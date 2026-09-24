import * as THREE from "three";
import { stellarExposure } from "./render/stellarAppearance.js";
import { AU_KM, CAM_DIST_MAX, COSMIC_ZOOMS, K, LY_SCENE, PC_KM, SEC_YEAR } from "./constants.js";
import { mulberry32, smooth01 } from "./format.js";
import { G } from "./state.js";
import { cam, camera, farTierGroup } from "./scene.js";
import { toast } from "./achievements.js";
import { makeGalaxyCloudAsync, galacticCenterScene, galacticRingPositions, applyEraToCloud } from "./universe/starfield.js";
import { galToSceneUnitsInto } from "./universe/coords.js";
import { GALACTIC_ORBIT_PERIOD_S } from "./universe/solarOrbit.js";
import { eraModulation, setMergerEpochGyr } from "./universe/cosmicEra.js";
import { PERF, markPerf } from "./perf.js";
import { galaxyVolumeEnabled } from "./render/galaxyVolume.js";

// Galactic-centre position in scene units (toward Sgr A*, ~26,000 ly). The
// procedural galaxy cloud and the real HYG catalog share this equatorial frame.
const GC_SCENE = galacticCenterScene();
export const GALAXY = {
    sunX: 0,
    sunZ: 0,
    centerX: GC_SCENE[0],
    centerY: GC_SCENE[1],
    centerZ: GC_SCENE[2],
};

let scaleEl = null;
let inited = false;
let sceneRef = null;
let layerBuilt = false;
let layerBuilding = false;
let layerBuildScheduled = false;
let layerBuildPromise = null;
const root = new THREE.Group();
const diskRoot = new THREE.Group();
const galaxyMotionRoot = new THREE.Group();
const galaxyRoot = new THREE.Group();
const localRoot = new THREE.Group();
const deepRoot = new THREE.Group();
const labelRoot = new THREE.Group();
galaxyMotionRoot.position.set(GC_SCENE[0], GC_SCENE[1], GC_SCENE[2]);
galaxyRoot.position.set(-GC_SCENE[0], -GC_SCENE[1], -GC_SCENE[2]);
galaxyMotionRoot.add(galaxyRoot);
diskRoot.add(galaxyMotionRoot);
root.add(diskRoot, localRoot, deepRoot, labelRoot);
root.visible = false;
let pointMap = null;
const GALAXY_OMEGA0 = Math.PI * 2 / GALACTIC_ORBIT_PERIOD_S;
const GALACTIC_NORTH_SCENE_AXIS = (() => {
    const gc = [0, 0, 0], north = [0, 0, 0];
    galToSceneUnitsInto(0, 0, 0, gc, 0, K);
    galToSceneUnitsInto(0, 0, 1, north, 0, K);
    return new THREE.Vector3(north[0] - gc[0], north[1] - gc[1], north[2] - gc[2]).normalize();
})();
const LOCAL_GALAXIES = [];
let cosmicVisualBucket = "";

// ---------------------------------------------------------------------------
// WP23a - Milky Way / Andromeda approach, merger, and Local-Group dynamics.
//
// Initial conditions (van der Marel, Fardal, Besla et al. 2012, ApJ 753, 8,
// "The M31 Velocity Vector II"): current 3-D separation ~770-785 kpc, radial
// (closing) velocity ~-109 to -117 km/s, and a small, poorly-constrained
// transverse component; 30 km/s is used here so the approach shows a visible
// off-axis swing rather than a perfectly radial plunge. Halo-inclusive
// virial masses (~1.3e12 Msun MW, ~1.5e12 Msun M31) follow the same paper's
// Local Group mass budget.
//
// Model: the reduced two-body problem for the MW-M31 separation vector,
// integrated once into a cached time -> position lookup table (no per-frame
// integration - a deterministic KDK leapfrog runs once, lazily, on first
// use). Gravity uses a Plummer-softened 1/r^2 law (softening ~15 kpc, a
// stand-in halo-core scale) so the point-mass force never diverges as the
// galaxies interpenetrate. A velocity-proportional drag switches on once the
// halos are close enough to overlap - the qualitative signature of
// dynamical friction (Chandrasekhar 1943, ApJ 97, 255: drag opposes the
// relative velocity and grows with local density) WITHOUT evaluating the
// literal Chandrasekhar formula (that needs a halo density profile + Coulomb
// logarithm this sim doesn't carry); the drag's radial turn-on scale and
// strength are tuned so the resulting timeline (first passage ~3.9 Gyr,
// captured under 50 kpc by ~7 Gyr, effectively coalesced within ~10-15 Gyr)
// matches the literature's ~4 Gyr first-passage / ~10 Gyr merger-completion
// range (van der Marel+ 2012 Sec.1; Cox & Loeb 2008, MNRAS 386, 461).
const G_SI = 6.674e-11;         // m^3 kg^-1 s^-2
const MSUN_KG = 1.98892e30;
const KPC_KM = PC_KM * 1000;
const GYR_SEC = 1e9 * SEC_YEAR;

const MERGER = {
    massMWMsun: 1.3e12,
    massM31Msun: 1.5e12,
    r0Kpc: 785,
    vr0KmS: -110,
    vt0KmS: 30,
    softenKpc: 15,
    frictionEta0PerGyr: 0.5,
    frictionScaleKpc: 85,
    mergeKpc: 50,          // "coalesced" once separation drops (and stays) below this
    mergeReleaseKpc: 75,   // hysteresis: only clears the "coalesced" state above this
    disruptTailGyr: 1.5,   // extra ramp after permanent capture before disruptFrac reaches 1
    tableMaxGyr: 100,
    tableDtGyr: 0.002,     // integration step (~2 Myr)
    tableSampleGyr: 0.01,  // stored-sample cadence (~10 Myr)
};

