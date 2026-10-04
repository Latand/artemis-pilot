import assert from 'node:assert/strict';
import { osculatingOrbit, sampleOrbit, exposurePolicy } from '../src/render/orbitalExposureMath.js';
const day=86400, mu=132712440018, a=149597870.7, v=Math.sqrt(mu/a);
const input=[a,0,0,0,v,0,mu], frozen=JSON.stringify(input);
const orbit=osculatingOrbit(...input), p={};
assert(orbit&&Math.abs(orbit.a/a-1)<1e-12);
sampleOrbit(orbit,0,p);assert(Math.hypot(p.x-a,p.y,p.z)<1e-5);
sampleOrbit(orbit,orbit.period/4,p);assert(Math.hypot(p.x,p.y-a,p.z)<1e-5);
sampleOrbit(orbit,-orbit.period/4,p);assert(Math.hypot(p.x,p.y+a,p.z)<1e-5);
assert.equal(JSON.stringify(input),frozen);
assert.equal(osculatingOrbit(a,0,0,0,Math.sqrt(2*mu/a)*1.1,0,mu),null);
for(const fps of [24,30,60,120])for(const rate of [1,3600,day,16*day,256*day,1000000*day])for(const sign of [-1,1]){
 const q=exposurePolicy({advance:sign*rate/fps,realDt:1/fps,period:orbit.period,orbitPx:250,radiusPx:.1});
 assert(q.blend>=0&&q.blend<=1&&q.averaged>=0&&q.averaged<=1);
 assert(Math.abs(q.span)<=orbit.period&&Math.sign(q.span)===sign);
 assert(q.span===0||Number.isFinite(q.span));
 const back=exposurePolicy({advance:-sign*rate/fps,realDt:1/fps,period:orbit.period,orbitPx:250,radiusPx:.1});
 assert.equal(q.span,-back.span);assert.equal(q.blend,back.blend);
}
const cfg={advance:256*day/60,realDt:1/60,period:orbit.period,orbitPx:250,radiusPx:.1};
assert.equal(exposurePolicy(cfg).blend,1);
assert.equal(exposurePolicy({...cfg,paused:true}).blend,0);
assert.equal(exposurePolicy({...cfg,focused:true}).blend,0);
assert.equal(exposurePolicy({...cfg,radiusPx:6}).blend,0);
assert.equal(exposurePolicy({...cfg,orbitPx:2}).blend,0);
assert.deepEqual(exposurePolicy({...cfg,advance:0}),{blend:0,averaged:0,span:0});
const at60=exposurePolicy(cfg),at120=exposurePolicy({...cfg,advance:cfg.advance/2,realDt:1/120});assert.deepEqual(at60,at120);
const shortPeriod=1.769*day;
assert.equal(exposurePolicy({...cfg,period:shortPeriod}).averaged,1,'Io at 256 d/s is orbit-averaged, never an aliased point');
let prev=0;
for(let turns=0;turns<1.5;turns+=.001){const q=exposurePolicy({...cfg,advance:turns*orbit.period,realDt:1/30});assert(q.span>=prev);assert(q.span-prev<orbit.period*.006);prev=q.span;}
console.log('orbital exposure: conics, reverse, 24–120 Hz, rate changes, pause, focus/scale gates, continuous bounded averaging passed');
