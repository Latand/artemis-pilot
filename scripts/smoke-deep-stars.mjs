// Deep-time star neighbourhood smoke: the stars around the ship at 1 Myr and
// 1 Gyr.
//
// Before: the flight path refreshed the active stars at t = 0 forever (only
// the landed/dead paths passed the clock); catalog stars were converted with
// the moving Sun anchor and then rotated by their own orbits, counting the
// Galactic rotation twice (the 20 pc neighbourhood sat ~230 pc away after
// 1 Myr, 12-18 kpc after 100 Myr); procedural neighbours were looked up in
// the birth cells around the ship and then carried a full orbital phase away
// (0 within 8 pc after 0.1 Myr, the nearest 134 pc away at 1 Myr and 12 kpc
// at 1 Gyr); cells cached Sun-relative km baked with whatever anchor was
// current when first generated; and Sgr A* stayed at its epoch point while the
// drawn galactic centre moved (247 pc off at 1 Myr, 16 kpc at 100 Myr).
//
// Checks:
//   A. catalog stars drift physically (epoch-anchored state, own orbit, Sun
//      of the same instant), independent of the per-frame anchor;
//   B. neighbours within 8 pc at 1 Myr and 1 Gyr at a realistic density;
//   C. procedural ids are stable, motion is continuous, thinned candidates
//      return once the catalog has dispersed, cells cache galactocentric only;
//   D. Sgr A* rides the drawn galactic centre;
//   E. every refresh path passes the real clock (flight step included);
//   F. a ship bound to a moving star rides along; a flyby does not;
//   G. a decorrelating frame (Gyr/s) refreshes cheaply.
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
const world = await import("../src/worldStep.js");
const coords = await import("../src/universe/coords.js");
const galaxy = await import("../src/universe/galaxy.js");
const hyg = await import("../src/universe/hygActiveCatalog.js");
const active = await import("../src/universe/activeStars.js");
const galClock = await import("../src/universe/galacticClock.js");
const { AU_KM, SEC_YEAR, STARS, MU_S } = constants;
const { G } = state;
const { eph } = ephem;
const { PC_KM, SUN_GAL } = coords;
const KYR = 1e3 * SEC_YEAR, MYR = 1e6 * SEC_YEAR, GYR = 1e9 * SEC_YEAR;
const pc = km => km / PC_KM;

const sgr = STARS.find(s => s.name === "SGR A*");
const SGR_EPOCH = [sgr.x, sgr.y, sgr.z];

const meta = JSON.parse(readFileSync(new URL("../public/data/hyg-stars-v41.json", import.meta.url), "utf8"));
const bin = readFileSync(new URL("../public/data/hyg-stars-v41.bin", import.meta.url));
hyg.registerHygCatalog(meta, new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4));
galaxy.setSeed(0x9e3779b9 >>> 0);
physics.initPhysicsHooks({
    die(reason) { if (!G.dead) { G.dead = true; G.deadReason = reason; } },
    award() { }, banner() { }, hideBanner() { },
});

function neighbours(t, wx = 0, wy = 0, wz = 0, radiusPc = 8) {
    galClock.syncGalacticFrame(t);
    active.refreshActiveStars(wx, wy, wz, "ship", t);
    const list = [];
    for (const s of active.ACTIVE_STARS) {
        if (s.bh || !(s.procedural || s.activeCatalog)) continue;
        const d = pc(Math.hypot(s.x - wx, s.y - wy, (s.z || 0) - wz));
        if (d <= radiusPc) list.push({ s, d });
    }
    list.sort((a, b) => a.d - b.d);
    return list;
}

