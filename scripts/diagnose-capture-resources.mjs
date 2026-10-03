// Diagnostic only. Runs the unmodified production app and existing coverage
// capture helper. It identifies allocations; it does not change/pass the soak.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

export function installResourceProbe(THREE) {
 const resources=new Map(), nativeIds=new WeakMap(), nativeLive=new Set(),targetIds=new WeakMap();
 const startedAt=performance.now();
 let renderer=null,nextNative=1,nextTarget=1;
 const state=window.__resourceProbe={phase:'module-load',events:[],snapshots:[]};
 const key=o=>{
  if(o?.isRenderTarget){if(!targetIds.has(o))targetIds.set(o,nextTarget++);return `target:${targetIds.get(o)}`;}
  return o?.isBufferGeometry?`geometry:${o.id}`:o?.isMaterial?`material:${o.id}`:o?.isTexture?`texture:${o.id}`:null;
 };
 const describe=o=>({key:key(o),uuid:o.uuid,id:o.id,type:o.type||o.constructor.name,name:o.name||o.texture?.name||'',width:o.width??o.image?.width,height:o.height??o.image?.height,
  textures:o.textures?.map(t=>key(t)),positionCount:o.attributes?.position?.count,parameters:o.parameters});
 const remember=o=>{const k=key(o);if(!k)return null;let r=resources.get(k);if(!r){r={object:o,owners:new Set()};resources.set(k,r);}return r;};
 const memory=()=>renderer?{...renderer.info.memory,programs:renderer.info.programs.length}:null;
 const event=(type,detail={})=>state.events.push({seq:state.events.length,phase:state.phase,atMs:performance.now()-startedAt,type,...detail,memory:memory()});
 const nativeId=o=>{if(!o)return null;if(!nativeIds.has(o))nativeIds.set(o,nextNative++);return nativeIds.get(o);};
 const add=THREE.EventDispatcher.prototype.addEventListener;
 THREE.EventDispatcher.prototype.addEventListener=function(type,listener){
  const result=add.call(this,type,listener);
  if(type==='dispose'&&remember(this))event('register-dispose-handler',{resource:describe(this),handler:listener.name,stack:new Error().stack});
  return result;
 };
 const dispatch=THREE.EventDispatcher.prototype.dispatchEvent;
 THREE.EventDispatcher.prototype.dispatchEvent=function(e){
  const observed=e.type==='dispose'&&remember(this);
  if(observed)event('dispose-before',{resource:describe(this),stack:new Error().stack});
  const result=dispatch.call(this,e);
  if(observed)event('dispose-after',{resource:describe(this)});
  return result;
 };
 const setSize=THREE.RenderTarget.prototype.setSize;
 THREE.RenderTarget.prototype.setSize=function(w,h,d=1){
  remember(this);for(const t of this.textures)remember(t);
  const changed=this.width!==w||this.height!==h||this.depth!==d;
  if(changed)event('target-resize-before',{resource:describe(this),next:[w,h,d],stack:new Error().stack});
  const result=setSize.call(this,w,h,d);
  if(changed)event('target-resize-after',{resource:describe(this)});
  return result;
 };
 for(const Type of [window.WebGLRenderingContext,window.WebGL2RenderingContext]){
  if(!Type)continue;
  for(const method of ['createTexture','deleteTexture']){
   const original=Type.prototype[method];
   Type.prototype[method]=function(...args){
    if(method==='deleteTexture'){
     const id=nativeId(args[0]);event('native-delete-texture',{nativeId:id,stack:new Error().stack});nativeLive.delete(id);
    }
    const result=original.apply(this,args);
    if(method==='createTexture'){
     const id=nativeId(result);nativeLive.add(id);event('native-create-texture',{nativeId:id,stack:new Error().stack});
    }
    return result;
   };
  }
 }
 const visit=(object,scene)=>{
  const owner=`${scene.name||scene.type}:${object.name||object.type}:${object.id}`;
  if(object.geometry)remember(object.geometry)?.owners.add(owner);
  const materials=Array.isArray(object.material)?object.material:[object.material];
  for(const m of materials){
   if(!m)continue;remember(m)?.owners.add(owner);
   for(const value of Object.values(m))if(value?.isTexture)remember(value)?.owners.add(owner);
   for(const [name,u] of Object.entries(m.uniforms||{})){
    const values=Array.isArray(u.value)?u.value:[u.value];
    for(const t of values)if(t?.isTexture)remember(t)?.owners.add(`${owner}/uniform:${name}`);
   }
  }
 };
 state.bind=value=>{
  renderer=value;
  for(const name of ['geometries','textures']){
   let current=renderer.info.memory[name];
   Object.defineProperty(renderer.info.memory,name,{enumerable:true,configurable:true,get:()=>current,set:next=>{
    const before=current;current=next;event('renderer-memory-change',{counter:name,before,after:next,stack:new Error().stack});
   }});
  }
  const render=renderer.render;
  renderer.render=function(scene,camera){scene.traverse(o=>visit(o,scene));return render.call(this,scene,camera);};
  const setTarget=renderer.setRenderTarget;
  renderer.setRenderTarget=function(target,...args){
   if(target){remember(target);for(const t of target.textures)remember(t);if(target.depthTexture)remember(target.depthTexture);}
   return setTarget.call(this,target,...args);
  };
 };
 state.snapshot=label=>{
  const detail={label,phase:state.phase,atMs:performance.now()-startedAt,eventIndex:state.events.length,memory:memory(),nativeLive:[...nativeLive],resources:[]};
  for(const {object,owners} of resources.values()){
   const texture=object.isTexture?object:null;
   const properties=texture?renderer.properties.get(texture):null;
   detail.resources.push({...describe(object),owners:[...owners],nativeId:properties?.__webglTexture?nativeId(properties.__webglTexture):null,
    registeredGeometry:object.isBufferGeometry?!!object._listeners?.dispose?.some(fn=>fn.name==='onGeometryDispose'):undefined});
  }
  state.snapshots.push(detail);return detail;
 };
 state.export=()=>({events:state.events.slice(0,8192),snapshots:state.snapshots.slice(0,64),phase:state.phase,
  eventCount:state.events.length,snapshotCount:state.snapshots.length,limits:{events:8192,snapshots:64},
  truncated:state.events.length>8192||state.snapshots.length>64});
}

