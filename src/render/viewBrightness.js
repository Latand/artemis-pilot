// Unified observer-relative star photometry (WP16).
//
// Single source of truth for "how bright does a star of luminosity L look
// from camDistPc parsecs away", used identically by every resolved-star
// layer through the shared point material (render/starPointMaterial.js): the
// HYG catalog and curated destinations (render/catalogStars.js), the Tier-1
// AT-HYG stream (render/athygStars.js), the active stars (stars.js) and the
// Sun (bodies.js). Brightness is always a function of distance from the
// CAMERA, never distance from the Sun — that is what removes the "near-Sun
// bubble" at galaxy zoom. Point magnitudes are V band (absMagVFromL converts a
// bolometric luminosity through BC_V(Teff)). The camera-attached
// constellation guides are the one Sol-perspective element and fade out as
// soon as parallax breaks them — see skyDomeFade below.
//
// The GLSL chunk at the bottom mirrors the JS functions above it verbatim
// (same formulas, same constants) so every point shader that pastes it in is
// provably using the identical model instead of a hand-copied approximation.

// IAU-nominal solar absolute bolometric magnitude (zero point tying L=1 Lsun
// to an absolute magnitude). Using the true Sun's Teff at that same L=1 point
// keeps the "Sun as an ordinary star" acceptance (WP16 a2) exact.
export const SUN_ABS_MAG = 4.74;
export const SUN_TEFF_K = 5772;

export function absMagFromL(L) {
    return SUN_ABS_MAG - 2.5 * Math.log10(Math.max(L, 1e-12));
}
export function lFromAbsMag(absMag) {
    return Math.pow(10, -0.4 * (absMag - SUN_ABS_MAG));
}
export function absMagFromApparent(mag, distPc) {
    return mag - 5 * Math.log10(Math.max(distPc, 1e-6) / 10);
}
export function apparentMagAt(absMag, distPc) {
    return absMag + 5 * Math.log10(Math.max(distPc, 1e-6) / 10);
}
// The one formula every layer funnels through: what a star of luminosity L
// (solar units) looks like from camDistPc parsecs away, observer-relative.
export function observedMag(L, camDistPc) {
    return apparentMagAt(absMagFromL(L), camDistPc);
}
// Same, but starting from a precomputed absolute magnitude (skips the L step
// — used by layers that store absMag directly, e.g. the GPU attribute paths).
export function observedMagFromAbsMag(absMag, camDistPc) {
    return apparentMagAt(absMag, camDistPc);
}

// Shared magnitude -> size/alpha/HDR curve. Values carried over unchanged
// from the original WP9 tier-1 shader (numerics report §2) so the existing
// visual calibration survives the switch from Sol-relative to camera-relative
// distance.
export const BRIGHTNESS_CURVE = {
    basePx: 6.0,
    magRef: 4.0,
    minPx: 0.6,
    maxPx: 10.0,
    magLimit: 8.0,
};

// A separate, more contrasty curve for the in-system naked-eye sky (WP16 a3):
// constellation figures need bright stars to clearly outrank faint ones at a
// glance, which the general field curve (tuned for point-cloud density, not
// naked-eye legibility) doesn't emphasize enough. `sizeExponent` steepens the
// size falloff specifically for this curve (BRIGHTNESS_CURVE omits it and
// keeps the original 0.2 rate, so every other layer is bit-for-bit
// unchanged) -- the physically "correct" sqrt(flux) rate of 0.2 mag/dex only
// spans ~1-10px across the whole naked-eye range, too little contrast for a
// handful of on-screen pixels to read as a hierarchy. 0.34 compresses most of
// a constellation's fainter members toward minPx (a legible, roughly-uniform
// "faint field") while stretching its 1-3 brightest anchors (the stars an
// asterism's shape actually pivots on) well above them.
export const SKY_CURVE = {
    basePx: 15.0,
    magRef: -0.2,
    minPx: 1.1,
    maxPx: 19.0,
    magLimit: 6.5,
    sizeExponent: 0.3,
};

export function sizePxForMag(mag, curve = BRIGHTNESS_CURVE) {
    const size = curve.basePx * Math.pow(10, -(curve.sizeExponent ?? 0.2) * (mag - curve.magRef));
    return Math.min(curve.maxPx, Math.max(curve.minPx, size));
}
export function alphaForMag(mag, curve = BRIGHTNESS_CURVE) {
    return Math.min(1, Math.max(0, Math.pow(10, -0.4 * (mag - curve.magLimit))));
}
// Unclamped (can exceed 1 for the brightest stars) so it can feed an HDR
// bloom threshold instead of clipping at a flat white.
export function hdrIntensityForMag(mag, curve = BRIGHTNESS_CURVE) {
    return Math.pow(10, -0.4 * (mag - curve.magLimit));
}

