import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import * as THREE from 'three';
import {LEGACY_COVERAGE_REF,LEGACY_MAIN_COVERAGE_REF,LEGACY_MAIN_RIVER_INPUTS,FIXED_COVERAGE_ANCESTOR,coverageExpectation,withinPreparedResourceBounds,drawCoveragePreparation,prepareCoverageResources,coverageMainHook,coverageExactStateHook} from './river-coverage-policy.mjs';

assert.equal(coverageExpectation(LEGACY_COVERAGE_REF,false).frames,120);
const actualMainInputs=Object.fromEntries(Object.keys(LEGACY_MAIN_RIVER_INPUTS).map(path=>{
 const blob=ref=>execFileSync('git',['rev-parse',`${ref}:${path}`],{encoding:'utf8'}).trim();
 assert.equal(blob(LEGACY_MAIN_COVERAGE_REF),blob(LEGACY_COVERAGE_REF),'Actual main legacy river is byte-identical to the explicit original control');
 return [path,blob(LEGACY_MAIN_COVERAGE_REF)];
}));
const mainExpectation=coverageExpectation(LEGACY_MAIN_COVERAGE_REF,false,actualMainInputs);
assert.equal(mainExpectation.frames,120);assert.equal(mainExpectation.rule,LEGACY_MAIN_COVERAGE_REF);
assert.equal(mainExpectation.legacyControl,LEGACY_COVERAGE_REF);assert.equal(mainExpectation.sourceRelativeHalos,false);
assert.throws(()=>coverageExpectation(LEGACY_MAIN_COVERAGE_REF,false));
assert.throws(()=>coverageExpectation(LEGACY_MAIN_COVERAGE_REF,true,actualMainInputs));
for(const path of Object.keys(actualMainInputs)){
 assert.throws(()=>coverageExpectation(LEGACY_MAIN_COVERAGE_REF,false,{...actualMainInputs,[path]:'0'.repeat(40)}));
 const missing={...actualMainInputs};delete missing[path];assert.throws(()=>coverageExpectation(LEGACY_MAIN_COVERAGE_REF,false,missing));
}
assert.throws(()=>coverageExpectation('0'.repeat(40),false,actualMainInputs),/No declared/);
for(const ref of ['22cc61dae7c2bbec5043dcf761cf4583b8b8d728','09863eedda25eef36d79e9cf88daa4ff3e377875']){
 const expected=coverageExpectation(ref,true);assert.equal(expected.frames,1200);assert.equal(expected.sourceRelativeHalos,true);assert.equal(expected.rule,FIXED_COVERAGE_ANCESTOR);
 assert.throws(()=>coverageExpectation(ref,false),/No declared/);
}
const bounds={geometries:60,textures:19,programs:16};
assert(withinPreparedResourceBounds(bounds,bounds));
assert(withinPreparedResourceBounds({...bounds,textures:18},bounds),'proven resize disposal dip is below the warmed upper bound');
for(const resource of Object.keys(bounds)){
 assert.equal(withinPreparedResourceBounds({...bounds,[resource]:bounds[resource]+1},bounds),false,`unexpected ${resource} growth must fail`);
 for(const invalid of [NaN,Infinity,-1,undefined,1.5])assert.equal(withinPreparedResourceBounds({...bounds,[resource]:invalid},bounds),false);
}

// Execute the exact serialized full-field readback hook with two independent
// ping-pong targets. A single changed texel or uniform must be observable.
const pixelsA=new Float32Array(16).fill(1),pixelsB=new Float32Array(16).fill(2);
const rtA={texture:{uuid:'A'}},rtB={texture:{uuid:'B'}};
const fieldContext=vm.createContext({TEXW:2,rtA,rtB,Float32Array,Uint8Array,Math,Object,
 renderer:{properties:{get:()=>({__webglFramebuffer:{}})},readRenderTargetPixels:(target,x,y,w,h,pixels)=>pixels.set(target===rtA?pixelsA:pixelsB)},
 river:{frame:7},uniformsShared:{uPhase:{value:3},uBody:{value:[new THREE.Vector3(1,2,3)]}},smoothCenter:new THREE.Vector3(),textureCenter:new THREE.Vector3(),smoothR:10,frameW:0,lastFrameKind:0,lastFrameIdx:0,frameVelScene:[0,0,0]});
vm.runInContext(coverageExactStateHook.replace('export function','function'),fieldContext);
const fieldRead=()=>JSON.parse(JSON.stringify(vm.runInContext('coverageExactState()',fieldContext)));
const originalField=fieldRead();assert.equal(originalField.targets.length,2);assert.equal(originalField.targets[0].texels,4);
pixelsB[15]=3;assert.notDeepEqual(fieldRead(),originalField,'last texel of second target is checked');pixelsB[15]=2;
fieldContext.uniformsShared.uPhase.value=4;assert.notDeepEqual(fieldRead(),originalField);fieldContext.uniformsShared.uPhase.value=3;

