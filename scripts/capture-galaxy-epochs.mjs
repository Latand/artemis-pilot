// Milky Way structure through time: the same views of the isolated
// volumetric galaxy (render/galaxyVolume.js, real WebGL, no catalog/UI) at a
// list of sim epochs, inertial and co-rotating with the spiral pattern, plus
// a dense face-on time series. Run against two revisions for before/after:
//   node scripts/capture-galaxy-epochs.mjs <repo root> <out dir>
// EPOCH_SERIES=0 skips the dense series; EPOCH_SIZE=WxH sets the frame;
// EPOCH_LIST=-30,0,30 and EPOCH_VIEWS=face,tilt narrow the matrix.
// Output: PNGs, report.json with per-frame statistics and a 96x96 luminance
// thumbnail per frame (for the correlation analysis in
// scripts/analyze-galaxy-epochs.mjs).
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(process.argv[2] || '.'), out = resolve(process.argv[3] || 'evidence/epochs');
const [W, H] = (process.env.EPOCH_SIZE || '360x360').split('x').map(Number);
const series = process.env.EPOCH_SERIES !== '0';
await mkdir(out, { recursive: true });
const MYR_S = 1e6 * 31557600;
const OMEGA_P = 28.2 * MYR_S / 3.0856775814913673e16;    // rad/Myr
const sha = (() => { try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })();
const report = { sourceSha: sha, size: [W, H], exposure: 0.15, frames: [], errors: [] };

// Views: camera position, target, fov (deg), up (galactocentric), whether
// the camera co-rotates with the spiral pattern (Omega_p).
const VIEWS = {
    'face': { pos: [0, 0, 62000], target: [0, 0, 0], fov: 30, up: [1, 0, 0] },
    'face-corot': { pos: [0, 0, 62000], target: [0, 0, 0], fov: 30, up: [1, 0, 0], corot: true },
    'tilt': { pos: [0, -46000, 30000], target: [0, 0, 0], fov: 34, up: [0, 0, 1] },
    'region-corot': { pos: [5200, 3000, 9500], target: [5200, 3000, 0], fov: 40, up: [1, 0, 0], corot: true },
    // from the Sun's position at that epoch (solarOrbit.js), toward the centre
    'sun-gc': { pos: [8178, 0, 20.8], target: [0, 0, 200], fov: 48, up: [0, 0, 1], sun: true },
};
const EPOCHS_MYR = process.env.EPOCH_LIST ? process.env.EPOCH_LIST.split(',').map(Number)
    : [-500, -120, -30, 0, 10, 30, 60, 120, 250, 500, 1000, 3000];
const VIEW_NAMES = process.env.EPOCH_VIEWS ? process.env.EPOCH_VIEWS.split(',') : Object.keys(VIEWS);
const SERIES = { view: 'face-corot', from: 0, to: 600, step: 10 };