let mergerTable = null;

// KDK leapfrog integration of the relative separation vector (x,y), run once
// and cached. See the module comment above for the physical model.
function buildMergerTable() {
    const muTot = G_SI * 1e-9 * (MERGER.massMWMsun + MERGER.massM31Msun) * MSUN_KG; // km^3/s^2
    const epsKm = MERGER.softenKpc * KPC_KM;
    const etaScaleKm = MERGER.frictionScaleKpc * KPC_KM;
    const eta0 = MERGER.frictionEta0PerGyr / GYR_SEC;
    const dt = MERGER.tableDtGyr * GYR_SEC;
    const tMax = MERGER.tableMaxGyr * GYR_SEC;
    const sampleDt = MERGER.tableSampleGyr * GYR_SEC;
    const nSamples = Math.floor(tMax / sampleDt) + 2;
    const tSec = new Float64Array(nSamples);
    const xKm = new Float64Array(nSamples);
    const yKm = new Float64Array(nSamples);

    let x = MERGER.r0Kpc * KPC_KM, y = 0;
    let vx = MERGER.vr0KmS, vy = MERGER.vt0KmS;
    let t = 0, si = 0, nextSampleT = 0;
    let lastR = Math.hypot(x, y), prevDrDt = -1;
    let firstPassageSec = null, mergedSec = null;

    while (t <= tMax) {
        if (t >= nextSampleT && si < nSamples) {
            tSec[si] = t; xKm[si] = x; yKm[si] = y; si++;
            nextSampleT += sampleDt;
        }
        let r2 = x * x + y * y;
        let rSoft = Math.sqrt(r2 + epsKm * epsKm);
        let g = -muTot / (rSoft * rSoft * rSoft);
        let r = Math.sqrt(r2);
        let eta = eta0 * Math.exp(-r / etaScaleKm);
        const ax0 = g * x - eta * vx, ay0 = g * y - eta * vy;
        const vxh = vx + ax0 * dt * 0.5, vyh = vy + ay0 * dt * 0.5;
        x += vxh * dt; y += vyh * dt;
        r2 = x * x + y * y;
        rSoft = Math.sqrt(r2 + epsKm * epsKm);
        g = -muTot / (rSoft * rSoft * rSoft);
        r = Math.sqrt(r2);
        eta = eta0 * Math.exp(-r / etaScaleKm);
        const ax1 = g * x - eta * vxh, ay1 = g * y - eta * vyh;
        vx = vxh + ax1 * dt * 0.5; vy = vyh + ay1 * dt * 0.5;
        t += dt;

        r = Math.hypot(x, y);
        const drDt = r - lastR;
        if (prevDrDt < 0 && drDt >= 0 && firstPassageSec === null) firstPassageSec = t;
        prevDrDt = drDt; lastR = r;
        const rKpc = r / KPC_KM;
        if (rKpc < MERGER.mergeKpc && mergedSec === null) mergedSec = t;
        else if (rKpc > MERGER.mergeReleaseKpc && mergedSec !== null) mergedSec = null;
    }
    if (si < nSamples) { tSec[si] = t; xKm[si] = x; yKm[si] = y; si++; }

    return {
        tSec: tSec.subarray(0, si),
        xKm: xKm.subarray(0, si),
        yKm: yKm.subarray(0, si),
        firstPassageSec: firstPassageSec ?? tMax,
        mergedSec: mergedSec ?? tMax,
    };
}

function getMergerTable() {
    if (!mergerTable) {
        mergerTable = buildMergerTable();
        setMergerEpochGyr(mergerTable.mergedSec / GYR_SEC);
    }
    return mergerTable;
}

export function mergerEpochGyr() {
    return getMergerTable().mergedSec / GYR_SEC;
}

function mergerRelativeKmAt(simTSeconds) {
    const tbl = getMergerTable();
    const t = Math.max(0, Number.isFinite(simTSeconds) ? simTSeconds : 0);
    const arr = tbl.tSec, n = arr.length;
    if (t <= arr[0]) return { x: tbl.xKm[0], y: tbl.yKm[0] };
    if (t >= arr[n - 1]) return { x: tbl.xKm[n - 1], y: tbl.yKm[n - 1] };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] <= t) lo = mid; else hi = mid;
    }
    const t0 = arr[lo], t1 = arr[hi];
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    return {
        x: tbl.xKm[lo] + (tbl.xKm[hi] - tbl.xKm[lo]) * f,
        y: tbl.yKm[lo] + (tbl.yKm[hi] - tbl.yKm[lo]) * f,
    };
}

// Pure, deterministic: MW-M31 3-D separation (kpc) at a given sim time
// (seconds, matching G.t). Exported for smoke:merger.
export function mergerSeparationKpcAt(simTSeconds) {
    const { x, y } = mergerRelativeKmAt(simTSeconds);
    return Math.hypot(x, y) / KPC_KM;
}

// 0..1 cumulative disk-disruption fraction, monotonically non-decreasing in
// time (does not "heal" when the pair swings back out to a wide apoapsis
// between passages) - ramps from the first close passage to a bit after the
// pair is permanently captured under `mergeKpc`, feeding the disk->spheroid
// visual and the color reddening.
export function mergerDisruptFractionAt(simTSeconds) {
    const tbl = getMergerTable();
    const t = Math.max(0, Number.isFinite(simTSeconds) ? simTSeconds : 0);
    const start = tbl.firstPassageSec;
    const end = tbl.mergedSec + MERGER.disruptTailGyr * GYR_SEC;
    if (end <= start) return t >= start ? 1 : 0;
    return smooth01(start, end, t);
}

