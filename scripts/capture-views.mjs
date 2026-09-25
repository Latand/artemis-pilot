// Named-view capture: photographs a list of camera views (focus, distance,
// orientation, simulation time) in one browser session, with per-frame
// luminance statistics. For judging a rendering change on exact, repeatable
// views (before/after pairs).
//
//   node scripts/capture-views.mjs <outDir> <views.json> [--width=1280]
//        [--height=800] [--q=extra&query] [--settle=900]
//
// views.json: [{ "name": "mw-478kly", "focus": "sun", "ly": 477700,
//   "yaw": -0.95, "pitch": 0.46, "gyr": 0, "fov": 48 }, ...]
// Optional per view: "tgtGal": [x, y, z] (galactocentric pc: free focus on
// that point), "wait": ms extra.
// Set PLAYWRIGHT_CHROMIUM to a preinstalled browser when the pinned
// Playwright build's own download is unavailable.
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const args = Object.fromEntries(process.argv.slice(4).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
}));
const out = resolve(process.argv[2] || "views");
const views = JSON.parse(await readFile(process.argv[3], "utf8"));
const W = Number(args.width || 1280), H = Number(args.height || 800);
const settleMs = Number(args.settle || 900);
await mkdir(out, { recursive: true });

const server = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM || process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ headless: true, executablePath, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const results = [];
try {
    const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
        Date.now = () => Date.UTC(2026, 8, 13, 12);
        localStorage.setItem("ap_intro_seen", "1");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(240000);
    const errors = [];
    page.on("pageerror", e => errors.push(String(e)));
    page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(base + `?hidehelp=1&dpr=1&perf=1&tier1=0&focus=sun&dist=1e4` + (args.q ? "&" + args.q : ""));
    await page.waitForFunction(() => window.__AP_READY, null, { timeout: 120000 });
    const enter = page.getByRole("button", { name: "ENTER SIMULATION", exact: true });
    if (await enter.isVisible().catch(() => false)) await enter.click();
    await page.evaluate(async () => {
        const { setPaused } = await import("/src/timeCtl.js");
        __G.gr = false; __G.predict = false; __G.darkEnergy = false; __G.darkMatter = false;
        setPaused(true, "capture");
        const c = await import("/src/cosmic.js");
        c.scheduleCosmicLayerBuild();
    });
    await page.waitForFunction(() => !window.__galaxyStatus || window.__galaxyStatus().ready || window.__galaxyStatus().error, null, { timeout: 180000, polling: 500 });
    await page.waitForFunction(() => !window.__volStatus || window.__volStatus().mapsReady, null, { timeout: 180000, polling: 250 });
    const hide = await page.addStyleTag({ content: "body * { visibility: hidden !important } #gl, #gl canvas { visibility: visible !important }" });
    const frames = n => page.evaluate(n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
    for (const v of views) {
        await page.evaluate(async v => {
            const { LY_SCENE, K } = await import("/src/constants.js");
            const { camera } = await import("/src/scene.js");
            __G.t = (v.gyr || 0) * 1e9 * 31557600 + (v.years || 0) * 31557600;
            if (camera.fov !== (v.fov || 48)) { camera.fov = v.fov || 48; camera.updateProjectionMatrix(); window.dispatchEvent(new Event("resize")); }
            if (v.tgtGal) {
                const { galToSceneUnitsInto } = await import("/src/universe/coords.js");
                const p = [0, 0, 0];
                galToSceneUnitsInto(v.tgtGal[0], v.tgtGal[1], v.tgtGal[2], p, 0, K);
                __G.focus = "free";
                __cam.tgt.set(p[0], p[1], p[2]);
            } else __G.focus = v.focus || "sun";
            __cam.dist = v.ly * LY_SCENE; __cam.distTarget = null;
            __cam.yaw = v.yaw ?? -0.95; __cam.pitch = v.pitch ?? 0.46;
            if (v.fromGal) {
                // camera direction from the target: a galactic-frame vector
                // (e.g. [0, 0, 1] looks down from the North Galactic Pole)
                const { galacticToWorld } = await import("/src/universe/coords.js");
                const w = galacticToWorld(v.fromGal);
                const n = [w[0], w[2], -w[1]];
                const l = Math.hypot(n[0], n[1], n[2]);
                __cam.pitch = Math.asin(n[1] / l);
                __cam.yaw = Math.atan2(n[2], n[0]);
            }
        }, v);
        await frames(4);
        if ((v.gyr || 0) > 1) await page.waitForFunction(() => !window.__tidesStatus || window.__tidesStatus().ready || window.__tidesStatus().error, null, { timeout: 180000, polling: 250 });
        await page.waitForTimeout(settleMs + (v.wait || 0));
        await page.waitForFunction(() => !window.__fieldStatus || window.__fieldStatus().idle, null, { timeout: 600000, polling: 500 }).catch(() => {});
        // the volume refines its draft once the view has settled
        await page.waitForFunction(() => !window.__volStatus || (!window.__volStatus().draft && window.__volStatus().fade >= 1), null, { timeout: 240000, polling: 100 }).catch(() => {});
        await frames(3);
        await page.evaluate(() => __PERF.clear());
        await frames(6);
        const buf = await page.screenshot({ type: "png" });
        await writeFile(resolve(out, v.name + ".png"), buf);
        const stats = await page.evaluate(() => ({
            calls: __PERF.renderInfo.calls, points: __PERF.renderInfo.points, triangles: __PERF.renderInfo.triangles,
            frameMs: __PERF.samples["frame.total"]?.avg ?? null, renderMs: __PERF.samples["render.frame"]?.avg ?? null,
            galExposure: window.__galaxyStatus?.().exposure ?? null,
            vol: window.__volStatus?.() ?? null,
        }));
        results.push({ ...v, ...stats });
        console.log(v.name, JSON.stringify(stats));
    }
    await hide.evaluate(el => el.remove());
    await writeFile(resolve(out, "views.json"), JSON.stringify({ W, H, errors, results }, null, 2) + "\n");
    if (errors.length) { console.error("page errors:", errors.slice(0, 10)); process.exitCode = 1; }
} finally {
    await browser.close();
    await server.close();
}
