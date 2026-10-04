import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { foreignStarById } from '../src/universe/foreignStars.js';
import { generateSystem } from '../src/universe/planetarySystem.js';
import { systemAnchor } from '../src/render/systemPrecision.js';
import { moveExplorationTarget } from '../src/universe/explorationCamera.js';
import { observerPositionRelativeTo, stabilizeBodyMaterial } from '../src/render/relativeBodyFrame.js';
import { CAM_DIST_MAX, LY_SCENE } from '../src/constants.js';
import { FOREIGN_RIVER_HOST, residualTolerance, healthyForeignObserver, healthyForeignFrame, foreignMovementPreserved, sameForeignSystem, healthyForeignAdvection, collectForeignBodyDraw } from './foreign-river-qa.mjs';

const source = readFileSync(new URL('../src/scene.js', import.meta.url), 'utf8');
const applySource = source.slice(source.indexOf('export function applyCamera() {'), source.indexOf('const ptrs = new Map();')).replace('export ', '');
assert(applySource.includes('camera.userData.systemAnchor = cam.preciseTarget || null;'));
const oldRiver = execFileSync('git', ['show', '8663be59ed26cfed38176895527b9aa1d9bdd4ff:src/river.js'], { encoding: 'utf8' });
const oldPublish = oldRiver.split('\n').find(line => line.includes('uniformsShared.uCam.value.set(camera.position.x'));
assert(oldPublish);
const oldUniform = new Function('uniformsShared', 'camera', 'smoothCenter', oldPublish);
let cases = 0, oldFailures = 0;
for (const time of [0, 1e8, -1e8, 0]) for (let angle = 0; angle < 12; angle++) {
  const star = foreignStarById(FOREIGN_RIVER_HOST, time), system = generateSystem(star); system.hostStar = star;
  const physical = [star.x, star.y, star.z, star.mu, star.R];
  const anchor = systemAnchor(system, 0, null, time);
  const cam = { preciseTarget: anchor, tgt: anchor.origin.clone().add(anchor.offset),
    dist: system.planets[0].radiusKm * .003, yaw: angle / 12 * 2 * Math.PI, pitch: .46 };
  const camera = new THREE.PerspectiveCamera(48, 1100 / 760, .02, 1e26);
  const orbit = { target: new THREE.Vector3(), offset: new THREE.Vector3(), worldPosition: new THREE.Vector3() };
  const applyCamera = new Function('cam', 'camera', 'preciseOrbit', 'orbitRotation', 'orbitZero', 'applyCameraRoll', applySource + ';return applyCamera;')(
    cam, camera, orbit, new THREE.Matrix4(), new THREE.Vector3(), () => {});
  const center = cam.tgt.clone(), object = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.ShaderMaterial());
  object.position.copy(center); object.updateMatrixWorld();
  let previousCalls = 0; object.material.onBeforeRender = () => previousCalls++;
  stabilizeBodyMaterial(object.material);
  const read = () => {
    applyCamera(); camera.updateMatrixWorld();
    const uCam = observerPositionRelativeTo(camera, center, new THREE.Vector3());
    const expected = anchor.origin.clone().sub(center).add(anchor.offset).add(orbit.offset);
    const expectedView = expected.clone().negate().applyQuaternion(camera.quaternion.clone().invert());
    object.modelViewMatrix.multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld);
    const oldTranslation = object.modelViewMatrix.elements.slice(12, 15);
    object.material.onBeforeRender(null, null, camera, object.geometry, object, null);
    const translation = object.modelViewMatrix.elements.slice(12, 15);
    const p = { expectedCamera: expected.toArray(), expectedTranslation: expectedView.toArray(),
      cameraUniform: uCam.toArray(), modelViewTranslation: translation,
      gpuCamera: uCam.toArray().map(Math.fround), gpuTranslation: translation.map(Math.fround),
      arithmeticScale: [...anchor.offset.toArray(), ...orbit.offset.toArray(), ...anchor.origin.clone().sub(center).toArray()] };
    const old = { uCam: { value: new THREE.Vector3() } }; oldUniform(old, camera, center);
    const control = { precision: { ...p, cameraUniform: old.uCam.value.toArray(), modelViewTranslation: oldTranslation } };
    assert(healthyForeignObserver({ precision: p }));
    if (!healthyForeignObserver(control)) oldFailures++;
    return { precision: p, broad: camera.position.toArray() };
  };
  const before = read(), delta = cam.dist * .65 / 30;
  moveExplorationTarget(cam, new THREE.Vector3(1, 0, 0), delta);
  const after = read(); assert(foreignMovementPreserved(before, after));
  assert(Math.abs(after.precision.cameraUniform[0] - before.precision.cameraUniform[0] - delta) < residualTolerance(anchor.offset.toArray()));
  assert.equal(previousCalls, 2, 'Existing draw callbacks run exactly once per draw');
  assert.deepEqual([star.x, star.y, star.z, star.mu, star.R], physical, 'Render precision does not mutate physical sources');
  delete camera.userData.systemAnchor;
  assert.deepEqual(observerPositionRelativeTo(camera, center, new THREE.Vector3()).toArray(), camera.position.clone().sub(center).toArray(), 'Ordinary view fallback is exact');
  camera.userData.systemAnchor = anchor; camera.position.x += 32;
  assert.deepEqual(observerPositionRelativeTo(camera, center, new THREE.Vector3()).toArray(), camera.position.clone().sub(center).toArray(), 'Stale split metadata falls back exactly');
  object.geometry.dispose(); object.material.dispose(); cases++;
}
assert.equal(oldFailures, 2 * cases, 'The actual previous river code fails every before/after precision sample');
const river = readFileSync(new URL('../src/river.js', import.meta.url), 'utf8');
for (const target of ['lineMat', 'dots.material', 'warpLines.material', 'obj.material']) assert(river.includes(`stabilizeBodyMaterial(${target});`));
assert(river.includes('observerPositionRelativeTo(camera, smoothCenter, uniformsShared.uCam.value);'));
assert(river.includes('observerPositionRelativeTo(camera, cam.tgt, riverObserverRelative).length()'));
for (const name of ['FLOW_GLSL', 'COMPUTE_FRAG']) {
  const pattern = new RegExp('const ' + name + ' = /\\* glsl \\*/`([\\s\\S]*?)`;');
  assert.equal(river.match(pattern)?.[1], oldRiver.match(pattern)?.[1], name + ' remains byte-identical');
}
console.log(`${cases} real M31 planet/epoch/angle cases pass, with ${oldFailures} old-code precision failures; ordinary/stale fallbacks and source/compute invariants pass`);