console.log("\nA. catalog stars drift physically");
{
    const near = hyg.sampleHygStarsNear(0, 0, 0, 20, 640, 0);
    let exact0 = near.length > 0, maxSpeed = 0, worstCurv = 0, anchorFree = true;
    const mean = [0, 0, 0];
    for (const s of near) {
        const a0 = hyg.hygStarById(s.id, 0), a1 = hyg.hygStarById(s.id, KYR), a2 = hyg.hygStarById(s.id, MYR);
        exact0 &&= a0.x === s.x && a0.y === s.y && a0.z === s.z;
        const v = [(a1.x - a0.x) / KYR, (a1.y - a0.y) / KYR, (a1.z - a0.z) / KYR];
        const disp = [a2.x - a0.x, a2.y - a0.y, a2.z - a0.z];
        maxSpeed = Math.max(maxSpeed, Math.hypot(...v));
        const pred = Math.hypot(v[0] * MYR, v[1] * MYR, v[2] * MYR);
        const curv = Math.hypot(disp[0] - v[0] * MYR, disp[1] - v[1] * MYR, disp[2] - v[2] * MYR) / Math.max(pred, PC_KM);
        worstCurv = Math.max(worstCurv, curv);
        for (let i = 0; i < 3; i++) mean[i] += disp[i] / near.length;
    }
    // the per-frame anchor must not leak into catalog positions
    const probe = near.slice(0, 20).map(s => hyg.hygStarById(s.id, MYR));
    coords.setSunGalAnchor(4000, 3000, -200);
    near.slice(0, 20).forEach((s, i) => { const b = hyg.hygStarById(s.id, MYR); anchorFree &&= b.x === probe[i].x && b.y === probe[i].y && b.z === probe[i].z; });
    galClock.syncGalacticFrame(0);
    ok(exact0, "t = 0 is exactly the catalog position", near.length + " stars within 20 pc");
    ok(maxSpeed < 200, "relative speeds are stellar", "fastest " + maxSpeed.toFixed(1) + " km/s");
    ok(pc(Math.hypot(...mean)) < 50, "no common drift: over 1 Myr the neighbourhood only shows the Sun's own peculiar motion",
        "mean displacement " + pc(Math.hypot(...mean)).toFixed(1) + " pc (base: ~230 pc, every star)");
    ok(worstCurv < .1, "the 1 Myr displacement is the 1 kyr velocity carried on (epicycle curvature < 10%)", "worst " + (100 * worstCurv).toFixed(2) + "%");
    ok(anchorFree, "positions use the Sun of the same instant, not the per-frame anchor");
}

console.log("\nB. neighbours within 8 pc at 1 Myr and 1 Gyr");
{
    const vol = 4 / 3 * Math.PI * 8 ** 3;
    const counts = {};
    for (const [label, t] of [["t=0", 0], ["1 Myr", MYR], ["1 Gyr", GYR]]) {
        const n = neighbours(t);
        counts[label] = n;
        ok(n.length >= 100 && n[0].d < 3, label + ": neighbours within 8 pc",
            n.length + " stars (" + n.filter(x => x.s.activeCatalog).length + " catalog), nearest " + n[0]?.d.toFixed(2) + " pc" +
            (t ? " (base: 0; nearest " + (t === MYR ? "134 pc" : "12 kpc") + ")" : ""));
    }
    const dens = counts["1 Gyr"].length / vol;
    ok(dens > .06 && dens < .2, "the 1 Gyr neighbourhood has the model's local density", dens.toFixed(3) + " /pc^3");
    ok(counts["1 Gyr"].every(x => x.s.procedural), "the catalog has dispersed by 1 Gyr; the procedural tier fills the neighbourhood");
    const away = neighbours(GYR, 30 * PC_KM, -12 * PC_KM, 4 * PC_KM);
    ok(away.length >= 100, "a ship 30 pc from the Sun at 1 Gyr has neighbours too", away.length + " within 8 pc");
}

