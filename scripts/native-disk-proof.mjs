import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DISK_PLANE_CASES, RESIZE_CASES, RECOVERY_CONTROLS, REPEAT_CYCLES } from './disk-plane-qa.mjs';

export const NATIVE_DISK_POLICY = Object.freeze({ scope: 'candidate untimed existing draws only',
    addedFrames: 0, addedDraws: 0, addedReadbacks: 0, maxDraws: 8192, maxCompiles: 64, maxPrograms: 64,
    queryPolicy: 'Native GL inspection only for the draw armed by the disk material callback, plus its compile precision query; no GL inspection of unrelated world draws. Shader reflection once per actual program. Query counts exclude production and other QA helpers.',
    qualification: 'Compiled highp declaration and native HIGH_FLOAT precision/range qualify storage; IEEE operation rounding is not certified.' });

export function validateNativeDiskHooks(root) {
    const source = readFileSync(resolve(root, 'src/holeOptics.js'), 'utf8');
    for (const marker of ['const diskPrecision=new WeakMap();', 'disk.material.onBeforeCompile=(parameters,renderer)=>{',
        'diskPrecision.set(renderer,supported && diskPrecision.get(renderer)!==false);', 'export function diskSupportUnclipped(input)',
        'uniform float uJetLength, uJetI, uDiskUnclipped;'])
        assert.equal(source.split(marker).length, 2, `Candidate native observer hook: ${marker}`);
    return { candidateCompileHook:true, stickyRejection:true, browserStarted:false };
}

export async function boundedNativeOperation(name, operation, timeoutMs = 2000) {
    const controller = new AbortController(); let timer;
    try {
        return await Promise.race([Promise.resolve().then(() => operation(controller.signal)),
            new Promise((_, reject) => { timer = setTimeout(() => {
                const error = new Error(`${name} exceeded ${timeoutMs}ms`); controller.abort(error); reject(error);
            }, timeoutMs); })]);
    } finally { clearTimeout(timer); }
}

// At most 2s + 5s, within the unchanged finalizer's 10s outer deadline.
export async function closeNativeDiskResources(stop, close, { stopMs = 2000, closeMs = 5000 } = {}) {
    const failures = [];
    for (const [name, operation, timeout] of [['native-disk-observer-stop', stop, stopMs], ['browser-close', close, closeMs]]) {
        try { await boundedNativeOperation(name, operation, timeout); }
        catch (error) { failures.push({ name, error }); }
    }
    if (failures.length) throw new AggregateError(failures.map(f => f.error),
        failures.map(f => `${f.name}: ${f.error.stack || String(f.error)}`).join('\n'));
}

