import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { buildLongitudeIntegral, surfaceExposureTurns, updateSurfaceRotationExposure, SURFACE_EXPOSURE_MAX_WIDTH, SURFACE_EXPOSURE_MAX_HEIGHT, surfaceExposurePreparation } from '../src/render/surfaceRotationExposure.js';
import { createBodySurfaceMaterial, setBodyColorMap } from '../src/render/bodySurfaceMaterial.js';
import { earthSurfaceMaterial, updateEarthSurfaceExposure } from '../src/render/planetAppearance.js';
const near = (a, b, message, eps = 2e-6) => assert(Math.abs(a - b) < eps, `${message}: ${a} vs ${b}`);
const sha = a => createHash('sha256').update(new Uint8Array(a.buffer)).digest('hex');
const tau = 2 * Math.PI;
const bytes = new Uint8Array([
    255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,255,255,
    20,40,60,128, 20,40,60,128, 20,40,60,128, 20,40,60,128,
]);
const integral = buildLongitudeIntegral(bytes, 4, 2);
assert.equal(sha(integral.data), sha(buildLongitudeIntegral(bytes, 4, 2).data), 'integral synthesis is deterministic');
assert.deepEqual([...integral.data.slice(16, 20)], [.5, .5, .5, 1], 'full longitude preserves RGB energy');
near(integral.data[36], 20 / 255, 'latitude is preserved');
const flipped = buildLongitudeIntegral(bytes, 4, 2, { flipY: true });
near(flipped.data[16], 20 / 255, 'source flipY is baked exactly once');
near(flipped.data[36], .5, 'north/south rows do not exchange later');
const srgb = buildLongitudeIntegral(new Uint8Array([0,0,0,255, 255,255,255,255]), 2, 1, { srgb: true });
near(srgb.data[8], .5, 'black/white exposure averages linear light, not encoded bytes');
const unequal = buildLongitudeIntegral(new Uint8Array([255,0,0,255, 0,255,0,255, 0,0,255,255]), 3, 1, { maxWidth: 2 });
for (let c = 0; c < 3; c++) near(unequal.data[8 + c], 1/3, 'odd-size downsample preserves full row mean');
const large = buildLongitudeIntegral(new Uint8Array(1024 * 512 * 4).fill(128), 1024, 512);
assert.equal(large.width, SURFACE_EXPOSURE_MAX_WIDTH);
assert.equal(large.height, SURFACE_EXPOSURE_MAX_HEIGHT);
assert(large.data.byteLength <= 2.01 * 1024 * 1024, 'per-map GPU storage is bounded near 2 MiB');

// CPU oracle for the shader's exact piecewise-constant longitude integral.
function prefix(map, u, y = 0, c = 0) {
    const x = Math.max(0, Math.min(1, u)) * map.width, lo = Math.floor(x), hi = Math.min(map.width, lo + 1), f = x - lo;
    return map.data[(y * (map.width + 1) + lo) * 4 + c] * (1 - f) + map.data[(y * (map.width + 1) + hi) * 4 + c] * f;
}
function exposed(map, u, turns, y = 0, c = 0) {
    const width = Math.min(1, Math.abs(turns));
    const mean = prefix(map, 1, y, c);
    if (width >= 1) return mean;
    const center = u - Math.floor(u), left = center - width / 2, right = center + width / 2;
    return (prefix(map, right - Math.floor(right), y, c) - prefix(map, left - Math.floor(left), y, c)
        + (Math.floor(right) - Math.floor(left)) * mean) / width;
}
for (let i = 0; i < 100; i++) {
    const u = i / 99, span = .13 + i / 150;
    near(exposed(integral, u, span), exposed(integral, u + 7, span), 'periodic exposure has no longitude seam');
    near(exposed(integral, u, span), exposed(integral, u, -span), 'reverse shutter is symmetric');
    near(exposed(integral, u, 1), .5, 'full turn is phase independent');
}
// A full-rotation-per-shutter frame sequence must not alias at either 30/60/
// 120 Hz, including the user's 256 days/s and arbitrarily deeper time warps.
const omegaEarth = tau / 86164;
for (const fps of [30,60,120]) for (const rate of [256 * 86400, -256 * 86400, 1e20, -1e20]) {
    const turns = surfaceExposureTurns(omegaEarth, rate / Math.min(fps, 30));
    assert.equal(turns, 1);
    for (let frame = 0; frame < 120; frame++) near(exposed(integral, omegaEarth * rate * frame / fps / tau, turns), .5, 'high-rate frame sequence is invariant');
}
assert.equal(surfaceExposureTurns(omegaEarth, 0), 0, 'pause restores exact surface immediately');
for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(surfaceExposureTurns(omegaEarth, bad), 0);
    assert.equal(surfaceExposureTurns(bad, 1), 0);
}
assert.equal(surfaceExposureTurns(1e308, 1e308), 1, 'finite extreme products saturate safely');
for (const rate of [1, 10, 86400, 256 * 86400]) near(surfaceExposureTurns(omegaEarth, rate/60), surfaceExposureTurns(-omegaEarth, -rate/60), 'retrograde and reverse agree');