const validFrame = { time: 0, contextLost: false, glError: 0, readError: 0, finite: true, invalidOwners: 0,
  count: 15376, drawCount: 15376, drawnCount: 15376, drawVisible: true, ambient: 0, drawnAmbient: 0, center: [1, 2, 3],
  sources: [{ name: FOREIGN_RIVER_HOST, activeSource: true, currentActive: true, sourceTime: 0, owners: 15376, drawnOwners: 15376,
    world: [2, 3, 4], field: [2, 3, 4], residual: [1, 1, 1] }],
  precision: { expectedCamera: [6.25, 6.5, -8.25], expectedTranslation: [0, 0, -12], cameraUniform: [6.25, 6.5, -8.25],
    modelViewTranslation: [0, 0, -12], gpuCamera: [6.25, 6.5, -8.25], gpuTranslation: [0, 0, -12], arithmeticScale: [8000, 12] },
  bodyPrecision: { visible: true, drawnThisFrame: true, expectedTranslation: [0, 0, -12], modelViewTranslation: [0, 0, -12],
    gpuTranslation: [0, 0, -12], arithmeticScale: [8000, 12] } };
assert(healthyForeignFrame(validFrame, false));
let negatives = 0;
for (const mutate of [
  f => f.sources[0].name = 'not-the-foreign-host', f => f.sources[0].currentActive = false,
  f => f.sources[0].sourceTime = -1, f => f.sources[0].drawnOwners = 0, f => f.sources[0].owners = 0,
  f => f.sources[0].field[0]++, f => f.sources[0].residual[0]++, f => f.finite = false,
  f => f.invalidOwners = 1, f => f.contextLost = true, f => f.readError = 1282, f => f.drawVisible = false,
  f => f.count = 4096, f => f.precision.cameraUniform[0] += .25, f => f.precision.modelViewTranslation[0] += .25,
  f => f.precision.gpuCamera[0] += .25, f => f.precision.gpuTranslation[0] += .25,
  f => f.bodyPrecision.visible = false, f => f.bodyPrecision.drawnThisFrame = false, f => f.bodyPrecision.modelViewTranslation[0] += .25,
  f => f.bodyPrecision.gpuTranslation[0] += .25,
]) { const bad = structuredClone(validFrame); mutate(bad); assert(!healthyForeignFrame(bad, false)); negatives++; }
console.log(`${negatives} foreign-source, full-buffer, stale-clock, GPU/model-view and body-alignment negative controls passed`);

