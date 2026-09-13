import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {CURATED_PHOTOMETRY} from '../src/render/curatedPhotometry.js';
import {meteredSkyExposure, skyExposureForDisc} from '../src/render/stellarAppearance.js';

const meta = JSON.parse(readFileSync(new URL('../public/data/hyg-stars-v41.json', import.meta.url)));
const raw = readFileSync(new URL('../public/data/hyg-stars-v41.bin', import.meta.url));
const data = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
for (const [name, p] of Object.entries(CURATED_PHOTOMETRY)) {
    assert.equal(meta.labels.find(r => r[0] === p.hygIndex)?.[1], p.sourceName, name + ' source identity');
    assert.equal(data[p.hygIndex * meta.stride + meta.fields.indexOf('tempK')], p.tempK, name + ' temperature');
    assert(Math.abs(data[p.hygIndex * meta.stride + meta.fields.indexOf('mag')] - p.mag) < 0.001, name + ' magnitude');
}
assert(CURATED_PHOTOMETRY.PROXIMA.tempK < 4000);
assert(CURATED_PHOTOMETRY['SIRIUS A'].tempK > 9000);
assert(CURATED_PHOTOMETRY.PROXIMA.mag > CURATED_PHOTOMETRY['SIRIUS A'].mag + 10);
assert.notEqual(CURATED_PHOTOMETRY['ALPHA CEN A'].hygIndex, CURATED_PHOTOMETRY['ALPHA CEN B'].hygIndex);
assert.equal(skyExposureForDisc(1,4,-1),1);
assert(skyExposureForDisc(1,4,1) < 0.01);
const camera = new THREE.PerspectiveCamera(48,16/9,0.1,1000);
camera.updateMatrixWorld();
const center = new THREE.Vector3(0,0,-4);
assert(meteredSkyExposure(camera,center,1) < 0.01);
center.z=4;
assert.equal(meteredSkyExposure(camera,center,1),1,'body behind camera does not meter');
center.z=-4;
let last=0;
for(let x=0;x<6;x+=0.005) {
    center.x=x;
    const exposure=meteredSkyExposure(camera,center,1);
    assert(Number.isFinite(exposure) && exposure>=last-1e-12,'exposure changes monotonically as the body leaves view');
    assert(exposure-last < 0.08,'no step at viewport boundary');
    last=exposure;
}
console.log('33 curated photometry records, temperature/magnitude ordering and continuous exposure: passed');
