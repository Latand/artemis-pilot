import assert from 'node:assert/strict';
import * as THREE from 'three';
import { earthSurfaceMaterial, updateEarthSurfaceExposure } from '../src/render/planetAppearance.js';
import { surfaceExposurePreparation } from '../src/render/surfaceRotationExposure.js';
import { applyTerrellToMaterial } from '../src/relView.js';

const map = new THREE.DataTexture(new Uint8Array(512 * 256 * 4).fill(128), 512, 256, THREE.RGBAFormat);
map.needsUpdate = true;
const earth = earthSurfaceMaterial(map, map, map, 6.371);
const clouds = applyTerrellToMaterial(new THREE.MeshLambertMaterial({ alphaMap: map, transparent: true }));
const compileCloud = () => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
    clouds.onBeforeCompile(shader);
    return shader;
};
const original = compileCloud();
const omega = 2 * Math.PI / 86164, cloudOmega = omega + 2 * Math.PI / (14 * 86400), fast = 256 * 86400 / 30;
updateEarthSurfaceExposure(earth, clouds, omega, cloudOmega, 0);
assert(!earth.defines.SURFACE_ROTATION_EXPOSURE && !clouds.defines?.SURFACE_ROTATION_EXPOSURE, 'initial pause uses exact shader variants');
assert.deepEqual(compileCloud(), original, 'paused clouds preserve the complete original shader and uniforms, including relativity hooks');
assert(earth.fragmentShader.includes('#define sampleSurfaceExposure(sourceMap, integralMap, uv, size, turns) texture2D(sourceMap, uv)'), 'inactive Earth preprocesses to direct source reads');
const pausedVersions = [earth.version, clouds.version];
for (let i = 0; i < 120; i++) updateEarthSurfaceExposure(earth, clouds, omega, cloudOmega, i % 2 ? 0 : 1/30);
assert.deepEqual([earth.version, clouds.version], pausedVersions, 'paused/ordinary updates do not invalidate programs');
assert(!updateEarthSurfaceExposure(earth, clouds, omega, cloudOmega, fast), 'cold maps retain exact variant while preparing');
assert(!earth.defines.SURFACE_ROTATION_EXPOSURE && !clouds.defines?.SURFACE_ROTATION_EXPOSURE);
const start = performance.now();
while (surfaceExposurePreparation.pending) { assert(performance.now() - start < 5000); await new Promise(resolve => setTimeout(resolve, 2)); }
assert(updateEarthSurfaceExposure(earth, clouds, omega, cloudOmega, fast));
assert.equal(earth.defines.SURFACE_ROTATION_EXPOSURE, 1);
assert.equal(clouds.defines.SURFACE_ROTATION_EXPOSURE, 1);
assert(compileCloud().fragmentShader.includes('sampleSurfaceExposure(alphaMap'), 'active variant retains cloud exposure');
assert.equal(earth.uniforms.uSurfaceExposureTurns.value, 1);
const activeVersions = [earth.version, clouds.version];
for (let i = 0; i < 120; i++) updateEarthSurfaceExposure(earth, clouds, omega, cloudOmega, i % 2 ? fast : -fast);
assert.deepEqual([earth.version, clouds.version], activeVersions, 'reverse/high-rate updates reuse the same active programs');
updateEarthSurfaceExposure(earth, clouds, omega, cloudOmega, 0);
assert.deepEqual([earth.version, clouds.version], activeVersions.map(v => v + 1), 'pause requests each exact cached variant once');
assert.deepEqual(compileCloud(), original, 'pause restores the exact original cloud shader after averaging');
assert.equal(earth.uniforms.uSurfaceExposureTurns.value, 0);
assert.equal(earth.uniforms.uCloudExposureTurns.value, 0);
// Cloud shadows cross their threshold slightly before the surface. They must
// not be silently disabled by selecting the ordinary Earth program there.
const betweenThresholds = .5 / 512 * (2 * Math.PI) / ((omega + cloudOmega) / 2);
updateEarthSurfaceExposure(earth, clouds, omega, cloudOmega, betweenThresholds);
assert.equal(earth.uniforms.uSurfaceExposureTurns.value, 0);
assert.equal(earth.defines.SURFACE_ROTATION_EXPOSURE, 1, 'cloud-shadow-only exposure enables the Earth variant');
updateEarthSurfaceExposure(earth, clouds, omega, cloudOmega, 0);
earth.dispose(); clouds.dispose(); map.dispose();
console.log('smoke-surface-fastpath passed: inactive direct sampling, exact cloud shader restoration, asynchronous readiness, two cached variants, forward/reverse reuse and cloud-shadow threshold');
