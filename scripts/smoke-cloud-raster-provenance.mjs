// No browser, GL implementation, textures or production modules are needed.
import assert from 'node:assert/strict';
import { captureCloudRasterProvenance } from './cloud-raster-provenance.mjs';

function fake(options = {}) {
    const constants = ['NO_ERROR', 'NONE', 'INVALID_ENUM', 'INVALID_OPERATION', 'CONTEXT_LOST_WEBGL',
        'DRAW_FRAMEBUFFER_BINDING', 'READ_FRAMEBUFFER_BINDING', 'RENDERBUFFER_BINDING', 'CURRENT_PROGRAM',
        'VERSION', 'SHADING_LANGUAGE_VERSION', 'VENDOR', 'RENDERER', 'DEPTH_BITS', 'STENCIL_BITS', 'SAMPLES',
        'SAMPLE_BUFFERS', 'DEPTH_RANGE', 'DEPTH_FUNC', 'DEPTH_WRITEMASK', 'SUBPIXEL_BITS', 'MAX_SAMPLES',
        'DRAW_FRAMEBUFFER', 'READ_FRAMEBUFFER', 'DEPTH', 'DEPTH_ATTACHMENT', 'FRAMEBUFFER_DEFAULT',
        'FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE', 'FRAMEBUFFER_ATTACHMENT_OBJECT_NAME', 'FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE',
        'FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE', 'UNSIGNED_NORMALIZED', 'RENDERBUFFER', 'TEXTURE',
        'RENDERBUFFER_INTERNAL_FORMAT', 'RENDERBUFFER_DEPTH_SIZE', 'RENDERBUFFER_STENCIL_SIZE', 'RENDERBUFFER_SAMPLES',
        'RENDERBUFFER_WIDTH', 'RENDERBUFFER_HEIGHT', 'DEPTH_COMPONENT24', 'VERTEX_SHADER', 'FRAGMENT_SHADER',
        'LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT', 'LINK_STATUS', 'SHADER_TYPE', 'COMPILE_STATUS'];
    const gl = Object.fromEntries(constants.map((name, i) => [name, i + 1]));
    gl.NO_ERROR = gl.NONE = 0;
    const calls = [], errors = options.preexistingError ? [gl.INVALID_OPERATION] : [];
    const framebuffer = {}, readFramebuffer = {}, depth = {}, saved = options.savedNull ? null : {};
    const earthMaterial = {}, cloudMaterial = {}, earthProgram = {}, cloudProgram = {};
    const state = { draw: options.nondefault ? framebuffer : null,
        read: options.separateRead ? readFramebuffer : options.nondefault ? framebuffer : null,
        renderbuffer: saved, currentProgram: cloudProgram };
    const original = { ...state };
    const invoke = (name, args, fn) => {
        calls.push({ name, args });
        const issue = options.fault?.(name, args, gl, calls) || {};
        if (issue.throwBefore) throw new Error(issue.throwBefore);
        const result = fn();
        if (issue.glError) errors.push(issue.glError);
        if (issue.throwAfter) throw new Error(issue.throwAfter);
        return result;
    };
    const method = (name, fn) => { gl[name] = (...args) => invoke(name, args, () => fn(...args)); };
    method('getError', () => options.stickyError ? gl.CONTEXT_LOST_WEBGL : errors.shift() ?? gl.NO_ERROR);
    method('getParameter', pname => {
        const values = { DRAW_FRAMEBUFFER_BINDING: state.draw, READ_FRAMEBUFFER_BINDING: state.read,
            RENDERBUFFER_BINDING: state.renderbuffer, CURRENT_PROGRAM: state.currentProgram,
            VERSION: 'WebGL 2.0 fake', SHADING_LANGUAGE_VERSION: 'WebGL GLSL ES 3.00 fake', VENDOR: 'fake', RENDERER: 'fake',
            DEPTH_BITS: 24, STENCIL_BITS: 0, SAMPLES: 4, SAMPLE_BUFFERS: 1, DEPTH_RANGE: new Float32Array([0, 1]),
            DEPTH_FUNC: 515, DEPTH_WRITEMASK: true, SUBPIXEL_BITS: 8, MAX_SAMPLES: 4 };
        const key = Object.keys(values).find(name => gl[name] === pname);
        if (!key) { errors.push(gl.INVALID_ENUM); return null; }
        return values[key];
    });
    method('getContextAttributes', () => ({ antialias: true, depth: true, alpha: true }));
    method('isContextLost', () => false);
    const translated = {};
    translated.getTranslatedShaderSource = shader => invoke('getTranslatedShaderSource', [shader], () => `translated ${shader.source}`);
    method('getExtension', name => name === 'WEBGL_debug_shaders' && !options.noTranslation ? translated : null);
    method('getShaderPrecisionFormat', () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }));
    method('getFramebufferAttachmentParameter', (target, attachment, pname) => {
        assert([gl.DRAW_FRAMEBUFFER, gl.READ_FRAMEBUFFER].includes(target));
        const bound = target === gl.DRAW_FRAMEBUFFER ? state.draw : state.read;
        assert.equal(attachment, bound === null ? gl.DEPTH : gl.DEPTH_ATTACHMENT, 'default/nondefault attachment enum must match');
        if (pname === gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) return options.noDepth ? gl.NONE
            : bound === null ? gl.FRAMEBUFFER_DEFAULT : options.texture ? gl.TEXTURE : gl.RENDERBUFFER;
        if (pname === gl.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE) return 24;
        if (pname === gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) return gl.UNSIGNED_NORMALIZED;
        assert.equal(pname, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
        assert.notEqual(bound, null, 'default framebuffer has no exposed object name');
        return depth;
    });
    method('bindRenderbuffer', (target, object) => { assert.equal(target, gl.RENDERBUFFER); state.renderbuffer = object; });
    method('getRenderbufferParameter', (target, pname) => {
        assert.equal(target, gl.RENDERBUFFER); assert.equal(state.renderbuffer, depth);
        const values = { RENDERBUFFER_INTERNAL_FORMAT: gl.DEPTH_COMPONENT24, RENDERBUFFER_DEPTH_SIZE: 24,
            RENDERBUFFER_STENCIL_SIZE: 0, RENDERBUFFER_SAMPLES: 4, RENDERBUFFER_WIDTH: 512, RENDERBUFFER_HEIGHT: 512 };
        const key = Object.keys(values).find(name => gl[name] === pname); assert(key); return values[key];
    });
    const shaders = [{ type: gl.VERTEX_SHADER, source: 'void main(){gl_Position=vec4(0.0);}' },
        { type: gl.FRAGMENT_SHADER, source: options.longSource ? 'x'.repeat(1_000_001) : 'void main(){gl_FragColor=vec4(1.0);}' }];
    method('getAttachedShaders', program => { assert([earthProgram, cloudProgram].includes(program)); return options.noShaders ? null : shaders; });
    method('getProgramParameter', (program, pname) => { assert.equal(pname, gl.LINK_STATUS); return true; });
    method('getShaderParameter', (shader, pname) => pname === gl.SHADER_TYPE ? shader.type : true);
    method('getShaderSource', shader => shader.source);
    gl.drawingBufferWidth = gl.drawingBufferHeight = 512;
    const guardedGL = new Proxy(gl, { get(target, key) {
        if (/^(create|draw[A-Z]|clear|renderbufferStorage|tex|framebuffer|compile|link|useProgram|bindFramebuffer)/.test(String(key))) {
            throw new Error(`Forbidden zero-draw provenance operation: ${String(key)}`);
        }
        return target[key];
    } });
    const renderer = {
        getContext: () => guardedGL,
        getRenderTarget: () => options.nondefault ? framebuffer : null,
        capabilities: { isWebGL2: true, precision: 'highp', logarithmicDepthBuffer: false, maxSamples: 4 },
        properties: { get: material => options.noProgram ? {} : { currentProgram: {
            id: material === earthMaterial ? 1 : 2, program: material === earthMaterial ? earthProgram : cloudProgram } } },
    };
    const capture = () => captureCloudRasterProvenance({ renderer, earthMaterial, cloudMaterial, userAgent: 'fake-UA', browserVersion: 'fake-version' });
    const verify = report => {
        assert.deepEqual(state, original, 'GL bindings remain unchanged');
        for (const binding of Object.values(report.bindingRestoration)) if (binding.status === 'ok') assert(binding.unchanged);
        assert(report.queryCount < 150, 'capture query count stays bounded');
        assert(calls.length < 1500, 'including bounded GL error drains');
        assert.doesNotThrow(() => JSON.stringify(report), 'report contains no unserializable handles');
    };
    return { gl, calls, state, depth, original, capture, verify, renderer, earthMaterial, cloudMaterial };
}
let scenarios = 0;
function test(name, run) { run(); scenarios++; console.log(`PASS ${name}`); }

