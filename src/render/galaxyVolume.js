// Volumetric rendering of the Milky Way's UNRESOLVED starlight and dust.
//
// One analytic model (src/universe/galaxyModel.js) is integrated along every
// view ray from the camera's true galactocentric position, so the same code
// draws the Milky Way band with its dust lanes from inside the disk, the
// barred spiral seen from outside, and every view in between -- no switch
// between an "inside" skybox and an "outside" sprite. Only the light of stars
// fainter than the resolved-star magnitude limit is integrated
// (unresolvedFraction), so this layer and the point-star layers add up to the
// whole population instead of double counting it.
//
// Structure. Arms, dust lanes, feathers and star-forming knots come from the
// face-on structure maps (universe/galaxyMaps.js), sampled as a mip-mapped
// texture filtered to each sample's footprint, so the Galaxy seen from
// outside is sharp where it is resolved and never aliases where it is not.
//
// Cost control: while the view changes every frame the integral is drawn
// as a draft into a half-float target sized to a pixel budget; once the view
// settles it is refined at the full device resolution, a band of rows per
// frame so the refinement never stalls a frame, and cross-faded in. Nothing
// is re-rendered while the camera and the model's time-dependent state stay
// put; a composite under the star layers is then the only per-frame cost.
// Steps are log-spaced from the camera and limited by altitude through the
// disk, so a thin disk stays resolved when a ray crosses it steeply from
// outside, and a ray from outside does not spend its budget in the empty
// halo.

import * as THREE from "three";
import { K } from "../constants.js";
import { W2G, worldKmToGalInto, getSunGalAnchor } from "../universe/coords.js";
import { GALAXY_MODEL_GLSL, galaxyModelUniformValues, patternAngles, MW, EXTINCTION_RGB, mwSample } from "../universe/galaxyModel.js";
import { MAP_EXTENT_PC } from "../universe/galaxyMaps.js";
import { teffToRGB, BRIGHTNESS_CURVE } from "./viewBrightness.js";
import { stellarExposure, extragalacticExposure, EXT_STRETCH_GLSL } from "./stellarAppearance.js";
import { renderQuality } from "../scene.js";

const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const DISABLED = q.get("galaxyvol") === "0";
// ?galres=N forces a fixed resolution scale (0.1-1); default: adaptive.
const RES_FORCED = Number(q.get("galres")) ? Math.max(0.1, Math.min(1, Number(q.get("galres")))) : 0;
// Radiance (Lsun pc^-2 sr^-1, model units) -> display units per pixel, the
// same photometry as the point stars: a faint (single-pixel) star of flux F
// (Lsun/pc^2) shows STAR_DISPLAY_PER_FLUX * F (viewBrightness.js
// BRIGHTNESS_CURVE: 10^-0.4 (m - magLimit), and F = 10^-0.4 (m - 4.83) /
// (4 pi 100 pc^2)), so extended light of radiance I shows that times the
// pixel's solid angle, 1 / pxScale^2 (device px per radian). The diffuse
// Milky Way therefore carries exactly the display flux of the stars it
// stands for, and a galaxy the flux of a star of its magnitude.
// ?galgain=N multiplies it (inspection only).
export const STAR_DISPLAY_PER_FLUX = 4 * Math.PI * 100 * Math.pow(10, 0.4 * (BRIGHTNESS_CURVE.magLimit - 4.83));
const GAIN_DEBUG = Number(q.get("galgain")) || 1;
export function galaxyDisplayGain(pxScaleDevice) {
    return GAIN_DEBUG * STAR_DISPLAY_PER_FLUX / Math.max(1, pxScaleDevice * pxScaleDevice);
}

