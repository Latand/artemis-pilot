import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {captureExploredWarmResources,gpuResourcesDoNotGrow,inspectExploredWarmTransition} from './explored-warm-resources.mjs';
const scene=new THREE.Scene(),texture=new THREE.Texture({width:256,height:64});
const label=new THREE.Sprite(new THREE.SpriteMaterial({map:texture}));scene.add(label);
const properties=new WeakMap([[texture,{}]]);
globalThis.window={exploredQA:{s:{scene,renderer:{info:{memory:{textures:28,geometries:87}},properties:{get:t=>properties.get(t)||{}}},cam:{dist:1637,tgt:new THREE.Vector3()}},body:{systemBodyRenderState:()=>[null,{label}]},state:{G:{focus:'star:2'}}}};
const capturedCold=captureExploredWarmResources();assert.equal(capturedCold.textures.length,1);assert.equal(capturedCold.textures[0].initialized,false);
assert.equal(capturedCold.textures[0].source,texture.source.uuid);assert.equal(capturedCold.p2Label.texture,texture.uuid);
properties.set(texture,{__webglTexture:{}});window.exploredQA.s.renderer.info.memory.textures++;
const capturedWarm=captureExploredWarmResources();assert(inspectExploredWarmTransition(capturedCold,capturedWarm).passed);
assert.equal(texture.version,0,'Read-only inventory does not schedule an upload');delete globalThis.window;
const before={gpu:{geometries:87,textures:28},materials:['fixed-material'],textures:[{id:'existing-label',source:'existing-canvas',width:256,height:64,initialized:false}],p2Label:{object:'p2',material:'fixed-material',texture:'existing-label'}};
const after=structuredClone(before);after.gpu.textures++;after.textures[0].initialized=true;
assert(inspectExploredWarmTransition(before,after).passed,'The exact observed first use is explained by its existing label');
assert(inspectExploredWarmTransition(after,after).passed,'An already warm desktop label allocates nothing');
assert(!inspectExploredWarmTransition(before,before).passed,'Old settled-only warmup must fail because the known label is not initialized');
for(const mutate of [
 s=>s.textures.push({id:'surprise',source:'new-source',width:256,height:64,initialized:true}),
 s=>s.textures[0].source='replacement-canvas',s=>s.textures[0].width=512,
 s=>s.p2Label.material='replacement-material',s=>s.gpu.textures++,s=>s.gpu.geometries++,
]){const changed=structuredClone(after);mutate(changed);assert(!inspectExploredWarmTransition(before,changed).passed);}
assert(gpuResourcesDoNotGrow(after.gpu,after.gpu));
assert(!gpuResourcesDoNotGrow({...after.gpu,textures:30},after.gpu),'An unexpected texture after the baseline still fails with no +1 allowance');
assert(!gpuResourcesDoNotGrow({...after.gpu,geometries:88},after.gpu));
const source=readFileSync(new URL('./verify-explored-systems.mjs',import.meta.url),'utf8');
assert(source.indexOf('const afterFirstUse=')<source.indexOf('const repeatedStart ='));
assert.match(source,/for \(let index = 0; index < 20; index\+\+\)/);
assert.match(source,/gpuResourcesDoNotGrow\(star.render.gpu,repeatedStart.render.gpu\)/);
console.log('PASS: real texture/source inventory, exact known-label first use, unchanged identity, old-warmup negative control, unexplained allocations rejected, twenty repeats retain strict no-growth gate');
