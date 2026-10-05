import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DISK_PLANE_CASES, RESIZE_CASES, RECOVERY_CONTROLS, REPEAT_CYCLES } from './disk-plane-qa.mjs';

export const NATIVE_DISK_POLICY = Object.freeze({ scope: 'candidate untimed existing draws only',
    addedFrames: 0, addedDraws: 0, addedReadbacks: 0, declaredUntimedPrecompiles: 3,
    maxDraws: 8192, maxCompiles: 64, maxPrograms: 64, maxKeys: 16384,
    queryPolicy: 'Native GL inspection only for the draw armed by the disk material callback, plus reflection once per selected program; production capability reads are observed without added calls; no GL inspection of unrelated world draws. Shader reflection once per actual program. Query counts exclude production and other QA helpers.',
    qualification: 'Compiled highp declaration and native HIGH_FLOAT precision/range qualify storage; IEEE operation rounding is not certified.' });

export function validateNativeDiskHooks(root) {
    const source = readFileSync(resolve(root, 'src/holeOptics.js'), 'utf8');
    for (const marker of ['const diskPrecision=new WeakMap();', 'disk.material.onBeforeCompile=(parameters,renderer)=>{',
        'diskPrecision.set(renderer,supported && diskPrecision.get(renderer)!==false);', 'export function diskSupportUnclipped(input)',
        'disk.material.customProgramCacheKey=()=>{', 'const setDiskMode=mode=>{', '#if !defined(DISK_UNCLIPPED) || DISK_UNCLIPPED == 0 || !defined(HIGH_PRECISION)'])
        assert.equal(source.split(marker).length, 2, `Candidate native observer hook: ${marker}`);
    return { candidateCompileHook:true, statefulKeyForwarded:true, versionedModeChanges:true, staticProgramOracle:true, stickyRejection:true, browserStarted:false };
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

// Serialized into the page. Native inspection is limited to existing positive
// disk submissions. The real key/compile callbacks run once with their original
// receiver/arguments; no observer call evaluates the key merely to inspect it.
export function installNativeDiskFastPathProof() {
    window.__createNativeDiskFastPathProof = (renderer, disk, eligible, lifecycle) => {
        const gl=renderer.getContext(),material=disk.material,restorers=[],programIds=new WeakMap(),programs=new Map();
        let label={kind:'setup'},pending=null,compileSerial=0,drawSerial=0,armSerial=0,submissionSerial=0,keySerial=0,precompileSerial=0;
        let stickyQualified=null,stopped=false,restored=false,historyTruncated=false,skippedSerial=0,scope=null,precompile=null,lastKey=null;
        const empty=()=>({compiles:[],programs:[],draws:[],skipped:[],keys:[],precompiles:[],errors:[]});let batch=empty();
        let queryCounts={};const totalQueryCounts={};
        const query=(name,...args)=>{queryCounts[name]=(queryCounts[name]||0)+1;totalQueryCounts[name]=(totalQueryCounts[name]||0)+1;return gl[name](...args);};
        const need=(ok,message)=>{if(!ok)throw Error(`Native disk proof: ${message}`);};
        const copy=value=>ArrayBuffer.isView(value)||Array.isArray(value)?Array.from(value):value;
        const fail=error=>{if(batch.errors.length<64)batch.errors.push(error.stack||String(error));else historyTruncated=true;};
        const bound=(count,max,name)=>{if(count>max)historyTruncated=true;need(count<=max,`${name} history limit exceeded`);};
        const patch=(object,key,replacement)=>{const descriptor=Object.getOwnPropertyDescriptor(object,key),original=object[key];
            restorers.push(()=>{if(descriptor)Object.defineProperty(object,key,descriptor);else delete object[key];need(object[key]===original,`${key} restoration failed`);});
            object[key]=replacement;need(object[key]===replacement,`${key} cannot be observed`);};
        const formatValue=f=>f?{precision:f.precision,rangeMin:f.rangeMin,rangeMax:f.rangeMax}:null;
        const supports=f=>!!f&&f.precision>=23&&f.rangeMin>=126&&f.rangeMax>=127;
        const format=()=>formatValue(query('getShaderPrecisionFormat',gl.FRAGMENT_SHADER,gl.HIGH_FLOAT));
        const hash=source=>{let h=2166136261;for(let i=0;i<source.length;i++)h=Math.imul(h^source.charCodeAt(i),16777619);return(h>>>0).toString(16).padStart(8,'0');};
        const mode=()=>material.defines?.DISK_UNCLIPPED;
        const qualifiedReads=reads=>reads.length===1&&reads[0].shaderType===gl.FRAGMENT_SHADER&&reads[0].precisionType===gl.HIGH_FLOAT&&supports(reads[0].value)&&!reads[0].error;
        function programInfo(program){
            if(programIds.has(program))return programs.get(programIds.get(program));
            bound(programs.size+1,64,'program');
            const info={id:programs.size+1,linked:query('getProgramParameter',program,gl.LINK_STATUS),programLog:query('getProgramInfoLog',program)||'',shaders:[]};
            programIds.set(program,info.id);programs.set(info.id,info);batch.programs.push(info);
            for(const shader of query('getAttachedShaders',program)||[]){
                const source=query('getShaderSource',shader)||'',type=query('getShaderParameter',shader,gl.SHADER_TYPE),compiled=query('getShaderParameter',shader,gl.COMPILE_STATUS);
                info.shaders.push({type,compiled,source,sourceFingerprint:hash(source),log:query('getShaderInfoLog',shader)||''});need(compiled===true,'bound disk shader is not compiled');
                if(type===gl.FRAGMENT_SHADER){
                    need(/#define\s+HOLE_LAYER\s+1\b/.test(source)&&source.includes('#if !defined(DISK_UNCLIPPED) || DISK_UNCLIPPED == 0 || !defined(HIGH_PRECISION)'),'bound program is not the static candidate disk layer');
                    need(!/if\s*\(\s*uDiskUnclipped\s*</.test(source),'old runtime branch cannot establish static mode');
                    const definitions=[...source.matchAll(/^[ \t]*#define[ \t]+DISK_UNCLIPPED\b([^\n]*)$/gm)];need(definitions.length===1&&/^[01]$/.test(definitions[0][1].trim()),'one native static mode definition required');
                    need(!/^[ \t]*#undef[ \t]+(?:DISK_UNCLIPPED|HIGH_PRECISION)\b/m.test(source),'native mode/precision definition cannot be undefined');
                    const declarations=[...source.matchAll(/precision\s+(highp|mediump|lowp)\s+float\s*;/g)].map(m=>m[1]);need(declarations.length===1,'one native float precision declaration required');
                    info.precisionDeclarations=declarations;info.effectivePrecision=declarations[0];info.staticDefine=Number(definitions[0][1]);
                    const highDefinitions=[...source.matchAll(/^[ \t]*#define[ \t]+HIGH_PRECISION\b([^\n]*)$/gm)];need(highDefinitions.every(m=>m[1].trim()===''),'native precision macro must be the Three marker');info.highPrecisionMacro=highDefinitions.length;
                    need(info.highPrecisionMacro===(info.effectivePrecision==='highp'?1:0),'native precision macro disagrees with declaration');
                    info.mode=info.staticDefine===1&&info.highPrecisionMacro===1?1:0;
                }
            }
            need(info.linked===true,'bound disk program is not linked');need(info.shaders.length===2&&info.shaders.some(s=>s.type===gl.FRAGMENT_SHADER)&&info.shaders.some(s=>s.type===gl.VERTEX_SHADER),'both shader stages required');
            info.highFloat=format();info.storageQualified=info.effectivePrecision==='highp'&&supports(info.highFloat);info.complete=true;return info;
        }
        function inspect(armed,method,count){
            const record={id:++drawSerial,label:armed.label,lifecycle:lifecycle(),method,count,armId:armed.id,submissionId:submissionSerial,
                compileSerialAtArm:armed.compileSerial,compileSerialAtDraw:compileSerial,keySerialAtArm:armed.keySerial,keySerialAtDraw:keySerial,stickyQualified};
            bound(drawSerial,8192,'draw');batch.draws.push(record);need(count>0&&!query('isContextLost'),'nonempty live draw required');
            const program=query('getParameter',gl.CURRENT_PROGRAM),active=query('getParameter',gl.ACTIVE_TEXTURE),framebuffer=query('getParameter',gl.FRAMEBUFFER_BINDING);need(program,'missing CURRENT_PROGRAM');
            const info=programInfo(program);need(info.complete,'bound program qualification is incomplete');
            record.program={id:info.id,linked:info.linked,effectivePrecision:info.effectivePrecision,staticDefine:info.staticDefine,highPrecisionMacro:info.highPrecisionMacro,
                mode:info.mode,storageQualified:info.storageQualified,highFloat:info.highFloat};
            record.viewport=Array.from(query('getParameter',gl.VIEWPORT));const viewport={x:0,y:0,z:0,w:0,copy(v){this.x=v.x;this.y=v.y;this.z=v.z;this.w=v.w;return this;}};
            renderer.getCurrentViewport(viewport);record.rendererViewport=[viewport.x,viewport.y,viewport.z,viewport.w];need(record.viewport.every((v,i)=>v===record.rendererViewport[i]),'native viewport differs from renderer current viewport');
            record.uniforms={};record.cpuUniforms={};
            for(const name of ['uDiskOn','uOrigin','uNormal','uViewDepth','uCameraRotation','uInverseProjection','uNear','uFar','uRsUnits']){
                const location=query('getUniformLocation',program,name);need(location!==null,`missing active ${name}`);const value=copy(query('getUniform',program,location));record.uniforms[name]=value;
                const cpu=material.uniforms[name]?.value;record.cpuUniforms[name]=cpu?.toArray?cpu.toArray().map(Math.fround):Math.fround(cpu);
                need(JSON.stringify(value)===JSON.stringify(record.cpuUniforms[name]),`uploaded ${name} differs from float32 material value`);
            }
            record.runtimeBranchUniformActive=query('getUniformLocation',program,'uDiskUnclipped')!==null;
            const u=record.uniforms;record.camera={perspective:armed.camera.isPerspectiveCamera===true,parented:!!armed.camera.parent};
            record.geometryEligible=eligible({origin:u.uOrigin,normal:u.uNormal,viewDepth:u.uViewDepth,rotation:u.uCameraRotation,inverseProjection:u.uInverseProjection,
                near:u.uNear,far:u.uFar,rsUnits:u.uRsUnits,viewportWidth:record.viewport[2],viewportHeight:record.viewport[3]});
            record.compiledDuringDraw=compileSerial>armed.compileSerial;record.cpuDecision=material.uniforms.uDiskUnclipped.value;record.cpuDefine=mode();record.materialVersion=material.version;
            need(info.staticDefine===record.cpuDefine,'native shader definition disagrees with current material define');
            need(info.mode===record.cpuDecision,'actual static program disagrees with CPU mode decision');
            if(info.mode===1)need(stickyQualified===true&&info.storageQualified&&record.camera.perspective&&!record.camera.parented&&u.uDiskOn>.5&&record.geometryEligible,'native fast program lacks precision or conservative geometry proof');
            record.bindingsUnchanged=query('getParameter',gl.CURRENT_PROGRAM)===program&&query('getParameter',gl.ACTIVE_TEXTURE)===active&&query('getParameter',gl.FRAMEBUFFER_BINDING)===framebuffer;
            need(record.bindingsUnchanged,'read-only queries changed bindings');record.complete=true;
        }
        try{
            const originalFormat=gl.getShaderPrecisionFormat;
            patch(gl,'getShaderPrecisionFormat',function(...args){
                let value,error;try{value=originalFormat.apply(this,args);return value;}catch(e){error=e;throw e;}finally{
                    if(scope){scope.formatReads.push({shaderType:args[0],precisionType:args[1],value:formatValue(value),...(error?{error:String(error)}:{})});}
                }
            });
            const originalKey=material.customProgramCacheKey;
            patch(material,'customProgramCacheKey',function(...args){
                const event={id:++keySerial,label:{...label},lifecycle:lifecycle(),armId:pending?.id??null,precompileId:precompile?.id??null,
                    submissionsBefore:submissionSerial,modeBefore:mode(),versionBefore:material.version,formatReads:[]};
                try{bound(keySerial,16384,'key');batch.keys.push(event);}catch(error){fail(error);}const previous=scope;scope=event;let result;
                try{result=originalKey.apply(this,args);}finally{scope=previous;}
                event.returnedKey=result;event.modeAfter=mode();event.versionAfter=material.version;event.cpuDecision=material.uniforms.uDiskUnclipped.value;event.forwarded=true;
                event.supported=qualifiedReads(event.formatReads);lastKey=event;
                try{
                    need(typeof result==='string'&&[0,1].includes(event.modeAfter),'valid forwarded native key/mode required');
                    need(pending||precompile,'key call must belong to an existing draw or declared precompile');
                    if(event.modeAfter===1)need(event.supported,'fast key requires the production capability read');
                    if(event.modeBefore===1&&event.modeAfter===0&&event.formatReads.length&&!event.supported)stickyQualified=false;
                    if(event.modeBefore!==event.modeAfter)need(event.versionAfter>event.versionBefore,'key-hook mode change must invalidate all renderer versions');
                    event.complete=true;
                }catch(error){fail(error);}return result;
            });
            const beforeCompile=material.onBeforeCompile;
            patch(material,'onBeforeCompile',function(parameters,compileRenderer){
                const event={id:++compileSerial,label:{...label},lifecycle:lifecycle(),armId:pending?.id??null,precompileId:precompile?.id??null,
                    submissionsBefore:submissionSerial,keyId:lastKey?.id??null,selectedPrecision:parameters?.precision??null,formatReads:[]};
                try{bound(compileSerial,64,'compile');batch.compiles.push(event);}catch(error){fail(error);}const previous=scope;scope=event;let result;
                try{result=beforeCompile.apply(this,arguments);}finally{scope=previous;}
                try{
                    need(compileRenderer===renderer,'unexpected compile renderer');need(pending||precompile,'compilation must belong to an existing draw or declared precompile');
                    need(lastKey&&lastKey.returnedKey===parameters?.customProgramCacheKey&&lastKey.armId===event.armId&&lastKey.precompileId===event.precompileId,'compile must use the observed forwarded key');
                    event.staticDefine=parameters?.defines?.DISK_UNCLIPPED;need([0,1].includes(event.staticDefine),'compiled static mode definition required');
                    event.supported=event.selectedPrecision==='highp'&&(event.staticDefine===1?lastKey.supported:qualifiedReads(event.formatReads));
                    stickyQualified=event.supported&&stickyQualified!==false;event.stickyQualified=stickyQualified;
                    event.resultMode=event.staticDefine===1&&event.selectedPrecision==='highp'?1:0;event.cpuDecision=material.uniforms.uDiskUnclipped.value;
                    need(event.cpuDecision===event.resultMode,'compile CPU mode disagrees with static/precision specialization');
                    if(event.resultMode===1)need(stickyQualified===true,'fast compilation lacks qualified storage');event.keyForwarded=true;event.complete=true;
                }catch(error){fail(error);}return result;
            });
            const oldBefore=material.onBeforeRender,oldAfter=disk.onAfterRender;
            patch(material,'onBeforeRender',function(...args){const value=oldBefore?.apply(this,args);if(args[0]===renderer&&args[4]===disk){pending={id:++armSerial,label:{...label},camera:args[2],compileSerial,keySerial};try{bound(armSerial,16384,'armed disk');}catch(error){fail(error);}}return value;});
            patch(disk,'onAfterRender',function(...args){if(pending){const skipped=pending;pending=null;try{bound(++skippedSerial,8192,'skipped disk');batch.skipped.push({id:skippedSerial,armId:skipped.id,reason:'no-native-submission',label:skipped.label,lifecycle:lifecycle(),compileSerialAtArm:skipped.compileSerial,compileSerialAtDraw:compileSerial,keySerialAtArm:skipped.keySerial,keySerialAtDraw:keySerial,drawRange:{...disk.geometry.drawRange}});}catch(error){fail(error);}}return oldAfter?.apply(this,args);});
            for(const method of ['drawArrays','drawElements']){const original=gl[method];need(typeof original==='function',`missing ${method}`);patch(gl,method,function(...args){
                if(precompile)precompile.nativeDraws++;
                const armed=pending;pending=null;if(armed){try{++submissionSerial;const count=method==='drawArrays'?args[2]:args[1];if(count===0){bound(++skippedSerial,8192,'skipped disk');batch.skipped.push({id:skippedSerial,armId:armed.id,submissionId:submissionSerial,reason:'native-zero-count',label:armed.label,lifecycle:lifecycle(),method,count,compileSerialAtArm:armed.compileSerial,compileSerialAtDraw:compileSerial,keySerialAtArm:armed.keySerial,keySerialAtDraw:keySerial,nativeUniformsObserved:false,drawRange:{...disk.geometry.drawRange}});}else inspect(armed,method,count);}catch(error){fail(error);}}
                return original.apply(this,args);
            });}
        }catch(error){for(const restore of restorers.reverse())restore();throw error;}
        const drain=()=>{const result={...batch,queryCounts,historyTruncated,totals:{draws:drawSerial,skipped:skippedSerial,compiles:compileSerial,arms:armSerial,submissions:submissionSerial,programs:programs.size,keys:keySerial,precompiles:precompileSerial,queryCounts:{...totalQueryCounts}},active:!stopped,hooksRestored:restored};batch=empty();queryCounts={};return result;};
        return{label(value){label={...value};},drain,
            precompile(callback){need(!pending&&!precompile&&!stopped,'precompile must be unarmed and non-nested');const event={id:++precompileSerial,label:{...label},before:lifecycle(),submissionsBefore:submissionSerial,keysBefore:keySerial,compilesBefore:compileSerial,nativeDraws:0};bound(precompileSerial,3,'precompile');batch.precompiles.push(event);precompile=event;
                try{return callback();}finally{precompile=null;event.after=lifecycle();event.submissionsAfter=submissionSerial;event.keysAfter=keySerial;event.compilesAfter=compileSerial;
                    try{need(event.nativeDraws===0&&event.submissionsAfter===event.submissionsBefore,'precompile cannot add native draws');need(JSON.stringify(event.before)===JSON.stringify(event.after),'precompile cannot advance the scene');need(event.keysAfter>event.keysBefore,'real precompile key selection required');event.complete=true;}catch(error){fail(error);}}
            },
            stop(){if(!stopped){stopped=true;pending=null;let errors=0;for(const restore of restorers.reverse())try{restore();}catch(error){errors++;fail(error);}restored=errors===0;}return drain();}
        };
    };
}

const storageQualified=f=>!!f&&f.precision>=23&&f.rangeMin>=126&&f.rangeMax>=127;
const productionReadQualified=reads=>Array.isArray(reads)&&reads.length===1&&reads[0].shaderType===35632&&reads[0].precisionType===36338&&!reads[0].error&&storageQualified(reads[0].value);
export function assertNativeDiskBatch(batch) {
    assert(batch,'Native disk evidence required');
    for(const field of ['errors','draws','skipped','compiles','programs','keys','precompiles'])assert(Array.isArray(batch[field]),`Native ${field} records required`);
    assert(batch.totals&&['draws','skipped','compiles','arms','submissions','keys','precompiles'].every(f=>Number.isInteger(batch.totals[f])&&batch.totals[f]>=0),'Finite cumulative native record counts required');
    assert(!batch.historyTruncated,'Native disk observation history must not be truncated');assert.equal(batch.errors.length,0,`Native disk observation errors: ${batch.errors.join('; ')}`);
    for(const key of batch.keys){
        assert(key.complete&&key.forwarded&&typeof key.returnedKey==='string');assert([0,1].includes(key.modeBefore)&&[0,1].includes(key.modeAfter));
        assert(Number.isInteger(key.versionBefore)&&Number.isInteger(key.versionAfter)&&key.versionAfter>=key.versionBefore);
        if(key.modeBefore!==key.modeAfter)assert(key.versionAfter>key.versionBefore,'Changed shared define requires version invalidation');
        assert.equal(key.supported,productionReadQualified(key.formatReads));if(key.modeAfter===1)assert(key.supported,'Fast key is qualified by the actual production read');
    }
    for(const event of batch.compiles){
        assert(event.complete&&event.keyForwarded);assert([0,1].includes(event.staticDefine));assert.equal(event.resultMode,event.staticDefine===1&&event.selectedPrecision==='highp'?1:0);assert.equal(event.cpuDecision,event.resultMode);
        assert(Number.isInteger(event.keyId)&&event.keyId>0,'Compilation has a real forwarded key');
        assert((Number.isInteger(event.armId)&&event.armId>0&&event.precompileId===null)||(event.armId===null&&Number.isInteger(event.precompileId)&&event.precompileId>0),'Compilation belongs to a draw or declared precompile');
        assert(Number.isInteger(event.submissionsBefore)&&event.submissionsBefore>=0);
        if(event.resultMode===1)assert(event.supported&&event.stickyQualified,'Static fast compilation must be qualified');
    }
    for(const event of batch.precompiles){
        assert(event.complete&&event.nativeDraws===0);assert.deepEqual(event.before,event.after,'Untimed precompile adds no scene frame');assert.equal(event.submissionsBefore,event.submissionsAfter);
        assert(Number.isInteger(event.keysBefore)&&event.keysAfter>event.keysBefore);assert(Number.isInteger(event.compilesBefore)&&event.compilesAfter>=event.compilesBefore);
    }
    for(const record of [...batch.draws,...batch.skipped]){
        assert(Number.isInteger(record.armId)&&record.armId>0);assert(Number.isInteger(record.compileSerialAtArm)&&record.compileSerialAtArm>=0&&Number.isInteger(record.compileSerialAtDraw)&&record.compileSerialAtDraw>=record.compileSerialAtArm);
        assert(Number.isInteger(record.keySerialAtArm)&&record.keySerialAtArm>=0&&Number.isInteger(record.keySerialAtDraw)&&record.keySerialAtDraw>=record.keySerialAtArm);
        if(record.reason==='no-native-submission')assert.equal(record.submissionId,undefined);else assert(Number.isInteger(record.submissionId)&&record.submissionId>0);
    }
    for(const skipped of batch.skipped){
        assert(['native-zero-count','no-native-submission'].includes(skipped.reason));
        if(skipped.reason==='native-zero-count'){assert.equal(skipped.count,0);assert.equal(skipped.nativeUniformsObserved,false,'Zero-count submissions are not uploaded-uniform proof');assert.equal(skipped.uniforms,undefined);assert.equal(skipped.program,undefined);}
    }
    for(const draw of batch.draws){
        assert(Number.isInteger(draw.count)&&draw.count>0);assert(draw.complete&&draw.bindingsUnchanged);
        assert.equal(draw.program.mode,draw.program.staticDefine===1&&draw.program.highPrecisionMacro===1?1:0);
        assert.equal(draw.program.highPrecisionMacro,draw.program.effectivePrecision==='highp'?1:0);assert.equal(draw.program.staticDefine,draw.cpuDefine);
        assert.equal(draw.program.mode,draw.cpuDecision,'Native program must match the current CPU decision');
        assert.equal(draw.compiledDuringDraw,draw.compileSerialAtDraw>draw.compileSerialAtArm);
        assert.deepEqual(draw.uniforms,draw.cpuUniforms);assert.equal(draw.uniforms.uDiskUnclipped,undefined,'Mode proof comes from the native shader definition');
        if(draw.program.mode===1)assert(draw.geometryEligible&&draw.stickyQualified&&draw.program.storageQualified&&draw.camera.perspective&&!draw.camera.parented&&draw.uniforms.uDiskOn>.5);
    }
    return true;
}

export function assertNativeInclinedParity(main, candidate) {
    assert.equal(candidate.phase, 'original'); assert.equal(Math.abs(candidate.pitch), .48);
    const production = candidate.nativeDiskProof.draws.filter(d => d.label.kind === 'capture' && d.label.draw === 0);
    assert(production.length > 0, 'Inclined parity requires actual candidate disk draws');
    assert(production.some(d => d.program.mode === 1 && d.geometryEligible && d.program.storageQualified), 'Inclined parity requires nonvacuous native fast-path use');
    assert.equal(candidate.productionSha256, main.productionSha256, 'Native inclined whole-frame A/B PNG parity');
    return { scenario:candidate.scenario, pitch:candidate.pitch, productionSha256:candidate.productionSha256,
        nativeDrawIds:production.map(d => d.id), fastPathDraws:production.filter(d => d.program.mode === 1).length };
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
    const allDraws=[],allCompiles=[],allSubmissions=[],allKeys=[],allPrecompiles=[],allPrograms=[];let drawCount=0,compileCount=0,skipCount=0,armCount=0,submissionCount=0,keyCount=0,precompileCount=0;
    for(const entry of evidence) {
        for(const draw of entry.proof.draws) { assert.equal(draw.id,++drawCount,'Native draw IDs are complete, ordered and unique');allDraws.push(draw); }
        for(const compile of entry.proof.compiles) { assert.equal(compile.id,++compileCount,'Native compile IDs are complete, ordered and unique');allCompiles.push(compile); }
        for(const skipped of entry.proof.skipped)assert.equal(skipped.id,++skipCount,'Native skip IDs are complete, ordered and unique');
        for(const event of entry.proof.keys){assert.equal(event.id,++keyCount);allKeys.push(event);}
        for(const event of entry.proof.precompiles){assert.equal(event.id,++precompileCount);allPrecompiles.push(event);}
        allPrograms.push(...entry.proof.programs);
        assert.equal(entry.proof.totals.keys,keyCount);assert.equal(entry.proof.totals.precompiles,precompileCount);
        const arms=[...entry.proof.draws,...entry.proof.skipped].sort((a,b)=>a.armId-b.armId);
        for(const record of arms) {
            assert.equal(record.armId,++armCount,'Disk arm IDs are complete, ordered and unique');
            if(record.reason!=='no-native-submission') {
                assert.equal(record.submissionId,++submissionCount,'Native submission IDs follow disk arm order without omission');
                allSubmissions.push(record);
            }
        }
        assert.equal(entry.proof.totals.draws,drawCount,'No native draw omitted from a drained batch');
        assert.equal(entry.proof.totals.compiles,compileCount,'No native compile omitted from a drained batch');
        assert.equal(entry.proof.totals.skipped,skipCount,'No native skip omitted from a drained batch');
        assert.equal(entry.proof.totals.arms,armCount,'No armed disk draw omitted from a drained batch');
        assert.equal(entry.proof.totals.submissions,submissionCount,'No native submission omitted from a drained batch');
        if(entry.phase==='precompile'){
            assert.equal(entry.proof.precompiles.length,1);assert.equal(entry.proof.draws.length,0);assert.equal(entry.proof.skipped.length,0);
            const event=entry.proof.precompiles[0];assert.equal(event.before.restores,entry.epoch);assert.deepEqual(event.label,{kind:'precompile',afterPhase:entry.afterPhase,epoch:entry.epoch});
            assert.equal(entry.afterPhase,entry.epoch===0?'original':`recovery-${entry.epoch}-controls`);
            assert.equal(entry.scenario,'saturn-near-lens');assert.equal(entry.pitch,.48);
            continue;
        }
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
            assert(captures.every(draw=>draw.program.mode===0),'Every required plane/dense crossing native draw uses normalized fallback');crossingCaptures++;
        }
    }
    assert.equal(seen.size,expected.size,'Every original, stability, resize and recovery capture has native evidence');
    const keyMap=new Map(allKeys.map(k=>[k.id,k])),compileMap=new Map(allCompiles.map(c=>[c.id,c])),programMap=new Map(allPrograms.map(p=>[p.id,p]));
    assert.equal(programMap.size,allPrograms.length,'Native program records are unique');
    for(const program of allPrograms){
        const fragment=program.shaders.find(s=>s.type===35632);assert(fragment&&fragment.compiled&&program.linked);
        const definitions=[...fragment.source.matchAll(/^[ \t]*#define[ \t]+DISK_UNCLIPPED\b([^\n]*)$/gm)];assert.equal(definitions.length,1);assert.match(definitions[0][1].trim(),/^[01]$/);assert.equal(program.staticDefine,Number(definitions[0][1]));assert(!/^[ \t]*#undef[ \t]+(?:DISK_UNCLIPPED|HIGH_PRECISION)\b/m.test(fragment.source));
        const precision=[...fragment.source.matchAll(/precision\s+(highp|mediump|lowp)\s+float\s*;/g)];assert.equal(precision.length,1);assert.equal(program.effectivePrecision,precision[0][1]);
        const highDefinitions=[...fragment.source.matchAll(/^[ \t]*#define[ \t]+HIGH_PRECISION\b([^\n]*)$/gm)];assert(highDefinitions.every(m=>m[1].trim()===''));const macro=highDefinitions.length;assert.equal(program.highPrecisionMacro,macro);assert.equal(macro,program.effectivePrecision==='highp'?1:0);
        assert.equal(program.mode,program.staticDefine===1&&macro===1?1:0);assert.equal(program.storageQualified,program.effectivePrecision==='highp'&&storageQualified(program.highFloat));
    }
    for(const draw of allDraws){const program=programMap.get(draw.program.id);assert(program,'Draw references an observed native program');for(const field of Object.keys(draw.program))assert.deepEqual(draw.program[field],program[field],`Draw program ${field} matches raw shader proof`);}
    for(const compile of allCompiles){
        const key=keyMap.get(compile.keyId);assert(key);assert.equal(key.armId,compile.armId);assert.equal(key.precompileId,compile.precompileId);assert.deepEqual(key.label,compile.label);assert.deepEqual(key.lifecycle,compile.lifecycle);
        assert.equal(compile.supported,compile.selectedPrecision==='highp'&&(compile.staticDefine===1?key.supported:productionReadQualified(compile.formatReads)));
    }
    const linkedCompiles=new Set(),linkedKeys=new Set();let priorCompileSerial=0;
    for(const submission of allSubmissions){
        assert(submission.compileSerialAtArm>=priorCompileSerial);assert(submission.compileSerialAtDraw<=compileCount);
        for(let id=submission.compileSerialAtArm+1;id<=submission.compileSerialAtDraw;id++){
            const compile=compileMap.get(id);assert(compile&&!linkedCompiles.has(id));assert.equal(compile.armId,submission.armId);assert.equal(compile.precompileId,null);
            assert.equal(compile.submissionsBefore,submission.submissionId-1);assert.deepEqual(compile.label,submission.label);assert.deepEqual(compile.lifecycle,submission.lifecycle);linkedCompiles.add(id);
        }
        const submissionKeys=allKeys.filter(k=>k.armId===submission.armId);assert.equal(submissionKeys.length,submission.keySerialAtDraw-submission.keySerialAtArm,'Complete key interval for each native submission');
        for(const key of submissionKeys){assert(key.id>submission.keySerialAtArm&&key.id<=submission.keySerialAtDraw);
            assert.equal(key.precompileId,null);assert.equal(key.submissionsBefore,submission.submissionId-1);assert.deepEqual(key.label,submission.label);assert.deepEqual(key.lifecycle,submission.lifecycle);linkedKeys.add(key.id);
        }
        priorCompileSerial=submission.compileSerialAtDraw;
    }
    assert.equal(allPrecompiles.length,3,'Exactly three declared untimed precompiles');
    assert.deepEqual(allPrecompiles.map(p=>p.before.restores),[0,1,2]);
    for(const pre of allPrecompiles){
        for(let id=pre.keysBefore+1;id<=pre.keysAfter;id++){const key=keyMap.get(id);assert(key&&!linkedKeys.has(id));assert.equal(key.precompileId,pre.id);assert.equal(key.armId,null);assert.equal(key.modeAfter,0);assert.deepEqual(key.lifecycle,pre.before);linkedKeys.add(id);}
        for(let id=pre.compilesBefore+1;id<=pre.compilesAfter;id++){const compile=compileMap.get(id);assert(compile&&!linkedCompiles.has(id));assert.equal(compile.precompileId,pre.id);assert.equal(compile.armId,null);assert.equal(compile.resultMode,0);assert.deepEqual(compile.lifecycle,pre.before);linkedCompiles.add(id);}
    }
    assert.equal(linkedCompiles.size,allCompiles.length,'Every compile links to a native submission or declared non-drawing precompile');assert.equal(linkedKeys.size,allKeys.length,'Every actual key call is retained and linked');
    for(const epoch of [0,1,2]){
        assert(allCompiles.some(c=>c.lifecycle.restores===epoch&&c.resultMode===0),`Observed normalized compilation in epoch ${epoch}`);
        assert(allDraws.some(d=>d.lifecycle.restores===epoch&&d.program.mode===1),`Actual fast program in epoch ${epoch}`);
        assert(allDraws.some(d=>d.lifecycle.restores===epoch&&d.program.mode===0),`Actual normalized program in epoch ${epoch}`);
    }
    assert(allDraws.some((d,i)=>d.program.mode===0&&!d.compiledDuringDraw&&allDraws.slice(0,i).some(p=>p.lifecycle.restores===d.lifecycle.restores&&p.program.mode===1)),'Native cached fast-to-fallback transition required');
    return {compiledEpochs:[0,1,2],requiredCaptures:expected.size,crossingFallbackCaptures:crossingCaptures,
        observedDraws:allDraws.length,skippedDraws:skipCount,compiles:allCompiles.length,
        nativeSubmissions:submissionCount,linkedCompiles:linkedCompiles.size,forwardedKeys:linkedKeys.size,precompiles:allPrecompiles.length,
        zeroCountCompileSubmissions:allSubmissions.filter(s=>s.reason==='native-zero-count'&&s.compileSerialAtDraw>s.compileSerialAtArm).length,
        positiveCompilationDraws:allDraws.filter(d=>d.compiledDuringDraw).length,
        fastPathDraws:allDraws.filter(d=>d.program.mode===1).length,hooksRestored:true};
}