// Ray steps grow by uStepK of the distance from the camera (drafts 0.09,
// the refined image 0.03, so the dust and clusters around a camera inside
// the disk keep their detail out to kiloparsecs); MAX_STEPS bounds the loop
// (log-spaced steps from 2 pc to 25 kpc need ~310 at 0.03).
const MAX_STEPS = 360;
const RAY_FRAG = /* glsl */`
precision highp float;
${GALAXY_MODEL_GLSL}
uniform vec3 uCamGal;
uniform mat3 uRayToGal;
uniform vec2 uTanHalf;
uniform vec3 uColYoung, uColOld, uColBar, uColHii, uColArm;
uniform vec3 uExtRGB;
uniform float uGain;
uniform float uOldFade;
uniform float uPixAngle;
uniform float uStepK;
varying vec2 vNdc;

vec2 gmBounds(vec3 o, vec3 d) {
    const float RB = 25000.0, ZB = 6000.0;
    float tin = 0.0, tout = 1e12;
    if (abs(d.z) > 1e-9) {
        float t1 = (ZB - o.z) / d.z, t2 = (-ZB - o.z) / d.z;
        tin = max(tin, min(t1, t2)); tout = min(tout, max(t1, t2));
    } else if (abs(o.z) > ZB) return vec2(0.0, -1.0);
    float a = dot(d.xy, d.xy), b = 2.0 * dot(o.xy, d.xy), c = dot(o.xy, o.xy) - RB * RB;
    if (a > 1e-12) {
        float disc = b * b - 4.0 * a * c;
        if (disc < 0.0) return vec2(0.0, -1.0);
        float sq = sqrt(disc);
        tin = max(tin, (-b - sq) / (2.0 * a)); tout = min(tout, (-b + sq) / (2.0 * a));
    } else if (c > 0.0) return vec2(0.0, -1.0);
    return vec2(max(tin, 0.0), tout);
}

void main() {
    vec3 d = normalize(uRayToGal * vec3(vNdc.x * uTanHalf.x, vNdc.y * uTanHalf.y, -1.0));
    vec3 o = uCamGal;
    vec2 bnd = gmBounds(o, d);
    if (bnd.y <= bnd.x) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float s = bnd.x;
    vec3 tau = vec3(0.0), acc = vec3(0.0);
    for (int i = 0; i < ${MAX_STEPS}; i++) {
        if (s >= bnd.y) break;
        vec3 p = o + d * s;
        float az = abs(p.z);
        float R = length(p.xy);
        // log-spaced from the camera (not from where the ray enters the
        // model, so a ray from outside starts with large steps), limited by
        // the altitude through the disk and by the disk's radial structure
        float dsLog = max(s, 2.0) * uStepK;
        float dsZ = 0.3 * max(az, 50.0) / max(abs(d.z), 1e-4);
        float dsCap = (az < 1500.0 && R < 22000.0) ? max(150.0, 0.04 * s) : 3000.0;
        float ds = max(min(min(dsLog, dsZ), dsCap), 2.0);
        ds = min(ds, bnd.y - s);
        float sm = s + 0.5 * ds;
        // the pixel footprint (filters the maps) and the resolution of this
        // sample across and along the ray (widen the detail below the maps'
        // texel)
        float foot = sm * uPixAngle;
        float hii, armX;
        vec4 smp = gmSample(o + d * sm, d, max(foot, 0.35 * ds * length(d.xy)), 0.5 * foot, 0.5 * ds, hii, armX);
        vec2 f = gmUnresolved(sm, 1.0857362 * tau.g);
        vec3 em = smp.x * uColYoung * f.x + ((smp.y - armX) * uColOld + armX * uColArm + smp.z * uColBar) * f.y * uOldFade + hii * uColHii;
        vec3 k = smp.w * uExtRGB;
        vec3 kd = k * ds;
        // Exact emission-absorption over the step: em * (1 - e^{-k ds}) / k.
        vec3 stepSum = mix(vec3(ds), (1.0 - exp(-kd)) / max(k, vec3(1e-12)), step(vec3(1e-5), kd));
        acc += exp(-tau) * em * stepSum;
        tau += kd;
        s += ds;
        if (tau.r > 12.0) break;
    }
    gl_FragColor = vec4(acc * uGain * 0.07957747154594767, 1.0);
}`;

const FULL_VERT = /* glsl */`
varying vec2 vNdc;
varying vec2 vUv;
void main() {
    vNdc = position.xy;
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */`
uniform sampler2D uTex;
uniform sampler2D uTexFull;
uniform float uMix;
uniform float uExposure;
uniform float uOpacity;
uniform float uStretch;
varying vec2 vUv;
${EXT_STRETCH_GLSL}
void main() {
    vec3 c = texture2D(uTex, vUv).rgb;
    // the refined full-resolution image fading in over the draft
    if (uMix > 0.0) c = mix(c, texture2D(uTexFull, vUv).rgb, uMix);
    c *= uExposure * uOpacity;
    // extragalactic display stretch on luminance (stellarAppearance.js)
    float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    if (uStretch > 0.0 && y > 0.0) c *= extStretch(y, uStretch) / y;
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

// Highlight meter: the draft's luminance, max-pooled into METER_W x
// METER_H blocks and log-encoded into bytes (readable everywhere).
const METER_W = 48, METER_H = 30, METER_SUB = 5;
const METER_FRAG = /* glsl */`
uniform sampler2D uSrc;
void main() {
    vec2 cell = floor(gl_FragCoord.xy);
    float m = 0.0;
    for (int j = 0; j < ${METER_SUB}; j++) for (int i = 0; i < ${METER_SUB}; i++) {
        vec2 uv = (cell + (vec2(float(i), float(j)) + 0.5) / ${METER_SUB}.0) / vec2(${METER_W}.0, ${METER_H}.0);
        m = max(m, dot(texture2D(uSrc, uv).rgb, vec3(0.2126, 0.7152, 0.0722)));
    }
    // log2 luminance over [-24, 16] in two bytes
    float x = clamp((log2(max(m, 1e-12)) + 24.0) / 40.0, 0.0, 1.0) * 255.0;
    gl_FragColor = vec4(floor(x) / 255.0, fract(x), 0.0, 1.0);
}`;

function fullScreenTriangle() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    return g;
}

