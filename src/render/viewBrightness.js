// Unified observer-relative star photometry (WP16).
//
// Single source of truth for "how bright does a star of luminosity L look
// from camDistPc parsecs away", used identically by the Tier-0 catalog cloud
// (cosmic.js/catalogWorker.js), the Tier-1 AT-HYG stream (render/athygStars.js),
// and the Sun's far-field view (bodies.js). Brightness is always a function of
// distance from the CAMERA, never distance from the Sun — that is what removes
// the "near-Sun bubble" at galaxy zoom (the old catalog cloud baked in
// apparent magnitude computed from Sol, so it stayed bright regardless of how
// far the camera actually was). The realSky naked-eye dome is the one
// deliberate exception (a fixed-distance-shell sky has no real per-star
// distance to be observer-relative about) and instead fades out wholesale
// once the camera leaves the solar neighborhood — see skyDomeFade below.
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

// --- Sun-specific helper: the Sun observed as an ordinary L=1 Lsun star ----
export function sunObservedMag(camDistPc) {
    return observedMag(1, camDistPc);
}

// --- realSky dome fade zone -------------------------------------------------
// The fixed-shell naked-eye dome only makes sense within the solar
// neighborhood; it fades fully out over 50 -> 500 pc of camera distance from
// Sol (WP16 a1/a: the one surviving piece of the old two-mode blend).
export const SKY_DOME_FADE_START_PC = 50;
export const SKY_DOME_FADE_END_PC = 500;
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
// Consumers apply headlight beaming with pow(dopplerD, 4.0).
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
