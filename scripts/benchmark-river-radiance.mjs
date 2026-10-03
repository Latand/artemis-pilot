// Full-layer paired acceptance extension, separate from the unchanged explored
// systems harness. DEVICE=desktop|mobile BASE_ROOT=/exact/09863eed node
// scripts/benchmark-river-radiance.mjs [candidate root] [output] [--validate]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { protocol, summarize, validateSample, trialSummary, scenarioSummary, summarizeLongTasks, longTaskBudget,
  assertMatchedState, assertHealthyState } from './river-radiance-paired-protocol.mjs';
import { transform, initializeDocument, initializeQA, readiness, readState } from './river-radiance-paired-browser.mjs';
import { radianceDeviceTargets, volumeProgressTransform, volumeRefinementReady, validateRefinementAdvance } from './river-radiance-volume-progress.mjs';
import { prepareFullView } from './river-radiance-full-preparation.mjs';
import { runLimits, durableReport, phaseBudget, installReportSignals } from './river-radiance-run-budget.mjs';

const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
assert(process.env.BASE_ROOT, 'BASE_ROOT must name the exact 09863eed worktree');
const root = resolve(args[0] || '.'), baselineRoot = resolve(process.env.BASE_ROOT);
const device = process.env.DEVICE || 'desktop'; assert(['desktop', 'mobile'].includes(device));
const mobile = device === 'mobile', viewport = mobile ? { width: 430, height: 932 } : { width: 1200, height: 800 };
const volumeSize=radianceDeviceTargets(mobile).volume;
const selectedFixtures = process.env.FIXTURE ? protocol.fixtures.filter(f => f.subject === process.env.FIXTURE) : protocol.fixtures;
assert(selectedFixtures.length, 'FIXTURE must be proxima, sun or black-hole');
const out = resolve(args[1] || `evidence/river-radiance-paired/${device}`);
const fixture = JSON.parse(await readFile(new URL('./fixtures/river-radiance-proxima.json', import.meta.url), 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const paths = ['src/main.js', 'src/river.js', 'src/render/bodySurfaceMaterial.js', 'src/universe/athygTier1.js', 'src/render/galaxyVolume.js'];
const productionPaths = ['src', 'public', 'index.html', 'package.json'];
const sources = {};
for (const [label, tree, expected] of [['A', baselineRoot, protocol.baseline], ['B', root, protocol.productionCandidate]]) {
  if (label === 'A') assert.equal(git(tree, 'rev-parse', 'HEAD'), protocol.baseline, 'Exact baseline commit required');
  // Harness-only commits on the candidate are allowed; production drift is not.
  git(tree, 'diff', '--exit-code', expected, '--', ...productionPaths);
  assert.equal(git(tree, 'ls-files', '--others', '--exclude-standard', '--', ...productionPaths), '', 'No untracked production inputs');
  sources[label] = { revision: git(tree, 'rev-parse', 'HEAD'), tree: git(tree, 'rev-parse', 'HEAD^{tree}'),
    productionReference: expected, productionTrees: git(tree, 'ls-tree', expected, '--', ...productionPaths), hashes: {} };
  for (const path of paths) {
    const original = await readFile(resolve(tree, path), 'utf8');
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: volumeProgressTransform(original, '/' + path) ?? transform(original, '/' + path) });
  }
  for (const path of ['src/main.js', 'src/river.js', 'src/lensing.js', 'src/holeOptics.js', 'src/render/holeAppearance.js',
    'src/render/linearFrame.js', 'src/render/galaxyVolume.js', 'src/scene.js', 'package.json'])
    sources[label].hashes[path] = sha(await readFile(resolve(tree, path)));
  const river = await readFile(resolve(tree, 'src/river.js'), 'utf8');
  const compute = river.match(/const COMPUTE_FRAG = \/\* glsl \*\/`([\s\S]*?)`;/)?.[1];
  assert(compute, 'Compute shader must be present'); sources[label].computeHash = sha(compute);
  if (label === 'B') sources[label].hashes['src/riverRadianceMath.js'] = sha(await readFile(resolve(tree, 'src/riverRadianceMath.js')));
}
assert.equal(sources.A.computeHash, sources.B.computeHash, 'Paired radiance must not change the compute shader');
if (process.argv.includes('--validate')) {
  console.log(JSON.stringify({ hooks: 'valid', device, sources, protocol, selectedFixtures, browserRun: false }, null, 2)); process.exit(0);
}
await mkdir(out, { recursive: true });
const browserArgs = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
const report = { version: 3, preparationPolicy:'asset-native-v2', runLimits, device, viewport, deviceScaleFactor: 1, sources, protocol, selectedFixtures, browserArgs,
  scope: selectedFixtures.length === protocol.fixtures.length ? 'complete device suite' : 'single-view shard; aggregate all three views for acceptance',
  expectedFrames: { measured: selectedFixtures.length * 1200, warmup: selectedFixtures.length * 240 },
  harness: Object.fromEntries(await Promise.all(['benchmark-river-radiance.mjs', 'river-radiance-paired-browser.mjs', 'river-radiance-paired-protocol.mjs', 'river-radiance-qa.mjs', 'river-radiance-full-preparation.mjs', 'river-radiance-run-budget.mjs', 'river-radiance-volume-progress.mjs', 'river-radiance-native-settlement.mjs', 'river-radiance-preparation-qa.mjs', 'fixtures/river-radiance-proxima.json']
    .map(async path => [path, sha(await readFile(new URL(path, import.meta.url)))]))),
  method: 'One Chromium instance, two fresh full application pages per view, serial normal browser timer tasks, real production frame, gl.finish plus synchronous 1px RGBA readback included in duration; all 120 warmup and 60/block samples retained across all five ABBA/BAAB trials',
  fixtureControl: 'Physical clock, source fixture and camera are frozen. River dtSim alone receives the declared visual advection; normal device particle/draw/compute policies and all normally enabled production render layers remain present. This is steady-state render performance, not live orbital evolution',
  setup: 'Preparation uses native rAF without test-added GPU synchronization, then verified drains and full volume history use before the separate synchronous warmup. AT-HYG uses its normal camera-priority selection for exactly 120 production streaming updates/eight tiles per update, then test-only hooks hold further tile requests. Every selected row remains rendered, its sorted tile IDs and row-byte SHA256 must match, and pending loads/assets/workers settle using equal serial A/B frames before the fixed 120-frame warmup. No fixture, trial or sample retry, replacement or outlier removal',
  omissions: ['Further AT-HYG tile requests after the fixed 120-update normal-entry history; bounded row IDs and hashes are recorded, every selected row and all normally enabled renderer layers remain present'],
  limitations: 'Hosted headless Chromium/SwiftShader with desktop/mobile viewport and production device policy; not physical-device FPS, native GPU evidence, startup latency, live physical evolution or interaction latency. Bounded catalog setup and further streaming are outside timing; this is not a maximum-catalog stress test. Equal frozen workload is mandatory; adaptive-quality divergence fails without compensating or lowering counts',
  gate: 'Every fixture: median of all five paired p95 ratios <=1.05. All measured long tasks must pass unchanged blocking-time, count and maximum-duration guards. GPU loss, GL errors, unequal workload, missing maps/layers or incomplete samples fail',
  hardware: { platform: os.platform(), release: os.release(), arch: os.arch(), logicalCPUs: os.cpus().length,
    cpuModels: [...new Set(os.cpus().map(cpu => cpu.model))], totalMemoryBytes: os.totalmem(), node: process.version },
  scenarios: [], workerEvents: [], errors: [], passed: false };
