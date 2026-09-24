// Point layer for the procedural resolved star field (universe/resolvedField.js):
// one THREE.Points per (frame family, magnitude bin), built in a worker and
// drawn with the shared resolved-star material, so a procedural star looks
// exactly like a catalog star of the same magnitude and colour.
//
// Frames: disk stars live in the frame co-rotating with the spiral pattern,
// bar stars in the bar's frame (galaxyModel.patternAngles). Each mesh carries
// an exact float64 frame->scene matrix rebuilt every frame (rotation with
// sim time, the Sun anchor, the render origin); its vertices are float32
// offsets from a reference point near the camera, so precision is set by the
// distance to the camera, not to the Sun or the Galactic centre.
//
// Resolve limit: the field draws stars brighter than apparent magnitude
// m_lim from the camera; the volumetric Milky Way and the catalog layers use
// the same m_lim (magLimit() below), so every star is either a point or part
// of the diffuse light, never both. m_lim adapts to a star budget: it is 11
// (the catalogs' reach) wherever that stays affordable and drops, in 0.25-mag
// steps, in the crowded inner Galaxy. A new limit takes effect for all layers
// at once, only when every bin has been rebuilt for it.
import * as THREE from "three";
import { makeStarPointMaterial } from "./starPointMaterial.js";
import { FAMILY_DISK, FAMILY_BAR, FIELD_BINS, binHasStars, binRadiusPc } from "../universe/resolvedField.js";
import { patternAngles, RESOLVED_MAG_LIMIT, mwSample, MW } from "../universe/galaxyModel.js";
import { W2G, getSunGalAnchor, worldKmToGalInto, PC_KM } from "../universe/coords.js";
import { K } from "../constants.js";
import { getOrigin } from "../universe/renderOrigin.js";
import { PERF, markPerf } from "../perf.js";

const FAMILIES = [FAMILY_DISK, FAMILY_BAR];
const MAG_MIN = 6, MAG_STEP = 0.25;
const state = {
    enabled: false, parent: null, worker: null, seed: 1, material: null,
    budget: 350000,
    mLim: RESOLVED_MAG_LIMIT,        // limit in force for every layer
    gen: 0, genMLim: RESOLVED_MAG_LIMIT, staging: null,
    meshes: FAMILIES.map(() => new Array(FIELD_BINS).fill(null)),
    counts: FAMILIES.map(() => new Float64Array(FIELD_BINS)),
    built: FAMILIES.map(() => new Array(FIELD_BINS).fill(null)),   // {cam, active, sfr, keep, gen}
    inflight: null, nextId: 1, lastParams: null, idleUpdates: 0, guessAtGen: null,
    handleBuild: null, fallbackBusy: false,
    stats: { builds: 0, ms: 0, cached: 0 },
};
const _g = [0, 0, 0];
const _ang = {};

export function initResolvedField(parent, { seed = 1, mobile = false } = {}) {
    if (state.parent) return;
    const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
    if (q.get("field") === "0") return;
    state.parent = parent;
    state.seed = seed >>> 0;
    state.budget = Number(q.get("fieldbudget")) || (mobile ? 60000 : 350000);
    state.material = makeStarPointMaterial({ resolveLimit: false });
    state.enabled = true;
    try {
        state.worker = new Worker(new URL("../workers/resolvedFieldWorker.js", import.meta.url), { type: "module" });
        state.worker.onmessage = e => onResult(e.data);
        state.worker.onerror = err => {
            console.warn("resolved field worker failed, building on the main thread:", err?.message || err);
            state.worker = null;
            state.inflight = null;
        };
    } catch (err) {
        state.worker = null;
    }
}

// Limit in force for the volumetric layer and the catalog point layers.
export function resolvedFieldMagLimit() { return state.enabled ? state.mLim : RESOLVED_MAG_LIMIT; }

export function resolvedFieldStatus() {
    let n = 0;
    for (const c of state.counts) for (const v of c) n += v;
    return {
        enabled: state.enabled, stars: n, mLim: state.mLim, gen: state.gen, staging: !!state.staging, budget: state.budget,
        idle: !state.enabled || (!state.inflight && !state.staging && state.idleUpdates > 2), ...state.stats,
    };
}

