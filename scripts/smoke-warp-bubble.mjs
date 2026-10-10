import assert from 'node:assert/strict';
import { bubbleShape,bubbleMetric,createWarpState,stepWarp,stopWarp,resetWarp,WARP_C,WARP_MAX_C } from '../src/warpBubble.js';
const close=(a,b,e=1e-7)=>assert(Math.abs(a-b)<=e*Math.max(1,Math.abs(b)),`${a} ~ ${b}`);
close(bubbleShape(0).f,1); close(bubbleShape(0).df,0);
for(const r of [.1,.5,.9,1,1.2,2]){
 const h=1e-5;close(bubbleShape(r).df,(bubbleShape(r+h).f-bubbleShape(r-h).f)/(2*h));
}
assert(bubbleShape(3).f<1e-8);
for(const beta of [.1,1,100,1e9]){
 const front=bubbleMetric(0,1,0,beta),back=bubbleMetric(0,-1,0,beta),side=bubbleMetric(1,0,0,beta);
 assert(front.expansion<0&&back.expansion>0);close(front.expansion,-back.expansion);
 close(front.energy,0);assert(side.energy<0);close(side.expansion,0);
 const center=bubbleMetric(0,0,0,beta);close(center.expansion,0);close(center.energy,0);close(center.shift,-beta);
 close(side.energy,bubbleMetric(1,0,0,1).energy*beta*beta);
}
const samples=[];
for(const fps of [30,60,144]){
 const s=createWarpState();s.enabled=true;let distance=0;
 for(let i=0;i<fps*24;i++){stepWarp(s,1,1,false,1/fps);distance+=s.meanSpeed/fps;}
 assert(s.speed>WARP_C);samples.push({speed:s.speed,distance});
 const local=s.speed;stepWarp(s,0,1,false,1/fps,false);assert.equal(s.speed,local);assert.equal(s.meanSpeed,0);
 for(let i=0;i<fps*3;i++)stepWarp(s,0,1,false,1/fps);
 const coast=s.speed;for(let i=0;i<fps*3;i++)stepWarp(s,0,1,false,1/fps);close(s.speed,coast,.002);
 for(let i=0;i<fps*15;i++)stepWarp(s,-1,1,false,1/fps);
 assert.equal(s.speed,0);assert.equal(s.logSpeed,0);
 for(let i=0;i<fps*100;i++)stepWarp(s,1,100,true,1/fps);
 close(s.speed,WARP_C*WARP_MAX_C);assert(s.limited);assert(Number.isFinite(s.meanSpeed));
 stopWarp(s,'test');assert.equal(s.speed,0);assert(s.enabled);resetWarp(s);assert.deepEqual(s,createWarpState());
}
for(const s of samples){close(s.speed,samples[0].speed);close(s.distance,samples[0].distance,1e-6);}
console.log('Warp bubble PASS: analytic derivatives, signed expansion, negative energy scaling, calm center, 30/60/144Hz ramp distance, pause/coast/brake, finite numerical cap and reset.');
