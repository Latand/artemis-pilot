// CPU-only tests of the exact serialized observer; never imports a browser.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { installLensResizeObserver, wantsResizeDiagnostic, captureWithResizeEvidence, removeResizeObservers } from './lens-resize-observer.mjs';

const selected = { variant: 'main', mobile: false, bloom: true, phase: 'resize-1-alternate', scenario: 'saturn-near-lens', pitch: .48 };
assert(wantsResizeDiagnostic(selected));
assert(wantsResizeDiagnostic({ ...selected, phase: 'resize-2-alternate' }));
for (const delta of [{ variant: 'candidate' }, { mobile: true }, { bloom: false }, { phase: 'original' },
    { mobile: undefined }, { bloom: undefined }, { phase: 'resize-1-original' }, { scenario: 'disk-crossing' }, { pitch: 0 }]) assert(!wantsResizeDiagnostic({ ...selected, ...delta }));

function fixture(options = {}) {
    const listeners = object => Object.assign(object, { addEventListener(name, callback) { (this.events ||= {})[name] = callback; },
        removeEventListener(name, callback) { assert.equal(this.events?.[name], callback); delete this.events[name]; } });
    const array = (...values) => ({ toArray: () => values });
    const properties = new Map(), texture = name => {
        const t = listeners({ isTexture: true, name, version: 1, source: { version: 1 }, image: { width: 2, height: 1, complete: true },
            type: 1009, format: 1023, minFilter: 1006, magFilter: 1006 });
        properties.set(t, { __webglTexture: {}, __version: 1 }); return t;
    };
    const target = name => {
        const t = listeners({ width: 2, height: 1, samples: 0, texture: texture(`${name}-color`), depthTexture: texture(`${name}-depth`),
            viewport: array(0, 0, 2, 1), scissor: array(0, 0, 2, 1), scissorTest: false });
        properties.set(t, { __webglFramebuffer: {} }); return t;
    };
    const source = target('source'), destination = target('destination');
    const state = { target: source, active: 33990, draws: 0, readbacks: 0, uploaded: false, program: {} };
    const lensProgram = {}, vertex = {}, fragment = {};
    const uniformInfo = [
        { name: 'tDiffuse', type: 35678, size: 1 }, { name: 'tDepth', type: 35678, size: 1 },
        { name: 'uN', type: 5124, size: 1 }, { name: 'uC[0]', type: 35664, size: 4 },
    ];
    const gl = { FRAMEBUFFER_BINDING: 36006, READ_FRAMEBUFFER_BINDING: 36010, FRAMEBUFFER: 36160,
        FRAMEBUFFER_COMPLETE: 36053, FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 36048,
        FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 36049, FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: 36050,
        COLOR_ATTACHMENT0: 36064, DEPTH_ATTACHMENT: 36096, NONE: 0, TEXTURE: 5890,
        CURRENT_PROGRAM: 35725, ACTIVE_TEXTURE: 34016, TEXTURE0: 33984, TEXTURE_BINDING_2D: 32873,
        TEXTURE_2D: 3553, TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240,
        TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243, SAMPLER_BINDING: 35097, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661,
        LINK_STATUS: 35714, ACTIVE_UNIFORMS: 35718, SAMPLER_2D: 35678, COMPILE_STATUS: 35713,
        SHADER_TYPE: 35663, VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632,
        VIEWPORT: 2978, SCISSOR_BOX: 3088, SCISSOR_TEST: 3089, COLOR_WRITEMASK: 3107,
        DEPTH_WRITEMASK: 2930, DEPTH_FUNC: 2932, DEPTH_TEST: 2929,
        PIXEL_PACK_BUFFER_BINDING: 35053, RGBA: 6408, UNSIGNED_BYTE: 5121,
        getParameter(p) {
            if (p === this.FRAMEBUFFER_BINDING) return properties.get(state.target).__webglFramebuffer;
            if (p === this.READ_FRAMEBUFFER_BINDING) return options.wrongReadFramebuffer ? {} : properties.get(state.target).__webglFramebuffer;
            if (p === this.CURRENT_PROGRAM) return state.program;
            if (p === this.ACTIVE_TEXTURE) return state.active;
            if (p === this.MAX_COMBINED_TEXTURE_IMAGE_UNITS) return 16;
            if (p === this.TEXTURE_BINDING_2D) return properties.get(state.active === this.TEXTURE0 ? source.texture : source.depthTexture).__webglTexture;
            if (p === this.SAMPLER_BINDING) return null;
            if (p === this.VIEWPORT || p === this.SCISSOR_BOX) return new Int32Array([0, 0, 2, 1]);
            if (p === this.COLOR_WRITEMASK) return [true, true, true, true];
            if (p === this.DEPTH_WRITEMASK) return true;
            if (p === this.DEPTH_FUNC) return 519;
            if (p === this.PIXEL_PACK_BUFFER_BINDING) return options.packBuffer ? {} : null;
            throw Error(`Unexpected parameter ${p}`);
        },
        isEnabled: () => false, isContextLost: () => false,
        checkFramebufferStatus() { return options.incomplete ? 36054 : this.FRAMEBUFFER_COMPLETE; },
        getFramebufferAttachmentParameter(_, attachment, name) {
            if (name === this.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) return this.TEXTURE;
            if (name === this.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL) return 0;
            return properties.get(attachment === this.COLOR_ATTACHMENT0 ? state.target.texture : state.target.depthTexture).__webglTexture;
        },
        activeTexture(value) { state.active = value; },
        getProgramParameter(program, name) { assert.equal(program, lensProgram); return name === this.ACTIVE_UNIFORMS ? (options.tooManyUniforms ? 257 : uniformInfo.length) : true; },
        getActiveUniform(_, i) { return uniformInfo[i]; }, getUniformLocation: (_, name) => name,
        getUniform(_, name) {
            assert(state.uploaded, 'native inspection must follow uniform upload');
            return name === 'tDiffuse' ? 0 : name === 'tDepth' ? (options.invalidUnit ? -1 : 1) : name === 'uN' ? 2 : new Float32Array([.5, .75]);
        },
        getTexParameter() { if (options.queryThrows) throw Error('injected sampler query error'); return 9729; },
        getProgramInfoLog: () => '', getAttachedShaders: () => [vertex, fragment],
        getShaderParameter(shader, name) { return name === this.SHADER_TYPE ? (shader === vertex ? this.VERTEX_SHADER : this.FRAGMENT_SHADER) : true; },
        getShaderSource: shader => shader === vertex ? 'vertex source' : 'fragment source', getShaderInfoLog: () => '',
        readPixels(x, y, w, h, format, type, bytes) {
            assert.equal(state.target, source, 'read existing source, without rebinding');
            assert.equal(format, this.RGBA, 'raw depth must never be read'); assert.equal(type, this.UNSIGNED_BYTE);
            assert.equal(w, 2); assert.equal(h, 1); state.readbacks++; bytes.set([10, 20, 30, 255, 40, 50, 60, 255]);
        },
        drawArrays() { assert.equal(state.active, 33990); state.draws++; if (options.drawThrows && state.uploaded) throw Error('original native failure'); },
        drawElements() { assert.equal(state.active, 33990); state.draws++; },
    };
    const material = name => ({ name, type: 'ShaderMaterial', visible: true, color: array(1, 1, 1) });
    const object = (name, m) => ({ name, type: 'Mesh', isMesh: true, visible: true, material: m, layers: { mask: 1 },
        position: array(0, 0, 0), scale: array(1, 1, 1), quaternion: array(0, 0, 0, 1), matrixWorld: array(1), modelViewMatrix: array(1),
        geometry: { type: 'BufferGeometry', drawRange: { start: 0, count: Infinity }, index: null, attributes: { position: { count: 3 } } } });
    const world = object('world', material('world')), quad = object('lens', material('lens'));
    world.geometry.attributes.position = { version: 7, count: 3, itemSize: 3, normalized: false, usage: 35044, array: new Float32Array(9) };
    world.geometry.attributes.uv = { isInterleavedBufferAttribute: true, count: 3, itemSize: 2, offset: 0,
        data: { version: 8, count: 3, stride: 5, usage: 35044, array: new Float32Array(15) } };
    world.geometry.index = { version: 9, count: 3, itemSize: 1, array: new Uint16Array(3) };
    world.isInstancedMesh = true; world.count = 2; world.instanceMatrix = { version: 10, count: 2, itemSize: 16, array: new Float32Array(32) };
    const camera = { near: .02, far: 1e19, aspect: 2, fov: 48, position: array(0, 0, 600), projectionMatrix: array(1),
        projectionMatrixInverse: array(1), matrixWorld: array(1), matrixWorldInverse: array(1) };
    const renderer = { getContext: () => gl, getRenderTarget: () => state.target,
        properties: { get: value => properties.get(value) || {} }, domElement: { width: 2, height: 1 },
        renderBufferDirect(camera, scene, geometry, m) {
            if (m === quad.material) { state.uploaded = true; state.program = lensProgram; }
            gl.drawArrays(4, 0, 3);
        } };
    const lensPass = { material: quad.material, uniforms: { uN: { value: 1 }, tDiffuse: { value: null }, tDepth: { value: null } },
        render(r, write, read) {
            state.target = write; this.uniforms.tDiffuse.value = read.texture; this.uniforms.tDepth.value = read.depthTexture;
            r.renderBufferDirect(camera, {}, quad.geometry, quad.material, quad, null);
        } };
    const qa = { readbacks: 40, st: { G: { t: 0, paused: true } }, surface: { diskPlaneAssetQueue: () => ({ pending: 0, scheduled: false, inFlight: false }) },
        b: { plSurfaces: [{ material: { map: source.texture } }] }, sat: 0, hole: { holeRoot: { traverse: cb => cb(world) } },
        lens: { lensingPass: lensPass }, s: { renderer, camera, scene: { traverse: cb => cb(world) }, viewportSize: { w: 2, h: 1 }, renderQuality: { dpr: 1 },
            composer: { readBuffer: source, writeBuffer: destination, renderTarget1: source, renderTarget2: destination, passes: [lensPass] } } };
    const window = listeners({ qa, __diskPlaneFrameSuccess: 79 });
    const context = { window, btoa: binary => Buffer.from(binary, 'binary').toString('base64') };
    vm.runInNewContext(`(${installLensResizeObserver.toString()})()`, context);
    if (options.truncateEvents) for (let i = 0; i < 129; i++) source.events.dispose();
    const originals = { drawArrays: gl.drawArrays, drawElements: gl.drawElements, render: lensPass.render, direct: renderer.renderBufferDirect };
    const render = () => { state.uploaded = false; state.target = source; renderer.renderBufferDirect(camera, {}, world.geometry, world.material, world, null);
        lensPass.render(renderer, destination, source); return 'production-pixels'; };
    const run = phase => window.__diskPlaneObserveLensResize(phase, render);
    const restored = () => { assert.equal(gl.drawArrays, originals.drawArrays); assert.equal(gl.drawElements, originals.drawElements);
        assert.equal(lensPass.render, originals.render); assert.equal(renderer.renderBufferDirect, originals.direct); assert.equal(state.active, 33990); };
    return { qa, state, run, restored, dispose: () => window.__diskPlaneDisposeLensResize() };
}

