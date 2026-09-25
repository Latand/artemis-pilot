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
//     V, R_V = 3.1 extinction law ratios; the Galaxy's V luminosity (M_V ~
//     -21.5, Licquia, Newman & Brinchmann 2015) and the local V surface
//     brightness (24-29 Lsun/pc^2, Flynn et al. 2006, Just et al. 2015).
//   derived: the local V luminosity density and young share from the
//     procedural population (resolvedLF.js).
//   model extrapolation / statistical: the arms beyond the maser-observed
//     azimuths, the star-forming knots, dust feathers and clumps
//     (galaxyMaps.js). Population colours are effective temperatures of
//     integrated light, not synthesized spectra.
//
// Band. Every luminosity density here is V band (Lsun,V / pc^3), like the
// point-star layers' magnitudes, so the diffuse light and the stars it
// hands over to add up in the same band; colours are unit-luminance RGB.

import { DISK, HALO, REID_ARMS, armWidth } from "./astroConstants.js";
import { R0_PC } from "./coords.js";
import { FAINT_LIGHT_V, FAINT_LIGHT_V_YOUNG, FAINT_LIGHT_V_OLD, LF_J_V_SUN, LF_YOUNG_LIGHT_SHARE } from "./resolvedLF.js";
import { TIDES, MW_BIN_COUNT, keepAtRadius } from "./mergerTides.js";
import { galaxyMaps, sampleGalaxyMapsInto, MAP_EXTENT_PC, LANE_OFFSET } from "./galaxyMaps.js";

const DEG = Math.PI / 180;
// 1 km/s/kpc in rad/s.
const KMS_KPC_RAD_S = 1 / 3.0856775814913673e16;

export const RESOLVED_MAG_LIMIT = 11;

