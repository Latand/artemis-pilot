// Bounded procedural volume: one quad, one warm core, no emitted particles.
// The shader's morphology/false colour is illustrative. All motion is a pure
// function of formation progress; pausing and rewinding affect every layer.
import * as THREE from "three";
import { K } from "./constants.js";
import { dotTexture } from "./textures.js";
import { renderQuality } from "./scene.js";

export function makeGasCloudVisual(record) {
    const material = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uProgress: { value: 0 }, uSeed: { value: (record.seed % 997) / 37 }, uBasis: { value: new THREE.Matrix3() } },
        vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
        fragmentShader: `
        varying vec2 vUv; uniform float uProgress, uSeed; uniform mat3 uBasis;
        float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
        float noise(vec3 p){vec3 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
          mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
        float fbm(vec3 p){return .57*noise(p)+.28*noise(p*2.03+8.1)+.15*noise(p*4.11-3.7);}
        void main(){
          vec2 q=(vUv-.5)*2.0; float rr=dot(q,q); if(rr>1.0)discard;
          float chord=sqrt(1.0-rr); vec3 light=vec3(0.0); float trans=1.0;
          float heat=smoothstep(.28,.96,uProgress);
          float angle=uProgress*3.4; mat2 rot=mat2(cos(angle),-sin(angle),sin(angle),cos(angle));
          const int STEPS=${renderQuality.mobile ? 24 : 40};
          for(int i=0;i<STEPS;i++){
            float z=mix(chord,-chord,(float(i)+.5)/float(STEPS));
            vec3 p=uBasis*vec3(q,z); p.xz=rot*p.xz;
            float radial=length(p); vec3 warp=vec3(fbm(p*2.4+uSeed),fbm(p.yzx*2.4+6.0+uSeed),fbm(p.zxy*2.4+11.0+uSeed))-.5;
            float n=fbm(p*6.0+warp*2.8+uSeed);
            float filament=pow(max(0.0,n-.28)*1.8,2.0);
            float envelope=pow(max(0.0,1.0-radial*radial),2.0);
            float dust=filament*envelope*3.5;
            float core=exp(-dot(p,p)*16.0)*heat;
            float a=1.0-exp(-(dust+core)*chord*3.8/float(STEPS));
            vec3 cool=mix(vec3(.13,.24,.40),vec3(.36,.53,.67),n);
            vec3 warm=mix(vec3(.75,.22,.07),vec3(1.45,.86,.36),core);
            vec3 c=mix(cool,warm,heat*(.4+.6*exp(-radial*2.5)));
            light+=trans*a*c*(.55+1.4*n+core*2.0); trans*=1.0-a;
          }
          float fade=1.0-smoothstep(.91,1.0,uProgress);
          gl_FragColor=vec4(light/max(.001,1.0-trans),(1.0-trans)*fade);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const volume = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    volume.renderOrder = -5;
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(255,246,220,1)", "rgba(255,95,28,0.0)"),
        color: 0xffc080, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    const group = new THREE.Group(); group.add(volume, core);
    return { group, volume, core, layers: [], formedVisual: null };
}

export function updateGasCloudVisual(vis, record, state, camera) {
    vis.group.visible = state.present && !state.born;
    if (!vis.group.visible) return;
    vis.volume.quaternion.copy(camera.quaternion);
    vis.volume.material.uniforms.uBasis.value.setFromMatrix4(camera.matrixWorld);
    vis.volume.material.uniforms.uProgress.value = state.progress;
    vis.volume.scale.setScalar(state.radiusKm * K);
    const heat = Math.max(0, (state.progress - .45) / .55);
    vis.core.material.opacity = Math.min(.92, heat * heat);
    vis.core.material.color.setRGB(1, .3 + heat * .6, .1 + heat * .65);
    vis.core.scale.setScalar(state.radiusKm * K * (.06 + heat * .22));
}

export function disposeGasCloudVisual(vis) {
    vis.volume.geometry.dispose(); vis.volume.material.dispose();
    vis.core.material.map.dispose(); vis.core.material.dispose();
}
