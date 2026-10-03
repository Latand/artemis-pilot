// Failure-only, zero-draw inspection. Call after preserving the failed frame.
// This consumes and records GL error flags (they cannot be restored), and may
// enable read-only debug extensions. It never creates/binds a framebuffer,
// allocates storage, compiles a shader, selects a program, or renders a frame.
// Default-framebuffer queries expose the WebGL contract, not the underlying
// Vulkan image format. A browser-managed default depth buffer has no public
// renderbuffer handle, so its RENDERBUFFER_INTERNAL_FORMAT remains unknown.
// WebGL 2 query contract: https://registry.khronos.org/webgl/specs/latest/2.0/
const ERROR_LIMIT = 8;
const SHADER_LIMIT = 8;
const SOURCE_LIMIT = 1_000_000;
const unavailable = reason => ({ status: 'unavailable', reason });
const message = error => String(error?.message || error).slice(0, 2000);

/**
 * Inspect the currently bound framebuffer(s) and already linked material
 * programs. Pass the actual, already rendered Earth/cloud materials. No
 * fallback compilation or program-cache search occurs if currentProgram is
 * absent. The result is JSON-safe; each query carries its own error outcome.
 * browserVersion is optional host-supplied evidence, never inferred from UA.
 */
export function captureCloudRasterProvenance({ renderer, earthMaterial, cloudMaterial,
    userAgent = globalThis.navigator?.userAgent, browserVersion } = {}) {
    let gl;
    try { gl = renderer?.getContext(); } catch (error) {
        return { schemaVersion: 1, status: 'error', error: message(error) };
    }
    if (!gl) return { schemaVersion: 1, status: 'unavailable', reason: 'Renderer context is unavailable.' };
    const rawValues = new WeakMap(), handles = new WeakMap();
    let nextHandle = 1, queryCount = 0;
    const handle = value => {
        if (value === null) return null;
        if (typeof value !== 'object' || value === undefined) return { unavailable: 'No object handle returned.' };
        if (!handles.has(value)) handles.set(value, `object-${nextHandle++}`);
        return handles.get(value);
    };
    const errors = () => {
        if (typeof gl.getError !== 'function') return unavailable('getError is unavailable.');
        const codes = [];
        try {
            for (let i = 0; i < ERROR_LIMIT; i++) {
                const code = gl.getError();
                if (code === gl.NO_ERROR) return { status: 'ok', codes, drained: true };
                codes.push(code);
            }
            return { status: 'error', codes, drained: false, reason: 'Bounded GL error drain exhausted.' };
        } catch (error) { return { status: 'error', codes, drained: false, error: message(error) }; }
    };
    const preexistingErrors = errors();
    const query = (call, fn, convert = value => value) => {
        queryCount++;
        let value, error;
        try { value = fn(); } catch (caught) { error = message(caught); }
        const glErrors = errors();
        const result = { call, status: error || glErrors.codes?.length ? 'error'
            : glErrors.status === 'ok' ? 'ok' : 'unverified', glErrors };
        if (error) result.error = error;
        else {
            rawValues.set(result, value);
            try { result.value = convert(value); } catch (caught) { result.status = 'error'; result.error = message(caught); }
        }
        return result;
    };
    const raw = result => rawValues.get(result);
    const constant = name => typeof gl[name] === 'number';
    const param = (name, convert) => constant(name) && typeof gl.getParameter === 'function'
        ? query(`getParameter(${name})`, () => gl.getParameter(gl[name]), convert)
        : unavailable(`${name} query is unavailable.`);
    const call = (method, args = [], convert) => typeof gl[method] === 'function'
        ? query(method, () => gl[method](...args), convert) : unavailable(`${method} is unavailable.`);
    const plain = fn => { try { return { status: 'ok', value: fn() }; } catch (error) { return { status: 'error', error: message(error) }; } };
    const source = value => typeof value === 'string' && value.length > 0
        ? { text: value.slice(0, SOURCE_LIMIT), length: value.length, truncated: value.length > SOURCE_LIMIT }
        : { text: null, unavailable: 'Driver returned no source or an empty source.' };
    const bindings = () => Object.fromEntries(['DRAW_FRAMEBUFFER_BINDING', 'READ_FRAMEBUFFER_BINDING',
        'RENDERBUFFER_BINDING', 'CURRENT_PROGRAM'].map(name => [name, param(name, handle)]));
    const before = bindings();
    const report = {
        schemaVersion: 1,
        scope: 'Zero-draw failure provenance; no acceptance decision or backend format inference.',
        limits: { errorDrain: ERROR_LIMIT, attachedShadersPerProgram: SHADER_LIMIT, sourceCharacters: SOURCE_LIMIT },
        errorFlagConsumption: 'Preexisting and query-generated GL errors are recorded and consumed; GL cannot restore error flags.',
        preexistingErrors,
        browser: { userAgent: typeof userAgent === 'string' ? userAgent : null,
            browserVersion: typeof browserVersion === 'string' ? browserVersion : null,
            browserVersionOrigin: typeof browserVersion === 'string' ? 'caller-supplied' : 'unavailable' },
        context: { attributes: call('getContextAttributes', [], value => value ? { ...value } : null),
            lost: call('isContextLost'), drawingBufferWidth: gl.drawingBufferWidth ?? null,
            drawingBufferHeight: gl.drawingBufferHeight ?? null,
            parameters: Object.fromEntries(['VERSION', 'SHADING_LANGUAGE_VERSION', 'VENDOR', 'RENDERER',
                'DEPTH_BITS', 'STENCIL_BITS', 'SAMPLES', 'SAMPLE_BUFFERS', 'DEPTH_RANGE', 'DEPTH_FUNC',
                'DEPTH_WRITEMASK', 'SUBPIXEL_BITS', 'MAX_SAMPLES'].map(name => [name,
                param(name, value => ArrayBuffer.isView(value) ? Array.from(value) : value)])) },
        renderer: { renderTarget: plain(() => handle(renderer.getRenderTarget())),
            capabilities: Object.fromEntries(['isWebGL2', 'precision', 'logarithmicDepthBuffer',
                'maxSamples', 'maxTextures', 'maxVertexTextures', 'maxTextureSize', 'maxCubemapSize',
                'maxAttributes', 'maxVertexUniforms', 'maxVaryings', 'maxFragmentUniforms'].map(name => [name,
                plain(() => renderer.capabilities?.[name] ?? null)])) },
        bindingsBefore: before,
    };
    const extension = name => call('getExtension', [name], value => ({ available: value !== null && value !== undefined }));
    const debugRenderer = extension('WEBGL_debug_renderer_info');
    report.context.debugRendererExtension = debugRenderer;
    if (debugRenderer.status === 'ok' && raw(debugRenderer)) {
        const ext = raw(debugRenderer);
        report.context.unmasked = Object.fromEntries(['UNMASKED_VENDOR_WEBGL', 'UNMASKED_RENDERER_WEBGL'].map(name => [name,
            typeof ext[name] === 'number' ? query(`getParameter(${name})`, () => gl.getParameter(ext[name])) : unavailable(`${name} is unavailable.`)]));
    }
    const debugShaders = extension('WEBGL_debug_shaders');
    report.debugShadersExtension = debugShaders;
    report.precision = Object.fromEntries(['VERTEX_SHADER', 'FRAGMENT_SHADER'].map(stage => [stage,
        Object.fromEntries(['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT'].map(type => [type,
            constant(stage) && constant(type) ? call('getShaderPrecisionFormat', [gl[stage], gl[type]], value => value
                ? { rangeMin: value.rangeMin, rangeMax: value.rangeMax, precision: value.precision } : null)
                : unavailable(`${stage}/${type} is unavailable.`)]))]));

    const renderbuffers = new Map();
    function inspectRenderbuffer(object) {
        if (renderbuffers.has(object)) return renderbuffers.get(object);
        const result = { handle: handle(object) };
        renderbuffers.set(object, result);
        const saved = before.RENDERBUFFER_BINDING;
        if (saved.status !== 'ok' || raw(saved) === undefined || !constant('RENDERBUFFER') || typeof gl.bindRenderbuffer !== 'function') {
            result.parameters = unavailable('Original renderbuffer binding is not reliably known; no binding change attempted.');
            return result;
        }
        // Even a throwing bind can have changed state. Always restore in finally.
        try {
            result.bind = call('bindRenderbuffer', [gl.RENDERBUFFER, object], () => null);
            if (result.bind.status === 'ok') result.parameters = Object.fromEntries(['RENDERBUFFER_INTERNAL_FORMAT',
                'RENDERBUFFER_DEPTH_SIZE', 'RENDERBUFFER_STENCIL_SIZE', 'RENDERBUFFER_SAMPLES',
                'RENDERBUFFER_WIDTH', 'RENDERBUFFER_HEIGHT'].map(name => [name,
                constant(name) ? call('getRenderbufferParameter', [gl.RENDERBUFFER, gl[name]]) : unavailable(`${name} is unavailable.`)]));
            else result.parameters = unavailable('Depth renderbuffer bind failed; its storage was not queried.');
        } finally {
            result.restore = call('bindRenderbuffer', [gl.RENDERBUFFER, raw(saved)], () => null);
            result.bindingAfterRestore = param('RENDERBUFFER_BINDING', handle);
            result.restored = result.restore.status === 'ok' && result.bindingAfterRestore.status === 'ok'
                && raw(result.bindingAfterRestore) === raw(saved);
        }
        return result;
    }
    function inspectFramebuffer(target, binding) {
        if (binding.status !== 'ok' || raw(binding) === undefined || !constant(target)) return unavailable('Framebuffer binding or target is unavailable; no framebuffer was bound.');
        const isDefault = raw(binding) === null, attachment = isDefault ? 'DEPTH' : 'DEPTH_ATTACHMENT';
        const result = { target, kind: isDefault ? 'default' : 'nondefault', binding: binding.value, attachment };
        const attach = name => constant(attachment) && constant(name)
            ? call('getFramebufferAttachmentParameter', [gl[target], gl[attachment], gl[name]]) : unavailable(`${attachment}/${name} is unavailable.`);
        result.objectType = attach('FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE');
        if (result.objectType.status !== 'ok' || raw(result.objectType) === gl.NONE) {
            result.storage = unavailable(result.objectType.status === 'ok' ? 'No depth attachment.' : 'Depth attachment type query failed.');
            return result;
        }
        result.depthSize = attach('FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE');
        result.componentType = attach('FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE');
        if (isDefault || raw(result.objectType) === gl.FRAMEBUFFER_DEFAULT) {
            result.storage = unavailable('Default framebuffer storage is browser-managed; no public renderbuffer handle or underlying internal format is exposed.');
        } else {
            result.objectName = call('getFramebufferAttachmentParameter', [gl[target], gl[attachment], gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME], handle);
            if (raw(result.objectType) === gl.RENDERBUFFER && result.objectName.status === 'ok' && raw(result.objectName)) {
                result.storage = inspectRenderbuffer(raw(result.objectName));
            } else result.storage = unavailable('No exposed depth renderbuffer; texture storage is not rebound or inferred.');
        }
        return result;
    }
    report.framebuffers = {
        draw: inspectFramebuffer('DRAW_FRAMEBUFFER', before.DRAW_FRAMEBUFFER_BINDING),
        read: inspectFramebuffer('READ_FRAMEBUFFER', before.READ_FRAMEBUFFER_BINDING),
    };
    function inspectMaterial(material) {
        if (!material || Array.isArray(material)) return unavailable('One already rendered material is required.');
        let program;
        try { program = renderer.properties.get(material)?.currentProgram; }
        catch (error) { return { status: 'error', error: message(error) }; }
        if (!program?.program) return unavailable('No current linked material program; no compile or fallback program selection attempted.');
        const result = { threeProgramId: program.id ?? null, handle: handle(program.program),
            isCurrentGLProgram: before.CURRENT_PROGRAM.status === 'ok' ? raw(before.CURRENT_PROGRAM) === program.program : null };
        result.linkStatus = call('getProgramParameter', [program.program, gl.LINK_STATUS]);
        result.attachedShaders = call('getAttachedShaders', [program.program], value => value ? { count: value.length, truncated: value.length > SHADER_LIMIT } : null);
        if (result.attachedShaders.status !== 'ok' || !Array.isArray(raw(result.attachedShaders))) {
            result.shaders = unavailable('Attached shader objects are unavailable.'); return result;
        }
        result.shaders = raw(result.attachedShaders).slice(0, SHADER_LIMIT).map(shader => ({
            handle: handle(shader),
            type: call('getShaderParameter', [shader, gl.SHADER_TYPE]),
            compileStatus: call('getShaderParameter', [shader, gl.COMPILE_STATUS]),
            source: call('getShaderSource', [shader], source),
            translatedSource: debugShaders.status === 'ok' && typeof raw(debugShaders)?.getTranslatedShaderSource === 'function'
                ? query('WEBGL_debug_shaders.getTranslatedShaderSource', () => raw(debugShaders).getTranslatedShaderSource(shader), source)
                : unavailable('WEBGL_debug_shaders translation is not available.'),
        }));
        return result;
    }
    report.programs = { earth: inspectMaterial(earthMaterial), cloud: inspectMaterial(cloudMaterial) };
    report.bindingsAfter = bindings();
    report.bindingRestoration = Object.fromEntries(Object.keys(before).map(name => [name,
        before[name].status === 'ok' && report.bindingsAfter[name].status === 'ok'
            ? { status: 'ok', unchanged: raw(before[name]) === raw(report.bindingsAfter[name]) }
            : unavailable('Binding comparison is unavailable because a query failed.')]));
    report.finalErrors = errors();
    report.queryCount = queryCount;
    return report;
}
