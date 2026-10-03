import assert from 'node:assert/strict';
import * as THREE from 'three';
import { beginRingSamplingDepth, trackRingSamplingMaterial, ringSamplingUniforms as u } from '../src/render/ringSamplingDepth.js';

const camera = new THREE.PerspectiveCamera(48, 1.5, .02, 1e5);
const geometry = new THREE.RingGeometry(74.5, 140.2, 64);
const map = new THREE.Texture();
const material = trackRingSamplingMaterial(new THREE.MeshLambertMaterial({ map, transparent: true, depthWrite: false, opacity: .7 }));
const mesh = new THREE.Mesh(geometry, material);
// Exercise real material callback order and the matrix the renderer uses,
// including rotation, nonuniform scaling, and affine tidal deformation.
for (const affine of [new THREE.Matrix4(), new THREE.Matrix4().set(1.4,.2,.1,0,.2,.8,.1,0,.1,.1,1.1,0,0,0,0,1)]) {
    beginRingSamplingDepth(camera);
    mesh.modelViewMatrix.makeRotationX(.47).premultiply(affine);
    mesh.modelViewMatrix.setPosition(23, -19, -600);
    material.onBeforeRender(null, null, camera, geometry, mesh, null);
    assert.equal(u.uRingPresent.value, 1);
    for (const angle of [0,.7,2,4,5.7]) {
        const point = new THREE.Vector3(100*Math.cos(angle), 100*Math.sin(angle), 0).applyMatrix4(mesh.modelViewMatrix);
        const ray = point.clone().multiplyScalar(-1/point.z);
        const origin = new THREE.Vector3().applyMatrix4(u.uViewToRing.value);
        const direction = ray.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(u.uViewToRing.value));
        const t = -origin.z/direction.z;
        const local = origin.clone().addScaledVector(direction,t);
        assert(Math.abs(t+point.z)<1e-9);
        assert(Math.abs(Math.hypot(local.x,local.y)-100)<1e-9);
    }
}
assert.equal(material.depthWrite, false, 'sampling proxy never becomes opaque');
assert.equal(material.transparent, true, 'normal ring blending is retained');
assert.equal(material.opacity, .7);
beginRingSamplingDepth(camera);
camera.near = 1e4;
material.onBeforeRender(null,null,camera,geometry,mesh,null);
assert.equal(u.uRingPresent.value,0,'far-tier draw cannot publish a near sampling proxy');
camera.near = .02;
material.onBeforeRender(null,null,camera,geometry,mesh,null);
assert.equal(u.uRingPresent.value,1);
beginRingSamplingDepth();
material.onBeforeRender(null,null,camera,geometry,mesh,null);
assert.equal(u.uRingPresent.value,0,'hidden/disabled/new frames cannot retain an old proxy');
console.log('Transparent ring sampling transform, tier, reset, and material invariants passed');

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const baseline='531da641fe5d61b4cdc7130285418c218299d263';
for(const path of ['src/lensing.js','src/holeOptics.js','src/render/ringSamplingDepth.js']){
 const expected=execFileSync('git',['show',baseline+':'+path],{encoding:'utf8'});
 assert.equal(readFileSync(new URL('../'+path,import.meta.url),'utf8'),expected,'partial optical production stays on the reviewed disk/ring source: '+path);
}
// Planet appearance is shared with surface-rotation work. Pin only this
// optical factory, not unrelated Earth/cloud/surface presentation functions.
function ringFactory(text){const start=text.indexOf('export function ringMaterial(');assert(start>=0);let i=text.indexOf('{',start),depth=1,end=i+1;for(;depth;end++){if(text[end]==='{')depth++;if(text[end]==='}')depth--;}return text.slice(start,end);}
assert.equal(ringFactory(readFileSync(new URL('../src/render/planetAppearance.js',import.meta.url),'utf8')),
 ringFactory(execFileSync('git',['show',baseline+':src/render/planetAppearance.js'],{encoding:'utf8'})));
const probe=readFileSync(new URL('./probe-optics-partial-release.mjs',import.meta.url),'utf8');
assert(probe.includes('silhouetteEdgeRepair:false,issue49RemainsOpen:true'));
for(const gate of ["assert.equal(result.metrics.opaqueChanged,0",'Math.max(...outer)*1.25','Math.min(...outer)*.75','Math.max(...outer)*.2','same compositor/target with lens mapping versus identity'])assert(probe.includes(gate),'same-target occlusion and every disk-crossing bound are retained');
assert(probe.includes('syncHoleScene()'),'paused physical/visual hole positions stay synchronized');
assert(probe.includes('gl.readPixels')&&probe.includes("toDataURL('image/png')"),'capture and pixel read remain in the same synchronous draw task');
const unresolved=readFileSync(new URL('./optics-deferred-edge-fixture.mjs',import.meta.url),'utf8');
assert(unresolved.includes('samples[0].detached>0&&same'),'residual edge artifact remains an explicit known-failing feature');
console.log('Partial-release source identity, unchanged disk/opaque gates and open edge limitation verified');
