import * as THREE from 'three';

// A display shutter in longitude only. Geometry, the epoch and the physical
// spin are never changed. A complete turn is its latitude-preserving mean,
// rather than a finite set of phases that can alias again at extreme warp.
import { SURFACE_EXPOSURE_MAX_WIDTH, SURFACE_EXPOSURE_MAX_HEIGHT, SURFACE_EXPOSURE_MAX_SOURCE_PIXELS, SURFACE_EXPOSURE_COMPACT_SOURCE_PIXELS,
    surfaceExposureTurns, integrateLongitudeRow } from './surfaceExposureMath.js';
export { SURFACE_EXPOSURE_MAX_WIDTH, SURFACE_EXPOSURE_MAX_HEIGHT, surfaceExposureTurns, buildLongitudeIntegral } from './surfaceExposureMath.js';

// Nearest-filtered float textures work without OES_texture_float_linear.
// Manual bilinear reads retain latitude and integrate the periodic longitude
// interval. The full-turn branch uses one longitude, so neither phase nor
// reverse time can create a new high-speed strobe.
export const SURFACE_EXPOSURE_GLSL = /* glsl */`
    vec4 surfacePrefix(sampler2D integralMap, vec2 uv, vec2 size) {
        vec2 p = vec2(clamp(uv.x, 0.0, 1.0) * size.x, clamp(uv.y * size.y - 0.5, 0.0, size.y - 1.0));
        vec2 lo = floor(p), hi = min(lo + 1.0, vec2(size.x, size.y - 1.0));
        vec2 f = fract(p), dimensions = vec2(size.x + 1.0, size.y);
        vec4 a = texture2D(integralMap, (lo + 0.5) / dimensions);
        vec4 b = texture2D(integralMap, (vec2(hi.x, lo.y) + 0.5) / dimensions);
        vec4 c = texture2D(integralMap, (vec2(lo.x, hi.y) + 0.5) / dimensions);
        vec4 d = texture2D(integralMap, (hi + 0.5) / dimensions);
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    vec4 surfaceLongitudeMean(sampler2D integralMap, float latitude, vec2 size) {
        float y = clamp(latitude * size.y - 0.5, 0.0, size.y - 1.0);
        vec2 dimensions = vec2(size.x + 1.0, size.y);
        vec4 a = texture2D(integralMap, vec2(size.x + 0.5, floor(y) + 0.5) / dimensions);
        vec4 b = texture2D(integralMap, vec2(size.x + 0.5, min(floor(y) + 1.0, size.y - 1.0) + 0.5) / dimensions);
        return mix(a, b, fract(y));
    }
    vec4 sampleSurfaceExposure(sampler2D sourceMap, sampler2D integralMap, vec2 uv, vec2 size, float turns) {
        // Missing/unreadable source pixels retain the ordinary material.
        if (turns <= 0.0 || size.x < 1.0) return texture2D(sourceMap, uv);
        float width = min(turns, 1.0);
        float blend = smoothstep(0.5, 2.0, width * size.x);
        if (blend <= 0.0) return texture2D(sourceMap, uv);
        vec4 mean = surfaceLongitudeMean(integralMap, uv.y, size);
        if (width >= 1.0) return mean;
        float center = fract(uv.x), left = center - width * 0.5, right = center + width * 0.5;
        vec4 integral = surfacePrefix(integralMap, vec2(fract(right), uv.y), size)
            - surfacePrefix(integralMap, vec2(fract(left), uv.y), size)
            + (floor(right) - floor(left)) * mean;
        vec4 exposed = max(vec4(0.0), integral / width);
        if (blend >= 1.0) return exposed;
        return mix(texture2D(sourceMap, uv), exposed, blend);
    }
`;

// A single worker owns image fetch/decode/readback and integration. The main
// thread only copies typed-array inputs in 64 KiB chunks and attaches results.
// Browsers without worker image support keep the exact source texture; they
// never fall back to potentially blocking main-thread canvas readback.
const sourceCache = new WeakMap(), readyEntries = new Set(), queue = [];
let scheduled = false, useCounter = 0, worker = null, workerFailed = false, inFlight = null, nextJobId = 0;
export const surfaceExposurePreparation = { pending: 0, readyBytes: 0, slices: 0, maxSliceMs: 0, built: 0, cacheHits: 0,
    workerJobs: 0, workerFailures: 0, cancelled: 0, exactFallbacks: 0,
    unsupportedImages: 0, imageFailures: 0, byteFallbacks: 0, lastFailure: '',
    mainSetupMs: 0, mainCopyMs: 0, mainMathMs: 0, mainAttachMs: 0,
    maxMainSetupMs: 0, maxMainCopyMs: 0, maxMainMathMs: 0, maxMainAttachMs: 0,
    workerFetchMs: 0, workerDecodeMs: 0, workerDrawMs: 0, workerReadMs: 0, workerMathMs: 0,
    workerMaxReadMs: 0, workerMaxMathMs: 0 };
