// DOM/renderer doubles isolate the real excursion lifecycle; orbital physics
// is separately exercised by smoke-scenario-playback and the full browser QA.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DRIVE, stepDrive } from '../src/curvatureDrive.js';
globalThis.window=new EventTarget();
const elements=new Map();
const element=id=>{if(!elements.has(id))elements.set(id,{id,hidden:false,textContent:'',value:0,disabled:false,appendChild(){},setAttribute(){},onclick:null});return elements.get(id);};
globalThis.document={body:{classList:{add(){},remove(){}}},createElement:()=>element('scenarioPlayback'),getElementById:element,addEventListener(){}};
const {G,WORLD,BH,GS,resetShip,setSimTime}=await import('../src/state.js');
const {eph,resetEphem,snapshotEphem}=await import('../src/ephemeris.js');
resetShip();resetEphem();
const vec={x:3,y:4,z:5,toArray(){return[this.x,this.y,this.z];},fromArray(a){[this.x,this.y,this.z]=a;},set(x,y,z){Object.assign(this,{x,y,z});}};
const m=globalThis.__scenarioMock={cam:{yaw:1,pitch:.4,dist:80,distTarget:null,tgt:vec},camera:{aspect:1.6},AP:{mode:'travel',target:3,phase:'coast'},REL:{active:false,phase:'off'},neb:[[1,2,3]],enc:{v:1},shipVisuals:{enabled:true,strength:1},log:{entries:[{id:'prior-discovery'}]},jump:false,listeners:new Set()};
const mock={
 './scene.js':`export const {cam,camera}=globalThis.__scenarioMock;export const viewportSize={w:1366,h:900};`,
 './autopilot.js':`export const AP=globalThis.__scenarioMock.AP; export function apOff(){AP.mode='off';}`,
 './relState.js':`export const REL=globalThis.__scenarioMock.REL;export function relResetState(){REL.active=false;REL.phase='off';}`,
 './blackholes.js':`import {BH} from '${new URL('../src/state.js',import.meta.url)}';export function clearBlackHoles(){BH.n=0;}export function addBlackHole(){BH.n++;}`,
 './bhEncounters.js':`export const serializeEncounterState=()=>structuredClone(globalThis.__scenarioMock.enc);export function restoreEncounterState(s){globalThis.__scenarioMock.enc=structuredClone(s);}`,
 './render/nebulae.js':`export const serializeNebulae=()=>structuredClone(globalThis.__scenarioMock.neb);export function restoreNebulae(s){globalThis.__scenarioMock.neb=structuredClone(s);}`,
 './universe/gasDynamics.js':`export function invalidateGasDynamics(){}`,
 './trails.js':`export function clearTrail(){} export function pushTrail(){} export function computePrediction(){}`,
 './hud.js':`export function hideBanner(){} export function showBanner(){}`,
 './achievements.js':`export function toast(){}`,
 './shipVisuals.js':`export const shipVisuals=globalThis.__scenarioMock.shipVisuals;`,
 './discoveryLog.js':`export const serializeLog=()=>structuredClone(globalThis.__scenarioMock.log);export function restoreLog(log){globalThis.__scenarioMock.log=structuredClone(log);}`,
 './timeCtl.js':`import {G} from '${new URL('../src/state.js',import.meta.url)}';export function setWarp(w,s){for(const fn of globalThis.__scenarioMock.listeners)fn('warp',s);G.warp=w;}export function setPaused(p){G.paused=p;}export function onTimeControl(fn){globalThis.__scenarioMock.listeners.add(fn);}export const jumpActive=()=>globalThis.__scenarioMock.jump;export const jumpSaveWarp=()=>G.warp;export function cancelTimeJump(){globalThis.__scenarioMock.jump=false;}`,
 './uiMode.js':`export function setUiMode(){}`,
 './scenarioPlayback.css':'',
};
const hook=registerHooks({resolve(spec,ctx,next){if((ctx.parentURL?.endsWith('/scenarioPlayback.js')||ctx.parentURL?.endsWith('/saves.js'))&&spec in mock)return{url:'scenario-test:'+spec,shortCircuit:true};return next(spec,ctx);},load(url,ctx,next){if(url.startsWith('scenario-test:'))return{format:'module',source:mock[url.slice(14)],shortCircuit:true};return next(url,ctx);}});
const runtime=await import('../src/scenarioPlayback.js');
runtime.initScenarioPlayback();
const reboot=()=>{resetShip();resetEphem();};
G.warp=321;G.paused=true;G.focus='earth';G.uiMode='observe';G.tau=120;G.driveMode='curvature';
BH.n=1;BH.x[0]=123;BH.rs[0]=.3;BH.ev[0]=[{t:0,dmu:5}];WORLD.muScale[0]=.7;GS.push({t:Infinity,x:5});
const original=runtime.captureScenarioReturnState();
reboot();stepDrive(DRIVE,.01,0,0,1/60);runtime.beginJupiterPlayback(original,reboot);assert.equal(DRIVE.magnitude,0,'scenario start disconnects a held actuator');
assert.equal(G.paused,true);assert.equal(G.focus,'ship');assert.equal(m.AP.mode,'off');assert.equal(m.neb.length,0);
assert.equal(runtime.tickScenarioPlayback(.1).advanceSec,0,'ready awaits start');assert.equal(m.shipVisuals.enabled,false,'ballistic excursion disables legacy speculative field');
element('spToggle').onclick();assert.equal(G.paused,false);assert.equal(G.gr,true,'natural gravitational flow remains enabled');
const first=runtime.tickScenarioPlayback(.1);assert.ok(first.advanceSec>0);G.t+=first.advanceSec;runtime.settleScenarioPlayback();
element('spToggle').onclick();const paused=G.t;assert.equal(runtime.tickScenarioPlayback(.1).advanceSec,0);assert.equal(G.t,paused);
element('spToggle').onclick();assert.ok(runtime.tickScenarioPlayback(.1).advanceSec>0);
element('spRestart').onclick();assert.equal(G.t,0);assert.equal(G.paused,true);assert.equal(element('spToggle').textContent,'Start flight');
m.log.entries.push({id:'temporary-discovery'});
stepDrive(DRIVE,.01,0,0,1/60);assert.ok(runtime.exitScenarioPlayback());assert.equal(DRIVE.magnitude,0,'exit does not restore stale held drive input');assert.ok(!runtime.scenarioPlaybackActive());
for(const k of ['t','tau','x','y','z','vx','vy','vz','warp','paused','focus','uiMode','driveMode'])assert.deepEqual(G[k],original.g[k],`return ${k}`);
assert.deepEqual([...WORLD.muScale],[...original.world.muScale]);assert.deepEqual(BH,original.bh);assert.deepEqual(GS,original.gs);assert.deepEqual(m.AP,original.ap);assert.deepEqual(m.neb,original.neb);assert.deepEqual(m.cam.tgt.toArray(),original.camera.tgt);
assert.equal(m.shipVisuals.enabled,true,'legacy visual preference restored');assert.deepEqual(snapshotEphem(),original.eph);assert.deepEqual(m.log,original.log,'discovery history is restored');
assert.equal(runtime.exitScenarioPlayback(),false,'repeated exit harmless');
// User time action relinquishes ownership before applying that action.
reboot();runtime.beginJupiterPlayback(original,reboot);for(const fn of m.listeners)fn('warp','user');G.warp=20;assert.equal(G.x,original.g.x);assert.equal(G.warp,20);assert.ok(!runtime.scenarioPlaybackActive());
reboot();runtime.beginJupiterPlayback(original,reboot);element('spToggle').onclick();const interrupted=runtime.tickScenarioPlayback(.1,true);assert.equal(interrupted.advanceSec,0,'interruption frame cannot burn on restored flight');assert.equal(G.x,original.g.x);
reboot();runtime.beginJupiterPlayback(original,reboot);window.dispatchEvent(new Event('ap:replace-universe'));assert.ok(!runtime.scenarioPlaybackActive());assert.equal(G.x,original.g.x);
reboot();runtime.beginJupiterPlayback(original,reboot);m.jump=true;assert.equal(runtime.tickScenarioPlayback(.1).advanceSec,0);assert.ok(!runtime.scenarioPlaybackActive());assert.equal(m.jump,false,'a competing event jump cannot resume after returning to a different clock');
// A guided excursion must preserve the new foreign-world state as well as
// the original Solar return snapshot, including free-camera sub-km offsets.
const { Vector3 } = await import('three');
const F = await import('../src/universe/foreignStars.js');
const E = await import('../src/universe/exploredSystem.js');
const J = await import('../src/universe/universeJournal.js');
const foreign = F.foreignStarById('gx:m31:2654435769:1249:0:-1:28', 0);
assert(foreign);
E.getExploredSystem('proc:' + foreign.id);
J.recordStarImpulse(foreign.id, 1, [2, -3, 4]);
G.focus='free';
const precise={origin:new Vector3(foreign.x*.001,foreign.z*.001,-foreign.y*.001),offset:new Vector3(.125,-.375,.625)};
Object.assign(m.cam,{tgt:precise.origin.clone().add(precise.offset),preciseTarget:precise,dist:179.762,distTarget:100});
const foreignReturn=runtime.captureScenarioReturnState();
const foreignJournal=JSON.parse(JSON.stringify(J.serializeUniverseJournal()));
reboot();runtime.beginJupiterPlayback(foreignReturn,reboot);
assert.equal(m.cam.preciseTarget,null,'guided camera releases the foreign split target');
assert.equal(J.serializeUniverseJournal().events.length,0,'excursion has its own reset world');
E.getExploredSystem('star:0');
runtime.exitScenarioPlayback();
assert.equal(G.focus,'free');
assert.deepEqual(m.cam.preciseTarget.origin.toArray(),foreignReturn.camera.preciseTarget.origin);
assert.deepEqual(m.cam.preciseTarget.offset.toArray(),foreignReturn.camera.preciseTarget.offset);
assert.equal(m.cam.distTarget,100,'existing approach controller state is restored');
assert.deepEqual(E.serializeExploredSystem(),foreignReturn.exploredSystem);
assert.deepEqual(J.serializeUniverseJournal(),foreignJournal,'excursion never erases persistent interventions');

