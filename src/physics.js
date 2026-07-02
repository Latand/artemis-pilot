import {
    MU_E, MU_M, MU_S, R_EARTH, R_MOON, R_SUN, C_LIGHT, J2_E, OMEGA_EARTH,
    A_MOON, AU_KM,
    PL, SOI_M, SOI_E, DRAG_CD, DRAG_H, ATM_TOP, MAX_STEPS_FRAME, EPH_CHUNK,
} from "./constants.js";
import {
    eph, updEphem, moonState, planetVel, relGravityAt3, advanceEphem, keplerAdvance3,
    gravityStarsFor, currentGravityStars, STELLAR_GRAVITY_MIN_R,
} from "./ephemeris.js";
import { G, BH, WORLD, GS, EPHT, bhMuAt, destroyBody } from "./state.js";
import { bhAdvance } from "./blackholes.js";
import { fmtMET, fmtKm } from "./format.js";
import { ACTIVE_STARS, refreshActiveStars, getCachedFocusedSystem } from "./universe/activeStars.js";
import { strongestActiveStarWell } from "./universe/starDominance.js";
import { dominantSystemPlanet, planetWorldState } from "./universe/planetarySystem.js";
import { darkEnergyAccel, darkEnergyVisibleFractionKm, darkMatterRelativeAccel, darkMatterVisibleFractionPc } from "./cosmology.js";
import { equatorialKmToGal } from "./universe/coords.js";
import { segmentSphereHit } from "./geometry.js";
import { PERF, markPerf } from "./perf.js";
import { sunStateAt, sunMaxRadiusReachedRsunAt } from "./universe/sunEvolution.js";

// hooks into the presentation layer, wired once by main.js. `engulfed` is
// optional (main.js's current initPhysicsHooks call doesn't pass it) — WP23b
// calls it defensively with `?.()` so a planet engulfment never throws while
// main.js (out of this package's file ownership) hasn't wired a UI reaction.
let H = { die: () => { }, award: () => { }, banner: () => { }, hideBanner: () => { }, engulfed: () => { } };
export function initPhysicsHooks(hooks) { H = hooks; }

// ============================ SUN EVOLUTION (WP23b) ============================
// The Sun's radius (and, later, its remnant mass) evolve under deep time
// warp per universe/sunEvolution.js. `sunLive`/`sunRKmLive` are refreshed
// once per advance() call (not per RK4 substep, which would recompute the
// same Gyr-scale-slow function dozens of times a frame for no benefit) and
// consumed by every contact/flush-zone check below that used to assume a
// constant R_SUN. Initialized to today's exact values so any call before the
// first advance() (there shouldn't be one) is still correct.
let sunLive = { phase: "MS", L_Lsun: 1, R_Rsun: 1, Teff: 5772, massLoss: 1 };
let sunRKmLive = R_SUN;
// SCOPE NOTE (investigated per the WP23b brief's "recompute elements on mass
// change" instruction): the Sun's gravitational parameter is intentionally
// NOT scaled by sunLive.massLoss anywhere in this file. ephemeris.js keeps
// a private, load-time-fixed `bodyMu[IDX_SUN] = MU_S` that both the honest
// RK4 field (relGravityAt3, used by deriv() below) and the Kepler-jump
// analytic bridge (keplerAdvance3) read from — a file this package does not
// own. Scaling MU_S only in physics.js's own local mu usages (the 1PN term,
// orbitInfo's domSun branch) would make the "fast path" (Kepler jump /
// prediction) disagree with the "honest path" (RK4 via relGravityAt3) about
// how heavy the Sun is, which is worse than no change at all: it would drift
// ship state on every fast<->honest handoff instead of leaving the (already
// small, since AGB mass loss only matters ~7.6+ Gyr out) mismatch alone.
// Properly threading a live Sun mass through gravity — including recomputing
// each planet's osculating elements at the mass-loss epoch, since adiabatic
// mass loss expands orbits (Ma ~ const) and the Kepler-jump bridge assumes a
// fixed mu — needs an ephemeris.js-owning pass and is left as a follow-up.
// The Sun's evolving RADIUS (contact/engulfment, this file) and VISUAL
// (bodies.js) are fully wired; sunStateAt's `massLoss` field is exported and
// ready for that follow-up to consume.
function checkSunEngulfment(sunMaxRKmEver) {
    if (WORLD.sunDestroyed) return;
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        // Simplified per the WP23b brief: engulf when the giant's radius
        // exceeds the planet's semi-major axis (not its live/eccentric
        // distance) — matches the real-astrophysics result this timeline was
        // tuned to reproduce: Mercury/Venus lost mid-RGB-ascent, Earth's fate
        // decided right at the AGB tip (R~215 Rsun ~ 1 AU), Mars untouched.
        // Uses the HIGH-WATER-MARK radius (sunMaxRadiusReachedRsunAt), not
        // the instantaneous one: R(t) briefly peaks past Earth's 1 AU right
        // at the AGB tip and then immediately shrinks again during the PN
        // ejection, a window only ~1 Myr wide — narrower than a single
        // frame's simulated span at the game's own top warp speed. Comparing
        // against the peak-ever-reached radius makes engulfment correct
        // regardless of how coarsely (or in how few jumps) time advances.
        if (sunMaxRKmEver <= PL[i].a) continue;
        // Deliberately NOT ghosted (contrast with main.js's markBodyDestroyed,
        // which every live caller already calls with ghost=false too):
        // addGhost() pushes onto the GS array, and every deep-time
        // fast-bridging path in this file and ephemeris.js (frame bridge,
        // shipDeepJump, shipCosmologyJump, the Kepler-jump tail) is gated on
        // GS.length===0 and never clears it. A ghosted engulfment would
        // permanently fall the whole rest of the run back to full RK4
        // stepping — exactly backwards for a feature whose entire point is
        // warping through Gyr of Sun evolution.
        destroyBody(i);
        H.engulfed?.(PL[i].name, sunLive.phase);
    }
    // Earth isn't in PL[] (it defines the frame origin, tracked separately
    // via WORLD.earthDestroyed) but is subject to the exact same rule at its
    // own semi-major axis (1 AU) — the AGB tip (R~215 Rsun ~1 AU) is where
    // the brief's "Earth's fate is marginal" is actually decided.
    if (!WORLD.earthDestroyed && sunMaxRKmEver > AU_KM) {
        destroyBody("earth");
        H.engulfed?.("EARTH", sunLive.phase);
    }
}

const _m = { mx: 0, my: 0, vmx: 0, vmy: 0, ang: 0 };
const _pv = { vx: 0, vy: 0 };
const _pw = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const _pwSnap = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
let warnedLostSysPlanetLanding = false;

