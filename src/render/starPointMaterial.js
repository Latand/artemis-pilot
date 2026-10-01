// One material for every RESOLVED star layer: the AT-HYG stream, the HYG
// catalog, curated destinations, the Sun, and the procedural field. Each point
// carries a V-band absolute magnitude and an effective temperature; the vertex
// shader turns them into apparent brightness from the live camera distance
// (viewBrightness.js) with one magnitude->size/intensity curve, one point-
// spread function and one exposure. A star therefore looks the same whichever
// layer happens to hold it, and brightens or fades continuously as the camera
// moves -- there is no per-layer brightness convention left to disagree.
//
// Optional per-point attributes (enabled by the options below):
//   hidden    -- 1 hides the point (a catalog row promoted to another layer)
//   radiusKm  -- photospheric radius; the point fades out as its disk
//                resolves (0.75 -> 3 px), where the photosphere mesh takes over
//   evo       -- (motion) material disk stars of the procedural field
//                (universe/resolvedField.js): (arm threshold, hand-over
//                random); the star moves on its circular orbit and shows
//                while its epoch and the arms where it is allow it
// Relativistic observer effects (relView.js): aberration, Doppler recolour,
// and point-source beaming D^2 (see viewBrightness.js RELATIVISTIC_VIEW_GLSL).
import * as THREE from "three";
import { K, PC_KM } from "../constants.js";
import { stellarExposure, STELLAR_VISIBILITY_GLSL, STELLAR_PSF_GLSL } from "./stellarAppearance.js";
import { relUniforms } from "../relView.js";
import { tierDepthRange } from "./tierDepth.js";
import { BRIGHTNESS_CURVE, VIEW_BRIGHTNESS_GLSL, RELATIVISTIC_VIEW_GLSL } from "./viewBrightness.js";
import { DYNAMICS_FN_GLSL } from "../universe/galaxyDynamics.js";
import { ARM_TRANSPORT_GLSL, ARM_LABEL_BIAS } from "../universe/armTransport.js";
import { MAP_EXTENT_PC } from "../universe/galaxyMaps.js";

// Pixels per radian of the current view (h / (2 tan(fov/2))), shared by every
// star material for the disk-resolve fade; main.js refreshes it per frame.
// uResolveLimit: apparent magnitude beyond which a star belongs to the
// volumetric Milky Way's diffuse light instead of being a point (the shared
// resolved/unresolved partition, render/resolvedFieldStars.js).
export const starViewUniforms = { uPxScale: { value: 900 }, uResolveLimit: { value: 11 } };

const VERT = /* glsl */`
attribute vec3 color;
attribute float absMag;
attribute float teffK;
#ifdef STAR_HIDDEN
attribute float hidden;
#endif
#ifdef STAR_RADIUS
attribute float radiusKm;
#endif
#ifdef STAR_RESOLVE_LIMIT
uniform float uResolveLimit;
#endif
#ifdef STAR_MOTION
// Disk stars of one material epoch (galaxyDynamics.js). position: the
// star's epoch-frame position (pc) at the epoch's centre minus uRefE; the
// mesh's matrix turns the frame by the orbital angle at |uRefE|, so each
// star adds its own differential rotation (Omega(R) - uOmRef) uTau, and an
// old thin-disk star (evo.x < -1: its label offset, ARM_LABEL_BIAS - dc) its
// crowding in the arms (armTransport.js). Young stars (evo.x > 0: their arm threshold) show
// while the arms where they are now are bright enough: born in the arms,
// gone as they leave them.
attribute vec2 evo;
uniform vec3 uRefE;
uniform float uOmRef, uTau, uEpW, uMapReady, uArmReady;
uniform vec4 uGenC, uGenWv, uMapNorm;
uniform sampler2D uGalMap;
${DYNAMICS_FN_GLSL}
${ARM_TRANSPORT_GLSL}
// structure maps at base-map position b: (young, old) modulation
vec2 smMap(vec2 b) {
    vec2 uv = b / ${(2 * MAP_EXTENT_PC).toFixed(1)} + 0.5;
    if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return vec2(0.0, 1.0);
    vec4 m = textureLod(uGalMap, uv, 0.0);
    return max(m.xy, vec2(0.0)) / uMapNorm.xy;
}
vec3 starMotion(vec3 d, out float vis) {
    vec3 q = uRefE + d;
    float R = length(q.xy), om = dynOmega(R);
    // the epoch hands its stars over one by one
    vis = smoothstep(evo.y * 0.92, evo.y * 0.92 + 0.08, uEpW);
    float delta = (om - uOmRef) * uTau;
    if (evo.x < -1.0 && uArmReady > 0.5 && vis > 0.0) delta += armDelta(q.xy, R, om, ${ARM_LABEL_BIAS.toFixed(1)} - evo.x);
    float sd = sin(delta), h = sin(0.5 * delta), cm1 = -2.0 * h * h;
    vec2 rd = d.xy + vec2(cm1 * d.x - sd * d.y, sd * d.x + cm1 * d.y);
    vec2 rr = vec2(cm1 * uRefE.x - sd * uRefE.y, sd * uRefE.x + cm1 * uRefE.y);
    if (evo.x > 0.0 && uMapReady > 0.5 && vis > 0.0) {
        // the gas arms' modulation where the star is now (both generations)
        float wind = dynWind(om);
        float y = uGenWv.z * smMap(dynRot(q.xy, uGenC.x + om * uTau - wind * uGenC.y)).x;
        if (uGenWv.w > 0.0) y += uGenWv.w * smMap(dynRot(q.xy, uGenC.z + om * uTau - wind * uGenC.w)).x;
        vis *= smoothstep(evo.x * 0.96, evo.x * 1.04, y);
    }
    return vec3(rd + rr, d.z);
}
#endif
varying vec3 vColor;
varying float vHdr;
uniform float uBasePx, uMagRef, uMinPx, uMaxPx, uMagLimit, uPcScene, uMagPenalty;
uniform float uPxScale, uKmScene;
uniform float uStellarExposure;
uniform vec2 uDepthRange;
${VIEW_BRIGHTNESS_GLSL}
${STELLAR_VISIBILITY_GLSL}
${RELATIVISTIC_VIEW_GLSL}
void main() {
    float keep = 1.0;
#ifdef STAR_MOTION
    float motionVis;
    vec4 mvPosition = modelViewMatrix * vec4(starMotion(position, motionVis), 1.0);
    keep = motionVis;
#else
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
#endif
    // Depth-tier fence (scene.js tierDepthRange): drawn in exactly one pass.
    float viewDepth = -mvPosition.z;
    if (viewDepth < uDepthRange.x || viewDepth >= uDepthRange.y) {
        vColor = vec3(0.0); vHdr = 0.0; gl_PointSize = 0.0;
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
    }
    float dopplerD;
    vec3 abPos = relApplyView(mvPosition.xyz, teffK, dopplerD);
    vColor = color;
    if (uBeta > 0.0) {
        vec3 rgb = relTeffToRGB(teffK * dopplerD);
        vColor = mix(rgb / 12.92, pow((rgb + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), rgb));
    }
    float dScene = length(abPos);
    float mag = obmApparentMagAt(absMag + uMagPenalty, dScene / uPcScene);
    float flux = obmHdrIntensity(mag, uMagLimit) * dopplerD * dopplerD;
#ifdef STAR_RADIUS
    float rScene = radiusKm * uKmScene;
    float rPx = rScene * uPxScale / max(dScene, rScene);
    keep *= 1.0 - smoothstep(0.75, 3.0, rPx);
#endif
#ifdef STAR_HIDDEN
    keep *= 1.0 - step(0.5, hidden);
#endif
#ifdef STAR_RESOLVE_LIMIT
    // Fainter than the resolve limit: carried by the diffuse Milky Way light.
    keep *= 1.0 - smoothstep(uResolveLimit, uResolveLimit + 0.4, mag - uMagPenalty);
#endif
    vHdr = stellarDisplayFlux(flux, uStellarExposure) * keep;
    gl_PointSize = keep > 0.0 ? obmSizePx(mag, uBasePx, uMagRef, uMinPx, uMaxPx) : 0.0;
    gl_Position = projectionMatrix * vec4(abPos, 1.0);
    // Sub-display flux is rejected before rasterization; the catalog row and
    // its photometry are untouched.
    if (vHdr * uStellarExposure < 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */`