// Debug/test introspection - smoke:merger reads this rather than
// re-deriving passage/merge timing with its own heuristics.
export function mergerDebugState() {
    const tbl = getMergerTable();
    return {
        r0Kpc: MERGER.r0Kpc,
        firstPassageGyr: tbl.firstPassageSec / GYR_SEC,
        mergedGyr: tbl.mergedSec / GYR_SEC,
        mergeKpc: MERGER.mergeKpc,
    };
}

export function isCosmicLayerBuilt() {
    return layerBuilt;
}

// Orbital-plane axes for reconstructing the 3-D relative vector: u_hat is
// the initial MW->M31 direction, w_hat is a perpendicular in-plane axis
// carrying the (small) transverse velocity. Central forces (gravity + a
// drag along the relative velocity) never produce an out-of-plane
// component, so the whole trajectory stays in this fixed plane.
const MERGER_U_HAT = new THREE.Vector3();
const MERGER_W_HAT = new THREE.Vector3();
let mergerAxesReady = false;
const MERGER_TMP_MW = new THREE.Vector3();
const MERGER_TMP_M31 = new THREE.Vector3();
const MERGER_MW_FRAC = MERGER.massM31Msun / (MERGER.massMWMsun + MERGER.massM31Msun);

function ensureMergerAxes(baseVec3) {
    if (mergerAxesReady) return;
    MERGER_U_HAT.copy(baseVec3).normalize();
    const upGuess = Math.abs(MERGER_U_HAT.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    MERGER_W_HAT.crossVectors(MERGER_U_HAT, upGuess).normalize();
    mergerAxesReady = true;
}

// Barycentric two-body split: with the barycenter fixed and MW/M31 at their
// t=0 scene positions (0 and the original base vector), MW recoils by the
// mass-M31 fraction of the net relative displacement and M31 carries the
// rest - standard two-body bookkeeping, applied "symmetrically" to the MW's
// own backdrop group per WP23a's brief (the Sun/local-neighborhood frame
// stays put; only the whole-Milky-Way visual wobbles).
function mergerScenePositions() {
    const rel = mergerRelativeKmAt(G.t);
    const dx = rel.x - MERGER.r0Kpc * KPC_KM, dy = rel.y;
    const mwU = -MERGER_MW_FRAC * dx, mwW = -MERGER_MW_FRAC * dy;
    const m31U = mwU + rel.x, m31W = mwW + rel.y;
    MERGER_TMP_MW.copy(MERGER_U_HAT).multiplyScalar(mwU * K).addScaledVector(MERGER_W_HAT, mwW * K);
    MERGER_TMP_M31.copy(MERGER_U_HAT).multiplyScalar(m31U * K).addScaledVector(MERGER_W_HAT, m31W * K);
    return { mwOffset: MERGER_TMP_MW, m31Pos: MERGER_TMP_M31 };
}

function setDisruptUniforms(uniforms, disrupt, eraRed) {
    if (!uniforms) return;
    if (uniforms.uDisrupt) uniforms.uDisrupt.value = disrupt;
    if (uniforms.uEraRed) uniforms.uEraRed.value = eraRed;
}

let mwDiskMergeUniforms = null;

// Hook for the WP24 parallel package (frozen contract, feature-detected so
// cosmic.js works whether or not it has landed yet): universe/deepField.js +
// render/deepFieldRender.js, a statistically-correct extragalactic field
// beyond the Local Group, initialized into scene.js's farTierGroup and
// updated every frame. (WP23c's cosmicEra.js is a confirmed-landed, tested
// dependency - imported statically above, no feature-detect needed.)
let deepFieldApi = null, deepFieldApiTried = false;
async function ensureDeepFieldApi() {
    if (deepFieldApiTried) return deepFieldApi;
    deepFieldApiTried = true;
    try { deepFieldApi = await import("./render/deepFieldRender.js"); } catch (err) { deepFieldApi = null; }
    return deepFieldApi;
}
let legacyDeepFieldObj = null;

function idleSlice(timeout = 120) {
    return new Promise(resolve => {
        if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout });
        else setTimeout(resolve, 0);
    });
}

function cosmicPointMap() {
    if (!pointMap) {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 64;
        const ctx = cv.getContext("2d");
        const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0, "rgba(255,255,255,0.82)");
        g.addColorStop(.18, "rgba(255,255,255,0.24)");
        g.addColorStop(.58, "rgba(255,255,255,0.045)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 64, 64);
        pointMap = new THREE.CanvasTexture(cv);
        pointMap.colorSpace = THREE.SRGBColorSpace;
    }
    return pointMap;
}

function colorMix(a, b, t, jitter = 0) {
    return [
        a[0] * (1 - t) + b[0] * t + jitter,
        a[1] * (1 - t) + b[1] * t + jitter,
        a[2] * (1 - t) + b[2] * t + jitter,
    ];
}

