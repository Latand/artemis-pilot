// Fresh-process cold shader-entry/cache diagnostic. This is not the paired
// performance acceptance gate and must never replace or loosen that gate.
// DEVICE=desktop|mobile node scripts/verify-surface-fastpath.mjs [ROOT] [OUTPUT]
// --validate checks the production-frame hooks without launching a browser.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { boundedDiagnostic } from './qa-bounded-diagnostic.mjs';
import { coldExactPrograms, oneActiveExposureProgram } from './surface-fastpath-policy.mjs';

const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const root = resolve(args[0] || '.'), out = resolve(args[1] || 'evidence/surface-fastpath');
const device = process.env.DEVICE || 'desktop', mobile = device === 'mobile';
assert(['desktop', 'mobile'].includes(device));
const viewport = mobile ? { width: 430, height: 932 } : { width: 960, height: 640 };
const fixture = { focus: 'earth', distance: 25, yaw: -.4, pitch: .45 };
const query = { focus: 'earth', dist: '25', hidehelp: '1', dpr: '1', tier1: '0', realsky: '0', field: '0',
    galaxyvol: '0', galaxies: '0', galaxy: '0', river: '0', bloom: '0', compile: '0', galadapt: '0',
    earthnight: '1', clouds: '1', moonmap: '1' };
const browserArgs = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
const warmupFrames = 120, blockFrames = 10, cycles = 10, rate = 256 * 86400;
function once(source, token, replacement) {
    assert.equal(source.split(token).length, 2, `Surface diagnostic production hook changed: ${token}`);
    return source.replace(token, replacement);
}
function transform(source, id) {
    id = id.replaceAll('\\', '/').split('?')[0];
    if (id.endsWith('/src/render/catalogStars.js')) return once(source, 'const start = () => loadTier0();',
        'const start = () => {}; // QA: paired benchmark background-HYG omission.');
    if (id.endsWith('/src/render/bodySurfaceMaterial.js')) return source + '\nexport const surfaceDiagnosticQueue=()=>({pending:pending.size,inFlight:!!inFlight});\n';
    if (!id.endsWith('/src/main.js')) return null;
    source = once(source, 'const firstFrameT0 = perfStart();',
        'G.t=0;G.paused=true;G.warp=1;resetEphem();clock.getDelta=()=>1/60;\nconst firstFrameT0 = perfStart();');
    source = once(source, 'renderer.setAnimationLoop(frame);', '// QA: production frames delivered explicitly by timer tasks.');
    return source + `\nconst surfaceDiagnosticPixel = new Uint8Array(4);
window.__surfaceDiagnosticFrame = () => {
    clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;
    const start=performance.now();frame();const cpuMs=performance.now()-start;
    const gl=renderer.getContext(),finishStart=performance.now();gl.finish();const finishMs=performance.now()-finishStart;
    const readbackStart=performance.now();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,surfaceDiagnosticPixel);
    const end=performance.now();
    return {startTime:start,endTime:end,cpuMs,finishMs,readbackMs:end-readbackStart,totalMs:end-start,frameNo,
        contextLost:gl.isContextLost(),glError:gl.getError()};
};\n`;
}
for (const path of ['src/main.js', 'src/render/catalogStars.js', 'src/render/bodySurfaceMaterial.js']) {
    const source = await readFile(resolve(root, path), 'utf8');
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: transform(source, '/' + path) });
}
if (process.argv.includes('--validate')) {
    console.log(JSON.stringify({ hooks: 'valid', device, fixture, viewport, query, warmupFrames, blockFrames, cycles,
        synchronization: 'readPixels included in total', acceptanceGate: 'unchanged external paired p95 and long-task gates' }));
    process.exit(0);
}

