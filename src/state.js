import { R_EARTH, MU_E, FUEL_DV0, BH_MAX, C_LIGHT, K, PL } from "./constants.js";

// ---- game state ----
export const G = {
    t: 0, tau: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    heading: 0, pitch: 0, throttle: 1,
    warp: 60, paused: false,
    uiMode: "observe",
    fuel: FUEL_DV0, infinite: true, dvUsed: 0,
    hold: null,                // 'pro' | 'retro' | null
    landed: null,              // null | {body:'earth'|'moon'|'planet', ang, i?}
    dead: false, deadReason: "",
    deathT: 0, deathRt: 0, observerMode: false,
    leftHome: false, maxRE: 0,
    gr: true, predict: false, constellations: false, darkEnergy: true, darkMatter: true, muted: false,
    cabin: false,
    focus: "ship",
    thrustMain: 0, thrustLat: 0, boost: false,
};
window.__G = G; // debug/testing handle

export const WORLD = {
    earthDestroyed: false,
    moonDestroyed: false,
    sunDestroyed: false,
    plDestroyed: new Uint8Array(PL.length),
    irreversibleFloorT: -Infinity,
    reverseBlocked: false,
    tdeInProgress: false,
};
window.__WORLD = WORLD;

export function resetWorld() {
    WORLD.earthDestroyed = false;
    WORLD.moonDestroyed = false;
    WORLD.sunDestroyed = false;
    WORLD.plDestroyed.fill(0);
    WORLD.irreversibleFloorT = -Infinity;
    WORLD.reverseBlocked = false;
    WORLD.tdeInProgress = false;
    GS.length = 0;
}

// ---- simulation clock for gravity-front bookkeeping ----
// ephemeris.js advances it on every flush; prediction snapshots carry their
// own copy so traces see the future gravity-front positions. `lo` is the
// compensation term of the same two-part representation the authoritative
// clock below uses; EPHT is re-synced to that clock at the end of every
// physics step (syncEphemClock), so the two can never drift apart.
export const EPHT = { t: 0, lo: 0 };

// ---- authoritative simulation clock (compensated) ----
// G.t is float64 seconds, whose spacing is 16 s at 1e17 s (~3 Gyr), 32 s at
// 6 Gyr, 4096 s at 2^64 s and 131072 s at 1e21 s: `G.t += dt` with a
// sub-half-ulp dt silently does nothing (60x warp froze the clock at 6 Gyr).
// The clock is therefore kept as an unevaluated sum hi + lo (Knuth TwoSum):
// G.t is always hi, the exactly-representable part, and lo carries the
// rounding residue, so G.t advances by the requested dt on average at any
// magnitude (it steps one ulp at a time once the residue exceeds half an
// ulp). Every advance of simulation time goes through advanceSimTime; a
// direct `G.t = x` (restart, quickload, jump sync) is detected on the next
// advance and adopted with a zero residue, so legacy writers stay correct.
const CLOCK = { hi: 0, lo: 0 };
const EPHT_SHADOW = { hi: 0 }; // last EPHT.t this module wrote, to detect external writes

function twoSumInto(c, dt) {
    const y = c.lo + dt;
    const s = c.hi + y;
    const bp = s - c.hi;
    c.lo = (c.hi - (s - bp)) + (y - bp);
    c.hi = s;
}

export function advanceSimTime(dt) {
    if (!Number.isFinite(dt) || dt === 0) return G.t;
    if (G.t !== CLOCK.hi) { CLOCK.hi = G.t; CLOCK.lo = 0; }
    twoSumInto(CLOCK, dt);
    G.t = CLOCK.hi;
    return G.t;
}

// Hard-set the clock (and the ephemeris clock with it): restart, quickload,
// a jump's exact arrival sync.
export function setSimTime(t) {
    CLOCK.hi = t; CLOCK.lo = 0; G.t = t;
    EPHT.t = t; EPHT.lo = 0; EPHT_SHADOW.hi = t;
}

