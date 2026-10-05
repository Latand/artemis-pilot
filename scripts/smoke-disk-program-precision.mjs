import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { WebGLPrograms } from 'three/src/renderers/webgl/WebGLPrograms.js';
import { K } from '../src/constants.js';
import { SHADOW_RS, shadowAngularRadius } from '../src/render/holeAppearance.js';
assert.equal(THREE.REVISION,'164','regression targets installed Three r164 program selection');
const source=readFileSync(new URL('../src/holeOptics.js',import.meta.url),'utf8');
const executable=source.replace(/^import .*;$/gm,'').replace(/^export \{[^\n]+;$/gm,'').replace(/export (const|function) /g,'$1 ');
const scene=new THREE.Scene();
const {makeHoleOptics,holeRoot}=new Function('THREE','K','scene','SHADOW_RS','shadowAngularRadius',
    executable+'\nreturn {makeHoleOptics,holeRoot};')(THREE,K,scene,SHADOW_RS,shadowAngularRadius);
const capabilities={precision:'highp',getMaxPrecision:value=>value,vertexTextures:true,logarithmicDepthBuffer:false};
const gl={FRAGMENT_SHADER:35632,HIGH_FLOAT:36338,getShaderPrecisionFormat:()=>({precision:23,rangeMin:127,rangeMax:127})};
const renderer={capabilities,getContext:()=>gl,getCurrentViewport:target=>target.set(0,0,960,640),getRenderTarget:()=>null,
    outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.NoToneMapping,shadowMap:{enabled:false,type:THREE.PCFShadowMap}};
const maps={get:()=>null},extensions={has:()=>false};
const programs=WebGLPrograms(renderer,maps,maps,extensions,capabilities,{}, {numPlanes:0,numIntersection:0});
const lights=Object.fromEntries(['directional','point','spot','spotLightMap','rectArea','hemi','directionalShadowMap','pointShadowMap','spotShadowMap'].map(name=>[name,[]]));
lights.numSpotLightShadowsWithMaps=0;lights.numLightProbes=0;
const camera=new THREE.PerspectiveCamera(48,1.5,.02,1e7);
camera.position.set(0,600*Math.sin(.48),600*Math.cos(.48));camera.lookAt(0,0,0);camera.updateMatrixWorld(true);
function makeDisk() {
    const optics=makeHoleOptics();holeRoot.add(optics.shadow,optics.disk,optics.ring,optics.jet);optics.rsUnits=50;
    const uniforms=optics.disk.material.uniforms;uniforms.uRsUnits.value=50;uniforms.uDiskOn.value=1;uniforms.uRout.value=20;
    return optics.disk;
}
function parameterize(material,object) { return programs.getParameters(material,lights,[],scene,object); }
const otherMaterial=new THREE.ShaderMaterial(),other=new THREE.Mesh(new THREE.PlaneGeometry(),otherMaterial);
function precedingPrecision(value) {otherMaterial.precision=value;return parameterize(otherMaterial,other);}
let checks=0;
function draw(disk,expected,label){disk.onBeforeRender(renderer,scene,camera);assert.equal(disk.material.uniforms.uDiskUnclipped.value,expected,label);disk.onAfterRender();checks++;}
// These explicit parameterizations model unarmed precompilation. Actual draw
// callback order and both static variants are covered by smoke-disk-static-programs.
// Exact r164 reproduction: WebGLPrograms retains its last precision variable
// when the next material.precision is null, despite renderer default highp.
precedingPrecision('mediump');
const inherited=makeDisk();assert.equal(inherited.material.precision,null);
const inheritedParams=parameterize(inherited.material,inherited);
assert.equal(capabilities.precision,'highp');assert.equal(inheritedParams.precision,'mediump');
assert.equal(inherited.material.precision ?? renderer.capabilities.precision,'highp','old inferred default would authorize the wrong precision');checks++;
inherited.material.onBeforeCompile(inheritedParams,renderer);draw(inherited,0,'actual inherited mediump must reject the shortcut');
const inheritedCache=new Set([programs.getProgramCacheKey(inheritedParams)]);
for(const precision of ['highp','mediump']) {
    precedingPrecision(precision);const parameters=parameterize(inherited.material,inherited),key=programs.getProgramCacheKey(parameters);
    const cached=inheritedCache.has(key);assert.equal(cached,precision==='mediump','reviewer sequence returns to cached mediump');checks++;
    if(!cached){inherited.material.onBeforeCompile(parameters,renderer);inheritedCache.add(key);}
    draw(inherited,0,`reviewer mediump→highp→cached-mediump sequence: ${precision}`);
}


// Follow actual Three parameterization/cache keys. Like getProgram, invoke
// onBeforeCompile only on a new key; a cached selection must not call it.
const disk=makeDisk(),cache=new Map();let compiles=0;
function select(precision,variant,expected,newProgram) {
    precedingPrecision(precision);
    if(variant===0)delete disk.material.defines.QA_VARIANT;else disk.material.defines.QA_VARIANT=variant;
    const parameters=parameterize(disk.material,disk),key=programs.getProgramCacheKey(parameters);
    assert.equal(parameters.precision,precision);
    const cached=cache.has(key);assert.equal(!cached,newProgram,'expected real program-cache transition');
    if(!cached){disk.material.onBeforeCompile(parameters,renderer);cache.set(key,parameters);compiles++;}
    draw(disk,expected,`${precision}/${variant}/${cached?'cached':'new'} precision binding`);
    return key;
}
const highKey=select('highp',0,1,true);
const mediumKey=select('mediump',0,0,true);assert.notEqual(highKey,mediumKey,'actual cache key includes effective precision');checks++;
select('highp',1,0,true); // another program compiles successfully after rejection
assert.equal(select('mediump',0,0,false),mediumKey,'cached mediump returns without a callback');checks++;
assert.equal(select('highp',0,0,false),highKey,'even safe cached variants retain conservative rejection');checks++;
assert.equal(compiles,3,'exactly three new program hooks; cached returns skipped them');checks++;

const absent=makeDisk();absent.material.onBeforeCompile({},renderer);draw(absent,0,'absent effective precision rejects');
precedingPrecision('highp');absent.material.onBeforeCompile(parameterize(absent.material,absent),renderer);draw(absent,0,'missing earlier proof stays rejected');
const fresh=makeDisk();fresh.material.onBeforeCompile(parameterize(fresh.material,fresh),renderer);draw(fresh,1,'new material with actual highp gets independent eligibility');
assert.equal(fresh.material.precision,null,'correction does not force a new material precision policy');checks++;
console.log(`Disk program precision: ${checks} checks passed using installed Three WebGLPrograms parameters/cache keys; inherited mediump, cached variants and missing precision reject. No GPU program execution claimed.`);
