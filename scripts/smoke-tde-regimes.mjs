// Tidal-encounter regimes and warp invariance (headless).
//
// Builds real encounters in the live n-body (ephemeris leapfrog + holes) — a
// body on a chosen conic about a freshly placed hole — advances them the way
// the game does (physics.advanceWorld frames of warp·dt), and checks the
// regime the pipeline booked, the mass bookkeeping, and that the outcome does
// not depend on warp or frame rate.
//
//   node scripts/smoke-tde-regimes.mjs [--quick]
installStub();
const QUICK = process.argv.includes("--quick");

const constants = await import("../src/constants.js");
const state = await import("../src/state.js");
const ephem = await import("../src/ephemeris.js");
const enc = await import("../src/bhEncounters.js");
const physics = await import("../src/physics.js");
const tde = await import("../src/tde.js");
const debris = await import("../src/tdeDebris.js");
const kepler = await import("../src/universe/keplerTools.js");

const { MU_S, MU_E, R_SUN, R_EARTH, C_LIGHT, PL } = constants;
const { G, BH, WORLD, EPHT, GS, resetWorld, resetShip } = state;
const { resetEphem, updEphem, IDX_SUN } = ephem;
const { ENC, TDES, CAPTURES } = enc;
const G_KM = 6.674e-20;

let failures = 0;
function check(ok, msg, extra) {
    if (ok) console.log("  PASS " + msg);
    else { failures++; console.log("  FAIL " + msg + (extra !== undefined ? " " + JSON.stringify(extra) : "")); }
}
const relErr = (a, b) => Math.abs(a - b) / Math.max(1e-300, Math.abs(b));
const rsOf = msun => 2 * MU_S * msun / (C_LIGHT * C_LIGHT);
const JUPITER = PL.findIndex(p => p.name === "JUPITER");

const log = [];
enc.initEncounterHooks({
    toast(m) { log.push({ kind: "toast", t: EPHT.t, text: m }); },
    event(k, m) { log.push({ kind: k, t: EPHT.t, text: m }); },
    disrupt(target, rs, why) { log.push({ kind: "disrupt", t: EPHT.t, target, text: why }); state.destroyBody(target); return String(target); },
    cataclysm(target, rs, why) { log.push({ kind: "captured", t: EPHT.t, target, text: why }); state.destroyBody(target); },
});

function resetAll() {
    while (BH.n) enc.removeHoleData(BH.n - 1);
    ENC.length = 0; TDES.length = 0; CAPTURES.length = 0;
    resetWorld();
    resetEphem();
    resetShip();
    GS.length = 0;
    state.setSimTime(0); // both clocks (sim and ephemeris), residues cleared
    G.dead = true; // world-only advance: the ship stays out of the encounter
    G.darkEnergy = false; G.darkMatter = false;
    log.length = 0;
    updEphem();
}
function bodyMu(target) { return target === "sun" ? MU_S : target === "earth" ? MU_E : PL[target].mu; }
function bodyR(target) { return target === "sun" ? R_SUN : target === "earth" ? R_EARTH : PL[target].R; }
function tidalR(target, msun) { return bodyR(target) * Math.cbrt(rsOf(msun) * C_LIGHT * C_LIGHT / 2 / bodyMu(target)); }

