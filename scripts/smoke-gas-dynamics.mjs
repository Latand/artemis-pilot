import assert from 'node:assert/strict';
globalThis.window = {};
const D = await import('../src/universe/gasDynamics.js');
const N = await import('../src/universe/nebulaeData.js');
const F = await import('../src/universe/gasFormation.js');
const E = await import('../src/ephemeris.js');
const S = await import('../src/state.js');
const A = await import('../src/universe/activeStars.js');
const { MU_S, C_LIGHT, LY_KM, SEC_YEAR } = await import('../src/constants.js');
const { setEpochMs, J2000_MS } = await import('../src/epoch.js');
setEpochMs(J2000_MS);
const clone = v => structuredClone(v);
let passed = 0;
function test(name, f) { f(); console.log('PASS ' + name); passed++; }
function close(a, b, rel = 1e-9, abs = 1e-12) { assert.ok(Number.isFinite(a) && Math.abs(a - b) <= abs + rel * Math.max(Math.abs(a), Math.abs(b)), `${a} vs ${b}`); }
function vectorClose(a,b,rel=1e-9,abs=1e-12){a.forEach((v,i)=>close(v,b[i],rel,abs));}
function reset() {
    N.clearNebulaRecords(); S.resetWorld(); S.BH.n = 0; E.resetEphem();
    S.G.t = 0; S.G.darkMatter = false; S.G.darkEnergy = false;
    S.WORLD.earthDestroyed = true; S.WORLD.moonDestroyed = true; S.WORLD.sunDestroyed = true; S.WORLD.plDestroyed.fill(1);
    A.GRAVITY_STARS.length = 0;
    D.invalidateGasDynamics();
}
function install({x=1e10, y=2e9, z=3e9, radius=1e7, mass=1, born=0}={}) {
    assert.equal(N.addNebulaRecord({xKm:x,yKm:y,zKm:z,radiusKm:radius,seed:2401,archetype:0,
        formation:{v:3,bornAtSec:born,massSolar:mass,temperatureK:10,radialVelocity:0}}),0);
    return N.NEBULAE[0];
}
function prepare(n,t,from=0) {
    for(let i=0;i<10000;i++) {const r=F.prepareGas(n,t,4,from);if(r.ready){D.invalidateGasDynamics();return;}assert.ok(r.steps>0,'gas prepare must progress');}
    throw Error('gas preparation exceeded its bound');
}
function setupPair(radius=1e7) {
    reset(); const n=install({radius}), st=E.snapshotEphem(), p=D.gasWorldState(n,0);
    const delta=[5*radius,2*radius,-radius];
    const rs=2*(2*MU_S)/(C_LIGHT*C_LIGHT);
    S.BH.n=1;S.bhRegister(0,p.x+delta[0]-st.earthX,p.y+delta[1]-st.earthY,rs,p.vx-st.earthVx,p.vy-st.earthVy,null,0,0,p.z+delta[2],p.vz);
    prepare(n,1000);
    return n;
}
function holeWorld(){const st=E.snapshotEphem();return{x:st.earthX+S.BH.x[0],y:st.earthY+S.BH.y[0],z:S.BH.z[0],vx:st.earthVx+S.BH.vx[0],vy:st.earthVy+S.BH.vy[0],vz:S.BH.vz[0]};}
function advance(dt, max=10) {
    let done=0;while(done<dt){const h=Math.min(max,dt-done),got=E.advanceEphem(h);assert.ok(got>0&&got<=h);done+=got;}S.G.t=E.snapshotEphem().t;return done;
}
test('unformed gas is already one massive source, with no read-side mutations',()=>{
    reset();const n=install();const before=JSON.stringify(n),p=D.gasWorldState(n,0),src=D.gasGravitySources(0);
    assert.equal(src.length,1);close(src[0].mu,MU_S);assert.equal(F.gasStateAt(n,0).born,false);
    assert.equal(JSON.stringify(n),before);vectorClose([p.x,p.y,p.z],[n.xKm,n.yKm,n.zKm],0,0);
    assert.equal(D.gasGravitySources(-1).length,0);
});
test('equal-opposite cloud/hole force and finite-size pair kernel in all three axes',()=>{
    const n=setupPair(),st=E.snapshotEphem(),p=holeWorld(),a=[0,0,0];
    const gas=D.gasGravitySources(st.t)[0];
    D.gasFieldAt(p.x,p.y,p.z,st.t,a,0,st.earthX,st.earthY);
    D.kickGasDynamics(st,1,[]);
    vectorClose(n.formation.dynamics.velocityKmS.map((v,i)=>v*gas.mu+a[i]*S.BH.mu[0]),[0,0,0],0,1e-8);
    assert.ok(a.every(v=>v!==0));
    D.resetGasDynamics();
    S.BH.ev[0]=[{x:S.BH.x[0],y:S.BH.y[0],z:S.BH.z[0],t:st.t,dmu:S.BH.mu[0]}];
    D.gasFieldAt(p.x,p.y,p.z,st.t,a,0,st.earthX,st.earthY);assert.deepEqual(a,[0,0,0]);
    D.kickGasDynamics(st,1,[]);assert.deepEqual(n.formation.dynamics.velocityKmS,[0,0,0]);
});
test('real shared KDK moves both cloud and hole and conserves pair momentum after background subtraction',()=>{
    const n=setupPair(),initial=holeWorld(),dt=1000;
    advance(dt,10);
    const d=n.formation.dynamics,h=holeWorld();
    assert.ok(Math.hypot(...d.offsetKm)>1,'cloud must be deflected by the moving hole');
    assert.ok(Math.hypot(h.vx-initial.vx,h.vy-initial.vy,h.vz-initial.vz)>1e-5,'hole must react to gas');
    const momentum=[h.vx-initial.vx,h.vy-initial.vy,h.vz-initial.vz].map((v,i)=>2*v+d.velocityKmS[i]);
    vectorClose(momentum,[0,0,0],0,2e-11);
    assert.equal(d.t,E.snapshotEphem().t);
    assert.equal(n.xKm,1e10);
});
test('dt refinement agrees and coupled signed KDK reverses without detaching gas from hole time',()=>{
    const n=setupPair();advance(1000,10);const coarse=clone(n.formation.dynamics),holeCoarse=holeWorld();
    setupPair();const fineN=N.NEBULAE[0];advance(1000,5);const fine=clone(fineN.formation.dynamics),holeFine=holeWorld();
    vectorClose(coarse.offsetKm,fine.offsetKm,1e-6,1e-3);
    vectorClose([holeCoarse.x,holeCoarse.y,holeCoarse.z],[holeFine.x,holeFine.y,holeFine.z],0,2e-3);
    for(let i=0;i<200;i++)close(E.advanceEphem(-5),-5,0,0);
    close(E.snapshotEphem().t,0,0,0);close(fineN.formation.dynamics.t,0,0,0);
    vectorClose(fineN.formation.dynamics.offsetKm,[0,0,0],0,1e-5);
    vectorClose(fineN.formation.dynamics.velocityKmS,[0,0,0],0,1e-9);
});
test('formed-star display view never double-counts the explicit gas+core gravity',()=>{
    const n=setupPair(),st=E.snapshotEphem(),point=[n.xKm-st.earthX+1e8,n.yKm-st.earthY,n.zKm],a=[0,0,0],b=[0,0,0];
    E.relGravityAt3(...point,a);
    A.GRAVITY_STARS.push({formedStar:true,id:'display-only',x:n.xKm,y:n.yKm,z:n.zKm,mu:MU_S,R:7e5,softeningKm:0});
    E.beginPredictionStars(A.GRAVITY_STARS);E.relGravityAt3(...point,b);E.endPredictionStars();
    assert.deepEqual(a,b);
});
test('save/restore preserves gas COM together with its hole and ephemeris, then resumes identically',()=>{
    let n=setupPair();advance(300,10);
    const saved={neb:N.serializeNebulae(300),bh:clone(S.BH),eph:E.snapshotEphem()};
    advance(200,10);const expected={d:clone(n.formation.dynamics),h:holeWorld()};
    N.restoreNebulaRecords(clone(saved.neb));for(const [key,v]of Object.entries(saved.bh)){if(ArrayBuffer.isView(v))S.BH[key].set(v);else S.BH[key]=clone(v);}E.loadEphemSnapshot(saved.eph);
    n=N.NEBULAE[0];prepare(n,1000,300);advance(200,10);
    assert.deepEqual(n.formation.dynamics,expected.d);assert.deepEqual(holeWorld(),expected.h);
    D.resetGasDynamics();assert.deepEqual(n.formation.dynamics.offsetKm,[0,0,0]);
});
test('isolated Gyr transport is bounded, retains a local kick and is partition independent',()=>{
    reset();const n=install({x:LY_KM*10,radius:1e7});
    n.formation.dynamics.velocityKmS=[1,2,-1];
    const t=2e9*SEC_YEAR,direct=D.serializeGasDynamics(n,t),p=D.gasWorldState(n,t);
    for(let i=1;i<=1000;i++)D.driftGasDynamics(t*i/1000);
    vectorClose(n.formation.dynamics.offsetKm,direct.offsetKm,1e-10,10);
    vectorClose(n.formation.dynamics.velocityKmS,direct.velocityKmS,1e-10,1e-10);
    assert.ok(Math.hypot(...direct.offsetKm)<2e16,'galactic restoring flow must prevent v*t runaway');
    assert.ok(Math.hypot(p.x,p.y,p.z)<6e17,'guiding motion remains within Galactic scale');
    assert.ok(Math.hypot(p.x-n.xKm,p.y-n.yKm,p.z-n.zKm)>1e13,'background must actually move');
});
test('a close encounter honestly limits huge warp rather than stretching force steps',()=>{
    const n=setupPair(1e10);
    const frame=E.beginEphemFrame(1e15,2),got=E.advanceEphem(1e12);E.endEphemFrame();
    assert.ok(got>0&&got<1e12);assert.equal(frame.stepsUsed,2);assert.equal(frame.analyticCalls,0);
    assert.equal(n.formation.dynamics.t,E.snapshotEphem().t);
});
test('gas mass transfers to one assembled source and escaped ejecta leaves the gravity ledger',()=>{
    reset(); const n=install({radius:1e7,mass:3});
    const early=D.gasGravitySources(0)[0],radius=1e11,a=[0,0,0];
    D.gasFieldAt(early.x+radius,early.y,early.z,0,a);
    close(-a[0]*radius*radius/MU_S,3,1e-7,1e-10);
    const unit=F.gasNumericalView(n,0).a.unitTimeSec,t=3*unit;
    prepare(n,t,t);const state=F.gasStateAt(n,t);assert.equal(state.assembled,true);
    const core=D.gasGravitySources(t)[0];assert.equal(core.softeningKm,0);close(core.mu/MU_S,3);
    D.gasFieldAt(core.x+radius,core.y,core.z,t,a);close(-a[0]*radius*radius/MU_S,3,1e-12);
    const end=state.stellar.contractionSec+state.stellar.mainSequenceSec*1.3+t;
    prepare(n,end,end);const remnant=F.gasStateAt(n,end),src=D.gasGravitySources(end)[0];
    close(src.mu/MU_S,remnant.gasMassSolar+remnant.stellarMassSolar);
    close(src.mu/MU_S+remnant.ejectedMassSolar,3);assert.ok(remnant.ejectedMassSolar>0);
});
test('future prediction retains the current gas inventory without evolving SPH or COM state',()=>{
    reset();const n=install(),before=JSON.stringify(n);
    D.beginPredictionGas(0);
    const future=D.gasGravitySources(1e12);assert.equal(future.length,1);close(future[0].mu,MU_S);
    assert.ok([future[0].x,future[0].y,future[0].z].every(Number.isFinite));
    assert.equal(JSON.stringify(n),before);D.endPredictionGas();
    assert.equal(D.gasGravitySources(1e12).length,1,'unprepared queries retain known gas instead of deleting it');
});
test('sparse or malformed COM saves reset safely; extrapolated extragalactic orbits are refused',()=>{
    for(const bad of [{v:1,t:1,offsetKm:new Array(3),velocityKmS:[0,0,0]},
        {v:1,t:1,offsetKm:[0,Infinity,0],velocityKmS:[0,0,0]},
        {v:1,t:1,offsetKm:[1e100,0,0],velocityKmS:[0,0,0]}])
        assert.deepEqual(D.normalizeGasDynamics(bad,0),{v:1,t:0,offsetKm:[0,0,0],velocityKmS:[0,0,0]});
    reset();const n=install({x:LY_KM*3e6});assert.equal(D.gasGalacticDomain(n).supported,false);
    const p=D.gasWorldState(n,SEC_YEAR*1e9);assert.equal(p.galacticSupported,false);
    vectorClose([p.x,p.y,p.z],[n.xKm,n.yKm,n.zKm],0,0);
});
test('stepping before the exact release never gives the hole a half-kick from future gas',()=>{
    const n=setupPair(),initial=holeWorld();
    E.advanceEphem(-10);const h=holeWorld();
    vectorClose([h.vx,h.vy,h.vz],[initial.vx,initial.vy,initial.vz],0,1e-12);
    vectorClose(n.formation.dynamics.velocityKmS,[0,0,0],0,1e-12);
    E.advanceEphem(10);const restored=holeWorld();
    vectorClose([restored.vx,restored.vy,restored.vz],[initial.vx,initial.vy,initial.vz],0,1e-12);
    close(n.formation.dynamics.t,0,0,0);
});
console.log(`Gas COM dynamics: ${passed} groups passed`);
