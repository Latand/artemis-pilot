// Tier-1 streaming orchestration: the ~2.37M-star AT-HYG base layer (WP7's
// public/data/athyg-tier1.bin + athyg-tier1-manifest.json). This module owns
// tile-priority scheduling and the worker/IndexedDB/network plumbing; actual
// GPU buffers live in ../render/athygStars.js, decode/fetch primitives live in
// ../workers/athygTileWorker.js. Deliberately does not import main.js or
// scene.js — the caller hands in the THREE parent object and camera state.
//
// Tier-1 is a SKY-SCALE layer: at in-system distances every one of the 12,288
// tiles is "visible" simultaneously (it's the background sky, not a nearby
// object a frustum would cull), so tile selection is a *priority* problem, not
// a frustum-culling problem. Two priority sources feed the same per-frame
// budget (`tilesPerFrame`, default 8):
//   1. Tiles inside a ~40 degree cone around the current camera-forward
//      direction (queryDisc) — so wherever the player is actually looking
//      fills in first.
//   2. A fixed, deterministic global sweep order — tiles bucketed into 64
//      declination bands, then round-robin across bands (band0/tile0,
//      band1/tile0, ..., band0/tile1, ...) — so the whole sky fills in
//      roughly uniformly rather than face-by-face in raw nested-pixel id
//      order. Computed once from healpix.js's pure pix2ang_nest, no RNG.
// A loaded-tile bitmask guarantees no tile is ever fetched twice; a full sweep
// that still leaves gaps (tile errors) restarts automatically so a transient
// failure self-heals instead of leaving a permanent hole in the sky.

import { ORDER, NPIX, queryDisc, pix2ang_nest } from "./healpix.js";
import { createTileGroups, ingestTile, markResidualsDirty, pumpGroupResiduals, disposeGroups, groupStats } from "../render/athygStars.js";
import { loadAndDecodeTile } from "../workers/athygTileWorker.js";
import { PC_KM } from "./coords.js";
import { deriveStar, deriveStarVisualInto, ekerMassForL } from "./stellar.js";

const DEFAULT_MANIFEST_URL = "/data/athyg-tier1-manifest.json";
const DEFAULT_BIN_URL = "/data/athyg-tier1.bin";
const VIEW_CONE_DEG = 40;
const DEC_BANDS = 64;
const DEFAULT_TILES_PER_FRAME = 8;
// Residual-recompute budget for pumpResidualRefresh — see athygStars.js's
// pumpGroupResiduals doc comment for the worst-case stale-offset math this
// number feeds into (2.37M stars / 300k per call = 8 frames worst case).
const DEFAULT_RESIDUAL_STARS_PER_CALL = 300_000;
const TILE_CPU_KEEP = 2048;
// Cap on simultaneously in-flight main-thread fallback fetches (used only
// when the tile Worker itself couldn't start or crashed) — an unbounded
// Promise.all-style fan-out of hundreds/thousands of Range requests at once
// would just contend with itself and the browser's own per-origin connection
// limit; a small cap keeps a few requests always in flight without either
// starving other page activity or serializing tile loads one at a time.
const MAIN_THREAD_FETCH_CONCURRENCY = 4;

let state = null;
const nearestScratch = [];

function tier1DisabledByUrl() {
    if (typeof location === "undefined") return false;
    return new URLSearchParams(location.search).get("tier1") === "0";
}

// Deterministic global tile visiting order: interleave across declination
// bands. Pure function of healpix.js's pix2ang_nest (no RNG, no wall-clock).
export function computeGlobalPriorityOrder(order = ORDER, bands = DEC_BANDS) {
    const npix = 12 * (1 << order) * (1 << order);
    const buckets = Array.from({ length: bands }, () => []);
    for (let pix = 0; pix < npix; pix++) {
        const { decDeg } = pix2ang_nest(order, pix);
        let b = Math.floor((decDeg + 90) / 180 * bands);
        if (b >= bands) b = bands - 1;
        if (b < 0) b = 0;
        buckets[b].push(pix);
    }
    const out = new Int32Array(npix);
    let o = 0;
    for (let row = 0; o < npix; row++) {
        for (let b = 0; b < bands; b++) {
            if (row < buckets[b].length) out[o++] = buckets[b][row];
        }
    }
    return out;
}

