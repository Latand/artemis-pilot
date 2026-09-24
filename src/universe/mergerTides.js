// Tidal debris of the Milky Way - Andromeda merger: a restricted N-body model.
//
// The two galaxies' centres follow the relative orbit of localGroupOrbit.js
// (softened two-body motion with a dynamical-friction drag, first passage at
// ~3.9 Gyr, coalescence by ~7-10 Gyr). Their stellar disks are sampled by
// massless test particles that move in the combined gravity of both hosts:
// the classic restricted three-body picture of Toomre & Toomre (1972, ApJ
// 178, 623), which reproduces the tidal tails and bridges of interacting
// disks. Each host is a Hernquist (1990, ApJ 356, 359) sphere of the orbit's
// total mass, with the scale radius set by the observed circular speed:
//   Milky Way  M = 1.3e12 Msun, a = 21 kpc  -> v_c(8 kpc) ~ 230 km/s
//   Andromeda  M = 1.5e12 Msun, a = 22 kpc  -> v_c(10 kpc) ~ 250 km/s
// (Eilers et al. 2019 for the Milky Way; Chemin, Carignan & Foster 2009 for
// M31). Particles start on circular orbits (plus a 6 km/s dispersion) at
// 2.5 Gyr, while the galaxies are still ~400 kpc apart, in disks that follow
// the light of the Galaxy model (galaxyModel.js: young + thin + thick disk,
// with the inner-disk deficit inside the bar) and of M31's exponential disk.
//
// Orientation. The Milky Way disk spins clockwise seen from the North
// Galactic Pole (angular momentum toward the south pole). Andromeda's disk is
// inclined 77 deg with its major axis at PA 38 deg (Walterbos & Kennicutt
// 1987; de Vaucouleurs 1958); its north-west side is the near side (dust
// lanes) and its south-west half approaches us (HI velocity field, Chemin+
// 2009), which fixes the spin direction.
//
// What it leaves out: disk self-gravity (no bars, arms or collective disk
// response), the hosts' own deformation and the exchange of orbital energy
// with the particles (the hosts' orbit is prescribed), gas and star
// formation. The remnant is therefore the phase-mixed debris of the two
// disks in the merged potential, not a self-consistent elliptical; the
// bulges stay with the smooth models (galaxyVolume.js, the Andromeda
// sprite). These are the standard limits of restricted N-body.
//
// Light bookkeeping. A particle carries a fixed share of its disk's light.
// While it stays on its initial orbit its light is still drawn by the smooth
// disk model; once the tide moves it off that orbit (radius or height beyond
// a tolerance; a particle, once disturbed, stays disturbed) it is drawn as
// debris and the smooth model loses exactly that light (keep factors per
// initial-radius bin for the Milky Way volume, one factor for M31's disk).
//
// Pure module, deterministic. Output frame: world axes (heliocentric ecliptic
// J2000 orientation), kiloparsecs, origin at the Milky Way's centre.

import { galacticToWorld, raDecToWorldUnitInto } from "./coords.js";
import { andromedaOffsetMpc, MERGER, MERGER_MW_FRAC } from "./localGroupOrbit.js";

const GYR_SEC = 1e9 * 31557600;
export const KMS_TO_KPC_GYR = 1.0227121650537077;
const G_KPC_GYR = 4.300917270e-6 * KMS_TO_KPC_GYR * KMS_TO_KPC_GYR;   // kpc^3 Msun^-1 Gyr^-2

export const TIDES = Object.freeze({
    nPerGalaxy: 3072,
    aMWKpc: 21,
    aM31Kpc: 22,
    tStartGyr: 2.5,
    dtGyr: 0.0025,       // 2.5 Myr: >= 29 steps per orbit at the inner disk edge; keyframes on the grid
    // keyframes: fine while the debris evolves fast, coarser as it phase-mixes
    keys: [[3.5, 10, 0.025], [10, 14, 0.05]],
    sigmaKms: 6,
    m31: { ra: 10.68458, dec: 41.26917, inclDeg: 77, paDeg: 38, hzKpc: 0.6 },
    // Milky Way keep bins: edges of the particles' INITIAL radius (kpc)
    mwBinEdgesKpc: [3, 5, 7, 9, 11, 14, 18],
    // disturbance tolerance: |R - R0| / (fr R0 + r0) and (|z| - |z0|) / (z0t + 2 hz)
    tolRFrac: 0.15, tolRKpc: 0.7, tolZKpc: 0.5,
});
export const MW_BIN_COUNT = TIDES.mwBinEdgesKpc.length + 1;

