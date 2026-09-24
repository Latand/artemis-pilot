// Renders the galaxy population (universe/galaxyPopulation.js): every galaxy
// beyond our own, plus the Milky Way itself once render/galaxyVolume.js hands
// it over, drawn by ONE shader at every scale.
//
// Photometry. A galaxy is an extended source. Each one is drawn as a sum of
// exponential components (disk + bulge for spirals, core + envelope for
// spheroids) in its projected ellipse, normalised so the integrated display
// flux is
//     gain * exposure * L / (4 pi d_A^2) * (1+z)^-4 / Omega_px,
// the same Lsun pc^-2 sr^-1 -> display conversion (GALAXY_DISPLAY_GAIN) the
// volumetric Milky Way uses. Resolved, that is surface brightness
// (distance-independent, like the Milky Way seen from outside); unresolved,
// each component is widened by the point-spread function and the same flux
// lands in a ~1-px blob. There is no point/extended switch: one formula spans
// both.
//
// Geometry. Every galaxy is an oblate body with a 3-D symmetry axis (from its
// measured axis ratio and position angle where known), so its projected
// ellipse follows the viewing direction: fly around a catalog galaxy and it
// turns from edge-on to face-on. Disks show a midplane dust lane when seen
// close to edge-on.
//
// Observer time. Positions and brightness are evaluated on the camera's past
// light cone (universe/cosmicExpansion.js): each galaxy is drawn at the
// angular-diameter distance a_e * chi of the epoch whose light reaches the
// camera now, dimmed by (1+z)^-4 and reddened. Bound units (groups,
// clusters, the Local Group) keep their proper sizes; only the separations
// between units follow the scale factor. The Local Group is the origin unit;
// its dynamic members (M31 and its satellites) are moved on the CPU along the
// MW-M31 trajectory (cosmic.js) evaluated at their retarded time.
//
// Precision. Galaxies are grouped into spatially compact chunks; each chunk's
// attributes are float32 offsets from a float64 centre and the camera
// position relative to that centre is computed on the CPU in float64, so
// camera-relative positions stay exact at any distance.
import * as THREE from "three";
import { K, MPC_KM } from "../constants.js";
import { GALAXY_DISPLAY_GAIN } from "./galaxyVolume.js";
import { extragalacticExposure } from "./stellarAppearance.js";
import { tierDepthRange } from "./tierDepth.js";
import { RELATIVISTIC_VIEW_GLSL } from "./viewBrightness.js";
import { relUniforms } from "../relView.js";
import { buildLightConeTable, lnScaleFactorAt, cosmicTimeGyr } from "../universe/cosmicExpansion.js";
import { PERF, markPerf } from "../perf.js";

const LC_N = 512;

const CHI_MAX_MPC = 2500;       // light-cone table reach (comoving Mpc; the farthest galaxy from the farthest camera is ~1.1 Gpc)
const MPC_SCENE = MPC_KM * K;

