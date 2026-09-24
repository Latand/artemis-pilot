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
    if (args.sky) {
        // --sky=name:l:b[:fovDeg];... look from Earth toward galactic (l, b).
        for (const spec of args.sky.split(";")) {
            const [name, l, b] = spec.split(":");
            shots.push({ name, sky: [Number(l), Number(b)], dist: 1e6 });
        }
    } else for (let i = 0; i < rungs; i++) {
        const d = from * Math.pow(to / from, rungs === 1 ? 0 : i / (rungs - 1));
        shots.push({ name: String(i).padStart(3, "0"), dist: d });
    }
    for (const shot of shots) {
        if (only && !only.has(shot.name)) continue;
        await page.evaluate(async ({ shot, focus, yaw, pitch }) => {
            if (shot.sky) {
                const { galacticToWorld } = await import("/src/universe/coords.js");
                const { K } = await import("/src/constants.js");
                const l = shot.sky[0] * Math.PI / 180, b = shot.sky[1] * Math.PI / 180;
                const w = galacticToWorld([Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)]);
                const D = [w[0], w[2], -w[1]]; // scene axes
                const e = window.__eph;
                const ex = e.earthX * K, ey = 0, ez = -e.earthY * K;
                // Camera 30,000 km sunward-agnostic offset opposite the view
                // direction; the orbit rig then looks along D.
                const dist = 3e4;
                __G.focus = "free";
                // Camera 100 units (100,000 km) from Earth on the sky side,
                // looking outward along D.
                __cam.tgt.set(ex + D[0] * (dist + 100), ey + D[1] * (dist + 100), ez + D[2] * (dist + 100));
                __cam.dist = dist; __cam.distTarget = null;
                __cam.pitch = Math.asin(Math.max(-1, Math.min(1, -D[1])));
                __cam.yaw = Math.atan2(-D[2], -D[0]);
                return;
            }
            if (focus === "galpole" || focus === "galside") {
                // Orbit the Galactic centre, looking down the NGP axis (face-on)
                // or along the disk from l = 90 deg (edge-on).
                const { galacticToWorld, galToSceneUnitsInto } = await import("/src/universe/coords.js");
                const { K } = await import("/src/constants.js");
                const gc = galToSceneUnitsInto(0, 0, 0, [0, 0, 0], 0, K);
                const w = galacticToWorld(focus === "galpole" ? [0.02, 0, 1] : [0, 1, 0.08]);
                const n = [w[0], w[2], -w[1]];
                const l = Math.hypot(n[0], n[1], n[2]);
                __G.focus = "free";
                __cam.tgt.set(gc[0], gc[1], gc[2]);
                __cam.dist = shot.dist; __cam.distTarget = null;
                __cam.pitch = Math.asin(n[1] / l);
                __cam.yaw = Math.atan2(n[2], n[0]);
                return;
            }
            __G.focus = /^\d+$/.test(focus) ? Number(focus) : focus;
            __cam.dist = shot.dist; __cam.distTarget = null;
            __cam.yaw = yaw; __cam.pitch = pitch;
        }, { shot, focus, yaw, pitch });
        await page.waitForTimeout(settleMs);
        // The procedural resolved field builds in a worker: wait until it
        // has caught up with this camera (and any resolve-limit change).
        await page.waitForFunction(() => !window.__fieldStatus || window.__fieldStatus().idle, null, { timeout: 600000, polling: 500 })
            .catch(() => console.log("  (field still building)"));
        await page.waitForTimeout(300);
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
        const field = await page.evaluate(async () => (await import("/src/render/resolvedFieldStars.js")).resolvedFieldStatus());
        const state = await page.evaluate(() => ({
            camDist: __cam.dist,
            calls: __PERF.renderInfo.calls, points: __PERF.renderInfo.points, triangles: __PERF.renderInfo.triangles,
            frameMs: __PERF.samples["frame.total"]?.avg ?? null,
            renderMs: __PERF.samples["render.frame"]?.avg ?? null,
        }));
        const ly = shot.dist / 9460730472.5808;
        const row = { ...shot, ly, ...stats, ...state, fieldStars: field.stars, resolveLimit: field.mLim };
        results.push(row);
        console.log(shot.name, ly.toExponential(2) + " ly", "mean", stats.meanLum.toFixed(2), "lit", (stats.litFrac * 100).toFixed(2) + "%", "p999", stats.p999, "calls", state.calls, "field", field.stars, "mLim", field.mLim, "gen", field.gen, "builds", field.builds, "idle", field.idle, "staging", field.staging);
    }
    await hide.evaluate(el => el.remove());
    await writeFile(resolve(out, "ladder.json"), JSON.stringify({ focus, yaw, pitch, tier1, simT, W, H, errors, results }, null, 2) + "\n");
    if (errors.length) { console.error("page errors:", errors.slice(0, 10)); process.exitCode = 1; }
} finally {
    await browser.close();
    await server.close();
}
