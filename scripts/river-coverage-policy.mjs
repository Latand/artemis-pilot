// Acceptance policy shared by the hosted fixture and its negative regressions.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const LEGACY_COVERAGE_REF='cb6601c2a5cdde3a8e9f22f6ac9b17a6837696a6';
// Actual main includes the Jupiter merge but has the identical legacy river.
export const LEGACY_MAIN_COVERAGE_REF='e69158f8bfa6f2d24d786cb60c247fe66afa1420';
export const LEGACY_MAIN_RIVER_INPUTS=Object.freeze({
 'src/river.js':'be3f94a03c6e32f909aa63f6abd8d21f535401c0',
 'src/riverMath.js':'4a6e75131eb3b611d879b9a22b06614f2dc44241',
 'src/flowfield.js':'5751670794aa1f994163dfa4453a28f4559c567d',
});
export const FIXED_COVERAGE_ANCESTOR='bd6a3e6dafce69cd83c3672f748965c349b066d6';

export function coverageExpectation(revision,hasReviewedHaloAncestry,legacyMainInputs){
 if(revision===LEGACY_COVERAGE_REF)return {mode:'legacy-negative-control',sourceRelativeHalos:false,frames:120,rule:LEGACY_COVERAGE_REF};
 if(revision===LEGACY_MAIN_COVERAGE_REF){
  assert.equal(hasReviewedHaloAncestry,false,'Declared legacy main must not have fixed halo ancestry');
  assert.deepEqual(legacyMainInputs,LEGACY_MAIN_RIVER_INPUTS,'Actual main must retain the exact reviewed legacy river inputs');
  return {mode:'legacy-negative-control',sourceRelativeHalos:false,frames:120,rule:LEGACY_MAIN_COVERAGE_REF,
   legacyControl:LEGACY_COVERAGE_REF,sourceProof:legacyMainInputs};
 }
 if(hasReviewedHaloAncestry)return {mode:'source-relative',sourceRelativeHalos:true,frames:1200,rule:FIXED_COVERAGE_ANCESTOR};
 throw new Error(`No declared river coverage expectation for ${revision}`);
}

export function withinPreparedResourceBounds(memory,bounds){
 return ['geometries','textures','programs'].every(key=>Number.isSafeInteger(memory?.[key])&&memory[key]>=0
  &&Number.isSafeInteger(bounds?.[key])&&bounds[key]>=0&&memory[key]<=bounds[key]);
}

export async function prepareCoverageResources(page,screenshot,report){
 const exactState=()=>page.evaluate(()=>({control:window.__coverageControlState(),field:window.__coverageFieldRead()}));
 const before=await exactState();
 await page.evaluate(()=>{window.__coveragePreparing=true;});
 try{await screenshot('resource-preparation-midpoint');}
 finally{await page.evaluate(()=>{window.__coveragePreparing=false;});}
 const after=await exactState();
 report.resourcePreparation=await page.evaluate(()=>window.__coveragePreparation);
 const summarize=state=>({...state,field:{...state.field,targets:state.field.targets.map(({bits,...target})=>({
  ...target,sha256:createHash('sha256').update(Buffer.from(new Uint32Array(bits).buffer)).digest('hex')
 }))}});
 // Compare every bit on the host; keep SHA256 summaries instead of two copies
 // of both full textures in the long-soak JSON artifact.
 report.preparationState={before:summarize(before),after:summarize(after)};
 assert.deepEqual(after,before,'render-only preparation preserves clock/input/camera/frame cadence and all river texels/uniforms');
 const prepared=report.resourcePreparation;
 assert(prepared?.restored&&prepared.coronaVisible&&prepared.projectedSunRadiusPx>=10&&prepared.gpuPresentAfter&&Number.isInteger(prepared.programId),
  'declared full-resolution midpoint draws and prepares the existing corona');
 return prepared;
}

