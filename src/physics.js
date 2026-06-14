import {
    MU_E, MU_M, MU_S, R_EARTH, R_MOON, R_SUN, C_LIGHT, J2_E, OMEGA_EARTH,
    PL, SOI_M, SOI_E, DRAG_CD, DRAG_H, ATM_TOP, MAX_STEPS_FRAME, EPH_CHUNK,
} from "./constants.js";
import { eph, updEphem, moonState, planetVel, relGravityAt3, advanceEphem, keplerAdvance, keplerAdvance3 } from "./ephemeris.js";
import { G, BH, WORLD, GS, EPHT, bhMuAt } from "./state.js";
import { bhAdvance } from "./blackholes.js";
import { fmtMET, fmtKm } from "./format.js";
import { ACTIVE_STARS, refreshActiveStars } from "./universe/activeStars.js";

// hooks into the presentation layer, wired once by main.js
let H = { die: () => { }, award: () => { }, banner: () => { }, hideBanner: () => { } };
export function initPhysicsHooks(hooks) { H = hooks; }

const _m = { mx: 0, my: 0, vmx: 0, vmy: 0, ang: 0 };
const _pv = { vx: 0, vy: 0 };

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
        const sx = eph.sunX + eph.sunVx * tau, sy = eph.sunY + eph.sunVy * tau;
        const dx = x - sx, dy = y - sy, dz = z;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 < PN_R2_MAX && r2 > 1e-12) {
            // first post-Newtonian Sun term: Mercury-style perihelion precession
            const r = Math.sqrt(r2);
            const rvx = vx - eph.sunVx, rvy = vy - eph.sunVy, rvz = vz;
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
        const px = eph.plX[i] + eph.plVx[i] * tau, py = eph.plY[i] + eph.plVy[i] * tau;
        const dx = x - px, dy = y - py, dz = z;
        const lim = p.R + p.atmTop;
        if (dx > lim || dx < -lim || dy > lim || dy < -lim || dz > lim || dz < -lim) continue;
        const h = Math.sqrt(dx * dx + dy * dy + dz * dz) - p.R;
        if (h >= p.atmTop) continue;
        // drag opposes the planet-relative velocity → aerobraking works
        const rho = p.atmD0 * Math.exp(-Math.max(0, h) / p.atmH);
        const rvx = vx - eph.plVx[i], rvy = vy - eph.plVy[i], rvz = vz;
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
        const dx = x - eph.plX[i], dy = y - eph.plY[i], dz = z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < p.soi * p.soi * 9) {
            const d = Math.sqrt(d2);
            const tP = Math.sqrt(d * d2 / p.mu) / 90;
            if (tP < dt) dt = tP;
            const gap = d - p.R;
            if (gap < 60000) dt = Math.min(dt, Math.max(.5, .2 * Math.max(200, gap) / Math.max(.01, vTot)));
            if (p.atmH && !WORLD.plDestroyed[i] && gap < p.atmTop + 60) {
                dt = Math.min(dt, .9);
                const rvx = vx - eph.plVx[i], rvy = vy - eph.plVy[i], rvz = vz;
                const aD = DRAG_CD * p.atmD0 * Math.exp(-Math.max(0, gap) / p.atmH) * Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz);
                if (aD > 1e-6) dt = Math.min(dt, .05 / aD);
            }
        }
    }
    for (const star of ACTIVE_STARS) {
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
    const dxm = G.x - _m.mx, dym = G.y - _m.my, dzm = G.z;
    const rM = Math.hypot(dxm, dym, dzm);
    updEphem(G.t);
    const sdx = G.x - eph.sunX, sdy = G.y - eph.sunY, sdz = G.z;
    const rS = Math.hypot(sdx, sdy, sdz);
    let pNear = -1, pNearD = Infinity;
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const d = Math.hypot(G.x - eph.plX[i], G.y - eph.plY[i], G.z);
        if (d < pNearD) { pNearD = d; pNear = i; }
    }
    const domMoon = !WORLD.moonDestroyed && rM < SOI_M;
    const domPl = !domMoon && pNear >= 0 && pNearD < PL[pNear].soi;
    const domSun = !WORLD.sunDestroyed && !domMoon && !domPl && (WORLD.earthDestroyed || rE > SOI_E);
    let mu, rx, ry, rz, rvx, rvy, rvz, R, body;
    if (domMoon) { mu = MU_M; rx = dxm; ry = dym; rz = dzm; rvx = G.vx - _m.vmx; rvy = G.vy - _m.vmy; rvz = G.vz; R = R_MOON; body = "MOON"; }
    else if (domPl) {
        const p = PL[pNear];
        planetVel(pNear, G.t, _pv);
        mu = p.mu; rx = G.x - eph.plX[pNear]; ry = G.y - eph.plY[pNear]; rz = G.z;
        rvx = G.vx - _pv.vx; rvy = G.vy - _pv.vy; rvz = G.vz; R = p.R; body = p.name;
    }
    else if (domSun) { mu = MU_S; rx = sdx; ry = sdy; rz = sdz; rvx = G.vx - eph.sunVx; rvy = G.vy - eph.sunVy; rvz = G.vz; R = R_SUN; body = "SUN"; }
    else if (!WORLD.earthDestroyed) { mu = MU_E; rx = G.x; ry = G.y; rz = G.z; rvx = G.vx; rvy = G.vy; rvz = G.vz; R = R_EARTH; body = "EARTH"; }
    else { mu = 1; rx = G.x; ry = G.y; rz = G.z; rvx = G.vx; rvy = G.vy; rvz = G.vz; R = 0; body = "DRIFT"; }
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
    return { domMoon, domSun, domPl, pNear, pNearD, body, mu, r, rp, ra, e, E, R, rE, rM, rS, relV: Math.sqrt(v2), rx, ry, rz, rvx, rvy, rvz };
}

