// Tidal-encounter capture harness.
//
// Starts an isolated Vite server, loads Artemis paused, places a hole so a
// chosen body is on a chosen conic about it (the geometry the regime smoke
// uses), advances simulation time deterministically through the encounter
// and photographs it at several phases. Timing anchors come from the booked
// encounter itself (inbound r_t crossing, pericentre, event, fallback time),
// so every phase lands on the same physical moment at any machine speed.
//
//   PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium \
//   node scripts/capture-tde.mjs [outDir=docs/tde-regimes] [--only=full,partial,flyby,capture]
//        [--phases=01,03] [--width=1280] [--height=800] [--q=extra&query]
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return [m[1], m[2] ?? "1"];
}));
const outArg = process.argv.slice(2).find(a => !a.startsWith("--"));
const out = resolve(outArg || "docs/tde-regimes");
const W = Number(args.width || 1280), H = Number(args.height || 800);
const only = args.only ? new Set(args.only.split(",")) : null;
const phaseFilter = args.phases ? args.phases.split(",") : null;
await mkdir(out, { recursive: true });

// Phases: `at` anchors on the booked encounter — "tidal" (inbound r_t
// crossing), "peri" (pericentre), "event" (booked outcome), "tfb" (k fallback
// times after pericentre). focus: "body" (dist in body radii), "debris" (dist
// in debris-cloud radii, floored at the body radius), "hole" (dist in
// L = max(r_t, 2 r_s)), "span" (frames the hole and the whole debris cloud;
// dist 1 just fits). The view looks down the orbital axis, tilted by `tilt`
// rad toward the tidal axis.
const SCENARIOS = [
    {
        id: "full", label: "Sun + 1e6 Msun, beta 3: full disruption",
        target: "sun", msun: 1e6, beta: 3, d0: 2.6,
        phases: [
            { name: "01-approach", at: "tidal", dt: -5400, focus: "body", dist: 16, tilt: .35 },
            { name: "02-stretched", at: "tidal", dt: -240, focus: "body", dist: 11, tilt: .35 },
            { name: "03-frozen-in", at: "tidal", dt: 420, focus: "debris", dist: 3.2, tilt: .35 },
            { name: "04-pericentre", at: "peri", dt: 0, focus: "debris", dist: 3.4, tilt: .35 },
            { name: "05-stream-1h", at: "peri", dt: 3600, focus: "debris", dist: 2.6, tilt: .3 },
            { name: "06-stream-8h", at: "peri", dt: 8 * 3600, focus: "debris", dist: 2.2, tilt: .12 },
            { name: "07-stream-2d", at: "peri", dt: 2 * 86400, focus: "debris", dist: 2.2, tilt: .12 },
            { name: "08-stream-12d", at: "peri", dt: 12 * 86400, focus: "span", dist: 1.25, tilt: .12 },
            { name: "09-fallback-1.2tfb", at: "tfb", k: 1.2, focus: "span", dist: 1.1, tilt: .12 },
            { name: "10-inner-1.2tfb", at: "tfb", k: 1.2, focus: "hole", dist: 4, tilt: .35 },
            { name: "11-disk-3tfb", at: "tfb", k: 3, focus: "hole", dist: 2.2, tilt: .6 },
            { name: "12-disk-inclined", at: "tfb", k: 3, focus: "hole", dist: 1.6, tilt: 1.3 },
        ],
    },
    {
        id: "partial", label: "Sun + 1e6 Msun, beta 1.4: partial disruption",
        target: "sun", msun: 1e6, beta: 1.4, d0: 2.6,
        phases: [
            { name: "01-approach", at: "peri", dt: -9000, focus: "body", dist: 16, tilt: .35 },
            { name: "02-near-peri", at: "peri", dt: -900, focus: "body", dist: 11, tilt: .35 },
            { name: "03-stripping", at: "peri", dt: 1800, focus: "body", dist: 14, tilt: .35 },
            { name: "04-streams-6h", at: "peri", dt: 6 * 3600, focus: "span", dist: 1.25, tilt: .12 },
            { name: "05-streams-2d", at: "peri", dt: 2 * 86400, focus: "span", dist: 1.25, tilt: .12 },
        ],
    },
    {
        id: "flyby", label: "Jupiter + 1e5 Msun, beta 0.45: tidal distortion flyby",
        target: 3, msun: 1e5, beta: .45, d0: 3.2,
        phases: [
            { name: "01-inbound", at: "peri", dt: -40000, focus: "body", dist: 5, tilt: .35 },
            { name: "02-pericentre", at: "peri", dt: 0, focus: "body", dist: 5, tilt: .35 },
            { name: "03-outbound", at: "peri", dt: 40000, focus: "body", dist: 5, tilt: .35 },
        ],
    },
    {
        id: "capture", label: "Sun + 1e8 Msun: swallowed whole (Hills regime)",
        target: "sun", msun: 1e8, beta: 1, d0: 6,
        phases: [
            // the camera sits 12 L = 7.1e9 km out, looking down the orbital
            // axis: it sees the hole ~6.6 h late (light-travel time)
            { name: "01-approach", at: "event", dt: -7200, focus: "body", dist: 60, tilt: .35 },
            { name: "02-infall-seen", at: "event", dt: 6 * 3600, focus: "hole", dist: 12, tilt: 0 },
            { name: "03-plunge-seen", at: "event", dt: 7.4 * 3600, focus: "hole", dist: 12, tilt: 0 },
            { name: "04-frozen-seen", at: "event", dt: 14 * 3600, focus: "hole", dist: 12, tilt: 0 },
        ],
    },
];

