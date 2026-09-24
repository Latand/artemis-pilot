import {
    AU_KM, PL, A_MOON, E_MOON, OMEGA, MOON_ANG0,
    MU_E, MU_M, MU_S, C_LIGHT, BH_MAX, LY_KM, PC_KM, DARK_ENERGY, DARK_MATTER,
    I_EARTH, OM_EARTH, I_MOON, OM_MOON0, OM_MOON_RATE, OM_YEAR,
    R_EARTH, R_MOON, R_SUN,
} from "./constants.js";
import {
    G, BH, WORLD, EPHT, GS, gsPull, bhMuAt, advanceEphemClock, ephemClockLo, setEphemClock, BODY_SCALE_EARTH,
} from "./state.js";
import { Q_MIN_TDE } from "./tde.js";
import { GRAVITY_STARS } from "./universe/activeStars.js";
import { darkEnergyAccel, darkMatterRelativeAccel } from "./cosmology.js";
import { epochOffsetSeconds, meanAnomalyAdvance } from "./epoch.js";
import { moonGeocentricCartesian, sunGeometricLongitudeJ2000 } from "./universe/lunarElp.js";
import { meanElementsAt, tableKeyForPlanet, STANDISH_TABLE1, SEC_PER_JULIAN_CENTURY } from "./universe/planetElements.js";

export const IDX_MOON = 0;
export const IDX_SUN = 1;
export const IDX_PLANETS = 2;
export const NB = IDX_PLANETS + PL.length;

const bodyMu = new Float64Array(NB);
bodyMu[IDX_MOON] = MU_M;
bodyMu[IDX_SUN] = MU_S;
for (let i = 0; i < PL.length; i++) bodyMu[IDX_PLANETS + i] = PL[i].mu;

const bodyR = new Float64Array(NB);
bodyR[IDX_MOON] = R_MOON;
bodyR[IDX_SUN] = R_SUN;
for (let i = 0; i < PL.length; i++) bodyR[IDX_PLANETS + i] = PL[i].R;

function isBodyActive(i) {
    return i === IDX_MOON ? !WORLD.moonDestroyed :
        i === IDX_SUN ? !WORLD.sunDestroyed :
            !WORLD.plDestroyed[i - IDX_PLANETS];
}
// WORLD.muScale / rScale carry the surviving core of a partially disrupted
// body (index order matches the ephemeris; Earth sits at BODY_SCALE_EARTH).
function activeBodyMu(i) { return isBodyActive(i) ? bodyMu[i] * WORLD.muScale[i] : 0; }
function activeEarthMu() { return WORLD.earthDestroyed ? 0 : MU_E * WORLD.muScale[BODY_SCALE_EARTH]; }
export function liveBodyMu(i) { return activeBodyMu(i); }
export function liveBodyRadius(i) { return bodyR[i] * WORLD.rScale[i]; }
export function liveEarthMu() { return activeEarthMu(); }
export function liveEarthRadius() { return R_EARTH * WORLD.rScale[BODY_SCALE_EARTH]; }

// Hole–body pair force per unit source mass: Paczyński–Wiita outside the
// body, the enclosed-mass (uniform-sphere) law inside it, so a hole passing
// through a planet or star feels a finite, continuous pull instead of a point
// singularity at the body's centre. Returns g with accel = mu * g * (d_vec/d).
// rb = 0 (ship, photons) or a body smaller than the capture sphere: pure PW.
// Softening radius of a hole-body pair. A body the hole can tidally disrupt
// (q >= Q_MIN_TDE) is resolved by the encounter pipeline at or before its
// pericentre, so the pair stays a point pair (PW) and its conic stays
// Keplerian all the way in; only a hole too light to disrupt the body can
// genuinely pass through it, and then the enclosed-mass law applies.
export function pairRadius(bodyMu, bodyR, holeMu) {
    return holeMu < Q_MIN_TDE * bodyMu ? bodyR : 0;
}
export function pairG(d, rs, rb) {
    if (rb > 2 * rs && d < rb) {
        const e = rb - rs;
        return d / (rb * e * e);
    }
    const eff = Math.max(d - rs, rs * .02);
    return 1 / (eff * eff);
}

const bodyX = new Float64Array(NB), bodyY = new Float64Array(NB), bodyZ = new Float64Array(NB);
const bodyVx = new Float64Array(NB), bodyVy = new Float64Array(NB), bodyVz = new Float64Array(NB);
// Earth's own WORLD z/vz are permanently pinned at exactly 0 (never assigned
// a nonzero value anywhere in this file): Earth's initial osculating orbit is
// i=Om=0 BY CONSTRUCTION (constants.js), and this file treats that plane as a
// fixed reference frame for the whole run rather than letting Earth's own
// absolute trajectory precess under mutual perturbations. The Sun/Moon/planet
// arrays (Earth-RELATIVE) are not pinned — they carry real z/vz and evolve
// under full 3-D gravity, so an inclined planet genuinely perturbs the Sun's
// and Moon's Earth-relative z over time; only Earth's own world-frame z stays
// exactly 0, which is what keeps that frame usable as z=0 by every consumer
// that hasn't been updated yet (WP14 is the wave that teaches physics.js/etc.
// to read eph.*Z; until then this invariant keeps everything downstream sane).
let earthX = 0, earthY = 0, earthVx = 0, earthVy = 0;
const earthZ = 0, earthVz = 0;

// Live ephemeris cache (km, km/s). Earth has an inertial world-state; the
// other arrays are Earth-local relative states used by precision dynamics.
export const eph = {
    earthX: 0, earthY: 0, earthZ: 0, earthVx: 0, earthVy: 0, earthVz: 0,
    sunX: 0, sunY: 0, sunZ: 0, sunVx: 0, sunVy: 0, sunVz: 0,
    moonX: 0, moonY: 0, moonZ: 0, moonVx: 0, moonVy: 0, moonVz: 0,
    plX: new Float64Array(PL.length), plY: new Float64Array(PL.length), plZ: new Float64Array(PL.length),
    plVx: new Float64Array(PL.length), plVy: new Float64Array(PL.length), plVz: new Float64Array(PL.length),
};
window.__eph = eph;

function syncFromState(st = null) {
    const X = st ? st.x : bodyX, Y = st ? st.y : bodyY, Z = st ? st.z : bodyZ;
    const VX = st ? st.vx : bodyVx, VY = st ? st.vy : bodyVy, VZ = st ? st.vz : bodyVz;
    eph.earthX = st ? st.earthX : earthX; eph.earthY = st ? st.earthY : earthY;
    eph.earthZ = st ? (Number.isFinite(st.earthZ) ? st.earthZ : 0) : earthZ;
    eph.earthVx = st ? st.earthVx : earthVx; eph.earthVy = st ? st.earthVy : earthVy;
    eph.earthVz = st ? (Number.isFinite(st.earthVz) ? st.earthVz : 0) : earthVz;
    eph.moonX = X[IDX_MOON]; eph.moonY = Y[IDX_MOON]; eph.moonZ = Z ? Z[IDX_MOON] : 0;
    eph.moonVx = VX[IDX_MOON]; eph.moonVy = VY[IDX_MOON]; eph.moonVz = VZ ? VZ[IDX_MOON] : 0;
    eph.sunX = X[IDX_SUN]; eph.sunY = Y[IDX_SUN]; eph.sunZ = Z ? Z[IDX_SUN] : 0;
    eph.sunVx = VX[IDX_SUN]; eph.sunVy = VY[IDX_SUN]; eph.sunVz = VZ ? VZ[IDX_SUN] : 0;
    for (let i = 0; i < PL.length; i++) {
        const k = IDX_PLANETS + i;
        eph.plX[i] = X[k]; eph.plY[i] = Y[k]; eph.plZ[i] = Z ? Z[k] : 0;
        eph.plVx[i] = VX[k]; eph.plVy[i] = VY[k]; eph.plVz[i] = VZ ? VZ[k] : 0;
    }
}

// Two-body elements → planar state (km, km/s). Solves Kepler's equation
// M = E − e·sinE by Newton, then converts: r = a(1 − e·cosE), true anomaly ν
// from E, heliocentric angle θ = varpi + ν, and radial/tangential speeds
// vr = √(μ/p)·e·sinν, vt = √(μ/p)·(1 + e·cosν) with p = a(1 − e²). Used only
// to set initial conditions — everything then evolves under full n-body
// integration. Kept exactly as the pre-WP13 planar path (byte-for-byte) so
// keplerInit3 below can build its 3-D bit-parity guarantee on top of it
// rather than duplicating the Kepler solve.
export function keplerInit(a, e, varpi, M0, mu, out) {
    let E = M0;
    for (let i = 0; i < 8; i++)
        E -= (E - e * Math.sin(E) - M0) / (1 - e * Math.cos(E));
    const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    const r = a * (1 - e * Math.cos(E));
    const c = Math.sqrt(mu / (a * (1 - e * e)));
    const vr = c * e * Math.sin(nu), vt = c * (1 + e * Math.cos(nu));
    const th = varpi + nu, ct = Math.cos(th), st = Math.sin(th);
    out.x = r * ct; out.y = r * st;
    out.vx = vr * ct - vt * st;
    out.vy = vr * st + vt * ct;
    return out;
}

// Three-D orbital elements → Cartesian state (km, km/s). Builds the planar
// state in the "argument of periapsis" frame (x-axis toward the ascending
// node) via the UNCHANGED keplerInit above with argp = varpi − Om, then
// rotates: about x by inclination i, then about z by the node Om (the
// standard 3-1-3 perifocal→ecliptic sequence, with the first z-rotation by
// argp already folded into keplerInit's own varpi-angle rotation).
// Bit-parity guarantee: when i = Om = 0, cos(i)=cos(Om)=1 and sin(i)=sin(Om)=0
// EXACTLY (IEEE754), so y1=yo, z1=yo·0=0, and the z-rotation reduces to
// x2=x1·1−y1·0=x1, y2=x1·0+y1·1=y1 — i.e. out.{x,y,z,vx,vy,vz} equal
// keplerInit's {x,y,0,vx,vy,0} bit-for-bit, with argp having reduced to varpi
// (varpi−0 is exact). This is asserted by smoke:physics3d.
const _k3p = { x: 0, y: 0, vx: 0, vy: 0 };
export function keplerInit3(a, e, i, Om, varpi, M0, mu, out) {
    const argp = varpi - Om;
    keplerInit(a, e, argp, M0, mu, _k3p);
    const ci = Math.cos(i), si = Math.sin(i);
    const cO = Math.cos(Om), sO = Math.sin(Om);
    const y1 = _k3p.y * ci, z1 = _k3p.y * si;
    const vy1 = _k3p.vy * ci, vz1 = _k3p.vy * si;
    const x1 = _k3p.x, vx1 = _k3p.vx;
    out.x = x1 * cO - y1 * sO;
    out.y = x1 * sO + y1 * cO;
    out.z = z1;
    out.vx = vx1 * cO - vy1 * sO;
    out.vy = vx1 * sO + vy1 * cO;
    out.vz = vz1;
    return out;
}