const parameters = JSON.stringify([{ index: 0, radiusKm: 4054, moons: [] }]);
const original = { system: { cachedStarId: 'proc:' + FOREIGN_RIVER_HOST, renderedStarId: 'proc:' + FOREIGN_RIVER_HOST,
  renderedHostId: FOREIGN_RIVER_HOST, cachedPlanets: parameters, renderedPlanets: parameters, slotPlanets: parameters } };
assert(sameForeignSystem(original, original));
// Replacing the live cache/renderer must fail even if the original setup
// object still exists with unchanged fields.
for (const mutate of [s => s.cachedStarId = 'proc:other', s => s.renderedStarId = 'proc:other', s => s.renderedHostId = 'other',
  s => s.cachedPlanets = '[]', s => s.renderedPlanets = '[]', s => s.slotPlanets = '[]']) {
  const replacement = structuredClone(original); mutate(replacement.system); assert(!sameForeignSystem(replacement, original));
}
for (const direction of [1, -1]) {
  const phase = [{ dtVis: 3 * direction, dispatch: null }, { dtVis: 3 * direction, dispatch: { dt: 6 * direction } }];
  assert(healthyForeignAdvection(phase, direction));
  for (const mutate of [p => p[1].dispatch.dt *= -1, p => p[0].dtVis *= -1,
    p => p[1].dispatch = null, p => p[1].dispatch.dt = 0]) {
    const wrong = structuredClone(phase); mutate(wrong); assert(!healthyForeignAdvection(wrong, direction));
  }
}
console.log('Live cache/renderer/slot replacement and wrong-sign/vacuous advection negatives pass');

