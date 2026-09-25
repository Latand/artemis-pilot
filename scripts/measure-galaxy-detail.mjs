// Real production volume and WebGLRenderer, isolated from UI/point stars.
// The HTTP route and finer reference integrator exist only in this test server.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] || '.'), out = resolve(process.argv[3] || 'evidence/detail');
const variant = process.env.VARIANT || 'after', reference = variant === 'reference';
await mkdir(out, { recursive: true });
const report = { variant, epochSeconds: 0, exposure: 0.15, viewport: [480, 300], dpr: 1, frames: [], checks: [], errors: [] };
const check = (name, pass) => { report.checks.push({ name, pass: !!pass }); console.log(pass ? 'PASS' : 'FAIL', name); };
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{ name: 'test-only-volume-detail', enforce: 'pre', configureServer(s) {
        s.middlewares.use((req, res, next) => {
            if (!req.url.startsWith('/__detail_probe__')) return next();
            res.setHeader('Content-Type', 'text/html');
            res.end('<!DOCTYPE html><html><body style="margin:0;background:black"><div id="gl"></div></body></html>');
        });
    }, transform(code, id) {
        if (!reference) return;
        if (id.endsWith('/src/universe/galaxyModel.js')) return code.replace('uDustQuadrature: 1', 'uDustQuadrature: 0');
        if (!id.endsWith('/src/render/galaxyVolume.js')) return;
        const count = 'const MAX_STEPS = 360;', step = 'draft ? 0.055 : 0.03';
        if (!code.includes(count) || !code.includes(step)) throw new Error('Reference integration seam changed');
        // Same field/exposure/pixel footprint; independent finer midpoint integration.
        // The reference disables the new segment quadrature instead of using it as truth.
        return code.replace(count, 'const MAX_STEPS = 1600;').replace(step, '0.006');
    } }] });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
    const page = await browser.newPage({ viewport: { width: 480, height: 300 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) report.errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__detail_probe__?dpr=1&galadapt=0&galexposure=0.15${reference ? '&galres=1' : ''}`);
    await page.evaluate(async () => {
        const s = await import('/src/scene.js'), v = await import('/src/render/galaxyVolume.js');
        const c = await import('/src/universe/coords.js'), e = await import('/src/render/stellarAppearance.js');
        const { K } = await import('/src/constants.js');
        window.probe = { s, v, c, e, K, previous: null, saved: null };
        s.renderQuality.mobile = false; s.renderer.setSize(480, 300, false); s.camera.aspect = 1.6;
        e.stellarExposure.value = 0.15; e.extragalacticExposure.blend = 0; e.extragalacticExposure.stretch = 0;
        const north = [], zero = []; c.galToSceneUnitsInto(0, 0, 1, north, 0, K); c.galToSceneUnitsInto(0, 0, 0, zero, 0, K);
        s.camera.up.set(north[0] - zero[0], north[1] - zero[1], north[2] - zero[2]).normalize();
        window.pose = (p = [8178, 0, 20.8], target = [0, 0, 200], fov = 18) => {
            const a = []; c.galToSceneUnitsInto(...p, a, 0, K); s.camera.position.set(...a);
            c.galToSceneUnitsInto(...target, a, 0, K); s.camera.lookAt(...a);
            s.camera.fov = fov; s.camera.updateProjectionMatrix(); s.camera.updateMatrixWorld(); v.updateGalaxyVolume(s.camera, 0);
        };
        window.draw = (capture = false, save = false) => {
            const r = s.renderer, gl = r.getContext(); v.updateGalaxyVolume(s.camera, 0);
            r.autoClear = true; r.clear();
            const start = performance.now(); v.renderGalaxyVolume(r); gl.finish();
            const renderAndFinishMs = performance.now() - start;
            const result = { renderAndFinishMs, stats: v.galaxyVolumeStats() };
            if (!capture) return result;
            const data = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
            gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, data);
            let sum = 0, lit = 0, delta = 0;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i] + data[i + 1] + data[i + 2] > 3) lit++;
                for (let j = 0; j < 3; j++) { sum += data[i + j]; if (probe.saved) delta += Math.abs(data[i + j] - probe.saved[i + j]); }
            }
            result.renderAndReadbackMs = performance.now() - start;
            result.mean = sum / (data.length * 0.75); result.coverage = lit / (data.length / 4);
            result.returnMAE = probe.saved ? delta / (data.length * 0.75) : null;
            if (save) probe.saved = data;
            result.pose = { observer: s.camera.position.toArray(), quaternion: s.camera.quaternion.toArray(), projection: s.camera.projectionMatrix.toArray() };
            // Read the canvas in the same task as the draw (preserveDrawingBuffer=false).
            result.png = r.domElement.toDataURL('image/png'); return result;
        };
        pose(); draw();
    });
    await page.waitForFunction(() => probe.v.galaxyVolumeStats().mapsReady);
    await page.waitForTimeout(800);
    report.gpu = await page.evaluate(() => {
        const g = probe.s.renderer.getContext(), x = g.getExtension('WEBGL_debug_renderer_info');
        return { renderer: x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
            browser: navigator.userAgent, hardwareTimerAvailable: !!g.getExtension('EXT_disjoint_timer_query_webgl2') };
    });
    // Execute the production GLSL quadrature with analytic density fixtures.
    // This tests the shader, not a separately transcribed JS implementation.
    report.quadrature = await page.evaluate(async () => {
        const THREE = await import('/node_modules/three/build/three.module.js');
        const { GALAXY_MODEL_GLSL } = await import('/src/universe/galaxyModel.js');
        const body = GALAXY_MODEL_GLSL.match(/float gdDustSegment\([^]*?\n}/)?.[0];
        if (!body) return { supported: false, cases: [] };
        const smooth = GALAXY_MODEL_GLSL.match(/float gmSmooth[^]*?\n/)?.[0];
        if (!smooth) throw new Error('Missing production smoothstep');
        const r = probe.s.renderer, previous = r.getRenderTarget(), auto = r.autoClear;
        const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
        const u = { uCenter: { value: new THREE.Vector3() }, uDirection: { value: new THREE.Vector3(1, 0, 0) },
            uTransverse: { value: 1 }, uLongitudinal: { value: 10 }, uWideK: { value: .2 },
            uDustQuadrature: { value: 1 }, uTest: { value: 0 } };
        const mat = new THREE.ShaderMaterial({ uniforms: u, depthTest: false, depthWrite: false, toneMapped: false,
            vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: `uniform vec3 uCenter, uDirection;
                uniform float uTransverse, uLongitudinal, uWideK, uDustQuadrature, uTest;
                ${smooth}
                float gdDust(vec3 p, float wide, float amp) {
                    if (uTest < .5) return 7.0;
                    if (uTest < 1.5) return 2.0 + .02 * p.x;
                    if (uTest < 2.5) return 1.0 + .0001 * p.x * p.x;
                    return 1.0 + .5 * cos(.15 * p.x) * (1.0 - gmSmooth(2.0, 4.0, wide));
                }
                ${body}
                void main() { float v = gdDustSegment(uCenter, uDirection, uTransverse, uLongitudinal, 1.0);
                    gl_FragColor = vec4(v, v, v, 1.0); }` });
        const geo = new THREE.PlaneGeometry(2, 2), scene = new THREE.Scene(), mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false; scene.add(mesh);
        const camera = new THREE.OrthographicCamera(), bytes = new Float32Array(4), cases = [];
        function sample(mode, x, wL, wT = 0.1, direction = 1, enabled = 1) {
            u.uTest.value = mode; u.uCenter.value.set(x, 0, 0); u.uDirection.value.set(direction, 0, 0);
            u.uLongitudinal.value = wL; u.uTransverse.value = wT; u.uDustQuadrature.value = enabled;
            r.setRenderTarget(rt); r.autoClear = true; r.render(scene, camera);
            r.readRenderTargetPixels(rt, 0, 0, 1, 1, bytes); return bytes[0];
        }
        const test = (name, actual, expected, tolerance = .0002) =>
            cases.push({ name, actual, expected, pass: Number.isFinite(actual) && Math.abs(actual - expected) < tolerance });
        try {
            test('Constant density retains its mean', sample(0, 25, 70), 7);
            test('Linear density is integrated exactly', sample(1, 30, 70), 2.6);
            test('Three equal midpoint weights for quadratic density', sample(2, 20, 70), 1 + .0001 * (400 + 8 * 4900 / 27));
            test('Direction reversal retains the same segment', sample(3, 14, 20, .1, -1), sample(3, 14, 20));
            test('Diagnostic disable retains midpoint evaluation', sample(2, 20, 70, .1, 1, 0), 1.04);
            test('Pixel-limited frequencies still disappear', sample(3, 0, 20, 5), 1);
            let mean = 0;
            for (let i = 0; i < 32; i++) mean += sample(3, i * 2 * Math.PI / (.15 * 32), 10) / 32;
            test('Filtered periodic density retains spatial mean', mean, 1);
            test('LOD blend is continuous at onset', sample(3, 1, 2 + 1e-4), sample(3, 1, 2 - 1e-4));
            test('LOD blend is continuous at full weight', sample(3, 1, 4 + 1e-4), sample(3, 1, 4 - 1e-4));
            return { supported: true, cases };
        } finally {
            r.setRenderTarget(previous); r.autoClear = auto; rt.dispose(); mat.dispose(); geo.dispose();
        }
    });
    if (variant !== 'before') check('Production quadrature analytic shader fixtures', report.quadrature.supported && report.quadrature.cases.every(c => c.pass));
    async function settle() {
        const costs = [], start = performance.now();
        for (let i = 0; i < 60; i++) {
            const f = await page.evaluate(() => draw()); costs.push(f.renderAndFinishMs);
            if (!f.stats.draft && f.stats.mapBlend >= 1) return { costs, latencyMs: performance.now() - start };
            await page.waitForTimeout(60);
        }
        throw new Error('Refinement did not settle');
    }
    async function capture(name, state, extra = {}, save = false) {
        const f = await page.evaluate(save => draw(true, save), save);
        await writeFile(`${out}/${name}.png`, Buffer.from(f.png.split(',')[1], 'base64')); delete f.png;
        report.frames.push({ name, state, ...f, ...extra });
        check(`${name}: visible finite volume`, Number.isFinite(f.mean) && f.mean > 0.1);
        await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
        console.log('FRAME', name, f.renderAndFinishMs.toFixed(2), 'ms'); return f;
    }
    const views = [
        { name: 'gc-wide', p: [8178, 0, 20.8], target: [0, 0, 200], fov: 48 },
        { name: 'gc-zoom', p: [8178, 0, 20.8], target: [0, 0, 200], fov: 18 },
        { name: 'cygnus', p: [8178, 0, 20.8], target: [8178, 3000, 100], fov: 30 },
        { name: 'external', p: [0, -1000, 45000], target: [0, 0, 0], fov: 48 },
    ];
    for (const state of views) {
        await page.evaluate(s => pose(s.p, s.target, s.fov), state);
        const refinement = await settle(); await capture(state.name, state, { refinement });
    }
    const home = views[1]; await page.evaluate(s => pose(s.p, s.target, s.fov), home); await settle();
    await capture('motion-start', home, {}, true);
    for (let i = 1; i <= 8; i++) {
        const state = { p: [8178 + i * 0.5, i * 0.8, 20.8], target: [0, 0, 200], fov: 18 };
        await page.evaluate(s => pose(s.p, s.target, s.fov), state);
        const f = await capture(`motion-${String(i).padStart(2, '0')}`, state);
        check(`Translation ${i} rejects angular history`, f.stats.historyUsed === false);
    }
    await page.evaluate(s => pose(s.p, s.target, s.fov), home); await settle();
    const returned = await capture('motion-return', home);
    check('Exact return pose is reproducible', returned.returnMAE < 0.05);
    check('No JavaScript or shader errors', report.errors.length === 0);
    assert(report.checks.every(c => c.pass), 'Detail regression failed');
} finally {
    const ms = report.frames.filter(f => /^motion-\d/.test(f.name)).map(f => f.renderAndFinishMs).sort((a,b) => a-b);
    report.motionTiming = ms.length ? { n: ms.length, p50: ms[Math.floor(ms.length * .5)], p95: ms[Math.min(ms.length - 1, Math.floor(ms.length * .95))], max: ms.at(-1), longFramesOver50ms: ms.filter(v => v > 50).length } : null;
    const complete = report.frames.filter(f => /^motion-\d/.test(f.name)).map(f => f.renderAndReadbackMs).sort((a,b) => a-b);
    report.motionReadbackTiming = complete.length ? { n: complete.length, p50: complete[Math.floor(complete.length * .5)], p95: complete.at(-1), max: complete.at(-1), longFramesOver50ms: complete.filter(v => v > 50).length } : null;
    report.timingMethod = 'renderAndFinishMs is JS draw + gl.finish wall time, NOT reliable GPU completion timing in this browser. renderAndReadbackMs includes a blocking readPixels and pixel-statistics loop; it excludes PNG encoding. Neither is hardware GPU time or interactive FPS. Refinement latency includes 60ms polling delays.';
    await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
    await browser.close(); await server.close();
}