// WP21 hook: seconds from J2000 to "now" (or the restored save's epoch).
// Never throws — a missing/broken epoch module must not break the universe,
// it just starts at J2000 (offset 0) instead of today's real date.
function safeEpochOffsetSeconds() {
    try {
        const v = epochOffsetSeconds();
        return Number.isFinite(v) ? v : 0;
    } catch { return 0; }
}

const SEC_PER_DAY = 86400;
const _kp = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const _emb = {}, _pel = {};
const _moon = { x: 0, y: 0, z: 0 }, _moon2 = { x: 0, y: 0, z: 0 };
export function resetEphem() {
    EPHT.t = 0;
    const epochOffsetSec = safeEpochOffsetSeconds();

    // Earth-Moon barycentre from JPL's J2000 mean elements (Standish Table 1,
    // planetElements.js) advanced to the epoch with the tabulated rates -- the
    // same source every planet uses, so relative planetary positions are real
    // (issue #6). The EMB orbit is the J2000 ecliptic by definition, so its
    // i = Om = 0 here keeps Earth's world z pinned at exactly 0 (see above).
    const emb = meanElementsAt("EMB", epochOffsetSec, AU_KM, _emb);
    keplerInit3(emb.a, emb.e, I_EARTH, OM_EARTH, emb.varpi, emb.M, MU_S + MU_E + MU_M, _kp);
    // Moon from truncated ELP-2000/82 (ecliptic, J2000 equinox). The sim Sun
    // and the real Sun now share one frame and one epoch, so the residual
    // rotation delta between the seeded solar longitude and Meeus's geometric
    // J2000 longitude is only the ~0.01 deg mean-element error; applying it
    // keeps Sun-Moon elongation (eclipses) exact by construction.
    const simSunLon = Math.atan2(-_kp.y, -_kp.x);
    const delta = simSunLon - sunGeometricLongitudeJ2000(epochOffsetSec);
    const dC = Math.cos(delta), dS = Math.sin(delta);
    moonGeocentricCartesian(epochOffsetSec, _moon);
    {
        const x = _moon.x, y = _moon.y;
        _moon.x = x * dC - y * dS;
        _moon.y = x * dS + y * dC;
    }
    moonGeocentricCartesian(epochOffsetSec + 60, _moon2);
    {
        const x = _moon2.x, y = _moon2.y;
        _moon2.x = x * dC - y * dS;
        _moon2.y = x * dS + y * dC;
    }
    const mvx = (_moon2.x - _moon.x) / 60, mvy = (_moon2.y - _moon.y) / 60, mvz = (_moon2.z - _moon.z) / 60;
    // Earth sits mu_M/(mu_E+mu_M) of the Earth-Moon vector away from the
    // barycentre, on the far side from the Moon (~4,670 km).
    const moonShare = MU_M / (MU_E + MU_M);
    earthX = _kp.x - moonShare * _moon.x;
    earthY = _kp.y - moonShare * _moon.y;
    earthVx = _kp.vx - moonShare * mvx;
    earthVy = _kp.vy - moonShare * mvy;
    // (Earth's world z stays pinned at 0; the Moon's ~5 deg inclination is
    // carried entirely by its Earth-relative z below.)
    bodyX[IDX_SUN] = -earthX;
    bodyY[IDX_SUN] = -earthY;
    bodyZ[IDX_SUN] = 0;
    bodyVx[IDX_SUN] = -earthVx;
    bodyVy[IDX_SUN] = -earthVy;
    bodyVz[IDX_SUN] = 0;
    const svx = bodyVx[IDX_SUN], svy = bodyVy[IDX_SUN], svz = bodyVz[IDX_SUN];
    bodyX[IDX_MOON] = _moon.x; bodyY[IDX_MOON] = _moon.y; bodyZ[IDX_MOON] = _moon.z;
    bodyVx[IDX_MOON] = mvx; bodyVy[IDX_MOON] = mvy; bodyVz[IDX_MOON] = mvz;

    // planets stored Earth-relative: Sun's Earth-relative state + heliocentric
    // state from the same Table 1 mean elements at the epoch
    for (let i = 0; i < PL.length; i++) {
        const p = PL[i];
        const k = IDX_PLANETS + i;
        const key = tableKeyForPlanet(p.name);
        if (key) {
            const el = meanElementsAt(key, epochOffsetSec, AU_KM, _pel);
            keplerInit3(el.a, el.e, el.i, el.Om, el.varpi, el.M, MU_S + p.mu, _kp);
        } else {
            const period = 2 * Math.PI / p.n;
            keplerInit3(p.a, p.e, p.i, p.Om, p.varpi, meanAnomalyAdvance(epochOffsetSec, period), MU_S, _kp);
        }
        bodyX[k] = bodyX[IDX_SUN] + _kp.x;
        bodyY[k] = bodyY[IDX_SUN] + _kp.y;
        bodyZ[k] = bodyZ[IDX_SUN] + _kp.z;
        bodyVx[k] = svx + _kp.vx;
        bodyVy[k] = svy + _kp.vy;
        bodyVz[k] = svz + _kp.vz;
    }

    // Zero the system's total (x,y) momentum. Above, the Sun's velocity was
    // set purely from the reduced Earth-Sun two-body problem (bodyVx/Vy[SUN]
    // cancels only Earth's momentum), so it omits the Sun's real reflex
    // motion from Jupiter, Saturn, and the rest — the total system momentum
    // (Sun + Earth + Moon + every planet) comes out nonzero (~9 m/s with the
    // real J2000 elements). Nothing in the n-body dynamics can dissipate a
    // nonzero total momentum, so the whole system's barycenter would coast
    // at that residual velocity forever: harmless for short runs, but a
    // deep-time warp integrates it into a multi-million-AU secular drift of
    // eph.earthX/Y (confirmed: the drift rate exactly equals this residual
    // momentum / total mass, independent of warp step size or Kepler-jump
    // chaining — this is an initial-condition defect, not an integrator one).
    // Every other body's velocity here is Earth-relative and so already
    // invariant under a uniform boost of the whole system; only Earth's own
    // world-frame velocity needs correcting to absorb it.
    {
        let Mtot = MU_S + MU_E + MU_M;
        let Px = MU_S * (earthVx + bodyVx[IDX_SUN]) + MU_E * earthVx + MU_M * (earthVx + bodyVx[IDX_MOON]);
        let Py = MU_S * (earthVy + bodyVy[IDX_SUN]) + MU_E * earthVy + MU_M * (earthVy + bodyVy[IDX_MOON]);
        for (let i = 0; i < PL.length; i++) {
            const k = IDX_PLANETS + i, mu = PL[i].mu;
            Mtot += mu;
            Px += mu * (earthVx + bodyVx[k]);
            Py += mu * (earthVy + bodyVy[k]);
        }
        earthVx -= Px / Mtot;
        earthVy -= Py / Mtot;
    }
    syncFromState();
}
export function updEphem() { syncFromState(); }
export const sunAng = () => Math.atan2(eph.sunY, eph.sunX);
export const moonAng = () => Math.atan2(eph.moonY, eph.moonX);

export function sunVel(out) {
    out.vx = eph.sunVx; out.vy = eph.sunVy;
    return out;
}
export function planetVel(i, _t, out) {
    out.vx = eph.plVx[i]; out.vy = eph.plVy[i];
    return out;
}
export function moonState(_t, out) {
    const r2 = eph.moonX * eph.moonX + eph.moonY * eph.moonY;
    out.mx = eph.moonX; out.my = eph.moonY;
    out.vmx = eph.moonVx; out.vmy = eph.moonVy;
    out.ang = Math.atan2(eph.moonY, eph.moonX);
    out.om = r2 > 0 ? (eph.moonX * eph.moonVy - eph.moonY * eph.moonVx) / r2 : OMEGA;
    return out;
}

function bodyIndexFromTarget(target) {
    return target === -2 ? IDX_MOON : target === -1 ? IDX_SUN : IDX_PLANETS + target;
}
// out.z/out.vz are new (WP13): existing callers reading only x/y/vx/vy are
// unaffected; WP15 (trails/prediction) is the intended first z consumer.
export function bodyStateForTarget(target, out, st = null) {
    if (target === -3) {
        out.x = st ? st.earthX : earthX; out.y = st ? st.earthY : earthY;
        out.z = st ? (Number.isFinite(st.earthZ) ? st.earthZ : 0) : earthZ;
        out.vx = st ? st.earthVx : earthVx; out.vy = st ? st.earthVy : earthVy;
        out.vz = st ? (Number.isFinite(st.earthVz) ? st.earthVz : 0) : earthVz;
        return out;
    }
    const k = bodyIndexFromTarget(target);
    const X = st ? st.x : bodyX, Y = st ? st.y : bodyY, Z = st ? st.z : bodyZ;
    const VX = st ? st.vx : bodyVx, VY = st ? st.vy : bodyVy, VZ = st ? st.vz : bodyVz;
    const ex = st ? st.earthX : earthX, ey = st ? st.earthY : earthY;
    const ez = st ? (Number.isFinite(st.earthZ) ? st.earthZ : 0) : earthZ;
    const evx = st ? st.earthVx : earthVx, evy = st ? st.earthVy : earthVy;
    const evz = st ? (Number.isFinite(st.earthVz) ? st.earthVz : 0) : earthVz;
    out.x = ex + X[k]; out.y = ey + Y[k]; out.z = ez + (Z ? Z[k] : 0);
    out.vx = evx + VX[k]; out.vy = evy + VY[k]; out.vz = evz + (VZ ? VZ[k] : 0);
    return out;
}

// Prediction-time black-hole extrapolation: predicted arcs span up to 160
// days, but BH.x/BH.y only hold the holes' live positions. While a prediction
// is active, gravity places hole i at snapX + snapVx·(tEval − t0) — a linear
// coast from a snapshot taken at prediction start. Covers both the snapshot
// path (advanceEphemSnapshot → leapfrogBodies) and the ship path (rk4Step calls
// relGravityAt with st = null while the live arrays hold the prediction
// state). Live integration never sets the flag, so that path is untouched.
const PRED_BH = {
    active: false, t0: 0,
    x: new Float64Array(BH_MAX), y: new Float64Array(BH_MAX), z: new Float64Array(BH_MAX),
    vx: new Float64Array(BH_MAX), vy: new Float64Array(BH_MAX), vz: new Float64Array(BH_MAX),
};