function linearRgbFromTeff(teff, gain = 1) {
    const rgb = teffToRGB(teff, [1, 1, 1]);
    const c = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
    // Normalize to unit luminance so colour does not change the light budget.
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    return new THREE.Vector3(c.r, c.g, c.b).multiplyScalar(gain / Math.max(lum, 1e-6));
}

// HII-region line emission: Halpha with [NII] and Hbeta, the pink of
// emission nebulae in colour images (display colour, unit luminance).
function linearRgbHii() {
    const c = new THREE.Vector3(1.0, 0.2, 0.42);
    return c.multiplyScalar(1 / (0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z));
}

// Exposure cap from the diffuse light itself. Inside the Galaxy every layer
// shares the stellar exposure, which keeps the stars' calibration (1 at
// cosmic scale): the band seen from the Sun is faint. Seen from a vantage
// where the inner Galaxy shows through little dust (above the disk, beside
// the bulge, at the Galactic centre) its light reaches many times white at
// that exposure, and a camera would expose for it. After each draft the
// image is max-pooled (above) and read back on the next frame; the cap puts
// the METER_PCT quantile of the blocks at METER_TARGET. Above the disk
// (from METER_ALT_PC up), where the disk's glow fills the view instead of a
// band across a dark sky, it also puts their median at METER_MID, so the
// disk keeps a photographic tonal range instead of washing out into a haze.
// It only ever lowers the exposure (a faint sky keeps the stars'
// calibration) and follows in log space with a METER_TAU time constant;
// main.js applies it to the stellar exposure, so stars and diffuse light
// stay on one exposure.
const METER_TARGET = 1.0, METER_PCT = 0.99, METER_MID = 0.12, METER_ALT_PC = [350, 1200], METER_TAU = 0.5;
const meter = { rt: null, mat: null, scene: null, buf: null, lum: null, pending: false, target: 1, cap: 1, t: 0, fresh: true };

// Resolution. The draft (drawn every frame while the view changes) covers
// the Galaxy's part of the screen with ~DRAFT_BUDGET_PX pixels from outside
// and is a fixed fraction of the screen inside the disk, where every ray
// crosses it. The refined image has one sample per device pixel (half on
// mobile), drawn REFINE_ROWS_PX pixels per frame (half that inside, where a
// ray costs more) and cross-faded in over REFINE_FADE_MS once complete.
// Both budgets follow the frame time (budget.*): a GPU that takes longer
// than FRAME_SLOW_MS per frame gets smaller drafts and bands, a fast one
// larger, so neither moving nor refining stalls the frame on a slow GPU.
const DRAFT_BUDGET_PX = 0.33e6, DRAFT_INSIDE_SCALE = 0.25, REFINE_ROWS_PX = 0.3e6, REFINE_FADE_MS = 300;
const FRAME_SLOW_MS = 30, FRAME_FAST_MS = 18;
const budget = { draft: 1, refine: 1, t: 0 };
function adaptBudget(key, now, lo, hi) {
    const dt = budget.t ? now - budget.t : 16;
    if (dt > 250) return;                      // a hitch elsewhere (load, tab switch)
    if (dt > FRAME_SLOW_MS) budget[key] = Math.max(lo, budget[key] * 0.75);
    else if (dt < FRAME_FAST_MS) budget[key] = Math.min(hi, budget[key] * 1.1);
}

const state = {
    ready: false,
    rtFull: null, rtDraft: null, refineRow: 0, refineT: 0, mix: 0, lastDrawn: null, inside: true,
    rayMat: null,
    compMat: null,
    rayScene: null,
    compScene: null,
    orthoCam: null,
    dirty: true,
    lastKey: new Float64Array(40),
    enabled: !DISABLED,
    opacity: 1,
    renders: 0,
    scale: 0.25,
    maps: null, mapsWorker: null, mapFade: 0, mapT: 0,
};

