// Pure acceptance/provenance/transform checks. Never starts a server or browser.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { protocol, summarize, trialSummary, scenarioSummary, summarizeLongTasks, longTaskBudget,
  assertMatchedState, assertHealthyState, aggregateReports } from './river-radiance-paired-protocol.mjs';
import { transform, initializeDocument, initializeQA, readiness, readState } from './river-radiance-paired-browser.mjs';
let tests = 0;
const test = (name, fn) => { fn(); tests++; console.log('ok', name); };
const digest = 'a'.repeat(64);
function state(subject = 'sun') {
  return { quality: { mobile: false, loadShed: 0 }, dpr: 1, context: { lost: false, losses: 0, restores: 0, error: 0 },
    paused: true, observerMode: true, gr: true, t: 0, camera: { target: [1, 2, 3] }, ship: [0, 0, 0, 0, 0, 0], workload: { frameNo: 120 },
    maps: { night: 1, clouds: 1, moon: true, realSky: true, galaxyBackdrop: false },
    river: { count: 15376, drawCount: 15376, drawnCount: 15376, drawnStart: 0, ambient: 15276, drawnAmbient: 15276,
      drawVisible: true, finite: true, invalidOwners: 0, readError: 0, textureHash: digest, uniforms: { vRef: 1, planeBias: 0 },
      sources: [{ name: subject === 'proxima' ? 'PROXIMA' : subject === 'sun' ? 'Sun' : 'placed-hole:0', owners: 100, drawnOwners: 100,
        inkGain: 1, cdfShare: .5, color: [1, 1, 1], coefficient: 3 }] },
    layers: { catalog: { loaded: true, count: 119000, error: '' },
      tier1: { initialized: true, tilesLoaded: 960, totalTiles: 12288, starsLoaded: 100000, pending: 0, tileErrors: 0, residualDirtyGroups: 0 },
      catalogRows: { updates: 120, remaining: 0, tiles: Array.from({ length: 960 }, (_, i) => i), rows: 100000, hash: digest },
      tides: { started: false, ready: false, error: null }, field: { enabled: true, idle: true, stars: 350000 },
      volume: { enabled: true, mapsReady: true, coverageReady: true, mapError: null },
      galaxy: { enabled: true, ready: true, building: false, error: null, galaxies: 40000 } }, post: { bloom: false, composer: false } };
}
function sample(frameNo, ratio = 1) {
  return { frameNo, cpuMs: 4 * ratio, finishMs: 0, readbackMs: 6 * ratio, frameAndFinishMs: 10 * ratio,
    roundTripMs: 11 * ratio, protocolAndSchedulingMs: ratio,
    gpu: { contextLost: false, losses: 0, restores: 0, error: 0, defaultFramebuffer: true },
    river: { enabled: true, visible: true, count: 15376, drawCount: 15376, computeEvery: 1, frame: frameNo },
    quality: { mobile: false, dpr: 1 } };
}
function scenario(fixture = protocol.fixtures[1], ratios = [1, 1, 1, 1, 1]) {
  const counters = { A: 120, B: 120 };
  return { name: fixture.subject, fixture, pages: Object.fromEntries(['A', 'B'].map(label => [label,
    { gpu: 'SwiftShader', longTaskSupported: true, observerProbe: { passed: true, observed: [{ duration: 80 }] } }])),
    before: { A: state(fixture.subject), B: state(fixture.subject) },
    warmup: { A: Array.from({ length: 120 }, (_, i) => sample(i + 1)), B: Array.from({ length: 120 }, (_, i) => sample(i + 1)) },
    trials: protocol.orders.map((order, i) => ({ order, blocks: [...order].map((label, j) => {
      const startTime = (i * 4 + j + 1) * 1000;
      const samples = Array.from({ length: 60 }, () => sample(++counters[label], label === 'B' ? ratios[i] : 1));
      const after = state(fixture.subject); after.workload.frameNo = counters[label];
      return { label, samples, after, startTime, endTime: startTime + 900 };
    }) })), longTasks: { A: { allEntries: [] }, B: { allEntries: [] } } };
}
function report() {
  return { device: 'desktop', protocol: structuredClone(protocol), selectedFixtures: structuredClone(protocol.fixtures),
    sources: { A: { revision: protocol.baseline }, B: { revision: protocol.productionCandidate, productionReference: protocol.productionCandidate } }, harness: { digest },
    errors: [], scenarios: protocol.fixtures.map(f => scenario(f)) };
}
test('exact three representative views and unchanged mandatory window sizes', () => {
  assert.equal(protocol.fixtures.length, 3); assert.equal(protocol.samplesPerBlock, 60); assert.equal(protocol.warmupFrames, 120);
  assert.deepEqual(protocol.orders, ['ABBA', 'BAAB', 'ABBA', 'BAAB', 'ABBA']); assert.equal(protocol.p95RatioLimit, 1.05);
  assert.equal(aggregateReports([report()], 'desktop', protocol.productionCandidate).mandatoryFrames.measured, 3600);
});
test('all enabled layers are explicit', () => {
  for (const key of ['tier1', 'realsky', 'field', 'galaxyvol', 'galaxies', 'river']) assert.equal(protocol.query[key], '1');
  assert(!('bloom' in protocol.query)); assert(!('galaxy' in protocol.query));
  assert(!('np' in protocol.query)); assert(!('galadapt' in protocol.query));
});
test('mobile health requires its full production texture and native postprocessing policy', () => {
  const s = state(); s.quality.mobile = true;
  assert.throws(() => assertHealthyState(s, true, 'sun'));
  Object.assign(s.river, { count: 9216, drawCount: 9216, drawnCount: 9216, ambient: 9116, drawnAmbient: 9116 });
  assertHealthyState(s, true, 'sun');
  s.post.bloom = true; assert.throws(() => assertHealthyState(s, true, 'sun'));
});
test('stream request counters exist before any module startup', () => {
  const sandbox = { window: {}, location: { protocol: 'about:' }, Date: class extends Date {},
    PerformanceObserver: class { static supportedEntryTypes = []; } };
  vm.runInNewContext(`(${initializeDocument.toString()})();`, sandbox);
  assert.equal(sandbox.window.__pairedTier1Remaining, 0); assert.equal(sandbox.window.__pairedTier1Updates, 0);
});
test('nearest-rank p95 retains tail in mean/max', () => {
  const s = summarize(Array(95).fill(10).concat(Array(5).fill(300)));
  assert.equal(s.p95, 10); assert.equal(s.max, 300); assert.equal(s.count, 100); assert.equal(s.mean, 24.5);
});
test('median of all five trial ratios, no outlier removal', () => {
  assert(scenarioSummary(scenario(undefined, [1.06, 1.06, 1.01, 1.01, 1.01])).passesFivePercentTarget);
  assert(!scenarioSummary(scenario(undefined, [1.06, 1.06, 1.06, .8, .8])).passesFivePercentTarget);
});
for (const [name, mutate] of [
  ['missing trial', s => s.trials.pop()], ['reordered trials', s => s.trials.reverse()],
  ['missing sample', s => s.trials[0].blocks[0].samples.pop()], ['missing warmup', s => s.warmup.A.pop()],
  ['hidden frame', s => s.trials[0].blocks[0].samples[0].frameNo++],
  ['cross-trial frame gap', s => { for (const b of s.trials[1].blocks) for (const p of b.samples) p.frameNo++; }],
  ['context loss', s => { s.trials[0].blocks[0].samples[0].gpu.contextLost = true; }],
  ['restored loss', s => { s.trials[0].blocks[0].samples[0].gpu.losses = 1; }],
  ['GL error', s => { s.trials[0].blocks[0].samples[0].gpu.error = 1282; }],
  ['wrong framebuffer', s => { s.trials[0].blocks[0].samples[0].gpu.defaultFramebuffer = false; }],
  ['disabled river', s => { s.trials[0].blocks[0].samples[0].river.enabled = false; }],
  ['adaptive cadence mismatch', s => { s.trials[0].blocks[0].samples[0].river.computeEvery = 2; }],
  ['quality mismatch', s => { s.trials[0].blocks[0].samples[0].quality.dpr = .5; }],
  ['nonfinite duration', s => { s.trials[0].blocks[0].samples[0].frameAndFinishMs = NaN; }],
]) test(`reject ${name}`, () => { const s = scenario(); mutate(s); assert.throws(() => scenarioSummary(s)); });
test('only intended display gain is ignored by workload comparison', () => {
  const a = state(), b = state(); b.river.sources[0].inkGain = .2; assertMatchedState(a, b);
});
for (const [name, mutate] of [
  ['owner distribution', s => s.river.sources[0].owners++], ['field coefficient', s => s.river.sources[0].coefficient++],
  ['CDF allocation', s => s.river.sources[0].cdfShare = .4], ['source color', s => s.river.sources[0].color[0] = .5],
  ['vRef', s => s.river.uniforms.vRef++], ['camera', s => s.camera.target[0]++],
  ['raw compute texture', s => s.river.textureHash = 'b'.repeat(64)], ['loaded rows', s => s.layers.catalogRows.hash = 'b'.repeat(64)],
  ['loaded tile IDs', s => s.layers.catalogRows.tiles[0] = 9999],
]) test(`reject unequal ${name}`, () => { const a = state(), b = state(); mutate(b); assert.throws(() => assertMatchedState(a, b)); });
for (const [name, mutate] of [
  ['low particle count', s => s.river.count = 4096], ['pending catalog request', s => s.layers.tier1.pending = 1],
  ['missing map', s => s.maps.moon = false], ['disabled full layer', s => s.layers.field.enabled = false],
  ['unmatched declared rows', s => s.layers.catalogRows.rows--], ['loss followed by restoration', s => { s.context.losses++; s.context.restores++; }],
]) test(`reject unhealthy ${name}`, () => { const s = state(); mutate(s); assert.throws(() => assertHealthyState(s, false, 'sun')); });
const long = durations => summarizeLongTasks(durations.map((duration, i) => ({ startTime: i + 1, duration })), [{ start: 0, end: 200 }]);
test('unchanged total blocking budget catches sub-p95 tail', () => assert(!longTaskBudget(long([]), long([101])).passed));
test('unchanged count budget catches repeated short long tasks', () => assert(!longTaskBudget(long([]), long([51, 51])).passed));
test('unchanged maximum budget catches one huge task despite available total budget', () => assert(!longTaskBudget(long(Array(100).fill(60)), long([201])).passed));
test('long-task windows retain inclusive boundary tasks and all raw entries', () => {
  const entries = [{ startTime: 0, duration: 80 }, { startTime: 10, duration: 70 }, { startTime: 20, duration: 60 }];
  const s = summarizeLongTasks(entries, [{ start: 0, end: 10 }]); assert.equal(s.measuredCount, 2); assert.equal(s.allEntries.length, 3);
});
for (const [name, mutate] of [
  ['missing view', r => { r.scenarios.pop(); r.selectedFixtures.pop(); }], ['duplicate view', r => r.scenarios[0] = r.scenarios[1]],
  ['wrong device', r => r.device = 'mobile'], ['changed threshold', r => r.protocol.p95RatioLimit = 1.5],
  ['wrong candidate HEAD', r => r.sources.B.revision = protocol.baseline], ['wrong baseline', r => r.sources.A.revision = protocol.productionCandidate], ['browser error', r => r.errors.push('shader error')],
  ['missing observer evidence', r => r.scenarios[0].pages.A.observerProbe.observed = []],
]) test(`aggregation rejects ${name}`, () => { const r = report(); mutate(r); assert.throws(() => aggregateReports([r], 'desktop', protocol.productionCandidate)); });
test('aggregation recomputes raw long tasks instead of trusting cached pass flags', () => {
  const r = report(); r.passed = true; r.longTaskBudget = { passed: true };
  r.scenarios[0].longTasks.B.allEntries = [{ startTime: 2100, duration: 500 }];
  assert.equal(aggregateReports([r], 'desktop', protocol.productionCandidate).passed, false);
});
test('three shards combine without granting three separate total-blocking allowances', () => {
  const r = report();
  const shards = r.scenarios.map(s => ({ ...r, selectedFixtures: [s.fixture], scenarios: [s] }));
  for (const shard of shards) shard.scenarios[0].longTasks.B.allEntries = [{ startTime: 2100, duration: 70 }];
  assert.equal(aggregateReports(shards, 'desktop', protocol.productionCandidate).passed, false); // total60 > unchanged +50, count3 > +1
});
for (const [label, revision] of [['A', protocol.baseline], ['B', protocol.productionCandidate]]) {
  for (const path of ['src/main.js', 'src/river.js', 'src/render/bodySurfaceMaterial.js', 'src/universe/athygTier1.js']) {
    const source = execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' });
    const result = transform(source, '/' + path);
    test(`${label} exact-source ${path} hook parses`, () => execFileSync(process.execPath, ['--input-type=module', '--check'], { input: result }));
    if (path === 'src/main.js') test(`${label} real frame plus readback timing, telemetry afterward`, () => {
      assert(result.includes('const start=performance.now();frame();'));
      assert(result.indexOf('frameAndFinishMs=performance.now()-start') < result.indexOf('gpu:{contextLost:gl.isContextLost()'));
      assert(!result.includes('eval('));
    });
    if (path === 'src/river.js') test(`${label} unchanged compute shader and production particle policy`, () => {
      const compute = s => s.match(/const COMPUTE_FRAG = \/\* glsl \*\/`([\s\S]*?)`;/)[1];
      assert.equal(compute(result), compute(source)); assert(result.includes('const v = m ? +m[1] : renderQuality.mobile ? 96 : 124;'));
    });
    if (path === 'src/universe/athygTier1.js') test(`${label} normal request gate keeps loaded renderer and residual pump`, () => {
      const begin = result.indexOf('function updateStreamingState('), end = result.indexOf('\n/**', begin);
      const body = result.slice(begin, end);
      assert(body.indexOf('pumpResidualRefreshFor(targetState)') < body.indexOf('__pairedTier1Remaining'));
      assert(body.indexOf('__pairedTier1Remaining') < body.indexOf('const toRequest'));
      const sandbox = { calls: [], window: { __pairedTier1Remaining: 1, __pairedTier1Updates: 0 },
        pumpResidualRefreshFor: () => {}, normalizeCameraDir: () => null, requestTiles: (_s, tiles) => sandbox.calls.push([...tiles]) };
      vm.runInNewContext(body + ';globalThis.pump=updateStreamingState;', sandbox);
      const target = { stats: { tilesLoaded: 0 }, manifest: { npix: 4 }, loaded: [false, false, false, false], pending: new Set(),
        residualDirtyGroups: 0, tilesPerFrame: 2, priorityOrder: [3, 1, 2, 0], sweepCursor: 0 };
      sandbox.pump(target, null); sandbox.pump(target, null);
      assert.deepEqual(sandbox.calls, [[3, 1]]); assert.equal(sandbox.window.__pairedTier1Updates, 1);
    });
  }
}
test('unknown hook markers fail closed', () => assert.throws(() => transform('changed entry', '/src/main.js')));
test('background HYG is not removed by this transform', () => assert.equal(transform('const start = () => loadTier0();', '/src/render/catalogStars.js'), null));
for (const fn of [initializeDocument, initializeQA, readiness, readState]) test(`serialized ${fn.name} parses`, () =>
  execFileSync(process.execPath, ['--input-type=module', '--check'], { input: `(${fn.toString()})` }));
const accepted = await readFile(new URL('./benchmark-explored-systems.mjs', import.meta.url));
const exact = execFileSync('git', ['show', `${protocol.productionCandidate}:scripts/benchmark-explored-systems.mjs`]);
test('established acceptance harness remains byte-for-byte untouched', () => assert.equal(createHash('sha256').update(accepted).digest('hex'), createHash('sha256').update(exact).digest('hex')));
console.log(`Full-layer paired radiance: ${tests} pure guards and exact-source transform checks passed; no browser run.`);
