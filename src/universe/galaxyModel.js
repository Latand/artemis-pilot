// Analytic light-and-dust model of the Milky Way for the UNRESOLVED stellar
// field (the diffuse Milky Way band seen from inside, the galaxy disk seen from
// outside). It is the same galaxy the procedural generator draws individual
// stars from (galaxy.js / astroConstants.js: exponential thin + thick disks,
// flattened power-law halo, Reid et al. 2019 log-spiral arms), expressed as a
// luminosity density instead of a number density, plus an interstellar dust
// layer. The renderer (render/galaxyVolume.js) integrates it along view rays
// in a GLSL port of this file; the JS version here is the reference used for
// exposure metering and for the smokes that pin the two together.
//
// Resolved vs unresolved light. Stars bright enough to be drawn as points are
// drawn by the star layers (catalog near the Sun, procedural elsewhere); the
// diffuse layer must carry only the light of the stars NOT drawn, or the
// Galaxy would be counted twice. A star is drawn when its apparent magnitude
// from the camera is brighter than RESOLVED_MAG_LIMIT, i.e. when its absolute
// magnitude is brighter than M_lim(s) = m_lim - 5 log10(s / 10 pc) at camera
// distance s. unresolvedFraction(s, comp) is the fraction of a component's
// light carried by stars fainter than M_lim(s) in V, tabulated from the
// procedural population (resolvedLF.js, built by scripts/build-resolved-lf.mjs
// from galaxy.js starsInCell plus a Monte Carlo of the luminous tail). The
// young and old components have their own tables (young light is carried by
// far more luminous stars). The procedural resolved field
// (resolvedField.js) draws exactly the complementary stars from the same
// tables and densities, so the diffuse glow fades out near the camera where
// individual stars take over and becomes the whole galaxy's light at large
// distance: a flux-preserving handoff, not a cross-fade.
//
// Provenance of the parameters (see docs/universe-continuity.md):
//   measured / literature: disk scale lengths and heights, arm geometry
//     (Reid+2019), solar position (GRAVITY 2019, Bennett & Bovy 2019), bar
//     orientation ~27 deg and half-length ~5 kpc (Wegg, Gerhard & Portail
//     2015), bar pattern speed ~39 km/s/kpc (Portail+2017), spiral pattern
//     speed ~28 km/s/kpc (Dias+2019), mean midplane extinction ~1.8 mag/kpc in
//     V, R_V = 3.1 extinction law ratios.
//   model extrapolation: the maser-traced arms are observed over the near
//     half of the disk only; here each log spiral continues around the far
//     side at full contrast. Population colours are effective temperatures of
//     integrated light, not synthesized spectra. Dust clumping is procedural.

import { DISK, HALO, REID_ARMS, armWidth } from "./astroConstants.js";
import { R0_PC } from "./coords.js";
import { FAINT_LIGHT_V, FAINT_LIGHT_V_YOUNG, FAINT_LIGHT_V_OLD } from "./resolvedLF.js";
import { TIDES, MW_BIN_COUNT, keepAtRadius } from "./mergerTides.js";

const DEG = Math.PI / 180;
// 1 km/s/kpc in rad/s.
const KMS_KPC_RAD_S = 1 / 3.0856775814913673e16;

export const RESOLVED_MAG_LIMIT = 11;

// Fraction of a component's bolometric light carried by stars FAINTER than
// absolute V magnitude M (M from -8 to +12 in steps of 1): young, old
// (thin + thick + halo + bar), and the local mixture.
export const FAINT_TABLES = Object.freeze({ young: FAINT_LIGHT_V_YOUNG, old: FAINT_LIGHT_V_OLD, mix: FAINT_LIGHT_V });
export const FAINT_LIGHT_TABLE = FAINT_LIGHT_V;
export const FAINT_TABLE_M0 = -8;

export function faintLightFraction(M, comp = "mix") {
    const table = FAINT_TABLES[comp] || FAINT_LIGHT_V;
    const x = (M - FAINT_TABLE_M0);
    if (x <= 0) return table[0];
    const n = table.length - 1;
    if (x >= n) return table[n];
    const i = Math.floor(x), f = x - i;
    return table[i] * (1 - f) + table[i + 1] * f;
}