// derivative of [x,y,z,vx,vy,vz] incl. the live n-body field in the Earth-relative
// frame, PW black holes, Earth J2, Sun 1PN, atmosphere drag, thrust.
// `tau` is the offset from the last ephemeris flush: body and hole positions
// are linearly extrapolated so RK4 stages sample the field where the bodies
// actually are mid-step.
const J2_R2_MAX = 4e9;        // J2 negligible beyond ~10 Earth radii
const PN_R2_MAX = 7.5e7 * 7.5e7; // Sun 1PN active inside ~0.5 AU
export function deriv(x, y, z, vx, vy, vz, tau, atx, aty, atz, out) {
    relGravityAt3(x, y, z, _ga, -1, null, tau);
    let ax = _ga[0], ay = _ga[1], az = _ga[2];
    if (!WORLD.earthDestroyed) {
        const rE2 = x * x + y * y + z * z;
        const rE = Math.sqrt(rE2);
        if (rE2 < J2_R2_MAX && rE > 1e-9) {
            const w = 1.5 * J2_E * MU_E * R_EARTH * R_EARTH / (rE2 * rE2 * rE);
            const q = 5 * z * z / rE2;
            ax += w * x * (q - 1);
            ay += w * y * (q - 1);
            az += w * z * (q - 3);
        }
        const h = rE - R_EARTH;
        if (h < ATM_TOP) {
            const rho = Math.exp(-Math.max(0, h) / DRAG_H);
            const avx = -OMEGA_EARTH * y, avy = OMEGA_EARTH * x;
            const rvx = vx - avx, rvy = vy - avy, rvz = vz;
            const v = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
            const f = -DRAG_CD * rho * v;
            ax += f * rvx; ay += f * rvy; az += f * rvz;
        }
    }
    if (!WORLD.sunDestroyed) {
        const sx = eph.sunX + eph.sunVx * tau, sy = eph.sunY + eph.sunVy * tau, sz = eph.sunZ + eph.sunVz * tau;
        const dx = x - sx, dy = y - sy, dz = z - sz;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 < PN_R2_MAX && r2 > 1e-12) {
            // first post-Newtonian Sun term: Mercury-style perihelion precession
            const r = Math.sqrt(r2);
            const rvx = vx - eph.sunVx, rvy = vy - eph.sunVy, rvz = vz - eph.sunVz;
            const v2 = rvx * rvx + rvy * rvy + rvz * rvz;
            const rv = dx * rvx + dy * rvy + dz * rvz;
            const k = MU_S / (C_LIGHT * C_LIGHT * r2 * r);
            ax += k * ((4 * MU_S / r - v2) * dx + 4 * rv * rvx);
            ay += k * ((4 * MU_S / r - v2) * dy + 4 * rv * rvy);
            az += k * ((4 * MU_S / r - v2) * dz + 4 * rv * rvz);
        }
    }
    for (let i = 0; i < PL.length; i++) {
        const p = PL[i];
        if (!p.atmH || WORLD.plDestroyed[i]) continue;
        const px = eph.plX[i] + eph.plVx[i] * tau, py = eph.plY[i] + eph.plVy[i] * tau, pz = eph.plZ[i] + eph.plVz[i] * tau;
        const dx = x - px, dy = y - py, dz = z - pz;
        const lim = p.R + p.atmTop;
        if (dx > lim || dx < -lim || dy > lim || dy < -lim || dz > lim || dz < -lim) continue;
        const h = Math.sqrt(dx * dx + dy * dy + dz * dz) - p.R;
        if (h >= p.atmTop) continue;
        // drag opposes the planet-relative velocity → aerobraking works
        const rho = p.atmD0 * Math.exp(-Math.max(0, h) / p.atmH);
        const rvx = vx - eph.plVx[i], rvy = vy - eph.plVy[i], rvz = vz - eph.plVz[i];
        const f = -DRAG_CD * rho * Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
        ax += f * rvx; ay += f * rvy; az += f * rvz;
    }
    out[0] = vx; out[1] = vy; out[2] = vz; out[3] = ax + atx; out[4] = ay + aty; out[5] = az + atz;
}

const _ga = [0, 0, 0];
const _k1 = [0, 0, 0, 0, 0, 0], _k2 = [0, 0, 0, 0, 0, 0], _k3 = [0, 0, 0, 0, 0, 0], _k4 = [0, 0, 0, 0, 0, 0], _st = [0, 0, 0, 0, 0, 0];
// tau0: ephemeris lag at the start of this step (0 when bodies are fresh)
export function rk4Step(s, tau0, dt, atx, aty, atz = 0) {
    deriv(s[0], s[1], s[2], s[3], s[4], s[5], tau0, atx, aty, atz, _k1);
    for (let i = 0; i < 6; i++) _st[i] = s[i] + .5 * dt * _k1[i];
    deriv(_st[0], _st[1], _st[2], _st[3], _st[4], _st[5], tau0 + .5 * dt, atx, aty, atz, _k2);
    for (let i = 0; i < 6; i++) _st[i] = s[i] + .5 * dt * _k2[i];
    deriv(_st[0], _st[1], _st[2], _st[3], _st[4], _st[5], tau0 + .5 * dt, atx, aty, atz, _k3);
    for (let i = 0; i < 6; i++) _st[i] = s[i] + dt * _k3[i];
    deriv(_st[0], _st[1], _st[2], _st[3], _st[4], _st[5], tau0 + dt, atx, aty, atz, _k4);
    for (let i = 0; i < 6; i++) s[i] += dt / 6 * (_k1[i] + 2 * _k2[i] + 2 * _k3[i] + _k4[i]);
}

export function stepSize(rE, rM, rS, h, vTot, x, y, z = 0, vx = 0, vy = 0, vz = 0) {
    const tE = Math.sqrt(rE * rE * rE / MU_E), tM = Math.sqrt(rM * rM * rM / MU_M);
    const tS = Math.sqrt(rS * rS * rS / MU_S);
    let dt = Math.min(tE, tM, tS) / 90;
    if (!WORLD.earthDestroyed) {
        // approaching the atmosphere fast: never let one step jump across the shell
        if (h < 1200) dt = Math.min(dt, Math.max(.4, .22 * Math.max(40, h - 90) / Math.max(.01, vTot)));
        if (h < ATM_TOP + 60) {
            dt = Math.min(dt, .9);
            // bound drag Δv to ~5 % of speed per step or RK4 blows up on the exp profile
            const aD = DRAG_CD * Math.exp(-Math.max(0, h) / DRAG_H) * vTot;
            if (aD > 1e-6) dt = Math.min(dt, .05 / aD);
        }
    }
    for (let i = 0; i < PL.length; i++) {
        const p = PL[i];
        const dx = x - eph.plX[i], dy = y - eph.plY[i], dz = z - eph.plZ[i];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < p.soi * p.soi * 9) {
            const d = Math.sqrt(d2);
            const tP = Math.sqrt(d * d2 / p.mu) / 90;
            if (tP < dt) dt = tP;
            const gap = d - p.R;
            if (gap < 60000) dt = Math.min(dt, Math.max(.5, .2 * Math.max(200, gap) / Math.max(.01, vTot)));
            if (p.atmH && !WORLD.plDestroyed[i] && gap < p.atmTop + 60) {
                dt = Math.min(dt, .9);
                const rvx = vx - eph.plVx[i], rvy = vy - eph.plVy[i], rvz = vz - eph.plVz[i];
                const aD = DRAG_CD * p.atmD0 * Math.exp(-Math.max(0, gap) / p.atmH) * Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
                if (aD > 1e-6) dt = Math.min(dt, .05 / aD);
            }
        }
    }
    for (const star of gravityStarsFor(eph.earthX + x, eph.earthY + y, z)) {
        const sx = star.x - eph.earthX, sy = star.y - eph.earthY;
        const sz = star.z || 0;
        const dx = x - sx, dy = y - sy, dz = z - sz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < star.R * star.R * 400) {
            const d = Math.sqrt(d2);
            const tStar = Math.sqrt(d * d2 / star.mu) / 90;
            if (tStar < dt) dt = tStar;
            const gap = d - star.R;
            if (gap < star.R * 20) dt = Math.min(dt, Math.max(.5, .2 * Math.max(200, gap) / Math.max(.01, vTot)));
        }
    }
    let floor = 0.02;
    for (let i = 0; i < BH.n; i++) {
        const dx = x - BH.x[i], dy = y - BH.y[i], dz = z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const d = Math.sqrt(d2);
        const tB = Math.sqrt(d * d2 / BH.mu[i]) / 60;
        if (tB < dt) dt = tB;
        const gap = d - BH.rs[i];
        if (gap < BH.rs[i] * 80) {
            // bullet-time: never jump across the photon sphere in one step
            const lim = Math.max(1e-7, .15 * Math.max(0, gap) / Math.max(.01, vTot));
            if (lim < dt) dt = lim;
            floor = 1e-7;
        }
    }
    return Math.max(floor, Math.min(180, dt));
}