const server = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false }, logLevel: "error" });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}/`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM || process.env.CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ headless: true, executablePath, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const summary = [];
try {
    for (const sc of SCENARIOS) {
        if (only && !only.has(sc.id)) continue;
        const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
        await context.addInitScript(() => {
            Date.now = () => Date.UTC(2026, 8, 13, 12);
            localStorage.setItem("ap_intro_seen", "1");
        });
        // external fonts are cosmetic and unreachable offline
        await context.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
        const page = await context.newPage();
        page.setDefaultTimeout(300000);
        const errors = [];
        page.on("pageerror", e => errors.push(String(e)));
        page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
        await page.goto(base + "?hidehelp=1&dpr=1&tier1=0&galadapt=0&bloom=0&focus=sun&dist=2000" + (args.q ? "&" + args.q : ""));
        await page.waitForFunction(() => window.__AP_READY, null, { timeout: 120000 });
        const enter = page.getByRole("button", { name: "ENTER SIMULATION", exact: true });
        if (await enter.isVisible().catch(() => false)) await enter.click();
        const info = await page.evaluate(async sc => {
            const { setPaused } = await import("/src/timeCtl.js");
            const { updEphem } = await import("/src/ephemeris.js");
            const enc = await import("/src/bhEncounters.js");
            const { MU_S, R_SUN, C_LIGHT, PL } = await import("/src/constants.js");
            setPaused(true, "capture");
            __G.gr = false; __G.predict = false; __G.darkEnergy = false; __G.darkMatter = false;
            updEphem();
            const target = sc.target;
            const b = enc.bodyState(target, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
            const muB = target === "sun" ? MU_S : PL[target].mu;
            const R = target === "sun" ? R_SUN : PL[target].R;
            const rs = 2 * MU_S * sc.msun / (C_LIGHT * C_LIGHT);
            const muH = rs * C_LIGHT * C_LIGHT / 2, mu = muH + muB;
            const rt = R * Math.cbrt(muH / muB);
            const L = Math.max(rt, 2 * rs);
            const rp = rt / sc.beta, e = 1, p = rp * (1 + e), d0 = sc.d0 * L;
            const nu = -Math.acos(Math.max(-1, Math.min(1, (p / d0 - 1) / e)));
            const r = p / (1 + e * Math.cos(nu));
            let px = r * Math.cos(nu), py = r * Math.sin(nu);
            const k = Math.sqrt(mu / p);
            let vx = -k * Math.sin(nu), vy = k * (e + Math.cos(nu));
            {
                // same angular momentum, zero energy in the hole's
                // Paczynski-Wiita potential: exactly parabolic, so half the
                // debris is bound
                const h = px * vy - py * vx, v = Math.sqrt(2 * mu / (r - rs)), vt = h / r;
                const vr = -Math.sqrt(Math.max(0, v * v - vt * vt));
                vx = (vr * px - vt * py) / r; vy = (vr * py + vt * px) / r;
            }
            const phi = .9, c = Math.cos(phi), s = Math.sin(phi);
            [px, py] = [px * c - py * s, px * s + py * c];
            [vx, vy] = [vx * c - vy * s, vx * s + vy * c];
            const incl = .25, ci = Math.cos(incl), si = Math.sin(incl);
            const rel = { x: px, y: py * ci, z: py * si, vx, vy: vy * ci, vz: vy * si };
            window.__addBH(b.x - rel.x, b.y - rel.y, rs, b.vx - rel.vx, b.vy - rel.vy, true, null, 0, 0, b.z - rel.z, b.vz - rel.vz);
            __G.focus = "bh:0";
            return { rt, rs, L, R, t0: __G.t };
        }, sc);
        const book = await page.evaluate(async target => {
            const { advance, advanceWorld } = await import("/src/physics.js");
            const enc = await import("/src/bhEncounters.js");
            const mine = r => r.target === target && r.cls && r.regime !== "none";
            for (let k = 0; k < 400 && !enc.ENC.some(mine); k++) {
                if (__G.dead) advanceWorld(1); else advance(1, 0, 0, 0, 0);
            }
            const rec = enc.ENC.find(mine) || null;
            if (!rec) return null;
            // an event already resolved while booking: take its recorded time
            const done = enc.CAPTURES.find(c => c.target === target) || enc.TDES.find(d => d.target === target);
            const tEvent = Number.isFinite(rec.tEvent) ? rec.tEvent : done ? (done.t ?? done.t0) : rec.tPeri;
            return { regime: rec.regime, target: rec.target, tPeri: rec.tPeri, tTidal: rec.tTidal, tEvent, tFb: rec.cls.tFbSec, beta: rec.cls.beta };
        }, sc.target);
        console.log(sc.id, "booked", JSON.stringify(book), "L", info.L.toExponential(3), "km");
        if (!book) { errors.push("encounter was not booked"); }
        const hide = await page.addStyleTag({ content: "body * { visibility: hidden !important } #gl, #gl canvas { visibility: visible !important }" });
        for (const ph of book ? sc.phases : []) {
            if (phaseFilter && !phaseFilter.some(p => ph.name.startsWith(p))) continue;
            const tAt = ph.at === "tidal" ? book.tTidal + (ph.dt || 0) :
                ph.at === "event" ? book.tEvent + (ph.dt || 0) :
                    ph.at === "tfb" ? book.tPeri + ph.k * book.tFb : book.tPeri + (ph.dt || 0);
            const st = await page.evaluate(async ({ tAt, ph, info, target }) => {
                const { advance, advanceWorld } = await import("/src/physics.js");
                const enc = await import("/src/bhEncounters.js");
                const vis = await import("/src/tdeVisuals.js");
                const { K } = await import("/src/constants.js");
                const { eph } = await import("/src/ephemeris.js");
                let guard = 0;
                while (__G.t < tAt - 1e-6 && guard++ < 400000) {
                    const dt = Math.min(tAt - __G.t, 3600);
                    if (__G.dead || __G.landed) advanceWorld(dt); else advance(dt, 0, 0, 0, 0);
                }
                // one render pass so the debris systems exist and are current
                const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                await frames();
                // The debris is drawn at the camera's retarded time, so moving
                // the camera moves what it sees: aim, let the frame catch up,
                // and aim again at the cloud as now seen.
                let sys = null, focus = ph.focus, distKm = 0, rec = null;
                for (let pass = 0; pass < 3; pass++) {
                sys = vis.debrisSystemsInfo().find(s => s.target === target && s.live > 0) || null;
                // the encounter's orbital axis (world -> scene: x, z, -y)
                rec = enc.ENC.find(r => r.target === target) || null;
                const spec = rec?.debris || enc.TDES.find(d => d.target === target)?.debris || enc.CAPTURES.find(c => c.target === target)?.debris || null;
                let rx, ry, rz, vx, vy, vz;
                if (rec && rec.cls) { rx = rec.relX; ry = rec.relY; rz = rec.relZ; vx = rec.relVx; vy = rec.relVy; vz = rec.relVz; }
                else if (spec) { rx = spec.x; ry = spec.y; rz = spec.z; vx = spec.vx; vy = spec.vy; vz = spec.vz; }
                else { rx = 1; ry = 0; rz = 0; vx = 0; vy = 1; vz = 0; }
                let hx = ry * vz - rz * vy, hy = rz * vx - rx * vz, hz = rx * vy - ry * vx;
                const hl = Math.hypot(hx, hy, hz) || 1;
                let nx = hx / hl, ny = hz / hl, nz = -hy / hl;
                if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
                const al = Math.hypot(rx, ry, rz) || 1;
                const ax = rx / al, ay = rz / al, az = -ry / al;
                const tilt = ph.tilt ?? .35;
                let ux = nx * Math.cos(tilt) + ax * Math.sin(tilt), uy = ny * Math.cos(tilt) + ay * Math.sin(tilt), uz = nz * Math.cos(tilt) + az * Math.sin(tilt);
                const ul = Math.hypot(ux, uy, uz) || 1;
                ux /= ul; uy /= ul; uz /= ul;
                __cam.pitch = Math.max(-1.35, Math.min(1.35, Math.asin(uy)));
                __cam.yaw = Math.atan2(uz, ux);
                const alive = target === "sun" ? !__WORLD.sunDestroyed : typeof target === "number" ? !__WORLD.plDestroyed[target] : true;
                focus = ph.focus;
                if (focus === "body" && !alive) focus = sys ? "debris" : "hole";
                if ((focus === "debris" || focus === "span") && !sys) focus = alive ? "body" : "hole";
                if (focus === "body") { __G.focus = target; distKm = ph.dist * info.R; }
                else if (focus === "hole") { __G.focus = "bh:0"; distKm = ph.dist * info.L; }
                else if (focus === "span") {
                    // midpoint of hole and cloud centroid; half-extent covers both
                    __G.focus = "free";
                    const hx0 = (eph.earthX + __BH.x[0] + sys.cx / 2) * K, hy0 = (__BH.z[0] + sys.cz / 2) * K, hz0 = -(eph.earthY + __BH.y[0] + sys.cy / 2) * K;
                    __cam.tgt.set(hx0, hy0, hz0);
                    const half = Math.hypot(sys.cx, sys.cy, sys.cz) / 2 + 1.6 * sys.radius;
                    distKm = ph.dist * half / Math.tan(24 * Math.PI / 180);
                }
                else {
                    __G.focus = "free";
                    const hx0 = (eph.earthX + __BH.x[0] + sys.cx) * K, hy0 = (__BH.z[0] + sys.cz) * K, hz0 = -(eph.earthY + __BH.y[0] + sys.cy) * K;
                    __cam.tgt.set(hx0, hy0, hz0);
                    distKm = ph.dist * Math.max(sys.radius, info.R * 3);
                }
                __cam.dist = distKm * K; __cam.distTarget = null;
                await frames();
                if (focus !== "debris" && focus !== "span") break;
                }
                const tde = enc.TDES.find(d => d.target === target);
                return {
                    t: __G.t, focus, distKm, regime: tde?.regime || (enc.CAPTURES.some(c => c.target === target) ? "captured" : rec?.regime || "none"),
                    debris: sys ? { live: sys.live, count: sys.count, radiusKm: sys.radius, bound: sys.bound, unbound: sys.unbound, returned: sys.returned, plunged: sys.plunged, rMinKm: sys.rMin, rMedianKm: sys.rMedian, rMaxKm: sys.rMax } : null,
                    tidal: vis.tidalState(target) ? { lambda: vis.tidalState(target).lambda, shrink: vis.tidalState(target).shrink } : null,
                    holeMsun: __BH.mu[0] / 132712440018,
                };
            }, { tAt, ph, info, target: sc.target });
            await page.waitForTimeout(900);
            if (args.debug) {
                // where the debris lands on screen (diagnosing framing)
                const dbg = await page.evaluate(async () => {
                    const { camera } = await import("/src/scene.js");
                    const vis = await import("/src/tdeVisuals.js");
                    const g = vis.tdeVisualGroup();
                    let inView = 0, total = 0, ndcMin = [9, 9], ndcMax = [-9, -9], nearCentre = 0;
                    const grid = new Array(40).fill(0);
                    const v = camera.position.clone();
                    g.updateMatrixWorld(true);
                    for (const pts of g.children) {
                        const pos = pts.geometry.getAttribute("position"), alp = pts.geometry.getAttribute("aAlpha");
                        for (let i = 0; i < pos.count; i++) {
                            if (!(alp.getX(i) > 0)) continue;
                            total++;
                            v.fromBufferAttribute(pos, i).applyMatrix4(pts.matrixWorld).project(camera);
                            if (Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z > -1 && v.z < 1) {
                                inView++;
                                grid[Math.min(4, Math.floor((v.y + 1) * 2.5)) * 8 + Math.min(7, Math.floor((v.x + 1) * 4))]++;
                                if (Math.hypot(v.x * 640, v.y * 400) < 20) nearCentre++;
                            }
                            ndcMin[0] = Math.min(ndcMin[0], v.x); ndcMin[1] = Math.min(ndcMin[1], v.y);
                            ndcMax[0] = Math.max(ndcMax[0], v.x); ndcMax[1] = Math.max(ndcMax[1], v.y);
                        }
                    }
                    const systems = vis.debrisSystemsInfo().map(x => ({ target: x.target, kind: x.kind, count: x.count, live: x.live, t0: x.t0, rMed: x.rMedian, radius: x.radius, bh: x.bh }));
                    return { nearCentre, grid: grid.join(","), systems, groups: g.children.length, visible: g.children.map(c => c.visible), total, inView, ndcMin, ndcMax, near: camera.near, far: camera.far, camPos: camera.position.toArray() };
                });
                console.log("     debug", JSON.stringify(dbg));
            }
            const buf = await page.screenshot({ type: "png" });
            const file = resolve(out, sc.id + "-" + ph.name + ".png");
            await writeFile(file, buf);
            console.log("  ", ph.name, JSON.stringify(st));
            summary.push({ scenario: sc.id, label: sc.label, phase: ph.name, file: sc.id + "-" + ph.name + ".png", ...st });
        }
        await hide.evaluate(el => el.remove());
        if (errors.length) { console.error("page errors:", errors.slice(0, 10)); process.exitCode = 1; }
        await context.close();
    }
    await writeFile(resolve(out, "capture.json"), JSON.stringify(summary, null, 2) + "\n");
} finally {
    await browser.close();
    await server.close();
}
