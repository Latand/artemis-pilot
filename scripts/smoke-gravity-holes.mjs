// Three-hole force explanation uses the live solver, not the ambient river.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = {};
const {G,WORLD,BH,resetWorld,bhMuAt}=await import('../src/state.js');
const {K,PL,LY_KM}=await import('../src/constants.js');
const {resetEphem,snapshotEphem,holeGravityAcceleration}=await import('../src/ephemeris.js');
const {addHoleData,removeHoleData,mergeByDistance,syncHoleScene}=await import('../src/bhEncounters.js');
const {advanceBodiesOnly}=await import('../src/physics.js');
const {getLocalGravityInspection}=await import('../src/gravityInspection.js');
const {gravityContext,holeContributionVectors,sumAcceleration}=await import('../src/gravityInspectorMath.js');
const {flowVel,flowCtx}=await import('../src/flowfield.js');
const {GRAVITY_STARS,ACTIVE_STARS}=await import('../src/universe/activeStars.js');
function fixture(){
 resetWorld();BH.n=0;GRAVITY_STARS.length=0;ACTIVE_STARS.length=0;resetEphem();
 Object.assign(G,{t:0,darkMatter:false,darkEnergy:false,paused:true,focus:'bh:0'});
 WORLD.earthDestroyed=WORLD.moonDestroyed=WORLD.sunDestroyed=true;WORLD.plDestroyed.fill(true);
 addHoleData(1e8,1e8,30,2,3,null,0,0,1e6,4);
 addHoleData(1.02e8,1.01e8,60,-3,1,null,0,0,2e6,-2);
 addHoleData(.99e8,1.03e8,90,1,-2,null,0,0,-1e6,3);
 syncHoleScene();
}
function check(i){
 const s=getLocalGravityInspection('bh:'+i),rows=holeContributionVectors(s,'bh:'+i),expected=[0,0,0];
 holeGravityAcceleration(snapshotEphem(),i,expected);assert.deepEqual(s.net,expected);
 assert(!s.contributions.some(r=>r.id==='bh:'+i));
 const summed=sumAcceleration(s.contributions);summed.forEach((v,k)=>assert(Math.abs(v-expected[k])<1e-13*Math.max(1,Math.abs(v))));
 for(const row of rows){
  const j=Number(row.id.slice(3)),d=[BH.x[j]-BH.x[i],BH.y[j]-BH.y[i],BH.z[j]-BH.z[i]],r=Math.hypot(...d);
  const rs=BH.rs[i]+BH.rs[j],eff=Math.max(r-rs,rs*.02),w=bhMuAt(j,BH.x[i],BH.y[i],BH.z[i],snapshotEphem().t)/(eff*eff*r);
  row.acceleration.forEach((v,k)=>assert(Math.abs(v-d[k]*w)<1e-13*Math.max(1,Math.abs(v))));
 }
 return {s,rows};
}
fixture();
for(let i=0;i<3;i++)assert.equal(check(i).rows.length,2);
console.log('PASS three unequal non-collinear holes: exact net and both other-hole contributions; no self-pull');
const before=JSON.stringify(getLocalGravityInspection('bh:0'));
flowCtx.starCount=0;const a=[],b=[];flowVel(1e5,700,-2e5,0,0,0,a);
BH.obsT.set([.08,2.4,.35]);flowVel(1e5,700,-2e5,0,0,0,b);
assert.deepEqual(a,b);assert.equal(JSON.stringify(getLocalGravityInspection('bh:0')),before);
const river=readFileSync(new URL('../src/river.js',import.meta.url),'utf8');
assert(!river.includes('BH.obsT'), 'GPU weights must be independent of the optical camera lapse');
for(const distance of [1,8e6/K,4e7/K,3e4*LY_KM,3e6*LY_KM])assert.equal(gravityContext(distance,'galaxy','bh:0'),'local');
assert.equal(gravityContext(3e4*LY_KM,'local','earth'),'galaxy');
console.log('PASS camera optical lapse leaves CPU/GPU gravity weights unchanged; selected-hole scope survives all scales');
const old=BH.x[1];assert(advanceBodiesOnly(.01)>0);assert.notEqual(BH.x[1],old);assert.equal(check(0).rows.length,2);
assert.equal(BH.sx[1],BH.x[1]*K);assert.equal(BH.sy[1],BH.z[1]*K);assert.equal(BH.sz[1],-BH.y[1]*K);
console.log('PASS integrated moving sources keep current coordinates and force ledger');
fixture();BH.ev[1]=[{x:BH.x[1],y:BH.y[1],z:BH.z[1],t:0,dmu:BH.mu[1]}];
assert.deepEqual(check(0).rows.map(r=>r.id),['bh:2']);
console.log('PASS not-yet-arrived mass front does not invent an explanatory arrow');
for(const focus of ['bh:0','bh:1','bh:2']){
 fixture();G.focus=focus;BH.x[1]=BH.x[0]+100;BH.y[1]=BH.y[0];BH.z[1]=BH.z[0];
 assert(mergeByDistance(0));assert.equal(BH.n,2);assert.equal(G.focus,focus==='bh:2'?'bh:1':'bh:0');
 const index=Number(G.focus.slice(3));assert.equal(check(index).rows.length,1);
 assert(!check(index).rows.some(r=>r.id==='bh:2'));
}
fixture();G.focus='bh:2';removeHoleData(1);assert.equal(G.focus,'bh:1');removeHoleData(1);assert.equal(G.focus,'ship');
console.log('PASS merger/removal preserves the selected survivor and removes obsolete contribution identities');
assert.deepEqual(holeContributionVectors({supported:false},'bh:0'),[]);
assert.deepEqual(holeContributionVectors({supported:true,contributions:[]},'ship'),[]);
console.log('Gravity hole explanation checks passed');