function mapOf(pixels = bytes, width = 4, height = 2) {
    const t = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
    t.needsUpdate = true;
    return t;
}
const source = mapOf(), material = createBodySurfaceMaterial('MARS', { map: source });
assert.equal(updateSurfaceRotationExposure(material, omegaEarth, 1/60), false, 'normal-time material stays exact');
assert.equal(material.userData.surfaceRotationExposure.slots[0].texture, null, 'normal time does not allocate exposure maps');
const waitPreparation = async () => {
    const start = performance.now();
    while (surfaceExposurePreparation.pending) {
        assert(performance.now() - start < 5000, 'bounded preparation makes progress');
        await new Promise(resolve => setTimeout(resolve, 2));
    }
};
assert.equal(updateSurfaceRotationExposure(material, omegaEarth, 256*86400/30), false, 'first frame uses exact fallback while queued');
assert.equal(material.userData.surfaceRotationExposure.turns.value, 0, 'normal/grain also remain exact until ready');
await waitPreparation();
assert.equal(updateSurfaceRotationExposure(material, omegaEarth, 256*86400/30), true);
const slot = material.userData.surfaceRotationExposure.slots[0], allocated = slot.texture;
assert.equal(allocated.type, THREE.FloatType);
assert.deepEqual([...allocated.image.data],[...buildLongitudeIntegral(bytes,4,2,{flipY:source.flipY}).data],'idle row builder matches the synchronous mathematical oracle');
assert.equal(allocated.minFilter, THREE.NearestFilter, 'no float-linear extension is needed');
assert.equal(allocated.flipY, false, 'CPU-orientated integral is not flipped again on upload');
for (let i = 0; i < 120; i++) updateSurfaceRotationExposure(material, omegaEarth, (-1) ** i * 256*86400/30);
assert.equal(slot.texture, allocated, 'per-frame updates reuse the texture');
assert.equal(updateSurfaceRotationExposure(material, omegaEarth, 0), false);
assert.equal(material.userData.surfaceRotationExposure.turns.value, 0, 'pause has no temporal history or lag');
assert.equal(slot.texture, allocated, 'paused maps remain reusable');
let disposed = 0; allocated.addEventListener('dispose', () => disposed++);
const replacement = mapOf(new Uint8Array(bytes.length).fill(200));
setBodyColorMap(material, replacement);
updateSurfaceRotationExposure(material, omegaEarth, 256*86400/30);
assert.equal(disposed, 1, 'map replacement disposes old integral exactly once');
assert.equal(slot.texture,null,'replacement is prepared away from the render call');
await waitPreparation();updateSurfaceRotationExposure(material,omegaEarth,256*86400/30);
assert.notEqual(slot.texture, allocated);
const current = slot.texture; current.addEventListener('dispose', () => disposed++);
replacement.image.data.fill(90); replacement.needsUpdate = true;
updateSurfaceRotationExposure(material, omegaEarth, 256*86400/30);
assert.equal(disposed, 2, 'same texture source version invalidates its integral');
await waitPreparation();updateSurfaceRotationExposure(material,omegaEarth,256*86400/30);
const last = slot.texture; last.addEventListener('dispose', () => disposed++);
material.dispose();
assert.equal(disposed, 3, 'material disposal releases its current integral');
assert.equal(slot.texture, null);
const inaccessible = createBodySurfaceMaterial('MARS', { map: new THREE.Texture() });
assert.equal(updateSurfaceRotationExposure(inaccessible, omegaEarth, 86400), false, 'unreadable maps keep ordinary shading');
inaccessible.dispose();
const malformed=createBodySurfaceMaterial('MARS',{map:mapOf(new Uint8Array(3),4,2)});updateSurfaceRotationExposure(malformed,omegaEarth,86400);await waitPreparation();assert.equal(updateSurfaceRotationExposure(malformed,omegaEarth,86400),false,'malformed source cannot upload a NaN prefix');malformed.dispose();

