// Deep-time world-step smoke: the solar system through its own end.
//
// Before the shared world step, Earth's engulfment at the AGB tip (~7.65
// Gyr) closed the analytic gate and handed the n-body to 2000 forced
// leapfrog steps of ~2.6e11 s each: one max-warp frame later Mars sat at
// ~1e12 AU and frames cost 80-130 ms; a destroyed Sun flung every planet
// ~100x past any ballistic bound; a landed ship kept Earth alive through
// 9 Gyr (engulfment only ran in flight); black-hole scenes delivered ~1e-9
// of a max-warp request while silently claiming the frame.
//
// This drives worldStep.stepWorld -- the one per-frame step main.js calls
// for every mode -- at 1 Gyr/s (30 fps frames) and asserts:
//   A. 0 -> 100 Gyr in flight: Mercury, Venus, Earth and the Moon are
//      engulfed on time, Mars and the giants survive on bounded orbits,
//      nothing is NaN, every frame is fully delivered and cheap;
//   B. a destroyed Sun: survivors coast within their ballistic bound, the
//      Earth-Moon pair stays bound, frames stay cheap;
//   C. a ship landed on Earth at max warp is lost when Earth is engulfed
//      (the landed path runs the same Sun step), then the dead path keeps
//      the system bounded to 9 Gyr;
//   D. a black-hole scene subcycles within the frame budget, delivers
//      years per second instead of ~1e-9 of the request, reports the
//      shortfall (timeCtl delivery view), and the planner plans it at the
//      rung it can deliver;
//   E. main.js routes every mode through stepWorld.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
    if (cond) { pass++; console.log("  PASS  " + label + (detail ? "   " + detail : "")); }
    else { fail++; console.log("  FAIL  " + label + (detail ? "   " + detail : "")); }
};

installDomStub();
const constants = await import("../src/constants.js");
const state = await import("../src/state.js");
const ephem = await import("../src/ephemeris.js");
const physics = await import("../src/physics.js");
const blackholes = await import("../src/blackholes.js");
const world = await import("../src/worldStep.js");
const timeCtl = await import("../src/timeCtl.js");
const timeline = await import("../src/universe/eventTimeline.js");
const { AU_KM, PL, MU_S, MU_E, SEC_YEAR, WARP_MAX } = constants;
const { G, WORLD, GS, BH } = state;
const { eph } = ephem;
const GYR = 1e9 * SEC_YEAR;
const FRAME_DT = WARP_MAX / 30; // one 30 fps frame at 1 Gyr/s (~33 Myr)
const MARS = PL.findIndex(p => p.name === "MARS");

physics.initPhysicsHooks({
    die(reason) { if (!G.dead) { G.dead = true; G.deadReason = reason; } },
    award() { }, banner() { }, hideBanner() { },
});

function reset() {
    blackholes.clearBlackHoles?.();
    state.resetWorld(); ephem.resetEphem(); state.resetShip();
    GS.length = 0; BH.n = 0;
    G.dead = false; G.landed = null; G.paused = false; G.focus = "ship";
    G.darkEnergy = true; G.darkMatter = true; // app defaults
}
function parkShipHelio(au) {
    const sx = eph.sunX, sy = eph.sunY, d = Math.hypot(sx, sy), ux = -sx / d, uy = -sy / d;
    const r = au * AU_KM, v = Math.sqrt(MU_S / r);
    G.x = sx + ux * r; G.y = sy + uy * r; G.z = eph.sunZ;
    G.vx = eph.sunVx - uy * v; G.vy = eph.sunVy + ux * v; G.vz = eph.sunVz;
}
function finiteWorld() {
    const vals = [G.t, G.x, G.y, G.z, G.vx, G.vy, G.vz, eph.earthX, eph.earthY, eph.sunX, eph.sunY, eph.sunZ, eph.moonX, eph.moonY];
    for (let i = 0; i < PL.length; i++) vals.push(eph.plX[i], eph.plY[i], eph.plZ[i], eph.plVx[i]);
    return vals.every(Number.isFinite);
}
function planetSunAU(i) {
    return Math.hypot(eph.plX[i] - eph.sunX, eph.plY[i] - eph.sunY, eph.plZ[i] - eph.sunZ) / AU_KM;
}
function run(frames, dt, perFrame) {
    const costs = [];
    let requested = 0, delivered = 0, limitedFrames = 0;
    for (let f = 0; f < frames; f++) {
        const t0 = performance.now();
        const got = world.stepWorld(dt);
        costs.push(performance.now() - t0);
        requested += dt; delivered += got;
        if (world.WORLD_STEP.limited) limitedFrames++;
        if (perFrame && perFrame(f) === false) break;
    }
    costs.sort((a, b) => a - b);
    const mean = costs.reduce((a, b) => a + b, 0) / Math.max(1, costs.length);
    return { requested, delivered, limitedFrames, mean, p95: costs[Math.floor(costs.length * .95)] || 0, max: costs[costs.length - 1] || 0 };
}