const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
const lowMemory = () => (typeof navigator !== 'undefined' && navigator.deviceMemory <= 4) || (typeof window !== 'undefined' && window.innerWidth < 720);
const memoryLimit = () => (lowMemory() ? 8 : 24) * 1024 * 1024;
const syncPending = () => { surfaceExposurePreparation.pending = queue.length + (inFlight ? 1 : 0); };
function stage(name, start) {
    const ms = now() - start;
    surfaceExposurePreparation['main' + name + 'Ms'] += ms;
    const key = 'maxMain' + name + 'Ms';
    surfaceExposurePreparation[key] = Math.max(surfaceExposurePreparation[key], ms);
}
function cancelWorkerEntry(entry) {
    if (inFlight?.entry !== entry || inFlight.cancelled) return;
    inFlight.cancelled = true; surfaceExposurePreparation.cancelled++;
    worker?.postMessage({ type: 'cancel', id: inFlight.id });
}
function clearTexture(entry) {
    if (entry.texture) {
        surfaceExposurePreparation.readyBytes -= entry.texture.image.data.byteLength;
        readyEntries.delete(entry); entry.texture.dispose(); entry.texture = null;
    }
    for (const slot of entry.refs) { slot.texture = null; slot.uniform.value = null; slot.size.value.set(0, 0); }
}
function releaseSlot(slot) {
    const entry = slot.entry;
    slot.entry = null; slot.texture = null; slot.uniform.value = null; slot.size.value.set(0, 0);
    if (!entry) return;
    entry.refs.delete(slot);
    if (!entry.refs.size) {
        cancelWorkerEntry(entry);
        clearTexture(entry); entry.status = 'released'; entry.job = null;
        entry.source.removeEventListener?.('dispose', entry.onDispose);
        if (sourceCache.get(entry.source) === entry) sourceCache.delete(entry.source);
    }
}
function attachReady(entry) {
    for (const slot of entry.refs) {
        slot.texture = entry.texture; slot.uniform.value = entry.texture;
        slot.size.value.set(entry.width, entry.height);
    }
}
function failExact(entry, reason = 'Surface preparation unavailable') {
    surfaceExposurePreparation.lastFailure = reason;
    entry.status = 'failed'; entry.job = null; clearTexture(entry);
    surfaceExposurePreparation.exactFallbacks++;
}
function finishJob(entry, result) {
    const start = now(), { data, width, height } = result, bytes = data.byteLength;
    while (surfaceExposurePreparation.readyBytes + bytes > memoryLimit() && readyEntries.size) {
        const oldest = [...readyEntries].sort((a, b) => a.lastUse - b.lastUse)[0];
        clearTexture(oldest); oldest.status = 'evicted';
    }
    const texture = new THREE.DataTexture(data, width + 1, height, THREE.RGBAFormat, THREE.FloatType);
    texture.name = (entry.source.name || 'surface') + ':longitude-exposure';
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.NearestFilter; texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false; texture.flipY = false; texture.needsUpdate = true;
    entry.width = width; entry.height = height;
    entry.texture = texture; entry.job = null; entry.status = 'ready';
    surfaceExposurePreparation.readyBytes += bytes; surfaceExposurePreparation.built++;
    readyEntries.add(entry); attachReady(entry); stage('Attach', start);
}
function workerFailure() {
    workerFailed = true; surfaceExposurePreparation.workerFailures++;
    worker?.terminate(); worker = null;
    if (inFlight) {
        const flight = inFlight; clearTimeout(flight.timeout); inFlight = null;
        if (flight.entry.refs.size && flight.entry.status === 'worker') {
            // Typed-array sources have a bounded mathematical fallback. Image
            // failures retain exact sampling rather than re-reading the image.
            if (flight.kind === 'bytes') { surfaceExposurePreparation.byteFallbacks++; flight.entry.job = null; flight.entry.status = 'new'; enqueue(flight.entry); }
            else { surfaceExposurePreparation.imageFailures++; failExact(flight.entry, 'Image worker failed or timed out'); }
        }
    }
    syncPending(); schedulePreparation();
}
function ensureWorker() {
    if (workerFailed || typeof Worker === 'undefined') return null;
    if (!worker) {
        try {
            worker = new Worker(new URL('./surfaceExposureWorker.js', import.meta.url), { type: 'module' });
            worker.onerror = workerFailure;
            worker.onmessageerror = workerFailure;
            worker.onmessage = ({ data }) => {
                const start = now(), flight = inFlight;
                if (!flight || data.id !== flight.id) return;
                clearTimeout(flight.timeout); inFlight = null;
                const entry = flight.entry;
                if (entry.refs.size && entry.status === 'worker' && !flight.cancelled) {
                    if (!data.error && !data.cancelled && data.data instanceof Float32Array &&
                        data.width === entry.width && data.height === entry.height && data.data.length === (entry.width + 1) * entry.height * 4) {
                        const t = data.timings || {};
                        for (const name of ['Fetch', 'Decode', 'Draw', 'Read', 'Math']) surfaceExposurePreparation['worker' + name + 'Ms'] += t[name.toLowerCase() + 'Ms'] || 0;
                        surfaceExposurePreparation.workerMaxReadMs = Math.max(surfaceExposurePreparation.workerMaxReadMs, t.maxReadMs || 0);
                        surfaceExposurePreparation.workerMaxMathMs = Math.max(surfaceExposurePreparation.workerMaxMathMs, t.maxMathMs || 0);
                        finishJob(entry, data);
                    } else {
                        surfaceExposurePreparation.workerFailures++;
                        if (flight.kind === 'url') {
                            if (/unavailable/.test(data.error || '')) surfaceExposurePreparation.unsupportedImages++;
                            else surfaceExposurePreparation.imageFailures++;
                        }
                        failExact(entry, data.error || 'Invalid worker result');
                    }
                }
                surfaceExposurePreparation.maxSliceMs = Math.max(surfaceExposurePreparation.maxSliceMs, now() - start);
                syncPending(); schedulePreparation();
            };
        } catch { workerFailure(); }
    }
    return worker;
}
function sourceInput(entry) {
    const image = entry.source.image;
    const sw = image?.naturalWidth || image?.width, sh = image?.naturalHeight || image?.height;
    if (!Number.isInteger(sw) || !Number.isInteger(sh) || sw < 1 || sh < 1 || sw > 8192 || sh > 8192 || sw * sh > (lowMemory() ? SURFACE_EXPOSURE_COMPACT_SOURCE_PIXELS : SURFACE_EXPOSURE_MAX_SOURCE_PIXELS)) return null;
    if (image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray)
        return image.data.length === sw * sh * 4 ? { kind: 'bytes', bytes: image.data, width: sw, height: sh } : null;
    if (typeof location === 'undefined') return null;
    try {
        const url = new URL(image.currentSrc || image.src, location.href);
        if (!image.currentSrc && !image.src || url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return null;
        return { kind: 'url', url: url.href, width: sw, height: sh };
    } catch { return null; }
}
function dispatch(entry, source) {
    const id = ++nextJobId;
    entry.status = 'worker'; entry.job = null;
    // The worker enforces its own 15 s work deadline. A longer main-thread
    // watchdog leaves room for delivery when a software-rendered frame stalls.
    inFlight = { id, entry, kind: source.kind, cancelled: false, timeout: setTimeout(workerFailure, 60000) };
    surfaceExposurePreparation.workerJobs++;
    try {
        worker.postMessage({ type: 'build', id, source, width: entry.width, height: entry.height,
            srgb: entry.source.colorSpace === THREE.SRGBColorSpace, flipY: entry.source.flipY,
            maxSourcePixels: lowMemory() ? SURFACE_EXPOSURE_COMPACT_SOURCE_PIXELS : SURFACE_EXPOSURE_MAX_SOURCE_PIXELS,
            maxEncodedBytes: (lowMemory() ? 4 : 8) * 1024 * 1024 }, source.kind === 'bytes' ? [source.bytes.buffer] : []);
    } catch { workerFailure(); }
    syncPending();
}
function beginJob(entry) {
    const source = sourceInput(entry);
    if (!source) { failExact(entry, 'Unsupported or oversized source'); return; }
    const width = entry.width = Math.min(source.width, lowMemory() ? 256 : SURFACE_EXPOSURE_MAX_WIDTH);
    const height = entry.height = Math.min(source.height, lowMemory() ? 128 : SURFACE_EXPOSURE_MAX_HEIGHT);
    if (ensureWorker()) {
        if (source.kind === 'url') { dispatch(entry, source); return; }
        entry.job = { source, copy: new Uint8Array(source.bytes.length), offset: 0 };
        entry.status = 'copying';
    } else if (source.kind === 'bytes') {
        entry.job = { source, data: new Float32Array((width + 1) * height * 4), width, height, row: 0,
            srgb: entry.source.colorSpace === THREE.SRGBColorSpace, flipY: entry.source.flipY };
        entry.status = 'building';
    } else { surfaceExposurePreparation.unsupportedImages++; failExact(entry, 'Image worker unavailable; exact source retained'); }
}
function advanceJob(entry) {
    const job = entry.job;
    if (entry.status === 'copying') {
        const start = now(), end = Math.min(job.offset + 65536, job.copy.length);
        job.copy.set(job.source.bytes.subarray(job.offset, end), job.offset); job.offset = end; stage('Copy', start);
        if (end === job.copy.length) dispatch(entry, { ...job.source, bytes: job.copy });
    } else {
        const start = now(), { source, row, width, height } = job, sw = source.width, sh = source.height;
        const sourceRow = job.flipY ? height - 1 - row : row;
        const y0 = Math.floor(sourceRow * sh / height), y1 = Math.floor((sourceRow + 1) * sh / height);
        integrateLongitudeRow(job.data, source.bytes.subarray(y0 * sw * 4, y1 * sw * 4), sw, y1 - y0, width, row, job.srgb);
        job.row++; stage('Math', start);
        if (job.row === height) finishJob(entry, job);
    }
}
function schedulePreparation() {
    if (scheduled || inFlight || !queue.length) return;
    scheduled = true;
    const run = deadline => {
        scheduled = false;
        const start = now(), budget = deadline?.didTimeout ? 2 : Math.max(.25, Math.min(2, deadline?.timeRemaining?.() ?? 2));
        const entry = queue.shift();
        if (entry?.refs.size && entry.status !== 'released' && entry.status !== 'failed') {
            try {
                if (!entry.job) { const setup = now(); beginJob(entry); stage('Setup', setup); }
                while (entry.job && now() - start < budget) advanceJob(entry);
                if (entry.job) queue.unshift(entry);
            } catch { failExact(entry); }
        }
        syncPending(); surfaceExposurePreparation.slices++;
        surfaceExposurePreparation.maxSliceMs = Math.max(surfaceExposurePreparation.maxSliceMs, now() - start);
        schedulePreparation();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 50 });
    else setTimeout(run, 0);
}
function enqueue(entry) {
    if (['queued', 'building', 'copying', 'worker'].includes(entry.status)) return;
    entry.status = 'queued'; queue.push(entry); syncPending(); schedulePreparation();
}
function prepareSlot(slot) {
    const source = slot.getMap(), version = source?.source?.version ?? 0;
    const signature = `${version}:${source?.flipY}:${source?.colorSpace}`;
    if (slot.source !== source || slot.signature !== signature) {
        releaseSlot(slot); slot.source = source; slot.signature = signature; slot.version = version;
        if (!source) return;
        let entry = sourceCache.get(source);
        if (!entry || entry.signature !== signature || entry.status === 'released') {
            entry = { source, signature, refs: new Set(), texture: null, job: null, status: 'new', lastUse: ++useCounter };
            entry.onDispose = () => { cancelWorkerEntry(entry); clearTexture(entry); entry.status = 'failed'; entry.job = null; };
            source.addEventListener?.('dispose', entry.onDispose); sourceCache.set(source, entry);
        } else surfaceExposurePreparation.cacheHits++;
        slot.entry = entry; entry.refs.add(slot);
    }
    const entry = slot.entry;
    if (!entry) return;
    entry.lastUse = ++useCounter;
    if (entry.status === 'ready') attachReady(entry);
    else if (entry.status === 'new' || entry.status === 'evicted') enqueue(entry);
}