test('default D24/MSAA provenance and actual linked shader sources', () => {
    const f = fake(), r = f.capture(); f.verify(r);
    assert.equal(r.context.parameters.DEPTH_BITS.value, 24); assert.equal(r.context.parameters.SAMPLES.value, 4);
    assert.equal(r.framebuffers.draw.kind, 'default'); assert.equal(r.framebuffers.draw.attachment, 'DEPTH');
    assert.equal(r.framebuffers.draw.depthSize.value, 24);
    assert.equal(r.framebuffers.draw.storage.status, 'unavailable');
    assert.equal(r.programs.earth.isCurrentGLProgram, false); assert.equal(r.programs.cloud.isCurrentGLProgram, true);
    assert(r.programs.earth.shaders[1].source.value.text.includes('gl_FragColor'));
    assert(r.programs.cloud.shaders[0].translatedSource.value.text.startsWith('translated'));
    assert.equal(r.precision.FRAGMENT_SHADER.HIGH_FLOAT.value.precision, 23);
    assert.equal(r.renderer.capabilities.logarithmicDepthBuffer.value, false);
    assert.deepEqual(r.context.parameters.DEPTH_RANGE.value, [0, 1]);
    assert.equal(r.browser.userAgent, 'fake-UA');
    assert.equal(f.calls.filter(c => c.name === 'bindRenderbuffer').length, 0);
});
test('exposed nondefault depth renderbuffer storage and binding restoration', () => {
    const f = fake({ nondefault: true }), r = f.capture(); f.verify(r);
    assert.equal(r.framebuffers.draw.attachment, 'DEPTH_ATTACHMENT');
    assert.equal(r.framebuffers.draw.storage.parameters.RENDERBUFFER_INTERNAL_FORMAT.value, f.gl.DEPTH_COMPONENT24);
    assert.equal(r.framebuffers.draw.storage.parameters.RENDERBUFFER_DEPTH_SIZE.value, 24);
    assert.equal(r.framebuffers.draw.storage.parameters.RENDERBUFFER_SAMPLES.value, 4);
    assert(r.framebuffers.draw.storage.restored);
    assert.equal(f.calls.filter(c => c.name === 'bindRenderbuffer').length, 2, 'same attachment handle inspected only once');
});
test('null renderbuffer binding and independent read framebuffer restoration', () => {
    const f = fake({ separateRead: true, savedNull: true }), r = f.capture(); f.verify(r);
    assert.equal(r.framebuffers.draw.kind, 'default'); assert.equal(r.framebuffers.read.kind, 'nondefault');
    assert(r.framebuffers.read.storage.restored); assert.equal(f.state.renderbuffer, null);
});
test('depth texture remains unbound and storage honestly unavailable', () => {
    const f = fake({ nondefault: true, texture: true }), r = f.capture(); f.verify(r);
    assert.equal(r.framebuffers.draw.storage.status, 'unavailable');
    assert.equal(f.calls.filter(c => c.name === 'bindRenderbuffer').length, 0);
});
test('absent depth attachment skips invalid storage queries', () => {
    const f = fake({ noDepth: true }), r = f.capture(); f.verify(r);
    assert.equal(r.framebuffers.draw.storage.reason, 'No depth attachment.');
    assert.equal(f.calls.filter(c => c.name === 'getFramebufferAttachmentParameter').length, 2);
});
test('GL query error is attributed without hiding restoration', () => {
    const f = fake({ nondefault: true, fault: (name, args, gl) => name === 'getRenderbufferParameter' && args[1] === gl.RENDERBUFFER_DEPTH_SIZE
        ? { glError: gl.INVALID_ENUM } : null }), r = f.capture(); f.verify(r);
    assert.equal(r.framebuffers.draw.storage.parameters.RENDERBUFFER_DEPTH_SIZE.status, 'error');
    assert.deepEqual(r.framebuffers.draw.storage.parameters.RENDERBUFFER_DEPTH_SIZE.glErrors.codes, [f.gl.INVALID_ENUM]);
    assert(r.framebuffers.draw.storage.restored);
});
test('throwing renderbuffer query still restores original binding', () => {
    const f = fake({ nondefault: true, fault: name => name === 'getRenderbufferParameter' ? { throwBefore: 'query failed' } : null }), r = f.capture(); f.verify(r);
    assert.equal(r.framebuffers.draw.storage.parameters.RENDERBUFFER_DEPTH_SIZE.error, 'query failed');
    assert(r.framebuffers.draw.storage.restored);
});
test('bind throwing after mutation still restores in finally', () => {
    let first = true;
    const f = fake({ nondefault: true, fault: name => {
        if (name === 'bindRenderbuffer' && first) { first = false; return { throwAfter: 'bind threw after mutation' }; }
    } }), r = f.capture(); f.verify(r);
    assert.equal(r.framebuffers.draw.storage.bind.status, 'error'); assert(r.framebuffers.draw.storage.restored);
    assert.equal(f.calls.filter(c => c.name === 'getRenderbufferParameter').length, 0);
});
test('unknown initial renderbuffer binding never triggers a bind', () => {
    const f = fake({ nondefault: true, fault: (name, args, gl) => name === 'getParameter' && args[0] === gl.RENDERBUFFER_BINDING
        ? { glError: gl.INVALID_OPERATION } : null }), r = f.capture(); f.verify(r);
    assert.equal(r.framebuffers.draw.storage.parameters.status, 'unavailable');
    assert.equal(f.calls.filter(c => c.name === 'bindRenderbuffer').length, 0);
});
test('preexisting errors remain distinct from subsequent queries', () => {
    const f = fake({ preexistingError: true }), r = f.capture(); f.verify(r);
    assert.deepEqual(r.preexistingErrors.codes, [f.gl.INVALID_OPERATION]);
    assert.equal(r.context.parameters.DEPTH_BITS.status, 'ok');
});
test('permanent error state is bounded and unknown bindings are not used', () => {
    const f = fake({ stickyError: true }), r = f.capture(); f.verify(r);
    assert.equal(r.preexistingErrors.drained, false); assert.equal(r.preexistingErrors.codes.length, 8);
    assert.equal(r.framebuffers.draw.status, 'unavailable');
    assert.equal(f.calls.filter(c => c.name === 'bindRenderbuffer').length, 0);
});
test('unavailable translation and absent linked programs do not compile', () => {
    const f = fake({ noTranslation: true }), r = f.capture(); f.verify(r);
    assert.equal(r.programs.earth.shaders[0].translatedSource.status, 'unavailable');
    const absent = fake({ noProgram: true }), a = absent.capture(); absent.verify(a);
    assert.equal(a.programs.earth.status, 'unavailable');
    assert.equal(absent.calls.filter(c => c.name === 'getAttachedShaders').length, 0);
});
test('unavailable attached shaders and bounded source truncation are explicit', () => {
    const missing = fake({ noShaders: true }), m = missing.capture(); missing.verify(m);
    assert.equal(m.programs.earth.shaders.status, 'unavailable');
    const f = fake({ longSource: true }), r = f.capture(); f.verify(r);
    assert.equal(r.programs.cloud.shaders[1].source.value.length, 1_000_001);
    assert.equal(r.programs.cloud.shaders[1].source.value.text.length, 1_000_000);
    assert.equal(r.programs.cloud.shaders[1].source.value.truncated, true);
});
test('restore failure is reported rather than certified unchanged', () => {
    let binds = 0;
    const f = fake({ nondefault: true, fault: name => name === 'bindRenderbuffer' && ++binds === 2
        ? { throwBefore: 'restore refused' } : null }), r = f.capture();
    assert.equal(r.framebuffers.draw.storage.restored, false);
    assert.equal(r.framebuffers.draw.storage.restore.error, 'restore refused');
    assert.equal(r.bindingRestoration.RENDERBUFFER_BINDING.unchanged, false);
    assert.equal(f.state.renderbuffer, f.depth);
});
test('attachment and shader query errors stay visible without rebinding', () => {
    const f = fake({ fault: (name, args, gl) => name === 'getFramebufferAttachmentParameter' || name === 'getShaderSource'
        ? { glError: gl.INVALID_OPERATION } : null }), r = f.capture(); f.verify(r);
    assert.equal(r.framebuffers.draw.objectType.status, 'error');
    assert.equal(r.framebuffers.draw.storage.status, 'unavailable');
    assert.equal(r.programs.cloud.shaders[0].source.status, 'error');
    assert.equal(f.calls.filter(c => c.name === 'bindRenderbuffer').length, 0);
});
test('missing WebGL2 query constants are unavailable rather than guessed', () => {
    const f = fake(); delete f.gl.DRAW_FRAMEBUFFER_BINDING; delete f.gl.READ_FRAMEBUFFER_BINDING;
    const r = f.capture(); f.verify(r);
    assert.equal(r.framebuffers.draw.status, 'unavailable'); assert.equal(r.framebuffers.read.status, 'unavailable');
    assert.equal(f.calls.filter(c => c.name === 'getFramebufferAttachmentParameter').length, 0);
});
test('missing context gives an honest unavailable result', () => {
    assert.equal(captureCloudRasterProvenance().status, 'unavailable');
});
console.log(`Cloud raster provenance smoke passed: ${scenarios} scenarios; no browser or GL draws.`);
