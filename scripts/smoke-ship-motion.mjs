import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createShipMotion, stepShipMotion, RING_MAX_RATE } from '../src/shipMotion.js';
import { createShipModel } from '../src/shipModel.js';
import { createWarpRiverLayer, WARP_DRAW_GLSL } from '../src/warpRiver.js';
const run=(fps,speed,seconds,state=createShipMotion())=>{for(let i=0;i<fps*seconds;i++)stepShipMotion(state,speed,1/fps);return state;};
const near=(a,b)=>assert(Math.abs(a-b)<1e-9,`${a} ~= ${b}`);
for(const speed of [0,7.8,60,120,1e30,Number.MAX_VALUE]) {
 const a=run(30,speed,5), b=run(60,speed,5), c=run(144,speed,5);
 near(a.rate,b.rate);near(a.rate,c.rate);near(a.angle,c.angle);
 assert(a.rate>=0&&a.rate<=RING_MAX_RATE&&a.angle>=0&&a.angle<Math.PI*2);
}
const low=run(60,8,3),high=run(60,120,3);assert(high.rate>low.rate);
const braking=run(60,0,2,{...high});assert(braking.rate<high.rate*.1);
const stop=run(60,0,14,{...high});assert.equal(stop.rate,0);
assert.equal(run(60,0,20).angle,0);
const frozen={...high};for(let i=0;i<120;i++)stepShipMotion(frozen,0,1/60,true);assert.deepEqual(frozen,high);
for(const dt of [-1,NaN,Infinity,0]){const s={...high};stepShipMotion(s,10,dt);assert.deepEqual(s,high);}
for(const badSpeed of [NaN,Infinity,-Infinity]){const s={...high};stepShipMotion(s,badSpeed,1e99);assert(Object.values(s).every(Number.isFinite));assert(s.rate<high.rate);}
near(run(60,-50,5).rate,run(60,50,5).rate);
const craft=createShipModel(),staticMatrices=craft.children.filter(o=>o.isMesh).map(o=>o.matrix.clone());
for(const rotor of craft.userData.rotors)rotor.rotation.y=high.angle;
craft.updateMatrixWorld(true);
craft.children.filter(o=>o.isMesh).forEach((o,i)=>assert(o.matrix.equals(staticMatrices[i])));
for(const mobile of [false,true]){const layer=createWarpRiverLayer({},'',mobile);assert(layer.geometry.attributes.position.count<650);assert.equal(layer.visible,false);assert(layer.geometry.index.count<=1152);layer.geometry.dispose();layer.material.dispose();}
// Architectural invariant: speculative terms never enter compute/advection.
const river=readFileSync(new URL('../src/river.js',import.meta.url),'utf8');
const compute=river.split('const COMPUTE_FRAG')[1].split('const LINE_VERT')[0];
assert(!compute.includes('warpDrawPosition')&&!compute.includes('WARP_DRAW_GLSL'));
assert(WARP_DRAW_GLSL.includes('if (uWarpStrength <= 0.0) return p;')&&WARP_DRAW_GLSL.includes('if (r2 >= 1.0) return p;'));
for(const file of ['physics.js','flowfield.js','relTravel.js','relView.js','trails.js','worldStep.js'])assert(!readFileSync(new URL(`../src/${file}`,import.meta.url),'utf8').includes('shipVisuals'));
console.log('Ship motion PASS: bounded rate; 30/60/144 fps; acceleration/brake/stop; pause; reverse; pathological inputs; fixed resources; draw-only warp isolation');