console.log("\nC. identity, continuity, completeness, galactocentric cache");
{
    const ids = neighbours(GYR).slice(0, 60).map(x => x.s.id).join("|");
    galaxy.clearCache();
    const ids2 = neighbours(GYR).slice(0, 60).map(x => x.s.id).join("|");
    ok(ids === ids2 && ids.length > 0, "the 1 Gyr neighbourhood regenerates with the same ids");
    const first = neighbours(GYR)[0].s;
    const rec = galaxy.localStarById(first.id);
    const again = active.proceduralStarById(first.id, GYR);
    ok(rec && again && again.x === first.x && again.y === first.y && again.z === first.z,
        "a neighbour's id resolves to the same star at the same place", first.id);
    // continuous motion across many re-evaluation buckets (and box reflections)
    const tq0 = active.activeStarEvalTime(GYR), dt = active.activeStarEvalTime(GYR + 30 * SEC_YEAR) - tq0;
    let maxStep = 0, prev = null, turns = 0, prevV = null;
    for (let k = 0; k < 25000; k++) {
        const s = active.proceduralStarById(first.id, tq0 + k * dt);
        const p = [s.x, s.y, s.z];
        if (prev) {
            const v = [p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]];
            maxStep = Math.max(maxStep, pc(Math.hypot(...v)));
            if (prevV && v[0] * prevV[0] + v[1] * prevV[1] + v[2] * prevV[2] < 0) turns++;
            prevV = v;
        }
        prev = p;
    }
    ok(maxStep < .01, "a star never jumps between re-evaluations (reflection is continuous)",
        "largest step " + (maxStep * 206265).toFixed(0) + " AU per " + (dt / SEC_YEAR).toFixed(1) + " yr over " + (25000 * dt / KYR).toFixed(0) + " kyr");
    // thinned candidates: absent at t = 0, back once the catalog has dispersed
    const back = neighbours(GYR).map(x => galaxy.localStarById(x.s.id)).filter(r => r && r.thinU !== undefined);
    const epochIds = new Set();
    for (const r of back.slice(0, 10)) {
        const cell = galaxy.localStarsInCell(Math.floor(r.gx / galaxy.LOCAL_CELL_PC), Math.floor(r.gy / galaxy.LOCAL_CELL_PC), Math.floor(r.gz / galaxy.LOCAL_CELL_PC));
        for (const st of cell) epochIds.add(st.id);
    }
    ok(back.length > 0 && back.slice(0, 10).every(r => !epochIds.has(r.id)),
        "catalog-thinned candidates return in deep time and stay out of the t = 0 tier", back.length + " resurrected neighbours at 1 Gyr");
    ok(galaxy.catalogRetentionAt("M", 0) === 1 && galaxy.catalogRetentionAt("G", MYR) > galaxy.catalogRetentionAt("G", 5 * MYR) &&
        galaxy.catalogRetentionAt("M", GYR) === 0, "catalog coverage fades monotonically from 1 at t = 0 to 0");
    // records cache galactocentric positions only; x/y/z convert on use
    galaxy.clearCache();
    coords.setSunGalAnchor(7000, 900, 40);
    const cell = galaxy.localStarsInCell(2044, 0, 5);
    galClock.syncGalacticFrame(0);
    const r0 = cell.find(s => s.companion) || cell[0];
    const w = coords.galToWorldKm(r0.gx, r0.gy, r0.gz);
    ok(r0.x === w[0] && r0.y === w[1] && r0.z === w[2] && Object.keys(r0).every(k => k !== "x" && k !== "y" && k !== "z"),
        "a cell generated under another anchor carries no stale Sun-relative km");
}

console.log("\nD. Sgr A* rides the drawn galactic centre");
{
    galClock.syncGalacticFrame(0);
    ok(sgr.x === SGR_EPOCH[0] && sgr.y === SGR_EPOCH[1] && sgr.z === SGR_EPOCH[2], "unchanged at t = 0");
    const gc0 = coords.galToWorldKm(0, 0, 0);
    const off0 = [sgr.x - gc0[0], sgr.y - gc0[1], sgr.z - gc0[2]];
    let worst = 0;
    for (const t of [MYR, GYR, 100 * GYR]) {
        galClock.syncGalacticFrame(t);
        const gc = coords.galToWorldKm(0, 0, 0);
        worst = Math.max(worst, Math.hypot(sgr.x - gc[0] - off0[0], sgr.y - gc[1] - off0[1], sgr.z - gc[2] - off0[2]));
    }
    galClock.syncGalacticFrame(0);
    ok(pc(worst) < 1e-6, "its offset from the drawn centre is the same at 1 Myr, 1 Gyr and 100 Gyr",
        "offset " + pc(Math.hypot(...off0)).toFixed(1) + " pc, drift " + (worst / AU_KM).toFixed(4) + " AU (base: 247 pc at 1 Myr, 16 kpc at 100 Myr)");
}

