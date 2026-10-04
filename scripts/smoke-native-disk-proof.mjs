// CPU-only native-call mocks. No browser, WebGL context, renderer or server.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { WebGLIndexedBufferRenderer } from 'three/src/renderers/webgl/WebGLIndexedBufferRenderer.js';
import { WebGLBufferRenderer } from 'three/src/renderers/webgl/WebGLBufferRenderer.js';
import { finalizeDiskProbe } from './disk-plane-finalize.mjs';
import { installNativeDiskFastPathProof, assertNativeDiskBatch, assertNativeInclinedParity, assertNativeDiskLifecycle, NATIVE_DISK_POLICY, closeNativeDiskResources, boundedNativeOperation, requiredNativeDiskCaptures } from './native-disk-proof.mjs';

function mock(options = {}) {
    const state = { draws:0, calls:[], before:0, after:0, compiles:0, uploaded:false, active:7, framebuffer:{}, restores:0, flag:0 };
    const format = { precision:23, rangeMin:127, rangeMax:127 };
    const uniforms = { uDiskUnclipped:{value:0}, uDiskOn:{value:1}, uOrigin:{value:[1,2,3]}, uNormal:{value:[0,1,0]},
        uViewDepth:{value:[0,0,1]}, uCameraRotation:{value:[1,0,0,0,1,0,0,0,1]},
        uInverseProjection:{value:[1,0,0,0,0,1,0,0,0,0,0,0,0,0,-1,1]}, uNear:{value:.02}, uFar:{value:1000}, uRsUnits:{value:50} };
    for (const u of Object.values(uniforms)) if (Array.isArray(u.value)) { const a=u.value;u.value={toArray:()=>[...a]}; }
    const gl = { CURRENT_PROGRAM:1, ACTIVE_TEXTURE:2, FRAMEBUFFER_BINDING:3, VIEWPORT:4, LINK_STATUS:5, SHADER_TYPE:6,
        COMPILE_STATUS:7, FRAGMENT_SHADER:8, VERTEX_SHADER:9, HIGH_FLOAT:10,
        isContextLost:()=>!!options.lost,
        getShaderPrecisionFormat:()=>options.lowFormat?{precision:10,rangeMin:14,rangeMax:14}:format,
        getParameter(key) { return key===1?state.program:key===2?state.active:key===3?state.framebuffer:[0,0,960,640]; },
        getProgramParameter:()=>!options.linkFailure, getProgramInfoLog:()=>'',
        getAttachedShaders:()=>[{type:9,source:'void main(){}'},{type:8,source:`precision ${state.sourcePrecision||'highp'} float;\n#define HOLE_LAYER ${options.wrongProgram?2:1}\nuniform float uDiskUnclipped;`}],
        getShaderParameter:(shader,key)=>key===6?shader.type:!options.compileFailure,
        getShaderSource:shader=>shader.source,getShaderInfoLog:()=>'',
        getUniformLocation:(_,name)=>options.missingUniform===name?null:name,
        getUniform(_,name) {
            assert(state.uploaded,'Queries must follow uniform upload');
            if(options.throwQuery)throw Error('injected native read failure');
            if(options.gpuMismatch&&name==='uDiskUnclipped')return 1-state.flag;
            const v=uniforms[name].value;return v?.toArray?new Float32Array(v.toArray()):Math.fround(v);
        },
        drawArrays(...args){state.calls.push({method:'drawArrays',args});state.draws++;if(options.drawThrows)throw Error('real draw failed');},
        drawElements(...args){state.calls.push({method:'drawElements',args});state.draws++;if(options.drawThrows)throw Error('real draw failed');} };
    state.program={};
    const material={uniforms,onBeforeCompile(parameters) { state.compiles++;uniforms.uDiskUnclipped.value=options.noReset?1:0; },
        onBeforeRender(){state.before++;},customProgramCacheKey(){return this.onBeforeCompile.toString();}};
    const disk={material,geometry:{drawRange:{start:0,count:6}},onAfterRender(){state.after++;}};
    const renderer={getContext:()=>gl,getCurrentViewport:t=>t.copy({x:0,y:0,z:options.viewportMismatch?840:960,w:640})};
    const camera={isPerspectiveCamera:true,parent:null};
    const original={before:material.onBeforeRender,after:disk.onAfterRender,compile:material.onBeforeCompile,key:material.customProgramCacheKey,
        keyValue:material.customProgramCacheKey(),arrays:gl.drawArrays,elements:gl.drawElements};
    const sandbox={window:{}};vm.runInNewContext(`(${installNativeDiskFastPathProof.toString()})()`,sandbox);
    const observer=sandbox.window.__createNativeDiskFastPathProof(renderer,disk,()=>!options.ineligible,
        ()=>({restores:state.restores,losses:state.restores,contextLost:false,paused:true,t:0}));
    function draw({compile=false,precision='highp',sourcePrecision=precision,flag=1,method='drawElements',skip=false}={}) {
        state.uploaded=false;state.sourcePrecision=sourcePrecision;uniforms.uDiskUnclipped.value=flag;
        material.onBeforeRender(renderer,null,camera,null,disk);
        if(compile){state.program={};material.onBeforeCompile({precision},renderer);}
        state.flag=uniforms.uDiskUnclipped.value;state.uploaded=true;
        try { if(!skip) { if(method==='drawArrays')gl.drawArrays(4,0,6);else gl.drawElements(4,6,5123,0); } } finally { disk.onAfterRender(); }
    }
    function restored(){assert.equal(material.onBeforeRender,original.before);assert.equal(disk.onAfterRender,original.after);
        assert.equal(material.onBeforeCompile,original.compile);assert.equal(material.customProgramCacheKey,original.key);
        assert.equal(material.customProgramCacheKey(),original.keyValue);assert.equal(gl.drawArrays,original.arrays);assert.equal(gl.drawElements,original.elements);}
    return{state,gl,material,disk,renderer,camera,original,observer,draw,restored};
}
const good=mock(), batches=[];
good.gl.drawElements();
assert.equal(Object.keys(good.observer.drain().queryCounts).length,0,'Unrelated native world draw makes zero observer GL queries');
good.state.draws=0;
assert.equal(good.material.customProgramCacheKey(),good.original.keyValue,'Compile wrapper must preserve the exact native cache key');
for(let epoch=0;epoch<3;epoch++){
    good.state.restores=epoch;
    good.observer.label({kind:'setup'});good.draw({compile:true});
    good.observer.label({kind:'capture',scenario:'disk-crossing',pitch:.48,draw:0});good.draw();
    batches.push(good.observer.drain());
}
// An ineligible view uses fallback after the program has been qualified.
const plane=mock({ineligible:true});plane.observer.label({kind:'capture',scenario:'disk-crossing',pitch:0,draw:0});
plane.draw({compile:true});plane.draw({flag:0,method:'drawArrays'});
const planeBatch=plane.observer.stop();assertNativeDiskBatch(planeBatch);plane.restored();
batches.push(planeBatch,good.observer.stop());good.restored();
// These sparse batches test native queries; lifecycle completeness is tested below against all planned captures.
assert.equal(good.state.draws,6,'Observer adds no draws');assert.equal(good.state.before,6);assert.equal(good.state.after,6);assert.equal(good.state.compiles,3);
for(const b of batches)assertNativeDiskBatch(b);
const actual=batches[0].draws[1];assert.equal(actual.uniforms.uDiskUnclipped,1);assert(actual.complete&&actual.program.storageQualified);
assert.equal(batches[0].draws[0].uniforms.uDiskUnclipped,0,'First compiled native draw reset is observed');
assert.equal(actual.uniforms.uNear,Math.fround(.02),'Uniform evidence comes from uploaded float32 values');

