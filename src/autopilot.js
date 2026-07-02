import { MU_E, MU_M, MU_S, R_EARTH, R_MOON, R_SUN, PL, STARS, MAIN_A, ROT_RATE, SOI_M, AU_KM } from "./constants.js";
import { G } from "./state.js";
import { eph, moonState, planetVel } from "./ephemeris.js";
import { activeStarForFocus, getCachedFocusedSystem } from "./universe/activeStars.js";
import { planetFocusIndex, planetWorldState } from "./universe/planetarySystem.js";

// Flight computer: flies the ship so the player can watch the physics, and
// hands the stick back the instant any manual input arrives.
//   travel  — flip-and-burn intercept of the focused body/star, then capture
//   circ    — circularize around the dominant body at the current radius
// Thrust goes through the exact same MAIN_A path as the player's keys, so
// Δv accounting, fuel, exhaust, and the prediction all behave identically.
export const AP = { mode: "off", phase: "", msg: "", target: null };

const _m = { mx: 0, my: 0, vmx: 0, vmy: 0, ang: 0 };
const _pv = { vx: 0, vy: 0 };
const _pw = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };

// target state in the ship's Earth-relative frame
export function targetState(t) {
    if (t == null) return null;
    if (typeof t === "number") {
        if (!PL[t]) return null;
        planetVel(t, G.t, _pv);
        return { x: eph.plX[t], y: eph.plY[t], z: 0, vx: _pv.vx, vy: _pv.vy, vz: 0, R: PL[t].R, mu: PL[t].mu, name: PL[t].name, soi: PL[t].soi };
    }
    if (t === "moon") { moonState(G.t, _m); return { x: _m.mx, y: _m.my, z: 0, vx: _m.vmx, vy: _m.vmy, vz: 0, R: R_MOON, mu: MU_M, name: "MOON", soi: SOI_M }; }
    if (t === "earth") return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, R: R_EARTH, mu: MU_E, name: "EARTH", soi: 924000 };
    if (t === "sun") return { x: eph.sunX, y: eph.sunY, z: 0, vx: eph.sunVx, vy: eph.sunVy, vz: 0, R: R_SUN, mu: MU_S, name: "SUN", soi: 5e9 };
    const pi = planetFocusIndex(t);
    if (pi >= 0) {
        const sys = getCachedFocusedSystem();
        const p = sys?.planets?.[pi];
        if (!p || !planetWorldState(sys, pi, sys.hostStar, G.t, _pw)) return null;
        const soi = Math.max(p.radiusKm * 3, p.a * AU_KM * Math.pow(p.mu / Math.max(1, sys.hostStar?.mu || MU_S), 0.4));
        return {
            x: _pw.x - eph.earthX, y: _pw.y - eph.earthY, z: _pw.z,
            vx: _pw.vx - eph.earthVx, vy: _pw.vy - eph.earthVy, vz: _pw.vz,
            R: p.radiusKm, mu: p.mu, name: p.name || ("P" + (pi + 1)), soi,
        };
    }
    const m = typeof t === "string" && t.match(/^star:(\d+)$/);
    if (m) {
        const st = STARS[+m[1]];
        if (!st) return null;
        return { x: st.x - eph.earthX, y: st.y - eph.earthY, z: st.z || 0, vx: -eph.earthVx, vy: -eph.earthVy, vz: 0, R: st.R, mu: st.mu, name: st.name, star: true, ref: st, id: st.id || "", bh: !!st.bh };
    }
    const proc = activeStarForFocus(t);
    if (proc) {
        return { x: proc.x - eph.earthX, y: proc.y - eph.earthY, z: proc.z || 0, vx: -eph.earthVx, vy: -eph.earthVy, vz: 0, R: proc.R, mu: proc.mu, name: proc.name, star: true, ref: proc, id: proc.id || "", bh: !!proc.bh, procedural: true, activeCatalog: !!proc.activeCatalog };
    }
    return null;
}

export function orbitInfoMatchesTarget(oi, ts) {
    if (ts.star) return !!oi.domStar && (oi.star === ts.ref || (!!ts.id && oi.starId === ts.id));
    return ts.name === oi.body;
}