// Fraction of a component's light at camera distance sPc, behind avMag of V
// extinction, that no star layer draws: the partition is in observed
// magnitude, so a star dimmed past the limit by dust belongs to the diffuse
// light (which the same dust dims).
export function unresolvedFraction(sPc, magLimit = RESOLVED_MAG_LIMIT, comp = "mix", avMag = 0) {
    const M = magLimit - 5 * Math.log10(Math.max(sPc, 1e-3) / 10) - avMag;
    return faintLightFraction(M, comp);
}

// --- Milky Way structural + light parameters (galactocentric pc; galaxy.js
// frame: +X from the Galactic centre toward the Sun at t=0, +Y the direction
// of rotation, +Z the North Galactic Pole). -----------------------------------
export const MW = Object.freeze({
    R0: R0_PC,
    // Bolometric luminosity density at the Sun (Lsun / pc^3), all components:
    // the procedural population's measured value (galaxy.js, see above).
    jSun: 0.1275,
    // Share of that local light by component (sums to 1 at the Sun).
    fYoung: 0.24,          // arm-concentrated young thin disk (hz ~ 100 pc)
    fThin: 0.66,           // old thin disk (hz 300 pc)
    fThick: 0.095,         // thick disk (hz 900 pc)
    fHalo: 0.005,          // stellar halo
    hzYoung: 100,
    hrThin: DISK.thinHR, hzThin: DISK.thinHZ,
    hrThick: DISK.thickHR, hzThick: DISK.thickHZ,
    haloQ: HALO.q, haloN: HALO.n,
    rDiskMax: 22000,
    // The thin disk gives way to the bar inside the molecular ring (inner
    // disk deficit / "type II" profile): light tapers in over R = 1.5-3.5 kpc.
    diskHoleIn: 1500, diskHoleOut: 3500,
    // Bar / bulge: triaxial exponential; axis ratios after Wegg+2015.
    barAngle0: 27 * DEG,   // major axis from the Sun-GC line toward +rotation
    barA: 1700, barB: 650, barC: 450,
    barLum: 2.6e10,        // Lsun (bolometric), ~20% of the model Galaxy
    barPatternKmsKpc: 39,
    spiralPatternKmsKpc: 28.2,
    armAmpYoung: 3.0,      // young light contrast (astroConstants ARM_AMP_YOUNG)
    armAmpOld: 0.3,
    // Dust: V-band opacity, azimuthal-mean midplane value at the solar circle
    // (1.2 mag/kpc; the classic ~1.8 mag/kpc average in the plane includes
    // the arm enhancement applied below).
    kappaSun: 1.2 * 0.4 * Math.LN10 / 1000,
    hzDust: 100, hrDust: 3500,
    armDustBase: 0.12,     // inter-arm dust relative to an arm centerline
    armDust: 1.6,
    armDustMean: 0.44,     // azimuthal mean of (armDustBase + armDust*arm) at R0
    dustHoleR: 3200,       // gas-poor bar region inside the molecular ring
    bubbleR: 110,          // Local Bubble (low-dust cavity around the Sun)
    // Integrated-light effective temperatures (display colour only).
    teffYoung: 10000, teffThin: 6100, teffThick: 5300, teffBar: 4800, teffHalo: 5000,
    // Clumpiness (GLSL only; log-normal factors normalized to unit mean, so
    // the smooth JS reference keeps the same average light and opacity):
    // molecular-cloud dust on ~40-400 pc scales and star-forming complexes
    // on ~250 pc scales, anchored in the rotating disk frame.
    dustClump: 2.1, youngClump: 1.3,
});

// Extinction-law ratios A_lambda / A_V for the display R, G, B channels
// (R_V = 3.1, Cardelli+1989 at ~0.64 / 0.55 / 0.45 micron).
export const EXTINCTION_RGB = Object.freeze([0.78, 1.0, 1.32]);

