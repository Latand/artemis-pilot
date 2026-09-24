// Milky Way - Andromeda relative orbit (pure; shared by cosmic.js, the galaxy
// population renderer and the tidal-debris model, universe/mergerTides.js).
import { galacticToWorld, raDecToWorldUnitInto, R0_PC, Z_SUN_PC, PC_KM } from "./coords.js";

const SEC_YEAR = 31557600;
function smooth01(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}
// WP23a - Milky Way / Andromeda approach, merger, and Local-Group dynamics.
//
// Initial conditions (van der Marel, Fardal, Besla et al. 2012, ApJ 753, 8,
// "The M31 Velocity Vector II"): current 3-D separation ~770-785 kpc, radial
// (closing) velocity ~-109 to -117 km/s, and a small, poorly-constrained
// transverse component; 30 km/s is used here so the approach shows a visible
// off-axis swing rather than a perfectly radial plunge. Halo-inclusive
// virial masses (~1.3e12 Msun MW, ~1.5e12 Msun M31) follow the same paper's
// Local Group mass budget.
//
// Model: the reduced two-body problem for the MW-M31 separation vector,
// integrated once into a cached time -> position lookup table (no per-frame
// integration - a deterministic KDK leapfrog runs once, lazily, on first
// use). Each galaxy is a Hernquist (1990) sphere of its total mass (scale
// radii 21 / 22 kpc, from the observed circular speeds; see
// universe/mergerTides.js), and each centre is accelerated as a test mass
// in the other's potential, G M / (r + a)^2: the same force the tidal-debris
// particles feel, so a galaxy's own stars follow its centre instead of being
// left behind (at pericentre a point-mass law would pull the centres twice
// as hard as the extended halos pull their stars). A velocity-proportional
// drag switches on once the halos are close enough to overlap - the
// qualitative signature of dynamical friction (Chandrasekhar 1943, ApJ 97,
// 255: drag opposes the relative velocity and grows with local density)
// WITHOUT evaluating the literal Chandrasekhar formula (that needs a halo
// density profile + Coulomb logarithm this sim doesn't carry); the drag's
// radial turn-on scale and strength are tuned so the resulting timeline
// (first passage ~4 Gyr, captured under 50 kpc by ~7 Gyr, effectively
// coalesced within ~10-15 Gyr) matches the literature's ~4 Gyr first-passage
// / ~6-10 Gyr merger-completion range (van der Marel+ 2012b, ApJ 753, 9;
// Cox & Loeb 2008, MNRAS 386, 461; Schiavi+ 2020, A&A 642, A30).
const G_SI = 6.674e-11;         // m^3 kg^-1 s^-2
const MSUN_KG = 1.98892e30;
const KPC_KM = PC_KM * 1000;
const GYR_SEC = 1e9 * SEC_YEAR;

export const MERGER = {
    massMWMsun: 1.3e12,
    massM31Msun: 1.5e12,
    r0Kpc: 785,
    vr0KmS: -110,
    vt0KmS: 30,
    hernquistMWKpc: 21,    // host potential scale radii (Hernquist 1990)
    hernquistM31Kpc: 22,
    coreKpc: 3,            // mutual-force taper once the bodies overlap (see buildMergerTable)
    frictionEta0PerGyr: 0.5,
    frictionScaleKpc: 110,
    mergeKpc: 50,          // "coalesced" once separation drops (and stays) below this
    mergeReleaseKpc: 75,   // hysteresis: only clears the "coalesced" state above this
    disruptTailGyr: 1.5,   // extra ramp after permanent capture before disruptFrac reaches 1
    tableMaxGyr: 100,
    tableDtGyr: 0.002,     // integration step (~2 Myr)
    tableSampleGyr: 0.01,  // stored-sample cadence (~10 Myr)
};

// Mass fraction that places the barycentre on the MW -> M31 line (from the MW).
export const MERGER_MW_FRAC = MERGER.massM31Msun / (MERGER.massMWMsun + MERGER.massM31Msun);

let mergerTable = null;

