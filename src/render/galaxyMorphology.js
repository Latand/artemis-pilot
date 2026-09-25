// Modeled substructure, not an observational image reconstruction. Catalog
// type, scale, axis and luminosity still come from galaxyPopulation.js.
// Angular Fourier profiles have unit mean in every annulus, including when
// high frequencies are filtered away; LOD never adds a second light source.
export function galaxySeed(id) {
    let x = (id + 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
    return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

export function needsGalaxyQuads(distanceMpc, radiusMpc, maxScaleKpc, pxScale, maxPointPx, wasQuad = false) {
    const nearest = Math.max(1e-6, distanceMpc - radiusMpc);
    const reachPx = 4.5 * maxScaleKpc * 0.001 / nearest * pxScale;
    return reachPx > Math.max(1, maxPointPx) * (wasQuad ? 0.25 : 0.4);
}

export const MORPH_VARYINGS = /* glsl */`
varying vec4 vMorph; // seed, type, resolved-detail weight, population quenching
varying vec3 vDiskFrame; // local major-axis cosine/sine, signed inclination
`;

export const MORPH_GLSL = /* glsl */`
// (1 + cos(p))^4 / its angular mean, with an analytic pixel-footprint filter.
// Four harmonics, no octave appears just because the camera starts moving.
float galRidge(float p, float footprint) {
    float f = min(footprint, 20.0);
    return 1.0 + 1.6 * cos(p) * exp(-0.5 * f * f)
        + 0.8 * cos(2.0 * p) * exp(-2.0 * f * f)
        + 0.22857143 * cos(3.0 * p) * exp(-4.5 * f * f)
        + 0.02857143 * cos(4.0 * p) * exp(-8.0 * f * f);
}
vec3 galUnitLuma(vec3 c) { return c / max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-5); }

vec3 galStructuredLight(vec2 pixel, vec4 ab, vec2 peak, vec3 color, float lane) {
    if (vMorph.z <= 0.0) {
        return color * (peak.x * exp(-length(pixel / ab.xy)) * lane
            + peak.y * exp(-length(pixel / ab.zw)) * mix(1.0, lane, 0.5));
    }
    vec2 sky = pixel / ab.xy;
    // A fixed basis in the GALAXY, not a phase attached to the screen's
    // projected major axis. Inclination carries the parity across the disk.
    vec2 p = mat2(vDiskFrame.x, vDiskFrame.y, -vDiskFrame.y, vDiskFrame.x)
        * vec2(sky.x, sky.y * (vDiskFrame.z < 0.0 ? -1.0 : 1.0));
    float r = length(p), theta = r > 1e-5 ? atan(p.y, p.x) : 0.0;
    float seed = vMorph.x * 6.283185307;
    float T = vMorph.y;
    float disk = step(0.5, T) * (1.0 - step(8.5, T));
    float irregular = step(8.5, T);
    float gate = vMorph.z * smoothstep(0.12, 0.3, abs(vDiskFrame.z));
    float envelope = smoothstep(0.2, 0.65, r) * (1.0 - smoothstep(3.2, 4.5, r));
    float arms = 2.0 + floor(vMorph.x * 2.99);
    float pitch = mix(3.5, 1.65, clamp(T / 9.0, 0.0, 1.0));
    // Radius-only winding variations preserve the angular light integral.
    // Branches and knots retain identity through zoom and observer rotation.
    float bend = 0.10 * sin(1.3 * r + seed) + 0.03 * sin(4.1 * r - seed);
    float phase = arms * (theta - pitch * log(max(r, 0.16)) + bend) + seed;
    // Derivatives of local coordinates avoid the atan branch-cut seam.
    float angular = length(fwidth(p)) / max(r, 0.16);
    float radialSlope = -pitch / max(r, 0.16) + 0.13 * cos(1.3 * r + seed) + 0.123 * cos(4.1 * r - seed);
    float fp = arms * (angular + abs(radialSlope) * fwidth(r));
    float arm = galRidge(phase, fp);
    float dust = galRidge(phase + 0.48, fp);
    float branchPhase = phase + 1.3 + 0.45 * sin(3.7 * r + seed);
    float branches = galRidge(branchPhase, fp + 1.665 * arms * fwidth(r));
    // Broad star-forming complexes, not a periodic necklace of tiny dots.
    // 5/7/11 do not match any of the 2/3/4-arm ridge harmonics, so
    // modulation redistributes the annular light without adding luminosity.
    float knots = 0.50 * cos(5.0 * theta + 2.2 * sin(1.7 * r + seed) + seed)
        * exp(-0.5 * pow(min(20.0, 5.0 * angular + 3.74 * fwidth(r)), 2.0))
        + 0.30 * cos(7.0 * theta - 2.3 * r + 1.3 * sin(4.0 * r - seed))
        * exp(-0.5 * pow(min(20.0, 7.0 * angular + 7.5 * fwidth(r)), 2.0))
        + 0.20 * cos(11.0 * theta + 3.5 * r - seed)
        * exp(-0.5 * pow(min(20.0, 11.0 * angular + 3.5 * fwidth(r)), 2.0));
    float strength = envelope * gate * (1.0 - 0.85 * vMorph.w);
    float structure = 1.0 + disk * strength * (0.57 * (arm - 1.0)
        - 0.20 * (dust - 1.0) + 0.10 * (branches - 1.0) + 0.26 * arm * knots);
    float patches = 0.24 * cos(3.0 * theta + sin(2.0 * r + seed)) * exp(-4.5 * angular * angular)
        + 0.18 * cos(7.0 * theta - 4.0 * r + seed) * exp(-0.5 * pow(min(20.0, 7.0 * angular + 4.0 * fwidth(r)), 2.0));
    structure += irregular * strength * patches;
    float young = clamp(disk * strength * (arm - 0.5) * 0.34 + irregular * strength * (patches + 0.3), 0.0, 1.0);
    vec3 diskColor = galUnitLuma(color * mix(vec3(1.0), mix(vec3(1.04, 1.0, 0.94), vec3(0.80, 0.96, 1.22), young), vMorph.z));
    vec3 coreColor = galUnitLuma(color * mix(vec3(1.0), vec3(1.08, 1.0, 0.88), vMorph.z));
    float bulgeR = length(pixel / ab.zw);
    return peak.x * exp(-r) * lane * structure * diskColor
        + peak.y * exp(-bulgeR) * mix(1.0, lane, 0.5) * coreColor;
}
`;