console.log("\nA. flight, 0 -> 100 Gyr at 1 Gyr/s, ship parked at 20 AU");
{
    reset();
    parkShipHelio(20);
    G.warp = WARP_MAX;
    let engulfT = { mercury: NaN, venus: NaN, earth: NaN, moon: NaN };
    let minAU = Infinity, maxAU = 0, marsMin = Infinity, marsMax = 0, shipMin = Infinity, shipMax = 0, finite = true;
    const stats = run(3100, FRAME_DT, () => {
        if (WORLD.plDestroyed[0] && !Number.isFinite(engulfT.mercury)) engulfT.mercury = G.t / GYR;
        if (WORLD.plDestroyed[1] && !Number.isFinite(engulfT.venus)) engulfT.venus = G.t / GYR;
        if (WORLD.earthDestroyed && !Number.isFinite(engulfT.earth)) engulfT.earth = G.t / GYR;
        if (WORLD.moonDestroyed && !Number.isFinite(engulfT.moon)) engulfT.moon = G.t / GYR;
        if (!finiteWorld()) finite = false;
        if (WORLD.earthDestroyed) {
            for (let i = 0; i < PL.length; i++) {
                if (WORLD.plDestroyed[i]) continue;
                const d = planetSunAU(i);
                minAU = Math.min(minAU, d); maxAU = Math.max(maxAU, d);
            }
            const m = planetSunAU(MARS);
            marsMin = Math.min(marsMin, m); marsMax = Math.max(marsMax, m);
            const s = Math.hypot(G.x - eph.sunX, G.y - eph.sunY, G.z - eph.sunZ) / AU_KM;
            shipMin = Math.min(shipMin, s); shipMax = Math.max(shipMax, s);
        }
        return G.t < 100 * GYR && !G.dead;
    });
    ok(G.t >= 100 * GYR * (1 - 1e-9), "reached 100 Gyr", (G.t / GYR).toFixed(3) + " Gyr");
    ok(Math.abs(stats.delivered - stats.requested) <= 1e-9 * stats.requested && stats.limitedFrames === 0,
        "every frame delivered in full (analytic path, no shortfall)", "limited frames " + stats.limitedFrames);
    ok(engulfT.mercury > 7 && engulfT.mercury < 7.7 && engulfT.venus > 7 && engulfT.venus < 7.7,
        "Mercury and Venus engulfed on the giant branches", "Mercury " + engulfT.mercury.toFixed(2) + ", Venus " + engulfT.venus.toFixed(2) + " Gyr");
    ok(engulfT.earth > 7.6 && engulfT.earth < 7.75 && engulfT.moon === engulfT.earth,
        "Earth and the Moon (same 1 AU heliocentric orbit) engulfed together at the AGB tip", "Earth " + engulfT.earth.toFixed(3) + " Gyr, Moon " + engulfT.moon.toFixed(3));
    ok(!WORLD.plDestroyed[MARS] && !WORLD.sunDestroyed, "Mars and the Sun survive");
    ok(finite, "no NaN/Infinity anywhere in the ship, Sun, Moon or planet states");
    ok(marsMin > 1.3 && marsMax < 1.75, "Mars stays on its orbit after Earth is gone",
        "[" + marsMin.toFixed(3) + ", " + marsMax.toFixed(3) + "] AU (base: ~1e12 AU one frame after engulfment)");
    ok(minAU > 1.3 && maxAU < 31, "every survivor stays inside its orbital range to 100 Gyr",
        "[" + minAU.toFixed(3) + ", " + maxAU.toFixed(3) + "] AU");
    ok(shipMin > 5 && shipMax < 60, "the parked ship stays in the outer system", "[" + shipMin.toFixed(2) + ", " + shipMax.toFixed(2) + "] AU (base: thrown to 2.3e7 AU)");
    ok(stats.mean < 8 && stats.p95 < 25, "frames stay cheap through deep time",
        "mean " + stats.mean.toFixed(2) + " ms, p95 " + stats.p95.toFixed(2) + " ms, max " + stats.max.toFixed(1) + " ms (base: 70-80 ms mean after engulfment)");
}