const {PerspectiveCamera,Vector3,Matrix4}=await import('three');
const {projectGravityVector}=await import('../src/gravityVectorProjection.js');
function cameraAt(positionKm,distance,yaw=0,pitch=0){
 const camera=new PerspectiveCamera(50,1100/760,2e-6,1e24),target=new Vector3(positionKm[0]*K,positionKm[2]*K,-positionKm[1]*K);
 const offset=new Vector3(distance*Math.cos(pitch)*Math.cos(yaw),distance*Math.sin(pitch),distance*Math.cos(pitch)*Math.sin(yaw));
 camera.position.copy(target).add(offset);camera.quaternion.setFromRotationMatrix(new Matrix4().lookAt(offset,new Vector3(),camera.up));camera.updateMatrixWorld();
 camera.userData.preciseOrbit={target,offset,worldPosition:camera.position.clone()};return camera;
}
for(const distance of [2e-6,1.06e-5,1000]){
 const position=[1.5e8,0,0],camera=cameraAt(position,distance);
 const toward=projectGravityVector(position,[1,0,0],camera,distance,.1,1100,760);
 assert(toward?.sightline,'actual line-of-sight acceleration has an honest depth cue');
 for(const a of [[0,1,0],[0,0,1]]){
  const p=projectGravityVector(position,a,camera,distance,.1,1100,760);
  assert(p&&!p.sightline);assert(p.ex>=0&&p.ex<=1100&&p.ey>=0&&p.ey<=760,'1 m / 10 m horizon arrows stay on screen');
 }
}
const remote=[2.5e17,2e17,0],near=[0,0,0],distance=.035;
const remoteCamera=cameraAt(remote,distance,.7,.48),nearCamera=cameraAt(near,distance,.7,.48);
for(const a of [[1,0,0],[0,1,0],[0,0,1]]){
 const p=projectGravityVector(remote,a,remoteCamera,distance,.1,1100,760),q=projectGravityVector(near,a,nearCamera,distance,.1,1100,760);
 assert(p&&!p.sightline,'remote placement retains its non-sightline direction');
 for(const k of ['x','y','ex','ey'])assert(Math.abs(p[k]-q[k])<1e-9,`translation-invariant projected ${k}`);
}
assert.equal(projectGravityVector(near,[0,0,0],nearCamera,distance,.1,1100,760),null);
console.log('PASS near-horizon 1 m / 10 m and remote force arrows preserve bounded screen directions');