for(const [name,opts,pattern] of [
    ['unlinked',{linkFailure:true},/not linked/],['uncompiled',{compileFailure:true},/not compiled/],
    ['wrong program',{wrongProgram:true},/candidate disk layer/],['missing uniform',{missingUniform:'uDiskUnclipped'},/missing active/],
    ['GPU upload mismatch',{gpuMismatch:true},/differs from float32/],['failed query',{throwQuery:true},/injected native read failure/],
    ['viewport mismatch',{viewportMismatch:true},/native viewport differs/],['missing compile reset',{noReset:true},/compile must reset/],
    ['lost context',{lost:true},/nonempty live draw/],
]){
    const x=mock(opts);x.draw({compile:true});const trace=x.observer.stop();
    assert.equal(x.state.draws,1,`${name}: failed observation never suppresses actual draw`);
    assert.match(trace.errors.join('\n'),pattern,name);assert.throws(()=>assertNativeDiskBatch(trace));x.restored();
    assert(trace.hooksRestored,`${name}: query failures do not make successful hook cleanup disappear`);
}
const low=mock({lowFormat:true});low.draw({compile:true});low.draw({flag:0});assertNativeDiskBatch(low.observer.stop());low.restored();
const lowWrong=mock({lowFormat:true});lowWrong.draw({compile:true});lowWrong.draw({flag:1});assert.throws(()=>assertNativeDiskBatch(lowWrong.observer.stop()));lowWrong.restored();
const sticky=mock();sticky.draw({compile:true,precision:'mediump'});const cachedMediump=sticky.state.program;
sticky.draw({compile:true,precision:'highp'});sticky.draw({flag:0});
sticky.state.program=cachedMediump;sticky.draw({flag:0,precision:'mediump'});
const stickyBatch=sticky.observer.stop();assertNativeDiskBatch(stickyBatch);assert(stickyBatch.compiles.every(c=>c.stickyQualified===false));
assert.equal(stickyBatch.compiles.length,2);assert.equal(stickyBatch.draws.at(-1).program.id,1);
assert.equal(stickyBatch.draws.at(-1).program.effectivePrecision,'mediump');assert.equal(stickyBatch.draws.at(-1).compiledDuringDraw,false);sticky.restored();
const stickyWrong=mock();stickyWrong.draw({compile:true,precision:'mediump'});stickyWrong.draw({compile:true,precision:'highp'});stickyWrong.draw({flag:1});
assert.throws(()=>assertNativeDiskBatch(stickyWrong.observer.stop()));stickyWrong.restored();
const wrongPrecision=mock();wrongPrecision.draw({compile:true,precision:'highp',sourcePrecision:'mediump'});wrongPrecision.draw({flag:1,sourcePrecision:'mediump'});
assert.throws(()=>assertNativeDiskBatch(wrongPrecision.observer.stop()));wrongPrecision.restored();
const throwing=mock({drawThrows:true});try{assert.throws(()=>throwing.draw({compile:true}),/real draw failed/);}finally{throwing.observer.stop();throwing.restored();}
const storm=mock({throwQuery:true});storm.draw({compile:true});for(let i=0;i<70;i++)storm.draw();
const stormBatch=storm.observer.stop();assert.equal(stormBatch.errors.length,64);assert(stormBatch.historyTruncated);assert.throws(()=>assertNativeDiskBatch(stormBatch),/truncated/);storm.restored();
// Actual installed Three submits zero-count calls instead of skipping GL.
for(const Renderer of [WebGLIndexedBufferRenderer,WebGLBufferRenderer]) {
    const x=mock();x.disk.geometry.drawRange.count=0;
    x.material.onBeforeRender(x.renderer,null,x.camera,null,x.disk);
    const native=new Renderer(x.gl,{}, {update(){}});native.setMode(4);
    if(native.setIndex)native.setIndex({type:5123,bytesPerElement:2});
    native.render(0,0);x.disk.onAfterRender();native.render(0,6);
    const proof=x.observer.stop();assertNativeDiskBatch(proof);x.restored();
    assert.equal(x.state.calls.length,2,'Both the zero submission and following world draw are forwarded');
    const first=x.state.calls[0];assert.equal(first.args[first.method==='drawArrays'?2:1],0,'Exact zero count is forwarded');
    assert.equal(proof.draws.length,0,'A zero submission cannot count as rendered evidence');
    assert.equal(proof.skipped.length,1);assert.equal(proof.skipped[0].reason,'native-zero-count');
    assert.equal(proof.skipped[0].count,0);assert.equal(Object.keys(proof.queryCounts).length,0,'Zero-count scope and following world draw make no observer GL queries');
}
const skip=mock();skip.disk.geometry.drawRange.count=0;skip.draw({skip:true});skip.gl.drawElements();
const skipBatch=skip.observer.stop();assert.equal(skipBatch.draws.length,0);assert.equal(skipBatch.skipped.length,1);
assert.equal(Object.keys(skipBatch.queryCounts).length,0,'Zero drawRange clears pending scope before the next unrelated world draw');skip.restored();