const save = () => durableReport(resolve(out, 'report.json'), report);
let activeBudget;
const checkpointTimer=setInterval(()=>activeBudget?.checkpoint(),runLimits.checkpointMs);
installReportSignals(report,()=>activeBudget,save);
save();
let browser;
const servers = {}, caches = [], contexts = new Set();
async function cleanupWithinBudget(operation){
  let timer;
  try{return await Promise.race([operation(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Browser cleanup exceeded ten seconds')),10000);})]);}
  finally{clearTimeout(timer);}
}
async function activate(page) {
  const start = performance.now(); await page.bringToFront(); await page.waitForFunction(() => !document.hidden);
  return performance.now() - start;
}
async function frame(page) {
  const start = performance.now();
  const sample = await page.evaluate(() => new Promise((resolve, reject) => setTimeout(() => {
    try { resolve(__pairedFrame()); } catch (error) { reject(error); }
  }, 0)));
  sample.roundTripMs = performance.now() - start;
  sample.protocolAndSchedulingMs = Math.max(0, sample.roundTripMs - sample.frameAndFinishMs);
  return sample;
}
async function frames(page, count, samples, label, previous, last) {
  for (let i = 0; i < count; i++) {
    await activeBudget.run(async()=>{
      const sample = await frame(page); samples.push(sample);save();validateSample(sample);
      sample.volumeProgress=await page.evaluate(()=>pairedQA.volume.pairedVolumeProgress());save();
      assert(volumeRefinementReady(sample.volumeProgress,volumeSize),'Full history readiness must persist through acceptance');
      last[label]=validateRefinementAdvance(previous[label],sample.volumeProgress,last[label],volumeSize);previous[label]=sample.volumeProgress;
      if (samples.length > 1) assert.equal(sample.frameNo, samples.at(-2).frameNo + 1, 'Every timer task executes exactly one frame');
    },`synchronized frame ${label}`);
  }
}
async function snapshot(page) {
  const state = await page.evaluate(readState);
  state.river.textureHash = sha(Buffer.from(state.river.textureBase64, 'base64')); delete state.river.textureBase64;
  return state;
}
async function observerProbe(page) {
  await activate(page);
  const probe = await page.evaluate(() => new Promise(resolve => setTimeout(() => {
    const start = performance.now(); while (performance.now() - start < 80) { /* verified normal timer-task probe */ }
    resolve({ start, end: performance.now() });
  }, 0)));
  await page.waitForFunction(probe => {
    for (const entry of __pairedObserver.takeRecords()) __pairedLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
    return __pairedLongTasks.some(entry => Math.min(entry.startTime + entry.duration, probe.end) - Math.max(entry.startTime, probe.start) >= 70);
  }, probe, { timeout: 10000 });
  return page.evaluate(probe => {
    const observed = __pairedLongTasks.filter(entry => Math.min(entry.startTime + entry.duration, probe.end) - Math.max(entry.startTime, probe.start) >= 70);
    __pairedObserver.takeRecords(); __pairedLongTasks.length = 0;
    return { ...probe, deliberateBusyMs: 80, minimumObservedMs: 70, observed, passed: observed.length > 0, clearedBeforeWarmup: true };
  }, probe);
}
try {
  for (const spec of selectedFixtures) {
    const name = `${spec.subject}-${spec.rate ? 'advection' : 'paused'}`;
    const scenario = { name, fixture: spec, pages: {}, setup: {},
      phases: [], preparation: {prefix:{A:[],B:[]},assets:{A:[],B:[],readiness:[]},nativeField:{A:[],B:[],complete:false},nativeWarmup:{A:[],B:[]},refinement:{A:[],B:[]},fences:[],complete:false},
      warmup: { A: [], B: [] }, trials: [], longTasks: {}, loadAverageBefore: os.loadavg() };
    report.scenarios.push(scenario); const pages = {};
    activeBudget=phaseBudget(scenario.phases,save);activeBudget.start('preparation');
    if(!browser)await activeBudget.run(async()=>{
      browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: browserArgs });
      report.browser = await browser.version();
      for (const [label, tree] of [['A', baselineRoot], ['B', root]]) {
        const cacheDir = await mkdtemp(resolve(os.tmpdir(), `radiance-paired-${label}-`)); caches.push(cacheDir);
        const server = await createServer({ root: tree, cacheDir, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
          plugins: [{ name: 'full-radiance-paired-qa', enforce: 'pre', transform:(source,id)=>volumeProgressTransform(source,id)??transform(source,id) }] });
        await server.listen(); servers[label] = server;
      }

    },'browser and server initialization');
    for (const label of ['A', 'B']) await activeBudget.run(async()=>{
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile }); contexts.add(context);
      await context.addInitScript(initializeDocument);
      const page = await context.newPage(); pages[label] = page; page.setDefaultTimeout(120000);
      page.on('pageerror', error => report.errors.push({ name, label, message: error.stack || error.message }));
      page.on('console', message => { if (message.type() === 'error') report.errors.push({ name, label, message: message.text() }); });
      page.on('worker', worker => {
        report.workerEvents.push({ name, label, event: 'created', url: worker.url(), nodeTime: performance.now() });
        worker.on('close', () => report.workerEvents.push({ name, label, event: 'closed', url: worker.url(), nodeTime: performance.now() }));
      });
      await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, body: '' }));
      await page.goto(`http://127.0.0.1:${servers[label].httpServer.address().port}/?${new URLSearchParams(protocol.query)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__AP_READY && window.__pairedFrame && window.__pairedRadianceRead);
      scenario.pages[label] = await page.evaluate(initializeQA, { fixture, spec, catalogSetupUpdates: protocol.catalogSetupUpdates });
      assert.equal(scenario.pages[label].mobile, mobile); assert(scenario.pages[label].longTaskSupported, 'Long-task observer is mandatory');
      scenario.pages[label].observerProbe = await observerProbe(page);
      assert(scenario.pages[label].observerProbe.passed, 'A supported but nonfunctional observer cannot report a pass');
      await page.waitForFunction(() => pairedQA.tier1.tier1Stats().initialized);
      scenario.setup[label] = { catalogSetupUpdates: protocol.catalogSetupUpdates, tileRequestsPerUpdate: 8 };
      await save();
    },`initialize ${label}`);
    assert.equal(scenario.pages.A.gpu, scenario.pages.B.gpu, 'Same renderer implementation required');
    const previous=await prepareFullView({pages,record:scenario.preparation,viewport,mobile,budget:activeBudget,save,activate,readiness});
    scenario.prepared=await activeBudget.run(async()=>({A:await snapshot(pages.A),B:await snapshot(pages.B)}),'fully prepared snapshots');
    for(const label of ['A','B'])assertHealthyState(scenario.prepared[label],mobile,spec.subject);
    assertMatchedState(scenario.prepared.A,scenario.prepared.B);activeBudget.finish();
    const last=Object.fromEntries(['A','B'].map(label=>[label,previous[label].observedAtMs]));
    activeBudget.start('warmup');
    for (const label of ['A', 'B']) { await activeBudget.run(()=>activate(pages[label]),`warmup activation ${label}`); await frames(pages[label], protocol.warmupFrames, scenario.warmup[label],label,previous,last); }
    scenario.before = await activeBudget.run(async()=>({A:await snapshot(pages.A),B:await snapshot(pages.B)}),'warmup snapshots');
    for (const label of ['A', 'B']) assertHealthyState(scenario.before[label], mobile, spec.subject);
    assertMatchedState(scenario.before.A, scenario.before.B); await save();activeBudget.finish();activeBudget.start('measurement');
    for (const [trialIndex, order] of protocol.orders.entries()) {
      const trial = { index: trialIndex + 1, order, blocks: [] }; scenario.trials.push(trial);
      for (const [blockIndex, label] of [...order].entries()) {
        const page = pages[label], activationMs = await activeBudget.run(()=>activate(page),`measured activation ${label}`);
        const block = { index: blockIndex + 1, label, activationMs, loadAverage: os.loadavg(), samples: [] };
        trial.blocks.push(block);
        block.startTime = await activeBudget.run(()=>page.evaluate(() => performance.now()),'block start');
        await frames(page, protocol.samplesPerBlock, block.samples,label,previous,last);
        block.endTime = await activeBudget.run(()=>page.evaluate(() => performance.now()),'block end');
        block.frame = summarize(block.samples.map(s => s.frameAndFinishMs));
        block.cpu = summarize(block.samples.map(s => s.cpuMs)); block.readback = summarize(block.samples.map(s => s.readbackMs));
        block.roundTrip = summarize(block.samples.map(s => s.roundTripMs));
        block.after = await activeBudget.run(()=>snapshot(page),'block snapshot'); await save();
        assertHealthyState(block.after, mobile, spec.subject);
        const sameOrdinal = trial.blocks.find(other => other.label !== label && other.after?.workload.frameNo === block.after.workload.frameNo);
        if (sameOrdinal) assertMatchedState(sameOrdinal.after, block.after);
        assert.equal(block.after.t, scenario.before[label].t, 'Physical clock stays frozen');
        assert.deepEqual(block.after.camera, scenario.before[label].camera, 'Fixed camera');
        assert.deepEqual(block.after.ship, scenario.before[label].ship, 'Fixed paused ship');
      }
      Object.assign(trial, trialSummary(trial)); await save();
      console.log('PAIRED RADIANCE', device, name, trial.index, order, 'p95', trial.A.p95, trial.B.p95, 'ratio', trial.ratio);
    }
    for (const label of ['A', 'B']) {
      // Drain after a normal browser task so the last measured task is delivered.
      const entries = await activeBudget.run(()=>pages[label].evaluate(() => new Promise(resolve => setTimeout(() => {
        for (const entry of __pairedObserver.takeRecords()) __pairedLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
        resolve(__pairedLongTasks);
      }, 0))),'long-task observer drain');
      const ranges = scenario.trials.flatMap(t => t.blocks.filter(b => b.label === label).map(b => ({ start: b.startTime, end: b.endTime })));
      scenario.longTasks[label] = summarizeLongTasks(entries, ranges);
    }
    // Per-view budgets are diagnostic. The unchanged acceptance budget is
    // computed over all measured windows across all three views below.
    scenario.longTaskBudget = longTaskBudget(scenario.longTasks.A, scenario.longTasks.B);
    await save();activeBudget.finish();Object.assign(scenario,scenarioSummary(scenario));save();
    await cleanupWithinBudget(async()=>{for(const page of Object.values(pages)){const context=page.context();await context.close();contexts.delete(context);}});
  }
  report.longTasks = {};
  for (const label of ['A', 'B']) {
    const sets = report.scenarios.map(s => s.longTasks[label]);
    report.longTasks[label] = { measuredCount: sets.reduce((n, s) => n + s.measuredCount, 0),
      measuredTotalBlockingMs: sets.reduce((n, s) => n + s.measuredTotalBlockingMs, 0),
      measuredMaximumMs: Math.max(...sets.map(s => s.measuredMaximumMs)) };
  }
  report.longTaskBudget = longTaskBudget(report.longTasks.A, report.longTasks.B);
  report.shardComplete = report.scenarios.length === selectedFixtures.length && report.scenarios.every(s => s.passesFivePercentTarget) && report.errors.length === 0;
  report.suiteComplete = selectedFixtures.length === protocol.fixtures.length;
  report.passed = report.suiteComplete ? report.shardComplete && report.longTaskBudget.passed : null;
  await save(); console.log(JSON.stringify({ device, passed: report.passed,
    scenarios: report.scenarios.map(s => ({ name: s.name, medianPairedRatio: s.medianPairedRatio, longTasksPassed: s.longTaskBudget.passed })) }, null, 2));
  assert(report.suiteComplete ? report.passed : report.shardComplete, 'Mandatory p95, long-task, full-workload or browser-error guard failed; all raw evidence retained');
} catch (error) {
  report.errors.push({ message: error.stack || String(error) }); report.passed = false; process.exitCode = 1; console.error(error);
} finally {
  clearInterval(checkpointTimer);save();
  try{await cleanupWithinBudget(async()=>{
    for(const context of contexts)await context.close();await browser?.close();
    for(const server of Object.values(servers))await server.close();
    for(const cache of caches)await rm(cache,{recursive:true,force:true});
  });}
  catch(error){report.errors.push({message:error.stack||String(error)});report.passed=false;report.shardComplete=false;process.exitCode=1;}
  finally{save();}
  process.exit(process.exitCode||0);
}
