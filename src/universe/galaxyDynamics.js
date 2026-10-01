// Time-dependent structure of the Milky Way's disk: what moves with the
// stars and gas (material) and what moves as a pattern through them.
//
// The structure maps (galaxyMaps.js) are one present-day picture of the
// disk. Rotating that picture rigidly at one pattern speed (the earlier
// model) turns every arm, dust cloud, star-forming complex and star into a
// fixed drawing that never changes at any warp. This module is the single
// definition of how the same picture evolves with time; the volumetric
// renderer (GLSL below), the JS reference model (galaxyModel.js mwSample)
// and the procedural star field (resolvedField.js) all evaluate it, so the
// layers agree at every epoch, every zoom and in reverse time. Everything
// is a pure function of (sim time, fixed constants): no state is integrated,
// so a time reached forward or backward looks the same.
//
// 1. Differential rotation. Gas, dust clouds, star-forming complexes and
//    stars orbit at the local circular rate Omega(R) = v_c(R) / R, from the
//    same rotation curve the procedural stars' epicycles use
//    (astroConstants.js vCirc, Eilers et al. 2019): solid body inside
//    5 kpc, flat outside, so the disk shears outside the bar region.
//
// 2. Transient, recurrent spiral arms (patterns, not material ribbons). In
//    simulations and in the Milky Way's kinematics, spirals are not one
//    rigid, eternal density wave: arms grow, shear and fade over one to a
//    few rotations and new ones take their place (Sellwood & Carlberg 1984,
//    2014; Grand, Kawata & Cropper 2012; Baba, Saitoh & Wada 2013; Quillen
//    et al. 2018 and Hunt et al. 2019 for transient arms in Gaia
//    kinematics). The arms here are GENERATIONS of the mapped structure:
//    generation k peaks at t_k = k P and its weight is cos^2 of its age over
//    +-P, so two generations overlap and their weights sum to one. A
//    generation's map frame turns at the pattern speed Omega_p plus a
//    fraction f of the local shear, A_k(R, t) = Omega_p t + theta_k +
//    f (Omega(R) - Omega_p)(t - t_k): its arms open while it grows and wind
//    up as it fades, but never wind for longer than its own life, so no
//    epoch accumulates tightly wound strips. Generation 0 is the measured
//    present-day spiral (Reid et al. 2019) and peaks at t = 0; generation
//    k != 0 is re-attached to the bar at its peak (theta_k is the bar's
//    advance over the arms by t_k, plus a seeded jitter): the arms of every
//    generation start near the bar ends while they are strongest, as
//    Scutum-Centaurus and Perseus do today. Rotations about the centre
//    preserve area, so every epoch has the same luminosity and the same
//    radial profile; only where the arms are changes.
//
// 3. Material structure below the maps' texels (dust clouds, star-forming
//    complexes, clusters, HII shells) and the procedural stars are carried
//    by the material: in EPOCH e (centred on t_e = e L) they sit in a frame
//    that turns at Omega(R), so they shear with the disk and stream through
//    the arms -- a complex lights up while it crosses an arm's young-star
//    ridge and fades beyond it. Each epoch lasts L (cloud and complex
//    lifetimes are a few tens of Myr, e.g. Kruijssen et al. 2019; Chevance
//    et al. 2020) and hands over to the next over a fraction of L, so the
//    shear any structure accumulates is bounded (|t - t_e| <= (1/2 + d) L):
//    bounded phase mixing. Epoch 0 is the present-day realisation; other
//    epochs are seeded realisations of the same statistics (salts).
//
// Provenance: MEASURED rotation curve, present-day arms, bar and pattern
// speeds (galaxyModel.js); MODEL the generation period, winding fraction,
// epoch length and the statistical arms and material of other epochs.

import { vCirc } from "./astroConstants.js";