export async function saveResourceCheckpoint(page,report,out) {
 if(page)try{
  const trace=await page.evaluate(()=>window.__resourceProbe?.export());
  if(trace){
   report.resourceProbe=trace;
   report.resourceProbeCheckpoint={frames:report.frames.length,phase:trace.phase};
   delete report.probeExportFailure;
   if(trace.truncated){report.diagnosticCompleted=false;report.traceFailure='Resource trace exceeded its explicit evidence limit';}
  }
 }catch(error){report.probeExportFailure=String(error);report.diagnosticCompleted=false;}
 // A kill during writing must leave the previous complete checkpoint readable.
 const pending=resolve(out,'report.next.json'),saved=resolve(out,'report.json');
 await writeFile(pending,JSON.stringify(report,null,2));await rename(pending,saved);
}

export function buildContiguousLoop(source) {
 const start=' const modes=baseline?[0]:[0,3852,-3852];',end=' const frames=report.frames;';
 assert.equal(source.split(start).length,2,'one original mode loop');
 assert.equal(source.split(end).length,2,'one original post-loop assertion block');
 const first=source.indexOf(start),last=source.indexOf(end,first);
 assert(last>first,'original loop precedes acceptance assertions');
 let replay=source.slice(first,last);
 const substitutions=[
  [start,' const modes=[0];'],
  [' const length=baseline?120:400;',' const length=400;'],
  ['for(let i=0;i<length;i++){','for(let i=0;i<202;i++){'],
  ['const sample=await page.evaluate(async({i,length,warp})=>{',"const sample=await page.evaluate(async({i,length,warp})=>{\n    window.__resourceProbe.phase='sample-'+i;"],
  ['const sampled=r.coverageRead();',"const sampled=r.coverageRead();\n    if([0,1,50,100,119,120,198,199,200,201].includes(i))window.__resourceProbe.snapshot('sample-'+i+'-complete');"],
  ["if(i%100===0)console.log('coverage',warp,i,sample.visible,sample.owned,sample.ratio);","if(i%100===0){console.log('coverage',warp,i,sample.visible,sample.owned,sample.ratio);await save();}"]
 ];
 for(const [before,after] of substitutions){assert.equal(replay.split(before).length,2,`exact original loop token: ${before}`);replay=replay.replace(before,after);}
 // Fail closed if adaptation changes anything besides the declared bound,
 // paused mode and read-only observation/checkpoint statements.
 let restored=replay;
 for(const [before,after] of [...substitutions].reverse())restored=restored.replace(after,before);
 assert.equal(restored,source.slice(first,last),'production sample, state setup and capture cadence are byte-identical');
 return replay;
}

