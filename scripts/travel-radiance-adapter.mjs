// Fresh measurements for the travel integration. Historical evidence and its
// equality verifier stay immutable. Adapt only source binding and the precisely
// declared empty CPU scene object; preserve all timing and workload gates.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readTravelInventory } from './travel-radiance-inventory.mjs';

export const inputs = JSON.parse(readFileSync(new URL('./fixtures/travel-radiance-inputs.json', import.meta.url)));
const here = dirname(fileURLToPath(import.meta.url));
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = value => createHash('sha256').update(value).digest('hex');
const files = [
  'benchmark-river-radiance.mjs', 'river-radiance-paired-protocol.mjs', 'river-radiance-paired-browser.mjs',
  'river-radiance-qa.mjs', 'river-radiance-full-preparation.mjs', 'river-radiance-run-budget.mjs',
  'river-radiance-volume-progress.mjs', 'river-radiance-native-settlement.mjs', 'river-radiance-preparation-qa.mjs',
  'river-radiance-complete-shards.mjs', 'river-radiance-proxima-shards.mjs',
  'fixtures/river-radiance-proxima.json', 'fixtures/radiance-complete-shards.json', 'fixtures/radiance-proxima-complete-shards.json',
];
const measuredHarnessFiles = ['benchmark-river-radiance.mjs', 'river-radiance-paired-browser.mjs', 'river-radiance-paired-protocol.mjs',
  'river-radiance-qa.mjs', 'river-radiance-full-preparation.mjs', 'river-radiance-run-budget.mjs', 'river-radiance-volume-progress.mjs',
  'river-radiance-native-settlement.mjs', 'river-radiance-preparation-qa.mjs', 'fixtures/river-radiance-proxima.json'];
function measuredSource(root, label, revision) {
  const hashes = {};
  for (const path of ['src/main.js', 'src/river.js', 'src/lensing.js', 'src/holeOptics.js', 'src/render/holeAppearance.js',
    'src/render/linearFrame.js', 'src/render/galaxyVolume.js', 'src/scene.js', 'package.json']) hashes[path] = sha(readFileSync(join(root, path)));
  if (label === 'B') hashes['src/riverRadianceMath.js'] = sha(readFileSync(join(root, 'src/riverRadianceMath.js')));
  const compute = readFileSync(join(root, 'src/river.js'), 'utf8').match(/const COMPUTE_FRAG = \/\* glsl \*\/`([\s\S]*?)`;/)?.[1];
  assert(compute);
  return { revision, tree: git(root, 'rev-parse', 'HEAD^{tree}'), productionReference: revision,
    productionTrees: git(root, 'ls-tree', revision, '--', 'src', 'public', 'index.html', 'package.json'), hashes, computeHash: sha(compute) };
}

export function verifyCleanInputs(root, paths) {
  git(root, 'diff', '--exit-code', '--cached', 'HEAD', '--', ...paths);
  git(root, 'diff', '--exit-code', '--', ...paths);
  // Includes ignored files, notably Vite's .env.local and implicit configs.
  assert.equal(git(root, 'ls-files', '--others', '--', ...paths), '', 'Untracked served/build/harness input');
}
export function productionFingerprint(root, paths = inputs.productionPaths) {
  verifyCleanInputs(root, paths);
  return sha(execFileSync('git', ['ls-files', '--stage', '-z', '--', ...paths], { cwd: root }));
}
export function requireProduction(root, expectedHead, fingerprint, paths = inputs.productionPaths) {
  assert.match(expectedHead, /^[a-f0-9]{40}$/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), expectedHead, 'Exact actual measured HEAD required');
  assert.equal(productionFingerprint(root, paths), fingerprint, 'Frozen production/build fingerprint differs');
  return { revision: expectedHead, tree: git(root, 'rev-parse', 'HEAD^{tree}'), fingerprint };
}
function once(source, token, replacement) {
  assert.equal(source.split(token).length, 2, 'Immutable harness adapter token changed: ' + token);
  return source.replace(token, replacement);
}