function galToFrame(g, theta, out) {
    const c = Math.cos(theta), s = Math.sin(theta);
    out[0] = g[0] * c + g[1] * s;
    out[1] = -g[0] * s + g[1] * c;
    out[2] = g[2];
    return out;
}

// Frame pc -> scene units: scene = L * p + T.
const _L = new Float64Array(9);
function frameToSceneLinear(theta, out = _L) {
    const c = Math.cos(theta), s = Math.sin(theta), k = PC_KM * K;
    // columns of Rz(theta) (frame -> galactocentric), F = diag(-1,1,1),
    // W2G^T (helio-galactic -> world), S: world -> scene (x, z, -y).
    const cols = [[c, s, 0], [-s, c, 0], [0, 0, 1]];
    for (let j = 0; j < 3; j++) {
        const g = cols[j];
        const h0 = -g[0], h1 = g[1], h2 = g[2];
        const wx = W2G[0][0] * h0 + W2G[1][0] * h1 + W2G[2][0] * h2;
        const wy = W2G[0][1] * h0 + W2G[1][1] * h1 + W2G[2][1] * h2;
        const wz = W2G[0][2] * h0 + W2G[1][2] * h1 + W2G[2][2] * h2;
        out[j] = wx * k; out[3 + j] = wz * k; out[6 + j] = -wy * k;
    }
    return out;
}
function anchorScene(out) {
    const a = getSunGalAnchor(), k = PC_KM * K, o = getOrigin();
    const h0 = -a[0], h1 = a[1], h2 = a[2];
    const wx = W2G[0][0] * h0 + W2G[1][0] * h1 + W2G[2][0] * h2;
    const wy = W2G[0][1] * h0 + W2G[1][1] * h1 + W2G[2][1] * h2;
    const wz = W2G[0][2] * h0 + W2G[1][2] * h1 + W2G[2][2] * h2;
    // scene of the galactocentric origin relative to the Sun: -(F anchor) mapped
    out[0] = -wx * k - o.x * K; out[1] = -wz * k - o.z * K; out[2] = wy * k + o.y * K;
    return out;
}
const _T0 = [0, 0, 0];

function frameAngle(family, tSec) {
    patternAngles(tSec, _ang);
    return family === FAMILY_BAR ? _ang.bar : _ang.spiral;
}

function placeMesh(mesh, family, tSec) {
    const ref = mesh.userData.ref;
    const L = frameToSceneLinear(frameAngle(family, tSec));
    anchorScene(_T0);
    const tx = L[0] * ref[0] + L[1] * ref[1] + L[2] * ref[2] + _T0[0];
    const ty = L[3] * ref[0] + L[4] * ref[1] + L[5] * ref[2] + _T0[1];
    const tz = L[6] * ref[0] + L[7] * ref[1] + L[8] * ref[2] + _T0[2];
    mesh.matrix.set(L[0], L[1], L[2], tx, L[3], L[4], L[5], ty, L[6], L[7], L[8], tz, 0, 0, 0, 1);
    mesh.matrixWorldNeedsUpdate = true;
}

function makeMesh(res) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(res.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(res.color, 3));
    g.setAttribute("absMag", new THREE.BufferAttribute(res.absMag, 1));
    g.setAttribute("teffK", new THREE.BufferAttribute(res.teff, 1));
    const m = new THREE.Points(g, state.material);
    m.name = `resolved field ${res.family === FAMILY_BAR ? "bar" : "disk"} bin ${res.bin}`;
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.renderOrder = -3;
    m.userData.ref = res.ref;
    return m;
}
function install(family, bin, res) {
    const old = state.meshes[family][bin];
    if (old) { state.parent.remove(old); old.geometry.dispose(); }
    state.meshes[family][bin] = res.n ? makeMesh(res) : null;
    if (state.meshes[family][bin]) state.parent.add(state.meshes[family][bin]);
    state.counts[family][bin] = res.n;
}