function dirToRaDec(x, y, z) {
    const len = Math.hypot(x, y, z);
    if (!(len > 1e-12)) return null;
    let raDeg = Math.atan2(y, x) * 180 / Math.PI;
    if (raDeg < 0) raDeg += 360;
    const decDeg = Math.asin(Math.max(-1, Math.min(1, z / len))) * 180 / Math.PI;
    return { raDeg, decDeg };
}

// Accepts a plain {x,y,z}/[x,y,z]-shaped forward-direction vector in the same
// world-frame (heliocentric-equatorial) axes as the camera position, or
// null/undefined to skip view-cone prioritization for this call.
function normalizeCameraDir(cameraDirOrFrustum) {
    if (!cameraDirOrFrustum) return null;
    const d = cameraDirOrFrustum;
    if (Array.isArray(d) && d.length >= 3) return { x: d[0], y: d[1], z: d[2] };
    if (typeof d.x === "number" && typeof d.y === "number" && typeof d.z === "number") return d;
    return null;
}

function startWorker() {
    if (typeof Worker === "undefined") { state.workerFailed = true; return; }
    try {
        const worker = new Worker(new URL("../workers/athygTileWorker.js", import.meta.url), { type: "module" });
        worker.onmessage = e => {
            const msg = e.data || {};
            if (msg.type === "tile") onTileLoaded(msg.tileId, msg);
            else if (msg.type === "tileError") onTileError(msg.tileId, msg.error);
        };
        worker.onerror = err => {
            console.error("athygTier1: tile worker crashed, falling back to main-thread fetch:", err?.message || err);
            state.workerFailed = true;
            worker.terminate();
            if (state.worker === worker) state.worker = null;
            retryPendingOnMainThread();
        };
        state.worker = worker;
    } catch (err) {
        console.error("athygTier1: could not start tile worker, falling back to main-thread fetch:", err?.message || err);
        state.workerFailed = true;
    }
}

function onTileLoaded(tileId, msg) {
    if (!state) return;
    state.pending.delete(tileId);
    state.loaded[tileId] = 1;
    state.stats.tilesLoaded++;
    state.stats.starsLoaded += msg.count || 0;
    retainTileData(tileId, msg);
    ingestTile(state.groups, tileId, msg);
    resolveTilePromise(tileId, true);
}

function onTileError(tileId, error) {
    if (!state) return;
    state.pending.delete(tileId);
    state.stats.tileErrors++;
    console.error(`athygTier1: tile ${tileId} failed to load: ${error}`);
    // Deliberately NOT marked loaded — the next global-sweep wraparound in
    // updateTier1 will retry it, so a transient failure self-heals instead of
    // leaving a permanent gap in the sky.
    resolveTilePromise(tileId, false);
}

function retainTileData(tileId, msg) {
    const count = msg.count || 0;
    if (!count) return;
    const positions = new Float32Array(msg.positions);
    const mag = new Float32Array(count);
    const ci = new Float32Array(count);
    const magCi = msg.magCi;
    for (let i = 0; i < count; i++) {
        mag[i] = magCi[i * 2] / 100;
        ci[i] = magCi[i * 2 + 1] / 1000;
    }
    if (state.tileData.has(tileId)) state.tileData.delete(tileId);
    state.tileData.set(tileId, { positions, mag, ci });
    while (state.tileData.size > TILE_CPU_KEEP) {
        const oldest = state.tileData.keys().next().value;
        state.tileData.delete(oldest);
    }
}

function resolveTilePromise(tileId, ok) {
    const resolvers = state.tilePromises.get(tileId);
    if (!resolvers) return;
    state.tilePromises.delete(tileId);
    for (const resolve of resolvers) resolve(ok);
}

// Used both when the worker itself fails to start and when it crashes mid-run
// (worker.onerror above) so already-requested tiles aren't silently dropped.
async function retryPendingOnMainThread() {
    if (!state) return;
    runMainThreadFetchQueue(Array.from(state.pending));
}

async function fetchOneOnMainThread(tileId) {
    const entry = state.manifest.tiles[tileId];
    if (!entry) { onTileError(tileId, `no manifest entry for tile ${tileId}`); return; }
    const [byteOffset, count] = entry;
    try {
        const decoded = await loadAndDecodeTile(tileId, byteOffset, count, state.binUrl, state.manifest.recordBytes);
        onTileLoaded(tileId, decoded);
    } catch (err) {
        onTileError(tileId, err?.message || String(err));
    }
}

