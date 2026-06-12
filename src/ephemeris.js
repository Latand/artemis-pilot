import {
    AU_KM, SUN_TH0, OM_YEAR, PL, A_MOON, OMEGA, MOON_ANG0,
    MU_E, MU_M, MU_S,
} from "./constants.js";
import { BH, WORLD } from "./state.js";

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

export function resetEphem() {
    const ma = MOON_ANG0;
    bodyX[IDX_MOON] = A_MOON * Math.cos(ma);
    bodyY[IDX_MOON] = A_MOON * Math.sin(ma);
    bodyVx[IDX_MOON] = -A_MOON * OMEGA * Math.sin(ma);
    bodyVy[IDX_MOON] = A_MOON * OMEGA * Math.cos(ma);

    const sa = SUN_TH0;
    const svx = -AU_KM * OM_YEAR * Math.sin(sa);
    const svy = AU_KM * OM_YEAR * Math.cos(sa);
    bodyX[IDX_SUN] = AU_KM * Math.cos(sa);
    bodyY[IDX_SUN] = AU_KM * Math.sin(sa);
    bodyVx[IDX_SUN] = svx;
    bodyVy[IDX_SUN] = svy;
    earthX = -bodyX[IDX_SUN];
    earthY = -bodyY[IDX_SUN];
    earthVx = -bodyVx[IDX_SUN];
    earthVy = -bodyVy[IDX_SUN];

    for (let i = 0; i < PL.length; i++) {
        const p = PL[i], pa = p.phase;
        const k = IDX_PLANETS + i;
        bodyX[k] = bodyX[IDX_SUN] + p.a * Math.cos(pa);
        bodyY[k] = bodyY[IDX_SUN] + p.a * Math.sin(pa);
        bodyVx[k] = svx - p.a * p.n * Math.sin(pa);
        bodyVy[k] = svy + p.a * p.n * Math.cos(pa);
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

// Indirect (frame) acceleration: every body and hole pulls the Earth-centered
// origin. Identical for all field points, so callers evaluating many points
// against one state compute it once and pass it as `ind`.
export function indirectAccel(st, out, tau = 0) {
    const X = st ? st.x : bodyX, Y = st ? st.y : bodyY;
    const VX = st ? st.vx : bodyVx, VY = st ? st.vy : bodyVy;
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
    for (let i = 0; i < BH.n; i++) {
        const bx = BH.x[i] + BH.vx[i] * tau, by = BH.y[i] + BH.vy[i] * tau;
        const r0 = Math.sqrt(bx * bx + by * by);
        if (r0 > 1e-9) {
            const eff0 = Math.max(r0 - BH.rs[i], BH.rs[i] * .02);
            const am0 = BH.mu[i] / (eff0 * eff0) / r0;
            ax -= bx * am0;
            ay -= by * am0;
        }
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
        if (ind === null) {
            const r02 = bx * bx + by * by;
            if (r02 > 1e-18) {
                const w0 = mu / (r02 * Math.sqrt(r02));
                ax -= w0 * bx;
                ay -= w0 * by;
            }
        }
    }
    for (let i = 0; i < BH.n; i++) {
        const bx = BH.x[i] + BH.vx[i] * tau, by = BH.y[i] + BH.vy[i] * tau;
        const dx = x - bx, dy = y - by;
        const r = Math.sqrt(dx * dx + dy * dy);
        if (r > 1e-9) {
            const eff = Math.max(r - BH.rs[i], BH.rs[i] * .02);
            const am = BH.mu[i] / (eff * eff) / r;
            ax -= dx * am;
            ay -= dy * am;
        }
        if (ind === null) {
            const r0 = Math.sqrt(bx * bx + by * by);
            if (r0 > 1e-9) {
                const eff0 = Math.max(r0 - BH.rs[i], BH.rs[i] * .02);
                const am0 = BH.mu[i] / (eff0 * eff0) / r0;
                ax -= bx * am0;
                ay -= by * am0;
            }
        }
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
    };
}
function copyStateToLive(st) {
    bodyX.set(st.x); bodyY.set(st.y); bodyVx.set(st.vx); bodyVy.set(st.vy);
    earthX = st.earthX; earthY = st.earthY; earthVx = st.earthVx; earthVy = st.earthVy;
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
            const d2 = dx * dx + dy * dy;
            if (d2 > BH.rs[b] * BH.rs[b]) dt = Math.min(dt, Math.sqrt(d2 * Math.sqrt(d2) / (mui + BH.mu[b])) / 45);
        }
    }
    return Math.max(1e-3, dt);
}
function advanceState(st, dtTotal, maxStep = 3600) {
    let rem = dtTotal, guard = 0;
    while (rem > 1e-9 && guard++ < 2000) {
        const dt = Math.min(rem, bodyStepSize(st, rem, maxStep));
        rk4Bodies(st, dt);
        rem -= dt;
    }
}
const _adv = makeState(); // persistent scratch: advanceEphem runs every flush, allocation-free
export function advanceEphem(dtTotal) {
    if (dtTotal <= 0) return;
    _adv.x.set(bodyX); _adv.y.set(bodyY); _adv.vx.set(bodyVx); _adv.vy.set(bodyVy);
    _adv.earthX = earthX; _adv.earthY = earthY; _adv.earthVx = earthVx; _adv.earthVy = earthVy;
    advanceState(_adv, dtTotal);
    copyStateToLive(_adv);
}
export function snapshotEphem() { return makeState(); }
export function applyEphemSnapshot(st) { syncFromState(st); }
export function loadEphemSnapshot(st) { copyStateToLive(st); }
export function advanceEphemSnapshot(st, dtTotal, maxStep = 3600) {
    if (dtTotal > 0) advanceState(st, dtTotal, maxStep);
    copyStateToLive(st);
}

resetEphem();