function onResult(res) {
    state.inflight = null;
    state.stats.builds++;
    state.stats.ms += res.ms;
    state.stats.cached = res.cached;
    if (PERF.enabled) markPerf("resolvedField.build", res.ms, { bin: res.bin, family: res.family, n: res.n });
    if (res.gen !== state.gen) return;
    const b = state.built[res.family];
    b[res.bin] = { cam: res.cam, active: res.active || null, sfr: res.sfr, keep: res.keep, gen: res.gen };
    if (res.overflow) { startGen(Math.max(MAG_MIN, state.genMLim - 1)); return; }
    if (state.staging) {
        state.staging.set(res.family * 1000 + res.bin, res);
        if (state.staging.size === state.staging.expected) {
            for (const r of state.staging.values()) install(r.family, r.bin, r);
            for (const family of FAMILIES) for (let bin = 0; bin < FIELD_BINS; bin++) {
                if (!state.staging.has(family * 1000 + bin) && state.meshes[family][bin]) install(family, bin, { n: 0 });
            }
            state.staging = null;
            state.mLim = state.genMLim;
        }
    } else {
        install(res.family, res.bin, res);
    }
    retuneLimit();
}

function totalCount() {
    let n = 0;
    for (const c of state.counts) for (const v of c) n += v;
    return n;
}
// Keep the drawn count near the budget: lower m_lim in crowded fields, raise
// it back (toward the catalogs' 11) where the field is sparse.
function allBuilt() {
    for (const family of FAMILIES) for (let bin = 0; bin < FIELD_BINS; bin++) {
        if (binHasStars(bin, family) && !state.built[family][bin]) return false;
    }
    return true;
}
function retuneLimit() {
    if (state.staging || !allBuilt()) return;
    const n = totalCount();
    let target = state.genMLim;
    if (n > state.budget * 1.3) target = state.genMLim - Math.max(MAG_STEP, Math.log10(n / state.budget) / 0.35);
    else if (n < state.budget * 0.45 && state.genMLim < RESOLVED_MAG_LIMIT) target = state.genMLim + Math.max(MAG_STEP, Math.log10(state.budget * 0.8 / Math.max(n, 1)) / 0.35);
    else return;
    target = Math.round(Math.min(RESOLVED_MAG_LIMIT, Math.max(MAG_MIN, target)) / MAG_STEP) * MAG_STEP;
    if (Math.abs(target - state.genMLim) >= MAG_STEP - 1e-9) startGen(target);
}
// A first estimate of the affordable limit before any star is built: the
// catalogs' reach near the Sun, less away from it (the field then carries
// every resolved star), and less where stars are denser (for a uniform
// medium N(<m) ~ n 10^(0.6 m), so n x f costs 1.67 log10 f magnitudes).
const _gs = {};
function guessLimit(camG, sunG) {
    const dSun = Math.hypot(camG[0] - sunG[0], camG[1] - sunG[1], camG[2] - sunG[2]);
    const base = RESOLVED_MAG_LIMIT - 1.5 * Math.min(1.5, Math.max(0, Math.log10(Math.max(dSun, 1) / 100)));
    mwSample(camG[0], camG[1], camG[2], patternAngles(0, {}), null, 0, _gs, 1e9, 1e9, 1e9);
    const f = (_gs.young + _gs.thin + _gs.thick + _gs.halo + _gs.bar) / MW.jSun;
    const m = Math.min(RESOLVED_MAG_LIMIT, base - 1.67 * Math.log10(Math.max(f, 1)));
    return Math.max(MAG_MIN, Math.round(m / MAG_STEP) * MAG_STEP);
}
function startGen(mLim) {
    state.gen++;
    state.genMLim = mLim;
    for (const b of state.built) b.fill(null);
    const expected = [];
    for (const family of FAMILIES) for (let bin = 0; bin < FIELD_BINS; bin++) if (binHasStars(bin, family)) expected.push(family * 1000 + bin);
    // Nothing drawn yet: install as results arrive; otherwise stage and swap.
    if (totalCount() === 0) { state.staging = null; state.mLim = mLim; return; }
    state.staging = new Map();
    state.staging.expected = expected.length;
}

