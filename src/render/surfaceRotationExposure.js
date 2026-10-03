import * as THREE from 'three';

// A display shutter in longitude only. Geometry, the epoch and the physical
// spin are never changed. A complete turn is its latitude-preserving mean,
// rather than a finite set of phases that can alias again at extreme warp.
export const SURFACE_EXPOSURE_MAX_WIDTH = 512;
export const SURFACE_EXPOSURE_MAX_HEIGHT = 256;
const TAU = Math.PI * 2;
const linearByte = Float64Array.from({ length: 256 }, (_, i) => {
    const c = i / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
});

export function surfaceExposureTurns(angularVelocity, simExposureSeconds) {
    if (!Number.isFinite(angularVelocity) || !Number.isFinite(simExposureSeconds)) return 0;
    return Math.min(1, Math.abs(angularVelocity * simExposureSeconds / TAU));
}

// Prefix integrals are normalized by longitude. RGB is averaged in linear
// light; alpha and non-colour maps are never sRGB decoded. No latitude mixing
// beyond a bounded area downsample, and no random/stochastic samples.
export function buildLongitudeIntegral(bytes, sourceWidth, sourceHeight, {
    srgb = false, flipY = false,
    maxWidth = SURFACE_EXPOSURE_MAX_WIDTH, maxHeight = SURFACE_EXPOSURE_MAX_HEIGHT,
} = {}) {
    if (!Number.isInteger(sourceWidth) || sourceWidth < 1 || !Number.isInteger(sourceHeight) || sourceHeight < 1 ||
        bytes?.length !== sourceWidth * sourceHeight * 4) throw new Error('Invalid longitude exposure pixels');
    const width = Math.max(1, Math.min(sourceWidth, Math.floor(maxWidth)));
    const height = Math.max(1, Math.min(sourceHeight, Math.floor(maxHeight)));
    const data = new Float32Array((width + 1) * height * 4);
    for (let y = 0; y < height; y++) {
        const sourceRow = flipY ? height - 1 - y : y;
        const y0 = Math.floor(sourceRow * sourceHeight / height), y1 = Math.floor((sourceRow + 1) * sourceHeight / height);
        const sums = [0, 0, 0, 0];
        for (let x = 0; x < width; x++) {
            const x0 = Math.floor(x * sourceWidth / width), x1 = Math.floor((x + 1) * sourceWidth / width);
            const pixel = [0, 0, 0, 0];
            for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
                const k = (sy * sourceWidth + sx) * 4;
                for (let c = 0; c < 4; c++) pixel[c] += srgb && c < 3 ? linearByte[bytes[k + c]] : bytes[k + c] / 255;
            }
            const out = (y * (width + 1) + x + 1) * 4;
            for (let c = 0; c < 4; c++) {
                sums[c] += pixel[c] / (y1 - y0) / sourceWidth;
                data[out + c] = sums[c];
            }
        }
    }
    return { data, width, height };
}

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

