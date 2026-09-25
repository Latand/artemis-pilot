import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sameObserver, sameGalaxyState, canReuseGalaxyHistory, targetSizeChanged } from '../src/render/galaxyViewCache.js';
import { skyDisplay, meteredSkyExposure, skyExposureForDisc } from '../src/render/stellarAppearance.js';
const observer = [8178, 0, 20.8], model = [0, .471, 1, 1, 1, 11, 0, 1];
const history = { observer, model, pixelAngle: .001 };
assert(sameObserver(observer, [...observer]));
assert(!sameObserver(observer, [8178.01, 0, 20.8]));
assert(!sameObserver(observer, [NaN, 0, 20.8]));
assert(sameGalaxyState(model, [...model]));
for (let i = 0; i < model.length; i++) {
    const changed = [...model]; changed[i] += .001;
    assert(!sameGalaxyState(model, changed));
    assert(!canReuseGalaxyHistory(history, observer, changed, .004));
}
assert(canReuseGalaxyHistory(history, observer, model, .004));
assert(!canReuseGalaxyHistory(history, observer, model, .0001)); // zoom beyond old angular detail
assert(!canReuseGalaxyHistory(history, [8178, 1, 20.8], model, .004));
assert(!canReuseGalaxyHistory(null, observer, model, .004));
for (let i = 0; i < 6; i++) {
    const dimensions = [1280, 800, 1280, 800, 640, 400], next = [...dimensions]; next[i]++;
    assert(targetSizeChanged(dimensions, next));
}
assert(!targetSizeChanged([1280,800,640,400], [1280,800,640,400]));
// Off-axis/view-offset projection: the shader's ray agrees with unproject,
// including a parented observer. A nominal camera.fov is not enough.
const parent = new THREE.Group(), camera = new THREE.PerspectiveCamera(48, 1.6, .01, 1e8);
parent.position.set(40,20,-90); parent.rotation.set(.1,.7,.3); parent.add(camera);
camera.position.set(10,-4,3); camera.setViewOffset(1600,1000,100,50,800,500); parent.updateMatrixWorld(true);
const p = camera.projectionMatrix.elements;
for (const [x,y] of [[0,0],[-.8,.5],[.9,-.7]]) {
    const expected = new THREE.Vector3(x,y,.5).unproject(camera).sub(camera.getWorldPosition(new THREE.Vector3())).normalize();
    const actual = new THREE.Vector3((x+p[8])/p[0],(y+p[9])/p[5],-1).transformDirection(camera.matrixWorld);
    assert(expected.distanceTo(actual)<1e-10);
}
assert.equal(skyDisplay.mode, 'photographic');
assert.equal(meteredSkyExposure(), 1);
assert(skyExposureForDisc(1,1)<.001); // physical meter retained, not rewritten
console.log('PASS galaxy cache invalidation, history rejection, off-axis observer rays, photographic sky mode');