const earth = earthSurfaceMaterial(source, source, source, 6.371);
const cloud = new THREE.MeshLambertMaterial({ alphaMap: source, transparent: true });
let priorCompile = 0; cloud.onBeforeCompile = () => priorCompile++;
assert.equal(updateEarthSurfaceExposure(earth, cloud, omegaEarth, omegaEarth + tau/(14*86400), 256*86400/30),false);
await waitPreparation();
assert(updateEarthSurfaceExposure(earth, cloud, omegaEarth, omegaEarth + tau/(14*86400), 256*86400/30));
assert(earth.userData.surfaceRotationExposure.slots.every(s=>s.texture===cloud.userData.surfaceRotationExposure.slots[0].texture),'shared source supplies one integral for Earth maps and cloud alpha');
assert.equal(earth.uniforms.uSurfaceExposureTurns.value, 1);
assert.equal(earth.uniforms.uCloudExposureTurns.value, 1);
assert.equal(cloud.userData.surfaceRotationExposure.turns.value, 1);
const fakeCloud = {uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader};
cloud.onBeforeCompile(fakeCloud);
assert.equal(priorCompile, 1, 'cloud exposure preserves existing shader hooks');
assert(fakeCloud.fragmentShader.includes('sampleSurfaceExposure(alphaMap'), 'visible cloud alpha is integrated');
assert(earth.fragmentShader.includes('sampleSurfaceExposure(dayMap'), 'Earth daylight is integrated');
assert(earth.fragmentShader.includes('sampleSurfaceExposure(nightMap'), 'Earth night lights are integrated');
assert(earth.fragmentShader.includes('sampleSurfaceExposure(cloudMap'), 'cloud shadows are integrated');
assert.equal(updateEarthSurfaceExposure(earth, cloud, omegaEarth, omegaEarth + tau/(14*86400), 0), false);
assert.equal(earth.uniforms.uCloudExposureTurns.value, 0);
assert.equal(earth.uniforms.uSurfaceExposureTurns.value, 0);
assert.equal(cloud.userData.surfaceRotationExposure.turns.value, 0);
const sharedTexture=cloud.userData.surfaceRotationExposure.slots[0].texture;let sharedDisposals=0;sharedTexture.addEventListener('dispose',()=>sharedDisposals++);
earth.dispose();assert.equal(sharedDisposals,0,'disposing one sharer preserves the other material integral');cloud.dispose();assert.equal(sharedDisposals,1,'last sharing owner disposes the integral once');
await waitPreparation();
const coldMap=mapOf(new Uint8Array(2048*1024*4).fill(128),2048,1024);
const cold=createBodySurfaceMaterial('EARTH',{map:coldMap});
const coldStart=performance.now();updateSurfaceRotationExposure(cold,omegaEarth,256*86400/30);
assert(performance.now()-coldStart<10,'cold render update only enqueues work');
assert.equal(cold.userData.surfaceRotationExposure.slots[0].texture,null);
const slicesBefore=surfaceExposurePreparation.slices;await waitPreparation();
assert(surfaceExposurePreparation.slices>slicesBefore+1,'2K map is split across idle turns');
updateSurfaceRotationExposure(cold,omegaEarth,256*86400/30);assert(cold.userData.surfaceRotationExposure.active);
cold.dispose();await waitPreparation();
const cancelled=createBodySurfaceMaterial('MOON',{map:coldMap});updateSurfaceRotationExposure(cancelled,omegaEarth,86400);cancelled.dispose();await waitPreparation();assert.equal(cancelled.userData.surfaceRotationExposure.slots[0].texture,null,'dispose while queued never resurrects a texture');
assert(surfaceExposurePreparation.readyBytes>=0&&surfaceExposurePreparation.readyBytes<=24*1024*1024,'ready integral cache stays within its memory ceiling');
const oldWindow=globalThis.window;globalThis.window={innerWidth:430};
const lowMaterials=[];
for(let i=0;i<18;i++){const map=mapOf(new Uint8Array(512*256*4).fill(80+i),512,256);const m=createBodySurfaceMaterial('MARS',{map});lowMaterials.push(m);updateSurfaceRotationExposure(m,omegaEarth,86400);}
await waitPreparation();
assert(surfaceExposurePreparation.readyBytes<=8*1024*1024,'mobile integral cache stays below 8 MiB');
const readyLow=lowMaterials.map(m=>m.userData.surfaceRotationExposure.slots[0]).filter(s=>s.texture);
assert(readyLow.length<lowMaterials.length&&readyLow.every(s=>s.size.value.x<=256&&s.size.value.y<=128),'low-memory mode uses smaller maps and evicts old entries');
for(const m of lowMaterials)m.dispose();await waitPreparation();
if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;
assert.equal(surfaceExposurePreparation.readyBytes,0,'all ready resources release after their last owner is gone');
const generic = createBodySurfaceMaterial('MOON');
const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
generic.onBeforeCompile(shader);
assert(shader.fragmentShader.includes('mapN.xy *= normalScale *'), 'unresolved normal relief cannot keep flashing');
assert(shader.fragmentShader.includes('uSurfaceExposureTurns * 512.0'), 'unresolved procedural grain is suppressed');
assert(shader.fragmentShader.includes('#include <lights_fragment_begin>'), 'solar illumination and terminator stay physical');
generic.dispose();
console.log('smoke-surface-exposure passed: deterministic linear-light periodic integrals, latitude/flipY, bounded storage, 30/60/120 Hz reverse/high-rate frame sequences, exact pause, lifecycle, Earth cloud/night and material integration');
