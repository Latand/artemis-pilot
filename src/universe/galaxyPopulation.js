// One galaxy population for every extragalactic scale.
//
// The Milky Way, the Local Group, the Local Volume, the 2MASS Redshift Survey
// and the statistical universe beyond them are built here as ONE list of
// galaxies with one set of physical properties (luminosity, colour, size,
// morphology, 3-D orientation), so a galaxy looks the same whichever scale the
// camera is at, and the renderer (render/galaxyPopulationRender.js) needs no
// per-layer brightness convention.
//
// Provenance is carried per galaxy (PROV below) and never mixed up:
//   MILKY_WAY      our Galaxy (drawn by render/galaxyVolume.js while it is
//                  resolved; this entry takes over when it is a few pixels)
//   LV_MEASURED    Local Volume catalog (UNGC + McConnachie 2012): measured
//                  distances, luminosities, sizes, orientations
//   REDSHIFT       2MRS (Huchra+2012): measured position, redshift, Ks, type,
//                  axis ratio, PA; distance DERIVED from redshift, with the
//                  Fingers-of-God of bound groups compressed (below)
//   ZOA_CLONE      procedural: 2MRS galaxies next to the Zone of Avoidance
//                  mirrored into it (the standard cloning fill, e.g. Yahil
//                  et al. 1991; Lavaux & Hudson 2011)
//   COMPLETION     procedural: galaxies fainter than the 2MRS flux limit,
//                  painted around observed galaxies with the K-band
//                  luminosity function, so the faint population follows the
//                  real structure
//   WEB            procedural: beyond the survey depth, a Voronoi cosmic web
//                  (van de Weygaert & Icke 1989 geometry) with the same
//                  luminosity function and selection
//
// Selection. What is kept is a flux-limited sample as seen from the Sun, in
// Ks: every real galaxy, plus procedural galaxies brighter than
// M_fl(d) = min(M_dwarf, m_r - 25 - 5 log10 d_L) out to the web radius. The
// resulting density is continuous across every seam (survey / clones /
// completion / web) because every part obeys the same M_fl(d).
//
// Groups. A friends-of-friends pass (Huchra & Geller 1982, with the
// high-density-contrast parameters of Crook et al. 2007: D0 = 0.56 Mpc,
// V0 = 350 km/s at 1000 km/s, scaled with the luminosity function) finds the
// bound groups and clusters in redshift space. Each group's line-of-sight
// scatter is compressed to its transverse size (the usual Finger-of-God
// correction), and each group is a BOUND UNIT for cosmic expansion: its
// centre moves with the Hubble flow, its members keep their proper
// separations. Local Volume groups come from UNGC's tidal index (a positive
// index means the galaxy is bound to its main disturber). The Local Group
// (members within 1 Mpc of its barycentre, the zero-velocity radius of
// Karachentsev et al. 2009) is the origin unit and does not expand.
//
// Frames and units: world frame (ecliptic J2000, coords.js), COMOVING Mpc
// normalised to a = 1 today, origin at the Sun at the catalog epoch.
//
// Pure module: no THREE, no DOM. Deterministic in (seed, inputs).

import { hashInts, makeRNG, splitSeed, samplePoisson, gaussian } from "./prng.js";
import { equatorialToWorldInto, galacticToWorld, W2G, R0_PC, Z_SUN_PC } from "./coords.js";
import { conformalTimeAtLnA, lnAAtConformalTime, COSMO } from "./cosmicExpansion.js";

export const PROV = Object.freeze({ MILKY_WAY: 0, LV_MEASURED: 1, REDSHIFT: 2, ZOA_CLONE: 3, COMPLETION: 4, WEB: 5 });
export const PROV_LABEL = ["Milky Way", "measured distance", "redshift distance", "procedural (ZoA fill)", "procedural (faint completion)", "procedural (cosmic web)"];

// --- Luminosity function ------------------------------------------------------
// K-band Schechter function for 2MRS total Ks magnitudes, FIT to the 2MRS
// number counts themselves in 25-400 Mpc shells (alpha fixed at the 2MASS
// value of Kochanek et al. 2001, ApJ 560, 566): M* - 5 log h = -23.65,
// phi* = 0.0081 h^3 Mpc^-3, residuals within +-15% per shell (large-scale
// structure). Literature values for comparison: Kochanek+2001 -23.39 / -1.09 /
// 0.0116 h^3; 6dFGS (Jones et al. 2006) -23.83 / -1.16 / 0.0133 h^3. The lower
// phi* partly reflects the local underdensity reported in the K band out to
// ~300 Mpc (Keenan, Barger & Cowie 2013). Fitting to the catalog keeps the
// procedural web beyond the survey at the survey's own mean density, so there
// is no density step at the seam. h = H0/100 = 0.6766.
const H = COSMO.H0 / 100;
export const LF_K = Object.freeze({
    Mstar: -23.65 + 5 * Math.log10(H),
    alpha: -1.09,
    phiStar: 0.0081 * H * H * H,
});
export const TWOMRS_KLIM = 11.75;
export const MK_SUN = 3.28;
const MPC_PC = 1e6;

