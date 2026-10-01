import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { PL } from '../src/constants.js';
import { MOONS } from '../src/moons.js';
import { BODY_APPEARANCES, getBodyAppearance, bodyAppearanceSeed } from '../src/render/bodyAppearanceProfiles.js';
import { generateBodySurfaceMaps } from '../src/render/bodySurfaceMaps.js';
import { createBodySurfaceMaterial, applyBodySurfaceDetail, setBodyColorMap, updateBodySurface } from '../src/render/bodySurfaceMaterial.js';
const hash = data => createHash('sha256').update(data).digest('hex').slice(0, 16);
const names = ['EARTH', 'MOON', ...PL.map(p => p.name), ...MOONS.map(m => m.name), 'CERES'];
const appearanceHashes = new Set();
for (const name of names) {
    assert(BODY_APPEARANCES[name], name + ' has an explicit appearance');
    const p = getBodyAppearance(name);
    assert(p.provenance.length > 25, name + ' has scientific provenance');
    const a = generateBodySurfaceMaps(p, 128), b = generateBodySurfaceMaps(p, 128);
    assert.equal(hash(a.color), hash(b.color), name + ' deterministic color');
    assert.equal(hash(a.normal), hash(b.normal), name + ' deterministic relief');
    appearanceHashes.add(hash(a.color));
    for (const value of a.elevation) assert(Number.isFinite(value), name + ' finite height');
    assert.equal(a.color.length, 128 * 64 * 4);
    assert.equal(a.normal.length, a.color.length);
    // Both exact pole rows must collapse to a single color and normal.
    for (const y of [0, a.height - 1]) for (let x = 1; x < a.width; x++) {
        const k = (y * a.width + x) * 4, first = y * a.width * 4;
        assert.deepEqual(a.color.slice(k, k + 4), a.color.slice(first, first + 4), name + ' pole continuity');
        assert.deepEqual(a.normal.slice(k, k + 4), a.normal.slice(first, first + 4), name + ' pole normal continuity');
    }
    const meanDelta = (x, next) => {
        let sum = 0;
        for (let y = 1; y < a.height - 1; y++) for (let c = 0; c < 3; c++) sum += Math.abs(a.color[(y * a.width + x) * 4 + c] - a.color[(y * a.width + next) * 4 + c]);
        return sum / ((a.height - 2) * 3);
    };
    let interior = 0;
    for (let x = 0; x < a.width - 1; x++) interior += meanDelta(x, x + 1);
    interior /= a.width - 1;
    assert(meanDelta(a.width - 1, 0) < Math.max(10, interior * 4), name + ' no discontinuous map seam');
    if (p.relief === 0) for (let k = 0; k < a.normal.length; k += 4) assert.deepEqual([...a.normal.slice(k, k + 3)], [128, 128, 255], name + ' cloud top has no rocky bump');
}
assert.equal(appearanceHashes.size, names.length, 'every named body has distinct detail');
assert(getBodyAppearance('NEREID').provenance.includes('no resolved'));
assert.equal(BODY_APPEARANCES.TITAN.relief, 0);
assert.equal(BODY_APPEARANCES.VENUS.relief, 0);
assert.equal(BODY_APPEARANCES.IO.craters, 0);
const ioColors = generateBodySurfaceMaps(getBodyAppearance('IO'), 512).color;
for (let k = 0; k < ioColors.length; k += 4) {
    // The yellow/red sulfur recipe always has red >= green. Uint8 wraparound
    // previously turned 1,547 bright rim pixels green in this exact seed/map.
    assert(ioColors[k] >= ioColors[k + 1], 'Io sulfur red channel must clamp rather than wrap toward green');
}
const lunarFallback = createBodySurfaceMaterial(getBodyAppearance('MOON'));
applyBodySurfaceDetail(lunarFallback, undefined, 64);
assert(lunarFallback.userData.appearanceProvenance.includes('fallback'));
assert(lunarFallback.map.userData.provenance.includes('not an observed'));
const lunarPhoto = new THREE.Texture(); lunarPhoto.userData.provenance = 'Verified image source';
setBodyColorMap(lunarFallback, lunarPhoto);
assert.equal(lunarFallback.userData.appearanceProvenance, 'Verified image source');
lunarFallback.dispose();
assert(BODY_APPEARANCES.NEPTUNE.mapSaturation < 1, 'historically over-blue map is display-corrected');
assert.notEqual(bodyAppearanceSeed('host-a:b'), bodyAppearanceSeed('host-b:b'));
for (const type of ['rocky', 'ice', 'ocean', 'desert', 'gas', 'hot-jupiter', 'sub-neptune']) {
    const p = getBodyAppearance({ name: 'Catalog b', type, color: 0x9d997a }, 'hip-123:Catalog b');
    assert(p.provenance.includes('no resolved'));
    assert.equal(p.seed, getBodyAppearance({ name: 'Catalog b', type }, 'hip-123:Catalog b').seed);
    assert.equal(generateBodySurfaceMaps(p, 64).color.length, 64 * 32 * 4);
}
// Exhaust the actual bundled catalog's unique host/body identities. Every named
// exoplanet receives a distinct stable ID while all appearances remain inferred.
const catalog = JSON.parse(readFileSync(new URL('../public/data/exoplanets.json', import.meta.url)));
const unique = new Map();
for (const host of Object.values(catalog.hosts)) for (const p of host.planets) {
    const name = host.hostname + (p.letter ? ' ' + p.letter : '');
    unique.set(name, getBodyAppearance({ name, gas: Number(p.massMe) > 50 }, name));
}
assert(unique.size > 1000, 'named catalog coverage is exercised');
for (const [name, profile] of unique) assert(profile.id === name && profile.provenance.includes('no resolved'), name);
const profile = getBodyAppearance('EUROPA');
const material = createBodySurfaceMaterial(profile);
applyBodySurfaceDetail(material, profile, 64);
assert(material.map.isDataTexture && material.normalMap.isDataTexture);
assert.equal(material.map.colorSpace, THREE.SRGBColorSpace);
assert.equal(material.normalMap.colorSpace, THREE.NoColorSpace);
assert.equal(material.map.wrapS, THREE.RepeatWrapping);
assert.equal(material.map.flipY, true);
assert.notEqual(hash(material.map.image.data), hash(material.normalMap.image.data), 'height is never inferred from albedo');
const photograph = new THREE.Texture();
setBodyColorMap(material, photograph);
applyBodySurfaceDetail(material, profile, 128);
assert.equal(material.map, photograph, 'higher-resolution relief preserves source albedo');
assert.equal(material.userData.surfaceDetailWidth, 128);
const hostMaterial = createBodySurfaceMaterial(getBodyAppearance({ name: 'Test b', type: 'ice' }, 'test:b'), { hostLit: true });
const fake = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
hostMaterial.onBeforeCompile(fake);
assert(fake.fragmentShader.includes('RE_Direct(directLight'), 'host star supplies direct light');
assert(!fake.fragmentShader.includes('#include <lights_fragment_begin>'), 'distant Sun is not used for exoplanet phase');
assert(fake.fragmentShader.includes('vec3 irradiance = vec3(0.0)'), 'unlit side has no artificial emission');
const direction = new THREE.Vector3(0, 1, 0), color = new THREE.Color(.7, .9, 1);
updateBodySurface(hostMaterial, 123, direction, color);
assert.deepEqual(hostMaterial.userData.surfaceUniforms.uBodyHostDirection.value.toArray(), [0, 1, 0]);
const fixedTime = hostMaterial.userData.surfaceUniforms.uSurfaceTime.value;
updateBodySurface(hostMaterial, 123);
assert.equal(hostMaterial.userData.surfaceUniforms.uSurfaceTime.value, fixedTime, 'paused surface is stable');
material.dispose(); hostMaterial.dispose();
assert(material.userData.surfaceDisposed, 'disposing a surface cancels queued detail');
console.log(`smoke-body-surfaces passed: ${names.length} named Solar System bodies, ${unique.size} catalog planets, deterministic maps, poles/seams, physical material state and host lighting`);