// dominant-body osculating orbit
export function orbitInfo() {
    moonState(G.t, _m);
    const rE = Math.hypot(G.x, G.y, G.z);
    const dxm = G.x - _m.mx, dym = G.y - _m.my, dzm = G.z - eph.moonZ;
    const rM = Math.hypot(dxm, dym, dzm);
    updEphem(G.t);
    const sdx = G.x - eph.sunX, sdy = G.y - eph.sunY, sdz = G.z - eph.sunZ;
    const rS = Math.hypot(sdx, sdy, sdz);
    let pNear = -1, pNearD = Infinity;
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const d = Math.hypot(G.x - eph.plX[i], G.y - eph.plY[i], G.z - eph.plZ[i]);
        if (d < pNearD) { pNearD = d; pNear = i; }
    }
    let domMoon = !WORLD.moonDestroyed && rM < SOI_M;
    let domPl = !domMoon && pNear >= 0 && pNearD < PL[pNear].soi;
    let domSun = !WORLD.sunDestroyed && !domMoon && !domPl && (WORLD.earthDestroyed || rE > SOI_E);
    let domStar = false, domSysPlanet = false, star = null, sysPlanet = null, sysPlanetIndex = -1, sysStarId = "", bh = false, rs = 0;
    let mu, rx, ry, rz, rvx, rvy, rvz, R, body;
    // moonState/planetVel are 2-D-only helpers (ephemeris.js, read-only this
    // wave); Vz for the Moon/planets/Sun comes straight off eph.*Vz instead.
    if (domMoon) { mu = MU_M; rx = dxm; ry = dym; rz = dzm; rvx = G.vx - _m.vmx; rvy = G.vy - _m.vmy; rvz = G.vz - eph.moonVz; R = R_MOON; body = "MOON"; }
    else if (domPl) {
        const p = PL[pNear];
        planetVel(pNear, G.t, _pv);
        mu = p.mu; rx = G.x - eph.plX[pNear]; ry = G.y - eph.plY[pNear]; rz = G.z - eph.plZ[pNear];
        rvx = G.vx - _pv.vx; rvy = G.vy - _pv.vy; rvz = G.vz - eph.plVz[pNear]; R = p.R; body = p.name;
    }
    else if (domSun) { mu = MU_S; rx = sdx; ry = sdy; rz = sdz; rvx = G.vx - eph.sunVx; rvy = G.vy - eph.sunVy; rvz = G.vz - eph.sunVz; R = sunRKmLive; body = "SUN"; }
    else if (!WORLD.earthDestroyed) { mu = MU_E; rx = G.x; ry = G.y; rz = G.z; rvx = G.vx; rvy = G.vy; rvz = G.vz; R = R_EARTH; body = "EARTH"; }
    else { mu = 1; rx = G.x; ry = G.y; rz = G.z; rvx = G.vx; rvy = G.vy; rvz = G.vz; R = 0; body = "DRIFT"; }
    const baseAcc = mu / Math.max(1, rx * rx + ry * ry + rz * rz);
    const wx = eph.earthX + G.x, wy = eph.earthY + G.y, wz = G.z;
    const starWell = stellarGravityActiveAt(wx, wy, wz) ? strongestActiveStarWell(currentGravityStars(), wx, wy, wz, baseAcc) : null;
    if (starWell?.dominant) {
        domMoon = false;
        domPl = false;
        domSun = false;
        domStar = true;
        star = starWell.star;
        mu = starWell.star.mu;
        rx = starWell.rx; ry = starWell.ry; rz = starWell.rz;
        rvx = G.vx + eph.earthVx;
        rvy = G.vy + eph.earthVy;
        rvz = G.vz;
        R = starWell.star.R;
        body = starWell.star.name;
        bh = !!starWell.star.bh;
        rs = starWell.star.rs || 0;
    }
    const sys = getCachedFocusedSystem();
    if (starWell?.star && sys?.hostStar === starWell.star) {
        const sp = dominantSystemPlanet(sys, starWell.star, { x: wx, y: wy, z: wz }, G.t);
        if (sp?.dominant) {
            domMoon = false;
            domPl = false;
            domSun = false;
            domStar = false;
            domSysPlanet = true;
            sysPlanet = sp.planet;
            sysPlanetIndex = sp.index;
            sysStarId = sys.starId;
            planetWorldState(sys, sp.index, starWell.star, G.t, _pw);
            mu = sp.planet.mu;
            rx = wx - _pw.x; ry = wy - _pw.y; rz = wz - _pw.z;
            rvx = G.vx + eph.earthVx - _pw.vx;
            rvy = G.vy + eph.earthVy - _pw.vy;
            rvz = G.vz - _pw.vz;
            R = sp.planet.radiusKm;
            body = sp.planet.name || ("P" + (sp.index + 1));
            bh = false;
            rs = 0;
        }
    }
    const r = Math.hypot(rx, ry, rz), v2 = rvx * rvx + rvy * rvy + rvz * rvz;
    const E = v2 / 2 - mu / r;
    const hx = ry * rvz - rz * rvy;
    const hy = rz * rvx - rx * rvz;
    const hz = rx * rvy - ry * rvx;
    const h2 = hx * hx + hy * hy + hz * hz;
    const e = Math.sqrt(Math.max(0, 1 + 2 * E * h2 / (mu * mu)));
    const a = -mu / (2 * E);
    let rp, ra;
    if (E < 0) { rp = a * (1 - e); ra = a * (1 + e); }
    else { rp = Math.abs(a) * (e - 1); ra = Infinity; }
    return {
        domMoon, domSun, domPl, domStar, domSysPlanet, star, sysPlanet, sysPlanetIndex, sysStarId, starNear: starWell?.star || null,
        starNearD: starWell?.d ?? Infinity, starNearAcc: starWell?.acc || 0,
        starId: starWell?.star?.id || starWell?.star?.name || "", bh, rs, pNear, pNearD, body, mu, r, rp, ra, e, E, R, rE, rM, rS,
        relV: Math.sqrt(v2), rx, ry, rz, rvx, rvy, rvz,
    };
}