const main={productionSha256:'same'},candidate={phase:'original',scenario:'disk-crossing',pitch:.48,productionSha256:'same',nativeDiskProof:batches[0]};
assert.equal(assertNativeInclinedParity(main,candidate).fastPathDraws,1);
assert.throws(()=>assertNativeInclinedParity(main,{...candidate,productionSha256:'changed'}),/whole-frame/);
assert.throws(()=>assertNativeInclinedParity(main,{...candidate,nativeDiskProof:{draws:[]}}),/actual candidate disk draws/);
assert.throws(()=>assertNativeInclinedParity(main,{...candidate,nativeDiskProof:{draws:[{...actual,uniforms:{uDiskUnclipped:0}}]}}),/nonvacuous/);
// Build complete, sequential native evidence for all actual capture phases.
const options={},full=mock(options),evidence=[];
full.observer.label({kind:'setup'});full.draw({compile:true});full.draw();
evidence.push({phase:'setup',proof:full.observer.drain()});
for(const test of requiredNativeDiskCaptures()) {
    options.ineligible=test.scenario==='disk-crossing' && Math.abs(test.pitch)<=.005;
    if(full.state.restores!==test.epoch) {
        full.state.restores=test.epoch;full.observer.label({kind:'configure',scenario:test.scenario,pitch:test.pitch});full.draw({compile:true});
    }
    full.observer.label({kind:'capture',scenario:test.scenario,pitch:test.pitch,draw:0,lensed:true,tides:true,
        diskOn:true,ringsOn:true,opacityControl:false,identity:false,diskDepthTest:true});
    full.draw({flag:options.ineligible?0:1});evidence.push({...test,proof:full.observer.drain()});
}
evidence.push({phase:'observer-stop',proof:full.observer.stop()});full.restored();
const summary=assertNativeDiskLifecycle(evidence);
assert.equal(summary.requiredCaptures,88);assert.equal(summary.crossingFallbackCaptures,33);
const mutate=fn=>{const changed=structuredClone(evidence);fn(changed);return changed;};
const denseIndex=evidence.findIndex(e=>e.phase==='original'&&e.scenario==='disk-crossing'&&e.pitch===.0006);
assert(denseIndex>0);
const invalidEvidence=[
    ['only one original dense crossing survives',evidence.filter(e=>e.phase!=='original'||e.scenario!=='disk-crossing'||Math.abs(e.pitch)>.005||e.pitch===0)],
    ['one dense case omitted',mutate(e=>e.splice(denseIndex,1))],
    ['production draw omitted',mutate(e=>e[denseIndex].proof.draws=[])],
    ['ablation substituted for production',mutate(e=>e[denseIndex].proof.draws[0].label.draw=1)],
    ['duplicate case substitution',mutate(e=>e[denseIndex]=structuredClone(e[denseIndex+1]))],
    ['mislabeled dense production',mutate(e=>e[denseIndex].proof.draws[0].label.pitch=.00065)],
    ['zero native count substituted',mutate(e=>e[denseIndex].proof.draws[0].count=0)],
    ['missing stability capture',evidence.filter(e=>!(e.phase==='original-stability'&&e.scenario==='saturn-near-lens'&&e.pitch===.48&&e.captureIndex===1))],
    ['missing resized crossing',evidence.filter(e=>!(e.phase==='resize-1-alternate'&&e.scenario==='disk-crossing'&&e.pitch===0))],
    ['missing recovered crossing',evidence.filter(e=>e.phase!=='recovery-1-after')],
    ['wrong recovery epoch',mutate(e=>e.find(x=>x.phase==='recovery-1-after').proof.draws.filter(d=>d.label.kind==='capture').forEach(d=>d.lifecycle.restores=0))],
    ['hooks not restored',mutate(e=>e.at(-1).proof.hooksRestored=false)],
    ['duplicate native draw ID',mutate(e=>e[denseIndex].proof.draws[0].id--)],
    ['dropped final native evidence',mutate(e=>e.at(-1).proof.totals.draws++)],
];
for(const [name,invalid]of invalidEvidence)assert.throws(()=>assertNativeDiskLifecycle(invalid),undefined,name);

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
console.log('Native disk proof CPU smoke passed: real Three indexed/array zero-count submissions, all 88 required captures/33 crossing captures and 14 completeness negatives; actual-upload timing, compile reset, sticky precision rejection, source precision, viewport/upload failures, raw errors, callback/cache-key cleanup, nonvacuous parity and lifecycle negatives. No browser/GPU executed.');