async function runPreparation(mode){
 const oldWindow=globalThis.window;
 const cam={tgt:new THREE.Vector3(10,20,30),dist:40000,distTarget:null,yaw:Math.PI/2,pitch:0};
 const camera=new THREE.PerspectiveCamera(48,215/466,.02,1e10),scene=new THREE.Scene(),sunCore=new THREE.Mesh(),sunCorona=new THREE.Mesh(new THREE.SphereGeometry(891.3152,48,32),new THREE.ShaderMaterial());
 scene.add(sunCore,sunCorona);sunCore.position.set(100,0,0);sunCorona.visible=false;
 const viewportSize={pxScale:466/(2*Math.tan(24*Math.PI/180))};
 const G={t:123,paused:true,warp:1,thrustMain:0},keys=new Set(['KeyW']),AP={mode:'off'};
 let frameNo=1,renderCalls=0,programId=null;
 const applyCamera=()=>{cam.tgt.clone();camera.position.copy(cam.tgt).add(new THREE.Vector3(cam.dist*Math.cos(cam.yaw),0,cam.dist*Math.sin(cam.yaw)));camera.lookAt(cam.tgt);};applyCamera();camera.updateMatrixWorld(true);
 const initialCam=JSON.stringify({tgt:cam.tgt.toArray(),dist:cam.dist,yaw:cam.yaw,pitch:cam.pitch,position:camera.position.toArray(),quaternion:camera.quaternion.toArray()});
 const memory={geometries:59,textures:19};
 const renderer={info:{memory,programs:Array(15)},properties:{get:()=>({currentProgram:programId===null?null:{id:programId}})},getContext:()=>({RGBA:6408,UNSIGNED_BYTE:5121,readPixels(){}})};
 const updateBodySurfaceLod=()=>{sunCorona.visible=696.34/camera.position.distanceTo(sunCore.position)*viewportSize.pxScale>=10;};
 const renderFrame=()=>{
  renderCalls++;assert(sunCorona.visible,'actual projected threshold must reveal corona');
  if(mode==='render-throws')throw new Error('render interruption');
  if(mode!=='missing-gpu'){sunCorona.geometry.addEventListener('dispose',function onGeometryDispose(){});memory.geometries++;}
  if(mode!=='missing-program'){programId=42;renderer.info.programs.push({id:42});}
  if(mode==='clock-drift')G.t++;
  if(mode==='input-drift')keys.clear();
  if(mode==='frame-drift')frameNo++;
  if(mode==='field-drift')pixelsB[15]=3;
 };
 try{
  globalThis.window={__coveragePreparing:false,__coverageControlState:()=>({G:{...G},keys:[...keys],AP:{...AP},frameNo,cam:JSON.parse(initialCam)}),__coverageFieldRead:fieldRead};
  const report={};
  const page={evaluate:async fn=>structuredClone(await fn())};
  const screenshot=async name=>{
   assert.equal(name,'resource-preparation-midpoint');assert.equal(window.__coveragePreparing,true);
   viewportSize.pxScale*=2;
   try{window.__coveragePreparation=drawCoveragePreparation({cam,camera,scene,renderer,sunCore,sunCorona,SUN_RADIUS:696.34,viewportSize,applyCamera,updateBodySurfaceLod,renderFrame});}
   finally{viewportSize.pxScale/=2;}
  };
  if(mode==='valid'){
   const prepared=await prepareCoverageResources(page,screenshot,report);assert.equal(renderCalls,1);assert.equal(prepared.programId,42);assert(prepared.projectedSunRadiusPx>18);assert.equal(prepared.gpuPresentBefore,false);assert.equal(prepared.gpuPresentAfter,true);assert.deepEqual(report.preparationState.before,report.preparationState.after);
   assert.equal(report.preparationState.before.field.targets[0].bits,undefined);assert.match(report.preparationState.before.field.targets[0].sha256,/^[a-f0-9]{64}$/);
  }else await assert.rejects(prepareCoverageResources(page,screenshot,report));
  assert.equal(window.__coveragePreparing,false,'temporary preparation dispatch restores even on failure');
  assert.equal(sunCorona.visible,false,'existing visibility restored even after interrupted draw');
  assert.equal(JSON.stringify({tgt:cam.tgt.toArray(),dist:cam.dist,yaw:cam.yaw,pitch:cam.pitch,position:camera.position.toArray(),quaternion:camera.quaternion.toArray()}),initialCam,'camera restored exactly');
 }finally{pixelsB[15]=2;if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;}
}
for(const mode of ['valid','render-throws','missing-gpu','missing-program','clock-drift','input-drift','frame-drift','field-drift'])await runPreparation(mode);

const fixture=readFileSync(new URL('./verify-river-coverage.mjs',import.meta.url),'utf8');
assert(fixture.includes('if(window.__coveragePreparing)return window.__coverageWarmupDraw();lastMobileFrame=-Infinity;frame();'));
assert(!drawCoveragePreparation.toString().includes('updateRiver(')&&!drawCoveragePreparation.toString().includes('frame()'));
assert(coverageMainHook.includes('frameNo,lastMobileFrame:String(lastMobileFrame)'));
assert(fixture.includes('const modes=legacy?[0]:[0,3852,-3852];')&&fixture.includes('const length=legacy?120:400;'));
assert(fixture.includes('withinPreparedResourceBounds(memory,report.resourceBounds)'));
assert(fixture.indexOf('prepareCoverageResources(page,screenshot,report)')<fixture.indexOf('const modes=legacy?'));
assert(fixture.includes('preparedCoronaAtBaseline.gpuPresent')&&fixture.includes('preparedCoronaAtBaseline.programId===prepared.programId'));
assert(fixture.includes("if(process.env.RIVER_PREPARATION_ONLY==='1'){")&&fixture.includes('break coverage;'));
assert(fixture.indexOf('break coverage;')<fixture.indexOf('const modes=legacy?'),'explicit preflight stops before any acceptance sample');
const workflow=readFileSync(new URL('../.github/workflows/river-coverage.yml',import.meta.url),'utf8');
assert(workflow.includes("RIVER_PREPARATION_ONLY: '1'")&&workflow.includes('needs: capture'),'all four preparation preflights gate the long soaks');
console.log('River resource policy: known-source expectations, full fixed-source1200 coverage, render-only corona preparation/restoration, both full GPU targets, clock/input/frame invariance, and unexpected geometry/texture/program growth rejection pass.');