const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'epoch-probe', enforce: 'pre', configureServer(s) {
        s.middlewares.use((req, res, next) => {
            if (!req.url.startsWith('/__epoch_probe__')) return next();
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
    page.setDefaultTimeout(180000);
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon') && !m.text().startsWith('Failed to load resource')) report.errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__epoch_probe__?quality=high&dpr=1&galadapt=0&galexposure=.15`);
    await page.evaluate(async ([W, H]) => {
        const s = await import('/src/scene.js'), v = await import('/src/render/galaxyVolume.js');
        const c = await import('/src/universe/coords.js'), e = await import('/src/render/stellarAppearance.js');
        const { K } = await import('/src/constants.js');
        const clock = await import('/src/universe/galacticClock.js');
        const coordsMod = c;
        s.renderQuality.mobile = false; s.renderer.setSize(W, H, false); s.camera.aspect = W / H;
        e.stellarExposure.value = .15; e.extragalacticExposure.blend = 0; e.extragalacticExposure.stretch = 0;
        const scene = p => { const a = []; coordsMod.galToSceneUnitsInto(p[0], p[1], p[2], a, 0, K); return a; };
        window.probe = { s, v, t: 0, sun: null };
        window.pose = (view, t) => {
            probe.t = t;
            // the Sun (and its Local Bubble) where it is at this epoch
            const sun = clock.syncGalacticFrame(t);
            const pos = view.sun ? [sun.x, sun.y, sun.z] : view.pos;
            const p = scene(pos), q = scene(view.target);
            const u0 = scene([0, 0, 0]), u1 = scene(view.up);
            s.camera.position.set(...p);
            s.camera.up.set(u1[0] - u0[0], u1[1] - u0[1], u1[2] - u0[2]).normalize();
            s.camera.lookAt(...q); s.camera.fov = view.fov; s.camera.updateProjectionMatrix(); s.camera.updateMatrixWorld();
        };
        window.draw = (capture = false) => {
            const r = s.renderer, gl = r.getContext();
            v.updateGalaxyVolume(s.camera, probe.t);
            r.setRenderTarget(null); r.autoClear = true; r.clear(); v.renderGalaxyVolume(r);
            const f = { stats: v.galaxyVolumeStats() };
            if (capture) {
                const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, b = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
                let sum = 0; for (let i = 0; i < b.length; i += 4) sum += b[i] + b[i + 1] + b[i + 2];
                f.mean = sum / (w * h * 3);
                const N = 96, th = new Array(N * N).fill(0), cnt = new Array(N * N).fill(0);
                for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                    const k = ((h - 1 - y) * w + x) * 4, j = Math.floor(y * N / h) * N + Math.floor(x * N / w);
                    th[j] += 0.2126 * b[k] + 0.7152 * b[k + 1] + 0.0722 * b[k + 2]; cnt[j]++;
                }
                f.thumb = th.map((v, i) => Math.round(v / Math.max(1, cnt[i]) * 10) / 10);
                f.png = r.domElement.toDataURL('image/png');
            }
            return f;
        };
    }, [W, H]);
    report.gpu = await page.evaluate(() => {
        const gl = probe.s.renderer.getContext(), x = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), browser: navigator.userAgent };
    });
    await page.evaluate(() => { pose({ pos: [0, 0, 62000], target: [0, 0, 0], fov: 30, up: [1, 0, 0] }, 0); draw(); });
    await page.waitForFunction(() => probe.v.galaxyVolumeStats().mapsReady);
    async function settle() {
        for (let i = 0; i < 400; i++) {
            const f = await page.evaluate(() => draw());
            if (!f.stats.draft && f.stats.mapBlend === 1) return;
            await page.waitForTimeout(20);
        }
        throw new Error('No settled image');
    }
    async function shot(name, viewName, tMyr) {
        const base = VIEWS[viewName];
        const view = { ...base };
        if (base.corot) {
            // camera turned with the spiral pattern: a rigidly rotating
            // picture is frozen in this view
            const a = OMEGA_P * tMyr, c = Math.cos(a), s = Math.sin(a);
            const rot = p => [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
            view.pos = rot(base.pos); view.target = rot(base.target); view.up = rot(base.up);
        }
        await page.evaluate(([v, t]) => pose(v, t), [view, tMyr * MYR_S]);
        const t0 = Date.now();
        await settle();
        const f = await page.evaluate(() => draw(true));
        await writeFile(`${out}/${name}.png`, Buffer.from(f.png.split(',')[1], 'base64'));
        delete f.png;
        report.frames.push({ name, view: viewName, tMyr, settleMs: Date.now() - t0, ...f });
        await writeFile(`${out}/report.json`, JSON.stringify(report));
        console.log('FRAME', name, f.mean.toFixed(2));
    }
    for (const viewName of VIEW_NAMES) {
        for (const tMyr of EPOCHS_MYR) {
            await shot(`${viewName}_${tMyr < 0 ? 'm' : 'p'}${String(Math.abs(tMyr)).padStart(4, '0')}`, viewName, tMyr);
        }
    }
    if (series) {
        for (let t = SERIES.from; t <= SERIES.to; t += SERIES.step) {
            await shot(`series_${String(t).padStart(4, '0')}`, SERIES.view, t);
        }
    }
    report.completed = true;
} finally {
    await writeFile(`${out}/report.json`, JSON.stringify(report));
    await browser.close();
    await server.close();
}
if (report.errors.length) { console.error(report.errors); process.exit(1); }
