import assert from 'node:assert/strict';
import * as THREE from 'three';
import { beginRingSamplingDepth, trackRingSamplingMaterial, ringSamplingUniforms as u, bodyUvBounds } from '../src/render/ringSamplingDepth.js';

const camera = new THREE.PerspectiveCamera(48, 1.5, .02, 1e5);
const geometry = new THREE.RingGeometry(74.5, 140.2, 64);
const map = new THREE.Texture();
const material = trackRingSamplingMaterial(new THREE.MeshLambertMaterial({ map, transparent: true, depthWrite: false, opacity: .7 }),58.232);
const renderer = { getDrawingBufferSize: out=>out.set(960,640) };
const mesh = new THREE.Mesh(geometry, material);
// Exercise real material callback order and the matrix the renderer uses,
// including rotation, nonuniform scaling, and affine tidal deformation.
for (const affine of [new THREE.Matrix4(), new THREE.Matrix4().set(1.4,.2,.1,0,.2,.8,.1,0,.1,.1,1.1,0,0,0,0,1)]) {
    beginRingSamplingDepth(camera);
    mesh.modelViewMatrix.makeRotationX(.47).premultiply(affine);
    mesh.modelViewMatrix.setPosition(23, -19, -600);
    material.onBeforeRender(renderer, null, camera, geometry, mesh, null);
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
    const bounds=u.uRingBodyBounds.value;
    for(let i=0;i<200;i++){
        const y=1-2*(i+.5)/200,angle=i*2.3999632297,r=Math.sqrt(1-y*y);
        const point=new THREE.Vector3(r*Math.cos(angle),y,r*Math.sin(angle)).multiplyScalar(58.232)
            .applyMatrix4(mesh.modelViewMatrix).applyMatrix4(camera.projectionMatrix);
        const x=point.x*.5+.5,vy=point.y*.5+.5;
        assert(x>=bounds.x&&x<=bounds.z&&vy>=bounds.y&&vy<=bounds.w,'post-affine sphere is inside bounded sampling region');
    }
    assert((bounds.z-bounds.x)*(bounds.w-bounds.y)<.2,'unrelated sky is excluded before neighbour reads');
}
assert.equal(material.depthWrite, false, 'sampling proxy never becomes opaque');
assert.equal(material.transparent, true, 'normal ring blending is retained');
assert.equal(material.opacity, .7);
beginRingSamplingDepth(camera);
camera.near = 1e4;
material.onBeforeRender(renderer,null,camera,geometry,mesh,null);
assert.equal(u.uRingPresent.value,0,'far-tier draw cannot publish a near sampling proxy');
camera.near = .02;
material.onBeforeRender(renderer,null,camera,geometry,mesh,null);
assert.equal(u.uRingPresent.value,1);
beginRingSamplingDepth();
material.onBeforeRender(renderer,null,camera,geometry,mesh,null);
assert.equal(u.uRingPresent.value,0,'hidden/disabled/new frames cannot retain an old proxy');
console.log('Transparent ring sampling transform, tier, reset, and material invariants passed');