export function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

function thinShape(R, z, hr, hz) {
    return Math.exp(-(R - MW.R0) / hr) * Math.exp(-Math.abs(z) / hz);
}

// Continued Reid et al. 2019 log spirals: 0 (between arms) .. 1 (on an arm
// centerline), gaussian in the perpendicular distance. `betaDeg` must already
// be in the pattern frame (azimuth minus the pattern rotation angle).
export function armProfile(R, betaDeg) {
    if (R < 1500 || R > MW.rDiskMax) return 0;
    const Rkpc = R / 1000;
    let best = 0;
    for (let i = 0; i < REID_ARMS.length; i++) {
        const arm = REID_ARMS[i];
        const psi = (Rkpc < arm.rKinkKpc ? arm.pitchInner : arm.pitchOuter) * DEG;
        const tanPsi = Math.tan(psi);
        const armBeta = Math.abs(tanPsi) < 1e-6 ? arm.betaKinkDeg
            : arm.betaKinkDeg - Math.log(Rkpc / arm.rKinkKpc) / tanPsi / DEG;
        let d = betaDeg - armBeta;
        d = ((d + 180) % 360 + 360) % 360 - 180;
        // Perpendicular distance to a spiral pitched psi to the circle:
        // arc length along the circle times sin(psi).
        const dPerp = Math.abs(d * DEG) * R * Math.sin(psi);
        const w = arm.widthKpc * (armWidth(Rkpc) / armWidth(8.15)) * 1000;
        const p = Math.exp(-(dPerp * dPerp) / (2 * w * w)) * armRangeWeight(arm, armBeta);
        if (p > best) best = p;
    }
    return best;
}

// Full contrast over the arm's maser-observed azimuth range (Reid+2019
// Table 2 betaMin..betaMax); beyond it the log spiral is an extrapolation and
// fades to 0.35 over 100 deg so the far side keeps weaker, not ring-like,
// structure. `armBeta` is the centerline azimuth (pattern frame, deg).
export function armRangeWeight(arm, armBeta) {
    let b = ((armBeta - arm.betaMinDeg) % 360 + 360) % 360 + arm.betaMinDeg;
    if (b >= arm.betaMinDeg && b <= arm.betaMaxDeg) return 1;
    const over = Math.min(Math.abs(b - arm.betaMaxDeg), Math.abs(b - 360 - arm.betaMinDeg), Math.abs(b - arm.betaMinDeg));
    return 0.35 + 0.65 * Math.exp(-(over * over) / (2 * 60 * 60));
}

let _barNorm = 0;
function barNorm() {
    if (!_barNorm) _barNorm = MW.barLum / (8 * Math.PI * MW.barA * MW.barB * MW.barC);
    return _barNorm;
}

// Pattern angles at simulation time t (seconds from the session epoch).
export function patternAngles(tSec, out = {}) {
    out.spiral = MW.spiralPatternKmsKpc * KMS_KPC_RAD_S * tSec;
    out.bar = MW.barAngle0 + MW.barPatternKmsKpc * KMS_KPC_RAD_S * tSec;
    return out;
}

