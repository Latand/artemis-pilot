import assert from 'node:assert/strict';
import { selectVisibleTrajectories, trajectoryHorizon, playbackDirection, projectedVelocity, fullyOcculted, trajectoryDisplayOpacity, orbitalDirectionSweep } from '../src/render/visibleTrajectoryMath.js';
import { osculatingOrbit } from '../src/render/orbitalExposureMath.js';
const periapsis=osculatingOrbit(7000,0,0,0,Math.sqrt(398600*1.9/7000),0,398600);
const shutter=86400/30,turn=orbitalDirectionSweep(periapsis,shutter);
assert(turn>87*Math.PI/180&&turn<89*Math.PI/180,'Eccentric periapsis resolves the actual ~88 degree velocity turnover');
assert.equal(turn,orbitalDirectionSweep(periapsis,-shutter),'Periapsis limit is reverse-symmetric');
assert.equal(trajectoryDisplayOpacity(0,shutter,periapsis.period,turn),0,'Mean-period alias at eccentric periapsis is suppressed');
for(const offset of [-Math.PI*2,0,Math.PI*2]) {
    const o={...periapsis,M:offset};
    assert(Math.abs(orbitalDirectionSweep(o,shutter)-turn)<1e-10,'Unwrapped periapsis is independent of the anomaly branch');
}
assert.equal(orbitalDirectionSweep(periapsis,0),0);
assert.equal(orbitalDirectionSweep(periapsis,periapsis.period*100),Math.PI/3,'Multiple revolutions take the fixed-cost fully faded branch');
assert.equal(trajectoryDisplayOpacity(0,0,100),1,'Pause/exact frame preserves instantaneous guides');
assert.equal(trajectoryDisplayOpacity(.5,0,100),.5,'Partial body exposure continuously fades its sharp guide');
assert.equal(trajectoryDisplayOpacity(1,0,100),0,'Averaged bands do not carry a strobing instantaneous marker');
assert.equal(trajectoryDisplayOpacity(0,100/6,100),0,'Selected-body direction also fades when unresolved');
for(let i=0;i<=100;i++) {
    const seconds=i/100*20,opacity=trajectoryDisplayOpacity(.2,seconds,100);
    assert.equal(opacity,trajectoryDisplayOpacity(.2,-seconds,100),'Reverse uses the same shutter visibility');
    assert(opacity>=0&&opacity<=.8);
    if(i)assert(opacity<=trajectoryDisplayOpacity(.2,(i-1)/100*20,100),'Visibility changes monotonically with the shutter');
}
const candidates=Array.from({length:30},(_,i)=>({id:`body:${i}`,visible:true,sx:i*40,sy:100,radiusPx:1,nx:0,ny:0,selected:i===25}));
let result=selectVisibleTrajectories(candidates);assert.equal(result.length,10);assert.equal(result[0].id,'body:25');
const previous=result.map(c=>c.id);candidates.forEach(c=>{c.nx=.02;});result=selectVisibleTrajectories(candidates,previous);assert.deepEqual(result.map(c=>c.id),previous);
assert.equal(selectVisibleTrajectories(candidates,[],999).length,10);
assert.equal(selectVisibleTrajectories(candidates,[],-1).length,0);
const crowded=candidates.map(c=>({...c,sx:0,sy:0}));assert.equal(selectVisibleTrajectories(crowded).length,1);
assert.equal(selectVisibleTrajectories([{...candidates[0],sx:NaN}]).length,0);
assert.equal(selectVisibleTrajectories(candidates.map(c=>({...c,visible:false}))).length,0);
assert.equal(trajectoryHorizon({speed:1,kmPerPixel:1000,linear:true}),60);
assert.equal(trajectoryHorizon({speed:1,kmPerPixel:1000,period:100}),12);
assert.equal(trajectoryHorizon({speed:0,kmPerPixel:1000}),0);
assert.equal(trajectoryHorizon({speed:10,kmPerPixel:2,period:1000}),13);
for(const warp of [1,86400,256*86400])assert.equal(playbackDirection(warp),1);
for(const warp of [-1,-86400,-256*86400])assert.equal(playbackDirection(warp),-1);
assert.deepEqual(projectedVelocity(1,2,2,.5,1),{x:0,y:0},'Line-of-sight radial motion has no false sideways arrow');
assert.deepEqual(projectedVelocity(3,4,2,.5,1),{x:2,y:2},'Off-axis arrows include depth perspective');
assert(fullyOcculted({x:0,y:0,z:0},{x:0,y:0,z:100},1,{x:0,y:0,z:50},10),'Body behind Sun/host disk is occulted');
assert(!fullyOcculted({x:0,y:0,z:0},{x:20,y:0,z:100},4,{x:0,y:0,z:50},10),'Partial visible limb is retained');
assert(!fullyOcculted({x:0,y:0,z:0},{x:0,y:0,z:25},1,{x:0,y:0,z:50},10),'Foreground body remains visible');
console.log('visible trajectory policy: stable selected-first cap, proximity declutter, finite visibility, scale-aware bounded horizons and reverse passed');
