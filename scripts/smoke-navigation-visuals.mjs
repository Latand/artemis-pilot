import assert from 'node:assert/strict';
import { RecentPath } from '../src/render/recentPath.js';
import { galaxySeed, needsGalaxyQuads } from '../src/render/galaxyMorphology.js';
import { buildDebrisNeighbours, sampleDebrisShapes, DEBRIS_NEIGHBOURS } from '../src/render/debrisShape.js';
const path = new RecentPath(32, 10), color = [0.6, 0.8, 1];
const opts = {spacing:0.05, dtLimit:0.15, speed:2};
for(let i=0;i<800;i++)path.sample(Math.cos(i*.01),Math.sin(i*.01),0,i*.01,i*.01,color,opts);
assert.equal(path.count,32);
const pos=new Float32Array(32*6),col=new Float32Array(32*6),alpha=new Float32Array(64);
let n=path.write(pos,col,alpha,[0,0,0],7.99,7.99,20);
assert(n<=64&&n>2&&Array.from(pos).every(Number.isFinite));
assert(alpha[0]<alpha[n-1]);
path.sample(100,0,0,1e12,8,color,opts);
assert.equal(path.count,1);assert.equal(path.breaks,1);
assert.equal(path.write(pos,col,alpha,[0,0,0],1e12,8,20),0);
path.sample(101,0,0,1e12-1,8.1,color,opts);assert.equal(path.count,1);assert.equal(path.breaks,2);
path.sample(102,0,0,1e12-1,8.2,color,{...opts,epoch:2});assert.equal(path.breaks,3);
path.expire(1e12,20,20);assert.equal(path.count,0);assert.equal(path.hasHead,false);
const slow=new RecentPath(64);
for(let i=0;i<101;i++)slow.sample(i*.001,0,0,i*.001,0,color,{spacing:.01});
assert(slow.count>=9,'distance accumulates from a committed vertex, not the mutable head');
slow.clear();slow.sample(1e12,2e12,3e12,0,0,color);slow.sample(1e12+2,2e12+1,3e12+3,1,1,color);
n=slow.write(new Float32Array(384),new Float32Array(384),new Float32Array(128),[1e12,2e12,3e12],1,1,20);
assert.equal(n,2);
assert.equal(galaxySeed(42),galaxySeed(42));assert.notEqual(galaxySeed(42),galaxySeed(43));
assert(needsGalaxyQuads(.1,.01,5,900,128));assert(!needsGalaxyQuads(10,.01,5,900,128));
const band=4.5*.005*900/40;
assert(!needsGalaxyQuads(band,0,5,900,128,false));assert(needsGalaxyQuads(band,0,5,900,128,true));
// Intrinsic annulus light is redistributed, not supplemented.
for(const arms of [2,3,4]) {
 let sum=0,min=Infinity;
 const ridge=p=>1+1.6*Math.cos(p)+.8*Math.cos(2*p)+(8/35)*Math.cos(3*p)+(1/35)*Math.cos(4*p);
 for(let i=0;i<8192;i++) {
  const t=i*2*Math.PI/8192,p=arms*t+1.7,a=ridge(p),d=ridge(p+.48);
  const s=1+.58*(a-1)-.15*(d-1)+.12*a*Math.cos(13*t+2.3);
  min=Math.min(min,s);sum+=s;
 }
 assert(min>0);assert(Math.abs(sum/8192-1)<1e-12);
}
// A deformed, initially local neighbour graph follows a tidal filament.
const points=new Float32Array(48*3),ws=new Float32Array(48*2);
for(let i=0;i<48;i++){points[i*3]=i*.1;points[i*3+1]=Math.sin(i)*.02;ws[i*2]=1;ws[i*2+1]=.5;}
const graph=buildDebrisNeighbours(points,24);
assert.equal(graph.length,48*DEBRIS_NEIGHBOURS);
for(let i=0;i<48;i++)for(let k=0;k<DEBRIS_NEIGHBOURS;k++){const j=graph[i*DEBRIS_NEIGHBOURS+k];assert(j<0||((i<24)===(j<24)));}
const stretch=new Float32Array(48*4);sampleDebrisShapes(points,ws,graph,stretch);
assert(stretch[10*4+3]>1.5);assert(Math.abs(stretch[10*4])>.9);
assert(Array.from(stretch).every(Number.isFinite));
for(let i=0;i<48;i++)assert(stretch[i*4+3]>=1&&stretch[i*4+3]<=2.5);
assert.deepEqual(sampleDebrisShapes(points,ws,graph,new Float32Array(48*4)),stretch);
console.log('PASS bounded/fading history, jumps/rewinds/epochs, slow sampling, precision, galaxy LOD/seed/annulus flux, tidal neighbour identity and deformation');
