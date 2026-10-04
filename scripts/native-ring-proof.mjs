// Serialized into the page with Playwright. No browser starts or GL calls are
// made by importing this module. Proof is native state evidence, not an
// alpha-gap guarantee. It never changes a sampler, texture binding, or program.
export function installNativeRingProof() {
    window.__diskPlaneNativeRingProof = function (renderer, rings, drawProduction) {
        const gl = renderer.getContext(), samples = [], failures = [], restorers = [];
        let armed = null;
        const require = (ok, message) => { if (!ok) throw Error(`Native ring proof: ${message}`); };
        const patch = (object, key, replacement) => {
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            object[key] = replacement;
            require(object[key] === replacement, `could not observe ${key}`);
            restorers.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key]; });
        };
        const shaderFingerprint = source => {
            let hash = 2166136261;
            for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
            return (hash >>> 0).toString(16).padStart(8, '0');
        };
        function inspectNativeDraw(ringIndex, method, count) {
            require(count > 0, 'empty draw cannot prove a sampled native ring');
            require(!gl.isContextLost(), 'GPU context is lost');
            const material = rings[ringIndex].material, map = material.map;
            const program = gl.getParameter(gl.CURRENT_PROGRAM);
            require(program, 'CURRENT_PROGRAM is missing at the native draw');
            const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
            require(linked === true, 'native ring program did not link');
            const shaders = (gl.getAttachedShaders(program) || []).map(shader => {
                const type = gl.getShaderParameter(shader, gl.SHADER_TYPE);
                const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
                const source = gl.getShaderSource(shader) || '';
                require(compiled === true, 'native ring shader did not compile');
                if (type === gl.FRAGMENT_SHADER) require(source.includes('uRingSun') && source.includes('vRingPosition'), 'CURRENT_PROGRAM is not the native ring shader');
                return { type, compiled, sourceFingerprint: shaderFingerprint(source), log: gl.getShaderInfoLog(shader) || '' };
            }).sort((a, b) => a.type - b.type);
            require(shaders.length === 2 && shaders.some(s => s.type === gl.VERTEX_SHADER) && shaders.some(s => s.type === gl.FRAGMENT_SHADER), 'both compiled shader stages are required');
            const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
            let mapUniform = null;
            for (let i = 0; i < uniformCount; i++) {
                const uniform = gl.getActiveUniform(program, i);
                if (uniform?.name === 'map') mapUniform = uniform;
            }
            require(mapUniform?.type === gl.SAMPLER_2D && mapUniform.size === 1, 'active map must be one sampler2D');
            const location = gl.getUniformLocation(program, 'map');
            require(location !== null, 'map sampler location is missing');
            const textureUnit = gl.getUniform(program, location);
            require(Number.isInteger(textureUnit) && textureUnit >= 0 && textureUnit < gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS), 'map has no valid uploaded texture unit');
            const activeBefore = gl.getParameter(gl.ACTIVE_TEXTURE);
            let sampler;
            try {
                // Inspect the unit uploaded for THIS program, not whichever
                // texture happened to be active before its material callback.
                gl.activeTexture(gl.TEXTURE0 + textureUnit);
                const actualTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
                const expectedTexture = renderer.properties.get(map).__webglTexture;
                require(actualTexture && expectedTexture && actualTexture === expectedTexture, 'map sampler is not bound to this native ring texture');
                const samplerObjectBound = gl.SAMPLER_BINDING !== undefined && gl.getParameter(gl.SAMPLER_BINDING) !== null;
                require(!samplerObjectBound, 'unexpected sampler object overrides native texture parameters');
                const minFilter = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER);
                const magFilter = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER);
                const wrapS = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S);
                const wrapT = gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T);
                // three@0.164.1 public texture enum -> native GL enum.
                const filters = { 1003: gl.NEAREST, 1004: gl.NEAREST_MIPMAP_NEAREST, 1005: gl.NEAREST_MIPMAP_LINEAR,
                    1006: gl.LINEAR, 1007: gl.LINEAR_MIPMAP_NEAREST, 1008: gl.LINEAR_MIPMAP_LINEAR };
                const wraps = { 1000: gl.REPEAT, 1001: gl.CLAMP_TO_EDGE, 1002: gl.MIRRORED_REPEAT };
                require(filters[map.minFilter] !== undefined && minFilter === filters[map.minFilter], 'actual native minification filter differs from the ring map');
                require(filters[map.magFilter] !== undefined && magFilter === filters[map.magFilter], 'actual native magnification filter differs from the ring map');
                require(wrapS === wraps[map.wrapS] && wrapT === wraps[map.wrapT], 'actual native wrapping differs from the ring map');
                const ext = gl.getExtension('EXT_texture_filter_anisotropic');
                const maxAnisotropy = ext ? gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : null;
                const anisotropy = ext ? gl.getTexParameter(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT) : null;
                if (ext) require(anisotropy === Math.min(map.anisotropy, maxAnisotropy), 'actual native anisotropy differs from the ring map');
                sampler = { textureUnit, textureMatchesRing: true, samplerObjectBound, minFilter, magFilter, wrapS, wrapT,
                    anisotropySupported: !!ext, anisotropy, maxAnisotropy };
            } finally {
                gl.activeTexture(activeBefore);
            }
            require(gl.getParameter(gl.ACTIVE_TEXTURE) === activeBefore, 'ACTIVE_TEXTURE was not restored');
            return { ringIndex, method, count, linked, programLog: gl.getProgramInfoLog(program) || '', shaders, sampler,
                activeTextureRestored: true, observation: 'first native draw after this ring material callback and uniform upload' };
        }
        try {
            rings.forEach((ring, ringIndex) => {
                const oldBefore = ring.material.onBeforeRender, oldAfter = ring.onAfterRender;
                patch(ring.material, 'onBeforeRender', function (...args) {
                    // Preserve production callbacks, including TDE hooks. Arm
                    // afterward so nested work in a callback cannot be mistaken
                    // for the renderer's later uniform upload and native draw.
                    const result = oldBefore?.apply(this, args);
                    if (args[0] === renderer && args[4] === ring) armed = { ringIndex };
                    return result;
                });
                patch(ring, 'onAfterRender', function (...args) {
                    // Clear even if no native draw happened. A subsequent
                    // unrelated draw must never satisfy missing ring evidence.
                    if (armed?.ringIndex === ringIndex) armed = null;
                    return oldAfter?.apply(this, args);
                });
            });
            for (const method of ['drawArrays', 'drawElements']) {
                const original = gl[method];
                require(typeof original === 'function', `${method} is unavailable`);
                patch(gl, method, function (...args) {
                    const observing = armed;
                    armed = null;
                    if (observing) {
                        try { samples.push(inspectNativeDraw(observing.ringIndex, method, method === 'drawArrays' ? args[2] : args[1])); }
                        catch (error) { failures.push(error.message || String(error)); }
                    }
                    // Inspection failures never suppress or modify the real draw.
                    return original.apply(this, args);
                });
            }
            const value = drawProduction();
            require(failures.length === 0, failures.join('; '));
            require(rings.length > 0 && rings.every((_, i) => samples.some(sample => sample.ringIndex === i)), 'no actual draw was observed for every native Saturn ring');
            return { value, proof: { stateEvidenceOnly: true, alphaGapGuarantee: false, samples, hooksRestored: true } };
        } finally {
            armed = null;
            for (const restore of restorers.reverse()) restore();
        }
    };
}