// Residue of the authoritative clock below G.t's last representable step
// (|lo| <= ulp(G.t)/2). Zero after an external `G.t = x`.
export function simTimeLo() { return G.t === CLOCK.hi ? CLOCK.lo : 0; }

// Compensated advance of the ephemeris clock by the time the ephemeris
// actually integrated. Adopts an externally written EPHT.t with zero residue.
export function advanceEphemClock(dt) {
    if (!Number.isFinite(dt) || dt === 0) return EPHT.t;
    const c = _ephtScratch;
    c.hi = EPHT.t; c.lo = EPHT.t === EPHT_SHADOW.hi ? EPHT.lo : 0;
    twoSumInto(c, dt);
    EPHT.t = c.hi; EPHT.lo = c.lo; EPHT_SHADOW.hi = c.hi;
    return EPHT.t;
}
const _ephtScratch = { hi: 0, lo: 0 };

// One clock: once the ephemeris has caught up with the ship (end of every
// physics step), EPHT takes the authoritative value verbatim, residue and
// all, so gravity fronts, ghost stamps and BH mass events all read the same
// time as G.t.
export function syncEphemClock() {
    EPHT.t = G.t; EPHT.lo = simTimeLo(); EPHT_SHADOW.hi = EPHT.t;
}
// Snapshot/restore helpers for ephemeris.js (prediction snapshots swap the
// live ephemeris state in and out, clock included).
export function ephemClockLo() { return EPHT.t === EPHT_SHADOW.hi ? EPHT.lo : 0; }
export function setEphemClock(t, lo = 0) { EPHT.t = t; EPHT.lo = lo; EPHT_SHADOW.hi = t; }

// ---- phantom & ghost gravity sources ----
// Changes to the field propagate at c. A phantom (t = Infinity) is the frozen
// debris of a body under tidal disruption: it keeps the body's mass pulling
// from where the shredding started, coasting at the body's last velocity,
// Plummer-softened by the body radius so a hole can pass through it without
// singular kicks. When the mass is finally absorbed the phantom becomes a
// ghost (t = absorption time): the old field keeps pulling only OUTSIDE the
// light front c·(tEval − t) — the news of the absorption expands at c.
export const GS = [];
window.__GS = GS;
export function addPhantom(x, y, z, vx, vy, vz, mu, R) {
    const s = { x, y, z, vx, vy, vz, mu, R, t0: EPHT.t, t: Infinity };
    GS.push(s);
    return s;
}
// `t` defaults to the ephemeris clock gsPull tests fronts against; callers
// stamping with G.t do so after the physics step has synced EPHT to it, so
// both name the same instant.
export function addGhost(x, y, z, vx, vy, vz, mu, R, t = EPHT.t) {
    GS.push({ x, y, z, vx, vy, vz, mu, R, t0: t, t });
}
// accumulate the pull of every phantom/ghost at (x, y, z) into out
export function gsPull(x, y, zOrT, maybeT, maybeOut) {
    const z = maybeOut === undefined ? 0 : zOrT;
    const tEval = maybeOut === undefined ? zOrT : maybeT;
    const out = maybeOut === undefined ? maybeT : maybeOut;
    for (let k = 0; k < GS.length; k++) {
        const s = GS[k];
        const ft = (tEval - s.t) * C_LIGHT;
        if (ft > 0) {
            const fx = x - s.x, fy = y - s.y, fz = z - (s.z || 0); // front expands from the event point
            if (fx * fx + fy * fy + fz * fz <= ft * ft) continue; // news arrived: source gone
        }
        const age = tEval - s.t0;
        const dx = x - (s.x + s.vx * age), dy = y - (s.y + s.vy * age), dz = z - ((s.z || 0) + (s.vz || 0) * age);
        const s2 = dx * dx + dy * dy + dz * dz + s.R * s.R;
        const w = s.mu / (s2 * Math.sqrt(s2));
        out[0] -= w * dx; out[1] -= w * dy;
        if (out.length > 2) out[2] -= w * dz;
    }
}

