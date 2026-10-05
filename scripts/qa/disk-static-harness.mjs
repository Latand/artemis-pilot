// CPU callback/cache harness; no WebGL context, browser or shader execution.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {WebGLPrograms} from 'three/src/renderers/webgl/WebGLPrograms.js';
import {K} from '../../src/constants.js';
import {SHADOW_RS,shadowAngularRadius} from '../../src/render/holeAppearance.js';
export {THREE};
export const source=readFileSync(new URL('../../src/holeOptics.js',import.meta.url),'utf8');
const executable=source.replace(/^import .*;$/gm,'').replace(/^export \{[^\n]+;$/gm,'').replace(/export (const|function) /g,'$1 ');
const scene=new THREE.Scene();
const {makeHoleOptics,holeRoot}=new Function('THREE','K','scene','SHADOW_RS','shadowAngularRadius',executable+'\nreturn {makeHoleOptics,holeRoot};')(THREE,K,scene,SHADOW_RS,shadowAngularRadius);
const rendererSource=readFileSync(new URL('../../node_modules/three/src/renderers/WebGLRenderer.js',import.meta.url),'utf8');
const between=(a,b)=>{const i=rendererSource.indexOf(a),j=rendererSource.indexOf(b,i);assert(i>0&&j>i);return rendererSource.slice(i,j);};
const actualRender=between('\t\tfunction renderObject(', '\t\tfunction getProgram(');
const actualGetProgram=between('\t\tfunction getProgram(', '\t\tfunction getUniformList(');
const actualUpdate=between('\t\tfunction updateCommonMaterialProperties(', '\t\tfunction setProgram(');
assert(rendererSource.includes('if ( material.version === materialProperties.__version )'));
assert(rendererSource.includes('} else if ( materialProperties.outputColorSpace !== colorSpace ) {'));
export function makeDisk(){const o=makeHoleOptics();holeRoot.add(o.shadow,o.disk,o.ring,o.jet);o.rsUnits=50;const u=o.disk.material.uniforms;u.uRsUnits.value=50;u.uDiskOn.value=1;u.uRout.value=20;return o.disk;}
export function makeMutatedDisk(text){
 const code=text.replace(/^import .*;$/gm,'').replace(/^export \{[^\n]+;$/gm,'').replace(/export (const|function) /g,'$1 ');
 const factory=new Function('THREE','K','scene','SHADOW_RS','shadowAngularRadius',code+'\nreturn {makeHoleOptics,holeRoot};')(THREE,K,scene,SHADOW_RS,shadowAngularRadius);
 const o=factory.makeHoleOptics();factory.holeRoot.add(o.shadow,o.disk,o.ring,o.jet);o.rsUnits=50;
 const u=o.disk.material.uniforms;u.uRsUnits.value=50;u.uDiskOn.value=1;u.uRout.value=20;return o.disk;
}
export function makeCamera(pitch=.48){const camera=new THREE.PerspectiveCamera(48,1.5,.02,1e7);pose(camera,pitch);return camera;}
export function pose(camera,pitch=.48){camera.position.set(0,600*Math.sin(pitch),600*Math.cos(pitch));camera.lookAt(0,0,0);camera.updateMatrixWorld(true);camera.updateProjectionMatrix();}
export function harness(){
 const state={format:{precision:23,rangeMin:127,rangeMax:127},formatThrows:false,queries:0,builds:0,lookups:0,draws:[],viewport:new THREE.Vector4(0,0,960,640),force:false};
 const gl={FRAGMENT_SHADER:35632,HIGH_FLOAT:36338,getShaderPrecisionFormat:()=>{state.queries++;if(state.formatThrows)throw Error('format unavailable');return state.format;}};
 const capabilities={precision:'highp',getMaxPrecision:p=>p,vertexTextures:true,logarithmicDepthBuffer:false};
 const renderer={capabilities,getContext:()=>gl,getCurrentViewport:t=>t.copy(state.viewport),getRenderTarget:()=>state.target||null,outputColorSpace:THREE.SRGBColorSpace,toneMapping:THREE.NoToneMapping,shadowMap:{enabled:false,type:THREE.PCFShadowMap}};
 const maps={get:()=>null},extensions={has:()=>false},lights=Object.fromEntries(['directional','point','spot','spotLightMap','rectArea','hemi','directionalShadowMap','pointShadowMap','spotShadowMap'].map(n=>[n,[]]));
 Object.assign(lights,{version:0,numSpotLightShadowsWithMaps:0,numLightProbes:0});
 let properties,cache,nativePrograms,getProgram,renderObject;
 function initialize(){
  const records=new WeakMap();properties={get:m=>{if(!records.has(m))records.set(m,{});return records.get(m);}};cache=new Map();
  nativePrograms=WebGLPrograms(renderer,maps,maps,extensions,capabilities,{}, {numPlanes:0,numIntersection:0});
  const programCache={getParameters:(...args)=>{state.lookups++;return nativePrograms.getParameters(...args);},getProgramCacheKey:nativePrograms.getProgramCacheKey,getUniforms:nativePrograms.getUniforms,
   acquireProgram:(parameters,key)=>{if(!cache.has(key)){state.builds++;cache.set(key,{key,parameters:{precision:parameters.precision,defines:{...parameters.defines},fragmentShader:parameters.fragmentShader,vertexShader:parameters.vertexShader,customProgramCacheKey:parameters.customProgramCacheKey}});}return cache.get(key);}};
  ({getProgram,renderObject}=new Function('_this','properties','currentRenderState','programCache','cubemaps','cubeuvmaps','clipping','onMaterialDispose','materialNeedsLights','DoubleSide','BackSide','FrontSide','_emptyScene',actualRender+actualGetProgram+actualUpdate+'\nreturn {getProgram,renderObject};')(renderer,properties,{state:{lights:{state:lights},shadowsArray:[]}},programCache,maps,maps,{uniform:{}},()=>{},()=>false,THREE.DoubleSide,THREE.BackSide,THREE.FrontSide,new THREE.Scene()));
 }
 initialize();
 renderer.renderBufferDirect=(camera,s,geometry,material,object)=>{
  const meta=properties.get(material),colorSpace=state.target?THREE.LinearSRGBColorSpace:renderer.outputColorSpace;
  // Only the two actual setProgram admission conditions relevant to these
  // unlit, unclipped, non-instanced ShaderMaterial fixtures are modeled here.
  if(meta.__version!==material.version||meta.outputColorSpace!==colorSpace||state.force){meta.__version=material.version;getProgram(material,s,object);}
  const program=meta.currentProgram;assert(program);
  const mode=program.parameters.defines.DISK_UNCLIPPED===1&&program.parameters.precision==='highp'?1:0;
  state.draws.push({mode,flag:material.uniforms.uDiskUnclipped.value,version:material.version,count:geometry.drawRange.count,program,queries:state.queries,builds:state.builds});
 };
 return{renderer,state,cache:()=>cache,
  draw:(disk,camera)=>{renderObject(disk,scene,camera,disk.geometry,disk.material,null);return state.draws.at(-1);},
  compile:disk=>getProgram(disk.material,scene,disk),
  seedPrecision:precision=>{const m=new THREE.ShaderMaterial();m.precision=precision;const o=new THREE.Mesh(new THREE.PlaneGeometry(),m);return nativePrograms.getParameters(m,lights,[],scene,o);},
  recover:()=>initialize(),scene};
}