const m = fixture();
for (const phase of ['resize-1-alternate', 'resize-2-alternate']) {
    const beforeDraws = m.state.draws, result = m.run(phase), trace = result.trace;
    assert.equal(result.value, 'production-pixels'); assert(trace.complete && trace.hooksRestored);
    assert.equal(m.state.draws - beforeDraws, 2, 'observer adds no native draws');
    assert.equal(trace.addedDraws, 0); assert.equal(trace.addedReadbacks, 1); assert.equal(trace.rawDepthTexelsObserved, false);
    assert.equal(trace.inventory.length, 1, 'shared scene/hole-root object is not duplicated');
    assert.equal(trace.inventory[0].geometry.attributes.position.version, 7);
    assert.equal(trace.inventory[0].geometry.attributes.uv.interleavedBuffer.version, 8);
    assert.equal(trace.inventory[0].geometry.index.arrayType, 'Uint16Array');
    assert.equal(trace.inventory[0].geometry.index.version, 9);
    assert.equal(trace.inventory[0].instanceCount, 2); assert.equal(trace.inventory[0].instanceMatrix.version, 10);
    assert.equal(trace.submittedDraws.length, 2); assert.equal(trace.nativeDraws.length, 2);
    const pass = trace.lensPasses[0];
    assert.equal(pass.cpuUniformsAfter.uN, 1); assert.equal(pass.nativeDraw.program.uniforms.uN.value, 2, 'actual uploaded value is independently observed');
    assert.equal(pass.nativeDraw.program.samplers[0].textureId, pass.source.color.gpuId);
    assert.equal(pass.nativeDraw.program.samplers[1].textureId, pass.source.depth.gpuId);
    assert.notEqual(pass.sourceBoundAtEntry.framebufferId, pass.nativeDraw.destinationBound.framebufferId);
    assert.deepEqual([...Buffer.from(pass.sourceColor.rgbaBase64, 'base64')], [10, 20, 30, 255, 40, 50, 60, 255]);
    m.restored();
}
assert.equal(m.state.readbacks, 2); assert.equal(m.qa.resizeDiagnosticReadbacks, 2);
const duplicate = m.run('resize-2-alternate');
assert(!duplicate.trace.complete); assert(duplicate.trace.errors.some(e => e.includes('two-capture authorization')));
assert.equal(m.state.readbacks, 2, 'duplicate phase must not read again'); m.restored();
assert.equal(m.dispose().removed, 7, 'remove one window, two target, and four texture listeners');
assert.equal(m.dispose().activeListeners, 0, 'cleanup is idempotent');
for (const option of ['wrongReadFramebuffer', 'incomplete', 'packBuffer']) {
    const m = fixture({ [option]: true }), result = m.run('resize-1-alternate');
    assert(!result.trace.complete && result.trace.errors.length > 0); assert.equal(m.state.readbacks, 0);
    assert.equal(m.state.draws, 2, 'failed diagnostic does not suppress production draws'); m.restored();
}
for (const option of ['queryThrows', 'invalidUnit', 'tooManyUniforms']) {
    const m = fixture({ [option]: true }), result = m.run('resize-1-alternate');
    assert(!result.trace.complete && result.trace.errors.length > 0); assert.equal(m.state.draws, 2);
    assert.equal(m.state.readbacks, 1); m.restored();
}
const throwing = fixture({ drawThrows: true });
assert.throws(() => throwing.run('resize-1-alternate'), /original native failure/); throwing.restored();
const truncated = fixture({ truncateEvents: true }).run('resize-1-alternate').trace;
assert(truncated.before.lifecycle.eventHistoryTruncated && truncated.truncated && !truncated.complete);
assert.equal(truncated.before.lifecycle.events.length, 128);