await mkdir(out, { recursive: true });
const report = {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    device, fixture, viewport, query, browserArgs, warmupFrames, blockFrames, cycles, rate,
    scope: 'Fresh Chromium process, one context, no earlier active exposure draw or prewarm. Production Earth-near frame, lighting and materials with paired-benchmark background omissions.',
    viewportPolicy: 'Desktop diagnostic uses 960x640 to bound software-rendered cold/repeat cost; camera/fixture/query match the paired Earth-near setup. This smaller viewport is not a replacement for acceptance measurements.',
    omittedUnrelatedLayers: ['AT-HYG streaming', 'background HYG layer', 'procedural background field', 'volumetric galaxy', 'galaxy population', 'gravity overlay', 'bloom', 'eager warm compile'],
    synchronization: 'Normal timer task executes production frame, gl.finish and synchronous one-pixel RGBA readback into one reusable array. Total includes GPU completion; metadata collection follows the timed section.',
    coldCost: 'First-ready active frame includes shader compilation, driver JIT and first integral GPU texture uploads. CPU prefix generation is measured separately before that draw.',
    acceptance: 'Diagnostic only. Existing five paired ABBA/BAAB trial median p95 <=1.05 and unchanged long-task blocking/count/maximum gates remain mandatory elsewhere.',
    limitations: 'CI Chromium/SwiftShader, not hardware FPS. No performance threshold is inferred from this unpaired diagnostic.',
    phases: [], samples: [], checks: [], screenshots: [], errors: [], passed: false,
};
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
function check(ok, name) {
    report.checks.push({ name, pass: !!ok });
    assert(ok, name);
}
async function phase(name) {
    report.phase = name; report.phases.push({ name, nodeTime: performance.now() });
    console.log('SURFACE FASTPATH', name); await save();
}
let browser, context, page, server, cacheDir;
async function state() {
    return page.evaluate(() => {
        const q = surfaceDiagnosticQA, renderer = q.scene.renderer;
        const materialState = mesh => {
            const material = mesh.material, properties = renderer.properties.get(material), exposure = material.userData.surfaceRotationExposure;
            return { materialId: material.id, version: material.version, programId: properties.currentProgram?.id ?? null,
                programCacheKey: properties.currentProgram?.cacheKey ?? null,
                cachedProgramIds: [...(properties.programs?.values() || [])].map(program => program.id).sort((a, b) => a - b),
                cachedPrograms: [...(properties.programs?.values() || [])].map(program => ({id:program.id,key:program.cacheKey})).sort((a,b)=>a.id-b.id),
                variant: !!material.defines?.SURFACE_ROTATION_EXPOSURE, turns: exposure?.turns.value ?? null,
                visible: mesh.visible, slots: (exposure?.slots || []).map(slot => ({ ready: !!slot.texture,
                    textureId: slot.texture?.uuid ?? null, size: slot.size.value.toArray(), uploaded: !!slot.texture && !!renderer.properties.get(slot.texture).__webglTexture })) };
        };
        return { t: q.G.t, paused: q.G.paused, warp: q.G.warp, frameNo: window.__surfaceDiagnosticLastFrame ?? null,
            earth: materialState(q.bodies.earth), clouds: materialState(q.bodies.clouds),
            totalProgramIds: renderer.info.programs.map(program => program.id).sort((a, b) => a - b),
            totalPrograms: renderer.info.programs.length, resources: { ...renderer.info.memory },
            draw: { ...renderer.info.render }, preparation: { ...q.exposure.surfaceExposurePreparation },
            camera: { distance: q.scene.cam.dist, yaw: q.scene.cam.yaw, pitch: q.scene.cam.pitch },
            maps: { day: !!q.bodies.earth.material.uniforms.dayMap.value,
                night: q.bodies.earth.material.uniforms.uHasNight.value, clouds: q.bodies.earth.material.uniforms.uHasClouds.value },
            exactSpin: q.bodies.earth.rotation.y === (q.constants.OMEGA_EARTH * q.G.t) % (2 * Math.PI) };
    });
}
async function frame(label) {
    const result = await boundedDiagnostic(() => page.evaluate(() => new Promise((resolveFrame, reject) => setTimeout(() => {
        try {
            const result = __surfaceDiagnosticFrame(); window.__surfaceDiagnosticLastFrame = result.frameNo; resolveFrame(result);
        } catch (error) { reject(error); }
    }, 0))), 90000);
    assert(result.ok, `${label}: production frame/readback failed or exceeded 90 seconds: ${result.error || ''}`);
    const timing = result.value;
    const snapshot = await state(), sample = { label, ...timing, state: snapshot };
    const previous = report.samples.at(-1);
    report.samples.push(sample);
    check(!timing.contextLost && timing.glError === 0, `${label}: completed readback uses a live, error-free GL context`);
    if (previous) check(timing.frameNo === previous.frameNo + 1, `${label}: a real production frame executed`);
    check(snapshot.exactSpin, `${label}: physical Earth angle remains exact`);
    return sample;
}
async function block(label, n = blockFrames) {
    const samples = [];
    for (let i = 0; i < n; i++) samples.push(await frame(`${label}-${i}`));
    await save(); return samples;
}
async function setRate(value) {
    await page.evaluate(value => {
        const q = surfaceDiagnosticQA; q.time.setWarp(value || 1); q.time.setPaused(value === 0);
    }, value);
}
async function screenshot(name) {
    const result = await boundedDiagnostic(() => page.screenshot({ path: resolve(out, name + '.png'), timeout: 10000 }), 12000);
    report.screenshots.push({ name, saved: result.ok, error: result.ok ? undefined : result.error });
    return result.ok;
}
try {
    await phase('start fresh browser');
    cacheDir = await mkdtemp(resolve(tmpdir(), 'artemis-surface-fastpath-'));
    server = await createServer({ root, cacheDir, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
        plugins: [{ name: 'surface-fastpath-diagnostic', enforce: 'pre', transform }] });
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: browserArgs });
    report.browser = await browser.version();
    context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    await context.addInitScript(() => {
        Date.now = () => Date.UTC(2026, 9, 1, 12);
        localStorage.setItem('ap_introSeen', '1'); localStorage.setItem('ap_uiMode', 'observe'); localStorage.setItem('ap_perf', '0');
        window.__surfaceDiagnosticLongTasks = [];
        if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
            window.__surfaceDiagnosticObserver = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) __surfaceDiagnosticLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
            });
            __surfaceDiagnosticObserver.observe({ type: 'longtask', buffered: true });
        }
    });
    page = await context.newPage(); page.setDefaultTimeout(120000);
    page.on('pageerror', error => report.errors.push({ type: 'pageerror', message: error.stack || error.message }));
    page.on('console', message => { if (message.type() === 'error') report.errors.push({ type: 'console', message: message.text() }); });
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, body: '' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${new URLSearchParams(query)}`, { waitUntil: 'domcontentloaded' });
    await phase('wait for production readiness');
    await page.waitForFunction(() => window.__AP_READY && window.__surfaceDiagnosticFrame);
    report.environment = await page.evaluate(async fixture => {
        const [scene, bodies, { G }, input, time, constants, exposure, surfaces] = await Promise.all([
            import('/src/scene.js'), import('/src/bodies.js'), import('/src/state.js'), import('/src/input.js'),
            import('/src/timeCtl.js'), import('/src/constants.js'), import('/src/render/surfaceRotationExposure.js'),
            import('/src/render/bodySurfaceMaterial.js'),
        ]);
        window.surfaceDiagnosticQA = { scene, bodies, G, input, time, constants, exposure, surfaces };
        input.setFocus(fixture.focus); scene.cam.dist = fixture.distance; scene.cam.distTarget = null;
        scene.cam.yaw = fixture.yaw; scene.cam.pitch = fixture.pitch;
        time.setPaused(true); time.setWarp(1); G.gr = false;
        const gl = scene.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
        return { mobile: scene.renderQuality.mobile, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
            longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
    }, fixture);
    check(report.environment.mobile === mobile, 'production quality matches the requested device');
    await page.bringToFront(); await page.waitForFunction(() => !document.hidden);
    await phase('paused warmup'); await block('warmup-paused', warmupFrames);
    await page.waitForFunction(() => { const q = surfaceDiagnosticQA.surfaces.surfaceDiagnosticQueue(); return !q.pending && !q.inFlight; });
    report.beforePreparation = await state();
    check(report.beforePreparation.maps.day && report.beforePreparation.maps.night === 1 && report.beforePreparation.maps.clouds === 1, 'real Earth day/night/cloud maps are loaded');
    check(!report.beforePreparation.earth.variant && !report.beforePreparation.clouds.variant, 'fresh context has only exact Earth/cloud variants');
    // Loading an alpha map or changing renderer lighting features may leave
    // historical exact programs. Cold means no averaged variant was compiled.
    check(coldExactPrograms(report.beforePreparation.earth) && coldExactPrograms(report.beforePreparation.clouds), 'both materials have only exact initial programs and a valid current program');
    check(report.beforePreparation.preparation.built === 0, 'no exposure prefixes were prepared before the diagnostic');
    check(await screenshot('00-paused-before-preparation'), 'initial paused screenshot saved');

    await phase('prepare CPU prefixes without active draw');
    const preparationStart = performance.now();
    report.enqueue = await page.evaluate(rate => {
        const q = surfaceDiagnosticQA, start = performance.now(), shutter = rate / 30;
        const earthReady = q.exposure.updateSurfaceRotationExposure(q.bodies.earth.material, q.constants.OMEGA_EARTH, shutter);
        const cloudReady = q.exposure.updateSurfaceRotationExposure(q.bodies.clouds.material, q.constants.OMEGA_EARTH + 2 * Math.PI / (14 * 86400), shutter);
        return { cpuMs: performance.now() - start, earthReady, cloudReady, preparation: { ...q.exposure.surfaceExposurePreparation } };
    }, rate);
    await page.waitForFunction(() => surfaceDiagnosticQA.exposure.surfaceExposurePreparation.pending === 0);
    report.preparationWallMs = performance.now() - preparationStart;
    report.afterPreparation = await state();
    check(report.afterPreparation.earth.slots.every(slot => slot.ready) && report.afterPreparation.clouds.slots.every(slot => slot.ready), 'all integral CPU buffers are ready before first active draw');
    check([...report.afterPreparation.earth.slots, ...report.afterPreparation.clouds.slots].every(slot => !slot.uploaded), 'cold integral GPU uploads have not been prewarmed');
    check(JSON.stringify(report.afterPreparation.totalProgramIds) === JSON.stringify(report.beforePreparation.totalProgramIds), 'CPU preparation acquires no GPU program');
    check(!report.afterPreparation.earth.variant && !report.afterPreparation.clouds.variant, 'CPU preparation does not switch exposure variants');
    await block('prepared-paused');
    report.beforeFirstActive = await state();
    check([...report.beforeFirstActive.earth.slots, ...report.beforeFirstActive.clouds.slots].every(slot => !slot.uploaded), 'prepared paused frames do not upload dormant integral textures');
    check(JSON.stringify(report.beforeFirstActive.totalProgramIds) === JSON.stringify(report.beforePreparation.totalProgramIds), 'prepared paused frames do not compile an averaged program');

    await phase('first ready active draw'); await setRate(rate);
    const firstActive = await frame('first-active-cold'); report.firstActive = firstActive;
    check(firstActive.state.earth.variant && firstActive.state.clouds.variant, 'first high-rate frame activates both averaged programs');
    check(firstActive.state.earth.turns === 1 && firstActive.state.clouds.turns === 1, '256 days/s uses complete longitude exposure');
    check(firstActive.state.earth.programId !== report.beforePreparation.earth.programId && firstActive.state.clouds.programId !== report.beforePreparation.clouds.programId, 'actual production Earth/cloud program IDs change on cold entry');
    await save(); check(await screenshot('01-first-active-cold'), 'cold active screenshot saved');
    await block('first-active-cached');
    const activeReady = await state(); report.activeReady = activeReady;
    check(oneActiveExposureProgram(report.beforePreparation.earth, activeReady.earth) && oneActiveExposureProgram(report.beforePreparation.clouds, activeReady.clouds), 'each material adds only one averaged program for the same renderer features');
    const targetResources = snapshot => JSON.stringify([snapshot.earth.slots, snapshot.clouds.slots]);
    const targetResourcesAfterFirstActive = targetResources(activeReady);
    report.nonTargetResourceChanges = [];
    report.globalResourcePolicy = 'Global program/resource counts are retained on every frame. Cache/resource invariants are strict for Earth/cloud materials. Other production bodies continue to evolve and may legitimately change LOD or prepare their own maps; such global changes are explicitly reported rather than attributed to the Earth variant cache.';

    await phase('ten pause resume cycles');
    report.transitions = [];
    for (let cycle = 0; cycle < cycles; cycle++) {
        await setRate(0); const paused = await frame(`cycle-${cycle}-pause-transition`);
        const pausedTail = await block(`cycle-${cycle}-paused`);
        await setRate(rate); const resumed = await frame(`cycle-${cycle}-resume-transition`);
        const activeTail = await block(`cycle-${cycle}-active`);
        report.transitions.push({ cycle, paused, resumed });
        for (const sample of [paused, ...pausedTail]) {
            check(!sample.state.earth.variant && !sample.state.clouds.variant && sample.state.earth.turns === 0 && sample.state.clouds.turns === 0, `${sample.label}: pause restores exact sampling immediately`);
            check(sample.state.earth.programId === report.beforePreparation.earth.programId && sample.state.clouds.programId === report.beforePreparation.clouds.programId, `${sample.label}: paused programs are reused`);
        }
        for (const sample of [resumed, ...activeTail]) {
            check(sample.state.earth.programId === firstActive.state.earth.programId && sample.state.clouds.programId === firstActive.state.clouds.programId, `${sample.label}: active programs are reused`);
        }
        for (const sample of [paused, ...pausedTail, resumed, ...activeTail]) {
            check(JSON.stringify(sample.state.earth.cachedProgramIds) === JSON.stringify(activeReady.earth.cachedProgramIds) && JSON.stringify(sample.state.clouds.cachedProgramIds) === JSON.stringify(activeReady.clouds.cachedProgramIds), `${sample.label}: exposure cache remains bounded`);
            check(targetResources(sample.state) === targetResourcesAfterFirstActive, `${sample.label}: Earth/cloud GPU resources remain identical`);
            if (JSON.stringify(sample.state.totalProgramIds) !== JSON.stringify(activeReady.totalProgramIds) ||
                JSON.stringify(sample.state.resources) !== JSON.stringify(activeReady.resources) || sample.state.preparation.built !== activeReady.preparation.built)
                report.nonTargetResourceChanges.push({ label: sample.label, totalProgramIds: sample.state.totalProgramIds,
                    resources: sample.state.resources, preparation: sample.state.preparation });
        }
        check(pausedTail.every(sample => sample.state.earth.version === paused.state.earth.version && sample.state.clouds.version === paused.state.clouds.version), `cycle ${cycle}: steady paused frames do not invalidate materials`);
        check(activeTail.every(sample => sample.state.earth.version === resumed.state.earth.version && sample.state.clouds.version === resumed.state.clouds.version), `cycle ${cycle}: steady active frames do not invalidate materials`);
        await save();
        if (cycle === 0 || cycle === cycles - 1) check(await screenshot(`02-cycle-${cycle}-active-cached`), `cycle ${cycle}: cached screenshot saved`);
    }
    await phase('reverse cached exposure'); await setRate(-rate);
    const reverse = await block('reverse-cached');
    check(reverse.every(sample => sample.state.earth.programId === firstActive.state.earth.programId && sample.state.clouds.programId === firstActive.state.clouds.programId), 'reverse reuses the same averaged programs');
    check(await screenshot('03-reverse-cached'), 'reverse screenshot saved');
    await setRate(0); await frame('final-pause');
    check(await screenshot('04-final-paused'), 'final exact screenshot saved');
    report.final = await state();
    const totals = labels => report.samples.filter(sample => labels(sample.label)).map(sample => sample.totalMs);
    const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { count: sorted.length, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)], max: sorted.at(-1) }; };
    report.timingSummary = { firstActiveTotalMs: firstActive.totalMs, preparedPaused: summary(totals(label => label.startsWith('prepared-paused-'))),
        firstActiveCached: summary(totals(label => label.startsWith('first-active-cached-'))),
        pauseTransitions: summary(totals(label => label.endsWith('-pause-transition'))),
        resumeTransitions: summary(totals(label => label.endsWith('-resume-transition'))), reverseCached: summary(totals(label => label.startsWith('reverse-cached-'))) };
    check(report.errors.length === 0, 'no page, console or shader errors');
    report.passed = true;
} catch (error) {
    report.failure = { phase: report.phase, message: error.stack || String(error) };
    console.error('SURFACE FASTPATH FAILED', report.failure.message);
    if (page && !page.isClosed()) {
        const diagnostic = await boundedDiagnostic(state, 5000);
        report.failureState = diagnostic;
        await screenshot('failure-current-frame');
    }
    process.exitCode = 1;
} finally {
    if (page && !page.isClosed()) {
        report.longTasks = await boundedDiagnostic(() => page.evaluate(() => {
            const entries = [...__surfaceDiagnosticLongTasks, ...(__surfaceDiagnosticObserver?.takeRecords() || []).map(entry => ({ startTime: entry.startTime, duration: entry.duration }))];
            return { diagnosticOnly: true, entries, count: entries.length, totalBlockingMs: entries.reduce((n, entry) => n + Math.max(0, entry.duration - 50), 0), maximumMs: Math.max(0, ...entries.map(entry => entry.duration)) };
        }), 5000);
    }
    await save();
    if (browser) report.browserClose = await boundedDiagnostic(() => browser.close(), 10000);
    if (server) await server.close();
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
    await save();
}