// Upper incomplete gamma Gamma(s, x) for the LF shape, tabulated in ln x.
const LN_X_MIN = Math.log(1e-5), LN_X_MAX = Math.log(60), GT_N = 3000;
const GT = new Float64Array(GT_N);           // Gamma(alpha+1, x_i)
const GT_DLX = (LN_X_MAX - LN_X_MIN) / (GT_N - 1);
(function buildGammaTable() {
    const s = LF_K.alpha + 1;
    const f = lx => { const x = Math.exp(lx); return Math.pow(x, s) * Math.exp(-x); };
    GT[GT_N - 1] = 0;
    for (let i = GT_N - 2; i >= 0; i--) {
        const a = LN_X_MIN + i * GT_DLX, b = a + GT_DLX;
        GT[i] = GT[i + 1] + GT_DLX / 6 * (f(a) + 4 * f(a + GT_DLX / 2) + f(b));
    }
})();
function gammaUpper(x) {
    const lx = Math.log(Math.max(x, 1e-300));
    if (lx <= LN_X_MIN) {
        // below the table: Gamma(s,x) ~ Gamma(s,x_min) + integral_x^xmin t^(s-1) dt
        const s = LF_K.alpha + 1, xm = Math.exp(LN_X_MIN);
        return GT[0] + (Math.pow(x, s) - Math.pow(xm, s)) / -s;
    }
    if (lx >= LN_X_MAX) return 0;
    const u = (lx - LN_X_MIN) / GT_DLX, i = Math.floor(u), f = u - i;
    return GT[i] + (GT[i + 1] - GT[i]) * f;
}
// Number density (Mpc^-3) of galaxies brighter than absolute Ks magnitude M,
// from a 0.005-mag table (exact Gamma evaluation off the table).
const MT_MIN = -30, MT_MAX = -8, MT_STEP = 0.005, MT_N = Math.round((MT_MAX - MT_MIN) / MT_STEP) + 1;
const MT = new Float64Array(MT_N);
for (let i = 0; i < MT_N; i++) MT[i] = LF_K.phiStar * gammaUpper(Math.pow(10, -0.4 * (MT_MIN + i * MT_STEP - LF_K.Mstar)));
export function lfDensityBrighter(M) {
    const u = (M - MT_MIN) / MT_STEP;
    if (!(u > 0) || u >= MT_N - 1) return LF_K.phiStar * gammaUpper(Math.pow(10, -0.4 * (M - LF_K.Mstar)));
    const i = Math.floor(u), f = u - i;
    return MT[i] + (MT[i + 1] - MT[i]) * f;
}
// Draw an absolute Ks magnitude between Mbright and Mfaint from the LF
// (inverse CDF on the table).
function sampleLF(rng, Mbright, Mfaint) {
    const nb = lfDensityBrighter(Mbright), nf = lfDensityBrighter(Mfaint);
    const target = nb + (nf - nb) * rng();
    let lo = Math.max(0, Math.floor((Mbright - MT_MIN) / MT_STEP)), hi = Math.min(MT_N - 1, Math.ceil((Mfaint - MT_MIN) / MT_STEP));
    if (hi <= lo) return Mbright;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (MT[mid] < target) lo = mid; else hi = mid;
    }
    const f = MT[hi] > MT[lo] ? (target - MT[lo]) / (MT[hi] - MT[lo]) : 0;
    return Math.min(Mfaint, Math.max(Mbright, MT_MIN + (lo + f) * MT_STEP));
}

// --- Redshift -> comoving distance ---------------------------------------------
const ETA0 = conformalTimeAtLnA(0);
export function comovingFromCz(czKms) {
    const z = Math.max(0, czKms) / COSMO.cKms;
    return ETA0 - conformalTimeAtLnA(-Math.log1p(z));
}
export function czFromComoving(chi) {
    const lnA = lnAAtConformalTime(ETA0 - chi);
    return (Math.exp(-lnA) - 1) * COSMO.cKms;
}
function distModulus(chiMpc) {
    const z = czFromComoving(chiMpc) / COSMO.cKms;
    const dl = Math.max(chiMpc * (1 + z), 1e-6);
    return 25 + 5 * Math.log10(dl);
}

// --- Morphology-dependent properties -------------------------------------------
// Piecewise-linear in de Vaucouleurs T. Integrated colours after Fukugita,
// Shimasaku & Ichikawa (1995, PASP 107, 945) and Jarrett et al. (2003, AJ 125,
// 525) for V-K; bulge fractions after Simien & de Vaucouleurs (1986);
// intrinsic thickness after Unterborn & Ryden (2008) and Padilla & Strauss
// (2008). These are population means, not per-galaxy measurements.
const T_KNOTS = [-5, -3, -1, 1, 3, 5, 7, 9, 10];
const BV_K = [0.96, 0.93, 0.90, 0.82, 0.70, 0.55, 0.50, 0.42, 0.40];
const VK_K = [3.25, 3.22, 3.18, 3.10, 3.00, 2.75, 2.50, 2.25, 2.20];
const BT_K = [1.00, 0.80, 0.55, 0.45, 0.30, 0.12, 0.04, 0.00, 0.00];
const Q0_K = [0.72, 0.55, 0.26, 0.21, 0.18, 0.15, 0.13, 0.30, 0.38];
function interpT(table, T) {
    if (T <= T_KNOTS[0]) return table[0];
    for (let i = 1; i < T_KNOTS.length; i++) {
        if (T <= T_KNOTS[i]) {
            const f = (T - T_KNOTS[i - 1]) / (T_KNOTS[i] - T_KNOTS[i - 1]);
            return table[i - 1] + (table[i] - table[i - 1]) * f;
        }
    }
    return table[table.length - 1];
}
export function morphologyProps(T) {
    return { bv: interpT(BV_K, T), vk: interpT(VK_K, T), bulge: interpT(BT_K, T), q0: interpT(Q0_K, T) };
}
// 2MRS (ZCAT) type code -> T, or NaN when unknown.
function twoMrsT(code, rng) {
    if (!Number.isFinite(code)) return NaN;
    if (code === -9 || code === -7) return -5;
    if (code === -6) return -5;
    if (code >= -5 && code <= 10) return code;
    if (code === 11 || code === 12 || code === 15 || code === 16) return 10;
    if (code === 20) return 1 + Math.floor(rng() * 7);
    return NaN;   // 19: unclassified
}
// Morphology-density relation (Dressler 1980): early-type fraction ~15% in the
// field, ~40% in groups, ~70% in rich clusters. Luminous galaxies lean early.
function drawT(rng, env, MK) {
    const lum = Math.max(0, Math.min(1, (-MK - 22) / 3));
    const early = Math.min(0.85, (env >= 2 ? 0.62 : env === 1 ? 0.38 : 0.15) + 0.2 * lum);
    const u = rng();
    if (u < early) return rng() < 0.55 ? -5 + rng() * 2 : -3 + rng() * 3;
    if (MK > -20 && rng() < 0.6) return 8 + rng() * 2;         // dwarfs: Sd/Im
    return 1 + rng() * 7;
}
// Size-luminosity: half-light radii after Lange et al. (2015, MNRAS 447,
// 2603) / Shen et al. (2003) with 0.15 dex scatter; disks carry an
// exponential scale length h = R_e / 1.678.
function scaleLengthKpc(T, LK, rng) {
    const sc = Math.pow(10, 0.15 * gaussian(rng));
    if (T <= -0.5) {
        const re = LK > 1e10 ? 3.2 * Math.pow(LK / 1e11, 0.6) : 0.83 * Math.pow(LK / 1e10, 0.2);
        return Math.max(0.15, re * sc);
    }
    const re = 4.5 * Math.pow(LK / 5e10, 0.28);
    return Math.max(0.12, re / 1.678 * sc);
}

