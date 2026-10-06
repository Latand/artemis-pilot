// Paired full-application benchmark for CI Chromium/SwiftShader. Both source
// revisions share one browser and runner; only one page executes a frame at a
// time. Every predeclared ABBA/BAAB trial and raw sample is retained.
// BASE_ROOT=/exact/baseline DEVICE=desktop|mobile node scripts/benchmark-explored-systems.mjs [ROOT] [OUTPUT]
// --validate checks test-only hooks for both revisions without a browser.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { systemRenderStatement } from './explored-system-hooks.mjs';

const args = process.argv.slice(2).filter(value => !value.startsWith('--'));
const root = resolve(args[0] || '.'), baselineRoot = resolve(process.env.BASE_ROOT || '');
assert(process.env.BASE_ROOT, 'BASE_ROOT must name the exact baseline worktree');
const device = process.env.DEVICE || 'desktop', mobile = device === 'mobile';
assert(['desktop', 'mobile'].includes(device));
const out = resolve(args[1] || `evidence/explored/paired-${device}`);
const viewport = mobile ? { width: 430, height: 932 } : { width: 1200, height: 800 };
const browserArgs = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
const samplesPerBlock = 60, warmupFrames = 120;
const orders = ['ABBA', 'BAAB', 'ABBA', 'BAAB', 'ABBA'];
const fixtures = [
    { name: 'earth-near', focus: 'earth', distance: 25, yaw: -.4, pitch: .45 },
    { name: 'catalog-star', focus: 'star:2', distance: null, yaw: -.4, pitch: .45 },
    { name: 'system-overview', focus: 'star:4', distance: 1500000, yaw: -.4, pitch: .45 },
];
const query = { quality: 'high', focus: 'earth', dist: '25', hidehelp: '1', dpr: '1', tier1: '0', realsky: '0', field: '0',
    galaxyvol: '0', galaxies: '0', galaxy: '0', river: '0', bloom: '0', compile: '0', galadapt: '0',
    earthnight: '1', clouds: '1', moonmap: '1' };
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
const summarize = values => ({ count: values.length, min: Math.min(...values), p50: quantile(values, .5),
    p95: quantile(values, .95), max: Math.max(...values), mean: values.reduce((a, b) => a + b, 0) / values.length });