let PRED_STARS = null;
export const STELLAR_GRAVITY_MIN_R = LY_KM * .02;
const DARK_ENERGY_GRAVITY_MIN_R2 = DARK_ENERGY.VISIBLE_START_KM * DARK_ENERGY.VISIBLE_START_KM;
const DARK_MATTER_GRAVITY_MIN_R2 = Math.pow(DARK_MATTER.VISIBLE_START_PC * PC_KM, 2);
export function beginPredictionStars(stars) {
    PRED_STARS = Array.isArray(stars) ? stars : null;
}
export function endPredictionStars() {
    PRED_STARS = null;
}
export function currentGravityStars() {
    return PRED_STARS || GRAVITY_STARS;
}
export function gravityStarsFor(wx, wy, wz) {
    if (PRED_STARS) return PRED_STARS;
    return Math.hypot(wx, wy, wz) < STELLAR_GRAVITY_MIN_R ? [] : GRAVITY_STARS;
}
export function beginPredictionBH() {
    PRED_BH.t0 = EPHT.t;
    for (let i = 0; i < BH.n; i++) {
        PRED_BH.x[i] = BH.x[i]; PRED_BH.y[i] = BH.y[i]; PRED_BH.z[i] = BH.z[i];
        PRED_BH.vx[i] = BH.vx[i]; PRED_BH.vy[i] = BH.vy[i]; PRED_BH.vz[i] = BH.vz[i];
    }
    PRED_BH.active = true;
}
export function endPredictionBH() { PRED_BH.active = false; }
// extrapolated hole position at absolute sim time t (for prediction-loop
// impact checks); falls back to the live state outside predictions
export function predBHX(i, t) { return PRED_BH.active ? PRED_BH.x[i] + PRED_BH.vx[i] * (t - PRED_BH.t0) : BH.x[i]; }
export function predBHY(i, t) { return PRED_BH.active ? PRED_BH.y[i] + PRED_BH.vy[i] * (t - PRED_BH.t0) : BH.y[i]; }
export function predBHZ(i, t) { return PRED_BH.active ? PRED_BH.z[i] + PRED_BH.vz[i] * (t - PRED_BH.t0) : BH.z[i]; }

// Indirect (frame) acceleration: every body and hole pulls the Earth-centered
// origin. Identical for all field points, so callers evaluating many points
// against one state compute it once and pass it as `ind`.
const _gp = [0, 0, 0];
const _de = [0, 0, 0];
const _dm = [0, 0, 0];
export function indirectAccel(st, out, tau = 0) {
    // with Earth gone the origin coasts inertially: no frame correction at all
    if (WORLD.earthDestroyed) { out[0] = 0; out[1] = 0; if (out.length > 2) out[2] = 0; return out; }
    const X = st ? st.x : bodyX, Y = st ? st.y : bodyY, Z = st ? st.z : bodyZ;
    const VX = st ? st.vx : bodyVx, VY = st ? st.vy : bodyVy, VZ = st ? st.vz : bodyVz;
    const tEval = (st && st.t !== undefined ? st.t : EPHT.t) + tau;
    let ax = 0, ay = 0, az = 0;
    for (let i = 0; i < NB; i++) {
        const mu = activeBodyMu(i);
        if (mu <= 0) continue;
        const bx = X[i] + VX[i] * tau, by = Y[i] + VY[i] * tau, bz = Z[i] + VZ[i] * tau;
        const r02 = bx * bx + by * by + bz * bz;
        if (r02 > 1e-18) {
            const w = mu / (r02 * Math.sqrt(r02));
            ax -= w * bx;
            ay -= w * by;
            az -= w * bz;
        }
    }
    const bhDt = PRED_BH.active ? tEval - PRED_BH.t0 : tau;
    const rEarth = liveEarthRadius(), muEarth = activeEarthMu();
    for (let i = 0; i < BH.n; i++) {
        const mu0 = bhMuAt(i, 0, 0, 0, tEval);
        if (mu0 <= 0) continue;
        const rE = pairRadius(muEarth, rEarth, BH.mu[i]);
        const bx = PRED_BH.active ? PRED_BH.x[i] + PRED_BH.vx[i] * bhDt : BH.x[i] + BH.vx[i] * bhDt;
        const by = PRED_BH.active ? PRED_BH.y[i] + PRED_BH.vy[i] * bhDt : BH.y[i] + BH.vy[i] * bhDt;
        const bz = PRED_BH.active ? PRED_BH.z[i] + PRED_BH.vz[i] * bhDt : BH.z[i] + BH.vz[i] * bhDt;
        const r0 = Math.sqrt(bx * bx + by * by + bz * bz);
        if (r0 > 1e-9) {
            // the hole's pull on Earth (the frame origin), Earth's extent included
            const am0 = mu0 * pairG(r0, BH.rs[i], rE) / r0;
            ax -= bx * am0;
            ay -= by * am0;
            az -= bz * am0;
        }
    }
    const ex = st ? st.earthX : earthX, ey = st ? st.earthY : earthY;
    for (const star of gravityStarsFor(ex, ey, 0)) {
        const bx = star.x - ex, by = star.y - ey, bz = star.z || 0;
        const r0 = Math.sqrt(bx * bx + by * by + bz * bz);
        if (r0 > 1e-9) {
            const w0 = star.mu / (r0 * r0 * r0);
            ax -= w0 * bx;
            ay -= w0 * by;
            az -= w0 * bz;
        }
    }
    if (GS.length) {
        _gp[0] = 0; _gp[1] = 0; _gp[2] = 0;
        gsPull(0, 0, 0, tEval, _gp);
        ax -= _gp[0]; ay -= _gp[1]; az -= _gp[2];
    }
    out[0] = ax; out[1] = ay;
    if (out.length > 2) out[2] = az;
    return out;
}

// `tau` linearly extrapolates body/hole positions, so an RK4 stage at t+τ
// samples the field at the stage time and between ephemeris flushes.
export function relGravityAt(x, y, out, skipBody = -1, st = null, tau = 0, ind = null) {
    return relGravityAtOpt(x, y, 0, out, skipBody, st, tau, ind, true);
}
export function relGravityAt3(x, y, z, out, skipBody = -1, st = null, tau = 0, ind = null) {
    return relGravityAtOpt(x, y, z, out, skipBody, st, tau, ind, true);
}
function relGravityAtOpt(x, y, z, out, skipBody = -1, st = null, tau = 0, ind = null, includeDarkEnergy = true) {
    const X = st ? st.x : bodyX, Y = st ? st.y : bodyY, Z = st ? st.z : bodyZ;
    const VX = st ? st.vx : bodyVx, VY = st ? st.vy : bodyVy, VZ = st ? st.vz : bodyVz;
    const tEval = (st && st.t !== undefined ? st.t : EPHT.t) + tau;
    // inline indirect terms only while Earth anchors an accelerating frame
    const indir = ind === null && !WORLD.earthDestroyed;
    let ax = 0, ay = 0, az = 0;
    const muE = activeEarthMu();
    if (muE > 0) {
        const r2 = x * x + y * y + z * z;
        if (r2 > 1e-18) {
            const w = muE / (r2 * Math.sqrt(r2));
            ax -= w * x;
            ay -= w * y;
            az -= w * z;
        }
    }
    for (let i = 0; i < NB; i++) {
        const mu = activeBodyMu(i);
        if (mu <= 0) continue;
        const bx = X[i] + VX[i] * tau, by = Y[i] + VY[i] * tau, bz = Z[i] + VZ[i] * tau;
        if (i !== skipBody) {
            const dx = x - bx, dy = y - by, dz = z - bz;
            const r2 = dx * dx + dy * dy + dz * dz;
            if (r2 > 1e-18) {
                const w = mu / (r2 * Math.sqrt(r2));
                ax -= w * dx;
                ay -= w * dy;
                az -= w * dz;
            }
        }
        if (indir) {
            const r02 = bx * bx + by * by + bz * bz;
            if (r02 > 1e-18) {
                const w0 = mu / (r02 * Math.sqrt(r02));
                ax -= w0 * bx;
                ay -= w0 * by;
                az -= w0 * bz;
            }
        }
    }
    const bhDt = PRED_BH.active ? tEval - PRED_BH.t0 : tau;
    // a body feels a hole through the pair law (see pairRadius / pairG); the
    // ship is a point
    const bodyRad = skipBody >= 0 && skipBody < NB ? liveBodyRadius(skipBody) : 0;
    const bodyMuSelf = skipBody >= 0 && skipBody < NB ? activeBodyMu(skipBody) : 0;
    const rEarth = indir ? liveEarthRadius() : 0, muEarth = indir ? activeEarthMu() : 0;
    for (let i = 0; i < BH.n; i++) {
        const rb = bodyRad > 0 ? pairRadius(bodyMuSelf, bodyRad, BH.mu[i]) : 0;
        const rE = indir ? pairRadius(muEarth, rEarth, BH.mu[i]) : 0;
        const bx = PRED_BH.active ? PRED_BH.x[i] + PRED_BH.vx[i] * bhDt : BH.x[i] + BH.vx[i] * bhDt;
        const by = PRED_BH.active ? PRED_BH.y[i] + PRED_BH.vy[i] * bhDt : BH.y[i] + BH.vy[i] * bhDt;
        const bz = PRED_BH.active ? PRED_BH.z[i] + PRED_BH.vz[i] * bhDt : BH.z[i] + BH.vz[i] * bhDt;
        const dx = x - bx, dy = y - by, dz = z - bz;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r > 1e-9) {
            // only the mass whose light front has reached this point pulls
            const mu = bhMuAt(i, x, y, z, tEval);
            if (mu > 0) {
                const am = mu * pairG(r, BH.rs[i], rb) / r;
                ax -= dx * am;
                ay -= dy * am;
                az -= dz * am;
            }
        }
        if (indir) {
            const mu0 = bhMuAt(i, 0, 0, 0, tEval);
            if (mu0 > 0) {
                const r0 = Math.sqrt(bx * bx + by * by + bz * bz);
                if (r0 > 1e-9) {
                    const am0 = mu0 * pairG(r0, BH.rs[i], rE) / r0;
                    ax -= bx * am0;
                    ay -= by * am0;
                    az -= bz * am0;
                }
            }
        }
    }
    const ex = st ? st.earthX : earthX, ey = st ? st.earthY : earthY;
    const gravityStars = gravityStarsFor(ex + x, ey + y, z);
    for (const star of gravityStars) {
        const bx = star.x - ex, by = star.y - ey, bz = star.z || 0;
        const dx = x - bx, dy = y - by, dz = z - bz;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 > 1e-18) {
            const w = star.mu / (r2 * Math.sqrt(r2));
            ax -= w * dx;
            ay -= w * dy;
            az -= w * dz;
        }
        if (indir) {
            const r02 = bx * bx + by * by + bz * bz;
            if (r02 > 1e-18) {
                const w0 = star.mu / (r02 * Math.sqrt(r02));
                ax -= w0 * bx;
                ay -= w0 * by;
                az -= w0 * bz;
            }
        }
    }
    if (GS.length) {
        _gp[0] = 0; _gp[1] = 0; _gp[2] = 0;
        gsPull(x, y, z, tEval, _gp);
        ax += _gp[0]; ay += _gp[1]; az += _gp[2];
        if (indir) {
            _gp[0] = 0; _gp[1] = 0; _gp[2] = 0;
            gsPull(0, 0, 0, tEval, _gp);
            ax -= _gp[0]; ay -= _gp[1]; az -= _gp[2];
        }
    }
    const rRel2 = x * x + y * y + z * z;
    if (includeDarkEnergy && G.darkEnergy && rRel2 >= DARK_ENERGY_GRAVITY_MIN_R2) {
        darkEnergyAccel(x, y, _de, undefined, z);
        ax += _de[0]; ay += _de[1];
        az += _de[2] || 0;
    }
    if (G.darkMatter && rRel2 >= DARK_MATTER_GRAVITY_MIN_R2) {
        darkMatterRelativeAccel(x, y, z, st ? st.earthX : earthX, st ? st.earthY : earthY, 0, _dm);
        ax += _dm[0]; ay += _dm[1]; az += _dm[2];
    }
    if (ind !== null) { ax += ind[0]; ay += ind[1]; if (ind.length > 2) az += ind[2]; }
    out[0] = ax; out[1] = ay;
    if (out.length > 2) out[2] = az;
    return out;
}