// ============================ CONTACT / LANDING ============================
function handleEarthContact(s) {
    const r = Math.hypot(s[0], s[1], s[2]), f = (R_EARTH + 0.005) / r;
    s[0] *= f; s[1] *= f; s[2] *= f;
    const surfVx = -OMEGA_EARTH * s[1], surfVy = OMEGA_EARTH * s[0];
    const spd = Math.hypot(s[3] - surfVx, s[4] - surfVy, s[5]);
    if (spd < 0.35) {
        s[3] = surfVx; s[4] = surfVy; s[5] = 0;
        G.landed = { body: "earth", ang: Math.atan2(s[1], s[0]), t0: G.t };
        G.heading = G.landed.ang;
        G.pitch = 0;
        if (G.leftHome) H.award("home");
        H.hideBanner();
    } else H.die("Hit Earth at " + spd.toFixed(2) + " km/s");
}
function handleMoonContact(s) {
    moonState(G.t, _m);
    let dx = s[0] - _m.mx, dy = s[1] - _m.my, dz = s[2];
    const r = Math.hypot(dx, dy, dz), f = (R_MOON + 0.003) / r;
    dx *= f; dy *= f; dz *= f;
    s[0] = _m.mx + dx; s[1] = _m.my + dy; s[2] = dz;
    const relSpd = Math.hypot(s[3] - _m.vmx, s[4] - _m.vmy, s[5]);
    if (relSpd < 0.12) {
        G.landed = { body: "moon", ang: Math.atan2(dy, dx) - _m.ang };
        G.heading = Math.atan2(dy, dx);
        G.pitch = 0;
        s[2] = 0; s[3] = _m.vmx; s[4] = _m.vmy; s[5] = 0;
        H.award("landM");
        H.banner("LUNAR LANDING", "Touched down at " + (relSpd * 1000).toFixed(0) + " m/s · MET " + fmtMET(G.t), "W TO LIFT OFF · R TO RESTART");
    } else H.die("Hit the Moon at " + relSpd.toFixed(2) + " km/s");
}
function handlePlanetContact(s, i) {
    const p = PL[i];
    let dx = s[0] - eph.plX[i], dy = s[1] - eph.plY[i], dz = s[2];
    const r = Math.hypot(dx, dy, dz), f = (p.R + 0.01) / r;
    dx *= f; dy *= f; dz *= f;
    s[0] = eph.plX[i] + dx; s[1] = eph.plY[i] + dy; s[2] = dz;
    planetVel(i, G.t, _pv);
    const rel = Math.hypot(s[3] - _pv.vx, s[4] - _pv.vy, s[5]);
    if (p.gas) {
        G.x = s[0]; G.y = s[1]; G.z = s[2]; G.vx = s[3]; G.vy = s[4]; G.vz = s[5];
        H.die("Crushed in " + p.name + "'s atmosphere at " + rel.toFixed(1) + " km/s");
        return;
    }
    if (rel < 0.3) {
        G.landed = { body: "planet", i, ang: Math.atan2(dy, dx) };
        G.heading = Math.atan2(dy, dx);
        G.pitch = 0;
        s[2] = 0; s[3] = _pv.vx; s[4] = _pv.vy; s[5] = 0;
        if (p.name === "MARS") H.award("mars");
        H.banner("LANDED ON " + p.name, "Touchdown at " + (rel * 1000).toFixed(0) + " m/s · MET " + fmtMET(G.t), "W TO LIFT OFF · R TO RESTART");
    } else H.die("Hit " + p.name + " at " + rel.toFixed(2) + " km/s");
}
export function snapLanded() {
    if (!G.landed) return;
    if (G.landed.body === "earth") {
        const r = R_EARTH + 0.005;
        const th = G.landed.ang + OMEGA_EARTH * (G.t - (G.landed.t0 ?? G.t));
        G.x = r * Math.cos(th); G.y = r * Math.sin(th); G.z = 0;
        G.vx = -OMEGA_EARTH * G.y; G.vy = OMEGA_EARTH * G.x; G.vz = 0;
    } else if (G.landed.body === "planet") {
        const i = G.landed.i, r = PL[i].R + 0.01;
        updEphem(G.t);
        G.x = eph.plX[i] + r * Math.cos(G.landed.ang);
        G.y = eph.plY[i] + r * Math.sin(G.landed.ang); G.z = 0;
        planetVel(i, G.t, _pv);
        G.vx = _pv.vx; G.vy = _pv.vy; G.vz = 0;
    } else {
        moonState(G.t, _m);
        const th = _m.ang + G.landed.ang, r = R_MOON + 0.003;
        G.x = _m.mx + r * Math.cos(th); G.y = _m.my + r * Math.sin(th); G.z = 0;
        G.vx = _m.vmx - r * _m.om * Math.sin(th);
        G.vy = _m.vmy + r * _m.om * Math.cos(th); G.vz = 0;
    }
}

