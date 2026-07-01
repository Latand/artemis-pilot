// Tier-1 (AT-HYG, ~2.37M stars) tile fetch/decode/cache worker.
//
// Structured as pure functions (decode, byte-range math, fetch-with-fallback,
// IndexedDB helpers) with a thin `self.onmessage` glue on top, so a plain Node
// script can `import` the pure parts (decodeTileRecords, computeTileRange) and
// exercise them against public/data/athyg-tier1.bin on disk without a Worker,
// a DOM, or IndexedDB — see scripts/smoke-tier1-runtime.mjs. The `self.onmessage`
// assignment is guarded so importing this module outside a Worker global is a
// no-op rather than a ReferenceError.
//
// Record layout (must match scripts/build-athyg-tier1.mjs): 20 bytes/star —
// xPc,yPc,zPc (Float32 LE, heliocentric-equatorial parsec) + magX100, ciX1000,
// pmRaMasYrX10, pmDecMasYrX10 (Int16 LE). All reads go through a DataView with
// explicit little-endian flags rather than a platform-endian typed-array view,
// so decoding is correct regardless of host byte order.

export const RECORD_BYTES = 20;

/**
 * Byte range for an HTTP Range request covering `count` records starting at
 * `tileByteOffset` within the .bin file. `end` is inclusive, matching the
 * Range header convention (`bytes=start-end`).
 */
export function computeTileRange(tileByteOffset, count, recordBytes = RECORD_BYTES) {
    const start = tileByteOffset;
    const end = tileByteOffset + count * recordBytes - 1;
    return { start, end };
}

/**
 * Decode `count` 20-byte records out of `buffer` starting at absolute byte
 * offset `byteOffset`. `buffer` may be the whole .bin file (Node smoke path,
 * `byteOffset` = the tile's manifest byteOffset) or a single range-fetched
 * tile slice (runtime path, `byteOffset` = 0) — the caller picks which.
 */
export function decodeTileRecords(buffer, byteOffset, count, recordBytes = RECORD_BYTES) {
    const dv = new DataView(buffer);
    const positions = new Float32Array(count * 3);
    const magCi = new Int16Array(count * 2);
    const pm = new Int16Array(count * 2);
    for (let i = 0; i < count; i++) {
        const o = byteOffset + i * recordBytes;
        positions[i * 3] = dv.getFloat32(o, true);
        positions[i * 3 + 1] = dv.getFloat32(o + 4, true);
        positions[i * 3 + 2] = dv.getFloat32(o + 8, true);
        magCi[i * 2] = dv.getInt16(o + 12, true);
        magCi[i * 2 + 1] = dv.getInt16(o + 14, true);
        pm[i * 2] = dv.getInt16(o + 16, true);
        pm[i * 2 + 1] = dv.getInt16(o + 18, true);
    }
    return { count, positions, magCi, pm };
}

// Populated only if the host doesn't honor Range requests (see fetchTileBytes).
// Once set, every subsequent tile in this worker's lifetime slices from it
// instead of re-fetching, per the WP9 "cache all requested tiles from it" spec.
let fullBinCache = null;
let warnedRangeFallback = false;

export function _resetFetchStateForTests() {
    fullBinCache = null;
    warnedRangeFallback = false;
}

/**
 * Fetch the bytes for one tile. Prefers HTTP Range (206); if the host ignores
 * Range and returns a full 200 response, falls back to caching the whole file
 * once and slicing tiles out of it locally (warns once — this is a real perf
 * cliff, not a silent degradation).
 */
export async function fetchTileBytes(binUrl, tileByteOffset, count, recordBytes = RECORD_BYTES) {
    const nBytes = count * recordBytes;
    if (nBytes === 0) return new ArrayBuffer(0);
    if (fullBinCache) return fullBinCache.slice(tileByteOffset, tileByteOffset + nBytes);
    const { start, end } = computeTileRange(tileByteOffset, count, recordBytes);
    const res = await fetch(binUrl, { headers: { Range: `bytes=${start}-${end}` } });
    if (res.status === 206) return res.arrayBuffer();
    if (!res.ok) throw new Error(`athyg tile fetch HTTP ${res.status} for ${binUrl}`);
    if (!warnedRangeFallback) {
        warnedRangeFallback = true;
        console.warn("athygTileWorker: server ignored HTTP Range (got 200, not 206); falling back to a single whole-file fetch + local slicing for all Tier-1 tiles");
    }
    fullBinCache = await res.arrayBuffer();
    return fullBinCache.slice(tileByteOffset, tileByteOffset + nBytes);
}