// Light shares of the Milky Way model (galaxyModel.js, integrated over the
// volume): young 4.5e9, thin 4.40e10, thick 2.46e10, halo 9.9e9, bar 2.6e10
// Lsun. The particles carry the three disk components (67 % of the Galaxy).
export const MW_LIGHT = Object.freeze({ young: 0.0415, thin: 0.4034, thick: 0.2255, halo: 0.0911, bar: 0.2384 });
export const MW_DISK_OF_TOTAL = MW_LIGHT.young + MW_LIGHT.thin + MW_LIGHT.thick;
const MW_COMPONENTS = [
    // share of the disk light, radial scale, vertical scale, inner-hole weight
    { f: MW_LIGHT.young / MW_DISK_OF_TOTAL, hr: 2.6, hz: 0.1, hole: 1 },
    { f: MW_LIGHT.thin / MW_DISK_OF_TOTAL, hr: 2.6, hz: 0.3, hole: 1 },
    { f: MW_LIGHT.thick / MW_DISK_OF_TOTAL, hr: 2.0, hz: 0.9, hole: 0.7 },
];

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function gauss(rng) {
    const u = Math.max(1e-12, rng()), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}
function norm(v) {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Disk frames in world axes: e1, e2 span the plane, n is the spin axis
// (angular momentum direction); rotation carries e1 toward e2.
export function milkyWayDiskFrame() {
    const x = norm(galacticToWorld([1, 0, 0]));   // Sun -> Galactic centre
    const zN = norm(galacticToWorld([0, 0, 1]));  // North Galactic Pole
    // at the Sun (-R0 x from the centre) the velocity is +y (l = 90 deg):
    // n = -NGP, and with e1 = -x (centre -> Sun), n x e1 = z x x = y
    const n = [-zN[0], -zN[1], -zN[2]];
    const e1 = [-x[0], -x[1], -x[2]];
    return { e1, e2: cross(n, e1), n };
}
export function andromedaDiskFrame(p = TIDES.m31) {
    const u = [0, 0, 0], a = [0, 0, 0], b = [0, 0, 0];
    raDecToWorldUnitInto(p.ra, p.dec, u);
    const d = 1e-3;
    raDecToWorldUnitInto(p.ra + d, p.dec, a); raDecToWorldUnitInto(p.ra - d, p.dec, b);
    const eE = norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
    raDecToWorldUnitInto(p.ra, p.dec + d, a); raDecToWorldUnitInto(p.ra, p.dec - d, b);
    const eN = norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
    const pa = p.paDeg * Math.PI / 180, inc = p.inclDeg * Math.PI / 180;
    const m = [0, 1, 2].map(i => Math.cos(pa) * eN[i] + Math.sin(pa) * eE[i]);          // major axis (NE)
    const nw = [0, 1, 2].map(i => Math.sin(pa) * eN[i] - Math.cos(pa) * eE[i]);         // projected minor axis (NW)
    // near side NW, south-west half approaching: spin toward us and the south-east
    const n = norm([0, 1, 2].map(i => -Math.cos(inc) * u[i] - Math.sin(inc) * nw[i]));
    const e1 = norm(m);
    return { e1, e2: cross(n, e1), n };
}

// Relative MW -> M31 vector (kpc, world axes) at cosmic sim time t (Gyr from now).
const _rel = [0, 0, 0];
function relKpc(tGyr, out) {
    andromedaOffsetMpc(tGyr * GYR_SEC, _rel);
    out[0] = _rel[0] * 1000; out[1] = _rel[1] * 1000; out[2] = _rel[2] * 1000;
    return out;
}

// Circular speed (kpc/Gyr) of the horizontal orbit at cylindrical R, height z,
// in a Hernquist sphere.
function vPhi(gm, a, R, z) {
    const r = Math.hypot(R, z);
    return Math.sqrt(gm * R * R / (r * (r + a) * (r + a)));
}

function keyTimes() {
    const t = [];
    for (const [t0, t1, dt] of TIDES.keys) {
        const n = Math.round((t1 - t0) / dt);
        for (let k = 0; k < n; k++) t.push(t0 + k * dt);
    }
    const last = TIDES.keys[TIDES.keys.length - 1][1];
    t.push(last);
    return Float64Array.from(t);
}

// --- the simulation --------------------------------------------------------------
// opts: { nPerGalaxy, m31HKpc (disk scale length), seed, dtGyr, onProgress }
export function simulateMergerTides(opts = {}) {
    const N1 = opts.nPerGalaxy ?? TIDES.nPerGalaxy;
    const N = 2 * N1;
    const rng = mulberry32((opts.seed ?? 0x71de5) >>> 0);
    const dt = opts.dtGyr ?? TIDES.dtGyr;
    const hM31 = opts.m31HKpc ?? 5.3;
    const f = MERGER_MW_FRAC;                         // MW centre = -f rel, M31 = (1 - f) rel
    const gmMW = G_KPC_GYR * MERGER.massMWMsun, gmM31 = opts.isolated ? 0 : G_KPC_GYR * MERGER.massM31Msun;
    const aMW = TIDES.aMWKpc, aM31 = TIDES.aM31Kpc;
    const frames = [milkyWayDiskFrame(), andromedaDiskFrame()];
    const sig = TIDES.sigmaKms * KMS_TO_KPC_GYR;

    const x = new Float64Array(N * 3), v = new Float64Array(N * 3), acc = new Float64Array(N * 3);
    const R0 = new Float32Array(N), z0 = new Float32Array(N), zTol = new Float32Array(N);
    const bin = new Uint8Array(N);

    // host positions / velocities at the start
    const t0 = TIDES.tStartGyr;
    const r0 = relKpc(t0, [0, 0, 0]), rA = relKpc(t0 - 0.005, [0, 0, 0]), rB = relKpc(t0 + 0.005, [0, 0, 0]);
    const vrel = [0, 1, 2].map(i => (rB[i] - rA[i]) / 0.01);
    const host = [
        { c: r0.map(q => -f * q), v: vrel.map(q => -f * q), gm: gmMW, a: aMW },
        { c: r0.map(q => (1 - f) * q), v: vrel.map(q => (1 - f) * q), gm: gmM31, a: aM31 },
    ];
    // --- sample the disks
    const edges = TIDES.mwBinEdgesKpc;
    for (let p = 0; p < N; p++) {
        const g = p < N1 ? 0 : 1;
        let R, z, hz;
        if (g === 0) {
            // component by light share, radius from R exp(-R/hr) x inner-hole weight
            let u = rng(), c = MW_COMPONENTS[0];
            for (const cc of MW_COMPONENTS) { if (u < cc.f) { c = cc; break; } u -= cc.f; }
            for (;;) {
                R = -c.hr * Math.log(Math.max(1e-12, rng() * rng()));
                if (R > 25) continue;
                const hole = smoothstep(1.5, 3.5, R);
                if (rng() < (1 - c.hole) + c.hole * hole) break;
            }
            hz = c.hz;
        } else {
            do { R = -hM31 * Math.log(Math.max(1e-12, rng() * rng())); } while (R > 6 * hM31);
            hz = TIDES.m31.hzKpc;
        }
        z = -hz * Math.log(Math.max(1e-12, rng())) * (rng() < 0.5 ? -1 : 1);
        const phi = rng() * 2 * Math.PI;
        const F = frames[g], H = host[g];
        const cp = Math.cos(phi), sp = Math.sin(phi);
        const vc = vPhi(H.gm, H.a, R, z);
        for (let i = 0; i < 3; i++) {
            const er = cp * F.e1[i] + sp * F.e2[i];
            const et = -sp * F.e1[i] + cp * F.e2[i];            // n x er
            x[p * 3 + i] = H.c[i] + R * er + z * F.n[i];
            v[p * 3 + i] = H.v[i] + vc * et + sig * gauss(rng);
        }
        R0[p] = R; z0[p] = Math.abs(z); zTol[p] = TIDES.tolZKpc + 2 * hz;
        if (g === 0) { let b = 0; while (b < edges.length && R >= edges[b]) b++; bin[p] = b; }
    }
    // --- light per bin (equal shares within a galaxy)
    const binCount = new Float64Array(MW_BIN_COUNT);
    for (let p = 0; p < N1; p++) binCount[bin[p]]++;

    const times = keyTimes();
    const nk = times.length;
    const pos = new Int16Array(nk * N * 3);
    const scale = new Float32Array(nk);
    const wq = new Uint8Array(nk * N), sq = new Uint8Array(nk * N);
    const keepMW = new Float32Array(nk * MW_BIN_COUNT), keepMWTotal = new Float32Array(nk), keepM31 = new Float32Array(nk);
    const w = new Float32Array(N);
    const cMW = [0, 0, 0], cM31 = [0, 0, 0], rel = [0, 0, 0];

    const hosts = (t) => {
        relKpc(t, rel);
        for (let i = 0; i < 3; i++) { cMW[i] = -f * rel[i]; cM31[i] = (1 - f) * rel[i]; }
    };
    const accel = () => {
        for (let p = 0; p < N; p++) {
            const o = p * 3;
            let dx = x[o] - cMW[0], dy = x[o + 1] - cMW[1], dz = x[o + 2] - cMW[2];
            let s = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9;
            let k = -gmMW / (s * (s + aMW) * (s + aMW));
            let ax = k * dx, ay = k * dy, az = k * dz;
            dx = x[o] - cM31[0]; dy = x[o + 1] - cM31[1]; dz = x[o + 2] - cM31[2];
            s = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9;
            k = -gmM31 / (s * (s + aM31) * (s + aM31));
            acc[o] = ax + k * dx; acc[o + 1] = ay + k * dy; acc[o + 2] = az + k * dz;
        }
    };
    const record = (k) => {
        // disturbance, relative to each particle's own host and disk plane
        for (let p = 0; p < N; p++) {
            const g = p < N1 ? 0 : 1;
            const c = g === 0 ? cMW : cM31, F = frames[g];
            const o = p * 3;
            const dx = x[o] - c[0], dy = x[o + 1] - c[1], dz = x[o + 2] - c[2];
            const zz = dx * F.n[0] + dy * F.n[1] + dz * F.n[2];
            const R = Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - zz * zz));
            const dR = Math.abs(R - R0[p]) / (TIDES.tolRFrac * R0[p] + TIDES.tolRKpc);
            const dZ = (Math.abs(zz) - z0[p]) / zTol[p];
            const wr = smoothstep(0.7, 1.5, Math.max(dR, dZ));
            if (wr > w[p]) w[p] = wr;
        }
        // positions relative to the Milky Way centre, quantised per keyframe
        let m = 1;
        for (let p = 0; p < N; p++) {
            const o = p * 3;
            m = Math.max(m, Math.abs(x[o] - cMW[0]), Math.abs(x[o + 1] - cMW[1]), Math.abs(x[o + 2] - cMW[2]));
        }
        const sc = m / 32767;
        scale[k] = sc;
        const base = k * N * 3;
        for (let p = 0; p < N; p++) {
            const o = p * 3;
            pos[base + o] = Math.round((x[o] - cMW[0]) / sc);
            pos[base + o + 1] = Math.round((x[o + 1] - cMW[1]) / sc);
            pos[base + o + 2] = Math.round((x[o + 2] - cMW[2]) / sc);
            wq[k * N + p] = Math.round(w[p] * 255);
        }
        smoothingLengths(x, w, N, sq, k * N);
        // keep factors
        const lost = new Float64Array(MW_BIN_COUNT);
        let lostMW = 0, lostM31 = 0;
        for (let p = 0; p < N1; p++) { lost[bin[p]] += w[p]; lostMW += w[p]; }
        for (let p = N1; p < N; p++) lostM31 += w[p];
        for (let b = 0; b < MW_BIN_COUNT; b++) keepMW[k * MW_BIN_COUNT + b] = binCount[b] > 0 ? 1 - lost[b] / binCount[b] : 1;
        keepMWTotal[k] = 1 - lostMW / N1;
        keepM31[k] = 1 - lostM31 / N1;
    };

    // --- KDK leapfrog on a fixed grid t = t0 + s dt; keyframes sit on grid steps
    const keyStep = Int32Array.from(times, tk => Math.round((tk - t0) / dt));
    let t = t0;
    hosts(t); accel();
    let k = 0;
    const nSteps = keyStep[nk - 1];
    for (let s = 0; ; s++) {
        while (k < nk && keyStep[k] === s) record(k++);
        if (s >= nSteps) break;
        for (let i = 0; i < N * 3; i++) v[i] += 0.5 * dt * acc[i];
        for (let i = 0; i < N * 3; i++) x[i] += dt * v[i];
        t = t0 + (s + 1) * dt;
        hosts(t); accel();
        for (let i = 0; i < N * 3; i++) v[i] += 0.5 * dt * acc[i];
        if (opts.onProgress && s % 200 === 0) opts.onProgress(s / nSteps);
    }

    return {
        n: N, nMW: N1, nM31: N1, times, pos, scale, w: wq, sigma: sq,
        keepMW, keepMWTotal, keepM31, binEdgesKpc: Float32Array.from(edges),
        frames, hosts: { aMW, aM31 },
        ...(opts.debug ? { debug: { x, v, cMW, cM31, gmMW, gmM31 } } : {}),
    };
}

