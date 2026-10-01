// Point layer for the procedural resolved star field (universe/resolvedField.js):
// one THREE.Points per (family, magnitude bin, material epoch), built in a
// worker and drawn with the shared resolved-star material, so a procedural
// star looks exactly like a catalog star of the same magnitude and colour.
//
// Frames and motion: bar stars live in the bar's frame (galaxyModel
// patternAngles) and turn with it. Disk stars are material
// (galaxyDynamics.js): a mesh holds the stars of one epoch, in that epoch's
// frame; its matrix turns the frame by the orbital angle at the mesh's
// reference point, and the vertex shader adds each star's own differential
// rotation, an old star's crowding in the arms (universe/armTransport.js),
// and shows it while its epoch -- and, for a young star, the arms where it
// is now -- allow (starPointMaterial.js STAR_MOTION). Each mesh carries an exact float64
// frame->scene matrix rebuilt every frame (rotation with sim time, the Sun
// anchor, the render origin); its vertices are float32 offsets from a
// reference point near the camera, so precision is set by the distance to
// the camera, not to the Sun or the Galactic centre.
//
// Selection is rebuilt as the camera moves through an epoch's frame, as the
// disk shears or its old stars stream past it (the worker measures that
// drift), and at least every SELECTION_MAX_MYR; the next epoch
// is built a little before its hand-over begins (in either time direction).
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
import { FAMILY_DISK, FAMILY_BAR, FIELD_BINS, binHasStars, binRadiusPc, shearRadMyr } from "../universe/resolvedField.js";
import { patternAngles, RESOLVED_MAG_LIMIT, mwSample, MW } from "../universe/galaxyModel.js";
import { MYR_S, EPOCH, epochState, generationState, epochPhi, epochWeightAt, omegaRadMyr, wrapAngle } from "../universe/galaxyDynamics.js";
import { W2G, getSunGalAnchor, worldKmToGalInto, PC_KM } from "../universe/coords.js";
import { K } from "../constants.js";
import { getOrigin } from "../universe/renderOrigin.js";
import { PERF, markPerf } from "../perf.js";
import { galaxyMapTexture } from "./galaxyVolume.js";

const MAG_MIN = 6, MAG_STEP = 0.25;
// A disk selection is rebuilt at least this often (its epoch weight bound,
// wMax, covers this much time either side).
const SELECTION_MAX_MYR = 5;
// The next epoch is built this fraction of an epoch before its hand-over.
const PREBUILD = 0.1;
const state = {
    enabled: false, parent: null, worker: null, seed: 1, barMaterial: null,
    budget: 350000,
    mLim: RESOLVED_MAG_LIMIT,        // limit in force for every layer
    gen: 0, genMLim: RESOLVED_MAG_LIMIT, staging: null,
    meshes: new Map(),               // key -> THREE.Points
    counts: new Map(),               // key -> stars in its mesh
    built: new Map(),                // key -> { camF, tB, active, sfr, keep, gen }
    epochU: new Map(),               // epoch -> shared uniforms
    needed: [],                      // disk epochs needed now
    inflight: null, nextId: 1, idleUpdates: 0, guessAtGen: null,
    // budget controller memory at this camera position: the last completed
    // (limit, count), the faintest limit known to overflow the budget, and
    // where the camera was (galactocentric pc)
    lastCount: null, overLimit: Infinity, countCam: null,
    handleBuild: null, fallbackBusy: false,
    stats: { builds: 0, ms: 0, cached: 0 },
};
const mapU = { uGalMap: { value: null }, uMapNorm: { value: new THREE.Vector4(1, 1, 1, 1) }, uMapReady: { value: 0 },
    uArmP: { value: null }, uArmReady: { value: 0 } };
const _g = [0, 0, 0];
const _ang = {};
const _gs = { gens: [{}, {}] }, _es = { epochs: [{}, {}] };

const keyOf = (family, bin, e) => family === FAMILY_BAR ? `b:${bin}` : `d:${bin}:${e}`;