const revision = cwd => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
function once(source, token, replacement) {
    assert.equal(source.split(token).length, 2, `Paired benchmark hook changed: ${token}`);
    return source.replace(token, replacement);
}
function fineFrameSource(source) {
    // Recovery-aware revisions keep frame() as a guarded wrapper. The
    // measured path still calls that real wrapper; only the attribution copy
    // instruments its underlying step, after all acceptance samples.
    const entry = source.includes('function frameStep() {') ? 'frameStep' : 'frame';
    const start = source.indexOf(`function ${entry}() {`);
    const end = source.indexOf('// setAnimationLoop lets WebXR', start);
    assert(start >= 0 && end > start, 'Diagnostic frame extraction markers must exist');
    let body = source.slice(start, end).trim().replace(`function ${entry}()`, 'function pairedInstrumentedFrame()');
    const statements = [
        ['belt', 'beltCursor = advanceMinorSwarm(minorSwarms.belt, minorRenderers.belt, beltCursor, Math.ceil(minorRenderers.belt.capacity / 6), minorBeltStep);'],
        ['kuiper', 'kuiperCursor = advanceMinorSwarm(minorSwarms.kuiper, minorRenderers.kuiper, kuiperCursor, Math.ceil(minorRenderers.kuiper.capacity / 6), minorKuiperStep);'],
        ['curated.propagate', 'propagateInto(minorSwarms.curated, G.t, minorRenderers.curated.worldKm, minorSunWorld, 0, minorRenderers.curated.capacity, minorCuratedStep);'],
        ['curated.upload', 'uploadMinorResiduals(minorRenderers.curated, 0, minorRenderers.curated.capacity);'],
        ['systemRender', systemRenderStatement(body)],
        ['minorVisibility', 'setMinorVisible(cam.dist / K / AU_KM);'],
    ];
    for (const [name, statement] of statements) body = once(body, statement,
        `${name === 'belt' ? 'perfEnd("qa.bodies.beforeMinor", sceneBodiesT0);' : ''}{const qaStart=perfStart();${statement}perfEnd("qa.${name}",qaStart);}`);
    body = once(body, 'for (let i = 0; i < minorTailPairs.length; i++) {',
        'const qaTailsStart=perfStart();for (let i = 0; i < minorTailPairs.length; i++) {');
    body = once(body, 'updateCometTail(minorTailPairs[i], minorTailBody, minorSunWorld, minorTailBody);\n        }',
        'updateCometTail(minorTailPairs[i], minorTailBody, minorSunWorld, minorTailBody);\n        }perfEnd("qa.cometTails",qaTailsStart);');
    return body;
}
function transform(source, id) {
    id = id.replaceAll('\\', '/').split('?')[0];
    if (id.endsWith('/src/render/catalogStars.js')) return once(source, 'const start = () => loadTier0();',
        'const start = () => {}; // QA: unrelated background HYG layer omitted identically.');
    if (id.endsWith('/src/render/bodySurfaceMaterial.js')) return source + '\nexport const pairedSurfaceQueue=()=>({pending:pending.size,inFlight:!!inFlight});\n';
    if (!id.endsWith('/src/main.js')) return null;
    source = once(source, 'const firstFrameT0 = perfStart();',
        'G.t=0;G.paused=true;G.warp=1;resetEphem();clock.getDelta=()=>1/60;\nconst firstFrameT0 = perfStart();');
    source = once(source, 'renderer.setAnimationLoop(frame);', 'if (frameNo === 0) frame(); // QA: exactly one untimed initialization frame, then explicit serial delivery.');
    // The measured production frame is untouched. Its diagnostic copy is
    // compiled only after ALL acceptance windows, never before them.
    // Chromium WebGL finish() is only Flush(); readPixels establishes completion:
    // https://chromium.googlesource.com/chromium/src/third_party/+/master/blink/renderer/modules/webgl/webgl_rendering_context_base.cc#3557
    const fine = fineFrameSource(source);
    return source + `\nconst pairedReadbackPixel=new Uint8Array(4);\nwindow.__pairedFrame=()=>{clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;
        const start=performance.now();frame();const cpu=performance.now()-start;const gl=renderer.getContext();
        const finishStart=performance.now();gl.finish();const finishMs=performance.now()-finishStart;
        const readbackStart=performance.now();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pairedReadbackPixel);
        return {cpuMs:cpu,finishMs,readbackMs:performance.now()-readbackStart,frameAndFinishMs:performance.now()-start,frameNo};};
let pairedFineFrame=null;
window.__pairedFineFrame=()=>{pairedFineFrame ||= eval(${JSON.stringify('(')} + ${JSON.stringify(fine)} + ${JSON.stringify(')')});
    clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;const start=performance.now();pairedFineFrame();const gl=renderer.getContext();gl.finish();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pairedReadbackPixel);
    return {frameAndFinishMs:performance.now()-start,frameNo};};
window.__pairedWorkload=()=>({frameNo,beltCursor,kuiperCursor,nearVisualReady,nearFieldCadence:cam.dist>LY_SCENE*.2?'cosmic':'every-frame',
    mobile:renderQuality.mobile,quality:{dpr:renderer.getPixelRatio(),antialias:renderer.getContext().getContextAttributes().antialias,riverCapacity:river.count,bloom:!!bloomPass.enabled,lensing:!!lensingPass.enabled,volume:galaxyVolumeStats().enabled},warp:G.warp,gr:G.gr,uiMode:G.uiMode,
    minor:Object.fromEntries(['belt','kuiper','curated','oort'].map(k=>[k,{capacity:minorRenderers[k].capacity,elementCount:minorSwarms[k].length/6,
        first:Array.from(minorSwarms[k].slice(0,12)),last:Array.from(minorSwarms[k].slice(-12))}]))});\n`;
}
for (const tree of [baselineRoot, root]) for (const path of ['src/main.js', 'src/render/catalogStars.js', 'src/render/bodySurfaceMaterial.js']) {
    const source = await readFile(resolve(tree, path), 'utf8');
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: transform(source, '/' + path) });
    if (path === 'src/main.js') execFileSync(process.execPath, ['--input-type=module', '--check'], { input: '(' + fineFrameSource(source) + ')' });
}
if (process.argv.includes('--validate')) {
    console.log(JSON.stringify({ hooks: 'valid', device, fixtures, orders, warmupFrames, samplesPerBlock })); process.exit(0);
}
await mkdir(out, { recursive: true });
const sourceHashes = {};
for (const [label, tree] of [['A', baselineRoot], ['B', root]]) {
    sourceHashes[label] = {};
    for (const path of ['src/universe/minorBodies.js', 'src/universe/renderOrigin.js', 'src/moons.js'])
        sourceHashes[label][path] = createHash('sha256').update(await readFile(resolve(tree, path))).digest('hex');
    const mainSource = await readFile(resolve(tree, 'src/main.js'), 'utf8');
    const start = mainSource.indexOf('const sceneBodiesT0 = perfStart();'), end = mainSource.indexOf('const sceneFocusT0 = perfStart();', start);
    sourceHashes[label]['main.sceneBodies'] = createHash('sha256').update(mainSource.slice(start, end)).digest('hex');
}