const YEAR_S = 31557600;
export const MYR_S = 1e6 * YEAR_S;
// 1 km/s/kpc in rad/Myr
export const KMS_KPC_RAD_MYR = MYR_S / 3.0856775814913673e16;
// Pattern speeds (galaxyModel.js MW cites them): bar ~39 km/s/kpc (Portail
// et al. 2017), spiral ~28.2 km/s/kpc (Dias et al. 2019).
export const SPIRAL_PATTERN_KMS_KPC = 28.2;
export const BAR_PATTERN_KMS_KPC = 39;
export const OMEGA_P = SPIRAL_PATTERN_KMS_KPC * KMS_KPC_RAD_MYR;   // rad/Myr
export const OMEGA_B = BAR_PATTERN_KMS_KPC * KMS_KPC_RAD_MYR;      // rad/Myr

export const SPIRAL = Object.freeze({
    // A generation is above half weight for P (cos^2 window of total width
    // 2P): about one rotation at the solar circle (~220 Myr), the lifetime
    // of transient arms in disk simulations.
    periodMyr: 250,
    // Fraction of the material shear the arms follow (0: rigid density
    // wave, 1: material arms). Half: the apparent winding of superposed
    // transient modes.
    windFrac: 0.5,
    // Jitter of a generation's attachment to the bar at its peak (rad).
    jitterRad: 50 * Math.PI / 180,
    // The gas (dust lanes, young stars, HII) shocks in the dominant
    // generation's arms: its hand-over is the stellar weight sharpened to
    // the middle +-gasHandover of the cross-fade (two half-weight sets of
    // narrow lanes would weave through each other, which gas, being
    // collisional, does not do). The old stars superpose linearly.
    gasHandover: 0.2,
});
export const EPOCH = Object.freeze({
    lengthMyr: 30,
    // Each hand-over spans 2 * fade * L, centred on the epoch boundary.
    fade: 0.15,
});
// Longest time any material structure is carried by its epoch's shear (Myr).
export const EPOCH_REACH_MYR = (0.5 + EPOCH.fade) * EPOCH.lengthMyr;

