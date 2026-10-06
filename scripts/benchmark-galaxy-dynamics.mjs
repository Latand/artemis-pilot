// Cost of the time-dependent Milky Way volume: full-resolution renders of
// the same views at epochs that exercise each path of the shader (one
// generation and one material epoch at a generation's peak; just after the
// present; two generations; two generations and an epoch hand-over),
// interleaved, with gl.finish() and a readback. Run it on
// two revisions for a paired comparison:
//   node scripts/benchmark-galaxy-dynamics.mjs <repo root> <out.json>
// Software rendering (SwiftShader) measures relative shader work, not a
// hardware frame rate.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(process.argv[2] || '.'), outFile = resolve(process.argv[3] || 'galaxy-dynamics-cost.json');
const W = 320, H = 200, REPEATS = Number(process.env.BENCH_REPEATS || 5);
const MYR_S = 1e6 * 31557600;
// t = 0: generation 0 alone, epoch 0 alone; 20 Myr: two generations, one
// epoch; 15 Myr: two generations and an epoch hand-over (midpoint).
// generation-peak: exact peaks k x 250 Myr (one generation, one epoch).
// epoch-handover-edge: 14 Myr, the incoming epoch at weight ~0.3.
const EPOCHS = [{ name: 'generation-peak', tMyr: 0, peak: true }, { name: 'present', tMyr: 0 }, { name: 'two-generations', tMyr: 20 },
    { name: 'epoch-handover', tMyr: 15 }, { name: 'epoch-handover-edge', tMyr: 14 }];
const VIEWS = [
    { name: 'face', pos: [0, 0, 62000], target: [0, 0, 0], fov: 30, up: [1, 0, 0] },
    { name: 'region', pos: [5200, 3000, 9500], target: [5200, 3000, 0], fov: 40, up: [1, 0, 0] },
    { name: 'sun-gc', pos: [8178, 0, 20.8], target: [0, 0, 200], fov: 48, up: [0, 0, 1] },
];
const report = { source: (() => { try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
    size: [W, H], repeats: REPEATS, samples: [], errors: [] };
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false }, plugins: [{
    name: 'cost-probe', enforce: 'pre', configureServer(s) {
        s.middlewares.use((req, res, next) => {
            if (!req.url.startsWith('/__dyn_cost__')) return next();
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><body style="margin:0"><div id="gl"></div></body>');
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
    // galres=1: every changed frame is one full-resolution integration
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__dyn_cost__?quality=high&dpr=1&galadapt=0&galexposure=.15&galres=1`);
    await page.evaluate(async ([W, H, MOBILE]) => {
        const s = await import('/src/scene.js'), v = await import('/src/render/galaxyVolume.js');
        const c = await import('/src/universe/coords.js'), e = await import('/src/render/stellarAppearance.js');
        const { K } = await import('/src/constants.js');
        // BENCH_MOBILE=1: the mobile settings of the shader (same resolution, galres=1)
        s.renderQuality.mobile = MOBILE; s.renderer.setSize(W, H, false); s.camera.aspect = W / H;
        e.stellarExposure.value = .15; e.extragalacticExposure.blend = 0; e.extragalacticExposure.stretch = 0;
        const scene = p => { const a = []; c.galToSceneUnitsInto(p[0], p[1], p[2], a, 0, K); return a; };
        const gl = s.renderer.getContext(), px = new Uint8Array(4);
        window.probe = { v };
        window.cost = (view, t) => {
            const p = scene(view.pos), q = scene(view.target), u0 = scene([0, 0, 0]), u1 = scene(view.up);
            s.camera.position.set(...p); s.camera.up.set(u1[0] - u0[0], u1[1] - u0[1], u1[2] - u0[2]).normalize();
            s.camera.lookAt(...q); s.camera.fov = view.fov; s.camera.updateProjectionMatrix(); s.camera.updateMatrixWorld();
            v.updateGalaxyVolume(s.camera, t);
            s.renderer.setRenderTarget(null); s.renderer.autoClear = true; s.renderer.clear();
            const start = performance.now();
            v.renderGalaxyVolume(s.renderer); gl.finish(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
            return performance.now() - start;
        };
    }, [W, H, process.env.BENCH_MOBILE === '1']);
    await page.evaluate(() => cost({ pos: [0, 0, 62000], target: [0, 0, 0], fov: 30, up: [1, 0, 0] }, 0));
    await page.waitForFunction(() => probe.v.galaxyVolumeStats().mapsReady);
    await page.waitForTimeout(1000);
    // warm-up, then interleave epochs within each repeat
    for (const v of VIEWS) for (const ep of EPOCHS) await page.evaluate(([v, t]) => cost(v, t), [v, ep.tMyr * MYR_S + 1]);
    for (let r = 0; r < REPEATS; r++) for (const v of VIEWS) for (const ep of (r % 2 ? [...EPOCHS].reverse() : EPOCHS)) {
        // a distinct time each sample (1 s apart), so nothing is reused
        const t = ep.peak ? (r + 1) * 250 * MYR_S : ep.tMyr * MYR_S + 2 + r;
        const ms = await page.evaluate(([v, t]) => cost(v, t), [v, t]);
        report.samples.push({ view: v.name, epoch: ep.name, tMyr: ep.tMyr, repeat: r, ms });
    }
    const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
    report.medianMs = {};
    for (const v of VIEWS) for (const ep of EPOCHS) report.medianMs[`${v.name}/${ep.name}`] = med(report.samples.filter(s => s.view === v.name && s.epoch === ep.name).map(s => s.ms));
    report.completed = true;
    console.log(JSON.stringify(report.medianMs, null, 1));
} finally {
    await writeFile(outFile, JSON.stringify(report, null, 2));
    await browser.close();
    await server.close();
}