// Serialized into the page. Queries execute after Three's uniform upload and
// immediately before the existing native disk draw. No GL binding is changed.
export function installNativeDiskFastPathProof() {
    window.__createNativeDiskFastPathProof = (renderer, disk, eligible, lifecycle) => {
        const gl = renderer.getContext(), material = disk.material, restorers = [];
        const programIds = new WeakMap(), programs = new Map();
        let label = { kind: 'setup' }, pending = null, compileSerial = 0, drawSerial = 0;
        let stickyQualified = null, stopped = false, restored = false, historyTruncated = false, skippedSerial = 0;
        let batch = { compiles: [], programs: [], draws: [], skipped: [], errors: [] };
        let queryCounts = {}; const totalQueryCounts = {};
        const query = (name, ...args) => { queryCounts[name] = (queryCounts[name] || 0) + 1;
            totalQueryCounts[name] = (totalQueryCounts[name] || 0) + 1; return gl[name](...args); };
        const need = (ok, message) => { if (!ok) throw Error(`Native disk proof: ${message}`); };
        const copy = value => ArrayBuffer.isView(value) || Array.isArray(value) ? Array.from(value) : value;
        const fail = error => { if (batch.errors.length < 64) batch.errors.push(error.stack || String(error)); else historyTruncated = true; };
        const bound = (count, max, name) => { if (count > max) historyTruncated = true; need(count <= max, `${name} history limit exceeded`); };
        const patch = (object, key, replacement) => {
            const descriptor = Object.getOwnPropertyDescriptor(object, key), original = object[key];
            restorers.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key];
                need(object[key] === original, `${key} restoration failed`); });
            object[key] = replacement; need(object[key] === replacement, `${key} cannot be observed`);
        };
        const format = () => { const f = query('getShaderPrecisionFormat', gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
            return f ? { precision: f.precision, rangeMin: f.rangeMin, rangeMax: f.rangeMax } : null; };
        const supports = f => !!f && f.precision >= 23 && f.rangeMin >= 126 && f.rangeMax >= 127;
        const hash = source => { let h = 2166136261; for (let i = 0; i < source.length; i++) h = Math.imul(h ^ source.charCodeAt(i), 16777619);
            return (h >>> 0).toString(16).padStart(8, '0'); };
        const beforeCompile = material.onBeforeCompile, cacheKey = material.customProgramCacheKey();
        function programInfo(program) {
            if (programIds.has(program)) return programs.get(programIds.get(program));
            bound(programs.size + 1, 64, 'program');
            const info = { id: programs.size + 1, linked: query('getProgramParameter', program, gl.LINK_STATUS),
                programLog: query('getProgramInfoLog', program) || '', shaders: [] };
            programIds.set(program, info.id); programs.set(info.id, info); batch.programs.push(info);
            for (const shader of query('getAttachedShaders', program) || []) {
                const source = query('getShaderSource', shader) || '', type = query('getShaderParameter', shader, gl.SHADER_TYPE);
                const compiled = query('getShaderParameter', shader, gl.COMPILE_STATUS);
                info.shaders.push({ type, compiled, source, sourceFingerprint: hash(source), log: query('getShaderInfoLog', shader) || '' });
                need(compiled === true, 'bound disk shader is not compiled');
                if (type === gl.FRAGMENT_SHADER) {
                    need(/#define\s+HOLE_LAYER\s+1\b/.test(source) && source.includes('uDiskUnclipped'), 'bound program is not the candidate disk layer');
                    const declarations = [...source.matchAll(/precision\s+(highp|mediump|lowp)\s+float\s*;/g)].map(m => m[1]);
                    info.precisionDeclarations = declarations;
                    info.effectivePrecision = declarations.length === 1 ? declarations[0] : 'unverified';
                }
            }
            need(info.linked === true, 'bound disk program is not linked');
            need(info.shaders.length === 2 && info.shaders.some(s => s.type === gl.FRAGMENT_SHADER) && info.shaders.some(s => s.type === gl.VERTEX_SHADER), 'both shader stages required');
            info.highFloat = format(); info.storageQualified = info.effectivePrecision === 'highp' && supports(info.highFloat);
            info.complete = true; return info;
        }
        function inspect(armed, method, count) {
            const record = { id: ++drawSerial, label: armed.label, lifecycle: lifecycle(), method, count,
                compileSerialAtArm: armed.compileSerial, compileSerialAtDraw: compileSerial, stickyQualified };
            bound(drawSerial, 8192, 'draw'); batch.draws.push(record);
            need(count > 0 && !query('isContextLost'), 'nonempty live draw required');
            const program = query('getParameter', gl.CURRENT_PROGRAM), active = query('getParameter', gl.ACTIVE_TEXTURE), framebuffer = query('getParameter', gl.FRAMEBUFFER_BINDING);
            need(program, 'missing CURRENT_PROGRAM');
            const info = programInfo(program);
            need(info.complete, 'bound program qualification is incomplete');
            record.program = { id: info.id, linked: info.linked, effectivePrecision: info.effectivePrecision,
                storageQualified: info.storageQualified, highFloat: info.highFloat };
            record.viewport = Array.from(query('getParameter', gl.VIEWPORT));
            const viewport = { x: 0, y: 0, z: 0, w: 0, copy(v) { this.x=v.x; this.y=v.y; this.z=v.z; this.w=v.w; return this; } };
            renderer.getCurrentViewport(viewport); record.rendererViewport = [viewport.x, viewport.y, viewport.z, viewport.w];
            need(record.viewport.every((v, i) => v === record.rendererViewport[i]), 'native viewport differs from renderer current viewport');
            record.uniforms = {}; record.cpuUniforms = {};
            for (const name of ['uDiskUnclipped', 'uDiskOn', 'uOrigin', 'uNormal', 'uViewDepth', 'uCameraRotation', 'uInverseProjection', 'uNear', 'uFar', 'uRsUnits']) {
                const location = query('getUniformLocation', program, name); need(location !== null, `missing active ${name}`);
                const value = copy(query('getUniform', program, location)); record.uniforms[name] = value;
                const cpu = material.uniforms[name]?.value;
                record.cpuUniforms[name] = cpu?.toArray ? cpu.toArray().map(Math.fround) : Math.fround(cpu);
                need(JSON.stringify(value) === JSON.stringify(record.cpuUniforms[name]), `uploaded ${name} differs from float32 material value`);
            }
            const u = record.uniforms;
            record.camera = { perspective: armed.camera.isPerspectiveCamera === true, parented: !!armed.camera.parent };
            record.geometryEligible = eligible({ origin:u.uOrigin, normal:u.uNormal, viewDepth:u.uViewDepth,
                rotation:u.uCameraRotation, inverseProjection:u.uInverseProjection, near:u.uNear, far:u.uFar,
                rsUnits:u.uRsUnits, viewportWidth:record.viewport[2], viewportHeight:record.viewport[3] });
            record.compiledDuringDraw = compileSerial > armed.compileSerial;
            record.expectedFlag = !record.compiledDuringDraw && stickyQualified === true && info.storageQualified &&
                record.camera.perspective && !record.camera.parented && u.uDiskOn > .5 && record.geometryEligible ? 1 : 0;
            need(u.uDiskUnclipped === record.expectedFlag, 'actual fast-path flag disagrees with compile/reset/eligibility evidence');
            record.bindingsUnchanged = query('getParameter', gl.CURRENT_PROGRAM) === program &&
                query('getParameter', gl.ACTIVE_TEXTURE) === active && query('getParameter', gl.FRAMEBUFFER_BINDING) === framebuffer;
            need(record.bindingsUnchanged, 'read-only queries changed bindings'); record.complete = true;
        }
        try {
            // Three's default key includes onBeforeCompile.toString(). Preserve
            // the exact pre-observation key while wrapping that callback.
            patch(material, 'customProgramCacheKey', () => cacheKey);
            patch(material, 'onBeforeCompile', function (parameters, compileRenderer) {
                const result = beforeCompile.apply(this, arguments);
                try {
                    need(compileRenderer === renderer, 'unexpected compile renderer');
                    const highFloat = format(), supported = parameters?.precision === 'highp' && supports(highFloat);
                    stickyQualified = supported && stickyQualified !== false;
                    const event = { id: ++compileSerial, label: { ...label }, lifecycle: lifecycle(),
                        selectedPrecision: parameters?.precision ?? null, highFloat, supported, stickyQualified,
                        resetFlag: material.uniforms.uDiskUnclipped.value, cacheKeyPreserved: material.customProgramCacheKey() === cacheKey };
                    bound(compileSerial, 64, 'compile'); batch.compiles.push(event);
                    need(event.resetFlag === 0 && event.cacheKeyPreserved, 'compile must reset flag and preserve program cache key');
                } catch (error) { fail(error); }
                return result;
            });
            const oldBefore = material.onBeforeRender, oldAfter = disk.onAfterRender;
            patch(material, 'onBeforeRender', function (...args) {
                const value = oldBefore?.apply(this, args);
                if (args[0] === renderer && args[4] === disk) pending = { label: { ...label }, camera: args[2], compileSerial };
                return value;
            });
            patch(disk, 'onAfterRender', function (...args) {
                if (pending) {
                    const skipped = pending; pending = null;
                    try { bound(++skippedSerial, 8192, 'skipped disk');
                        batch.skipped.push({ id:skippedSerial, reason:'no-native-submission', label:skipped.label, lifecycle:lifecycle(), drawRange:{...disk.geometry.drawRange} }); }
                    catch (error) { fail(error); }
                }
                return oldAfter?.apply(this, args);
            });
            for (const method of ['drawArrays', 'drawElements']) {
                const original = gl[method]; need(typeof original === 'function', `missing ${method}`);
                patch(gl, method, function (...args) {
                    const armed = pending; pending = null;
                    if (armed) {
                        try {
                            const count=method === 'drawArrays' ? args[2] : args[1];
                            if(count===0) {
                                // Three can submit a real zero-count call for an
                                // empty drawRange. Forward it without querying a
                                // program or treating it as rendered evidence.
                                bound(++skippedSerial,8192,'skipped disk');
                                batch.skipped.push({id:skippedSerial,reason:'native-zero-count',label:armed.label,
                                    lifecycle:lifecycle(),method,count,drawRange:{...disk.geometry.drawRange}});
                            } else inspect(armed,method,count);
                        } catch (error) { fail(error); }
                    }
                    return original.apply(this, args); // failures never suppress the actual draw
                });
            }
        } catch (error) { for (const restore of restorers.reverse()) restore(); throw error; }
        const drain = () => { const result = { ...batch, queryCounts, historyTruncated,
            totals:{ draws:drawSerial, skipped:skippedSerial, compiles:compileSerial, programs:programs.size, queryCounts:{...totalQueryCounts} },
            active: !stopped, hooksRestored: restored }; batch = { compiles:[], programs:[], draws:[], skipped:[], errors:[] }; queryCounts = {}; return result; };
        return { label(value) { label = { ...value }; }, drain,
            stop() {
                if (!stopped) {
                    stopped = true; pending = null;
                    let restoreErrors = 0;
                    for (const restore of restorers.reverse()) { try { restore(); } catch (error) { restoreErrors++; fail(error); } }
                    restored = restoreErrors === 0;
                }
                return drain();
            } };
    };
}

