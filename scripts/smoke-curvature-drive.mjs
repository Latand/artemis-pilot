import assert from 'node:assert/strict';
import { createDriveState, resetDrive, stepDrive, sampleDriveGradient, drivePotential, DRIVE_MAX_ACCEL } from '../src/curvatureDrive.js';
const close = (a,b,e=1e-11)=>assert(Math.abs(a-b)<e, `${a} ~= ${b}`);
for(const vector of [[.006,0,0],[0,-.006,0],[.003,.004,.005],[-.002,.001,-.003]]) {
 const g=sampleDriveGradient([],0,0,0,...vector);
 g.forEach((v,i)=>close(v,vector[i]));
 for(const p of [[.1,.3,.2],[-.25,.2,-.3]]) {
  const actual=sampleDriveGradient([],...p,...vector);
  for(let i=0;i<3;i++) { const a=[...p],b=[...p],h=1e-5;a[i]+=h;b[i]-=h;
   close(actual[i],-(drivePotential(...a,...vector)-drivePotential(...b,...vector))/(2*h),1e-10);
  }
 }
 for(const p of [[1,0,0],[0,2,0],[0,0,-2]]) assert.deepEqual(sampleDriveGradient([],...p,...vector),[0,0,0]);
}
for(const fps of [30,60,144]) {
 let impulse=0; const d=createDriveState();
 for(let i=0;i<fps*2;i++){stepDrive(d,.006,0,0,1/fps);impulse+=d.ax/fps;}
 const expected=.006*(2-.18*(1-Math.exp(-2/.18)));
 close(impulse,expected);assert(d.level>.99);
 stepDrive(d,0,0,0,1/fps);assert.deepEqual(d,createDriveState());
}
let d=createDriveState();for(let i=0;i<120;i++)stepDrive(d,1e9,1e9,1e9,1/60);
assert(d.magnitude<=DRIVE_MAX_ACCEL+1e-12);assert(Object.values(d).every(v=>typeof v==='boolean'||Number.isFinite(v)));
for(let i=0;i<180;i++)stepDrive(d,-.006,0,0,1/60);assert(d.ax<-.00599);
for(let i=0;i<120;i++)stepDrive(d,0,0,.006,1/60);assert(d.az>.00599);
for(const bad of [NaN,Infinity,-Infinity]){stepDrive(d,bad,0,0,1/60);assert.deepEqual(d,createDriveState());}
for(const dt of [0,-1,NaN,Infinity]){stepDrive(d,1,0,0,dt);assert.deepEqual(d,createDriveState());}
stepDrive(d,1,0,0,.1);stepDrive(d,1,0,0,.1,false);assert.deepEqual(d,createDriveState(),'all inactive gates disconnect');
stepDrive(d,1,0,0,.1);resetDrive(d);assert.deepEqual(d,createDriveState());
console.log('Curvature drive PASS: potential gradient, compact support, frame-rate independent impulse, bounds, reverse/lateral, exact ballistic coast, inactive gates and reset');

const {shipPresentation,SHIP_MARKER_PX}=await import('../src/shipPresentation.js');
for(const height of [320,820,2160])for(const fov of [30,50,90])for(const d of [1,10,100,1e4,1e8]){
 const p=shipPresentation(d,Math.min(2.4,Math.max(.012,d*.02)),fov,height);
 close(p.markerScale*height/(2*Math.tan(fov*Math.PI/360)),SHIP_MARKER_PX);
 assert(p.hullAlpha>=0&&p.hullAlpha<=1&&p.markerAlpha>=0&&p.markerAlpha<=.9);
}
assert.equal(shipPresentation(.14,.012,50,820).hullAlpha,1);
assert.equal(shipPresentation(1e6,2.4,50,820).hullAlpha,0);
console.log('Ship presentation PASS: bounded 6px non-glow marker, continuous hull handoff across FOV / viewport sizes');

// Exercise the shipped key handler (terminal declaration), with only its
// external services stubbed. Include repeat events, not only key presses.
const {readFileSync}=await import('node:fs');
const source=readFileSync(new URL('../src/input.js',import.meta.url),'utf8');
const keySource=source.slice(source.indexOf('function onKeyDown(e)'));
let logOpens=0,loads=0;const keys=new Set();
const keyDown=new Function('G','keys','initAudio','thrustGain','help','toggleLog','toast','loadState',`return (${keySource});`)(
 {uiMode:'pilot',throttle:1},keys,()=>{},null,{shown:false},()=>logOpens++,()=>{},()=>{loads++;return Promise.resolve();});
const event=(code,shiftKey=false,repeat=false)=>({code,shiftKey,repeat,target:null,preventDefault(){}});
keyDown(event('KeyL',true));for(let i=0;i<4;i++)keyDown(event('KeyL',true,true));
assert.equal(logOpens,1);assert.equal(loads,0);assert(!keys.has('KeyE')&&!keys.has('KeyQ'));
keys.clear();keyDown(event('KeyE',true));keyDown(event('KeyE',true,true));assert(keys.has('KeyE'));assert.equal(logOpens,1,'boosted lateral E never opens log');
keys.clear();keyDown(event('KeyL'));assert.equal(loads,1,'plain L still quickloads');
console.log('Input regression PASS: held/repeated log shortcut has no lateral command; boosted E and plain quickload preserved');