// --- adaptive smoothing ----------------------------------------------------------
// Each particle's kernel follows the local spacing of the VISIBLE (disturbed)
// debris: the weight sum in a grid cell around it, at the finest of three
// cell sizes that holds >= 6 particles' worth. sigma = 1.4 x spacing (the
// blobs overlap into a smooth field), stored as a byte on a log scale
// between SIG_MIN and SIG_MAX kpc.
export const SIG_MIN = 0.2, SIG_MAX = 12;
const SIG_LN = Math.log(SIG_MAX / SIG_MIN);
export function decodeSigma(q) { return SIG_MIN * Math.exp(SIG_LN * q / 255); }
function encodeSigma(s) {
    return Math.max(0, Math.min(255, Math.round(Math.log(Math.max(SIG_MIN, Math.min(SIG_MAX, s)) / SIG_MIN) / SIG_LN * 255)));
}
const LEVELS = [1.5, 4.5, 13.5];
const _maps = LEVELS.map(() => new Map());
function cellKey(x, y, z, c) {
    return ((Math.floor(x / c) + 1024) * 2048 + (Math.floor(y / c) + 1024)) * 2048 + (Math.floor(z / c) + 1024);
}
function smoothingLengths(x, w, N, out, o) {
    for (let l = 0; l < LEVELS.length; l++) {
        const m = _maps[l]; m.clear();
        const c = LEVELS[l];
        for (let p = 0; p < N; p++) {
            if (w[p] <= 0) continue;
            const key = cellKey(x[p * 3], x[p * 3 + 1], x[p * 3 + 2], c);
            m.set(key, (m.get(key) || 0) + w[p]);
        }
    }
    for (let p = 0; p < N; p++) {
        let s = SIG_MAX;
        for (let l = 0; l < LEVELS.length; l++) {
            const c = LEVELS[l];
            const n = _maps[l].get(cellKey(x[p * 3], x[p * 3 + 1], x[p * 3 + 2], c)) || 0;
            if (n >= 6 || l === LEVELS.length - 1) { s = 1.4 * c * Math.pow(Math.max(n, 1), -1 / 3); break; }
        }
        out[o + p] = encodeSigma(s);
    }
}

