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
const _gp = [0, 0];
const _de = [0, 0];
export function indirectAccel(st, out, tau = 0) {
    // with Earth gone the origin coasts inertially: no frame correction at all
    if (WORLD.earthDestroyed) { out[0] = 0; out[1] = 0; return out; }
    const X = st ? st.x : bodyX, Y = st ? st.y : bodyY;
    const VX = st ? st.vx : bodyVx, VY = st ? st.vy : bodyVy;
    const tEval = (st && st.t !== undefined ? st.t : EPHT.t) + tau;
    let ax = 0, ay = 0;
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
        const mu0 = bhMuAt(i, 0, 0, tEval);
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
        const bx = star.x - (st ? st.earthX : earthX), by = star.y - (st ? st.earthY : earthY);
        const r0 = Math.sqrt(bx * bx + by * by);
        if (r0 > 1e-9) {
            const w0 = star.mu / (r0 * r0 * r0);
            ax -= w0 * bx;
            ay -= w0 * by;
        }
    }
    if (GS.length) {
        _gp[0] = 0; _gp[1] = 0;
        gsPull(0, 0, tEval, _gp);
        ax -= _gp[0]; ay -= _gp[1];
    }
    out[0] = ax; out[1] = ay;
    return out;
}

// `tau` linearly extrapolates body/hole positions, so an RK4 stage at t+τ
// samples the field where the bodies actually are instead of where they were
// at the start of the step (and between ephemeris flushes).
export function relGravityAt(x, y, out, skipBody = -1, st = null, tau = 0, ind = null) {
    const X = st ? st.x : bodyX, Y = st ? st.y : bodyY;
    const VX = st ? st.vx : bodyVx, VY = st ? st.vy : bodyVy;
    const tEval = (st && st.t !== undefined ? st.t : EPHT.t) + tau;
    // inline indirect terms only while Earth anchors an accelerating frame
    const indir = ind === null && !WORLD.earthDestroyed;
    let ax = 0, ay = 0;
    const muE = activeEarthMu();
    if (muE > 0) {
        const r2 = x * x + y * y;
        if (r2 > 1e-18) {
            const w = muE / (r2 * Math.sqrt(r2));
            ax -= w * x;
            ay -= w * y;
        }
    }
    for (let i = 0; i < NB; i++) {
        const mu = activeBodyMu(i);
        if (mu <= 0) continue;
        const bx = X[i] + VX[i] * tau, by = Y[i] + VY[i] * tau;
        if (i !== skipBody) {
            const dx = x - bx, dy = y - by;
            const r2 = dx * dx + dy * dy;
            if (r2 > 1e-18) {
                const w = mu / (r2 * Math.sqrt(r2));
                ax -= w * dx;
                ay -= w * dy;
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
        const dx = x - bx, dy = y - by;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > 1e-9) {
            // only the mass whose light front has reached this point pulls
            const mu = bhMuAt(i, x, y, tEval);
            if (mu > 0) {
                const eff = Math.max(r - BH.rs[i], BH.rs[i] * .02);
                const am = mu / (eff * eff) / r;
                ax -= dx * am;
                ay -= dy * am;
            }
        }
        if (indir) {
            const mu0 = bhMuAt(i, 0, 0, tEval);
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
        const bx = star.x - ex, by = star.y - ey;
        const dx = x - bx, dy = y - by;
        const r2 = dx * dx + dy * dy;
        if (r2 > 1e-18) {
            const w = star.mu / (r2 * Math.sqrt(r2));
            ax -= w * dx;
            ay -= w * dy;
        }
        if (indir) {
            const r02 = bx * bx + by * by;
            if (r02 > 1e-18) {
                const w0 = star.mu / (r02 * Math.sqrt(r02));
                ax -= w0 * bx;
                ay -= w0 * by;
            }
        }
    }
    if (GS.length) {
        _gp[0] = 0; _gp[1] = 0;
        gsPull(x, y, tEval, _gp);
        ax += _gp[0]; ay += _gp[1];
        if (indir) {
            _gp[0] = 0; _gp[1] = 0;
            gsPull(0, 0, tEval, _gp);
            ax -= _gp[0]; ay -= _gp[1];
        }
    }
    if (G.darkEnergy) {
        darkEnergyAccel(x, y, _de);
        ax += _de[0]; ay += _de[1];
    }
    if (ind !== null) { ax += ind[0]; ay += ind[1]; }
    out[0] = ax; out[1] = ay;
    return out;
}

const _a = [0, 0];
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
    for (let i = 0; i < NB; i++) {
        if (!isBodyActive(i)) {
            K_.x[i] = 0; K_.y[i] = 0; K_.vx[i] = 0; K_.vy[i] = 0;
            continue;
        }
        relGravityAt(st.x[i], st.y[i], _a, i, st, 0, _ind);
        K_.x[i] = st.vx[i]; K_.y[i] = st.vy[i];
        K_.vx[i] = _a[0]; K_.vy[i] = _a[1];
    }
    K_.earthX = st.earthVx; K_.earthY = st.earthVy;
    if (WORLD.earthDestroyed) { K_.earthVx = 0; K_.earthVy = 0; }
    else { K_.earthVx = -_ind[0]; K_.earthVy = -_ind[1]; }
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
// live-path guard wired by blackholes.js: a body can free-fall into a hole
// well inside one flush interval, so disruption boundaries must be checked
// per substep — never from predictions, which must not mutate the world
let liveGuard = null;
export function setLiveGuard(fn) { liveGuard = fn; }
function advanceState(st, dtTotal, maxStep = 3600, live = false) {
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