// Runtime integration, including physical mesh radii and per-host identities.
// Canvas is used only for guide labels/dots; surface pixels use the tested pure
// generator above. This is not a substitute for the browser shader test.
globalThis.document = { createElement() { return { width: 1, height: 1, getContext() { return {
    createRadialGradient() { return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; }, fillRect() {}, fillText() {},
}; } }; } };
const { initSystemRender, updateSystemRender, disposeSystemRender, systemBodyRenderState, planetScenePosition } = await import('../src/render/systemBodies.js');
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, 1.6, .01, 1e9);
initSystemRender(scene);
const testSystem = {
    starId: 'test-host-1', hostMass: 1, hostTeff: 4400, hostStar: { x: 0, y: 0, z: 0 },
    planets: [{ name: 'Test b', a: 1, e: 0, i: 0, Om: 0, varpi: 0, M0: 0, radiusKm: 6371,
        mu: 398600, type: 'rocky', color: 0xafa08c, rotSec: 86400, tilt: .2,
        moons: [{ name: 'Test b I', a: 40000, e: 0, R: 100, phase: 0, orbitMu: 398600, color: 0xaaaaaa }] }],
};
const center = planetScenePosition(testSystem, 0, 0, new THREE.Vector3());
camera.position.copy(center).add(new THREE.Vector3(0, 0, 30));
camera.lookAt(center); camera.updateMatrixWorld();
updateSystemRender(testSystem, 0, camera, 'planet:0');
let slot = systemBodyRenderState()[0];
assert.equal(slot.mesh.scale.x, 6.371, 'resolved planet uses physical radius');
assert.equal(slot.moons[0].scale.x, .1, 'moon never expands to a minimum screen radius');
assert.equal(slot.glow.visible, false, 'resolved planet guide does not cover the surface');
assert.equal(slot.mesh.material.userData.bodyAppearance.id, 'test-host-1:Test b');
assert(slot.mesh.material.userData.surfaceUniforms.uBodyHostDirection.value.dot(center.clone().negate().normalize()) > .999999);
const oldProfile = slot.mesh.material.userData.bodyAppearance.seed;
updateSystemRender({ ...testSystem, starId: 'test-host-2' }, 0, camera, 'planet:0');
slot = systemBodyRenderState()[0];
assert.notEqual(slot.mesh.material.userData.bodyAppearance.seed, oldProfile, 'same slot in another host gets unique stable detail');
disposeSystemRender();
assert.equal(systemBodyRenderState().length, 0);
const { createMinorBodyRenderers, updateWorldPositions } = await import('../src/render/minorBodiesRender.js');
const minor = createMinorBodyRenderers({ scene, swarms: { meta: { counts: { belt: 1, kuiper: 1, oort: 1 } } } });
assert.equal(minor.curated.resolvedBodies.length, 1, 'Ceres has an actual resolved surface');
const positions = new Float64Array(minor.curated.capacity * 3); positions[0] = 10000;
updateWorldPositions(minor.curated, positions);
assert.equal(minor.curated.resolvedBodies[0].surface.position.x, 10, 'Ceres follows unchanged minor-body orbit buffer');
assert.equal(minor.curated.resolvedBodies[0].surface.visible, true);
console.log('smoke-body-surfaces runtime integration passed');