function init() {
    if (state.ready) return;
    const model = galaxyModelUniformValues();
    const uniforms = {
        uCamGal: { value: new THREE.Vector3(MW.R0, 0, 20.8) },
        uRayToGal: { value: new THREE.Matrix3() },
        uTanHalf: { value: new THREE.Vector2(1, 1) },
        uColYoung: { value: linearRgbFromTeff(MW.teffYoung) },
        uColOld: { value: linearRgbFromTeff(MW.teffThin) },
        uColBar: { value: linearRgbFromTeff(MW.teffBar) },
        uColHii: { value: linearRgbHii() },
        uColArm: { value: linearRgbFromTeff(MW.teffArm) },
        uExtRGB: { value: new THREE.Vector3(...EXTINCTION_RGB) },
        uGain: { value: galaxyDisplayGain(900) },
        uSpiral: { value: 0 },
        uBar: { value: MW.barAngle0 },
        uSfr: { value: 1 },
        uKeep: { value: 1 },
        // passive fading of the old populations in deep time (galaxyEvolution.js)
        uOldFade: { value: 1 },
        uSun: { value: new THREE.Vector3(MW.R0, 0, 20.8) },
        uPixAngle: { value: 0.002 },
        uFine: { value: 1 },
        uStepK: { value: 0.09 },
        uWideK: { value: 0.3 },
        uGalMap: { value: null },
        uLaneMap: { value: null },
        uMapNorm: { value: new THREE.Vector4(1, 1, 1, 1) },
    };
    for (const [k, v] of Object.entries(model)) uniforms[k] = { value: v };
    state.rayMat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: FULL_VERT,
        fragmentShader: RAY_FRAG,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
    });
    state.compMat = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: null }, uTexFull: { value: null }, uMix: { value: 0 }, uExposure: { value: 1 }, uOpacity: { value: 1 }, uStretch: { value: 0 } },
        vertexShader: FULL_VERT,
        fragmentShader: COMPOSITE_FRAG,
        depthTest: false,
        depthWrite: false,
        blending: THREE.NoBlending,
    });
    const tri = fullScreenTriangle();
    state.rayScene = new THREE.Scene();
    const rayMesh = new THREE.Mesh(tri, state.rayMat);
    rayMesh.frustumCulled = false;
    state.rayScene.add(rayMesh);
    state.compScene = new THREE.Scene();
    const compMesh = new THREE.Mesh(tri, state.compMat);
    compMesh.frustumCulled = false;
    state.compScene.add(compMesh);
    state.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    meter.rt = new THREE.WebGLRenderTarget(METER_W, METER_H, { depthBuffer: false, stencilBuffer: false });
    meter.mat = new THREE.ShaderMaterial({ uniforms: { uSrc: { value: null } }, vertexShader: FULL_VERT, fragmentShader: METER_FRAG, depthTest: false, depthWrite: false });
    meter.scene = new THREE.Scene();
    const meterMesh = new THREE.Mesh(tri, meter.mat);
    meterMesh.frustumCulled = false;
    meter.scene.add(meterMesh);
    meter.buf = new Uint8Array(METER_W * METER_H * 4);
    meter.lum = new Float32Array(METER_W * METER_H);
    state.ready = true;
    buildMaps();
}

// The structure maps are built off the main thread (~1 s); the volume fades
// in once they exist instead of switching from a smooth galaxy to a
// structured one on screen.
function buildMaps() {
    const install = packed => {
        const top = packed.levels[0];
        const tex = new THREE.DataTexture(top.data, top.width, top.height, THREE.RGBAFormat, THREE.HalfFloatType);
        tex.mipmaps = packed.levels;
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.needsUpdate = true;
        tex.name = "galaxyStructureMaps";
        const lane = new THREE.DataTexture(packed.lane, packed.size, packed.size, THREE.RGBAFormat, THREE.HalfFloatType);
        lane.minFilter = THREE.LinearFilter;
        lane.magFilter = THREE.LinearFilter;
        lane.generateMipmaps = false;
        lane.wrapS = lane.wrapT = THREE.ClampToEdgeWrapping;
        lane.needsUpdate = true;
        lane.name = "galaxyLaneMaps";
        const u = state.rayMat.uniforms;
        u.uGalMap.value = tex;
        u.uLaneMap.value = lane;
        u.uMapNorm.value.set(packed.norm.young, packed.norm.old, packed.norm.dust, packed.norm.young);
        u.uMapReady.value = 1;
        u.uMapTexelPc.value = 2 * packed.extentPc / packed.size;
        state.maps = { ms: packed.ms ?? null, size: packed.size };
        state.mapT = typeof performance !== "undefined" ? performance.now() : 0;
        state.dirty = true;
    };
    const mainThread = () => import("../universe/galaxyMaps.js").then(m => install(m.packGalaxyMapsHalf(m.ensureGalaxyMaps())));
    try {
        const w = new Worker(new URL("../workers/galaxyMapsWorker.js", import.meta.url), { type: "module" });
        state.mapsWorker = w;
        w.onmessage = e => { install(e.data); w.terminate(); state.mapsWorker = null; };
        w.onerror = err => { console.warn("galaxy maps worker failed, building on the main thread:", err?.message || err); state.mapsWorker = null; mainThread(); };
        w.postMessage({ type: "build" });
    } catch (err) {
        mainThread();
    }
}

