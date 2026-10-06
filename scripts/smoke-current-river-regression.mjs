import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { adaptCurrentRiver, materializeCurrentRiver, currentRiverHarnesses, currentRiverProfile } from './run-current-river-regression.mjs';
const read = path => readFileSync(new URL('../'+path, import.meta.url), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const base = "github.event.pull_request.base.sha == '6179f23661591bb4dee89a0bf8e686233e1ba280'";
function validateArchivedRadiance(source) {
  assert.equal(source.split('    if: '+base+'\n').length, 3);
  assert(source.includes('    if: ${{ always() && !cancelled() && '+base+' }}'));
  const original = source.replaceAll('    if: '+base+'\n', '')
    .replace('    if: ${{ always() && !cancelled() && '+base+' }}', '    if: ${{ always() && !cancelled() }}');
  assert.equal(sha(original), 'a3bd07d3ab30b90b02a4393476a0778818d7fa399c3e0f58062d980f3e5d451f', 'Original radiance jobs, pins and performance budgets are preserved');
}
function validateArchivedForeign(source) {
  const guard = "    if: (github.event_name == 'push' && github.ref == 'refs/heads/diagnostic/foreign-river-precision') || ("+base+")\n";
  assert.equal(source.split(guard).length, 2);
  assert.equal(sha(source.replace(guard, '')), '7a6eb700d3cca62d131852a82f989ff32ae0120a478fd1cae921ed1e109abbff', 'Original foreign identity gate and functional commands are preserved');
}
const radiance = read('.github/workflows/river-radiance.yml'), foreign = read('.github/workflows/foreign-river-validation.yml');
validateArchivedRadiance(radiance); validateArchivedForeign(foreign);
for (const [validate, source] of [[validateArchivedRadiance, radiance], [validateArchivedForeign, foreign]]) {
  assert.throws(() => validate(source.replace(base, 'true')));
  assert.throws(() => validate(source.replace('persist-credentials: false', 'persist-credentials: true')));
}
const workflow = read('.github/workflows/river-current-validation.yml');
function validateCurrent(source) {
  assert(!/^    if:/m.test(source), 'Current jobs must not inherit historical skip conditions');
  assert(!/continue-on-error|fresh-performance|travel-radiance-adapter\.mjs measure/.test(source));
  for (const path of ['src/**', 'public/**', 'scripts/**', 'index.html', 'package*.json', 'bun.lock', 'vite.config.*',
    '.env*', 'postcss.config.*', '.postcssrc*', 'tsconfig*.json', 'jsconfig*.json', 'npm-shrinkwrap.json', '.npmrc',
    '.github/workflows/river-current-validation.yml', '.github/workflows/river-radiance.yml', '.github/workflows/foreign-river-validation.yml'])
    assert(source.includes(`      - '${path}'`), `Current trigger missing ${path}`);
  for (const name of ['current-river-regression', 'radiance-acceptance', 'river-radiance', 'river-radiance-qa',
    'river-radiance-lifecycle', 'context-recovery-qa', 'foreign-river', 'foreign-star-startup', 'scenario-session'])
    assert(source.includes(`node scripts/smoke-${name}.mjs`), `Current smoke missing ${name}`);
  for (const token of ['        device: [desktop, mobile]', '        suite: [foreign, radiance-transient, radiance-lifecycle]',
    '    needs: current-model', 'timeout --signal=TERM --kill-after=10s 15m node scripts/run-current-river-regression.mjs',
    '          npm run build']) assert(source.includes(token));
}
validateCurrent(workflow);
for (const mutate of [s => s.replace("      - 'src/**'\n", ''), s => s.replace('  current-model:\n', '  current-model:\n    if: false\n'),
  s => s.replace('suite: [foreign, radiance-transient, radiance-lifecycle]', 'suite: [foreign]')]) assert.throws(() => validateCurrent(mutate(workflow)));
for (const [kind, { file, sha256 }] of Object.entries(currentRiverHarnesses)) {
  const original = read('scripts/'+file); assert.equal(sha(original), sha256);
  const { source, substitutions } = adaptCurrentRiver(kind, original);
  let restored = source;
  for (const { before, after } of [...substitutions].reverse()) {
    assert.equal(restored.split(after).length, 2, 'Adapter delta is unambiguous and reversible'); restored = restored.replace(after, before);
  }
  assert.equal(restored, original, 'Only declared current-mode substitutions exist');
  assert.equal(source.split('/?quality=high&').length, 2);
  for (const flag of ['historicalAttestation: false', 'pairedSourceAcceptance: false', 'performanceAcceptance: false']) assert(source.includes(flag));
  const checks = text => (text.match(/\bcheck\(/g) || []).length;
  assert.equal(checks(source), checks(original) - (kind === 'radiance' ? 2 : 0), 'All per-frame, pixel, source, recovery and advection checks remain');
  if (kind === 'radiance') {
    assert(source.includes('process.argv.slice(2, 3)'));
    assert(!source.includes('if (ri) check('));
    assert(!source.includes('const rows = report.cases.filter'));
    assert(source.includes("roots[0] + '/'"));
  }
  for (const mutation of [original+'\n', original.replace('readFile', 'changedReadFile'), original.replace('assert', 'void')]) {
    assert.notEqual(mutation, original); assert.throws(() => adaptCurrentRiver(kind, mutation), /Exact immutable functional harness/);
  }
  const materialized = materializeCurrentRiver(source, new URL(file, import.meta.url).href);
  execFileSync(process.execPath, ['--input-type=module', '--check'], { input: materialized });
}
// Pure fixture selection: only mobile lifecycle exercises the real Low cadence.
// Explicit np=96 retains the original full mobile allocation and dpr=1 remains.
for (const device of ['desktop', 'mobile']) for (const suite of ['transient', 'lifecycle']) for (const kind of ['foreign', 'radiance']) {
  const cadence = kind === 'radiance' && device === 'mobile' && suite === 'lifecycle';
  const { source, substitutions, profile } = adaptCurrentRiver(kind, read('scripts/'+currentRiverHarnesses[kind].file), { device, suite });
  assert.equal(profile.qualityMode, cadence ? 'low' : 'high');
  assert.equal(profile.particleWidth, cadence ? 96 : null);
  assert.equal(profile.expectedComputeEvery, cadence ? 2 : null);
  const query = new URLSearchParams(source.match(/page\.goto\(`[^`]+\/\?([^`]+)`/)[1]);
  assert.equal(query.get('quality'), profile.qualityMode); assert.equal(query.get('dpr'), '1');
  assert.equal(query.get('np'), cadence ? '96' : null);
  assert(source.includes(`qualityMode: "${profile.qualityMode}"`));
  let restored = source;
  for (const { before, after } of [...substitutions].reverse()) {
    assert.equal(restored.split(after).length, 2); restored = restored.replace(after, before);
  }
  assert.equal(restored, read('scripts/'+currentRiverHarnesses[kind].file));
  if (cadence) {
    for (const assertion of ['healthyRadianceMobileCadence(row.frames, spec.subject)', 'signedRadianceAdvection(state,plan)',
      'healthyRadianceGain(state, row.frames.at(-2))', 'healthyRadianceRecovery(row.recoveries.at(-1), state)',
      'healthyRadianceCapture(state)', 'frame.count === (mobile ? 9216 : 15376)']) assert(source.includes(assertion));
    assert(source.includes('Current mobile staged High/Low cadence at DPR1 with np=96 (9,216 texels);'));
    assert(!source.includes(': full production device quality`'));
    const selection = source.match(/            if \(q\.s\.setQualityMode\) \{[\s\S]*?\n            \}/)[0];
    for (const subject of ['proxima', 'black-hole']) for (const rate of [0,3852,-3852]) for (const native of [false,true]) {
      const q = { subject, s: { renderQuality: { mode: 'low' } } }; let calls = 0;
      if (native) q.s.setQualityMode = mode => { q.s.renderQuality.mode = mode; calls++; };
      new Function('q','plan',selection)(q,{rate});
      const expected = native && subject === 'black-hole' && rate === 0 ? 'high' : 'low';
      assert.equal(q.s.renderQuality.mode, expected); assert.equal(calls, expected === 'high' ? 1 : 0);
    }
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: materializeCurrentRiver(source, new URL('verify-river-radiance.mjs', import.meta.url).href) });
  }
}
for (const options of [{ device: 'tablet' }, { suite: 'benchmark' }]) assert.throws(() => currentRiverProfile('radiance', options));
const river = read('src/river.js');
const allocation = river.match(/const TEXW = \(\(\) => \{[\s\S]+?\}\)\(\);/);
const scheduling = river.match(/const adaptiveComputeEvery = [^\n]+;\n    const baseComputeEvery = [^\n]+;\n    const computeEvery = [^\n]+;/);
assert(allocation && scheduling, 'Production allocation and compute-cadence seams');
const allocate = new Function('location', 'renderQuality', allocation[0]+' return TEXW;');
const cadenceOf = new Function('renderQuality', 'river', scheduling[0]+' return computeEvery;');
const qualityURL = new URL('../src/render/adaptiveQuality.js', import.meta.url);
// A cherry-pick onto pre-controller main retains its native mobile load-shed path.
const nativeQuality = existsSync(qualityURL) ? await import(qualityURL) : null;
const profile = currentRiverProfile('radiance', { device: 'mobile', suite: 'lifecycle' });
const quality = { mode: profile.qualityMode, mobile: true, software: true, loadShed: 2,
  ...(nativeQuality ? nativeQuality.qualityBudget(2, true) : {}) };
assert.equal(allocate({ search: '?quality=low&np=96&dpr=1' }, quality), 96);
assert.equal(96 * 96, 9216, 'Unchanged full mobile particle capacity');
assert.equal(cadenceOf(quality, { computeEveryAdaptive: 1 }), 2, 'Actual production cadence remains two');
if (nativeQuality) {
  const controller = nativeQuality.createQualityController({ mode: profile.qualityMode, mobile: true, software: true });
  assert.equal(controller.state.mode, 'low'); assert.equal(controller.state.level, 2);
  assert.equal(nativeQuality.qualityBudget(controller.state.level, true).riverEvery, 2);
  assert.equal(nativeQuality.qualityPixelRatio({ level: 2, mobile: true, device: 3, override: 1, width: 430, height: 932 }), 1);
  const full = { mode: 'high', mobile: true, software: true, loadShed: 0, ...nativeQuality.qualityBudget(0, true) };
  assert.equal(cadenceOf(full, { computeEveryAdaptive: 1 }), 1, 'Retain the original High-mode non-cadence control');
}
// Immutable policy, acceptance metadata and negative controls stay pinned;
// these checks preserve historical contracts but do not claim new timings.
for (const [path, expected] of Object.entries({
  'scripts/travel-radiance-adapter.mjs': 'a718147a951a5a14e3e8f127f3b09632393cd7807108f4bec8c8a5822d33ffe5',
  'scripts/smoke-travel-radiance-adapter.mjs': '6831e88f9e5c404071bc371c82d08380d3409698225f286a44996f3991f87610',
  'scripts/verify-foreign-river-inputs.mjs': '60c8b247e772e8d05fa04568c2996b78ee8bb08518615e75e97ca8d3f3f02aca',
  'scripts/fixtures/travel-radiance-inputs.json': 'ee5db53e2c677f26b2ad605c9f50513d7ab00ff10fd46353f6357f2c47a248a0',
  'scripts/fixtures/foreign-river-validation.json': 'c5197f327778f527518d07eec6bc65dac4de36a8b90b2c8b99806b343d787b80',
  'scripts/verify-radiance-acceptance.mjs': '673bbd24f04b044537914bfc46a82b166f712a2038a189b30e33c5221eacf15a',
  'scripts/fixtures/radiance-acceptance.json': '11a999cd7bc2e41e9f2c5a210b5802b54a39de6b4f855721ce01f736f173054c',
  'scripts/fixtures/radiance-acceptance-metadata.json': 'bd07425709431d1e617a6621073aa1cf516af24be363866599bcff743205db18',
  'scripts/foreign-river-qa.mjs': '76303ea8686c51381f1ba6705034265860b8a9dcae049215c05ddd593437c0cb',
  'scripts/river-radiance-qa.mjs': '8c052596895045da9d4326e322c6d283558b430086ede693a9d05d54f360b413',
  'scripts/river-radiance-lifecycle.mjs': '22fd07e634b21fa8e175297a38fda8eb309b87805c5b8c38b42508c527afe671',
})) assert.equal(sha(read(path)), expected, `Historical contract: ${path}`);
console.log('Current river scope: preserved archived workflows/contracts, mandatory six functional cells, reversible explicit-quality/single-root adapter with full-capacity Low mobile lifecycle, routing and mutated-harness negatives passed. No timing acceptance.');
