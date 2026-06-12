import {
    MU_E, MU_M, MU_S, R_EARTH, R_MOON, R_SUN, C_LIGHT, J2_E,
    PL, SOI_M, SOI_E, DRAG_CD, DRAG_H, ATM_TOP, MAX_STEPS_FRAME, EPH_CHUNK,
} from "./constants.js";
import { eph, updEphem, moonState, planetVel, relGravityAt, advanceEphem } from "./ephemeris.js";
import { G, BH, WORLD } from "./state.js";
import { bhAdvance } from "./blackholes.js";
import { fmtMET, fmtKm } from "./format.js";

// hooks into the presentation layer, wired once by main.js
let H = { die: () => { }, award: () => { }, banner: () => { }, hideBanner: () => { } };
export function initPhysicsHooks(hooks) { H = hooks; }

const _m = { mx: 0, my: 0, vmx: 0, vmy: 0, ang: 0 };
const _pv = { vx: 0, vy: 0 };

// derivative of [x,y,vx,vy] incl. the live n-body field in the Earth-relative
// frame, PW black holes, Earth J2, Sun 1PN, atmosphere drag, thrust.
// `tau` is the offset from the last ephemeris flush: body and hole positions
// are linearly extrapolated so RK4 stages sample the field where the bodies
// actually are mid-step.
const J2_R2_MAX = 4e9;        // J2 negligible beyond ~10 Earth radii
const PN_R2_MAX = 7.5e7 * 7.5e7; // Sun 1PN active inside ~0.5 AU
export function deriv(x, y, vx, vy, tau, atx, aty, out) {
    relGravityAt(x, y, _ga, -1, null, tau);
    let ax = _ga[0], ay = _ga[1];
    if (!WORLD.earthDestroyed) {
        const rE2 = x * x + y * y;
        const rE = Math.sqrt(rE2);
        if (rE2 < J2_R2_MAX && rE > 1e-9) {
            // oblateness: equatorial-plane radial correction → apsidal precession
            const w = 1.5 * J2_E * MU_E * R_EARTH * R_EARTH / (rE2 * rE2 * rE);
            ax -= w * x; ay -= w * y;
        }
        const h = rE - R_EARTH;
        if (h < ATM_TOP) {
            const rho = Math.exp(-Math.max(0, h) / DRAG_H);
            const v = Math.sqrt(vx * vx + vy * vy);
            const f = -DRAG_CD * rho * v;
            ax += f * vx; ay += f * vy;
        }
    }
    if (!WORLD.sunDestroyed) {
        const sx = eph.sunX + eph.sunVx * tau, sy = eph.sunY + eph.sunVy * tau;
        const dx = x - sx, dy = y - sy;
        const r2 = dx * dx + dy * dy;
        if (r2 < PN_R2_MAX && r2 > 1e-12) {
            // first post-Newtonian Sun term: Mercury-style perihelion precession
            const r = Math.sqrt(r2);
            const rvx = vx - eph.sunVx, rvy = vy - eph.sunVy;
            const v2 = rvx * rvx + rvy * rvy;
            const rv = dx * rvx + dy * rvy;
            const k = MU_S / (C_LIGHT * C_LIGHT * r2 * r);
            ax += k * ((4 * MU_S / r - v2) * dx + 4 * rv * rvx);
            ay += k * ((4 * MU_S / r - v2) * dy + 4 * rv * rvy);
        }
    }
    for (let i = 0; i < PL.length; i++) {
        const p = PL[i];
        if (!p.atmH || WORLD.plDestroyed[i]) continue;
        const px = eph.plX[i] + eph.plVx[i] * tau, py = eph.plY[i] + eph.plVy[i] * tau;
        const dx = x - px, dy = y - py;
        const lim = p.R + p.atmTop;
        if (dx > lim || dx < -lim || dy > lim || dy < -lim) continue;
        const h = Math.sqrt(dx * dx + dy * dy) - p.R;
        if (h >= p.atmTop) continue;
        // drag opposes the planet-relative velocity → aerobraking works
        const rho = p.atmD0 * Math.exp(-Math.max(0, h) / p.atmH);
        const rvx = vx - eph.plVx[i], rvy = vy - eph.plVy[i];
        const f = -DRAG_CD * rho * Math.sqrt(rvx * rvx + rvy * rvy);
        ax += f * rvx; ay += f * rvy;
    }
    out[0] = vx; out[1] = vy; out[2] = ax + atx; out[3] = ay + aty;
}