function makeTarget(w, h, name) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
    });
    rt.texture.name = name;
    return rt;
}
function sizeTarget(rt, w, h, name) {
    if (!rt) return makeTarget(w, h, name);
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    return rt;
}
function ensureTargets(renderer) {
    const size = renderer.getDrawingBufferSize(_size);
    const full = RES_FORCED || (renderQuality.mobile ? 0.5 : 1);
    const sc = RES_FORCED || state.scale;
    const w = Math.max(64, Math.round(size.x * full)), h = Math.max(40, Math.round(size.y * full));
    const wd = Math.max(64, Math.round(size.x * sc)), hd = Math.max(40, Math.round(size.y * sc));
    const fw = state.rtFull?.width, fh = state.rtFull?.height;
    state.rtFull = sizeTarget(state.rtFull, w, h, "galaxyVolume");
    state.rtDraft = sizeTarget(state.rtDraft, wd, hd, "galaxyVolumeDraft");
    if (fw !== w || fh !== h) { state.refineRow = 0; state.mix = 0; }
}
const _size = new THREE.Vector2();

const _camGal = [0, 0, 0];
const _m = new THREE.Matrix3();
const _rot = new THREE.Matrix4();
const _ang = {};
// scene (x, y, z) -> world (x, -z, y) -> helio-galactic (W2G) -> galactocentric
// (flip the toward-GC axis: galaxy.js +X points from the GC toward the Sun).
const SCENE_TO_GAL = (() => {
    const s2w = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
    const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let v = 0;
        for (let k = 0; k < 3; k++) v += W2G[i][k] * s2w[k][j];
        out[i][j] = (i === 0 ? -1 : 1) * v;
    }
    return out;
})();

// Per-frame: camera state + model time -> uniforms; marks the target dirty
// only when something visible changed.
export function updateGalaxyVolume(camera, tSec, era = null, disrupt = 0, opacity = 1, oldFade = 1) {
    if (!state.enabled) return;
    init();
    const u = state.rayMat.uniforms;
    // Camera galactocentric position (pc) from its absolute scene position.
    camera.updateMatrixWorld();
    const p = camera.position;
    worldKmToGalInto(p.x / K, -p.z / K, p.y / K, _camGal);
    u.uCamGal.value.set(_camGal[0], _camGal[1], _camGal[2]);
    const sun = getSunGalAnchor();
    u.uSun.value.set(sun[0], sun[1], sun[2]);
    // Camera-local ray -> galactocentric direction.
    _rot.extractRotation(camera.matrixWorld);
    const e = _rot.elements;
    const R = [[e[0], e[4], e[8]], [e[1], e[5], e[9]], [e[2], e[6], e[10]]];
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        let v = 0;
        for (let k = 0; k < 3; k++) v += SCENE_TO_GAL[i][k] * R[k][j];
        M[i][j] = v;
    }
    _m.set(M[0][0], M[0][1], M[0][2], M[1][0], M[1][1], M[1][2], M[2][0], M[2][1], M[2][2]);
    u.uRayToGal.value.copy(_m);
    const tanY = Math.tan(camera.fov * Math.PI / 360);
    u.uTanHalf.value.set(tanY * camera.aspect, tanY);
    patternAngles(tSec, _ang);
    u.uSpiral.value = _ang.spiral;
    u.uBar.value = _ang.bar;
    u.uSfr.value = era ? era.blueFrac : 1;
    // merger: per-radius keep factors from the tidal model, or (while it is
    // still computing) a uniform disruption fraction
    const kr = u.uKeepR.value;
    if (disrupt && disrupt.length === kr.length) {
        u.uKeep.value = 1;
        for (let i = 0; i < kr.length; i++) kr[i] = Math.max(0, Math.min(1, disrupt[i]));
    } else {
        u.uKeep.value = 1 - Math.max(0, Math.min(1, disrupt || 0));
        kr.fill(1);
    }
    u.uOldFade.value = Number.isFinite(oldFade) ? Math.max(0, oldFade) : 1;
    state.opacity = opacity;
    state.scale = resolutionScale(_camGal, M, tanY * camera.aspect, tanY);
    const pxScale = Math.max(1, _size.y) / (2 * tanY);
    u.uGain.value = galaxyDisplayGain(pxScale);
    updateAnchor(_camGal, M, tanY * camera.aspect, tanY, pxScale, Math.max(1, _size.x * _size.y));
    // Dirty check: position (relative to its distance from the GC scale),
    // orientation, pattern angle, era, aspect.
    const key = state.lastKey;
    const vals = [
        _camGal[0], _camGal[1], _camGal[2],
        M[0][0], M[0][1], M[0][2], M[1][0], M[1][1], M[1][2], M[2][0], M[2][1], M[2][2],
        _ang.spiral, _ang.bar, u.uSfr.value, u.uKeep.value, camera.aspect, tanY, u.uOldFade.value, ...kr,
    ];
    const camDist = Math.hypot(_camGal[0] - sun[0], _camGal[1] - sun[1], _camGal[2] - sun[2]);
    const posTol = Math.max(0.05, 0.002 * Math.min(camDist, Math.hypot(_camGal[0], _camGal[1], _camGal[2])));
    let changed = false;
    for (let i = 0; i < vals.length; i++) {
        const tol = i < 3 ? posTol : i < 12 ? 2e-4 : i < 14 ? 2e-4 : 1e-3;
        if (Math.abs(vals[i] - key[i]) > tol) { changed = true; break; }
    }
    if (changed) {
        for (let i = 0; i < vals.length; i++) key[i] = vals[i];
        state.dirty = true;
    }
}

