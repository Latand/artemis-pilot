import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { decodeLocalVolume } from '../src/universe/galaxyCatalogs.js';
import { externalGalaxyCases, transformExternalGalaxySource, EPOCH_GYR } from './external-galaxy-fixtures.mjs';
const cases = externalGalaxyCases(), ids = new Set(cases.map(t => t.name));
assert.equal(cases.length, 25); assert.equal(ids.size, cases.length);
assert.deepEqual(['m31', 'zoom', 'catalog'].map(s => externalGalaxyCases(s).length), [9, 7, 9]);
assert.throws(() => externalGalaxyCases('missing'));
const lv = decodeLocalVolume(readFileSync(new URL('../public/data/local-volume.json', import.meta.url), 'utf8'));
for (const name of new Set(cases.map(t => t.target))) assert(lv.some(g => g.displayName === name), `Missing real catalog galaxy ${name}`);
for (const [target, family] of [['NGC 253', 'spiral'], ['NGC 5128', 'elliptical'], ['NGC 6822', 'irregular']]) {
    const g = lv.find(g => g.displayName === target);
    assert(family === 'spiral' ? g.type > 0 && g.type < 8.5 : family === 'elliptical' ? g.type <= 0 : g.type >= 8.5, `${target} catalog type changed`);
}
assert.equal(cases.find(t => t.name === 'm31-user-epoch').epochGyr, EPOCH_GYR);
assert(cases.some(t => t.view === 'behind'));
assert(cases.some(t => t.view === 'offaxis'));
assert.equal(cases.find(t => t.name === 'm31-exact-center').offsetLy, 0);
assert.equal(cases.find(t => t.name === 'm31-near-center-behind').offsetLy, .35);
assert.deepEqual(cases.find(t => t.name === 'm31-asymmetric-projection').projectionOffset, [.12, .03]);
const zoom = externalGalaxyCases('zoom');
assert(zoom[0].height >= 80 && zoom.at(-1).height <= .04);
assert(zoom.every((t, i) => !i || t.height < zoom[i - 1].height));
for (const file of ['src/main.js', 'src/render/galaxyPopulationRender.js', 'src/render/catalogStars.js']) {
    const src = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert(transformExternalGalaxySource(src, '/repo/' + file));
}
assert.throws(() => transformExternalGalaxySource('changed source', '/repo/src/main.js'));
assert.equal(transformExternalGalaxySource('untouched', '/repo/src/unrelated.js'), null);
// Independent ray-direction check at coordinates where near-plane world
// unprojection loses precision. Coverage must depend on rotation/projection,
// never translation. Compare against safe-origin unprojection.
const camera = new THREE.PerspectiveCamera(48, 1.5, .02, 1e30);
camera.rotation.set(.21, -.35, .13); camera.updateMatrixWorld();
camera.projectionMatrix.elements[8] = .12; camera.projectionMatrix.elements[9] = .03;
camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
for (const [x,y] of [[0,0],[-.95,.95],[.95,-.95]]) {
    const expected = new THREE.Vector3(x,y,.5).unproject(camera).normalize();
    const p = camera.projectionMatrix.elements;
    const actual = new THREE.Vector3((x+p[8])/p[0],(y+p[9])/p[5],-1).applyQuaternion(camera.quaternion).normalize();
    assert(expected.distanceTo(actual) < 1e-12);
    camera.position.set(1e16,-2e16,3e16); camera.updateMatrixWorld();
    const far = new THREE.Vector3((x+p[8])/p[0],(y+p[9])/p[5],-1).applyQuaternion(camera.quaternion).normalize();
    assert(actual.distanceTo(far) < 1e-12);
    camera.position.set(0,0,0); camera.updateMatrixWorld();
}
const browserSource = readFileSync(new URL('./external-galaxy-browser.js', import.meta.url), 'utf8');
assert(!browserSource.includes('.unproject(camera).sub(camera.position)'), 'Coverage rays must not lose near-plane offsets at huge camera coordinates');
console.log('PASS external-galaxy QA: 25 unique real-catalog fixtures, morphology families, present/user epochs, center-behind/off-axis and on-disk zoom, fail-closed transforms');