const _pnBody3 = [0, 0, 0], _pnEarth3 = [0, 0, 0];
const PN_R2_MAX = 7.5e7 * 7.5e7;
function sun1PN(dx, dy, dz, dvx, dvy, dvz, out) {
    const r2 = dx * dx + dy * dy + dz * dz;
    if (WORLD.sunDestroyed || r2 <= 1e-12 || r2 > PN_R2_MAX) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
    const r = Math.sqrt(r2);
    const v2 = dvx * dvx + dvy * dvy + dvz * dvz;
    const rv = dx * dvx + dy * dvy + dz * dvz;
    const k = MU_S / (C_LIGHT * C_LIGHT * r2 * r);
    out[0] = k * ((4 * MU_S / r - v2) * dx + 4 * rv * dvx);
    out[1] = k * ((4 * MU_S / r - v2) * dy + 4 * rv * dvy);
    out[2] = k * ((4 * MU_S / r - v2) * dz + 4 * rv * dvz);
    return out;
}

function makeState() {
    return {
        x: new Float64Array(bodyX),
        y: new Float64Array(bodyY),
        z: new Float64Array(bodyZ),
        vx: new Float64Array(bodyVx),
        vy: new Float64Array(bodyVy),
        vz: new Float64Array(bodyVz),
        earthX,
        earthY,
        earthZ,
        earthVx,
        earthVy,
        earthVz,
        t: EPHT.t,
        tLo: ephemClockLo(),
    };
}
function copyLiveToState(st) {
    st.x.set(bodyX); st.y.set(bodyY); st.z.set(bodyZ);
    st.vx.set(bodyVx); st.vy.set(bodyVy); st.vz.set(bodyVz);
    st.earthX = earthX; st.earthY = earthY; st.earthZ = earthZ;
    st.earthVx = earthVx; st.earthVy = earthVy; st.earthVz = earthVz;
    st.t = EPHT.t;
    st.tLo = ephemClockLo();
    return st;
}
function copyStateToLive(st) {
    bodyX.set(st.x); bodyY.set(st.y);
    if (st.z) bodyZ.set(st.z); else bodyZ.fill(0); // v ≤ 8 / pre-WP13 v9 saves: no z
    bodyVx.set(st.vx); bodyVy.set(st.vy);
    if (st.vz) bodyVz.set(st.vz); else bodyVz.fill(0);
    earthX = st.earthX; earthY = st.earthY;
    earthVx = st.earthVx; earthVy = st.earthVy;
    // earthZ/earthVz are intentionally not read back: Earth's world z is a
    // permanent 0 by this file's frame convention (see the `earthZ` const
    // above), not a per-snapshot value.
    if (typeof st.t === "number") setEphemClock(st.t, Number.isFinite(st.tLo) ? st.tLo : 0);
    syncFromState();
}

// ---- KDK (velocity-Verlet) leapfrog for the body n-body ----
// Symplectic at fixed step: unlike RK4 its energy error oscillates rather
// than drifting secularly, so long warped runs stay bounded instead of
// gaining/losing orbital energy over many periods (numerics report §4).
// One step = half-kick (using the acceleration at the start of the step),
// full drift, then a second half-kick using the acceleration at the END of
// the step (new positions, new time — so time-dependent fields like a
// black hole's gravity front see the right instant for each evaluation).
const _lfAx = new Float64Array(NB), _lfAy = new Float64Array(NB), _lfAz = new Float64Array(NB);
let _lfEarthAx = 0, _lfEarthAy = 0;
const _a3 = [0, 0, 0];
const _ind3 = [0, 0, 0];
// the indirect frame term is identical for every body: compute it once
function computeAccel(st) {
    indirectAccel(st, _ind3);
    sun1PN(-st.x[IDX_SUN], -st.y[IDX_SUN], -st.z[IDX_SUN], -st.vx[IDX_SUN], -st.vy[IDX_SUN], -st.vz[IDX_SUN], _pnEarth3);
    for (let i = 0; i < NB; i++) {
        if (!isBodyActive(i)) { _lfAx[i] = 0; _lfAy[i] = 0; _lfAz[i] = 0; continue; }
        relGravityAtOpt(st.x[i], st.y[i], st.z[i], _a3, i, st, 0, _ind3, false);
        if (!WORLD.sunDestroyed) {
            if (i === IDX_SUN) { _a3[0] -= _pnEarth3[0]; _a3[1] -= _pnEarth3[1]; _a3[2] -= _pnEarth3[2]; }
            else {
                sun1PN(st.x[i] - st.x[IDX_SUN], st.y[i] - st.y[IDX_SUN], st.z[i] - st.z[IDX_SUN],
                    st.vx[i] - st.vx[IDX_SUN], st.vy[i] - st.vy[IDX_SUN], st.vz[i] - st.vz[IDX_SUN], _pnBody3);
                _a3[0] += _pnBody3[0] - _pnEarth3[0];
                _a3[1] += _pnBody3[1] - _pnEarth3[1];
                _a3[2] += _pnBody3[2] - _pnEarth3[2];
            }
        }
        _lfAx[i] = _a3[0]; _lfAy[i] = _a3[1]; _lfAz[i] = _a3[2];
    }
    // Earth's own world acceleration is X,Y only — see the `earthZ` note:
    // its z is pinned to 0 for the whole run, so no z-acceleration is ever
    // integrated into it even though _ind3[2]/_pnEarth3[2] may be nonzero
    // (that nonzero z DOES correctly reach every other body via `_ind3`
    // above, which is what lets the Sun/Moon/planets feel the real 3-D
    // frame term; only Earth's own absolute trajectory stays flat).
    if (WORLD.earthDestroyed) { _lfEarthAx = 0; _lfEarthAy = 0; }
    else { _lfEarthAx = -_ind3[0] + _pnEarth3[0]; _lfEarthAy = -_ind3[1] + _pnEarth3[1]; }
}
// ---- live black holes ride the same KDK ----
// Holes are integrated in the same leapfrog steps as the bodies with the SAME
// pair laws (pairG), so every hole-body kick is exactly equal and opposite
// and the integration step bounds both sides of an encounter. (Integrating
// the holes in a separate RK4 pass against interpolated bodies let the kicks
// fail to cancel, which pumped momentum into the frame and made the outcome
// depend on warp and frame rate.)
const _hAx = new Float64Array(BH_MAX), _hAy = new Float64Array(BH_MAX), _hAz = new Float64Array(BH_MAX);
const _gpH = [0, 0, 0], _dmH = [0, 0, 0];
function computeHoleAccel(st) {
    const tEval = st.t;
    const muE = activeEarthMu(), rEarth = liveEarthRadius();
    const ex = st.earthX, ey = st.earthY;
    for (let i = 0; i < BH.n; i++) {
        const x = BH.x[i], y = BH.y[i], z = BH.z[i], rsI = BH.rs[i];
        const rE = pairRadius(muE, rEarth, BH.mu[i]);
        let ax = 0, ay = 0, az = 0;
        if (muE > 0) {
            const d = Math.sqrt(x * x + y * y + z * z);
            if (d > 1e-12) {
                const w = muE * pairG(d, rsI, rE) / d;
                ax -= w * x; ay -= w * y; az -= w * z;
            }
        }
        for (let b = 0; b < NB; b++) {
            const mu = activeBodyMu(b);
            if (mu <= 0) continue;
            const dx = x - st.x[b], dy = y - st.y[b], dz = z - st.z[b];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d > 1e-12) {
                const w = mu * pairG(d, rsI, pairRadius(mu, liveBodyRadius(b), BH.mu[i])) / d;
                ax -= w * dx; ay -= w * dy; az -= w * dz;
            }
        }
        for (let j = 0; j < BH.n; j++) {
            if (j === i) continue;
            const dx = x - BH.x[j], dy = y - BH.y[j], dz = z - BH.z[j];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const mu = bhMuAt(j, x, y, z, tEval);
            if (mu > 0 && d > 1e-12) {
                // shared pair softening so unequal holes obey action-reaction
                const rsP = rsI + BH.rs[j];
                const eff = Math.max(d - rsP, rsP * .02);
                const w = mu / (eff * eff * d);
                ax -= w * dx; ay -= w * dy; az -= w * dz;
            }
        }
        const stars = gravityStarsFor(ex + x, ey + y, z);
        for (let k = 0; k < stars.length; k++) {
            const star = stars[k];
            const dx = x - (star.x - ex), dy = y - (star.y - ey), dz = z - (star.z || 0);
            const r2 = dx * dx + dy * dy + dz * dz;
            if (r2 > 1e-18) {
                const w = star.mu / (r2 * Math.sqrt(r2));
                ax -= w * dx; ay -= w * dy; az -= w * dz;
            }
        }
        if (GS.length) {
            _gpH[0] = 0; _gpH[1] = 0; _gpH[2] = 0;
            gsPull(x, y, z, tEval, _gpH);
            ax += _gpH[0]; ay += _gpH[1]; az += _gpH[2];
        }
        if (G.darkMatter && x * x + y * y + z * z >= DARK_MATTER_GRAVITY_MIN_R2) {
            darkMatterRelativeAccel(x, y, z, ex, ey, 0, _dmH);
            ax += _dmH[0]; ay += _dmH[1]; az += _dmH[2];
        }
        _hAx[i] = ax + _ind3[0]; _hAy[i] = ay + _ind3[1]; _hAz[i] = az + _ind3[2];
    }
}
// Pre-drift positions of the step just taken, for the capture hook's
// segment-vs-sphere tests (bodies in ephemeris index order, then holes).
export const LF_SEG = {
    bx: new Float64Array(NB), by: new Float64Array(NB), bz: new Float64Array(NB),
    hx: new Float64Array(BH_MAX), hy: new Float64Array(BH_MAX), hz: new Float64Array(BH_MAX),
    n: 0,
};
// `tEnd` is the state's time after the step. Callers stepping a long
// interval pass tStart + elapsed (elapsed summed from zero, so it stays
// exact) instead of accumulating st.t += dt, whose rounding at deep time
// (32 s ulp at 6 Gyr) used to walk the gravity-front clock off G.t.
// `live`: the step also carries the placed holes and runs the encounter hook.
function leapfrogBodies(st, dt, live = false, tEnd = st.t + dt) {
    const h = dt / 2;
    let holes = live && BH.n > 0;
    computeAccel(st);
    if (holes) computeHoleAccel(st);
    for (let i = 0; i < NB; i++) {
        if (!isBodyActive(i)) continue; // frozen: matches the old zero-derivative behavior
        st.vx[i] += h * _lfAx[i]; st.vy[i] += h * _lfAy[i]; st.vz[i] += h * _lfAz[i];
    }
    st.earthVx += h * _lfEarthAx; st.earthVy += h * _lfEarthAy;
    if (holes) {
        for (let i = 0; i < BH.n; i++) {
            BH.vx[i] += h * _hAx[i]; BH.vy[i] += h * _hAy[i]; BH.vz[i] += h * _hAz[i];
            LF_SEG.hx[i] = BH.x[i]; LF_SEG.hy[i] = BH.y[i]; LF_SEG.hz[i] = BH.z[i];
        }
        LF_SEG.n = BH.n;
        for (let i = 0; i < NB; i++) { LF_SEG.bx[i] = st.x[i]; LF_SEG.by[i] = st.y[i]; LF_SEG.bz[i] = st.z[i]; }
    }
    for (let i = 0; i < NB; i++) {
        if (!isBodyActive(i)) continue;
        st.x[i] += dt * st.vx[i]; st.y[i] += dt * st.vy[i]; st.z[i] += dt * st.vz[i];
    }
    st.earthX += dt * st.earthVx; st.earthY += dt * st.earthVy; // earthZ stays 0
    if (holes) {
        for (let i = 0; i < BH.n; i++) {
            BH.x[i] += dt * BH.vx[i]; BH.y[i] += dt * BH.vy[i]; BH.z[i] += dt * BH.vz[i];
        }
    }
    st.t = tEnd;
    // encounters resolve here, at the drift end and BEFORE the closing kick:
    // a body captured or disrupted at this instant never receives a kick from
    // inside the capture sphere
    if (holes && livePreKick) {
        syncFromState(st);
        livePreKick(st.t, dt);
    }
    computeAccel(st);
    holes = live && BH.n > 0;
    if (holes) computeHoleAccel(st);
    for (let i = 0; i < NB; i++) {
        if (!isBodyActive(i)) continue;
        st.vx[i] += h * _lfAx[i]; st.vy[i] += h * _lfAy[i]; st.vz[i] += h * _lfAz[i];
    }
    st.earthVx += h * _lfEarthAx; st.earthVy += h * _lfEarthAy;
    if (holes) {
        for (let i = 0; i < BH.n; i++) {
            BH.vx[i] += h * _hAx[i]; BH.vy[i] += h * _hAy[i]; BH.vz[i] += h * _hAz[i];
        }
    }
}
// Nominal nominal step ceiling: never step past 1/200 of the shortest
// orbital period actually modeled (the Moon's, ~27.3 days) — small enough
// that the KDK map stays close to symplectic-accurate for the fastest body,
// while still being (much) larger than the existing 3600 s live-path cap, so
// the common case is unaffected. `bodyStepSize` below clamps to this AND
// still shrinks further for close encounters / black holes, so the ceiling
// only actually binds when a caller raises `maxStep` past it (deep-time
// Kepler-jump-ineligible warps, e.g. with a black hole present).
const LUNAR_PERIOD_S = 2 * Math.PI * Math.sqrt((A_MOON * A_MOON * A_MOON) / (MU_E + MU_M));
const LEAP_DT_MAX = LUNAR_PERIOD_S / 200;