// The caller installs shader sampling; this owns lazy, reusable integral maps.
// Exactly one integral per bound map, shared by all samples in this material.
export function configureSurfaceRotationExposure(material, uniforms, maps) {
    const turns = uniforms.uSurfaceExposureTurns ||= { value: 0 };
    const slots = maps.map(({ name, getMap }) => {
        const uniform = uniforms[name + 'Integral'] = { value: null };
        const size = uniforms[name + 'IntegralSize'] = { value: new THREE.Vector2() };
        return { getMap, uniform, size, source: undefined, version: -1, texture: null, entry: null };
    });
    const state = { turns, slots, active: false, disposed: false };
    material.userData.surfaceRotationExposure = state;
    material.addEventListener('dispose', () => {
        state.disposed = true; state.active = false;
        for (const slot of slots) releaseSlot(slot);
    });
    return state;
}

export function updateSurfaceRotationExposure(material, angularVelocity, simExposureSeconds) {
    const state = material?.userData.surfaceRotationExposure;
    if (!state || state.disposed) return false;
    const requestedTurns = surfaceExposureTurns(angularVelocity, simExposureSeconds);
    state.turns.value = 0; state.active = false;
    if (requestedTurns > .5 / SURFACE_EXPOSURE_MAX_WIDTH) {
        for (const slot of state.slots) {
            prepareSlot(slot);
            if (slot.size.value.x * requestedTurns > .5) state.active = true;
        }
    }
    if (state.active) state.turns.value = requestedTurns;
    return state.active;
}