// Luminosity density (Lsun/pc^3) by component and dust opacity (V, per pc) at
// galactocentric (x, y, z) pc. `era` is cosmicEra.eraModulation(t) (or null),
// `disrupt` the merger disruption: a fraction 0..1 of the disk light removed
// everywhere, or the per-radius keep factors of the tidal model
// (mergerTides.js keepAt().mwBins), which remove the disk light the debris
// particles carry.
// (sunX, sunY, sunZ): the Sun's CURRENT galactocentric position, centre of
// the Local Bubble dust cavity (defaults to the t=0 anchor).
export function mwSample(x, y, z, angles, era, disrupt, out, sunX = MW.R0, sunY = 0, sunZ = 20.8) {
    const R = Math.hypot(x, y);
    const beta = Math.atan2(y, x) / DEG - angles.spiral / DEG;
    const arm = armProfile(R, beta);
    const sfr = era ? era.blueFrac : 1;
    const keep = disrupt && disrupt.length === MW_BIN_COUNT
        ? keepAtRadius(disrupt, TIDES.mwBinEdgesKpc, R / 1000)
        : 1 - Math.max(0, Math.min(1, disrupt || 0));
    const j0 = MW.jSun;
    const hole = smoothstep(MW.diskHoleIn, MW.diskHoleOut, R);
    const young = hole * j0 * MW.fYoung * thinShape(R, z, MW.hrThin, MW.hzYoung) * (0.15 + MW.armAmpYoung * arm) / (0.15 + MW.armAmpYoung * armProfile(MW.R0, 0)) * sfr;
    const thin = hole * j0 * MW.fThin * thinShape(R, z, MW.hrThin, MW.hzThin) * (1 + MW.armAmpOld * arm);
    const thick = (0.3 + 0.7 * hole) * j0 * MW.fThick * thinShape(R, z, MW.hrThick, MW.hzThick);
    const rEff = Math.hypot(R, z / MW.haloQ);
    const halo = j0 * MW.fHalo * Math.pow(MW.R0 / Math.max(rEff, 300), MW.haloN);
    const cb = Math.cos(angles.bar), sb = Math.sin(angles.bar);
    const bx = (x * cb + y * sb) / MW.barA, by = (-x * sb + y * cb) / MW.barB, bz = z / MW.barC;
    const bar = barNorm() * Math.exp(-Math.sqrt(bx * bx + by * by + bz * bz));
    out.young = young * keep;
    out.thin = thin * keep;
    out.thick = thick * keep;
    out.halo = halo;
    out.bar = bar;
    const dSun = Math.hypot(x - sunX, y - sunY, z - sunZ);
    out.kappa = MW.kappaSun * Math.exp(-(R - MW.R0) / MW.hrDust) * Math.exp(-Math.abs(z) / MW.hzDust) *
        (MW.armDustBase + MW.armDust * arm) / MW.armDustMean * (0.25 + 0.75 * sfr) * keep *
        smoothstep(MW.dustHoleR * 0.45, MW.dustHoleR, R) * smoothstep(MW.bubbleR * 0.4, MW.bubbleR, dSun);
    out.arm = arm;
    return out;
}

// Reference integration along one ray: camera at galactocentric pc (cx, cy,
// cz), unit direction (dx, dy, dz). Returns the per-component radiance in
// Lsun/pc^2/sr-like units (luminosity density x path / 4 pi), with dust
// attenuation and the unresolved-light fraction applied; `out.tau` is the V
// optical depth to the far edge.
export function integrateRay(cx, cy, cz, dx, dy, dz, tSec, era = null, disrupt = 0, out = {}, steps = 160, sun = null, magLimit = RESOLVED_MAG_LIMIT) {
    const ang = patternAngles(tSec, _ang);
    const sMax = rayExit(cx, cy, cz, dx, dy, dz);
    let tauV = 0, young = 0, old = 0, bar = 0;
    const sMin = 0.5;
    const ratio = Math.pow(Math.max(sMax, sMin * 2) / sMin, 1 / steps);
    let s0 = 0, s = sMin;
    for (let i = 0; i < steps && s0 < sMax; i++) {
        const s1 = Math.min(sMax, s);
        const sm = 0.5 * (s0 + s1), ds = s1 - s0;
        mwSample(cx + dx * sm, cy + dy * sm, cz + dz * sm, ang, era, disrupt, _smp,
            sun ? sun[0] : MW.R0, sun ? sun[1] : 0, sun ? sun[2] : 20.8);
        const av = 1.0857362047581294 * tauV;
        const fy = unresolvedFraction(sm, magLimit, "young", av), fo = unresolvedFraction(sm, magLimit, "old", av);
        const att = Math.exp(-tauV);
        young += _smp.young * fy * att * ds;
        old += (_smp.thin + _smp.thick + _smp.halo) * fo * att * ds;
        bar += _smp.bar * fo * att * ds;
        tauV += _smp.kappa * ds;
        s0 = s1;
        s *= ratio;
    }
    const k = 1 / (4 * Math.PI);
    out.young = young * k; out.old = old * k; out.bar = bar * k; out.tau = tauV;
    return out;
}
const _ang = {}, _smp = {};

