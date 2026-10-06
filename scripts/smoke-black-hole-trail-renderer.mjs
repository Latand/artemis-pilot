// Exercise the real THREE trail buffers and lifetime without a WebGL context.
// Only the scene/viewport are replaced; shader compilation is covered in CI.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
registerHooks({load(url,context,next){
 if(url===`file://${root}/src/scene.js`)return {format:'module',shortCircuit:true,source:`import * as THREE from '${root}/node_modules/three/build/three.module.js';export const scene=new THREE.Scene();export const viewportSize={w:1100,h:760,pxScale:850};`};
 return next(url,context);
}});
globalThis.window={};globalThis.location={search:''};
const {makeBlackHoleTrail,tickBlackHoleTrails}=await import('../src/render/blackHoleTrails.js');
const {clearBlackHoleTrails}=await import('../src/render/blackHolePath.js');
const {holeRoot}=await import('../src/holeOptics.js');
const trails=Array.from({length:6},()=>makeBlackHoleTrail());
assert(trails.every(t=>t.mesh.parent===holeRoot),'Real traces belong to the unbent hole pass, never distant lensable sky');
const arrays=trails.map(t=>Object.values(t.mesh.geometry.attributes).map(a=>a.array));
for(let k=0;k<=1800;k++){
 tickBlackHoleTrails(false,k/60);
 for(let i=0;i<6;i++)trails[i].update((i+1)*k/120,0,0,k/60,{enabled:true,scenePerPixel:1,speed:i+1,stepLimit:1});
}
assert(trails.every(t=>t.mesh.visible&&t.mesh.geometry.instanceCount>1&&t.mesh.geometry.instanceCount<=256));
trails.forEach((t,i)=>Object.values(t.mesh.geometry.attributes).forEach((a,j)=>assert.equal(a.array,arrays[i][j])));
const before=trails.map(t=>Array.from(t.path.history.points));
tickBlackHoleTrails(true,900);
for(let i=0;i<6;i++)trails[i].update((i+1)*15,0,0,30,{enabled:true,scenePerPixel:100,speed:i+1,stepLimit:1});
trails.forEach((t,i)=>assert.deepEqual(Array.from(t.path.history.points),before[i]));
clearBlackHoleTrails();assert(trails.every(t=>!t.mesh.visible&&t.path.history.count===0&&t.mesh.geometry.instanceCount===0));
let disposed=0;for(const t of trails){t.mesh.geometry.addEventListener('dispose',()=>disposed++);t.mesh.material.addEventListener('dispose',()=>disposed++);t.dispose();}
assert.equal(disposed,12);assert.equal(holeRoot.children.length,0);
console.log('PASS six real trail buffers stay fixed, paused history is stable, reset clears rendering, and disposal releases every resource');