// Draft scale from the Galaxy's screen coverage: the bounding box of the
// model (R < 25 kpc, |z| < 6 kpc) projected into the view; inside the
// stellar disk (where every ray crosses it) a fixed scale. Quantized (with
// the rounding favouring the current step) so zooming does not resize the
// targets every frame.
const SCALE_STEPS = [0.18, 0.25, 0.35, 0.5, 0.7, 1];
const _corner = [0, 0, 0];
function resolutionScale(cam, M, tanX, tanY) {
    state.inside = Math.hypot(cam[0], cam[1]) < 22000 && Math.abs(cam[2]) < 2000;
    if (state.inside) return quantizeScale(DRAFT_INSIDE_SCALE * Math.sqrt(budget.draft));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = false;
    for (let c = 0; c < 8; c++) {
        _corner[0] = (c & 1 ? 25000 : -25000) - cam[0];
        _corner[1] = (c & 2 ? 25000 : -25000) - cam[1];
        _corner[2] = (c & 4 ? 6000 : -6000) - cam[2];
        // galactocentric -> camera-local: M^T (M carries camera rays to the Galaxy)
        const vx = M[0][0] * _corner[0] + M[1][0] * _corner[1] + M[2][0] * _corner[2];
        const vy = M[0][1] * _corner[0] + M[1][1] * _corner[1] + M[2][1] * _corner[2];
        const vz = M[0][2] * _corner[0] + M[1][2] * _corner[1] + M[2][2] * _corner[2];
        if (vz > -1) { behind = true; break; }
        const nx = vx / -vz / tanX, ny = vy / -vz / tanY;
        x0 = Math.min(x0, nx); x1 = Math.max(x1, nx); y0 = Math.min(y0, ny); y1 = Math.max(y1, ny);
    }
    const cover = behind ? 1 : Math.max(0, Math.min(1, x1) - Math.max(-1, x0)) * Math.max(0, Math.min(1, y1) - Math.max(-1, y0)) / 4;
    const px = Math.max(1, _size.x * _size.y) * Math.max(cover, 1e-4);
    return quantizeScale(Math.min(1, Math.sqrt(DRAFT_BUDGET_PX * budget.draft / px)));
}
function quantizeScale(want) {
    let step = SCALE_STEPS[0];
    for (const v of SCALE_STEPS) if (v <= want * (v === state.scale ? 1.15 : 1)) step = v;
    return step;
}

// Apparent magnitude separating point stars from the diffuse light (shared
// with every point layer; render/resolvedFieldStars.js owns its value).
export function setGalaxyVolumeMagLimit(m) {
    if (!state.enabled) return;
    init();
    const u = state.rayMat.uniforms.uMagLimit;
    if (Math.abs(u.value - m) > 1e-3) { u.value = m; state.dirty = true; }
}