const VERT = /* glsl */`
precision highp float;
attribute vec3 aUnit;
attribute vec3 aDelta;
attribute vec4 aShape;
attribute vec4 aPhot;
attribute float aT;
uniform vec3 uCamRel;
uniform mat3 uWorldToView;
uniform sampler2D uLightCone;
uniform float uChiMax, uAObs, uMpcScene, uFarClamp, uPxScale, uGainExposure, uMwKeep, uMergeMorph, uCull;
uniform vec2 uViewport;
uniform float uMaxPointPx, uDpr;
uniform vec2 uDepthRange;
#ifndef GAL_POINTS
varying vec2 vPx;          // pixel offset from the centre along (major, minor)
#endif
varying vec4 vAB;          // component scales in px: (a1, b1, a2, b2)
varying vec2 vW;           // component peak display values
varying vec3 vColor;
varying float vLane;       // dust-lane strength
varying float vExt;        // quad half-size in widest-component scale lengths
#ifdef GAL_POINTS
varying vec2 vRot;         // screen direction of the major axis (points)
varying float vHalf;       // point half-size in px
#endif
${RELATIVISTIC_VIEW_GLSL}
const float LC_N = ${LC_N}.0;
float lightCone(float chi) {
    float u = clamp(chi / uChiMax, 0.0, 1.0) * (LC_N - 1.0);
    float i0 = floor(u);
    float f = u - i0;
    float a = texture2D(uLightCone, vec2((i0 + 0.5) / LC_N, 0.5)).r;
    float b = texture2D(uLightCone, vec2((min(i0 + 1.0, LC_N - 1.0) + 0.5) / LC_N, 0.5)).r;
    return mix(a, b, f);
}
vec3 bvColor(float bv, float zfac) {
    // Ballesteros (2012) B-V -> T, redshifted, blackbody colour, linear RGB,
    // normalised to unit luminance (colour never changes the light budget).
    float b = clamp(bv, -0.4, 2.0);
    float teff = 4600.0 * (1.0 / (0.92 * b + 1.7) + 1.0 / (0.92 * b + 0.62)) / zfac;
    vec3 c = relTeffToRGB(teff);
    c = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
    return c / max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4);
}
void offscreen() {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
#ifndef GAL_POINTS
    vPx = vec2(0.0);
#endif
    vAB = vec4(1.0); vW = vec2(0.0); vColor = vec3(0.0); vLane = 0.0; vExt = 1.0;
#ifdef GAL_POINTS
    vRot = vec2(1.0, 0.0); vHalf = 0.0; gl_PointSize = 0.0;
#endif
}
void main() {
    float T = aT;
    float flagMw = step(99.0, T) * (1.0 - step(199.0, T));
    float flagMerge = step(99.0, T);
    T -= 100.0 * floor((T + 5.5) / 100.0);
    float keep = mix(1.0, uMwKeep, flagMw);
    if (keep <= 0.001) { offscreen(); return; }
    // --- light cone: comoving separation to the unit centre -> emission epoch
    vec3 rel = aUnit - uCamRel;
    float chi = length(rel);
    float dlnA = lightCone(chi);
    float ratio = exp(dlnA);                          // a_emit / a_obs
    vec3 appW = rel * (uAObs * ratio) + aDelta;       // apparent position, observer proper Mpc
    float dMpc = length(appW);
    if (dMpc <= 0.0) { offscreen(); return; }
    vec3 dirV = uWorldToView * (appW / dMpc);
    float dScene = dMpc * uMpcScene;
    // Cheap early rejection: even as a point source (all light in the PSF core)
    // this galaxy stays below the display threshold. (Doppler brightening at
    // relativistic speed is allowed for by a generous factor.)
    {
        float dPc0 = dMpc * 1e6;
        float L0 = pow(10.0, -0.4 * (aPhot.x - 4.83));
        float r0 = ratio * ratio;
        float boost = uBeta > 0.0 ? 64.0 : 1.0;
        if (L0 / (12.566370614 * dPc0 * dPc0) * uPxScale * uPxScale * r0 * r0 * uGainExposure * keep * boost / 3.5343 < uCull) { offscreen(); return; }
    }
    // relativistic aberration + Doppler for a moving camera (relView.js);
    // applied to the unit direction: |position|^2 overflows float32 past
    // ~6 Gly in scene units.
    float dopplerD;
    dirV = normalize(relApplyView(dirV, 5500.0, dopplerD));
    float viewDepth = dScene * max(0.0, -dirV.z);
    if (-dirV.z <= 0.0 || viewDepth < uDepthRange.x || viewDepth >= uDepthRange.y) { offscreen(); return; }
    // --- shape: oblate body, symmetry axis n, intrinsic axis ratio q0
    float morph = uMergeMorph * flagMerge;
    float q0 = mix(aShape.w, 0.7, morph);
    float bulge = mix(aPhot.w, 1.0, morph);
    vec3 n = normalize(uWorldToView * aShape.xyz);
    vec3 l = dirV;
    float ci = abs(dot(n, l));
    float si = sqrt(max(0.0, 1.0 - ci * ci));
    float q = sqrt(ci * ci + q0 * q0 * si * si);
    vec3 nSky = n - dot(n, l) * l;
    vec3 maj = length(nSky) > 1e-5 ? normalize(cross(l, nSky)) : normalize(cross(l, vec3(0.0, 1.0, 0.0) + vec3(1e-3, 0.0, 0.0)));
    vec3 mnr = cross(l, maj);
    // --- sizes in px (PSF-widened): h in kpc -> angle -> px
    float dPc = dMpc * 1e6;
    float pxPerKpc = 1e3 / dPc * uPxScale;
    float h = aPhot.z;
    float spheroid = step(0.985, bulge);
    // spirals: disk (h) + bulge (exp. scale 0.12 h, rounder); spheroids: core
    // (0.1 Re) + envelope (0.7 Re), a two-exponential de Vaucouleurs stand-in.
    float a1 = mix(h, 0.7 * h, spheroid) * pxPerKpc;
    float a2 = mix(0.12 * h, 0.1 * h, spheroid) * pxPerKpc;
    float q2 = mix(max(q, 0.65), q, spheroid);
    float w1 = mix(1.0 - bulge, 0.65, spheroid);
    float w2 = mix(bulge, 0.35, spheroid);
    // --- photometry: V luminosity, cosmological dimming, Doppler (extended: D^4)
    float L = pow(10.0, -0.4 * (aPhot.x - 4.83));
    float r4 = ratio * ratio * ratio * ratio;
    float dop4 = dopplerD * dopplerD * dopplerD * dopplerD;
    // flux / Omega_px in Lsun pc^-2 sr^-1: L/(4 pi d^2) * pxScale^2
    float fluxPx = L / (12.566370614 * dPc * dPc) * uPxScale * uPxScale * r4 * dop4 * uGainExposure * keep;
    // Point-spread function. Faint sources get the diffraction-limited
    // 0.75 px; a source whose unresolved peak would saturate the display
    // spreads into a larger glow (width ~ peak^1/5, like the star layers'
    // size curve), so bright galaxies read as brighter, bigger points
    // instead of clipped squares. The integrated flux is unchanged.
    const float PSF0 = 0.75, PEAK_SAT = 1.5;
    float peak0 = fluxPx / (6.283185307 * max(a1 * a1 * q, PSF0 * PSF0));
    float PSF = PSF0 * clamp(pow(max(peak0 / PEAK_SAT, 1.0), 0.2), 1.0, 3.5);
    float A1 = sqrt(a1 * a1 + PSF * PSF), B1 = sqrt(a1 * a1 * q * q + PSF * PSF);
    float A2 = sqrt(a2 * a2 + PSF * PSF), B2 = sqrt(a2 * a2 * q2 * q2 + PSF * PSF);
    float p1 = fluxPx * w1 / (6.283185307 * A1 * B1);
    float p2 = fluxPx * w2 / (6.283185307 * A2 * B2);
    if (p1 + p2 < uCull) { offscreen(); return; }
    // Display soft knee (like the star layers' intensity cap): a source far
    // above white is compressed instead of burning a hard-edged disk. Below
    // the knee -- every source that is not already saturated -- the
    // photometry is linear.
    const float KNEE = 3.0;
    float pk = p1 + p2;
    if (pk > KNEE) {
        float sc = KNEE * pow(pk / KNEE, 0.3) / pk;
        p1 *= sc; p2 *= sc;
    }
    // --- quad covering ~4.5 scale lengths of the widest component
    float drawD = min(dScene, uFarClamp);
    vec3 center = dirV * drawD;
    // Cull by the centre against the frustum with a margin for the quad:
    // the clip vector is normalised below, which only works for quads that
    // stay in front of the camera, so their half-size is also capped at
    // ~0.5 rad (such a galaxy fills the view; the sprite is not the right
    // representation any more, but it must never fold through w = 0).
    // The quad only needs to reach where the profile drops below the display
    // threshold: ln(peak / threshold) scale lengths, at most 4.5.
    float rVis = clamp(log(max(p1 + p2, 1e-30) / (0.3 * uCull)), 1.2, 4.5);
    float extA = min(rVis * max(A1, A2), 0.5 * uPxScale), extB = min(rVis * max(B1, B2), 0.5 * uPxScale);
    vec4 clipC = projectionMatrix * vec4(center, 1.0);
    if (clipC.w <= 0.0) { offscreen(); return; }
    vec2 ndcC = clipC.xy / clipC.w;
    vec2 margin = 2.0 * vec2(extA) / uViewport;
    if (abs(ndcC.x) > 1.0 + margin.x || abs(ndcC.y) > 1.0 + margin.y) { offscreen(); return; }
#ifdef GAL_POINTS
    // One vertex per galaxy: a square point covering the rotated ellipse.
    // The major axis' screen direction goes to the fragment shader.
    float hs = max(extA, extB);
    // Too large for a point sprite: cap the reach (the flux is unchanged).
    hs = min(hs, 0.5 * uMaxPointPx);
    vec4 clipM = projectionMatrix * vec4(center + maj * (drawD / uPxScale), 1.0);
    vec2 sd = (clipM.xy / clipM.w - ndcC) * uViewport;
    vRot = length(sd) > 1e-9 ? normalize(sd) : vec2(1.0, 0.0);
    vHalf = hs;
    gl_PointSize = 2.0 * hs * uDpr;
    gl_Position = vec4(ndcC, 0.9999, 1.0);
#else
    vec2 corner = position.xy;
    vPx = corner * vec2(extA, extB);
    float pxToScene = drawD / uPxScale;
    vec3 p = center + (maj * vPx.x + mnr * vPx.y) * pxToScene;
    vec4 clip = projectionMatrix * vec4(p, 1.0);
    // Normalise the homogeneous clip vector. At these distances w ~ 1e15-1e19:
    // z/w rounds onto (or past) the far plane in float32, and rasterisers
    // lose the varyings' perspective-correct interpolation (1/w ~ 1e-17
    // skewed the profile toward one corner of the quad). A galaxy's quad is
    // small against its distance, so affine interpolation is exact enough,
    // and as background light that never writes depth it sits just inside
    // the far plane.
    gl_Position = vec4(clip.xy / clip.w, 0.9999, 1.0);
#endif
    vAB = vec4(A1, B1, A2, B2);
    vExt = rVis;
    vW = vec2(p1, p2);
    float zfac = 1.0 / max(ratio, 1e-6) / max(dopplerD, 1e-3);
    vColor = bvColor(mix(aPhot.y, 0.95, morph), zfac);
    // edge-on spiral dust lane, only once the minor axis is resolved
    float spiral = step(0.5, T) * (1.0 - step(8.5, T)) * (1.0 - spheroid);
    vLane = spiral * 0.75 * smoothstep(0.75, 0.97, si) * smoothstep(1.5, 4.0, a1 * q);
}`;

