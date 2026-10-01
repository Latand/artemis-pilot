// Each translucent kernel follows an actual SPH parcel. Kernel overlap is a
// false-colour density view, NOT optical radiative transfer. The bright core
// glyph marks the unresolved sink; neither its size nor colour is a photosphere.
import * as THREE from "three";
import { K } from "./constants.js";
import { dotTexture } from "./textures.js";
import { gasNumericalView } from "./universe/gasFormation.js";
import { G } from "./state.js";

export function makeGasCloudVisual(record) {
    const view=gasNumericalView(record,G.t),count=view.a.count;
    const geometry=new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,1,-1,0,1,1,0,-1,1,0],3));
    geometry.setIndex([0,1,2,0,2,3]);
    const offset=new THREE.InstancedBufferAttribute(new Float32Array(count*3),3),density=new THREE.InstancedBufferAttribute(new Float32Array(count),1),active=new THREE.InstancedBufferAttribute(new Float32Array(count),1);
    geometry.setAttribute('aOffset',offset);geometry.setAttribute('aDensity',density);geometry.setAttribute('aActive',active);geometry.instanceCount=count;
    const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,side:THREE.DoubleSide,toneMapped:false,
        uniforms:{uRadius:{value:record.radiusKm*K},uH:{value:view.a.h},uTemperature:{value:record.formation.temperatureK}},
        vertexShader:`attribute vec3 aOffset;attribute float aDensity,aActive;uniform float uRadius,uH;varying vec2 vUv;varying float vDensity,vActive;
          void main(){vUv=position.xy;vDensity=aDensity;vActive=aActive;vec4 p=modelViewMatrix*vec4(aOffset*uRadius,1.0);p.xy+=position.xy*uH*uRadius*2.0;gl_Position=projectionMatrix*p;}`,
        fragmentShader:`varying vec2 vUv;varying float vDensity,vActive;uniform float uTemperature;
          void main(){float r2=dot(vUv,vUv);if(r2>1.0||vActive<.5)discard;
          float column=exp(-5.0*r2)*(.07+.025*sqrt(max(0.0,vDensity)));
          float dense=clamp(log(1.0+vDensity)/4.0,0.0,1.0);
          vec3 cold=mix(vec3(.19,.35,.55),vec3(.78,.9,1.0),dense);
          vec3 hot=mix(vec3(.65,.23,.08),vec3(1.0,.72,.31),dense);
          vec3 c=mix(cold,hot,clamp((uTemperature-10.0)/190.0,0.0,1.0));
          gl_FragColor=vec4(c,min(.45,column));
          #include <colorspace_fragment>
          }`,});
    const volume=new THREE.Mesh(geometry,material);volume.frustumCulled=false;volume.renderOrder=-5;
    const core=new THREE.Sprite(new THREE.SpriteMaterial({map:dotTexture("rgba(255,246,222,1)","rgba(255,140,48,0.0)"),
        color:0xffdcaa,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false,opacity:0}));
    const group=new THREE.Group();group.add(volume,core);
    return{group,volume,core,offset,density,active,layers:[]};
}
export function updateGasCloudVisual(vis,record,state,_camera) {
    const view=gasNumericalView(record,G.t),{a,b,blend}=view;
    vis.group.visible=state.present;
    if(!state.present)return;
    for(let i=0;i<a.count;i++){
        vis.active.array[i]=a.active[i];
        vis.density.array[i]=a.density[i]/(3/(4*Math.PI));
        const j=i*3;
        vis.offset.array[j]=a.positions[j]+(b.positions[j]-a.positions[j])*blend;
        vis.offset.array[j+1]=a.positions[j+2]+(b.positions[j+2]-a.positions[j+2])*blend;
        vis.offset.array[j+2]=-a.positions[j+1]-(b.positions[j+1]-a.positions[j+1])*blend;
    }
    vis.offset.needsUpdate=vis.density.needsUpdate=vis.active.needsUpdate=true;
    vis.core.visible=state.born;
    if(state.born){
        vis.core.position.set(state.sinkPosition[0]*record.radiusKm*K,state.sinkPosition[2]*record.radiusKm*K,-state.sinkPosition[1]*record.radiusKm*K);
        vis.core.scale.setScalar(state.sinkRadiusKm*K*.65);
        vis.core.material.opacity=.55+.45*Math.min(1,state.coreMassSolar/state.totalMassSolar);
    }
}
export function disposeGasCloudVisual(vis){vis.volume.geometry.dispose();vis.volume.material.dispose();vis.core.material.map.dispose();vis.core.material.dispose();}