const _ga = [0, 0];
const _k1 = [0, 0, 0, 0], _k2 = [0, 0, 0, 0], _k3 = [0, 0, 0, 0], _k4 = [0, 0, 0, 0], _st = [0, 0, 0, 0];
// tau0: ephemeris lag at the start of this step (0 when bodies are fresh)
export function rk4Step(s, tau0, dt, atx, aty) {
    deriv(s[0], s[1], s[2], s[3], tau0, atx, aty, _k1);
    for (let i = 0; i < 4; i++) _st[i] = s[i] + .5 * dt * _k1[i];
    deriv(_st[0], _st[1], _st[2], _st[3], tau0 + .5 * dt, atx, aty, _k2);
    for (let i = 0; i < 4; i++) _st[i] = s[i] + .5 * dt * _k2[i];
    deriv(_st[0], _st[1], _st[2], _st[3], tau0 + .5 * dt, atx, aty, _k3);
    for (let i = 0; i < 4; i++) _st[i] = s[i] + dt * _k3[i];
    deriv(_st[0], _st[1], _st[2], _st[3], tau0 + dt, atx, aty, _k4);
    for (let i = 0; i < 4; i++) s[i] += dt / 6 * (_k1[i] + 2 * _k2[i] + 2 * _k3[i] + _k4[i]);
}

export function stepSize(rE, rM, rS, h, vTot, x, y, vx = 0, vy = 0) {
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
        const dx = x - eph.plX[i], dy = y - eph.plY[i];
        const d2 = dx * dx + dy * dy;
        if (d2 < p.soi * p.soi * 9) {
            const d = Math.sqrt(d2);
            const tP = Math.sqrt(d * d2 / p.mu) / 90;
            if (tP < dt) dt = tP;
            const gap = d - p.R;
            if (gap < 60000) dt = Math.min(dt, Math.max(.5, .2 * Math.max(200, gap) / Math.max(.01, vTot)));
            if (p.atmH && !WORLD.plDestroyed[i] && gap < p.atmTop + 60) {
                dt = Math.min(dt, .9);
                const rvx = vx - eph.plVx[i], rvy = vy - eph.plVy[i];
                const aD = DRAG_CD * p.atmD0 * Math.exp(-Math.max(0, gap) / p.atmH) * Math.sqrt(rvx * rvx + rvy * rvy);
                if (aD > 1e-6) dt = Math.min(dt, .05 / aD);
            }
        }
    }
    let floor = 0.02;
    for (let i = 0; i < BH.n; i++) {
        const dx = x - BH.x[i], dy = y - BH.y[i];
        const d2 = dx * dx + dy * dy;
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
    const rE = Math.hypot(G.x, G.y);
    const dxm = G.x - _m.mx, dym = G.y - _m.my;
    const rM = Math.hypot(dxm, dym);
    updEphem(G.t);
    const sdx = G.x - eph.sunX, sdy = G.y - eph.sunY;
    const rS = Math.hypot(sdx, sdy);
    let pNear = -1, pNearD = Infinity;
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const d = Math.hypot(G.x - eph.plX[i], G.y - eph.plY[i]);
        if (d < pNearD) { pNearD = d; pNear = i; }
    }
    const domMoon = !WORLD.moonDestroyed && rM < SOI_M;
    const domPl = !domMoon && pNear >= 0 && pNearD < PL[pNear].soi;
    const domSun = !WORLD.sunDestroyed && !domMoon && !domPl && (WORLD.earthDestroyed || rE > SOI_E);
    let mu, rx, ry, rvx, rvy, R, body;
    if (domMoon) { mu = MU_M; rx = dxm; ry = dym; rvx = G.vx - _m.vmx; rvy = G.vy - _m.vmy; R = R_MOON; body = "MOON"; }
    else if (domPl) {
        const p = PL[pNear];
        planetVel(pNear, G.t, _pv);
        mu = p.mu; rx = G.x - eph.plX[pNear]; ry = G.y - eph.plY[pNear];
        rvx = G.vx - _pv.vx; rvy = G.vy - _pv.vy; R = p.R; body = p.name;
    }
    else if (domSun) { mu = MU_S; rx = sdx; ry = sdy; rvx = G.vx; rvy = G.vy; R = R_SUN; body = "SUN"; }
    else if (!WORLD.earthDestroyed) { mu = MU_E; rx = G.x; ry = G.y; rvx = G.vx; rvy = G.vy; R = R_EARTH; body = "EARTH"; }
    else { mu = 1; rx = G.x; ry = G.y; rvx = G.vx; rvy = G.vy; R = 0; body = "DRIFT"; }
    const r = Math.hypot(rx, ry), v2 = rvx * rvx + rvy * rvy;
    const E = v2 / 2 - mu / r;
    const hh = rx * rvy - ry * rvx;
    const e = Math.sqrt(Math.max(0, 1 + 2 * E * hh * hh / (mu * mu)));
    const a = -mu / (2 * E);
    let rp, ra;
    if (E < 0) { rp = a * (1 - e); ra = a * (1 + e); }
    else { rp = Math.abs(a) * (e - 1); ra = Infinity; }
    return { domMoon, domSun, domPl, pNear, pNearD, body, mu, r, rp, ra, e, E, R, rE, rM, rS, relV: Math.sqrt(v2) };
}

