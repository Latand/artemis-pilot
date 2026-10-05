// Pure CPU observer tests use actual production callbacks and installed Three
// cache/admission code. GL allocation/reflection/uploads are controlled mocks.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {WebGLIndexedBufferRenderer} from 'three/src/renderers/webgl/WebGLIndexedBufferRenderer.js';
import {WebGLBufferRenderer} from 'three/src/renderers/webgl/WebGLBufferRenderer.js';
import {source as holeSource,harness,makeDisk,makeCamera,pose} from './qa/disk-static-harness.mjs';
import {finalizeDiskProbe} from './disk-plane-finalize.mjs';
import {installNativeDiskFastPathProof,assertNativeDiskBatch,assertNativeInclinedParity,assertNativeDiskLifecycle,NATIVE_DISK_POLICY,closeNativeDiskResources,boundedNativeOperation,requiredNativeDiskCaptures} from './native-disk-proof.mjs';
const eligibilityText=holeSource.slice(holeSource.indexOf('export function diskSupportUnclipped'),holeSource.indexOf('\nexport function makeHoleOptics')).replace('export function','function');
const eligible=new Function(eligibilityText+';return diskSupportUnclipped;')();
function mock(options={}){
 const h=harness(),disk=makeDisk(),material=disk.material,camera=makeCamera(),renderer=h.renderer,gl=renderer.getContext();
 const state={draws:0,calls:[],uploaded:false,active:7,framebuffer:{},restores:0,frameSuccess:0};
 Object.assign(gl,{CURRENT_PROGRAM:1,ACTIVE_TEXTURE:2,FRAMEBUFFER_BINDING:3,VIEWPORT:4,LINK_STATUS:5,SHADER_TYPE:6,COMPILE_STATUS:7,VERTEX_SHADER:35633,
  isContextLost:()=>!!options.lost,
  getParameter:k=>k===1?state.program:k===2?state.active:k===3?state.framebuffer:[0,0,options.viewportMismatch?840:960,640],
  getProgramParameter:()=>!options.linkFailure,getProgramInfoLog:()=>'',
  getAttachedShaders:program=>{const p=program.parameters,precision=options.sourcePrecision||p.precision,mode=options.wrongMode?1-p.defines.DISK_UNCLIPPED:p.defines.DISK_UNCLIPPED;
   const prefix=`precision ${precision} float;\n#define ${precision==='highp'?'HIGH_PRECISION':'MEDIUM_PRECISION'}\n#define HOLE_LAYER ${options.wrongProgram?2:1}\n#define DISK_UNCLIPPED ${mode}\n${options.duplicateMode?'#define DISK_UNCLIPPED 0\n':''}${options.invalidMode?'#define DISK_UNCLIPPED 2\n':''}${options.undefine?'#undef DISK_UNCLIPPED\n':''}`;
   return[{type:35633,source:prefix+p.vertexShader},{type:35632,source:prefix+p.fragmentShader}];},
  getShaderParameter:(shader,key)=>key===6?shader.type:!options.compileFailure,getShaderSource:shader=>shader.source,getShaderInfoLog:()=>'',
  getUniformLocation:(_,name)=>name==='uDiskUnclipped'||options.missingUniform===name?null:name,
  getUniform:(_,name)=>{assert(state.uploaded,'Query follows actual mocked upload');if(options.throwQuery)throw Error('injected native read failure');const value=state.uploaded[name];return options.gpuMismatch&&name==='uRsUnits'?value+1:value;},
  drawArrays(...args){state.calls.push({method:'drawArrays',args});state.draws++;if(options.drawThrows)throw Error('real draw failed');},
  drawElements(...args){state.calls.push({method:'drawElements',args});state.draws++;if(options.drawThrows)throw Error('real draw failed');}});
 const original={before:material.onBeforeRender,after:disk.onAfterRender,compile:material.onBeforeCompile,key:material.customProgramCacheKey,format:gl.getShaderPrecisionFormat,arrays:gl.drawArrays,elements:gl.drawElements};
 const beforeInstall={queries:h.state.queries,version:material.version};const sandbox={window:{}};vm.runInNewContext(`(${installNativeDiskFastPathProof.toString()})()`,sandbox);
 const nativeObserver=sandbox.window.__createNativeDiskFastPathProof(renderer,disk,eligible,()=>({losses:state.restores,restores:state.restores,contextLost:false,frameSuccess:state.frameSuccess,paused:true,t:0}));
 const observer={label:nativeObserver.label,precompile:nativeObserver.precompile,drain:()=>structuredClone(nativeObserver.drain()),stop:()=>structuredClone(nativeObserver.stop())};
 assert.deepEqual({queries:h.state.queries,version:material.version},beforeInstall,'Installation does not invoke the stateful key hook or capability query');
 const originalDirect=renderer.renderBufferDirect;let delivery={};
 renderer.renderBufferDirect=(...args)=>{
  originalDirect(...args);state.program=h.state.draws.at(-1).program;state.uploaded=Object.fromEntries(Object.entries(material.uniforms).map(([name,u])=>[name,u.value?.toArray?new Float32Array(u.value.toArray()):Math.fround(u.value)]));
  if(delivery.skip)return;
  const count=delivery.count??disk.geometry.drawRange.count;
  if(delivery.NativeRenderer){const native=new delivery.NativeRenderer(gl,{}, {update(){}});native.setMode(4);if(native.setIndex)native.setIndex({type:5123,bytesPerElement:2});native.render(0,count);}
  else if(delivery.method==='drawArrays')gl.drawArrays(4,0,count);else gl.drawElements(4,count,5123,0);
 };
 function draw(input={}){delivery=input;pose(camera,input.pitch??.48);state.frameSuccess++;state.uploaded=false;return h.draw(disk,camera);}
 function recover(){state.restores++;h.recover();}
 function precompile(){observer.precompile(()=>h.compile(disk));}
 function restored(){assert.equal(material.onBeforeRender,original.before);assert.equal(disk.onAfterRender,original.after);assert.equal(material.onBeforeCompile,original.compile);assert.equal(material.customProgramCacheKey,original.key);assert.equal(gl.getShaderPrecisionFormat,original.format);assert.equal(gl.drawArrays,original.arrays);assert.equal(gl.drawElements,original.elements);}
 return{h,state,gl,material,disk,renderer,camera,original,observer,draw,recover,precompile,restored};
}
const good=mock();good.gl.drawElements(4,6,5123,0);assert.equal(Object.keys(good.observer.drain().queryCounts).length,0);good.state.draws=0;
good.draw({pitch:0});good.observer.label({kind:'capture',scenario:'disk-crossing',pitch:.48,draw:0});good.draw();good.draw();
const goodBatch=good.observer.stop();assertNativeDiskBatch(goodBatch);good.restored();assert.equal(good.state.draws,3);
assert.equal(goodBatch.draws[0].program.mode,0);assert.equal(goodBatch.draws[1].program.mode,1);assert(goodBatch.draws[1].compiledDuringDraw,'A qualified static fast program may compile on its first draw');
assert.equal(goodBatch.draws[2].program.id,goodBatch.draws[1].program.id);assert.equal(goodBatch.draws[2].compiledDuringDraw,false);
assert(goodBatch.draws.every(d=>d.uniforms.uDiskUnclipped===undefined&&!d.runtimeBranchUniformActive));
let nativeNegatives=0;
for(const [name,opts,pattern]of [
 ['unlinked',{linkFailure:true},/not linked/],['uncompiled',{compileFailure:true},/not compiled/],['wrong layer',{wrongProgram:true},/static candidate disk/],
 ['wrong native mode',{wrongMode:true},/shader definition/],['duplicate mode',{duplicateMode:true},/one native static mode/],['invalid extra mode',{invalidMode:true},/one native static mode/],['mode undefined',{undefine:true},/cannot be undefined/],
 ['missing uniform',{missingUniform:'uNear'},/missing active/],['GPU mismatch',{gpuMismatch:true},/differs from float32/],
 ['query failed',{throwQuery:true},/injected native read/],['viewport mismatch',{viewportMismatch:true},/viewport differs/],['lost context',{lost:true},/nonempty live draw/]
]){const x=mock(opts);x.draw();const proof=x.observer.stop();assert.equal(x.state.draws,1);assert.match(proof.errors.join('\n'),pattern,name);assert.throws(()=>assertNativeDiskBatch(proof));x.restored();nativeNegatives++;}
const low=mock();low.h.state.format={precision:10,rangeMin:14,rangeMax:14};low.draw();low.draw();assertNativeDiskBatch(low.observer.stop());low.restored();
const medium=mock();medium.h.seedPrecision('mediump');medium.draw();medium.h.seedPrecision('highp');medium.h.state.force=true;medium.draw();medium.h.seedPrecision('mediump');medium.draw();const mediumProof=medium.observer.stop();assertNativeDiskBatch(mediumProof);assert(mediumProof.draws.every(d=>d.program.mode===0));medium.restored();
const stale=mock();stale.draw();stale.draw();stale.h.seedPrecision('mediump');stale.h.state.force=true;stale.draw();const staleProof=stale.observer.stop();assertNativeDiskBatch(staleProof);assert.equal(staleProof.draws.at(-1).program.staticDefine,1);assert.equal(staleProof.draws.at(-1).program.mode,0);stale.restored();
const throwing=mock({drawThrows:true});try{assert.throws(()=>throwing.draw(),/real draw failed/);}finally{throwing.observer.stop();throwing.restored();}
for(const NativeRenderer of [WebGLIndexedBufferRenderer,WebGLBufferRenderer]){
 const x=mock();x.draw({pitch:0,count:0,NativeRenderer});const proof=x.observer.stop();assertNativeDiskBatch(proof);x.restored();assert.equal(x.state.calls.length,1);assert.equal(proof.draws.length,0);assert.equal(proof.skipped.length,1);assert.equal(proof.skipped[0].nativeUniformsObserved,false);assert.equal(Object.keys(proof.queryCounts).length,0,'Zero submissions add no observer GL query');
}
const skipped=mock();skipped.draw({skip:true});skipped.gl.drawElements(4,6,5123,0);const skippedProof=skipped.observer.stop();assert.equal(skippedProof.draws.length,0);assert.equal(Object.keys(skippedProof.queryCounts).length,0);skipped.restored();
const unarmed=mock();unarmed.material.customProgramCacheKey();assert.throws(()=>assertNativeDiskBatch(unarmed.observer.stop()),/declared precompile/);unarmed.restored();
const pre=mock();pre.observer.label({kind:'precompile'});pre.precompile();pre.draw();const preProof=pre.observer.stop();assertNativeDiskBatch(preProof);assert.equal(preProof.precompiles.length,1);assert.equal(preProof.compiles[0].armId,null);assert.equal(preProof.compiles[0].precompileId,1);assert.equal(preProof.draws[0].program.mode,1);pre.restored();
// Bounded history must fail acceptance without suppressing a source callback
// or original native draw when a diagnostic exceeds its allowed footprint.
const overflow=mock();for(let i=0;i<66;i++){overflow.material.defines.QA_VARIANT=i;overflow.material.needsUpdate=true;overflow.draw();}
const overflowProof=overflow.observer.stop();assert.equal(overflow.state.draws,66);assert(overflowProof.historyTruncated);assert.equal(overflowProof.compiles.length,64);assert.equal(overflowProof.programs.length,64);assert.throws(()=>assertNativeDiskBatch(overflowProof),/truncated/);overflow.restored();
const keyOverflow=mock();let forwarded=0;keyOverflow.observer.label({kind:'precompile'});keyOverflow.observer.precompile(()=>{for(let i=0;i<=NATIVE_DISK_POLICY.maxKeys;i++){keyOverflow.material.customProgramCacheKey();forwarded++;}});
const keyOverflowProof=keyOverflow.observer.stop();assert.equal(forwarded,NATIVE_DISK_POLICY.maxKeys+1);assert.equal(keyOverflowProof.keys.length,NATIVE_DISK_POLICY.maxKeys);assert(keyOverflowProof.historyTruncated);assert.throws(()=>assertNativeDiskBatch(keyOverflowProof),/truncated/);keyOverflow.restored();
const main={productionSha256:'same'},candidate={phase:'original',scenario:'disk-crossing',pitch:.48,productionSha256:'same',nativeDiskProof:goodBatch};
assert.equal(assertNativeInclinedParity(main,candidate).fastPathDraws,2);assert.throws(()=>assertNativeInclinedParity(main,{...candidate,productionSha256:'changed'}),/whole-frame/);assert.throws(()=>assertNativeInclinedParity(main,{...candidate,nativeDiskProof:{draws:[]}}),/actual candidate/);
function completeEvidence({initialZeroRenderer=null,initialNoSubmission=false}={}){
 const full=mock(),evidence=[];full.observer.label({kind:'setup'});
 for(let i=0;i<(initialZeroRenderer?16:1);i++)full.draw({pitch:0,count:initialZeroRenderer?0:6,NativeRenderer:initialZeroRenderer,skip:initialNoSubmission});
 evidence.push({phase:'setup',proof:full.observer.drain()});
 for(const test of requiredNativeDiskCaptures()){
  if(full.state.restores!==test.epoch){full.recover();full.observer.label({kind:'configure',scenario:test.scenario,pitch:test.pitch});full.draw({pitch:0});}
  full.observer.label({kind:'capture',scenario:test.scenario,pitch:test.pitch,draw:0,lensed:true,tides:true,diskOn:true,ringsOn:true,opacityControl:false,identity:false,diskDepthTest:true});
  full.draw({pitch:test.pitch});evidence.push({...test,proof:full.observer.drain()});
  if(test.scenario==='saturn-near-lens'&&test.pitch===.48&&['original','recovery-1-controls','recovery-2-controls'].includes(test.phase)){
   full.observer.label({kind:'precompile',afterPhase:test.phase,epoch:test.epoch});full.precompile();evidence.push({phase:'precompile',afterPhase:test.phase,scenario:test.scenario,pitch:test.pitch,epoch:test.epoch,proof:full.observer.drain()});
  }
 }
 evidence.push({phase:'observer-stop',proof:full.observer.stop()});full.restored();return evidence;
}
const evidence=completeEvidence(),summary=assertNativeDiskLifecycle(evidence);assert.equal(summary.requiredCaptures,88);assert.equal(summary.crossingFallbackCaptures,33);assert.equal(summary.precompiles,3);
const mutate=fn=>{const changed=structuredClone(evidence);fn(changed);return changed;};
const denseIndex=evidence.findIndex(e=>e.phase==='original'&&e.scenario==='disk-crossing'&&e.pitch===.0006);assert(denseIndex>0);
const invalid=[
 ['only one dense capture',evidence.filter(e=>e.phase!=='original'||e.scenario!=='disk-crossing'||Math.abs(e.pitch)>.005||e.pitch===0)],
 ['dense omitted',mutate(e=>e.splice(denseIndex,1))],['production omitted',mutate(e=>e[denseIndex].proof.draws=[])],
 ['ablation substitute',mutate(e=>e[denseIndex].proof.draws[0].label.draw=1)],['duplicate case',mutate(e=>e[denseIndex]=structuredClone(e[denseIndex+1]))],
 ['mislabeled dense',mutate(e=>e[denseIndex].proof.draws[0].label.pitch=.00065)],['zero count proof',mutate(e=>e[denseIndex].proof.draws[0].count=0)],
 ['stability missing',evidence.filter(e=>!(e.phase==='original-stability'&&e.scenario==='saturn-near-lens'&&e.pitch===.48&&e.captureIndex===1))],
 ['resize missing',evidence.filter(e=>!(e.phase==='resize-1-alternate'&&e.scenario==='disk-crossing'&&e.pitch===0))],['recovery missing',evidence.filter(e=>e.phase!=='recovery-1-after')],
 ['wrong epoch',mutate(e=>e.find(x=>x.phase==='recovery-1-after').proof.draws.filter(d=>d.label.kind==='capture').forEach(d=>d.lifecycle.restores=0))],
 ['restore omitted',mutate(e=>e.at(-1).proof.hooksRestored=false)],['duplicate draw',mutate(e=>e[denseIndex].proof.draws[0].id--)],['dropped totals',mutate(e=>e.at(-1).proof.totals.draws++)],
 ['raw program disagreement',mutate(e=>e.flatMap(x=>x.proof.programs)[0].staticDefine=1)],['CPU only mode substitute',mutate(e=>{const d=e[denseIndex].proof.draws[0];d.program.mode=1;d.cpuDecision=1;})],
 ['precompile missing',evidence.filter(e=>!(e.phase==='precompile'&&e.epoch===1))],['precompile drew',mutate(e=>e.find(x=>x.phase==='precompile').proof.precompiles[0].nativeDraws=1)],
 ['precompile frame advanced',mutate(e=>e.find(x=>x.phase==='precompile').proof.precompiles[0].after.frameSuccess++)],
 ['key omitted',mutate(e=>e.flatMap(x=>x.proof.keys)[0].complete=false)],['key mode invalidation absent',mutate(e=>{const k=e.flatMap(x=>x.proof.keys).find(k=>k.modeBefore!==k.modeAfter);k.versionAfter=k.versionBefore;})],
 ['key interval omitted',mutate(e=>e[denseIndex].proof.draws[0].keySerialAtDraw++)],
 ['precompile mislabeled',mutate(e=>e.find(x=>x.phase==='precompile').proof.precompiles[0].label.epoch=9)],
 ['compile key forged',mutate(e=>e.flatMap(x=>x.proof.compiles)[0].keyId=9999)],
];
for(const[name,proof]of invalid)assert.throws(()=>assertNativeDiskLifecycle(proof),undefined,name);
let submissionNegatives=0;
for(const NativeRenderer of [WebGLIndexedBufferRenderer,WebGLBufferRenderer]){
 const linked=completeEvidence({initialZeroRenderer:NativeRenderer}),result=assertNativeDiskLifecycle(linked);assert.equal(result.skippedDraws,16);assert(result.zeroCountCompileSubmissions>0);
 const first=linked.flatMap(e=>e.proof.draws)[0];assert.equal(first.program.mode,1);assert(first.compiledDuringDraw,'Static first fast compilation is safe only with native definition/qualification proof');
 for(const[name,change]of [
 ['wrong CPU compile mode',e=>e[0].proof.compiles[0].cpuDecision=1],['compile arm missing',e=>delete e[0].proof.compiles[0].armId],
 ['wrong submission predecessor',e=>e[0].proof.compiles[0].submissionsBefore=1],['compile later arm',e=>e[0].proof.compiles[0].armId=2],
 ['zero omits compile interval',e=>e[0].proof.skipped[0].compileSerialAtDraw=0],['zero invents uniform proof',e=>e[0].proof.skipped[0].nativeUniformsObserved=true],
 ['duplicate zero ID',e=>e[0].proof.skipped[1].submissionId=1],['zero removed',e=>e[0].proof.skipped.shift()],
 ['compile wrong epoch',e=>e[0].proof.compiles[0].lifecycle.restores=1],['stale fast geometry',e=>e.flatMap(x=>x.proof.draws)[0].geometryEligible=false],
 ['hide compile flag',e=>e.flatMap(x=>x.proof.draws)[0].compiledDuringDraw=false],['qualification fabricated',e=>e.flatMap(x=>x.proof.keys).find(k=>k.modeAfter===1).formatReads=[]]
 ]){const copy=structuredClone(linked);change(copy);assert.throws(()=>assertNativeDiskLifecycle(copy),undefined,name);submissionNegatives++;}
}
assert.throws(()=>assertNativeDiskLifecycle(completeEvidence({initialNoSubmission:true})),/Every compile links|Every actual key/);submissionNegatives++;
const source=readFileSync(new URL('./probe-disk-plane.mjs',import.meta.url),'utf8');
assert(source.indexOf('qa.nativeDiskObserver =')<source.indexOf('for (let i = 0; i < 8; i++)'));
assert(source.includes("if (variant === 'candidate') await page.evaluate(installNativeDiskFastPathProof)"));
assert(source.includes('await stopNativeDiskObserver();')&&source.includes("nativeStopPromise ||= boundedNativeOperation('native-disk-observer-stop'"));
const callbackMatch=source.match(/flush,closeBrowser:(\(\)=>closeNativeDiskResources\(stopNativeDiskObserver,\(\)=>browser\?\.close\(\)\)),closeServer:/);
assert(callbackMatch,'Exact observer-stop/browser-close integration is testable');
for(const originalFailure of [false,true])for(const failureMode of ['throw','hang','dual-throw','dual-hang']){
    const state={stopped:0,browserClosed:0,serverClosed:0}, report={completed:!originalFailure};
    const closeBrowser=vm.runInNewContext(callbackMatch[1],{
        closeNativeDiskResources:(stop,close)=>closeNativeDiskResources(stop,close,{stopMs:5,closeMs:5}),
        stopNativeDiskObserver:async()=>{state.stopped++;if(failureMode.includes('hang'))await new Promise(()=>{});throw Error('observer stop/query failed');},
        browser:{close:async()=>{state.browserClosed++;if(failureMode==='dual-throw')throw Error('browser close failed');if(failureMode==='dual-hang')await new Promise(()=>{});}}});
    const original=Error('original pixel failure');
    await assert.rejects(finalizeDiskProbe({report,hadOriginalError:originalFailure,originalError:originalFailure?original:undefined,
        verifySources:async()=>{},flush:async()=>{},closeBrowser,closeServer:async()=>{state.serverClosed++;},timeoutMs:100}),
        error=>originalFailure?error===original:error instanceof AggregateError);
    assert.deepEqual(state,{stopped:1,browserClosed:1,serverClosed:1});assert.equal(report.completed,false);
    const details=report.finalization.errors.map(e=>e.error).join('\n');assert.match(details,/native-disk-observer-stop/);
    if(failureMode.startsWith('dual'))assert.match(details,/browser-close: (?:Error: browser close failed|Error: browser-close exceeded)/);
}
let lateResolve,lateMutation=false;
const bounded=boundedNativeOperation('stop',async signal=>{await new Promise(resolve=>{lateResolve=resolve;});signal.throwIfAborted();lateMutation=true;},5);
await assert.rejects(bounded,/stop exceeded/);lateResolve();await Promise.resolve();await Promise.resolve();assert.equal(lateMutation,false,'Timed-out stop cannot publish late evidence');
assert(source.indexOf('await preservePointerCaptures(variant, test, phase, [result])')<source.indexOf("if (variant === 'candidate') assertNativeDiskBatch(result.nativeDiskProof)"));
const helper=installNativeDiskFastPathProof.toString();
assert(!/\.readPixels\(|\.render\(|\.finish\(|\.useProgram\(|\.bindFramebuffer\(|\.activeTexture\(/.test(helper),'Observer only queries existing draws; no rendering, readbacks or binding changes');
assert.deepEqual([NATIVE_DISK_POLICY.addedFrames,NATIVE_DISK_POLICY.addedDraws,NATIVE_DISK_POLICY.addedReadbacks],[0,0,0]);
console.log(`Static native proof: ${nativeNegatives} native failures, ${invalid.length} definition/coverage/key/precompile negatives and ${submissionNegatives} compile/zero-submission negatives plus2 history-cap controls passed;88 captures/33 crossings,3 non-drawing precompiles, native indexed/array forwarding, actual source callbacks and cache keys, exact inclined parity and independent cleanup. No browser/GPU execution.`);