export function assertNativeDiskBatch(batch) {
    assert(batch, 'Native disk evidence required');
    for(const field of ['errors','draws','skipped','compiles','programs'])assert(Array.isArray(batch[field]),`Native ${field} records required`);
    assert(batch.totals && ['draws','skipped','compiles'].every(field=>Number.isInteger(batch.totals[field])&&batch.totals[field]>=0),'Finite cumulative native record counts required');
    assert(!batch.historyTruncated, 'Native disk observation history must not be truncated');
    assert.equal(batch.errors.length, 0, `Native disk observation errors: ${batch.errors.join('; ')}`);
    for (const event of batch.compiles) {
        assert.equal(event.resetFlag, 0); assert(event.cacheKeyPreserved);
    }
    for(const skipped of batch.skipped) {
        assert(['native-zero-count','no-native-submission'].includes(skipped.reason),'Known skipped disk classification');
        if(skipped.reason==='native-zero-count')assert.equal(skipped.count,0,'Native skipped submission has exactly zero count');
    }
    for (const draw of batch.draws) {
        assert(Number.isInteger(draw.count) && draw.count>0,'Only positive native counts are rendered evidence');
        assert(draw.complete && draw.bindingsUnchanged, 'Native disk query must complete without binding changes');
        assert.equal(draw.uniforms.uDiskUnclipped, draw.expectedFlag);
        if (draw.compiledDuringDraw) assert.equal(draw.uniforms.uDiskUnclipped, 0, 'Compilation first draw uses fallback');
        if (draw.uniforms.uDiskUnclipped === 1) assert(draw.geometryEligible && draw.stickyQualified && draw.program.storageQualified);
    }
    return true;
}