// Distance along the ray to the model's bounding cylinder (R < 25 kpc,
// |z| < 6 kpc), or 0 if the ray misses it.
export function rayExit(cx, cy, cz, dx, dy, dz) {
    const RB = 25000, ZB = 6000;
    const a = dx * dx + dy * dy, b = 2 * (cx * dx + cy * dy), c = cx * cx + cy * cy - RB * RB;
    let tCyl = Infinity;
    if (a > 1e-12) {
        const disc = b * b - 4 * a * c;
        if (disc >= 0) tCyl = (-b + Math.sqrt(disc)) / (2 * a);
    }
    let tZ = Infinity;
    if (Math.abs(dz) > 1e-12) tZ = Math.max((ZB - cz) / dz, (-ZB - cz) / dz);
    const t = Math.min(tCyl, tZ);
    return Number.isFinite(t) && t > 0 ? t : 0;
}

// --- GLSL port -------------------------------------------------------------
// Mirrors armProfile / mwSample / unresolvedFraction above. Uniforms are
// filled by render/galaxyVolume.js from the same MW constants (see
// galaxyModelUniformValues), so the JS reference and the shader cannot drift
// apart silently; smoke-galaxy-model.mjs compares both implementations.
// GLSL body of gmKeep: bin centres from the tidal model's radial bins.
function KEEP_GLSL() {
    const e = TIDES.mwBinEdgesKpc, nb = MW_BIN_COUNT;
    const c = i => i === 0 ? e[0] * 0.5 : i === nb - 1 ? e[nb - 2] + 2 : 0.5 * (e[i - 1] + e[i]);
    let g = `if (rk <= ${c(0).toFixed(3)}) return uKeepR[0];\n`;
    for (let i = 1; i < nb; i++) {
        g += `    if (rk <= ${c(i).toFixed(3)}) return mix(uKeepR[${i - 1}], uKeepR[${i}], (rk - ${c(i - 1).toFixed(3)}) / ${(c(i) - c(i - 1)).toFixed(3)});\n`;
    }
    return g + `    return uKeepR[${nb - 1}];`;
}

