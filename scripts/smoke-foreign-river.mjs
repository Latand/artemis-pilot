import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as THREE from 'three';
import { foreignStarById } from '../src/universe/foreignStars.js';
import { generateSystem } from '../src/universe/planetarySystem.js';
import { systemAnchor } from '../src/render/systemPrecision.js';
import { moveExplorationTarget } from '../src/universe/explorationCamera.js';
import { observerPositionRelativeTo, stabilizeBodyMaterial } from '../src/render/relativeBodyFrame.js';
import { FOREIGN_RIVER_HOST, residualTolerance, healthyForeignObserver, healthyForeignFrame, foreignMovementPreserved, sameForeignSystem, healthyForeignAdvection } from './foreign-river-qa.mjs';

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
  bodyPrecision: { visible: true, expectedTranslation: [0, 0, -12], modelViewTranslation: [0, 0, -12], arithmeticScale: [8000, 12] } };
assert(healthyForeignFrame(validFrame, false));
let negatives = 0;
for (const mutate of [
  f => f.sources[0].name = 'not-the-foreign-host', f => f.sources[0].currentActive = false,
  f => f.sources[0].sourceTime = -1, f => f.sources[0].drawnOwners = 0, f => f.sources[0].owners = 0,
  f => f.sources[0].field[0]++, f => f.sources[0].residual[0]++, f => f.finite = false,
  f => f.invalidOwners = 1, f => f.contextLost = true, f => f.readError = 1282, f => f.drawVisible = false,
  f => f.count = 4096, f => f.precision.cameraUniform[0] += .25, f => f.precision.modelViewTranslation[0] += .25,
  f => f.precision.gpuCamera[0] += .25, f => f.precision.gpuTranslation[0] += .25,
  f => f.bodyPrecision.visible = false, f => f.bodyPrecision.modelViewTranslation[0] += .25,
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