// ============================ CONTACT / LANDING ============================
// A landing site is stored as (ang, uz): `ang` is the touchdown azimuth in the
// body's equatorial plane, already de-rotated against whatever spin/orbital
// angle the body carries (so it stays fixed to the ground as the body turns);
// `uz` is the z-component of the body-relative unit landing vector, i.e. the
// sine of latitude — invariant under that same de-rotation because it only
// spins the xy-projection. Pre-fix saves/landings have no `uz` and are
// equivalent to `uz: 0` (equatorial), which is what `landingUnit` defaults to.
function landingUnit(ang, uz) {
    const z = uz ?? 0;
    const ur = Math.sqrt(Math.max(0, 1 - z * z));
    return [ur * Math.cos(ang), ur * Math.sin(ang), z];
}
function handleEarthContact(s) {
    const r = Math.hypot(s[0], s[1], s[2]), f = (R_EARTH + 0.005) / r;
    s[0] *= f; s[1] *= f; s[2] *= f;
    const surfVx = -OMEGA_EARTH * s[1], surfVy = OMEGA_EARTH * s[0];
    const spd = Math.hypot(s[3] - surfVx, s[4] - surfVy, s[5]);
    if (spd < 0.35) {
        s[3] = surfVx; s[4] = surfVy; s[5] = 0;
        G.landed = { body: "earth", ang: Math.atan2(s[1], s[0]), uz: s[2] / (R_EARTH + 0.005), t0: G.t };
        G.heading = G.landed.ang;
        G.pitch = 0;
        if (G.leftHome) H.award("home");
        H.hideBanner();
    } else H.die("Hit Earth at " + spd.toFixed(2) + " km/s");
}
function handleMoonContact(s) {
    moonState(G.t, _m);
    let dx = s[0] - _m.mx, dy = s[1] - _m.my, dz = s[2] - eph.moonZ;
    const r = Math.hypot(dx, dy, dz), f = (R_MOON + 0.003) / r;
    dx *= f; dy *= f; dz *= f;
    s[0] = _m.mx + dx; s[1] = _m.my + dy; s[2] = eph.moonZ + dz;
    const relSpd = Math.hypot(s[3] - _m.vmx, s[4] - _m.vmy, s[5] - eph.moonVz);
    if (relSpd < 0.12) {
        G.landed = { body: "moon", ang: Math.atan2(dy, dx) - _m.ang, uz: dz / (R_MOON + 0.003) };
        G.heading = Math.atan2(dy, dx);
        G.pitch = 0;
        s[2] = eph.moonZ + dz; s[3] = _m.vmx; s[4] = _m.vmy; s[5] = eph.moonVz;
        H.award("landM");
        H.banner("LUNAR LANDING", "Touched down at " + (relSpd * 1000).toFixed(0) + " m/s · MET " + fmtMET(G.t), "W TO LIFT OFF · R TO RESTART");
    } else H.die("Hit the Moon at " + relSpd.toFixed(2) + " km/s");
}
function handlePlanetContact(s, i) {
    const p = PL[i];
    let dx = s[0] - eph.plX[i], dy = s[1] - eph.plY[i], dz = s[2] - eph.plZ[i];
    const r = Math.hypot(dx, dy, dz), f = (p.R + 0.01) / r;
    dx *= f; dy *= f; dz *= f;
    s[0] = eph.plX[i] + dx; s[1] = eph.plY[i] + dy; s[2] = eph.plZ[i] + dz;
    planetVel(i, G.t, _pv);
    const rel = Math.hypot(s[3] - _pv.vx, s[4] - _pv.vy, s[5] - eph.plVz[i]);
    if (p.gas) {
        G.x = s[0]; G.y = s[1]; G.z = s[2]; G.vx = s[3]; G.vy = s[4]; G.vz = s[5];
        H.die("Crushed in " + p.name + "'s atmosphere at " + rel.toFixed(1) + " km/s");
        return;
    }
    if (rel < 0.3) {
        G.landed = { body: "planet", i, ang: Math.atan2(dy, dx), uz: dz / (p.R + 0.01) };
        G.heading = Math.atan2(dy, dx);
        G.pitch = 0;
        s[2] = eph.plZ[i] + dz; s[3] = _pv.vx; s[4] = _pv.vy; s[5] = eph.plVz[i];
        if (p.name === "MARS") H.award("mars");
        H.banner("LANDED ON " + p.name, "Touchdown at " + (rel * 1000).toFixed(0) + " m/s · MET " + fmtMET(G.t), "W TO LIFT OFF · R TO RESTART");
    } else H.die("Hit " + p.name + " at " + rel.toFixed(2) + " km/s");
}
function handleSystemPlanetContact(s, sys, planetIndex, hostStar) {
    const p = sys?.planets?.[planetIndex];
    if (!p || !planetWorldState(sys, planetIndex, hostStar, G.t, _pwSnap)) return;
    let dx = eph.earthX + s[0] - _pwSnap.x, dy = eph.earthY + s[1] - _pwSnap.y, dz = s[2] - _pwSnap.z;
    const eps = 0.01;
    const r = Math.hypot(dx, dy, dz) || 1, f = (p.radiusKm + eps) / r;
    dx *= f; dy *= f; dz *= f;
    s[0] = _pwSnap.x + dx - eph.earthX; s[1] = _pwSnap.y + dy - eph.earthY; s[2] = _pwSnap.z + dz;
    const rel = Math.hypot(s[3] + eph.earthVx - _pwSnap.vx, s[4] + eph.earthVy - _pwSnap.vy, s[5] - _pwSnap.vz);
    const name = p.name || ("P" + (planetIndex + 1));
    if (p.gas) {
        G.x = s[0]; G.y = s[1]; G.z = s[2]; G.vx = s[3]; G.vy = s[4]; G.vz = s[5];
        H.die("Crushed in " + name + "'s atmosphere at " + rel.toFixed(1) + " km/s");
        return;
    }
    if (rel < 0.3) {
        G.landed = { body: "sysplanet", starId: sys.starId, i: planetIndex, ang: Math.atan2(dy, dx), uz: dz / (p.radiusKm + eps) };
        G.heading = Math.atan2(dy, dx);
        G.pitch = 0;
        s[3] = _pwSnap.vx - eph.earthVx; s[4] = _pwSnap.vy - eph.earthVy; s[5] = _pwSnap.vz;
        H.banner("LANDED ON " + name, "Touchdown at " + (rel * 1000).toFixed(0) + " m/s · MET " + fmtMET(G.t), "W TO LIFT OFF · R TO RESTART");
    } else H.die("Hit " + name + " at " + rel.toFixed(2) + " km/s");
}
export function snapLanded() {
    if (!G.landed) return;
    if (G.landed.body === "earth") {
        const r = R_EARTH + 0.005;
        const th = G.landed.ang + OMEGA_EARTH * (G.t - (G.landed.t0 ?? G.t));
        const [ux, uy, uz] = landingUnit(th, G.landed.uz);
        G.x = r * ux; G.y = r * uy; G.z = r * uz;
        G.vx = -OMEGA_EARTH * G.y; G.vy = OMEGA_EARTH * G.x; G.vz = 0;
    } else if (G.landed.body === "planet") {
        const i = G.landed.i, r = PL[i].R + 0.01;
        updEphem(G.t);
        const [ux, uy, uz] = landingUnit(G.landed.ang, G.landed.uz);
        G.x = eph.plX[i] + r * ux;
        G.y = eph.plY[i] + r * uy; G.z = eph.plZ[i] + r * uz;
        planetVel(i, G.t, _pv);
        G.vx = _pv.vx; G.vy = _pv.vy; G.vz = eph.plVz[i];
    } else if (G.landed.body === "sysplanet") {
        const sys = getCachedFocusedSystem();
        const star = sys?.hostStar;
        const p = sys?.starId === G.landed.starId ? sys.planets?.[G.landed.i] : null;
        if (!star || !p || !planetWorldState(sys, G.landed.i, star, G.t, _pwSnap)) {
            if (!warnedLostSysPlanetLanding) {
                warnedLostSysPlanetLanding = true;
                console.warn("procedural planet landing lost focused system", G.landed);
            }
            G.landed = null;
            return;
        }
        const r = p.radiusKm + 0.01;
        const [ux, uy, uz] = landingUnit(G.landed.ang, G.landed.uz);
        G.x = _pwSnap.x + r * ux - eph.earthX;
        G.y = _pwSnap.y + r * uy - eph.earthY;
        G.z = _pwSnap.z + r * uz;
        G.vx = _pwSnap.vx - eph.earthVx; G.vy = _pwSnap.vy - eph.earthVy; G.vz = _pwSnap.vz;
    } else {
        moonState(G.t, _m);
        const th = _m.ang + G.landed.ang, r = R_MOON + 0.003;
        const [ux, uy, uz] = landingUnit(th, G.landed.uz);
        const X = r * ux, Y = r * uy;
        G.x = _m.mx + X; G.y = _m.my + Y; G.z = eph.moonZ + r * uz;
        G.vx = _m.vmx - _m.om * Y;
        G.vy = _m.vmy + _m.om * X; G.vz = eph.moonVz;
    }
}