// --- sampling a model at a time -------------------------------------------------
// Keyframe bracket for time t (Gyr): { k, f } with t = mix(times[k], times[k+1], f);
// null before the first keyframe (the disks are intact then).
export function keyBracket(model, tGyr, out = {}) {
    const T = model.times, n = T.length;
    if (!(tGyr >= T[0])) return null;
    if (tGyr >= T[n - 1]) { out.k = n - 2; out.f = 1; return out; }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= tGyr) lo = mid; else hi = mid; }
    out.k = lo; out.f = (tGyr - T[lo]) / (T[hi] - T[lo]);
    return out;
}

// Smooth-model keep factors at time t: { mwBins: Float32Array, mwTotal, m31 }.
const _kb = {};
export function keepAt(model, tMwGyr, tM31Gyr, out = { mwBins: new Float32Array(MW_BIN_COUNT), mwTotal: 1, m31: 1 }) {
    const b = model ? keyBracket(model, tMwGyr, _kb) : null;
    if (!b) { out.mwBins.fill(1); out.mwTotal = 1; }
    else {
        const { k, f } = b;
        for (let i = 0; i < MW_BIN_COUNT; i++) {
            const a0 = model.keepMW[k * MW_BIN_COUNT + i], a1 = model.keepMW[(k + 1) * MW_BIN_COUNT + i];
            out.mwBins[i] = a0 + (a1 - a0) * f;
        }
        out.mwTotal = model.keepMWTotal[k] + (model.keepMWTotal[k + 1] - model.keepMWTotal[k]) * f;
    }
    const c = model ? keyBracket(model, tM31Gyr, _kb) : null;
    out.m31 = c ? model.keepM31[c.k] + (model.keepM31[c.k + 1] - model.keepM31[c.k]) * c.f : 1;
    return out;
}

