import * as THREE from 'three';
import { K, MU_S, PC_KM, DARK_MATTER } from '../constants.js';
import { G, WORLD } from '../state.js';
import { camera, cam, scene, renderQuality } from '../scene.js';
import { tierDepthRange } from './tierDepth.js';
import { GRAVITY_STARS } from '../universe/activeStars.js';
import { galacticCenterScene } from '../universe/starfield.js';
import { galaxyFlowSources } from './galaxyPopulationRender.js';
import { flowPulseRate, largeScaleFlowBlend } from '../flowScaleMath.js';

const MAX_SOURCES = 24, SEGMENTS = 4;
const sources = Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4());
const shape = Array.from({ length: MAX_SOURCES }, () => new THREE.Vector3());
const uniforms = {
    uSources: { value: sources }, uShape: { value: shape }, uCount: { value: 0 },
    uScale: { value: 1 }, uCenter: { value: new THREE.Vector3() },
    uPhase: { value: 0 }, uOpacity: { value: 0 }, uLength: { value: .08 },
    uFar: { value: 1 }, uDepthRange: tierDepthRange,
};
const vertexShader = /* glsl */`
precision highp float;
attribute float aSeed, aAlong;
uniform vec4 uSources[${MAX_SOURCES}];
// (softening radius, NFW scale radius, virial radius), normalized to view.
uniform vec3 uShape[${MAX_SOURCES}];
uniform int uCount;
uniform float uScale, uPhase, uOpacity, uLength, uFar;
uniform vec3 uCenter;
uniform vec2 uDepthRange;
varying vec3 vColor;
float hash(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
vec3 randomDir(float n) {
    float z = hash(n + 2.7) * 2.0 - 1.0;
    float phi = hash(n + 6.1) * 6.2831853;
    return vec3(sqrt(max(0.0, 1.0-z*z)) * cos(phi), z, sqrt(max(0.0, 1.0-z*z)) * sin(phi));
}
vec3 field(vec3 p) {
    vec3 pull = vec3(0.0);
    for (int i = 0; i < ${MAX_SOURCES}; i++) {
        if (i >= uCount) break;
        vec3 delta = uSources[i].xyz - p;
        float r = max(length(delta), 0.00001);
        float mass = uSources[i].w;
        if (uShape[i].y > 0.0) {
            float x = min(r, uShape[i].z) / uShape[i].y;
            float c = uShape[i].z / uShape[i].y;
            mass *= (log(1.0+x) - x/(1.0+x)) / (log(1.0+c) - c/(1.0+c));
        }
        float r2 = dot(delta, delta) + uShape[i].x*uShape[i].x;
        pull += delta * mass / max(0.000000001, r2*sqrt(r2));
    }
    return pull;
}
void main() {
    float cycle = fract(uPhase + hash(aSeed));
    vec3 p = uCenter + randomDir(aSeed) * pow(hash(aSeed+9.0), .3333333) * 1.7;
    // Half the glyphs sample the strongest wells, half the surrounding field.
    int anchor = int(mod(aSeed, float(max(1,uCount))));
    for (int i = 0; i < ${MAX_SOURCES}; i++) {
        if (i == anchor && mod(aSeed, 2.0) < 1.0) {
            float reach = clamp(length(uSources[i].xyz-uCenter)*.35, .12, 1.4);
            p = uSources[i].xyz + randomDir(aSeed) * reach * (.3+hash(aSeed+5.0));
        }
    }
    // Streamline glyph, integrated in view units, with inward moving pulse.
    // This traces the softened gravitational gradient; it is not stellar motion.
    float path = cycle * .22 + aAlong * uLength;
    for (int i = 0; i < 6; i++) {
        vec3 f = field(p);
        float len = length(f);
        if (len > .00000001) p += f / len * (path / 6.0);
    }
    vec3 view = mat3(modelViewMatrix) * p;
    float dist = max(length(view), .00000001);
    float depth = -view.z * uScale;
    float ink = smoothstep(0.0,.12,cycle) * (1.0-smoothstep(.8,1.0,cycle));
    // Stop glyphs at a small display footprint instead of oscillating across
    // unresolved centres and piling into a bright point at web scale.
    for (int i = 0; i < ${MAX_SOURCES}; i++) {
        if (i >= uCount) break;
        if (uSources[i].w > .0001) ink *= smoothstep(.015,.045,length(p-uSources[i].xyz));
    }
    ink *= 1.0-smoothstep(1.5,2.2,length(p-uCenter));
    ink *= smoothstep(.035,.2,dist);
    if (depth < uDepthRange.x || depth >= uDepthRange.y || view.z >= 0.0) ink = 0.0;
    gl_Position = projectionMatrix * vec4(view/dist * min(dist*uScale,uFar*.8), 1.0);
    float pulse = .3 + .7 * pow(max(0.0,cos((aAlong-cycle)*6.2831853)),4.0);
    vColor = mix(vec3(.10,.40,.72),vec3(.48,.82,1.0),aAlong) * ink * pulse * uOpacity;
}`;
const fragmentShader = /* glsl */`
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor,1.0); }
`;
let mesh, cachedGalaxies = [], lastSample = -Infinity, lastScale = 0, lastDarkMatter;
const lastTarget = new THREE.Vector3(Infinity, Infinity, Infinity);
export const largeFlowStatus = { visible: false, sources: 0, galaxies: 0, phase: 0, blend: 0, crossingSeconds: 0 };
window.__largeFlow = largeFlowStatus;