async function fetchTileBytesWithRetry(binUrl, tileByteOffset, count, recordBytes) {
    try {
        return await fetchTileBytes(binUrl, tileByteOffset, count, recordBytes);
    } catch (err) {
        console.warn(`athygTileWorker: tile fetch failed (${err?.message || err}), retrying once`);
        return fetchTileBytes(binUrl, tileByteOffset, count, recordBytes);
    }
}

// --- IndexedDB tile cache ----------------------------------------------------
// Only referenced inside function bodies (never at module scope), so importing
// this file in Node — where `indexedDB` doesn't exist — is safe as long as
// these are never called.

const IDB_NAME = "athyg-tier1";
const IDB_STORE = "tiles";
const IDB_VERSION = 1;
let idbOpenPromise = null;
let idbWarnedUnavailable = false;

function openTileDb() {
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("indexedDB unavailable"));
    if (idbOpenPromise) return idbOpenPromise;
    idbOpenPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
        // Fires when an older connection (e.g. a stale tab) is holding the DB
        // open across a version bump and won't yield — without this handler
        // the open() call would hang forever instead of failing, and every
        // caller here (idbGetTile/idbPutTile) already treats a rejected
        // openTileDb() as a normal cache-miss/unavailable path.
        req.onblocked = () => reject(new Error("indexedDB open blocked by another connection"));
    });
    return idbOpenPromise;
}

export async function idbGetTile(tileId) {
    try {
        const db = await openTileDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readonly");
            const req = tx.objectStore(IDB_STORE).get(tileId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error || new Error("indexedDB get failed"));
        });
    } catch {
        return null; // cache miss/unavailable — the caller falls through to a network fetch.
    }
}

export async function idbPutTile(tileId, rawBuffer) {
    try {
        const db = await openTileDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, "readwrite");
            tx.objectStore(IDB_STORE).put(rawBuffer, tileId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error("indexedDB put failed"));
        });
    } catch (err) {
        if (!idbWarnedUnavailable) {
            idbWarnedUnavailable = true;
            console.warn(`athygTileWorker: IndexedDB cache unavailable (${err?.message || err}); continuing without a tile cache`);
        }
    }
}

/**
 * Load and decode one tile: IndexedDB cache, else Range-fetch (or the
 * whole-file fallback), storing a fresh network fetch into the cache.
 * Exported so athygTier1.js can call it directly on the main thread as a
 * fallback when the Worker itself fails to start.
 */
export async function loadAndDecodeTile(tileId, byteOffset, count, binUrl, recordBytes = RECORD_BYTES) {
    if (count === 0) return { tileId, count: 0, positions: new Float32Array(0), magCi: new Int16Array(0), pm: new Int16Array(0), fromCache: false };
    let raw = await idbGetTile(tileId);
    let fromCache = !!raw;
    if (!raw) {
        raw = await fetchTileBytesWithRetry(binUrl, byteOffset, count, recordBytes);
        await idbPutTile(tileId, raw);
    }
    const decoded = decodeTileRecords(raw, 0, count, recordBytes);
    return { tileId, fromCache, ...decoded };
}

// `typeof self.postMessage === "function"` alone isn't a reliable "are we
// actually inside a dedicated Worker" check: bun's main-thread global scope
// also exposes a `self.postMessage`, so that guard alone registers a live
// `self.onmessage` listener even when this module is merely imported for its
// pure exports (e.g. from a Node/bun smoke script) — an event listener bun's
// process never fires but also never lets the event loop consider settled,
// hanging the process forever instead of letting the script exit. `importScripts`
// is a real Worker-only global (present on WorkerGlobalScope in both classic
// and module workers per spec, even though calling it is a no-op/throws in a
// module worker) and undefined in bun/Node/a plain browser main thread, so
// pairing it with the postMessage check reliably scopes this to a real Worker.
if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof importScripts === "function") {
    self.onmessage = async e => {
        const { type, tiles, binUrl, manifest } = e.data || {};
        if (type !== "loadTiles" || !Array.isArray(tiles)) return;
        const recordBytes = manifest?.recordBytes || RECORD_BYTES;
        for (const tileId of tiles) {
            const entry = manifest?.tiles?.[tileId];
            if (!entry) {
                self.postMessage({ type: "tileError", tileId, error: `no manifest entry for tile ${tileId}` });
                continue;
            }
            const [byteOffset, count] = entry;
            try {
                const { positions, magCi, pm, fromCache } = await loadAndDecodeTile(tileId, byteOffset, count, binUrl, recordBytes);
                self.postMessage(
                    { type: "tile", tileId, count, positions, magCi, pm, fromCache },
                    [positions.buffer, magCi.buffer, pm.buffer],
                );
            } catch (err) {
                self.postMessage({ type: "tileError", tileId, error: err?.message || String(err) });
            }
        }
    };
}