// free-fall timescale of a hole-body pair under pairG
function pairTau(d, rs, rb, mu) {
    if (rb > 2 * rs && d < rb) return Math.sqrt(rb * rb * rb / mu);
    const eff = Math.max(d - rs, rs * .02);
    return Math.sqrt(eff * eff * Math.max(d, rs * .02) / mu);
}
function bodyStepSize(st, rem, maxStep = 3600, live = false) {
    let dt = Math.min(rem, maxStep, LEAP_DT_MAX);
    const muE = activeEarthMu();
    for (let i = 0; i < NB; i++) {
        const mui = activeBodyMu(i);
        if (mui <= 0) continue;
        const rE2 = st.x[i] * st.x[i] + st.y[i] * st.y[i] + st.z[i] * st.z[i];
        if (muE > 0 && rE2 > 1) dt = Math.min(dt, Math.sqrt(rE2 * Math.sqrt(rE2) / (muE + mui)) / 55);
        for (let j = i + 1; j < NB; j++) {
            const muj = activeBodyMu(j);
            if (muj <= 0) continue;
            const dx = st.x[i] - st.x[j], dy = st.y[i] - st.y[j], dz = st.z[i] - st.z[j];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > 1) dt = Math.min(dt, Math.sqrt(d2 * Math.sqrt(d2) / (mui + muj)) / 55);
        }
        const rBody = liveBodyRadius(i);
        for (let b = 0; b < BH.n; b++) {
            const dx = st.x[i] - BH.x[b], dy = st.y[i] - BH.y[b], dz = st.z[i] - BH.z[b];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            dt = Math.min(dt, pairTau(d, BH.rs[b], pairRadius(mui, rBody, BH.mu[b]), mui + BH.mu[b]) / (45 * BH.stepFine[b]));
        }
    }
    if (live) {
        const rEarth = liveEarthRadius();
        for (let i = 0; i < BH.n; i++) {
            if (muE > 0) {
                const d = Math.hypot(BH.x[i], BH.y[i], BH.z[i]);
                dt = Math.min(dt, pairTau(d, BH.rs[i], pairRadius(muE, rEarth, BH.mu[i]), muE + BH.mu[i]) / (45 * BH.stepFine[i]));
            }
            for (let j = i + 1; j < BH.n; j++) {
                const d = Math.hypot(BH.x[i] - BH.x[j], BH.y[i] - BH.y[j], BH.z[i] - BH.z[j]);
                const rsP = BH.rs[i] + BH.rs[j];
                const eff = Math.max(d - rsP, rsP * .02);
                dt = Math.min(dt, Math.sqrt(eff * eff * Math.max(d, rsP * .02) / (BH.mu[i] + BH.mu[j])) / 45);
            }
        }
    }
    // captures and disruptions are resolved by scheduled events and the
    // segment-vs-sphere test, not by a step floor; the live floor only keeps
    // the loop finite
    return Math.max(live && BH.n ? 1e-6 : 1e-3, dt);
}
// ---- deep-time propagation ----
// Exact planar two-body propagation over any dt: osculating elements from
// the state vector, Kepler's equation (elliptic or hyperbolic) by damped
// Newton, state back out. Retrograde orbits are mirrored prograde and
// flipped back. Sets out.ok=false (and coasts linearly) on the degenerate
// cases: parabolic slivers, radial plunges, non-finite results.
export function keplerAdvance(x, y, vx, vy, mu, dt, out) {
    out.x = x + vx * dt; out.y = y + vy * dt; out.vx = vx; out.vy = vy;
    out.ok = false;
    const r0 = Math.hypot(x, y);
    if (!(mu > 0) || !(r0 > 1e-9)) return out;
    const mir = (x * vy - y * vx) >= 0 ? 1 : -1;
    y *= mir; vy *= mir;
    const v2 = vx * vx + vy * vy;
    const En = v2 / 2 - mu / r0;
    const rv = x * vx + y * vy;
    const evx = ((v2 - mu / r0) * x - rv * vx) / mu;
    const evy = ((v2 - mu / r0) * y - rv * vy) / mu;
    const e = Math.hypot(evx, evy);
    if (Math.abs(e - 1) < 1e-6 || Math.abs(En) < 1e-14) return out;
    const vp = Math.atan2(evy, evx);
    const nu0 = Math.atan2(y, x) - vp;
    let nu1, r1, p;
    if (En < 0) {
        const a = -mu / (2 * En);
        p = a * (1 - e * e);
        const n = Math.sqrt(mu / (a * a * a));
        const E0 = Math.atan2(Math.sqrt(1 - e * e) * Math.sin(nu0), e + Math.cos(nu0));
        let M = (E0 - e * Math.sin(E0) + n * dt) % (2 * Math.PI);
        let E1 = e < .8 ? M : Math.PI * (M < 0 ? -1 : 1);
        for (let i = 0; i < 40; i++) {
            const f = E1 - e * Math.sin(E1) - M;
            E1 -= Math.max(-1, Math.min(1, f / (1 - e * Math.cos(E1))));
            if (Math.abs(f) < 1e-12) break;
        }
        nu1 = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E1 / 2), Math.sqrt(1 - e) * Math.cos(E1 / 2));
        r1 = a * (1 - e * Math.cos(E1));
    } else {
        const a = -mu / (2 * En); // < 0
        p = a * (1 - e * e);      // > 0
        const n = Math.sqrt(mu / (-a * -a * -a));
        const tn = Math.tan(nu0 / 2) * Math.sqrt((e - 1) / (e + 1));
        if (Math.abs(tn) >= 1) return out; // rounding pushed ν outside the asymptotes
        const H0 = 2 * Math.atanh(tn);
        const M = e * Math.sinh(H0) - H0 + n * dt;
        let H1 = Math.asinh(M / e);
        for (let i = 0; i < 50; i++) {
            const f = e * Math.sinh(H1) - H1 - M;
            H1 -= f / (e * Math.cosh(H1) - 1);
            if (Math.abs(f) < 1e-11 * Math.max(1, Math.abs(M))) break;
        }
        if (!isFinite(H1)) return out;
        nu1 = 2 * Math.atan(Math.sqrt((e + 1) / (e - 1)) * Math.tanh(H1 / 2));
        r1 = a * (1 - e * Math.cosh(H1));
    }
    const c = Math.sqrt(mu / p);
    const vr = c * e * Math.sin(nu1), vt = c * (1 + e * Math.cos(nu1));
    const th = vp + nu1, ct = Math.cos(th), sth = Math.sin(th);
    const nx = r1 * ct, ny = r1 * sth;
    const nvx = vr * ct - vt * sth, nvy = vr * sth + vt * ct;
    if (!isFinite(nx + ny + nvx + nvy)) return out;
    out.x = nx; out.y = ny * mir;
    out.vx = nvx; out.vy = nvy * mir;
    out.ok = true;
    return out;
}