export function initResolvedField(parent, { seed = 1, mobile = false } = {}) {
    if (state.parent) return;
    const q = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
    if (q.get("field") === "0") return;
    state.parent = parent;
    state.seed = seed >>> 0;
    state.budget = Number(q.get("fieldbudget")) || (mobile ? 60000 : 350000);
    state.barMaterial = makeStarPointMaterial({ resolveLimit: false });
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
    return {
        enabled: state.enabled, stars: totalCount(), mLim: state.mLim, gen: state.gen, staging: !!state.staging, budget: state.budget,
        epochs: state.needed.slice(), meshes: state.meshes.size,
        idle: !state.enabled || (!state.inflight && !state.staging && state.idleUpdates > 2), ...state.stats,
    };
}

function rotZInto(g, theta, out) {
    const c = Math.cos(theta), s = Math.sin(theta);
    out[0] = g[0] * c - g[1] * s;
    out[1] = g[0] * s + g[1] * c;
    out[2] = g[2];
    return out;
}
// Galactocentric point -> the frame of a disk epoch e at tMyr: turned back
// along the circular orbit through it.
function galToEpoch(g, e, tMyr, out) {
    const a = epochPhi(e) + omegaRadMyr(Math.hypot(g[0], g[1])) * (tMyr - e * EPOCH.lengthMyr);
    return rotZInto(g, -a, out);
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

function frameAngle(mesh, tSec) {
    const ud = mesh.userData;
    if (ud.family === FAMILY_BAR) return patternAngles(tSec, _ang).bar;
    return epochPhi(ud.e) + ud.omRef * (tSec / MYR_S - ud.e * EPOCH.lengthMyr);
}

function placeMesh(mesh, tSec) {
    const ref = mesh.userData.ref;
    const L = frameToSceneLinear(frameAngle(mesh, tSec));
    anchorScene(_T0);
    const tx = L[0] * ref[0] + L[1] * ref[1] + L[2] * ref[2] + _T0[0];
    const ty = L[3] * ref[0] + L[4] * ref[1] + L[5] * ref[2] + _T0[1];
    const tz = L[6] * ref[0] + L[7] * ref[1] + L[8] * ref[2] + _T0[2];
    mesh.matrix.set(L[0], L[1], L[2], tx, L[3], L[4], L[5], ty, L[6], L[7], L[8], tz, 0, 0, 0, 1);
    mesh.matrixWorldNeedsUpdate = true;
}

// Uniforms every mesh of disk epoch e shares: time since its centre, its
// hand-over weight, and the spiral generations relative to its frame.
function epochUniforms(e) {
    let u = state.epochU.get(e);
    if (!u) {
        u = { uTau: { value: 0 }, uEpW: { value: 0 }, uGenC: { value: new THREE.Vector4() }, uGenWv: { value: new THREE.Vector4(1, 0, 1, 0) } };
        state.epochU.set(e, u);
    }
    return u;
}
function updateEpochUniforms(e, tSec) {
    const u = epochUniforms(e);
    u.uTau.value = tSec / MYR_S - e * EPOCH.lengthMyr;
    let w = 0;
    for (const ep of _es.epochs) if (ep.e === e) w = Math.max(w, ep.w);
    u.uEpW.value = w;
    const phi = epochPhi(e), g0 = _gs.gens[0], g1 = _gs.gens[1];
    u.uGenC.value.set(wrapAngle(phi - g0.base), g0.tau, wrapAngle(phi - g1.base), g1.tau);
    u.uGenWv.value.set(g0.w, g1.w, g0.wGas, g1.wGas);
}
// Disk epochs to hold meshes for: those carrying weight, and the next one
// (either time direction) shortly before its hand-over starts.
function neededEpochs(tMyr) {
    const L = EPOCH.lengthMyr, d = EPOCH.fade;
    const v = tMyr / L, c = Math.floor(v + 0.5), s = v - c;
    const out = [c];
    if (s > 0.5 - d - PREBUILD) out.push(c + 1);
    if (s < d - 0.5 + PREBUILD) out.push(c - 1);
    return out;
}

function makeMesh(res) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(res.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(res.color, 3));
    g.setAttribute("absMag", new THREE.BufferAttribute(res.absMag, 1));
    g.setAttribute("teffK", new THREE.BufferAttribute(res.teff, 1));
    const disk = res.family === FAMILY_DISK;
    let material = state.barMaterial, omRef = 0;
    if (disk) {
        g.setAttribute("evo", new THREE.BufferAttribute(res.evo, 2));
        omRef = omegaRadMyr(Math.hypot(res.ref[0], res.ref[1]));
        material = makeStarPointMaterial({
            resolveLimit: true, motion: true,
            uniforms: {
                ...mapU, ...epochUniforms(res.epoch),
                uRefE: { value: new THREE.Vector3(res.ref[0], res.ref[1], res.ref[2]) },
                uOmRef: { value: omRef },
            },
        });
    }
    const m = new THREE.Points(g, material);
    m.name = `resolved field ${disk ? `disk bin ${res.bin} epoch ${res.epoch}` : `bar bin ${res.bin}`}`;
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.renderOrder = -3;
    m.userData = { ref: res.ref, family: res.family, e: disk ? res.epoch : null, omRef };
    return m;
}
function dropMesh(key) {
    const old = state.meshes.get(key);
    if (!old) return;
    state.parent.remove(old);
    old.geometry.dispose();
    if (old.material !== state.barMaterial) old.material.dispose();
    state.meshes.delete(key);
    state.counts.delete(key);
}
function install(key, res) {
    dropMesh(key);
    if (!res.n) return;
    const mesh = makeMesh(res);
    state.meshes.set(key, mesh);
    state.counts.set(key, res.n);
    state.parent.add(mesh);
    placeMesh(mesh, state.lastT ?? 0);
}

