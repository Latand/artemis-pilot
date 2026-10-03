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
 const resources=new Map(), nativeIds=new WeakMap(), nativeLive=new Set();
 let renderer=null,nextNative=1;
 const state=window.__resourceProbe={phase:'module-load',events:[],snapshots:[]};
 const key=o=>o?.isBufferGeometry?`geometry:${o.id}`:o?.isMaterial?`material:${o.id}`:o?.isTexture?`texture:${o.id}`:o?.isRenderTarget?`target:${o.uuid}`:null;
 const describe=o=>({key:key(o),uuid:o.uuid,id:o.id,type:o.type||o.constructor.name,name:o.name||o.texture?.name||'',width:o.width??o.image?.width,height:o.height??o.image?.height,
  textures:o.textures?.map(t=>key(t)),positionCount:o.attributes?.position?.count,parameters:o.parameters});
 const remember=o=>{const k=key(o);if(!k)return null;let r=resources.get(k);if(!r){r={object:o,owners:new Set()};resources.set(k,r);}return r;};
 const memory=()=>renderer?{...renderer.info.memory,programs:renderer.info.programs.length}:null;
 const event=(type,detail={})=>state.events.push({seq:state.events.length,phase:state.phase,type,...detail,memory:memory()});
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
  const detail={label,phase:state.phase,eventIndex:state.events.length,memory:memory(),nativeLive:[...nativeLive],resources:[]};
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
 report.scope='Diagnostic allocation attribution only; unchanged production and capture helper. 120 original prefix samples, then exact i=199/200 midpoint and two full-resolution capture/restore cycles. No soak acceptance result.';
 report.fixtureRevision=${JSON.stringify(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim())};
 const sample=async (i,label)=>{
  await page.evaluate(label=>{window.__resourceProbe.phase=label;},label);
  const value=await page.evaluate(async i=>{
   const {cam,renderer,camera}=await import('/src/scene.js'),{sunCore}=await import('/src/bodies.js'),{G}=await import('/src/state.js');
   G.focus='free';G.paused=true;G.warp=1;
   const p=i/399,cycle=(1+Math.cos(p*Math.PI*2))/2,dist=40000*(1+.25*Math.sin(p*Math.PI*2)),behind=180000*cycle;
   cam.tgt.copy(sunCore.position).add({x:.10*(dist+behind),y:0,z:behind});cam.dist=dist;cam.distTarget=null;cam.yaw=Math.PI/2;cam.pitch=0;
   window.__coverageFrame();
   const r=await import('/src/river.js');
   return {...r.coverageRead(),i,screen:sunCore.position.clone().project(camera).toArray(),memory:{...renderer.info.memory,programs:renderer.info.programs.length}};
  },i);
  report.frames.push({...value,label});
  return value;
 };
 const snapshot=async label=>{await page.evaluate(label=>{window.__resourceProbe.phase=label;window.__resourceProbe.snapshot(label);},label);};
 await snapshot('before-prefix');await save();
 for(let i=0;i<120;i++){
  await sample(i,'prefix-'+i);
  if(i===0){await snapshot('initial-before-capture');await page.evaluate(()=>{window.__resourceProbe.phase='initial-capture';});await screenshot('initial');await snapshot('initial-restored-before-draw');}
  if([1,2,3,4,5,10,50,119].includes(i))await snapshot('prefix-'+i+'-complete');
  if(i%30===0){console.log('resource prefix',i);await save();}
 }
 await sample(199,'midpoint-199');await snapshot('midpoint-199-complete');
 await sample(200,'midpoint-200');await snapshot('midpoint-before-capture');await save();
 for(let cycle=0;cycle<2;cycle++){
  if(cycle)await sample(200,'repeat-exact-midpoint');
  await page.evaluate(cycle=>{window.__resourceProbe.phase='midpoint-capture-'+cycle;},cycle);
  await screenshot('midpoint-'+cycle);
  await snapshot('midpoint-'+cycle+'-restored-before-draw');
  for(let j=0;j<8;j++){await sample(201+j,'restore-'+cycle+'-'+j);await snapshot('restore-'+cycle+'-'+j+'-complete');if(j===0||j===7)await save();}
 }
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
  probe.phase='test-resize';target.setSize(20,40);geometry.dispose();
  assert.equal(target.width,20);assert.equal(target.height,40);assert.equal(gl.deleted,handle);
  const last=probe.snapshot('disposed');assert.deepEqual(last.memory,{geometries:0,textures:0,programs:0});assert.deepEqual(last.nativeLive,[]);
  assert.equal(last.resources.find(r=>r.key===`geometry:${geometry.id}`).registeredGeometry,true,'the synthetic listener remains installed, independently of allocation count');
  const events=probe.export().events;
  for(const type of ['register-dispose-handler','target-resize-before','target-resize-after','dispose-before','dispose-after','native-create-texture','native-delete-texture','renderer-memory-change'])assert(events.some(e=>e.type===type),type);
  assert(events.some(e=>e.type==='renderer-memory-change'&&e.counter==='textures'&&e.before===1&&e.after===0&&e.phase==='test-resize'));
  assert(events.some(e=>e.type==='dispose-before'&&e.resource.key===`target:${target.uuid}`&&e.stack.includes('setSize')));
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
   assert(interrupted.resourceProbe.events.some(e=>e.type==='target-resize-before'&&e.resource.key===`target:${target.uuid}`));
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
  assert(loop.includes("if(i%30===0){console.log('resource prefix',i);await save();}"),'bounded periodic prefix checkpoints retained');
  assert(loop.includes('if(j===0||j===7)await save();'),'first and last restored draws checkpointed');
  console.log('Resource attribution observes exact IDs, native handle deletion, resize/disposal, owners and counters without changing renderer arguments/results.');
  console.log('Early-kill regression: saved checkpoints retain the trace without finally; partial next writes preserve the prior report and trace limits fail closed.');
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