// A disk point-cloud that can progressively scatter into a spheroid and
// redden, driven by `uDisrupt` (WP23a merger visual) and `uEraRed` (WP23c
// era hook) uniforms. Used for both the Milky Way's own procedural disk
// cloud and Andromeda's disk (`diskGalaxy(..., { mergeable: true })`) so the
// two merging disks share one shader; non-merging galaxies (M33/LMC/SMC)
// keep the plain PointsMaterial path in `diskGalaxy()`, untouched.
//
// `scatterTarget` is a per-point randomized position on a puffed-out
// spheroid with the same characteristic radius as the source disk
// (precomputed once, deterministic in `seed`) - at uDisrupt=1 the cloud
// looks like a pressure-supported elliptical remnant instead of flying
// apart to infinity.
function mergeableDiskPoints(pos, col, opts = {}) {
    const { size = 1.2, opacity = .5, seed = 1 } = opts;
    const count = pos.length / 3;
    const scatter = new Float32Array(count * 3);
    const rnd = mulberry32(seed | 0);
    let maxR = 1;
    for (let i = 0; i < count; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const r = Math.sqrt(x * x + y * y * 4 + z * z);
        if (r > maxR) maxR = r;
        const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2;
        const side = Math.sqrt(Math.max(0, 1 - u * u));
        scatter[i * 3] = Math.cos(th) * side * r;
        scatter[i * 3 + 1] = u * r * .7;
        scatter[i * 3 + 2] = Math.sin(th) * side * r;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geom.setAttribute("scatterTarget", new THREE.BufferAttribute(scatter, 3));
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uSize: { value: size },
            uOpacity: { value: opacity },
            uDisrupt: { value: 0 },
            uEraRed: { value: 0 },
            uRadiusScale: { value: maxR },
        },
        vertexShader: /* glsl */`
            attribute vec3 scatterTarget;
            varying vec3 vColor;
            uniform float uSize, uDisrupt, uEraRed, uRadiusScale;
            void main() {
                float m = smoothstep(0.0, 1.0, uDisrupt);
                // Shear/twist the still-disk-like points before they fully
                // leave the plane (inner region shears faster, mimicking
                // differential rotation winding up during the approach).
                float rr = length(position.xz);
                float twist = uDisrupt * 2.4 * (1.0 - clamp(rr / uRadiusScale, 0.0, 1.0));
                float tc = cos(twist), ts = sin(twist);
                vec3 sheared = vec3(position.x * tc - position.z * ts, position.y, position.x * ts + position.z * tc);
                vec3 mixed = mix(sheared, scatterTarget, m);
                float red = clamp(m * .85 + uEraRed * .5, 0.0, 1.0);
                vColor = mix(color, vec3(1.0, 0.62, 0.42), red);
                vec4 mvPosition = modelViewMatrix * vec4(mixed, 1.0);
                gl_PointSize = uSize;
                gl_Position = projectionMatrix * mvPosition;
            }`,
        fragmentShader: /* glsl */`
            varying vec3 vColor;
            uniform float uOpacity;
            void main() {
                vec2 uv = gl_PointCoord - 0.5;
                float r2 = dot(uv, uv);
                if (r2 > 0.25) discard;
                float g = exp(-r2 * 10.0);
                gl_FragColor = vec4(vColor, g * uOpacity);
            }`,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    });
    mat.userData.baseOpacity = opacity;
    const obj = new THREE.Points(geom, mat);
    obj.frustumCulled = false;
    return obj;
}

function points(data, size, opacity) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(data.pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(data.col, 3));
    const mat = new THREE.PointsMaterial({
        vertexColors: true,
        size,
        sizeAttenuation: false,
        transparent: true,
        map: cosmicPointMap(),
        alphaTest: .02,
        opacity,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    });
    mat.userData.baseOpacity = opacity;
    const obj = new THREE.Points(geom, mat);
    obj.frustumCulled = false;
    return obj;
}

function sphericalCloud(count, radiusLy, seed, colorA, colorB, coreBias = 1.9, flatness = 1) {
    const rnd = mulberry32(seed);
    const radius = radiusLy * LY_SCENE;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const u = rnd() * 2 - 1;
        const th = rnd() * Math.PI * 2;
        const r = radius * Math.pow(rnd(), coreBias);
        const side = Math.sqrt(Math.max(0, 1 - u * u));
        pos[i * 3] = Math.cos(th) * side * r;
        pos[i * 3 + 1] = u * r * flatness;
        pos[i * 3 + 2] = Math.sin(th) * side * r;
        const mix = Math.pow(rnd(), .7);
        const c = colorMix(colorA, colorB, mix, (rnd() - .5) * .045);
        col[i * 3] = Math.max(0, Math.min(1, c[0]));
        col[i * 3 + 1] = Math.max(0, Math.min(1, c[1]));
        col[i * 3 + 2] = Math.max(0, Math.min(1, c[2]));
    }
    return { pos, col };
}

function globularCloud(count, radiusLy, seed, colorA, colorB) {
    const rnd = mulberry32(seed);
    const radius = radiusLy * LY_SCENE;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const u = rnd() * 2 - 1;
        const th = rnd() * Math.PI * 2;
        const r = radius * (.12 + Math.pow(rnd(), .72) * .88);
        const side = Math.sqrt(Math.max(0, 1 - u * u));
        pos[i * 3] = Math.cos(th) * side * r;
        pos[i * 3 + 1] = u * r * .88;
        pos[i * 3 + 2] = Math.sin(th) * side * r;
        const c = colorMix(colorA, colorB, rnd(), .04 + rnd() * .05);
        col[i * 3] = Math.min(1, c[0]);
        col[i * 3 + 1] = Math.min(1, c[1]);
        col[i * 3 + 2] = Math.min(1, c[2]);
    }
    return { pos, col };
}

function offsetCloud(data, x, y, z) {
    const pos = data.pos;
    for (let i = 0; i < pos.length; i += 3) {
        pos[i] += x;
        pos[i + 1] += y;
        pos[i + 2] += z;
    }
    return data;
}

