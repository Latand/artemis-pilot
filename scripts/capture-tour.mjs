// Camera-tour capture: renders a smooth fly-through as numbered frames for
// an animated GIF/video. Keyframes give a camera distance, an orbit target
// and a view direction; frames in between interpolate the distance
// logarithmically, the target linearly (in scene space) and the direction
// along the great circle, all with an ease-in-out. Every frame waits for the
// Milky Way volume to finish refining, so each one is a full-quality still.
//
//   node scripts/capture-tour.mjs <outDir> <tour.json> [--width=640]
//        [--height=400] [--q=extra&query] [--from=0] [--to=N] [--settle=1500]
//
// tour.json: { "keys": [
//   { "km": 20000, "target": "earth", "yaw": -0.95, "pitch": 0.22 },
//   { "ly": 50000, "target": [-2500, -4500, 0], "fromGal": [0.25, 0.1, 1],
//     "frames": 40 }, ... ] }
// "km" or "ly" sets the distance; "target" is "earth", "sun" or
// galactocentric pc; the direction is "yaw"/"pitch" (scene frame) or
// "fromGal" (galactic-frame vector from the target to the camera), with
// "sunSide": true measuring the yaw from the direction toward the Sun; "frames"
// is the number of frames from the previous key to this one (default 24).
// Frames are written as 0000.png, 0001.png, ... --from/--to capture a
// sub-range (to split a long tour across processes). For a GIF, capture at
// twice the size and downscale: each frame is then supersampled.
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
const out = resolve(process.argv[2] || "tour");
const tour = JSON.parse(await readFile(process.argv[3], "utf8"));
const W = Number(args.width || 640), H = Number(args.height || 400);
// time for the auto-exposure (0.5-0.6 s time constants) to settle per frame
const settleMs = Number(args.settle || 1500);
await mkdir(out, { recursive: true });

// frame list: one entry per rendered frame, [key index, eased fraction]
const frames = [[0, 0]];
for (let k = 1; k < tour.keys.length; k++) {
    const n = tour.keys[k].frames ?? 24;
    for (let i = 1; i <= n; i++) {
        const s = i / n;
        frames.push([k, tour.keys[k].linear ? s : s * s * (3 - 2 * s)]);
    }
}
const first = Number(args.from || 0), last = Math.min(frames.length - 1, Number(args.to ?? frames.length - 1));

const server = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM || process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ headless: true, executablePath, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
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
    // galadapt=0: fixed Milky Way volume budgets, so software rendering refines
    await page.goto(base + `?hidehelp=1&dpr=1&tier1=0&galadapt=0&focus=sun&dist=1e4` + (args.q ? "&" + args.q : ""));
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
    await page.addStyleTag({ content: "body * { visibility: hidden !important } #gl, #gl canvas { visibility: visible !important }" });
    // resolve every key to scene-space target, distance and unit direction
    const keys = await page.evaluate(async keys => {
        const { LY_SCENE, K } = await import("/src/constants.js");
        const { galToSceneUnitsInto, galacticToWorld } = await import("/src/universe/coords.js");
        const { earthG, sunCore } = await import("/src/bodies.js");
        return keys.map(k => {
            let tgt;
            if (k.target === "earth") tgt = earthG.position.toArray();
            else if (k.target === "sun" || !k.target) tgt = sunCore.position.toArray();
            else { tgt = [0, 0, 0]; galToSceneUnitsInto(k.target[0], k.target[1], k.target[2], tgt, 0, K); }
            let n;
            if (k.fromGal) { const w = galacticToWorld(k.fromGal); n = [w[0], w[2], -w[1]]; }
            else {
                // sunSide: yaw measured from the direction toward the Sun, so
                // a planet is seen on its day side
                const s = sunCore.position;
                const y = (k.yaw ?? (k.sunSide ? 0 : -0.95)) + (k.sunSide ? Math.atan2(s.z - tgt[2], s.x - tgt[0]) : 0), p = k.pitch ?? 0.22;
                n = [Math.cos(p) * Math.cos(y), Math.sin(p), Math.cos(p) * Math.sin(y)];
            }
            const l = Math.hypot(n[0], n[1], n[2]);
            return { tgt, dist: k.km != null ? k.km * K : k.ly * LY_SCENE, n: n.map(x => x / l) };
        });
    }, tour.keys);
    const raf = n => page.evaluate(n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
    const t0 = Date.now();
    // the first view is rendered twice: the one right after start-up can
    // catch the volume's targets half-initialised
    for (let f = first, warm = true; f <= last; warm ? (warm = false) : f++) {
        const [k, s] = frames[f];
        const a = keys[Math.max(0, k - 1)], b = keys[k];
        const lerp = (x, y) => x + (y - x) * s;
        // targets far apart glide in log-distance so the pan tracks the zoom
        const tgt = a.tgt.map((x, i) => lerp(x, b.tgt[i]));
        const dist = Math.exp(lerp(Math.log(a.dist), Math.log(b.dist)));
        const dot = Math.min(1, Math.max(-1, a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2]));
        const om = Math.acos(dot);
        const n = om < 1e-6 ? b.n : a.n.map((x, i) => (Math.sin((1 - s) * om) * x + Math.sin(s * om) * b.n[i]) / Math.sin(om));
        await page.evaluate(({ tgt, dist, n, warm }) => {
            __G.focus = "free";
            __cam.tgt.set(tgt[0], tgt[1], tgt[2]);
            __cam.dist = dist * (warm ? 1.05 : 1); __cam.distTarget = null;
            __cam.pitch = Math.asin(Math.max(-1, Math.min(1, n[1])));
            __cam.yaw = Math.atan2(n[2], n[0]);
        }, { tgt, dist, n, warm });
        await raf(4);
        await page.waitForTimeout(settleMs);
        await page.waitForFunction(() => !window.__fieldStatus || window.__fieldStatus().idle, null, { timeout: 600000, polling: 250 }).catch(() => {});
        await page.waitForFunction(() => !window.__volStatus || (!window.__volStatus().draft && window.__volStatus().fade >= 1), null, { timeout: 240000, polling: 100 }).catch(() => {});
        await raf(2);
        if (warm) continue;
        await writeFile(resolve(out, String(f).padStart(4, "0") + ".png"), await page.screenshot({ type: "png" }));
        console.log(`${f}/${frames.length - 1} key ${k} s ${s.toFixed(3)} ${(Date.now() - t0) / 1000 | 0}s`);
    }
    if (errors.length) { console.error("page errors:", errors.slice(0, 10)); process.exitCode = 1; }
} finally {
    await browser.close();
    await server.close();
}