const complete = { complete: true, hooksRestored: true, addedReadbacks: 1, addedDraws: 0 };
for (const delta of [{ complete: false }, { hooksRestored: false }, { addedReadbacks: 0 }, { addedReadbacks: 2 }, { addedDraws: 1 }]) {
    let saved = false;
    await assert.rejects(captureWithResizeEvidence({ selected: true, capture: async () => ({ resizeDiagnostic: { ...complete, ...delta } }),
        save: async () => { saved = true; } }), /after evidence save/);
    assert(saved, 'invalid trace must be persisted before rejection');
}
const originalFailure = new Error('capture failed'), savedTrace = { partial: true };
let recoveredSaved = null;
await assert.rejects(captureWithResizeEvidence({ selected: true, capture: async () => { throw originalFailure; },
    recover: async () => savedTrace, save: async trace => { recoveredSaved = trace; } }), error => error === originalFailure);
assert.equal(recoveredSaved, savedTrace, 'raw partial observation survives a throwing production capture');
let persistenceError = null;
await assert.rejects(captureWithResizeEvidence({ selected: true, capture: async () => { throw originalFailure; },
    recover: async () => { throw Error('trace retrieval failed'); }, save: async () => {},
    onPersistenceError: error => { persistenceError = error; } }), error => error === originalFailure);