function init() {
    const particles = renderQuality.mobile ? 160 : 360;
    const count = particles * SEGMENTS * 2;
    const seed = new Float32Array(count), along = new Float32Array(count);
    let v = 0;
    for (let i = 0; i < particles; i++) for (let j = 0; j < SEGMENTS; j++) {
        seed[v] = seed[v+1] = i + 1;
        along[v++] = j / SEGMENTS; along[v++] = (j+1) / SEGMENTS;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count*3),3));
    geometry.setAttribute('aSeed',new THREE.BufferAttribute(seed,1));
    geometry.setAttribute('aAlong',new THREE.BufferAttribute(along,1));
    mesh = new THREE.LineSegments(geometry, new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader,
        transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
    mesh.name = 'gravity.timePulses.largeScale'; mesh.frustumCulled = false;
    // Both depth tiers see this object; uDepthRange emits each glyph only in
    // its own tier, including the solar/interstellar handover below the split.
    scene.add(mesh);
}

export function updateLargeScaleFlow(dtSim, dtReal, opacity, sunPosition) {
    const blend = largeScaleFlowBlend(cam.dist);
    largeFlowStatus.blend = blend;
    if (!mesh && blend > 0 && opacity > .01) init();
    if (!mesh) return;
    mesh.visible = blend * opacity > .01;
    largeFlowStatus.visible = mesh.visible;
    if (!mesh.visible) return;
    const scale = Math.max(1, camera.position.distanceTo(cam.tgt));
    mesh.position.copy(camera.position); mesh.updateMatrixWorld();
    const now = performance.now();
    if (now-lastSample > 750 || Math.abs(Math.log(scale/Math.max(1,lastScale))) > .15 ||
        lastTarget.distanceTo(cam.tgt) > scale*.1 || dtSim > 1e6*31557600 || lastDarkMatter !== G.darkMatter) {
        cachedGalaxies = galaxyFlowSources(camera, scale, 18, G.darkMatter);
        lastDarkMatter = G.darkMatter;
        lastSample = now; lastScale = scale; lastTarget.copy(cam.tgt);
    }
    const wells = [];
    const add = (x,y,z,mass,core=0,rs=0,virial=0) => {
        if (Number.isFinite(x+y+z+mass) && mass > 0) wells.push({x,y,z,mass,core,rs,virial});
    };
    if (!WORLD.sunDestroyed) add(sunPosition.x,sunPosition.y,sunPosition.z,1);
    for (const star of GRAVITY_STARS) add(star.x*K,(star.z||0)*K,-star.y*K,star.mu/MU_S,(star.R||0)*K);
    const gc = galacticCenterScene();
    const stellarCore = 2600*PC_KM*K;
    add(...gc,6e10,stellarCore);
    if (G.darkMatter) add(...gc,DARK_MATTER.HALO_MASS_SOLAR,DARK_MATTER.SOFTENING_PC*PC_KM*K,
        DARK_MATTER.SCALE_RADIUS_PC*PC_KM*K,DARK_MATTER.VIRIAL_RADIUS_PC*PC_KM*K);
    for (const gal of cachedGalaxies) {
        // M31 uses its existing merger-model total mass with dark matter on.
        // Other catalog galaxies contribute estimated stellar masses only.
        add(gal.x,gal.y,gal.z,gal.mass,gal.core);
    }
    wells.sort((a,b) => b.mass/Math.max(b.core*b.core, (b.x-cam.tgt.x)**2+(b.y-cam.tgt.y)**2+(b.z-cam.tgt.z)**2,1) -
        a.mass/Math.max(a.core*a.core,(a.x-cam.tgt.x)**2+(a.y-cam.tgt.y)**2+(a.z-cam.tgt.z)**2,1));
    wells.length = Math.min(wells.length,MAX_SOURCES);
    const maxForce = Math.max(1e-30,...wells.map(w=>w.mass / Math.max(.04,
        ((w.x-cam.tgt.x)**2+(w.y-cam.tgt.y)**2+(w.z-cam.tgt.z)**2+w.core*w.core)/(scale*scale))));
    let crossing = Infinity;
    for (let i=0;i<wells.length;i++) {
        const w=wells[i];
        sources[i].set((w.x-camera.position.x)/scale,(w.y-camera.position.y)/scale,(w.z-camera.position.z)/scale,w.mass/maxForce);
        shape[i].set(Math.max(.00001,w.core/scale),w.rs/scale,w.virial/scale);
        const r = Math.max(scale,w.core,Math.hypot(w.x-cam.tgt.x,w.y-cam.tgt.y,w.z-cam.tgt.z));
        const rKm = r/K;
        let mass=w.mass;
        if(w.rs>0) {
            const x=Math.min(r,w.virial)/w.rs, c=w.virial/w.rs;
            mass *= (Math.log1p(x)-x/(1+x))/(Math.log1p(c)-c/(1+c));
        }
        crossing=Math.min(crossing,rKm/Math.sqrt(2*MU_S*mass/rKm));
    }
    const rate = dtReal>0 ? Math.abs(dtSim)/dtReal : 0;
    const pulseRate = flowPulseRate(rate,crossing);
    // Pause freezes glyphs. Reverse reverses propagation; never use |G.t|
    // as a shader clock (it loses precision on Gyr jumps).
    uniforms.uPhase.value = (uniforms.uPhase.value + Math.sign(dtSim)*Math.min(dtReal,.1)*pulseRate + 64)%64;
    uniforms.uCount.value=wells.length; uniforms.uScale.value=scale; uniforms.uFar.value=camera.far;
    uniforms.uCenter.value.copy(cam.tgt).sub(camera.position).divideScalar(scale);
    uniforms.uOpacity.value=opacity*blend*.72;
    uniforms.uLength.value=.065+.1*Math.min(1,rate/Math.max(1,crossing));
    Object.assign(largeFlowStatus,{sources:wells.length,galaxies:cachedGalaxies.length,
        haloSources:wells.filter(w=>w.rs>0).length,
        phase:uniforms.uPhase.value,crossingSeconds:crossing,vertices:mesh.geometry.attributes.position.count});
}