console.log("\nB. destroyed Sun at t = 0, 1 Gyr/s for 60 frames (~2 Gyr)");
{
    reset();
    parkShipHelio(20);
    const d0 = [], v0 = [];
    for (let i = 0; i < PL.length; i++) {
        d0.push(Math.hypot(eph.plX[i], eph.plY[i], eph.plZ[i]));
        v0.push(Math.hypot(eph.plVx[i] + eph.earthVx, eph.plVy[i] + eph.earthVy, eph.plVz[i]));
    }
    const vEarth = Math.hypot(eph.earthVx, eph.earthVy);
    state.destroyBody("sun");
    G.warp = WARP_MAX;
    let finite = true, moonMin = Infinity, moonMax = 0;
    const t0 = G.t;
    const stats = run(60, FRAME_DT, () => {
        if (!finiteWorld()) finite = false;
        const m = Math.hypot(eph.moonX, eph.moonY, eph.moonZ);
        moonMin = Math.min(moonMin, m); moonMax = Math.max(moonMax, m);
    });
    const t = G.t - t0;
    let worst = 0;
    for (let i = 0; i < PL.length; i++) {
        // distance from Earth (the frame origin) vs a straight-line coast at the
        // two bodies' combined speeds: the analytic path must not exceed it
        const bound = d0[i] + (v0[i] + vEarth + 1) * t;
        worst = Math.max(worst, Math.hypot(eph.plX[i], eph.plY[i], eph.plZ[i]) / bound);
    }
    ok(finite, "no NaN/Infinity after the Sun is gone");
    ok(Math.abs(stats.delivered - stats.requested) <= 1e-9 * stats.requested, "every frame delivered in full");
    ok(worst <= 1, "planets coast within their ballistic bound", "worst distance / bound = " + worst.toFixed(3) + " (base: ~100x the bound)");
    ok(moonMin > 3.5e5 && moonMax < 4.1e5, "the Earth-Moon pair stays bound", "[" + Math.round(moonMin) + ", " + Math.round(moonMax) + "] km");
    ok(stats.mean < 10 && stats.p95 < 40, "frames stay cheap", "mean " + stats.mean.toFixed(2) + " ms, p95 " + stats.p95.toFixed(1) + " ms (base: up to 160 ms)");
}