function galaxyCoreTexture(colorA, colorB) {
    const W = 128;
    const cv = document.createElement("canvas");
    cv.width = cv.height = W;
    const ctx = cv.getContext("2d");
    const g = ctx.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
    const ca = `rgba(${Math.round(colorB[0] * 255)},${Math.round(colorB[1] * 255)},${Math.round(colorB[2] * 255)},`;
    const cb = `rgba(${Math.round(colorA[0] * 255)},${Math.round(colorA[1] * 255)},${Math.round(colorA[2] * 255)},`;
    g.addColorStop(0, ca + ".70)");
    g.addColorStop(.25, ca + ".25)");
    g.addColorStop(.65, cb + ".055)");
    g.addColorStop(1, cb + "0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, W);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function diskGalaxy(cx, cy, cz, radiusLy, tilt, colorA, colorB, seed, count = 9000, opts = {}) {
    const rnd = mulberry32(seed);
    const radius = radiusLy * LY_SCENE;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const arm = Math.floor(rnd() * 4);
        const rn = Math.pow(rnd(), 1.55);
        const r = radius * rn;
        const spiral = arm * Math.PI * .5 + rn * 5.1 + (rnd() - .5) * (.55 + rn * .75);
        const bar = Math.max(0, 1 - rn * 8);
        const stretch = 1 + bar * 1.9;
        const x = Math.cos(spiral) * r * stretch;
        const z = Math.sin(spiral) * r * (.62 + bar * .25);
        const y = (rnd() + rnd() - 1) * radius * (.018 + .018 * rn);
        pos[i * 3] = cx + x;
        pos[i * 3 + 1] = cy + y;
        pos[i * 3 + 2] = cz + z;
        const core = Math.max(0, 1 - rn * 4.5);
        const hot = .18 + core * .75 + rnd() * .08;
        const c = colorMix(colorA, colorB, Math.min(1, hot), (rnd() - .5) * .035);
        col[i * 3] = Math.max(0, Math.min(1, c[0]));
        col[i * 3 + 1] = Math.max(0, Math.min(1, c[1]));
        col[i * 3 + 2] = Math.max(0, Math.min(1, c[2]));
    }
    let disk;
    if (opts.mergeable) {
        // WP23a: this disk is a merger participant (currently just M31) -
        // build it with the disruptable/reddenable shader instead of the
        // plain PointsMaterial path below.
        disk = mergeableDiskPoints(pos, col, { size: 1.18, opacity: .66, seed: seed ^ 0x77 });
    } else {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
        const mat = new THREE.PointsMaterial({
            vertexColors: true,
            size: 1.18,
            sizeAttenuation: false,
            transparent: true,
            map: cosmicPointMap(),
            alphaTest: .015,
            opacity: .66,
            depthWrite: false,
            depthTest: true,
            blending: THREE.AdditiveBlending,
        });
        mat.userData.baseOpacity = .66;
        disk = new THREE.Points(geom, mat);
        disk.frustumCulled = false;
    }
    const coreMat = new THREE.SpriteMaterial({
        map: galaxyCoreTexture(colorA, colorB),
        transparent: true,
        opacity: .32,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    });
    coreMat.userData.baseOpacity = .32;
    const core = new THREE.Sprite(coreMat);
    core.scale.set(radius * .55, radius * .28, 1);
    core.frustumCulled = false;
    const group = new THREE.Group();
    group.add(disk, core);
    group.rotation.set(tilt || 0, seed * .017, (seed % 31) * .021);
    group.frustumCulled = false;
    if (opts.mergeable) group.userData.mergeUniforms = disk.material.uniforms;
    return group;
}

function galaxyHalo(radiusLy, seed, colorA, colorB, richness = 1) {
    const group = new THREE.Group();
    const haloCount = Math.max(240, Math.round(900 * richness));
    const clusterCount = Math.max(60, Math.round(160 * richness));
    const halo = points(sphericalCloud(haloCount, radiusLy * 2.6, seed ^ 0x51ed, colorA, colorB, 1.35, .82), .72, .22);
    const clusters = points(globularCloud(clusterCount, radiusLy * 2.05, seed ^ 0xa71, [.72, .82, 1], [1, .9, .66]), 1.75, .58);
    group.add(halo, clusters);
    group.frustumCulled = false;
    return group;
}

function milkyWayHalo() {
    const group = new THREE.Group();
    group.add(points(
        offsetCloud(sphericalCloud(4600, 210000, 48879, [.42, .52, .82], [.95, .82, .58], 1.08, .72), GALAXY.centerX, GALAXY.centerY, GALAXY.centerZ),
        .66,
        .18,
    ));
    group.add(points(
        offsetCloud(globularCloud(520, 165000, 48881, [.70, .82, 1], [1, .88, .62]), GALAXY.centerX, GALAXY.centerY, GALAXY.centerZ),
        1.65,
        .48,
    ));
    group.frustumCulled = false;
    return group;
}

function deepFieldLayer(count = 16000) {
    const rnd = mulberry32(0x9e3779);
    const radius = CAM_DIST_MAX * .78;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const u = rnd() * 2 - 1;
        const th = rnd() * Math.PI * 2;
        const side = Math.sqrt(Math.max(0, 1 - u * u));
        const r = radius * (.94 + rnd() * .04);
        pos[i * 3] = Math.cos(th) * side * r;
        pos[i * 3 + 1] = u * r;
        pos[i * 3 + 2] = Math.sin(th) * side * r;
        const warm = rnd() < .34;
        const base = warm ? [.92, .73, .52] : [.48, .60, .92];
        const hi = warm ? [1, .88, .67] : [.72, .82, 1];
        const c = colorMix(base, hi, Math.pow(rnd(), .55), (rnd() - .5) * .035);
        const gain = .45 + Math.pow(rnd(), 5.0) * .55;
        col[i * 3] = Math.max(0, Math.min(1, c[0] * gain));
        col[i * 3 + 1] = Math.max(0, Math.min(1, c[1] * gain));
        col[i * 3 + 2] = Math.max(0, Math.min(1, c[2] * gain));
    }
    const obj = points({ pos, col }, 1.25, .62);
    obj.material.depthTest = false;
    obj.material.userData.baseOpacity = .62;
    obj.renderOrder = -1;
    return obj;
}

