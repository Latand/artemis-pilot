// Observer-relative time: what the camera can see NOW of a distant source.
//
// The simulation state is authoritative and advances in coordinate time
// (G.t). What reaches the observer from a source at distance d left it at the
// retarded time
//
//     t_obs = t_sim - d / c
//
// so every time-dependent VISUAL (a flare, a star's evolutionary phase, a
// galaxy's position on its orbit) should be evaluated at t_obs for the
// camera's position, while the physics keeps using t_sim. Separating the two
// is what lets a nearby and a distant observer see the same event at
// different stages without changing the simulation itself.
//
// Domain of validity: flat-space light travel in the simulator's world frame
// (heliocentric/barycentric J2000 ecliptic km). Gravitational (Shapiro) delay
// and cosmological light cones are not included here; the large-scale layer
// uses its own comoving-distance treatment on top of this (see
// cosmicExpansion.js). The source's own motion during the light-travel time
// is handled by callers that know it (retardedTimeMoving below does one
// fixed-point refinement for a source with a known velocity).
//
// Pure module: main.js publishes the camera state once per frame via
// setObserver(); consumers only read it.

export const C_KM_S = 299792.458;

const OBS = { x: 0, y: 0, z: 0, t: 0, valid: false };

// World-frame km of the camera and the authoritative sim time this frame.
export function setObserver(xKm, yKm, zKm, tSim) {
    OBS.x = xKm; OBS.y = yKm; OBS.z = zKm; OBS.t = tSim; OBS.valid = true;
}

export function observerState() { return OBS; }

export function lightTravelSeconds(distKm) {
    return Math.max(0, distKm) / C_KM_S;
}

// Retarded (emission) time for light from a source at world km (x, y, z)
// reaching the current observer. Falls back to the sim time when no observer
// has been published (headless smokes, early startup).
export function observedTimeAt(x, y, z, tSim = OBS.t) {
    if (!OBS.valid) return tSim;
    const d = Math.hypot(x - OBS.x, y - OBS.y, z - OBS.z);
    return tSim - d / C_KM_S;
}

// Same, for a source moving with velocity (vx, vy, vz) km/s whose position is
// given at tSim: one fixed-point step of t_e = t - |r(t_e) - r_obs|/c, which
// is exact for uniform motion to O(v^2/c^2).
export function retardedTimeMoving(x, y, z, vx, vy, vz, tSim = OBS.t) {
    if (!OBS.valid) return tSim;
    let te = tSim - Math.hypot(x - OBS.x, y - OBS.y, z - OBS.z) / C_KM_S;
    const dt = te - tSim;
    te = tSim - Math.hypot(x + vx * dt - OBS.x, y + vy * dt - OBS.y, z + vz * dt - OBS.z) / C_KM_S;
    return te;
}

// Whether a source-to-observer delay is large enough to matter at the given
// warp (sim seconds per real second): delays under one real frame are
// visually indistinguishable from "now" and callers may skip retarded
// evaluation entirely.
export function delayIsVisible(distKm, warp, frameSeconds = 1 / 60) {
    return distKm / C_KM_S > Math.abs(warp) * frameSeconds;
}