const _ka2 = { x: 0, y: 0, vx: 0, vy: 0, ok: false };
export function keplerAdvance3(x, y, z, vx, vy, vz, mu, dt, out) {
    out.x = x + vx * dt; out.y = y + vy * dt; out.z = z + vz * dt;
    out.vx = vx; out.vy = vy; out.vz = vz; out.ok = false;
    const r = Math.hypot(x, y, z);
    if (!(mu > 0) || !(r > 1e-9)) return out;
    const hx = y * vz - z * vy;
    const hy = z * vx - x * vz;
    const hz = x * vy - y * vx;
    const h = Math.hypot(hx, hy, hz);
    if (!(h > 1e-12)) return out;
    const ih = 1 / h;
    const nhx = hx * ih, nhy = hy * ih, nhz = hz * ih;
    const vchx = vy * hz - vz * hy;
    const vchy = vz * hx - vx * hz;
    const vchz = vx * hy - vy * hx;
    let px = vchx / mu - x / r;
    let py = vchy / mu - y / r;
    let pz = vchz / mu - z / r;
    let p = Math.hypot(px, py, pz);
    if (p < 1e-10) {
        px = x / r; py = y / r; pz = z / r; p = 1;
    } else {
        px /= p; py /= p; pz /= p;
    }
    const qx = nhy * pz - nhz * py;
    const qy = nhz * px - nhx * pz;
    const qz = nhx * py - nhy * px;
    const x2 = x * px + y * py + z * pz;
    const y2 = x * qx + y * qy + z * qz;
    const vx2 = vx * px + vy * py + vz * pz;
    const vy2 = vx * qx + vy * qy + vz * qz;
    keplerAdvance(x2, y2, vx2, vy2, mu, dt, _ka2);
    if (!_ka2.ok) return out;
    out.x = px * _ka2.x + qx * _ka2.y;
    out.y = py * _ka2.x + qy * _ka2.y;
    out.z = pz * _ka2.x + qz * _ka2.y;
    out.vx = px * _ka2.vx + qx * _ka2.vy;
    out.vy = py * _ka2.vx + qy * _ka2.vy;
    out.vz = pz * _ka2.vx + qz * _ka2.vy;
    out.ok = isFinite(out.x + out.y + out.z + out.vx + out.vy + out.vz);
    return out;
}

// RK4 cannot honestly integrate a megayear frame budget, and forcing giant
// steps scrambles the orbits. Past the per-call step budget the system rides
// osculating two-body orbits instead: Earth and planets heliocentric, the
// Moon geocentric, with the system barycenter coasting uniformly. Mutual
// perturbations pause for the jump; periods, shapes, and phases stay right
// at any warp. The barycenter/Earth-world-position recomposition below is
// unchanged from the pre-WP13 2-D math (Earth's world z stays pinned at 0 —
// see the `earthZ` note); only the per-body conics gained a z/vz component,
// via keplerAdvance3 instead of keplerAdvance.
const _kjE = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ok: false };
const _kjM = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ok: false };
const _kjP = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ok: false };
const _jx = new Float64Array(NB), _jy = new Float64Array(NB), _jz = new Float64Array(NB);
const _jvx = new Float64Array(NB), _jvy = new Float64Array(NB), _jvz = new Float64Array(NB);

// ---- secular drift on the analytic path ----
// A frozen conic loses the slow orientation changes the integrator produces
// by itself: the Sun drags the Moon's node round in 18.6 yr and its perigee
// in 8.85 yr, and the planets' mutual pulls precess every perihelion and
// node. Without these the lunar node regressed below the analytic threshold
// and froze above it. The conics are rotated by the observed mean rates --
// lunar node/perigee from Meeus' mean elements, planetary node/perihelion
// from the same Standish Table 1 rates that seed the planets -- as rigid
// rotations (node: about the ecliptic pole; perihelion: about the orbit
// normal), so shapes and energies are untouched and a forward/backward jump
// pair still cancels exactly. Eccentricity/inclination rates are NOT applied:
// they are bounded oscillations in reality and a linear rate would run away
// over Myr.
const RATE_PER_CY = Math.PI / 180 / SEC_PER_JULIAN_CENTURY; // deg/cy -> rad/s
const MOON_VARPI_RATE = 4069.0137287 * RATE_PER_CY;  // lunar perigee, +40.69 deg/yr
const MOON_NODE_RATE = -1934.1362891 * RATE_PER_CY;  // lunar node, -19.34 deg/yr (18.6 yr)
const EARTH_VARPI_RATE = STANDISH_TABLE1.EMB.rate[4] * RATE_PER_CY;
const PL_VARPI_RATE = new Float64Array(PL.length), PL_NODE_RATE = new Float64Array(PL.length);
for (let i = 0; i < PL.length; i++) {
    const key = tableKeyForPlanet(PL[i].name);
    if (!key) continue;
    PL_VARPI_RATE[i] = STANDISH_TABLE1[key].rate[4] * RATE_PER_CY;
    PL_NODE_RATE[i] = STANDISH_TABLE1[key].rate[5] * RATE_PER_CY;
}
// Rotate a conic state in place: the perihelion by (varpi - node) about the
// orbit normal, then the node about the ecliptic pole (world z).
function precessConic(o, dt, varpiRate, nodeRate) {
    const dNode = nodeRate * dt, dArg = (varpiRate - nodeRate) * dt;
    if (dArg !== 0) {
        let hx = o.y * o.vz - o.z * o.vy, hy = o.z * o.vx - o.x * o.vz, hz = o.x * o.vy - o.y * o.vx;
        const h = Math.hypot(hx, hy, hz);
        if (h > 0) {
            hx /= h; hy /= h; hz /= h;
            const c = Math.cos(dArg), s = Math.sin(dArg);
            // r, v lie in the orbital plane (normal h): u' = u cos + (h x u) sin
            const x = o.x, y = o.y, z = o.z, vx = o.vx, vy = o.vy, vz = o.vz;
            o.x = x * c + (hy * z - hz * y) * s; o.y = y * c + (hz * x - hx * z) * s; o.z = z * c + (hx * y - hy * x) * s;
            o.vx = vx * c + (hy * vz - hz * vy) * s; o.vy = vy * c + (hz * vx - hx * vz) * s; o.vz = vz * c + (hx * vy - hy * vx) * s;
        }
    }
    if (dNode !== 0) {
        const c = Math.cos(dNode), s = Math.sin(dNode);
        const x = o.x, vx = o.vx;
        o.x = x * c - o.y * s; o.y = x * s + o.y * c;
        o.vx = vx * c - o.vy * s; o.vy = vx * s + o.vy * c;
    }
    return o;
}