// --- Bolometric -> V -------------------------------------------------------
// Catalog layers carry V-band absolute magnitudes; the procedural population
// and the Sun's evolution model carry bolometric luminosities. Every layer
// renders V-band magnitudes, so bolometric values pass through BC_V(Teff):
// Torres (2010, AJ 140, 1158) polynomial fit to Flower (1996), with the
// solar zero point M_bol,sun = 4.74 (so BC_V(5772 K) = -0.07, M_V,sun = 4.81).
// Below 3,900 K the polynomial runs away (-5.0 at 3,000 K); cool dwarfs use
// a short table after Pecaut & Mamajek (2013), joined continuously at 3,900 K.
const COOL_BC = [[2500, -4.6], [2850, -3.66], [3050, -2.98], [3200, -2.52], [3400, -2.06], [3550, -1.72], [3700, -1.45], [3850, -1.24]];
export function bolometricCorrectionV(teffK) {
    const t = Math.max(2000, Math.min(50000, teffK || SUN_TEFF_K));
    if (t < 3900) {
        const hi = torresBC(3900);
        const table = COOL_BC.concat([[3900, hi]]);
        if (t <= table[0][0]) return table[0][1];
        for (let i = 1; i < table.length; i++) {
            if (t <= table[i][0]) {
                const [t0, b0] = table[i - 1], [t1, b1] = table[i];
                return b0 + (b1 - b0) * (t - t0) / (t1 - t0);
            }
        }
    }
    return torresBC(t);
}
function torresBC(teffK) {
    const lt = Math.log10(teffK);
    let bc;
    if (lt < 3.70) {
        bc = -0.190537291496456e5 + 0.155144866764412e5 * lt - 0.421278819301717e4 * lt * lt + 0.381476328422343e3 * lt * lt * lt;
    } else if (lt < 3.90) {
        bc = -0.370510203809015e5 + 0.385672629965804e5 * lt - 0.150651486316025e5 * lt * lt + 0.261724637119416e4 * lt ** 3 - 0.170623810323864e3 * lt ** 4;
    } else {
        bc = -0.118115450538963e6 + 0.137145973583929e6 * lt - 0.636233812100225e5 * lt * lt + 0.147412923562646e5 * lt ** 3 - 0.170587278406872e4 * lt ** 4 + 0.788731721804990e2 * lt ** 5;
    }
    return bc;
}
export function absMagVFromL(L, teffK) {
    return absMagFromL(L) - bolometricCorrectionV(teffK);
}

// --- Sun-specific helper: the Sun observed as an ordinary L=1 Lsun star ----
export function sunObservedMag(camDistPc) {
    return observedMag(1, camDistPc);
}

// --- Sol-perspective guide fade -------------------------------------------
// The camera-attached dome now carries only constellation figures and their
// labels (the stars themselves are real 3-D points at every scale). A figure
// drawn on a camera-centred shell is exact only at the Sun: moving D shifts a
// star at distance d by ~D/d rad, so Sirius (2.6 pc) drifts ~1 deg off its
// line by D ~ 0.05 pc. The guides therefore fade out over 0.008 -> 0.08 pc
// (1650 AU -> 0.26 ly) of camera distance from the Sun, before they visibly
// stop connecting the stars they name.
export const SKY_DOME_FADE_START_PC = 0.008;
export const SKY_DOME_FADE_END_PC = 0.08;
export function skyDomeFade(camDistFromSolPc) {
    const q = Math.max(0, Math.min(1, (camDistFromSolPc - SKY_DOME_FADE_START_PC) / (SKY_DOME_FADE_END_PC - SKY_DOME_FADE_START_PC)));
    const s = q * q * (3 - 2 * q);
    return 1 - s;
}

// --- Teff <-> color, the one shared blackbody LUT --------------------------