varying vec3 vColor;
varying float vHdr;
uniform float uFade;
uniform float uDim;
${STELLAR_PSF_GLSL}
void main() {
    float g = stellarPSF(gl_PointCoord);
    if (g < 0.001) discard;
    gl_FragColor = vec4(vColor * min(vHdr, 16.0) * uStellarExposure, g * uFade * uDim);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

// motion: the moving disk stars of the procedural field; `uniforms` adds or
// shares uniform objects (their per-epoch and per-mesh state).
export function makeStarPointMaterial({ dim = 1, magPenalty = 0, hidden = false, radius = false, resolveLimit = true, motion = false, uniforms = null } = {}) {
    const defines = {};
    if (hidden) defines.STAR_HIDDEN = "";
    if (radius) defines.STAR_RADIUS = "";
    if (resolveLimit) defines.STAR_RESOLVE_LIMIT = "";
    if (motion) defines.STAR_MOTION = "";
    const mat = new THREE.ShaderMaterial({
        defines,
        uniforms: {
            uBasePx: { value: BRIGHTNESS_CURVE.basePx },
            uMagRef: { value: BRIGHTNESS_CURVE.magRef },
            uMinPx: { value: BRIGHTNESS_CURVE.minPx },
            uMaxPx: { value: BRIGHTNESS_CURVE.maxPx },
            uMagLimit: { value: BRIGHTNESS_CURVE.magLimit },
            uPcScene: { value: PC_KM * K },
            uKmScene: { value: K },
            uPxScale: starViewUniforms.uPxScale,
            uResolveLimit: starViewUniforms.uResolveLimit,
            uDepthRange: tierDepthRange,
            uFade: { value: 1 },
            uStellarExposure: stellarExposure,
            uDim: { value: dim },
            uMagPenalty: { value: magPenalty },
            uBeta: relUniforms.uBeta,
            uBoostDirView: relUniforms.uBoostDirView,
            ...(uniforms || {}),
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    });
    return mat;
}

// CPU mirror of the shader's visibility for one star (labels, pick targets):
// 0..1 point alpha after exposure, zero once its disk is resolved.
export function starPointAlpha(absMag, distScene, radiusKm = 0, exposure = stellarExposure.value, pxScale = starViewUniforms.uPxScale.value) {
    const mag = absMag + 5 * Math.log10(Math.max(distScene / (PC_KM * K), 1e-6) / 10);
    const flux = Math.pow(10, -0.4 * (mag - BRIGHTNESS_CURVE.magLimit));
    const f = flux * exposure;
    const vis = f * smooth(0.02, 0.12, f);
    let keep = 1;
    if (radiusKm > 0) {
        const r = radiusKm * K;
        keep = 1 - smooth(0.75, 3, r * pxScale / Math.max(distScene, r));
    }
    return Math.min(1, vis) * keep;
}
function smooth(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}
