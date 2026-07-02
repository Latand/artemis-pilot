// Smoke test for WP23b (src/universe/sunEvolution.js): the Sun's own life
// cycle under deep time warp.
//
// Part 1 (pure Node, no browser): exercises sunStateAt(simTSeconds) directly
// — the acceptance numbers from the WP23b brief (MS today, L(+5Gyr)>1.4, RGB
// tip R>150 Rsun somewhere in [7,8.5] Gyr from now, WD by 9 Gyr with
// R<0.02 Rsun, final mass ~0.54 Msun) plus continuity across every phase
// boundary (no visible pop in L/Teff at a phase transition).
//
// Part 2 (headless Playwright): drives the live app's ship/ephemeris forward
// via direct advance() calls (same technique as smoke-river-deeptime.mjs) to
// the RGB tip and confirms Mercury+Venus are actually engulfed (Mars is
// not), then to the white-dwarf epoch — reading the real bodies.js module
// instance's sunGlow/sunCore state (color + radius scale) as the physical
// proof the visual really tracks the evolving star, plus a screenshot of
// each epoch for human sanity-checking.

import { createServer } from "vite";
import {
    sunStateAt, PHASE_BOUNDARIES_GYR, WD_MASS_MSUN,
} from "../src/universe/sunEvolution.js";

const GYR_SEC = 1e9 * 31557600;

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
    if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "   " + detail : ""}`); }
    else { fail++; console.log(`  FAIL  ${label}${detail ? "   " + detail : ""}`); }
};
const hr = t => console.log("\n" + "─".repeat(60) + "\n  " + t + "\n" + "─".repeat(60));
const atGyr = gyr => sunStateAt(gyr * GYR_SEC);

hr("Part 1: sunStateAt pure-math acceptance (Node, no browser)");

{
    const now = atGyr(0);
    ok(now.phase === "MS", "today (t=0) is main-sequence", `got ${now.phase}`);
    ok(Math.abs(now.L_Lsun - 1) < 1e-6, "today L = 1 Lsun", `got ${now.L_Lsun}`);
    ok(Math.abs(now.Teff - 5772) < 1e-6, "today Teff = 5772K", `got ${now.Teff}`);
    ok(Math.abs(now.R_Rsun - 1) < 1e-6, "today R = 1 Rsun", `got ${now.R_Rsun}`);
    ok(Math.abs(now.massLoss - 1) < 1e-9, "today mass = 1 Msun (no loss yet)", `got ${now.massLoss}`);
}

{
    const at5 = atGyr(5);
    ok(at5.L_Lsun > 1.4, "L(+5 Gyr) > 1.4 Lsun (main-sequence brightening)", `got ${at5.L_Lsun.toFixed(3)}`);
    ok(at5.phase === "MS", "+5 Gyr is still main-sequence", `got ${at5.phase}`);
}

{
    // Sweep [7, 8.5] Gyr for the RGB-tip peak radius (fine enough to catch a
    // ~0.3 Gyr-wide anchor without hardcoding the exact tip time).
    let maxR = 0, maxAtGyr = 0;
    for (let g = 7; g <= 8.5; g += 0.005) {
        const s = atGyr(g);
        if (s.R_Rsun > maxR) { maxR = s.R_Rsun; maxAtGyr = g; }
    }
    ok(maxR > 150, "RGB-tip peak radius exceeds 150 Rsun within [7, 8.5] Gyr from now", `got ${maxR.toFixed(1)} Rsun at +${maxAtGyr.toFixed(2)} Gyr`);
}

{
    const at9 = atGyr(9);
    ok(at9.phase === "WD", "the Sun is a white dwarf by +9 Gyr", `got ${at9.phase}`);
    ok(at9.R_Rsun < 0.02, "white-dwarf radius < 0.02 Rsun (Earth-ish) by +9 Gyr", `got ${at9.R_Rsun.toFixed(5)}`);
    ok(Math.abs(at9.massLoss - WD_MASS_MSUN) < 0.01, "final remnant mass ~0.54 Msun by +9 Gyr", `got ${at9.massLoss.toFixed(3)}`);
}

hr("Continuity across every phase boundary (no L/Teff pop)");
{
    const order = ["MS", "subgiant", "RGB", "heliumFlash", "AGB", "PN", "WD"];
    const boundaries = [
        PHASE_BOUNDARIES_GYR.msEnd, PHASE_BOUNDARIES_GYR.subgiantEnd, PHASE_BOUNDARIES_GYR.rgbTip,
        PHASE_BOUNDARIES_GYR.heFlashEnd, PHASE_BOUNDARIES_GYR.agbTip, PHASE_BOUNDARIES_GYR.wdStart,
    ];
    const eps = 1e-6;
    let prevPhase = null;
    for (let i = 0; i < boundaries.length; i++) {
        const b = boundaries[i];
        const before = atGyr(b - eps), after = atGyr(b + eps);
        ok(before.phase === order[i] && after.phase === order[i + 1],
            `phase boundary at +${b} Gyr: ${order[i]} -> ${order[i + 1]}`, `got ${before.phase} -> ${after.phase}`);
        const dL = Math.abs(after.L_Lsun - before.L_Lsun) / Math.max(before.L_Lsun, 1e-9);
        const dT = Math.abs(after.Teff - before.Teff) / Math.max(before.Teff, 1e-9);
        ok(dL < 0.01, `L continuous across ${order[i]}->${order[i + 1]}`, `Δ=${(dL * 100).toFixed(3)}%`);
        ok(dT < 0.01, `Teff continuous across ${order[i]}->${order[i + 1]}`, `Δ=${(dT * 100).toFixed(3)}%`);
    }
    ok(atGyr(20).phase === "WD" && atGyr(20).R_Rsun < 0.02, "stays a small, cool white dwarf far into deep time (+20 Gyr)");
    // phaseDurationSec is deliberately Infinity for the (endless) WD phase —
    // check the physical quantities stay finite, not that bonus field.
    const far = atGyr(100);
    const finite = [far.L_Lsun, far.R_Rsun, far.Teff, far.massLoss, far.ageIntoPhaseSec].every(Number.isFinite);
    ok(finite, "sunStateAt's physical quantities stay finite at extreme deep time (+100 Gyr)", JSON.stringify(far));
}

if (fail > 0) {
    console.log(`\n${pass} passed, ${fail} FAILED — aborting before the browser part.\n`);
    process.exit(1);
}
console.log(`\n${pass} passed, ${fail} failed.\n`);

hr("Part 2: headless deep-warp run (engulfment + Sun visual)");

let url = process.env.ARTEMIS_URL;
let viteServer = null;
if (!url) {
    // hmr:false — this repo checkout is shared with other concurrently-running
    // agents; a live-reload push mid-test (from an unrelated file edit) would
    // destroy the page.evaluate() execution context this test depends on for
    // several minutes straight. This test only needs one static page load.
    viteServer = await createServer({ logLevel: "silent", server: { host: "127.0.0.1", port: 0, hmr: false } });
    await viteServer.listen();
    const address = viteServer.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite server did not expose a TCP port");
    url = `http://127.0.0.1:${address.port}/?bloom=0&hidehelp=1&tier1=0`;
}