function ring(cx, cy, cz, rLy, color, opacity) {
    const segs = 420;
    const pos = new Float32Array(segs * 3);
    for (let i = 0; i < segs; i++) {
        const a = i / segs * Math.PI * 2;
        pos[i * 3] = cx + Math.cos(a) * rLy * LY_SCENE;
        pos[i * 3 + 1] = cy;
        pos[i * 3 + 2] = cz + Math.sin(a) * rLy * LY_SCENE;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    mat.userData.baseOpacity = opacity;
    const line = new THREE.LineLoop(geom, mat);
    line.frustumCulled = false;
    return line;
}

// A ring in the real Galactic plane at galactocentric radius Rpc (parsecs),
// transformed into the equatorial scene frame so it tilts correctly.
function galacticPlaneRing(Rpc, color, opacity) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(galacticRingPositions(Rpc), 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    mat.userData.baseOpacity = opacity;
    const line = new THREE.LineLoop(geom, mat);
    line.frustumCulled = false;
    return line;
}

function addMovingGalaxy(cfg) {
    const group = new THREE.Group();
    group.name = cfg.name;
    const base = new THREE.Vector3(cfg.xLy * LY_SCENE, cfg.yLy * LY_SCENE, cfg.zLy * LY_SCENE);
    group.position.copy(base);
    const diskGroup = diskGalaxy(0, 0, 0, cfg.radiusLy, cfg.tilt || 0, cfg.colorA, cfg.colorB, cfg.seed, cfg.count || 9000, { mergeable: !!cfg.mergeable });
    group.add(diskGroup);
    group.add(galaxyHalo(cfg.radiusLy, cfg.seed, cfg.colorA, cfg.colorB, cfg.richness || 1));
    localRoot.add(group);
    const velocity = new THREE.Vector3();
    if (cfg.approachKmS) velocity.copy(base).normalize().multiplyScalar(-cfg.approachKmS * K);
    if (cfg.velocityKmS) velocity.add(new THREE.Vector3(cfg.velocityKmS[0] * K, cfg.velocityKmS[2] * K, -cfg.velocityKmS[1] * K));
    LOCAL_GALAXIES.push({ id: cfg.id, name: cfg.name, group, base, velocity, mergeUniforms: diskGroup.userData.mergeUniforms || null });
    return group;
}

// M31 ("m31") follows the WP23a two-body merger trajectory (see above);
// M33/LMC/SMC keep their original constant-velocity vectors, just no longer
// clamped to +-5 Gyr (they stay finite for any sim time on a straight line -
// no numerical-safety reason to clamp them, and clamping was only ever what
// froze M31 mid-approach).
function updateLocalGalaxyMotion() {
    const t = G.t;
    const gc = galacticCenterScene();
    diskRoot.position.set(gc[0] - GC_SCENE[0], gc[1] - GC_SCENE[1], gc[2] - GC_SCENE[2]);
    galaxyMotionRoot.quaternion.setFromAxisAngle(GALACTIC_NORTH_SCENE_AXIS, GALAXY_OMEGA0 * t);
    const era = eraModulation(t);
    const eraRed = era.redshiftTint;
    for (const g of LOCAL_GALAXIES) {
        if (g.id === "m31") {
            ensureMergerAxes(g.base);
            const { mwOffset, m31Pos } = mergerScenePositions();
            // Draw the pair in the Milky-Way-fixed frame. The Sun
            // (camera/origin) rides inside the MW, so its own disk has to stay
            // Sun-embedded. mwOffset is the MW's barycentric recoil, which grows
            // past the disk radius as M31 falls in; applying it to galaxyRoot
            // slid the whole disk off-origin into a detached arc. Keeping
            // galaxyRoot at -GC_SCENE holds the disk on the Sun, while M31 keeps
            // its correct closing geometry as the full relative separation
            // (m31Pos - mwOffset). The merger still reads through M31's approach
            // and the in-place disruption uniforms below.
            g.group.position.copy(m31Pos).sub(mwOffset);
            galaxyRoot.position.set(-GC_SCENE[0], -GC_SCENE[1], -GC_SCENE[2]);
            const disrupt = mergerDisruptFractionAt(t);
            setDisruptUniforms(g.mergeUniforms, disrupt, eraRed);
            setDisruptUniforms(mwDiskMergeUniforms, disrupt, eraRed);
        } else {
            g.group.position.set(
                g.base.x + g.velocity.x * t,
                g.base.y + g.velocity.y * t,
                g.base.z + g.velocity.z * t,
            );
        }
    }
}

function buildLocalGroup() {
    addMovingGalaxy({ id: "m31", name: "ANDROMEDA", xLy: 2537000, yLy: 18000, zLy: -420000, radiusLy: 110000, tilt: .35, colorA: [.56, .65, .9], colorB: [1, .82, .55], seed: 8102, approachKmS: 110, richness: 1.35, mergeable: true });
    addMovingGalaxy({ id: "m33", name: "TRIANGULUM", xLy: 1610000, yLy: -24000, zLy: 980000, radiusLy: 45000, tilt: -.25, colorA: [.54, .68, 1], colorB: [.9, .88, .74], seed: 8117, approachKmS: 44, richness: .85 });
    addMovingGalaxy({ id: "lmc", name: "LARGE MAGELLANIC CLOUD", xLy: -142000, yLy: -36000, zLy: 68000, radiusLy: 16000, colorA: [.62, .72, 1], colorB: [.95, .86, .7], seed: 8131, velocityKmS: [57, -226, 221], richness: .45 });
    addMovingGalaxy({ id: "smc", name: "SMALL MAGELLANIC CLOUD", xLy: -184000, yLy: -62000, zLy: 104000, radiusLy: 9500, colorA: [.58, .68, .96], colorB: [.9, .82, .68], seed: 8149, velocityKmS: [19, -153, 174], richness: .32 });
    localRoot.add(ring(0, 0, 0, 1200000, 0x31405b, .2));
    localRoot.add(ring(0, 0, 0, 3200000, 0x26344b, .16));
    const rnd = mulberry32(8814);
    const count = 1800;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const r = (180000 + Math.pow(rnd(), .6) * 2900000) * LY_SCENE;
        const th = rnd() * Math.PI * 2;
        pos[i * 3] = Math.cos(th) * r;
        pos[i * 3 + 1] = (rnd() - .5) * 360000 * LY_SCENE;
        pos[i * 3 + 2] = Math.sin(th) * r * .68;
        col[i * 3] = .62 + rnd() * .28;
        col[i * 3 + 1] = .68 + rnd() * .24;
        col[i * 3 + 2] = .82 + rnd() * .18;
    }
    localRoot.add(points({ pos, col }, 1.2, .42));
}