async function refetchTileCpuData(tileId) {
    if (state.cpuPending.has(tileId)) return;
    const entry = state.manifest.tiles[tileId];
    if (!entry) { onTileError(tileId, `no manifest entry for tile ${tileId}`); return; }
    const [byteOffset, count] = entry;
    state.cpuPending.add(tileId);
    try {
        const decoded = await loadAndDecodeTile(tileId, byteOffset, count, state.binUrl, state.manifest.recordBytes);
        retainTileData(tileId, decoded);
        resolveTilePromise(tileId, true);
    } catch (err) {
        onTileError(tileId, err?.message || String(err));
    } finally {
        state.cpuPending.delete(tileId);
    }
}

// Runs `fetchOneOnMainThread` over `tileIds` with at most
// MAIN_THREAD_FETCH_CONCURRENCY requests in flight at once, instead of firing
// every tile's fetch simultaneously (only reachable when the tile Worker
// itself failed to start or crashed — the common Worker path never calls
// this). A shared cursor across a small pool of self-relaunching workers is
// simpler than tracking a live "N in flight" counter and needs no per-tile
// bookkeeping beyond the index.
async function runMainThreadFetchQueue(tileIds) {
    let next = 0;
    const worker = async () => {
        while (next < tileIds.length) {
            const tileId = tileIds[next++];
            await fetchOneOnMainThread(tileId);
        }
    };
    const poolSize = Math.min(MAIN_THREAD_FETCH_CONCURRENCY, tileIds.length);
    await Promise.all(Array.from({ length: poolSize }, worker));
}

function requestTiles(tileIds) {
    if (!tileIds.length) return;
    const fresh = [];
    for (const t of tileIds) {
        if (state.loaded[t] || state.pending.has(t)) continue;
        state.pending.add(t);
        fresh.push(t);
    }
    if (!fresh.length) return;
    if (state.worker && !state.workerFailed) {
        state.worker.postMessage({ type: "loadTiles", tiles: fresh, binUrl: state.binUrl, manifest: state.manifest });
    } else {
        runMainThreadFetchQueue(fresh);
    }
}

/**
 * Fetch the manifest and stand up the (empty) group meshes + streaming
 * worker. Self-gating: reads `?tier1=0` from location.search itself, so it is
 * a no-op if instantiated with the flag present even before main.js (WP10)
 * wires anything up. Idempotent — a second call while already initialized
 * just returns the existing state.
 */
export async function initTier1({ scene, manifestUrl = DEFAULT_MANIFEST_URL, binUrl = DEFAULT_BIN_URL, tilesPerFrame = DEFAULT_TILES_PER_FRAME } = {}) {
    if (tier1DisabledByUrl()) return null;
    if (state) return state;
    if (!scene) throw new Error("initTier1 requires a scene/parent Object3D to attach star groups to");

    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`Tier-1 manifest fetch failed: HTTP ${res.status}`);
    const manifest = await res.json();
    const absBinUrl = new URL(binUrl, new URL(manifestUrl, location.href)).href;

    const groups = createTileGroups(scene, manifest);
    state = {
        manifest,
        binUrl: absBinUrl,
        parent: scene, // kept so disposeTier1 can remove group meshes from the scene graph
        groups,
        loaded: new Uint8Array(manifest.npix),
        pending: new Set(),
        cpuPending: new Set(),
        tileData: new Map(),
        tilePromises: new Map(),
        priorityOrder: computeGlobalPriorityOrder(manifest.order),
        sweepCursor: 0,
        worker: null,
        workerFailed: false,
        tilesPerFrame,
        stats: { tilesLoaded: 0, starsLoaded: 0, tileErrors: 0 },
        residualCursor: { groupIndex: 0 },
        residualDirtyGroups: 0,
    };
    startWorker();
    return state;
}

/**
 * Per-frame driver. `camWorldKmX/Y/Z` are the camera's world-frame (heliocentric
 * equatorial) kilometre position (unused directly today — Tier-1 tile
 * selection is priority-based, not distance-based — but part of the frozen
 * signature for forward compatibility with a future distance-aware scheme).
 * `cameraDirOrFrustum` is a {x,y,z} or [x,y,z] forward-direction vector in the
 * same axes, or null to skip view-cone prioritization this call.
 * `simTSeconds` is accepted for signature stability with the rest of the
 * universe update chain; Tier-1 stars don't move yet (see athygStars.js).
 * Also pumps at most one chunk of the residual-refresh backlog left by a
 * prior refreshResiduals() call (see pumpResidualRefresh) — this runs
 * unconditionally, even once tile streaming itself has reached steady
 * state, since a camera-origin rebase can happen at any point in a flight,
 * long after the ~25 minute full-sky load completes.
 * Zero-allocation once every tile has loaded AND no residual refresh is
 * pending (the common steady state) — see the early return below.
 */
