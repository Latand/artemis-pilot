import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createCloudDepthGuard, registerEarthCloudGround, CLOUD_DEPTH_GUARD_MAX_ITEMS } from '../src/render/cloudDepthGuard.js';
import { createEarthCloudMaterial } from '../src/render/planetAppearance.js';
import { relUniforms } from '../src/relView.js';
import { applyTerrellToMaterial } from '../src/relView.js';
import { bodyBoundsHooksSafe } from '../src/render/bodyBoundsHooks.js';
import { stabilizeBodyMaterial } from '../src/render/relativeBodyFrame.js';
import { photosphereMaterial } from '../src/render/planetAppearance.js';
import { createBodySurfaceMaterial } from '../src/render/bodySurfaceMaterial.js';
import { getBodyAppearance } from '../src/render/bodyAppearanceProfiles.js';
const BH = { n: 0 }; // Inject the same live-count contract used by bodies.js.
const material = new THREE.MeshBasicMaterial(), base = new THREE.Vector3(123456, 2345, -78901);
const mesh = (radius, name) => {
    const object = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), material);
    object.name = name; object.geometry.computeBoundingSphere(); object.position.copy(base); object.updateMatrixWorld(); return object;
};
const earth = mesh(6.371, 'Earth'), cloud = mesh(6.377, 'Earth clouds');
const ship = mesh(.004, 'Ship hull'), moon = mesh(1.737, 'Moon'), placed = mesh(.03, 'Placed opaque body');
const camera = new THREE.PerspectiveCamera(50, 1, .02, 1e9);
const item = object => ({ object, geometry: object.geometry, material: object.material });
const lists = objects => ({ opaque: [item(earth), ...objects.map(item)], transmissive: [], transparent: [item(cloud)] });
const setEye = distance => { camera.position.copy(base).add(new THREE.Vector3(0, 0, distance)); camera.lookAt(base); camera.updateMatrixWorld(); };
const setPosition = (object, x, y, z) => { object.position.copy(base).add(new THREE.Vector3(x, y, z)); object.updateMatrixWorld(); };
const guard = createCloudDepthGuard();
let contacts = 0;
for (const distance of [6.5, 8, 15, 25, 60, 200, 1000]) {
    setEye(distance);
    assert(guard.evaluate(camera, cloud, earth, lists([])), 'clear footprint enables the bounded raster aid');
    for (const gapKm of [1, 3, 6, 10, 25, 50, 100, 250, 500, 1000, 10000]) {
        if (6.377 + gapKm * .001 >= distance) continue;
        setPosition(ship, 0, 0, 6.377 + gapKm * .001);
        assert.equal(guard.evaluate(camera, cloud, earth, lists([ship])), false, 'even nearly contacting foreground ship bounds disable bias');
        assert.equal(guard.state.reason, 'foreground-overlap'); contacts++;
    }
    const tangentX = 6.377 * Math.sqrt(1 - (6.377 / distance) ** 2), tangentZ = 6.377 ** 2 / distance;
    for (const delta of [-.02, -.003, 0, .003, .02]) {
        setPosition(placed, tangentX, 0, tangentZ + delta);
        assert.equal(guard.evaluate(camera, cloud, earth, lists([placed])), false, 'limb-intersecting placed-body bounds disable bias'); contacts++;
    }
    setPosition(moon, 100, 0, 0);
    assert(guard.evaluate(camera, cloud, earth, lists([moon])), 'off-footprint Moon does not disable the aid');
    setPosition(moon, 0, 0, -30);
    assert(guard.evaluate(camera, cloud, earth, lists([moon])), 'fully rearward Moon cannot be overwritten by the front cloud shell');
    setPosition(placed, 0, 0, 0);
    assert(guard.evaluate(camera, cloud, earth, lists([placed])), 'geometry wholly inside the enclosing ground sphere is not foreground');
}
setEye(60); setPosition(ship, 0, 0, 6.4);
assert.equal(guard.evaluate(camera, cloud, earth, lists([ship]), .001), false, 'relativistic projection falls back conservatively');
const instanced = new THREE.InstancedMesh(ship.geometry, material, 2);
instanced.name = 'Instanced placed bodies'; instanced.position.copy(base);
instanced.setMatrixAt(0, new THREE.Matrix4().makeTranslation(100, 0, 0));
instanced.setMatrixAt(1, new THREE.Matrix4().makeTranslation(0, 0, 6.4));
instanced.computeBoundingSphere(); instanced.updateMatrixWorld();
assert.equal(guard.evaluate(camera, cloud, earth, lists([instanced])), false, 'possibly stale aggregate instance bounds fail closed');
assert.equal(guard.state.reason, 'unknown-deformation');
const skinned = new THREE.SkinnedMesh(ship.geometry, material); skinned.position.copy(base);
skinned.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 6.4), .004); skinned.updateMatrixWorld();
assert.equal(guard.evaluate(camera, cloud, earth, lists([skinned])), false, 'possibly stale skinned bounds fail closed');
skinned.boundingSphere = null;
assert.equal(guard.evaluate(camera, cloud, earth, lists([skinned])), false, 'missing deformed bounds never use a small source-mesh substitute');
assert.equal(guard.state.reason, 'unknown-deformation');
const huge = lists(Array(CLOUD_DEPTH_GUARD_MAX_ITEMS).fill(ship));
assert.equal(guard.evaluate(camera, cloud, earth, huge), false, 'draw-list budget is a safe fallback, not a partial scan');
assert.equal(guard.state.checked, 0);
assert.equal(guard.evaluate(camera, cloud, earth, null), false);
const absentCloud = lists([]); absentCloud.transparent = [];
assert.equal(guard.evaluate(camera, cloud, earth, absentCloud), false, 'a stale or foreign render list cannot authorize bias');
const dynamic = mesh(.01, 'Unknown dynamic object'); setPosition(dynamic, 100, 0, 0);
dynamic.geometry.attributes.position.needsUpdate = true;
assert.equal(guard.evaluate(camera, cloud, earth, lists([dynamic])), false, 'changed vertex data cannot reuse potentially stale bounds');
dynamic.geometry.dispose();
const custom = mesh(.01, 'Custom draw transform'); custom.onBeforeRender = () => {};
assert.equal(guard.evaluate(camera, cloud, earth, lists([custom])), false, 'unknown draw callbacks fail closed');
custom.onBeforeRender = THREE.Object3D.prototype.onBeforeRender;
custom.material = new THREE.ShaderMaterial();
assert.equal(guard.evaluate(camera, cloud, earth, lists([custom])), false, 'unknown shader geometry fails closed');
custom.material.dispose(); custom.material = new THREE.MeshBasicMaterial({ polygonOffset: true });
assert.equal(guard.evaluate(camera, cloud, earth, lists([custom])), false, 'other raster-depth policies are not interpreted as physical bounds');
custom.material.dispose(); custom.geometry.dispose();
const shifted = mesh(.004, 'Off-footprint shader-shifted foreground');
setPosition(shifted, 100, 0, 6.4); shifted.frustumCulled = false;
shifted.material = new THREE.MeshBasicMaterial();
shifted.material.onBeforeCompile = shader => { shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.x -= 100.0;'); };
assert.equal(guard.evaluate(camera, cloud, earth, lists([shifted])), false, 'a built-in material can move a supposedly off-footprint sphere into the foreground');
assert.equal(guard.state.reason, 'unknown-material-hook');
applyTerrellToMaterial(shifted.material);
assert.equal(bodyBoundsHooksSafe(shifted.material), false, 'Terrell wrapping never blesses an unsafe previous compiler hook');
assert.equal(guard.evaluate(camera, cloud, earth, lists([shifted])), false);
shifted.material.dispose(); shifted.material = new THREE.MeshBasicMaterial();
shifted.material.onBeforeCompile = shader => { shader.fragmentShader = shader.fragmentShader.replace('void main() {', 'void main() { gl_FragDepth = 0.0;'); };
assert.equal(guard.evaluate(camera, cloud, earth, lists([shifted])), false, 'custom fragment-depth hooks fail closed');
shifted.material.dispose(); shifted.material = new THREE.MeshBasicMaterial();
shifted.material.onBeforeRender = () => { shifted.modelViewMatrix.elements[12] -= 100; };
stabilizeBodyMaterial(shifted.material);
assert.equal(bodyBoundsHooksSafe(shifted.material), false, 'precision wrapping never blesses an unsafe previous draw hook');
assert.equal(guard.evaluate(camera, cloud, earth, lists([shifted])), false, 'unknown material draw transforms fail closed');
shifted.material.dispose();
for (const known of [new THREE.MeshBasicMaterial(), createBodySurfaceMaterial(getBodyAppearance('MOON')), photosphereMaterial(0xffffff)]) {
    applyTerrellToMaterial(known);
    assert(bodyBoundsHooksSafe(known), 'audited built-in, surface, photosphere, precision and beta-zero Terrell hooks remain recognized');
    shifted.material = known;
    assert(guard.evaluate(camera, cloud, earth, lists([shifted])), 'recognized off-footprint material does not disable the aid');
    known.onBeforeCompile = () => {};
    assert.equal(bodyBoundsHooksSafe(known), false, 'replacing a registered hook invalidates its exact-identity trust');
    known.dispose();
}
shifted.geometry.dispose();
cloud.scale.set(1, 1.01, 1); cloud.updateMatrixWorld();
assert.equal(guard.evaluate(camera, cloud, earth, lists([])), false, 'non-spherical cloud draw transforms do not use spherical front-half assumptions');
cloud.scale.setScalar(1); cloud.updateMatrixWorld();
const original = ship.geometry.boundingSphere; ship.geometry.boundingSphere = null;
ship.geometry.computeBoundingSphere = () => { throw new Error('must not build geometry bounds in the draw callback'); };
assert.equal(guard.evaluate(camera, cloud, earth, lists([ship])), false); ship.geometry.boundingSphere = original;
const sheared = mesh(1, 'Sheared placed body');
sheared.matrixWorld.set(1, 1, 0, base.x + 7.2, 0, 1, 0, base.y, 0, 0, 1, base.z + 6.4, 0, 0, 0, 1);
assert.equal(guard.evaluate(camera, cloud, earth, lists([sheared])), false, 'sheared object bounds cannot shrink below their actual singular-value extent');
sheared.geometry.dispose();
const guardedMaterial = createEarthCloudMaterial(null, () => BH.n > 0); cloud.material = guardedMaterial;
const renderer = { renderLists: { get: () => lists([ship]) } };
assert.equal(guardedMaterial.polygonOffset, false);
guardedMaterial.onBeforeRender(renderer, {}, camera, cloud.geometry, cloud);
assert.equal(guardedMaterial.polygonOffset, false, 'unregistered cloud defaults off');
registerEarthCloudGround(cloud, earth);
guardedMaterial.onBeforeRender(renderer, {}, camera, cloud.geometry, cloud);
assert.equal(guardedMaterial.polygonOffset, false, 'actual material draw hook preserves foreground occlusion');
renderer.renderLists.get = () => lists([]);
const version = guardedMaterial.version;
for (let i = 0; i < 120; i++) {
    cloud.rotation.y = (i % 2 ? -1 : 1) * i * .13; cloud.updateMatrixWorld();
    guardedMaterial.onBeforeRender(renderer, {}, camera, cloud.geometry, cloud);
    assert(guardedMaterial.polygonOffset, 'pause/reverse orientation changes retain a clear-footprint policy');
}
assert.equal(guardedMaterial.version, version, 'draw-only guard does not create shader variants');
const originalBHCount = BH.n, originalBeta = relUniforms.uBeta.value;
try {
    for (let i = 0; i < 3; i++) {
        BH.n = 1;
        guardedMaterial.onBeforeRender(renderer, {}, camera, cloud.geometry, cloud);
        assert.equal(guardedMaterial.polygonOffset, false, 'black-hole creation disables bias before unreliable TDE draw bounds');
        assert.equal(guardedMaterial.userData.cloudDepthGuard.reason, 'draw-deformation-context');
        BH.n = 0;
        guardedMaterial.onBeforeRender(renderer, {}, camera, cloud.geometry, cloud);
        assert(guardedMaterial.polygonOffset, 'black-hole removal restores clear-footprint evaluation');
        relUniforms.uBeta.value = .1;
        guardedMaterial.onBeforeRender(renderer, {}, camera, cloud.geometry, cloud);
        assert.equal(guardedMaterial.polygonOffset, false, 'shader relativistic mode disables geometric-cone assumptions');
        relUniforms.uBeta.value = 0;
        guardedMaterial.onBeforeRender(renderer, {}, camera, cloud.geometry, cloud);
        assert(guardedMaterial.polygonOffset, 'leaving relativistic mode restores ordinary policy');
    }
} finally { BH.n = originalBHCount; relUniforms.uBeta.value = originalBeta; }
assert.equal(guardedMaterial.depthTest, true); assert.equal(guardedMaterial.depthWrite, false);
guardedMaterial.dispose(); material.dispose();
for (const object of [earth, cloud, ship, moon, placed]) object.geometry.dispose();
console.log(`Cloud depth guard passed: ${contacts} close/far contact/limb bounds, ship/moon/placed/instanced/skinned cases, bounded unknown fallback and actual material hook`);
