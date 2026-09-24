// Draws the tidal debris of the Milky Way - Andromeda merger
// (universe/mergerTides.js): the disk stars the tide has pulled off their
// orbits, as smoothed light, in the same photometry as the galaxy sprites
// (render/galaxyPopulationRender.js) and the volumetric Milky Way.
//
// Each particle is a Gaussian blob carrying a fixed share of its disk's V
// light, with a kernel width that follows the local spacing of the debris
// (adaptive smoothing), widened by the same point-spread function as the
// galaxies, so the summed light is a smooth surface-brightness field: tails,
// bridges, shells and finally the remnant's envelope. Undisturbed disk stars
// carry weight 0 here and are drawn by the smooth models; the keep factors
// exported below remove exactly the light the debris took over.
//
// Observer time: the Milky Way's particles are shown at the retarded time of
// the Galactic centre, Andromeda's at the retarded time of Andromeda (the
// same epochs its sprite and the volume use). Particles closer to the camera
// than a few kernel widths fade out: that near field is resolved star light
// of the observer's own neighbourhood, not a blob.
import * as THREE from "three";
import { K, PC_KM } from "../constants.js";
import { RELATIVISTIC_VIEW_GLSL } from "./viewBrightness.js";
import { EXT_STRETCH_GLSL } from "./stellarAppearance.js";
import { keepAt, sampleParticles, MW_BIN_COUNT } from "../universe/mergerTides.js";
import { PERF, markPerf } from "../perf.js";

const KPC_SCENE = PC_KM * 1000 * K;
// ?tidesgain=N scales the debris light (inspection only; 1 = photometric)
const DEBUG_GAIN = (() => { try { return Number(new URLSearchParams(location.search).get("tidesgain")) || 1; } catch { return 1; } })();

const VERT = /* glsl */`
precision highp float;
attribute vec2 aWS;          // (weight 0..1, kernel sigma kpc)
attribute float aGal;        // 0 Milky Way, 1 Andromeda
uniform vec3 uCamKpc;
uniform mat3 uWorldToView;
uniform float uKpcScene, uPxScale, uGainExposure, uMaxPointPx, uDpr, uFarClamp, uLum, uRed;
uniform vec2 uLp, uBV;
uniform vec2 uDepthRange, uViewport;
varying vec3 vColor;
varying float vPeak, vS, vHalf;
${RELATIVISTIC_VIEW_GLSL}
vec3 bvColor(float bv, float zfac) {
    float b = clamp(bv, -0.4, 2.0);
    float teff = 4600.0 * (1.0 / (0.92 * b + 1.7) + 1.0 / (0.92 * b + 0.62)) / zfac;
    vec3 c = relTeffToRGB(teff);
    c = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
    return c / max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
}
void offscreen() {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0); vPeak = 0.0; vS = 1.0; vHalf = 0.0;
}
void main() {
    float w = aWS.x;
    float sig = aWS.y;
    vec3 rel = position - uCamKpc;
    float d = length(rel);
    if (w < 0.004 || d <= 0.0) { offscreen(); return; }
    w *= smoothstep(2.0 * sig, 5.0 * sig, d);
    if (w < 0.004) { offscreen(); return; }
    vec3 dirV = uWorldToView * (rel / d);
    float dopplerD;
    dirV = normalize(relApplyView(dirV, 5500.0, dopplerD));
    float dScene = d * uKpcScene;
    float viewDepth = dScene * max(0.0, -dirV.z);
    if (-dirV.z <= 0.0 || viewDepth < uDepthRange.x || viewDepth >= uDepthRange.y) { offscreen(); return; }
    float gal = step(0.5, aGal);
    float dPc = d * 1000.0;
    float L = mix(uLp.x, uLp.y, gal) * w * uLum;
    float dop2 = dopplerD * dopplerD;
    float flux = L / (12.566370614 * dPc * dPc) * uPxScale * uPxScale * uGainExposure * dop2 * dop2;
    float sPx = sig / d * uPxScale;
    const float PSF0 = 0.75;
    float peak0 = flux / (6.283185307 * max(sPx * sPx, PSF0 * PSF0));
    float PSF = PSF0 * clamp(pow(max(peak0 / 1.5, 1.0), 0.2), 1.0, 3.5);
    float s = sqrt(sPx * sPx + PSF * PSF);
    float peak = flux / (6.283185307 * s * s);
    // many blobs overlap: keep ones far below a single display step
    const float FLOOR = 2e-5;
    if (peak < FLOOR) { offscreen(); return; }
    const float KNEE = 3.0;
    if (peak > KNEE) peak = KNEE * pow(peak / KNEE, 0.3);
    float drawD = min(dScene, uFarClamp);
    vec4 clipC = projectionMatrix * vec4(dirV * drawD, 1.0);
    if (clipC.w <= 0.0) { offscreen(); return; }
    vec2 ndc = clipC.xy / clipC.w;
    float hs = min(s * sqrt(2.0 * log(peak / FLOOR)), 0.5 * uMaxPointPx);
    hs = max(hs, 1.0);
    vec2 margin = 2.0 * vec2(hs) / uViewport;
    if (abs(ndc.x) > 1.0 + margin.x || abs(ndc.y) > 1.0 + margin.y) { offscreen(); return; }
    gl_PointSize = 2.0 * hs * uDpr;
    gl_Position = vec4(ndc, 0.9999, 1.0);
    vPeak = peak; vS = s; vHalf = hs;
    float bv = mix(mix(uBV.x, uBV.y, gal), 0.95, uRed);
    vColor = bvColor(bv, 1.0 / max(dopplerD, 1e-3));
}`;

