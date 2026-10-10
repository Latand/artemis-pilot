import assert from 'node:assert/strict';
import { WARP_WAVES as s, resetWarpWaves, noteWarpTransition, pulseAge } from '../src/warpWaveState.js';
resetWarpWaves();noteWarpTransition('ramping',10,1,2,3,0);assert.equal(s.events.length,0);
resetWarpWaves();s.enabled=true;noteWarpTransition('ramping',10,1,2,3,0);
assert.deepEqual(s.events,[{x:1,y:2,z:3,t:0,kind:'ramping'}]);
for(let i=1;i<20;i++)noteWarpTransition('ramping',i*10,i,2,3,i);
assert.equal(s.events.length,1);assert.equal(s.events[0].x,1);
noteWarpTransition('cruise',3000000,999,0,0,20);assert.equal(s.events.length,1);
noteWarpTransition('braking',2900000,1000,0,0,21);assert.equal(s.events.length,2);
noteWarpTransition('ready',0,1100,0,0,22);assert.equal(s.events.at(-1).kind,'collapse');
assert.equal(pulseAge(s.events[0],22),22);assert.equal(pulseAge(s.events[0],-1),0);
for(let i=0;i<10;i++){noteWarpTransition('ramping',1,i,0,0,23+i*2);noteWarpTransition('ready',0,i,0,0,24+i*2);}
assert.equal(s.events.length,4);
noteWarpTransition('ready',0,0,0,0,1);assert.equal(s.events.length,0);
noteWarpTransition('ramping',100,0,0,0,2);assert.equal(s.events.length,1);
noteWarpTransition('ready',0,0,0,0,0);assert.equal(s.events.length,0);
s.replay={};resetWarpWaves();assert.equal(s.enabled,false);assert.equal(s.replay,null);assert.equal(s.events.length,0);
console.log('Warp illustrative events: stationary origins, no cruise emission, bounded history, reset and reverse passed.');