// ============================ INTEGRATION ============================
const _gs = [0, 0, 0, 0, 0, 0];
const _bhKick = [0, 0, 0];
const _saveG = [0, 0, 0, 0, 0, 0, 0];
const _cosA0 = [0, 0, 0], _cosA1 = [0, 0, 0], _cosTmp = [0, 0, 0];
const STELLAR_GRAVITY_MIN_R2 = STELLAR_GRAVITY_MIN_R * STELLAR_GRAVITY_MIN_R;
function stellarGravityActiveAt(wx, wy, wz) {
    return wx * wx + wy * wy + wz * wz >= STELLAR_GRAVITY_MIN_R2;
}
function cosmologyVisibilityAt(x, y, z) {
    let vis = G.darkEnergy ? darkEnergyVisibleFractionKm(Math.hypot(x, y, z)) : 0;
    if (G.darkMatter) {
        const s = equatorialKmToGal(eph.earthX + x, eph.earthY + y, z);
        const e = equatorialKmToGal(eph.earthX, eph.earthY, 0);
        vis = Math.max(vis, darkMatterVisibleFractionPc(Math.hypot(s[0] - e[0], s[1] - e[1], s[2] - e[2])));
    }
    return vis;
}
function smoothCosmologyAccelAt(x, y, z, out) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    if (G.darkEnergy) darkEnergyAccel(x, y, out, undefined, z);
    if (G.darkMatter) {
        darkMatterRelativeAccel(x, y, z, eph.earthX, eph.earthY, 0, _cosTmp);
        out[0] += _cosTmp[0]; out[1] += _cosTmp[1]; out[2] += _cosTmp[2];
    }
    return out;
}
function cosmologyJumpLocalClear(x0, y0, z0, x1, y1, z1, dt) {
    if (!WORLD.earthDestroyed && segmentSphereHit(x0, y0, z0, x1, y1, z1, Math.max(SOI_E, R_EARTH + ATM_TOP))) return false;
    if (!WORLD.moonDestroyed && segmentSphereHit(x0, y0, z0, x1, y1, z1, A_MOON + SOI_M)) return false;
    if (!WORLD.sunDestroyed && segmentSphereHit(x0, y0, z0, x1, y1, z1, AU_KM + 3 * sunRKmLive)) return false;
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const p = PL[i];
        if (segmentSphereHit(x0, y0, z0, x1, y1, z1, AU_KM + p.a + p.soi)) return false;
    }
    for (let i = 0; i < BH.n; i++) {
        const xBH1 = BH.x[i] + BH.vx[i] * dt, yBH1 = BH.y[i] + BH.vy[i] * dt;
        const lim = Math.max(BH.rs[i] * 150, 5000);
        if (segmentSphereHit(x0 - BH.x[i], y0 - BH.y[i], z0, x1 - xBH1, y1 - yBH1, z1, lim)) return false;
    }
    return true;
}
function cosmologyJumpClear(x0, y0, z0, x1, y1, z1, dt = 0) {
    if (bodiesNeedFlush(x0, y0, z0, 0) || bodiesNeedFlush(x1, y1, z1, 0)) return false;
    if (!cosmologyJumpLocalClear(x0, y0, z0, x1, y1, z1, dt)) return false;
    for (const star of ACTIVE_STARS) {
        const sx = star.x - eph.earthX, sy = star.y - eph.earthY, sz = star.z || 0;
        const radius = star.bh ? Math.max(star.rs * 1.5, star.R) : star.R;
        if (segmentSphereHit(x0 - sx, y0 - sy, z0 - sz, x1 - sx, y1 - sy, z1 - sz, radius)) return false;
    }
    return true;
}
function stellarContactRadius(star) {
    return star?.bh ? Math.max(star.rs * 1.5, star.R) : star?.R || 0;
}
function osculatingPeriapsis(rx, ry, rz, rvx, rvy, rvz, mu) {
    const r = Math.hypot(rx, ry, rz);
    if (r <= 0 || mu <= 0) return 0;
    const v2 = rvx * rvx + rvy * rvy + rvz * rvz;
    const E = v2 / 2 - mu / r;
    const hx = ry * rvz - rz * rvy;
    const hy = rz * rvx - rx * rvz;
    const hz = rx * rvy - ry * rvx;
    const h2 = hx * hx + hy * hy + hz * hz;
    if (h2 <= 0) return 0;
    if (Math.abs(E) < 1e-18) return h2 / (2 * mu);
    const e = Math.sqrt(Math.max(0, 1 + 2 * E * h2 / (mu * mu)));
    const a = -mu / (2 * E);
    return E < 0 ? a * (1 - e) : Math.abs(a) * (e - 1);
}
function stellarJumpClear(star, x0, y0, z0, x1, y1, z1, rp) {
    if (!star) return false;
    const radius = stellarContactRadius(star);
    if (rp <= radius * 1.1) return false;
    if (Math.hypot(x0, y0, z0) <= radius * 1.1 || Math.hypot(x1, y1, z1) <= radius * 1.1) return false;
    return !segmentSphereHit(x0, y0, z0, x1, y1, z1, radius);
}
function cosmologyJumpStarClear(x1, y1, z1) {
    const oi = orbitInfo();
    if (oi.domStar && oi.star) {
        const sx = oi.star.x - eph.earthX, sy = oi.star.y - eph.earthY, sz = oi.star.z || 0;
        if (!stellarJumpClear(oi.star, oi.rx, oi.ry, oi.rz || 0, x1 - sx, y1 - sy, z1 - sz, oi.rp)) return false;
    }
    const wx = eph.earthX + G.x, wy = eph.earthY + G.y, wz = G.z;
    const well = stellarGravityActiveAt(wx, wy, wz) ? strongestActiveStarWell(currentGravityStars(), wx, wy, wz, 0, 2) : null;
    if (well?.star && well.star !== oi.star) {
        const rvx = G.vx + eph.earthVx, rvy = G.vy + eph.earthVy, rvz = G.vz;
        const rp = osculatingPeriapsis(well.rx, well.ry, well.rz, rvx, rvy, rvz, well.star.mu);
        const sx = well.star.x - eph.earthX, sy = well.star.y - eph.earthY, sz = well.star.z || 0;
        if (!stellarJumpClear(well.star, well.rx, well.ry, well.rz, x1 - sx, y1 - sy, z1 - sz, rp)) return false;
    }
    return true;
}
function shipCosmologyJump(dt) {
    if (dt <= 1e-9 || cosmologyVisibilityAt(G.x, G.y, G.z) <= .01) return 0;
    smoothCosmologyAccelAt(G.x, G.y, G.z, _cosA0);
    const hvx = G.vx + _cosA0[0] * dt * .5;
    const hvy = G.vy + _cosA0[1] * dt * .5;
    const hvz = G.vz + _cosA0[2] * dt * .5;
    const nx = G.x + hvx * dt;
    const ny = G.y + hvy * dt;
    const nz = G.z + hvz * dt;
    if (!cosmologyJumpStarClear(nx, ny, nz)) return 0;
    if (!cosmologyJumpClear(G.x, G.y, G.z, nx, ny, nz, dt)) return 0;
    advanceEphem(dt);
    bhAdvance(dt, G.t);
    G.t += dt;
    smoothCosmologyAccelAt(nx, ny, nz, _cosA1);
    G.x = nx; G.y = ny; G.z = nz;
    G.vx = hvx + _cosA1[0] * dt * .5;
    G.vy = hvy + _cosA1[1] * dt * .5;
    G.vz = hvz + _cosA1[2] * dt * .5;
    return dt;
}
// Inside any of these zones the ephemeris must be exact (contact checks, SOI
// dynamics, bullet time); outside, the ship integrates on extrapolated body
// positions and the n-body system advances in EPH_CHUNK batches.
function bodiesNeedFlush(x, y, z, lag) {
    if (!WORLD.moonDestroyed) {
        const dx = x - (eph.moonX + eph.moonVx * lag), dy = y - (eph.moonY + eph.moonVy * lag), dz = z - (eph.moonZ + eph.moonVz * lag);
        if (dx * dx + dy * dy + dz * dz < SOI_M * SOI_M) return true;
    }
    if (!WORLD.sunDestroyed) {
        const dx = x - (eph.sunX + eph.sunVx * lag), dy = y - (eph.sunY + eph.sunVy * lag), dz = z - (eph.sunZ + eph.sunVz * lag);
        if (dx * dx + dy * dy + dz * dz < 9 * sunRKmLive * sunRKmLive) return true;
    }
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const dx = x - (eph.plX[i] + eph.plVx[i] * lag), dy = y - (eph.plY[i] + eph.plVy[i] * lag), dz = z - (eph.plZ[i] + eph.plVz[i] * lag);
        if (dx * dx + dy * dy + dz * dz < PL[i].soi * PL[i].soi) return true;
    }
    for (let i = 0; i < BH.n; i++) {
        const dx = x - (BH.x[i] + BH.vx[i] * lag), dy = y - (BH.y[i] + BH.vy[i] * lag), dz = z;
        const lim = Math.max(BH.rs[i] * 150, 5000);
        if (dx * dx + dy * dy + dz * dz < lim * lim) return true;
    }
    for (const star of gravityStarsFor(eph.earthX + x, eph.earthY + y, z)) {
        const sx = star.x - (eph.earthX + eph.earthVx * lag);
        const sy = star.y - (eph.earthY + eph.earthVy * lag);
        const sz = star.z || 0;
        const dx = x - sx, dy = y - sy, dz = z - sz;
        const lim = star.R * 25;
        if (dx * dx + dy * dy + dz * dz < lim * lim) return true;
    }
    return false;
}
function markAdvancePerf(t0, simAdv, advanced, stats) {
    if (stats && stats.dtMin === Infinity) stats.dtMin = 0;
    if (PERF.enabled) markPerf("physics.advance", performance.now() - t0, { simAdv, advanced, ...stats });
    return advanced;
}
export function advance(simAdv, atx, aty, atz, aMag) {
    const perfOn = PERF.enabled;
    const perfT0 = perfOn ? performance.now() : 0;
    const perfStats = perfOn ? {
        steps: 0,
        flushes: 0,
        flushChecks: 0,
        starContactChecks: 0,
        dtMin: Infinity,
        dtMax: 0,
        jump: "none",
    } : null;
    if (simAdv < 0) { atx = 0; aty = 0; atz = 0; aMag = 0; }
    let adv = simAdv, steps = 0, lag = 0;
    const s = _gs;
    s[0] = G.x; s[1] = G.y; s[2] = G.z; s[3] = G.vx; s[4] = G.vy; s[5] = G.vz;
    updEphem(G.t);
    refreshActiveStars(eph.earthX + s[0], eph.earthY + s[1], s[2], G.focus);
    // WP23b: refresh the Sun's evolving state once per frame (Gyr-scale
    // slow — no need to recompute per RK4 substep) and engulf any inner
    // planet the growing giant has swallowed.
    sunLive = sunStateAt(G.t);
    sunRKmLive = sunLive.R_Rsun * R_SUN;
    checkSunEngulfment(sunMaxRadiusReachedRsunAt(G.t) * R_SUN);
    // Hour/s+ warp can ask for dozens of local RK4 substeps in one browser
    // frame. If the coast is safely conic, bridge it in O(1) so rendering
    // and HUD cadence stay smooth while the clock keeps its requested rate.
    // Destruction flags must not gate the jump: the guarded paths are
    // internally destruction-aware, and a permanently-closed gate froze deep
    // warp forever after the Sun engulfed Earth (BUG D).
    if (!G.dead && !G.landed && aMag === 0 && GS.length === 0) {
        const rE0 = Math.hypot(s[0], s[1], s[2]);
        const dm0 = Math.hypot(s[0] - eph.moonX, s[1] - eph.moonY, s[2] - eph.moonZ);
        const ds0 = Math.hypot(s[0] - eph.sunX, s[1] - eph.sunY, s[2] - eph.sunZ);
        const dt0 = stepSize(rE0, dm0, ds0, rE0 - R_EARTH, Math.hypot(s[3], s[4], s[5]), s[0], s[1], s[2], s[3], s[4], s[5]);
        if (perfStats) perfStats.dtMax = Math.max(perfStats.dtMax, dt0);
        const frameBridge = Math.abs(G.warp) > 600 && Math.abs(simAdv) > Math.max(18, dt0 * 8);
        // reverse uses the reversible stepped/Kepler path only; deep-time analytic jumps are forward-only.
        if (simAdv > 0 && (frameBridge || Math.abs(simAdv) > MAX_STEPS_FRAME * dt0)) {
            if (BH.n === 0 && shipCosmologyJump(simAdv) > 0) {
                if (perfStats) perfStats.jump = frameBridge ? "cosmology-frame" : "cosmology-full";
                return markAdvancePerf(perfT0, simAdv, simAdv, perfStats || {});
            }
            if (BH.n === 0 && shipDeepJump(simAdv) > 0) {
                if (perfStats) perfStats.jump = frameBridge ? "kepler-frame" : "deep-full";
                return markAdvancePerf(perfT0, simAdv, simAdv, perfStats || {});
            }
            if (BH.n > 0) {
                const jumped = tryBHBridgeJump(simAdv);
                if (jumped > 0) {
                    if (perfStats) perfStats.jump = frameBridge ? "bh-bridge-frame" : "bh-bridge-full";
                    return markAdvancePerf(perfT0, simAdv, jumped, perfStats || {});
                }
            }
        }
    }
    while (Math.abs(adv) > 1e-9 && steps < MAX_STEPS_FRAME && !G.dead && !G.landed) {
        const rE = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
        const dmx = s[0] - (eph.moonX + eph.moonVx * lag), dmy = s[1] - (eph.moonY + eph.moonVy * lag), dmz = s[2] - (eph.moonZ + eph.moonVz * lag);
        const rM = Math.sqrt(dmx * dmx + dmy * dmy + dmz * dmz);
        const dsx = s[0] - (eph.sunX + eph.sunVx * lag), dsy = s[1] - (eph.sunY + eph.sunVy * lag), dsz = s[2] - (eph.sunZ + eph.sunVz * lag);
        const rS = Math.sqrt(dsx * dsx + dsy * dsy + dsz * dsz);
        const vTot = Math.sqrt(s[3] * s[3] + s[4] * s[4] + s[5] * s[5]);
        const mag = Math.min(stepSize(rE, rM, rS, rE - R_EARTH, vTot, s[0], s[1], s[2], s[3], s[4], s[5]), Math.abs(adv));
        const dt = Math.sign(adv) * mag;
        if (perfStats) {
            perfStats.dtMin = Math.min(perfStats.dtMin, mag);
            perfStats.dtMax = Math.max(perfStats.dtMax, mag);
        }
        rk4Step(s, lag, dt, atx, aty, atz);
        G.t += dt; adv -= dt; lag += dt; steps++;
        if (aMag > 0) {
            const dv = aMag * dt * 1000;
            G.dvUsed += dv;
            if (!G.infinite) {
                G.fuel -= dv;
                if (G.fuel <= 0) { G.fuel = 0; atx = 0; aty = 0; atz = 0; aMag = 0; }
            }
        }
        let shouldFlush = Math.abs(lag) >= EPH_CHUNK || Math.abs(adv) <= 1e-9 || steps >= MAX_STEPS_FRAME;
        if (!shouldFlush) {
            if (perfStats) perfStats.flushChecks++;
            shouldFlush = bodiesNeedFlush(s[0], s[1], s[2], lag);
        }
        if (shouldFlush) {
            if (perfStats) perfStats.flushes++;
            advanceEphem(lag);
            bhAdvance(lag, G.t); // holes free-fall in sync with the ship
            lag = 0;
        }
        // Earth sits at the frame origin: its contact check is always exact
        if (!WORLD.earthDestroyed && Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]) <= R_EARTH) { handleEarthContact(s); break; }
        const contactStars = gravityStarsFor(eph.earthX + s[0], eph.earthY + s[1], s[2]);
        if (contactStars.length) {
            let hitStar = null;
            for (const star of contactStars) {
                if (perfStats) perfStats.starContactChecks++;
                const sx = star.x - (eph.earthX + eph.earthVx * lag);
                const sy = star.y - (eph.earthY + eph.earthVy * lag);
                const sz = star.z || 0;
                if (Math.hypot(s[0] - sx, s[1] - sy, s[2] - sz) <= star.R) { hitStar = star; break; }
            }
            if (hitStar) {
                G.x = s[0]; G.y = s[1]; G.z = s[2]; G.vx = s[3]; G.vy = s[4]; G.vz = s[5];
                H.die(hitStar.bh
                    ? "Crossed " + hitStar.name + "'s photon sphere; captured into the boundary flow"
                    : "Entered " + hitStar.name + "'s photosphere", hitStar.bh);
                break;
            }
        }
        // every other surface lies deep inside a flush zone, so these checks
        // only need to run when the ephemeris is fresh
        if (Math.abs(lag) > 0) continue;
        if (!WORLD.moonDestroyed && Math.hypot(s[0] - eph.moonX, s[1] - eph.moonY, s[2] - eph.moonZ) <= R_MOON) { handleMoonContact(s); break; }
        if (!WORLD.sunDestroyed && Math.hypot(s[0] - eph.sunX, s[1] - eph.sunY, s[2] - eph.sunZ) <= sunRKmLive) {
            G.x = s[0]; G.y = s[1]; G.z = s[2]; G.vx = s[3]; G.vy = s[4]; G.vz = s[5];
            H.die(sunLive.phase === "WD" ? "Vaporized on the white dwarf's surface" : "Vaporized in the solar photosphere");
            break;
        }
        let hitP = -1;
        for (let i = 0; i < PL.length; i++)
            if (!WORLD.plDestroyed[i] && Math.hypot(s[0] - eph.plX[i], s[1] - eph.plY[i], s[2] - eph.plZ[i]) <= PL[i].R) { hitP = i; break; }
        if (hitP >= 0) { handlePlanetContact(s, hitP); break; }
        const sys = getCachedFocusedSystem();
        if (sys?.hostStar && sys.planets?.length) {
            const wx = eph.earthX + s[0], wy = eph.earthY + s[1], wz = s[2];
            let hitSysP = -1;
            for (const p of sys.planets) {
                planetWorldState(sys, p.index, sys.hostStar, G.t, _pw);
                if (Math.hypot(wx - _pw.x, wy - _pw.y, wz - _pw.z) <= p.radiusKm) { hitSysP = p.index; break; }
            }
            if (hitSysP >= 0) { handleSystemPlanetContact(s, sys, hitSysP, sys.hostStar); break; }
        }
        for (let i = 0; i < BH.n; i++) {
            const dBH = Math.hypot(s[0] - BH.x[i], s[1] - BH.y[i], s[2]);
            if (dBH <= BH.rs[i]) {
                G.x = s[0]; G.y = s[1]; G.z = s[2]; G.vx = s[3]; G.vy = s[4]; G.vz = s[5];
                H.award("bh");
                H.die("Crossed the event horizon; no signal returns", true);
                break;
            }
            if (dBH <= BH.rs[i] * 1.5) {
                G.x = s[0]; G.y = s[1]; G.z = s[2]; G.vx = s[3]; G.vy = s[4]; G.vz = s[5];
                H.award("bh");
                H.die("Crossed the photon sphere; captured into the black-hole boundary flow", true);
                break;
            }
        }
        if (G.dead) break;
    }
    if (perfStats) perfStats.steps = steps;
    if (Math.abs(lag) > 0) { advanceEphem(lag); bhAdvance(lag, G.t); }
    G.x = s[0]; G.y = s[1]; G.z = s[2]; G.vx = s[3]; G.vy = s[4]; G.vz = s[5];
    // deep-time remainder: at warps the per-frame RK4 budget cannot cover,
    // the ship rides its osculating two-body orbit while the ephemeris
    // Kepler-jumps the same span, keeping the commanded clock rate at every
    // scale.
    // Destruction flags must not gate the jump (see the frame-bridge gate
    // above): a permanently-closed gate froze deep warp after Earth's
    // engulfment (BUG D).
    if (adv > 1e-9 && !G.dead && !G.landed && aMag === 0 &&
        GS.length === 0) {
        if (BH.n === 0) {
            const cosJump = shipCosmologyJump(adv);
            if (cosJump > 0) {
                adv -= cosJump;
                if (perfStats) perfStats.jump = "cosmology-tail";
            } else {
                const deepJump = shipDeepJump(adv);
                if (deepJump > 0) {
                    adv -= deepJump;
                    if (perfStats) perfStats.jump = "deep-tail";
                }
            }
        }
        else {
            let guard = 0;
            while (adv > 1e-9 && guard++ < 24 && !G.dead && !G.landed) {
                const jumped = tryBHBridgeJump(adv);
                if (jumped <= 1e-9) break;
                adv -= jumped;
                if (perfStats) perfStats.jump = "bh-bridge-tail";
            }
        }
    }
    const rE = Math.sqrt(G.x * G.x + G.y * G.y + G.z * G.z);
    G.maxRE = Math.max(G.maxRE, rE);
    if (rE > 100000) G.leftHome = true;
    if (perfStats && perfStats.dtMin === Infinity) perfStats.dtMin = 0;
    return markAdvancePerf(perfT0, simAdv, simAdv - adv, perfStats || {});
}