const TAU = 2 * Math.PI;
export function wrapAngle(a) {
    a %= TAU;
    return a < 0 ? a + TAU : a;
}
function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}
// Integer hash -> [0, 1), stable across engines (32-bit integer ops).
export function dynHash01(k, salt) {
    let h = Math.imul(k | 0, 0x27d4eb2d) ^ Math.imul(salt | 0, 0x9e3779b1) ^ 0x6d2b79f5;
    h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

// --- Rotation -------------------------------------------------------------
// Circular angular rate at cylindrical radius Rpc (rad/Myr). vCirc is
// linear in R inside 5 kpc, so Omega is constant there (no shear).
export function omegaRadMyr(Rpc) {
    const Rk = Math.max(Rpc, 1) / 1000;
    return vCirc(Rk) / Rk * KMS_KPC_RAD_MYR;
}
// Angular rate of a generation's arms relative to the pattern speed (at
// radius R, or where the material turns at om = Omega(R)).
export function windRadMyr(Rpc) {
    return windOfOmega(omegaRadMyr(Rpc));
}
export function windOfOmega(om) {
    return SPIRAL.windFrac * (om - OMEGA_P);
}

// --- Spiral generations ---------------------------------------------------
// Map-frame offset of generation k (rad): 0 for the present-day arms.
export function generationTheta(k) {
    if (k === 0) return 0;
    const tk = k * SPIRAL.periodMyr;
    return wrapAngle((OMEGA_B - OMEGA_P) * tk + (2 * dynHash01(k, 0x51) - 1) * SPIRAL.jitterRad);
}
// The two generations alive at sim time tSec (s): out.gens[i] = { k, w,
// wGas, base (rad, wrapped), tau (Myr since the generation's peak) }; w
// weighs the old stars, wGas the gas and young channels. The map
// frame of generation g at radius R is turned by base + windRadMyr(R) * tau
// from the galactocentric frame (sample the maps at Rot(-angle) p).
export function generationState(tSec, out = { gens: [{}, {}] }) {
    const tMyr = (Number.isFinite(tSec) ? tSec : 0) / MYR_S;
    const P = SPIRAL.periodMyr;
    const u = tMyr / P, k0 = Math.floor(u), s = u - k0;
    const sn = Math.sin(0.5 * Math.PI * s);
    // a generation within ~1.6 Myr of its partner's peak (weight < 1e-4)
    // is dropped: one generation to sample instead of two
    let w1 = sn * sn;
    if (w1 < GEN_W_MIN) w1 = 0; else if (w1 > 1 - GEN_W_MIN) w1 = 1;
    const pat = OMEGA_P * tMyr;
    for (let i = 0; i < 2; i++) {
        const k = k0 + i, g = out.gens[i] || (out.gens[i] = {});
        g.k = k;
        g.w = i === 0 ? 1 - w1 : w1;
        g.wGas = gasWeight(g.w);
        g.tau = tMyr - k * P;
        g.base = wrapAngle(pat + generationTheta(k));
    }
    return out;
}
export function gasWeight(w) {
    return smoothstep(0.5 - SPIRAL.gasHandover, 0.5 + SPIRAL.gasHandover, w);
}
const GEN_W_MIN = 1e-4;
export function generationAngle(g, Rpc) {
    return g.base + windRadMyr(Rpc) * g.tau;
}

// --- Material epochs --------------------------------------------------------
// Salts of epoch e: integer cell offsets (100 pc cells of the star-forming
// complexes) and a noise-space offset (dust clouds); zero for epoch 0, so
// the present-day realisation is unchanged. Bounded, for float32 shaders.
export function epochSalt(e, out = { cell: [0, 0], noise: [0, 0, 0] }) {
    if (e === 0) {
        out.cell[0] = out.cell[1] = 0;
        out.noise[0] = out.noise[1] = out.noise[2] = 0;
        return out;
    }
    out.cell[0] = Math.floor(dynHash01(e, 0x61) * 512);
    out.cell[1] = Math.floor(dynHash01(e, 0x62) * 512);
    for (let i = 0; i < 3; i++) out.noise[i] = dynHash01(e, 0x63 + i) * 640;
    return out;
}
export function epochPhi(e) {
    return wrapAngle(OMEGA_P * e * EPOCH.lengthMyr);
}
function fillEpoch(ep, e, w, tMyr) {
    ep.e = e; ep.w = w;
    ep.tau = tMyr - e * EPOCH.lengthMyr;
    ep.phi = epochPhi(e);
    ep.salt = epochSalt(e, ep.salt || { cell: [0, 0], noise: [0, 0, 0] });
    return ep;
}
// The epochs alive at tSec: out.epochs[0] is the current one, out.epochs[1]
// the one it hands over to/from (w = 0 outside a hand-over). Material at
// epoch-frame point q is at galactocentric Rot(phi + Omega(R) tau) q.
export function epochState(tSec, out = { epochs: [{}, {}] }) {
    const tMyr = (Number.isFinite(tSec) ? tSec : 0) / MYR_S;
    const L = EPOCH.lengthMyr, d = EPOCH.fade;
    const v = tMyr / L, c = Math.floor(v + 0.5), s = v - c;
    let p = c, wp = 0;
    if (s > 0.5 - d) { p = c + 1; wp = smoothstep(0.5 - d, 0.5 + d, s); }
    else if (s < d - 0.5) { p = c - 1; wp = 1 - smoothstep(-0.5 - d, d - 0.5, s); }
    fillEpoch(out.epochs[0] || (out.epochs[0] = {}), c, 1 - wp, tMyr);
    fillEpoch(out.epochs[1] || (out.epochs[1] = {}), p, wp, tMyr);
    return out;
}
// Weight of epoch e at tSec (0 outside its life).
export function epochWeightAt(e, tSec) {
    const st = epochState(tSec, _es);
    for (const ep of st.epochs) if (ep.e === e && ep.w > 0) return ep.w;
    return 0;
}
const _es = { epochs: [{}, {}] };
export function materialAngle(ep, Rpc) {
    return ep.phi + omegaRadMyr(Rpc) * ep.tau;
}
// Time span (Myr) over which epoch e carries any weight.
export function epochWindowMyr(e) {
    const L = EPOCH.lengthMyr;
    return [(e - 0.5 - EPOCH.fade) * L, (e + 0.5 + EPOCH.fade) * L];
}
// Generations with weight at some time in [t0, t1] (Myr), each with its
// map-frame offset theta and peak time tk (Myr).
export function generationsBetween(t0Myr, t1Myr, out = []) {
    out.length = 0;
    const P = SPIRAL.periodMyr;
    for (let k = Math.floor(t0Myr / P); k <= Math.floor(t1Myr / P) + 1; k++) {
        if ((k - 1) * P >= t1Myr || (k + 1) * P <= t0Myr) continue;
        out.push({ k, theta: generationTheta(k), tk: k * P });
    }
    return out;
}

// Exposure-time filter for material detail: a frame that spans more sim
// time than a fraction of an epoch would only flicker between realisations
// it cannot show, so the detail fades to its (unit) mean, like a pixel
// footprint larger than a cloud. 1 = full detail.
export function materialDetailLod(dtMyrPerFrame) {
    const L = EPOCH.lengthMyr;
    return 1 - smoothstep(L / 24, L / 6, Math.abs(dtMyrPerFrame || 0));
}

// --- GLSL ---------------------------------------------------------------------
// Uniforms (filled by dynamicsUniformValues):
//   uGenA = (base0, tau0, base1, tau1), uGenW = (w0, w1, wGas0, wGas1),
//   uGenN = generations with weight (slot 0 first)
//   uEpA = (phi0, tau0, phi1, tau1), uEpW = (w0, w1), uEpN = epochs with weight
//   uEpCell = (cellX0, cellY0, cellX1, cellY1), uEpNoise0 / uEpNoise1
const V5 = vCirc(5), V25 = vCirc(25);
// Functions only (no uniforms): circular rate, arms' winding rate, rotation.
export const DYNAMICS_FN_GLSL = /* glsl */`
// circular rate (rad/Myr) at radius R (pc): astroConstants.vCirc
float dynOmega(float R) {
    float Rk = max(R, 1.0) / 1000.0;
    float v = Rk < 5.0 ? ${V5.toFixed(6)} * Rk / 5.0 : mix(${V5.toFixed(6)}, ${V25.toFixed(6)}, (min(Rk, 25.0) - 5.0) / 20.0);
    return v / Rk * ${KMS_KPC_RAD_MYR.toPrecision(10)};
}
float dynWind(float om) { return ${SPIRAL.windFrac.toFixed(4)} * (om - ${OMEGA_P.toPrecision(10)}); }
vec2 dynRot(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
`;
export const DYNAMICS_GLSL = /* glsl */`
uniform vec4 uGenA, uGenW, uEpA, uEpCell;
uniform vec2 uEpW;
uniform int uGenN, uEpN;
uniform vec3 uEpNoise0, uEpNoise1;
${DYNAMICS_FN_GLSL}`;
// GLSL constants are generated from vCirc assuming it is linear on 5-25 kpc.
export const VCIRC_GLSL_KNOTS = Object.freeze({ v5: V5, v25: V25 });

export function dynamicsUniformValues(tSec, gs = generationState(tSec), es = epochState(tSec), out = {}) {
    let g0 = gs.gens[0], g1 = gs.gens[1];
    if (!(g0.w > 0) && !(g0.wGas > 0)) { const g = g0; g0 = g1; g1 = g; }   // the generation alive first
    const e0 = es.epochs[0], e1 = es.epochs[1];
    out.uGenN = g1.w > 0 || g1.wGas > 0 ? 2 : 1;
    out.uEpN = e1.w > 0 && e1.e !== e0.e ? 2 : 1;
    out.uGenA = [g0.base, g0.tau, g1.base, g1.tau];
    out.uGenW = [g0.w, g1.w, g0.wGas, g1.wGas];
    out.uEpA = [e0.phi, e0.tau, e1.phi, e1.tau];
    out.uEpW = [e0.w, e1.w];
    out.uEpCell = [e0.salt.cell[0], e0.salt.cell[1], e1.salt.cell[0], e1.salt.cell[1]];
    out.uEpNoise0 = e0.salt.noise.slice();
    out.uEpNoise1 = e1.salt.noise.slice();
    return out;
}