// ============================ CONTACT / LANDING ============================
function handleEarthContact(s) {
    const r = Math.hypot(s[0], s[1]), f = (R_EARTH + 0.005) / r;
    s[0] *= f; s[1] *= f;
    const spd = Math.hypot(s[2], s[3]);
    if (spd < 0.35) {
        s[2] = 0; s[3] = 0;
        G.landed = { body: "earth", ang: Math.atan2(s[1], s[0]) };
        G.heading = G.landed.ang;
        if (G.leftHome) {
            H.award("home");
            H.banner("SPLASHDOWN", "Back on Earth · MET " + fmtMET(G.t) + " · Δv used " + Math.round(G.dvUsed) + " m/s", "SHIFT+W TO LIFT OFF AGAIN · R TO RESTART");
        } else
            H.banner("TOUCHDOWN", "On the surface of Earth.", "SHIFT+W TO LIFT OFF · R TO RESTART");
    } else H.die("Hit Earth at " + spd.toFixed(2) + " km/s");
}
function handleMoonContact(s) {
    moonState(G.t, _m);
    let dx = s[0] - _m.mx, dy = s[1] - _m.my;
    const r = Math.hypot(dx, dy), f = (R_MOON + 0.003) / r;
    dx *= f; dy *= f;
    s[0] = _m.mx + dx; s[1] = _m.my + dy;
    const relSpd = Math.hypot(s[2] - _m.vmx, s[3] - _m.vmy);
    if (relSpd < 0.12) {
        G.landed = { body: "moon", ang: Math.atan2(dy, dx) - _m.ang };
        G.heading = Math.atan2(dy, dx);
        s[2] = _m.vmx; s[3] = _m.vmy;
        H.award("landM");
        H.banner("LUNAR LANDING", "Touched down at " + (relSpd * 1000).toFixed(0) + " m/s · MET " + fmtMET(G.t), "W TO LIFT OFF · R TO RESTART");
    } else H.die("Hit the Moon at " + relSpd.toFixed(2) + " km/s");
}
function handlePlanetContact(s, i) {
    const p = PL[i];
    let dx = s[0] - eph.plX[i], dy = s[1] - eph.plY[i];
    const r = Math.hypot(dx, dy), f = (p.R + 0.01) / r;
    dx *= f; dy *= f;
    s[0] = eph.plX[i] + dx; s[1] = eph.plY[i] + dy;
    planetVel(i, G.t, _pv);
    const rel = Math.hypot(s[2] - _pv.vx, s[3] - _pv.vy);
    if (p.gas) {
        G.x = s[0]; G.y = s[1]; G.vx = s[2]; G.vy = s[3];
        H.die("Crushed in " + p.name + "'s atmosphere at " + rel.toFixed(1) + " km/s");
        return;
    }
    if (rel < 0.3) {
        G.landed = { body: "planet", i, ang: Math.atan2(dy, dx) };
        G.heading = Math.atan2(dy, dx);
        s[2] = _pv.vx; s[3] = _pv.vy;
        if (p.name === "MARS") H.award("mars");
        H.banner("LANDED ON " + p.name, "Touchdown at " + (rel * 1000).toFixed(0) + " m/s · MET " + fmtMET(G.t), "W TO LIFT OFF · R TO RESTART");
    } else H.die("Hit " + p.name + " at " + rel.toFixed(2) + " km/s");
}
export function snapLanded() {
    if (!G.landed) return;
    if (G.landed.body === "earth") {
        const r = R_EARTH + 0.005;
        G.x = r * Math.cos(G.landed.ang); G.y = r * Math.sin(G.landed.ang);
        G.vx = 0; G.vy = 0;
    } else if (G.landed.body === "planet") {
        const i = G.landed.i, r = PL[i].R + 0.01;
        updEphem(G.t);
        G.x = eph.plX[i] + r * Math.cos(G.landed.ang);
        G.y = eph.plY[i] + r * Math.sin(G.landed.ang);
        planetVel(i, G.t, _pv);
        G.vx = _pv.vx; G.vy = _pv.vy;
    } else {
        moonState(G.t, _m);
        const th = _m.ang + G.landed.ang, r = R_MOON + 0.003;
        G.x = _m.mx + r * Math.cos(th); G.y = _m.my + r * Math.sin(th);
        G.vx = _m.vmx - r * _m.om * Math.sin(th);
        G.vy = _m.vmy + r * _m.om * Math.cos(th);
    }
}