function bhAccelAtShip(tau, out) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    const tEval = EPHT.t + tau;
    for (let i = 0; i < BH.n; i++) {
        const bx = BH.x[i] + BH.vx[i] * tau, by = BH.y[i] + BH.vy[i] * tau;
        const dx = G.x - bx, dy = G.y - by, dz = G.z;
        const r = Math.hypot(dx, dy, dz);
        if (r > 1e-9) {
            const mu = bhMuAt(i, G.x, G.y, G.z, tEval);
            if (mu > 0) {
                const eff = Math.max(r - BH.rs[i], BH.rs[i] * .02);
                const am = mu / (eff * eff) / r;
                out[0] -= dx * am;
                out[1] -= dy * am;
                out[2] -= dz * am;
            }
        }
        if (!WORLD.earthDestroyed) {
            const r0 = Math.hypot(bx, by);
            const mu0 = bhMuAt(i, 0, 0, 0, tEval);
            if (r0 > 1e-9 && mu0 > 0) {
                const eff0 = Math.max(r0 - BH.rs[i], BH.rs[i] * .02);
                const am0 = mu0 / (eff0 * eff0) / r0;
                out[0] -= bx * am0;
                out[1] -= by * am0;
            }
        }
    }
    return out;
}

function bhBridgeWindow(dt) {
    if (!BH.n || GS.length || WORLD.sunDestroyed || WORLD.earthDestroyed) return 0;
    const oi = orbitInfo();
    const domAcc = Math.max(1e-18, oi.mu / Math.max(1, oi.r * oi.r));
    const shipSpeed = Math.max(.05, Math.hypot(G.vx, G.vy, G.vz));
    let maxDt = dt;
    let strongest = 0;
    for (let i = 0; i < BH.n; i++) {
        const dx = G.x - BH.x[i], dy = G.y - BH.y[i], dz = G.z;
        const d = Math.hypot(dx, dy, dz);
        const danger = Math.max(BH.rs[i] * 240, 5000);
        if (d < danger) return 0;
        const eff = Math.max(d - BH.rs[i], BH.rs[i] * .02);
        const a = BH.mu[i] / Math.max(1e-18, eff * eff);
        strongest = Math.max(strongest, a);
        const rvx = G.vx - BH.vx[i], rvy = G.vy - BH.vy[i], rvz = G.vz;
        const closing = -(dx * rvx + dy * rvy + dz * rvz) / Math.max(d, 1e-9);
        if (closing > .01) maxDt = Math.min(maxDt, Math.max(1, (d - danger) / (closing * 8)));
        maxDt = Math.min(maxDt, Math.max(1, Math.sqrt(eff * eff * Math.max(d, BH.rs[i] * .02) / BH.mu[i]) * .18));
        if (a > 1e-12) maxDt = Math.min(maxDt, Math.max(1, shipSpeed * .035 / a));
    }
    if (strongest > domAcc * .12) return 0;
    return Math.min(dt, Math.max(0, maxDt));
}