// Scene background hook (scene.js renderSceneTiered): re-render the integral
// if needed (a draft while the view changes every frame, then the full
// resolution band by band once it settles), then composite it into the
// current target. rows: [first, count] of a band, or the whole target.
function rayRender(renderer, rt, rows = null) {
    const u = state.rayMat.uniforms;
    u.uPixAngle.value = 2 * u.uTanHalf.value.y / rt.height;
    const draft = rt === state.rtDraft;
    u.uFine.value = draft ? 0 : 1;
    u.uStepK.value = draft ? 0.09 : 0.03;
    u.uWideK.value = draft ? 0.3 : 0.2;
    if (rows) { rt.scissor.set(0, rows[0], rt.width, rows[1]); rt.scissorTest = true; }
    renderer.setRenderTarget(rt);
    renderer.autoClear = !rows;
    renderer.render(state.rayScene, state.orthoCam);
    rt.scissorTest = false;
    state.renders++;
}
// Exposure anchor for the Galaxy seen from outside: its core's surface
// brightness (display units before exposure), averaged over the pixel
// footprint at the Galactic centre. Resolved, a surface brightness does not
// change with distance, so zooming from the whole Galaxy into one arm keeps
// the exposure (the same picture, with more detail); far away the core
// shrinks into a pixel and the anchor falls like a point source's.
// render/galaxyPopulationRender.js meters with it instead of an estimate
// from the sprite's parameters. S0: face-on central column of the model
// (Lsun/pc^2) / 4 pi, times the display gain; A: the core's area (pc^2).
const CORE_AREA_PC2 = 1.2e6;
const anchor = { s0: 0, peak: 0, cover: 0, corePx: 0, fresh: false };
function coreSurfaceBrightness() {
    if (anchor.s0) return anchor.s0;
    const smp = {}, ang = patternAngles(0, {});
    let col = 0, z0 = 0;
    for (let k = 1; k <= 400; k++) {
        const z1 = 6000 * Math.pow(k / 400, 3), zm = 0.5 * (z0 + z1);
        mwSample(0, 0, zm, ang, null, 0, smp);
        col += 2 * (smp.young + smp.thin + smp.thick + smp.halo + smp.bar) * (z1 - z0);
        z0 = z1;
    }
    anchor.s0 = col / (4 * Math.PI);
    return anchor.s0;
}
function updateAnchor(camGal, M, tanX, tanY, pxScale, screenPx) {
    const d = Math.hypot(camGal[0], camGal[1], camGal[2]);
    const foot = d / Math.max(pxScale, 1);
    anchor.peak = coreSurfaceBrightness() * galaxyDisplayGain(pxScale) * CORE_AREA_PC2 / (CORE_AREA_PC2 + foot * foot);
    anchor.corePx = CORE_AREA_PC2 / Math.max(foot * foot, 1) + 1;
    // screen coverage of the stellar disk (R < 15 kpc), projected
    const vz = M[0][2] * -camGal[0] + M[1][2] * -camGal[1] + M[2][2] * -camGal[2];
    const cosi = Math.abs(camGal[2]) / Math.max(d, 1);
    const rPx = 15000 / Math.max(d, 1) * pxScale;
    anchor.cover = vz < 0 ? Math.min(1, Math.PI * rPx * rPx * Math.max(cosi, 0.08) / Math.max(screenPx, 1)) : 0;
    anchor.fresh = vz < 0 && d > 3000;
}
// { peak, corePx, cover, fresh }: the Galaxy's exposure anchor, the pixels
// its core covers, and the fraction of the view its disk covers.
export function galaxyVolumeMeter() {
    const fresh = !!(state.enabled && state.maps && state.opacity > 0.5 && anchor.fresh && extragalacticExposure.blend > 0);
    return { peak: anchor.peak * state.opacity, corePx: anchor.corePx, cover: anchor.cover, fresh };
}
// The meter's reading of the previous draft (see METER_TARGET).
function meterRead(renderer) {
    meter.pending = false;
    renderer.readRenderTargetPixels(meter.rt, 0, 0, METER_W, METER_H, meter.buf);
    const n = METER_W * METER_H, b = meter.buf, lum = meter.lum;
    for (let i = 0; i < n; i++) lum[i] = Math.pow(2, (b[i * 4] + b[i * 4 + 1] / 255) * 40 / 255 - 24);
    lum.sort();
    const k = state.opacity * state.mapFade;
    const peak = lum[Math.min(n - 1, Math.floor(METER_PCT * n))] * k, mid = lum[n >> 1] * k;
    let target = peak > 0 ? Math.min(1, METER_TARGET / peak) : 1;
    const t = Math.min(1, Math.max(0, (Math.abs(_camGal[2]) - METER_ALT_PC[0]) / (METER_ALT_PC[1] - METER_ALT_PC[0])));
    const w = t * t * (3 - 2 * t);
    if (w > 0 && mid > METER_MID) target = Math.min(target, Math.pow(METER_MID / mid, w));
    meter.target = target;
}
function meterPool(renderer, rt) {
    meter.mat.uniforms.uSrc.value = rt.texture;
    renderer.setRenderTarget(meter.rt);
    renderer.autoClear = true;
    renderer.render(meter.scene, state.orthoCam);
    meter.pending = true;
}
// Exposure cap for the stellar exposure from the diffuse light (<= 1).
export function galaxyVolumeExposureCap() {
    return state.enabled && state.ready && state.maps && state.opacity > 0.001 ? meter.cap : 1;
}
function meterUpdate(now) {
    const dt = meter.t ? Math.min(0.5, Math.max(0, (now - meter.t) / 1000)) : 0;
    meter.t = now;
    if (meter.fresh) { meter.cap = meter.target; meter.fresh = false; return; }
    meter.cap = Math.exp(Math.log(meter.cap) + (Math.log(meter.target) - Math.log(meter.cap)) * (1 - Math.exp(-dt / METER_TAU)));
}