async function buildCosmicLayer() {
    if (!sceneRef || layerBuilt) return layerBuildPromise;
    if (layerBuilding) return layerBuildPromise;
    layerBuilding = true;
    const t0 = PERF.enabled ? performance.now() : 0;
    layerBuildPromise = (async () => {
        // The 170k Milky Way cloud is visually important but not needed for the
        // first solar-system frame. Generate it in slices so startup and play
        // remain responsive while the far-scale layer warms up.
        // WP23a: built with the disruptable/reddenable shader (mergeableDiskPoints)
        // instead of the plain points() helper, so the MW's own disk can puff
        // into "Milkomeda" alongside M31's disk during the merger.
        const mwCloud = await makeGalaxyCloudAsync(170000, 0x6d57, 4096, idleSlice);
        const mwDisk = mergeableDiskPoints(mwCloud.pos, mwCloud.col, { size: 1.20, opacity: .5, seed: 0x6d57 ^ 0x77 });
        mwDiskMergeUniforms = mwDisk.material.uniforms;
        galaxyRoot.add(mwDisk);
        await idleSlice();
        galaxyRoot.add(milkyWayHalo());
        galaxyRoot.add(galacticPlaneRing(8178, 0x53617a, .30));
        galaxyRoot.add(galacticPlaneRing(16000, 0x344058, .24));
        await idleSlice();
        // Curated destinations and the HYG catalog are drawn at every scale by
        // render/catalogStars.js (shared resolved-star material), not here.
        buildLocalGroup();
        await idleSlice();
        legacyDeepFieldObj = deepFieldLayer();
        deepRoot.add(legacyDeepFieldObj);
        deepRoot.frustumCulled = false;
        const deepApi = await ensureDeepFieldApi();
        // WP24's contract: initDeepField builds into its OWN camera-following
        // skybox group nested inside the group we hand it, so that group must
        // be a plain, non-animated Object3D at the scene root - NOT `deepRoot`,
        // which cosmic.js itself already recenters onto the camera every frame
        // for the legacy layer below (double-applying that would be wrong).
        // scene.js's farTierGroup is exactly that group.
        if (deepApi?.initDeepField) {
            try { deepApi.initDeepField(farTierGroup); } catch (err) { console.warn("deepField init failed", err); }
        }
        layerBuilt = true;
        cosmicVisualBucket = "";
        if (PERF.enabled) markPerf("cosmic.buildLayer", performance.now() - t0, {
            galaxyPoints: 170000,
            localGalaxies: LOCAL_GALAXIES.length,
        });
    })().catch(err => {
        console.warn("cosmic layer unavailable", err);
    }).finally(() => {
        layerBuilding = false;
    });
    return layerBuildPromise;
}

