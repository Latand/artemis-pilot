import { C_LIGHT, G_ACCEL_KMS2, SEC_YEAR } from "./constants.js";

export function betaAtCoordTime(a, t) {
    const atc = a * t / C_LIGHT;
    return atc / Math.sqrt(1 + atc * atc);
}

export function gammaAtCoordTime(a, t) {
    const atc = a * t / C_LIGHT;
    return Math.sqrt(1 + atc * atc);
}

export function distAtCoordTime(a, t) {
    const atc = a * t / C_LIGHT;
    return (C_LIGHT * C_LIGHT / a) * (Math.sqrt(1 + atc * atc) - 1);
}

export function properTimeAtCoordTime(a, t) {
    return (C_LIGHT / a) * Math.asinh(a * t / C_LIGHT);
}

export function coordTimeForDistance(a, d) {
    const q = 1 + a * d / (C_LIGHT * C_LIGHT);
    return (C_LIGHT / a) * Math.sqrt(q * q - 1);
}

export function coordTimeForProperTime(a, tau) {
    return (C_LIGHT / a) * Math.sinh(a * tau / C_LIGHT);
}

export function brachistochronePlan(distanceKm, a = G_ACCEL_KMS2) {
    const half = distanceKm / 2;
    const tHalf = coordTimeForDistance(a, half);
    const T = 2 * tHalf;
    const tauHalf = properTimeAtCoordTime(a, tHalf);
    return Object.freeze({
        a, distanceKm, half, tHalf, T,
        coordTotal: T,
        properTotal: 2 * tauHalf,
        peakGamma: 1 + a * half / (C_LIGHT * C_LIGHT),
    });
}

export function brachistochroneSample(plan, s) {
    const a = plan.a;
    const sc = Math.min(Math.max(s, 0), plan.T);
    let distKm, beta, gamma;
    if (sc <= plan.tHalf) {
        distKm = distAtCoordTime(a, sc);
        beta = betaAtCoordTime(a, sc);
        gamma = gammaAtCoordTime(a, sc);
    } else {
        const back = plan.T - sc;
        distKm = plan.distanceKm - distAtCoordTime(a, back);
        beta = betaAtCoordTime(a, back);
        gamma = gammaAtCoordTime(a, back);
    }
    const properElapsed = sc <= plan.tHalf
        ? properTimeAtCoordTime(a, sc)
        : plan.properTotal - properTimeAtCoordTime(a, plan.T - sc);
    return { distKm, beta, gamma, properElapsed };
}

export const REL = {
    active: false, phase: "off",
    plan: null, target: null,
    coordElapsed: 0,
    beta: 0, gamma: 1,
    boostX: 1, boostY: 0, boostZ: 0,
    originX: 0, originY: 0, originZ: 0,
    dirX: 1, dirY: 0, dirZ: 0,
    startTauSec: 0, startCoordT: 0,
};

export function relResetState() {
    REL.active = false;
    REL.phase = "off";
    REL.plan = null;
    REL.target = null;
    REL.coordElapsed = 0;
    REL.beta = 0;
    REL.gamma = 1;
    REL.boostX = 1;
    REL.boostY = 0;
    REL.boostZ = 0;
    REL.originX = 0;
    REL.originY = 0;
    REL.originZ = 0;
    REL.dirX = 1;
    REL.dirY = 0;
    REL.dirZ = 0;
    REL.startTauSec = 0;
    REL.startCoordT = 0;
}

export { G_ACCEL_KMS2, SEC_YEAR };