// KDK leapfrog integration of the relative separation vector (x,y), run once
// and cached. See the module comment above for the physical model.
export function buildMergerTable() {
    const gmMW = G_SI * 1e-9 * MERGER.massMWMsun * MSUN_KG;   // km^3/s^2
    const gmM31 = G_SI * 1e-9 * MERGER.massM31Msun * MSUN_KG;
    const aMW = MERGER.hernquistMWKpc * KPC_KM, aM31 = MERGER.hernquistM31Kpc * KPC_KM;
    const etaScaleKm = MERGER.frictionScaleKpc * KPC_KM;
    const eta0 = MERGER.frictionEta0PerGyr / GYR_SEC;
    const dt = MERGER.tableDtGyr * GYR_SEC;
    const tMax = MERGER.tableMaxGyr * GYR_SEC;
    const sampleDt = MERGER.tableSampleGyr * GYR_SEC;
    const nSamples = Math.floor(tMax / sampleDt) + 2;
    const tSec = new Float64Array(nSamples);
    const xKm = new Float64Array(nSamples);
    const yKm = new Float64Array(nSamples);
    // relative acceleration magnitude / r: each centre falls in the other's
    // potential. Inside a few kpc the two bodies overlap almost entirely and
    // their mutual force must vanish at zero separation (a test mass in a
    // cusp feels a finite pull there, which would pump energy into the
    // late-time sloshing), so it is tapered by r^2 / (r^2 + core^2).
    const core2 = (MERGER.coreKpc * KPC_KM) ** 2;
    const gOverR = r => -(gmM31 / ((r + aM31) * (r + aM31)) + gmMW / ((r + aMW) * (r + aMW))) * r / (r * r + core2);

    let x = MERGER.r0Kpc * KPC_KM, y = 0;
    let vx = MERGER.vr0KmS, vy = MERGER.vt0KmS;
    let t = 0, si = 0, nextSampleT = 0;
    let lastR = Math.hypot(x, y), prevDrDt = -1;
    let firstPassageSec = null, mergedSec = null;

    while (t <= tMax) {
        if (t >= nextSampleT && si < nSamples) {
            tSec[si] = t; xKm[si] = x; yKm[si] = y; si++;
            nextSampleT += sampleDt;
        }
        let r = Math.hypot(x, y);
        let g = gOverR(r);
        let eta = eta0 * Math.exp(-r / etaScaleKm);
        const ax0 = g * x - eta * vx, ay0 = g * y - eta * vy;
        const vxh = vx + ax0 * dt * 0.5, vyh = vy + ay0 * dt * 0.5;
        x += vxh * dt; y += vyh * dt;
        r = Math.hypot(x, y);
        g = gOverR(r);
        eta = eta0 * Math.exp(-r / etaScaleKm);
        const ax1 = g * x - eta * vxh, ay1 = g * y - eta * vyh;
        vx = vxh + ax1 * dt * 0.5; vy = vyh + ay1 * dt * 0.5;
        t += dt;

        r = Math.hypot(x, y);
        const drDt = r - lastR;
        if (prevDrDt < 0 && drDt >= 0 && firstPassageSec === null) firstPassageSec = t;
        prevDrDt = drDt; lastR = r;
        const rKpc = r / KPC_KM;
        if (rKpc < MERGER.mergeKpc && mergedSec === null) mergedSec = t;
        else if (rKpc > MERGER.mergeReleaseKpc && mergedSec !== null) mergedSec = null;
    }
    if (si < nSamples) { tSec[si] = t; xKm[si] = x; yKm[si] = y; si++; }

    return {
        tSec: tSec.subarray(0, si),
        xKm: xKm.subarray(0, si),
        yKm: yKm.subarray(0, si),
        firstPassageSec: firstPassageSec ?? tMax,
        mergedSec: mergedSec ?? tMax,
    };
}

const tableListeners = [];
// Called once with the table when it is first built (cosmic.js hands the
// merger epoch to cosmicEra.js this way; this module imports nothing).
export function onMergerTable(fn) {
    if (mergerTable) fn(mergerTable); else tableListeners.push(fn);
}
export function getMergerTable() {
    if (!mergerTable) {
        mergerTable = buildMergerTable();
        for (const fn of tableListeners.splice(0)) fn(mergerTable);
    }
    return mergerTable;
}

export function mergerEpochGyr() {
    return getMergerTable().mergedSec / GYR_SEC;
}

