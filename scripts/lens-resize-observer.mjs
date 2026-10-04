// LOCAL diagnostic observer. Import/installation performs no rendering or GL
// reads. Only the two explicitly selected existing production captures inspect
// native state. No texture, program, attachment, viewport, or sampler is changed.
export const RESIZE_DIAGNOSTIC_PHASES = ['resize-1-alternate', 'resize-2-alternate'];
export const RESIZE_DIAGNOSTIC_PLAN = { variant: 'main', device: 'desktop', bloom: true,
    scenario: 'saturn-near-lens', pitch: .48, phases: RESIZE_DIAGNOSTIC_PHASES,
    additionalAppFrames: 0, additionalDraws: 0, additionalUntimedColorReadbacksUpperBound: 2,
    rawDepthTexelsObserved: false, originalEqualityGateUnchanged: true };
export function wantsResizeDiagnostic({ variant, mobile, bloom, phase, scenario, pitch }) {
    return variant === 'main' && mobile === false && bloom === true && RESIZE_DIAGNOSTIC_PHASES.includes(phase)
        && scenario === 'saturn-near-lens' && pitch === .48;
}

// Persist first: a failed observation must remain reviewable and must never be
// counted as successful instrumentation merely because the pixels rendered.
export async function captureWithResizeEvidence({ capture, selected, recover, save, onPersistenceError }) {
    let result;
    try { result = await capture(); }
    catch (error) {
        if (selected) {
            try { await save(await recover()); }
            catch (persistenceError) { try { onPersistenceError?.(persistenceError); } catch {} }
        }
        throw error;
    }
    await save(result.resizeDiagnostic);
    if (selected) {
        const trace = result.resizeDiagnostic;
        if (!trace || trace.complete !== true || trace.hooksRestored !== true || trace.addedReadbacks !== 1 || trace.addedDraws !== 0)
            throw Error(`Incomplete resize observation after evidence save: ${JSON.stringify({ complete: trace?.complete,
                hooksRestored: trace?.hooksRestored, readbacks: trace?.addedReadbacks, draws: trace?.addedDraws,
                truncated: trace?.truncated, errors: trace?.errors })}`);
    }
    return result;
}

