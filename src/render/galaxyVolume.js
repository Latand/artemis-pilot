// Volumetric rendering of the Milky Way's UNRESOLVED starlight and dust.
// Rays use the actual galactocentric observer and one shared galaxy model.
// Point stars and this diffuse component partition the same luminosity.
// Completed angular radiance is reused only at the same observer/model;
// translated views are integrated afresh, never reprojected at a fake depth.

import * as THREE from "three";
import { K } from "../constants.js";
import { W2G, worldKmToGalInto, getSunGalAnchor } from "../universe/coords.js";
import { GALAXY_MODEL_GLSL, galaxyModelUniformValues, patternAngles, MW, EXTINCTION_RGB, mwSample } from "../universe/galaxyModel.js";
import previewData from "virtual:galaxy-preview";
import { canReuseGalaxyHistory, targetSizeChanged } from "./galaxyViewCache.js";
import { teffToRGB, BRIGHTNESS_CURVE } from "./viewBrightness.js";
import { stellarExposure, extragalacticExposure, EXT_STRETCH_GLSL } from "./stellarAppearance.js";
import { renderQuality } from "../scene.js";

const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
const DISABLED = q.get("galaxyvol") === "0";
const RES_FORCED = Number(q.get("galres")) ? Math.max(0.1, Math.min(1, Number(q.get("galres")))) : 0;
// Radiance -> display flux per pixel, calibrated to the point-star layers.
// Pixel solid angle is 1 / pxScaleDevice^2. Do not meter against a draft's
// resolution: changing quality must not change the represented light.
export const STAR_DISPLAY_PER_FLUX = 4 * Math.PI * 100 * Math.pow(10, 0.4 * (BRIGHTNESS_CURVE.magLimit - 4.83));
const GAIN_DEBUG = Number(q.get("galgain")) || 1;
const fixedExposure = Number(q.get('galexposure'));
const FIXED_EXPOSURE = Number.isFinite(fixedExposure) && fixedExposure > 0 ? fixedExposure : null;
export function galaxyDisplayGain(pxScaleDevice) {
    return GAIN_DEBUG * STAR_DISPLAY_PER_FLUX / Math.max(1, pxScaleDevice * pxScaleDevice);
}