console.log("\nE. every refresh path passes the real clock");
{
    reset();
    parkShipHelio(20);
    state.setSimTime(MYR);
    state.syncEphemClock();
    G.warp = 3600 * 60;
    world.stepWorld(3600);
    const proc = active.ACTIVE_STARS.filter(s => s.procedural && !s.companionOf); // companions ride their primary
    const tq = active.activeStarEvalTime(G.t);
    ok(tq > 0 && proc.length > 50 && proc.every(s => s._posSimT === tq),
        "the flight step evaluates the neighbourhood at the clock (base: at t = 0 forever)", proc.length + " procedural at t = " + (tq / MYR).toFixed(4) + " Myr");
    const src = f => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
    const calls = [];
    for (const f of ["main.js", "physics.js", "catalogSearch.js", "worldStep.js", "universe/activeStars.js"]) {
        for (const m of src(f).matchAll(/refreshActiveStars\(([^;]*?)\);/g)) calls.push({ f, args: m[1] });
    }
    const untimed = calls.filter(c => !(c.f === "universe/activeStars.js" && c.args === "0, 0, 0") && c.args.split(",").length < 5);
    ok(calls.length >= 3 && untimed.length === 0, "no runtime refresh evaluates the stars at the epoch",
        calls.length + " call sites" + (untimed.length ? "; untimed: " + untimed.map(c => c.f).join(", ") : ""));
    ok(/refreshActiveStars\([^;]*G\.t, advanced\)/.test(src("main.js")) && /refreshActiveStars\([^;]*activeStarsTime\(\)\)/.test(src("catalogSearch.js")),
        "main.js passes the clock and the frame's advance; the catalog browser uses the layer's time");
}

