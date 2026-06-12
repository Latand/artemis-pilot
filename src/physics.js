import {
    MU_E, MU_M, MU_S, R_EARTH, R_MOON, R_SUN,
    PL, SOI_M, SOI_E, DRAG_CD, DRAG_H, ATM_TOP, MAX_STEPS_FRAME,
} from "./constants.js";
import { eph, updEphem, moonState, planetVel, relGravityAt, advanceEphem } from "./ephemeris.js";
import { G, BH } from "./state.js";
import { bhAdvance } from "./blackholes.js";
import { fmtMET, fmtKm } from "./format.js";

// hooks into the presentation layer, wired once by main.js
let H = { die: () => { }, award: () => { }, banner: () => { }, hideBanner: () => { } };
export function initPhysicsHooks(hooks) { H = hooks; }

const _m = { mx: 0, my: 0, vmx: 0, vmy: 0, ang: 0 };
const _pv = { vx: 0, vy: 0 };

// derivative of [x,y,vx,vy] incl. the live n-body field in the Earth-relative
// frame, PW black holes, atmosphere drag, thrust
export function deriv(x, y, vx, vy, t, atx, aty, out) {
    relGravityAt(x, y, _ga);
    let ax = _ga[0], ay = _ga[1];
    const rE = Math.hypot(x, y);
    const h = rE - R_EARTH;
    if (h < ATM_TOP) {
        const rho = Math.exp(-Math.max(0, h) / DRAG_H);
        const v = Math.hypot(vx, vy);
        const f = -DRAG_CD * rho * v;
        ax += f * vx; ay += f * vy;
    }
    out[0] = vx; out[1] = vy; out[2] = ax + atx; out[3] = ay + aty;
}

const _ga = [0, 0];
const _k1 = [0, 0, 0, 0], _k2 = [0, 0, 0, 0], _k3 = [0, 0, 0, 0], _k4 = [0, 0, 0, 0], _st = [0, 0, 0, 0];
export function rk4Step(s, t, dt, atx, aty) {
    deriv(s[0], s[1], s[2], s[3], t, atx, aty, _k1);
    for (let i = 0; i < 4; i++) _st[i] = s[i] + .5 * dt * _k1[i];
    deriv(_st[0], _st[1], _st[2], _st[3], t + .5 * dt, atx, aty, _k2);
    for (let i = 0; i < 4; i++) _st[i] = s[i] + .5 * dt * _k2[i];
    deriv(_st[0], _st[1], _st[2], _st[3], t + .5 * dt, atx, aty, _k3);
    for (let i = 0; i < 4; i++) _st[i] = s[i] + dt * _k3[i];
    deriv(_st[0], _st[1], _st[2], _st[3], t + dt, atx, aty, _k4);
    for (let i = 0; i < 4; i++) s[i] += dt / 6 * (_k1[i] + 2 * _k2[i] + 2 * _k3[i] + _k4[i]);
}

