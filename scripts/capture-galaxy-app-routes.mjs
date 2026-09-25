// Full application captures complement the isolated-volume assertions.
// Only the test server exposes the existing frame() callback; production is unchanged.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] || '.'), out = resolve(process.argv[3] || 'evidence/galaxy/app');
await mkdir(out, { recursive: true });
const report = { epoch: '2026-09-13T12:00:00Z', simulatedSeconds: 0, exposure: .15, frames: [], errors: [] };
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{ name: 'test-only-frame-capture', enforce: 'pre', transform(source, id) {
        if (!id.replaceAll('\\','/').endsWith('/src/main.js')) return;
        const marker = 'const firstFrameT0 = perfStart();';
        if (source.split(marker).length !== 2) throw new Error('Initial-frame hook changed: update the capture harness');
        // Freeze simulation BEFORE its first frame, not at a machine-dependent
        // elapsed time after startup. Both versions have identical ephemerides.
        return source.replace(marker, 'G.t = 0; G.paused = true; resetEphem();\n' + marker) +
            '\nwindow.__captureAppFrame = frame; window.__captureRiverBlend = v => { grB = v; };\n';
    } }] });
await server.listen();
const browser = await chromium.launch({ args: ['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => report.errors.push(e.message));
    await page.addInitScript(() => { Date.now = () => Date.UTC(2026,8,13,12); localStorage.setItem('ap_introSeen','1'); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?hidehelp=1&dpr=1&tier1=0&galadapt=0&focus=earth&dist=25&realsky=0&river=0&lens=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__AP_READY && window.__captureAppFrame);
    await page.evaluate(async () => {
        const s = await import('/src/scene.js'), b = await import('/src/bodies.js');
        const e = await import('/src/render/stellarAppearance.js'), c = await import('/src/universe/coords.js');
        const v = await import('/src/render/galaxyVolume.js');
        const { setPaused } = await import('/src/timeCtl.js'); setPaused(true, 'capture');
        s.renderer.setAnimationLoop(null); window.__G.predict = false; window.__G.gr = false; window.__G.uiMode = 'observe';
        Object.defineProperty(e.stellarExposure, 'value', { configurable: true, get: () => .15, set() {} });
        const p = []; c.galToSceneUnitsInto(0,0,0,p);
        const len = Math.hypot(...p), yaw = Math.atan2(-p[2],-p[0]), pitch = Math.asin(-p[1]/len);
        window.appTest = { s, b, e, c, v, yaw, pitch };
        if (__G.t !== 0) throw new Error('Simulation advanced before capture');
    });
    await page.waitForFunction(() => appTest.v.galaxyVolumeStats().mapsReady);
    const states = [
        { name: 'earth-near', focus: 'earth', dist: 25 },
        { name: 'earth-orbit', focus: 'earth', dist: 25, yaw: .22, pitch: .12 },
        { name: 'moon-near', focus: 'moon', dist: 6 },
        { name: 'moon-recede', focus: 'moon', dist: 60 },
        { name: 'solar-system', focus: 'sun', dist: 1e5 },
        { name: 'outer-solar-system', focus: 'sun', dist: 1e7 },
        { name: 'fov-zoom', focus: 'sun', dist: 1e7, fov: 18 },
        { name: 'earth-return', focus: 'earth', dist: 25 },
        { name: 'earth-river-overlay', focus: 'earth', dist: 25, river: true },
    ];
    for (const state of states) {
        await page.evaluate(state => {
            const { s, b, yaw, pitch } = appTest;
            __G.focus = state.focus; __G.gr = !!state.river; __captureRiverBlend(state.river ? 1 : 0);
            s.cam.dist = state.dist; s.cam.distTarget = null;
            s.cam.tgt.copy(state.focus === 'earth' ? b.earthG.position : state.focus === 'moon' ? b.moon.position : b.sunCore.position);
            s.cam.yaw = yaw + (state.yaw || 0); s.cam.pitch = pitch + (state.pitch || 0);
            s.camera.fov = state.fov || 48; s.camera.updateProjectionMatrix();
        }, state);
        const costs = [];
        for (let i = 0; i < 8; i++) {
            costs.push(await page.evaluate(() => {
                const t = performance.now(); __captureAppFrame(); appTest.s.renderer.getContext().finish(); return performance.now()-t;
            }));
            await page.waitForTimeout(60);
        }
        const start = performance.now();
        const captured = await page.evaluate(() => {
            __captureAppFrame(); const { s, v } = appTest, gl = s.renderer.getContext(); gl.finish();
            if (__G.t !== 0) throw new Error('Capture epoch changed');
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            return { png: s.renderer.domElement.toDataURL('image/png'), camera: { position: s.camera.position.toArray(), quaternion: s.camera.quaternion.toArray(), fov: s.camera.fov, aspect: s.camera.aspect },
                time: __G.t, focus: __G.focus, river: __G.gr, dpr: s.renderer.getPixelRatio(), size: [gl.drawingBufferWidth,gl.drawingBufferHeight],
                volume: v.galaxyVolumeStats(), gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
        });
        captured.captureRoundTripMs = performance.now() - start;
        await writeFile(`${out}/${state.name}.png`, Buffer.from(captured.png.split(',')[1], 'base64')); delete captured.png;
        report.frames.push({ name: state.name, state, ...captured, fullFrameAndFinishMs: costs });
        await writeFile(`${out}/app-report.json`, JSON.stringify(report,null,2));
        console.log('APP CAPTURE', state.name, JSON.stringify({ time: captured.time, camera: captured.camera, volume: captured.volume }));
    }
    if (report.errors.length) throw new Error(report.errors.join('\n'));
} finally {
    await writeFile(`${out}/app-report.json`, JSON.stringify(report,null,2));
    await browser.close(); await server.close();
}