const MAX_STEPS = 360;
// The moving view was integration-limited in matched output/step ablations:
// more output pixels alone did not recover the missing dust contrast. Use a
// bounded intermediate step inside the disk; keep output buffers unchanged.
const DRAFT_STEP_K = 0.04, SETTLED_STEP_K = 0.03;
// Exact angular reprojection, not a single-depth reprojection of a volume.
// Mips remove unresolved history frequencies; edge weights reject uncovered rays.
const HISTORY_GLSL = /* glsl */`
uniform sampler2D uHistory;
uniform mat3 uToHistory;
uniform vec2 uHistoryTan, uHistoryOffset, uHistorySize;
uniform float uHistoryValid, uHistoryGain;
vec3 historyRay(vec3 ray, out vec2 uv, out float weight) {
    vec3 h = uToHistory * ray;
    uv = ((h.xy / max(-h.z, 1e-12) - uHistoryOffset) / uHistoryTan) * 0.5 + 0.5;
    vec2 edge = min(uv, 1.0 - uv);
    vec2 guard = max(2.0 / uHistorySize, 2.0 * fwidth(uv));
    weight = uHistoryValid * step(h.z, -1e-6) * smoothstep(0.0, 1.0, min(edge.x / guard.x, edge.y / guard.y));
    return texture2D(uHistory, clamp(uv, 0.0, 1.0)).rgb * uHistoryGain;
}
`;
const RAY_FRAG = /* glsl */`
precision highp float;
${GALAXY_MODEL_GLSL}
uniform vec3 uCamGal;
uniform mat3 uRayToGal;
uniform vec2 uTanHalf, uRayOffset;
${HISTORY_GLSL}
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
    vec3 d = normalize(uRayToGal * vec3(vNdc * uTanHalf + uRayOffset, -1.0));
    vec2 hu; float hw;
    vec3 hc = historyRay(d, hu, hw);
    // Full refinements always integrate fresh rays, avoiding accumulated blur.
    if (hw >= 0.99999) { gl_FragColor = vec4(hc, 1.0); return; }
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
        // Log steps from the observer, capped by altitude through the disk.
        float dsLog = max(s, 2.0) * uStepK;
        float dsZ = 0.3 * max(az, 50.0) / max(abs(d.z), 1e-4);
        float dsCap = (az < 1500.0 && R < 22000.0) ? max(150.0, 0.04 * s) : 3000.0;
        float ds = max(min(min(dsLog, dsZ), dsCap), 2.0);
        ds = min(ds, bnd.y - s);
        float sm = s + 0.5 * ds;
        float foot = sm * uPixAngle;
        float hii, armX;
        vec4 smp = gmSample(o + d * sm, d, max(foot, 0.35 * ds * length(d.xy)), 0.5 * foot, 0.5 * ds, hii, armX);
        vec2 f = gmUnresolved(sm, 1.0857362 * tau.g);
        vec3 em = smp.x * uColYoung * f.x + ((smp.y - armX) * uColOld + armX * uColArm + smp.z * uColBar) * f.y * uOldFade + hii * uColHii;
        vec3 k = smp.w * uExtRGB;
        vec3 kd = k * ds;
        // Exact emission-absorption over each integration step.
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
uniform mat3 uRayToGal;
uniform vec2 uTanHalf, uRayOffset;
${HISTORY_GLSL}
${EXT_STRETCH_GLSL}
void main() {
    vec3 c = texture2D(uTex, vUv).rgb;
    vec2 hu; float hw;
    vec3 ray = normalize(uRayToGal * vec3((vUv * 2.0 - 1.0) * uTanHalf + uRayOffset, -1.0));
    vec3 hc = historyRay(ray, hu, hw);
    c = mix(c, hc, hw);
    if (uMix > 0.0) c = mix(c, texture2D(uTexFull, vUv).rgb, uMix);
    c *= uExposure * uOpacity;
    float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
    if (uStretch > 0.0 && y > 0.0) c *= extStretch(y, uStretch) / y;
    gl_FragColor = vec4(c, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

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
    // Log2 luminance over [-24, 16] encoded in two bytes.
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
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    return new THREE.Vector3(c.r, c.g, c.b).multiplyScalar(gain / Math.max(lum, 1e-6));
}
function linearRgbHii() {
    const c = new THREE.Vector3(1.0, 0.2, 0.42);
    return c.multiplyScalar(1 / (0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z));
}

// Meter the galaxy's own highlights, sharing the cap with the point stars.
// The median target changes smoothly with altitude, never camera distance
// to a foreground body. main.js applies this cap to the shared exposure.
const METER_TARGET = 1.0, METER_PCT = 0.99, METER_MID = 0.05, METER_MID_IN = 0.12, METER_ALT_PC = [300, 800], METER_TAU = 0.5;
const meter = { rt: null, mat: null, scene: null, buf: null, lum: null, pending: false, target: 1, cap: 1, t: 0, fresh: true };
const DRAFT_BUDGET_PX = 0.33e6, DRAFT_INSIDE_SCALE = 0.5, REFINE_ROWS_PX = 0.3e6, REFINE_FADE_MS = 300;
const FRAME_SLOW_MS = 30, FRAME_FAST_MS = 18;
const ADAPT = q.get("galadapt") !== "0";
const budget = { draft: 1, refine: 1, t: 0 };
function adaptBudget(key, now, lo, hi) {
    if (!ADAPT) return;
    const dt = budget.t ? now - budget.t : 16;
    if (dt > FRAME_SLOW_MS) budget[key] = Math.max(lo, budget[key] * Math.min(0.75, Math.max(0.1, FRAME_SLOW_MS / dt)));
    else if (dt < FRAME_FAST_MS) budget[key] = Math.min(hi, budget[key] * 1.1);
}

const state = {
    ready: false,
    rtFull: null, rtDraft: null, refineRow: 0, refineT: 0, mix: 0, lastDrawn: null, inside: true,
    rayMat: null, compMat: null, rayScene: null, compScene: null, orthoCam: null,
    dirty: true, lastKey: [], enabled: !DISABLED, opacity: 1, renders: 0, scale: 0.25,
    maps: null, mapsWorker: null, mapFade: 1, mapT: 0, mapError: null, mapTimer: null,
    mapRevision: 0, targetSize: [], history: null, rtHistory: null,
    copyScene: null, copyMat: null, historySaved: false, historyUsed: false,
    camera: null, time: 0, era: null, disrupt: 0, oldFade: 1, invalidations: 0,
};

function init() {
    if (state.ready) return;
    const model = galaxyModelUniformValues();
    const uniforms = {
        uCamGal: { value: new THREE.Vector3(MW.R0, 0, 20.8) },
        uRayToGal: { value: new THREE.Matrix3() },
        uTanHalf: { value: new THREE.Vector2(1, 1) },
        uRayOffset: { value: new THREE.Vector2() },
        ...historyUniforms(),
        uColYoung: { value: linearRgbFromTeff(MW.teffYoung) },
        uColOld: { value: linearRgbFromTeff(MW.teffThin) },
        uColBar: { value: linearRgbFromTeff(MW.teffBar) },
        uColHii: { value: linearRgbHii() },
        uColArm: { value: linearRgbFromTeff(MW.teffArm) },
        uExtRGB: { value: new THREE.Vector3(...EXTINCTION_RGB) },
        uGain: { value: galaxyDisplayGain(900) },
        uSpiral: { value: 0 }, uBar: { value: MW.barAngle0 },
        uSfr: { value: 1 }, uKeep: { value: 1 }, uOldFade: { value: 1 },
        uSun: { value: new THREE.Vector3(MW.R0, 0, 20.8) },
        uPixAngle: { value: 0.002 }, uFine: { value: 1 },
        uStepK: { value: 0.09 }, uWideK: { value: 0.3 },
        uGalMap: { value: null }, uLaneMap: { value: null },
        uCoarseMap: { value: null },
        uCoarseTexelPc: { value: 2 * previewData.extentPc / previewData.size },
        uMapBlend: { value: 1 }, uMapLanes: { value: 0 },
        uMapNorm: { value: new THREE.Vector4(1, 1, 1, 1) },
    };
    for (const [k, v] of Object.entries(model)) uniforms[k] = { value: v };
    state.rayMat = new THREE.ShaderMaterial({
        uniforms, vertexShader: FULL_VERT, fragmentShader: RAY_FRAG,
        depthTest: false, depthWrite: false, toneMapped: false,
    });
    state.compMat = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: null }, uTexFull: { value: null }, uMix: { value: 0 }, uExposure: { value: 1 }, uOpacity: { value: 1 }, uStretch: { value: 0 }, uRayToGal: uniforms.uRayToGal, uTanHalf: uniforms.uTanHalf, uRayOffset: uniforms.uRayOffset, ...historyUniforms() },
        vertexShader: FULL_VERT, fragmentShader: COMPOSITE_FRAG,
        depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });
    const tri = fullScreenTriangle();
    state.rayScene = new THREE.Scene();
    const rayMesh = new THREE.Mesh(tri, state.rayMat);
    rayMesh.frustumCulled = false; state.rayScene.add(rayMesh);
    state.compScene = new THREE.Scene();
    const compMesh = new THREE.Mesh(tri, state.compMat);
    compMesh.frustumCulled = false; state.compScene.add(compMesh);
    state.copyMat = new THREE.ShaderMaterial({
        uniforms: { uSource: { value: null } }, vertexShader: FULL_VERT,
        fragmentShader: 'uniform sampler2D uSource; varying vec2 vUv; void main(){ gl_FragColor=texture2D(uSource,vUv); }',
        depthTest: false, depthWrite: false, toneMapped: false,
    });
    state.copyScene = new THREE.Scene();
    const copyMesh = new THREE.Mesh(tri, state.copyMat);
    copyMesh.frustumCulled = false; state.copyScene.add(copyMesh);
    state.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    meter.rt = new THREE.WebGLRenderTarget(METER_W, METER_H, { depthBuffer: false, stencilBuffer: false });
    meter.mat = new THREE.ShaderMaterial({ uniforms: { uSrc: { value: null } }, vertexShader: FULL_VERT, fragmentShader: METER_FRAG, depthTest: false, depthWrite: false });
    meter.scene = new THREE.Scene();
    const meterMesh = new THREE.Mesh(tri, meter.mat);
    meterMesh.frustumCulled = false; meter.scene.add(meterMesh);
    meter.buf = new Uint8Array(METER_W * METER_H * 4);
    meter.lum = new Float32Array(METER_W * METER_H);
    state.ready = true;
    installPreview();
    buildMaps();
}

// An actual area-averaged mip of the full model supplies immediate coverage.
// No duplicated stars, independent panorama or blocking main-thread rebuild.
function mapTexture(levels, name) {
    const top = levels[0];
    const tex = new THREE.DataTexture(top.data, top.width, top.height, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.mipmaps = levels; tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true; tex.name = name;
    return tex;
}
function installPreview() {
    const raw = atob(previewData.rgba16), bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer), levels = [];
    let offset = 0;
    for (let n = previewData.size; n >= 1; n >>= 1) {
        const data = new Uint16Array(n * n * 4);
        for (let i = 0; i < data.length; i++, offset += 2) data[i] = view.getUint16(offset, true);
        levels.push({ width: n, height: n, data });
    }
    const u = state.rayMat.uniforms, tex = mapTexture(levels, 'galaxyPreview');
    u.uGalMap.value = u.uCoarseMap.value = tex;
    u.uMapNorm.value.set(previewData.norm.young, previewData.norm.old, previewData.norm.dust, previewData.norm.young);
    u.uMapReady.value = 1; u.uMapTexelPc.value = u.uCoarseTexelPc.value;
    state.maps = { size: previewData.size, full: false, ms: 0 };
}
function buildMaps() {
    const fail = err => {
        clearTimeout(state.mapTimer); state.mapsWorker?.terminate(); state.mapsWorker = null;
        state.mapError = String(err?.message || err || 'Galaxy map worker failed');
        console.warn('Galaxy detail unavailable; retaining shared-model preview:', state.mapError);
    };
    try {
        const w = new Worker(new URL('../workers/galaxyMapsWorker.js', import.meta.url), { type: 'module' });
        state.mapsWorker = w;
        state.mapTimer = setTimeout(() => fail('Galaxy map generation timed out'), 30000);
        w.onmessage = e => {
            try {
                const packed = e.data;
                if (!packed?.levels?.length || packed.size !== previewData.sourceSize || !packed.lane || !packed.norm) throw new Error('Invalid galaxy map payload');
                const tex = mapTexture(packed.levels, 'galaxyStructureMaps');
                const lane = new THREE.DataTexture(packed.lane, packed.size, packed.size, THREE.RGBAFormat, THREE.HalfFloatType);
                lane.minFilter = lane.magFilter = THREE.LinearFilter; lane.generateMipmaps = false;
                lane.needsUpdate = true; lane.name = 'galaxyLaneMaps';
                const u = state.rayMat.uniforms;
                u.uGalMap.value = tex; u.uLaneMap.value = lane;
                u.uMapNorm.value.set(packed.norm.young, packed.norm.old, packed.norm.dust, packed.norm.young);
                u.uMapTexelPc.value = 2 * packed.extentPc / packed.size;
                u.uMapLanes.value = 1; u.uMapBlend.value = 0;
                state.maps = { ms: packed.ms ?? null, size: packed.size, full: true };
                state.mapT = performance.now(); state.mapRevision++; state.history = null; state.dirty = true;
                clearTimeout(state.mapTimer); w.terminate(); state.mapsWorker = null;
            } catch (err) { fail(err); }
        };
        w.onerror = fail; w.onmessageerror = fail;
        w.postMessage({ type: 'build' });
    } catch (err) { fail(err); }
}

function historyUniforms() {
    return { uHistory: { value: null }, uToHistory: { value: new THREE.Matrix3() },
        uHistoryTan: { value: new THREE.Vector2(1, 1) }, uHistoryOffset: { value: new THREE.Vector2() },
        uHistorySize: { value: new THREE.Vector2(1, 1) }, uHistoryValid: { value: 0 }, uHistoryGain: { value: 1 } };
}
function modelKey() {
    const u = state.rayMat.uniforms;
    return [u.uSpiral.value, u.uBar.value, u.uSfr.value, u.uKeep.value, u.uOldFade.value,
        u.uMagLimit.value, state.mapRevision, u.uMapBlend.value, ...u.uSun.value.toArray(), ...u.uKeepR.value];
}
function prepareHistory() {
    const u = state.rayMat.uniforms, h = state.history;
    const angle = 2 * u.uTanHalf.value.y / state.rtDraft.height;
    const valid = !RES_FORCED && canReuseGalaxyHistory(h, u.uCamGal.value.toArray(), modelKey(), angle);
    state.historyUsed = valid;
    for (const target of [u, state.compMat.uniforms]) {
        target.uHistory.value = state.rtHistory?.texture || null;
        target.uHistoryValid.value = valid ? 1 : 0;
        if (valid) {
            target.uToHistory.value.copy(h.ray).transpose();
            target.uHistoryTan.value.copy(h.tan); target.uHistoryOffset.value.copy(h.offset);
            target.uHistorySize.value.set(state.rtHistory.width, state.rtHistory.height);
            target.uHistoryGain.value = u.uGain.value / h.gain;
        }
    }
}
function saveHistory(renderer) {
    if (RES_FORCED || state.historySaved) return;
    const full = state.rtFull;
    state.rtHistory = sizeTarget(state.rtHistory, full.width, full.height, 'galaxyAngularHistory');
    state.rtHistory.texture.generateMipmaps = true;
    state.rtHistory.texture.minFilter = THREE.LinearMipmapLinearFilter;
    state.copyMat.uniforms.uSource.value = full.texture;
    renderer.setRenderTarget(state.rtHistory); renderer.autoClear = true;
    renderer.render(state.copyScene, state.orthoCam);
    const u = state.rayMat.uniforms;
    state.history = { observer: u.uCamGal.value.toArray(), model: modelKey(), ray: u.uRayToGal.value.clone(),
        tan: u.uTanHalf.value.clone(), offset: u.uRayOffset.value.clone(), gain: u.uGain.value,
        pixelAngle: 2 * u.uTanHalf.value.y / full.height };
    state.historySaved = true;
}

function makeTarget(w, h, name) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, stencilBuffer: false,
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
    // Bound residency, including DPR-heavy displays. No monolithic 8K volume.
    const maxPixels = renderQuality.mobile ? 1.2e6 : 4.2e6;
    const cap = Math.min(1, Math.sqrt(maxPixels / Math.max(1, size.x * size.y)),
        renderer.capabilities.maxTextureSize / Math.max(size.x, size.y, 1));
    const full = Math.min(cap, RES_FORCED || (renderQuality.mobile ? 0.5 : 1));
    const sc = Math.min(full, RES_FORCED || state.scale);
    const w = Math.max(64, Math.round(size.x * full)), h = Math.max(40, Math.round(size.y * full));
    const wd = Math.max(64, Math.round(size.x * sc)), hd = Math.max(40, Math.round(size.y * sc));
    const next = [size.x, size.y, w, h, wd, hd];
    if (targetSizeChanged(state.targetSize, next)) {
        state.targetSize = next; state.dirty = true; state.lastDrawn = null;
        state.refineRow = 0; state.mix = 0; state.history = null; state.historySaved = false;
        meter.pending = false; state.invalidations++;
    }
    state.rtFull = sizeTarget(state.rtFull, w, h, 'galaxyVolume');
    state.rtDraft = sizeTarget(state.rtDraft, wd, hd, 'galaxyVolumeDraft');
}
const _size = new THREE.Vector2();
const _camGal = [0, 0, 0];
const _m = new THREE.Matrix3();
const _rot = new THREE.Matrix4();
const _observer = new THREE.Vector3();
const _ang = {};
// scene (x,y,z) -> world (x,-z,y) -> W2G -> galactocentric.
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

export function updateGalaxyVolume(camera, tSec, era = null, disrupt = 0, opacity = 1, oldFade = 1) {
    if (!state.enabled) return;
    init();
    state.camera = camera; state.time = tSec; state.era = era; state.disrupt = disrupt; state.oldFade = oldFade;
    const u = state.rayMat.uniforms;
    camera.updateWorldMatrix(true, false);
    const p = _observer.setFromMatrixPosition(camera.matrixWorld);
    worldKmToGalInto(p.x / K, -p.z / K, p.y / K, _camGal);
    u.uCamGal.value.set(_camGal[0], _camGal[1], _camGal[2]);
    const sun = getSunGalAnchor();
    u.uSun.value.set(sun[0], sun[1], sun[2]);
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
    const projection = camera.projectionMatrix.elements;
    const tanY = 1 / projection[5], tanX = 1 / projection[0];
    u.uTanHalf.value.set(tanX, tanY);
    u.uRayOffset.value.set(projection[8] * tanX, projection[9] * tanY);
    patternAngles(tSec, _ang);
    u.uSpiral.value = _ang.spiral; u.uBar.value = _ang.bar;
    u.uSfr.value = era ? era.blueFrac : 1;
    const kr = u.uKeepR.value;
    if (disrupt && disrupt.length === kr.length) {
        u.uKeep.value = 1;
        for (let i = 0; i < kr.length; i++) kr[i] = Math.max(0, Math.min(1, disrupt[i]));
    } else {
        u.uKeep.value = 1 - Math.max(0, Math.min(1, disrupt || 0)); kr.fill(1);
    }
    u.uOldFade.value = Number.isFinite(oldFade) ? Math.max(0, oldFade) : 1;
    state.opacity = opacity;
    state.scale = resolutionScale(_camGal, M, tanX, tanY);
    const pxScale = Math.max(1, _size.y) / (2 * tanY);
    u.uGain.value = galaxyDisplayGain(pxScale);
    updateAnchor(_camGal, M, tanX, tanY, pxScale, Math.max(1, _size.x * _size.y));
    const key = state.lastKey;
    const vals = [
        _camGal[0], _camGal[1], _camGal[2],
        M[0][0], M[0][1], M[0][2], M[1][0], M[1][1], M[1][2], M[2][0], M[2][1], M[2][2],
        _ang.spiral, _ang.bar, u.uSfr.value, u.uKeep.value, tanX, tanY, u.uOldFade.value, ...kr, ...u.uRayOffset.value.toArray(), ...sun,
    ];
    const posTol = Math.max(1e-8, Math.hypot(..._camGal) * 1e-12);
    let changed = false;
    for (let i = 0; i < vals.length; i++) {
        const tol = i < 3 ? posTol : i < 12 ? 1e-6 : i < 14 ? 1e-10 : 1e-8;
        if (!Number.isFinite(key[i]) || Math.abs(vals[i] - key[i]) > tol) { changed = true; break; }
    }
    if (changed) {
        for (let i = 0; i < vals.length; i++) key[i] = vals[i];
        state.dirty = true;
    }
}

const SCALE_STEPS = [0.18, 0.25, 0.35, 0.5, 0.7, 1];
const _corner = [0, 0, 0];
function resolutionScale(cam, M, tanX, tanY) {
    state.inside = Math.hypot(cam[0], cam[1]) < 22000 && Math.abs(cam[2]) < 2000;
    if (state.inside) return quantizeScale(Math.max(renderQuality.mobile ? 0.25 : 0.35,
        DRAFT_INSIDE_SCALE * Math.sqrt(budget.draft)));
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, behind = false;
    for (let c = 0; c < 8; c++) {
        _corner[0] = (c & 1 ? 25000 : -25000) - cam[0];
        _corner[1] = (c & 2 ? 25000 : -25000) - cam[1];
        _corner[2] = (c & 4 ? 6000 : -6000) - cam[2];
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

export function setGalaxyVolumeMagLimit(m) {
    if (!state.enabled) return;
    init();
    const u = state.rayMat.uniforms.uMagLimit;
    if (Math.abs(u.value - m) > 1e-3) { u.value = m; state.dirty = true; }
}
function rayRender(renderer, rt, rows = null) {
    const u = state.rayMat.uniforms;
    u.uPixAngle.value = 2 * u.uTanHalf.value.y / rt.height;
    const draft = rt === state.rtDraft;
    u.uFine.value = 1; // projected footprint, not motion, selects detail
    u.uHistoryValid.value = draft && state.historyUsed ? 1 : 0;
    u.uStepK.value = draft ? (state.inside ? DRAFT_STEP_K : 0.055) : SETTLED_STEP_K;
    u.uWideK.value = 0.2;
    if (rows) { rt.scissor.set(0, rows[0], rt.width, rows[1]); rt.scissorTest = true; }
    renderer.setRenderTarget(rt);
    renderer.autoClear = !rows;
    try { renderer.render(state.rayScene, state.orthoCam); }
    finally { rt.scissorTest = false; }
    state.renders++;
}

// Surface-brightness anchor for the external galaxy, shared with its sprite.
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
    const vz = M[0][2] * -camGal[0] + M[1][2] * -camGal[1] + M[2][2] * -camGal[2];
    const cosi = Math.abs(camGal[2]) / Math.max(d, 1);
    const rPx = 15000 / Math.max(d, 1) * pxScale;
    anchor.cover = vz < 0 ? Math.min(1, Math.PI * rPx * rPx * Math.max(cosi, 0.08) / Math.max(screenPx, 1)) : 0;
    anchor.fresh = vz < 0 && d > 3000;
}
export function galaxyVolumeMeter() {
    const fresh = !!(state.enabled && state.maps && state.opacity > 0.5 && anchor.fresh && extragalacticExposure.blend > 0);
    const live = !!(state.enabled && state.maps && state.opacity > 0.001 && anchor.fresh && extragalacticExposure.blend > 0);
    return { peak: anchor.peak * state.opacity, corePx: anchor.corePx, cover: anchor.cover, fresh, live, opacity: live ? state.opacity : 0 };
}
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
    const midTarget = METER_MID_IN * Math.pow(METER_MID / METER_MID_IN, w);
    if (mid > midTarget) target = Math.min(target, midTarget / mid);
    meter.target = target; meter.peak = peak; meter.mid = mid;
}
function meterPool(renderer, rt) {
    meter.mat.uniforms.uSrc.value = rt.texture;
    renderer.setRenderTarget(meter.rt);
    renderer.autoClear = true;
    renderer.render(meter.scene, state.orthoCam);
    meter.pending = true;
}
export function galaxyVolumeExposureCap() {
    return state.enabled && state.ready && state.maps && state.opacity > 0.001 ? meter.cap : 1;
}
function meterUpdate(now) {
    const dt = meter.t ? Math.min(0.5, Math.max(0, (now - meter.t) / 1000)) : 0;
    meter.t = now;
    if (meter.fresh) { meter.cap = meter.target; meter.fresh = false; return; }
    meter.cap = Math.exp(Math.log(meter.cap) + (Math.log(meter.target) - Math.log(meter.cap)) * (1 - Math.exp(-dt / METER_TAU)));
}

export function renderGalaxyVolume(renderer, camera = state.camera) {
    if (!state.enabled || !state.ready || state.opacity <= 0.001 || !state.maps) { meter.target = 1; meter.fresh = true; return; }
    renderer.getDrawingBufferSize(_size);
    if (camera) updateGalaxyVolume(camera, state.time, state.era, state.disrupt, state.opacity, state.oldFade);
    ensureTargets(renderer);
    const prevTarget = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear, prevXR = renderer.xr.enabled;
    const prevFace = renderer.getActiveCubeFace(), prevMip = renderer.getActiveMipmapLevel();
    const viewport = renderer.getCurrentViewport(new THREE.Vector4());
    const gl = renderer.getContext();
    const scissor = new THREE.Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX));
    const scissorTest = gl.isEnabled(gl.SCISSOR_TEST);
    const restoreTarget = () => {
        // Preserve active subviewport and Three's current-viewport cache,
        // without changing the target's defaults or global logical viewport.
        if (prevTarget) {
            const vp = prevTarget.viewport.clone(), sc = prevTarget.scissor.clone(), st = prevTarget.scissorTest;
            prevTarget.viewport.copy(viewport); prevTarget.scissor.copy(scissor); prevTarget.scissorTest = scissorTest;
            renderer.setRenderTarget(prevTarget, prevFace, prevMip);
            prevTarget.viewport.copy(vp); prevTarget.scissor.copy(sc); prevTarget.scissorTest = st;
        } else renderer.setRenderTarget(null, prevFace, prevMip);
        renderer.state.viewport(viewport); renderer.state.scissor(scissor); renderer.state.setScissorTest(scissorTest);
    };
    renderer.xr.enabled = false;
    try {
        const now = typeof performance !== "undefined" ? performance.now() : state.mapT + 1e4;
        const full = state.rtFull;
        const u = state.rayMat.uniforms;
        if (state.maps.full && u.uMapBlend.value < 1) {
            const t = Math.min(1, Math.max(0, (now - state.mapT) / 600));
            u.uMapBlend.value = t * t * (3 - 2 * t); state.dirty = true;
        }
        prepareHistory();
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
            state.dirty = false; state.historySaved = false;
            state.lastDrawn = state.rtDraft;
        } else if (state.refineRow < full.height) {
            if (state.refineRow > 0) adaptBudget("refine", now, 0.02, 4);
            const n = Math.max(2, Math.floor(REFINE_ROWS_PX * budget.refine * (state.inside ? 0.5 : 1) / full.width));
            rayRender(renderer, full, [state.refineRow, Math.min(n, full.height - state.refineRow)]);
            state.refineRow += n;
            if (state.refineRow >= full.height) state.refineT = now;
        } else if (state.mix < 1) {
            const t = Math.min(1, (now - state.refineT) / REFINE_FADE_MS);
            state.mix = t * t * (3 - 2 * t);
        }
        if (state.mix >= 1) saveHistory(renderer);
        restoreTarget();
        renderer.autoClear = false;
        const b = extragalacticExposure.blend;
        state.compMat.uniforms.uTex.value = RES_FORCED ? full.texture : state.rtDraft.texture;
        state.compMat.uniforms.uTexFull.value = full.texture;
        state.compMat.uniforms.uMix.value = RES_FORCED ? 0 : state.mix;
        state.compMat.uniforms.uExposure.value = FIXED_EXPOSURE ?? (b > 0
            ? Math.exp(Math.log(Math.max(1e-6, stellarExposure.value)) * (1 - b) + Math.log(Math.max(1e-6, extragalacticExposure.value)) * b)
            : stellarExposure.value);
        state.mapFade = 1;
        state.compMat.uniforms.uOpacity.value = state.opacity * state.mapFade;
        state.compMat.uniforms.uStretch.value = extragalacticExposure.stretch;
        renderer.render(state.compScene, state.orthoCam);
        budget.t = now;
    } finally {
        restoreTarget(); renderer.autoClear = prevAuto; renderer.xr.enabled = prevXR;
    }
}

export function galaxyVolumeStats() {
    const refined = RES_FORCED || state.mix >= 1;
    const rt = refined ? state.rtFull : state.rtDraft;
    return {
        enabled: state.enabled, renders: state.renders, res: rt ? [rt.width, rt.height] : null, scale: RES_FORCED || state.scale,
        mapsReady: !!state.maps?.full, coverageReady: !!state.maps, mapError: state.mapError, mapsMs: state.maps?.ms ?? null, fade: state.mapFade, draft: !refined,
        exposureMode: FIXED_EXPOSURE === null ? "shared-sky" : "fixed-diagnostic",
        historyUsed: state.historyUsed, historyReady: !!state.history, invalidations: state.invalidations,
        integrationStep: state.rayMat?.uniforms.uStepK.value ?? null, maxRaySteps: MAX_STEPS,
        mapSize: state.maps?.size, mapBlend: state.rayMat?.uniforms.uMapBlend.value ?? 0,
        targetBytes: (state.rtDraft ? state.rtDraft.width * state.rtDraft.height * 8 : 0) +
            (state.rtFull ? state.rtFull.width * state.rtFull.height * 8 : 0) +
            (state.rtHistory ? Math.ceil(state.rtHistory.width * state.rtHistory.height * 8 * 4 / 3) : 0),
        anchor: { peak: anchor.peak, cover: anchor.cover, fresh: anchor.fresh },
        budget: { draft: budget.draft, refine: budget.refine }, exposureCap: meter.cap, meterPeak: meter.peak, meterMid: meter.mid,
    };
}
export function setGalaxyVolumeEnabled(on) {
    const enabled = !!on && !DISABLED;
    if (enabled !== state.enabled) { state.dirty = true; state.history = null; state.lastDrawn = null; }
    state.enabled = enabled;
}
export function galaxyVolumeEnabled() {
    return state.enabled;
}