export function isBodyDestroyed(target) {
    return target === "earth" ? WORLD.earthDestroyed :
        target === "moon" ? WORLD.moonDestroyed :
            target === "sun" ? WORLD.sunDestroyed :
                typeof target === "number" ? WORLD.plDestroyed[target] === 1 : false;
}

export function destroyBody(target) {
    WORLD.irreversibleFloorT = Math.max(WORLD.irreversibleFloorT, G.t);
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
    CLOCK.hi = 0; CLOCK.lo = 0;
    G.t = 0; G.tau = 0;
    G.x = r0 * Math.cos(th0); G.y = r0 * Math.sin(th0); G.z = 0;
    G.vx = -v0 * Math.sin(th0); G.vy = v0 * Math.cos(th0); G.vz = 0;
    G.heading = Math.atan2(G.vy, G.vx);
    G.pitch = 0;
    G.fuel = FUEL_DV0; G.dvUsed = 0;
    G.landed = null; G.dead = false; G.deadReason = ""; G.deathT = 0; G.deathRt = 0; G.observerMode = false;
    G.leftHome = false; G.maxRE = r0;
    G.hold = null; G.warp = 60; G.paused = false; G.throttle = 1; G.darkEnergy = true; G.darkMatter = true;
    G.cabin = false;
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
    kind: new Uint8Array(BH_MAX),      // 0 hole, 1 quasar, 2 pulsar (WP-X1 rail)
    period: new Float64Array(BH_MAX),  // pulsar spin period, s (0 otherwise)
    placeCount: 0,                     // user-action counter -> deterministic placement seeds
    // per-hole mass-gain events {x, y, z, t, dmu}: birth, absorptions, and
    // merger inheritance — each delta's influence expands at c from that point
    ev: new Array(BH_MAX).fill(null),
};
window.__BH = BH;
export function bhRegister(i, xKm, yKm, rsKm, vx0 = 0, vy0 = 0, events = null, kind = 0, period = 0) {
    BH.x[i] = xKm; BH.y[i] = yKm; BH.rs[i] = rsKm;
    BH.vx[i] = vx0; BH.vy[i] = vy0;
    BH.mu[i] = rsKm * C_LIGHT * C_LIGHT / 2;
    BH.sx[i] = xKm * K; BH.sz[i] = -yKm * K;
    BH.c[i] = .001 * Math.sqrt(2 * BH.mu[i] / 1000);
    BH.sinkS[i] = rsKm * K;
    BH.obsT[i] = 1;
    BH.ev[i] = events && events.length ? events.map(e => ({ z: 0, ...e }))
        : [{ x: xKm, y: yKm, z: 0, t: -1e18, dmu: BH.mu[i] }];
    BH.kind[i] = kind;
    BH.period[i] = period;
    if (kind === 2) BH.sinkS[i] = 12 * K; // neutron star captures at its ~12 km surface
}
// hole i's gravitational parameter as felt at (x, y, z): only the mass deltas
// whose light fronts have reached the point contribute
export function bhMuAt(i, x, y, zOrT, maybeT) {
    const z = maybeT === undefined ? 0 : zOrT;
    const tEval = maybeT === undefined ? zOrT : maybeT;
    const ev = BH.ev[i];
    if (!ev) return BH.mu[i];
    let mu = 0;
    for (let k = 0; k < ev.length; k++) {
        const e = ev[k];
        const ft = (tEval - e.t) * C_LIGHT;
        if (ft <= 0) continue;
        const dx = x - e.x, dy = y - e.y, dz = z - (e.z || 0);
        if (dx * dx + dy * dy + dz * dz <= ft * ft) mu += e.dmu;
    }
    return mu;
}
// restart rewinds the clock to 0: treat surviving holes as long-established
export function rebaseBHEvents() {
    for (let i = 0; i < BH.n; i++)
        BH.ev[i] = [{ x: BH.x[i], y: BH.y[i], z: 0, t: -1e18, dmu: BH.mu[i] }];
}
window.__bhMuAt = bhMuAt; // debug/testing handle
window.__EPHT = EPHT;