// ============================ INTEGRATION ============================
const _gs = [0, 0, 0, 0];
// Inside any of these zones the ephemeris must be exact (contact checks, SOI
// dynamics, bullet time); outside, the ship integrates on extrapolated body
// positions and the n-body system advances in EPH_CHUNK batches.
function bodiesNeedFlush(x, y, lag) {
    if (!WORLD.moonDestroyed) {
        const dx = x - (eph.moonX + eph.moonVx * lag), dy = y - (eph.moonY + eph.moonVy * lag);
        if (dx * dx + dy * dy < SOI_M * SOI_M) return true;
    }
    if (!WORLD.sunDestroyed) {
        const dx = x - (eph.sunX + eph.sunVx * lag), dy = y - (eph.sunY + eph.sunVy * lag);
        if (dx * dx + dy * dy < 9 * R_SUN * R_SUN) return true;
    }
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const dx = x - (eph.plX[i] + eph.plVx[i] * lag), dy = y - (eph.plY[i] + eph.plVy[i] * lag);
        if (dx * dx + dy * dy < PL[i].soi * PL[i].soi) return true;
    }
    for (let i = 0; i < BH.n; i++) {
        const dx = x - (BH.x[i] + BH.vx[i] * lag), dy = y - (BH.y[i] + BH.vy[i] * lag);
        const lim = Math.max(BH.rs[i] * 150, 5000);
        if (dx * dx + dy * dy < lim * lim) return true;
    }
    return false;
}
export function advance(simAdv, atx, aty, aMag) {
    let adv = simAdv, steps = 0, lag = 0;
    const s = _gs;
    s[0] = G.x; s[1] = G.y; s[2] = G.vx; s[3] = G.vy;
    updEphem(G.t);
    while (adv > 1e-9 && steps < MAX_STEPS_FRAME && !G.dead && !G.landed) {
        const rE = Math.sqrt(s[0] * s[0] + s[1] * s[1]);
        const dmx = s[0] - (eph.moonX + eph.moonVx * lag), dmy = s[1] - (eph.moonY + eph.moonVy * lag);
        const rM = Math.sqrt(dmx * dmx + dmy * dmy);
        const dsx = s[0] - (eph.sunX + eph.sunVx * lag), dsy = s[1] - (eph.sunY + eph.sunVy * lag);
        const rS = Math.sqrt(dsx * dsx + dsy * dsy);
        const vTot = Math.sqrt(s[2] * s[2] + s[3] * s[3]);
        const dt = Math.min(stepSize(rE, rM, rS, rE - R_EARTH, vTot, s[0], s[1], s[2], s[3]), adv);
        rk4Step(s, lag, dt, atx, aty);
        G.t += dt; adv -= dt; lag += dt; steps++;
        if (aMag > 0) {
            const dv = aMag * dt * 1000;
            G.dvUsed += dv;
            if (!G.infinite) {
                G.fuel -= dv;
                if (G.fuel <= 0) { G.fuel = 0; atx = 0; aty = 0; aMag = 0; }
            }
        }
        if (lag >= EPH_CHUNK || adv <= 1e-9 || steps >= MAX_STEPS_FRAME || bodiesNeedFlush(s[0], s[1], lag)) {
            advanceEphem(lag);
            bhAdvance(lag, G.t); // holes free-fall in sync with the ship
            lag = 0;
        }
        // Earth sits at the frame origin: its contact check is always exact
        if (!WORLD.earthDestroyed && Math.sqrt(s[0] * s[0] + s[1] * s[1]) <= R_EARTH) { handleEarthContact(s); break; }
        // every other surface lies deep inside a flush zone, so these checks
        // only need to run when the ephemeris is fresh
        if (lag > 0) continue;
        if (!WORLD.moonDestroyed && Math.hypot(s[0] - eph.moonX, s[1] - eph.moonY) <= R_MOON) { handleMoonContact(s); break; }
        if (!WORLD.sunDestroyed && Math.hypot(s[0] - eph.sunX, s[1] - eph.sunY) <= R_SUN) {
            G.x = s[0]; G.y = s[1]; G.vx = s[2]; G.vy = s[3];
            H.die("Vaporized in the solar photosphere");
            break;
        }
        let hitP = -1;
        for (let i = 0; i < PL.length; i++)
            if (!WORLD.plDestroyed[i] && Math.hypot(s[0] - eph.plX[i], s[1] - eph.plY[i]) <= PL[i].R) { hitP = i; break; }
        if (hitP >= 0) { handlePlanetContact(s, hitP); break; }
        for (let i = 0; i < BH.n; i++) {
            const dBH = Math.hypot(s[0] - BH.x[i], s[1] - BH.y[i]);
            if (dBH <= BH.rs[i]) {
                G.x = s[0]; G.y = s[1]; G.vx = s[2]; G.vy = s[3];
                H.award("bh");
                H.die("Crossed the event horizon; no signal returns", true);
                break;
            }
            if (dBH <= BH.rs[i] * 1.5) {
                G.x = s[0]; G.y = s[1]; G.vx = s[2]; G.vy = s[3];
                H.award("bh");
                H.die("Crossed the photon sphere; captured into the black-hole boundary flow", true);
                break;
            }
        }
        if (G.dead) break;
    }
    if (lag > 0) { advanceEphem(lag); bhAdvance(lag, G.t); }
    G.x = s[0]; G.y = s[1]; G.vx = s[2]; G.vy = s[3];
    const rE = Math.sqrt(G.x * G.x + G.y * G.y);
    G.maxRE = Math.max(G.maxRE, rE);
    if (rE > 100000) G.leftHome = true;
    return simAdv - adv;
}

