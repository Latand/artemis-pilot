import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const finite=(lens,source)=>Math.min(1,Math.max(0,1-lens/Math.max(source,1e-9)));
assert.equal(finite(100,100),0);assert.equal(finite(100,50),0);
assert(Math.abs(finite(100,110)-1/11)<1e-12);
assert(finite(100,1e12)>.999999);
// Normalized finite-footprint interval: never introduce two full faces.
function support(z,dz,h=.01){const a=(-h-z)/dz,b=(h-z)/dz;const entry=Math.max(0,Math.min(a,b)),exit=Math.max(a,b);return Math.min(1,Math.max(0,(exit-entry)*Math.abs(dz)/(2*h)));}
for(const z of [-.02,-.01,-.009999,-.005,0,.005,.009999,.01,.02]){
 assert.equal(support(z,.2),support(-z,-.2),'reflection symmetry');
 assert(Math.abs(support(z,.2)+support(z,-.2)-1)<1e-12,'total directional coverage stays normalized across both boundaries');
}
assert.equal(support(0,.2),.5);assert.equal(support(0,-.2),.5);
const lens=readFileSync(new URL('../src/lensing.js',import.meta.url),'utf8');
const hole=readFileSync(new URL('../src/holeOptics.js',import.meta.url),'utf8');
assert(lens.includes('iteration < 3'),'fixed-cost source-depth lookup');
assert(lens.includes('1.0 - uDist[i] / max(sourceZ, 1e-9)'),'finite source depth');
assert(lens.includes('supported > .5 ? dq : dz'),'accepted colour and depth agree');
assert(hole.includes('(exitHit-entry)*abs(rd.z)/(2.0*halfSupport)'),'normalized clipped plane-crossing support');
console.log('Finite-source lens lookup and disk-plane support smoke passed');

// A new foreground-depth edge reached on the last iteration must be tested
// against that final depth, rather than accepted using the previous delta.
const p=.2,A=.1,depths=[200,204.08163265,210.52631579,101];
let q=p,previous=p;
for(let i=0;i<3;i++){previous=q;q=p-A*finite(100,depths[i]);}
assert(Math.abs(q-previous)<.002,'fixture looks converged by the stale-step test');
const verified=p-A*finite(100,depths[3]);
assert(Math.abs(q-verified)>.05,'final depth disproves that apparent convergence');
assert(lens.includes('length(q-verifiedQ)'),'shader validates the final sampled source');
assert(hole.includes('uNear/depthPerRs'),'sampling interval is clipped before choosing its midpoint');