export function adaptSource(name, source, candidateHead) {
  if (name === 'river-radiance-paired-protocol.mjs') {
    source = once(source, "baseline: '09863eedda25eef36d79e9cf88daa4ff3e377875'", `baseline: '${inputs.baseline}'`);
    source = once(source, "productionCandidate: '2c9b5bcf2f542728d76cf1350007297db2678f34'", `productionCandidate: '${candidateHead}'`);
    source = "import { comparableTravelState, validateStableTravelInventory } from './travel-radiance-inventory.mjs';\n" + source;
    source = once(source, 'export function comparableState(state) {', 'export function comparableState(state) {\n  state = comparableTravelState(state);');
    source = once(source, 'export function scenarioSummary(scenario,{legacy=false}={}) {',
      'export function scenarioSummary(scenario,{legacy=false}={}) {\n  validateStableTravelInventory(scenario);');
    source = once(source, 'export function assertMatchedState(A, B) {',
      'export function assertMatchedState(A, B) {\n  assert.deepEqual(A.river.sources.map(s => s.inkGain), B.river.sources.map(s => s.inkGain), "Both revisions retain identical radiance gains");');
    // This adapter never accepts historical raw reports or legacy budgets.
    source = once(source, '  if(reuseSunOnly){', '  assert(!reuseComplete && !legacy && !reuseSunOnly, "Fresh travel evidence only");\n  if(reuseSunOnly){');
  } else if (name === 'benchmark-river-radiance.mjs') {
    source = once(source, "'BASE_ROOT must name the exact 09863eed worktree'", "'BASE_ROOT must name the exact frozen main worktree'");
    source = once(source, '{ fixture, spec, catalogSetupUpdates: protocol.catalogSetupUpdates }', '{ fixture, spec, label, catalogSetupUpdates: protocol.catalogSetupUpdates }');
    source = once(source, 'const report = { version: 3,', "const report = { adapterBinding: JSON.parse(process.env.TRAVEL_RADIANCE_BINDING), version: 3,");
  } else if (name === 'river-radiance-paired-browser.mjs') {
    source = once(source, 'initializeQA({ fixture, spec, catalogSetupUpdates }) {',
      'initializeQA({ fixture, spec, label, catalogSetupUpdates }) {\n  window.__travelVariant = label;');
    source = once(source, 'return { focus: q.G.focus,', `return { travelInventory: (${readTravelInventory.toString()})(q.scene.scene), focus: q.G.focus,`);
  }
  return source;
}

export function prepareHarness(referenceRoot, baselineRoot, candidateRoot, expectedHead, destination) {
  assert.equal(git(referenceRoot, 'rev-parse', 'HEAD'), inputs.historicalHarness);
  assert.equal(git(referenceRoot, 'rev-parse', 'HEAD^{tree}'), inputs.historicalTree);
  verifyCleanInputs(referenceRoot, [...inputs.productionPaths, 'scripts']);
  const A = requireProduction(baselineRoot, inputs.baseline, inputs.productionFingerprints.A);
  assert.equal(A.tree, inputs.baselineTree);
  const B = requireProduction(candidateRoot, expectedHead, inputs.productionFingerprints.B);
  verifyCleanInputs(candidateRoot, ['scripts', '.github/workflows/river-radiance.yml']);
  assert.equal(resolve(here, '..'), resolve(candidateRoot), 'Execute the committed candidate adapter');
  const source = {}, effective = {}, originalHashes = {}, effectiveHashes = {};
  for (const name of files) {
    source[name] = execFileSync('git', ['show', inputs.historicalHarness + ':scripts/' + name], { cwd: referenceRoot, encoding: 'utf8' });
    effective[name] = adaptSource(name, source[name], expectedHead);
    originalHashes[name] = sha(source[name]); effectiveHashes[name] = sha(effective[name]);
  }
  effective['travel-radiance-inventory.mjs'] = readFileSync(join(here, 'travel-radiance-inventory.mjs'), 'utf8');
  effectiveHashes['travel-radiance-inventory.mjs'] = sha(effective['travel-radiance-inventory.mjs']);
  for (const [name, value] of Object.entries(effective)) {
    const path = join(destination, 'scripts', name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value);
  }
  writeFileSync(join(destination, 'package.json'), '{"type":"module"}\n');
  symlinkSync(join(candidateRoot, 'src'), join(destination, 'src'), 'dir');
  symlinkSync(join(candidateRoot, 'node_modules'), join(destination, 'node_modules'), 'dir');
  const binding = { version: 1, freshOnly: true, historicalHarness: inputs.historicalHarness, historicalTree: inputs.historicalTree,
    frozenTravelReference: inputs.frozenTravelReference, productionPaths: inputs.productionPaths, sources: { A, B },
    measuredSources: { A: measuredSource(baselineRoot, 'A', inputs.baseline), B: measuredSource(candidateRoot, 'B', expectedHead) },
    measuredHarness: Object.fromEntries(measuredHarnessFiles.map(name => [name, effectiveHashes[name]])),
    adapterHashes: Object.fromEntries(['travel-radiance-adapter.mjs', 'travel-radiance-inventory.mjs', 'fixtures/travel-radiance-inputs.json']
      .map(name => [name, sha(readFileSync(join(here, name)))])), originalHashes, effectiveHashes };
  return { binding, effective };
}

