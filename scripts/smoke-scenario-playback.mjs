import assert from 'node:assert/strict';
import { jupiterEncounterSeed, createPlaybackPlan, simulationAtPlayhead, playheadAtSimulation, playbackStep, encounterCameraDistance } from '../src/scenarioPlaybackMath.js';
globalThis.window={};
const { PL }=await import('../src/constants.js');
const { G, resetShip }=await import('../src/state.js');
const { eph, resetEphem }=await import('../src/ephemeris.js');
const { setEpochMs }=await import('../src/epoch.js');
const { advance }=await import('../src/physics.js');
function invariants() {
    const r=[G.x-eph.plX[3],G.y-eph.plY[3],G.z-eph.plZ[3]];
    const v=[G.vx-eph.plVx[3],G.vy-eph.plVy[3],G.vz-eph.plVz[3]];
    return { r:Math.hypot(...r), energy:Math.hypot(...v)**2/2-PL[3].mu/Math.hypot(...r), h:Math.hypot(r[1]*v[2]-r[2]*v[1],r[2]*v[0]-r[0]*v[2],r[0]*v[1]-r[1]*v[0]) };
}
const heliocentric=()=>Math.hypot(G.vx-eph.sunVx,G.vy-eph.sunVy,G.vz-(eph.sunVz||0));
const results=[];
for(const epoch of ['2000-01-01','2026-10-03','2035-07-01']) {
    setEpochMs(Date.parse(epoch+'T00:00:00Z')); resetShip(); resetEphem();
    const seed=jupiterEncounterSeed(eph,PL[3]),plan=createPlaybackPlan(seed.periapsisTimeSec);
    [G.x,G.y,G.z]=seed.position;[G.vx,G.vy,G.vz]=seed.velocity;
    const start=invariants(), speed=heliocentric();
    assert.ok(Math.abs(start.energy-seed.vinfKmS**2/2)<1e-8,'positive hyperbolic energy');
    assert.ok(Math.abs(start.h-seed.angularMomentum)/start.h<1e-12,'target angular momentum');
    let min=start.r,wall=0, maxEnergyErr=0,maxHErr=0, prev=0;
    for(let i=0;i<=600;i++) {
        const t=i/10,sim=simulationAtPlayhead(plan,t);
        assert.ok(sim>=prev,'timeline monotone');prev=sim;
        assert.ok(Math.abs(playheadAtSimulation(plan,sim)-t)<1e-8,'delivered clock inverse');
    }
    // Phase derivatives agree on both sides. No speed jump at a phase cut.
    for(const t of plan.wall.slice(1,-1)) {
        const e=.00001,a=(simulationAtPlayhead(plan,t)-simulationAtPlayhead(plan,t-e))/e,b=(simulationAtPlayhead(plan,t+e)-simulationAtPlayhead(plan,t))/e;
        assert.ok(Math.abs(a-b)/Math.max(a,b)<1e-4,'continuous rate ramp');
    }
    while(G.t<plan.simDuration-1e-6) {
        const dt=wall%2<1?1/30:1/60,step=playbackStep(plan,G.t,dt);
        G.warp=step.warp;const delivered=advance(step.advanceSec,0,0,0,0);wall+=dt;
        assert.ok(delivered>0 && !G.dead,'integration delivers a surviving flyby');
        const q=invariants();min=Math.min(min,q.r);maxEnergyErr=Math.max(maxEnergyErr,Math.abs(q.energy-start.energy));maxHErr=Math.max(maxHErr,Math.abs(q.h-start.h)/start.h);
    }
    assert.ok(Math.abs(wall-60)<.05,'about sixty seconds at mixed 30/60 fps');
    assert.ok(min/PL[3].R>3.45&&min/PL[3].R<3.55,'periapsis safely above Jupiter');
    assert.ok(heliocentric()-speed>10,'real heliocentric gravity assist');
    assert.ok(maxEnergyErr<.06,'planet-relative energy conserved within solar perturbations');
    assert.ok(maxHErr<.001,'angular momentum conserved within solar perturbations');
    assert.equal(G.dvUsed,0,'no thrust or propulsive delta-v');
    results.push({epoch,duration:wall,periapsisRj:min/PL[3].R,entryKmS:speed,exitKmS:heliocentric(),maxEnergyErr,maxHErr});
}
const plan=createPlaybackPlan(160000),begin=playbackStep(plan,0,10);
assert.ok(begin.advanceSec<simulationAtPlayhead(plan,.121),'long stall bounded to 120ms');
assert.equal(playbackStep(plan,1234,0).advanceSec,0,'paused zero-delta does not advance');
assert.equal(playbackStep(plan,plan.simDuration,.05).advanceSec,0,'no overshoot at completion');
assert.ok(encounterCameraDistance(500,70,.46)>encounterCameraDistance(500,70,1.7),'portrait widens the frame to retain ship and Jupiter');
console.log(JSON.stringify(results,null,2));console.log('Scenario timeline and live 3-D gravity assist checks passed');