export function assertNativeInclinedParity(main, candidate) {
    assert.equal(candidate.phase, 'original'); assert.equal(Math.abs(candidate.pitch), .48);
    const production = candidate.nativeDiskProof.draws.filter(d => d.label.kind === 'capture' && d.label.draw === 0);
    assert(production.length > 0, 'Inclined parity requires actual candidate disk draws');
    assert(production.some(d => d.uniforms.uDiskUnclipped === 1 && d.geometryEligible && d.program.storageQualified), 'Inclined parity requires nonvacuous native fast-path use');
    assert.equal(candidate.productionSha256, main.productionSha256, 'Native inclined whole-frame A/B PNG parity');
    return { scenario:candidate.scenario, pitch:candidate.pitch, productionSha256:candidate.productionSha256,
        nativeDrawIds:production.map(d => d.id), fastPathDraws:production.filter(d => d.uniforms.uDiskUnclipped === 1).length };
}

export function requiredNativeDiskCaptures() {
    const expected=[];
    const add=(phase,test,captureIndex=0,epoch=0)=>expected.push({phase,...test,captureIndex,epoch});
    for(const test of DISK_PLANE_CASES) {
        if(test.scenario.startsWith('saturn-'))for(const captureIndex of [0,1])add('original-stability',test,captureIndex);
        add('original',test);
    }
    for(let cycle=1;cycle<=REPEAT_CYCLES;cycle++)for(const size of ['alternate','original'])
        for(const test of RESIZE_CASES)add(`resize-${cycle}-${size}`,test);
    for(let cycle=1;cycle<=REPEAT_CYCLES;cycle++) {
        add(`recovery-${cycle}-before`,{scenario:'disk-crossing',pitch:0},0,cycle-1);
        add(`recovery-${cycle}-after`,{scenario:'disk-crossing',pitch:0},0,cycle);
        for(const test of RECOVERY_CONTROLS)add(`recovery-${cycle}-controls`,test,0,cycle);
    }
    return expected;
}

