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

const DEFAULT_MANIFEST_URL = "/data/athyg-tier1-manifest.json";
const DEFAULT_BIN_URL = "/data/athyg-tier1.bin";
const VIEW_CONE_DEG = 40;
const DEC_BANDS = 64;
const DEFAULT_TILES_PER_FRAME = 8;
// Residual-recompute budget for pumpResidualRefresh — see athygStars.js's
// pumpGroupResiduals doc comment for the worst-case stale-offset math this
// number feeds into (2.37M stars / 300k per call = 8 frames worst case).
const DEFAULT_RESIDUAL_STARS_PER_CALL = 300_000;
// Cap on simultaneously in-flight main-thread fallback fetches (used only
// when the tile Worker itself couldn't start or crashed) — an unbounded
// Promise.all-style fan-out of hundreds/thousands of Range requests at once
// would just contend with itself and the browser's own per-origin connection
// limit; a small cap keeps a few requests always in flight without either
// starving other page activity or serializing tile loads one at a time.
const MAIN_THREAD_FETCH_CONCURRENCY = 4;

let state = null;

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
    ingestTile(state.groups, tileId, msg);
}

function onTileError(tileId, error) {
    if (!state) return;
    state.pending.delete(tileId);
    state.stats.tileErrors++;
    console.error(`athygTier1: tile ${tileId} failed to load: ${error}`);
    // Deliberately NOT marked loaded — the next global-sweep wraparound in
    // updateTier1 will retry it, so a transient failure self-heals instead of
    // leaving a permanent gap in the sky.
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

export function disposeTier1() {
    if (!state) return;
    if (state.worker) state.worker.terminate();
    disposeGroups(state.groups, state.parent);
    state = null;
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
        pending: state.pending.size,
        drawCalls: gs.drawCalls,
        workerFallback: state.workerFailed,
        residualDirtyGroups: state.residualDirtyGroups,
    };
}