const pwModule = await import("playwright");
const pw = pwModule.default ?? pwModule;
const browser = await pw.chromium.launch({
    headless: true,
    args: [
        "--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle",
        "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("pageerror", err => errors.push(err.message));

function assert(condition, message, ctx) {
    if (!condition) throw new Error(message + (ctx ? " " + JSON.stringify(ctx) : ""));
}

// This smoke is about the SUN and PLANETS' fate at a given epoch, not about
// flying the ship there — a real ship parked passively at Earth's old LEO
// gets correctly vaporized once the giant swallows Earth's orbit (~7.65 Gyr,
// verified separately), which is physically right but would stall a test
// that's trying to sample epochs past it. So: teleport G.t directly (like
// smoke-river-deeptime.mjs's runToEpoch teleports the ship), refresh the
// ephemeris for that instant, and fire one near-zero advance() call purely
// to trigger checkSunEngulfment/refreshActiveStars (both live at the top of
// physics.js's advance()) for the new epoch. The ship itself is parked at a
// static, inert 50 AU (never near any body, never dies) so it can't
// interfere with any of that.
async function warpToEpoch(page, targetGyr, { freshStart } = {}) {
    return await page.evaluate(async ({ targetGyr, freshStart }) => {
        const { G, WORLD, resetWorld } = await import("/src/state.js");
        const { SEC_YEAR, AU_KM, SUN_RADIUS } = await import("/src/constants.js");
        const { advance } = await import("/src/physics.js");
        const { updEphem } = await import("/src/ephemeris.js");
        const { sunStateAt } = await import("/src/universe/sunEvolution.js");
        const bodies = await import("/src/bodies.js");

        if (freshStart) {
            resetWorld();
            G.dead = false; G.landed = null; G.paused = false; G.cabin = false;
            G.darkEnergy = true; G.darkMatter = true; G.gr = true;
            G.x = 50 * AU_KM; G.y = 0; G.z = 0; G.vx = 0; G.vy = 0; G.vz = 0;
            G.heading = 0; G.pitch = 0; G.focus = "ship";
        }
        G.warp = 1;
        G.t = targetGyr * 1e9 * SEC_YEAR;
        updEphem(G.t);
        advance(1e-6, 0, 0, 0, 0);

        const sun = sunStateAt(G.t);
        G.focus = "sun";
        const cam = window.__cam;
        if (cam) cam.dist = Math.max(0.05, SUN_RADIUS * sun.R_Rsun * 7);

        const waitFrame = () => new Promise(r => requestAnimationFrame(r));
        for (let i = 0; i < 12; i++) await waitFrame();

        const glowColor = bodies.sunGlow ? [bodies.sunGlow.material.color.r, bodies.sunGlow.material.color.g, bodies.sunGlow.material.color.b] : null;
        return {
            gyrReached: G.t / (1e9 * SEC_YEAR),
            sun,
            plDestroyed: Array.from(WORLD.plDestroyed),
            earthDestroyed: WORLD.earthDestroyed,
            sunCoreScale: bodies.sunCore ? bodies.sunCore.scale.x : null,
            glowColor,
        };
    }, { targetGyr, freshStart });
}

// Vite's dev server can trigger a one-time full-reload the first time it
// discovers a not-yet-pre-bundled dependency mid-session (e.g. this new
// module's import graph) — the reload destroys the current page.evaluate's
// execution context. Retry once after any such reload, forcing a fresh
// warp from t=0 (whatever state was mid-evaluate is gone with the reload).
async function warpToEpochRetrying(page, targetGyr, opts) {
    try {
        return await warpToEpoch(page, targetGyr, opts);
    } catch (err) {
        if (!/Execution context was destroyed|navigation/i.test(String(err?.message))) throw err;
        console.log("  (page reloaded mid-evaluate — retrying " + targetGyr + " Gyr from a fresh start)");
        await page.waitForFunction(() => window.__G && window.__cam && window.__gl, null, { timeout: 60000 });
        return await warpToEpoch(page, targetGyr, { ...opts, freshStart: true });
    }
}

try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem("ap_introSeen", "1"); localStorage.setItem("ap_helpSeen", "1"); });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => window.__G && window.__cam && window.__gl);

    // --- RGB tip (~7.5 Gyr from now): Mercury + Venus gone, Mars intact ---
    const rgb = await warpToEpochRetrying(page, 7.5, { freshStart: true });
    console.log("RGB tip -> " + JSON.stringify({ gyrReached: rgb.gyrReached, phase: rgb.sun.phase, R_Rsun: rgb.sun.R_Rsun, plDestroyed: rgb.plDestroyed, glowColor: rgb.glowColor }));
    assert(Math.abs(rgb.gyrReached - 7.5) / 7.5 < 0.001, "should reach ~7.5 Gyr", rgb);
    assert(rgb.sun.R_Rsun > 150, "Sun should be a giant (>150 Rsun) at the RGB tip", rgb.sun);
    assert(rgb.plDestroyed[0] === 1, "Mercury (PL[0]) should be engulfed by the RGB tip", rgb.plDestroyed);
    assert(rgb.plDestroyed[1] === 1, "Venus (PL[1]) should be engulfed by the RGB tip", rgb.plDestroyed);
    assert(rgb.plDestroyed[2] === 0, "Mars (PL[2]) should NOT be engulfed (its orbit stays outside the giant's reach)", rgb.plDestroyed);
    assert(rgb.sunCoreScale > 100, "sunCore mesh scale should reflect the giant radius", rgb);
    assert(rgb.glowColor && rgb.glowColor[0] > rgb.glowColor[2] + 0.2, "Sun's rendered color should read red/orange-dominant at the RGB tip", rgb.glowColor);

    const rgbShot = await page.screenshot({ path: "/tmp/claude-1000/-home-latand-Projects-artemis-pilot/3464e715-d9dc-487c-a901-5c8f9bd38368/scratchpad/23b-sun-rgb-tip.png" });
    console.log("RGB tip screenshot bytes " + rgbShot.length);

    // --- White-dwarf epoch (~9 Gyr from now, continuing forward) ---
    const wd = await warpToEpochRetrying(page, 9, { freshStart: false });
    console.log("WD epoch -> " + JSON.stringify({ gyrReached: wd.gyrReached, phase: wd.sun.phase, R_Rsun: wd.sun.R_Rsun, mass: wd.sun.massLoss, earthDestroyed: wd.earthDestroyed, glowColor: wd.glowColor }));
    assert(Math.abs(wd.gyrReached - 9) / 9 < 0.001, "should reach ~9 Gyr", wd);
    assert(wd.sun.phase === "WD", "Sun should be a white dwarf by +9 Gyr", wd.sun);
    assert(wd.sun.R_Rsun < 0.02, "white-dwarf radius should be small (<0.02 Rsun)", wd.sun);
    assert(wd.sunCoreScale < 0.02, "sunCore mesh scale should have shrunk to the white-dwarf radius", wd);
    assert(wd.glowColor && wd.glowColor[2] >= wd.glowColor[0] - 0.05, "Sun's rendered color should read blue-white (not red) at the white-dwarf epoch", wd.glowColor);

    const wdShot = await page.screenshot({ path: "/tmp/claude-1000/-home-latand-Projects-artemis-pilot/3464e715-d9dc-487c-a901-5c8f9bd38368/scratchpad/23b-sun-wd.png" });
    console.log("WD epoch screenshot bytes " + wdShot.length);

    if (errors.length) throw new Error("console errors: " + JSON.stringify(errors.slice(0, 20)));

    console.log("\nsun evolution smoke passed\n");
} finally {
    await browser.close();
    await viteServer?.close();
}