console.log("\nC. landed on Earth at 1 Gyr/s through the AGB tip, then the dead path to 9 Gyr");
{
    reset();
    G.landed = { body: "earth", ang: 0, uz: 0, t0: 0 };
    physics.snapLanded();
    G.warp = WARP_MAX;
    let lostAt = NaN, finite = true, maxAU = 0;
    run(400, FRAME_DT, () => {
        if (G.landed) physics.snapLanded();
        if (G.dead && !Number.isFinite(lostAt)) lostAt = G.t / GYR;
        if (!finiteWorld()) finite = false;
        if (WORLD.earthDestroyed) for (let i = 0; i < PL.length; i++) if (!WORLD.plDestroyed[i]) maxAU = Math.max(maxAU, planetSunAU(i));
        return G.t < 9 * GYR;
    });
    ok(WORLD.earthDestroyed && !G.landed && G.dead && /Engulfed/.test(G.deadReason),
        "the landed ship is lost with Earth (the landed path runs the same Sun step)", (G.deadReason || "still landed") + " at " + lostAt.toFixed(3) + " Gyr");
    ok(lostAt > 7.6 && lostAt < 7.75, "engulfment happens at the AGB tip, not at lift-off", lostAt.toFixed(3) + " Gyr");
    ok(G.t >= 9 * GYR * (1 - 1e-9) && finite && maxAU < 31, "the dead path keeps the system bounded to 9 Gyr",
        "t " + (G.t / GYR).toFixed(2) + " Gyr, max planet " + maxAU.toFixed(2) + " AU");
}

console.log("\nD. black-hole scene: subcycled within the frame budget, shortfall reported");
{
    reset();
    parkShipHelio(20);
    const sx = eph.sunX, sy = eph.sunY, d = Math.hypot(sx, sy), ux = -sx / d, uy = -sy / d;
    // 0.34 Msun, 50 AU out, co-moving with the Sun, BEHIND the parked ship's
    // orbital motion. The holes ride the bodies' leapfrog with the frame's
    // indirect term, so this hole stays put (it free-falls ~3 AU over the
    // ~16 yr below); the separate hole RK4 it replaced lacked that term, and a
    // hole given the Sun's velocity drifted off at Earth's orbital speed. A
    // hole AHEAD of the ship is where ~14 yr of max-warp frames carry it (~57
    // deg of its 20 AU orbit): ~33 AU from the hole, whose pull there tops 12%
    // of the Sun's, bhBridgeWindow refuses the bridge and honest RK4 delivers
    // ~0.41 yr/s -- below the planner's rung, on mainline as well.
    blackholes.addBlackHole(sx + uy * 50 * AU_KM, sy - ux * 50 * AU_KM, 1, eph.sunVx, eph.sunVy, true);
    ok(BH.n === 1, "one hole placed");
    G.warp = WARP_MAX;
    let finite = true, maxAU = 0;
    const stats = run(30, FRAME_DT, () => {
        if (!finiteWorld()) finite = false;
        for (let i = 0; i < PL.length; i++) maxAU = Math.max(maxAU, planetSunAU(i));
    });
    const view = timeCtl.deliveryStatus();
    const yrPerS = stats.delivered / (30 / 30) / SEC_YEAR;
    ok(yrPerS > 5, "max warp with a hole delivers years per second, not ~1e-9 of the request",
        yrPerS.toFixed(2) + " yr/s (base: 0.41 yr/s)");
    ok(stats.limitedFrames === 30 && world.WORLD_STEP.reason.includes("black holes") && view.limited && view.ratio < .05 &&
        Math.abs(view.deliveredSec) < Math.abs(view.requestedSec) * 1e-6,
        "the shortfall is reported (world step + timeCtl delivery view)",
        world.WORLD_STEP.reason + ", last frame " + (view.deliveredSec / view.requestedSec).toExponential(2) + " delivered, smoothed ratio " + view.ratio.toExponential(2));
    ok(world.WORLD_STEP.bodySteps <= ephem.EPHEM_FRAME_STEP_BUDGET, "the bodies stay inside the frame's step budget",
        world.WORLD_STEP.bodySteps + " / " + ephem.EPHEM_FRAME_STEP_BUDGET);
    ok(finite && maxAU < 32, "planets stay bound in the hole scene", "max " + maxAU.toFixed(2) + " AU");
    // the step budget above is the deterministic bound; this wall-clock check
    // only catches pathological regressions (it runs alongside browser smokes)
    ok(stats.mean < 100, "black-hole frames stay within budget cost", "mean " + stats.mean.toFixed(1) + " ms, max " + stats.max.toFixed(1) + " ms");
    const feas = timeCtl.maxFeasibleWarp();
    ok(feas === timeline.BH_FEASIBLE_WARP, "the warp planner counts the hole", "feasible " + feas / SEC_YEAR + " yr/s");
    G.warp = feas;
    const planned = run(30, feas / 30);
    ok(planned.limitedFrames === 0 && Math.abs(planned.delivered - planned.requested) <= 1e-9 * planned.requested,
        "the planner's black-hole rung is delivered in full", (planned.delivered / SEC_YEAR).toFixed(3) + " yr in 1 s");
    ok(!timeCtl.deliveryStatus().limited || timeCtl.deliveryStatus().latch > 0, "the delivery view relaxes once warp is deliverable");
}