// Every key the field should hold right now.
function neededKeys(out = []) {
    out.length = 0;
    for (let bin = 0; bin < FIELD_BINS; bin++) {
        if (binHasStars(bin, FAMILY_BAR)) out.push(keyOf(FAMILY_BAR, bin));
        if (binHasStars(bin, FAMILY_DISK)) for (const e of state.needed) out.push(keyOf(FAMILY_DISK, bin, e));
    }
    return out;
}
const _keys = [];

function onResult(res) {
    state.inflight = null;
    state.stats.builds++;
    state.stats.ms += res.ms;
    state.stats.cached = res.cached;
    if (PERF.enabled) markPerf("resolvedField.build", res.ms, { bin: res.bin, family: res.family, epoch: res.epoch, n: res.n });
    if (res.gen !== state.gen) return;
    const key = keyOf(res.family, res.bin, res.epoch);
    state.built.set(key, { camF: res.camF, tB: res.tB, active: res.active || null, sfr: res.sfr, keep: res.keep, gen: res.gen, drift: res.drift || 0 });
    if (res.overflow) { startGen(Math.max(MAG_MIN, state.genMLim - 1)); return; }
    if (state.staging) {
        state.staging.set(key, res);
        // nothing drawn there yet (a new epoch, a bin that was empty): show
        // it now rather than leave a gap until the whole set is rebuilt
        if (!state.meshes.has(key)) install(key, res);
        if (neededKeys(_keys).every(k => state.staging.has(k))) swapStaged();
    } else {
        install(key, res);
    }
    retuneLimit();
}
function swapStaged() {
    const staged = state.staging;
    for (const [key, r] of staged) install(key, r);
    for (const key of [...state.meshes.keys()]) if (!staged.has(key)) dropMesh(key);
    state.staging = null;
    state.mLim = state.genMLim;
}

