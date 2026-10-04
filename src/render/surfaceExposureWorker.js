import { integrateLongitudeRow, SURFACE_EXPOSURE_MAX_SOURCE_PIXELS, encodedSurfaceDimensions } from './surfaceExposureMath.js';

let running = null;
const now = () => performance.now();
const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
self.onmessage = ({ data: message }) => {
    if (message.type === 'cancel') {
        if (running?.id === message.id) { running.cancelled = true; running.controller.abort(); }
        return;
    }
    if (message.type !== 'build' || running) return;
    const job = running = { id: message.id, cancelled: false, controller: new AbortController() };
    const deadline = setTimeout(() => { job.cancelled = true; job.timedOut = true; job.controller.abort(); }, 15000);
    build(job, message).then(result => {
        if (job.cancelled) self.postMessage({ id: job.id, cancelled: true, error: job.timedOut ? 'Worker preparation timed out' : undefined });
        else self.postMessage({ id: job.id, ...result }, result.data ? [result.data.buffer] : []);
    }).catch(error => self.postMessage({ id: job.id, cancelled: job.cancelled,
        error: String(error?.message || error) })).finally(() => { clearTimeout(deadline); if (running === job) running = null; });
};
async function build(job, message) {
    const { source, width, height, srgb, flipY } = message, sw = source.width, sh = source.height;
    const maxSourcePixels = Math.min(SURFACE_EXPOSURE_MAX_SOURCE_PIXELS, message.maxSourcePixels || SURFACE_EXPOSURE_MAX_SOURCE_PIXELS);
    const maxEncodedBytes = Math.min(8 * 1024 * 1024, message.maxEncodedBytes || 8 * 1024 * 1024);
    if (!Number.isInteger(sw) || !Number.isInteger(sh) || sw < 1 || sh < 1 || sw * sh > maxSourcePixels ||
        !Number.isInteger(width) || width < 1 || width > 512 || width > sw || !Number.isInteger(height) || height < 1 || height > 256 || height > sh)
        throw new Error('Invalid bounded surface worker dimensions');
    const timings = { fetchMs: 0, decodeMs: 0, drawMs: 0, readMs: 0, mathMs: 0, maxReadMs: 0, maxMathMs: 0 };
    let bytes, bitmap, canvas, context;
    try {
        if (source.kind === 'bytes') {
            bytes = source.bytes;
            if (!(bytes instanceof Uint8Array) || bytes.length !== sw * sh * 4) throw new Error('Invalid source bytes');
        } else if (source.kind === 'url') {
            if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') throw new Error('Worker image readback unavailable');
            const url = new URL(source.url, self.location.href);
            if (url.origin !== self.location.origin) throw new Error('Cross-origin surface source is not supported');
            let start = now();
            const response = await fetch(url.href, { signal: job.controller.signal, credentials: 'same-origin', mode: 'same-origin', redirect: 'error' });
            if (!response.ok) throw new Error('Surface source fetch failed');
            const declared = Number(response.headers.get('content-length'));
            if (declared > maxEncodedBytes) throw new Error('Encoded surface source exceeds budget');
            const reader = response.body?.getReader();
            if (!reader) throw new Error('Bounded surface download unavailable');
            const chunks = []; let encodedBytes = 0;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    encodedBytes += value.byteLength;
                    if (encodedBytes > maxEncodedBytes) {
                        await reader.cancel(); throw new Error('Encoded surface source exceeds budget');
                    }
                    chunks.push(value);
                }
            } finally { reader.releaseLock(); }
            const blob = new Blob(chunks, { type: response.headers.get('content-type') || '' });
            chunks.length = 0;
            timings.fetchMs = now() - start;
            if (job.cancelled) return {};
            const header = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
            const dimensions = encodedSurfaceDimensions(header);
            if (!dimensions || dimensions.width !== sw || dimensions.height !== sh || dimensions.width * dimensions.height > maxSourcePixels)
                throw new Error('Unsupported or changed encoded surface dimensions');
            start = now(); bitmap = await createImageBitmap(blob); timings.decodeMs = now() - start;
            if (job.cancelled) return {};
            if (bitmap.width !== sw || bitmap.height !== sh) throw new Error('Decoded surface dimensions changed');
            canvas = new OffscreenCanvas(sw, Math.ceil(sh / height));
            context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) throw new Error('Worker canvas unavailable');
        } else throw new Error('Unsupported surface worker input');
        const data = new Float32Array((width + 1) * height * 4);
        for (let row = 0; row < height; row++) {
            if (job.cancelled) return {};
            const sourceRow = flipY ? height - 1 - row : row;
            const y0 = Math.floor(sourceRow * sh / height), y1 = Math.floor((sourceRow + 1) * sh / height);
            let strip;
            if (bytes) strip = bytes.subarray(y0 * sw * 4, y1 * sw * 4);
            else {
                let start = now(); context.clearRect(0, 0, sw, y1 - y0);
                context.drawImage(bitmap, 0, y0, sw, y1 - y0, 0, 0, sw, y1 - y0); timings.drawMs += now() - start;
                start = now(); strip = context.getImageData(0, 0, sw, y1 - y0).data;
                const ms = now() - start; timings.readMs += ms; timings.maxReadMs = Math.max(timings.maxReadMs, ms);
            }
            const start = now(); integrateLongitudeRow(data, strip, sw, y1 - y0, width, row, srgb);
            const ms = now() - start; timings.mathMs += ms; timings.maxMathMs = Math.max(timings.maxMathMs, ms);
            // Cancellation/fetch events remain responsive; this work is never
            // run in a main-thread idle callback even if a row readback stalls.
            if (row % 8 === 7) await yieldTask();
        }
        return { data, width, height, timings };
    } finally {
        bitmap?.close();
        if (canvas) { canvas.width = 1; canvas.height = 1; }
    }
}