export function scheduleCosmicLayerBuild() {
    if (layerBuilt || layerBuilding || layerBuildScheduled || !sceneRef) return layerBuildPromise;
    layerBuildScheduled = true;
    const start = () => {
        layerBuildScheduled = false;
        buildCosmicLayer();
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(start, { timeout: 2400 });
    else setTimeout(start, 800);
    return layerBuildPromise;
}

export function initCosmicLayer(scene) {
    if (inited) return;
    inited = true;
    sceneRef = scene;
    root.frustumCulled = false;
    scene.add(root);
    scaleEl = document.getElementById("cosmicScale");
}

export function cosmicScaleLabel(dist = cam.dist) {
    const ly = dist / LY_SCENE;
    if (ly < .01) return (dist / (AU_KM * .001)).toFixed(2) + " AU";
    if (ly < 1000) return ly.toFixed(2) + " ly";
    if (ly < 1e6) return (ly / 1000).toFixed(1) + " kly";
    return (ly / 1e6).toFixed(2) + " Mly";
}


export function cycleCosmicScale() {
    scheduleCosmicLayerBuild();
    if (cam.dist < LY_SCENE * 1000) {
        cam.dist = COSMIC_ZOOMS.MILKY_WAY;
        G.focus = "free";
        cam.tgt.set(GALAXY.centerX, GALAXY.centerY, GALAXY.centerZ);
        toast("Scale: Milky Way · " + cosmicScaleLabel());
    } else if (cam.dist < LY_SCENE * 800000) {
        cam.dist = COSMIC_ZOOMS.LOCAL_GROUP;
        G.focus = "free";
        cam.tgt.set(900000 * LY_SCENE, 0, 160000 * LY_SCENE);
        toast("Scale: Local Group · " + cosmicScaleLabel());
    } else {
        cam.dist = COSMIC_ZOOMS.SOLAR;
        G.focus = "ship";
        toast("Scale: Solar System");
    }
}

export function updateCosmicLayer() {
    // The main loop skips body updates at cosmic scales. Reset metering here
    // so an Earth close-up cannot leave the galactic sky underexposed.
    if (cam.dist > LY_SCENE * .2) stellarExposure.value = 1;
    if (!inited) return;
    if (!layerBuilt) {
        if (cam.dist > LY_SCENE * .2) {
            scheduleCosmicLayerBuild();
            if (scaleEl) {
                scaleEl.style.opacity = "1";
                scaleEl.textContent = "COSMIC SCALE - warming";
            }
        }
        root.visible = false;
        return;
    }
    // LOD cross-fade tuned so a star field is ALWAYS visible while zooming:
    //  - near: 73 curated bright stars, accents up close
    //  - catalog: 119k real HYG stars — the dominant local field; kept bright and
    //    visible far out (real data spans kpc) so it overlaps the galaxy band
    //  - galaxy: procedural Milky Way band, fades in to back the catalog
    // The earlier tuning let the catalog die out (~300–2000 ly) before the galaxy
    // appeared, leaving an empty "dead zone" that flickered while zooming.
    const gal = smooth01(LY_SCENE * 40, LY_SCENE * 5000, cam.dist);
    const group = smooth01(LY_SCENE * 70000, LY_SCENE * 1200000, cam.dist);
    const deep = smooth01(LY_SCENE * 220000, LY_SCENE * 1600000, cam.dist);
    const galaxyVisible = gal > .01;
    const groupVisible = group > .01;
    const deepVisible = deep > .01;

    // Unconditional (not gated on groupVisible): the MW backdrop's own
    // barycentric merger wobble lives on galaxyRoot, which is visible over a
    // much wider zoom range than the Local Group view.
    updateLocalGalaxyMotion();
    if (deepFieldApi?.updateDeepField) {
        try { deepFieldApi.updateDeepField(camera, G.t); } catch (err) { console.warn("deepField update failed", err); }
    }
    const label = "COSMIC SCALE · " + cosmicScaleLabel();
    const bucket = [
        Math.round(gal * 100),
        Math.round(group * 100),
        Math.round(deep * 100),
        galaxyVisible ? 1 : 0,
        label,
    ].join("|");
    root.visible = galaxyVisible || groupVisible || deepVisible;
    diskRoot.visible = galaxyVisible;
    // The Milky Way's own light now comes from the volumetric model
    // (render/galaxyVolume.js); this legacy point cloud remains only as the
    // fallback when that layer is disabled (?galaxyvol=0).
    galaxyRoot.visible = galaxyVisible && !galaxyVolumeEnabled();
    localRoot.visible = groupVisible;
    deepRoot.visible = deepVisible;
    if (deepRoot.visible) deepRoot.position.copy(camera.position);
    // WP24 contract: once its own field has finished building, stop showing
    // cosmic.js's old fixed-16k decoration so the two don't double up - but
    // never before, so there is no frame with neither field visible.
    if (legacyDeepFieldObj && deepFieldApi?.deepFieldReady?.()) legacyDeepFieldObj.visible = false;

    // WP23c wiring contract: eraModulation(G.t) via applyEraToCloud multiplies
    // the procedural galaxy backdrop's color/intensity as star formation
    // declines over deep time. Real star catalogs (render/catalogStars.js)
    // are left alone - individual-star aging is WP23b's job, a different
    // mechanism. Runs every frame, NOT bucket-gated like the block below:
    // era keeps changing continuously under warp even on frames where the
    // camera-distance LOD factors haven't crossed a bucket boundary.
    const era = eraModulation(G.t);
    for (const child of galaxyRoot.children) {
        child.visible = galaxyVisible && !galaxyVolumeEnabled();
        if (child.material) {
            // mwDisk/rings historically render at the raw LOD value (their
            // authored baseOpacity was never actually consumed on this
            // path) - stash this frame's LOD value as the base applyEraToCloud
            // reads, so its base*lumFactor multiply reproduces that exactly,
            // with era's factor now composed in too.
            child.material.userData.baseOpacity = child.isPoints ? .18 + .72 * gal * (1 - group * .55) : .07 + .24 * gal * (1 - group * .55);
            applyEraToCloud(child, era);
        } else {
            // milkyWayHalo(): a Group of Points whose own authored
            // baseOpacity IS multiplied in (matches the setTreeOpacity call
            // this replaces).
            applyEraToCloud(child, { lumFactor: (.22 + .68 * gal) * (1 - group * .35) * era.lumFactor, redshiftTint: era.redshiftTint });
        }
    }
    applyEraToCloud(localRoot, { lumFactor: (.16 + .84 * group) * era.lumFactor, redshiftTint: era.redshiftTint });
    applyEraToCloud(deepRoot, { lumFactor: deep * era.lumFactor, redshiftTint: era.redshiftTint });

    if (bucket === cosmicVisualBucket) return;
    cosmicVisualBucket = bucket;
    if (scaleEl) {
        scaleEl.style.opacity = gal > .01 ? "1" : "0";
        scaleEl.textContent = label;
    }
}

export { CAM_DIST_MAX };
