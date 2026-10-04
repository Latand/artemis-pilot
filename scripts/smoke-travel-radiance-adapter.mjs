import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inputs, requireProduction, productionFingerprint, prepareHarness, validateFreshReport } from './travel-radiance-adapter.mjs';
import { foreignAttributes, comparableTravelState, validateTravelInventory } from './travel-radiance-inventory.mjs';

const root = resolve('.'), reference = resolve(process.argv[2] || '../radiance-accepted'), baseline = resolve(process.argv[3] || '../travel-main');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const temporary = mkdtempSync(join(tmpdir(), 'travel-radiance-tests-'));
let checks = 0;
const test = (name, fn) => { fn(); checks++; console.log('PASS', name); };
const uuid = '12345678-1234-1234-1234-123456789abc';
const inventory = variant => ({ variant, objects: [{ uuid, geometryUuid: uuid, materialUuid: uuid,
  type: 'Points', materialType: 'ShaderMaterial', visible: false, drawRange: { start: 0, count: 0 },
  geometryUsers: 1, materialUsers: 1, attributes: structuredClone(foreignAttributes) }] });

try {
  const harness = join(temporary, 'harness'); mkdirSync(harness);
  const { binding } = prepareHarness(reference, baseline, root, head, harness);
  const p = await import(pathToFileURL(join(harness, 'scripts/river-radiance-paired-protocol.mjs')));
  const { runLimits } = await import(pathToFileURL(join(harness, 'scripts/river-radiance-run-budget.mjs')));
  const fixtures = await import(pathToFileURL(join(reference, 'scripts/river-radiance-test-fixtures.mjs')));
  const decorate = (state, label) => ({ ...state, travelInventory: inventory(label),
    sceneObjects: { objects: 101, geometries: 51, materials: 21 },
    render: { geometries: 50, textures: 20, programs: 10 } });
  function rows() {
    return p.protocol.fixtures.map(fixture => {
      const scenario = fixtures.scenario(fixture);
      for (const label of ['A', 'B']) {
        scenario.prepared[label] = decorate(scenario.prepared[label], label);
        scenario.before[label] = decorate(scenario.before[label], label);
      }
      for (const trial of scenario.trials) for (const block of trial.blocks) block.after = decorate(block.after, block.label);
      return { ...fixtures.report(), protocol: structuredClone(p.protocol), adapterBinding: structuredClone(binding),
        sources: structuredClone(binding.measuredSources), harness: structuredClone(binding.measuredHarness),
        selectedFixtures: [fixture], scenarios: [scenario], shardComplete: true, passed: null };
    });
  }
  const aggregate = reports => { reports.forEach(report => validateFreshReport(report, binding, 'desktop')); return p.aggregateReports(reports, 'desktop', head); };
  test('actual main and frozen candidate inputs bind independently of historical evidence', () => {
    assert.equal(binding.sources.A.revision, inputs.baseline); assert.equal(binding.sources.B.revision, head);
    assert.equal(binding.sources.A.fingerprint, inputs.productionFingerprints.A);
    assert.equal(binding.sources.B.fingerprint, inputs.productionFingerprints.B);
  });
  test('all timing caps, native quality protocol, trials and sample counts remain unchanged', () => {
    assert.equal(runLimits.preparationMs, 60 * 60000); assert.equal(runLimits.warmupMs, 15 * 60000); assert.equal(runLimits.measurementMs, 80 * 60000);
    assert.equal(p.protocol.warmupFrames, 120); assert.equal(p.protocol.samplesPerBlock, 60); assert.equal(p.protocol.catalogSetupUpdates, 120);
    assert.deepEqual(p.protocol.orders, ['ABBA', 'BAAB', 'ABBA', 'BAAB', 'ABBA']); assert.equal(p.protocol.p95RatioLimit, 1.05);
    const old = fixtures.report().protocol;
    assert.deepEqual({ ...p.protocol, baseline: old.baseline, productionCandidate: old.productionCandidate }, old);
  });
  test('all three complete fresh views aggregate from raw samples', () => {
    const result = aggregate(rows()); assert(result.passed); assert.deepEqual(result.mandatoryFrames, { measured: 3600, warmup: 720 });
  });
  for (const [name, mutate] of [
    ['historical binding', r => { delete r[0].adapterBinding; }],
    ['wrong actual head', r => { r[0].sources.B.revision = '0'.repeat(40); }],
    ['wrong source hash', r => { r[0].sources.B.hashes['src/main.js'] = '0'.repeat(64); }],
    ['missing helper hash', r => { delete r[0].harness['river-radiance-full-preparation.mjs']; }],
    ['incomplete report', r => { r[0].shardComplete = false; }],
    ['browser error', r => { r[0].errors.push({ message: 'GL error' }); }],
    ['missing view', r => { r.pop(); }],
    ['duplicate view', r => { r[2] = structuredClone(r[1]); }],
    ['missing sample', r => { r[0].scenarios[0].trials[0].blocks[0].samples.pop(); }],
    ['missing warmup', r => { r[0].scenarios[0].warmup.A.pop(); }],
    ['missing trial', r => { r[0].scenarios[0].trials.pop(); }],
    ['relaxed phase cap', r => { r[0].scenarios[0].phases[0].limitMs++; }],
    ['timed-out preparation', r => { r[0].scenarios[0].phases[0].timedOut = true; }],
    ['cadence mismatch', r => { r[0].scenarios[0].trials[0].blocks[0].samples[0].river.computeEvery++; }],
    ['quality mismatch', r => { r[0].scenarios[0].trials[0].blocks[0].samples[0].quality.dpr = .5; }],
    ['GPU error', r => { r[0].scenarios[0].trials[0].blocks[0].samples[0].gpu.error = 1282; }],
    ['camera mismatch', r => { r[0].scenarios[0].before.B.camera.target[0]++; }],
    ['GPU resource growth', r => { r[0].scenarios[0].before.B.render.textures++; }],
    ['unexplained CPU geometry', r => { r[0].scenarios[0].before.B.sceneObjects.geometries++; }],
    ['radiance gain mismatch', r => { r[0].scenarios[0].before.B.river.sources[0].inkGain = .2; }],
    ['raw field mismatch', r => { r[0].scenarios[0].before.B.river.textureHash = 'b'.repeat(64); }],
    ['catalog row mismatch', r => { r[0].scenarios[0].before.B.layers.catalogRows.hash = 'b'.repeat(64); }],
    ['missing candidate foreign object', r => { r[0].scenarios[0].before.B.travelInventory.objects = []; }],
    ['missing baseline foreign object', r => { r[0].scenarios[0].before.A.travelInventory.objects = []; }],
    ['unexpected baseline object', r => { r[0].scenarios[0].before.A.travelInventory.objects.push(inventory('A').objects[0]); }],
    ['foreign object replacement', r => { r[0].scenarios[0].before.B.travelInventory.objects[0].uuid = 'abcdefab-cdef-abcd-efab-cdefabcdefab'; }],
  ]) test('reject ' + name, () => { const r = rows(); mutate(r); assert.throws(() => aggregate(r)); });
  for (const [name, mutate] of [
    ['visible point layer', o => { o.visible = true; }], ['drawn point', o => { o.drawRange.count = 1; }],
    ['wrong capacity', o => { o.attributes.position[1]++; }], ['shared geometry', o => { o.geometryUsers = 2; }],
    ['shared material', o => { o.materialUsers = 2; }], ['wrong material', o => { o.materialType = 'MeshBasicMaterial'; }],
  ]) test('reject ' + name, () => { const i = inventory('B'); mutate(i.objects[0]); assert.throws(() => validateTravelInventory(i)); });
  test('comparison preserves raw inventory and exact CPU/GPU accounting', () => {
    const state = decorate(fixtures.state(), 'B'), before = structuredClone(state), normalized = comparableTravelState(state);
    assert.deepEqual(state, before); assert.deepEqual(normalized.sceneObjects, state.sceneObjects); assert.deepEqual(normalized.render, state.render);
  });
  test('no historical reuse or legacy-budget modes', () => {
    for (const options of [{ reuseComplete: true }, { legacy: true }, { reuseSunOnly: true }])
      assert.throws(() => p.aggregateReports(rows(), 'desktop', head, options), /Fresh travel evidence only/);
  });
  test('a genuine p95 regression fails without removing any frame', () => {
    const r = rows(); for (const trial of r[0].scenarios[0].trials) for (const block of trial.blocks) if (block.label === 'B')
      for (const sample of block.samples) sample.frameAndFinishMs *= 1.1;
    assert.equal(aggregate(r).passed, false);
  });
  for (const [name, entries] of [['blocking', [{ startTime: 1100, duration: 101 }]],
    ['count', [{ startTime: 1100, duration: 51 }, { startTime: 1150, duration: 51 }]], ['maximum', [{ startTime: 1100, duration: 201 }]]])
    test('unchanged long-task ' + name + ' budget', () => {
      const r = rows(), s = r[0].scenarios[0];
      const block = s.trials[0].blocks.find(b => b.label === 'B');
      s.longTasks.B.allEntries = entries.map((e, i) => ({ ...e, startTime: block.startTime + 10 + i * 100 }));
      assert.equal(aggregate(r).passed, false);
    });

  const fixture = join(temporary, 'source'); mkdirSync(fixture);
  const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, value) => { mkdirSync(dirname(join(fixture, path)), { recursive: true }); writeFileSync(join(fixture, path), value); };
  git('init', '-q'); put('.gitignore', '*.local\n'); put('src/a.js', 'accepted\n'); put('package.json', '{}\n'); git('add', '.');
  const commit = () => git('-c', 'user.name=QA fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic input');
  commit(); const original = git('rev-parse', 'HEAD'), paths = inputs.productionPaths, fingerprint = productionFingerprint(fixture, paths);
  test('clean frozen source passes', () => requireProduction(fixture, original, fingerprint, paths));
  test('all fresh workflow roots use the reviewed actual PR base', () => {
    const workflow = readFileSync(join(root, '.github/workflows/river-radiance.yml'), 'utf8');
    assert(workflow.includes(`REVIEWED_BASE_REVISION: '${inputs.baseline}'`));
    assert.equal(workflow.split('test "$PR_BASE_REVISION" = "$REVIEWED_BASE_REVISION"').length - 1, 3);
    assert.equal(workflow.split(`git worktree add --detach ../travel-main ${inputs.baseline}`).length - 1, 2);
    assert(workflow.includes(`git worktree add --detach ../radiance-baseline ${inputs.baseline}`));
  });
  test('clean-runner dependency installation preserves protected inputs; old lock creation fails preflight', () => {
    const workflow = readFileSync(join(root, '.github/workflows/river-radiance.yml'), 'utf8');
    const commands = [...workflow.matchAll(/^\s*- run: (npm install[^\n]*)$/gm)].map(match => match[1]);
    assert.deepEqual(commands, Array(3).fill('npm install --ignore-scripts --no-package-lock'));
    const isolated = ['--offline', '--no-audit', '--no-fund'];
    const run = command => execFileSync('npm', [...command.split(' ').slice(1), ...isolated], {
      cwd: fixture, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_cache: join(temporary, 'npm-cache') },
    });
    assert.equal(existsSync(join(fixture, 'package-lock.json')), false);
    run(commands[0]);
    assert.equal(existsSync(join(fixture, 'package-lock.json')), false);
    requireProduction(fixture, original, fingerprint, paths);
    run('npm install --ignore-scripts');
    assert.equal(existsSync(join(fixture, 'package-lock.json')), true, 'Old workflow actually creates an undeclared build input');
    assert.throws(() => requireProduction(fixture, original, fingerprint, paths), /Untracked served\/build\/harness input/);
    rmSync(join(fixture, 'package-lock.json'));
    requireProduction(fixture, original, fingerprint, paths);
  });
  test('unstaged, staged, masked and committed production mutations fail', () => {
    put('src/a.js', 'changed\n'); assert.throws(() => requireProduction(fixture, original, fingerprint, paths));
    git('add', '.'); put('src/a.js', 'accepted\n'); assert.throws(() => requireProduction(fixture, original, fingerprint, paths));
    put('src/a.js', 'changed\n'); commit(); const changed = git('rev-parse', 'HEAD');
    put('src/a.js', 'accepted\n'); assert.throws(() => requireProduction(fixture, changed, fingerprint, paths));
    put('src/a.js', 'changed\n'); assert.throws(() => requireProduction(fixture, changed, fingerprint, paths));
    git('reset', '--hard', original);
  });
  test('ignored implicit environment input fails', () => { put('.env.local', 'QA=1\n'); assert.throws(() => requireProduction(fixture, original, fingerprint, paths)); });
  console.log(`${checks} travel radiance adapter checks passed`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
