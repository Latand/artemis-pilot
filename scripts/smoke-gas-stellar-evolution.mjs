import assert from 'node:assert/strict';
globalThis.window={};
const {formedStarEvolution:track,validGasMass}=await import('../src/universe/formedStarEvolution.js');
const {SEC_YEAR,MU_S}=await import('../src/constants.js');
const gas=await import('../src/universe/gasFormation.js');
const neb=await import('../src/universe/nebulaeData.js');
const active=await import('../src/universe/activeStars.js');
let checks=0;
const check=(name,fn)=>{fn();checks++;console.log('PASS',name);};
check('Continuous gas mass accepts 2.7, rejects missing/nonfinite/outside physical UI range',()=>{
 for(const m of [.1,.3,1,2.7,10,30])assert(validGasMass(m));
 for(const m of [0,.09,31,Infinity,NaN,'2.7',null])assert(!validGasMass(m));
 assert.equal(gas.normalizeFormation({v:3,massSolar:2.7,bornAtSec:0}).massSolar,2.7);
});
check('Mass determines radius, luminosity, temperature and finite lifetime',()=>{
 const states=[.3,1,3,10,30].map(m=>track(m,track(m,0).contractionSec+SEC_YEAR));
 for(let i=0;i<states.length;i++){
  const s=states[i];assert.equal(s.kind,'MS');assert(s.radiusKm>0&&s.temperatureK>0&&s.luminositySolar>0);
  if(i){assert(s.mainSequenceSec<states[i-1].mainSequenceSec);assert(s.radiusKm>states[i-1].radiusKm);assert(s.luminositySolar>states[i-1].luminositySolar);}
 }
});
check('Track covers protostar, MS, giant and mass-appropriate remnants without creating mass',()=>{
 for(const [m,kind]of [[.1,'WD'],[1,'WD'],[3,'WD'],[10,'NS'],[30,'BH']]){
  const zero=track(m,0,12),ms=zero.contractionSec,life=zero.mainSequenceSec;
  assert.equal(zero.kind,'protostar');assert.equal(track(m,ms,12).kind,'MS');
  assert.equal(track(m,ms+1.05*life,12).kind,'giant');
  const end=track(m,ms+1.2*life,12);assert.equal(end.kind,kind);
  assert(Math.abs(end.massSolar+end.ejectedMassSolar-m)<1e-12);assert(end.massSolar<=m);
  assert.deepEqual(track(m,ms+1.05*life,12),track(m,ms+1.05*life,12));
 }
});
check('A small unresolved core is substellar; accretion alone cannot skip to a remnant',()=>{
 assert.equal(track(.03,1e20).kind,'BD');assert.equal(track(10,1e20,12,false).kind,'protostar');
 assert.equal(track(10,1e20,12,false).ageSec,0);
});
const source={xKm:1e14,yKm:2e13,zKm:-3e12,radiusKm:gas.GAS_RADIUS_KM,seed:2401,formation:{v:3,massSolar:3,bornAtSec:0,temperatureK:10}};
neb.addNebulaRecord(source);let n=neb.NEBULAE[0];
function reach(t){let result;for(let i=0;i<1000;i++){result=gas.prepareGas(n,t,4);if(result.ready)return;}throw Error('Gas budget did not converge');}
const unit=gas.gasNumericalView(n,0).a.unitTimeSec;reach(unit*3);
check('Only numerical assembly starts the stellar age and preserves one source identity',()=>{
 const s=gas.gasStateAt(n,unit*3);assert(s.assembled);assert(s.stellar.ageSec<unit*3);assert(s.stellar.ageSec>0);
 const star=neb.formedStarForNebula(0,unit*3),id=star.id;
 assert.equal(star.R,s.stellar.radiusKm);assert.equal(star.gasSink,false);assert(star.R<s.sinkRadiusKm/1000);
 assert.equal(star.mu,MU_S*s.stellarMassSolar);
 active.refreshActiveStars(star.x,star.y,star.z,'neb:0',unit*3);
 assert.equal(active.ACTIVE_STARS.filter(x=>x.id===id).length,1);
});
const assembly=gas.gasNumericalView(n,unit*3).a.sink.assembledAtSec;
const one=track(3,0);const future=assembly+one.contractionSec+one.mainSequenceSec*1.2;reach(future);
check('Deep-time remnant, saved clock and reverse reproduce stellar phase and mass ledger',()=>{
 const end=gas.gasStateAt(n,future),star=neb.formedStarForNebula(0,future);assert.equal(end.stellar.kind,'WD');
 assert(Math.abs(end.gasMassSolar+end.stellarMassSolar+end.ejectedMassSolar-end.totalMassSolar)<1e-12);
 assert.equal(star.mu,end.stellarMassSolar*MU_S);
 const saved=JSON.parse(JSON.stringify(neb.serializeNebulae(future)));
 neb.restoreNebulaRecords(saved);n=neb.NEBULAE[0];assert.deepEqual(gas.gasStateAt(n,future).stellar,end.stellar);
 reach(assembly+one.contractionSec+SEC_YEAR);assert.equal(gas.gasStateAt(n,assembly+one.contractionSec+SEC_YEAR).stellar.kind,'MS');
 reach(unit*.5);assert.equal(gas.gasStateAt(n,unit*.5).born,false);assert.equal(neb.formedStarForNebula(0,unit*.5),null);
});
neb.clearNebulaRecords();
console.log(`${checks} stellar integration groups passed`);