export function apTravelToFocus(toast) {
    const t = G.focus === "ship" || G.focus === "free" ? null : G.focus;
    const ts = targetState(t);
    if (!ts) { toast("Autopilot: focus a body or star first (F / ⇧F / U / click label)"); return; }
    AP.mode = "travel";
    AP.phase = "accel";
    AP.target = t;
    AP.msg = "EN ROUTE " + ts.name;
    toast("Autopilot: travelling to " + ts.name + " · take the stick any time");
}
export function apCircularize(toast) {
    AP.mode = "circ";
    AP.phase = "burn";
    AP.target = null;
    AP.msg = "CIRCULARIZING";
    toast("Autopilot: circularizing at current radius");
}
export function apOff(reason, toast) {
    if (AP.mode === "off") return;
    AP.mode = "off"; AP.phase = ""; AP.msg = "";
    if (toast && reason) toast("Autopilot off — " + reason);
}

// rotate the nose toward a desired angle, autopilot-fast but bounded
function steerYawPitch(wantYaw, wantPitch, dtR) {
    let d = wantYaw - G.heading;
    d = ((d + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const mx = ROT_RATE * 3 * dtR;
    G.heading += Math.abs(d) <= mx ? d : Math.sign(d) * mx;
    const dp = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, wantPitch)) - (G.pitch || 0);
    G.pitch = (G.pitch || 0) + (Math.abs(dp) <= mx ? dp : Math.sign(dp) * mx);
    return Math.hypot(d, dp) < .25; // aligned enough to burn
}
function steerVector(x, y, z, dtR) {
    const h = Math.hypot(x, y);
    return steerYawPitch(Math.atan2(y, x), Math.atan2(z, h), dtR);
}
function thrustVector(a) {
    const cp = Math.cos(G.pitch || 0);
    return {
        atx: a * cp * Math.cos(G.heading),
        aty: a * cp * Math.sin(G.heading),
        atz: a * Math.sin(G.pitch || 0),
        aMag: a,
        mainIn: 1,
    };
}

export function circularVelocityVector(rx, ry, rz, rvx, rvy, rvz, mu, out = { x: 0, y: 0, z: 0 }) {
    const r = Math.hypot(rx, ry, rz) || 1;
    const vc = Math.sqrt(mu / r);
    let hx = ry * rvz - rz * rvy;
    let hy = rz * rvx - rx * rvz;
    let hz = rx * rvy - ry * rvx;
    let h = Math.hypot(hx, hy, hz);
    if (h < 1e-12) {
        hx = -ry;
        hy = rx;
        hz = 0;
        h = Math.hypot(hx, hy, hz);
        if (h < 1e-12) { hx = 0; hy = -rz; hz = ry; h = Math.hypot(hx, hy, hz) || 1; }
    }
    out.x = vc * (hy * rz - hz * ry) / (h * r);
    out.y = vc * (hz * rx - hx * rz) / (h * r);
    out.z = vc * (hx * ry - hy * rx) / (h * r);
    return out;
}

// arrival orbit radius per target class
function arrivalRadius(ts) {
    if (ts.bh) return ts.R * 14;             // stand well off the photon sphere
    if (ts.star) return ts.R * 24;
    return Math.max(ts.R * 3.2, Math.min(ts.soi * .25, ts.R * 60));
}

