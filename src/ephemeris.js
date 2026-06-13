import {
    AU_KM, SUN_TH0, E_EARTH, VARPI_EARTH, PL, STARS, A_MOON, E_MOON, OMEGA, MOON_ANG0,
    MU_E, MU_M, MU_S, C_LIGHT, BH_MAX, darkEnergyAccel,
} from "./constants.js";
import { G, BH, WORLD, EPHT, GS, gsPull, bhMuAt } from "./state.js";

export const IDX_MOON = 0;
export const IDX_SUN = 1;
export const IDX_PLANETS = 2;
export const NB = IDX_PLANETS + PL.length;

const bodyMu = new Float64Array(NB);
bodyMu[IDX_MOON] = MU_M;
bodyMu[IDX_SUN] = MU_S;
for (let i = 0; i < PL.length; i++) bodyMu[IDX_PLANETS + i] = PL[i].mu;

function isBodyActive(i) {
    return i === IDX_MOON ? !WORLD.moonDestroyed :
        i === IDX_SUN ? !WORLD.sunDestroyed :
            !WORLD.plDestroyed[i - IDX_PLANETS];
}
function activeBodyMu(i) { return isBodyActive(i) ? bodyMu[i] : 0; }
function activeEarthMu() { return WORLD.earthDestroyed ? 0 : MU_E; }

const bodyX = new Float64Array(NB), bodyY = new Float64Array(NB);
const bodyVx = new Float64Array(NB), bodyVy = new Float64Array(NB);
let earthX = 0, earthY = 0, earthVx = 0, earthVy = 0;

// Live ephemeris cache (km, km/s). Earth has an inertial world-state; the
// other arrays are Earth-local relative states used by precision dynamics.
export const eph = {
    earthX: 0, earthY: 0, earthVx: 0, earthVy: 0,
    sunX: 0, sunY: 0, sunVx: 0, sunVy: 0,
    moonX: 0, moonY: 0, moonVx: 0, moonVy: 0,
    plX: new Float64Array(PL.length), plY: new Float64Array(PL.length),
    plVx: new Float64Array(PL.length), plVy: new Float64Array(PL.length),
};
window.__eph = eph;

function syncFromState(st = null) {
    const X = st ? st.x : bodyX, Y = st ? st.y : bodyY;
    const VX = st ? st.vx : bodyVx, VY = st ? st.vy : bodyVy;
    eph.earthX = st ? st.earthX : earthX; eph.earthY = st ? st.earthY : earthY;
    eph.earthVx = st ? st.earthVx : earthVx; eph.earthVy = st ? st.earthVy : earthVy;
    eph.moonX = X[IDX_MOON]; eph.moonY = Y[IDX_MOON];
    eph.moonVx = VX[IDX_MOON]; eph.moonVy = VY[IDX_MOON];
    eph.sunX = X[IDX_SUN]; eph.sunY = Y[IDX_SUN];
    eph.sunVx = VX[IDX_SUN]; eph.sunVy = VY[IDX_SUN];
    for (let i = 0; i < PL.length; i++) {
        const k = IDX_PLANETS + i;
        eph.plX[i] = X[k]; eph.plY[i] = Y[k];
        eph.plVx[i] = VX[k]; eph.plVy[i] = VY[k];
    }
}

// Two-body elements → planar state (km, km/s). Solves Kepler's equation
// M = E − e·sinE by Newton, then converts: r = a(1 − e·cosE), true anomaly ν
// from E, heliocentric angle θ = varpi + ν, and radial/tangential speeds
// vr = √(μ/p)·e·sinν, vt = √(μ/p)·(1 + e·cosν) with p = a(1 − e²). Used only
// to set initial conditions — everything then evolves under full n-body RK4.
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