// --- Orientation ------------------------------------------------------------------
// World-frame disk normal from the observed axis ratio and position angle of a
// galaxy at equatorial (ra, dec): cos^2 i = (q^2 - q0^2) / (1 - q0^2)
// (Hubble 1926), normal = los cos i + (sky minor axis) sin i, the sign of the
// sin term (which side is near) unknown and drawn at random.
const _e = [0, 0, 0], _w = [0, 0, 0];
function normalFromSky(ux, uy, uz, ba, paDeg, q0, rng, out, o) {
    // equatorial basis at the galaxy
    const dec = Math.asin(Math.max(-1, Math.min(1, uz)));
    const ra = Math.atan2(uy, ux);
    const sd = Math.sin(dec), cd = Math.cos(dec), sa = Math.sin(ra), ca = Math.cos(ra);
    const Nx = -sd * ca, Ny = -sd * sa, Nz = cd;       // north
    const Ex = -sa, Ey = ca, Ez = 0;                   // east
    const pa = Number.isFinite(paDeg) ? paDeg * Math.PI / 180 : rng() * Math.PI;
    let cosI;
    if (Number.isFinite(ba) && ba > 0) {
        const q = Math.min(1, ba);
        cosI = Math.sqrt(Math.max(0, Math.min(1, (q * q - q0 * q0) / Math.max(1e-6, 1 - q0 * q0))));
    } else cosI = rng();
    const sinI = Math.sqrt(Math.max(0, 1 - cosI * cosI));
    const sgn = rng() < 0.5 ? -1 : 1;
    // sky minor axis = -N sin(pa) + E cos(pa)
    const mx = -Nx * Math.sin(pa) + Ex * Math.cos(pa);
    const my = -Ny * Math.sin(pa) + Ey * Math.cos(pa);
    const mz = -Nz * Math.sin(pa) + Ez * Math.cos(pa);
    const nx = ux * cosI + sgn * mx * sinI, ny = uy * cosI + sgn * my * sinI, nz = uz * cosI + sgn * mz * sinI;
    equatorialToWorldInto(nx, ny, nz, out, o);
}
function randomUnit(rng, out, o) {
    const u = rng() * 2 - 1, th = rng() * 2 * Math.PI, s = Math.sqrt(1 - u * u);
    out[o] = s * Math.cos(th); out[o + 1] = s * Math.sin(th); out[o + 2] = u;
}

// --- Output container -------------------------------------------------------------
function makeStore(cap) {
    return {
        n: 0, cap,
        pos: new Float64Array(cap * 3),      // comoving Mpc, world frame (Sun at epoch)
        unit: new Int32Array(cap),           // bound-unit index (see units)
        MV: new Float32Array(cap),           // absolute V magnitude
        MK: new Float32Array(cap),           // absolute Ks magnitude
        bv: new Float32Array(cap),           // B-V colour
        T: new Float32Array(cap),            // morphological T-type
        hKpc: new Float32Array(cap),         // disk scale length / spheroid scale radius
        bulge: new Float32Array(cap),        // bulge-to-total light ratio
        q0: new Float32Array(cap),           // intrinsic minor/major axis ratio
        normal: new Float32Array(cap * 3),   // world-frame symmetry axis
        prov: new Uint8Array(cap),
        name: new Int32Array(cap).fill(-1),
    };
}
function growStore(s, need) {
    if (s.n + need <= s.cap) return;
    const cap = Math.max(s.cap * 2, s.n + need);
    const n = makeStore(cap);
    for (const k of Object.keys(s)) {
        if (ArrayBuffer.isView(s[k])) n[k].set(s[k]);
    }
    n.n = s.n;
    Object.assign(s, n);
}
function push(s, g) {
    growStore(s, 1);
    const i = s.n++;
    s.pos[i * 3] = g.x; s.pos[i * 3 + 1] = g.y; s.pos[i * 3 + 2] = g.z;
    s.unit[i] = g.unit ?? -1;
    s.MV[i] = g.MV; s.MK[i] = g.MK; s.bv[i] = g.bv; s.T[i] = g.T;
    s.hKpc[i] = g.hKpc; s.bulge[i] = g.bulge; s.q0[i] = g.q0;
    s.normal[i * 3] = g.nx; s.normal[i * 3 + 1] = g.ny; s.normal[i * 3 + 2] = g.nz;
    s.prov[i] = g.prov;
    s.name[i] = g.name ?? -1;
    return i;
}

// --- Union-find ---------------------------------------------------------------------
function makeUF(n) {
    const p = new Int32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    const find = i => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) p[b] = a; else p[a] = b; } };
    return { find, union };
}

