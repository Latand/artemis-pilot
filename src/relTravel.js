import { C_LIGHT, G_ACCEL_KMS2, SEC_YEAR } from "./constants.js";
import { G } from "./state.js";
import { targetState } from "./autopilot.js";
import { advanceEphem } from "./ephemeris.js";
import { bhAdvance } from "./blackholes.js";
import { REL, relResetState } from "./relState.js";

export { REL, relResetState };

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

export function brachistochroneSampleInto(plan, s, out) {
    const a = plan.a;
    const sc = Math.min(Math.max(s, 0), plan.T);
    if (sc <= plan.tHalf) {
        out.distKm = distAtCoordTime(a, sc);
        out.beta = betaAtCoordTime(a, sc);
        out.gamma = gammaAtCoordTime(a, sc);
    } else {
        const back = plan.T - sc;
        out.distKm = plan.distanceKm - distAtCoordTime(a, back);
        out.beta = betaAtCoordTime(a, back);
        out.gamma = gammaAtCoordTime(a, back);
    }
    out.properElapsed = sc <= plan.tHalf
        ? properTimeAtCoordTime(a, sc)
        : plan.properTotal - properTimeAtCoordTime(a, plan.T - sc);
    return out;
}

export function brachistochroneSample(plan, s) {
    return brachistochroneSampleInto(plan, s, { distKm: 0, beta: 0, gamma: 1, properElapsed: 0 });
}

const _relSampA = { distKm: 0, beta: 0, gamma: 1, properElapsed: 0 };
const _relSampB = { distKm: 0, beta: 0, gamma: 1, properElapsed: 0 };

export function relTravelToFocus(toast) {
    if (REL.active) { relCancel("cancelled", toast); return; }
    const t = (G.focus === "ship" || G.focus === "free") ? null : G.focus;
    const ts = targetState(t);
    if (!ts) { toast("Relativistic travel: focus a star/body first (F / ⇧F / U)"); return; }
    const dx = ts.x - G.x, dy = ts.y - G.y, dz = (ts.z || 0) - G.z;
    const dist = Math.hypot(dx, dy, dz);
    if (!(dist > 0)) { toast("Relativistic travel: already there"); return; }
    REL.active = true; REL.phase = "accel"; REL.target = t;
    REL.plan = brachistochronePlan(dist);
    REL.coordElapsed = 0;
    REL.originX = G.x; REL.originY = G.y; REL.originZ = G.z;
    REL.dirX = dx / dist; REL.dirY = dy / dist; REL.dirZ = dz / dist;
    REL.startTauSec = G.tau; REL.startCoordT = G.t;
    REL.beta = 0; REL.gamma = 1;
    toast("Relativistic 1 g cruise to " + ts.name + " — flip-and-burn engaged");
}

export function relCancel(reason, toast) {
    if (!REL.active) return;
    relResetState();
    if (toast && reason) toast("Relativistic travel off — " + reason);
}

export function relTravelStep(simAdvSec) {
    const p = REL.plan;
    const prev = REL.coordElapsed;
    // reverse warp cannot rewind a cruise — see main.js cancel guard.
    const s = Math.min(Math.max(0, prev + simAdvSec), p.T);
    const sample = brachistochroneSampleInto(p, s, _relSampA);
    G.x = REL.originX + REL.dirX * sample.distKm;
    G.y = REL.originY + REL.dirY * sample.distKm;
    G.z = REL.originZ + REL.dirZ * sample.distKm;
    const vc = sample.beta * C_LIGHT;
    G.vx = REL.dirX * vc; G.vy = REL.dirY * vc; G.vz = REL.dirZ * vc;
    REL.beta = sample.beta; REL.gamma = sample.gamma;
    REL.boostX = REL.dirX; REL.boostY = REL.dirY; REL.boostZ = REL.dirZ;
    REL.phase = s <= p.tHalf ? "accel" : "decel";
    const dCoord = s - prev;
    const properPrev = brachistochroneSampleInto(p, prev, _relSampB).properElapsed;
    G.tau += sample.properElapsed - properPrev;
    advanceEphem(dCoord);
    bhAdvance(dCoord, G.t);
    G.t += dCoord;
    REL.coordElapsed = s;
    // float-accumulation guard - after the last step s can sit 1 ulp under T.
    if (p.T - s < 1e-6) {
        REL.beta = 0; REL.gamma = 1;
        const ts = targetState(REL.target);
        if (ts) { G.x = ts.x; G.y = ts.y; G.z = ts.z || 0; G.vx = ts.vx || 0; G.vy = ts.vy || 0; G.vz = ts.vz || 0; }
        REL.phase = "arrived";
        relResetState();
        return true;
    }
    return false;
}

export { G_ACCEL_KMS2, SEC_YEAR };