function tryBHBridgeJump(dt) {
    const jump = bhBridgeWindow(dt);
    if (jump <= 1e-9) return 0;
    _saveG[0] = G.x; _saveG[1] = G.y; _saveG[2] = G.z;
    _saveG[3] = G.vx; _saveG[4] = G.vy; _saveG[5] = G.vz; _saveG[6] = G.t;
    bhAccelAtShip(0, _bhKick);
    G.vx += _bhKick[0] * jump * .5;
    G.vy += _bhKick[1] * jump * .5;
    G.vz += _bhKick[2] * jump * .5;
    const ok = shipDeepJump(jump);
    if (ok <= 0) {
        G.x = _saveG[0]; G.y = _saveG[1]; G.z = _saveG[2];
        G.vx = _saveG[3]; G.vy = _saveG[4]; G.vz = _saveG[5]; G.t = _saveG[6];
        return 0;
    }
    bhAdvance(ok, G.t);
    bhAccelAtShip(0, _bhKick);
    G.vx += _bhKick[0] * ok * .5;
    G.vy += _bhKick[1] * ok * .5;
    G.vz += _bhKick[2] * ok * .5;
    return ok;
}

const _dj = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ok: false };
// Jump the ship dt seconds along the conic around its strongest pull and
// recompose against that body's post-jump state. Returns dt on success, 0
// when honest integration must continue: thrustless coast only, clear of
// atmospheres, periapsis above the surface, no contested three-body zone,
// and never against a hole's Paczyński–Wiita field.
export function shipDeepJump(dt) {
    const oi = orbitInfo();
    const wx = eph.earthX + G.x, wy = eph.earthY + G.y, wz = G.z;
    const domAcc = oi.mu / (oi.r * oi.r);
    const starWell = stellarGravityActiveAt(wx, wy, wz) ? strongestActiveStarWell(currentGravityStars(), wx, wy, wz, oi.domStar ? 0 : domAcc) : null;
    const starAcc = starWell?.acc || 0;
    if (oi.domStar) {
        const st = oi.star;
        if (!st || starWell?.star !== st || !starWell.dominant) return 0;
        const d = oi.r;
        if (st.bh && d < st.rs * 200) return 0;
        if (d <= st.R * 1.1) return 0;
        if (oi.rp <= stellarContactRadius(st) * 1.1) return 0;
        keplerAdvance3(oi.rx, oi.ry, oi.rz || 0, oi.rvx, oi.rvy, oi.rvz || 0, st.mu, dt, _dj);
        if (!_dj.ok) return 0;
        if (!stellarJumpClear(st, oi.rx, oi.ry, oi.rz || 0, _dj.x, _dj.y, _dj.z, oi.rp)) return 0;
        advanceEphem(dt);
        G.x = st.x + _dj.x - eph.earthX; G.y = st.y + _dj.y - eph.earthY; G.z = (st.z || 0) + _dj.z;
        G.vx = _dj.vx - eph.earthVx; G.vy = _dj.vy - eph.earthVy; G.vz = _dj.vz;
        G.t += dt;
        return dt;
    }
    if (starWell?.dominant && starAcc > domAcc) {
        // a named star owns the well; they are static, so recomposition only
        // has to undo the Earth-frame offset
        const st = starWell.star;
        const d = starWell.d;
        if (st.bh && d < st.rs * 200) return 0;
        if (d <= st.R * 1.1) return 0;
        const rp = osculatingPeriapsis(starWell.rx, starWell.ry, starWell.rz, G.vx + eph.earthVx, G.vy + eph.earthVy, G.vz, st.mu);
        if (rp <= stellarContactRadius(st) * 1.1) return 0;
        keplerAdvance3(starWell.rx, starWell.ry, starWell.rz, G.vx + eph.earthVx, G.vy + eph.earthVy, G.vz, st.mu, dt, _dj);
        if (!_dj.ok) return 0;
        if (!stellarJumpClear(st, starWell.rx, starWell.ry, starWell.rz, _dj.x, _dj.y, _dj.z, rp)) return 0;
        advanceEphem(dt);
        G.x = st.x + _dj.x - eph.earthX; G.y = st.y + _dj.y - eph.earthY; G.z = (st.z || 0) + _dj.z;
        G.vx = _dj.vx - eph.earthVx; G.vy = _dj.vy - eph.earthVy; G.vz = _dj.vz;
        G.t += dt;
        return dt;
    }
    const atmTop = oi.body === "EARTH" ? ATM_TOP : oi.domPl ? (PL[oi.pNear].atmTop || 0) : oi.domSysPlanet ? (oi.sysPlanet?.atmTop || 0) : 0;
    if (oi.r - oi.R < atmTop) return 0;     // inside the drag shell: integrate it
    if (oi.rp < oi.R + atmTop) return 0;    // orbit dips into it: let the decay/impact play out
    if (Math.abs(oi.e - 1) < 1e-4) return 0;
    if (starAcc > domAcc * .02) return 0;
    keplerAdvance3(oi.rx, oi.ry, oi.rz || 0, oi.rvx, oi.rvy, oi.rvz || 0, oi.mu, dt, _dj);
    if (!_dj.ok) return 0;
    advanceEphem(dt);
    // bx/by/bz default to 0 (world origin): EARTH/DRIFT domination has no
    // separate body offset since Earth's own world z is permanently 0 (see
    // ephemeris.js's earthZ note) and the ship state is already Earth-relative.
    let bx = 0, by = 0, bz = 0, bvx = 0, bvy = 0, bvz = 0;
    if (oi.domMoon) { bx = eph.moonX; by = eph.moonY; bz = eph.moonZ; bvx = eph.moonVx; bvy = eph.moonVy; bvz = eph.moonVz; }
    else if (oi.domPl) { bx = eph.plX[oi.pNear]; by = eph.plY[oi.pNear]; bz = eph.plZ[oi.pNear]; bvx = eph.plVx[oi.pNear]; bvy = eph.plVy[oi.pNear]; bvz = eph.plVz[oi.pNear]; }
    else if (oi.domSysPlanet) {
        const sys = getCachedFocusedSystem();
        if (!sys?.hostStar || sys.starId !== oi.sysStarId || !planetWorldState(sys, oi.sysPlanetIndex, sys.hostStar, G.t + dt, _pwSnap)) return 0;
        bx = _pwSnap.x - eph.earthX; by = _pwSnap.y - eph.earthY; bz = _pwSnap.z;
        bvx = _pwSnap.vx - eph.earthVx; bvy = _pwSnap.vy - eph.earthVy; bvz = _pwSnap.vz;
    }
    else if (oi.domSun) { bx = eph.sunX; by = eph.sunY; bz = eph.sunZ; bvx = eph.sunVx; bvy = eph.sunVy; bvz = eph.sunVz; }
    G.x = bx + _dj.x; G.y = by + _dj.y; G.z = bz + _dj.z;
    G.vx = bvx + _dj.vx; G.vy = bvy + _dj.vy; G.vz = bvz + _dj.vz;
    G.t += dt;
    return dt;
}