// Construction never runs in the render call. Idle slices process complete
// source row strips, retaining linear-light averaging without a full-image
// canvas readback. Earth cloud colour/shadow/alpha share the same source entry.
const sourceCache = new WeakMap(), readyEntries = new Set(), queue = [];
let scheduled = false, useCounter = 0;
export const surfaceExposurePreparation = { pending: 0, readyBytes: 0, slices: 0, maxSliceMs: 0, built: 0, cacheHits: 0 };
const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
const lowMemory = () => (typeof navigator !== 'undefined' && navigator.deviceMemory <= 4) || (typeof window !== 'undefined' && window.innerWidth < 720);
const memoryLimit = () => (lowMemory() ? 8 : 24) * 1024 * 1024;
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
function beginJob(entry) {
    const image = entry.source.image;
    const sw = image?.naturalWidth || image?.width, sh = image?.naturalHeight || image?.height;
    // Unsupported sources retain their ordinary texture; no other read route.
    if (!Number.isInteger(sw) || !Number.isInteger(sh) || sw < 1 || sh < 1 || sw > 8192 || sh > 8192) { entry.status = 'failed'; return; }
    const width = Math.min(sw, lowMemory() ? 256 : SURFACE_EXPOSURE_MAX_WIDTH);
    const height = Math.min(sh, lowMemory() ? 128 : SURFACE_EXPOSURE_MAX_HEIGHT);
    const bytes = image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray ? image.data : null;
    if (bytes && bytes.length !== sw * sh * 4) { entry.status = 'failed'; return; }
    let canvas, context;
    if (!bytes) {
        if (typeof document === 'undefined') { entry.status = 'failed'; return; }
        canvas = document.createElement('canvas'); canvas.width = sw; canvas.height = Math.ceil(sh / height) + 1;
        context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) { entry.status = 'failed'; return; }
    }
    entry.width = width; entry.height = height;
    entry.job = { image, sw, sh, width, height, bytes, canvas, context, row: 0,
        srgb: entry.source.colorSpace === THREE.SRGBColorSpace, flipY: entry.source.flipY,
        data: new Float32Array((width + 1) * height * 4) };
    entry.status = 'building';
}
function buildRow(job) {
    const { sw, sh, width, height, row, srgb } = job;
    const sourceRow = job.flipY ? height - 1 - row : row;
    const y0 = Math.floor(sourceRow * sh / height), y1 = Math.floor((sourceRow + 1) * sh / height);
    let bytes;
    if (job.bytes) bytes = job.bytes.subarray(y0 * sw * 4, y1 * sw * 4);
    else {
        job.context.clearRect(0, 0, sw, y1 - y0);
        job.context.drawImage(job.image, 0, y0, sw, y1 - y0, 0, 0, sw, y1 - y0);
        bytes = job.context.getImageData(0, 0, sw, y1 - y0).data;
    }
    const sums = [0, 0, 0, 0], pixel = [0, 0, 0, 0];
    for (let x = 0; x < width; x++) {
        pixel.fill(0);
        const x0 = Math.floor(x * sw / width), x1 = Math.floor((x + 1) * sw / width);
        for (let y = 0; y < y1 - y0; y++) for (let sx = x0; sx < x1; sx++) {
            const k = (y * sw + sx) * 4;
            for (let c = 0; c < 4; c++) pixel[c] += srgb && c < 3 ? linearByte[bytes[k + c]] : bytes[k + c] / 255;
        }
        const out = (row * (width + 1) + x + 1) * 4;
        for (let c = 0; c < 4; c++) { sums[c] += pixel[c] / (y1 - y0) / sw; job.data[out + c] = sums[c]; }
    }
    job.row++;
}
function finishJob(entry) {
    const job = entry.job, bytes = job.data.byteLength;
    while (surfaceExposurePreparation.readyBytes + bytes > memoryLimit() && readyEntries.size) {
        const oldest = [...readyEntries].sort((a, b) => a.lastUse - b.lastUse)[0];
        clearTexture(oldest); oldest.status = 'evicted';
    }
    const texture = new THREE.DataTexture(job.data, job.width + 1, job.height, THREE.RGBAFormat, THREE.FloatType);
    texture.name = (entry.source.name || 'surface') + ':longitude-exposure';
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.NearestFilter; texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false; texture.flipY = false; texture.needsUpdate = true;
    entry.texture = texture; entry.job = null; entry.status = 'ready';
    surfaceExposurePreparation.readyBytes += bytes; surfaceExposurePreparation.built++;
    readyEntries.add(entry); attachReady(entry);
}
function schedulePreparation() {
    if (scheduled || !queue.length) return;
    scheduled = true;
    const run = deadline => {
        scheduled = false;
        const start = now(), budget = deadline?.didTimeout ? 2 : Math.max(.25, Math.min(2, deadline?.timeRemaining?.() ?? 2));
        const entry = queue.shift();
        if (entry?.refs.size && entry.status !== 'released' && entry.status !== 'failed') {
            try {
                if (!entry.job) beginJob(entry);
                // A row is the smallest atomic readback, bounded to 8192-wide
                // source strips; do not batch several full maps into a frame.
                while (entry.job && entry.job.row < entry.job.height && now() - start < budget) buildRow(entry.job);
                if (entry.job && entry.job.row === entry.job.height) finishJob(entry);
                else if (entry.job) queue.unshift(entry);
            } catch { entry.status = 'failed'; entry.job = null; clearTexture(entry); }
        }
        surfaceExposurePreparation.pending = queue.length;
        surfaceExposurePreparation.slices++;
        surfaceExposurePreparation.maxSliceMs = Math.max(surfaceExposurePreparation.maxSliceMs, now() - start);
        schedulePreparation();
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 50 });
    else setTimeout(run, 0);
}
function enqueue(entry) {
    if (entry.status === 'queued' || entry.status === 'building') return;
    entry.status = 'queued'; queue.push(entry);
    surfaceExposurePreparation.pending = queue.length; schedulePreparation();
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
            entry.onDispose = () => { clearTexture(entry); entry.status = 'failed'; entry.job = null; };
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
