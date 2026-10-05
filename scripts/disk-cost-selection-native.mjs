// Read-only observation of the existing cost fixture's four settled frames.
import assert from 'node:assert/strict';
import {installNativeDiskFastPathProof,assertNativeDiskBatch} from './native-disk-proof.mjs';
export const SELECTION_POLICY=Object.freeze({device:'mobile',bloom:0,warmupFrames:120,settledFrames:4,
    addedFrames:0,acceptanceFrames:0,maxPositiveDrawsPerSettledFrame:4,
    limitation:'No timing acceptance. Zero/unobserved submissions contain CPU compile linkage, not uploaded-uniform proof.'});
function once(source,from,to){assert.equal(source.split(from).length,2,`Selection observer marker: ${from}`);return source.replace(from,to);}
export function makeSelectionObserver(){
    let source=installNativeDiskFastPathProof.toString();
    source=once(source,'let queryCounts = {}; const totalQueryCounts = {};','let unobservedSerial=0; let queryCounts = {}; const totalQueryCounts = {};');
    source=once(source,'const beforeCompile = material.onBeforeCompile, cacheKey = material.customProgramCacheKey();',
        'const beforeCompile = material.onBeforeCompile, cacheKey = material.customProgramCacheKey(); let observingCompile=false, productionFormat=null, productionFormatCalls=0;');
    source=once(source,"patch(material, 'onBeforeCompile', function (parameters, compileRenderer) {",`const originalFormat=gl.getShaderPrecisionFormat;
            patch(gl,'getShaderPrecisionFormat',function(...args){
                const value=originalFormat.apply(this,args);
                if(observingCompile && args[0]===gl.FRAGMENT_SHADER && args[1]===gl.HIGH_FLOAT){
                    productionFormatCalls++;productionFormat=value?{precision:value.precision,rangeMin:value.rangeMin,rangeMax:value.rangeMax}:null;
                }
                return value;
            });
            patch(material, 'onBeforeCompile', function (parameters, compileRenderer) {`);
    source=once(source,'const result = beforeCompile.apply(this, arguments);',
        'let result;observingCompile=true;productionFormat=null;productionFormatCalls=0;try{result=beforeCompile.apply(this,arguments);}finally{observingCompile=false;}');
    source=once(source,"const highFloat = format(), supported = parameters?.precision === 'highp' && supports(highFloat);",
        "const highFloat=productionFormat, supported=parameters?.precision==='highp' && productionFormatCalls===1 && supports(highFloat);");
    source=once(source,'selectedPrecision: parameters?.precision ?? null, highFloat, supported, stickyQualified,',
        'selectedPrecision: parameters?.precision ?? null, highFloat, productionFormatCalls, supported, stickyQualified,');
    source=once(source,'let batch = { compiles: [], programs: [], draws: [], skipped: [], errors: [] };','let batch = { compiles: [], programs: [], draws: [], skipped: [], unobserved: [], errors: [] };');
    source=once(source,'batch = { compiles:[], programs:[], draws:[], skipped:[], errors:[] };','batch = { compiles:[], programs:[], draws:[], skipped:[], unobserved:[], errors:[] };');
    source=once(source,'submissions:submissionSerial, programs:programs.size, queryCounts:{...totalQueryCounts}',
        'submissions:submissionSerial, unobserved:unobservedSerial, programs:programs.size, queryCounts:{...totalQueryCounts}');
    source=once(source,"need(count > 0 && !query('isContextLost'), 'nonempty live draw required');",
        "record.contextLost=query('isContextLost'); need(count > 0 && !record.contextLost, 'nonempty live draw required');");
    source=once(source,'function inspect(armed, method, count) {',`function inspect(armed, method, count) {
            if(armed.label.kind!=='cost-settled') {
                bound(++unobservedSerial,8192,'unobserved disk');
                batch.unobserved.push({id:unobservedSerial,armId:armed.id,submissionId:submissionSerial,
                    label:armed.label,lifecycle:lifecycle(),method,count,compileSerialAtArm:armed.compileSerial,
                    compileSerialAtDraw:compileSerial,nativeUniformsObserved:false});
                return;
            }`);
    return new Function(`return (${source});`)();
}
export function assertCostSelectionProof({before,settled,stopped,startFrame,samples}){
    const batches=[before,settled,stopped];batches.forEach(assertNativeDiskBatch);
    assert.equal(samples.length,4);assert(samples.every((s,i)=>s.frameNo===startFrame+i+1),'Exactly four existing settled frame deliveries');
    assert.equal(before.draws.length,0,'Warmup has no observed native positive draws');
    assert.equal(stopped.draws.length,0,'Stopping adds no draw');assert(stopped.hooksRestored);
    assert.equal(Object.keys(before.queryCounts).length,0,'Warmup adds no observer GL query');
    assert.equal(before.programs.length,0,'No native shader reflection during warmup');
    const allCompiles=batches.flatMap(b=>b.compiles),records=[],counts={draws:0,skipped:0,compiles:0,unobserved:0,arms:0,submissions:0};
    assert(allCompiles.every(c=>c.productionFormatCalls===1),'Observe the production precision query exactly once per compile');
    for(const batch of batches){
        assert(Array.isArray(batch.unobserved));
        for(const key of ['draws','skipped','compiles','unobserved']){
            for(const record of batch[key])assert.equal(record.id,++counts[key],`${key} IDs complete`);
            assert.equal(batch.totals[key],counts[key],`${key} total complete`);
        }
        for(const record of [...batch.draws,...batch.skipped,...batch.unobserved].sort((a,b)=>a.armId-b.armId)){
            assert.equal(record.armId,++counts.arms,'Every armed native scope retained');
            if(record.reason!=='no-native-submission'){
                assert.equal(record.submissionId,++counts.submissions);records.push(record);
            }
        }
        assert.equal(batch.totals.arms,counts.arms);assert.equal(batch.totals.submissions,counts.submissions);
        for(const r of batch.unobserved){assert(Number.isInteger(r.count)&&r.count>0&&r.label.kind!=='cost-settled');assert.equal(r.nativeUniformsObserved,false);assert.equal(r.uniforms,undefined);}
    }
    const linked=new Set();let prior=0;
    for(const r of records){
        assert(Number.isInteger(r.compileSerialAtArm)&&Number.isInteger(r.compileSerialAtDraw)&&r.compileSerialAtArm>=prior&&r.compileSerialAtDraw>=r.compileSerialAtArm&&r.compileSerialAtDraw<=counts.compiles);
        for(let id=r.compileSerialAtArm+1;id<=r.compileSerialAtDraw;id++){
            const c=allCompiles.find(c=>c.id===id);assert(c&&!linked.has(id));assert.equal(c.armId,r.armId);
            assert.equal(c.submissionsBefore,r.submissionId-1);assert.deepEqual(c.label,r.label);assert.deepEqual(c.lifecycle,r.lifecycle);linked.add(id);
        }
        prior=r.compileSerialAtDraw;
    }
    assert.equal(linked.size,allCompiles.length,'All observed CPU resets link to actual submissions');
    assert(allCompiles.length>0,'Observe compilation before deciding selected precision');
    const modes=[];
    for(const frame of samples.map(s=>s.frameNo)){
        const draws=settled.draws.filter(d=>d.lifecycle.frameNo===frame);
        assert(draws.length>0&&draws.length<=4,'Each of four settled frames has bounded positive native evidence');
        for(const d of draws){
            assert.equal(d.label.kind,'cost-settled');assert.equal(d.label.fixture,'saturn-hole-near');
            assert.equal(d.lifecycle.paused,true);assert.equal(d.lifecycle.t,0);assert.equal(d.contextLost,false);
            assert.equal(d.uniforms.uDiskOn,1,'The timed-fixture disk is emitting');
            const reasons=[];
            if(d.compiledDuringDraw)reasons.push('compiled-on-this-positive-draw');
            if(!d.stickyQualified)reasons.push('compile-history-unqualified');
            if(!d.program.storageQualified)reasons.push('bound-program-storage-unqualified');
            if(!d.geometryEligible)reasons.push('conservative-geometry-proof-rejected');
            if(!d.camera.perspective||d.camera.parented)reasons.push('camera-ineligible');
            assert.equal(d.uniforms.uDiskUnclipped,reasons.length?0:1,'Mode matches actual reasons');
            modes.push({frame,draw:d.id,flag:d.uniforms.uDiskUnclipped,program:d.program.id,precision:d.program.effectivePrecision,reasons});
        }
    }
    assert.equal(modes.length,settled.draws.length,'No draw outside the four settled frames');
    return{classification:modes.every(d=>d.flag===1)?'all-fast':modes.every(d=>d.flag===0)?'all-fallback':'mixed',
        modes,compiledPrograms:settled.programs.length,linkedCompileResets:linked.size,unobservedWarmupPositive:counts.unobserved,
        warmupNativeUniformsObserved:false,timingAcceptance:false,hooksRestored:true};
}