const FRAG = /* glsl */`
precision highp float;
#ifndef GAL_POINTS
varying vec2 vPx;
#endif
varying vec4 vAB;
varying vec2 vW;
varying vec3 vColor;
varying float vLane;
varying float vExt;
#ifdef GAL_POINTS
varying vec2 vRot;
varying float vHalf;
#endif
void main() {
#ifdef GAL_POINTS
    vec2 qp = (gl_PointCoord - 0.5) * vec2(2.0, -2.0) * vHalf;   // px, y up
    vec2 vPx = vec2(dot(qp, vRot), dot(qp, vec2(-vRot.y, vRot.x)));
#endif
    float r1 = length(vPx / vAB.xy);
    float r2 = length(vPx / vAB.zw);
    // taper to zero at the quad edge (vExt scale lengths of the widest part)
    vec2 e = vPx / (vExt * max(vAB.xy, vAB.zw));
    float edge = 1.0 - smoothstep(0.55, 1.0, length(e));
    float yl = vPx.y / max(0.18 * vAB.y, 0.5);
    float lane = 1.0 - vLane * exp(-yl * yl) * smoothstep(0.0, 0.6, r1);
    float v = (vW.x * exp(-r1) * lane + vW.y * exp(-r2) * mix(1.0, lane, 0.5)) * edge;
    if (v < 1e-5) discard;
    gl_FragColor = vec4(vColor * min(v, 64.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;

const state = {
    parent: null, worker: null, enabled: false, ready: false, building: false, error: null,
    chunks: [], catalog: null, shared: null, lcTex: null, lcLnA: NaN, lcData: new Float32Array(LC_N),
    lg: null, stats: { buildMs: null, visibleChunks: 0 }, group: null,
};

function quadGeometry() {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
}

function makeShared() {
    const tex = new THREE.DataTexture(state.lcData, LC_N, 1, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter; tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    state.lcTex = tex;
    return {
        uWorldToView: { value: new THREE.Matrix3() },
        uLightCone: { value: tex },
        uChiMax: { value: CHI_MAX_MPC },
        uAObs: { value: 1 },
        uMpcScene: { value: MPC_SCENE },
        uFarClamp: { value: 1e18 },
        uPxScale: { value: 900 },
        uGainExposure: { value: GALAXY_DISPLAY_GAIN },
        uMwKeep: { value: 0 },
        uMergeMorph: { value: 0 },
        uCull: { value: 0.0015 },
        uViewport: { value: new THREE.Vector2(1280, 800) },
        uMaxPointPx: { value: 128 },
        uDpr: { value: 1 },
        uDepthRange: tierDepthRange,
        uBeta: relUniforms.uBeta,
        uBoostDirView: relUniforms.uBoostDirView,
    };
}

// The bulk of the population is drawn as GL points (one vertex per galaxy);
// the Local Group chunk -- the only galaxies that grow to hundreds of pixels
// -- as instanced quads with no size limit. Same shader, same photometry.
function makeChunkMesh(c) {
    const asPoints = !c.lg;
    const g = asPoints ? new THREE.BufferGeometry() : quadGeometry();
    const A = asPoints ? THREE.BufferAttribute : THREE.InstancedBufferAttribute;
    if (asPoints) g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(c.count * 3), 3));
    g.setAttribute("aUnit", new A(c.unit, 3));
    g.setAttribute("aDelta", new A(c.delta, 3));
    g.setAttribute("aShape", new A(c.shape, 4));
    g.setAttribute("aPhot", new A(c.phot, 4));
    g.setAttribute("aT", new A(c.t, 1));
    if (!asPoints) g.instanceCount = c.count;
    const defines = asPoints ? { GAL_POINTS: "" } : {};
    const mat = new THREE.ShaderMaterial({
        defines,
        uniforms: { ...state.shared, uCamRel: { value: new THREE.Vector3() } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        // a quad's winding follows the projected axes: never cull it
        side: asPoints ? THREE.FrontSide : THREE.DoubleSide,
    });
    const mesh = asPoints ? new THREE.Points(g, mat) : new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.name = "galaxies.chunk" + (c.lg ? ".localGroup" : "");
    mesh.userData.center = c.center;
    mesh.userData.radiusMpc = c.radiusMpc;
    mesh.userData.minMV = c.minMV ?? -30;
    mesh.userData.lg = !!c.lg;
    return mesh;
}

export function initGalaxyPopulation(parent, { seed, options } = {}) {
    if (state.parent) return;
    const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
    if (q.get("galaxies") === "0") return;
    state.parent = parent;
    state.enabled = true;
    state.group = new THREE.Group();
    state.group.name = "galaxyPopulation";
    state.group.frustumCulled = false;
    parent.add(state.group);
    state.shared = makeShared();
    // Absolute site root: a module worker resolves relative URLs against its
    // own script, not the page.
    const base = new URL(".", location.href).href.replace(/\/+$/, "");
    const msg = { type: "build", id: 1, base, options: { ...(options || {}), ...(seed !== undefined ? { seed } : {}) } };
    state.building = true;
    try {
        state.worker = new Worker(new URL("../workers/galaxyPopulationWorker.js", import.meta.url), { type: "module" });
        state.worker.onmessage = e => onBuilt(e.data);
        state.worker.onerror = err => { state.error = String(err?.message || err); state.building = false; console.warn("galaxy population worker failed:", state.error); };
        state.worker.postMessage(msg);
    } catch (err) {
        state.error = String(err?.message || err);
        state.building = false;
    }
}

function onBuilt(m) {
    state.building = false;
    if (m.type !== "built") { state.error = m.message || "build failed"; console.warn("galaxy population:", state.error); return; }
    state.catalog = m.catalog;
    for (const c of m.chunks) {
        const mesh = makeChunkMesh(c);
        state.group.add(mesh);
        state.chunks.push(mesh);
        if (c.lg) initLocalGroup(c, mesh);
    }
    state.stats.buildMs = m.ms;
    state.ready = true;
    state.worker?.terminate();
    state.worker = null;
}

// --- Local Group dynamics ---------------------------------------------------------
// M31 and every Local Group member within 300 kpc of it (M33, M32, NGC 205,
// the Andromeda dwarfs) ride M31's trajectory; everything else in the Local
// Group keeps its catalog position relative to the Galactic centre.
function initLocalGroup(c, mesh) {
    const cat = state.catalog;
    let m31 = -1;
    for (let k = 0; k < c.count; k++) {
        const nm = cat.names[cat.name[c.gid[k]]];
        if (nm === "Andromeda") { m31 = k; break; }
    }
    const base = Float32Array.from(c.delta);
    const rides = new Uint8Array(c.count);
    if (m31 >= 0) {
        const mx = base[m31 * 3], my = base[m31 * 3 + 1], mz = base[m31 * 3 + 2];
        for (let k = 0; k < c.count; k++) {
            if (Math.hypot(base[k * 3] - mx, base[k * 3 + 1] - my, base[k * 3 + 2] - mz) < 0.3) rides[k] = 1;
        }
        // flag M31 as a merger participant (T + 200)
        c.t[m31] = 200 + c.t[m31];
        mesh.geometry.attributes.aT.needsUpdate = true;
    }
    state.lg = { mesh, base, rides, m31, m31Base: m31 >= 0 ? [base[m31 * 3], base[m31 * 3 + 1], base[m31 * 3 + 2]] : null, last: [NaN, NaN, NaN] };
}

// M31's GC-relative world-frame position (Mpc) at its catalog epoch, or null.
export function andromedaCatalogMpc() {
    return state.lg?.m31Base || null;
}

function updateLocalGroup(m31NowMpc) {
    const lg = state.lg;
    if (!lg || !lg.m31Base || !m31NowMpc) return;
    const dx = m31NowMpc[0] - lg.m31Base[0], dy = m31NowMpc[1] - lg.m31Base[1], dz = m31NowMpc[2] - lg.m31Base[2];
    if (Math.abs(dx - lg.last[0]) + Math.abs(dy - lg.last[1]) + Math.abs(dz - lg.last[2]) < 1e-6) return;
    lg.last[0] = dx; lg.last[1] = dy; lg.last[2] = dz;
    const attr = lg.mesh.geometry.attributes.aDelta;
    const d = attr.array;
    for (let k = 0; k < lg.rides.length; k++) {
        if (!lg.rides[k]) continue;
        d[k * 3] = lg.base[k * 3] + dx; d[k * 3 + 1] = lg.base[k * 3 + 1] + dy; d[k * 3 + 2] = lg.base[k * 3 + 2] + dz;
    }
    attr.needsUpdate = true;
}

// --- Exposure ------------------------------------------------------------------------
// Inside the Milky Way every layer shares the stellar exposure. Outside it no
// star can be resolved any more, and the scene is galaxies: resolved ones
// keep their surface brightness at any distance, unresolved ones fade as
// d^-2 while ever more of them crowd the view, so no fixed exposure works.
// The layer meters like a camera: every few frames it projects a fixed
// sample of the population plus every Local Group member (the Milky Way
// included, even while render/galaxyVolume.js draws it) and exposes so that
// the brightest EXPOSURE.brightFrac of the screen's pixels sit at
// EXPOSURE.target (the brightest objects may saturate; the field does not).
// It adapts in log space with a ~0.6 s time constant, and blends in with the
// camera's distance from the Galactic centre (150 -> 600 kly), where the
// volumetric Milky Way switches to the same exposure
// (stellarAppearance.extragalacticExposure). One exposure scales every
// galaxy, so relative brightness is exact.
const EXPOSURE = { sample: null, n: 12000, every: 8, target: 0.9, brightFrac: 0.002, tau: 0.6, value: 1, auto: 1, frame: 0, t: 0, min: 0.05, max: 1e8, fresh: true };
const _mPeak = new Float32Array(EXPOSURE.n + 512), _mFoot = new Float32Array(EXPOSURE.n + 512), _mIdx = new Uint32Array(EXPOSURE.n + 512);
// Peak display value (at exposure 1) and pixel footprint of one galaxy.
function galaxyPeak(MV, hKpc, d, pxScale, out) {
    const dPc = d * 1e6;
    const flux = Math.pow(10, -0.4 * (MV - 4.83)) / (12.566370614 * dPc * dPc) * pxScale * pxScale * GALAXY_DISPLAY_GAIN;
    const hPx = hKpc * 1e3 / dPc * pxScale;
    const area = Math.max(hPx * hPx * 0.5, 0.5625);
    out[0] = flux / (6.283185307 * area);
    out[1] = 25.13 * area;                          // ~pixels within two scale lengths
    return out;
}
const _pf = [0, 0];
function inView(e, x, y, z, tanX, tanY, marginRad = 0) {
    const vx = e[0] * x + e[3] * y + e[6] * z, vy = e[1] * x + e[4] * y + e[7] * z, vz = e[2] * x + e[5] * y + e[8] * z;
    if (vz >= 0) return false;
    const m = marginRad * Math.hypot(vx, vy, vz);
    return Math.abs(vx) <= -vz * tanX + m && Math.abs(vy) <= -vz * tanY + m;
}
// Photographic metering: the level reached by the brightest brightFrac of
// the screen's pixels, estimated from the galaxies in view (a fixed sample
// of the catalogue weighted up to the whole population, plus every Local
// Group member at its own weight).
function meterExposure(camGC, viewRot, pxScale, tanX, tanY, screenPx) {
    const cat = state.catalog;
    if (!cat) return EXPOSURE.auto;
    if (!EXPOSURE.sample) {
        const n = Math.min(EXPOSURE.n, cat.count);
        EXPOSURE.sample = new Int32Array(n);
        for (let k = 0; k < n; k++) EXPOSURE.sample[k] = Math.floor((k + 0.5) * cat.count / n);
    }
    const e = viewRot.elements;
    const pos = cat.pos, MV = cat.MV;
    const w = cat.count / EXPOSURE.sample.length;
    let m = 0;
    for (let k = 0; k < EXPOSURE.sample.length; k++) {
        const i = EXPOSURE.sample[k];
        if (cat.unit[i] === cat.localGroupUnit) continue;
        const x = pos[i * 3] - camGC[0], y = pos[i * 3 + 1] - camGC[1], z = pos[i * 3 + 2] - camGC[2];
        const d = Math.hypot(x, y, z);
        if (!(d > 1e-4) || !inView(e, x, y, z, tanX, tanY)) continue;
        galaxyPeak(MV[i], cat.hKpc[i], d, pxScale, _pf);
        _mPeak[m] = _pf[0]; _mFoot[m] = _pf[1] * w; m++;
    }
    const lg = state.lg;
    if (lg) {
        const d3 = lg.mesh.geometry.attributes.aDelta.array;
        const ph = lg.mesh.geometry.attributes.aPhot.array;
        for (let k = 0; k < lg.rides.length && m < _mPeak.length; k++) {
            const x = d3[k * 3] - camGC[0], y = d3[k * 3 + 1] - camGC[1], z = d3[k * 3 + 2] - camGC[2];
            const d = Math.hypot(x, y, z);
            const rad = 4 * ph[k * 4 + 2] * 1e-3 / Math.max(d, 1e-6);
            if (!(d > 1e-5) || !inView(e, x, y, z, tanX, tanY, rad)) continue;
            galaxyPeak(ph[k * 4], ph[k * 4 + 2], d, pxScale, _pf);
            _mPeak[m] = _pf[0]; _mFoot[m] = Math.min(_pf[1], screenPx); m++;
        }
    }
    if (!m) return EXPOSURE.auto;
    for (let k = 0; k < m; k++) _mIdx[k] = k;
    const idx = _mIdx.subarray(0, m).sort((a, b) => _mPeak[b] - _mPeak[a]);
    const want = EXPOSURE.brightFrac * screenPx;
    let acc = 0, ref = _mPeak[idx[m - 1]];
    for (let k = 0; k < m; k++) {
        acc += _mFoot[idx[k]];
        if (acc >= want) { ref = _mPeak[idx[k]]; break; }
    }
    return ref > 0 ? EXPOSURE.target / ref : EXPOSURE.auto;
}

// --- Per frame ---------------------------------------------------------------------
const _v = new THREE.Matrix3(), _r = new THREE.Matrix4();
/**
 * @param {THREE.Camera} camera
 * @param {object} f  { tSim (s), gcScene [x,y,z] scene units, exposure, pxScale,
 *                      mwKeep 0..1, mergeMorph 0..1, m31Mpc [x,y,z] GC-relative world Mpc (or null) }
 */
export function updateGalaxyPopulation(camera, f) {
    if (!state.ready) return;
    const t0 = PERF.enabled ? performance.now() : 0;
    const s = state.shared;
    // epoch and light-cone table
    const lnAObs = lnScaleFactorAt(cosmicTimeGyr(f.tSim));
    if (!(Math.abs(lnAObs - state.lcLnA) < 1e-7)) {
        buildLightConeTable(lnAObs, CHI_MAX_MPC, LC_N, state.lcData);
        state.lcTex.needsUpdate = true;
        state.lcLnA = lnAObs;
    }
    const aObs = Math.exp(lnAObs);
    s.uAObs.value = Number.isFinite(aObs) ? aObs : 1e30;
    // world axes -> view: view rotation * (world -> scene axis map)
    camera.updateMatrixWorld();
    _r.copy(camera.matrixWorldInverse);
    const e = _r.elements;
    // rotation part R (row-major r_ij = e[j*4+i]); scene = S world with
    // S = [[1,0,0],[0,0,1],[0,-1,0]]  ->  (R S)_ij = R_i0 S_0j + R_i1 S_1j + R_i2 S_2j
    const R = (i, j) => e[j * 4 + i];
    _v.set(
        R(0, 0), -R(0, 2), R(0, 1),
        R(1, 0), -R(1, 2), R(1, 1),
        R(2, 0), -R(2, 2), R(2, 1),
    );
    s.uWorldToView.value.copy(_v);
    s.uPxScale.value = f.pxScale;
    if (f.viewport) s.uViewport.value.set(f.viewport[0], f.viewport[1]);
    if (f.dpr) s.uDpr.value = f.dpr;
    if (f.maxPointPx) s.uMaxPointPx.value = Math.min(256, f.maxPointPx / (f.dpr || 1));
    s.uMwKeep.value = f.mwKeep;
    s.uMergeMorph.value = f.mergeMorph || 0;
    s.uFarClamp.value = camera.far * 0.8;
    updateLocalGroup(f.m31Mpc);
    // camera comoving position relative to the Galactic centre (float64)
    const p = camera.position;
    const cx = (p.x - f.gcScene[0]) / MPC_SCENE, cy = -(p.z - f.gcScene[2]) / MPC_SCENE, cz = (p.y - f.gcScene[1]) / MPC_SCENE;
    // exposure: shared stellar exposure inside the Milky Way, metered beyond
    const now = typeof performance !== "undefined" ? performance.now() / 1000 : 0;
    const dt = EXPOSURE.t ? Math.min(0.5, Math.max(0, now - EXPOSURE.t)) : 1;
    EXPOSURE.t = now;
    const dGCly = Math.hypot(cx, cy, cz) * 3.2615637771674e6;
    const blend = smooth(1.5e5, 6e5, dGCly);
    if (blend > 0 && (EXPOSURE.frame++ % EXPOSURE.every === 0)) {
        const tanY = Math.tan(camera.fov * Math.PI / 360), tanX = tanY * camera.aspect;
        const screenPx = f.viewport ? f.viewport[0] * f.viewport[1] : 1e6;
        const target = Math.min(EXPOSURE.max, Math.max(EXPOSURE.min, meterExposure([cx, cy, cz], _v, f.pxScale, tanX, tanY, screenPx)));
        const k = EXPOSURE.fresh ? 1 : 1 - Math.exp(-dt * EXPOSURE.every / EXPOSURE.tau);
        EXPOSURE.fresh = false;
        EXPOSURE.auto = Math.exp(Math.log(EXPOSURE.auto) + (Math.log(target) - Math.log(EXPOSURE.auto)) * k);
    } else if (blend <= 0) { EXPOSURE.auto = Math.max(EXPOSURE.min, f.exposure); EXPOSURE.fresh = true; }
    EXPOSURE.value = Math.exp(Math.log(Math.max(1e-6, f.exposure)) * (1 - blend) + Math.log(EXPOSURE.auto) * blend);
    extragalacticExposure.value = EXPOSURE.auto;
    extragalacticExposure.blend = blend;
    s.uGainExposure.value = GALAXY_DISPLAY_GAIN * EXPOSURE.value;
    // Chunk culling (CPU): outside the view cone, or too faint to reach the
    // display even at its brightest member's nearest possible distance.
    const tanY = Math.tan(camera.fov * Math.PI / 360), tanX = tanY * camera.aspect;
    const halfDiag = Math.atan(Math.hypot(tanX, tanY));
    const ev = _v.elements;
    const gainE = s.uGainExposure.value * f.pxScale * f.pxScale / (12.566370614 * 3.5343);
    let vis = 0;
    for (const mesh of state.chunks) {
        const c = mesh.userData.center;
        // The camera enters comoving coordinates (divided by a_obs) for every
        // chunk; the Local Group's members sit at the origin unit with
        // proper offsets, so they do not expand.
        const k = 1 / s.uAObs.value;
        const rx = cx * k - c[0], ry = cy * k - c[1], rz = cz * k - c[2];
        mesh.material.uniforms.uCamRel.value.set(rx, ry, rz);
        if (mesh.userData.lg || s.uBeta.value > 0) { mesh.visible = true; vis++; continue; }
        const R = mesh.userData.radiusMpc * 1.05 + 0.5;
        const d = Math.hypot(rx, ry, rz);
        let show = d <= R;
        if (!show) {
            // view-space direction of the chunk centre (from the camera)
            const x = -rx, y = -ry, z = -rz;
            const vx = ev[0] * x + ev[3] * y + ev[6] * z, vy = ev[1] * x + ev[4] * y + ev[7] * z, vz = ev[2] * x + ev[5] * y + ev[8] * z;
            const ang = Math.acos(Math.max(-1, Math.min(1, -vz / d)));
            show = ang - Math.asin(Math.min(1, R / d)) <= halfDiag;
            if (show) {
                const dn = Math.max(d - R, 1e-3) * 1e6;
                show = Math.pow(10, -0.4 * (mesh.userData.minMV - 4.83)) / (dn * dn) * gainE >= s.uCull.value;
            }
        }
        mesh.visible = show;
        if (show) vis++;
    }
    state.stats.visibleChunks = vis;
    if (PERF.enabled) markPerf("galaxies.update", performance.now() - t0, { chunks: vis });
}

export function galaxyPopulationStatus() {
    return {
        exposure: EXPOSURE.value, visibleChunks: state.stats.visibleChunks,
        enabled: state.enabled, ready: state.ready, building: state.building, error: state.error,
        galaxies: state.catalog?.count || 0, chunks: state.chunks.length, stats: state.catalog?.stats || null,
        buildMs: state.stats.buildMs,
    };
}

export function galaxyCatalog() { return state.catalog; }

// Test hook: a standalone chunk mesh with its own shared uniforms (smokes).
export function makeGalaxyChunkForTest(c) {
    if (!state.shared) state.shared = makeShared();
    return { mesh: makeChunkMesh(c), shared: state.shared };
}

function smooth(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}