function totalCount() {
    let n = 0;
    for (const v of state.counts.values()) n += v;
    return n;
}
// Keep the drawn count near the budget: lower m_lim in crowded fields, raise
// it back (toward the catalogs' 11) where the field is sparse.
function allBuilt() {
    for (const key of neededKeys(_keys)) if (state.built.get(key)?.gen !== state.gen) return false;
    return true;
}
// The count grows with the limit at a rate that depends on the view (0.35
// dex/mag in a uniform medium seen from inside; much steeper looking down
// onto the disk): once two limits have been counted here, their secant sets
// the step, and the limit is never raised back to one that overflowed.
const COUNT_MEMORY_PC = 300;
function retuneLimit() {
    if (state.staging || !allBuilt()) return;
    const n = totalCount(), m = state.genMLim;
    // forget counts made elsewhere
    const cam = state.lastDebugCam;
    if (!cam || !state.countCam || Math.hypot(cam[0] - state.countCam[0], cam[1] - state.countCam[1], cam[2] - state.countCam[2]) > COUNT_MEMORY_PC) {
        state.lastCount = null; state.overLimit = Infinity;
        state.countCam = cam ? cam.slice() : null;
    }
    const prev = state.lastCount;
    let slope = 0.35;
    if (prev && Math.abs(prev.m - m) >= MAG_STEP - 1e-9 && prev.n > 0 && n > 0) {
        slope = Math.min(1.5, Math.max(0.2, Math.log10(n / prev.n) / (m - prev.m)));
    }
    state.lastCount = { m, n };
    if (n > state.budget * 1.3) state.overLimit = Math.min(state.overLimit, m);
    let target = m;
    if (n > state.budget * 1.3) target = m - Math.max(MAG_STEP, Math.log10(n / state.budget) / slope);
    else if (n < state.budget * 0.45 && m < RESOLVED_MAG_LIMIT) target = m + Math.max(MAG_STEP, Math.log10(state.budget * 0.8 / Math.max(n, 1)) / slope);
    else return;
    target = Math.round(Math.min(RESOLVED_MAG_LIMIT, Math.max(MAG_MIN, target)) / MAG_STEP) * MAG_STEP;
    if (target > m) target = Math.min(target, state.overLimit - MAG_STEP);
    if (Math.abs(target - m) >= MAG_STEP - 1e-9) startGen(target);
}
// A first estimate of the affordable limit before any star is built: the
// catalogs' reach near the Sun, less away from it (the field then carries
// every resolved star), and less where stars are denser (for a uniform
// medium N(<m) ~ n 10^(0.6 m), so n x f costs 1.67 log10 f magnitudes).
const _gs0 = {};
function guessLimit(camG, sunG) {
    const dSun = Math.hypot(camG[0] - sunG[0], camG[1] - sunG[1], camG[2] - sunG[2]);
    const base = RESOLVED_MAG_LIMIT - 1.5 * Math.min(1.5, Math.max(0, Math.log10(Math.max(dSun, 1) / 100)));
    mwSample(camG[0], camG[1], camG[2], patternAngles(0, {}), null, 0, _gs0, 1e9, 1e9, 1e9);
    const f = (_gs0.young + _gs0.thin + _gs0.thick + _gs0.halo + _gs0.bar) / MW.jSun;
    const m = Math.min(RESOLVED_MAG_LIMIT, base - 1.67 * Math.log10(Math.max(f, 1)));
    return Math.max(MAG_MIN, Math.round(m / MAG_STEP) * MAG_STEP);
}
function startGen(mLim) {
    state.gen++;
    state.genMLim = mLim;
    state.built.clear();
    // Nothing drawn yet: install as results arrive; otherwise stage and swap.
    state.staging = totalCount() === 0 ? null : new Map();
    if (!state.staging) state.mLim = mLim;
}
// Largest weight epoch e has within SELECTION_MAX_MYR (+1) of tMyr: stars
// handed over beyond it cannot show before the selection is rebuilt.
function epochWeightBound(e, tMyr) {
    let w = 0;
    const span = SELECTION_MAX_MYR + 1;
    for (let k = -8; k <= 8; k++) w = Math.max(w, epochWeightAt(e, (tMyr + span * k / 8) * MYR_S));
    return Math.min(1, w + 0.02);
}