// Exercise the real save/load functions and the real replacement listener.
// The saved universe deliberately differs from the excursion return state.
const storage=new Map();
globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value))};
const saves=await import('../src/saves.js');
const {getSeed,setSeed}=await import('../src/universe/galaxy.js');
const {galaxyWorldKm}=await import('../src/universe/galaxyRegistry.js');
const P=await import('../src/universe/planetarySystem.js');
const slot='artemis.quicksave.v1';
assert(saves.saveState());const singleEventSave=localStorage.getItem(slot);
const returnTarget={origin:m.cam.preciseTarget.origin.clone(),offset:m.cam.preciseTarget.offset.clone()};
J.recordStarImpulse(foreign.id,3,[4,5,6]);
assert(saves.saveState());const returnSave=localStorage.getItem(slot);
assert.deepEqual(JSON.parse(singleEventSave).universeJournal.events.map(e=>e.sequence),[1]);
assert.deepEqual(JSON.parse(returnSave).universeJournal.events.map(e=>e.sequence),[1,2]);
J.restoreUniverseJournal(null);assert(saves.saveState());const emptyJournalSave=localStorage.getItem(slot);
setSeed(getSeed()+1);J.restoreUniverseJournal(null);
const loadStar=F.sampleForeignStars(galaxyWorldKm('m31',[10000,0,0],0),0).find(star=>P.generateSystem(star).planets.length);
assert(loadStar);
const loadSystem=E.getExploredSystem('proc:'+loadStar.id,null,0);
G.focus=P.planetFocusValue(0,loadSystem);setSimTime(123456);G.paused=true;
J.recordStarImpulse(loadStar.id,2,[-7,8,9]);
const loadTarget={origin:new Vector3(loadStar.x*.001,loadStar.z*.001,-loadStar.y*.001),offset:new Vector3(13.25,-17.5,21.75)};
Object.assign(m.cam,{tgt:loadTarget.origin.clone().add(loadTarget.offset),preciseTarget:loadTarget,dist:123.5,yaw:.7,pitch:.2,distTarget:null});
assert(saves.saveState());const differentUniverseSave=localStorage.getItem(slot);
for(const loadCase of [{blob:differentUniverseSave,target:loadTarget},{blob:singleEventSave,target:returnTarget},{blob:emptyJournalSave,target:returnTarget}]) {
 const loadSave=loadCase.blob,expectedLoad=JSON.parse(loadSave);
 for(const phase of ['ready','playing','paused','complete']) {
    localStorage.setItem(slot,returnSave);assert(await saves.loadState());
    const prior=runtime.captureScenarioReturnState();reboot();runtime.beginJupiterPlayback(prior,reboot);
    if(phase!=='ready')element('spToggle').onclick();
    if(phase==='paused')element('spToggle').onclick();
    if(phase==='complete'){setSimTime(1e12);runtime.settleScenarioPlayback();assert.equal(element('spToggle').textContent,'Finished');}
    assert(runtime.scenarioPlaybackActive());
    const invalid=JSON.parse(loadSave);invalid.universeJournal={version:1,events:[{},{}]};
    localStorage.setItem(slot,JSON.stringify(invalid));
    assert.equal(await saves.loadState(),false,'Invalid save preflight preserves the active excursion');
    assert(runtime.scenarioPlaybackActive());
    localStorage.setItem(slot,loadSave);assert(await saves.loadState());
    assert.equal(runtime.scenarioPlaybackActive(),false,phase+' relinquishes ownership before replacement');
    assert.equal(getSeed(),expectedLoad.galaxySeed);assert.equal(G.t,expectedLoad.g.t);
    assert.equal(G.focus,expectedLoad.g.focus);assert.deepEqual(E.serializeExploredSystem(),expectedLoad.exploredSystem);
    assert.deepEqual(J.serializeUniverseJournal(),expectedLoad.universeJournal,phase+' keeps the loaded journal, not the return journal');
    assert.equal(m.cam.dist,expectedLoad.camera.dist);assert.equal(m.cam.yaw,expectedLoad.camera.yaw);assert.equal(m.cam.pitch,expectedLoad.camera.pitch);
    assert(m.cam.preciseTarget.origin.distanceTo(loadCase.target.origin)<4);
    assert(m.cam.preciseTarget.offset.distanceTo(loadCase.target.offset)<1e-9,phase+' retains the loaded split camera residual');
    assert.equal(runtime.exitScenarioPlayback(),false,'No later exit can overwrite the loaded world');
    assert.deepEqual(J.serializeUniverseJournal(),expectedLoad.universeJournal);
 }
}
hook.deregister();console.log('Scenario ready/start/pause/resume/restart/exit, interruption and full return snapshot checks passed');
