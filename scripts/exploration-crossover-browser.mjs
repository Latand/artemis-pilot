// Test-only browser hooks. Production files and acceptance harness stay unchanged.
import assert from 'node:assert/strict';
function once(source, token, replacement) {
    assert.equal(source.split(token).length, 2, `Paired benchmark hook changed: ${token}`);
    return source.replace(token, replacement);
}
export function transform(source, id) {
    id = id.replaceAll('\\', '/').split('?')[0];
    if (id.endsWith('/src/render/catalogStars.js')) return once(source, 'const start = () => loadTier0();',
        'const start = () => {}; // QA: unrelated background HYG layer omitted identically.');
    if (id.endsWith('/src/render/bodySurfaceMaterial.js')) return source + '\nexport const pairedSurfaceQueue=()=>({pending:pending.size,inFlight:!!inFlight});\n';
    if (!id.endsWith('/src/main.js')) return null;
    source = once(source, 'const firstFrameT0 = perfStart();',
        'G.t=0;G.paused=true;G.warp=1;resetEphem();clock.getDelta=()=>1/60;\nconst firstFrameT0 = perfStart();');
    source = once(source, 'renderer.setAnimationLoop(frame);', '// QA: frames delivered explicitly and serially.');
    // The production frame body is untouched; this wrapper measures it.
    // Chromium WebGL finish() is only Flush(); readPixels establishes completion:
    // https://chromium.googlesource.com/chromium/src/third_party/+/master/blink/renderer/modules/webgl/webgl_rendering_context_base.cc#3557
    return source + `\nconst pairedReadbackPixel=new Uint8Array(4);window.__crossoverPrograms=new Map();\nwindow.__pairedFrame=()=>{clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;
        renderer.info.autoReset=false;renderer.info.reset();const start=performance.now();frame();const cpu=performance.now()-start;const gl=renderer.getContext();
        const finishStart=performance.now();gl.finish();const finishMs=performance.now()-finishStart;
        const readbackStart=performance.now();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pairedReadbackPixel);
        const readbackMs=performance.now()-readbackStart,frameAndFinishMs=performance.now()-start;
        // Everything below is OUTSIDE the timing interval; retain every frame.
        const telemetryStart=performance.now();
        const gpu={contextLost:gl.isContextLost(),error:gl.getError(),width:gl.drawingBufferWidth,height:gl.drawingBufferHeight,
            defaultFramebuffer:gl.getParameter(gl.FRAMEBUFFER_BINDING)===null};
        for(const p of renderer.info.programs) if(!__crossoverPrograms.has(p.id)) __crossoverPrograms.set(p.id,{
            id:p.id,name:p.name,cacheKey:p.cacheKey,linked:gl.getProgramParameter(p.program,gl.LINK_STATUS),
            shaders:gl.getAttachedShaders(p.program).map(shader=>({type:gl.getShaderParameter(shader,gl.SHADER_TYPE),source:gl.getShaderSource(shader)})).sort((a,b)=>a.type-b.type)});
        const counters={...renderer.info.render,...renderer.info.memory},programIds=renderer.info.programs.map(p=>p.id);
        const telemetryMs=performance.now()-telemetryStart;
        return {cpuMs:cpu,finishMs,readbackMs,frameAndFinishMs,telemetryMs,frameNo,gpu,
            counters,programIds};};
window.__pairedWorkload=()=>({frameNo,beltCursor,kuiperCursor,nearVisualReady,nearFieldCadence:cam.dist>LY_SCENE*.2?'cosmic':'every-frame',
    mobile:renderQuality.mobile,loadShed:renderQuality.loadShed,warp:G.warp,gr:G.gr,uiMode:G.uiMode,
    minor:Object.fromEntries(['belt','kuiper','curated','oort'].map(k=>[k,{capacity:minorRenderers[k].capacity,elementCount:minorSwarms[k].length/6,
        first:Array.from(minorSwarms[k].slice(0,12)),last:Array.from(minorSwarms[k].slice(-12))}]))});\n`;
}

