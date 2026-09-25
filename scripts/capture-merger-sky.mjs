// Merger sky capture: the sky seen from the Earth while the Milky Way and
// Andromeda collide. For each epoch the simulation clock is set, the camera
// sits beside the Earth and looks toward Andromeda's apparent (retarded)
// position and toward the Galactic centre; every frame records the image
// and luminance statistics.
//
//   node scripts/capture-merger-sky.mjs <outDir> [--gyr=0,3,4.05,...]
//        [--fov=70] [--width=1280] [--height=800] [--views=m31,gc]
//
// Set PLAYWRIGHT_CHROMIUM to a preinstalled browser when the pinned
// Playwright build's own download is unavailable.
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const args = Object.fromEntries(process.argv.slice(3).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? "1"] : [a, "1"];
}));
const out = resolve(process.argv[2] || "merger-sky");
const W = Number(args.width || 1280), H = Number(args.height || 800);
const epochs = (args.gyr || "0,2,3.5,3.9,4.05,4.3,5,6,7.1,8,10,14").split(",").map(Number);
const fov = Number(args.fov || 70);
const views = (args.views || "m31,gc").split(",");
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
    await page.goto(base + `?hidehelp=1&dpr=1&perf=1&tier1=0&galadapt=0&focus=earth&dist=3e4` + (args.q ? "&" + args.q : ""));
    await page.waitForFunction(() => window.__AP_READY, null, { timeout: 120000 });
    const enter = page.getByRole("button", { name: "ENTER SIMULATION", exact: true });
    if (await enter.isVisible().catch(() => false)) await enter.click();
    await page.evaluate(async fov => {
        const { setPaused } = await import("/src/timeCtl.js");
        __G.gr = false; __G.predict = false; __G.darkEnergy = false; __G.darkMatter = false;
        setPaused(true, "capture");
        const { camera } = await import("/src/scene.js");
        camera.fov = fov;
        camera.updateProjectionMatrix();
        window.dispatchEvent(new Event("resize"));
    }, fov);
    await page.waitForFunction(() => !window.__galaxyStatus || window.__galaxyStatus().ready || window.__galaxyStatus().error, null, { timeout: 180000, polling: 500 });
    const hide = await page.addStyleTag({ content: "body * { visibility: hidden !important } #gl, #gl canvas { visibility: visible !important }" });
    const frames = n => page.evaluate(n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
    for (const gyr of epochs) {
        await page.evaluate(t => { __G.t = t; }, gyr * 1e9 * 31557600);
        await frames(6);
        if (gyr > 1) {
            await page.waitForFunction(() => !window.__tidesStatus || window.__tidesStatus().ready || window.__tidesStatus().error, null, { timeout: 180000, polling: 250 });
        }
        for (const view of views) {
            const info = await page.evaluate(async view => {
                const { galacticCenterScene } = await import("/src/universe/starfield.js");
                const { andromedaOffsetMpc } = await import("/src/universe/localGroupOrbit.js");
                const { K, MPC_KM, C_LIGHT } = await import("/src/constants.js");
                const e = window.__eph;
                const ex = e.earthX * K, ey = 0, ez = -e.earthY * K;
                const gc = galacticCenterScene();
                let tx, ty, tz;
                if (view === "gc") { tx = gc[0]; ty = gc[1]; tz = gc[2]; }
                else {
                    // Andromeda where its arriving light left it (iterate the retarded time)
                    const m = [0, 0, 0];
                    let tr = __G.t;
                    for (let i = 0; i < 4; i++) {
                        andromedaOffsetMpc(tr, m);
                        const k = MPC_KM * K;
                        tx = gc[0] + m[0] * k; ty = gc[1] + m[2] * k; tz = gc[2] - m[1] * k;
                        tr = __G.t - Math.hypot(tx - ex, ty - ey, tz - ez) / K / C_LIGHT;
                    }
                }
                let D = [tx - ex, ty - ey, tz - ez];
                const L = Math.hypot(D[0], D[1], D[2]);
                D = D.map(v => v / L);
                const dist = 3e4;
                __G.focus = "free";
                __cam.tgt.set(ex + D[0] * (dist + 100), ey + D[1] * (dist + 100), ez + D[2] * (dist + 100));
                __cam.dist = dist; __cam.distTarget = null;
                __cam.pitch = Math.asin(Math.max(-1, Math.min(1, -D[1])));
                __cam.yaw = Math.atan2(-D[2], -D[0]);
                return { distKpc: L / K / 3.0856775814913673e16 };
            }, view);
            await frames(8);
            await page.waitForTimeout(400);
            const buf = await page.screenshot({ type: "png" });
            const name = `t${String(gyr).replace(".", "p")}-${view}`;
            await writeFile(resolve(out, name + ".png"), buf);
            const stats = await page.evaluate(async b64 => {
                const img = new Image();
                img.src = "data:image/png;base64," + b64;
                await img.decode();
                const c = document.createElement("canvas");
                c.width = img.width; c.height = img.height;
                const ctx = c.getContext("2d");
                ctx.drawImage(img, 0, 0);
                const d = ctx.getImageData(0, 0, c.width, c.height).data;
                let sum = 0, lit = 0;
                for (let i = 0; i < d.length; i += 4) {
                    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
                    sum += y; if (y > 24) lit++;
                }
                return { meanLum: sum / (d.length / 4), litFrac: lit / (d.length / 4) };
            }, buf.toString("base64"));
            const tides = await page.evaluate(() => window.__tidesStatus?.() || null);
            const row = { gyr, view, ...info, ...stats, tidesVisible: tides?.visible ?? null };
            results.push(row);
            console.log(name, "dist", info.distKpc.toFixed(1), "kpc", "mean", stats.meanLum.toFixed(2), "lit", (stats.litFrac * 100).toFixed(1) + "%", "tides", tides?.visible);
        }
    }
    await hide.evaluate(el => el.remove());
    await writeFile(resolve(out, "merger-sky.json"), JSON.stringify({ epochs, fov, W, H, errors, results }, null, 2) + "\n");
    if (errors.length) { console.error("page errors:", errors.slice(0, 10)); process.exitCode = 1; }
} finally {
    await browser.close();
    await server.close();
}
