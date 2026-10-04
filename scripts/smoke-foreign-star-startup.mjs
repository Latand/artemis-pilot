// Real production initializer and actual Three renderer traversal/allocators.
// Only the GL attribute upload boundary is a recorder; no browser/GPU claimed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { WebGLGeometries } from 'three/src/renderers/webgl/WebGLGeometries.js';
import { WebGLObjects } from 'three/src/renderers/webgl/WebGLObjects.js';
globalThis.window = {};
const F = await import('../src/render/foreignStarField.js');
const { galaxyWorldKm } = await import('../src/universe/galaxyRegistry.js');
const { makeStarPointMaterial } = await import('../src/render/starPointMaterial.js');

const rendererSource = readFileSync(new URL('../node_modules/three/src/renderers/WebGLRenderer.js', import.meta.url), 'utf8');
const projectSource = rendererSource.slice(rendererSource.indexOf('function projectObject('), rendererSource.indexOf('function renderScene('));
assert(projectSource.includes('if ( object.visible === false ) return;'));
function allocationRecorder() {
  const uploaded = [], submitted = [], info = { memory: { geometries: 0 }, render: { frame: 0 } };
  const attributes = { update: attribute => uploaded.push(attribute), remove() {} };
  const geometries = WebGLGeometries({}, attributes, info, { releaseStatesOfGeometry() {} });
  const objects = WebGLObjects({}, geometries, attributes, info);
  const project = new Function('objects', 'currentRenderList', '_vector3', '_frustum', '_projScreenMatrix', 'currentRenderState',
    projectSource + ';return projectObject;')(objects, { push: object => submitted.push(object) }, new THREE.Vector3(),
    new THREE.Frustum(), new THREE.Matrix4(), { pushLight() {}, pushShadow() {} });
  return { info, uploaded, submitted, render(scene, camera) { info.render.frame++; project(scene, camera, 0, false); } };
}
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
F.initForeignStarField(scene);
const mesh = scene.getObjectByName('persistent Andromeda stars'), geometry = mesh.geometry;
const attributes = Object.values(geometry.attributes), recorder = allocationRecorder();
assert.equal(mesh.visible, false); assert.deepEqual(geometry.drawRange, { start: 0, count: 0 });
recorder.render(scene, camera);
assert.equal(recorder.info.memory.geometries, 0); assert.equal(recorder.uploaded.length, 0);
assert.equal(recorder.submitted.length, 0, 'Desktop pre-frame warmup cannot submit undiscovered stars');
F.updateForeignStarField(camera, [0, 0, 0], 0); recorder.render(scene, camera);
assert.equal(recorder.info.memory.geometries, 0, 'First real Milky Way query still allocates no foreign geometry');

const world = galaxyWorldKm('m31', [10000, 0, 0], 0);
camera.position.set(world[0] * .001, world[2] * .001, -world[1] * .001);
F.updateForeignStarField(camera, world, 0); recorder.render(scene, camera);
assert(mesh.visible && geometry.drawRange.count > 0 && geometry.drawRange.count <= 420);
const ids = F.foreignCameraStars().map(star => star.id);
assert(ids.length > 0); assert.equal(recorder.info.memory.geometries, 1);
assert.equal(recorder.uploaded.length, 5); assert.equal(recorder.uploaded.reduce((sum, a) => sum + a.array.byteLength, 0), 15120);
assert.equal(recorder.submitted[0], mesh, 'The exact discovered foreign object owns the allocation');
F.updateForeignStarField(camera, [0, 0, 0], 0); recorder.render(scene, camera);
assert(!mesh.visible && geometry.drawRange.count === 0);
F.updateForeignStarField(camera, world, 0); recorder.render(scene, camera);
assert.equal(mesh.geometry, geometry); assert.deepEqual(Object.values(geometry.attributes), attributes);
assert.deepEqual(F.foreignCameraStars().map(star => star.id), ids);
assert.equal(recorder.info.memory.geometries, 1, 'Returning/revisiting does not allocate another geometry');

const old = execFileSync('git', ['show', '8663be59ed26cfed38176895527b9aa1d9bdd4ff:src/render/foreignStarField.js'], { encoding: 'utf8' });
const oldInit = old.slice(old.indexOf('export function initForeignStarField('), old.indexOf('export function updateForeignStarField(')).replace('export ', '');
const oldScene = new THREE.Scene();
const oldMesh = new Function('THREE', 'makeStarPointMaterial', 'scene', 'let mesh;' + oldInit + ';initForeignStarField(scene);return mesh;')(THREE, makeStarPointMaterial, oldScene);
assert(oldMesh.visible && oldMesh.geometry.drawRange.count === Infinity);
const control = allocationRecorder(); control.render(oldScene, camera);
assert.equal(control.info.memory.geometries, 1); assert.equal(control.uploaded.length, 5);
assert.equal(control.submitted[0], oldMesh, 'Old startup actually registers/submits the undiscovered foreign object');
console.log('Actual Three traversal/allocator: old startup +1 geometry/15120 bytes; corrected initial MW zero, M31 activation one, stable IDs and allocation on revisit');