console.log("\nF. relativistic cruise after Earth's engulfment rides the same world step");
{
    reset();
    parkShipHelio(20);
    G.warp = WARP_MAX;
    run(240, FRAME_DT, () => G.t < 8 * GYR); // past the AGB tip, Earth gone
    const rel = await import("../src/relTravel.js");
    G.focus = "star:0";
    rel.relTravelToFocus(() => { });
    ok(rel.REL.active && WORLD.earthDestroyed, "a cruise to Proxima starts after Earth is gone");
    G.warp = 30 * SEC_YEAR;
    const t0 = G.t, e0 = rel.REL.coordElapsed;
    let finite = true, maxAU = 0, clockOk = true;
    const stats = run(12, G.warp / 30, () => {
        if (!finiteWorld()) finite = false;
        if (state.EPHT.t !== G.t) clockOk = false;
        for (let i = 0; i < PL.length; i++) if (!WORLD.plDestroyed[i]) maxAU = Math.max(maxAU, planetSunAU(i));
        return rel.REL.active;
    });
    const covered = rel.REL.active ? rel.REL.coordElapsed - e0 : stats.delivered;
    ok(Math.abs((G.t - t0) - stats.delivered) <= 1e-6 * stats.delivered && Math.abs(covered - stats.delivered) <= 1e-6 * stats.delivered,
        "clock, cruise and world advance by the same delivered time", (stats.delivered / SEC_YEAR).toFixed(3) + " yr");
    ok(finite && clockOk && maxAU < 31, "bodies stay bounded and EPHT.t === G.t under the cruise", "max planet " + maxAU.toFixed(2) + " AU");
}

