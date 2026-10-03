import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { boundedDiagnostic } from './qa-bounded-diagnostic.mjs';
const mobile = process.env.DEVICE === 'mobile';
const out = resolve(process.env.ARTEMIS_EVIDENCE || `evidence/cloud-activation-${mobile ? 'mobile' : 'desktop'}`);
function replaceOnce(source, needle, replacement) {
    assert.equal(source.split(needle).length, 2, `exact capture hook: ${needle}`);
    return source.replace(needle, replacement);
}
function instrument(source, id) {
    if (id.split('?')[0].endsWith('/src/trails.js')) {
        assert.equal(source.split('const predLine = new THREE.Line(').length, 2, 'exact legacy prediction owner');
        return source + '\nwindow.__qaShipPredictionLine = predLine;';
    }
    if (!id.split('?')[0].endsWith('/src/main.js')) return;
    source = replaceOnce(source, 'const firstFrameT0 = perfStart();', 'G.t=0;G.paused=true;resetEphem();clock.getDelta=()=>window.__qaDt??1/60;const firstFrameT0 = perfStart();');
    source = replaceOnce(source, 'renderer.setAnimationLoop(frame);', '');
    return source + '\nwindow.__cloudActivationFrame=(capture=false)=>{lastMobileFrame=-Infinity;const start=performance.now();frame();const gl=renderer.getContext();gl.finish();const result={t:G.t,frameNo,contextLost:gl.isContextLost(),canvasWidth:renderer.domElement.width,canvasHeight:renderer.domElement.height};if(capture)result.png=renderer.domElement.toDataURL(\'image/png\');result.completedMs=performance.now()-start;return result;};';
}
if (process.argv.includes('--validate')) {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: instrument(await readFile('src/main.js', 'utf8'), '/src/main.js') });
    instrument(await readFile('src/trails.js', 'utf8'), '/src/trails.js');
    assert.throws(() => instrument('', '/src/main.js'));
    assert.throws(() => instrument('const predLine = new THREE.Line(\nconst predLine = new THREE.Line(', '/src/trails.js'));
    console.log('Cloud activation capture validates exact production hooks; no browser started');
    process.exit(0);
}
await mkdir(out, { recursive: true });
const report = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), mobile,
    scope: 'Injected, bounded default-Explore Earth activation diagnostic. Full production layers and existing np=128 capture setting. PNGs read the rendered canvas in the same task before default-buffer discard; DOM/HUD, UI-flow and performance acceptance remain separate. G.predict is observed, never forced.',
    maximumFrames: 17, phases: [], frames: [], captures: [], checks: [], errors: [] };
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
const check = (value, name) => { report.checks.push({ name, pass: !!value }); };
const bounded = async (name, action, limit = 90000) => {
    console.log(name);
    const start = performance.now();
    const result = await boundedDiagnostic(action, limit);
    report.phases.push({ name, completedMs: performance.now() - start, ok: result.ok });
    if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result)}`);
    return result.value;
};
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{ name: 'cloud-activation-capture', enforce: 'pre', transform: instrument }] });
let browser, page;
try {
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
        args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    page = await browser.newPage({ viewport: mobile ? { width: 430, height: 932 } : { width: 960, height: 640 },
        isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    page.setDefaultTimeout(60000);
    await page.addInitScript(() => { localStorage.clear(); localStorage.setItem('ap_introSeen', '1'); localStorage.setItem('ap_uiMode', 'observe'); Date.now = () => Date.UTC(2026, 9, 3, 6); });
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
    await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, body: '' }));
    await bounded('load production app', () => page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=sun&hidehelp=1&compile=0&np=128`, { waitUntil: 'domcontentloaded' }));
    await bounded('production readiness', () => page.waitForFunction(() => window.__AP_READY && window.__cloudActivationFrame && window.__qaShipPredictionLine));
    await bounded('Earth camera setup', () => page.evaluate(async mobile => {
        const { cam } = await import('/src/scene.js'); const { setFocus } = await import('/src/input.js');
        window.__qaCloudMesh = (await import('/src/bodies.js')).clouds;
        window.__qaCloudPreparation = (await import('/src/render/surfaceRotationExposure.js')).surfaceExposurePreparation;
        setFocus('earth'); cam.dist = 60; cam.distTarget = null; cam.yaw = 3.54; cam.pitch = 1.2;
        __qaDt = mobile ? 1 / 30 : 1 / 60;
    }, mobile));
    // Framing Earth requests its real lazy cloud detail. Await the loaded
    // production alpha map; do not force cloud visibility or readiness flags.
    report.frames.push(await bounded('request lazy Earth cloud map', () => page.evaluate(() => __cloudActivationFrame())));
    await bounded('actual cloud map readiness', () => page.waitForFunction(() => {
        const image = window.__qaCloudMesh.material.alphaMap?.image;
        return !!image && (image.naturalWidth || image.width) > 0 && (image.naturalHeight || image.height) > 0;
    }));
    report.cloudReadiness = await page.evaluate(() => { const map = window.__qaCloudMesh.material.alphaMap; return { source: new URL(map.image.src).pathname, width: map.image.naturalWidth || map.image.width, height: map.image.naturalHeight || map.image.height }; });
    await save();
    for (const [name, rate, pitch = 1.2, distance = 60] of [['paused', 0], ['forward256', 256 * 86400], ['reverse256', -256 * 86400], ['paused-again', 0],
        ['north-pole-cap-paused', 0, 1.45, 8.5], ['north-pole-cap-active', 256 * 86400, 1.45, 8.5],
        ['south-pole-cap-paused', 0, -1.45, 8.5], ['south-pole-cap-active', -256 * 86400, -1.45, 8.5]]) {
        await bounded(`${name}: rate and camera`, () => page.evaluate(async ({ rate, pitch, distance }) => {
            const time = await import('/src/timeCtl.js'); time.setWarp(rate || 1); time.setPaused(rate === 0);
            const { cam } = await import('/src/scene.js'); cam.pitch = pitch; cam.dist = distance; cam.distTarget = null;
        }, { rate, pitch, distance }));
        let png;
        for (let i = 0; i < 2; i++) {
            assert(report.frames.length < report.maximumFrames, 'bounded frame count');
            const sample = await bounded(`${name}: frame${i}`, () => page.evaluate(capture => __cloudActivationFrame(capture), i === 1));
            if (sample.png) { png = sample.png; delete sample.png; }
            report.frames.push(sample);
            if (i === 0 && rate !== 0) await bounded(`${name}: actual requested exposure readiness`, () => page.waitForFunction(() => __qaCloudPreparation.pending === 0));
        }
        const state = await bounded(`${name}: draw list`, () => page.evaluate(async () => {
            const { renderer, scene, renderQuality, cam, camera } = await import('/src/scene.js'); const { clouds, earth, earthG } = await import('/src/bodies.js');
            const lists = renderer.renderLists.get(scene, 0), guard = clouds.material.userData.cloudDepthGuard;
            const items = [...lists.opaque, ...lists.transmissive, ...lists.transparent];
            const describe = item => item ? { id: item.object.id, type: item.object.type, name: item.object.name,
                legacyShipPrediction: item.object === window.__qaShipPredictionLine, material: item.material.type,
                color: item.material.color?.getHexString(), depthWrite: item.material.depthWrite, depthTest: item.material.depthTest,
                positionCount: item.geometry.attributes.position?.count, indexCount: item.geometry.index?.count ?? null,
                drawRange: { ...item.geometry.drawRange }, group: item.group ? { ...item.group } : null } : null;
            const predictionItems = items.filter(item => item.object === window.__qaShipPredictionLine);
            return { t: __G.t, mode: __G.uiMode, focus: __G.focus, predict: __G.predict, paused: __G.paused, rate: __G.warp,
                mobile: renderQuality.mobile, cloudVisible: clouds.visible, cloudListed: items.some(item => item.object === clouds), cloudTriangles: clouds.geometry.index.count / 3,
                camera: { distance: camera.position.distanceTo(earthG.position), requestedDistance: cam.dist, pitch: cam.pitch, yaw: cam.yaw },
                height: clouds.geometry.parameters.radius - earth.geometry.parameters.radius, cloudRotation: clouds.rotation.y,
                surfaceActive: !!clouds.material.userData.surfaceRotationExposure?.active, surfaceTurns: clouds.material.userData.surfaceRotationExposure?.turns.value,
                guard: { ...guard }, bias: clouds.material.polygonOffset, depthTest: clouds.material.depthTest,
                blocked: describe(items.find(item => item.object.id === guard.blockedObjectId)),
                listCount: items.length, predictionItems: predictionItems.map(describe),
                emptyDraws: items.filter(item => item.geometry.drawRange.count === 0 && item.material.depthWrite).slice(0, 256).map(describe) };
        }));
        report.captures.push({ name, ...state }); await save();
        assert(png?.startsWith('data:image/png;base64,'), 'same-task production canvas PNG exists');
        const bytes = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64');
        assert(bytes.byteLength > 100, 'canvas PNG is not an empty data URL');
        await writeFile(resolve(out, `${name}.png`), bytes);
        report.captures.at(-1).pngBytes = bytes.byteLength;
        check(state.cloudTriangles === (mobile ? 8120 : 13632) && Math.abs(state.height - .006) < 1e-9, `${name}: exact reviewed mesh and physical height`);
        check(rate === 0 || state.surfaceActive, `${name}: real high-rate exposure is ready for the pixel capture`);
        check(state.mode === 'observe' && state.focus === 'earth' && state.mobile === mobile, `${name}: correct actual production tier and focus`);
        check(state.predict === false, `${name}: default prediction stays disabled without QA forcing`);
        check(state.predictionItems.length === 1 && state.predictionItems[0].positionCount === 2400 && state.predictionItems[0].color === '6fd8c8' && state.predictionItems[0].drawRange.count === 0, `${name}: exact disabled legacy prediction is render-listed with zero count`);
        check(state.cloudVisible && state.cloudListed && state.guard.enabled && state.guard.skippedEmpty >= 1 && state.bias && state.depthTest, `${name}: clear-footprint guard really enables while ordinary depth testing stays on`);
        await save();
    }
    check(report.errors.length === 0, 'no JS/shader errors');
    check(report.frames.length === report.maximumFrames, 'exactly one lazy-load setup frame and sixteen sequence/polar frames');
    check(report.frames.every(frame => !frame.contextLost), 'context remains healthy through every same-task capture');
    await save();
    assert(report.checks.every(check => check.pass), 'activation checks failed; preserved report identifies the exact remaining blocker');
} catch (error) {
    report.failure = error.stack || String(error); await save(); throw error;
} finally {
    if (browser) await boundedDiagnostic(() => browser.close(), 5000);
    await boundedDiagnostic(() => server.close(), 5000);
}
console.log(JSON.stringify({ output: out, captures: report.captures.length, checks: report.checks.length, errors: report.errors.length }));
