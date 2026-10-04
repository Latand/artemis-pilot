import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { R_EARTH, K } from '../src/constants.js';
import { EARTH_CLOUD_HEIGHT_KM, createEarthCloudMaterial } from '../src/render/planetAppearance.js';

// Evaluate the exact cloud geometry expression from production, rather than
// proving a different test-only sphere. Fail closed if its construction changes.
const source = readFileSync(new URL('../src/bodies.js', import.meta.url), 'utf8');
const expressions = [...source.matchAll(/sphere\(\(R_EARTH \+ EARTH_CLOUD_HEIGHT_KM\) \* K, \d+, \d+, \d+, \d+\)/g)];
assert.equal(expressions.length, 1, 'one production cloud geometry expression');
assert(source.includes('earth = new THREE.Mesh(sphere(radius, 96, 72, 48, 32), earthMat)'), 'ground tessellation is unchanged');
assert.equal(EARTH_CLOUD_HEIGHT_KM, 6, 'physical cloud altitude stays six kilometres');
assert(source.includes('applyTerrellToMaterial(createEarthCloudMaterial(maps.clouds, () => BH.n > 0))'), 'production uses the shared cloud-only policy with live black-hole state');
const alphaMap = new THREE.Texture(), cloudMaterial = createEarthCloudMaterial(alphaMap);
assert.equal(cloudMaterial.alphaMap, alphaMap, 'the original cloud source remains bound');
assert.equal(cloudMaterial.polygonOffset, false, 'bias is off until an actual draw proves the footprint clear');
assert.equal(cloudMaterial.polygonOffsetFactor, 0, 'no grazing-slope amplification');
assert.equal(cloudMaterial.polygonOffsetUnits, -2, 'two bounded constant raster-depth units');
assert.equal(cloudMaterial.depthTest, true, 'foreground objects still occlude clouds');
assert.equal(cloudMaterial.depthFunc, THREE.LessEqualDepth);
assert.equal(cloudMaterial.depthWrite, false, 'the transparent cloud shell does not overwrite scene depth');
assert.equal(cloudMaterial.side, THREE.FrontSide, 'far cloud hemisphere never paints through Earth');
assert.equal(cloudMaterial.opacity, .92); assert.equal(cloudMaterial.transparent, true);
assert.equal(cloudMaterial.blending, THREE.NormalBlending);
cloudMaterial.dispose(); alphaMap.dispose();
const build = new Function('sphere', 'R_EARTH', 'EARTH_CLOUD_HEIGHT_KM', 'K', 'return ' + expressions[0][0]);
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
function inradius(geometry, rotation) {
    const vertices = geometry.getAttribute('position'), indices = geometry.index.array;
    let minimum = Infinity;
    for (let i = 0; i < indices.length; i += 3) {
        a.fromBufferAttribute(vertices, indices[i]).applyQuaternion(rotation);
        b.fromBufferAttribute(vertices, indices[i + 1]).applyQuaternion(rotation);
        c.fromBufferAttribute(vertices, indices[i + 2]).applyQuaternion(rotation);
        normal.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
        assert(normal.lengthSq() > 1e-24, 'no degenerate cloud triangles');
        minimum = Math.min(minimum, Math.abs(normal.normalize().dot(a)));
    }
    return minimum;
}
const identity = new THREE.Quaternion();
const old = new THREE.SphereGeometry((R_EARTH + 6) * K, 48, 32);
assert(inradius(old, identity) < R_EARTH * K - .015, 'regression fixture reproduces the old >15 km facet incursion');
assert.equal(old.index.count / 3, 2976); old.dispose();
const results = [];
for (const mobile of [false, true]) {
    const sphere = (r, dw, dh, mw, mh) => new THREE.SphereGeometry(r, mobile ? mw : dw, mobile ? mh : dh);
    const geometry = build(sphere, R_EARTH, EARTH_CLOUD_HEIGHT_KM, K);
    assert.equal(geometry.index.count / 3, mobile ? 12096 : 13632, 'bounded cloud-only triangle count');
    let minimum = Infinity;
    for (const longitude of [-2 * Math.PI, -3.7, -.7, 0, .1, Math.PI / 96, .7, 2.1, 2 * Math.PI]) {
        const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.41, longitude, -.23));
        minimum = Math.min(minimum, inradius(geometry, rotation));
    }
    // Every cloud face plane lies outside the complete ideal Earth sphere.
    // The convex ground mesh is contained by that sphere at ANY relative
    // rotation, so this is stronger than a finite camera/phase sampling test.
    assert(minimum > R_EARTH * K + .0006, 'every rotated cloud face contains Earth with >0.6 km clearance');
    const positions = geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
        const radius = a.fromBufferAttribute(positions, i).length();
        assert(Math.abs(radius - (R_EARTH + 6) * K) < 5e-7, 'vertices retain the physical six-kilometre shell');
    }
    results.push({ mobile, triangles: geometry.index.count / 3, minimumClearanceKm: (minimum - R_EARTH * K) / K });
    geometry.dispose();
}
console.log('Earth cloud-shell containment passed:', JSON.stringify(results));