// --- Friends-of-friends in redshift space ---------------------------------------------
export const FOF = Object.freeze({ D0: 0.56, V0: 350, vF: 1000, mLim: TWOMRS_KLIM });
function fofScale(v) {
    if (v <= FOF.vF) return 1;
    const Mf = FOF.mLim - 25 - 5 * Math.log10(FOF.vF / COSMO.H0);
    const Mv = FOF.mLim - 25 - 5 * Math.log10(v / COSMO.H0);
    return Math.cbrt(lfDensityBrighter(Mf) / Math.max(1e-30, lfDensityBrighter(Mv)));
}
// ux/uy/uz: unit vectors, v: velocities (km/s). Returns Int32Array group root per galaxy.
export function friendsOfFriends(ux, uy, uz, v) {
    const n = v.length;
    const uf = makeUF(n);
    const CELL = 1.5 * Math.PI / 180;
    const nDec = Math.ceil(Math.PI / CELL), nRa = Math.ceil(2 * Math.PI / CELL);
    const cells = new Map();
    const decOf = new Float64Array(n), raOf = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const dec = Math.asin(Math.max(-1, Math.min(1, uz[i])));
        let ra = Math.atan2(uy[i], ux[i]); if (ra < 0) ra += 2 * Math.PI;
        decOf[i] = dec; raOf[i] = ra;
        const key = Math.min(nDec - 1, Math.floor((dec + Math.PI / 2) / CELL)) * nRa + Math.min(nRa - 1, Math.floor(ra / CELL));
        let a = cells.get(key); if (!a) cells.set(key, a = []);
        a.push(i);
    }
    for (const a of cells.values()) a.sort((p, q) => v[p] - v[q] || p - q);
    const lowerV = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v[arr[m]] < x) lo = m + 1; else hi = m; } return lo; };
    for (let i = 0; i < n; i++) {
        const vi = v[i];
        const vMax = vi * 1.3 + 1500;
        const vWin = FOF.V0 * fofScale(vMax);
        const vbarMin = Math.max(50, vi - vWin / 2);
        const dMax = FOF.D0 * fofScale(vMax);
        const thMax = 2 * Math.asin(Math.min(1, dMax * COSMO.H0 / (2 * vbarMin)));
        const d0 = Math.max(0, Math.floor((decOf[i] - thMax + Math.PI / 2) / CELL));
        const d1 = Math.min(nDec - 1, Math.floor((decOf[i] + thMax + Math.PI / 2) / CELL));
        for (let dc = d0; dc <= d1; dc++) {
            const decC = -Math.PI / 2 + (dc + 0.5) * CELL;
            const cosD = Math.max(0.02, Math.cos(Math.abs(decC) + CELL));
            const span = Math.min(nRa, Math.ceil(thMax / cosD / CELL) + 1);
            const rc = Math.floor(raOf[i] / CELL);
            for (let k = -span; k <= span; k++) {
                if (span === nRa && k > -span + nRa - 1) break;
                const rcc = ((rc + k) % nRa + nRa) % nRa;
                const arr = cells.get(dc * nRa + rcc);
                if (!arr) continue;
                for (let m = lowerV(arr, vi - vWin); m < arr.length; m++) {
                    const j = arr[m];
                    const vj = v[j];
                    if (vj > vi + vWin) break;
                    if (j <= i) continue;
                    const vbar = 0.5 * (vi + vj);
                    const R = fofScale(vbar);
                    if (Math.abs(vi - vj) > FOF.V0 * R) continue;
                    const dot = ux[i] * ux[j] + uy[i] * uy[j] + uz[i] * uz[j];
                    const chord = Math.sqrt(Math.max(0, 2 - 2 * dot));     // 2 sin(theta/2)
                    if (chord * vbar / COSMO.H0 > FOF.D0 * R) continue;
                    uf.union(i, j);
                }
            }
        }
    }
    const root = new Int32Array(n);
    for (let i = 0; i < n; i++) root[i] = uf.find(i);
    return root;
}

// --- Voronoi cosmic web --------------------------------------------------------------
// Seeds (void centres) on a jittered lattice; a candidate point's structure
// class follows from the gaps between its nearest seed distances
// d1 <= d2 <= d3 <= d4: walls where d2 ~ d1, filaments where d3 ~ d1, nodes
// (clusters) where d4 ~ d1. Acceptance weights give the mass fractions of
// cosmic-web environments in N-body simulations (Cautun et al. 2014, MNRAS
// 441, 2923: nodes ~11%, filaments ~50%, walls ~24%, voids ~15%).
export const WEB = Object.freeze({ cellMpc: 32, jitter: 0.9, wall: 2.2, fil: 2.6, node: 3.8, pVoid: 0.035, aWall: 0.30, aFil: 0.62, aNode: 1.0 });
// Seeds are a pure function of (seed, cell), cached for the cells within
// extentMpc of the origin so a weight costs 27 distance evaluations.
export function makeWebField(seed, extentMpc) {
    const c = WEB.cellMpc, j = WEB.jitter;
    const half = Math.ceil(extentMpc / c) + 2, side = 2 * half + 1;
    const seeds = new Float64Array(side * side * side * 3);
    for (let ix = -half; ix <= half; ix++) for (let iy = -half; iy <= half; iy++) for (let iz = -half; iz <= half; iz++) {
        const k = (((ix + half) * side + (iy + half)) * side + (iz + half)) * 3;
        seeds[k] = (ix + 0.5 + (hashInts(seed, 0x70e1, ix, iy, iz) / 4294967296 - 0.5) * j) * c;
        seeds[k + 1] = (iy + 0.5 + (hashInts(seed, 0x70e2, ix, iy, iz) / 4294967296 - 0.5) * j) * c;
        seeds[k + 2] = (iz + 0.5 + (hashInts(seed, 0x70e3, ix, iy, iz) / 4294967296 - 0.5) * j) * c;
    }
    const d4 = new Float64Array(4);
    // Structure weight (0..1); envOut.env = 0 wall/void, 1 filament, 2 node.
    return function webWeight(x, y, z, envOut) {
        const ix = Math.floor(x / c), iy = Math.floor(y / c), iz = Math.floor(z / c);
        d4[0] = d4[1] = d4[2] = d4[3] = Infinity;
        for (let a = -1; a <= 1; a++) {
            const X = ix + a + half; if (X < 0 || X >= side) continue;
            for (let b = -1; b <= 1; b++) {
                const Y = iy + b + half; if (Y < 0 || Y >= side) continue;
                for (let e = -1; e <= 1; e++) {
                    const Z = iz + e + half; if (Z < 0 || Z >= side) continue;
                    const k = ((X * side + Y) * side + Z) * 3;
                    const dx = seeds[k] - x, dy = seeds[k + 1] - y, dz = seeds[k + 2] - z;
                    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (d < d4[3]) {
                        let m = 3;
                        while (m > 0 && d4[m - 1] > d) { d4[m] = d4[m - 1]; m--; }
                        d4[m] = d;
                    }
                }
            }
        }
        const g2 = d4[1] - d4[0], g3 = d4[2] - d4[0], g4 = d4[3] - d4[0];
        const eW = Math.exp(-0.5 * (g2 / WEB.wall) ** 2);
        const eF = Math.exp(-0.5 * (g3 / WEB.fil) ** 2);
        const eN = Math.exp(-0.5 * (g4 / WEB.node) ** 2);
        if (envOut) envOut.env = eN > 0.5 ? 2 : eF > 0.5 ? 1 : 0;
        return Math.min(1, WEB.pVoid + WEB.aWall * eW + WEB.aFil * eF + WEB.aNode * eN);
    };
}

