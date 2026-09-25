// Real WebGL regression in the running application. No mocked THREE renderer.
// BASELINE=1 records known old failures, allowing identical before/after captures.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] || process.cwd());
const out = resolve(process.argv[3] || 'evidence/galaxy');
const baseline = process.env.BASELINE === '1';
await mkdir(out, { recursive: true });
const report = { baseline, epoch: '2026-09-13T12:00:00Z', simulatedSeconds: 0,
    exposure: 0.15, checks: [], frames: [], errors: [], timings: {},
    scope: 'Isolated volume in the running app, plus actual tier/composer/occlusion paths. Not a headset or hardware FPS benchmark.' };
const check = (name, pass, expectedOldFailure = false) => {
    report.checks.push({ name, pass: !!pass, expectedOldFailure: baseline && expectedOldFailure });
    console.log(pass ? 'PASS' : baseline && expectedOldFailure ? 'BASELINE DEFECT' : 'FAIL', name);
};
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const url = `http://127.0.0.1:${server.httpServer.address().port}/?hidehelp=1&dpr=1&tier1=0&galadapt=0&focus=sun&dist=1e4&realsky=0&river=0`;
async function openPage(fault = 'hold') {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') report.errors.push(m.text()); });
    await page.addInitScript(({ fault }) => {
        Date.now = () => Date.UTC(2026, 8, 13, 12);
        localStorage.setItem('ap_introSeen', '1');
        const NativeWorker = Worker; window.__releaseGalaxy = () => {};
        window.Worker = class extends NativeWorker {
            constructor(url, options) {
                const galaxy = String(url).includes('galaxyMapsWorker');
                if (galaxy && fault === 'throw') throw new Error('Injected galaxy worker failure');
                super(url, options);
                if (galaxy && fault === 'hold') {
                    let held = true, pending;
                    this.addEventListener('message', event => {
                        if (held) { pending = event.data; event.stopImmediatePropagation(); }
                    }, true);
                    window.__releaseGalaxy = () => {
                        held = false;
                        if (pending) this.dispatchEvent(new MessageEvent('message', { data: pending }));
                    };
                }
            }
        };
    }, { fault });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__AP_READY);
    await page.evaluate(async () => {
        const s = await import('/src/scene.js'), v = await import('/src/render/galaxyVolume.js');
        const c = await import('/src/universe/coords.js'), { K } = await import('/src/constants.js');
        const e = await import('/src/render/stellarAppearance.js'), T = await import('/node_modules/three/build/three.module.js');
        const origin = await import('/src/universe/renderOrigin.js');
        const { setPaused } = await import('/src/timeCtl.js'); setPaused(true, 'capture');
        s.renderer.setAnimationLoop(null); window.__G.predict = false;
        s.renderQuality.mobile = false; s.renderer.setSize(640, 400, false);
        s.camera.aspect = 1.6; s.camera.fov = 48; s.camera.updateProjectionMatrix();
        e.stellarExposure.value = 0.15; e.extragalacticExposure.blend = 0; e.extragalacticExposure.stretch = 0;
        window.test = { s, v, c, K, e, T, origin, time: 0, saved: {}, empty: new T.Scene() };
        window.pose = (position = [8178, 0, 20.8], target = [0, 0, 0]) => {
            const p = []; c.galToSceneUnitsInto(...position, p, 0, K); s.camera.position.set(...p);
            c.galToSceneUnitsInto(...target, p, 0, K); s.camera.lookAt(...p); s.camera.updateMatrixWorld();
        };
        window.draw = ({ png = false, save = '', compare = '', tier = false, occlude = false, composer = false } = {}) => {
            const r = s.renderer, gl = r.getContext();
            v.updateGalaxyVolume(s.camera, test.time);
            r.setRenderTarget(null); r.setScissorTest(false); r.autoClear = true;
            const start = performance.now(); r.clear();
            if (composer) s.composer.render();
            else if (tier) s.renderSceneTiered(r, occlude ? test.foreground : test.empty, s.camera);
            else { v.renderGalaxyVolume(r); if (occlude) { r.autoClear = false; r.render(test.foreground, s.camera); } }
            gl.finish(); const renderAndFinishMs = performance.now() - start;
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, pixels = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            let sum = 0, nonzero = 0, delta = 0, edge = 0; const old = test.saved[compare];
            for (let i = 0; i < pixels.length; i += 4) {
                sum += pixels[i] + pixels[i+1] + pixels[i+2];
                if (pixels[i] + pixels[i+1] + pixels[i+2] > 3) nonzero++;
                if (old?.length === pixels.length) for (let j = 0; j < 3; j++) delta += Math.abs(old[i+j] - pixels[i+j]);
                if ((i / 4) % w > 0) edge += Math.abs(pixels[i] - pixels[i-4]);
            }
            if (save) test.saved[save] = pixels;
            const center = ((h >> 1) * w + (w >> 1)) * 4;
            return { mean: sum / (w*h*3), nonzero: nonzero / (w*h), edge: edge / (w*h),
                mae: old?.length === pixels.length ? delta / (w*h*3) : null,
                center: [...pixels.slice(center, center+3)], size: [w,h], renderAndFinishMs,
                stats: v.galaxyVolumeStats(), png: png ? r.domElement.toDataURL('image/png') : null };
        };
        pose();
    });
    return page;
}
async function frame(page, name, args = {}) {
    const f = await page.evaluate(args => draw(args), { ...args, png: !!name });
    if (name) { await writeFile(`${out}/${name}.png`, Buffer.from(f.png.split(',')[1], 'base64')); }
    delete f.png; report.frames.push({ name, ...f }); return f;
}
async function settle(page) {
    let f;
    for (let i = 0; i < 40; i++) { f = await frame(page, null); if (!f.stats.draft && f.stats.fade > .999) return f; await page.waitForTimeout(80); }
    throw new Error('Galaxy refinement never settled');
}
try {
    const page = await openPage();
    report.gpu = await page.evaluate(() => {
        const gl = test.s.renderer.getContext(), d = gl.getExtension('WEBGL_debug_renderer_info');
        return { vendor: d ? gl.getParameter(d.UNMASKED_VENDOR_WEBGL) : null,
            renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
            browser: navigator.userAgent, pixelRatio: test.s.renderer.getPixelRatio() };
    });
    const startup = await frame(page, '00-coarse-startup');
    check('Immediate shared-model coverage before full worker result', startup.mean > 1, true);
    await page.evaluate(() => __releaseGalaxy());
    await page.waitForFunction(() => test.v.galaxyVolumeStats().mapsReady);
    await settle(page);
    const still = await frame(page, '01-settled', { save: 'still' });
    check('Settled galaxy is nonblack', still.mean > 1);
    // Same observer, orientation and projection: resizing alone used to black out.
    await page.evaluate(() => test.s.renderer.setSize(800, 500, false));
    const resized = await frame(page, '02-first-frame-after-resize');
    check('No black first frame after render-target resize', resized.mean > 1, true);
    await settle(page);
    await frame(page, '03-resized-settled', { save: 'resized' });
    const motion = [];
    for (let i = 0; i < 16; i++) {
        await page.evaluate(() => test.s.camera.rotateY(.002));
        const f = await frame(page, `motion-${String(i).padStart(2,'0')}`); motion.push(f);
    }
    check('Every continuously rotating frame has coverage', motion.every(f => f.mean > 1));
    check('Rotation preserves valid completed angular detail', motion.every(f => f.stats.historyUsed === true), true);
    report.timings.rotationRenderAndFinishMs = motion.map(f => f.renderAndFinishMs);
    await page.evaluate(() => pose()); await settle(page);
    const returned = await frame(page, '04-return', { compare: 'resized' });
    check('Returning to the same observer is deterministic', returned.mae < .05);
    await page.evaluate(() => { test.origin.setOrigin(1e15, -4e13, 2e12); });
    const rebased = await frame(page, '05-rebased', { compare: 'resized' });
    check('Floating render origin does not move the physical observer', rebased.mae < .05);
    await page.evaluate(() => pose([8178.01, 0, 20.8]));
    const translated = await frame(page, '06-translated');
    check('Translation rejects stale angular history', translated.stats.historyUsed === false, true);
    await settle(page);
    await page.evaluate(() => { test.time = 1e13; });
    const changed = await frame(page, '07-model-time-change');
    check('Changed galaxy model rejects angular history', changed.stats.historyUsed === false, true);
    await page.evaluate(() => { test.time = 0; pose(); }); await settle(page);
    const direct = await frame(page, '08-direct', { save: 'direct' });
    const tier = await frame(page, '09-depth-tiers', { tier: true, compare: 'direct' });
    check('Depth-tier path preserves the same background', tier.mean > 1 && tier.mae < .1);
    const restored = await page.evaluate(() => {
        const { s, v, T } = test, r = s.renderer, gl = r.getContext();
        const rt = new T.WebGLRenderTarget(320, 240);
        rt.viewport.set(11,13,250,190); rt.scissor.set(17,19,170,140); rt.scissorTest = true;
        r.setRenderTarget(rt); r.autoClear = false; r.xr.enabled = true;
        const snapshot = () => ({ sameTarget: r.getRenderTarget() === rt, auto: r.autoClear, xr: r.xr.enabled,
            viewport: [...gl.getParameter(gl.VIEWPORT)], current: r.getCurrentViewport(new T.Vector4()).toArray(),
            scissor: [...gl.getParameter(gl.SCISSOR_BOX)], scissorTest: gl.isEnabled(gl.SCISSOR_TEST) });
        const before = snapshot(); v.renderGalaxyVolume(r); const after = snapshot();
        r.xr.enabled = false; r.autoClear = true; r.setRenderTarget(null); r.setScissorTest(false); rt.dispose();
        return { before, after, equal: JSON.stringify(before) === JSON.stringify(after) };
    });
    report.rendererState = restored; check('Target, viewport, scissor, autoClear and XR flag restored', restored.equal, true);
    await page.evaluate(() => {
        const { s, T } = test;
        const sphere = new T.Mesh(new T.SphereGeometry(1,32,16), new T.MeshBasicMaterial({ color: 0, toneMapped: false }));
        const direction = s.camera.getWorldDirection(new T.Vector3());
        sphere.position.copy(s.camera.position).addScaledVector(direction, 8);
        test.foreground = new T.Scene(); test.foreground.add(sphere); s.registerNearTierOnly(sphere);
    });
    const occult = await frame(page, '10-opaque-foreground', { tier: true, occlude: true });
    check('Opaque foreground covers the galaxy, not the other way around', Math.max(...occult.center) < 3 && occult.mean > 1);
    await page.evaluate(async () => {
        await test.s.ensurePostProcessing(); test.s.composer.setSize(800,500);
        test.s.composer.passes[0].scene = test.empty; test.s.composer.passes[0].camera = test.s.camera;
        test.s.bloomPass.enabled = false;
    });
    const composer = await frame(page, '11-composer', { composer: true, compare: 'direct' });
    check('Composer retains galaxy coverage', composer.mean > 1);
    report.composerDirectMAE = composer.mae;
    await page.evaluate(() => { test.s.bloomPass.enabled = true; });
    const bloom = await frame(page, '12-composer-bloom', { composer: true });
    check('Bloom path retains galaxy coverage', bloom.mean > 1);
    for (const [name, position] of [['inner-disk',[6000,100,40]], ['above-disk',[8178,0,2200]], ['external',[0,0,45000]], ['return-solar',[8178,0,20.8]]]) {
        await page.evaluate(p => pose(p), position); await settle(page);
        const f = await frame(page, `route-${name}`); check(`${name}: visible deterministic model`, f.mean > .1);
    }
    await page.evaluate(() => { pose(); test.s.renderer.setPixelRatio(1.5); });
    const dpr = await frame(page, '13-dpr-change');
    check('DPR change has immediate coverage', dpr.mean > 1, true);
    await page.close();
    if (!baseline) {
        const failed = await openPage('throw');
        const fallback = await frame(failed, '14-worker-failure');
        check('Worker failure keeps same-model coarse coverage', fallback.mean > 1 && !!fallback.stats.mapError && !fallback.stats.mapsReady);
        await failed.close();
    }
    const relevantErrors = report.errors.filter(e => !e.includes('favicon') && !e.includes('404 (Not Found)'));
    check('No JavaScript or WebGL shader errors', relevantErrors.length === 0);
    assert(report.checks.every(c => c.pass || c.expectedOldFailure), 'Rendering regression failed; inspect report.json and PNG evidence');
} finally {
    const times = report.timings.rotationRenderAndFinishMs;
    if (times?.length) {
        const sorted = [...times].sort((a,b) => a-b);
        report.timings.summary = { n: sorted.length, p50: sorted[Math.floor(sorted.length*.5)], p95: sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))], max: sorted.at(-1),
            meaning: 'Synchronous JS draw + gl.finish wall time, excluding PNG/readPixels and event delivery. Software rendering is not hardware frame time.' };
    }
    await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.close();
}
