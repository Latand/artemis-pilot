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
    return source + '\nwindow.__cloudActivationFrame=()=>{lastMobileFrame=-Infinity;frame();renderer.getContext().finish();return {t:G.t,frameNo};};';
}
if (process.argv.includes('--validate')) {
    instrument(await readFile('src/main.js', 'utf8'), '/src/main.js');
    instrument(await readFile('src/trails.js', 'utf8'), '/src/trails.js');
    assert.throws(() => instrument('', '/src/main.js'));
    assert.throws(() => instrument('const predLine = new THREE.Line(\nconst predLine = new THREE.Line(', '/src/trails.js'));
    console.log('Cloud activation capture validates exact production hooks; no browser started');
    process.exit(0);
}
await mkdir(out, { recursive: true });
const report = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), mobile,
    scope: 'Injected, bounded default-Explore Earth activation diagnostic. Full production layers and existing np=128 capture setting; no UI-flow or performance acceptance claim. G.predict is observed, never forced.',
    maximumFrames: 8, frames: [], captures: [], checks: [], errors: [] };
const save = () => writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
const check = (value, name) => { report.checks.push({ name, pass: !!value }); };
const bounded = async (name, action, limit = 90000) => {
    console.log(name);
    const result = await boundedDiagnostic(action, limit);
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
        setFocus('earth'); cam.dist = 60; cam.distTarget = null; cam.yaw = 3.54; cam.pitch = 1.2;
        __qaDt = mobile ? 1 / 30 : 1 / 60;
    }, mobile));
    for (const [name, rate] of [['paused', 0], ['forward256', 256 * 86400], ['reverse256', -256 * 86400], ['paused-again', 0]]) {
        await bounded(`${name}: rate`, () => page.evaluate(async rate => {
            const time = await import('/src/timeCtl.js'); time.setWarp(rate || 1); time.setPaused(rate === 0);
        }, rate));
        for (let i = 0; i < 2; i++) {
            assert(report.frames.length < report.maximumFrames, 'bounded frame count');
            report.frames.push(await bounded(`${name}: frame${i}`, () => page.evaluate(() => __cloudActivationFrame())));
        }
        const state = await bounded(`${name}: draw list`, () => page.evaluate(async () => {
            const { renderer, scene, renderQuality } = await import('/src/scene.js'); const { clouds } = await import('/src/bodies.js');
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
                guard: { ...guard }, bias: clouds.material.polygonOffset, depthTest: clouds.material.depthTest,
                blocked: describe(items.find(item => item.object.id === guard.blockedObjectId)),
                listCount: items.length, predictionItems: predictionItems.map(describe),
                emptyDraws: items.filter(item => item.geometry.drawRange.count === 0 && item.material.depthWrite).slice(0, 256).map(describe) };
        }));
        report.captures.push({ name, ...state }); await save();
        await bounded(`${name}: screenshot`, () => page.screenshot({ path: resolve(out, `${name}.png`), timeout: 20000 }), 25000);
        check(state.mode === 'observe' && state.focus === 'earth' && state.mobile === mobile, `${name}: correct actual production tier and focus`);
        check(state.predict === false, `${name}: default prediction stays disabled without QA forcing`);
        check(state.predictionItems.length === 1 && state.predictionItems[0].positionCount === 2400 && state.predictionItems[0].color === '6fd8c8' && state.predictionItems[0].drawRange.count === 0, `${name}: exact disabled legacy prediction is render-listed with zero count`);
        check(state.cloudVisible && state.cloudListed && state.guard.enabled && state.guard.skippedEmpty >= 1 && state.bias && state.depthTest, `${name}: clear-footprint guard really enables while ordinary depth testing stays on`);
        await save();
    }
    check(report.errors.length === 0, 'no JS/shader errors');
    check(report.frames.length === report.maximumFrames, 'exactly eight production frames');
    await save();
    assert(report.checks.every(check => check.pass), 'activation checks failed; preserved report identifies the exact remaining blocker');
} catch (error) {
    report.failure = error.stack || String(error); await save(); throw error;
} finally {
    if (browser) await boundedDiagnostic(() => browser.close(), 5000);
    await boundedDiagnostic(() => server.close(), 5000);
}
console.log(JSON.stringify({ output: out, captures: report.captures.length, checks: report.checks.length, errors: report.errors.length }));
