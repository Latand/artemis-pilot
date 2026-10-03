import * as THREE from 'three';
import { earthSurfaceMaterial, updateEarthSurfaceExposure } from '../src/render/planetAppearance.js';
import { surfaceExposurePreparation } from '../src/render/surfaceRotationExposure.js';
import { integrateLongitudeRow } from '../src/render/surfaceExposureMath.js';

const q = window.surfaceWorkerQA = { renderer: null, lost: 0, restored: 0 };
const start = async () => {
    const loader = new THREE.TextureLoader();
    q.maps = await Promise.all(['2k_earth_daymap.jpg', '2k_earth_nightmap.jpg', '2k_earth_clouds.jpg'].map(name => loader.loadAsync('/textures/' + name)));
    q.maps[0].colorSpace = q.maps[1].colorSpace = THREE.SRGBColorSpace;
    q.maps[2].colorSpace = THREE.NoColorSpace;
    q.renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    q.renderer.setSize(256, 256); q.renderer.setPixelRatio(1);
    q.renderer.outputColorSpace = THREE.SRGBColorSpace; q.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    document.body.appendChild(q.renderer.domElement);
    q.renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); q.lost++; });
    q.renderer.domElement.addEventListener('webglcontextrestored', () => q.restored++);
    q.scene = new THREE.Scene(); q.camera = new THREE.PerspectiveCamera(40, 1, .1, 10); q.camera.position.z = 3.5;
    q.earth = earthSurfaceMaterial(...q.maps, 1);
    q.earth.uniforms.sunDir.value.set(.6, .15, .785).normalize(); q.earth.uniforms.uCamera.value.copy(q.camera.position);
    q.clouds = new THREE.MeshLambertMaterial({ alphaMap: q.maps[2], transparent: true });
    q.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), q.earth));
    q.spin = 2 * Math.PI / 86164; q.cloudSpin = q.spin + 2 * Math.PI / (14 * 86400); q.shutter = 256 * 86400 / 30;
    updateEarthSurfaceExposure(q.earth, q.clouds, q.spin, q.cloudSpin, q.shutter);
    q.ready = true;
};
q.update = () => updateEarthSurfaceExposure(q.earth, q.clouds, q.spin, q.cloudSpin, q.shutter);
q.preparation = () => ({ ...surfaceExposurePreparation });
q.render = () => {
    q.renderer.render(q.scene, q.camera);
    const gl = q.renderer.getContext(), pixels = new Uint8Array(256 * 256 * 4);
    gl.finish(); gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError() !== 0 || gl.isContextLost()) throw new Error('Invalid fixture GL readback');
    return pixels;
};
q.capture = async () => {
    const pixels = q.render();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', pixels))].map(v => v.toString(16).padStart(2, '0')).join('');
    return { hash, resources: { ...q.renderer.info.memory }, preparation: q.preparation(),
        prefixes: q.earth.userData.surfaceRotationExposure.slots.map(slot => ({ id: slot.texture.uuid, bytes: slot.texture.image.data.byteLength })) };
};
// Deliberate diagnostic recreation of the previous main-thread row path. Run
// only after the new-path 16 ms metric has been recorded; it never contributes
// to production maxSliceMs and never replaces the unchanged gate.
q.legacyProbe = () => q.maps.map((source, index) => {
    const slot = q.earth.userData.surfaceRotationExposure.slots[index], [width, height] = slot.size.value.toArray();
    const sw = source.image.width, sh = source.image.height, data = new Float32Array((width + 1) * height * 4);
    const start = performance.now(), canvas = document.createElement('canvas'); canvas.width = sw; canvas.height = Math.ceil(sh / height) + 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const timing = { setupMs: performance.now() - start, drawMs: 0, readMs: 0, mathMs: 0, maxDrawMs: 0, maxReadMs: 0, maxMathMs: 0, maxCombinedRowMs: 0 };
    for (let row = 0; row < height; row++) {
        const rowStart = performance.now(), sourceRow = source.flipY ? height - 1 - row : row;
        const y0 = Math.floor(sourceRow * sh / height), y1 = Math.floor((sourceRow + 1) * sh / height);
        let t = performance.now(); context.clearRect(0, 0, sw, y1 - y0); context.drawImage(source.image, 0, y0, sw, y1 - y0, 0, 0, sw, y1 - y0);
        let ms = performance.now() - t; timing.drawMs += ms; timing.maxDrawMs = Math.max(timing.maxDrawMs, ms);
        t = performance.now(); const bytes = context.getImageData(0, 0, sw, y1 - y0).data;
        ms = performance.now() - t; timing.readMs += ms; timing.maxReadMs = Math.max(timing.maxReadMs, ms);
        t = performance.now(); integrateLongitudeRow(data, bytes, sw, y1 - y0, width, row, source.colorSpace === THREE.SRGBColorSpace);
        ms = performance.now() - t; timing.mathMs += ms; timing.maxMathMs = Math.max(timing.maxMathMs, ms);
        timing.maxCombinedRowMs = Math.max(timing.maxCombinedRowMs, performance.now() - rowStart);
    }
    const actual = slot.texture.image.data;
    let maxDifference = 0, differingFloats = 0;
    for (let i = 0; i < data.length; i++) { maxDifference = Math.max(maxDifference, Math.abs(data[i] - actual[i])); if (data[i] !== actual[i]) differingFloats++; }
    canvas.width = canvas.height = 1;
    return { source: source.image.src, width, height, timing, maxDifference, differingFloats, exact: differingFloats === 0 };
});
start().catch(error => { q.error = error.stack || String(error); });
