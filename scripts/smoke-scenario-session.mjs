// DOM/renderer doubles isolate the real excursion lifecycle; orbital physics
// is separately exercised by smoke-scenario-playback and the full browser QA.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
globalThis.window=new EventTarget();
const elements=new Map();
const element=id=>{if(!elements.has(id))elements.set(id,{id,hidden:false,textContent:'',value:0,disabled:false,appendChild(){},setAttribute(){},onclick:null});return elements.get(id);};
globalThis.document={body:{classList:{add(){},remove(){}}},createElement:()=>element('scenarioPlayback'),getElementById:element,addEventListener(){}};
const {G,WORLD,BH,GS,resetShip,setSimTime}=await import('../src/state.js');
const {eph,resetEphem,snapshotEphem}=await import('../src/ephemeris.js');
resetShip();resetEphem();
const vec={x:3,y:4,z:5,toArray(){return[this.x,this.y,this.z];},fromArray(a){[this.x,this.y,this.z]=a;},set(x,y,z){Object.assign(this,{x,y,z});}};
const m=globalThis.__scenarioMock={cam:{yaw:1,pitch:.4,dist:80,distTarget:null,tgt:vec},camera:{aspect:1.6},AP:{mode:'travel',target:3,phase:'coast'},REL:{active:false,phase:'off'},neb:[[1,2,3]],enc:{v:1},log:{entries:[{id:'prior-discovery'}]},jump:false,listeners:new Set()};
const mock={
 './scene.js':`export const {cam,camera}=globalThis.__scenarioMock;`,
 './autopilot.js':`export const AP=globalThis.__scenarioMock.AP; export function apOff(){AP.mode='off';}`,
 './relState.js':`export const REL=globalThis.__scenarioMock.REL;export function relResetState(){REL.active=false;REL.phase='off';}`,
 './blackholes.js':`import {BH} from '${new URL('../src/state.js',import.meta.url)}';export function clearBlackHoles(){BH.n=0;}export function addBlackHole(){BH.n++;}`,
 './bhEncounters.js':`export const serializeEncounterState=()=>structuredClone(globalThis.__scenarioMock.enc);export function restoreEncounterState(s){globalThis.__scenarioMock.enc=structuredClone(s);}`,
 './render/nebulae.js':`export const serializeNebulae=()=>structuredClone(globalThis.__scenarioMock.neb);export function restoreNebulae(s){globalThis.__scenarioMock.neb=structuredClone(s);}`,
 './universe/gasDynamics.js':`export function invalidateGasDynamics(){}`,
 './trails.js':`export function clearTrail(){} export function pushTrail(){} export function computePrediction(){}`,
 './hud.js':`export function hideBanner(){}`,
 './discoveryLog.js':`export const serializeLog=()=>structuredClone(globalThis.__scenarioMock.log);export function restoreLog(log){globalThis.__scenarioMock.log=structuredClone(log);}`,
 './timeCtl.js':`import {G} from '${new URL('../src/state.js',import.meta.url)}';export function setWarp(w,s){for(const fn of globalThis.__scenarioMock.listeners)fn('warp',s);G.warp=w;}export function setPaused(p){G.paused=p;}export function onTimeControl(fn){globalThis.__scenarioMock.listeners.add(fn);}export const jumpActive=()=>globalThis.__scenarioMock.jump;export function cancelTimeJump(){globalThis.__scenarioMock.jump=false;}`,
 './uiMode.js':`export function setUiMode(){}`,
 './scenarioPlayback.css':'',
};
const hook=registerHooks({resolve(spec,ctx,next){if(ctx.parentURL?.endsWith('/scenarioPlayback.js')&&spec in mock)return{url:'scenario-test:'+spec,shortCircuit:true};return next(spec,ctx);},load(url,ctx,next){if(url.startsWith('scenario-test:'))return{format:'module',source:mock[url.slice(14)],shortCircuit:true};return next(url,ctx);}});
const runtime=await import('../src/scenarioPlayback.js');
runtime.initScenarioPlayback();
const reboot=()=>{resetShip();resetEphem();};
G.warp=321;G.paused=true;G.focus='earth';G.uiMode='observe';G.tau=120;G.driveMode='curvature';
BH.n=1;BH.x[0]=123;BH.rs[0]=.3;BH.ev[0]=[{t:0,dmu:5}];WORLD.muScale[0]=.7;GS.push({t:Infinity,x:5});
const original=runtime.captureScenarioReturnState();
reboot();runtime.beginJupiterPlayback(original,reboot);
assert.equal(G.paused,true);assert.equal(G.focus,'ship');assert.equal(m.AP.mode,'off');assert.equal(m.neb.length,0);
assert.equal(runtime.tickScenarioPlayback(.1).advanceSec,0,'ready awaits start');
element('spToggle').onclick();assert.equal(G.paused,false);
const first=runtime.tickScenarioPlayback(.1);assert.ok(first.advanceSec>0);G.t+=first.advanceSec;runtime.settleScenarioPlayback();
element('spToggle').onclick();const paused=G.t;assert.equal(runtime.tickScenarioPlayback(.1).advanceSec,0);assert.equal(G.t,paused);
element('spToggle').onclick();assert.ok(runtime.tickScenarioPlayback(.1).advanceSec>0);
element('spRestart').onclick();assert.equal(G.t,0);assert.equal(G.paused,true);assert.equal(element('spToggle').textContent,'Start flight');
m.log.entries.push({id:'temporary-discovery'});
assert.ok(runtime.exitScenarioPlayback());assert.ok(!runtime.scenarioPlaybackActive());
for(const k of ['t','tau','x','y','z','vx','vy','vz','warp','paused','focus','uiMode','driveMode'])assert.deepEqual(G[k],original.g[k],`return ${k}`);
assert.deepEqual([...WORLD.muScale],[...original.world.muScale]);assert.deepEqual(BH,original.bh);assert.deepEqual(GS,original.gs);assert.deepEqual(m.AP,original.ap);assert.deepEqual(m.neb,original.neb);assert.deepEqual(m.cam.tgt.toArray(),original.camera.tgt);
assert.deepEqual(snapshotEphem(),original.eph);assert.deepEqual(m.log,original.log,'discovery history is restored');
assert.equal(runtime.exitScenarioPlayback(),false,'repeated exit harmless');
// User time action relinquishes ownership before applying that action.
reboot();runtime.beginJupiterPlayback(original,reboot);for(const fn of m.listeners)fn('warp','user');G.warp=20;assert.equal(G.x,original.g.x);assert.equal(G.warp,20);assert.ok(!runtime.scenarioPlaybackActive());
reboot();runtime.beginJupiterPlayback(original,reboot);element('spToggle').onclick();const interrupted=runtime.tickScenarioPlayback(.1,true);assert.equal(interrupted.advanceSec,0,'interruption frame cannot burn on restored flight');assert.equal(G.x,original.g.x);
reboot();runtime.beginJupiterPlayback(original,reboot);window.dispatchEvent(new Event('ap:replace-universe'));assert.ok(!runtime.scenarioPlaybackActive());assert.equal(G.x,original.g.x);
reboot();runtime.beginJupiterPlayback(original,reboot);m.jump=true;assert.equal(runtime.tickScenarioPlayback(.1).advanceSec,0);assert.ok(!runtime.scenarioPlaybackActive());assert.equal(m.jump,false,'a competing event jump cannot resume after returning to a different clock');
hook.deregister();console.log('Scenario ready/start/pause/resume/restart/exit, interruption and full return snapshot checks passed');