export const GALAXY_MODEL_GLSL = /* glsl */`
uniform float uArmRk[5], uArmTanIn[5], uArmTanOut[5], uArmSinIn[5], uArmSinOut[5];
uniform float uArmBetaK[5], uArmW[5], uArmBMin[5], uArmBMax[5];
uniform float uFaintY[21], uFaintO[21];
uniform float uMagLimit;
uniform float uSpiral, uBar, uSfr, uKeep;
uniform float uKeepR[${MW_BIN_COUNT}];
uniform vec3 uSun;
uniform float uJ0, uFYoung, uFThin, uFThick, uFHalo, uYoungNorm;
uniform float uBarNorm;
uniform vec3 uBarAxes;
uniform float uKappaSun;
const float R0 = ${MW.R0.toFixed(1)};
const float DEG = 0.017453292519943295;
float gmSmooth(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
// Disk light the tidal debris has not taken over (mergerTides.js), per
// initial-radius bin, piecewise linear in R between bin centres.
float gmKeep(float R) {
    float rk = R / 1000.0;
    ${KEEP_GLSL()}
}
float gmArm(float R, float betaDeg) {
    if (R < 1500.0 || R > ${MW.rDiskMax.toFixed(1)}) return 0.0;
    float Rkpc = R / 1000.0;
    float lnR = log(Rkpc);
    float wScale = (0.33 + 0.036 * (Rkpc - 8.15)) / 0.33;
    float best = 0.0;
    for (int i = 0; i < 5; i++) {
        bool inner = Rkpc < uArmRk[i];
        float tanPsi = inner ? uArmTanIn[i] : uArmTanOut[i];
        float sinPsi = inner ? uArmSinIn[i] : uArmSinOut[i];
        float armBeta = uArmBetaK[i] - (lnR - log(uArmRk[i])) / tanPsi / DEG;
        float d = betaDeg - armBeta;
        d = mod(d + 180.0, 360.0) - 180.0;
        float dPerp = abs(d * DEG) * R * sinPsi;
        float w = uArmW[i] * wScale;
        float bb = mod(armBeta - uArmBMin[i], 360.0) + uArmBMin[i];
        float over = (bb <= uArmBMax[i]) ? 0.0 : min(abs(bb - uArmBMax[i]), abs(bb - 360.0 - uArmBMin[i]));
        float rangeW = 0.35 + 0.65 * exp(-(over * over) / 7200.0);
        best = max(best, exp(-(dPerp * dPerp) / (2.0 * w * w)) * rangeW);
    }
    return best;
}
// (young, old) faint-light fractions at absolute magnitude M.
vec2 gmFaint(float M) {
    float x = clamp(M + 8.0, 0.0, 20.0);
    int i = int(floor(x));
    int j = min(i + 1, 20);
    float f = x - float(i);
    vec2 a = vec2(0.0), b = vec2(0.0);
    for (int k = 0; k < 21; k++) {
        if (k == i) a = vec2(uFaintY[k], uFaintO[k]);
        if (k == j) b = vec2(uFaintY[k], uFaintO[k]);
    }
    return mix(a, b, f);
}
// avMag: V extinction between the camera and the sample (observed-magnitude
// partition, see unresolvedFraction).
vec2 gmUnresolved(float sPc, float avMag) {
    return gmFaint(uMagLimit - 5.0 * log(max(sPc, 1e-3) / 10.0) / log(10.0) - avMag);
}
// Returns luminosity densities: x = young, y = old (thin+thick+halo), z = bar;
// w = dust opacity (V, per pc).
float gmHash(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}
float gmNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = gmHash(i), n100 = gmHash(i + vec3(1, 0, 0)), n010 = gmHash(i + vec3(0, 1, 0)), n110 = gmHash(i + vec3(1, 1, 0));
    float n001 = gmHash(i + vec3(0, 0, 1)), n101 = gmHash(i + vec3(1, 0, 1)), n011 = gmHash(i + vec3(0, 1, 1)), n111 = gmHash(i + vec3(1, 1, 1));
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z) * 2.0 - 1.0;
}
uniform float uClumpDust, uClumpYoung;
vec4 gmSample(vec3 p) {
    float R = length(p.xy);
    float beta = atan(p.y, p.x) / DEG - uSpiral / DEG;
    // Pattern-frame coordinates (structures co-rotate with the spiral).
    float cs = cos(uSpiral), sn = sin(uSpiral);
    vec3 q = vec3(p.x * cs + p.y * sn, -p.x * sn + p.y * cs, p.z);
    vec3 qd = q * vec3(1.0, 1.0, 2.5);
    float nD = 0.6 * gmNoise(qd / 420.0) + 0.55 * gmNoise(qd / 130.0 + 17.0) + 0.32 * gmNoise(qd / 45.0 + 41.0) + 0.2 * gmNoise(qd / 15.0 + 73.0);
    // Log-normal with unit mean (value-noise sum variance ~0.19).
    float dustClump = exp(uClumpDust * nD - 0.5 * uClumpDust * uClumpDust * 0.14);
    float nY = gmNoise(q / 260.0 + 7.0) + 0.5 * gmNoise(q / 90.0 + 3.0);
    float youngClump = exp(uClumpYoung * nY - 0.5 * uClumpYoung * uClumpYoung * 0.16);
    float arm = gmArm(R, beta);
    float hole = gmSmooth(${MW.diskHoleIn.toFixed(1)}, ${MW.diskHoleOut.toFixed(1)}, R);
    float az = abs(p.z);
    float radial = exp(-(R - R0) / ${MW.hrThin.toFixed(1)});
    float keep = uKeep * gmKeep(R);
    float young = hole * uJ0 * uFYoung * radial * exp(-az / ${MW.hzYoung.toFixed(1)}) * (0.15 + ${MW.armAmpYoung.toFixed(3)} * arm) * uYoungNorm * uSfr * keep * youngClump;
    float thin = hole * uJ0 * uFThin * radial * exp(-az / ${MW.hzThin.toFixed(1)}) * (1.0 + ${MW.armAmpOld.toFixed(3)} * arm) * keep;
    float thick = (0.3 + 0.7 * hole) * uJ0 * uFThick * exp(-(R - R0) / ${MW.hrThick.toFixed(1)}) * exp(-az / ${MW.hzThick.toFixed(1)}) * keep;
    float rEff = length(vec2(R, p.z / ${MW.haloQ.toFixed(3)}));
    float halo = uJ0 * uFHalo * pow(R0 / max(rEff, 300.0), ${MW.haloN.toFixed(3)});
    float cb = cos(uBar), sb = sin(uBar);
    vec3 bq = vec3((p.x * cb + p.y * sb) / uBarAxes.x, (-p.x * sb + p.y * cb) / uBarAxes.y, p.z / uBarAxes.z);
    float bar = uBarNorm * exp(-length(bq));
    float dSun = length(p - uSun);
    float kappa = uKappaSun * exp(-(R - R0) / ${MW.hrDust.toFixed(1)}) * exp(-az / ${MW.hzDust.toFixed(1)}) *
        (${MW.armDustBase.toFixed(3)} + ${MW.armDust.toFixed(3)} * arm) / ${MW.armDustMean.toFixed(4)} * (0.25 + 0.75 * uSfr) * keep *
        gmSmooth(${(MW.dustHoleR * 0.45).toFixed(1)}, ${MW.dustHoleR.toFixed(1)}, R) * gmSmooth(${(MW.bubbleR * 0.4).toFixed(1)}, ${MW.bubbleR.toFixed(1)}, dSun) * dustClump;
    return vec4(young, thin + thick + halo, bar, kappa);
}
`;