export function validateFreshReport(report, binding, device) {
  assert.deepEqual(report.adapterBinding, binding, 'Only fresh reports of the current measured candidate and reviewed adapter');
  assert.equal(report.device, device);
  assert.deepEqual(report.sources, binding.measuredSources, 'Exact measured source metadata required');
  assert.equal(report.shardComplete, true, 'Incomplete or failed shard cannot contribute');
  assert.deepEqual(report.errors, []);
  assert.equal(report.scenarios.length, 1, 'Exactly one fresh view per shard');
  assert.equal(report.selectedFixtures.length, 1);
  assert.deepEqual(report.harness, binding.measuredHarness, 'Complete measured harness hash set required');
}

async function main() {
  const [mode, referenceArg, baselineArg, candidateArg, outputArg, ...reports] = process.argv.slice(2);
  assert(['validate', 'measure', 'aggregate'].includes(mode));
  assert(referenceArg && baselineArg && candidateArg && outputArg);
  const reference = resolve(referenceArg), baseline = resolve(baselineArg), candidate = resolve(candidateArg), output = resolve(outputArg);
  const expectedHead = process.env.EXPECTED_CANDIDATE_REVISION;
  assert(expectedHead, 'External exact candidate HEAD is mandatory');
  const device = process.env.DEVICE || 'desktop'; assert(['desktop', 'mobile'].includes(device));
  if (mode === 'measure') assert(['proxima', 'sun', 'black-hole'].includes(process.env.FIXTURE), 'One bounded view per job');
  mkdirSync(output, { recursive: true });
  const temporary = mkdtempSync(join(tmpdir(), 'travel-radiance-harness-'));
  let provenance = { passed: false, mode, errors: [] };
  try {
    const { binding, effective } = prepareHarness(reference, baseline, candidate, expectedHead, temporary);
    provenance.binding = binding;
    for (const [name, source] of Object.entries(effective)) {
      const path = join(output, 'effective-harness', name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source);
    }
    writeFileSync(join(output, 'adapter-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    if (mode === 'aggregate') {
      assert.equal(reports.length, 3, 'All three fresh views per device are mandatory');
      const rows = reports.map(path => JSON.parse(readFileSync(path)));
      rows.forEach(report => validateFreshReport(report, binding, device));
      for (const path of reports) {
        const provenance = JSON.parse(readFileSync(join(dirname(path), 'adapter-provenance.json')));
        assert.equal(provenance.mode, 'measure'); assert.equal(provenance.passed, true);
        assert.deepEqual(provenance.errors, []); assert.deepEqual(provenance.binding, binding);
      }
      const { aggregateReports } = await import(pathToFileURL(join(temporary, 'scripts/river-radiance-paired-protocol.mjs')));
      const result = aggregateReports(rows, device, expectedHead);
      writeFileSync(join(output, 'aggregate.json'), JSON.stringify(result, null, 2) + '\n');
      assert(result.passed, 'Fresh full-trial p95 or device-wide long-task gate failed');
    } else {
      const args = [join(temporary, 'scripts/benchmark-river-radiance.mjs'), candidate, output];
      if (mode === 'validate') args.push('--validate');
      const child = spawnSync(process.execPath, args, { cwd: candidate, stdio: 'inherit', env: { ...process.env,
        BASE_ROOT: baseline, TRAVEL_RADIANCE_BINDING: JSON.stringify(binding) } });
      assert.equal(child.status, 0, 'Fresh runner failed; original partial evidence retained');
    }
    provenance.passed = true;
  } catch (error) { provenance.errors.push({ message: error.stack || String(error) }); process.exitCode = 1; }
  finally {
    try {
      requireProduction(baseline, inputs.baseline, inputs.productionFingerprints.A);
      requireProduction(candidate, expectedHead, inputs.productionFingerprints.B);
      verifyCleanInputs(candidate, ['scripts', '.github/workflows/river-radiance.yml']);
    } catch (error) { provenance.passed = false; provenance.errors.push({ message: error.stack || String(error) }); process.exitCode = 1; }
    writeFileSync(join(output, 'adapter-provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ mode, passed: provenance.passed, errors: provenance.errors }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
