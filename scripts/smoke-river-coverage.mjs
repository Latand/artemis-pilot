import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { haloSamplingRadius, haloEdgeFade, refreshProbability, HALO_RADIUS_MAX } from '../src/riverCoverageMath.js';
import { spawnReach } from '../src/riverMath.js';
const src=readFileSync(new URL('../src/river.js',import.meta.url),'utf8');
// Reproduce the lost support: an on-screen source lies beyond cam.tgt's
// ambient sphere. Its own halo remains fully sampled at either side of it.
for(const radius of [22,28000,112000,1e7]){
 for(const ratio of [.5,.99,1,1.01,1.6,4]){
  const sourceDistance=radius*ratio;
  const haloRadius=haloSamplingRadius(radius,sourceDistance+radius/2.8);
  const reach=spawnReach(752,0,haloRadius);
  assert(haloRadius>=radius&&haloRadius<=HALO_RADIUS_MAX);
  assert.equal(haloEdgeFade(reach*.5,reach),1);
  assert.equal(haloEdgeFade(reach*1.25,reach),0);
  assert(haloEdgeFade(reach,reach)>0);
 }
}
for(const dt of [1/120,1/60,1/30,4/60]){
 const survival=Math.pow(1-refreshProbability(.006,dt),1/dt);
 assert(Math.abs(survival-Math.pow(.994,60))<1e-12);
}
assert.equal(refreshProbability(0,1),0);assert.equal(refreshProbability(1,1/60),1);
assert.equal(haloSamplingRadius(22,1e25),HALO_RADIUS_MAX);
assert(src.includes('if (!halo && length(p) > uRadius * 1.04)'), 'Only ambient samples use the ambient kill sphere');
assert(src.includes('distance(p, uBody[own].xyz) > spawnReach(own) * 1.25'), 'Source-relative recycling guard retained');
assert(src.includes('hash13(vec3(vUv * 601.1, 3.3))'), 'Population allocation is independent of recycle time');
assert(src.includes('reach * 0.8, reach * 1.25'), 'Halo fading agrees with source-relative support');
// All masses use the same support law; no Sun index branch in the rule.
const coverage=src.slice(src.indexOf('float spawnReach'),src.indexOf('float hash13'));
assert(!coverage.includes('chosen ==')&&!coverage.includes('chosen=='));
console.log('Source-relative river coverage and real-time refresh smoke passed');
const {haloViewWeight}=await import('../src/riverCoverageMath.js');
assert.equal(haloViewWeight(0,0,1e16,1e16,1e16,2.4e6,.5,1.5),0,'Deep-space invisible/quantized halos cannot claim samples');
assert.equal(haloViewWeight(0,0,-100,100,100,10,.5,1.5),0,'Sources behind the view release sampling slots');
assert.equal(haloViewWeight(0,0,100,100,100,10,.5,1.5),1,'Visible off-center source remains sampled');
assert.equal(haloViewWeight(0,0,8,8,8,14,.5,1.5),1,'Tiny focused local body retains coverage');

assert.equal(haloViewWeight(0,0,3e8,3e8,3e8,2.4e6,.5,1.5,1.9e8),0,'Samples outside the near-only render tier release their slots');

assert(src.includes('haloCoverageDirty ||= haloCoverageChanged'),'Paused view changes stay pending until the scheduled compute');
assert(!src.includes('respawn > .08 || haloCoverageChanged'),'View-weight changes must not bypass mobile compute cadence');