// ============================ AERO READOUT ============================
// strongest atmospheric interaction this instant (Earth or any planet with an
// atmosphere); drives the plasma sheath, camera shake, and HUD
export const AERO = { aD: 0, vx: 0, vy: 0 };
export function sampleAero() {
    AERO.aD = 0; AERO.vx = G.vx; AERO.vy = G.vy;
    if (G.dead) return AERO;
    let best = 0;
    if (!WORLD.earthDestroyed) {
        const rE = Math.sqrt(G.x * G.x + G.y * G.y), h = rE - R_EARTH;
        if (h < ATM_TOP) best = DRAG_CD * Math.exp(-Math.max(0, h) / DRAG_H) * (G.vx * G.vx + G.vy * G.vy);
    }
    for (let i = 0; i < PL.length; i++) {
        const p = PL[i];
        if (!p.atmH || WORLD.plDestroyed[i]) continue;
        const dx = G.x - eph.plX[i], dy = G.y - eph.plY[i];
        const lim = p.R + p.atmTop;
        if (dx > lim || dx < -lim || dy > lim || dy < -lim) continue;
        const h = Math.sqrt(dx * dx + dy * dy) - p.R;
        if (h >= p.atmTop) continue;
        const rvx = G.vx - eph.plVx[i], rvy = G.vy - eph.plVy[i];
        const aD = DRAG_CD * p.atmD0 * Math.exp(-Math.max(0, h) / p.atmH) * (rvx * rvx + rvy * rvy);
        if (aD > best) { best = aD; AERO.vx = rvx; AERO.vy = rvy; }
    }
    AERO.aD = best * 1000; // m/s²
    return AERO;
}