const source=await readFile(new URL('./verify-river-coverage.mjs',import.meta.url),'utf8');
const split=' const modes=baseline?[0]:[0,3852,-3852];';
assert.equal(source.split(split).length,2,'exact original coverage prefix');
let prefix=source.slice(0,source.indexOf(split));
// Reuse the actual setup, production hooks, and screenshot helper, adding
// synchronous observations only. The separate loop is not soak acceptance.
prefix=prefix.replace(/^import .*;\n/gm,'');
prefix=prefix.replace('let browser;','let browser,probePage;').replace('const page=await browser.newPage','const page=probePage=await browser.newPage');
const originalSave='const save=()=>writeFile(`${out}/report.json`,JSON.stringify(report,null,2));';
assert.equal(prefix.split(originalSave).length,2,'exact original save hook');
prefix=prefix.replace(originalSave,'const save=()=>saveResourceCheckpoint(probePage,report,out);');
const screenshotStart=' const screenshot=async name=>{';
assert.equal(prefix.split(screenshotStart).length,2,'one original screenshot helper');
prefix=prefix.replace(screenshotStart,screenshotStart+"\n  await page.evaluate(name=>{window.__resourceProbe.phase='capture-'+name;},name);");
const originalScene="if(id.split('?')[0].endsWith('/src/scene.js'))return source+'\\nwindow.__coverageDpr=pr=>{renderQuality.dpr=pr;renderer.setPixelRatio(pr);resizePostProcessing();};';";
assert.equal(prefix.split(originalScene).length,2,'exact scene hook');
const initToken='export const renderer = new THREE.WebGLRenderer({ antialias: true });';
const installation=`(${installResourceProbe.toString()})(THREE);\n${initToken}\nwindow.__resourceProbe.bind(renderer);`;
prefix=prefix.replace(originalScene,`if(id.split('?')[0].endsWith('/src/scene.js')){assert.equal(source.split(${JSON.stringify(initToken)}).length,2);return source.replace(${JSON.stringify(initToken)},${JSON.stringify(installation)})+'\\nwindow.__coverageDpr=pr=>{renderQuality.dpr=pr;renderer.setPixelRatio(pr);resizePostProcessing();};';}`);
const captureReturn='return {width,height,litPixels,dpr:s.renderer.getPixelRatio()';
assert.equal(prefix.split(captureReturn).length,2,'exact same-task capture return');
prefix=prefix.replace(captureReturn,"window.__resourceProbe.snapshot('full-capture-render-complete');"+captureReturn);
const pngWrite="await writeFile(`${out}/${name}.png`,Buffer.from(png.slice(png.indexOf(',')+1),'base64'));";
assert.equal(prefix.split(pngWrite).length,2,'exact canonical PNG write');
prefix=prefix.replace(pngWrite,pngWrite+'await save();');
const restore="await page.evaluate(()=>window.__coverageDpr(.5));await setViewportStable(viewport);";
assert.equal(prefix.split(restore).length,2,'exact soak restoration');
prefix=prefix.replace(restore,"await page.evaluate(()=>{window.__coverageDpr(.5);window.__resourceProbe.snapshot('capture-dpr-restored');});await setViewportStable(viewport);await page.evaluate(()=>window.__resourceProbe.snapshot('capture-viewport-settled-before-draw'));await save();");
const loop=`
 report.scope='Diagnostic geometry attribution only. Contiguous original paused samples i=0 through201, original length400 camera path, original captures at0 and200. No skipped indices, repeated frames, extra warmup or replacement acceptance result.';
 report.fixtureRevision=${JSON.stringify(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())};
 await page.evaluate(()=>window.__resourceProbe.snapshot('before-prefix'));await save();
 ${buildContiguousLoop(source)}
 assert.equal(report.frames.length,202,'every original sample through the first reported growth');
 assert(report.frames.every((frame,index)=>frame.i===index&&frame.warp===0),'contiguous original paused sequence');
 assert.deepEqual(report.captures.map(capture=>capture.name),['0-0','0-200'],'only original captures before the boundary');
 report.diagnosticCompleted=true;await save();
 assert(report.resourceProbe&&!report.traceFailure&&!report.probeExportFailure,'complete resource evidence retained');
}catch(error){report.failure=error.stack||String(error);process.exitCode=1;}
finally{
 await save();await browser?.close();await server.close();
}
`;
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const run=new AsyncFunction('assert','mkdir','writeFile','execFileSync','resolve','chromium','createServer','saveResourceCheckpoint',prefix+loop);
if(process.argv.includes('--self-test')){
 const THREE=await import('three');
 const previousWindow=globalThis.window;
 const originals={add:THREE.EventDispatcher.prototype.addEventListener,dispatch:THREE.EventDispatcher.prototype.dispatchEvent,setSize:THREE.RenderTarget.prototype.setSize};
 try{
  class FakeGL {createTexture(){return {};}deleteTexture(texture){this.deleted=texture;}}
  globalThis.window={WebGLRenderingContext:FakeGL};installResourceProbe(THREE);
  const propertyMap=new WeakMap(),calls=[];
  const renderer={info:{memory:{geometries:0,textures:0},programs:[]},properties:{get(o){if(!propertyMap.has(o))propertyMap.set(o,{});return propertyMap.get(o);}},
   render(scene,camera){calls.push([scene,camera]);return 'render-result';},setRenderTarget(target){calls.push(target);return 'target-result';}};
  const probe=window.__resourceProbe;probe.bind(renderer);probe.phase='test-first-use';
  const geometry=new THREE.BoxGeometry(1,2,3),material=new THREE.MeshBasicMaterial(),mesh=new THREE.Mesh(geometry,material),scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();
  mesh.name='attribution-owner';scene.add(mesh);
  function onGeometryDispose(){renderer.info.memory.geometries--;}
  geometry.addEventListener('dispose',onGeometryDispose);renderer.info.memory.geometries++;
  assert.equal(renderer.render(scene,camera),'render-result');assert.equal(calls[0][0],scene);assert.equal(calls[0][1],camera);
  const target=new THREE.WebGLRenderTarget(10,20),gl=new FakeGL();target.texture.name='probe-known-target';
  assert.equal(renderer.setRenderTarget(target),'target-result');assert.equal(calls[1],target);
  const handle=gl.createTexture();renderer.properties.get(target.texture).__webglTexture=handle;renderer.info.memory.textures++;
  function onRenderTargetDispose(){gl.deleteTexture(handle);renderer.info.memory.textures--;}
  target.addEventListener('dispose',onRenderTargetDispose);
  const first=probe.snapshot('registered');
  assert.deepEqual(first.memory,{geometries:1,textures:1,programs:0});
  assert(first.resources.find(r=>r.key===`geometry:${geometry.id}`).owners.some(name=>name.includes('attribution-owner')));
  assert.equal(first.resources.find(r=>r.key===`texture:${target.texture.id}`).nativeId,first.nativeLive[0]);
  const targetKey=first.resources.find(r=>r.textures?.includes(`texture:${target.texture.id}`)).key;
  const otherTarget=new THREE.WebGLRenderTarget(3,4);renderer.setRenderTarget(otherTarget);
  const otherKey=probe.snapshot('second-target').resources.find(r=>r.textures?.includes(`texture:${otherTarget.texture.id}`)).key;
  assert.notEqual(targetKey,otherKey,'RenderTarget identity does not rely on an absent Three UUID');
  probe.phase='test-resize';target.setSize(20,40);geometry.dispose();
  assert.equal(target.width,20);assert.equal(target.height,40);assert.equal(gl.deleted,handle);
  const last=probe.snapshot('disposed');assert.deepEqual(last.memory,{geometries:0,textures:0,programs:0});assert.deepEqual(last.nativeLive,[]);
  assert.equal(last.resources.find(r=>r.key===`geometry:${geometry.id}`).registeredGeometry,true,'the synthetic listener remains installed, independently of allocation count');
  const events=probe.export().events;
  for(const type of ['register-dispose-handler','target-resize-before','target-resize-after','dispose-before','dispose-after','native-create-texture','native-delete-texture','renderer-memory-change'])assert(events.some(e=>e.type===type),type);
  assert(events.some(e=>e.type==='renderer-memory-change'&&e.counter==='textures'&&e.before===1&&e.after===0&&e.phase==='test-resize'));
  assert(events.some(e=>e.type==='dispose-before'&&e.resource.key===targetKey&&e.stack.includes('setSize')));
  assert(events.every((event,index)=>Number.isFinite(event.atMs)&&event.atMs>=0&&(index===0||event.atMs>=events[index-1].atMs)),'monotonic allocation timestamps');
  const checkpointDir=await mkdtemp(resolve(tmpdir(),'river-resource-checkpoint-'));
  try{
   const report={frames:[{i:30}],diagnosticCompleted:false};
   // This is the same function used by periodic and post-capture save().
   // Read its persisted report directly, without the diagnostic's finally.
   await saveResourceCheckpoint({evaluate:async fn=>fn()},report,checkpointDir);
   const interrupted=JSON.parse(await readFile(resolve(checkpointDir,'report.json'),'utf8'));
   assert.equal(interrupted.diagnosticCompleted,false);
   assert.equal(interrupted.resourceProbeCheckpoint.frames,1);
   assert.equal(interrupted.resourceProbeCheckpoint.phase,'test-resize');
   assert(interrupted.resourceProbe.events.some(e=>e.type==='target-resize-before'&&e.resource.key===targetKey));
   assert(interrupted.resourceProbe.events.some(e=>e.type==='native-delete-texture'&&e.nativeId===first.nativeLive[0]));
   assert(interrupted.resourceProbe.snapshots.some(s=>s.label==='disposed'&&s.memory.textures===0));
   // A kill while the next file is incomplete does not corrupt that report.
   await writeFile(resolve(checkpointDir,'report.next.json'),'{');
   assert.deepEqual(JSON.parse(await readFile(resolve(checkpointDir,'report.json'),'utf8')),interrupted);
   probe.events.push(...Array(8193).fill({type:'overflow-test'}));
   report.diagnosticCompleted=true;
   await saveResourceCheckpoint({evaluate:async fn=>fn()},report,checkpointDir);
   const bounded=JSON.parse(await readFile(resolve(checkpointDir,'report.json'),'utf8'));
   assert.equal(bounded.resourceProbe.events.length,8192);assert.equal(bounded.resourceProbe.truncated,true);
   assert.equal(bounded.diagnosticCompleted,false);assert(bounded.traceFailure);
  }finally{await rm(checkpointDir,{recursive:true,force:true});}
  assert(prefix.includes(pngWrite+'await save();'),'full-size capture checkpoints before later UI screenshot');
  assert(prefix.includes("snapshot('capture-viewport-settled-before-draw'));await save();"),'restoration checkpoints before the next draw');
  assert(loop.includes("if(i%100===0){console.log('coverage',warp,i,sample.visible,sample.owned,sample.ratio);await save();}"),'original periodic logging gains bounded checkpoints');
  const sampleCalls=[],captureCalls=[],order=[],modeCalls=[],replayReport={frames:[]};
  const mockPage={evaluate:async(fn,arg)=>{
   if(typeof arg==='number'){modeCalls.push(arg);assert(String(fn).includes("G.focus='free'"));return;}
   sampleCalls.push(arg);order.push(`sample:${arg.i}`);return {...arg};
  }};
  await new AsyncFunction('page','report','screenshot','save','console',buildContiguousLoop(source))(
   mockPage,replayReport,async name=>{captureCalls.push(name);order.push(`capture:${name}`);},async()=>{}, {log(){}}
  );
  assert.deepEqual(modeCalls,[0],'original mode state is set once, not rewritten on every frame');
  assert.deepEqual(sampleCalls,Array.from({length:202},(_,i)=>({i,length:400,warp:0})),'every original real-frame index through201 is scheduled exactly once');
  assert.deepEqual(captureCalls,['0-0','0-200']);
  assert.deepEqual(order.slice(0,3),['sample:0','capture:0-0','sample:1']);
  assert.deepEqual(order.slice(-3),['sample:200','capture:0-200','sample:201']);
  assert.throws(()=>buildContiguousLoop(source.replace('for(let i=0;i<length;i++){','for(let i=0;i<length;i+=2){')),/exact original loop token/);
  assert.throws(()=>buildContiguousLoop(source.replace('const sampled=r.coverageRead();','const sampled=r.coverageRead();const sampled=r.coverageRead();')),/exact original loop token/);
  const workflow=await readFile(new URL('../.github/workflows/river-resource-diagnostic.yml',import.meta.url),'utf8');
  assert(workflow.includes("push:\n    branches:\n      - 'diagnostic/river-contiguous-geometry'"));
  assert(!workflow.includes('pull_request')&&!workflow.includes('workflow_dispatch'),'new probe has only the exact branch push trigger');
  assert(workflow.includes('ref: ${{ github.sha }}')&&workflow.includes('timeout-minutes: 15'));
  console.log('Resource attribution observes exact IDs, native handle deletion, resize/disposal, owners and counters without changing renderer arguments/results.');
  console.log('Early-kill regression: saved checkpoints retain the trace without finally; partial next writes preserve the prior report and trace limits fail closed.');
  console.log('Contiguous replay regression: all202 original indices, length400, one mode setup and captures0/200; changed/duplicate hook tokens reject. Push trigger is scoped to one new branch.');
 }finally{
  THREE.EventDispatcher.prototype.addEventListener=originals.add;THREE.EventDispatcher.prototype.dispatchEvent=originals.dispatch;THREE.RenderTarget.prototype.setSize=originals.setSize;
  if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
 }
}else if(process.argv.includes('--validate')){
 console.log('Original fixture prefix/capture helper with synchronous observations compiles; acceptance script unchanged.');
}else{
 assert.equal(process.env.DEVICE,'mobile','diagnostic is one bounded mobile job');
 await run(assert,mkdir,writeFile,execFileSync,resolve,chromium,createServer,saveResourceCheckpoint);
}