// --- Builder ----------------------------------------------------------------------------
export const POP_DEFAULTS = Object.freeze({
    seed: 0x6a1a,
    renderKLim: 13.0,        // m_r: the population's Ks flux limit from the Sun
    dwarfMK: -17.5,          // faintest procedural galaxy anywhere
    lvRadiusMpc: 11,         // inside this the Local Volume catalog stands alone
    surveyMpc: 250,          // 2MRS-conditioned completion out to here...
    seamMpc: 40,             // ...cross-faded into the web over this width
    webMpc: 700,             // outer edge of the rendered universe
    companionRMpc: 4.5,      // correlated-neighbour radius for field hosts
    maxGalaxies: 900000,
});

function mkFromM(MKabs) { return Math.pow(10, -0.4 * (MKabs - MK_SUN)); }
export function selectionMK(chiMpc, opts = POP_DEFAULTS) {
    return Math.min(opts.dwarfMK, opts.renderKLim - distModulus(Math.max(chiMpc, 0.01)));
}

// The Milky Way entry: luminosity from the volumetric model's integral (so
// the volume -> sprite handoff conserves light), structure from galaxyModel.
export const MILKY_WAY = Object.freeze({
    LBol: 1.083e11,        // Lsun: integral of galaxyModel.js mwSample over its volume
    MV: 4.74 - 2.5 * Math.log10(1.083e11) + 0.12,
    T: 4, hKpc: 2.6, bulge: 0.24, q0: 0.12, bv: 0.68,
});

/**
 * Build the population.
 * @param {object[]} lv decodeLocalVolume() result
 * @param {object} mrs decode2mrs() result
 * @param {object} [options] POP_DEFAULTS overrides
 */