// Serialized into main.js by the test's Vite plugin. It draws existing scene
// objects without advancing frame(), the simulator, or the river compute.
export function drawCoveragePreparation({cam,camera,scene,renderer,sunCore,sunCorona,SUN_RADIUS,viewportSize,applyCamera,updateBodySurfaceLod,renderFrame}){
 const savedCam={tgt:cam.tgt.clone(),dist:cam.dist,distTarget:cam.distTarget,yaw:cam.yaw,pitch:cam.pitch};
 const savedCamera={position:camera.position.clone(),quaternion:camera.quaternion.clone()};
 const visibility=[];scene.traverse(object=>visibility.push([object,object.visible]));
 const registered=()=>!!sunCorona.geometry._listeners?.dispose?.some(fn=>fn.name==='onGeometryDispose');
 const memory=()=>({...renderer.info.memory,programs:renderer.info.programs.length});
 const result={geometry:{id:sunCorona.geometry.id,uuid:sunCorona.geometry.uuid},material:{id:sunCorona.material.id,uuid:sunCorona.material.uuid},
  gpuPresentBefore:registered(),memoryBefore:memory(),midpointIndex:200,trajectoryLength:400,restored:false};
 try{
  const p=200/399,dist=40000*(1+.25*Math.sin(p*Math.PI*2)),behind=180000*(1+Math.cos(p*Math.PI*2))/2;
  cam.tgt.copy(sunCore.position).add({x:.10*(dist+behind),y:0,z:behind});cam.dist=dist;cam.distTarget=null;cam.yaw=Math.PI/2;cam.pitch=0;
  applyCamera();camera.updateMatrixWorld(true);
  // Use the real production threshold/selector, not an unconditional visible flag.
  updateBodySurfaceLod(false,true);
  result.projectedSunRadiusPx=SUN_RADIUS/camera.position.distanceTo(sunCore.position)*viewportSize.pxScale;
  result.coronaVisible=sunCorona.visible;
  const started=performance.now();renderFrame(false);
  const gl=renderer.getContext(),pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
  result.synchronizedFirstUseMs=performance.now()-started;
  result.gpuPresentAfter=registered();result.memoryAfter=memory();
  result.programId=renderer.properties.get(sunCorona.material).currentProgram?.id??null;
  return result;
 }finally{
  cam.tgt.copy(savedCam.tgt);cam.dist=savedCam.dist;cam.distTarget=savedCam.distTarget;cam.yaw=savedCam.yaw;cam.pitch=savedCam.pitch;
  // A deferred first frame can leave the native camera unapplied. Restore
  // the exact captured pose, not a newly derived pose from the orbit controls.
  camera.position.copy(savedCamera.position);camera.quaternion.copy(savedCamera.quaternion);camera.updateMatrixWorld(true);
  for(const [object,visible] of visibility)object.visible=visible;
  result.restored=visibility.every(([object,visible])=>object.visible===visible);
 }
}

export const coverageMainHook=`
window.__coverageControlState=()=>({G:JSON.stringify(G),AP:JSON.stringify(AP),keys:[...keys].sort(),frameNo,lastMobileFrame:String(lastMobileFrame),clock:{elapsedTime:clock.elapsedTime,running:clock.running},cam:{tgt:cam.tgt.toArray(),dist:cam.dist,distTarget:cam.distTarget,yaw:cam.yaw,pitch:cam.pitch},camera:{position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),near:camera.near,far:camera.far,aspect:camera.aspect}});
window.__coverageCoronaState=()=>({geometryUuid:sunCorona.geometry.uuid,materialUuid:sunCorona.material.uuid,gpuPresent:!!sunCorona.geometry._listeners?.dispose?.some(fn=>fn.name==='onGeometryDispose'),programId:renderer.properties.get(sunCorona.material).currentProgram?.id??null});
window.__coverageWarmupDraw=()=>window.__coveragePreparation=(${drawCoveragePreparation.toString()})({cam,camera,scene,renderer,sunCore,sunCorona,SUN_RADIUS,viewportSize,applyCamera,updateBodySurfaceLod,renderFrame});
`;

// Read both complete ping-pong targets and every shared compute/draw uniform.
// Unallocated targets are identified explicitly rather than called valid data.
export const coverageExactStateHook=`
export function coverageExactState(){
 const value=v=>v?.isTexture?{textureUuid:v.uuid}:v?.toArray?v.toArray():Array.isArray(v)?v.map(value):v;
 const targets=[rtA,rtB].map(target=>{
  const allocated=!!renderer.properties.get(target).__webglFramebuffer;
  const pixels=new Float32Array(TEXW*TEXW*4);
  if(allocated)renderer.readRenderTargetPixels(target,0,0,TEXW,TEXW,pixels);
  return {textureUuid:target.texture.uuid,allocated,texels:TEXW*TEXW,bits:Array.from(new Uint32Array(pixels.buffer))};
 });
 return {targets,river:{...river},uniforms:Object.fromEntries(Object.entries(uniformsShared).map(([name,u])=>[name,value(u.value)])),smoothCenter:smoothCenter.toArray(),textureCenter:textureCenter.toArray(),smoothR,frameW,lastFrameKind,lastFrameIdx,frameVelScene:[...frameVelScene]};
}
`;
