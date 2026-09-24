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
// Relativistic observer effects (relView.js): aberration, Doppler recolour,
// and point-source beaming D^2 (see viewBrightness.js RELATIVISTIC_VIEW_GLSL).
import * as THREE from "three";
import { K, PC_KM } from "../constants.js";
import { stellarExposure, STELLAR_VISIBILITY_GLSL, STELLAR_PSF_GLSL } from "./stellarAppearance.js";
import { relUniforms } from "../relView.js";
import { tierDepthRange } from "./tierDepth.js";
import { BRIGHTNESS_CURVE, VIEW_BRIGHTNESS_GLSL, RELATIVISTIC_VIEW_GLSL } from "./viewBrightness.js";

// Pixels per radian of the current view (h / (2 tan(fov/2))), shared by every
// star material for the disk-resolve fade; main.js refreshes it per frame.
export const starViewUniforms = { uPxScale: { value: 900 } };

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
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
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
    float keep = 1.0;
#ifdef STAR_RADIUS
    float rScene = radiusKm * uKmScene;
    float rPx = rScene * uPxScale / max(dScene, rScene);
    keep = 1.0 - smoothstep(0.75, 3.0, rPx);
#endif
#ifdef STAR_HIDDEN
    keep *= 1.0 - step(0.5, hidden);
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

export function makeStarPointMaterial({ dim = 1, magPenalty = 0, hidden = false, radius = false } = {}) {
    const defines = {};
    if (hidden) defines.STAR_HIDDEN = "";
    if (radius) defines.STAR_RADIUS = "";
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
            uDepthRange: tierDepthRange,
            uFade: { value: 1 },
            uStellarExposure: stellarExposure,
            uDim: { value: dim },
            uMagPenalty: { value: magPenalty },
            uBeta: relUniforms.uBeta,
            uBoostDirView: relUniforms.uBoostDirView,
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