// Per frame. camWorldKm: camera position (world frame, heliocentric km);
// active: { gal: [x, y, z] galactocentric pc, radiusPc } of the active-star
// neighbourhood, or null; sfr / keep: era and merger factors of the volume.
export function updateResolvedField({ camWorldKm, tSec, sfr = 1, keep = 1, active = null, catalogMagLimit = 11 }) {
    if (!state.enabled) return;
    const tMyr = tSec / MYR_S;
    state.lastT = tSec;
    generationState(tSec, _gs);
    epochState(tSec, _es);
    const needed = neededEpochs(tMyr);
    state.needed = needed;
    for (const e of needed) updateEpochUniforms(e, tSec);
    for (const e of [...state.epochU.keys()]) if (!needed.includes(e)) state.epochU.delete(e);
    const mt = galaxyMapTexture();
    mapU.uGalMap.value = mt.texture;
    if (mt.norm) mapU.uMapNorm.value.copy(mt.norm);
    mapU.uMapReady.value = mt.full ? 1 : 0;
    mapU.uArmP.value = mt.arm;
    mapU.uArmReady.value = mt.arm ? 1 : 0;
    // epochs handed over: their stars are gone
    for (const [key, mesh] of [...state.meshes]) {
        if (mesh.userData.family === FAMILY_DISK && !needed.includes(mesh.userData.e)) dropMesh(key);
    }
    for (const key of [...state.built.keys()]) {
        if (key[0] === "d" && !needed.includes(Number(key.slice(key.lastIndexOf(":") + 1)))) state.built.delete(key);
    }
    if (state.staging) for (const key of [...state.staging.keys()]) {
        if (key[0] === "d" && !needed.includes(Number(key.slice(key.lastIndexOf(":") + 1)))) state.staging.delete(key);
    }
    for (const mesh of state.meshes.values()) placeMesh(mesh, tSec);
    if (state.staging && neededKeys(_keys).every(k => state.staging.has(k))) swapStaged();
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
    const camR = Math.hypot(_g[0], _g[1]), shear = shearRadMyr(camR);
    const barTheta = patternAngles(tSec, _ang).bar;
    const frames = [{ family: FAMILY_BAR, e: null }, ...needed.map((e, i) => ({ family: FAMILY_DISK, e, first: i === 0 }))];
    for (const fr of frames) {
        const disk = fr.family === FAMILY_DISK;
        const camF = disk ? galToEpoch(_g, fr.e, tMyr, [0, 0, 0]) : rotZInto(_g, -barTheta, [0, 0, 0]);
        const actF = active ? (disk ? active.gal.slice() : rotZInto(active.gal, -barTheta, [0, 0, 0])) : null;
        for (let bin = 0; bin < FIELD_BINS; bin++) {
            if (!binHasStars(bin, fr.family)) continue;
            const prev = state.built.get(keyOf(fr.family, bin, fr.e));
            let score;
            if (!prev) score = 1000 - bin * 0.01 + (disk ? (fr.first ? 5 : 0) : 6);   // unbuilt: current frames, faint (near, cheap) bins first
            else {
                const r = binRadiusPc(bin, state.genMLim);
                score = Math.hypot(camF[0] - prev.camF[0], camF[1] - prev.camF[1], camF[2] - prev.camF[2]) / Math.max(0.06 * r, 0.05);
                if (disk) {
                    // the disk shears past the camera, old stars stream
                    // through the arms past it; the selection's epoch weight
                    // bound runs out
                    const dt = Math.abs(tMyr - prev.tB);
                    score = Math.max(score, dt * shear / 0.06, dt * prev.drift / Math.max(0.06 * r, 0.05), dt / SELECTION_MAX_MYR);
                }
                if (r < 400 && ((actF === null) !== (prev.active === null) ||
                    (actF && Math.hypot(actF[0] - prev.active[0], actF[1] - prev.active[1], actF[2] - prev.active[2]) > 1))) score = Math.max(score, 1.5);
                if (Math.abs(sfr - prev.sfr) > 0.03 || Math.abs(keep - prev.keep) > 0.03) score = Math.max(score, 1.2);
            }
            if (score > 1 && score > bestScore) {
                bestScore = score;
                best = { family: fr.family, bin, e: fr.e, camF, active: actF };
            }
        }
    }
    if (!best) { state.idleUpdates++; return; }
    state.idleUpdates = 0;
    const disk = best.family === FAMILY_DISK;
    const sunF = disk ? galToEpoch(sunG, best.e, tMyr, [0, 0, 0]) : rotZInto(sunG, -barTheta, [0, 0, 0]);
    const params = {
        cam: disk ? [_g[0], _g[1], _g[2]] : best.camF, sun: sunF, ref: best.camF,
        active: best.active, activeR: active ? active.radiusPc : 0,
        sfr, keep, magLimit: state.genMLim, catalogMagLimit,
        maxStars: state.budget * 1.2,
    };
    if (disk) {
        params.epoch = best.e;
        params.tauB = tMyr - best.e * EPOCH.lengthMyr;
        params.wMax = epochWeightBound(best.e, tMyr);
    }
    const msg = { type: "build", id: state.nextId++, gen: state.gen, seed: state.seed, family: best.family, bin: best.bin, params };
    state.inflight = msg;
    const decorate = r => {
        r.active = best.active; r.sfr = sfr; r.keep = keep; r.camF = best.camF; r.tB = tMyr;
        r.epoch = disk ? best.e : null;
        return r;
    };
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
