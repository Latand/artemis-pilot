// Actual app renderer, frozen TDE state and same-frame blend ablation.
// The 10 km hole disrupts an Earth-mass body; its disk spans many thousands
// of ISCO radii while the physical horizon is unresolved. The old normal
// blend turned the cold outskirts into an opaque black ellipse.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { transformCelestialSource } from './celestial-detail-fixtures.mjs';

const out = resolve(process.argv[2] || 'evidence/bh-river');
await mkdir(out, { recursive: true });
const mobile = process.env.DEVICE === 'mobile';
const report = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    mobile, comparison: 'same frozen frame: prior NormalBlending vs production vs disk disabled',
    omissions: ['unrelated galaxy and background catalog layers', 'TDE debris stream; disk state is seeded from the disruption formulas'],
    errors: [], cases: [] };
let server, browser;
try {
    server = await createServer({ configFile: false, logLevel: 'error',
        server: { host: '127.0.0.1', port: 0, hmr: false },
        plugins: [{ name: 'bh-river-regression', enforce: 'pre',
            resolveId(id) { if (id === 'virtual:galaxy-preview') return '\0off'; },
            load(id) { if (id === '\0off') return 'export default null;'; },
            transform: transformCelestialSource,
        }] });
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 700 } : { width: 1000, height: 700 },
        deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => report.errors.push(e.stack || String(e)));
    page.on('console', m => { if (m.type() === 'error' && /THREE|Shader|GL_INVALID/.test(m.text())) report.errors.push(m.text()); });
    await page.addInitScript(() => { Date.now = () => Date.UTC(2026, 8, 13, 12); localStorage.clear(); });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=earth&dist=25&tier1=0&realsky=0&field=0&galaxies=0&galaxyvol=0&galaxy=0&compile=0&bloom=0&np=124&dpr=1`);
    await page.waitForFunction(() => window.__AP_READY && window.__celestialFrame);
    await page.evaluate(async () => {
        window.qa = { s: await import('/src/scene.js'), st: await import('/src/state.js'), bh: await import('/src/blackholes.js'),
            c: await import('/src/constants.js'), enc: await import('/src/bhEncounters.js'), tde: await import('/src/tde.js'),
            lens: await import('/src/lensing.js'), THREE: await import('/node_modules/three/build/three.module.js') };
        const { st, bh, c, enc, tde } = qa;
        document.getElementById('intro').style.display = 'none';
        st.G.paused = true; st.G.gr = true; st.G.predict = false;
        bh.clearBlackHoles(); bh.addBlackHole(200000, 0, 10, 0, 0, true);
        const mu = st.BH.mu[0], rt = tde.tidalRadiusKm(c.R_EARTH, mu, c.MU_E), tfb = tde.fallbackTimeSec(c.R_EARTH, mu, c.MU_E);
        const mStarKg = c.MU_E / 6.674e-20, mBhMsun = mu / c.MU_S;
        enc.TDES.push({ bh: 0, target: 'earth', name: 'Earth', regime: 'full', beta: 1, rp: rt, rt,
            t0: -3 * tfb, tFb: tfb, boundMass: c.MU_E / 2, accreted: 0, massLossFrac: 1,
            vRelX: 0, vRelY: 0, vRelZ: 0, mStarKg, mBhMsun, LEddW: tde.L_EDD_PER_MSUN * mBhMsun,
            LpeakW: tde.tdeLuminosityW(tfb, tfb, mStarKg, mBhMsun), rCirc: 2 * rt, debris: null, active: true, jetted: false });
        st.WORLD.earthDestroyed = true;
        qa.rt = rt; qa.dist = rt * c.K * 7;
        await window.__celestialEnsureLensing();
    });
    for (const test of [{ name: 'wide-tilted', pitch: .25 }, { name: 'wide-face-on', pitch: 1.42 },
        { name: 'wide-edge-on', pitch: .04 }, { name: 'resolved-inner', pitch: .48, dist: .08 }]) {
        const result = await page.evaluate(test => {
            const { s, st, bh, lens, THREE } = qa;
            st.G.focus = 'bh:0'; s.cam.dist = test.dist ?? qa.dist; s.cam.distTarget = null; s.cam.pitch = test.pitch; s.cam.yaw = .7;
            window.__celestialFrame(); s.cam.tgt.copy(bh.BH_META[0].g.position);
            for (let i = 0; i < 16; i++) window.__celestialFrame();
            const disk = bh.BH_META[0].optics.disk, material = disk.material, actualBlend = material.blending;
            const gl = s.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const draw = () => {
                if (lens.lensingPass.enabled) lens.renderLensed(s.renderer, s.scene, s.camera);
                else s.renderSceneTiered(s.renderer, s.scene, s.camera);
                gl.finish(); const bytes = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
                return { bytes, png: s.renderer.domElement.toDataURL('image/png') };
            };
            material.blending = THREE.NormalBlending; const before = draw();
            disk.visible = false; const noDisk = draw();
            disk.visible = true; material.blending = actualBlend; const after = draw();
            let priorDarkened = 0, stillDarkened = 0, restored = 0, innerLight = 0;
            const lum = (a, i) => .2126 * a[i] + .7152 * a[i + 1] + .0722 * a[i + 2];
            for (let i = 0; i < after.bytes.length; i += 4) {
                const off = lum(noDisk.bytes, i), old = lum(before.bytes, i), now = lum(after.bytes, i);
                if (off > 12 && old < off * .5) { priorDarkened++; if (now >= off - 3) restored++; }
                if (off > 12 && now < off * .5) stillDarkened++;
                if (now > off + 8) innerLight++;
            }
            const u = material.uniforms;
            return { images: { before: before.png, after: after.png, 'disk-disabled': noDisk.png },
                state: { cameraDistance: s.cam.dist, pitch: s.cam.pitch, rsKm: st.BH.rs[0], diskOn: u.uDiskOn.value,
                    outerToInnerRadius: u.uRout.value, TmaxK: u.uTmax.value, gain: u.uGain.value,
                    blend: actualBlend, expectedBlend: THREE.AdditiveBlending, near: s.camera.near, far: s.camera.far,
                    physicalObserverRs: u.uDistance.value, lensing: lens.lensingPass.enabled },
                metrics: { priorDarkened, stillDarkened, restored, innerLight }, glError: gl.getError() };
        }, test);
        for (const [kind, data] of Object.entries(result.images)) await writeFile(resolve(out, `${test.name}-${kind}.png`), Buffer.from(data.split(',')[1], 'base64'));
        delete result.images; report.cases.push({ ...test, ...result });
        console.log(test.name, JSON.stringify(result));
        assert.equal(result.state.blend, result.state.expectedBlend, 'disk contributes light without a made-up absorbing sheet');
        assert.equal(result.glError, 0, 'no WebGL errors');
        assert.equal(result.state.diskOn, 1, 'the real TDE update enables the disk');
        assert.equal(result.metrics.stillDarkened, 0, 'disk emission cannot erase visible background');
        if (test.name === 'wide-tilted' || test.name === 'wide-face-on') {
            assert(result.metrics.priorDarkened > 25, 'same-frame old blend reproduces the reported blank region');
            assert.equal(result.metrics.restored, result.metrics.priorDarkened, 'all old opaque-disk pixels retain background');
        }
        if (test.name === 'resolved-inner') assert(result.metrics.innerLight > 100, 'resolved disk emission remains visible');
        if (test.name === 'wide-tilted') await page.screenshot({ path: resolve(out, 'app-ui-after.png') });
    }
    assert.deepEqual(report.errors, []); report.passed = true;
} catch (e) { report.errors.push(e.stack || String(e)); report.passed = false; process.exitCode = 1; console.error(e); }
finally { await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close(); }
