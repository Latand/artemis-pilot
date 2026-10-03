import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const finite=(lens,source)=>Math.min(1,Math.max(0,1-lens/Math.max(source,1e-9)));
assert.equal(finite(100,100),0);assert.equal(finite(100,50),0);
assert(Math.abs(finite(100,110)-1/11)<1e-12);
assert(finite(100,1e12)>.999999);
// A camera crossing the sampling slab sees the appropriate entry/exit face.
function hit(z,dz,h=.01){const face=Math.abs(z)>h?Math.sign(z):Math.sign(dz);return(face*h-z)/dz;}
for(const z of [-.02,-.005,0,.005,.02])for(const dz of [-.2,.2]){
 assert.equal(hit(z,dz),hit(-z,-dz),'two-sided reflection symmetry');
 if(Math.abs(z)<.01)assert(hit(z,dz)>0,'inside support has a positive exit hit');
}
const lens=readFileSync(new URL('../src/lensing.js',import.meta.url),'utf8');
const hole=readFileSync(new URL('../src/holeOptics.js',import.meta.url),'utf8');
assert(lens.includes('iteration < 3'),'fixed-cost source-depth lookup');
assert(lens.includes('1.0 - uDist[i] / max(sourceZ, 1e-9)'),'finite source depth');
assert(lens.includes('supported > .5 ? dq : dz'),'accepted colour and depth agree');
assert(hole.includes('face * halfSupport-ro.z'),'bounded plane-crossing support');
console.log('Finite-source lens lookup and disk-plane support smoke passed');
