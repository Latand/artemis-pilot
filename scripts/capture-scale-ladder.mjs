// Scale-continuity capture harness.
//
// Starts an isolated Vite server, loads Artemis at a fixed epoch with the
// simulation paused, and photographs a log-spaced camera-distance ladder
// (or a named scenario list) around one focus. Every frame records the
// rendered image plus luminance statistics measured from the screenshot, so
// a transition can be judged numerically (brightness/density jumps between
// neighbouring rungs) as well as by eye.
//
//   node scripts/capture-scale-ladder.mjs <outDir> [--tier1] [--rungs=40]
//        [--from=1e4] [--to=3.7e16] [--focus=sun] [--yaw=-0.95] [--pitch=0.22]
//        [--simt=<seconds>] [--width=1280] [--height=800] [--only=a,b]
//
// Distances are scene units (1 unit = 1000 km). --tier1 streams the full
// AT-HYG catalog before capturing (slow, ~1-2 min); without it the tier-1
// layer is disabled so runs are fast and deterministic.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const args = Object.fromEntries(process.argv.slice(3).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
}));
const out = resolve(process.argv[2] || "scale-ladder");
const W = Number(args.width || 1280), H = Number(args.height || 800);
const tier1 = !!args.tier1;
const rungs = Number(args.rungs || 40);
const from = Number(args.from || 1e4), to = Number(args.to || 3.7e16);
const focus = args.focus || "sun";
const yaw = Number(args.yaw ?? -0.95), pitch = Number(args.pitch ?? 0.22);
const simT = args.simt !== undefined ? Number(args.simt) : null;
const settleMs = Number(args.settle || 900);
await mkdir(out, { recursive: true });

const server = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
// PLAYWRIGHT_CHROMIUM (or CHROMIUM_PATH) points at a preinstalled browser when
// the pinned Playwright build's own download is unavailable.
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
    const q = `?hidehelp=1&dpr=1&perf=1&focus=${encodeURIComponent(focus)}&dist=${from}` + (tier1 ? "" : "&tier1=0") + (args.q ? "&" + args.q : "");
    await page.goto(base + q);
    await page.waitForFunction(() => window.__AP_READY, null, { timeout: 120000 });
    const enter = page.getByRole("button", { name: "ENTER SIMULATION", exact: true });
    if (await enter.isVisible().catch(() => false)) await enter.click();
    await page.evaluate(async simT => {
        const { setPaused } = await import("/src/timeCtl.js");
        __G.gr = false; __G.predict = false; __G.darkEnergy = false; __G.darkMatter = false;
        if (simT !== null) {
            const { advance } = await import("/src/physics.js");
            let guard = 0;
            while (__G.t < simT && guard++ < 20000) advance(Math.min(simT - __G.t, 3.15e13), 0, 0, 0, 0);
        }
        setPaused(true, "capture");
    }, simT);
    if (tier1) {
        for (let i = 0; i < 60; i++) {
            const s = await page.evaluate(() => __tier1Stats());
            if (s.initialized && s.tilesLoaded === s.totalTiles) break;
            await page.evaluate(async () => {
                const { updateTier1 } = await import("/src/universe/athygTier1.js");
                for (let j = 0; j < 400; j++) updateTier1(0, 0, 0, null, 0);
            });
            await page.waitForTimeout(3000);
        }
    }
    // Build the cosmic layer up front so every rung sees the same content.
    await page.evaluate(async () => {
        const c = await import("/src/cosmic.js");
        c.scheduleCosmicLayerBuild();
    });
    await page.waitForFunction(async () => (await import("/src/cosmic.js")).isCosmicLayerBuilt(), null, { timeout: 180000 });
    await page.evaluate(async () => { const s = await import("/src/realSky.js"); return s.realSkyStatus?.().loaded; });
    const hide = await page.addStyleTag({ content: "body * { visibility: hidden !important } #gl, #gl canvas { visibility: visible !important }" });

    const shots = [];
    const only = args.only ? new Set(args.only.split(",")) : null;
    for (let i = 0; i < rungs; i++) {
        const d = from * Math.pow(to / from, rungs === 1 ? 0 : i / (rungs - 1));
        shots.push({ name: String(i).padStart(3, "0"), dist: d });
    }
    for (const shot of shots) {
        if (only && !only.has(shot.name)) continue;
        await page.evaluate(({ shot, focus, yaw, pitch }) => {
            __G.focus = /^\d+$/.test(focus) ? Number(focus) : focus;
            __cam.dist = shot.dist; __cam.distTarget = null;
            __cam.yaw = yaw; __cam.pitch = pitch;
        }, { shot, focus, yaw, pitch });
        await page.waitForTimeout(settleMs);
        await page.evaluate(() => __PERF.clear());
        await page.waitForTimeout(250);
        const buf = await page.screenshot({ type: "png" });
        const file = resolve(out, shot.name + ".png");
        await writeFile(file, buf);
        const stats = await page.evaluate(async b64 => {
            const img = new Image();
            img.src = "data:image/png;base64," + b64;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.width; c.height = img.height;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            const n = c.width * c.height;
            const hist = new Uint32Array(256);
            let sum = 0, lit = 0, bright = 0;
            for (let i = 0; i < d.length; i += 4) {
                const y = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
                hist[y]++; sum += y;
                if (y > 24) lit++;
                if (y > 160) bright++;
            }
            const pct = p => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p * n) return v; } return 255; };
            return { meanLum: sum / n, litFrac: lit / n, brightFrac: bright / n, p50: pct(.5), p99: pct(.99), p999: pct(.999) };
        }, buf.toString("base64"));
        const state = await page.evaluate(() => ({
            camDist: __cam.dist,
            calls: __PERF.renderInfo.calls, points: __PERF.renderInfo.points, triangles: __PERF.renderInfo.triangles,
            frameMs: __PERF.samples["frame.total"]?.avg ?? null,
            renderMs: __PERF.samples["render.frame"]?.avg ?? null,
        }));
        const ly = shot.dist / 9460730472.5808;
        const row = { ...shot, ly, ...stats, ...state };
        results.push(row);
        console.log(shot.name, ly.toExponential(2) + " ly", "mean", stats.meanLum.toFixed(2), "lit", (stats.litFrac * 100).toFixed(2) + "%", "p999", stats.p999, "calls", state.calls);
    }
    await hide.evaluate(el => el.remove());
    await writeFile(resolve(out, "ladder.json"), JSON.stringify({ focus, yaw, pitch, tier1, simT, W, H, errors, results }, null, 2) + "\n");
    if (errors.length) { console.error("page errors:", errors.slice(0, 10)); process.exitCode = 1; }
} finally {
    await browser.close();
    await server.close();
}