export function buildGalaxyPopulation(lv, mrs, options = {}) {
    const opts = { ...POP_DEFAULTS, ...options };
    const seed = opts.seed >>> 0;
    const rng = makeRNG(splitSeed(seed, 0x9a1a));
    const S = makeStore(Math.min(opts.maxGalaxies, 400000));
    const names = [];
    const units = [];                       // { cx, cy, cz, n, bound, kind }
    const stats = { lv: 0, redshift: 0, dropped: 0, clones: 0, completion: 0, web: 0, groups: 0, fogCompressed: 0 };
    const w = [0, 0, 0], nrm = [0, 0, 0];

    // --- Milky Way ---------------------------------------------------------
    const gcHelio = galacticToWorld([R0_PC, 0, -Z_SUN_PC]);
    const ngp = galacticToWorld([0, 0, 1]);
    const lgUnit = units.push({ cx: 0, cy: 0, cz: 0, n: 0, bound: true, kind: "local-group" }) - 1;
    names.push("MILKY WAY");
    const mwIndex = push(S, {
        x: gcHelio[0] / MPC_PC, y: gcHelio[1] / MPC_PC, z: gcHelio[2] / MPC_PC, unit: lgUnit,
        MV: MILKY_WAY.MV, MK: MILKY_WAY.MV - 3.0, bv: MILKY_WAY.bv, T: MILKY_WAY.T,
        hKpc: MILKY_WAY.hKpc, bulge: MILKY_WAY.bulge, q0: MILKY_WAY.q0,
        nx: ngp[0], ny: ngp[1], nz: ngp[2], prov: PROV.MILKY_WAY, name: 0,
    });

    // --- Local Volume --------------------------------------------------------
    const lvIndexOf = new Int32Array(lv.length).fill(-1);
    const lvByName = new Map();
    for (let r = 0; r < lv.length; r++) {
        const g = lv[r];
        if (!(g.distMpc > 0)) continue;
        equatorialToWorldInto(g.ex, g.ey, g.ez, w);
        const T = Number.isFinite(g.type) ? Math.max(-5, Math.min(10, g.type)) : 10;
        const mp = morphologyProps(T);
        let MV = Number.isFinite(g.MV) ? g.MV : Number.isFinite(g.MB) ? g.MB - mp.bv : NaN;
        if (!Number.isFinite(MV) && Number.isFinite(g.logLK)) MV = MK_SUN - 2.5 * g.logLK + mp.vk;
        if (!Number.isFinite(MV)) continue;
        const MK = Number.isFinite(g.logLK) ? MK_SUN - 2.5 * g.logLK : MV - mp.vk;
        const RHo = Number.isFinite(g.diamKpc) && g.diamKpc > 0 ? g.diamKpc / 2 : NaN;
        const hKpc = Number.isFinite(RHo) ? RHo / (T <= -0.5 ? 3.0 : 3.6) : scaleLengthKpc(T, mkFromM(MK), rng);
        const q0 = mp.q0;
        const baUse = Number.isFinite(g.ba) ? g.ba : Number.isFinite(g.inclDeg) ? Math.sqrt(Math.cos(g.inclDeg * Math.PI / 180) ** 2 * (1 - q0 * q0) + q0 * q0) : NaN;
        normalFromSky(g.ex, g.ey, g.ez, baUse, g.paDeg, q0, rng, nrm, 0);
        const ni = names.push(g.displayName || g.name) - 1;
        const idx = push(S, {
            x: w[0] * g.distMpc, y: w[1] * g.distMpc, z: w[2] * g.distMpc, unit: -1,
            MV, MK, bv: mp.bv, T, hKpc, bulge: mp.bulge, q0,
            nx: nrm[0], ny: nrm[1], nz: nrm[2], prov: PROV.LV_MEASURED, name: ni,
        });
        lvIndexOf[r] = idx;
        lvByName.set(g.name, idx);
        stats.lv++;
    }
    // LV bound units: tidal index > 0 links a galaxy to its main disturber.
    {
        const idxs = [mwIndex];
        for (let r = 0; r < lv.length; r++) if (lvIndexOf[r] >= 0) idxs.push(lvIndexOf[r]);
        const local = new Map(idxs.map((g, k) => [g, k]));
        const uf = makeUF(idxs.length);
        for (let r = 0; r < lv.length; r++) {
            const gi = lvIndexOf[r];
            if (gi < 0) continue;
            const g = lv[r];
            if (!(g.tidalIndex > 0) || !g.mainDisturber) continue;
            const other = g.mainDisturber === "Milky Way" ? mwIndex : lvByName.get(g.mainDisturber);
            if (other === undefined) continue;
            uf.union(local.get(gi), local.get(other));
        }
        // Local Group: everything within 1 Mpc of the MW-M31 barycentre.
        const m31 = lvByName.get("MESSIER031");
        const bx = m31 !== undefined ? S.pos[mwIndex * 3] + (S.pos[m31 * 3] - S.pos[mwIndex * 3]) * 0.54 : 0;
        const by = m31 !== undefined ? S.pos[mwIndex * 3 + 1] + (S.pos[m31 * 3 + 1] - S.pos[mwIndex * 3 + 1]) * 0.54 : 0;
        const bz = m31 !== undefined ? S.pos[mwIndex * 3 + 2] + (S.pos[m31 * 3 + 2] - S.pos[mwIndex * 3 + 2]) * 0.54 : 0;
        units[lgUnit].cx = bx; units[lgUnit].cy = by; units[lgUnit].cz = bz;
        const rootUnit = new Map();
        for (let k = 0; k < idxs.length; k++) {
            const gi = idxs[k];
            const d = Math.hypot(S.pos[gi * 3] - bx, S.pos[gi * 3 + 1] - by, S.pos[gi * 3 + 2] - bz);
            if (d < 1.0) uf.union(k, 0);
        }
        const members = new Map();
        for (let k = 0; k < idxs.length; k++) {
            const r0 = uf.find(k);
            let a = members.get(r0); if (!a) members.set(r0, a = []);
            a.push(idxs[k]);
        }
        for (const [r0, a] of members) {
            if (r0 === uf.find(0)) { for (const gi of a) S.unit[gi] = lgUnit; units[lgUnit].n = a.length; continue; }
            if (a.length < 2) continue;
            let cx = 0, cy = 0, cz = 0, wsum = 0;
            for (const gi of a) {
                const L = Math.pow(10, -0.4 * S.MV[gi]);
                cx += S.pos[gi * 3] * L; cy += S.pos[gi * 3 + 1] * L; cz += S.pos[gi * 3 + 2] * L; wsum += L;
            }
            const u = units.push({ cx: cx / wsum, cy: cy / wsum, cz: cz / wsum, n: a.length, bound: true, kind: "lv-group" }) - 1;
            for (const gi of a) S.unit[gi] = u;
            rootUnit.set(r0, u);
        }
    }

    // --- 2MRS ---------------------------------------------------------------------
    const nM = mrs.count;
    const keep = [];
    const VIRGO = [0, 0, 0];
    { const ra = 187.706 * Math.PI / 180, dec = 12.391 * Math.PI / 180; VIRGO[0] = Math.cos(dec) * Math.cos(ra); VIRGO[1] = Math.cos(dec) * Math.sin(ra); VIRGO[2] = Math.sin(dec); }
    const vUse = [];
    for (let i = 0; i < nM; i++) {
        if (mrs.lvIndex[i] >= 0) continue;                       // drawn from the Local Volume row
        let v = mrs.vCmb[i];
        if (!(v > 250)) {
            // Blueshifted Virgo members (M86, M90, NGC 4419): the cluster's
            // mean CMB-frame velocity; other sub-250 km/s rows are unconfirmed.
            const cosV = mrs.ex[i] * VIRGO[0] + mrs.ey[i] * VIRGO[1] + mrs.ez[i] * VIRGO[2];
            if (cosV > Math.cos(6 * Math.PI / 180)) v = 1400; else { stats.dropped++; continue; }
        }
        keep.push(i); vUse.push(v);
    }
    const nK = keep.length;
    const ux = new Float64Array(nK), uy = new Float64Array(nK), uz = new Float64Array(nK), vv = new Float64Array(vUse);
    for (let k = 0; k < nK; k++) { const i = keep[k]; ux[k] = mrs.ex[i]; uy[k] = mrs.ey[i]; uz[k] = mrs.ez[i]; }
    const root = friendsOfFriends(ux, uy, uz, vv);
    const chi = new Float64Array(nK);
    for (let k = 0; k < nK; k++) chi[k] = comovingFromCz(vv[k]);
    // Finger-of-God compression per group.
    const grp = new Map();
    for (let k = 0; k < nK; k++) { let a = grp.get(root[k]); if (!a) grp.set(root[k], a = []); a.push(k); }
    const chiC = Float64Array.from(chi);
    const groupUnitOfRoot = new Map();
    for (const [r0, a] of grp) {
        if (a.length < 2) continue;
        let cx = 0, cy = 0, cz = 0, vm = 0;
        for (const k of a) { cx += ux[k]; cy += uy[k]; cz += uz[k]; vm += vv[k]; }
        const cl = Math.hypot(cx, cy, cz); cx /= cl; cy /= cl; cz /= cl; vm /= a.length;
        const dg = comovingFromCz(vm);
        let s2p = 0, s2l = 0;
        for (const k of a) {
            const dot = Math.min(1, ux[k] * cx + uy[k] * cy + uz[k] * cz);
            const rp = dg * Math.acos(dot);
            s2p += rp * rp;
            const dl = chi[k] - dg;
            s2l += dl * dl;
        }
        const sp = Math.sqrt(s2p / a.length), sl = Math.sqrt(s2l / a.length);
        const f = sl > 1e-6 ? Math.min(1, Math.max(sp, 0.05) / sl) : 1;
        if (f < 1) stats.fogCompressed++;
        for (const k of a) chiC[k] = dg + (chi[k] - dg) * f;
        equatorialToWorldInto(cx, cy, cz, w);
        const u = units.push({ cx: w[0] * dg, cy: w[1] * dg, cz: w[2] * dg, n: a.length, bound: true, kind: "fof-group", sigmaMpc: Math.max(sp, 0.05) }) - 1;
        groupUnitOfRoot.set(r0, u);
        stats.groups++;
    }
    const hostStart = S.n;
    const hostSigma = [];
    for (let k = 0; k < nK; k++) {
        const i = keep[k];
        const d = chiC[k];
        equatorialToWorldInto(ux[k], uy[k], uz[k], w);
        const T0 = twoMrsT(mrs.type[i], rng);
        const MK = mrs.KsMag[i] - distModulus(d);
        const unit = groupUnitOfRoot.get(root[k]) ?? -1;
        const T = Number.isFinite(T0) ? T0 : drawT(rng, unit >= 0 ? 1 : 0, MK);
        const mp = morphologyProps(T);
        normalFromSky(ux[k], uy[k], uz[k], mrs.ba[i], mrs.pa[i], mp.q0, rng, nrm, 0);
        push(S, {
            x: w[0] * d, y: w[1] * d, z: w[2] * d, unit,
            MV: MK + mp.vk, MK, bv: mp.bv, T, hKpc: scaleLengthKpc(T, mkFromM(MK), rng), bulge: mp.bulge, q0: mp.q0,
            nx: nrm[0], ny: nrm[1], nz: nrm[2], prov: PROV.REDSHIFT,
        });
        hostSigma.push(unit >= 0 ? units[unit].sigmaMpc : 0);
        stats.redshift++;
    }
    const hostEnd = S.n;

    // --- Zone-of-avoidance clones ----------------------------------------------------
    // Mask: |b| < 5 deg, widened to 8 deg within 30 deg of the Galactic centre.
    // A galaxy in the strip just outside the mask is mirrored across its edge.
    const g3 = [0, 0, 0], cloneUnit = new Map();
    for (let i = hostStart; i < hostEnd; i++) {
        const x = S.pos[i * 3], y = S.pos[i * 3 + 1], z = S.pos[i * 3 + 2];
        const d = Math.hypot(x, y, z);
        for (let r = 0; r < 3; r++) g3[r] = (W2G[r][0] * x + W2G[r][1] * y + W2G[r][2] * z) / d;
        const b = Math.asin(Math.max(-1, Math.min(1, g3[2]))) * 180 / Math.PI;
        const l = Math.atan2(g3[1], g3[0]) * 180 / Math.PI;
        const edge = Math.abs(l) < 30 ? 8 : 5;
        const ab = Math.abs(b);
        if (ab < edge || ab > 2 * edge) continue;
        const b2 = Math.sign(b) * (2 * edge - ab) * Math.PI / 180, lr = l * Math.PI / 180;
        const wv = galacticToWorld([Math.cos(b2) * Math.cos(lr), Math.cos(b2) * Math.sin(lr), Math.sin(b2)]);
        let unit = S.unit[i];
        if (unit >= 0) {
            if (!cloneUnit.has(unit)) cloneUnit.set(unit, units.push({ cx: 0, cy: 0, cz: 0, n: 0, bound: true, kind: "zoa-clone", sigmaMpc: units[unit].sigmaMpc }) - 1);
            unit = cloneUnit.get(unit);
        }
        randomUnit(rng, nrm, 0);
        push(S, {
            x: wv[0] * d, y: wv[1] * d, z: wv[2] * d, unit,
            MV: S.MV[i], MK: S.MK[i], bv: S.bv[i], T: S.T[i], hKpc: S.hKpc[i], bulge: S.bulge[i], q0: S.q0[i],
            nx: nrm[0], ny: nrm[1], nz: nrm[2], prov: PROV.ZOA_CLONE,
        });
        hostSigma.push(hostSigma[i - hostStart]);
        stats.clones++;
    }
    const cloneEnd = S.n;
    // Clone-group centres: the mean of their (mirrored) members.
    for (const u of cloneUnit.values()) { units[u].cx = 0; units[u].cy = 0; units[u].cz = 0; units[u].n = 0; }
    for (let i = hostEnd; i < cloneEnd; i++) {
        const u = S.unit[i];
        if (u < 0) continue;
        units[u].cx += S.pos[i * 3]; units[u].cy += S.pos[i * 3 + 1]; units[u].cz += S.pos[i * 3 + 2]; units[u].n++;
    }
    for (const u of cloneUnit.values()) { const m = Math.max(1, units[u].n); units[u].cx /= m; units[u].cy /= m; units[u].cz /= m; }

    // --- Faint completion around observed (and cloned) galaxies ------------------------
    // Each host at comoving distance d stands for the galaxies of its
    // neighbourhood that 2MRS could not see: on average
    //   w(d) = [n(<M_fl(d)) - n(<M_lim(d))] / n(<M_lim(d))
    // companions with M_lim < M < M_fl, placed inside the host's group (bound,
    // Plummer-like with the group's transverse size) or, for field hosts, as
    // correlated neighbours with dN/dr ~ r^(3 - gamma), gamma = 1.8 (the
    // two-point correlation function, e.g. Davis & Peebles 1983).
    const crng = makeRNG(splitSeed(seed, 0xc0f1));
    for (let i = hostStart; i < cloneEnd; i++) {
        const hx = S.pos[i * 3], hy = S.pos[i * 3 + 1], hz = S.pos[i * 3 + 2];
        const d = Math.hypot(hx, hy, hz);
        if (d < opts.lvRadiusMpc || d > opts.surveyMpc + opts.seamMpc) continue;
        const Mlim = TWOMRS_KLIM - distModulus(d);
        const Mfl = selectionMK(d, opts);
        if (Mfl <= Mlim) continue;
        const nLim = lfDensityBrighter(Mlim);
        const wgt = (lfDensityBrighter(Mfl) - nLim) / Math.max(1e-12, nLim);
        const seamFade = 1 - smooth(opts.surveyMpc - opts.seamMpc, opts.surveyMpc + opts.seamMpc, d);
        const k = samplePoisson(crng, wgt * seamFade);
        if (!k) continue;
        const unit = S.unit[i];
        const sig = hostSigma[i - hostStart];
        for (let c = 0; c < k; c++) {
            growStore(S, 1);
            if (S.n >= opts.maxGalaxies) break;
            let ox, oy, oz;
            if (unit >= 0 && sig > 0) {
                // Plummer sphere with half-mass radius ~1.3 sigma_perp, capped at 3 sigma.
                const a = Math.max(0.12, sig * 1.0);
                const u = Math.min(0.95, crng());
                const r = Math.min(3 * a, a / Math.sqrt(Math.pow(u, -2 / 3) - 1));
                randomUnit(crng, nrm, 0);
                ox = nrm[0] * r; oy = nrm[1] * r; oz = nrm[2] * r;
            } else {
                const r = opts.companionRMpc * Math.pow(crng(), 1 / 1.2);
                randomUnit(crng, nrm, 0);
                ox = nrm[0] * r; oy = nrm[1] * r; oz = nrm[2] * r;
            }
            const x = hx + ox, y = hy + oy, z = hz + oz;
            const MK = sampleLF(crng, Mlim, Mfl);
            const T = drawT(crng, unit >= 0 ? (units[unit].n > 25 ? 2 : 1) : 0, MK);
            const mp = morphologyProps(T);
            randomUnit(crng, nrm, 0);
            push(S, {
                x, y, z, unit: unit >= 0 ? unit : -1,
                MV: MK + mp.vk, MK, bv: mp.bv + 0.03 * gaussian(crng), T, hKpc: scaleLengthKpc(T, mkFromM(MK), crng), bulge: mp.bulge, q0: mp.q0,
                nx: nrm[0], ny: nrm[1], nz: nrm[2], prov: PROV.COMPLETION,
            });
            if (unit >= 0) units[unit].n++;
            stats.completion++;
        }
        if (S.n >= opts.maxGalaxies) break;
    }

    // --- Cosmic web beyond the survey ---------------------------------------------------
    // Radial distribution: the same selection, n(<M_fl(d)) d^2, faded in over
    // the seam; directions isotropic; positions accepted with the web weight.
    {
        const wrng = makeRNG(splitSeed(seed, 0x3eb0));
        const rIn = opts.surveyMpc - opts.seamMpc, rOut = opts.webMpc;
        const webWeight = makeWebField(seed, rOut);
        const NB = 600;
        const cdf = new Float64Array(NB + 1), rr = new Float64Array(NB + 1);
        let total = 0;
        for (let b = 0; b <= NB; b++) {
            const r = rIn + (rOut - rIn) * b / NB;
            rr[b] = r;
            if (b > 0) {
                const rm = 0.5 * (r + rr[b - 1]);
                const fade = smooth(opts.surveyMpc - opts.seamMpc, opts.surveyMpc + opts.seamMpc, rm);
                total += lfDensityBrighter(selectionMK(rm, opts)) * 4 * Math.PI * rm * rm * (rr[b] - rr[b - 1]) * fade;
            }
            cdf[b] = total;
        }
        // The mean acceptance of the web weight is measured, so the expected
        // count matches the luminosity function exactly.
        let accSum = 0;
        const probe = makeRNG(splitSeed(seed, 0x3eb1));
        const NP = 4000;
        for (let p = 0; p < NP; p++) {
            randomUnit(probe, nrm, 0);
            const r = rIn + (rOut - rIn) * probe();
            accSum += webWeight(nrm[0] * r, nrm[1] * r, nrm[2] * r, null);
        }
        const target = Math.min(opts.maxGalaxies - S.n, samplePoisson(wrng, total));
        const env = { env: 0 };
        let made = 0, tries = 0;
        const maxTries = Math.ceil(target / Math.max(0.02, accSum / NP) * 3) + 1000;
        while (made < target && tries < maxTries) {
            tries++;
            const u = wrng() * total;
            let lo = 0, hi = NB;
            while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m; else hi = m; }
            const f = cdf[hi] > cdf[lo] ? (u - cdf[lo]) / (cdf[hi] - cdf[lo]) : 0;
            const r = rr[lo] + (rr[hi] - rr[lo]) * f;
            randomUnit(wrng, nrm, 0);
            const x = nrm[0] * r, y = nrm[1] * r, z = nrm[2] * r;
            if (wrng() > webWeight(x, y, z, env)) continue;
            const MK = sampleLF(wrng, -27.5, selectionMK(r, opts));
            const T = drawT(wrng, env.env, MK);
            const mp = morphologyProps(T);
            randomUnit(wrng, nrm, 0);
            push(S, {
                x, y, z, unit: -1,
                MV: MK + mp.vk, MK, bv: mp.bv + 0.03 * gaussian(wrng), T, hKpc: scaleLengthKpc(T, mkFromM(MK), wrng), bulge: mp.bulge, q0: mp.q0,
                nx: nrm[0], ny: nrm[1], nz: nrm[2], prov: PROV.WEB,
            });
            made++;
            stats.web++;
        }
    }

    // --- Pack ----------------------------------------------------------------------------
    const n = S.n;
    const out = {
        count: n,
        pos: S.pos.slice(0, n * 3), unit: S.unit.slice(0, n), MV: S.MV.slice(0, n), MK: S.MK.slice(0, n),
        bv: S.bv.slice(0, n), T: S.T.slice(0, n), hKpc: S.hKpc.slice(0, n), bulge: S.bulge.slice(0, n),
        q0: S.q0.slice(0, n), normal: S.normal.slice(0, n * 3), prov: S.prov.slice(0, n), name: S.name.slice(0, n),
        names, mwIndex,
        units: {
            count: units.length,
            center: Float64Array.from(units.flatMap(u => [u.cx, u.cy, u.cz])),
            members: Int32Array.from(units.map(u => u.n)),
            kind: units.map(u => u.kind),
        },
        localGroupUnit: lgUnit,
        stats, options: opts,
    };
    return out;
}

function smooth(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

// Structural hash for determinism checks (positions to 1 kpc, magnitudes to 1e-3).
export function populationHash(pop) {
    let h = 0x811c9dc5 >>> 0;
    const step = Math.max(1, Math.floor(pop.count / 20000));
    for (let i = 0; i < pop.count; i += step) {
        h = hashInts(h, Math.round(pop.pos[i * 3] * 1000), Math.round(pop.pos[i * 3 + 1] * 1000), Math.round(pop.pos[i * 3 + 2] * 1000), Math.round(pop.MV[i] * 1000), pop.prov[i], pop.unit[i]);
    }
    return hashInts(h, pop.count);
}
