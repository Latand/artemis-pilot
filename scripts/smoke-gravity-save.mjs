// Actual save/load and compact-body lifecycle; only presentation is doubled.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {Vector3} from 'three';
globalThis.window=new EventTarget();
const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v))};
const {G,BH,resetShip}=await import('../src/state.js');
const {resetEphem}=await import('../src/ephemeris.js');
const {addHoleData,removeHoleData}=await import('../src/bhEncounters.js');
globalThis.__gravitySave={cam:{dist:5000,yaw:.2,pitch:.4,distTarget:null,tgt:new Vector3()},addHoleData,removeHoleData};
const stateUrl=new URL('../src/state.js',import.meta.url).href;
const mock={
 './scene.js':`export const {cam}=globalThis.__gravitySave;`,
 './blackholes.js':`import {BH} from '${stateUrl}';export function clearBlackHoles(){while(BH.n)globalThis.__gravitySave.removeHoleData(BH.n-1);}export function addBlackHole(x,y,rs,vx,vy,quiet,events,kind,period,z,vz){return globalThis.__gravitySave.addHoleData(x,y,rs,vx,vy,events,kind,period,z,vz);}`,
 './autopilot.js':'export function apOff(){}',
 './relState.js':'export function relResetState(){}',
 './render/nebulae.js':'export const serializeNebulae=()=>[];export function restoreNebulae(){}',
 './trails.js':'export function clearTrail(){}export function pushTrail(){}export function computePrediction(){}',
 './hud.js':'export function hideBanner(){}export function showBanner(){}',
 './achievements.js':'export function toast(){}',
 './discoveryLog.js':'export const serializeLog=()=>({entries:[]});export function restoreLog(){}',
 './timeCtl.js':`import {G} from '${stateUrl}';export const jumpActive=()=>false;export const jumpSaveWarp=()=>G.warp;export function cancelTimeJump(){}`,
};
const hooks=registerHooks({resolve(spec,ctx,next){if(ctx.parentURL?.endsWith('/saves.js')&&spec in mock)return{url:'gravity-save:'+spec,shortCircuit:true};return next(spec,ctx);},load(url,ctx,next){if(url.startsWith('gravity-save:'))return{format:'module',source:mock[url.slice(13)],shortCircuit:true};return next(url,ctx);}});
const {saveState,loadState}=await import('../src/saves.js');
for(const focus of ['bh:0','bh:1','bh:2'])for(const oldCount of [1,3,5]){
 resetShip();resetEphem();BH.n=0;
 for(let i=0;i<3;i++)addHoleData(1e8+i*2e6,1e8+i*3e6,30+i*10,0,0,null,0,0,i*1e6);
 G.focus=focus;assert(saveState());
 while(BH.n)removeHoleData(BH.n-1);
 for(let i=0;i<oldCount;i++)addHoleData(4e8+i*2e6,3e8,2);
 G.focus='ship';assert(await loadState());
 assert.equal(G.focus,focus,`restore ${focus} over ${oldCount} existing holes`);assert.equal(BH.n,3);
 assert.equal(BH.x[Number(focus.slice(3))],1e8+Number(focus.slice(3))*2e6);
}
hooks.deregister();
console.log('PASS actual save/load preserves each compact selection over smaller, equal and larger prior inventories');