// ============================ AERO READOUT ============================
// strongest atmospheric interaction this instant (Earth or any planet with an
// atmosphere); drives the plasma sheath, camera shake, and HUD
export const AERO = { aD: 0, vx: 0, vy: 0, vz: 0 };
export function sampleAero() {
    AERO.aD = 0; AERO.vx = G.vx; AERO.vy = G.vy; AERO.vz = G.vz;
    if (G.dead) return AERO;
    let best = 0;
    if (!WORLD.earthDestroyed) {
        const rE = Math.sqrt(G.x * G.x + G.y * G.y + G.z * G.z), h = rE - R_EARTH;
        if (h < ATM_TOP) {
            const avx = -OMEGA_EARTH * G.y, avy = OMEGA_EARTH * G.x;
            const rvx = G.vx - avx, rvy = G.vy - avy, rvz = G.vz;
            best = DRAG_CD * Math.exp(-Math.max(0, h) / DRAG_H) * (rvx * rvx + rvy * rvy + rvz * rvz);
            AERO.vx = rvx; AERO.vy = rvy; AERO.vz = rvz;
        }
    }
    for (let i = 0; i < PL.length; i++) {
        const p = PL[i];
        if (!p.atmH || WORLD.plDestroyed[i]) continue;
        const dx = G.x - eph.plX[i], dy = G.y - eph.plY[i], dz = G.z - eph.plZ[i];
        const lim = p.R + p.atmTop;
        if (dx > lim || dx < -lim || dy > lim || dy < -lim || dz > lim || dz < -lim) continue;
        const h = Math.sqrt(dx * dx + dy * dy + dz * dz) - p.R;
        if (h >= p.atmTop) continue;
        const rvx = G.vx - eph.plVx[i], rvy = G.vy - eph.plVy[i], rvz = G.vz - eph.plVz[i];
        const aD = DRAG_CD * p.atmD0 * Math.exp(-Math.max(0, h) / p.atmH) * (rvx * rvx + rvy * rvy + rvz * rvz);
        if (aD > best) { best = aD; AERO.vx = rvx; AERO.vy = rvy; AERO.vz = rvz; }
    }
    AERO.aD = best * 1000; // m/s²
    return AERO;
}