// Returns {atx, aty, atz, aMag, mainIn} or null when idle. dtSim is this frame's
// sim-time advance (dtR · warp): burn decisions must use sim-time impulse.
export function apStep(dtR, dtSim, oi, hooks) {
    if (AP.mode === "off" || G.dead || G.paused) return null;
    if (G.landed) { apOff("on the surface", hooks.toast); return null; }
    G.hold = null;
    if (AP.mode === "circ") {
        // burn toward the circular velocity vector at the current radius
        const { rx, ry, rz = 0, rvx, rvy, rvz = 0, mu } = oi;
        const want = circularVelocityVector(rx, ry, rz, rvx, rvy, rvz, mu);
        const dvx = want.x - rvx, dvy = want.y - rvy, dvz = want.z - rvz;
        const dv = Math.hypot(dvx, dvy, dvz);
        AP.msg = "CIRC Δv " + (dv * 1000).toFixed(0) + " m/s";
        if (dv < .004) { apOff("orbit circularized", hooks.toast); return null; }
        const aligned = steerVector(dvx, dvy, dvz, dtR);
        if (!aligned) return { atx: 0, aty: 0, atz: 0, aMag: 0, mainIn: 0 };
        // throttle down near the end so we don't overshoot in one sim step
        const a = Math.min(MAIN_A * Math.max(G.throttle, 1), dv / Math.max(dtSim, 1e-6) * .8);
        return thrustVector(a);
    }
    // ---- travel ----
    const ts = targetState(AP.target);
    if (!ts) { apOff("target lost", hooks.toast); return null; }
    const dx = ts.x - G.x, dy = ts.y - G.y, dz = (ts.z || 0) - G.z;
    const dist = Math.hypot(dx, dy, dz);
    // bound to a different body: climb out prograde first —
    // pointing at the target from low orbit just flies you into the ground
    const domIsTarget = orbitInfoMatchesTarget(oi, ts);
    if (!domIsTarget && oi.E < 0 && oi.mu > 1e4 && dist > oi.r * 1.5) {
        AP.phase = "climb";
        AP.msg = "CLIMBING OUT OF " + oi.body + " ORBIT";
        const aligned = steerVector(oi.rvx, oi.rvy, oi.rvz || 0, dtR);
        if (!aligned) return { atx: 0, aty: 0, atz: 0, aMag: 0, mainIn: 0 };
        const a = MAIN_A * Math.max(G.throttle, 1) * 4;
        return thrustVector(a);
    }
    const rArr = arrivalRadius(ts);
    const wx = G.vx - ts.vx, wy = G.vy - ts.vy, wz = G.vz - (ts.vz || 0);        // velocity relative to target
    const closing = (wx * dx + wy * dy + wz * dz) / Math.max(dist, 1e-9); // >0 → approaching
    const wMag = Math.hypot(wx, wy, wz);
    const aCap = MAIN_A * Math.max(G.throttle, 1) * 4; // autopilot may use boost-grade accel
    if (dist <= rArr * 1.6 && wMag < Math.sqrt((ts.mu || 1) / Math.max(rArr, 1)) * 1.5) {
        if (ts.mu > 1e4) {
            AP.mode = "circ"; AP.phase = "capture";
            hooks.toast("Autopilot: arrived at " + ts.name + " — capturing orbit");
            return null;
        }
        apOff("arrived at " + ts.name, hooks.toast);
        return null;
    }
    // stopping distance at full deceleration against current closing speed
    const sStop = closing > 0 ? closing * closing / (2 * aCap) : 0;
    let phase, tx, ty, tz;
    if (closing > 0 && dist - rArr < sStop * 1.2) {
        phase = "brake";
        tx = -wx; ty = -wy; tz = -wz; // kill relative velocity
    } else if (wMag > 1e-6 && closing < wMag * .92) {
        // course correction: steer the relative velocity onto the target line
        phase = "align";
        tx = dx / dist * Math.max(wMag, .01) - wx;
        ty = dy / dist * Math.max(wMag, .01) - wy;
        tz = dz / dist * Math.max(wMag, .01) - wz;
    } else {
        phase = "accel";
        tx = dx; ty = dy; tz = dz;
    }
    AP.phase = phase;
    AP.msg = ts.name + " " + (dist > 1e9 ? (dist / 9.4607e12).toFixed(3) + " ly" : Math.round(dist).toLocaleString("en-US") + " km") +
        " · rel " + (wMag >= 1000 ? Math.round(wMag).toLocaleString("en-US") : wMag.toFixed(2)) + " km/s";
    const aligned = steerVector(tx, ty, tz, dtR);
    if (!aligned) return { atx: 0, aty: 0, atz: 0, aMag: 0, mainIn: 0 };
    let a = aCap;
    if (phase === "brake") a = Math.min(aCap, closing / Math.max(dtSim, 1e-6) * .9);
    return thrustVector(a);
}