// Actual e90481cd desktop/mobile host-0 capture: a global near-tier far plane
// puts this correctly centered sphere 3.346e9 scene units outside the frustum.
const capturedStar = foreignStarById(FOREIGN_RIVER_HOST, 0), radius = capturedStar.R * .001;
const origin = new THREE.Vector3(capturedStar.x * .001, capturedStar.z * .001, -capturedStar.y * .001);
const eye = new THREE.PerspectiveCamera(48, 1100 / 760, .02, CAM_DIST_MAX * 1.35);
const eyeOffset = new THREE.Vector3(Math.cos(.46) * Math.cos(-.95), Math.sin(.46), Math.cos(.46) * Math.sin(-.95)).multiplyScalar(radius * 4);
eye.position.copy(origin).add(eyeOffset); eye.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(eyeOffset, new THREE.Vector3(), eye.up)); eye.updateMatrixWorld();
eye.userData.systemAnchor = { origin, offset: new THREE.Vector3() };
eye.userData.preciseOrbit = { worldPosition: eye.position.clone(), offset: eyeOffset };
const photo = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 48), stabilizeBodyMaterial(new THREE.MeshBasicMaterial()));
photo.position.copy(origin); photo.updateMatrixWorld();
const frustum = new THREE.Frustum();
for (const [near, far] of [[.02, LY_SCENE * .02], [LY_SCENE * .02, CAM_DIST_MAX * 1.35]]) {
  eye.near = near; eye.far = far; eye.updateProjectionMatrix();
  frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(eye.projectionMatrix, eye.matrixWorldInverse));
  assert.equal(frustum.intersectsObject(photo), false, 'The actual captured host was rejected in both uncorrected CPU tier tests');
}
const starSource = readFileSync(new URL('../src/stars.js', import.meta.url), 'utf8');
const rule = starSource.split('\n').find(line => line.trim() === 'photosphere.frustumCulled = !star.galaxyId;'); assert(rule);
const applyRule = new Function('photosphere', 'star', rule); applyRule(photo, capturedStar);
assert.equal(photo.frustumCulled, false);
photo.material.onBeforeRender(null, null, eye, photo.geometry, photo, null);
assert(Math.abs(photo.modelViewMatrix.elements[14] + radius * 4) < residualTolerance(eyeOffset.toArray()));
assert(photo.modelViewMatrix.elements[14] + radius < 0, 'All of the intended near-pass sphere is in front of the observer');
eye.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)); eye.updateMatrixWorld();
photo.material.onBeforeRender(null, null, eye, photo.geometry, photo, null);
assert(photo.modelViewMatrix.elements[14] - radius > 0, 'Behind-camera sphere has negative clip w for every vertex and remains GPU-clipped');
const parent = new THREE.Group(), testScene = new THREE.Scene(); parent.add(photo); testScene.add(parent); parent.visible = false;
let visited = false; testScene.traverseVisible(object => { if (object === photo) visited = true; }); assert(!visited, 'Existing visibility still removes hidden surfaces');
applyRule(photo, { ...capturedStar, galaxyId: undefined }); assert.equal(photo.frustumCulled, true, 'Ordinary MW photospheres retain CPU frustum culling');
assert(starSource.includes('const ACTIVE_VISUAL_MAX = 48;'));
photo.geometry.dispose(); photo.material.dispose();
const nearZero = structuredClone(validFrame);
nearZero.precision.expectedTranslation = [2.1316282072803006e-14, 2.842170943040401e-14, -1213.468838920708];
nearZero.precision.modelViewTranslation = [0, 5.684341886080802e-14, -1213.468838920708];
nearZero.precision.gpuTranslation = nearZero.precision.modelViewTranslation.map(Math.fround);
nearZero.precision.arithmeticScale = [632.4825112639269, 538.7171939004957, -884.4525317804363];
assert(healthyForeignObserver(nearZero), 'Independent double rotation roundoff is included before float32 upload rounding');
nearZero.precision.gpuTranslation[0] = residualTolerance(nearZero.precision.arithmeticScale) * 2;
assert(!healthyForeignObserver(nearZero), 'A near-zero mutation beyond the derived arithmetic bound still fails');
console.log('Captured photosphere culling, hidden/behind-camera/MW rules, actual-draw and derived-roundoff negatives pass');

const drawGeometry = new THREE.SphereGeometry(1, 16, 8), drawMaterial = new THREE.MeshBasicMaterial(), drawObject = new THREE.Mesh(drawGeometry, drawMaterial);
const drawCamera = new THREE.PerspectiveCamera();
const fakeRenderer = { getContext: () => ({ getUniformLocation: () => ({}), getUniform: () => new Float32Array(drawObject.modelViewMatrix.elements) }),
  properties: { get: () => ({ currentProgram: { program: {} } }) } };
const collect = group => collectForeignBodyDraw(drawObject, fakeRenderer, drawCamera, drawGeometry, drawMaterial, group, 1);
assert(collect(null).submission.triangles > 0);
drawGeometry.setDrawRange(0, 0);
const emptyDraw = collect(null); assert.equal(emptyDraw.submission.triangles, 0, 'Actual collector rejects onAfterRender with an empty draw');
const phantom = structuredClone(validFrame); phantom.bodyPrecision.drawnThisFrame = emptyDraw.submission.triangles > 0;
assert(!healthyForeignFrame(phantom, false), 'Healthy river pixels/uniforms cannot certify an empty photosphere draw');
drawGeometry.setDrawRange(0, Infinity);
assert.equal(collect({ start: 0, count: 0 }).submission.triangles, 0);
assert.equal(collect({ start: drawGeometry.index.count, count: 3 }).submission.triangles, 0);
drawGeometry.setDrawRange(0, 2); assert.equal(collect(null).submission.triangles, 0, 'Incomplete triangle is not a rendered body');
drawGeometry.setDrawRange(0, Infinity); drawObject.isInstancedMesh = true; drawObject.count = 0;
assert.equal(collect(null).submission.triangles, 0);
drawObject.count = 2; assert.equal(collect(null).submission.instances, 2);
delete drawObject.isInstancedMesh; drawGeometry.setIndex(null); assert(collect(null).submission.triangles > 0);
drawGeometry.dispose(); drawMaterial.dispose();
console.log('Real body collector rejects empty indexed/group/instance draws and incomplete triangles');