console.log("\nG. regime from the warp (hysteresis), secular drift keeps the Moon continuous");
{
    const YEARS = 4;
    const wrapDeg = d => ((d + 540) % 360) - 180;
    function lunarNode() {
        const x = eph.moonX, y = eph.moonY, z = eph.moonZ, vx = eph.moonVx, vy = eph.moonVy, vz = eph.moonVz;
        return Math.atan2(y * vz - z * vy, -(z * vx - x * vz));
    }
    function nodeDrift(warpYr, fps) {
        reset();
        parkShipHelio(20);
        G.warp = warpYr * SEC_YEAR;
        const dt = G.warp / fps;
        let t = 0, acc = 0, prev = lunarNode();
        while (t < YEARS * SEC_YEAR - 1) {
            t += world.stepWorld(Math.min(dt, YEARS * SEC_YEAR - t));
            const n = lunarNode();
            acc += wrapDeg((n - prev) * 180 / Math.PI);
            prev = n;
        }
        return { deg: acc, regime: ephem.ephemRegime() };
    }
    const expected = -19.3414 * YEARS; // observed 18.6 yr regression
    const at60 = nodeDrift(1, 60), at58 = nodeDrift(1, 58), at30 = nodeDrift(1, 30);
    ok(at60.regime === "integrated" && at58.regime === "integrated" && at30.regime === "integrated",
        "1 yr/s is integrated at 60, 58 and 30 fps (the regime no longer depends on frame rate)");
    ok(Math.abs(at60.deg - at58.deg) < .5 && Math.abs(at60.deg - at30.deg) < .5,
        "the lunar node regresses the same at every frame rate",
        at60.deg.toFixed(2) + " / " + at58.deg.toFixed(2) + " / " + at30.deg.toFixed(2) + " deg (base: " + "-39 deg at 60 fps, 0 at 58 fps over 2 yr)");
    const fast = nodeDrift(4, 60), faster = nodeDrift(1000, 60);
    ok(fast.regime === "analytic" && faster.regime === "analytic", "4 yr/s and faster ride the analytic conics");
    ok([at60, fast, faster].every(r => Math.abs(r.deg - expected) < .06 * Math.abs(expected)) && Math.abs(at60.deg - fast.deg) < 5,
        "node regression is continuous across the threshold (integrated vs analytic + secular)",
        at60.deg.toFixed(2) + " vs " + fast.deg.toFixed(2) + " vs " + faster.deg.toFixed(2) + " deg over " + YEARS + " yr, observed " + expected.toFixed(2));
    // hysteresis: 2 yr/s keeps whichever regime it came from
    ephem.beginEphemFrame(1 * SEC_YEAR); ephem.advanceEphem(SEC_YEAR / 60); ephem.endEphemFrame();
    ephem.beginEphemFrame(2 * SEC_YEAR); ephem.advanceEphem(2 * SEC_YEAR / 60); const upTo2 = ephem.ephemRegime(); ephem.endEphemFrame();
    ephem.beginEphemFrame(4 * SEC_YEAR); ephem.advanceEphem(4 * SEC_YEAR / 60); ephem.endEphemFrame();
    ephem.beginEphemFrame(2 * SEC_YEAR); ephem.advanceEphem(2 * SEC_YEAR / 60); const downTo2 = ephem.ephemRegime(); ephem.endEphemFrame();
    ok(upTo2 === "integrated" && downTo2 === "analytic", "2 yr/s sits in the hysteresis band (no flapping)", "up: " + upTo2 + ", down: " + downTo2);
}

console.log("\nH. reverse time rides the analytic bridges above the irreversible floor");
{
    reset();
    parkShipHelio(20);
    const snap = () => [eph.sunX, eph.sunY, eph.moonX, eph.moonY, ...eph.plX, ...eph.plY, G.x, G.y];
    const before = snap(), t0 = G.t;
    G.warp = 30 * SEC_YEAR;
    run(30, G.warp / 30);
    G.warp = -30 * SEC_YEAR;
    const back = run(30, G.warp / 30);
    const after = snap();
    let worst = 0;
    for (let i = 0; i < before.length; i++) worst = Math.max(worst, Math.abs(after[i] - before[i]) / Math.max(AU_KM * 1e-3, Math.abs(before[i])));
    ok(Math.abs(back.delivered - back.requested) <= 1e-9 * Math.abs(back.requested) && Math.abs(G.t - t0) < 1,
        "-30 yr/s is delivered in full and returns the clock", (back.delivered / SEC_YEAR).toFixed(2) + " yr");
    ok(worst < 1e-6, "a forward/backward pair retraces bodies and ship (secular terms included)", "worst relative error " + worst.toExponential(2));
    G.warp = -WARP_MAX;
    const rev = run(15, -FRAME_DT);
    ok(Math.abs(rev.delivered - rev.requested) <= 1e-9 * Math.abs(rev.requested) && !WORLD.reverseBlocked,
        "-1 Gyr/s with nothing irreversible is delivered in full", (rev.delivered / GYR).toFixed(3) + " Gyr in 0.5 s (base: ~0.4 yr/s)");
    // past an engulfment the floor holds
    reset();
    parkShipHelio(20);
    G.warp = WARP_MAX;
    run(300, FRAME_DT, () => G.t < 9 * GYR);
    const floor = WORLD.irreversibleFloorT;
    G.warp = -WARP_MAX;
    let finite = true;
    run(90, -FRAME_DT, () => { if (!finiteWorld()) finite = false; });
    ok(Number.isFinite(floor) && Math.abs(G.t - floor) < 1 && WORLD.reverseBlocked && WORLD.earthDestroyed && finite,
        "reverse stops at the engulfment floor and nothing un-happens",
        "floor " + (floor / GYR).toFixed(3) + " Gyr, now " + (G.t / GYR).toFixed(3) + " Gyr");
}