// Uniform values for GALAXY_MODEL_GLSL (plain numbers/arrays; the renderer
// wraps them in THREE uniform objects).
export function galaxyModelUniformValues() {
    const armRk = [], tanIn = [], tanOut = [], sinIn = [], sinOut = [], betaK = [], w = [], bmin = [], bmax = [];
    for (const arm of REID_ARMS) {
        armRk.push(arm.rKinkKpc);
        tanIn.push(Math.tan(arm.pitchInner * DEG)); tanOut.push(Math.tan(arm.pitchOuter * DEG));
        sinIn.push(Math.sin(arm.pitchInner * DEG)); sinOut.push(Math.sin(arm.pitchOuter * DEG));
        betaK.push(arm.betaKinkDeg);
        w.push(arm.widthKpc * 1000);
        bmin.push(arm.betaMinDeg); bmax.push(arm.betaMaxDeg);
    }
    return {
        uArmRk: armRk, uArmTanIn: tanIn, uArmTanOut: tanOut, uArmSinIn: sinIn, uArmSinOut: sinOut,
        uArmBetaK: betaK, uArmW: w, uArmBMin: bmin, uArmBMax: bmax,
        uFaintY: FAINT_LIGHT_V_YOUNG.slice(),
        uFaintO: FAINT_LIGHT_V_OLD.slice(),
        uMagLimit: RESOLVED_MAG_LIMIT,
        uJ0: MW.jSun, uFYoung: MW.fYoung, uFThin: MW.fThin, uFThick: MW.fThick, uFHalo: MW.fHalo,
        uYoungNorm: 1 / (0.15 + MW.armAmpYoung * armProfile(MW.R0, 0)),
        uBarNorm: barNorm(),
        uBarAxes: [MW.barA, MW.barB, MW.barC],
        uKappaSun: MW.kappaSun,
        uClumpDust: MW.dustClump,
        uClumpYoung: MW.youngClump,
        uKeepR: new Array(MW_BIN_COUNT).fill(1),
    };
}