const _kp = { x: 0, y: 0, vx: 0, vy: 0 };
export function resetEphem() {
    EPHT.t = 0;
    // Moon from elements; MOON_ANG0 is its initial mean anomaly, varpi = 0
    keplerInit(A_MOON, E_MOON, 0, MOON_ANG0, MU_E + MU_M, _kp);
    bodyX[IDX_MOON] = _kp.x;
    bodyY[IDX_MOON] = _kp.y;
    bodyVx[IDX_MOON] = _kp.vx;
    bodyVy[IDX_MOON] = _kp.vy;

    // Earth's heliocentric state from elements, with the initial true anomaly
    // chosen so the Earth→Sun direction stays exactly at SUN_TH0; the Sun's
    // Earth-relative state is its negative (Earth world-state matches it).
    const nu0 = SUN_TH0 + Math.PI - VARPI_EARTH;
    const E0 = 2 * Math.atan2(Math.sqrt(1 - E_EARTH) * Math.sin(nu0 / 2), Math.sqrt(1 + E_EARTH) * Math.cos(nu0 / 2));
    keplerInit(AU_KM, E_EARTH, VARPI_EARTH, E0 - E_EARTH * Math.sin(E0), MU_S + MU_E, _kp);
    earthX = _kp.x;
    earthY = _kp.y;
    earthVx = _kp.vx;
    earthVy = _kp.vy;
    bodyX[IDX_SUN] = -_kp.x;
    bodyY[IDX_SUN] = -_kp.y;
    bodyVx[IDX_SUN] = -_kp.vx;
    bodyVy[IDX_SUN] = -_kp.vy;
    const svx = bodyVx[IDX_SUN], svy = bodyVy[IDX_SUN];

    // planets stored Earth-relative: Sun's Earth-relative state + heliocentric
    // state from J2000 elements (p.phase is the initial mean anomaly)
    for (let i = 0; i < PL.length; i++) {
        const p = PL[i];
        const k = IDX_PLANETS + i;
        keplerInit(p.a, p.e, p.varpi, p.phase, MU_S, _kp);
        bodyX[k] = bodyX[IDX_SUN] + _kp.x;
        bodyY[k] = bodyY[IDX_SUN] + _kp.y;
        bodyVx[k] = svx + _kp.vx;
        bodyVy[k] = svy + _kp.vy;
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
export function bodyStateForTarget(target, out, st = null) {
    if (target === -3) {
        out.x = st ? st.earthX : earthX; out.y = st ? st.earthY : earthY;
        out.vx = st ? st.earthVx : earthVx; out.vy = st ? st.earthVy : earthVy;
        return out;
    }
    const k = bodyIndexFromTarget(target);
    const X = st ? st.x : bodyX, Y = st ? st.y : bodyY;
    const VX = st ? st.vx : bodyVx, VY = st ? st.vy : bodyVy;
    const ex = st ? st.earthX : earthX, ey = st ? st.earthY : earthY;
    const evx = st ? st.earthVx : earthVx, evy = st ? st.earthVy : earthVy;
    out.x = ex + X[k]; out.y = ey + Y[k]; out.vx = evx + VX[k]; out.vy = evy + VY[k];
    return out;
}

// Prediction-time black-hole extrapolation: predicted arcs span up to 160
// days, but BH.x/BH.y only hold the holes' live positions. While a prediction
// is active, gravity places hole i at snapX + snapVx·(tEval − t0) — a linear
// coast from a snapshot taken at prediction start. Covers both the snapshot
// path (advanceEphemSnapshot → derivAll) and the ship path (rk4Step calls
// relGravityAt with st = null while the live arrays hold the prediction
// state). Live integration never sets the flag, so that path is untouched.
const PRED_BH = {
    active: false, t0: 0,
    x: new Float64Array(BH_MAX), y: new Float64Array(BH_MAX),
    vx: new Float64Array(BH_MAX), vy: new Float64Array(BH_MAX),
};
export function beginPredictionBH() {
    PRED_BH.t0 = EPHT.t;
    for (let i = 0; i < BH.n; i++) {
        PRED_BH.x[i] = BH.x[i]; PRED_BH.y[i] = BH.y[i];
        PRED_BH.vx[i] = BH.vx[i]; PRED_BH.vy[i] = BH.vy[i];
    }
    PRED_BH.active = true;
}
export function endPredictionBH() { PRED_BH.active = false; }
// extrapolated hole position at absolute sim time t (for prediction-loop
// impact checks); falls back to the live state outside predictions
export function predBHX(i, t) { return PRED_BH.active ? PRED_BH.x[i] + PRED_BH.vx[i] * (t - PRED_BH.t0) : BH.x[i]; }
export function predBHY(i, t) { return PRED_BH.active ? PRED_BH.y[i] + PRED_BH.vy[i] * (t - PRED_BH.t0) : BH.y[i]; }

// Indirect (frame) acceleration: every body and hole pulls the Earth-centered
// origin. Identical for all field points, so callers evaluating many points
// against one state compute it once and pass it as `ind`.
const _gp = [0, 0, 0];
const _de = [0, 0, 0];
export function indirectAccel(st, out, tau = 0) {
    // with Earth gone the origin coasts inertially: no frame correction at all
    if (WORLD.earthDestroyed) { out[0] = 0; out[1] = 0; if (out.length > 2) out[2] = 0; return out; }
    const X = st ? st.x : bodyX, Y = st ? st.y : bodyY;
    const VX = st ? st.vx : bodyVx, VY = st ? st.vy : bodyVy;
    const tEval = (st && st.t !== undefined ? st.t : EPHT.t) + tau;
    let ax = 0, ay = 0, az = 0;
    for (let i = 0; i < NB; i++) {
        const mu = activeBodyMu(i);
        if (mu <= 0) continue;
        const bx = X[i] + VX[i] * tau, by = Y[i] + VY[i] * tau;
        const r02 = bx * bx + by * by;
        if (r02 > 1e-18) {
            const w = mu / (r02 * Math.sqrt(r02));
            ax -= w * bx;
            ay -= w * by;
        }
    }
    const bhDt = PRED_BH.active ? tEval - PRED_BH.t0 : tau;
    for (let i = 0; i < BH.n; i++) {
        const mu0 = bhMuAt(i, 0, 0, 0, tEval);
        if (mu0 <= 0) continue;
        const bx = PRED_BH.active ? PRED_BH.x[i] + PRED_BH.vx[i] * bhDt : BH.x[i] + BH.vx[i] * bhDt;
        const by = PRED_BH.active ? PRED_BH.y[i] + PRED_BH.vy[i] * bhDt : BH.y[i] + BH.vy[i] * bhDt;
        const r0 = Math.sqrt(bx * bx + by * by);
        if (r0 > 1e-9) {
            const eff0 = Math.max(r0 - BH.rs[i], BH.rs[i] * .02);
            const am0 = mu0 / (eff0 * eff0) / r0;
            ax -= bx * am0;
            ay -= by * am0;
        }
    }
    for (const star of STARS) {
        const bx = star.x - (st ? st.earthX : earthX), by = star.y - (st ? st.earthY : earthY), bz = star.z || 0;
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
    const X = st ? st.x : bodyX, Y = st ? st.y : bodyY;
    const VX = st ? st.vx : bodyVx, VY = st ? st.vy : bodyVy;
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
        const bx = X[i] + VX[i] * tau, by = Y[i] + VY[i] * tau;
        if (i !== skipBody) {
            const dx = x - bx, dy = y - by, dz = z;
            const r2 = dx * dx + dy * dy + dz * dz;
            if (r2 > 1e-18) {
                const w = mu / (r2 * Math.sqrt(r2));
                ax -= w * dx;
                ay -= w * dy;
                az -= w * dz;
            }
        }
        if (indir) {
            const r02 = bx * bx + by * by;
            if (r02 > 1e-18) {
                const w0 = mu / (r02 * Math.sqrt(r02));
                ax -= w0 * bx;
                ay -= w0 * by;
            }
        }
    }
    const bhDt = PRED_BH.active ? tEval - PRED_BH.t0 : tau;
    for (let i = 0; i < BH.n; i++) {
        const bx = PRED_BH.active ? PRED_BH.x[i] + PRED_BH.vx[i] * bhDt : BH.x[i] + BH.vx[i] * bhDt;
        const by = PRED_BH.active ? PRED_BH.y[i] + PRED_BH.vy[i] * bhDt : BH.y[i] + BH.vy[i] * bhDt;
        const dx = x - bx, dy = y - by, dz = z;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (r > 1e-9) {
            // only the mass whose light front has reached this point pulls
            const mu = bhMuAt(i, x, y, z, tEval);
            if (mu > 0) {
                const eff = Math.max(r - BH.rs[i], BH.rs[i] * .02);
                const am = mu / (eff * eff) / r;
                ax -= dx * am;
                ay -= dy * am;
                az -= dz * am;
            }
        }
        if (indir) {
            const mu0 = bhMuAt(i, 0, 0, 0, tEval);
            if (mu0 > 0) {
                const r0 = Math.sqrt(bx * bx + by * by);
                if (r0 > 1e-9) {
                    const eff0 = Math.max(r0 - BH.rs[i], BH.rs[i] * .02);
                    const am0 = mu0 / (eff0 * eff0) / r0;
                    ax -= bx * am0;
                    ay -= by * am0;
                }
            }
        }
    }
    for (const star of STARS) {
        const ex = st ? st.earthX : earthX, ey = st ? st.earthY : earthY;
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
    if (includeDarkEnergy && G.darkEnergy) {
        darkEnergyAccel(x, y, _de, undefined, z);
        ax += _de[0]; ay += _de[1];
        az += _de[2] || 0;
    }
    if (ind !== null) { ax += ind[0]; ay += ind[1]; if (ind.length > 2) az += ind[2]; }
    out[0] = ax; out[1] = ay;
    if (out.length > 2) out[2] = az;
    return out;
}

const _a = [0, 0];
const _pnBody = [0, 0], _pnEarth = [0, 0];
const PN_R2_MAX = 7.5e7 * 7.5e7;
function sun1PN(dx, dy, dvx, dvy, out) {
    const r2 = dx * dx + dy * dy;
    if (WORLD.sunDestroyed || r2 <= 1e-12 || r2 > PN_R2_MAX) { out[0] = 0; out[1] = 0; return out; }
    const r = Math.sqrt(r2);
    const v2 = dvx * dvx + dvy * dvy;
    const rv = dx * dvx + dy * dvy;
    const k = MU_S / (C_LIGHT * C_LIGHT * r2 * r);
    out[0] = k * ((4 * MU_S / r - v2) * dx + 4 * rv * dvx);
    out[1] = k * ((4 * MU_S / r - v2) * dy + 4 * rv * dvy);
    return out;
}
const _k = [];
for (let i = 0; i < 4; i++)
    _k.push({ x: new Float64Array(NB), y: new Float64Array(NB), vx: new Float64Array(NB), vy: new Float64Array(NB), earthX: 0, earthY: 0, earthVx: 0, earthVy: 0 });
const _sx = new Float64Array(NB), _sy = new Float64Array(NB), _svx = new Float64Array(NB), _svy = new Float64Array(NB);

function makeState() {
    return {
        x: new Float64Array(bodyX),
        y: new Float64Array(bodyY),
        vx: new Float64Array(bodyVx),
        vy: new Float64Array(bodyVy),
        earthX,
        earthY,
        earthVx,
        earthVy,
        t: EPHT.t,
    };
}
function copyStateToLive(st) {
    bodyX.set(st.x); bodyY.set(st.y); bodyVx.set(st.vx); bodyVy.set(st.vy);
    earthX = st.earthX; earthY = st.earthY; earthVx = st.earthVx; earthVy = st.earthVy;
    if (typeof st.t === "number") EPHT.t = st.t;
    syncFromState();
}
const _ind = [0, 0];
function derivAll(st, K_) {
    // the indirect frame term is identical for every body: compute it once
    // (Earth's inertial acceleration is exactly its negative)
    indirectAccel(st, _ind);
    sun1PN(-st.x[IDX_SUN], -st.y[IDX_SUN], -st.vx[IDX_SUN], -st.vy[IDX_SUN], _pnEarth);
    for (let i = 0; i < NB; i++) {
        if (!isBodyActive(i)) {
            K_.x[i] = 0; K_.y[i] = 0; K_.vx[i] = 0; K_.vy[i] = 0;
            continue;
        }
        relGravityAtOpt(st.x[i], st.y[i], 0, _a, i, st, 0, _ind, false);
        if (!WORLD.sunDestroyed) {
            if (i === IDX_SUN) { _a[0] -= _pnEarth[0]; _a[1] -= _pnEarth[1]; }
            else {
                sun1PN(st.x[i] - st.x[IDX_SUN], st.y[i] - st.y[IDX_SUN], st.vx[i] - st.vx[IDX_SUN], st.vy[i] - st.vy[IDX_SUN], _pnBody);
                _a[0] += _pnBody[0] - _pnEarth[0];
                _a[1] += _pnBody[1] - _pnEarth[1];
            }
        }
        K_.x[i] = st.vx[i]; K_.y[i] = st.vy[i];
        K_.vx[i] = _a[0]; K_.vy[i] = _a[1];
    }
    K_.earthX = st.earthVx; K_.earthY = st.earthVy;
    if (WORLD.earthDestroyed) { K_.earthVx = 0; K_.earthVy = 0; }
    else { K_.earthVx = -_ind[0] + _pnEarth[0]; K_.earthVy = -_ind[1] + _pnEarth[1]; }
}
function rk4Bodies(st, dt) {
    derivAll(st, _k[0]);
    for (const [f, prev, cur] of [[.5, 0, 1], [.5, 1, 2], [1, 2, 3]]) {
        for (let i = 0; i < NB; i++) {
            _sx[i] = st.x[i] + f * dt * _k[prev].x[i];
            _sy[i] = st.y[i] + f * dt * _k[prev].y[i];
            _svx[i] = st.vx[i] + f * dt * _k[prev].vx[i];
            _svy[i] = st.vy[i] + f * dt * _k[prev].vy[i];
        }
        derivAll({
            x: _sx, y: _sy, vx: _svx, vy: _svy,
            earthX: st.earthX + f * dt * _k[prev].earthX,
            earthY: st.earthY + f * dt * _k[prev].earthY,
            earthVx: st.earthVx + f * dt * _k[prev].earthVx,
            earthVy: st.earthVy + f * dt * _k[prev].earthVy,
            t: st.t + f * dt,
        }, _k[cur]);
    }
    for (let i = 0; i < NB; i++) {
        st.x[i] += dt / 6 * (_k[0].x[i] + 2 * _k[1].x[i] + 2 * _k[2].x[i] + _k[3].x[i]);
        st.y[i] += dt / 6 * (_k[0].y[i] + 2 * _k[1].y[i] + 2 * _k[2].y[i] + _k[3].y[i]);
        st.vx[i] += dt / 6 * (_k[0].vx[i] + 2 * _k[1].vx[i] + 2 * _k[2].vx[i] + _k[3].vx[i]);
        st.vy[i] += dt / 6 * (_k[0].vy[i] + 2 * _k[1].vy[i] + 2 * _k[2].vy[i] + _k[3].vy[i]);
    }
    st.earthX += dt / 6 * (_k[0].earthX + 2 * _k[1].earthX + 2 * _k[2].earthX + _k[3].earthX);
    st.earthY += dt / 6 * (_k[0].earthY + 2 * _k[1].earthY + 2 * _k[2].earthY + _k[3].earthY);
    st.earthVx += dt / 6 * (_k[0].earthVx + 2 * _k[1].earthVx + 2 * _k[2].earthVx + _k[3].earthVx);
    st.earthVy += dt / 6 * (_k[0].earthVy + 2 * _k[1].earthVy + 2 * _k[2].earthVy + _k[3].earthVy);
}
function bodyStepSize(st, rem, maxStep = 3600) {
    let dt = Math.min(rem, maxStep);
    const muE = activeEarthMu();
    for (let i = 0; i < NB; i++) {
        const mui = activeBodyMu(i);
        if (mui <= 0) continue;
        const rE2 = st.x[i] * st.x[i] + st.y[i] * st.y[i];
        if (muE > 0 && rE2 > 1) dt = Math.min(dt, Math.sqrt(rE2 * Math.sqrt(rE2) / (muE + mui)) / 55);
        for (let j = i + 1; j < NB; j++) {
            const muj = activeBodyMu(j);
            if (muj <= 0) continue;
            const dx = st.x[i] - st.x[j], dy = st.y[i] - st.y[j];
            const d2 = dx * dx + dy * dy;
            if (d2 > 1) dt = Math.min(dt, Math.sqrt(d2 * Math.sqrt(d2) / (mui + muj)) / 55);
        }
        for (let b = 0; b < BH.n; b++) {
            const dx = st.x[i] - BH.x[b], dy = st.y[i] - BH.y[b];
            const d = Math.sqrt(dx * dx + dy * dy);
            // free-fall timescale against the PW-softened pull; the floor keeps
            // it finite even with the body's center inside the horizon
            const eff = Math.max(d - BH.rs[b], BH.rs[b] * .02);
            dt = Math.min(dt, Math.sqrt(eff * eff * Math.max(d, BH.rs[b] * .02) / (mui + BH.mu[b])) / 45);
        }
    }
    return Math.max(1e-3, dt);
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
// at any warp.
const _kjE = { x: 0, y: 0, vx: 0, vy: 0, ok: false };
const _kjM = { x: 0, y: 0, vx: 0, vy: 0, ok: false };
const _kjP = { x: 0, y: 0, vx: 0, vy: 0, ok: false };
const _jx = new Float64Array(NB), _jy = new Float64Array(NB);
const _jvx = new Float64Array(NB), _jvy = new Float64Array(NB);
function keplerJumpState(st, dt) {
    const muS = bodyMu[IDX_SUN], muE = activeEarthMu(), muM = activeBodyMu(IDX_MOON);
    const sk = IDX_SUN;
    // heliocentric pieces (earth-relative differences cancel the frame)
    const eHx = -st.x[sk], eHy = -st.y[sk], eHvx = -st.vx[sk], eHvy = -st.vy[sk];
    const sWx = st.earthX + st.x[sk], sWy = st.earthY + st.y[sk];
    const sWvx = st.earthVx + st.vx[sk], sWvy = st.earthVy + st.vy[sk];
    // barycenter offset from the Sun, mass(∝μ)-weighted
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
    // advance every active piece on its own conic
    keplerAdvance(eHx, eHy, eHvx, eHvy, muS + muE, dt, _kjE);
    if (muM > 0) keplerAdvance(st.x[IDX_MOON], st.y[IDX_MOON], st.vx[IDX_MOON], st.vy[IDX_MOON], muE + bodyMu[IDX_MOON], dt, _kjM);
    for (let i = 0; i < PL.length; i++) {
        const k = IDX_PLANETS + i;
        if (activeBodyMu(k) <= 0) continue;
        keplerAdvance(st.x[k] - st.x[sk], st.y[k] - st.y[sk], st.vx[k] - st.vx[sk], st.vy[k] - st.vy[sk], muS + bodyMu[k], dt, _kjP);
        _jx[k] = _kjP.x; _jy[k] = _kjP.y; _jvx[k] = _kjP.vx; _jvy[k] = _kjP.vy;
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
    st.earthX = sWx1 + _kjE.x; st.earthY = sWy1 + _kjE.y;
    st.earthVx = sWvx1 + _kjE.vx; st.earthVy = sWvy1 + _kjE.vy;
    st.x[sk] = -_kjE.x; st.y[sk] = -_kjE.y;
    st.vx[sk] = -_kjE.vx; st.vy[sk] = -_kjE.vy;
    if (muM > 0) {
        st.x[IDX_MOON] = _kjM.x; st.y[IDX_MOON] = _kjM.y;
        st.vx[IDX_MOON] = _kjM.vx; st.vy[IDX_MOON] = _kjM.vy;
    }
    for (let i = 0; i < PL.length; i++) {
        const k = IDX_PLANETS + i;
        if (activeBodyMu(k) <= 0) continue;
        st.x[k] = _jx[k] - _kjE.x; st.y[k] = _jy[k] - _kjE.y;
        st.vx[k] = _jvx[k] - _kjE.vx; st.vy[k] = _jvy[k] - _kjE.vy;
    }
}

// live-path guard wired by blackholes.js: a body can free-fall into a hole
// well inside one flush interval, so disruption boundaries must be checked
// per substep — never from predictions, which must not mutate the world
let liveGuard = null;
export function setLiveGuard(fn) { liveGuard = fn; }
function advanceState(st, dtTotal, maxStep = 3600, live = false) {
    // deep-time gate (live path only — predictions keep full RK4 fidelity):
    // holes, gravity ghosts, and a destroyed Sun or Earth all break the
    // two-body decomposition, so those fall through to the integrator
    if (live && BH.n === 0 && GS.length === 0 && !WORLD.sunDestroyed && !WORLD.earthDestroyed &&
        dtTotal > bodyStepSize(st, dtTotal, maxStep) * 150) {
        keplerJumpState(st, dtTotal);
        st.t += dtTotal;
        return;
    }
    let rem = dtTotal, guard = 0;
    while (rem > 1e-9 && guard++ < 2000) {
        // if the step collapses near a deep well, spend the remaining budget
        // anyway: bounded local error beats bodies silently losing time
        const dt = Math.min(rem, Math.max(bodyStepSize(st, rem, maxStep), rem / (2001 - guard)));
        rk4Bodies(st, dt);
        st.t += dt;
        rem -= dt;
        if (live && liveGuard && BH.n) {
            syncFromState(st); // the guard reads current body positions via eph
            liveGuard();
        }
    }
}
const _adv = makeState(); // persistent scratch: advanceEphem runs every flush, allocation-free
export function advanceEphem(dtTotal) {
    if (dtTotal <= 0) return;
    _adv.x.set(bodyX); _adv.y.set(bodyY); _adv.vx.set(bodyVx); _adv.vy.set(bodyVy);
    _adv.earthX = earthX; _adv.earthY = earthY; _adv.earthVx = earthVx; _adv.earthVy = earthVy;
    _adv.t = EPHT.t;
    advanceState(_adv, dtTotal, 3600, true);
    copyStateToLive(_adv);
    // a ghost whose front has swept past Neptune influences nothing anymore
    for (let k = GS.length - 1; k >= 0; k--)
        if ((EPHT.t - GS[k].t) * C_LIGHT > 1e10) GS.splice(k, 1);
}
export function snapshotEphem() { return makeState(); }
export function applyEphemSnapshot(st) { syncFromState(st); }
export function loadEphemSnapshot(st) { copyStateToLive(st); }
export function advanceEphemSnapshot(st, dtTotal, maxStep = 3600) {
    if (dtTotal > 0) advanceState(st, dtTotal, maxStep);
    copyStateToLive(st);
}

resetEphem();
window.__eph = eph; // debug/testing handle