export function updateTier1(camWorldKmX, camWorldKmY, camWorldKmZ, cameraDirOrFrustum, simTSeconds) {
    if (!state) return;
    if (state.residualDirtyGroups > 0) pumpResidualRefresh();
    if (state.stats.tilesLoaded >= state.manifest.npix) return; // steady state: nothing left to stream, no per-frame work or allocation.

    const toRequest = [];
    const dir = normalizeCameraDir(cameraDirOrFrustum);
    if (dir) {
        const radec = dirToRaDec(dir.x, dir.y, dir.z);
        if (radec) {
            const viewTiles = queryDisc(state.manifest.order, radec.raDeg, radec.decDeg, VIEW_CONE_DEG);
            for (let i = 0; i < viewTiles.length && toRequest.length < state.tilesPerFrame; i++) {
                const t = viewTiles[i];
                if (!state.loaded[t] && !state.pending.has(t)) toRequest.push(t);
            }
        }
    }

    const order = state.priorityOrder;
    let scanned = 0;
    while (toRequest.length < state.tilesPerFrame && scanned < order.length) {
        const t = order[state.sweepCursor];
        state.sweepCursor = (state.sweepCursor + 1) % order.length;
        scanned++;
        if (!state.loaded[t] && !state.pending.has(t)) toRequest.push(t);
    }

    if (toRequest.length) requestTiles(toRequest);
}

/**
 * Call contract: after `renderOrigin.maybeRebase(...)` returns true, call this
 * once, synchronously, to mark every loaded star's GPU residual dirty against
 * the new origin. This itself does NOT recompute anything — it only flags the
 * backlog and rewinds the resume cursor; updateTier1 then chews through it
 * incrementally via pumpResidualRefresh (see athygStars.pumpGroupResiduals
 * for the chunking scheme and its worst-case stale-offset justification).
 * A no-op if Tier-1 hasn't been initialized (or was disabled via ?tier1=0).
 */
export function refreshResiduals() {
    if (!state) return;
    markResidualsDirty(state.groups);
    state.residualCursor.groupIndex = 0;
    state.residualDirtyGroups = state.groups.reduce((n, g) => n + (g.residualDirty ? 1 : 0), 0);
}

/**
 * Recomputes up to `maxStarsPerCall` residuals of whatever refreshResiduals
 * left dirty, resuming across calls via `state.residualCursor`. Called
 * automatically once per updateTier1() invocation while a backlog remains;
 * exposed directly too so a caller with tighter control over its own frame
 * budget (e.g. wanting to burn spare time between other per-frame work) can
 * drive it explicitly instead. A no-op (returns done:true) if Tier-1 hasn't
 * been initialized or nothing is dirty.
 */
export function pumpResidualRefresh(maxStarsPerCall = DEFAULT_RESIDUAL_STARS_PER_CALL) {
    if (!state || state.residualDirtyGroups === 0) return { done: true, dirtyGroups: 0 };
    const result = pumpGroupResiduals(state.groups, state.residualCursor, maxStarsPerCall);
    state.residualDirtyGroups = result.dirtyGroups;
    return result;
}

// Fade factor (1 = full, 0 = gone) for the whole tier-1 field, driven per frame
// from camera distance so the Sun-bubble star cloud dissolves before the camera
// reaches galactic scale. A no-op until init; `last` guards the per-group uniform
// writes so a steady fade (the common case) touches nothing.
let lastTier1Fade = 1;
export function setTier1Fade(fade) {
    if (!state) return;
    const f = fade < 0 ? 0 : fade > 1 ? 1 : fade;
    if (Math.abs(f - lastTier1Fade) < .003) return;
    lastTier1Fade = f;
    const visible = f > .002;
    for (const g of state.groups) {
        if (!g.mesh) continue;
        g.mesh.material.uniforms.uFade.value = f;
        g.mesh.visible = visible;
    }
}

