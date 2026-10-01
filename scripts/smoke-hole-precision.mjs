import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { K, LY_SCENE, STARS } from '../src/constants.js';
import { preciseViewPosition } from '../src/render/preciseViewPosition.js';

const zero = new THREE.Vector3();
function orbitCamera(target, distance, yaw, pitch) {
    const offset = new THREE.Vector3(
        distance * Math.cos(pitch) * Math.cos(yaw),
        distance * Math.sin(pitch),
        distance * Math.cos(pitch) * Math.sin(yaw),
    );
    const camera = new THREE.PerspectiveCamera(48, 1.4, 2e-6, 1e20);
    camera.position.copy(target).add(offset);
    camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(offset, zero, camera.up));
    camera.userData.preciseOrbit = {
        target: target.clone(), offset, worldPosition: camera.position.clone(),
    };
    camera.updateMatrixWorld(true);
    return camera;
}

let checked = 0, worstUncorrectedNdc = 0;
for (const name of ['GAIA BH1', 'GAIA BH2', 'GAIA BH3', 'CYGNUS X-1', 'SGR A*']) {
    const star = STARS.find(s => s.name === name);
    assert.ok(star?.bh, `${name} exists in the production catalog`);
    const target = new THREE.Vector3(star.x * K, (star.z || 0) * K, -star.y * K);
    for (const radii of [1.06, 2.7, 8, 45]) for (const yaw of [.7, 1.3, 2.9]) for (const pitch of [.015, .48, 1.42]) {
        const distance = radii * star.rs * K;
        const camera = orbitCamera(target, distance, yaw, pitch);
        const result = preciseViewPosition(target.clone(), camera);
        const tolerance = distance * 2e-14;
        assert.ok(Math.hypot(result.x, result.y) < tolerance, `${name} ${radii}rs lens stays centered`);
        assert.ok(Math.abs(result.z + distance) < tolerance, `${name} ${radii}rs distance stays exact`);
        const old = target.clone().applyMatrix4(camera.matrixWorldInverse);
        worstUncorrectedNdc = Math.max(worstUncorrectedNdc, Math.hypot(old.x, old.y) / Math.abs(old.z) / Math.tan(24 * Math.PI / 180));
        checked++;
    }
}
assert.ok(worstUncorrectedNdc > .05, 'fixture reproduces substantial absolute-coordinate cancellation');

const target = new THREE.Vector3(1e12, -2e12, 3e12);
const camera = orbitCamera(target, .25, .7, .48);
const point = target.clone().add(new THREE.Vector3(100, -50, 200));
function matchesOrdinaryProjection(label) {
    const expected = point.clone().applyMatrix4(camera.matrixWorldInverse);
    assert.deepEqual(preciseViewPosition(point.clone(), camera).toArray(), expected.toArray(), label);
}
const orbit = camera.userData.preciseOrbit;
delete camera.userData.preciseOrbit;
matchesOrdinaryProjection('camera without orbit metadata preserves ordinary projection');
camera.userData.preciseOrbit = orbit;
camera.position.x += 4;
camera.updateMatrixWorld(true);
matchesOrdinaryProjection('camera moved since applyCamera preserves ordinary projection');
camera.position.copy(orbit.worldPosition);
const parent = new THREE.Group();
parent.position.set(10, 20, 30);
parent.add(camera); parent.updateMatrixWorld(true);
matchesOrdinaryProjection('parented camera does not mistake local coordinates for the recorded world position');