const FRAG = /* glsl */`
precision highp float;
uniform float uStretch;
${EXT_STRETCH_GLSL}
varying vec3 vColor;
varying float vPeak, vS, vHalf;
void main() {
    vec2 q = (gl_PointCoord - 0.5) * 2.0 * vHalf;
    float r2 = dot(q, q) / (vS * vS);
    float edge = 1.0 - smoothstep(0.7, 1.0, length(q) / vHalf);
    float v = vPeak * exp(-0.5 * r2) * edge;
    if (v < 1e-6) discard;
    gl_FragColor = vec4(vColor * extStretch(min(v, 64.0), uStretch), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

const state = {
    group: null, shared: null, worker: null, started: false, model: null, error: null, ms: null,
    mesh: null, pos: null, ws: null, keep: { mwBins: new Float32Array(MW_BIN_COUNT), mwTotal: 1, m31: 1 },
    lastT: [NaN, NaN], visible: 0,
};

// `shared`: the galaxy layer's shared uniforms (view matrix, pixel scale,
// gain x exposure, depth tier, relativistic view) -- one exposure for both.
export function initMergerTides(parent, shared) {
    if (state.group || !parent || !shared) return;
    const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
    if (q.get("tides") === "0") return;
    state.group = new THREE.Group();
    state.group.name = "mergerTides";
    parent.add(state.group);
    state.shared = shared;
}

// Start the simulation (once the Local Group photometry is known).
// opts: { m31HKpc }
export function startMergerTides(opts = {}) {
    if (!state.group || state.started) return;
    state.started = true;
    try {
        state.worker = new Worker(new URL("../workers/mergerTidesWorker.js", import.meta.url), { type: "module" });
        state.worker.onmessage = e => onDone(e.data);
        state.worker.onerror = err => { state.error = String(err?.message || err); console.warn("merger tides worker failed:", state.error); };
        state.worker.postMessage({ type: "simulate", id: 1, options: { m31HKpc: opts.m31HKpc } });
    } catch (err) {
        state.error = String(err?.message || err);
    }
}

function onDone(m) {
    state.worker?.terminate();
    state.worker = null;
    if (m.type !== "done") { state.error = m.message || "simulation failed"; console.warn("merger tides:", state.error); return; }
    const model = m.model;
    state.model = model;
    state.ms = m.ms;
    const n = model.n;
    state.pos = new Float32Array(n * 3);
    state.ws = new Float32Array(n * 2);
    const gal = new Float32Array(n);
    for (let p = model.nMW; p < n; p++) gal[p] = 1;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(state.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aWS", new THREE.BufferAttribute(state.ws, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute("aGal", new THREE.BufferAttribute(gal, 1));
    const s = state.shared;
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uWorldToView: s.uWorldToView, uPxScale: s.uPxScale, uGainExposure: s.uGainExposure,
            uMaxPointPx: s.uMaxPointPx, uDpr: s.uDpr, uFarClamp: s.uFarClamp, uDepthRange: s.uDepthRange, uViewport: s.uViewport,
            uBeta: s.uBeta, uBoostDirView: s.uBoostDirView, uStretch: s.uStretch,
            uCamKpc: { value: new THREE.Vector3() },
            uKpcScene: { value: KPC_SCENE },
            uLum: { value: 1 }, uRed: { value: 0 },
            uLp: { value: new THREE.Vector2(0, 0) }, uBV: { value: new THREE.Vector2(0.68, 0.8) },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    });
    state.mesh = new THREE.Points(g, mat);
    state.mesh.frustumCulled = false;
    state.mesh.visible = false;
    state.mesh.name = "mergerTides.debris";
    state.group.add(state.mesh);
}

// Keep factors of the smooth models at the given epochs, or null while the
// simulation is still running (callers fall back to the scalar ramp).
export function mergerKeepAt(tMwGyr, tM31Gyr) {
    if (!state.model) return null;
    return keepAt(state.model, tMwGyr, tM31Gyr, state.keep);
}
export function mergerTidesModel() { return state.model; }

/**
 * Per frame, after updateGalaxyPopulation (whose shared uniforms it uses).
 * f: { tMwGyr, tM31Gyr (retarded epochs, Gyr from now), gcScene [x,y,z],
 *      lum (stellar-population factor), red (0..1 colour quench),
 *      phot: { mwL, m31L (V Lsun of the disk light the particles carry), mwBV, m31BV } }
 */
export function updateMergerTides(camera, f) {
    const mesh = state.mesh, model = state.model;
    if (!mesh || !model) return;
    const t0 = PERF.enabled ? performance.now() : 0;
    const u = mesh.material.uniforms;
    const p = camera.position;
    const cx = (p.x - f.gcScene[0]) / KPC_SCENE, cy = -(p.z - f.gcScene[2]) / KPC_SCENE, cz = (p.y - f.gcScene[1]) / KPC_SCENE;
    // nothing to draw before the first keyframe, or from far beyond the Local Group
    const first = model.times[0];
    const far = Math.hypot(cx, cy, cz) > 3e4;
    if ((f.tMwGyr < first && f.tM31Gyr < first) || far) { mesh.visible = false; state.visible = 0; return; }
    u.uCamKpc.value.set(cx, cy, cz);
    u.uLum.value = f.lum ?? 1;
    u.uRed.value = f.red ?? 0;
    if (f.phot) {
        u.uLp.value.set(f.phot.mwL / model.nMW * DEBUG_GAIN, f.phot.m31L / model.nM31 * DEBUG_GAIN);
        u.uBV.value.set(f.phot.mwBV, f.phot.m31BV);
    }
    if (f.tMwGyr !== state.lastT[0] || f.tM31Gyr !== state.lastT[1]) {
        sampleParticles(model, f.tMwGyr, 0, model.nMW, state.pos, state.ws);
        sampleParticles(model, f.tM31Gyr, model.nMW, model.n, state.pos, state.ws);
        state.lastT[0] = f.tMwGyr; state.lastT[1] = f.tM31Gyr;
        let vis = 0;
        for (let i = 0; i < model.n; i++) if (state.ws[i * 2] > 0.004) vis++;
        state.visible = vis;
        const g = mesh.geometry;
        g.attributes.position.needsUpdate = true;
        g.attributes.aWS.needsUpdate = true;
    }
    mesh.visible = state.visible > 0;
    if (PERF.enabled) markPerf("galaxies.tides", performance.now() - t0, { visible: state.visible });
}

export function mergerTidesStatus() {
    return { started: state.started, ready: !!state.model, error: state.error, ms: state.ms, visible: state.visible, particles: state.model?.n || 0 };
}

// Debug/test introspection (smokes).
export function mergerTidesDebug() {
    const m = state.mesh;
    if (!m) return null;
    const u = m.material.uniforms, out = {};
    for (const [k, v] of Object.entries(u)) {
        const x = v.value;
        out[k] = x && x.toArray ? x.toArray() : (x && x.elements ? Array.from(x.elements) : x);
    }
    const n = state.model.n;
    let wSum = 0, rMax = 0, sig = 0, nv = 0;
    for (let p = 0; p < n; p++) {
        const w = state.ws[p * 2];
        if (w > 0.004) { wSum += w; nv++; sig += state.ws[p * 2 + 1]; rMax = Math.max(rMax, Math.hypot(state.pos[p * 3], state.pos[p * 3 + 1], state.pos[p * 3 + 2])); }
    }
    return { uniforms: out, visible: m.visible, parentVisible: m.parent?.visible, wSum, nv, meanSigma: nv ? sig / nv : 0, rMax, lastT: state.lastT.slice(), p0: Array.from(state.pos.slice(0, 6)) };
}