// Fraction of a component's V light carried by stars FAINTER than
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
// Young (< 100 Myr) share of the local midplane V light, from the local star
// formation rate rather than the procedural population's share
// (LF_YOUNG_LIGHT_SHARE ~ 0.04, whose recent star formation is ~5x too low):
// Sigma_SFR ~ 2 Msun pc^-2 Gyr^-1 near the Sun (Fuchs, Jahreiss & Flynn 2009;
// Kennicutt & Evans 2012) over 100 Myr at (M/L)_V ~ 0.07 (continuous
// formation, Kroupa IMF, Starburst99) is ~2.9 Lsun/pc^2, a fifth of the local
// light over the young layer's 2 x 100 pc. Galaxy-wide the young light is
// then ~4% of L_V (SFR 1.65 Msun/yr, Licquia & Newman 2015).
const F_YOUNG = 0.2, F_THICK = 0.015, F_HALO = 0.001;
export const MW = Object.freeze({
    R0: R0_PC,
    // V luminosity density at the Sun (Lsun,V / pc^3), all components: the
    // procedural population's value (resolvedLF.js; the measured 0.053-0.056
    // is ~25% lower, see docs/universe-continuity.md).
    jSun: LF_J_V_SUN,
    // Share of that local light by component (sums to 1 at the Sun). The
    // thick disk and halo shares are light, not number, fractions: a local
    // thick/thin density ratio of ~4% (Bland-Hawthorn & Gerhard 2016) at
    // M/L_V ~ 4 against the local disk's ~1.5 (Flynn et al. 2006), and a
    // stellar halo of ~1e9 Lsun (Deason et al. 2019).
    fYoung: F_YOUNG,       // < 100 Myr, arm-concentrated (hz ~ 100 pc)
    fYoungPopulation: LF_YOUNG_LIGHT_SHARE,
    fThin: 1 - F_YOUNG - F_THICK - F_HALO,
    fThick: F_THICK,       // thick disk (hz 900 pc)
    fHalo: F_HALO,         // stellar halo
    hzYoung: 100,
    hrThin: DISK.thinHR, hzThin: DISK.thinHZ,
    hrThick: DISK.thickHR, hzThick: DISK.thickHZ,
    haloQ: HALO.q, haloN: HALO.n,
    rDiskMax: 22000,
    // The thin disk gives way to the bar inside the molecular ring (inner
    // disk deficit / "type II" profile): light tapers in over R = 1.5-3.5 kpc.
    diskHoleIn: 1500, diskHoleOut: 3500,
    // Bar / bulge (Wegg & Gerhard 2013; Wegg, Gerhard & Portail 2015): a
    // boxy/peanut bulge (triaxial exponential) inside a flat-topped long
    // bar with a sharp end at ~5 kpc and a thin vertical profile.
    barAngle0: 27 * DEG,   // major axis from the Sun-GC line toward +rotation
    barA: 700, barB: 290, barC: 260,          // bulge exponential scales (pc)
    longBarL: 4300, longBarB: 420, longBarZ: 180,
    barLum: 9e9,           // Lsun,V, bulge + long bar
    longBarFrac: 0.35,
    barPatternKmsKpc: 39,
    spiralPatternKmsKpc: 28.2,
    armAmpYoung: 3.0,      // young light contrast (astroConstants ARM_AMP_YOUNG)
    armAmpOld: 0.3,
    // Dust: V-band opacity, mean midplane value within 1 kpc of the Sun (the
    // classic ~1.8 mag/kpc for lines of sight in the plane, e.g. Spitzer
    // 1978); arms, lanes, feathers and clumps elsewhere: galaxyMaps.js.
    kappaSun: 1.8 * 0.4 * Math.LN10 / 1000,
    hzDust: 100, hrDust: 3500,
    dustHoleR: 3200,       // gas-poor bar region inside the molecular ring
    bubbleR: 110,          // Local Bubble (low-dust cavity around the Sun)
    // bar dust lanes on the leading edges (in the bar frame)
    barLaneKappa: 7, barLaneW: 110,
    // HII-region line emission (Halpha, [NII], Hbeta): its V-equivalent
    // luminosity relative to the young stars it ionizes (the Galaxy's
    // Halpha luminosity, SFR 1.7 Msun/yr and Kennicutt 1998, against the
    // young stars' V light: ~0.2-0.3). Gas, so never resolved into stars.
    hiiShare: 0.35, hzHii: 80,
    // Integrated-light effective temperatures (display colour only); the
    // stellar arms' excess light over the smooth disk is younger (formed in
    // the arms within ~1 Gyr): teffArm.
    teffYoung: 14000, teffThin: 5700, teffArm: 8500, teffThick: 5100, teffBar: 4500, teffHalo: 5000,
    // Detail below the maps' ~50 pc texels (GLSL, unit mean): dust filament
    // contrast; young clusters are galaxyModel's gdYoungClusters.
    dustClump: 2.1, youngClump: 0.65,
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

// Bar / bulge light: a triaxial exponential boxy/peanut bulge plus a
// flat-topped long bar (exp(-(x/L)^4) along its axis, exponential across and
// vertically), both in the frame rotating at the bar pattern speed.
const GAMMA_5_4 = 0.9064024770554771;
export const BAR_NORM = Object.freeze({
    bulge: MW.barLum * (1 - MW.longBarFrac) / (8 * Math.PI * MW.barA * MW.barB * MW.barC),
    long: MW.barLum * MW.longBarFrac / (2 * MW.longBarL * GAMMA_5_4 * 2 * MW.longBarB * 2 * MW.longBarZ),
});
export function barDensity(xb, yb, z) {
    const az = Math.abs(z);
    return BAR_NORM.bulge * Math.exp(-Math.hypot(xb / MW.barA, yb / MW.barB, z / MW.barC)) +
        BAR_NORM.long * Math.exp(-Math.pow(Math.abs(xb) / MW.longBarL, 4)) * Math.exp(-Math.abs(yb) / MW.longBarB) * Math.exp(-az / MW.longBarZ);
}
// Dust lanes along the bar's leading edges (the classic straight lanes of
// barred galaxies: shocks in the bar's gas flow, Athanassoula 1992), relative
// opacity in units of kappaSun, bar frame.
export function barLaneDust(xb, yb, z) {
    const ax = Math.abs(xb);
    const win = smoothstep(500, 1300, ax) * (1 - smoothstep(3600, 4600, ax));
    if (win <= 0) return 0;
    const q = (yb - Math.sign(xb) * (260 + 0.12 * ax)) / MW.barLaneW;
    return MW.barLaneKappa * win * Math.exp(-0.5 * q * q) * Math.exp(-Math.abs(z) / MW.hzDust);
}

// Pattern angles at simulation time t (seconds from the session epoch).
export function patternAngles(tSec, out = {}) {
    out.spiral = MW.spiralPatternKmsKpc * KMS_KPC_RAD_S * tSec;
    out.bar = MW.barAngle0 + MW.barPatternKmsKpc * KMS_KPC_RAD_S * tSec;
    return out;
}

// Structure-map modulations at a galactocentric point (galaxyMaps.js, in
// the spiral pattern frame); without maps (a context that has not built
// them) the smooth model: disk and dust holes, no arms.
const _mm = { young: 1, old: 1, dust: 1, hii: 0 };
export function structureAt(x, y, spiral, out = _mm) {
    const m = galaxyMaps();
    if (!m) {
        const R = Math.hypot(x, y);
        out.young = smoothstep(MW.diskHoleIn, MW.diskHoleOut, R); out.old = 1;
        out.dust = smoothstep(MW.dustHoleR * 0.45, MW.dustHoleR, R); out.hii = 0;
        return out;
    }
    const c = Math.cos(spiral), s = Math.sin(spiral);
    return sampleGalaxyMapsInto(m, x * c + y * s, -x * s + y * c, out);
}

// V luminosity density (Lsun/pc^3) by component, HII line emission, and
// dust opacity (V, per pc) at galactocentric (x, y, z) pc. `era` is
// cosmicEra.eraModulation(t) (or null), `disrupt` the merger disruption: a
// fraction 0..1 of the disk light removed everywhere, or the per-radius keep
// factors of the tidal model (mergerTides.js keepAt().mwBins), which remove
// the disk light the debris particles carry.
// (sunX, sunY, sunZ): the Sun's CURRENT galactocentric position, centre of
// the Local Bubble dust cavity (defaults to the t=0 anchor).
export function mwSample(x, y, z, angles, era, disrupt, out, sunX = MW.R0, sunY = 0, sunZ = 20.8) {
    const R = Math.hypot(x, y);
    const sfr = era ? era.blueFrac : 1;
    const keep = disrupt && disrupt.length === MW_BIN_COUNT
        ? keepAtRadius(disrupt, TIDES.mwBinEdgesKpc, R / 1000)
        : 1 - Math.max(0, Math.min(1, disrupt || 0));
    const j0 = MW.jSun;
    const m = structureAt(x, y, angles.spiral);
    const hole = smoothstep(MW.diskHoleIn, MW.diskHoleOut, R);
    const radial = Math.exp(-(R - MW.R0) / MW.hrThin);
    const az = Math.abs(z);
    const young = j0 * MW.fYoung * radial * Math.exp(-az / MW.hzYoung) * m.young * sfr;
    const thin = hole * j0 * MW.fThin * radial * Math.exp(-az / MW.hzThin) * m.old;
    const thick = (0.12 + 0.88 * hole) * j0 * MW.fThick * Math.exp(-(R - MW.R0) / MW.hrThick) * Math.exp(-az / MW.hzThick);
    const rEff = Math.hypot(R, z / MW.haloQ);
    const halo = j0 * MW.fHalo * Math.pow(MW.R0 / Math.max(rEff, 300), MW.haloN);
    const cb = Math.cos(angles.bar), sb = Math.sin(angles.bar);
    const xb = x * cb + y * sb, yb = -x * sb + y * cb;
    out.young = young * keep;
    out.thin = thin * keep;
    out.thick = thick * keep;
    out.halo = halo;
    out.bar = barDensity(xb, yb, z);
    out.hii = j0 * MW.fYoung * MW.hiiShare * radial * Math.exp(-az / MW.hzHii) * m.hii * sfr * keep;
    const dSun = Math.hypot(x - sunX, y - sunY, z - sunZ);
    const gas = 0.25 + 0.75 * sfr;
    out.kappa = MW.kappaSun * (Math.exp(-(R - MW.R0) / MW.hrDust) * Math.exp(-az / MW.hzDust) * m.dust * keep *
        smoothstep(MW.bubbleR * 0.4, MW.bubbleR, dSun) + barLaneDust(xb, yb, z)) * gas;
    out.arm = m.old - 1;
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
    let tauV = 0, young = 0, old = 0, bar = 0, hii = 0;
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
        hii += _smp.hii * att * ds;
        tauV += _smp.kappa * ds;
        s0 = s1;
        s *= ratio;
    }
    const k = 1 / (4 * Math.PI);
    out.young = young * k; out.old = old * k; out.bar = bar * k; out.hii = hii * k; out.tau = tauV;
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
// Mirrors structureAt / mwSample / unresolvedFraction above: the structure
// maps are a texture (render/galaxyVolume.js uploads the same arrays), the
// constants come from MW, so the JS reference and the shader cannot drift
// apart silently; smoke-galaxy-model.mjs checks the shared parameters. The
// shader adds only unit-mean clumping below the maps' texel size.
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
uniform float uFaintY[21], uFaintO[21];
uniform float uMagLimit;
uniform float uSpiral, uBar, uSfr, uKeep;
uniform float uKeepR[${MW_BIN_COUNT}];
uniform vec3 uSun;
uniform float uJ0, uFYoung, uFThin, uFThick, uFHalo;
uniform float uBarNorm, uLongBarNorm;
uniform float uKappaSun;
uniform sampler2D uGalMap, uLaneMap;
uniform vec4 uMapNorm;
uniform float uMapReady, uMapTexelPc;
const float R0 = ${MW.R0.toFixed(1)};
const float DEG = 0.017453292519943295;
const float MAP_HALF = ${MAP_EXTENT_PC.toFixed(1)};
float gmSmooth(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
// Disk light the tidal debris has not taken over (mergerTides.js), per
// initial-radius bin, piecewise linear in R between bin centres.
float gmKeep(float R) {
    float rk = R / 1000.0;
    ${KEEP_GLSL()}
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
// --- Detail below the structure maps' ~50 pc texels ---------------------------
// Deterministic in the pattern frame (the JS twin of the young clusters is
// resolvedField.js clusterOfCell, so resolved young stars sit in them).
float gdHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
vec3 gdHash3(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float gdNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(gdHash(i), gdHash(i + vec2(1.0, 0.0)), f.x), mix(gdHash(i + vec2(0.0, 1.0)), gdHash(i + vec2(1.0, 1.0)), f.x), f.y) * 2.0 - 1.0;
}
// Young star clusters: 3-D Gaussian blobs, one per cell of an L-pc grid in
// the plane (cell units g = q.xy / L + salt), at a random height drawn from
// the young layer (Laplace, scale height ${MW.hzYoung} pc). Brightnesses
// follow the cluster luminosity function dN/dL ~ L^-2 (Zhang & Fall 1999;
// Larsen 2002) over 3 decades, normalized to a mean of 1: most clusters are
// faint, a few carry much of the light. Each blob is widened to the
// sample's resolution (wide: footprint and ray step), conserving its light,
// so coarse sampling blurs clusters instead of aliasing them. The field has
// unit mean at every height: the plane average at z is
// (2 pi s2 / L^2) sqrt(2 pi s2) p(z).
float gdClusters3(vec3 q, float L, float salt, float sig, float wide) {
    vec2 g = q.xy / L + salt;
    vec2 c = floor(g);
    float s2 = sig * sig + wide * wide;
    float acc = 0.0;
    for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
        vec2 cc = c + vec2(float(i), float(j));
        vec3 h = gdHash3(cc);
        float u = gdHash(cc + 71.7) - 0.5;
        float zc = -${MW.hzYoung.toFixed(1)} * sign(u) * log(max(1.0 - 2.0 * abs(u), 1e-4));
        vec2 dxy = (g - cc - h.xy) * L;
        float dz = q.z - zc;
        acc += ${(1 / (1 + Math.log(1000))).toFixed(6)} / max(h.z, 1e-3) * exp(-(dot(dxy, dxy) + dz * dz) / (2.0 * s2));
    }
    float pz = exp(-abs(q.z) / ${MW.hzYoung.toFixed(1)}) / ${(2 * MW.hzYoung).toFixed(1)};
    return acc * L * L / (15.749610 * s2 * sqrt(s2) * pz);
}
// Young light at full detail: 30% smooth, 35% in star-forming complexes
// (100 pc cells, 15 pc blobs), 35% in clusters (25 pc cells, 3 pc blobs):
// (young, complexes) -- the complexes also carry the HII regions.
vec2 gdYoungClusters(vec3 q, float wide) {
    if (wide > 120.0 || abs(q.z) > 5.0 * ${MW.hzYoung.toFixed(1)}) return vec2(1.0);
    float c1 = gdClusters3(q, 100.0, 11.3, 15.0, wide);
    float c2 = wide < 40.0 ? gdClusters3(q, 25.0, 57.1, 3.0, wide) : 1.0;
    float fade = 1.0 - gmSmooth(70.0, 120.0, wide);
    return vec2(mix(1.0, 0.3 + 0.35 * c1 + 0.35 * mix(1.0, c2, 1.0 - gmSmooth(25.0, 40.0, wide)), fade), mix(1.0, c1, fade));
}
// Dust: turbulent filaments (ridged 3-D noise, flattened to the layer) from
// ~90 pc down to ~5 pc, each octave only where the resolution resolves it.
float gdDust(vec3 q, float wide) {
    float n = 0.0, w2 = 0.0;
    for (int o = 0; o < 4; o++) {
        float lam = 90.0 * pow(0.4, float(o));
        float lod = 1.0 - gmSmooth(0.35 * lam, 0.8 * lam, wide);
        if (lod <= 0.0) break;
        float r = 1.0 - abs(gmNoise(q * vec3(1.0, 1.0, 2.2) / lam + float(o) * 17.13));
        float a = lod * (1.0 - 0.15 * float(o));
        n += a * (r * r * r - 0.3);
        w2 += a * a;
    }
    return exp(uClumpDust * n - 0.5 * uClumpDust * uClumpDust * 0.045 * w2);
}
// Structure maps at pattern-frame q (pc), filtered to the footprint (pc) the
// sample stands for: (young, old, dust, hii), each normalized like
// galaxyMaps.sampleGalaxyMapsInto; smooth model until the maps exist.
vec4 gmMap(vec2 q, float R, float footPc) {
    if (uMapReady < 0.5) return vec4(gmSmooth(${MW.diskHoleIn.toFixed(1)}, ${MW.diskHoleOut.toFixed(1)}, R), 1.0, gmSmooth(${(MW.dustHoleR * 0.45).toFixed(1)}, ${MW.dustHoleR.toFixed(1)}, R), 0.0);
    vec2 uv = q / (2.0 * MAP_HALF) + 0.5;
    if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return vec4(0.0, 1.0, 0.0, 0.0);
    float lod = max(0.0, log2(max(footPc, 1.0) / uMapTexelPc));
    vec4 m = texture2DLodEXT(uGalMap, uv, lod);
    // where the footprint resolves the texels, the dust lane is drawn from
    // its interpolated arm coordinates (galaxyMaps.laneProfile): sharp at
    // any zoom, replacing the lane the texels sampled
    float fine = 1.0 - gmSmooth(0.5, 1.5, lod);
    if (fine > 0.0) {
        vec4 ln = texture2D(uLaneMap, uv);
        float w = max(ln.y, 0.01);
        float d = (ln.x + ${LANE_OFFSET.toFixed(3)} * w) / max(0.045, 0.3 * w);
        m.z += fine * (ln.z * exp(-0.5 * d * d) - ln.w);
    }
    return max(m, vec4(0.0)) / uMapNorm;
}
// Luminosity densities: x = young, y = old (thin+thick+halo), z = bar;
// w = dust opacity (V, per pc); hii: HII line emission. footPc: the pixel
// footprint (filters the maps); wide: the resolution of this sample (half
// the footprint or ~a third of the ray step, whichever is coarser), which
// widens and fades the detail below the maps' texel.
vec4 gmSample(vec3 p, float footPc, float wide, out float hii, out float armExcess) {
    float R = length(p.xy);
    // pattern-frame coordinates (structures co-rotate with the spiral)
    float cs = cos(uSpiral), sn = sin(uSpiral);
    vec3 q = vec3(p.x * cs + p.y * sn, -p.x * sn + p.y * cs, p.z);
    vec4 mp = gmMap(q.xy, R, footPc);
    // Detail below the maps' texels, each octave faded in only where the
    // footprint resolves it and unit-mean, so a distant view is the same
    // picture with less detail (galaxyDetail below): hierarchical star
    // clusters for the young light, filamentary dust.
    float youngC = 1.0, hiiC = 1.0, dustC = 1.0;
    if (wide < 120.0 && abs(p.z) < 700.0) {
        vec2 yc = gdYoungClusters(q, wide);
        youngC = yc.x; hiiC = yc.y;
        dustC = gdDust(q, wide);
    }
    float hole = gmSmooth(${MW.diskHoleIn.toFixed(1)}, ${MW.diskHoleOut.toFixed(1)}, R);
    float az = abs(p.z);
    float radial = exp(-(R - R0) / ${MW.hrThin.toFixed(1)});
    float keep = uKeep * gmKeep(R);
    float young = uJ0 * uFYoung * radial * exp(-az / ${MW.hzYoung.toFixed(1)}) * mp.x * uSfr * keep * youngC;
    float thin = hole * uJ0 * uFThin * radial * exp(-az / ${MW.hzThin.toFixed(1)}) * mp.y * keep;
    float thick = (0.12 + 0.88 * hole) * uJ0 * uFThick * exp(-(R - R0) / ${MW.hrThick.toFixed(1)}) * exp(-az / ${MW.hzThick.toFixed(1)}) * keep;
    float rEff = length(vec2(R, p.z / ${MW.haloQ.toFixed(3)}));
    float halo = uJ0 * uFHalo * pow(R0 / max(rEff, 300.0), ${MW.haloN.toFixed(3)});
    // bar: boxy/peanut bulge + flat-topped long bar, in the bar frame
    float cb = cos(uBar), sb = sin(uBar);
    float xb = p.x * cb + p.y * sb, yb = -p.x * sb + p.y * cb;
    float bar = uBarNorm * exp(-length(vec3(xb / ${MW.barA.toFixed(1)}, yb / ${MW.barB.toFixed(1)}, p.z / ${MW.barC.toFixed(1)})))
        + uLongBarNorm * exp(-pow(abs(xb) / ${MW.longBarL.toFixed(1)}, 4.0)) * exp(-abs(yb) / ${MW.longBarB.toFixed(1)}) * exp(-az / ${MW.longBarZ.toFixed(1)});
    float gas = 0.25 + 0.75 * uSfr;
    float dSun = length(p - uSun);
    float kappa = exp(-(R - R0) / ${MW.hrDust.toFixed(1)}) * exp(-az / ${MW.hzDust.toFixed(1)}) * mp.z * keep * gmSmooth(${(MW.bubbleR * 0.4).toFixed(1)}, ${MW.bubbleR.toFixed(1)}, dSun);
    // dust lanes on the bar's leading edges
    float axb = abs(xb);
    float win = gmSmooth(500.0, 1300.0, axb) * (1.0 - gmSmooth(3600.0, 4600.0, axb));
    float ql = (yb - sign(xb) * (260.0 + 0.12 * axb)) / ${MW.barLaneW.toFixed(1)};
    kappa += ${MW.barLaneKappa.toFixed(3)} * win * exp(-0.5 * ql * ql) * exp(-az / ${MW.hzDust.toFixed(1)});
    kappa *= uKappaSun * gas * dustC;
    hii = uJ0 * uFYoung * ${MW.hiiShare.toFixed(4)} * radial * exp(-az / ${MW.hzHii.toFixed(1)}) * mp.w * uSfr * keep * hiiC;
    // light of the stellar arms above the smooth disk: formed in the arms
    // within the last ~Gyr (A stars and intermediate ages), so bluer
    armExcess = thin * max(0.0, 1.0 - 1.0 / max(mp.y, 1e-3));
    return vec4(young, thin + thick + halo, bar, kappa);
}
`;

// Uniform values for GALAXY_MODEL_GLSL (plain numbers/arrays; the renderer
// wraps them in THREE uniform objects and supplies uGalMap/uMapNorm).
export function galaxyModelUniformValues() {
    return {
        uFaintY: FAINT_LIGHT_V_YOUNG.slice(),
        uFaintO: FAINT_LIGHT_V_OLD.slice(),
        uMagLimit: RESOLVED_MAG_LIMIT,
        uJ0: MW.jSun, uFYoung: MW.fYoung, uFThin: MW.fThin, uFThick: MW.fThick, uFHalo: MW.fHalo,
        uBarNorm: BAR_NORM.bulge,
        uLongBarNorm: BAR_NORM.long,
        uKappaSun: MW.kappaSun,
        uClumpDust: MW.dustClump,
        uClumpYoung: MW.youngClump,
        uKeepR: new Array(MW_BIN_COUNT).fill(1),
        uMapReady: 0,
        uMapTexelPc: 2 * MAP_EXTENT_PC / 1024,
    };
}
