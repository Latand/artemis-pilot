import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import * as THREE from 'three';
import { buildLongitudeIntegral, encodedSurfaceDimensions } from '../src/render/surfaceExposureMath.js';

// Execute the actual browser worker module in a worker_threads adapter. Image
// decode/readback and WebGL restore are exercised separately by hosted QA.
assert.deepEqual(encodedSurfaceDimensions(new Uint8Array([255,216,255,192,0,8,8,4,0,8,0,0])), { width: 2048, height: 1024 });
const pngHeader = new Uint8Array(24); pngHeader.set([137,80,78,71]); pngHeader.set([73,72,68,82],12);
const pngView = new DataView(pngHeader.buffer); pngView.setUint32(16,8192); pngView.setUint32(20,8192);
assert.deepEqual(encodedSurfaceDimensions(pngHeader), { width: 8192, height: 8192 });
assert.equal(encodedSurfaceDimensions(new Uint8Array([255,216,255,192,255,255])), null, 'truncated image metadata never reaches decode');
const instances = [];
class WorkerAdapter {
    static crashNext = false;
    static oversizedImageNext = false;
    constructor(url) {
        this.crash = WorkerAdapter.crashNext; WorkerAdapter.crashNext = false;
        this.jobs = 0; this.cancels = 0; this.probes = []; instances.push(this);
        const oversizedImage = WorkerAdapter.oversizedImageNext; WorkerAdapter.oversizedImageNext = false;
        const bootstrap = `const {parentPort}=require('node:worker_threads');
            globalThis.self={location:{href:'https://fixture.invalid/app/',origin:'https://fixture.invalid'},postMessage:(v,t)=>parentPort.postMessage(v,t)};
            if (${oversizedImage}) {
                globalThis.OffscreenCanvas=function(){throw Error('Unexpected canvas allocation');};
                globalThis.createImageBitmap=async()=>{parentPort.postMessage({probe:'decode-called'});throw Error('Unexpected decode');};
                globalThis.fetch=async(url,options)=>{parentPort.postMessage({probe:'fetch-options',mode:options.mode,redirect:options.redirect});return new Response(new Uint8Array(${JSON.stringify([...pngHeader])}),{headers:{'content-type':'image/png'}});};
            }
            import(${JSON.stringify(url.href)}).then(()=>parentPort.on('message',data=>self.onmessage({data})));`;
        this.worker = new NodeWorker(bootstrap, { eval: true }); this.worker.unref();
        this.worker.on('message', data => { if (data.probe) this.probes.push(data); else this.onmessage?.({ data }); });
        this.worker.on('error', error => this.onerror?.(error));
    }
    postMessage(message, transfer) {
        if (message.type === 'cancel') this.cancels++;
        if (message.type === 'build') {
            this.jobs++;
            if (this.crash) { this.crash = false; this.worker.terminate(); queueMicrotask(() => this.onerror?.(new Error('controlled worker crash'))); return; }
        }
        this.worker.postMessage(message, transfer);
    }
    terminate() { return this.worker.terminate(); }
}
globalThis.Worker = WorkerAdapter;
globalThis.location = { href: 'https://fixture.invalid/app/', origin: 'https://fixture.invalid' };
const module = await import('../src/render/surfaceRotationExposure.js?worker-smoke');
const wait = async (predicate, label) => {
    const start = performance.now();
    while (!predicate()) { assert(performance.now() - start < 10000, label); await new Promise(resolve => setTimeout(resolve, 2)); }
};
function material(api, bytes, width, height, { srgb = false, flipY = false } = {}) {
    const source = bytes === null ? new THREE.Texture({ width, height, src: 'https://fixture.invalid/app/surface.png' }) : new THREE.DataTexture(bytes, width, height, THREE.RGBAFormat);
    source.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; source.flipY = flipY; source.needsUpdate = true;
    const m = new THREE.MeshStandardMaterial({ map: source });
    api.configureSurfaceRotationExposure(m, {}, [{ name: 'test', getMap: () => m.map }]);
    return m;
}
try {
    for (const srgb of [false, true]) for (const flipY of [false, true]) {
        const bytes = Uint8Array.from({ length: 128 * 64 * 4 }, (_, i) => i * 31 % 256);
        const m = material(module, bytes, 128, 64, { srgb, flipY });
        assert.equal(module.updateSurfaceRotationExposure(m, 1, 100), false);
        await wait(() => module.surfaceExposurePreparation.pending === 0, 'real worker finishes');
        assert(module.updateSurfaceRotationExposure(m, 1, 100));
        const slot = m.userData.surfaceRotationExposure.slots[0];
        assert.deepEqual(slot.texture.image.data, buildLongitudeIntegral(bytes, 128, 64, { srgb, flipY }).data, 'worker prefix bytes equal the CPU oracle');
        assert.equal(bytes.byteLength, 128 * 64 * 4, 'transferring the bounded copy never detaches source pixels');
        const retained = slot.texture.image.data, previousVersion = slot.texture.version;
        slot.texture.needsUpdate = true;
        assert.equal(slot.texture.image.data, retained, 'CPU result remains resident for context-restoration upload');
        assert(slot.texture.version > previousVersion);
        m.dispose(); m.map.dispose();
    }
    assert.equal(instances.length, 1, 'one worker serves serial surface jobs');
    const big = new Uint8Array(1024 * 512 * 4).fill(80);
    const cancelled = material(module, big, 1024, 512);
    module.updateSurfaceRotationExposure(cancelled, 1, 100);
    await wait(() => cancelled.userData.surfaceRotationExposure.slots[0].entry.status === 'worker', 'cancellation reaches an in-flight job');
    cancelled.dispose();
    await wait(() => module.surfaceExposurePreparation.pending === 0, 'cancelled job acknowledges and drains');
    assert.equal(cancelled.userData.surfaceRotationExposure.slots[0].texture, null, 'late cancelled completion cannot resurrect a texture');
    assert(instances[0].cancels > 0);
    const shared = material(module, big, 1024, 512);
    const sharer = new THREE.MeshStandardMaterial({ map: shared.map });
    module.configureSurfaceRotationExposure(sharer, {}, [{ name: 'test', getMap: () => sharer.map }]);
    module.updateSurfaceRotationExposure(shared, 1, 100); module.updateSurfaceRotationExposure(sharer, 1, 100);
    await wait(() => shared.userData.surfaceRotationExposure.slots[0].entry.status === 'worker', 'shared source reaches worker');
    const cancelsBefore = instances[0].cancels; shared.dispose();
    assert.equal(instances[0].cancels, cancelsBefore, 'disposing one sharing owner does not cancel the others job');
    await wait(() => module.surfaceExposurePreparation.pending === 0, 'shared owner retains result');
    assert(module.updateSurfaceRotationExposure(sharer, 1, 100)); sharer.dispose();
    const replacement = material(module, big, 1024, 512);
    module.updateSurfaceRotationExposure(replacement, 1, 100);
    await wait(() => replacement.userData.surfaceRotationExposure.slots[0].entry.status === 'worker', 'replacement reaches in-flight job');
    const nextBytes = new Uint8Array(64 * 32 * 4).fill(190);
    replacement.map = new THREE.DataTexture(nextBytes, 64, 32, THREE.RGBAFormat); replacement.map.needsUpdate = true;
    module.updateSurfaceRotationExposure(replacement, 1, 100);
    await wait(() => module.surfaceExposurePreparation.pending === 0, 'replacement survives cancellation of stale input');
    assert(module.updateSurfaceRotationExposure(replacement, 1, 100));
    assert.deepEqual(replacement.userData.surfaceRotationExposure.slots[0].texture.image.data, buildLongitudeIntegral(nextBytes, 64, 32).data);
    replacement.dispose();
    const unsupported = material(module, null, 128, 64);
    module.updateSurfaceRotationExposure(unsupported, 1, 100);
    await wait(() => module.surfaceExposurePreparation.pending === 0, 'unsupported worker image path drains');
    assert.equal(module.updateSurfaceRotationExposure(unsupported, 1, 100), false, 'unsupported worker readback retains exact source sampling');
    assert.equal(unsupported.userData.surfaceRotationExposure.turns.value, 0);
    assert(module.surfaceExposurePreparation.unsupportedImages > 0, 'unsupported worker image behavior is recorded'); unsupported.dispose();
    WorkerAdapter.oversizedImageNext = true;
    const changedImage = await import('../src/render/surfaceRotationExposure.js?changed-image');
    const image = material(changedImage, null, 128, 64); changedImage.updateSurfaceRotationExposure(image, 1, 100);
    await wait(() => changedImage.surfaceExposurePreparation.pending === 0, 'changed encoded dimensions fail before decode');
    assert.equal(changedImage.updateSurfaceRotationExposure(image, 1, 100), false);
    assert.equal(changedImage.surfaceExposurePreparation.imageFailures, 1);
    assert.deepEqual(instances.at(-1).probes, [{ probe: 'fetch-options', mode: 'same-origin', redirect: 'error' }], 'oversized encoded image is rejected without allocating a decoded bitmap');
    image.dispose();
    const previousWindow = globalThis.window; globalThis.window = { innerWidth: 430 };
    try {
        const compact = await import('../src/render/surfaceRotationExposure.js?compact-limit');
        const oversized = material(compact, null, 4096, 1024); compact.updateSurfaceRotationExposure(oversized, 1, 100);
        await wait(() => compact.surfaceExposurePreparation.pending === 0, 'compact raw-image budget is enforced');
        assert.equal(compact.surfaceExposurePreparation.workerJobs, 0, 'oversized compact sources are rejected before worker fetch/decode');
        assert.equal(compact.updateSurfaceRotationExposure(oversized, 1, 100), false); oversized.dispose();
    } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
    WorkerAdapter.crashNext = true;
    const fallback = await import('../src/render/surfaceRotationExposure.js?worker-crash');
    const crashed = material(fallback, big, 1024, 512, { srgb: true, flipY: true });
    fallback.updateSurfaceRotationExposure(crashed, 1, 100);
    await wait(() => fallback.surfaceExposurePreparation.pending === 0, 'worker crash falls back to sliced byte integration');
    assert(fallback.updateSurfaceRotationExposure(crashed, 1, 100));
    assert.deepEqual(crashed.userData.surfaceRotationExposure.slots[0].texture.image.data, buildLongitudeIntegral(big, 1024, 512, { srgb: true, flipY: true }).data);
    assert(fallback.surfaceExposurePreparation.workerFailures > 0 && fallback.surfaceExposurePreparation.mainMathMs > 0);
    crashed.dispose();
    const originalTimeout = globalThis.setTimeout;
    class SilentWorker { postMessage() {} terminate() {} }
    globalThis.Worker = SilentWorker;
    globalThis.setTimeout = (callback, ms, ...args) => originalTimeout(callback, ms === 60000 ? 20 : ms, ...args);
    try {
        const timed = await import('../src/render/surfaceRotationExposure.js?worker-timeout');
        const m = material(timed, big, 1024, 512); timed.updateSurfaceRotationExposure(m, 1, 100);
        await wait(() => timed.surfaceExposurePreparation.pending === 0, 'silent worker deadline releases the queue');
        assert(timed.updateSurfaceRotationExposure(m, 1, 100));
        assert.equal(timed.surfaceExposurePreparation.byteFallbacks, 1, 'timeout uses one bounded byte fallback');
        m.dispose();
    } finally { globalThis.setTimeout = originalTimeout; }
    delete globalThis.Worker;
    const noWorker = await import('../src/render/surfaceRotationExposure.js?worker-absent');
    const imageFallback = material(noWorker, null, 128, 64);
    noWorker.updateSurfaceRotationExposure(imageFallback, 1, 100);
    await wait(() => noWorker.surfaceExposurePreparation.pending === 0, 'no-worker image fallback drains');
    assert.equal(noWorker.updateSurfaceRotationExposure(imageFallback, 1, 100), false);
    assert.equal(noWorker.surfaceExposurePreparation.mainMathMs, 0, 'image fallback does not perform hidden main-thread canvas work');
    assert(noWorker.surfaceExposurePreparation.unsupportedImages > 0); imageFallback.dispose();
    assert.equal(module.surfaceExposurePreparation.readyBytes, 0, 'worker results release with their last material owner');
    console.log('smoke-surface-worker passed: actual worker linear-light pixel identity, retained source/result buffers, one worker, cancellation/stale replacement, unsupported image exact fallback and crash byte fallback');
} finally {
    for (const instance of instances) await instance.terminate();
    delete globalThis.Worker; delete globalThis.location;
}
