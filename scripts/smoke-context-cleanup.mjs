// Run from the repository root. This checks source-level cleanup, not real GPU recovery.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const {PerspectiveCamera,Vector2}=await import(pathToFileURL(resolve('node_modules/three/build/three.module.js')).href);
const src=fs.readFileSync('src/scene.js','utf8');
const start=src.indexOf('export function renderSceneTiered('), end=src.indexOf('// ---- post-processing',start);
assert(start>=0&&end>start,'Tiered source anchors exist');
const fn=src.slice(start,end).replace('export ','');
for (const fail of ['background','far','near']) {
 const nearTierOnly=[{visible:true},{visible:false}],tierSavedVis=[],farTierGroup={visible:false},tierDepthRange={value:new Vector2(0,1e38)};
 const camera=new PerspectiveCamera(48,1,.02,100000000);
 let draws=0;const renderer={autoClear:true,clear(){},clearDepth(){},render(){draws++;if((fail==='far'&&draws===1)||(fail==='near'&&draws===2))throw Error(fail);}};
 const backgroundHooks=[()=>{if(fail==='background')throw Error(fail);}];
 const factory=new Function('renderLinearFrame','nearTierOnly','tierSavedVis','farTierGroup','tierDepthRange','TIER_SPLIT_UNITS','backgroundHooks',fn+';return renderSceneTiered;');
 const render=factory(()=>false,nearTierOnly,tierSavedVis,farTierGroup,tierDepthRange,1e5,backgroundHooks);
 assert.throws(()=>render(renderer,{},camera),new RegExp(fail));
 assert.deepEqual(nearTierOnly.map(o=>o.visible),[true,false]);assert.equal(farTierGroup.visible,false);assert.equal(renderer.autoClear,true);assert.equal(camera.near,.02);assert.equal(camera.far,100000000);assert.deepEqual(tierDepthRange.value.toArray(),[0,1e38]);
}
const river=fs.readFileSync('src/river.js','utf8');
const fstart=river.indexOf('export function warmRiverCompute('),fend=river.indexOf('// Test/diagnostic',fstart);
assert(fstart>=0&&fend>fstart,'River source anchors exist');
const f=river.slice(fstart,fend).replace('export ','');
const prior={prior:true};let target=prior;const renderer={getRenderTarget:()=>target,setRenderTarget:t=>{target=t;},render:()=>{throw Error('midframe loss');}};
const warm=new Function('renderer',`let river={enabled:true},rtA={},rtB={},computeScene={},computeCam={},uniformsShared={uPos:{}};${f};return warmRiverCompute;`)(renderer);
assert.throws(warm,/midframe loss/);assert.equal(target,prior);
const cstart=src.indexOf('class TieredRenderPass extends RenderPass'),cend=src.indexOf('        composer.addPass(new TieredRenderPass',cstart);
assert(cstart>=0&&cend>cstart,'Composer source anchors exist');
const cls=src.slice(cstart,cend);
class Base{constructor(){Object.assign(this,{overrideMaterial:null,clearColor:null,clearAlpha:null,clearDepth:false,renderToScreen:false,clear:false,scene:{},camera:{}});}}
const Cls=new Function('RenderPass','renderSceneTiered',cls+';return TieredRenderPass;')(Base,()=>{});const r={autoClear:true,setRenderTarget(){}};new Cls().render(r,{},{});assert.equal(r.autoClear,true);
console.log('PASS review harness: tier cleanup after background/far/near exceptions; river target cleanup after exception; healthy composer autoClear restoration');

// Keep exact-source browser fixtures usable after scheduler changes. These
// checks parse transformed modules without launching a browser.
const {execFileSync}=await import('node:child_process');
const {transformCelestialSource}=await import('./celestial-detail-fixtures.mjs');
const {transformExternalGalaxySource}=await import('./external-galaxy-fixtures.mjs');
const main=fs.readFileSync('src/main.js','utf8');
for(const transform of [transformCelestialSource,transformExternalGalaxySource]) {
 const transformed=transform(main,'/src/main.js');
 assert(transformed&&!transformed.includes('renderer.setAnimationLoop(frame);'));
 execFileSync(process.execPath,['--check','--input-type=module'],{input:transformed});
}
const mobile=fs.readFileSync('scripts/verify-mobile-thrust.mjs','utf8');
const transformBody=mobile.slice(mobile.indexOf("if(!id.split"),mobile.indexOf('\n}}]});'));
const transformed=new Function('s','id','assert',transformBody)(main,'/src/main.js',assert);
assert.equal(transformed.split('window.__frameSuccess=').length-1,3,'Every near-flight completion branch is counted');
execFileSync(process.execPath,['--check','--input-type=module'],{input:transformed});
const entry=main.slice(main.indexOf('function frame() {'),main.indexOf('function frameStep() {'));
const makeFrame=new Function('frameStep','renderContext','renderSubmissionSerial',entry+';return frame;');
assert.doesNotThrow(makeFrame(()=>{throw Error('GPU lost');},{isLost:()=>true}));
assert.throws(makeFrame(()=>{throw Error('unrelated failure');},{isLost:()=>false}),/unrelated failure/);
console.log('PASS: production scheduler loss guard, unrelated error propagation, and all exact-source QA transforms');