function keplerJumpState(st, dt) {
    const muS = bodyMu[IDX_SUN] * WORLD.muScale[IDX_SUN], muE = activeEarthMu(), muM = activeBodyMu(IDX_MOON);
    const sk = IDX_SUN;
    // heliocentric pieces (earth-relative differences cancel the frame)
    const eHx = -st.x[sk], eHy = -st.y[sk], eHz = -st.z[sk];
    const eHvx = -st.vx[sk], eHvy = -st.vy[sk], eHvz = -st.vz[sk];
    const sWx = st.earthX + st.x[sk], sWy = st.earthY + st.y[sk];
    const sWvx = st.earthVx + st.vx[sk], sWvy = st.earthVy + st.vy[sk];
    // barycenter offset from the Sun, mass(∝μ)-weighted (x,y only: this feeds
    // only Earth's world position, whose z is permanently 0 — see `earthZ`)
    let M = muS + muE + muM;
    let ox = muE * eHx + muM * (eHx + st.x[IDX_MOON]), oy = muE * eHy + muM * (eHy + st.y[IDX_MOON]);
    let ovx = muE * eHvx + muM * (eHvx + st.vx[IDX_MOON]), ovy = muE * eHvy + muM * (eHvy + st.vy[IDX_MOON]);
    for (let i = 0; i < PL.length; i++) {
        const k = IDX_PLANETS + i, mu = activeBodyMu(k);
        if (mu <= 0) continue;
        M += mu;
        ox += mu * (st.x[k] - st.x[sk]); oy += mu * (st.y[k] - st.y[sk]);
        ovx += mu * (st.vx[k] - st.vx[sk]); ovy += mu * (st.vy[k] - st.vy[sk]);
    }
    const rBx = sWx + ox / M, rBy = sWy + oy / M;
    const vBx = sWvx + ovx / M, vBy = sWvy + ovy / M;
    // advance every active piece on its own conic, then apply its secular drift
    keplerAdvance3(eHx, eHy, eHz, eHvx, eHvy, eHvz, muS + muE, dt, _kjE);
    precessConic(_kjE, dt, EARTH_VARPI_RATE, 0);
    if (muM > 0) {
        // (live masses: a partially stripped body keeps its reduced mu)
        keplerAdvance3(st.x[IDX_MOON], st.y[IDX_MOON], st.z[IDX_MOON], st.vx[IDX_MOON], st.vy[IDX_MOON], st.vz[IDX_MOON], muE + muM, dt, _kjM);
        precessConic(_kjM, dt, MOON_VARPI_RATE, MOON_NODE_RATE);
    }
    for (let i = 0; i < PL.length; i++) {
        const k = IDX_PLANETS + i;
        if (activeBodyMu(k) <= 0) continue;
        keplerAdvance3(st.x[k] - st.x[sk], st.y[k] - st.y[sk], st.z[k] - st.z[sk], st.vx[k] - st.vx[sk], st.vy[k] - st.vy[sk], st.vz[k] - st.vz[sk], muS + activeBodyMu(k), dt, _kjP);
        precessConic(_kjP, dt, PL_VARPI_RATE[i], PL_NODE_RATE[i]);
        _jx[k] = _kjP.x; _jy[k] = _kjP.y; _jz[k] = _kjP.z;
        _jvx[k] = _kjP.vx; _jvy[k] = _kjP.vy; _jvz[k] = _kjP.vz;
    }
    // recompose: the barycenter coasted, the Sun hangs off it
    let nox = muE * _kjE.x, noy = muE * _kjE.y, novx = muE * _kjE.vx, novy = muE * _kjE.vy;
    if (muM > 0) {
        nox += muM * (_kjE.x + _kjM.x); noy += muM * (_kjE.y + _kjM.y);
        novx += muM * (_kjE.vx + _kjM.vx); novy += muM * (_kjE.vy + _kjM.vy);
    }
    for (let i = 0; i < PL.length; i++) {
        const k = IDX_PLANETS + i, mu = activeBodyMu(k);
        if (mu <= 0) continue;
        nox += mu * _jx[k]; noy += mu * _jy[k];
        novx += mu * _jvx[k]; novy += mu * _jvy[k];
    }
    const sWx1 = rBx + vBx * dt - nox / M, sWy1 = rBy + vBy * dt - noy / M;
    const sWvx1 = vBx - novx / M, sWvy1 = vBy - novy / M;
    st.earthX = sWx1 + _kjE.x; st.earthY = sWy1 + _kjE.y; // st.earthZ untouched: stays 0
    st.earthVx = sWvx1 + _kjE.vx; st.earthVy = sWvy1 + _kjE.vy;
    st.x[sk] = -_kjE.x; st.y[sk] = -_kjE.y; st.z[sk] = -_kjE.z;
    st.vx[sk] = -_kjE.vx; st.vy[sk] = -_kjE.vy; st.vz[sk] = -_kjE.vz;
    if (muM > 0) {
        st.x[IDX_MOON] = _kjM.x; st.y[IDX_MOON] = _kjM.y; st.z[IDX_MOON] = _kjM.z;
        st.vx[IDX_MOON] = _kjM.vx; st.vy[IDX_MOON] = _kjM.vy; st.vz[IDX_MOON] = _kjM.vz;
    }
    for (let i = 0; i < PL.length; i++) {
        const k = IDX_PLANETS + i;
        if (activeBodyMu(k) <= 0) continue;
        st.x[k] = _jx[k] - _kjE.x; st.y[k] = _jy[k] - _kjE.y; st.z[k] = _jz[k] - _kjE.z;
        st.vx[k] = _jvx[k] - _kjE.vx; st.vy[k] = _jvy[k] - _kjE.vy; st.vz[k] = _jvz[k] - _kjE.vz;
    }
}

// Analytic advance that stays valid when Earth and/or the Sun are destroyed
// (engulfed at the AGB tip, absorbed by a hole, smashed). keplerJumpState
// above is the intact case. Without Earth the frame origin is a massless
// point that coasts inertially (exactly what the leapfrog does: no indirect
// term once Earth is gone), the Moon becomes a heliocentric body, and the
// Sun still anchors every survivor's conic. Without the Sun nothing binds the
// planets any more: they coast on straight lines (their mutual pulls are
// negligible once they separate at their former orbital speeds), while an
// intact Earth-Moon pair keeps its geocentric conic with the pair's
// barycentre coasting. Destroyed bodies stay frozen in the origin-relative
// frame, as in the integrator.
const _gaW = new Float64Array(6);
function analyticJumpState(st, dt) {
    if (!WORLD.sunDestroyed && !WORLD.earthDestroyed) { keplerJumpState(st, dt); return; }
    const sk = IDX_SUN;
    const ox0 = st.earthX, oy0 = st.earthY, ovx = st.earthVx, ovy = st.earthVy;
    if (!WORLD.sunDestroyed) {
        // Earth gone, Sun intact: heliocentric conics about a coasting barycentre
        const muS = activeBodyMu(sk); // (live mass: a stripped Sun keeps its reduced mu)
        const sWx = ox0 + st.x[sk], sWy = oy0 + st.y[sk], sWz = st.z[sk];
        const sWvx = ovx + st.vx[sk], sWvy = ovy + st.vy[sk], sWvz = st.vz[sk];
        let M = muS, bx = 0, by = 0, bz = 0, bvx = 0, bvy = 0, bvz = 0;
        for (let k = 0; k < NB; k++) {
            if (k === sk) continue;
            const mu = activeBodyMu(k);
            if (mu <= 0) continue;
            M += mu;
            bx += mu * (st.x[k] - st.x[sk]); by += mu * (st.y[k] - st.y[sk]); bz += mu * (st.z[k] - st.z[sk]);
            bvx += mu * (st.vx[k] - st.vx[sk]); bvy += mu * (st.vy[k] - st.vy[sk]); bvz += mu * (st.vz[k] - st.vz[sk]);
        }
        const Bx = sWx + bx / M, By = sWy + by / M, Bz = sWz + bz / M;
        const BVx = sWvx + bvx / M, BVy = sWvy + bvy / M, BVz = sWvz + bvz / M;
        let nx = 0, ny = 0, nz = 0, nvx = 0, nvy = 0, nvz = 0;
        for (let k = 0; k < NB; k++) {
            if (k === sk) continue;
            const mu = activeBodyMu(k);
            if (mu <= 0) continue;
            keplerAdvance3(st.x[k] - st.x[sk], st.y[k] - st.y[sk], st.z[k] - st.z[sk],
                st.vx[k] - st.vx[sk], st.vy[k] - st.vy[sk], st.vz[k] - st.vz[sk], muS + mu, dt, _kjP);
            if (k >= IDX_PLANETS) precessConic(_kjP, dt, PL_VARPI_RATE[k - IDX_PLANETS], PL_NODE_RATE[k - IDX_PLANETS]);
            _jx[k] = _kjP.x; _jy[k] = _kjP.y; _jz[k] = _kjP.z;
            _jvx[k] = _kjP.vx; _jvy[k] = _kjP.vy; _jvz[k] = _kjP.vz;
            nx += mu * _kjP.x; ny += mu * _kjP.y; nz += mu * _kjP.z;
            nvx += mu * _kjP.vx; nvy += mu * _kjP.vy; nvz += mu * _kjP.vz;
        }
        const s1x = Bx + BVx * dt - nx / M, s1y = By + BVy * dt - ny / M, s1z = Bz + BVz * dt - nz / M;
        const s1vx = BVx - nvx / M, s1vy = BVy - nvy / M, s1vz = BVz - nvz / M;
        const ox1 = ox0 + ovx * dt, oy1 = oy0 + ovy * dt; // the origin coasts (z stays 0)
        st.earthX = ox1; st.earthY = oy1;
        st.x[sk] = s1x - ox1; st.y[sk] = s1y - oy1; st.z[sk] = s1z;
        st.vx[sk] = s1vx - ovx; st.vy[sk] = s1vy - ovy; st.vz[sk] = s1vz;
        for (let k = 0; k < NB; k++) {
            if (k === sk || activeBodyMu(k) <= 0) continue;
            st.x[k] = s1x + _jx[k] - ox1; st.y[k] = s1y + _jy[k] - oy1; st.z[k] = s1z + _jz[k];
            st.vx[k] = s1vx + _jvx[k] - ovx; st.vy[k] = s1vy + _jvy[k] - ovy; st.vz[k] = s1vz + _jvz[k];
        }
        return;
    }
    // Sun gone: nothing binds the planets
    let ox1 = ox0 + ovx * dt, oy1 = oy0 + ovy * dt, ovx1 = ovx, ovy1 = ovy;
    let moonDone = false;
    if (!WORLD.earthDestroyed) {
        // the Earth-Moon pair keeps its conic; its barycentre coasts (x,y only:
        // Earth's world z is pinned at 0, see the earthZ note)
        const muE = activeEarthMu(), muM = activeBodyMu(IDX_MOON);
        const share = muM / (muE + muM);
        const bx = ox0 + share * st.x[IDX_MOON], by = oy0 + share * st.y[IDX_MOON];
        const bvx = ovx + share * st.vx[IDX_MOON], bvy = ovy + share * st.vy[IDX_MOON];
        if (muM > 0) {
            keplerAdvance3(st.x[IDX_MOON], st.y[IDX_MOON], st.z[IDX_MOON],
                st.vx[IDX_MOON], st.vy[IDX_MOON], st.vz[IDX_MOON], muE + muM, dt, _kjM);
            _gaW[0] = _kjM.x; _gaW[1] = _kjM.y; _gaW[2] = _kjM.z;
            _gaW[3] = _kjM.vx; _gaW[4] = _kjM.vy; _gaW[5] = _kjM.vz;
        }
        ox1 = bx + bvx * dt - share * (muM > 0 ? _gaW[0] : 0);
        oy1 = by + bvy * dt - share * (muM > 0 ? _gaW[1] : 0);
        ovx1 = bvx - share * (muM > 0 ? _gaW[3] : 0);
        ovy1 = bvy - share * (muM > 0 ? _gaW[4] : 0);
        if (muM > 0) {
            st.x[IDX_MOON] = _gaW[0]; st.y[IDX_MOON] = _gaW[1]; st.z[IDX_MOON] = _gaW[2];
            st.vx[IDX_MOON] = _gaW[3]; st.vy[IDX_MOON] = _gaW[4]; st.vz[IDX_MOON] = _gaW[5];
        }
        moonDone = true;
    }
    for (let k = 0; k < NB; k++) {
        if (k === sk || (k === IDX_MOON && moonDone) || !isBodyActive(k)) continue;
        // straight-line coast in the world frame, re-expressed about the new origin
        const wx = ox0 + st.x[k] + (ovx + st.vx[k]) * dt, wy = oy0 + st.y[k] + (ovy + st.vy[k]) * dt;
        const wvx = ovx + st.vx[k], wvy = ovy + st.vy[k];
        st.x[k] = wx - ox1; st.y[k] = wy - oy1; st.z[k] += st.vz[k] * dt;
        st.vx[k] = wvx - ovx1; st.vy[k] = wvy - ovy1;
    }
    st.earthX = ox1; st.earthY = oy1; st.earthVx = ovx1; st.earthVy = ovy1;
}