// Per frame. camWorldKm: camera position (world frame, heliocentric km);
// active: { gal: [x, y, z] galactocentric pc, radiusPc } of the active-star
// neighbourhood, or null; sfr / keep: era and merger factors of the volume.
export function updateResolvedField({ camWorldKm, tSec, sfr = 1, keep = 1, active = null, catalogMagLimit = 11 }) {
    if (!state.enabled) return;
    for (const family of FAMILIES) {
        const meshes = state.meshes[family];
        for (let bin = 0; bin < FIELD_BINS; bin++) if (meshes[bin]) placeMesh(meshes[bin], family, tSec);
    }
    if (state.inflight || state.fallbackBusy) return;
    worldKmToGalInto(camWorldKm[0], camWorldKm[1], camWorldKm[2], _g);
    state.lastDebugCam = [_g[0], _g[1], _g[2]];
    const sunG = getSunGalAnchor();
    // Large moves shift the limit by the change in the estimate (keeping the
    // budget controller's learned offset); the controller refines it.
    const guess = guessLimit(_g, sunG);
    if (state.guessAtGen === null) {
        state.guessAtGen = guess;
        if (guess !== state.genMLim) startGen(guess);
    } else if (Math.abs(guess - state.guessAtGen) > 0.75) {
        const next = Math.max(MAG_MIN, Math.min(RESOLVED_MAG_LIMIT, state.genMLim + guess - state.guessAtGen));
        state.guessAtGen = guess;
        if (Math.abs(next - state.genMLim) >= MAG_STEP) startGen(Math.round(next / MAG_STEP) * MAG_STEP);
    }
    // Pick the bin most in need of a rebuild.
    let best = null, bestScore = 0;
    for (const family of FAMILIES) {
        const theta = frameAngle(family, tSec);
        const cam = galToFrame(_g, theta, [0, 0, 0]);
        const actF = active ? galToFrame(active.gal, theta, [0, 0, 0]) : null;
        for (let bin = 0; bin < FIELD_BINS; bin++) {
            if (!binHasStars(bin, family)) continue;
            const prev = state.built[family][bin];
            let score;
            if (!prev) score = 1000 - bin * 0.01;   // unbuilt: faint (near, cheap) bins first
            else {
                const r = binRadiusPc(bin, state.genMLim);
                score = Math.hypot(cam[0] - prev.cam[0], cam[1] - prev.cam[1], cam[2] - prev.cam[2]) / Math.max(0.06 * r, 0.05);
                if (r < 400 && ((actF === null) !== (prev.active === null) ||
                    (actF && Math.hypot(actF[0] - prev.active[0], actF[1] - prev.active[1], actF[2] - prev.active[2]) > 1))) score = Math.max(score, 1.5);
                if (Math.abs(sfr - prev.sfr) > 0.03 || Math.abs(keep - prev.keep) > 0.03) score = Math.max(score, 1.2);
            }
            if (score > 1 && score > bestScore) {
                bestScore = score;
                best = { family, bin, cam, active: actF, activeR: active ? active.radiusPc : 0 };
            }
        }
    }
    if (!best) { state.idleUpdates++; return; }
    state.idleUpdates = 0;
    const theta = frameAngle(best.family, tSec);
    const sun = galToFrame(sunG, theta, [0, 0, 0]);
    const params = {
        cam: best.cam, sun, ref: best.cam, active: best.active, activeR: best.activeR,
        sfr, keep, magLimit: state.genMLim, catalogMagLimit,
        maxStars: state.budget * 1.2,
    };
    const msg = { type: "build", id: state.nextId++, gen: state.gen, seed: state.seed, family: best.family, bin: best.bin, params };
    state.inflight = msg;
    const decorate = r => { r.active = best.active; r.sfr = sfr; r.keep = keep; return r; };
    if (state.worker) {
        state.worker.onmessage = e => onResult(decorate(e.data));
        state.worker.postMessage(msg);
    } else {
        // No worker: one bin per idle slice on the main thread.
        state.fallbackBusy = true;
        const run = async () => {
            if (!state.handleBuild) state.handleBuild = (await import("../workers/resolvedFieldWorker.js")).handleBuild;
            state.fallbackBusy = false;
            onResult(decorate(state.handleBuild(msg)));
        };
        (typeof requestIdleCallback === "function" ? requestIdleCallback(() => run(), { timeout: 200 }) : setTimeout(run, 0));
    }
}

// Debug/testing handle (capture scripts, smokes).
export function resolvedFieldDebug() {
    return { state, lastCam: state.lastDebugCam };
}