// Serialized by Playwright into each new document. No command wrappers in timing.
export function initializeDocument() {
    Date.now = () => Date.UTC(2026, 9, 1, 12);
    if (location.protocol === 'http:') {
        localStorage.clear(); localStorage.setItem('ap_introSeen', '1');
        localStorage.setItem('ap_uiMode', 'observe'); localStorage.setItem('ap_perf', '0');
    }
    window.__pairedLongTasks = [];
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        window.__pairedObserver = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) __pairedLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
        });
        __pairedObserver.observe({ type: 'longtask', buffered: true });
    }
}
export async function initializeQA() {
    const [scene, input, state, surfaces, bodies, galaxy, epoch] = await Promise.all([
        import('/src/scene.js'), import('/src/input.js'), import('/src/state.js'), import('/src/render/bodySurfaceMaterial.js'),
        import('/src/bodies.js'), import('/src/universe/galaxy.js'), import('/src/epoch.js'),
    ]);
    window.pairedQA = { scene, input, G: state.G, surfaces, bodies, galaxy, epoch };
    const gl = scene.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { mobile: scene.renderQuality.mobile, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        contextAttributes: gl.getContextAttributes(), glVersion: gl.getParameter(gl.VERSION),
        longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
}
export function readState() {
    const q = pairedQA, { cam, camera, renderer } = q.scene;
    return { focus: q.G.focus, t: q.G.t, paused: q.G.paused, seed: q.galaxy.getSeed(), epoch: q.epoch.getEpochMs(),
        workload: __pairedWorkload(), ship: [q.G.x, q.G.y, q.G.z, q.G.vx, q.G.vy, q.G.vz],
        camera: { distance: cam.dist, yaw: cam.yaw, pitch: cam.pitch, target: cam.tgt.toArray(), position: camera.position.toArray(),
            quaternion: camera.quaternion.toArray(), fov: camera.fov },
        render: { ...renderer.info.memory, programs: renderer.info.programs.length },
        maps: { night: q.bodies.shaderTick.earthUniforms.uHasNight.value, clouds: q.bodies.shaderTick.earthUniforms.uHasClouds.value, moon: !!q.bodies.moon.material.map } };
}
export function selectFixture(fixture) {
    const q = pairedQA; q.input.setFocus(fixture.focus);
    if (fixture.distance !== null) q.scene.cam.dist = fixture.distance;
    q.scene.cam.distTarget = null; q.scene.cam.yaw = fixture.yaw; q.scene.cam.pitch = fixture.pitch;
}
export function readPrograms() {
    const active = new Set(pairedQA.scene.renderer.info.programs.map(p => p.id));
    return [...__crossoverPrograms.values()].map(p => ({ ...p, active: active.has(p.id) }));
}

// Installed only in the separate untimed replay, before application startup.
// Full WebGL/WebGL2 API call tape: input data are copied at call time, including
// uniforms, buffer uploads and draw arguments. Objects have stable per-type IDs
// from creation. Texture DOM sources retain dimensions + canvas pixels if readable.
// This is API-call parity, not a claim about driver-internal command identity.
export function installCommandRecorder() {
    const tapes = [], wrapped = new WeakSet();
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        const gl = original.call(this, type, ...args);
        if (!gl || !/^webgl2?$|^experimental-webgl$/.test(type) || wrapped.has(gl)) return gl;
        wrapped.add(gl);
        const ids = new WeakMap(), counts = {}, methods = new Set();
        let recording = false, commands = [];
        function value(v) {
            if (v === undefined) return { undefined: true };
            if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
            if (typeof v === 'number') return Number.isFinite(v) ? v : { nonFinite: String(v) };
            if (ArrayBuffer.isView(v)) return { type: v.constructor.name, bytes: Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
            if (v instanceof ArrayBuffer) return { type: 'ArrayBuffer', bytes: Array.from(new Uint8Array(v)) };
            if (Array.isArray(v)) return v.map(value);
            if (v instanceof HTMLImageElement || v instanceof HTMLCanvasElement || v instanceof ImageBitmap) {
                const width = v.naturalWidth || v.width, height = v.naturalHeight || v.height;
                const result = { type: v.constructor.name, width, height };
                try { const c = document.createElement('canvas'); c.width = width; c.height = height;
                    const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0); result.bytes = Array.from(ctx.getImageData(0, 0, width, height).data);
                } catch (error) { result.unreadable = String(error); }
                return result;
            }
            if (!ids.has(v)) { const type = v.constructor?.name || 'Object'; counts[type] = (counts[type] || 0) + 1; ids.set(v, `${type}#${counts[type]}`); }
            return { resource: ids.get(v) };
        }
        const originals = {}, extensionWrapped = new WeakSet();
        function wrapMethods(object, prefix = '') {
            const names = new Set();
            for (let p = object; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
                for (const name of Object.getOwnPropertyNames(p)) if (name !== 'constructor' && typeof object[name] === 'function') names.add(name);
            }
            for (const name of names) {
                const callName = prefix + name, call = object[name].bind(object);
                methods.add(callName); if (!prefix) originals[name] = call;
                object[name] = (...args) => {
                    const inputs = recording ? args.map(value) : null;
                    const result = call(...args);
                    // Establish object identities even when capture is disabled.
                    if (result && typeof result === 'object' && !ArrayBuffer.isView(result) && !Array.isArray(result)) value(result);
                    if (recording) commands.push({ name: callName, args: inputs });
                    if (!prefix && name === 'getExtension' && result && !extensionWrapped.has(result)) {
                        extensionWrapped.add(result); wrapMethods(result, `extension:${args[0]}.`);
                    }
                    return result;
                };
            }
        }
        wrapMethods(gl);
        const tape = { gl, get methods() { return [...methods].sort(); },
            begin: () => { commands = []; recording = true; },
            end: () => { recording = false; return commands; },
            pixels: () => { const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight, data = new Uint8Array(width * height * 4);
                originals.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
                let binary = ''; for (let i = 0; i < data.length; i += 16384) binary += String.fromCharCode(...data.subarray(i, i + 16384));
                return { width, height, base64: btoa(binary), error: originals.getError(), contextLost: originals.isContextLost() };
            } };
        tapes.push(tape); window.__crossoverTapes = tapes;
        return gl;
    };
}