// WebXR supplies asymmetric per-eye matrices without keeping fov/aspect in
// sync. Reconstruct rays from the actual projection, including a vast far
// plane, and verify them against the independent near-frustum interpolation.
const eyeCamera = new THREE.PerspectiveCamera(50, 1, .07, 1e20);
const frustum = { left: -.07, right: .12, top: .10, bottom: -.09 };
eyeCamera.projectionMatrix.makePerspective(frustum.left, frustum.right, frustum.top, frustum.bottom, eyeCamera.near, eyeCamera.far);
eyeCamera.projectionMatrixInverse.copy(eyeCamera.projectionMatrix).invert();
const eyeRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.3, -.8, .2));
let asymmetricRays = 0;
for (const scale of [.004, 1, 250, 1e15]) {
    // This mirrors WebXRManager's manually composed eye matrix. The actual
    // per-eye camera has no parent linking it to the application's world rig.
    eyeCamera.matrixWorld.compose(new THREE.Vector3(2, -3, 5), eyeRotation, new THREE.Vector3(scale, scale, scale));
    eyeCamera.matrixWorldInverse.copy(eyeCamera.matrixWorld).invert();
    const rotation = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().extractRotation(eyeCamera.matrixWorld));
    const worldToView = new THREE.Matrix3().setFromMatrix4(eyeCamera.matrixWorldInverse);
    const eye = new THREE.Vector3().setFromMatrixPosition(eyeCamera.matrixWorld);
    for (const x of [-1, -.3, 0, .8, 1]) for (const y of [-1, 0, 1]) {
        const projected = new THREE.Vector4(x, y, 0, 1).applyMatrix4(eyeCamera.projectionMatrixInverse);
        const viewRay = new THREE.Vector3(projected.x, projected.y, projected.z).divideScalar(projected.w).normalize();
        const expected = new THREE.Vector3(
            (frustum.left + (x + 1) * .5 * (frustum.right - frustum.left)) / eyeCamera.near,
            (frustum.bottom + (y + 1) * .5 * (frustum.top - frustum.bottom)) / eyeCamera.near,
            -1,
        ).normalize();
        assert.ok(viewRay.distanceTo(expected) < 1e-14, 'inverse projection matches the asymmetric near-plane ray');
        const worldRay = viewRay.clone().applyMatrix3(rotation).normalize();
        assert.ok(worldRay.distanceTo(expected.applyQuaternion(eyeRotation)) < 1e-14, 'world ray is independent of uniform rig scale');
        const distance = 15 * scale;
        const worldHit = eye.clone().addScaledVector(worldRay, distance);
        const viewHit = worldHit.clone().applyMatrix4(eyeCamera.matrixWorldInverse);
        const depth = -worldRay.clone().applyMatrix3(worldToView).z * distance;
        assert.ok(Math.abs(depth + viewHit.z) < 1e-11, 'analytic hit depth agrees with the rendered world at every rig scale');
        const screen = viewHit.clone().applyMatrix4(eyeCamera.projectionMatrix);
        assert.ok(Math.hypot(screen.x - x, screen.y - y) < 1e-11, 'analytic ray projects back to its original eye pixel');
        asymmetricRays++;
    }
}
const composedWorld = eyeCamera.matrixWorld.clone();
new THREE.Vector3().setFromMatrixPosition(eyeCamera.matrixWorld);
assert.deepEqual(eyeCamera.matrixWorld.elements, composedWorld.elements, 'reading an XR eye translation must not update its manually composed matrix');
eyeCamera.getWorldPosition(new THREE.Vector3());
assert.notDeepEqual(eyeCamera.matrixWorld.elements, composedWorld.elements, 'fixture reproduces getWorldPosition overwriting the XR rig transform');

// An analytic fullscreen primitive does not receive geometric clipping.
// A near-tier projection rounds a far object onto depth=1 in float32 rather
// than producing depth>1, so clip-depth bounds alone cannot prevent a second
// draw of its shadow/emission after the far tier has already rendered it.
const tierNear = .02, tierFar = LY_SCENE * .02, outsideZ = Math.fround(tierFar * 10);
const tierProjection = new THREE.PerspectiveCamera(48, 1, tierNear, tierFar).projectionMatrix.elements;
const clipZ = Math.fround(Math.fround(-Math.fround(tierProjection[10]) * outsideZ) + Math.fround(tierProjection[14]));
const clipW = Math.fround(-Math.fround(tierProjection[11]) * outsideZ + Math.fround(tierProjection[15]));
const roundedDepth = Math.fround(.5 * (Math.fround(clipZ / clipW) + 1));
assert.equal(roundedDepth, 1, 'fixture reproduces a beyond-tier hit passing normalized clip-depth bounds');
assert.ok(outsideZ > tierFar, 'explicit view-depth tier fence rejects that same hit');

const lensingSource = readFileSync(new URL('../src/lensing.js', import.meta.url), 'utf8');
assert.ok(lensingSource.includes('preciseViewPosition(_v.set(wx, wy, wz), camera)'), 'production lens selection uses the tested projection');
const holeSource = readFileSync(new URL('../src/holeOptics.js', import.meta.url), 'utf8');
assert.ok(holeSource.includes('uInverseProjection * vec4(vScreen,0.0,1.0)'), 'production optics uses inverse projection rather than fov/aspect');
assert.ok(holeSource.includes('eye.setFromMatrixPosition(camera.matrixWorld)'), 'production optics preserves the composed per-eye rig transform');
assert.ok(holeSource.includes('dot(uViewDepth,ray)'), 'production hit depth accounts for the inverse camera scale');
assert.ok(holeSource.includes('if (z < uNear || z > uFar) discard;'), 'production optics explicitly fences each view-depth tier');
console.log(`Hole lens precision: ${checked} named close-orbit cases, ${asymmetricRays} asymmetric/scaled-eye rays, and ordinary/moved/parented camera fallbacks passed`);