console.log("\nF. a ship bound to a moving star rides along");
{
    reset();
    const DT = active.ACTIVE_STAR_EVAL_DT_S; // one re-evaluation bucket (~19.6 yr)
    state.setSimTime(51022.5 * DT);           // mid-bucket near 1 Myr
    state.syncEphemClock();
    const host = neighbours(G.t).filter(x => x.s.procedural && x.s.mass > .2)[0].s;
    const hostNow = () => active.ACTIVE_STARS.find(s => s.id === host.id);
    const orbitR = AU_KM, vc = Math.sqrt(host.mu / orbitR);
    const place = vRel => {
        const h = hostNow() || host;
        G.x = h.x - eph.earthX + orbitR; G.y = h.y - eph.earthY; G.z = h.z || 0;
        G.vx = -eph.earthVx; G.vy = -eph.earthVy + vRel; G.vz = -(eph.earthVz || 0);
        G.focus = "ship"; G.dead = false; G.landed = null;
        physics.advance(1, 0, 0, 0, 0); // a flight step records what the ship is bound to
    };
    const shipHostAU = () => {
        const h = hostNow();
        return h ? Math.hypot(eph.earthX + G.x - h.x, eph.earthY + G.y - h.y, G.z - (h.z || 0)) / AU_KM : NaN;
    };
    // the next bucket moves the host; the next sync carries the ship
    place(vc);
    const before = shipHostAU(), h0 = { ...hostNow() };
    state.setSimTime(G.t + DT);
    state.syncEphemClock();
    const carried = physics.followMovingStars(true, 0);
    const h1 = hostNow();
    const hostJumpAU = Math.hypot(h1.x - h0.x, h1.y - h0.y, h1.z - h0.z) / AU_KM;
    ok(hostJumpAU > 5 && Math.abs(carried / AU_KM - hostJumpAU) < 1e-6 && Math.abs(shipHostAU() - before) < 1e-6,
        "a bucket re-evaluation carries the bound ship with its host",
        "host moved " + hostJumpAU.toFixed(1) + " AU, ship-host " + before.toFixed(6) + " -> " + shipHostAU().toFixed(6) + " AU");
    // a fast flyby is not bound: no carry
    place(vc * 4);
    state.setSimTime(G.t + DT);
    state.syncEphemClock();
    ok(physics.followMovingStars(true, 0) === 0, "an unbound flyby is not dragged along");
    // integrated: 1 yr frames through bucket boundaries keep the orbit
    place(vc);
    G.warp = SEC_YEAR * 60;
    let minR = Infinity, maxR = 0;
    for (let f = 0; f < 45; f++) {
        world.stepWorld(SEC_YEAR);
        const r = shipHostAU();
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    }
    ok(!G.dead && minR > .9 && maxR < 1.1, "45 years of 1 yr frames across two re-evaluations keep a 1 AU orbit",
        "ship-host [" + minR.toFixed(4) + ", " + maxR.toFixed(4) + "] AU");
    // Sgr A* moves every frame: a ship bound to it rides the per-frame sync
    reset();
    state.setSimTime(0);
    galClock.syncGalacticFrame(0);
    const R = 200 * sgr.rs, v = Math.sqrt(sgr.mu / R);
    active.refreshActiveStars(sgr.x + R, sgr.y, sgr.z, "ship", 0);
    G.x = sgr.x - eph.earthX + R; G.y = sgr.y - eph.earthY; G.z = sgr.z;
    G.vx = -eph.earthVx; G.vy = -eph.earthVy + v; G.vz = -(eph.earthVz || 0);
    physics.advance(1, 0, 0, 0, 0);
    const rel0 = [eph.earthX + G.x - sgr.x, eph.earthY + G.y - sgr.y, G.z - sgr.z];
    state.setSimTime(G.t + 10 * SEC_YEAR);
    state.syncEphemClock();
    physics.followMovingStars(false);
    const rel1 = [eph.earthX + G.x - sgr.x, eph.earthY + G.y - sgr.y, G.z - sgr.z];
    ok(Math.hypot(rel1[0] - rel0[0], rel1[1] - rel0[1], rel1[2] - rel0[2]) < 1,
        "a ship orbiting Sgr A* rides the galactic-centre sync",
        "Sgr A* moved " + (Math.hypot(sgr.x - SGR_EPOCH[0], sgr.y - SGR_EPOCH[1], sgr.z - SGR_EPOCH[2]) / AU_KM).toFixed(0) + " AU in 10 yr");
    galClock.syncGalacticFrame(0);
}

console.log("\nG. decorrelating frames refresh cheaply");
{
    const frame = GYR / 60;
    const costs = [];
    let t = 0, near = 0;
    for (let f = 0; f < 90; f++) {
        t += frame;
        galClock.syncGalacticFrame(t);
        const t0 = performance.now();
        active.refreshActiveStars(0, 0, 0, "ship", t, frame);
        costs.push(performance.now() - t0);
        near += active.ACTIVE_STARS.filter(s => s.procedural).length;
    }
    const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
    ok(mean < 10, "a 1 Gyr/s frame re-samples only the nearest stars", "mean " + mean.toFixed(2) + " ms, " + (near / 90).toFixed(1) + " procedural within 2 pc (a full 8 pc re-sample costs ~8-20 ms cold)");
    galClock.syncGalacticFrame(0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("deep-stars smoke passed");

function reset() {
    state.resetWorld(); ephem.resetEphem(); state.resetShip();
    G.dead = false; G.landed = null; G.paused = false; G.focus = "ship";
    G.darkEnergy = true; G.darkMatter = true;
}
function parkShipHelio(au) {
    const sx = eph.sunX, sy = eph.sunY, d = Math.hypot(sx, sy), ux = -sx / d, uy = -sy / d;
    const r = au * AU_KM, v = Math.sqrt(MU_S / r);
    G.x = sx + ux * r; G.y = sy + uy * r; G.z = eph.sunZ;
    G.vx = eph.sunVx - uy * v; G.vy = eph.sunVy + ux * v; G.vz = eph.sunVz;
}

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
    globalThis.navigator ??= { userAgent: "node", xr: undefined };
    globalThis.localStorage ??= { getItem() { return null; }, setItem() { }, removeItem() { } };
    globalThis.performance ??= { now: () => Date.now() };
}