// ---- per-frame integration budget ----
// worldStep.js opens a frame context for every rendered frame. Bulk advances
// (deep-time bridges, the dead/landed/relativistic paths) that cannot ride the
// analytic path integrate with HONEST steps (bodyStepSize, never stretched)
// until either the request or this frame's step budget is used up, and report
// the time they actually delivered; the caller advances the clock by that and
// the shortfall is surfaced (timeCtl.noteFrameDelivery). Small advances
// (ephemeris flushes inside the ship integrator, <= EPHEM_EXACT_MAX_SEC) and
// predictions keep the old always-complete behaviour: their forced substeps
// are at most a few seconds long.
export const EPHEM_FRAME_STEP_BUDGET = 2500; // ~7 us/step with a hole in play: <= ~18 ms a frame
const EPHEM_CALL_STEP_BUDGET = 20000; // a bulk call outside any frame (smokes, startup ?simt)
const EPHEM_EXACT_MAX_SEC = 3600;
const EPHEM_FRAME = { active: false, rate: 0, stepsLeft: 0, stepsUsed: 0, calls: 0, analyticCalls: 0, limited: false };
export function beginEphemFrame(rateSecPerSec = 0, budget = EPHEM_FRAME_STEP_BUDGET) {
    EPHEM_FRAME.active = true;
    EPHEM_FRAME.rate = Math.abs(Number(rateSecPerSec)) || 0;
    EPHEM_FRAME.stepsLeft = budget;
    EPHEM_FRAME.stepsUsed = 0;
    EPHEM_FRAME.calls = 0;
    EPHEM_FRAME.analyticCalls = 0;
    EPHEM_FRAME.limited = false;
    return EPHEM_FRAME;
}
export function endEphemFrame() { EPHEM_FRAME.active = false; return EPHEM_FRAME; }

// ---- physics regime: analytic conics vs the honest leapfrog ----
// Chosen from the COMMANDED RATE (the warp, sim-s per wall-s) with
// hysteresis, never from the per-frame dt. The old per-call test (|dt| >
// 150 x a ~3600 s step = 540,000 s) put the 1 yr/s preset 2.6% under the
// threshold at 60 fps and over it at 58 fps, so the Moon's node regressed or
// froze depending on frame rate. Now 1 yr/s is always integrated, >= 3 yr/s
// always rides the conics (with the secular drift above keeping the
// orientation behaviour continuous), and 1.5-3 yr/s keeps whichever regime
// it was in. Inside a world-step frame the rate is |G.warp|; a direct call
// outside any frame (smokes, the startup ?simt loop) is treated as one
// 60 fps frame, rate = |dt| * 60.
export const ANALYTIC_ON_RATE = 3 * 31557600;
export const ANALYTIC_OFF_RATE = 1.5 * 31557600;
const DIRECT_CALL_FPS = 60;
let analyticRegime = false;
function analyticRegimeFor(dtTotal) {
    const rate = EPHEM_FRAME.active ? EPHEM_FRAME.rate : Math.abs(dtTotal) * DIRECT_CALL_FPS;
    if (analyticRegime) { if (rate < ANALYTIC_OFF_RATE) analyticRegime = false; }
    else if (rate >= ANALYTIC_ON_RATE) analyticRegime = true;
    return analyticRegime;
}
export function ephemRegime() { return analyticRegime ? "analytic" : "integrated"; }
export function ephemFrameStats() { return EPHEM_FRAME; }
export function ephemBudgetLeft() { return EPHEM_FRAME.active ? EPHEM_FRAME.stepsLeft : EPHEM_CALL_STEP_BUDGET; }

// live-path guard wired by blackholes.js: a body can free-fall into a hole
// well inside one flush interval, so disruption boundaries must be checked
// per substep — never from predictions, which must not mutate the world
let liveGuard = null, livePreKick = null, liveNextEvent = null;
export function setLiveGuard(fn) { liveGuard = fn; }
// preKick(t, dt): after each live drift, before the closing kick (resolve
// scheduled encounters and captures at exact times); nextEvent(t): earliest
// scheduled encounter time, so a step never jumps across it; guard(t, dt):
// after each full live step.
export function setLiveEventHooks({ preKick = null, nextEvent = null, guard = undefined } = {}) {
    livePreKick = preKick;
    liveNextEvent = nextEvent;
    if (guard !== undefined) liveGuard = guard;
}
// never step across a scheduled encounter: a forward live step is clipped to
// end on it (its end time is then within rounding of the booked instant)
function clipToLiveEvent(st, rem, mag, live) {
    if (live && liveNextEvent && BH.n && rem > 0) {
        const lead = liveNextEvent(st.t) - st.t;
        if (lead > 0 && lead < mag) return lead;
    }
    return mag;
}
// Returns the simulated time actually integrated (== dtTotal unless a live
// bulk advance ran out of this frame's step budget).
function advanceState(st, dtTotal, maxStep = 3600, live = false) {
    // deep-time gate (live path only — predictions keep full leapfrog fidelity):
    // holes and gravity ghosts break the two-body decomposition, so those fall
    // through to the integrator; destroyed bodies no longer do (see
    // analyticJumpState) — that gate used to hand a post-engulfment system to
    // 2000 forced steps of ~2.6e11 s each and fling Mars to 1e12 AU.
    if (live && BH.n === 0 && GS.length === 0 && Math.abs(dtTotal) > EPHEM_EXACT_MAX_SEC &&
        analyticRegimeFor(dtTotal)) {
        analyticJumpState(st, dtTotal);
        st.t += dtTotal;
        if (EPHEM_FRAME.active) EPHEM_FRAME.analyticCalls++;
        return dtTotal;
    }
    if (live && Math.abs(dtTotal) > EPHEM_EXACT_MAX_SEC) return budgetedLeapfrog(st, dtTotal, maxStep);
    let rem = dtTotal, guard = 0, elapsed = 0;
    const tStart = st.t;
    while (Math.abs(rem) > 1e-9 && guard++ < 2000) {
        // if the step collapses near a deep well, spend the remaining budget
        // anyway: bounded local error beats bodies silently losing time
        // (only ever short, bounded intervals come through here)
        const mag = clipToLiveEvent(st, rem, Math.min(Math.abs(rem), Math.max(bodyStepSize(st, Math.abs(rem), maxStep, live), Math.abs(rem) / (2001 - guard))), live);
        const dt = Math.sign(rem) * mag;
        elapsed += dt;
        leapfrogBodies(st, dt, live, tStart + elapsed);
        rem -= dt;
        if (live && liveGuard && BH.n) {
            syncFromState(st); // the guard reads current body positions via eph
            liveGuard(st.t, dt);
        }
    }
    return dtTotal;
}
function budgetedLeapfrog(st, dtTotal, maxStep) {
    const budget = ephemBudgetLeft();
    // With holes in play the bulk path is the only way through deep time, so
    // it may use the full accuracy ceiling (LEAP_DT_MAX, 1/200 of a lunar
    // month) the step-size note above reserves for exactly this case;
    // bodyStepSize still shrinks it near the holes.
    if (BH.n > 0) maxStep = Math.max(maxStep, LEAP_DT_MAX);
    let rem = dtTotal, elapsed = 0, steps = 0;
    const tStart = st.t, sign = Math.sign(dtTotal);
    while (Math.abs(rem) > 1e-9 && steps < budget) {
        // live: the holes ride these steps (and scheduled encounters clip them)
        const mag = clipToLiveEvent(st, rem, Math.min(Math.abs(rem), bodyStepSize(st, Math.abs(rem), maxStep, true)), true);
        const dt = sign * mag;
        elapsed += dt;
        leapfrogBodies(st, dt, true, tStart + elapsed);
        rem -= dt;
        steps++;
        if (liveGuard && BH.n) {
            syncFromState(st);
            liveGuard(st.t, dt);
        }
    }
    const complete = Math.abs(rem) <= 1e-9;
    if (EPHEM_FRAME.active) {
        EPHEM_FRAME.stepsLeft -= steps;
        EPHEM_FRAME.stepsUsed += steps;
        if (!complete) EPHEM_FRAME.limited = true;
    }
    return complete ? dtTotal : elapsed;
}
const _adv = makeState(); // persistent scratch: advanceEphem runs every flush, allocation-free
// Advance the live ephemeris; returns the time actually delivered (see the
// budget note above) and advances the ephemeris clock by exactly that.
export function advanceEphem(dtTotal) {
    if (!(Math.abs(dtTotal) > 1e-9)) return 0;
    copyLiveToState(_adv);
    const t0 = _adv.t, lo0 = _adv.tLo;
    if (EPHEM_FRAME.active) EPHEM_FRAME.calls++;
    const delivered = advanceState(_adv, dtTotal, 3600, true);
    // the ephemeris clock advances by exactly the integrated span through the
    // compensated adder (not by the state's own rounded sum of substeps)
    _adv.t = t0; _adv.tLo = lo0;
    copyStateToLive(_adv);
    advanceEphemClock(delivered);
    // a ghost whose front has swept past Neptune influences nothing anymore
    for (let k = GS.length - 1; k >= 0; k--)
        if ((EPHT.t - GS[k].t) * C_LIGHT > 1e10) GS.splice(k, 1);
    return delivered;
}
export function snapshotEphem(out = null) { return out ? copyLiveToState(out) : makeState(); }
export function applyEphemSnapshot(st) { syncFromState(st); }
export function loadEphemSnapshot(st) { copyStateToLive(st); }
export function advanceEphemSnapshot(st, dtTotal, maxStep = 3600) {
    if (dtTotal > 0) advanceState(st, dtTotal, maxStep);
    copyStateToLive(st);
}
export function advanceEphemSnapshotKepler(st, dtTotal, syncLive = true) {
    if (dtTotal > 0 && BH.n === 0 && GS.length === 0) {
        analyticJumpState(st, dtTotal);
        st.t += dtTotal;
    } else if (dtTotal > 0) advanceState(st, dtTotal, dtTotal);
    if (syncLive) copyStateToLive(st);
}

resetEphem();
window.__eph = eph; // debug/testing handle
