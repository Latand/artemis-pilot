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
// Cost control: the integral is smooth, so it runs at a fraction of the
// viewport resolution into a half-float target and is re-rendered only when
// the camera moves/turns or the model's time-dependent state changes; a
// bilinear composite under the star layers is the only per-frame cost when
// nothing changed. Adaptive steps (log-spaced from the camera, limited by
// altitude through the disk) keep a thin disk resolved even when a ray
// crosses it steeply from outside.

import * as THREE from "three";
import { K } from "../constants.js";
import { W2G, worldKmToGalInto, getSunGalAnchor } from "../universe/coords.js";
import { GALAXY_MODEL_GLSL, galaxyModelUniformValues, patternAngles, MW, EXTINCTION_RGB } from "../universe/galaxyModel.js";
import { teffToRGB } from "./viewBrightness.js";
import { stellarExposure } from "./stellarAppearance.js";

const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const DISABLED = q.get("galaxyvol") === "0";
const RES_SCALE = Math.max(0.1, Math.min(1, Number(q.get("galres")) || 0.25));
// Radiance (Lsun pc^-2 sr^-1, model units) -> display units. Calibrated so the
// brightest Milky Way star clouds seen from the Sun sit near the brightness of
// the faint-star field and the high-latitude sky stays dark, like a moderate
// astrophotograph; every stellar layer shares the same stellarExposure.
export const GALAXY_DISPLAY_GAIN = Number(q.get("galgain")) || 0.004;

const MAX_STEPS = 200;
const RAY_FRAG = /* glsl */`
precision highp float;
${GALAXY_MODEL_GLSL}
uniform vec3 uCamGal;
uniform mat3 uRayToGal;
uniform vec2 uTanHalf;
uniform vec3 uColYoung, uColOld, uColBar;
uniform vec3 uExtRGB;
uniform float uGain;
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
        float dsLog = max(s - bnd.x, 2.0) * 0.09;
        float dsZ = 0.3 * max(az, 50.0) / max(abs(d.z), 1e-4);
        float dsCap = (az < 1500.0 && R < 22000.0) ? max(150.0, 0.04 * s) : 3000.0;
        float ds = max(min(min(dsLog, dsZ), dsCap), 2.0);
        ds = min(ds, bnd.y - s);
        float sm = s + 0.5 * ds;
        vec4 smp = gmSample(o + d * sm);
        float f = gmUnresolved(sm);
        vec3 em = (smp.x * uColYoung + smp.y * uColOld + smp.z * uColBar) * f;
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
uniform float uExposure;
uniform float uOpacity;
varying vec2 vUv;
void main() {
    vec3 c = texture2D(uTex, vUv).rgb * uExposure * uOpacity;
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
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

const state = {
    ready: false,
    rt: null,
    rayMat: null,
    compMat: null,
    rayScene: null,
    compScene: null,
    orthoCam: null,
    dirty: true,
    lastKey: new Float64Array(20),
    enabled: !DISABLED,
    opacity: 1,
    renders: 0,
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
        uExtRGB: { value: new THREE.Vector3(...EXTINCTION_RGB) },
        uGain: { value: GALAXY_DISPLAY_GAIN },
        uSpiral: { value: 0 },
        uBar: { value: MW.barAngle0 },
        uSfr: { value: 1 },
        uKeep: { value: 1 },
        uSun: { value: new THREE.Vector3(MW.R0, 0, 20.8) },
        uBarAxes: { value: new THREE.Vector3(...model.uBarAxes) },
    };
    for (const [k, v] of Object.entries(model)) {
        if (k === "uBarAxes") continue;
        uniforms[k] = { value: v };
    }
    state.rayMat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: FULL_VERT,
        fragmentShader: RAY_FRAG,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
    });
    state.compMat = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: null }, uExposure: { value: 1 }, uOpacity: { value: 1 } },
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
    state.ready = true;
}

function ensureTarget(renderer) {
    const size = renderer.getDrawingBufferSize(_size);
    const w = Math.max(64, Math.round(size.x * RES_SCALE));
    const h = Math.max(40, Math.round(size.y * RES_SCALE));
    if (!state.rt) {
        state.rt = new THREE.WebGLRenderTarget(w, h, {
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false,
            stencilBuffer: false,
        });
        state.rt.texture.name = "galaxyVolume";
        state.compMat.uniforms.uTex.value = state.rt.texture;
        state.dirty = true;
    } else if (state.rt.width !== w || state.rt.height !== h) {
        state.rt.setSize(w, h);
        state.dirty = true;
    }
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
export function updateGalaxyVolume(camera, tSec, era = null, disrupt = 0, opacity = 1) {
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
    u.uKeep.value = 1 - Math.max(0, Math.min(1, disrupt || 0));
    state.opacity = opacity;
    // Dirty check: position (relative to its distance from the GC scale),
    // orientation, pattern angle, era, aspect.
    const key = state.lastKey;
    const vals = [
        _camGal[0], _camGal[1], _camGal[2],
        M[0][0], M[0][1], M[0][2], M[1][0], M[1][1], M[1][2], M[2][0], M[2][1], M[2][2],
        _ang.spiral, _ang.bar, u.uSfr.value, u.uKeep.value, camera.aspect, tanY,
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

// Scene background hook (scene.js renderSceneTiered): re-render the low-res
// integral if needed, then composite it into the current target.
export function renderGalaxyVolume(renderer) {
    if (!state.enabled || !state.ready || state.opacity <= 0.001) return;
    ensureTarget(renderer);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    if (state.dirty) {
        renderer.setRenderTarget(state.rt);
        renderer.autoClear = true;
        renderer.render(state.rayScene, state.orthoCam);
        state.dirty = false;
        state.renders++;
    }
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = false;
    state.compMat.uniforms.uExposure.value = stellarExposure.value;
    state.compMat.uniforms.uOpacity.value = state.opacity;
    renderer.render(state.compScene, state.orthoCam);
    renderer.autoClear = prevAuto;
}

export function galaxyVolumeStats() {
    return { enabled: state.enabled, renders: state.renders, res: state.rt ? [state.rt.width, state.rt.height] : null };
}

export function setGalaxyVolumeEnabled(on) {
    state.enabled = !!on && !DISABLED;
}

export function galaxyVolumeEnabled() {
    return state.enabled;
}