// Ballesteros (2012) B-V -> Teff estimator — used whenever a real tempK isn't
// available (AT-HYG tier-1 only carries mag + color index, no tempK column).
export function bvToTeff(bv) {
    const b = Number.isFinite(bv) ? Math.max(-0.4, Math.min(2.0, bv)) : 0.65;
    return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

// Blackbody (Planckian-locus) approximation — Tanner Helland's fit, good
// enough for a visual LUT (not spectroscopy). Normalized to 0..1 RGB.
export function teffToRGB(teffK, out = [1, 1, 1]) {
    const t = Math.max(1000, Math.min(40000, teffK || SUN_TEFF_K)) / 100;
    let r, g, b;
    if (t <= 66) r = 255;
    else r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661;
    else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    if (t >= 66) b = 255;
    else if (t <= 19) b = 0;
    else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    out[0] = Math.max(0, Math.min(1, r / 255));
    out[1] = Math.max(0, Math.min(1, g / 255));
    out[2] = Math.max(0, Math.min(1, b / 255));
    return out;
}

// --- shared GLSL --------------------------------------------------------
// Mirrors apparentMagAt / sizePxForMag / hdrIntensityForMag above exactly.
// Consumers supply uBasePx/uMagRef/uMinPx/uMaxPx/uMagLimit uniforms (from
// BRIGHTNESS_CURVE or SKY_CURVE) and a per-star `absMag` attribute, plus a
// uPcScene uniform (scene units per parsec) to turn the vertex-shader's
// view-space distance into parsecs.
// TRAP (review I1): the GLSL below hardcodes BRIGHTNESS_CURVE's 0.2 size
// exponent. SKY_CURVE uses sizeExponent 0.3 and is CPU-evaluated only
// (realSky bands). If a future shader ever feeds SKY_CURVE, the exponent must
// become a uniform first — otherwise sizes silently diverge from the CPU math
// that smoke:brightness validates.
export const VIEW_BRIGHTNESS_GLSL = /* glsl */`
float obmApparentMagAt(float absMag, float camDistPc) {
    return absMag + 5.0 * log(max(camDistPc, 1e-6) / 10.0) / log(10.0);
}
float obmSizePx(float mag, float basePx, float magRef, float minPx, float maxPx) {
    float size = basePx * pow(10.0, -0.2 * (mag - magRef));
    return clamp(size, minPx, maxPx);
}
float obmHdrIntensity(float mag, float magLimit) {
    return pow(10.0, -0.4 * (mag - magLimit));
}
`;

// --- relativistic star-field view (WP-J3) ----------------------------------
// Convention: mu = dot(dirToStar, boost), where dirToStar points from the
// observer toward the star and boost is the unit velocity direction.
// The JS formulas below and the GLSL formulas in RELATIVISTIC_VIEW_GLSL use the
// same expressions; smoke-relview.mjs guards both the JS behavior and the GLSL
// literal formulas.

// Apparent cos(angle-to-boost) of a star seen from a ship moving at beta.
// Forward stars (mu -> +1) stay forward; side stars bunch toward the forward
// direction. Identity at beta=0.
export function relAberrateCos(mu, beta) {
    return (mu + beta) / (1 + beta * mu);
}

// Relativistic Doppler factor D = nu_obs / nu_emit for a source at mu.
// D > 1 is blueshift ahead. Identity at beta=0.
export function relDopplerFactor(mu, beta) {
    const gamma = 1 / Math.sqrt(1 - beta * beta);
    return 1 / (gamma * (1 - beta * mu));
}

export const RELATIVISTIC_VIEW_GLSL = /* glsl */`
uniform float uBeta;
uniform vec3  uBoostDirView;      // unit, view space
// GLSL port of teffToRGB (Tanner Helland), matched to the JS LUT.
vec3 relTeffToRGB(float teffK) {
    float t = clamp(teffK, 1000.0, 40000.0) / 100.0;
    float r, g, b;
    if (t <= 66.0) r = 255.0; else r = 329.698727446 * pow(t - 60.0, -0.1332047592);
    if (t <= 66.0) g = 99.4708025861 * log(t) - 161.1195681661;
    else           g = 288.1221695283 * pow(t - 60.0, -0.0755148492);
    if (t >= 66.0) b = 255.0; else if (t <= 19.0) b = 0.0;
    else           b = 138.5177312231 * log(t - 10.0) - 305.0447927307;
    return clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
}
float relAberrateCos(float mu, float beta) { return (mu + beta) / (1.0 + beta * mu); }
float relDopplerFactor(float mu, float beta) {
    float gamma = 1.0 / sqrt(1.0 - beta * beta);
    return 1.0 / (gamma * (1.0 - beta * mu));
}
// Given the view-space vertex position of a point star, return the aberrated
// view-space position at the same radius and expose Doppler through out param.
// Identity when uBeta==0.
// Consumers apply headlight beaming to POINT sources with pow(dopplerD, 2.0):
// specific intensity I_nu/nu^3 is invariant, so bolometric surface brightness
// scales as D^4 while a point source's solid angle shrinks as D^-2 -- the
// flux of a star seen by a moving observer scales as D^2 (D^4 applies to
// extended surfaces).
vec3 relApplyView(vec3 viewPos, float teffK, out float dopplerD) {
    dopplerD = 1.0;
    if (uBeta <= 0.0) return viewPos;
    float dist = length(viewPos);
    vec3 dir = viewPos / dist;              // observer -> star, view space
    float mu = dot(dir, uBoostDirView);
    dopplerD = relDopplerFactor(mu, uBeta);
    float muP = relAberrateCos(mu, uBeta);
    // Rotate dir in the plane (dir, boost) so its cos-to-boost becomes muP.
    vec3 perp = dir - mu * uBoostDirView;
    float pl = length(perp);
    if (pl < 1e-6) return viewPos;          // exactly along the axis: unchanged
    perp /= pl;
    float sinP = sqrt(max(0.0, 1.0 - muP * muP));
    vec3 dirP = muP * uBoostDirView + sinP * perp;
    return dirP * dist;
}
`;