export function mergerRelativeKmAt(simTSeconds) {
    const tbl = getMergerTable();
    const t = Math.max(0, Number.isFinite(simTSeconds) ? simTSeconds : 0);
    const arr = tbl.tSec, n = arr.length;
    if (t <= arr[0]) return { x: tbl.xKm[0], y: tbl.yKm[0] };
    if (t >= arr[n - 1]) return { x: tbl.xKm[n - 1], y: tbl.yKm[n - 1] };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= t) lo = mid; else hi = mid;
    }
    const t0 = arr[lo], t1 = arr[hi];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    return {
        x: tbl.xKm[lo] + (tbl.xKm[hi] - tbl.xKm[lo]) * f,
        y: tbl.yKm[lo] + (tbl.yKm[hi] - tbl.yKm[lo]) * f,
    };
}

// Pure, deterministic: MW-M31 3-D separation (kpc) at a given sim time
// (seconds, matching G.t). Exported for smoke:merger.
export function mergerSeparationKpcAt(simTSeconds) {
    const { x, y } = mergerRelativeKmAt(simTSeconds);
    return Math.hypot(x, y) / KPC_KM;
}

// 0..1 cumulative disk-disruption fraction, monotonically non-decreasing in
// time (does not "heal" when the pair swings back out to a wide apoapsis
// between passages) - ramps from the first close passage to a bit after the
// pair is permanently captured under `mergeKpc`, feeding the disk->spheroid
// visual and the color reddening.
export function mergerDisruptFractionAt(simTSeconds) {
    const tbl = getMergerTable();
    const t = Math.max(0, Number.isFinite(simTSeconds) ? simTSeconds : 0);
    const start = tbl.firstPassageSec;
    const end = tbl.mergedSec + MERGER.disruptTailGyr * GYR_SEC;
    if (end <= start) return t >= start ? 1 : 0;
    return smooth01(start, end, t);
}

// Debug/test introspection - smoke:merger reads this rather than
// re-deriving passage/merge timing with its own heuristics.
export function mergerDebugState() {
    const tbl = getMergerTable();
    return {
        r0Kpc: MERGER.r0Kpc,
        firstPassageGyr: tbl.firstPassageSec / GYR_SEC,
        mergedGyr: tbl.mergedSec / GYR_SEC,
        mergeKpc: MERGER.mergeKpc,
    };
}

// --- M31 on its trajectory, in the real sky ---------------------------------
// The relative MW->M31 vector of the table above, placed in the world frame:
// the orbital plane contains the observed line from the Galactic centre to
// M31 (Local Volume catalog: RA 10.68458, Dec 41.26917, 0.78343 Mpc, McConnachie
// 2012 via UNGC) and the transverse direction -- poorly constrained by the
// measured proper motions -- is taken perpendicular to that line and to the
// Galactic pole. The table's initial separation is rescaled to the catalog
// one so t = 0 reproduces the observed position exactly.
const M31_FRAME = (() => {
    const u = [0, 0, 0];
    raDecToWorldUnitInto(10.68458, 41.26917, u);
    const gc = galacticToWorld([R0_PC, 0, -Z_SUN_PC]).map(v => v / 1e6);
    const rel = [u[0] * 0.78343 - gc[0], u[1] * 0.78343 - gc[1], u[2] * 0.78343 - gc[2]];
    const r0 = Math.hypot(rel[0], rel[1], rel[2]);
    const uh = rel.map(v => v / r0);
    const ngp = galacticToWorld([0, 0, 1]);
    let w = [uh[1] * ngp[2] - uh[2] * ngp[1], uh[2] * ngp[0] - uh[0] * ngp[2], uh[0] * ngp[1] - uh[1] * ngp[0]];
    const wl = Math.hypot(w[0], w[1], w[2]);
    w = w.map(v => v / wl);
    return { u: uh, w, r0Mpc: r0, scale: r0 / (MERGER.r0Kpc / 1000) };
})();

// M31's position relative to the Galactic centre (world frame, Mpc) at sim time t.
export function andromedaOffsetMpc(tSec, out = [0, 0, 0]) {
    const rel = mergerRelativeKmAt(tSec);
    const k = M31_FRAME.scale / (KPC_KM * 1000);
    const x = rel.x * k, y = rel.y * k;
    for (let i = 0; i < 3; i++) out[i] = M31_FRAME.u[i] * x + M31_FRAME.w[i] * y;
    return out;
}

// Local Group barycentre (MW 1.3e12, M31 1.5e12 Msun) relative to the
// Galactic centre, world Mpc, at sim time t.
export function localGroupBarycentreMpc(tSec, out = [0, 0, 0]) {
    andromedaOffsetMpc(tSec, out);
    for (let i = 0; i < 3; i++) out[i] *= MERGER_MW_FRAC;
    return out;
}