const report = { version: 4, device, sourceHashes,
    fixedDiagnosticExperiment: 'After ALL acceptance fixtures and long-task collection: twenty attribution frames per fixture plus twenty fine-substage Earth frames and one 120-frame Earth CDP CPU profile per revision. No profiler runs between acceptance trials or fixtures', baselineRevision: revision(baselineRoot), candidateRevision: revision(root),
    epoch: '2026-10-01T12:00:00.000Z', query, viewport, deviceScaleFactor: 1, browserArgs, warmupFrames, samplesPerBlock, orders,
    hardware: { platform: os.platform(), release: os.release(), arch: os.arch(), logicalCPUs: os.cpus().length,
        cpuModels: [...new Set(os.cpus().map(cpu => cpu.model))], totalMemoryBytes: os.totalmem(), node: process.version },
    authority: 'Paired trials are the performance acceptance measurement because the sequential independent-browser timings confound revision with machine-time drift. Sequential raw reports and their comparison remain available as diagnostics; they are not deleted or relabeled as passing',
    scheduling: 'Both pages disable background timer/render throttling, have no automatic render loop, and are foregrounded before each measured block. The other page executes no application frames',
    method: 'One Chromium instance; two actual full-app pages; serial alternating ABBA/BAAB blocks; each measured frame is delivered by a normal setTimeout browser task including GPU finish plus a synchronous 1-pixel RGBA readback, never directly in a DevTools evaluation task',
    gpuSynchronization: 'Prior finish-only evidence contained severe stalls inside arbitrary WebGL calls; this experiment tests explicit readback synchronization. Every frame now reads one pixel into one reusable 4-byte array, forcing completed framebuffer work before the next sample; readback time is included and separately reported',
    gate: 'For each fixture, median of all five paired trial p95 ratios must be <=1.05. Every trial is mandatory, no outlier removal, replacement trials or selective reruns',
    limitations: 'CI headless Chromium/SwiftShader, not physical desktop/mobile hardware; matched app view with declared unrelated layers disabled',
    omissions: ['AT-HYG streaming', 'background HYG layer', 'procedural background field', 'volumetric galaxy', 'galaxy population', 'gravity overlay', 'bloom'],
    errors: [], scenarios: [], pages: {}, workerEvents: [], passed: false };
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
let browser;
const servers = [], caches = [], pages = {};
async function activate(page) {
    const start = performance.now(); await page.bringToFront(); await page.waitForFunction(() => !document.hidden);
    return performance.now() - start;
}
async function frame(page) {
    const start = performance.now();
    const sample = await page.evaluate(() => new Promise((resolve, reject) => {
        // DevTools evaluation work is not reliably exposed to Long Tasks.
        // Deliver production work on the browser's normal timer task queue.
        setTimeout(() => { try { resolve(__pairedFrame()); } catch (error) { reject(error); } }, 0);
    }));
    sample.roundTripMs = performance.now() - start;
    sample.protocolAndSchedulingMs = Math.max(0, sample.roundTripMs - sample.frameAndFinishMs);
    return sample;
}
async function frames(page, count) {
    const samples = [];
    for (let i = 0; i < count; i++) {
        const sample = await frame(page);
        if (samples.length) assert.equal(sample.frameNo, samples.at(-1).frameNo + 1, 'Every delivered sample must execute a real production frame, never a hidden/throttled no-op');
        samples.push(sample);
    }
    return samples;
}
async function state(page) {
    return page.evaluate(() => {
        const q = pairedQA, { cam, camera, renderer } = q.scene;
        const geometries = new Set(), materials = new Set(); let objects = 0;
        q.scene.scene.traverse(object => { objects++; if (object.geometry) geometries.add(object.geometry.uuid);
            for (const material of (Array.isArray(object.material) ? object.material : [object.material]).filter(Boolean)) materials.add(material.uuid); });
        return { sceneObjects: { objects, geometries: geometries.size, materials: materials.size }, focus: q.G.focus, t: q.G.t, paused: q.G.paused, seed: q.galaxy.getSeed(), epoch: q.epoch.getEpochMs(), workload: __pairedWorkload(),
            background: { galaxy: q.galaxyRender.galaxyPopulationStatus(), volume: q.volume.galaxyVolumeStats(), tides: q.tides.mergerTidesStatus(), field: q.field.resolvedFieldStatus(), surfaceQueue: q.surfaces.pairedSurfaceQueue() },
            ship: [q.G.x, q.G.y, q.G.z, q.G.vx, q.G.vy, q.G.vz],
            camera: { distance: cam.dist, yaw: cam.yaw, pitch: cam.pitch, target: cam.tgt.toArray(), position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), fov: camera.fov },
            render: { ...renderer.info.memory, programs: renderer.info.programs.length },
            maps: { night: q.bodies.shaderTick.earthUniforms.uHasNight.value, clouds: q.bodies.shaderTick.earthUniforms.uHasClouds.value, moon: !!q.bodies.moon.material.map } };
    });
}
try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
        args: browserArgs });
    report.browser = await browser.version();
    for (const [label, tree] of [['A', baselineRoot], ['B', root]]) {
        const cacheDir = await mkdtemp(resolve(os.tmpdir(), `artemis-paired-${label}-`)); caches.push(cacheDir);
        const server = await createServer({ root: tree, cacheDir, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
            plugins: [{ name: 'paired-explored-qa', enforce: 'pre', transform }] });
        await server.listen(); servers.push(server);
        const context = await browser.newContext({ viewport,
            deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
        await context.addInitScript(() => {
            Date.now = () => Date.UTC(2026, 9, 1, 12);
            localStorage.setItem('ap_introSeen', '1'); localStorage.setItem('ap_uiMode', 'observe'); localStorage.setItem('ap_perf', '0');
            window.__pairedLongTasks = [];
            if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
                window.__pairedObserver = new PerformanceObserver(list => {
                    for (const entry of list.getEntries()) __pairedLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
                });
                __pairedObserver.observe({ type: 'longtask', buffered: true });
            }
        });
        const page = await context.newPage(); pages[label] = page; page.setDefaultTimeout(120000);
        page.on('worker', worker => {
            report.workerEvents.push({ label, event: 'created', url: worker.url(), nodeTime: performance.now() });
            worker.on('close', () => report.workerEvents.push({ label, event: 'closed', url: worker.url(), nodeTime: performance.now() }));
        });
        page.on('pageerror', error => report.errors.push({ label, message: error.stack || error.message }));
        page.on('console', message => { if (message.type() === 'error' && /THREE|Shader|GL_INVALID|WebGL/i.test(message.text())) report.errors.push({ label, message: message.text() }); });
        await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, body: '' }));
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${new URLSearchParams(query)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__AP_READY && window.__pairedFrame);
        report.pages[label] = await page.evaluate(async () => {
            const [scene, input, state, surfaces, bodies] = await Promise.all([import('/src/scene.js'), import('/src/input.js'),
                import('/src/state.js'), import('/src/render/bodySurfaceMaterial.js'), import('/src/bodies.js')]);
            const [galaxy, epoch, galaxyRender, volume, tides, field] = await Promise.all([
                import('/src/universe/galaxy.js'), import('/src/epoch.js'), import('/src/render/galaxyPopulationRender.js'),
                import('/src/render/galaxyVolume.js'), import('/src/render/mergerTidesRender.js'), import('/src/render/resolvedFieldStars.js'),
            ]);
            window.pairedQA = { scene, input, G: state.G, surfaces, bodies, galaxy, epoch, galaxyRender, volume, tides, field };
            const gl = scene.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
            return { mobile: scene.renderQuality.mobile, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
        });
        assert.equal(report.pages[label].mobile, mobile, 'Production device quality must match request');
        assert(report.pages[label].longTaskSupported, 'Long-task observation must be supported for the acceptance gate');
        await activate(page);
        const probe = await page.evaluate(() => new Promise(resolve => setTimeout(() => {
            const start = performance.now(); while (performance.now() - start < 80) { /* deliberate one-time observer probe */ }
            resolve({ start, end: performance.now() });
        }, 0)));
        await page.waitForFunction(probe => {
            for (const entry of __pairedObserver.takeRecords()) __pairedLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
            return __pairedLongTasks.some(entry => Math.min(entry.startTime + entry.duration, probe.end) - Math.max(entry.startTime, probe.start) >= 70);
        }, probe, { timeout: 10000 });
        report.pages[label].observerProbe = await page.evaluate(probe => {
            const observed = __pairedLongTasks.filter(entry => Math.min(entry.startTime + entry.duration, probe.end) - Math.max(entry.startTime, probe.start) >= 70);
            __pairedObserver.takeRecords(); __pairedLongTasks.length = 0;
            return { ...probe, deliberateBusyMs: 80, minimumObservedMs: 70, observed, passed: observed.length > 0, clearedBeforeWarmup: true };
        }, probe);
        assert(report.pages[label].observerProbe.passed, 'The actual timer-task observer probe must pass; unsupported zero counts are never accepted');
        const initial = await state(page);
        assert.deepEqual(initial.maps, { night: 1, clouds: 1, moon: true }, 'Normal detail must preload before timing');
        report.pages[label].initial = initial; await save();
    }
    assert.equal(report.pages.A.gpu, report.pages.B.gpu, 'Both pages must share the same renderer implementation');
    for (const fixture of fixtures) {
        const scenario = { fixture, warmup: {}, trials: [], diagnostics: {}, loadAverageBefore: os.loadavg() }; report.scenarios.push(scenario);
        for (const label of ['A', 'B']) {
            const page = pages[label]; await activate(page);
            await page.evaluate(fixture => {
                const q = pairedQA; q.input.setFocus(fixture.focus);
                if (fixture.distance !== null) q.scene.cam.dist = fixture.distance;
                q.scene.cam.distTarget = null; q.scene.cam.yaw = fixture.yaw; q.scene.cam.pitch = fixture.pitch;
            }, fixture);
            scenario.warmup[label] = await frames(page, warmupFrames);
            await page.waitForFunction(() => { const s = pairedQA.surfaces.pairedSurfaceQueue(); return !s.pending && !s.inFlight; });
            scenario.warmup[label].push(...await frames(page, 4));
        }
        scenario.before = { A: await state(pages.A), B: await state(pages.B) };
        scenario.activeWorkersBefore = Object.fromEntries(['A', 'B'].map(label => [label, pages[label].workers().map(worker => worker.url())]));
        assert.equal(scenario.before.A.seed, scenario.before.B.seed); assert.equal(scenario.before.A.epoch, scenario.before.B.epoch);
        assert.deepEqual(scenario.before.A.workload, scenario.before.B.workload, 'Exact seed, minor-swarm records, capacities and frame cadence must match');
        assert.deepEqual(scenario.before.A.camera, scenario.before.B.camera, `${fixture.name}: matched camera pose`);
        assert.deepEqual(scenario.before.A.ship, scenario.before.B.ship, `${fixture.name}: matched paused ship`);
        assert.deepEqual(scenario.before.A.maps, scenario.before.B.maps, `${fixture.name}: matched preloaded maps`);
        for (const [trialIndex, order] of orders.entries()) {
            const trial = { index: trialIndex + 1, order, blocks: [] }; scenario.trials.push(trial);
            for (const [blockIndex, label] of [...order].entries()) {
                const page = pages[label], activationMs = await activate(page);
                const startTime = await page.evaluate(() => performance.now());
                const samples = await frames(page, samplesPerBlock);
                const endTime = await page.evaluate(() => performance.now());
                const block = { index: blockIndex + 1, label, activationMs, loadAverage: os.loadavg(), startTime, endTime, samples,
                    frame: summarize(samples.map(s => s.frameAndFinishMs)), cpu: summarize(samples.map(s => s.cpuMs)),
                    protocolAndScheduling: summarize(samples.map(s => s.protocolAndSchedulingMs)), roundTrip: summarize(samples.map(s => s.roundTripMs)) };
                // Observe errors outside the timed block; a lost context makes
                // readPixels a no-op and must never masquerade as a fast frame.
                block.gpuStatus = await page.evaluate(() => {
                    const gl = pairedQA.scene.renderer.getContext();
                    return { contextLost: gl.isContextLost(), error: gl.getError() };
                });
                trial.blocks.push(block); await save();
                assert.deepEqual(block.gpuStatus, { contextLost: false, error: 0 },
                    `${fixture.name} ${label}: measured readback must use a live, error-free GL context`);
            }
            const forLabel = label => trial.blocks.filter(block => block.label === label).flatMap(block => block.samples);
            trial.A = summarize(forLabel('A').map(sample => sample.frameAndFinishMs));
            trial.B = summarize(forLabel('B').map(sample => sample.frameAndFinishMs));
            trial.ratio = trial.B.p95 / trial.A.p95; trial.regressionPercent = (trial.ratio - 1) * 100;
            console.log('PAIRED', device, fixture.name, trial.index, order, 'p95', trial.A.p95, trial.B.p95, 'ratio', trial.ratio);
        }
        scenario.medianPairedRatio = quantile(scenario.trials.map(trial => trial.ratio), .5);
        scenario.ratioRange = { min: Math.min(...scenario.trials.map(trial => trial.ratio)), max: Math.max(...scenario.trials.map(trial => trial.ratio)) };
        scenario.passesFivePercentTarget = scenario.medianPairedRatio <= 1.05;
        scenario.after = { A: await state(pages.A), B: await state(pages.B) };
        for (const label of ['A', 'B']) {
            assert.equal(scenario.after[label].t, 0); assert.equal(scenario.after[label].paused, true);
            assert.deepEqual(scenario.after[label].ship, scenario.before[label].ship, 'Measured frames must never move the paused ship');
            assert.deepEqual(scenario.after[label].camera, scenario.before[label].camera, 'Measured camera must stay fixed');
        }
        await save();
    }
    report.longTasks = {};
    for (const label of ['A', 'B']) {
        const entries = await pages[label].evaluate(() => [...__pairedLongTasks, ...(__pairedObserver?.takeRecords() || []).map(entry => ({ startTime: entry.startTime, duration: entry.duration }))]);
        const ranges = report.scenarios.flatMap(s => s.trials.flatMap(t => t.blocks.filter(b => b.label === label).map(b => ({ start: b.startTime, end: b.endTime }))));
        const measured = entries.filter(entry => ranges.some(range => entry.startTime >= range.start && entry.startTime <= range.end));
        report.longTasks[label] = { thresholdMs: 50, measuredCount: measured.length, measuredTotalBlockingMs: measured.reduce((n, entry) => n + Math.max(0, entry.duration - 50), 0),
            measuredMaximumMs: Math.max(0, ...measured.map(entry => entry.duration)), measured, allEntries: entries };
    }
    // Tail stalls below the p95 cut must still be able to fail acceptance.
    // Windows contain equal frame counts for both labels; retain the original
    // explicit blocking-time/count/maximum budget on these paired windows.
    const beforeLong = report.longTasks.A, afterLong = report.longTasks.B;
    report.longTaskBudget = {
        scope: 'All measured paired windows, with equal frame counts and no discarded tasks',
        allowedTotalBlockingMs: beforeLong.measuredTotalBlockingMs * 1.05 + 50,
        allowedMaximumMs: Math.max(200, beforeLong.measuredMaximumMs * 1.05),
        allowedCount: Math.ceil(beforeLong.measuredCount * 1.05) + 1,
    };
    report.longTaskBudget.passed = afterLong.measuredTotalBlockingMs <= report.longTaskBudget.allowedTotalBlockingMs &&
        afterLong.measuredMaximumMs <= report.longTaskBudget.allowedMaximumMs && afterLong.measuredCount <= report.longTaskBudget.allowedCount;
    // CPU profiling can alter JIT state. Run all diagnostics only after every
    // acceptance frame and its long-task record has been collected.
    for (const scenario of report.scenarios) {
        const { fixture } = scenario;
        for (const label of ['A', 'B']) {
            await activate(pages[label]);
            await pages[label].evaluate(fixture => {
                const q = pairedQA; q.input.setFocus(fixture.focus);
                if (fixture.distance !== null) q.scene.cam.dist = fixture.distance;
                q.scene.cam.distTarget = null; q.scene.cam.yaw = fixture.yaw; q.scene.cam.pitch = fixture.pitch;
            }, fixture);
            await frames(pages[label], warmupFrames);
            await pages[label].waitForFunction(() => { const s = pairedQA.surfaces.pairedSurfaceQueue(); return !s.pending && !s.inFlight; });
            await frames(pages[label], 4);
            // Attribution pass only: never included in the performance gate.
            const page = pages[label]; await activate(page);
            await page.evaluate(label => {
                __PERF.setEnabled(true); __PERF.clear();
                if (label === 'B') {
                    window.__pairedHiddenWrites = [];
                    window.__pairedUIObserver = new MutationObserver(records => {
                        for (const record of records) __pairedHiddenWrites.push({ id: record.target.id, oldValue: record.oldValue });
                    });
                    __pairedUIObserver.observe(document.querySelector('#exploreSystem'), {
                        subtree: true, attributes: true, attributeFilter: ['hidden'], attributeOldValue: true,
                    });
                }
            }, label);
            try {
                const samples = await frames(page, 20);
                scenario.diagnostics[label] = { samples, ...await page.evaluate(label => {
                    const result = { stages: structuredClone(__PERF.samples), last: structuredClone(__PERF.last),
                        renderer: { ...__PERF.renderInfo }, memory: { ...__PERF.mem } };
                    if (label === 'B') {
                        result.systemControlHiddenWrites = [...__pairedHiddenWrites, ...__pairedUIObserver.takeRecords().map(record => ({ id: record.target.id, oldValue: record.oldValue }))];
                        __pairedUIObserver.disconnect();
                    }
                    return result;
                }, label) };
            } finally { await page.evaluate(() => { __PERF.setEnabled(false); window.__pairedUIObserver?.disconnect(); }); }
            if (label === 'B') assert.equal(scenario.diagnostics.B.systemControlHiddenWrites.length, 0,
                `${fixture.name}: steady-state system-control subtree must receive no hidden-attribute writes in twenty production frames`);
            if (fixture.name === 'earth-near') {
                const diagnostic = scenario.diagnostics[label];
                diagnostic.activeWorkers = page.workers().map(worker => worker.url());
                await page.evaluate(() => { __PERF.setEnabled(true); __PERF.clear(); });
                try {
                    diagnostic.fineFrames = [];
                    for (let i = 0; i < 20; i++) diagnostic.fineFrames.push(await page.evaluate(() => new Promise((resolve, reject) => setTimeout(() => {
                        try {
                            const frame = __pairedFineFrame();
                            resolve({ ...frame, stages: Object.fromEntries(Object.entries(__PERF.last).filter(([name]) => name.startsWith('qa.'))) });
                        } catch (error) { reject(error); }
                    }, 0))));
                    diagnostic.fineStages = await page.evaluate(() => structuredClone(__PERF.samples));
                    diagnostic.workload = await state(page);
                } finally { await page.evaluate(() => __PERF.setEnabled(false)); }
                if (process.env.PAIRED_CPU_PROFILE !== '0') {
                    const session = await page.context().newCDPSession(page);
                    const browserSession = await browser.newBrowserCDPSession();
                    const processBefore = await browserSession.send('SystemInfo.getProcessInfo');
                    await session.send('Profiler.enable'); await session.send('Profiler.setSamplingInterval', { interval: 1000 });
                    await session.send('Performance.enable');
                    const before = await session.send('Performance.getMetrics');
                    await session.send('Profiler.start');
                    diagnostic.profileFrames = await frames(page, 120);
                    const { profile } = await session.send('Profiler.stop');
                    const after = await session.send('Performance.getMetrics');
                    const processAfter = await browserSession.send('SystemInfo.getProcessInfo');
                    await browserSession.detach();
                    const file = `${device}-earth-${label}.cpuprofile`;
                    await writeFile(resolve(out, file), JSON.stringify(profile));
                    const byId = new Map(profile.nodes.map(node => [node.id, node])), selfMicros = new Map();
                    for (let i = 0; i < (profile.samples || []).length; i++) {
                        const id = profile.samples[i]; selfMicros.set(id, (selfMicros.get(id) || 0) + (profile.timeDeltas?.[i] || 0));
                    }
                    diagnostic.cpuProfile = { file, sampleIntervalUs: 1000, frames: 120,
                        topSelfTime: [...selfMicros].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([id, microseconds]) => ({ microseconds, ...byId.get(id)?.callFrame })),
                        metricsBefore: before.metrics, metricsAfter: after.metrics,
                        processCPU: processAfter.processInfo.map(process => ({ ...process, cpuDeltaSeconds: process.cpuTime - (processBefore.processInfo.find(before => before.id === process.id)?.cpuTime || 0) })),
                        processAttributionNote: 'CPU deltas for all Chromium process types, including GPU, over the same 120-frame profile window; only this page is manually rendering' };
                    await session.send('Profiler.disable'); await session.detach();
                }
            }
        }
        await save();
    }
    report.passed = report.scenarios.length === fixtures.length && report.scenarios.every(s => s.trials.length === orders.length && s.passesFivePercentTarget) &&
        report.longTaskBudget.passed && !report.errors.length;
    await save();
    console.log(JSON.stringify({ device, passed: report.passed, scenarios: report.scenarios.map(s => ({ fixture: s.fixture.name, ratio: s.medianPairedRatio, range: s.ratioRange, passes: s.passesFivePercentTarget })) }, null, 2));
    assert(report.passed, 'Paired full-app p95, mandatory long-task budget or another assertion failed; all trials are preserved');
} catch (error) {
    report.errors.push({ message: error.stack || String(error) }); report.passed = false; process.exitCode = 1; console.error(error);
} finally {
    await save(); await browser?.close(); for (const server of servers) await server.close();
    for (const cache of caches) await rm(cache, { recursive: true, force: true });
}
