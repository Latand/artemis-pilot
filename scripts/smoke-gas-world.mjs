// Production world stepping with a minimal inert UI; no force/clock mocks.
import assert from 'node:assert/strict';
globalThis.window={};globalThis.document={getElementById:()=>({appendChild(){},innerHTML:''}),createElement:()=>({})};
const F=await import('../src/universe/gasFormation.js'),N=await import('../src/universe/nebulaeData.js'),S=await import('../src/state.js'),W=await import('../src/worldStep.js'),C=await import('../src/constants.js');
const {formedStarEvolution}=await import('../src/universe/formedStarEvolution.js');
S.resetShip();Object.assign(S.G,{t:0,paused:true,warp:1000*C.SEC_YEAR});
N.addNebulaRecord({xKm:C.LY_KM*.51,yKm:0,zKm:0,radiusKm:.045*C.LY_KM,seed:2401,formation:{v:3,bornAtSec:0,massSolar:10,temperatureK:10}});
const n=N.NEBULAE[0],unit=F.gasNumericalView(n,0).a.unitTimeSec;
function reach(target){let calls=0;while(Math.abs(target-S.G.t)>Math.max(1,Math.abs(target)*1e-12)&&calls++<1000){W.stepWorld(target-S.G.t);assert((W.WORLD_STEP.gasSteps||0)<=4);}assert(calls<1000,'honest shared clock must reach the isolated target');return calls;}
const calls=reach(3*unit),s=F.gasStateAt(n,S.G.t);assert(s.assembled);assert(s.stellar.ageSec>0);assert.equal(s.stellar.kind,'protostar');
const assembly=F.gasNumericalView(n,S.G.t).a.sink.assembledAtSec,track=formedStarEvolution(10,0);
S.G.warp=1e8*C.SEC_YEAR;
for(const [fraction,kind]of [[.2,'MS'],[1.05,'giant'],[1.2,'NS']]){
 reach(assembly+track.contractionSec+fraction*track.mainSequenceSec);assert.equal(F.gasStateAt(n,S.G.t).stellar.kind,kind);
}
assert.equal(S.G.paused,true,'direct world stepping cannot change the user pause selection');
assert.equal(F.gasStateAt(n,S.G.t).ejectedMassSolar,8.65);
console.log(`Production gas→protostar in ${calls} bounded world frames; actual shared-clock MS/giant/remnant passed`);
