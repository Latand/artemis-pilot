import { R_EARTH, MU_E, FUEL_DV0, BH_MAX, C_LIGHT, K, PL } from "./constants.js";

// ---- game state ----
export const G = {
    t: 0, x: 0, y: 0, vx: 0, vy: 0,
    heading: 0, throttle: 1,
    warp: 60, paused: false,
    fuel: FUEL_DV0, infinite: true, dvUsed: 0,
    hold: null,                // 'pro' | 'retro' | null
    landed: null,              // null | {body:'earth'|'moon'|'planet', ang, i?}
    dead: false, deadReason: "",
    deathT: 0, deathRt: 0, observerMode: false,
    leftHome: false, maxRE: 0,
    gr: true, predict: true, muted: false,
    focus: "ship",
    thrustMain: 0, thrustLat: 0, boost: false,
};
window.__G = G; // debug/testing handle

export const WORLD = {
    earthDestroyed: false,
    moonDestroyed: false,
    sunDestroyed: false,
    plDestroyed: new Uint8Array(PL.length),
};
window.__WORLD = WORLD;

export function resetWorld() {
    WORLD.earthDestroyed = false;
    WORLD.moonDestroyed = false;
    WORLD.sunDestroyed = false;
    WORLD.plDestroyed.fill(0);
}

export function isBodyDestroyed(target) {
    return target === "earth" ? WORLD.earthDestroyed :
        target === "moon" ? WORLD.moonDestroyed :
            target === "sun" ? WORLD.sunDestroyed :
                typeof target === "number" ? WORLD.plDestroyed[target] === 1 : false;
}

export function destroyBody(target) {
    if (target === "earth") WORLD.earthDestroyed = true;
    else if (target === "moon") WORLD.moonDestroyed = true;
    else if (target === "sun") WORLD.sunDestroyed = true;
    else if (typeof target === "number" && target >= 0 && target < PL.length) WORLD.plDestroyed[target] = 1;
}

export const keys = new Set();
window.__keys = keys; // debug/testing handle

export function resetShip() {
    resetWorld();
    const r0 = R_EARTH + 300, th0 = -0.6;
    const v0 = Math.sqrt(MU_E / r0);
    G.t = 0;
    G.x = r0 * Math.cos(th0); G.y = r0 * Math.sin(th0);
    G.vx = -v0 * Math.sin(th0); G.vy = v0 * Math.cos(th0);
    G.heading = Math.atan2(G.vy, G.vx);
    G.fuel = FUEL_DV0; G.dvUsed = 0;
    G.landed = null; G.dead = false; G.deadReason = ""; G.deathT = 0; G.deathRt = 0; G.observerMode = false;
    G.leftHome = false; G.maxRE = r0;
    G.hold = null; G.warp = 60; G.paused = false; G.throttle = 1;
}

// ---- black holes (data; visuals live in blackholes.js) ----
export const BH = {
    n: 0,
    sizeIdx: 5,
    x: new Float64Array(BH_MAX), y: new Float64Array(BH_MAX),
    vx: new Float64Array(BH_MAX), vy: new Float64Array(BH_MAX),
    mu: new Float64Array(BH_MAX), rs: new Float64Array(BH_MAX),
    sx: new Float64Array(BH_MAX), sz: new Float64Array(BH_MAX),
    c: new Float64Array(BH_MAX), sinkS: new Float64Array(BH_MAX),
    obsT: new Float64Array(BH_MAX),
};
window.__BH = BH;
export function bhRegister(i, xKm, yKm, rsKm, vx0 = 0, vy0 = 0) {
    BH.x[i] = xKm; BH.y[i] = yKm; BH.rs[i] = rsKm;
    BH.vx[i] = vx0; BH.vy[i] = vy0;
    BH.mu[i] = rsKm * C_LIGHT * C_LIGHT / 2;
    BH.sx[i] = xKm * K; BH.sz[i] = -yKm * K;
    BH.c[i] = .001 * Math.sqrt(2 * BH.mu[i] / 1000);
    BH.sinkS[i] = rsKm * K;
    BH.obsT[i] = 1;
}