console.log("\nE. main.js routes every mode through the world step");
{
    const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const frame = main.slice(main.indexOf("function frame()"), main.indexOf("const jumpSettlement"));
    ok(/stepWorld\(frameSimAdvance, atx, aty, atz, aMag, toast\)/.test(frame), "frame() advances time only through stepWorld");
    ok(!/advanceEphem\(|bhAdvance\(|relTravelStep\(|G\.t \+=/.test(frame), "no mode advances bodies or the clock on its own");
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
console.log("deep-time smoke passed");
process.exit(0);

function installDomStub() {
    globalThis.window = globalThis;
    globalThis.addEventListener ??= () => { };
    globalThis.removeEventListener ??= () => { };
    globalThis.matchMedia ??= () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
    globalThis.ResizeObserver ??= class { observe() { } unobserve() { } disconnect() { } };
    globalThis.location = { search: "" };
    globalThis.requestAnimationFrame ??= () => 0;
    globalThis.cancelAnimationFrame ??= () => { };
    const element = () => ({
        style: {}, dataset: {},
        classList: { add() { }, remove() { }, toggle() { }, contains() { return false; } },
        appendChild() { }, removeChild() { }, append() { }, remove() { },
        addEventListener() { }, removeEventListener() { },
        setAttribute() { }, getAttribute() { return null; },
        querySelector() { return null; }, querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 1, height: 1 }; },
    });
    const canvas2d = () => new Proxy({ canvas: { width: 1, height: 1 } }, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (prop === "createImageData") return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
            if (prop === "createRadialGradient" || prop === "createLinearGradient") return () => ({ addColorStop() { } });
            if (prop === "measureText") return text => ({ width: String(text).length * 8 });
            return () => { };
        },
        set() { return true; },
    });
    const webgl = () => {
        const constants = {
            VERSION: 0x1f02, SHADING_LANGUAGE_VERSION: 0x8b8c, VENDOR: 0x1f00, RENDERER: 0x1f01,
            ALIASED_LINE_WIDTH_RANGE: 0x846e, ALIASED_POINT_SIZE_RANGE: 0x846d,
        };
        const getParameter = p => p === constants.VERSION ? "WebGL 2.0" :
            p === constants.SHADING_LANGUAGE_VERSION ? "WebGL GLSL ES 3.00" :
                p === constants.VENDOR || p === constants.RENDERER ? "stub" :
                    p === constants.ALIASED_LINE_WIDTH_RANGE || p === constants.ALIASED_POINT_SIZE_RANGE ? new Float32Array([1, 1]) : 16;
        return new Proxy({
            canvas: { width: 1, height: 1 },
            getExtension() { return null; },
            getParameter,
            getShaderPrecisionFormat() { return { precision: 23, rangeMin: 127, rangeMax: 127 }; },
        }, {
            get(target, prop) {
                if (prop in target) return target[prop];
                if (prop in constants) return constants[prop];
                if (prop === "drawingBufferWidth" || prop === "drawingBufferHeight") return 1;
                if (typeof prop === "string" && /^[A-Z0-9_]+$/.test(prop)) return 0;
                return () => { };
            },
        });
    };
    const canvas = () => ({ ...element(), width: 1, height: 1, getContext(type) { return type === "2d" ? canvas2d() : webgl(); } });
    globalThis.document = {
        body: element(), documentElement: element(),
        createElement(tag) { return tag === "canvas" ? canvas() : element(); },
        createElementNS(_ns, tag) { return tag === "canvas" ? canvas() : element(); },
        getElementById() { return element(); },
        querySelector() { return null; }, querySelectorAll() { return []; },
        addEventListener() { }, removeEventListener() { },
    };
}
