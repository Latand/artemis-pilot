import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window={};
const {BH,WORLD,G,bhRegister}=await import('../src/state.js');
const {flowCtx,flowVel}=await import('../src/flowfield.js');
const {K}=await import('../src/constants.js');
// Isolate a moving off-plane BH. The physical law is unchanged: samples
// above/below the current center must point inward with equal magnitudes.
WORLD.earthDestroyed=WORLD.moonDestroyed=WORLD.sunDestroyed=true;WORLD.plDestroyed.fill(1);G.darkEnergy=false;
BH.n=1;flowCtx.starCount=0;flowCtx.earthScX=300;flowCtx.earthScZ=-120;
for(const zKm of [-300000,120000,800000]){
 bhRegister(0,200000,-40000,1,1,2,null,0,0,zKm,3);
 const center=[flowCtx.earthScX+BH.sx[0],BH.sy[0],flowCtx.earthScZ+BH.sz[0]];
 for(const axis of [0,1,2]){
  const above=[...center],below=[...center];above[axis]+=10;below[axis]-=10;
  const a=[0,0,0],b=[0,0,0];flowVel(...above,0,0,0,a);flowVel(...below,0,0,0,b);
  assert(a[axis]<0&&b[axis]>0,`inward around actual BH center axis ${axis}`);
  assert(Math.abs(a[axis]+b[axis])<1e-12);
  assert(a.every((v,j)=>j===axis||Math.abs(v)<1e-12));
 }
 assert.equal(center[1],zKm*K);
}
const source=readFileSync(new URL('../src/river.js',import.meta.url),'utf8');
assert(source.includes('BH.sy[i] - smoothCenter.y'),'GPU field uses same BH height as its mesh');
assert(source.includes('earthV.x + BH.sx[i], BH.sy[i], earthV.z + BH.sz[i]'),'local focus follows 3D position');
assert(source.includes('fvz += BH.vz[frameIdx]'),'moving frame includes vertical velocity');
assert(source.includes('stored.xyz + uBody[own].xyz'),'source-local halo reconstruction on current frame');
assert(source.includes('p - uBody[finalOwner].xyz'),'GPU stores source-local halo positions');
console.log('Moving 3D black-hole field/source alignment smoke passed');