assert.match(persistenceError.message, /trace retrieval failed/);
assert.equal((await removeResizeObservers({ evaluate: async () => ({ complete: true, activeListeners: 0 }) })).complete, true);
await assert.rejects(removeResizeObservers({ evaluate: async () => { throw Error('page unavailable'); } }), /page unavailable/);
await assert.rejects(removeResizeObservers({ evaluate: () => new Promise(() => {}) }, 1), /timed out/);

const probe = readFileSync(new URL('./probe-disk-plane.mjs', import.meta.url), 'utf8');
assert(probe.includes("assert.equal(sample.productionSha256, previous.productionSha256, 'Repeated camera/resize restores exact settled frozen pixels')"));
assert(probe.includes('finalizeDiskProbe('), 'source-bound finalizer retained');
assert(probe.includes('const sourceBindingBefore = bindSources();'));
assert(probe.includes("if (variant === 'main' && !mobile && bloom)"), 'lifecycle listeners belong only to the eligible page');
assert(probe.includes('report.resizeObserverCleanup = await removeResizeObservers(observedPage)'), 'finalizer explicitly removes page listeners before closing the browser');
console.log('Lens-resize observer CPU smoke passed: exact two-capture selection, real-upload vs CPU values, attachment ownership, bounded color-only reads, unchanged draw count, missing/incomplete/duplicate/query failure controls, and finally restoration. No browser/GPU executed.');