// Place a hole so that `target` is on a conic of Newtonian pericentre rp about
// it, eccentricity e, currently inbound at distance d0. pw: keep that angular
// momentum but give the orbit zero Paczynski-Wiita energy (exactly parabolic
// in the potential the hole exerts).
function placeEncounter({ target, msun, rsKm, kind = 0, rp, e = 1, d0, phi = .7, incl = .15, pw = false }) {
    updEphem();
    const b = enc.bodyState(target, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
    const rs = rsKm ?? rsOf(msun);
    const mu = rs * C_LIGHT * C_LIGHT / 2 + bodyMu(target);
    const p = rp * (1 + e);
    const nu = -Math.acos(Math.max(-1, Math.min(1, (p / d0 - 1) / e)));
    const r = p / (1 + e * Math.cos(nu));
    let px = r * Math.cos(nu), py = r * Math.sin(nu);
    const k = Math.sqrt(mu / p);
    let vx = -k * Math.sin(nu), vy = k * (e + Math.cos(nu));
    if (pw) {
        const h = px * vy - py * vx, v = Math.sqrt(2 * mu / (r - rs)), vt = h / r;
        const vr = -Math.sqrt(Math.max(0, v * v - vt * vt));
        vx = (vr * px - vt * py) / r; vy = (vr * py + vt * px) / r;
    }
    const c = Math.cos(phi), s = Math.sin(phi);
    [px, py] = [px * c - py * s, px * s + py * c];
    [vx, vy] = [vx * c - vy * s, vx * s + vy * c];
    const ci = Math.cos(incl), si = Math.sin(incl);
    const rel = { x: px, y: py * ci, z: py * si, vx, vy: vy * ci, vz: vy * si };
    return enc.addHoleData(b.x - rel.x, b.y - rel.y, rs, b.vx - rel.vx, b.vy - rel.vy, null, kind, kind === 2 ? .0334 : 0, b.z - rel.z, b.vz - rel.vz);
}
// frames of frameDt through the world step's dead/landed path; a frame may
// deliver less than it asked (the bodies' per-call step budget with a hole in
// play), so the loop counts what was delivered
function run(total, frameDt) {
    let t = 0, stall = 0;
    while (t < total - 1e-9 && stall < 4) {
        const got = physics.advanceWorld(Math.min(frameDt, total - t));
        if (got > 0) { t += got; stall = 0; } else stall++;
    }
    return t;
}
function holeState(i = 0) {
    return { x: BH.x[i], y: BH.y[i], z: BH.z[i], vx: BH.vx[i], vy: BH.vy[i], vz: BH.vz[i], mu: BH.mu[i] };
}
// world-frame hole speed (the Earth-centred frame can itself coast fast once
// Earth has been swallowed)
function worldSpeed(i = 0) { return Math.hypot(BH.vx[i] + ephem.eph.earthVx, BH.vy[i] + ephem.eph.earthVy, BH.vz[i]); }
function finiteAndSubluminal() {
    for (let i = 0; i < BH.n; i++) {
        const v = worldSpeed(i);
        if (!Number.isFinite(v + BH.x[i] + BH.y[i] + BH.z[i] + BH.mu[i]) || v >= C_LIGHT) return false;
    }
    return true;
}

// ---------------------------------------------------------------- pure table
console.log("[A] classifyTidalEncounter (pure)");
{
    const sun = { mStar: MU_S, rStar: R_SUN };
    const cls = (msun, beta, extra = {}) => {
        const mBh = rsOf(msun) * C_LIGHT * C_LIGHT / 2;
        const rt = tde.tidalRadiusKm(R_SUN, mBh, MU_S);
        return tde.classifyTidalEncounter({ mBh, rs: rsOf(msun), rp: rt / beta, ...sun, ...extra });
    };
    const rows = [
        ["Sun + 1e6 Msun  beta 3", cls(1e6, 3), "full"],
        ["Sun + 1e6 Msun  beta 1.2", cls(1e6, 1.2), "partial"],
        ["Sun + 1e6 Msun  beta 0.3", cls(1e6, .3), "distort"],
        ["Sun + 1e8 Msun  beta 1", cls(1e8, 1), "captured"],
        ["Sun + 1e9 Msun  beta 1", cls(1e9, 1), "captured"],
        ["Sun + 0.34 Msun (r_s 1 km) beta 3", cls(.3386, 3), "none"],
        ["Sun + 3.4e-4 Msun (r_s 1 m) beta 3", cls(3.386e-4, 3), "none"],
    ];
    for (const [label, c, want] of rows) {
        console.log("    " + label.padEnd(36) + " -> " + c.regime.padEnd(8) + " beta " + c.beta.toFixed(3) + " rt/rs " + (c.rt / Math.max(1e-30, c.rCapture / 2)).toExponential(2) + " dM/M " + c.massLossFrac.toFixed(3) + (c.hills ? " (Hills)" : ""));
        check(c.regime === want, label + " is " + want, c.regime);
    }
    const f = cls(1e6, 3);
    check(relErr(f.tFbSec / 86400, 41.0) < .01, "t_fb(Sun, 1e6 Msun) = 41.0 d", f.tFbSec / 86400);
    check(relErr(f.mdotPeakKgS, MU_S / G_KM / (3 * f.tFbSec)) < 1e-12, "Mdot_peak = M*/(3 t_fb) for a full disruption");
    check(relErr(f.boundMass, .5 * MU_S) < 1e-12 && relErr(f.unboundMass, .5 * MU_S) < 1e-12, "full: half bound, half unbound");
    check(cls(1e8, 1).hills && cls(1e9, 1).hills && !cls(1e6, 1).hills, "Hills flag: r_t inside the capture radius above ~4e7 Msun");
    const p12 = tde.massLossFraction(1.2, 4 / 3), p07 = tde.massLossFraction(.7, 5 / 3);
    check(p12 > .15 && p12 < .3, "GRR13 gamma=4/3 dM/M(1.2) ~ 0.22", p12);
    check(p07 > .18 && p07 < .32, "GRR13 gamma=5/3 dM/M(0.7) ~ 0.24", p07);
    check(tde.massLossFraction(1.85, 4 / 3) === 1 && tde.massLossFraction(.9, 5 / 3) === 1, "beta_d: 1.85 (4/3), 0.9 (5/3)");
    // relativistic capture: parabolic L = 4GM/c is the separatrix
    const mu = MU_S * 1e6, rs = rsOf(1e6);
    const Lc = 4 * mu / C_LIGHT;
    check(tde.pwPericentre(0, Lc * .999, mu, rs, 1e3 * rs, {}).captured && !tde.pwPericentre(0, Lc * 1.001, mu, rs, 1e3 * rs, {}).captured,
        "PW capture separatrix at L = 4GM/c for a parabolic orbit");
    // accretion integral
    const tFb = 86400, bm = 1;
    check(tde.accretedMass(tFb * .99, tFb, bm) === 0 && relErr(tde.accretedMass(tFb * 8, tFb, bm), .75) < 1e-12, "M_acc(t) = (M*/2)[1-(t/t_fb)^(-2/3)], zero before t_fb");
    let integ = 0;
    for (let t = tFb; t < tFb * 64; t += tFb / 2000) integ += tde.fallbackRate(t + tFb / 4000, tFb, 2) * tFb / 2000;
    check(relErr(integ, tde.accretedMass(tFb * 64, tFb, 1)) < 1e-3, "integral of Mdot equals M_acc (no pre-peak mass)", integ);
}

// ---------------------------------------------------------------- live cases
console.log("[B] live encounters");
function liveCase(label, { target, msun, beta, d0f = 3, e = 1, runSec, frame = 60 }, verify) {
    resetAll();
    const rt = tidalR(target, msun);
    const rCap = 2 * rsOf(msun);
    placeEncounter({ target, msun, rp: rt / beta, e, d0: d0f * Math.max(rt, rCap) });
    const t0 = performance.now();
    run(runSec, frame);
    const ms = performance.now() - t0;
    const rec = TDES.find(d => d.target === target) || null;
    const cap = CAPTURES.find(c => c.target === target) || null;
    const encRec = ENC.find(r => r.target === target) || null;
    console.log("    " + label + ": " + JSON.stringify({
        wallMs: Math.round(ms), regime: rec?.regime ?? (cap ? "captured" : encRec?.regime ?? "none"),
        beta: rec?.beta ?? encRec?.cls?.beta, tFbDays: rec ? rec.tFb / 86400 : undefined,
        destroyed: state.isBodyDestroyed(target), log: log.filter(l => l.target === target || String(l.text).includes(enc.bodyLabel(target))).map(l => l.kind + ":" + l.text),
    }));
    verify({ rec, cap, encRec, rt, rCap });
}
liveCase("Sun + 1e6 Msun, beta 3", { target: "sun", msun: 1e6, beta: 3, runSec: 86400 }, ({ rec }) => {
    check(rec?.regime === "full", "Sun + 1e6 Msun beta 3 -> full disruption", rec?.regime);
    check(state.isBodyDestroyed("sun"), "the Sun is removed at pericentre");
    check(rec && relErr(rec.boundMass, .5 * MU_S) < 1e-9, "bound mass = M_sun/2 (not 100%)");
    check(rec && relErr(rec.tFb / 86400, 41.0) < .01, "t_fb = 41 d");
    check(rec && relErr(BH.mu[0], 1e6 * MU_S) < 1e-9, "no mass accreted before t_fb (flat-dM/deps fallback)", BH.mu[0] / MU_S);
    check(GS.length === 0, "no phantom gravity sources");
    check(finiteAndSubluminal(), "hole state finite and sub-luminal");
});
liveCase("Sun + 1e6 Msun, beta 1.2", { target: "sun", msun: 1e6, beta: 1.2, runSec: 86400 }, ({ rec }) => {
    check(rec?.regime === "partial", "Sun + 1e6 Msun beta 1.2 -> partial", rec?.regime);
    check(!state.isBodyDestroyed("sun"), "the Sun's core survives");
    const f = rec?.massLossFrac ?? 0;
    check(f > .05 && f < .6, "stripped fraction from the GRR13 fit", f);
    check(Math.abs(WORLD.muScale[IDX_SUN] - (1 - f)) < 1e-12, "the core keeps (1 - dM/M) of the Sun's mass", WORLD.muScale[IDX_SUN]);
    check(rec && relErr(rec.boundMass, .5 * f * MU_S) < 1e-9, "only half the stripped mass is bound");
});
liveCase("Sun + 1e8 Msun, beta 1", { target: "sun", msun: 1e8, beta: 1, runSec: 3 * 86400, frame: 600 }, ({ rec, cap }) => {
    check(!rec && cap, "Sun + 1e8 Msun -> captured, no flare", { rec: rec?.regime, cap: !!cap });
    check(cap && /tidal radius inside the horizon/.test(cap.reason), "honest reason: tidal radius inside the horizon", cap?.reason);
    check(log.some(l => l.kind === "captured" && l.target === "sun"), "wired through the cataclysm hook");
    check(finiteAndSubluminal(), "hole state finite and sub-luminal");
});
liveCase("Sun + 1e9 Msun, beta 1", { target: "sun", msun: 1e9, beta: 1, runSec: 6 * 86400, frame: 3600 }, ({ rec, cap }) => {
    check(!rec && cap, "Sun + 1e9 Msun -> captured, no flare", { rec: rec?.regime, cap: !!cap });
    check(TDES.length === 0, "no Eddington flare from any quasar capture", TDES.map(d => d.name));
    check(finiteAndSubluminal(), "hole state finite and sub-luminal");
});
liveCase("Earth + 34 Msun, beta 3", { target: "earth", msun: 33.86, beta: 3, runSec: 20000, frame: 60 }, ({ rec }) => {
    check(rec?.regime === "full", "Earth + 34 Msun beta 3 -> disrupted", rec?.regime);
    check(state.isBodyDestroyed("earth"), "Earth removed");
    check(rec && relErr(rec.boundMass, .5 * MU_E) < 1e-9, "bound mass = M_earth/2");
});
liveCase("Earth + 34 Msun, beta 0.3", { target: "earth", msun: 33.86, beta: .3, d0f: 5.5, runSec: 30000, frame: 60 }, ({ rec, encRec }) => {
    check(!rec && !state.isBodyDestroyed("earth"), "flyby leaves Earth intact");
    check(log.some(l => l.kind === "tde-flyby" && /Earth/.test(l.text)), "flyby booked as distort (tidal elongation only)", log.map(l => l.text));
    check(Math.abs(WORLD.muScale[ephem.NB] - 1) < 1e-15, "no mass change on a distort flyby");
});
liveCase("Sun + 0.34 Msun (r_s 1 km), beta 3", { target: "sun", msun: .3386, beta: 3, d0f: 12, runSec: 12000, frame: 60 }, ({ rec, cap }) => {
    check(!rec && !cap && !state.isBodyDestroyed("sun"), "0.34 Msun hole cannot tidally disrupt the Sun (mass ratio)");
    check(ENC.every(r => r.target !== "sun"), "no encounter booked for q < 10");
    check(finiteAndSubluminal(), "a hole passing through the Sun stays finite (extended-body pair law)");
    const v = worldSpeed(0);
    check(v < 3000, "no singular kick from the Sun's centre", v);
});

// ------------------------------------------------------- warp invariance
console.log("[C] warp / frame-rate invariance (Earth + 1 m hole, beta 3: hole recoil ~1% of Earth's momentum)");
{
    const msun = 0.001 * C_LIGHT * C_LIGHT / 2 / MU_S; // r_s = 1 m
    const rt = tidalR("earth", msun);
    const runs = QUICK
        ? [["warp 600 @60fps", 600, 60], ["warp 3600 @60fps", 3600, 60], ["warp 3600 @24fps", 3600, 24]]
        : [["warp 1 @30fps", 1, 30], ["warp 600 @60fps", 600, 60], ["warp 600 @144fps", 600, 144], ["warp 3600 @60fps", 3600, 60], ["warp 3600 @24fps", 3600, 24]];
    const out = [];
    let tEnd = 0, tFb = 0;
    for (const [label, warp, fps] of runs) {
        resetAll();
        placeEncounter({ target: "earth", msun, rp: rt / 3, d0: 2 * rt });
        const h0 = holeState();
        // pericentre, then 1.5 t_fb of fallback
        if (!tEnd) {
            // probe once to learn t_p and t_fb
            run(4000, 10);
            const d = TDES[0];
            tFb = d.tFb; tEnd = d.t0 + 1.5 * d.tFb;
            resetAll();
            placeEncounter({ target: "earth", msun, rp: rt / 3, d0: 2 * rt });
        }
        const w0 = performance.now();
        run(tEnd, warp / fps);
        const d = TDES[0];
        const h = holeState();
        out.push({
            label, wallMs: Math.round(performance.now() - w0), regime: d?.regime, beta: d?.beta, t0: d?.t0,
            accreted: BH.mu[0] - h0.mu, h, dx: h.x - h0.x, dy: h.y - h0.y, dz: h.z - h0.z, dvx: h.vx - h0.vx, dvy: h.vy - h0.vy, dvz: h.vz - h0.vz,
        });
    }
    const ref = out[0];
    const dispRef = Math.hypot(ref.dx, ref.dy, ref.dz), dvRef = Math.hypot(ref.dvx, ref.dvy, ref.dvz);
    for (const o of out) {
        const dPos = Math.hypot(o.dx - ref.dx, o.dy - ref.dy, o.dz - ref.dz) / dispRef;
        const dVel = Math.hypot(o.dvx - ref.dvx, o.dvy - ref.dvy, o.dvz - ref.dvz) / dvRef;
        console.log("    " + o.label.padEnd(18) + " wall " + String(o.wallMs).padStart(6) + " ms  regime " + o.regime + "  beta " + o.beta?.toFixed(5) +
            "  t_p " + o.t0?.toFixed(3) + " s  accreted " + (o.accreted / MU_E).toFixed(6) + " M_E  |dx|/disp " + dPos.toExponential(2) + "  |dv|/dv " + dVel.toExponential(2));
        check(o.regime === ref.regime, o.label + ": same regime");
        check(Math.abs(o.t0 - ref.t0) < 1, o.label + ": same pericentre time (< 1 s)", o.t0 - ref.t0);
        check(relErr(o.accreted, ref.accreted) < .01, o.label + ": same accreted mass (1%)", o.accreted / ref.accreted);
        check(dPos < .01 && dVel < .01, o.label + ": same hole state (1%)", { dPos, dVel });
    }
    check(ref.accreted > 0 && relErr(ref.accreted, .5 * MU_E * tde.accretedFraction(tEnd - ref.t0, tFb)) < 1e-6, "accreted mass follows M_acc(t) of the bound half", ref.accreted / MU_E);
    check(dvRef > .05, "hole recoil is resolved (not a trivially frozen hole)", dvRef);
}

// ------------------------------------------------------- stress: 3390 Msun
// A 3390 Msun hole dropped at rest 0.3 AU sunward of Earth plunges through
// the inner Solar System. The old integrator ate a different set of planets
// at each warp and flung holes past c; here the sequence of outcomes must be
// the same at every warp and every hole stays sub-luminal.
console.log("[D] 3390 Msun hole through the inner Solar System");
{
    const res = [];
    const span = 40 * 86400;
    for (const [label, warp, fps] of [["warp 3600", 3600, 60], ["warp 21600", 21600, 60], ["warp 86400", 86400, 60], ["warp 604800", 604800, 30]]) {
        resetAll();
        updEphem();
        const ux = ephem.eph.sunX / Math.hypot(ephem.eph.sunX, ephem.eph.sunY), uy = ephem.eph.sunY / Math.hypot(ephem.eph.sunX, ephem.eph.sunY);
        enc.addHoleData(ux * 4.5e7, uy * 4.5e7, 1e4, 0, 0);
        const w0 = performance.now();
        // the booked angular momentum of each plunge, in units of 4GM/c
        const lRatio = {};
        let t = 0;
        const frame = warp / fps;
        let stall = 0;
        while (t < span - 1e-9 && stall < 4) {
            const got = physics.advanceWorld(Math.min(frame, span - t));
            if (got > 0) { t += got; stall = 0; } else stall++;
            for (const r of ENC) if (r.pending && r.cls) lRatio[enc.bodyLabel(r.target)] = r.el.h / (4 * r.muHole / C_LIGHT);
        }
        const outcomes = [];
        for (const c of CAPTURES) outcomes.push({ t: c.t, who: enc.bodyLabel(c.target), what: "captured" });
        for (const d of TDES) outcomes.push({ t: d.t0, who: enc.bodyLabel(d.target), what: d.regime });
        outcomes.sort((a, b) => a.t - b.t);
        const eaten = enc.BODY_TARGETS.filter(t => state.isBodyDestroyed(t)).map(enc.bodyLabel).sort().join(",");
        res.push({ label, ms: Math.round(performance.now() - w0), ok: finiteAndSubluminal(), v: worldSpeed(0), eaten, outcomes, lRatio, times: outcomes.map(o => (o.t / 86400).toFixed(3)) });
    }
    // Every body falls in almost radially: its angular momentum about the hole
    // is ~1e-4 of r v, so the capture/disruption boundary (L = 4GM/c) is
    // crossed by metre-per-second differences in the hole's path, which the
    // warp-dependent substeps of the swallowings before it legitimately
    // produce. A body whose L/(4GM/c) falls within [0.5, 2] at any warp is
    // marginal: it must be destroyed at every warp, but either outcome counts.
    const marginal = new Set();
    for (const r of res) for (const [who, l] of Object.entries(r.lRatio)) if (l > .5 && l < 2) marginal.add(who);
    const seqOf = r => r.outcomes.map(o => o.who + ":" + (marginal.has(o.who) && (o.what === "full" || o.what === "captured") ? "destroyed" : o.what)).join(" > ");
    for (const r of res) {
        console.log("    " + r.label.padEnd(12) + " wall " + String(r.ms).padStart(5) + " ms  v_hole(world) " + r.v.toFixed(1) + " km/s  " + r.outcomes.map(o => o.who + ":" + o.what).join(" > ") + "  [d " + r.times.join(",") + "]");
        check(r.ok, r.label + ": hole stays finite and below c");
        check(r.eaten === res[0].eaten, r.label + ": the same bodies are destroyed at every warp", { got: r.eaten, want: res[0].eaten });
        check(seqOf(r) === seqOf(res[0]), r.label + ": the same sequence of outcomes at every warp", seqOf(r));
    }
    for (const who of marginal) console.log("    marginal plunge: " + who + " L/(4GM/c) = " + res.map(r => r.lRatio[who]?.toFixed(3) ?? "-").join(", "));
    check(res.every(r => r.outcomes.some(o => o.who === "Sun" && o.what === "captured")), "the Sun plunges on L < 4GM/c and is swallowed whole (every warp)");
}

// ------------------------------------------------------- lifecycle (item 2)
console.log("[E] lifecycle: removal, merge, quickload, reverse, pulsars, 3-D");
{
    const snapshotWorld = () => {
        const eph = ephem.snapshotEphem();
        return JSON.stringify({
            t: G.t, ephT: EPHT.t,
            eph: { x: Array.from(eph.x), y: Array.from(eph.y), z: Array.from(eph.z), vx: Array.from(eph.vx), vy: Array.from(eph.vy), vz: Array.from(eph.vz), earthX: eph.earthX, earthY: eph.earthY, earthVx: eph.earthVx, earthVy: eph.earthVy },
            world: { earth: WORLD.earthDestroyed, moon: WORLD.moonDestroyed, sun: WORLD.sunDestroyed, pl: Array.from(WORLD.plDestroyed), floor: Number.isFinite(WORLD.irreversibleFloorT) ? WORLD.irreversibleFloorT : null },
            bh: Array.from({ length: BH.n }, (_, i) => [BH.x[i], BH.y[i], BH.vx[i], BH.vy[i], BH.rs[i], BH.kind[i], BH.period[i], BH.z[i], BH.vz[i]]),
            bhEv: Array.from({ length: BH.n }, (_, i) => BH.ev[i].map(e => e.tFb > 0 ? [e.x, e.y, e.z, e.t, e.dmu, e.tFb] : [e.x, e.y, e.z, e.t, e.dmu])),
            tde: enc.serializeEncounterState(),
        });
    };
    const restoreWorld = json => {
        const d = JSON.parse(json);
        resetAll();
        state.setSimTime(d.t);
        ephem.loadEphemSnapshot({
            x: Float64Array.from(d.eph.x), y: Float64Array.from(d.eph.y), z: Float64Array.from(d.eph.z),
            vx: Float64Array.from(d.eph.vx), vy: Float64Array.from(d.eph.vy), vz: Float64Array.from(d.eph.vz),
            earthX: d.eph.earthX, earthY: d.eph.earthY, earthVx: d.eph.earthVx, earthVy: d.eph.earthVy, t: d.ephT,
        });
        WORLD.earthDestroyed = d.world.earth; WORLD.moonDestroyed = d.world.moon; WORLD.sunDestroyed = d.world.sun;
        WORLD.plDestroyed.set(d.world.pl);
        WORLD.irreversibleFloorT = d.world.floor === null ? -Infinity : d.world.floor;
        d.bh.forEach(([x, y, vx, vy, rs, kind, period, z, vz], i) => {
            const ev = d.bhEv[i].map(r => ({ x: r[0], y: r[1], z: r[2], t: r[3], dmu: r[4], ...(r[5] > 0 ? { tFb: r[5] } : {}) }));
            enc.addHoleData(x, y, rs, vx, vy, ev, kind, period, z, vz);
        });
        enc.restoreEncounterState(d.tde);
    };
    const rt6 = tidalR("sun", 1e6);

    // 1. removing a hole mid-approach clears the booking and the reverse block
    resetAll();
    placeEncounter({ target: "sun", msun: 1e6, rp: rt6 / 3, d0: 3 * rt6 });
    run(600, 60);
    const pendingBefore = WORLD.tdeInProgress && ENC.some(r => r.pending);
    enc.removeHoleData(0);
    check(pendingBefore && !WORLD.tdeInProgress && ENC.length === 0 && GS.length === 0, "removal mid-approach clears the booking and tdeInProgress");
    const back = physics.advanceWorld(-300);
    check(back === -300 && !WORLD.reverseBlocked, "reverse works again after the hole is removed", back);

    // 2. removing a hole mid-flare leaves no debris gravity behind and re-opens
    //    the deep-time fast path (a partial leaves the Sun alive)
    resetAll();
    placeEncounter({ target: "sun", msun: 1e6, rp: rt6 / 1.2, d0: 3 * rt6 });
    run(2 * 86400, 600);
    const flareBefore = TDES.length > 0;
    enc.removeHoleData(0);
    check(flareBefore && TDES.length === 0 && GS.length === 0 && !WORLD.tdeInProgress, "removal mid-flare drops the flare, no phantom/ghost left");
    const w0 = performance.now();
    ephem.advanceEphem(3e9);
    const ms = performance.now() - w0;
    check(ms < 200, "deep-time Kepler path re-opens after the hole is gone (100 yr in " + ms.toFixed(0) + " ms)");
    const floorBefore = WORLD.irreversibleFloorT;
    const rev = physics.advanceWorld(-1e12);
    check(WORLD.reverseBlocked && Math.abs(G.t - floorBefore) < 1e-6, "reverse stops at the disruption's irreversible floor", { t: G.t, floorBefore });

    // 3. merging mid-flare hands the running flare to the merged hole
    resetAll();
    placeEncounter({ target: "sun", msun: 1e6, rp: rt6 / 3, d0: 3 * rt6 });
    run(86400, 600);
    const sunFlare = TDES.find(d => d.target === "sun");
    const rsA = BH.rs[0];
    enc.addHoleData(BH.x[0] + 12 * rsA, BH.y[0], rsA * .5, BH.vx[0], BH.vy[0], null, 0, 0, BH.z[0], BH.vz[0]);
    let vMax = 0;
    for (let k = 0; k < 60; k++) { run(60, 60); for (let i = 0; i < BH.n; i++) vMax = Math.max(vMax, worldSpeed(i)); }
    check(BH.n === 1 && sunFlare && sunFlare.bh === 0 && TDES.includes(sunFlare), "merger keeps the flare on the merged hole", { n: BH.n, bh: sunFlare?.bh });
    check(vMax < .95 * C_LIGHT, "two holes coalesce below c without touching the numerical guard (merge at 2(r_s1+r_s2))", vMax / C_LIGHT);
    const acc0 = sunFlare.accreted, mu0 = BH.mu[0];
    run(sunFlare.t0 + 2 * sunFlare.tFb - G.t, 86400);
    check(sunFlare.accreted > acc0 && relErr(sunFlare.accreted, .5 * MU_S * tde.accretedFraction(G.t - sunFlare.t0, sunFlare.tFb)) < 1e-9,
        "accretion continues onto the merged hole along M_acc(t)");
    check(BH.mu[0] - mu0 >= sunFlare.accreted - acc0 - 1e-3 * MU_S, "merged hole mass grows by the accreted debris");

    // 4. quicksave / quickload: mid-approach and mid-flare round trips
    for (const [label, tSave] of [["mid-approach", 900], ["mid-flare", 20 * 86400]]) {
        resetAll();
        placeEncounter({ target: "sun", msun: 1e6, rp: rt6 / 3, d0: 3 * rt6, phi: 1.3 });
        run(tSave, 300);
        const saved = snapshotWorld();
        run(60 * 86400 - G.t, 3600);
        const refA = { mu: BH.mu[0], x: BH.x[0], vx: BH.vx[0], t0: TDES.find(d => d.target === "sun")?.t0, regime: TDES.find(d => d.target === "sun")?.regime };
        restoreWorld(saved);
        run(60 * 86400 - G.t, 3600);
        const refB = { mu: BH.mu[0], x: BH.x[0], vx: BH.vx[0], t0: TDES.find(d => d.target === "sun")?.t0, regime: TDES.find(d => d.target === "sun")?.regime };
        check(refA.regime === "full" && refB.regime === refA.regime && Math.abs(refA.t0 - refB.t0) < 1e-6 && relErr(refB.mu, refA.mu) < 1e-12 &&
            Math.abs(refB.x - refA.x) < 1e-6 * Math.abs(refA.x) + 1 && Math.abs(refB.vx - refA.vx) < 1e-6,
            "quickload " + label + " continues the same encounter", { refA, refB });
    }

    // 5. pulsars: a 1.4 Msun neutron star tidally disrupts a planet like any
    //    1.4 Msun object (Eddington-capped at 1.4 Msun); a plunge hits the crust
    const NS_RS = 4.1345;
    const rtNS = R_EARTH * Math.cbrt(NS_RS * C_LIGHT * C_LIGHT / 2 / MU_E);
    resetAll();
    placeEncounter({ target: "earth", rsKm: NS_RS, kind: 2, rp: rtNS / 3, d0: 3 * rtNS });
    run(40000, 60);
    const nsFlare = TDES.find(d => d.target === "earth");
    check(nsFlare?.regime === "full" && relErr(nsFlare.LEddW, tde.L_EDD_PER_MSUN * BH.mu[0] / MU_S) < 1e-6 && BH.kind[0] === 2,
        "neutron star: ordinary tidal disruption of Earth, flare capped at L_Edd(1.4 Msun)", nsFlare?.regime);
    check(Math.abs(BH.sinkS[0] - 12 * constants.K) < 1e-15, "neutron star keeps its 12 km surface after accreting");
    resetAll();
    placeEncounter({ target: "earth", rsKm: NS_RS, kind: 2, rp: 3, d0: 3 * rtNS });
    run(40000, 60);
    const nsCap = CAPTURES.find(c => c.target === "earth");
    check(nsCap && /neutron-star surface/.test(nsCap.reason) && !TDES.some(d => d.target === "earth"), "neutron star: a plunging body impacts the surface (no horizon, no flare)", nsCap?.reason);
    // the ship dies on the crust, not at a 4-6 km 'horizon'
    resetAll();
    G.dead = false;
    let deathMsg = "", deathR = 0;
    physics.initPhysicsHooks({ die(m) { G.dead = true; deathMsg = m; deathR = Math.hypot(G.x - BH.x[0], G.y - BH.y[0], G.z - BH.z[0]); }, award() { }, banner() { }, hideBanner() { }, engulfed() { } });
    enc.addHoleData(G.x + 3000, G.y, NS_RS, G.vx, G.vy, null, 2, .0334, G.z, G.vz);
    for (let k = 0; k < 2000 && !G.dead; k++) physics.advance(.05, 0, 0, 0, 0);
    check(/neutron-star surface/.test(deathMsg) && deathR <= 12.01 && deathR > 6, "ship impacts the neutron-star surface at 12 km", { deathMsg, deathR });
    G.dead = true;

    // 6. 3-D: a vertical flyby (orbit plane perpendicular to the ecliptic)
    resetAll();
    const rtJ = tidalR(JUPITER, 1e5);
    placeEncounter({ target: JUPITER, msun: 1e5, rp: rtJ / .35, d0: 5.5 * rtJ, incl: Math.PI / 2 });
    const z0 = BH.z[0], vz0 = BH.vz[0];
    run(20 * 86400, 600);
    check(!state.isBodyDestroyed(JUPITER) && log.some(l => l.kind === "tde-flyby" && /Jupiter/.test(l.text)), "vertical flyby: distort, Jupiter intact", log.map(l => l.text));
    check(Math.abs(BH.vz[0] - vz0) > 1e-6, "the hole feels Jupiter's out-of-plane pull (z dynamics)", BH.vz[0] - vz0);
}

// ------------------------------------------------------- debris (item 3)
console.log("[F] emergent debris: split, fallback, precession, remnant, determinism");
{
    const out = [0, 0, 0];
    // 1. full disruption on an exactly parabolic (PW) orbit
    const fullRun = frame => {
        resetAll();
        const rt = tidalR("sun", 1e6);
        placeEncounter({ target: "sun", msun: 1e6, rp: rt / 3, d0: 3 * rt, pw: true });
        run(2 * 3600, frame);
        const d = TDES.find(x => x.target === "sun");
        return d ? d.debris : null;
    };
    const spec = fullRun(60);
    check(spec && spec.kind === "full", "full disruption leaves a debris spec", spec?.kind);
    const m = new debris.DebrisModel(spec, debris.debrisCountFor(spec));
    const n = m.count, tFb = spec.tFb, cen = m.census(spec.t0);
    const fb = cen.bound / n;
    console.log("    elements " + n + ", bound " + cen.bound + " (" + (100 * fb).toFixed(1) + "%), eps_cm/dEps " + (m.model.epsCm / m.model.dEps).toExponential(2) + ", kappa " + m.model.kappa.toFixed(4));
    check(n <= 3000 && Math.abs(fb - .5) < .03, "half the debris is bound (emergent split)", fb);
    const ret = [];
    for (let i = 0; i < n; i++) if (m.flags[i] & debris.DEBRIS_BOUND) ret.push(m.tRet[i] - spec.tPeri);
    ret.sort((a, b) => a - b);
    check(Math.abs(ret[0] / tFb - 1) < .03, "the most bound debris returns after t_fb = 41 d", ret[0] / 86400);
    for (const k of [1.2, 2, 5]) {
        const frac = ret.filter(t => t <= k * tFb).length / ret.length;
        check(Math.abs(frac - (1 - Math.pow(k, -2 / 3))) < .03, "returned by " + k + " t_fb matches M_acc(t)/(M/2) = 1-(t/t_fb)^-2/3", frac);
    }
    // log-slope of the return rate over 1.5 - 40 t_fb
    const edges = [];
    for (let k = 0; k <= 8; k++) edges.push(1.5 * Math.pow(40 / 1.5, k / 8) * tFb);
    const xs = [], ys = [];
    for (let b = 0; b + 1 < edges.length; b++) {
        const cnt = ret.filter(t => t >= edges[b] && t < edges[b + 1]).length;
        if (cnt > 4) { xs.push(Math.log(Math.sqrt(edges[b] * edges[b + 1]))); ys.push(Math.log(cnt / (edges[b + 1] - edges[b]))); }
    }
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0, sxx = 0;
    for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; }
    const slope = sxy / sxx;
    console.log("    fallback d(ln Mdot)/d(ln t) over 1.5-40 t_fb: " + slope.toFixed(3));
    check(Math.abs(slope + 5 / 3) < .15, "the t^-5/3 return rate emerges from the orbits", slope);
    // stream geometry: thin and long, the bound half on the inside
    let rB = 0, rU = 0, nB = 0, nU = 0;
    for (let i = 0; i < n; i++) {
        m.particleAt(i, spec.tPeri + 2 * 86400, out);
        const r = Math.hypot(out[0], out[1], out[2]);
        if (m.flags[i] & debris.DEBRIS_BOUND) { rB += r; nB++; } else { rU += r; nU++; }
    }
    check(rB / nB < rU / nU, "two days on, the bound half trails the unbound half", { bound: rB / nB, unbound: rU / nU });
    const c12 = m.census(spec.tPeri + 1.2 * tFb);
    check(c12.returned > 0 && c12.returned - c12.accreted > 0, "at 1.2 t_fb the returned debris is circularizing (disk)", c12);

    // 2. a pure function of sim time: cold jump == many warm steps == reversed == repeated
    const ts = [spec.t0, spec.tPeri, spec.tPeri + 3600, spec.tPeri + 2 * 86400, spec.tPeri + 1.3 * tFb, spec.tPeri + 4 * tFb];
    const snap = (mm, t) => {
        const a = [];
        for (let i = 0; i < mm.count; i += 97) {
            if (mm.particleAt(i, t, out) > 0) a.push(out[0], out[1], out[2]); else a.push(0, 0, 0);
        }
        return a;
    };
    const cold = ts.map(t => snap(new debris.DebrisModel(spec, n), t));
    const warm = new debris.DebrisModel(spec, n);
    const warmSnaps = [];
    let tw = spec.t0;
    for (const t of ts) { while (tw < t) { tw = Math.min(t, tw + (t - spec.t0) / 400 + 1); snap(warm, tw); } warmSnaps.push(snap(warm, t)); }
    const rev = ts.slice().reverse().map(t => snap(warm, t)).reverse();
    let worst = 0;
    for (let k = 0; k < ts.length; k++) for (let j = 0; j < cold[k].length; j += 3) {
        const r = Math.hypot(cold[k][j], cold[k][j + 1], cold[k][j + 2]) || 1;
        for (const other of [warmSnaps[k], rev[k]]) {
            const e = Math.hypot(cold[k][j] - other[j], cold[k][j + 1] - other[j + 1], cold[k][j + 2] - other[j + 2]) / r;
            worst = Number.isFinite(e) ? Math.max(worst, e) : Infinity;
        }
    }
    check(worst < 1e-9, "debris positions depend only on sim time (cold, stepped, reversed agree)", worst);
    const a1 = snap(warm, spec.tPeri + 5e5), a2 = snap(warm, spec.tPeri + 5e5);
    check(a1.every((v, k) => Math.abs(v - a2[k]) <= 1e-9 * Math.abs(v) + 1e-6), "a paused frame re-evaluates to the same positions (to the solver tolerance)");
    // observer effects: each element is drawn at its own retarded time
    // t_i = t - |x_i(t_i) - x_obs| / c; the drawn solution must sit on
    // the exact light cone (iterated to convergence)
    {
        const C = 299792.458;
        let worstRet = 0, worstShift = 0;
        for (const [tq, D] of [[spec.tPeri + 600, 3e7], [spec.tPeri + 2 * 86400, 2e9], [spec.tPeri + 1.3 * tFb, 3e10]]) {
            const ox = D * .6, oy = -D * .8, oz = D * .1; // observer, hole at the origin
            const tH = tq - Math.hypot(ox, oy, oz) / C;
            const mr = new debris.DebrisModel(spec, n);
            for (let i = 0; i < n; i += 37) {
                if (!(mr.seenAt(i, tq, tH, 0, 0, 0, ox, oy, oz, out) > 0)) continue;
                const sx = out[0], sy = out[1], sz = out[2];
                // exact: iterate t_i to the fixed point
                let ti = tH;
                for (let k = 0; k < 40; k++) {
                    mr.particleAt(i, ti, out);
                    ti = tq - Math.hypot(out[0] - ox, out[1] - oy, out[2] - oz) / C;
                }
                mr.particleAt(i, ti, out);
                const r = Math.hypot(out[0], out[1], out[2]);
                worstRet = Math.max(worstRet, Math.hypot(sx - out[0], sy - out[1], sz - out[2]) / r);
                mr.particleAt(i, tq, out);
                worstShift = Math.max(worstShift, Math.hypot(sx - out[0], sy - out[1], sz - out[2]) / r);
            }
        }
        console.log("    retarded-time drawing: error vs exact light cone " + worstRet.toExponential(2) + " of r (the retardation itself shifts elements by up to " + worstShift.toExponential(2) + " of r)");
        check(worstRet < 2e-3 && worstShift > 20 * worstRet, "debris is drawn on the observer's past light cone (within 0.2% of r)", { worstRet, worstShift });
    }
    // warp: the debris born in a run at 1-hour frames matches the 1-minute run
    const specW = fullRun(3600);
    // (same sampling seed: the record serial counts encounters across runs)
    const mW = new debris.DebrisModel({ ...specW, seed: spec.seed }, n);
    let wd = 0;
    for (let i = 0; i < n; i += 31) {
        m.particleAt(i, spec.tPeri + 3 * 86400, out);
        const x = out[0], y = out[1], z = out[2];
        mW.particleAt(i, spec.tPeri + 3 * 86400, out);
        wd = Math.max(wd, Math.hypot(out[0] - x, out[1] - y, out[2] - z) / Math.hypot(x, y, z));
    }
    check(Math.abs(specW.t0 - spec.t0) < 1 && wd < 1e-3, "debris is warp-independent (1-min vs 1-h frames)", { dt0: specW.t0 - spec.t0, wd });

    // 3. precessing conics sweep the Paczynski-Wiita apsidal angle
    for (const q of [6.7, 15.8]) {
        const mu = MU_S * 1e6, rs = rsOf(1e6), rp = q * rs;
        const vp = Math.sqrt(2 * mu / (rp - rs)), L = rp * vp;
        const pm = debris.precessionModel(0, L, mu, rs, rp, {});
        // RK4 test particle in the PW potential from pericentre
        let st = [rp, 0, 0, vp], t = 0;
        const tDyn = Math.sqrt(rp ** 3 / mu), T = 30 * tDyn;
        const f = v => { const r = Math.hypot(v[0], v[1]), a = -mu / ((r - rs) * (r - rs) * r); return [v[2], v[3], a * v[0], a * v[1]]; };
        while (t < T) {
            const h = Math.min(T - t, tDyn / 400 * Math.max(1, Math.pow(Math.hypot(st[0], st[1]) / rp, 1.5)));
            const k1 = f(st), k2 = f(st.map((v, i) => v + k1[i] * h / 2)), k3 = f(st.map((v, i) => v + k2[i] * h / 2)), k4 = f(st.map((v, i) => v + k3[i] * h));
            st = st.map((v, i) => v + h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
            t += h;
        }
        const phiPW = Math.atan2(st[1], st[0]);
        // the model: exact energy (zero), equivalent Kepler with v_t x kappa
        const vM = Math.sqrt(2 * (mu / rp + pm.B / (rp * rp)));
        const el = kepler.conicFromState(rp, 0, 0, 0, pm.kappa * vM, 0, mu, kepler.makeConic());
        const pf = [0, 0, 0];
        kepler.perifocalAt(el.rp, el.alpha, mu, T, NaN, pf);
        const phiM = Math.atan2(pf[1], pf[0]) / pm.kappa;
        const dphi = Math.abs(Math.atan2(Math.sin(phiM - phiPW), Math.cos(phiM - phiPW)));
        console.log("    r_p = " + q + " r_s: kappa " + pm.kappa.toFixed(4) + ", PW sweep " + pm.sweep.toFixed(4) + " rad, angle error at 30 t_dyn " + dphi.toExponential(2) + " rad");
        check(dphi < .01, "precessing conic tracks a Paczynski-Wiita test particle (r_p = " + q + " r_s)", dphi);
    }
    check(Math.abs(debris.pwApsidalSweep(0, 1e6, 1, 0, 5e11) - Math.PI) < 1e-6 && Math.abs(debris.pwApsidalSweep(-.3, 1, 1, 0, 1 / (1 + Math.sqrt(.4))) - Math.PI) < 1e-6 &&
        Math.abs(debris.pwApsidalSweep(.2, 1, 1, 0, 1 / (1 + Math.sqrt(1.4))) - Math.acos(-1 / Math.sqrt(1.4))) < 1e-5, "apsidal sweep reduces to Kepler's (pi; arccos(-1/e)) without the hole's r_s");

    // 4. a partial stripping: the tails bracket the surviving core
    resetAll();
    {
        const rt = tidalR("sun", 1e6);
        placeEncounter({ target: "sun", msun: 1e6, rp: rt / 1.4, d0: 3 * rt, pw: true });
        run(4 * 3600, 60);
        const d = TDES.find(x => x.target === "sun");
        check(d && d.regime === "partial" && !state.isBodyDestroyed("sun"), "beta 1.4 strips the Sun partially", d?.regime);
        if (d) {
            const mp = new debris.DebrisModel(d.debris, debris.debrisCountFor(d.debris));
            run(8 * 3600, 600);
            const b = enc.bodyState("sun", { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
            const rx = b.x - BH.x[0], ry = b.y - BH.y[0], rz = b.z - BH.z[0];
            let iB = -1, iU = -1;
            for (let i = 0; i < mp.count; i++) {
                if (mp.u[i] < 0 && (iB < 0 || mp.u[i] > mp.u[iB])) iB = i;
                if (mp.u[i] > 0 && (iU < 0 || mp.u[i] < mp.u[iU])) iU = i;
            }
            const pB = [0, 0, 0], pU = [0, 0, 0];
            mp.particleAt(iB, G.t, pB); mp.particleAt(iU, G.t, pU);
            const sep = Math.hypot(pB[0] - pU[0], pB[1] - pU[1], pB[2] - pU[2]);
            const off = Math.hypot((pB[0] + pU[0]) / 2 - rx, (pB[1] + pU[1]) / 2 - ry, (pB[2] + pU[2]) / 2 - rz);
            const cp = mp.census(G.t);
            console.log("    partial: " + mp.count + " elements, bound " + cp.bound + "; core-to-tail-midpoint " + (off / sep).toFixed(3) + " of the tail gap at +12 h");
            check(off / sep < .25, "the leading and trailing tails leave from the surviving core", off / sep);
        }
    }
    // 5. swallowed whole: every element plunges, freezes toward r_s, none returns
    resetAll();
    {
        const rt = tidalR("sun", 1e8);
        placeEncounter({ target: "sun", msun: 1e8, rp: rt, d0: 2.4 * 2 * rsOf(1e8), pw: true });
        run(4 * 3600, 60);
        const c = CAPTURES.find(x => x.target === "sun");
        check(c && c.debris, "Sun + 1e8 Msun: captured with a debris spec");
        if (c) {
            const mc = new debris.DebrisModel(c.debris, debris.debrisCountFor(c.debris));
            const rs = c.debris.rs;
            const r1 = [], r2 = [];
            for (let i = 0; i < mc.count; i += 53) {
                mc.particleAt(i, c.t + 3600, out); r1.push(Math.hypot(out[0], out[1], out[2]));
                mc.particleAt(i, c.t + 7200, out); r2.push(Math.hypot(out[0], out[1], out[2]));
            }
            const cc = mc.census(c.t + 7200);
            check(cc.plunged === mc.count && cc.returned === 0, "all elements plunge, none returns", cc);
            check(r1.every((r, k) => r > rs && r2[k] > rs && r2[k] <= r), "they approach r_s asymptotically (never cross it in coordinate time)");
        }
    }
}

if (failures) { console.log(failures + " FAILED"); process.exit(1); }
console.log("tde regimes smoke passed");

function installStub() {
    globalThis.window = globalThis;
    globalThis.addEventListener ??= () => { };
    globalThis.removeEventListener ??= () => { };
    globalThis.location = { search: "" };
    globalThis.matchMedia ??= () => ({ matches: false, addEventListener() { }, removeEventListener() { } });
}