export function disposeTier1() {
    if (!state) return;
    if (state.worker) state.worker.terminate();
    disposeGroups(state.groups, state.parent);
    state = null;
}

export function tier1MassFor(tileId, idx) {
    if (!state || tier1DisabledByUrl()) return null;
    const data = state.tileData.get(tileId);
    if (!data || idx < 0 || idx >= data.mag.length) return null;
    const p = idx * 3;
    const x = data.positions[p], y = data.positions[p + 1], z = data.positions[p + 2];
    const mag = data.mag[idx];
    const distPc = Math.hypot(x, y, z);
    if (!(distPc > 0) || !Number.isFinite(mag)) return null;
    const absMag = mag - 5 * Math.log10(distPc / 10);
    const observedL = Math.pow(10, -0.4 * (absMag - 4.74));
    const mass = ekerMassForL(observedL);
    const visual = deriveStarVisualInto(mass, {});
    const full = deriveStar(mass);
    return { mass, L: visual.L, R: full.R, Teff: full.Teff, absMag, distPc };
}

export async function ensureTier1Tile(tileId) {
    if (!state || tier1DisabledByUrl()) return false;
    if (state.tileData.has(tileId)) return true;
    const promise = new Promise(resolve => {
        const existing = state.tilePromises.get(tileId);
        if (existing) existing.push(resolve);
        else state.tilePromises.set(tileId, [resolve]);
    });
    if (state.loaded[tileId]) {
        refetchTileCpuData(tileId);
    } else {
        requestTiles([tileId]);
    }
    return promise;
}

function insertNearestTier1(result, limit) {
    let i = nearestScratch.length;
    if (i >= limit && result.distFromCamPc >= nearestScratch[i - 1].distFromCamPc) return;
    if (i < limit) nearestScratch.push(result);
    i = Math.min(i, limit - 1);
    while (i > 0 && result.distFromCamPc < nearestScratch[i - 1].distFromCamPc) {
        nearestScratch[i] = nearestScratch[i - 1];
        i--;
    }
    nearestScratch[i] = result;
}

function prefetchTier1Tile(tileId) {
    if (state.loaded[tileId]) {
        refetchTileCpuData(tileId);
    } else {
        requestTiles([tileId]);
    }
}

export function nearestTier1(camWorldKm, coneDeg = 12, maxResults = 8) {
    nearestScratch.length = 0;
    if (!state || tier1DisabledByUrl() || !(maxResults > 0)) return nearestScratch;
    const cx = (camWorldKm?.x ?? camWorldKm?.[0] ?? 0) / PC_KM;
    const cy = (camWorldKm?.y ?? camWorldKm?.[1] ?? 0) / PC_KM;
    const cz = (camWorldKm?.z ?? camWorldKm?.[2] ?? 0) / PC_KM;
    const radec = dirToRaDec(cx, cy, cz);
    if (!radec) return nearestScratch;
    const tiles = queryDisc(state.manifest.order, radec.raDeg, radec.decDeg, coneDeg);
    for (const tileId of tiles) {
        const data = state.tileData.get(tileId);
        if (!data) { prefetchTier1Tile(tileId); continue; }
        for (let idx = 0; idx < data.mag.length; idx++) {
            const p = idx * 3;
            const x = data.positions[p], y = data.positions[p + 1], z = data.positions[p + 2];
            const d = Math.hypot(x - cx, y - cy, z - cz);
            insertNearestTier1({ tileId, idx, x, y, z, distFromCamPc: d, mag: data.mag[idx], ci: data.ci[idx] }, maxResults);
        }
    }
    return nearestScratch;
}

export function tier1PromotedDedupKey(tileId, idx) {
    if (tier1DisabledByUrl()) return null;
    return "t1:" + tileId + ":" + idx;
}

export function tier1Stats() {
    if (!state) return { initialized: false };
    const gs = groupStats(state.groups);
    return {
        initialized: true,
        totalTiles: state.manifest.npix,
        totalStars: state.manifest.count,
        tilesLoaded: state.stats.tilesLoaded,
        starsLoaded: state.stats.starsLoaded,
        tileErrors: state.stats.tileErrors,
        cpuTiles: state.tileData.size,
        pending: state.pending.size,
        drawCalls: gs.drawCalls,
        workerFallback: state.workerFailed,
        residualDirtyGroups: state.residualDirtyGroups,
    };
}