export function assertNativeDiskLifecycle(evidence) {
    assert(Array.isArray(evidence),'Complete phase/case native evidence required');
    const batches=evidence.map(entry=>entry.proof);batches.forEach(assertNativeDiskBatch);
    assert.equal(evidence[0]?.phase,'setup','Setup evidence is first');
    assert.equal(evidence.at(-1)?.phase,'observer-stop','Observer stop evidence is last');
    assert.equal(evidence.filter(e=>e.phase==='setup').length,1);
    assert.equal(evidence.filter(e=>e.phase==='observer-stop').length,1);
    assert(batches.at(-1).hooksRestored,'Native disk hooks restored before closing page');
    const key=entry=>JSON.stringify([entry.phase,entry.scenario,entry.pitch,entry.captureIndex]);
    const expected=new Map(requiredNativeDiskCaptures().map(entry=>[key(entry),entry]));
    const seen=new Set();let crossingCaptures=0;
    const allDraws=[],allCompiles=[];let drawCount=0,compileCount=0,skipCount=0;
    for(const entry of evidence) {
        for(const draw of entry.proof.draws) { assert.equal(draw.id,++drawCount,'Native draw IDs are complete, ordered and unique');allDraws.push(draw); }
        for(const compile of entry.proof.compiles) { assert.equal(compile.id,++compileCount,'Native compile IDs are complete, ordered and unique');allCompiles.push(compile); }
        for(const skipped of entry.proof.skipped)assert.equal(skipped.id,++skipCount,'Native skip IDs are complete, ordered and unique');
        assert.equal(entry.proof.totals.draws,drawCount,'No native draw omitted from a drained batch');
        assert.equal(entry.proof.totals.compiles,compileCount,'No native compile omitted from a drained batch');
        assert.equal(entry.proof.totals.skipped,skipCount,'No native skip omitted from a drained batch');
        if(entry.phase==='setup'||entry.phase==='observer-stop')continue;
        const entryKey=key(entry),planned=expected.get(entryKey);
        assert(planned && !seen.has(entryKey),'Every required native capture occurs once with its exact phase/case/index');seen.add(entryKey);
        const captures=entry.proof.draws.filter(draw=>draw.label.kind==='capture');
        assert(captures.every(draw=>draw.label.scenario===entry.scenario && draw.label.pitch===entry.pitch),'Native capture labels match their enclosing required case');
        const production=captures.filter(draw=>draw.label.draw===0);
        assert(production.length>0,'Every required capture has positive native production-draw evidence');
        for(const draw of production) {
            const label=draw.label;
            assert(label.lensed===true && label.tides===true && label.diskOn===true && label.ringsOn===true &&
                label.opacityControl===false && label.identity===false && label.diskDepthTest===true,'Required evidence is the unchanged production draw, not an ablation');
            assert.equal(draw.lifecycle.restores,planned.epoch,'Native production draw belongs to the required recovery epoch');
        }
        if(entry.scenario==='disk-crossing' && Math.abs(entry.pitch)<=.005) {
            assert(captures.every(draw=>draw.uniforms.uDiskUnclipped===0),'Every required plane/dense crossing native draw uses normalized fallback');crossingCaptures++;
        }
    }
    assert.equal(seen.size,expected.size,'Every original, stability, resize and recovery capture has native evidence');
    for(const epoch of [0,1,2]) {
        assert(allCompiles.some(c=>c.lifecycle.restores===epoch && c.resetFlag===0),`Observed compilation/reset in lifecycle epoch ${epoch}`);
        assert(allDraws.some(d=>d.lifecycle.restores===epoch && d.compiledDuringDraw && d.uniforms.uDiskUnclipped===0),`First compiled native draw fallback in epoch ${epoch}`);
        assert(allDraws.some(d=>d.lifecycle.restores===epoch && d.uniforms.uDiskUnclipped===1),`Existing stabilized draws exercise fast path in epoch ${epoch}`);
    }
    return {compiledEpochs:[0,1,2],requiredCaptures:expected.size,crossingFallbackCaptures:crossingCaptures,
        observedDraws:allDraws.length,skippedDraws:skipCount,compiles:allCompiles.length,
        fastPathDraws:allDraws.filter(d=>d.uniforms.uDiskUnclipped===1).length,hooksRestored:true};
}