export function renderGalaxyVolume(renderer) {
    if (!state.enabled || !state.ready || state.opacity <= 0.001 || !state.maps) { meter.target = 1; meter.fresh = true; return; }
    renderer.getDrawingBufferSize(_size);
    ensureTargets(renderer);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const now = typeof performance !== "undefined" ? performance.now() : state.mapT + 1e4;
    const full = state.rtFull;
    if (meter.pending) meterRead(renderer);
    meterUpdate(now);
    if (state.dirty || !state.lastDrawn) {
        adaptBudget("draft", now, 0.15, 2.5);
        if (RES_FORCED) {
            rayRender(renderer, full);
            state.refineRow = full.height; state.mix = 1;
        } else {
            rayRender(renderer, state.rtDraft);
            state.refineRow = 0; state.mix = 0;
        }
        meterPool(renderer, RES_FORCED ? full : state.rtDraft);
        state.dirty = false;
        state.lastDrawn = state.rtDraft;
    } else if (state.refineRow < full.height) {
        if (state.refineRow > 0) adaptBudget("refine", now, 0.05, 4);
        const n = Math.max(8, Math.floor(REFINE_ROWS_PX * budget.refine * (state.inside ? 0.5 : 1) / full.width));
        rayRender(renderer, full, [state.refineRow, Math.min(n, full.height - state.refineRow)]);
        state.refineRow += n;
        if (state.refineRow >= full.height) state.refineT = now;
    } else if (state.mix < 1) {
        const t = Math.min(1, (now - state.refineT) / REFINE_FADE_MS);
        state.mix = t * t * (3 - 2 * t);
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = false;
    const b = extragalacticExposure.blend;
    state.compMat.uniforms.uTex.value = RES_FORCED ? full.texture : state.rtDraft.texture;
    state.compMat.uniforms.uTexFull.value = full.texture;
    state.compMat.uniforms.uMix.value = RES_FORCED ? 0 : state.mix;
    state.compMat.uniforms.uExposure.value = b > 0
        ? Math.exp(Math.log(Math.max(1e-6, stellarExposure.value)) * (1 - b) + Math.log(Math.max(1e-6, extragalacticExposure.value)) * b)
        : stellarExposure.value;
    const t = Math.min(1, Math.max(0, (now - state.mapT) / 600));
    state.mapFade = t * t * (3 - 2 * t);
    state.compMat.uniforms.uOpacity.value = state.opacity * state.mapFade;
    state.compMat.uniforms.uStretch.value = extragalacticExposure.stretch;
    renderer.render(state.compScene, state.orthoCam);
    renderer.autoClear = prevAuto;
    budget.t = now;
}

export function galaxyVolumeStats() {
    const refined = RES_FORCED || state.mix >= 1;
    const rt = refined ? state.rtFull : state.rtDraft;
    return {
        enabled: state.enabled, renders: state.renders, res: rt ? [rt.width, rt.height] : null, scale: RES_FORCED || state.scale,
        mapsReady: !!state.maps, mapsMs: state.maps?.ms ?? null, fade: state.mapFade, draft: !refined,
        anchor: { peak: anchor.peak, cover: anchor.cover, fresh: anchor.fresh },
        budget: { draft: budget.draft, refine: budget.refine }, exposureCap: meter.cap,
    };
}

export function setGalaxyVolumeEnabled(on) {
    state.enabled = !!on && !DISABLED;
}

export function galaxyVolumeEnabled() {
    return state.enabled;
}