export async function removeResizeObservers(page, timeoutMs = 2000) {
    let timer;
    try {
        return await Promise.race([
            page.evaluate(() => {
                if (!window.__diskPlaneDisposeLensResize) throw Error('Resize observer cleanup handle is missing');
                return window.__diskPlaneDisposeLensResize();
            }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Resize observer cleanup timed out')), timeoutMs); }),
        ]);
    } finally { clearTimeout(timer); }
}

// Self-contained because Playwright serializes this function into the page.
export function installLensResizeObserver() {
    const qa = window.qa, ids = new WeakMap();
    let nextId = 1;
    const id = value => value && (typeof value === 'object' || typeof value === 'function')
        ? (ids.has(value) ? ids.get(value) : (ids.set(value, `object-${nextId++}`), ids.get(value))) : null;
    const events = [], readbackPhases = new Set(), counters = { windowResize: 0, targetDisposal: 0, textureDisposal: 0 };
    let eventHistoryTruncated = false;
    qa.resizeDiagnosticReadbacks = 0;
    const recordEvent = (kind, object) => {
        counters[kind]++;
        if (events.length < 128) events.push({ kind, id: id(object), frameSuccess: window.__diskPlaneFrameSuccess || 0,
            readbacks: qa.readbacks, width: object?.width ?? null, height: object?.height ?? null });
        else eventHistoryTruncated = true;
    };
    // Lifecycle listeners count already-existing resize/disposal events; they
    // do not replace callbacks or alter the renderer's scheduling or resources.
    const lifecycleListeners = [];
    const listen = (object, event, callback) => {
        object.addEventListener(event, callback);
        lifecycleListeners.push({ object, event, callback });
    };
    listen(window, 'resize', () => recordEvent('windowResize', null));
    for (const target of [qa.s.composer?.renderTarget1, qa.s.composer?.renderTarget2].filter(Boolean)) {
        listen(target, 'dispose', () => recordEvent('targetDisposal', target));
        for (const texture of [target.texture, target.depthTexture].filter(Boolean))
            listen(texture, 'dispose', () => recordEvent('textureDisposal', texture));
    }
    window.__diskPlaneDisposeLensResize = () => {
        let removed = 0;
        for (const { object, event, callback } of lifecycleListeners.splice(0).reverse()) {
            object.removeEventListener(event, callback); removed++;
        }
        return { complete: true, removed, activeListeners: lifecycleListeners.length };
    };
    const array = value => value?.toArray ? value.toArray() : Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value) : value;
    const short = text => String(text || '').slice(0, 2048);
    const fingerprint = source => {
        let h = 2166136261;
        for (let i = 0; i < source.length; i++) h = Math.imul(h ^ source.charCodeAt(i), 16777619);
        return (h >>> 0).toString(16).padStart(8, '0');
    };
    const imageState = image => image ? { width: image.width ?? image.videoWidth ?? null,
        height: image.height ?? image.videoHeight ?? null, complete: image.complete ?? null } : null;
    const textureState = texture => {
        if (!texture) return null;
        const properties = qa.s.renderer.properties.get(texture);
        return { id: id(texture), name: texture.name, version: texture.version, sourceId: id(texture.source),
            sourceVersion: texture.source?.version ?? null, image: imageState(texture.image),
            gpuId: id(properties.__webglTexture), uploadedVersion: properties.__version ?? null,
            minFilter: texture.minFilter, magFilter: texture.magFilter, type: texture.type, format: texture.format,
            internalFormat: texture.internalFormat, colorSpace: texture.colorSpace, generateMipmaps: texture.generateMipmaps };
    };
    const targetState = target => {
        if (!target) return null;
        const p = qa.s.renderer.properties.get(target);
        return { id: id(target), width: target.width, height: target.height, samples: target.samples,
            framebufferId: id(p.__webglFramebuffer), depthbufferId: id(p.__webglDepthbuffer),
            multisampledFramebufferId: id(p.__webglMultisampledFramebuffer), viewport: array(target.viewport),
            scissor: array(target.scissor), scissorTest: target.scissorTest,
            color: textureState(target.texture), depth: textureState(target.depthTexture) };
    };
    const cpuUniforms = uniforms => Object.fromEntries(Object.entries(uniforms).map(([name, uniform]) => {
        const value = uniform.value;
        return [name, value?.isTexture ? textureState(value) : Array.isArray(value) ? value.map(array) : array(value)];
    }));
    function readiness() {
        const { s, st, surface, b, sat } = qa, composer = s.composer;
        return { t: st.G.t, paused: st.G.paused, frameSuccess: window.__diskPlaneFrameSuccess || 0, readbacks: qa.readbacks,
            diagnosticReadbacks: qa.resizeDiagnosticReadbacks,
            assetQueue: surface.diskPlaneAssetQueue(), saturnMap: textureState(b.plSurfaces[sat].material.map),
            viewport: { ...s.viewportSize }, quality: { ...s.renderQuality },
            canvas: { width: s.renderer.domElement.width, height: s.renderer.domElement.height },
            camera: { near: s.camera.near, far: s.camera.far, aspect: s.camera.aspect, fov: s.camera.fov,
                position: array(s.camera.position), projection: array(s.camera.projectionMatrix),
                projectionInverse: array(s.camera.projectionMatrixInverse), world: array(s.camera.matrixWorld), view: array(s.camera.matrixWorldInverse) },
            lifecycle: { ...counters, events: events.slice(), eventHistoryTruncated },
            composer: { readBuffer: targetState(composer.readBuffer), writeBuffer: targetState(composer.writeBuffer),
                target1: targetState(composer.renderTarget1), target2: targetState(composer.renderTarget2),
                passes: composer.passes.map(pass => ({ id: id(pass), type: pass.constructor.name, enabled: pass.enabled,
                    needsSwap: pass.needsSwap, renderToScreen: pass.renderToScreen, clear: pass.clear })) } };
    }
    const attributeState = attribute => attribute ? { id: id(attribute), type: attribute.constructor.name,
        version: attribute.version ?? null, count: attribute.count, itemSize: attribute.itemSize,
        normalized: attribute.normalized, usage: attribute.usage ?? null, gpuType: attribute.gpuType ?? null,
        arrayType: attribute.array?.constructor.name ?? null, arrayLength: attribute.array?.length ?? null,
        isInterleavedBufferAttribute: !!attribute.isInterleavedBufferAttribute, offset: attribute.offset ?? null,
        interleavedBuffer: attribute.data ? { id: id(attribute.data), type: attribute.data.constructor.name,
            version: attribute.data.version, count: attribute.data.count, stride: attribute.data.stride,
            usage: attribute.data.usage, arrayType: attribute.data.array?.constructor.name,
            arrayLength: attribute.data.array?.length, meshPerAttribute: attribute.data.meshPerAttribute ?? null } : null,
        meshPerAttribute: attribute.meshPerAttribute ?? null } : null;
    const visibility = object => {
        const parents = [];
        for (let p = object; p; p = p.parent) parents.push({ id: id(p), name: p.name, visible: p.visible });
        return { id: id(object), name: object.name, type: object.type, visible: object.visible,
            effectiveVisible: parents.every(p => p.visible !== false), parents, layers: object.layers?.mask,
            renderOrder: object.renderOrder, frustumCulled: object.frustumCulled,
            position: array(object.position), scale: array(object.scale), quaternion: array(object.quaternion),
            world: array(object.matrixWorld), modelView: array(object.modelViewMatrix),
            isInstancedMesh: !!object.isInstancedMesh, instanceCount: object.count ?? null,
            instanceMatrix: attributeState(object.instanceMatrix), instanceColor: attributeState(object.instanceColor),
            tdeTarget: object.userData?.tdeTarget ?? null };
    };
    const materialState = material => ({ id: id(material), name: material.name, type: material.type, visible: material.visible,
        side: material.side, transparent: material.transparent, opacity: material.opacity, alphaTest: material.alphaTest,
        depthTest: material.depthTest, depthWrite: material.depthWrite, depthFunc: material.depthFunc,
        colorWrite: material.colorWrite, blending: material.blending, version: material.version,
        color: array(material.color), map: textureState(material.map), alphaMap: textureState(material.alphaMap),
        surfaceDetailWidth: material.userData?.surfaceDetailWidth ?? null, surfacePhotographic: material.userData?.surfacePhotographic ?? null });
    const geometryState = geometry => ({ id: id(geometry), type: geometry.type,
        drawRange: { start: geometry.drawRange.start, count: Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : String(geometry.drawRange.count) },
        indexCount: geometry.index?.count ?? null, positionCount: geometry.attributes?.position?.count ?? null,
        index: attributeState(geometry.index), attributes: Object.fromEntries(Object.entries(geometry.attributes || {}).map(([name, attribute]) => [name, attributeState(attribute)])),
        morphAttributes: Object.fromEntries(Object.entries(geometry.morphAttributes || {}).map(([name, attributes]) => [name, attributes.map(attributeState)])),
        instanceCount: geometry.instanceCount ?? null,
        boundingSphere: geometry.boundingSphere ? { center: array(geometry.boundingSphere.center), radius: geometry.boundingSphere.radius } : null });

    window.__diskPlaneObserveLensResize = function (phase, drawProduction) {
        const { renderer, scene, composer } = qa.s, gl = renderer.getContext(), lensPass = qa.lens.lensingPass;
        const trace = { phase, diagnosticOnly: true, addedDraws: 0, addedReadbacks: 0,
            rawDepthTexelsObserved: false, readbackPolicy: 'Exactly one untimed pre-lens color read of the already-bound source target at each of two selected captures. No extra frames or draws.',
            limits: { inventory: 4096, submittedDraws: 4096, nativeDraws: 8192, uniforms: 256, lifecycleEvents: 128 },
            before: readiness(), after: null, inventory: [], submittedDraws: [], nativeDraws: [], lensPasses: [],
            errors: [], truncated: false, hooksRestored: false };
        window.__diskPlaneLastResizeTrace = trace;
        const restorers = [], captures = new Set();
        let submitted = null, activeLens = null;
        const boundedPush = (name, item, limit) => { if (trace[name].length < limit) trace[name].push(item); else trace.truncated = true; };
        const safe = operation => { try { return operation(); } catch (error) {
            if (trace.errors.length < 128) trace.errors.push(short(error.stack || error)); else trace.truncated = true;
            return null;
        } };
        const patch = (object, key, replacement) => {
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            object[key] = replacement;
            if (object[key] !== replacement) throw Error(`Cannot observe ${key}`);
            restorers.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key]; });
        };
        const attachments = () => {
            const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
            const result = { framebufferId: id(framebuffer), rendererTarget: targetState(renderer.getRenderTarget()),
                readFramebufferId: gl.READ_FRAMEBUFFER_BINDING === undefined ? id(framebuffer) : id(gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)),
                viewport: array(gl.getParameter(gl.VIEWPORT)), scissor: array(gl.getParameter(gl.SCISSOR_BOX)),
                scissorTest: gl.isEnabled(gl.SCISSOR_TEST), colorMask: array(gl.getParameter(gl.COLOR_WRITEMASK)),
                depthMask: gl.getParameter(gl.DEPTH_WRITEMASK), depthFunc: gl.getParameter(gl.DEPTH_FUNC),
                depthTest: gl.isEnabled(gl.DEPTH_TEST), defaultFramebuffer: !framebuffer, attachments: [] };
            if (framebuffer) {
                result.status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
                result.complete = result.status === gl.FRAMEBUFFER_COMPLETE;
                for (const [name, attachment] of [['color0', gl.COLOR_ATTACHMENT0], ['depth', gl.DEPTH_ATTACHMENT]]) {
                    const objectType = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, attachment, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);
                    const object = objectType === gl.NONE ? null : gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, attachment, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
                    result.attachments.push({ name, objectType, objectId: id(object),
                        textureLevel: objectType === gl.TEXTURE ? gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, attachment, gl.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL) : null });
                }
            }
            // WebGL has no getTexLevelParameter. Texture dimensions above are
            // explicitly CPU allocation metadata, paired with real attachment
            // identity, FBO completeness, upload version, and disposal history.
            result.dimensionEvidence = 'CPU target/texture allocation metadata plus native attachment identities and completeness';
            return result;
        };
        function sourceColor(readBuffer, sourceState) {
            if (!['resize-1-alternate', 'resize-2-alternate'].includes(phase) || readbackPhases.has(phase) || qa.resizeDiagnosticReadbacks >= 2)
                throw Error('Pre-lens diagnostic color readback exceeds its two-capture authorization');
            const expected = targetState(readBuffer);
            if (!sourceState.complete || sourceState.rendererTarget?.id !== expected.id ||
                sourceState.framebufferId !== expected.framebufferId || sourceState.readFramebufferId !== expected.framebufferId)
                throw Error('Pre-lens source target is not the complete already-bound read framebuffer');
            // This narrowly scoped fixture uses the production LDR composer.
            // Do not change a target format, binding, or pack buffer to read it.
            if (readBuffer.texture.type !== 1009 || readBuffer.texture.format !== 1023 ||
                !Number.isInteger(readBuffer.width) || !Number.isInteger(readBuffer.height) || gl.isContextLost())
                throw Error('Expected a live RGBA unsigned-byte source target');
            if (gl.PIXEL_PACK_BUFFER_BINDING !== undefined && gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) !== null)
                throw Error('Unexpected pixel pack buffer; observer will not alter it');
            readbackPhases.add(phase); qa.resizeDiagnosticReadbacks++; trace.addedReadbacks++;
            const bytes = new Uint8Array(readBuffer.width * readBuffer.height * 4);
            gl.readPixels(0, 0, readBuffer.width, readBuffer.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
            return { width: readBuffer.width, height: readBuffer.height, format: 'RGBA8', origin: 'bottom-left',
                rgbaBase64: btoa(binary), untimed: true, beforeOutputPass: true,
                textureColorSpace: readBuffer.texture.colorSpace ?? null, framebufferId: sourceState.framebufferId };
        }
        function nativeLensProgram() {
            const program = gl.getParameter(gl.CURRENT_PROGRAM), uniforms = {}, samplers = [];
            if (!program) throw Error('Lens native draw has no CURRENT_PROGRAM');
            const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
            if (uniformCount > trace.limits.uniforms) throw Error('Lens uniform inventory exceeds bound');
            for (let i = 0; i < uniformCount; i++) {
                const info = gl.getActiveUniform(program, i), location = gl.getUniformLocation(program, info.name);
                const value = gl.getUniform(program, location);
                uniforms[info.name] = { type: info.type, size: info.size, value: array(value) };
                if (info.type !== gl.SAMPLER_2D) continue;
                if (!Number.isInteger(value) || value < 0 || value >= gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)) throw Error('Invalid uploaded lens sampler unit');
                const before = gl.getParameter(gl.ACTIVE_TEXTURE);
                try {
                    gl.activeTexture(gl.TEXTURE0 + value);
                    const texture = gl.getParameter(gl.TEXTURE_BINDING_2D);
                    samplers.push({ name: info.name, unit: value, textureId: id(texture),
                        samplerObjectId: gl.SAMPLER_BINDING === undefined ? null : id(gl.getParameter(gl.SAMPLER_BINDING)),
                        minFilter: texture ? gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER) : null,
                        magFilter: texture ? gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER) : null,
                        wrapS: texture ? gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S) : null,
                        wrapT: texture ? gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T) : null });
                } finally { gl.activeTexture(before); }
                if (gl.getParameter(gl.ACTIVE_TEXTURE) !== before) throw Error('Lens sampler query did not restore ACTIVE_TEXTURE');
            }
            return { id: id(program), linked: gl.getProgramParameter(program, gl.LINK_STATUS),
                log: short(gl.getProgramInfoLog(program)), uniformCount, uniforms, samplers,
                shaders: (gl.getAttachedShaders(program) || []).map(shader => ({ id: id(shader),
                    type: gl.getShaderParameter(shader, gl.SHADER_TYPE), compiled: gl.getShaderParameter(shader, gl.COMPILE_STATUS),
                    sourceFingerprint: fingerprint(gl.getShaderSource(shader) || ''), log: short(gl.getShaderInfoLog(shader)) })) };
        }
        try {
            const collect = object => {
                if (!object.isMesh && !object.isLine && !object.isPoints && !object.isSprite) return;
                if (captures.has(object)) return; captures.add(object);
                boundedPush('inventory', { ...visibility(object), geometry: geometryState(object.geometry),
                    materials: (Array.isArray(object.material) ? object.material : [object.material]).filter(Boolean).map(materialState) }, trace.limits.inventory);
            };
            safe(() => { scene.traverse(collect); qa.hole.holeRoot.traverse(collect); });
            const originalRenderBuffer = renderer.renderBufferDirect;
            patch(renderer, 'renderBufferDirect', function (camera, drawScene, geometry, material, object, group) {
                const previous = submitted;
                const entry = safe(() => ({ ...visibility(object), material: materialState(material), geometry: geometryState(geometry),
                    target: targetState(this.getRenderTarget()), camera: { id: id(camera), near: camera.near, far: camera.far,
                        projection: array(camera.projectionMatrix), view: array(camera.matrixWorldInverse) }, group: group ? { ...group } : null }));
                if (entry) boundedPush('submittedDraws', entry, trace.limits.submittedDraws);
                submitted = { object, material, entry };
                try { return originalRenderBuffer.apply(this, arguments); }
                finally { submitted = previous; }
            });
            const originalLensRender = lensPass.render;
            patch(lensPass, 'render', function (actualRenderer, writeBuffer, readBuffer, ...rest) {
                const previous = activeLens;
                const entry = safe(() => ({ cpuUniformsBefore: cpuUniforms(this.uniforms), source: targetState(readBuffer),
                    destination: targetState(writeBuffer), sourceBoundAtEntry: attachments(), nativeDraw: null }));
                if (entry) trace.lensPasses.push(entry);
                if (entry) entry.sourceColor = safe(() => sourceColor(readBuffer, entry.sourceBoundAtEntry));
                activeLens = entry;
                try { return originalLensRender.call(this, actualRenderer, writeBuffer, readBuffer, ...rest); }
                finally { if (entry) safe(() => { entry.cpuUniformsAfter = cpuUniforms(this.uniforms); }); activeLens = previous; }
            });
            for (const method of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'].filter(method => typeof gl[method] === 'function')) {
                const original = gl[method];
                patch(gl, method, function (...args) {
                    safe(() => {
                        boundedPush('nativeDraws', { method, args, objectId: id(submitted?.object), materialId: id(submitted?.material),
                            programId: id(gl.getParameter(gl.CURRENT_PROGRAM)), framebufferId: id(gl.getParameter(gl.FRAMEBUFFER_BINDING)) }, trace.limits.nativeDraws);
                        if (submitted?.material === lensPass.material && activeLens)
                            activeLens.nativeDraw = { program: nativeLensProgram(), destinationBound: attachments(), cpuUniforms: cpuUniforms(lensPass.uniforms) };
                    });
                    return original.apply(this, args);
                });
            }
            const value = drawProduction();
            trace.after = safe(readiness);
            if (eventHistoryTruncated) trace.truncated = true;
            trace.complete = trace.errors.length === 0 && !trace.truncated && trace.lensPasses.length === 1 &&
                !!trace.lensPasses[0].nativeDraw && !!trace.lensPasses[0].sourceColor && trace.addedReadbacks === 1;
            return { value, trace };
        } finally {
            for (const restore of restorers.reverse()) restore();
            trace.hooksRestored = true;
            if (!trace.after) trace.after = safe(readiness);
        }
    };
}
