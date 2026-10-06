import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { TRAIL_FIXTURE as f } from './black-hole-trail-fixture.mjs';
import { BlackHolePath } from '../src/render/blackHolePath.js';
globalThis.window={};
const {G,WORLD,BH,resetWorld}=await import('../src/state.js'),{eph,resetEphem}=await import('../src/ephemeris.js'),{K}=await import('../src/constants.js'),{addHoleData}=await import('../src/bhEncounters.js'),{advanceBodiesOnly}=await import('../src/physics.js');
for(const [width,height] of [[1100,760],[430,932]]){
 resetWorld();resetEphem();BH.n=0;Object.assign(G,{t:0,darkMatter:false,darkEnergy:false});WORLD.earthDestroyed=WORLD.moonDestroyed=WORLD.sunDestroyed=true;WORLD.plDestroyed.fill(true);
 for(const [x,y,z,rs,vx,vy,vz] of f.holes)addHoleData(x,y,rs,vx-eph.earthVx,vy-eph.earthVy,null,0,0,z,vz);
 const camera=new PerspectiveCamera(48,width/height,.02,1e20),{dist,yaw,pitch}=f.camera;
 const offset=new Vector3(dist*Math.cos(pitch)*Math.cos(yaw),dist*Math.sin(pitch),dist*Math.cos(pitch)*Math.sin(yaw)),target=new Vector3(),pos=new Vector3();
 const histories=Array.from({length:3},()=>new BlackHolePath()),pixelScale=height/2/Math.tan(camera.fov*Math.PI/360);
 for(let k=0;k<=f.steps;k++){
  if(k)assert(advanceBodiesOnly(f.step)>0);
  target.set((eph.earthX+BH.x[0])*K,BH.z[0]*K,-(eph.earthY+BH.y[0])*K);camera.position.copy(target).add(offset);camera.lookAt(target);camera.updateMatrixWorld();
  for(let i=0;i<3;i++){
   pos.set((eph.earthX+BH.x[i])*K,BH.z[i]*K,-(eph.earthY+BH.y[i])*K);
   histories[i].sample(pos.x,pos.y,pos.z,G.t,k*f.step,{scenePerPixel:camera.position.distanceTo(pos)/pixelScale,speed:Math.hypot(eph.earthVx+BH.vx[i],eph.earthVy+BH.vy[i],BH.vz[i])*K,stepLimit:100});
   const projected=pos.clone().project(camera);assert(Math.abs(projected.x)<.8&&Math.abs(projected.y)<.8&&projected.z<1,'all three stay in the frame throughout sampling');
  }
 }
 assert.equal(BH.n,3);assert(histories.every(h=>h.lifetime>10&&h.history.count>100));
 const strength=Math.tan(Math.sqrt(2*BH.rs[0]*K/dist))/Math.tan(camera.fov*Math.PI/360);assert(strength>.004,'fixture must activate actual lensing');
 console.log(`PASS ${width}x${height}: live integrated fixture stays slow on screen and framed, with active lens strength ${strength.toFixed(5)}`);
}