export function stepSize(rE, rM, rS, h, vTot, x, y) {
    const tE = Math.sqrt(rE * rE * rE / MU_E), tM = Math.sqrt(rM * rM * rM / MU_M);
    const tS = Math.sqrt(rS * rS * rS / MU_S);
    let dt = Math.min(tE, tM, tS) / 90;
    // approaching the atmosphere fast: never let one step jump across the shell
    if (h < 1200) dt = Math.min(dt, Math.max(.4, .22 * Math.max(40, h - 90) / Math.max(.01, vTot)));
    if (h < ATM_TOP + 60) {
        dt = Math.min(dt, .9);
        // bound drag Δv to ~5 % of speed per step or RK4 blows up on the exp profile
        const aD = DRAG_CD * Math.exp(-Math.max(0, h) / DRAG_H) * vTot;
        if (aD > 1e-6) dt = Math.min(dt, .05 / aD);
    }
    for (let i = 0; i < PL.length; i++) {
        const d = Math.hypot(x - eph.plX[i], y - eph.plY[i]);
        if (d < PL[i].soi * 3) {
            const tP = Math.sqrt(d * d * d / PL[i].mu) / 90;
            if (tP < dt) dt = tP;
            const gap = d - PL[i].R;
            if (gap < 60000) dt = Math.min(dt, Math.max(.5, .2 * Math.max(200, gap) / Math.max(.01, vTot)));
        }
    }
    let floor = 0.02;
    for (let i = 0; i < BH.n; i++) {
        const d = Math.hypot(x - BH.x[i], y - BH.y[i]);
        const tB = Math.sqrt(d * d * d / BH.mu[i]) / 60;
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
        const d = Math.hypot(G.x - eph.plX[i], G.y - eph.plY[i]);
        if (d < pNearD) { pNearD = d; pNear = i; }
    }
    const domMoon = rM < SOI_M;
    const domPl = !domMoon && pNear >= 0 && pNearD < PL[pNear].soi;
    const domSun = !domMoon && !domPl && rE > SOI_E;
    let mu, rx, ry, rvx, rvy, R, body;
    if (domMoon) { mu = MU_M; rx = dxm; ry = dym; rvx = G.vx - _m.vmx; rvy = G.vy - _m.vmy; R = R_MOON; body = "MOON"; }
    else if (domPl) {
        const p = PL[pNear];
        planetVel(pNear, G.t, _pv);
        mu = p.mu; rx = G.x - eph.plX[pNear]; ry = G.y - eph.plY[pNear];
        rvx = G.vx - _pv.vx; rvy = G.vy - _pv.vy; R = p.R; body = p.name;
    }
    else if (domSun) { mu = MU_S; rx = sdx; ry = sdy; rvx = G.vx; rvy = G.vy; R = R_SUN; body = "SUN"; }
    else { mu = MU_E; rx = G.x; ry = G.y; rvx = G.vx; rvy = G.vy; R = R_EARTH; body = "EARTH"; }
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
export function advance(simAdv, atx, aty, aMag) {
    let adv = simAdv, steps = 0;
    const s = _gs;
    s[0] = G.x; s[1] = G.y; s[2] = G.vx; s[3] = G.vy;
    while (adv > 1e-9 && steps < MAX_STEPS_FRAME && !G.dead && !G.landed) {
        updEphem(G.t);
        const rE = Math.hypot(s[0], s[1]);
        moonState(G.t, _m);
        const rM = Math.hypot(s[0] - _m.mx, s[1] - _m.my);
        const rS = Math.hypot(s[0] - eph.sunX, s[1] - eph.sunY);
        const dt = Math.min(stepSize(rE, rM, rS, rE - R_EARTH, Math.hypot(s[2], s[3]), s[0], s[1]), adv);
        rk4Step(s, G.t, dt, atx, aty);
        advanceEphem(dt);
        bhAdvance(dt, G.t); // holes free-fall in sync with the ship
        G.t += dt; adv -= dt; steps++;
        if (aMag > 0) {
            const dv = aMag * dt * 1000;
            G.dvUsed += dv;
            if (!G.infinite) {
                G.fuel -= dv;
                if (G.fuel <= 0) { G.fuel = 0; atx = 0; aty = 0; aMag = 0; }
            }
        }
        updEphem(G.t);
        const rE2 = Math.hypot(s[0], s[1]);
        if (rE2 <= R_EARTH) { handleEarthContact(s); break; }
        moonState(G.t, _m);
        if (Math.hypot(s[0] - _m.mx, s[1] - _m.my) <= R_MOON) { handleMoonContact(s); break; }
        if (Math.hypot(s[0] - eph.sunX, s[1] - eph.sunY) <= R_SUN) {
            G.x = s[0]; G.y = s[1]; G.vx = s[2]; G.vy = s[3];
            H.die("Vaporized in the solar photosphere");
            break;
        }
        let hitP = -1;
        for (let i = 0; i < PL.length; i++)
            if (Math.hypot(s[0] - eph.plX[i], s[1] - eph.plY[i]) <= PL[i].R) { hitP = i; break; }
        if (hitP >= 0) { handlePlanetContact(s, hitP); break; }
        for (let i = 0; i < BH.n; i++) {
            if (Math.hypot(s[0] - BH.x[i], s[1] - BH.y[i]) <= BH.rs[i] * 1.5) {
                G.x = s[0]; G.y = s[1]; G.vx = s[2]; G.vy = s[3];
                H.award("bh");
                H.die("Plunged inside the photon sphere — spaghettified past the event horizon", true);
                break;
            }
        }
        if (G.dead) break;
    }
    G.x = s[0]; G.y = s[1]; G.vx = s[2]; G.vy = s[3];
    const rE = Math.hypot(G.x, G.y);
    G.maxRE = Math.max(G.maxRE, rE);
    if (rE > 100000) G.leftHome = true;
    return simAdv - adv;
}
