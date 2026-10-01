// Exercise real prediction/physics modules without a WebGL context. Only the
// scene and texture factories are replaced; main's actual toggle is reused.
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
registerHooks({load(url,context,next){
 if(url===`file://${root}/src/scene.js`)return {format:'module',shortCircuit:true,source:`import * as THREE from '${root}/node_modules/three/build/three.module.js';export const scene=new THREE.Scene();export const renderQuality={mobile:false};`};
 if(url===`file://${root}/src/textures.js`)return {format:'module',shortCircuit:true,source:'export const dotTexture=()=>null;export const ringTexture=()=>null;export const ringTextureProc=()=>null;'};
 if(url===`file://${root}/src/trails.js`)return {format:'module',shortCircuit:true,source:readFileSync(new URL(url),'utf8')+'\nexport function qaPrediction(){return {shipPoints:prGeom.drawRange.count,bodyPoints:bpGeom.drawRange.count,bodyVisible:bodyPredLine.visible,bounded:boundedInspectionPrediction,focus:inspectionPredictionFocus}};'};
 return next(url,context);
}});
globalThis.window={};globalThis.location={search:''};
const trails=await import('../src/trails.js'),{G,resetWorld}=await import('../src/state.js'),ephem=await import('../src/ephemeris.js');
const {J2000_MS,setEpochMs}=await import('../src/epoch.js'),{R_EARTH}=await import('../src/constants.js');
setEpochMs(J2000_MS);resetWorld();ephem.resetEphem();Object.assign(G,{t:0,x:R_EARTH+1000,y:0,z:0,vx:0,vy:7,vz:0,focus:'ship',uiMode:'observe',predict:false,landed:null,dead:false});
let lockedBodyTarget=-99,bodyPredHiddenForPredictOff=true;const BODY_NONE=-99;
const {gravityPredictionActive,useBoundedCoastPrediction,computePrediction,computeBodyPrediction}=trails;
function unlockBodyPrediction(){lockedBodyTarget=BODY_NONE;bodyPredHiddenForPredictOff=true;trails.clearBodyPrediction();}
trails.initInspectionPredictionHooks({clearBodyLock:unlockBodyPrediction});
const toggleSource=readFileSync(`${root}/src/main.js`,'utf8').match(/function toggleGravityPrediction\(\)\{[\s\S]*?\n\}/)[0];
const toggleGravityPrediction=eval(`(${toggleSource})`);
function inspect(focus='earth'){trails.clearInspectionPrediction();G.predict=false;G.uiMode='observe';G.focus=focus;toggleGravityPrediction();assert(trails.gravityPredictionActive(focus));assert.equal(lockedBodyTarget,focus==='earth'?-3:-2);assert(trails.qaPrediction().bodyPoints>=16);}
function normal(){const s=trails.qaPrediction();assert(G.predict);assert(!s.bounded);assert.equal(s.focus,null);assert(s.shipPoints>1);assert.equal(s.bodyPoints,0);assert(!s.bodyVisible);assert.equal(lockedBodyTarget,BODY_NONE);}
inspect();G.focus='ship';trails.syncInspectionPrediction();trails.togglePrediction();trails.togglePrediction();normal();
console.log('PASS focus change + normal P off/on clears inspector mode and stale body lock');
inspect();trails.togglePrediction();trails.togglePrediction();normal();
console.log('PASS normal prediction toggle exits inspector mode even on the same target');
inspect();G.uiMode='pilot';trails.syncInspectionPrediction();computePrediction();normal();
console.log('PASS mode transition clears inspection state without requiring another selection');
inspect();trails.clearTrail();computePrediction();normal();
console.log('PASS reset/quickload trail reset clears the session and body lock');
inspect();G.predict=false;computePrediction();assert(!trails.qaPrediction().bounded);G.predict=true;computePrediction();normal();
console.log('PASS direct off/on cannot resurrect a stale inspector session');
inspect();G.focus='moon';computeBodyPrediction(-3,true);assert.equal(lockedBodyTarget,BODY_NONE);assert.equal(trails.qaPrediction().bodyPoints,0);
console.log('PASS a stale body computation cancels instead of redrawing the old target');
const before=ephem.snapshotEphem();G.focus='ship';G.predict=true;computePrediction();assert.deepEqual(ephem.snapshotEphem(),before);
lockedBodyTarget=-2;assert.equal(trails.clearInspectionPrediction(),false);assert.equal(lockedBodyTarget,-2);
console.log('PASS normal paths preserve live state and unrelated normal body locks');