// Keep factor of the Milky Way disk at cylindrical radius R (kpc), from the
// bins (piecewise linear between bin centres).
export function keepAtRadius(bins, edges, R) {
    const nb = bins.length;
    const centre = i => i === 0 ? edges[0] * 0.5 : i === nb - 1 ? edges[nb - 2] + 2 : 0.5 * (edges[i - 1] + edges[i]);
    if (R <= centre(0)) return bins[0];
    for (let i = 1; i < nb; i++) {
        const c0 = centre(i - 1), c1 = centre(i);
        if (R <= c1) return bins[i - 1] + (bins[i] - bins[i - 1]) * (R - c0) / (c1 - c0);
    }
    return bins[nb - 1];
}

// Interpolated particle state for one galaxy's particles [p0, p1) at time t:
// positions (kpc, MW-centred world axes) into pos[p*3..], weight and sigma
// into ws[p*2], ws[p*2+1]. Returns false before the first keyframe.
export function sampleParticles(model, tGyr, p0, p1, pos, ws) {
    const b = keyBracket(model, tGyr, _kb);
    if (!b) {
        for (let p = p0; p < p1; p++) { ws[p * 2] = 0; ws[p * 2 + 1] = SIG_MIN; }
        return false;
    }
    const { k, f } = b, N = model.n;
    const s0 = model.scale[k], s1 = model.scale[k + 1];
    const A = model.pos, o0 = k * N * 3, o1 = (k + 1) * N * 3;
    const W = model.w, S = model.sigma, q0 = k * N, q1 = (k + 1) * N;
    const g = 1 - f;
    for (let p = p0; p < p1; p++) {
        const i = p * 3;
        pos[i] = A[o0 + i] * s0 * g + A[o1 + i] * s1 * f;
        pos[i + 1] = A[o0 + i + 1] * s0 * g + A[o1 + i + 1] * s1 * f;
        pos[i + 2] = A[o0 + i + 2] * s0 * g + A[o1 + i + 2] * s1 * f;
        ws[p * 2] = (W[q0 + p] * g + W[q1 + p] * f) / 255;
        ws[p * 2 + 1] = decodeSigma(S[q0 + p] * g + S[q1 + p] * f);
    }
    return true;
}