// ============================ INTEGRATION ============================
const _gs = [0, 0, 0, 0, 0, 0];
const _bhKick = [0, 0, 0];
const _saveG = [0, 0, 0, 0, 0, 0, 0];
// Inside any of these zones the ephemeris must be exact (contact checks, SOI
// dynamics, bullet time); outside, the ship integrates on extrapolated body
// positions and the n-body system advances in EPH_CHUNK batches.
function bodiesNeedFlush(x, y, z, lag) {
    if (!WORLD.moonDestroyed) {
        const dx = x - (eph.moonX + eph.moonVx * lag), dy = y - (eph.moonY + eph.moonVy * lag), dz = z;
        if (dx * dx + dy * dy + dz * dz < SOI_M * SOI_M) return true;
    }
    if (!WORLD.sunDestroyed) {
        const dx = x - (eph.sunX + eph.sunVx * lag), dy = y - (eph.sunY + eph.sunVy * lag), dz = z;
        if (dx * dx + dy * dy + dz * dz < 9 * R_SUN * R_SUN) return true;
    }
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const dx = x - (eph.plX[i] + eph.plVx[i] * lag), dy = y - (eph.plY[i] + eph.plVy[i] * lag), dz = z;
        if (dx * dx + dy * dy + dz * dz < PL[i].soi * PL[i].soi) return true;
    }
    for (let i = 0; i < BH.n; i++) {
        const dx = x - (BH.x[i] + BH.vx[i] * lag), dy = y - (BH.y[i] + BH.vy[i] * lag), dz = z;
        const lim = Math.max(BH.rs[i] * 150, 5000);
        if (dx * dx + dy * dy + dz * dz < lim * lim) return true;
    }
    for (const star of ACTIVE_STARS) {
        const sx = star.x - (eph.earthX + eph.earthVx * lag);
        const sy = star.y - (eph.earthY + eph.earthVy * lag);
        const sz = star.z || 0;
        const dx = x - sx, dy = y - sy, dz = z - sz;
        const lim = star.R * 25;
        if (dx * dx + dy * dy + dz * dz < lim * lim) return true;
    }
    return false;
}
export function advance(simAdv, atx, aty, atz, aMag) {
    let adv = simAdv, steps = 0, lag = 0;
    const s = _gs;
    s[0] = G.x; s[1] = G.y; s[2] = G.z; s[3] = G.vx; s[4] = G.vy; s[5] = G.vz;
    updEphem(G.t);
    refreshActiveStars(eph.earthX + s[0], eph.earthY + s[1], s[2], G.focus);
    // a frame budget far beyond the step cap: integrating the cap first is
    // wasted work (the jump leaps it anyway), and at low fps it starves the
    // clock — jump the whole frame in O(1) and keep 60 fps at any warp
    if (!G.dead && !G.landed && aMag === 0 && GS.length === 0 &&
        !WORLD.sunDestroyed && !WORLD.earthDestroyed) {
        const rE0 = Math.hypot(s[0], s[1], s[2]);
        const dm0 = Math.hypot(s[0] - eph.moonX, s[1] - eph.moonY, s[2]);
        const ds0 = Math.hypot(s[0] - eph.sunX, s[1] - eph.sunY, s[2]);
        const dt0 = stepSize(rE0, dm0, ds0, rE0 - R_EARTH, Math.hypot(s[3], s[4], s[5]), s[0], s[1], s[2], s[3], s[4], s[5]);
        if (simAdv > MAX_STEPS_FRAME * dt0) {
            if (BH.n === 0 && shipDeepJump(simAdv) > 0) return simAdv;
            if (BH.n > 0) {
                const jumped = tryBHBridgeJump(simAdv);
                if (jumped > 0) return jumped;
            }
        }
    }
    while (adv > 1e-9 && steps < MAX_STEPS_FRAME && !G.dead && !G.landed) {
        const rE = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
        const dmx = s[0] - (eph.moonX + eph.moonVx * lag), dmy = s[1] - (eph.moonY + eph.moonVy * lag), dmz = s[2];
        const rM = Math.sqrt(dmx * dmx + dmy * dmy + dmz * dmz);
        const dsx = s[0] - (eph.sunX + eph.sunVx * lag), dsy = s[1] - (eph.sunY + eph.sunVy * lag), dsz = s[2];
        const rS = Math.sqrt(dsx * dsx + dsy * dsy + dsz * dsz);
        const vTot = Math.sqrt(s[3] * s[3] + s[4] * s[4] + s[5] * s[5]);
        const dt = Math.min(stepSize(rE, rM, rS, rE - R_EARTH, vTot, s[0], s[1], s[2], s[3], s[4], s[5]), adv);
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
        if (lag >= EPH_CHUNK || adv <= 1e-9 || steps >= MAX_STEPS_FRAME || bodiesNeedFlush(s[0], s[1], s[2], lag)) {
            advanceEphem(lag);
            bhAdvance(lag, G.t); // holes free-fall in sync with the ship
            lag = 0;
        }
        // Earth sits at the frame origin: its contact check is always exact
        if (!WORLD.earthDestroyed && Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]) <= R_EARTH) { handleEarthContact(s); break; }
        let hitStar = null;
        for (const star of ACTIVE_STARS) {
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
        // every other surface lies deep inside a flush zone, so these checks
        // only need to run when the ephemeris is fresh
        if (lag > 0) continue;
        if (!WORLD.moonDestroyed && Math.hypot(s[0] - eph.moonX, s[1] - eph.moonY, s[2]) <= R_MOON) { handleMoonContact(s); break; }
        if (!WORLD.sunDestroyed && Math.hypot(s[0] - eph.sunX, s[1] - eph.sunY, s[2]) <= R_SUN) {
            G.x = s[0]; G.y = s[1]; G.z = s[2]; G.vx = s[3]; G.vy = s[4]; G.vz = s[5];
            H.die("Vaporized in the solar photosphere");
            break;
        }
        let hitP = -1;
        for (let i = 0; i < PL.length; i++)
            if (!WORLD.plDestroyed[i] && Math.hypot(s[0] - eph.plX[i], s[1] - eph.plY[i], s[2]) <= PL[i].R) { hitP = i; break; }
        if (hitP >= 0) { handlePlanetContact(s, hitP); break; }
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
    if (lag > 0) { advanceEphem(lag); bhAdvance(lag, G.t); }
    G.x = s[0]; G.y = s[1]; G.z = s[2]; G.vx = s[3]; G.vy = s[4]; G.vz = s[5];
    // deep-time remainder: at warps the per-frame RK4 budget cannot cover,
    // the ship rides its osculating two-body orbit while the ephemeris
    // Kepler-jumps the same span, keeping the commanded clock rate at every
    // scale.
    if (adv > 1e-9 && !G.dead && !G.landed && aMag === 0 &&
        GS.length === 0 && !WORLD.sunDestroyed && !WORLD.earthDestroyed) {
        if (BH.n === 0) adv -= shipDeepJump(adv);
        else {
            let guard = 0;
            while (adv > 1e-9 && guard++ < 24 && !G.dead && !G.landed) {
                const jumped = tryBHBridgeJump(adv);
                if (jumped <= 1e-9) break;
                adv -= jumped;
            }
        }
    }
    const rE = Math.sqrt(G.x * G.x + G.y * G.y + G.z * G.z);
    G.maxRE = Math.max(G.maxRE, rE);
    if (rE > 100000) G.leftHome = true;
    return simAdv - adv;
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
function shipDeepJump(dt) {
    const oi = orbitInfo();
    const wx = eph.earthX + G.x, wy = eph.earthY + G.y, wz = G.z;
    let starI = -1, starAcc = 0;
    for (let i = 0; i < ACTIVE_STARS.length; i++) {
        const dx = wx - ACTIVE_STARS[i].x, dy = wy - ACTIVE_STARS[i].y, dz = wz - (ACTIVE_STARS[i].z || 0);
        const a = ACTIVE_STARS[i].mu / (dx * dx + dy * dy + dz * dz);
        if (a > starAcc) { starAcc = a; starI = i; }
    }
    const domAcc = oi.mu / (oi.r * oi.r);
    if (starAcc > domAcc) {
        // a named star owns the well; they are static, so recomposition only
        // has to undo the Earth-frame offset
        const st = ACTIVE_STARS[starI];
        const d = Math.hypot(wx - st.x, wy - st.y, wz - (st.z || 0));
        if (st.bh && d < st.rs * 200) return 0;
        if (d <= st.R * 1.1 || domAcc > starAcc * .02) return 0;
        keplerAdvance3(wx - st.x, wy - st.y, wz - (st.z || 0), G.vx + eph.earthVx, G.vy + eph.earthVy, G.vz, st.mu, dt, _dj);
        if (!_dj.ok) return 0;
        advanceEphem(dt);
        G.x = st.x + _dj.x - eph.earthX; G.y = st.y + _dj.y - eph.earthY; G.z = (st.z || 0) + _dj.z;
        G.vx = _dj.vx - eph.earthVx; G.vy = _dj.vy - eph.earthVy; G.vz = _dj.vz;
        G.t += dt;
        return dt;
    }
    if (Math.abs(G.z) > 1e-6 || Math.abs(G.vz) > 1e-9) return 0;
    const atmTop = oi.body === "EARTH" ? ATM_TOP : oi.domPl ? (PL[oi.pNear].atmTop || 0) : 0;
    if (oi.r - oi.R < atmTop) return 0;     // inside the drag shell: integrate it
    if (oi.rp < oi.R + atmTop) return 0;    // orbit dips into it: let the decay/impact play out
    if (Math.abs(oi.e - 1) < 1e-4) return 0;
    if (starAcc > domAcc * .02) return 0;
    keplerAdvance(oi.rx, oi.ry, oi.rvx, oi.rvy, oi.mu, dt, _dj);
    if (!_dj.ok) return 0;
    advanceEphem(dt);
    let bx = 0, by = 0, bvx = 0, bvy = 0;
    if (oi.domMoon) { bx = eph.moonX; by = eph.moonY; bvx = eph.moonVx; bvy = eph.moonVy; }
    else if (oi.domPl) { bx = eph.plX[oi.pNear]; by = eph.plY[oi.pNear]; bvx = eph.plVx[oi.pNear]; bvy = eph.plVy[oi.pNear]; }
    else if (oi.domSun) { bx = eph.sunX; by = eph.sunY; bvx = eph.sunVx; bvy = eph.sunVy; }
    G.x = bx + _dj.x; G.y = by + _dj.y; G.z = 0;
    G.vx = bvx + _dj.vx; G.vy = bvy + _dj.vy; G.vz = 0;
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
        const dx = G.x - eph.plX[i], dy = G.y - eph.plY[i], dz = G.z;
        const lim = p.R + p.atmTop;
        if (dx > lim || dx < -lim || dy > lim || dy < -lim || dz > lim || dz < -lim) continue;
        const h = Math.sqrt(dx * dx + dy * dy + dz * dz) - p.R;
        if (h >= p.atmTop) continue;
        const rvx = G.vx - eph.plVx[i], rvy = G.vy - eph.plVy[i], rvz = G.vz;
        const aD = DRAG_CD * p.atmD0 * Math.exp(-Math.max(0, h) / p.atmH) * (rvx * rvx + rvy * rvy + rvz * rvz);
        if (aD > best) { best = aD; AERO.vx = rvx; AERO.vy = rvy; AERO.vz = rvz; }
    }
    AERO.aD = best * 1000; // m/s²
    return AERO;
}
