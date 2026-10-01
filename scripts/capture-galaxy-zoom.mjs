// The Milky Way's diffuse light AND its procedural resolved stars together,
// at several zooms onto one region of the disk and at several epochs: the
// stars a camera resolves must sit in the arms, complexes and dust the
// volume shows at that epoch, at every distance. Real WebGL, the volume
// (render/galaxyVolume.js) and the procedural field
// (render/resolvedFieldStars.js and its worker), no catalog/UI.
//   node scripts/capture-galaxy-zoom.mjs <repo root> <out dir>
// ZOOM_SIZE=WxH, ZOOM_LIST=-50,0,50 (Myr), ZOOM_VIEWS=z600,inside narrow the
// matrix; ZOOM_EXPOSURE sets the fixed display exposure (default 0.09: the
// disk seen from within a few kpc is far brighter than the whole Galaxy).
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(process.argv[2] || '.'), out = resolve(process.argv[3] || 'evidence/zoom');
const [W, H] = (process.env.ZOOM_SIZE || '480x320').split('x').map(Number);
await mkdir(out, { recursive: true });
const MYR_S = 1e6 * 31557600;
const OMEGA_P = 28.2 * MYR_S / 3.0856775814913673e16;
const EPOCHS = process.env.ZOOM_LIST ? process.env.ZOOM_LIST.split(',').map(Number) : [-120, 0, 50, 150];
const EXPOSURE = Number(process.env.ZOOM_EXPOSURE || 0.09);
// A region of the inner disk (galactocentric pc, co-rotating with the
// pattern) seen from straight above at three heights and once from inside
// the disk; the target turns with the pattern so every epoch frames the same
// part of the rotating Galaxy.
const TARGET = [6200, 3900, 0];
const ALL_ZOOMS = [
    { name: 'z6000', off: [0, -1200, 6000], fov: 50 },
    { name: 'z1800', off: [0, -400, 1800], fov: 50 },
    { name: 'z600', off: [0, -150, 600], fov: 50 },
    { name: 'inside', off: [-1600, -900, 40], fov: 60 },
];
const ZOOMS = process.env.ZOOM_VIEWS ? ALL_ZOOMS.filter(z => process.env.ZOOM_VIEWS.split(',').includes(z.name)) : ALL_ZOOMS;
const sha = (() => { try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
const report = { sourceSha: sha, size: [W, H], exposure: EXPOSURE, target: TARGET, frames: [], errors: [] };

const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'zoom-probe', enforce: 'pre', configureServer(s) {
        s.middlewares.use((req, res, next) => {
            if (!req.url.startsWith('/__zoom_probe__')) return next();
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><body style="margin:0;background:black"><div id="gl"></div></body>');
        });
    },
}] });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(300000);
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon') && !m.text().startsWith('Failed to load resource')) report.errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__zoom_probe__?dpr=1&galadapt=0&galexposure=${EXPOSURE}`);
    await page.evaluate(async ([W, H, EXPOSURE]) => {
        const s = await import('/src/scene.js'), v = await import('/src/render/galaxyVolume.js');
        const c = await import('/src/universe/coords.js'), e = await import('/src/render/stellarAppearance.js');
        const f = await import('/src/render/resolvedFieldStars.js'), sp = await import('/src/render/starPointMaterial.js');
        const clock = await import('/src/universe/galacticClock.js'), { getSeed } = await import('/src/universe/galaxy.js');
        const T = await import('/node_modules/three/build/three.module.js');
        const { K } = await import('/src/constants.js');
        s.renderQuality.mobile = false; s.renderer.setSize(W, H, false); s.camera.aspect = W / H;
        s.camera.near = 1e-3; s.camera.far = 1e30;
        e.stellarExposure.value = EXPOSURE; e.extragalacticExposure.blend = 0; e.extragalacticExposure.stretch = 0;
        const field = new T.Scene();
        f.initResolvedField(field, { seed: getSeed(), mobile: false });
        const scene = p => { const a = []; c.galToSceneUnitsInto(p[0], p[1], p[2], a, 0, K); return a; };
        window.probe = { s, v, f, t: 0, field };
        window.pose = (pos, target, fov, t) => {
            probe.t = t;
            clock.syncGalacticFrame(t);
            const p = scene(pos), q = scene(target), u0 = scene([0, 0, 0]), u1 = scene([0, 0, 1]);
            s.camera.position.set(...p);
            s.camera.up.set(u1[0] - u0[0], u1[1] - u0[1], u1[2] - u0[2]).normalize();
            s.camera.lookAt(...q); s.camera.fov = fov; s.camera.updateProjectionMatrix(); s.camera.updateMatrixWorld();
        };
        const updateField = () => {
            const cam = s.camera;
            f.updateResolvedField({ camWorldKm: [cam.position.x / K, -cam.position.z / K, cam.position.y / K], tSec: probe.t, catalogMagLimit: 8 });
        };
        // let the field's worker build every bin without rendering frames
        window.pump = async () => {
            for (let i = 0; i < 4000; i++) {
                updateField();
                const st = f.resolvedFieldStatus();
                if (st.idle && !st.staging) return st;
                await new Promise(r => setTimeout(r, 10));
            }
            return f.resolvedFieldStatus();
        };
        window.draw = (capture = false) => {
            const r = s.renderer, gl = r.getContext(), cam = s.camera;
            updateField();
            const lim = f.resolvedFieldMagLimit();
            sp.starViewUniforms.uResolveLimit.value = lim; v.setGalaxyVolumeMagLimit(lim);
            sp.starViewUniforms.uPxScale.value = H / (2 * Math.tan(cam.fov * Math.PI / 360));
            v.updateGalaxyVolume(cam, probe.t);
            r.setRenderTarget(null); r.autoClear = true; r.clear(); v.renderGalaxyVolume(r);
            r.autoClear = false; r.render(probe.field, cam); r.autoClear = true;
            const st = { volume: v.galaxyVolumeStats(), field: f.resolvedFieldStatus() };
            if (capture) {
                const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, b = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
                let sum = 0; for (let i = 0; i < b.length; i += 4) sum += b[i] + b[i + 1] + b[i + 2];
                st.mean = sum / (w * h * 3);
                st.png = r.domElement.toDataURL('image/png');
            }
            return st;
        };
    }, [W, H, EXPOSURE]);
    report.gpu = await page.evaluate(() => {
        const gl = probe.s.renderer.getContext(), x = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), browser: navigator.userAgent };
    });
    const turn = (p, a) => [Math.cos(a) * p[0] - Math.sin(a) * p[1], Math.sin(a) * p[0] + Math.cos(a) * p[1], p[2]];
    for (const tMyr of EPOCHS) {
        const a = OMEGA_P * tMyr, tgt = turn(TARGET, a);
        for (const z of ZOOMS) {
            const pos = turn(TARGET.map((v, i) => v + z.off[i]), a);
            await page.evaluate(([p, q, fov, t]) => pose(p, q, fov, t), [pos, tgt, z.fov, tMyr * MYR_S]);
            const t0 = Date.now();
            let st = await page.evaluate(() => pump());
            if (process.env.ZOOM_DEBUG) console.log('pumped', JSON.stringify(st));
            // a field that never settles (its budget controller hunting
            // between limits) is captured after 4 min and flagged
            let settled = false;
            for (let i = 0; i < 3000 && Date.now() - t0 < 240000; i++) {
                st = await page.evaluate(() => draw());
                if (process.env.ZOOM_DEBUG && i % 20 === 0) console.log(i, JSON.stringify({ draft: st.volume.draft, blend: st.volume.mapBlend, ...st.field }));
                if (st.volume.mapsReady && !st.volume.draft && st.volume.mapBlend === 1 && st.field.idle && !st.field.staging) { settled = true; break; }
                await page.waitForTimeout(30);
            }
            const f = await page.evaluate(() => draw(true));
            const name = `${z.name}_${tMyr < 0 ? 'm' : 'p'}${String(Math.abs(tMyr)).padStart(4, '0')}`;
            await writeFile(`${out}/${name}.png`, Buffer.from(f.png.split(',')[1], 'base64'));
            delete f.png;
            report.frames.push({ name, tMyr, zoom: z.name, settled, settleMs: Date.now() - t0, mean: f.mean,
                stars: f.field.stars, mLim: f.field.mLim, epochs: f.field.epochs, fieldBuilds: f.field.builds, fieldMs: f.field.ms });
            await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
            console.log('FRAME', name, f.mean.toFixed(2), 'stars', f.field.stars, 'mLim', f.field.mLim);
        }
    }
    report.completed = true;
} finally {
    await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
    await browser.close();
    await server.close();
}
if (report.errors.length) { console.error(report.errors); process.exit(1); }
