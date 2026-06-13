import { C_LIGHT, MU_E, MU_M, MU_S, PL, R_EARTH, R_MOON, R_SUN, STARS } from "./constants.js";
import { BH, G, WORLD } from "./state.js";
import { eph } from "./ephemeris.js";

const C2 = C_LIGHT * C_LIGHT;

function addCurvature(curv, mu, r, floorR = 1e-9) {
    if (!(mu > 0)) return curv;
    return curv + 2 * mu / (C2 * Math.max(floorR, r));
}

export function schwarzschildRadiusKm(mu) {
    return 2 * mu / C2;
}

export function clockRateAtShip() {
    let curv = 0;
    if (!WORLD.earthDestroyed) curv = addCurvature(curv, MU_E, Math.hypot(G.x, G.y), R_EARTH);
    if (!WORLD.moonDestroyed) curv = addCurvature(curv, MU_M, Math.hypot(G.x - eph.moonX, G.y - eph.moonY), R_MOON);
    if (!WORLD.sunDestroyed) curv = addCurvature(curv, MU_S, Math.hypot(G.x - eph.sunX, G.y - eph.sunY), R_SUN);
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        curv = addCurvature(curv, PL[i].mu, Math.hypot(G.x - eph.plX[i], G.y - eph.plY[i]), PL[i].R);
    }
    const wx = eph.earthX + G.x;
    const wy = eph.earthY + G.y;
    for (const star of STARS) {
        const floorR = star.bh ? Math.max(star.rs * 1.002, star.R) : star.R;
        curv = addCurvature(curv, star.mu, Math.hypot(wx - star.x, wy - star.y), floorR);
    }
    for (let i = 0; i < BH.n; i++) {
        const floorR = Math.max(BH.rs[i] * 1.002, 1e-9);
        curv = addCurvature(curv, BH.mu[i], Math.hypot(G.x - BH.x[i], G.y - BH.y[i]), floorR);
    }
    const vx = G.vx + eph.earthVx;
    const vy = G.vy + eph.earthVy;
    const speedTerm = (vx * vx + vy * vy) / C2;
    const rate = Math.sqrt(Math.max(1e-6, 1 - curv - speedTerm));
    return { rate, curv, speedTerm };
}

export function clockRateLabel(rate) {
    const slow = Math.max(0, 1 - rate);
    if (slow < 1e-12) return (slow * 1e15).toFixed(2) + " fs/s slow";
    if (slow < 1e-9) return (slow * 1e12).toFixed(2) + " ps/s slow";
    if (slow < 1e-6) return (slow * 1e9).toFixed(2) + " ns/s slow";
    if (slow < 1e-3) return (slow * 1e6).toFixed(2) + " us/s slow";
    return (rate * 100).toFixed(3) + "% local";
}
