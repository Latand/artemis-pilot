// Isolated production-material WebGL fixture. It deliberately excludes the
// atmosphere, galaxy, ship scene, labels and application clock. No performance
// or full-application acceptance is inferred from these bounded renderings.
import * as THREE from 'three';
import { R_EARTH, K } from '../src/constants.js';
import { earthSurfaceMaterial, createEarthCloudMaterial, updateEarthSurfaceExposure, EARTH_CLOUD_HEIGHT_KM } from '../src/render/planetAppearance.js';
import { registerEarthCloudGround } from '../src/render/cloudDepthGuard.js';
import { surfaceExposurePreparation } from '../src/render/surfaceRotationExposure.js';
import { applyTerrellToMaterial, relUniforms } from '../src/relView.js';

export const SIZE = 512;
export const DISTANCES = [6.5, 8, 15, 25, 60, 200, 1000];
export const GAPS_KM = [1, 3, 6, 25, 250, 10000];
export const RADIUS = R_EARTH * K;
export const CLOUD_RADIUS = (R_EARTH + EARTH_CLOUD_HEIGHT_KM) * K;
export const NEAR = .02;
export const FAR = 9460730.4725808 * .02;
const TAU = 2 * Math.PI;
const MODES = ['paused', 'active', 'reverse'];

export function makeGeometry(tier) {
    return {
        ground: new THREE.SphereGeometry(RADIUS, tier === 'mobile' ? 48 : 96, tier === 'mobile' ? 32 : 72),
        cloud: new THREE.SphereGeometry(CLOUD_RADIUS, 96, tier === 'mobile' ? 64 : 72),
    };
}

// Every face plane of the convex cloud mesh encloses the entire ideal Earth
// sphere. Therefore disabling cloud depth testing is an ordering oracle ONLY
// in the explicitly isolated, no-foreground Earth/cloud scene at beta=0.
export function containmentProof(geometry) {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
    const positions = geometry.attributes.position, indices = geometry.index.array;
    let inradius = Infinity, maximumRadiusError = 0;
    for (let i = 0; i < indices.length; i += 3) {
        a.fromBufferAttribute(positions, indices[i]); b.fromBufferAttribute(positions, indices[i + 1]); c.fromBufferAttribute(positions, indices[i + 2]);
        n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
        if (n.lengthSq() < 1e-24) throw new Error('Degenerate cloud face');
        inradius = Math.min(inradius, Math.abs(n.normalize().dot(a)));
    }
    for (let i = 0; i < positions.count; i++) maximumRadiusError = Math.max(maximumRadiusError, Math.abs(a.fromBufferAttribute(positions, i).length() - CLOUD_RADIUS));
    return { inradius, minimumClearanceKm: (inradius - RADIUS) / K, maximumRadiusError, triangles: indices.length / 3 };
}

export function buildPlan() {
    const cases = [], skipped = [];
    for (const tier of ['desktop', 'mobile']) {
        for (const distance of DISTANCES) {
            // Twelve orientations and independent cloud drifts reproduce the
            // offline precision sweep; both exact and exposed shaders execute.
            for (let phase = 0; phase < 12; phase++) for (const mode of ['paused', 'active']) cases.push({ kind: 'clear', tier, distance, phase, mode });
            for (let i = 0; i < GAPS_KM.length; i++) {
                const gapKm = GAPS_KM[i];
                for (const kind of ['contact', 'limb']) {
                    const depth = (kind === 'contact' ? distance - CLOUD_RADIUS : Math.sqrt(distance ** 2 - CLOUD_RADIUS ** 2)) - gapKm * K;
                    if (depth <= NEAR * 1.1) { skipped.push({ kind, tier, distance, gapKm, reason: 'A physically front probe would lie behind the near plane or camera.' }); continue; }
                    // All requested gaps when actually in front, with exposure
                    // direction and phase distributed across the bounded sweep.
                    cases.push({ kind, tier, distance, gapKm, phase: [0, 3, 7][i % 3], mode: MODES[i % 3] });
                    // A second phase/exposure pair stresses limb intersections.
                    if (kind === 'limb') cases.push({ kind, tier, distance, gapKm, phase: [7, 0, 3][i % 3], mode: MODES[(i + 1) % 3] });
                }
            }
        }
    }
    return { cases, skipped };
}

function difference(a, b) {
    let pixels = 0, channels = 0, maximum = 0, coveragePixels = 0, alphaPixels = 0;
    for (let i = 0; i < a.length; i += 4) {
        let changed = false;
        for (let c = 0; c < 4; c++) { const delta = Math.abs(a[i + c] - b[i + c]); if (delta) { channels++; changed = true; maximum = Math.max(maximum, delta); } }
        if (changed) pixels++;
        if ((a[i + 3] !== 0) !== (b[i + 3] !== 0)) coveragePixels++;
        if (a[i + 3] !== b[i + 3]) alphaPixels++;
    }
    return { pixels, channels, maximum, coveragePixels, alphaPixels };
}
const probePixel = (bytes, i) => bytes[i] === 255 && bytes[i + 1] === 0 && bytes[i + 2] === 255 && bytes[i + 3] === 255;
function foregroundCoverage(baseline, candidate, fixed) {
    let baselinePixels = 0, candidatePixels = 0, lostBaselinePixels = 0, fixedLostBaselinePixels = 0;
    for (let i = 0; i < baseline.length; i += 4) {
        const was = probePixel(baseline, i), is = probePixel(candidate, i);
        if (was) baselinePixels++;
        if (is) candidatePixels++;
        if (was && !is) lostBaselinePixels++;
        if (was && !probePixel(fixed, i)) fixedLostBaselinePixels++;
    }
    return { baselinePixels, candidatePixels, lostBaselinePixels, fixedLostBaselinePixels };
}
async function digest(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
}

async function start() {
    const q = window.cloudDepthQA;
    const { BH } = await import('../src/state.js');
    const loader = new THREE.TextureLoader();
    q.maps = await Promise.all(['2k_earth_daymap.jpg', '2k_earth_nightmap.jpg', '2k_earth_clouds.jpg'].map(name => loader.loadAsync('/textures/' + name)));
    q.maps[0].colorSpace = q.maps[1].colorSpace = THREE.SRGBColorSpace;
    q.maps[2].colorSpace = THREE.NoColorSpace;
    q.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    q.renderer.setPixelRatio(1); q.renderer.setSize(SIZE, SIZE);
    q.renderer.setClearColor(0x000000, 0);
    q.renderer.outputColorSpace = THREE.SRGBColorSpace;
    q.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    document.body.appendChild(q.renderer.domElement);
    q.scene = new THREE.Scene();
    q.camera = new THREE.PerspectiveCamera(48, 1, NEAR, FAR);
    q.geometries = Object.fromEntries(['desktop', 'mobile'].map(tier => [tier, makeGeometry(tier)]));
    for (const meshes of Object.values(q.geometries)) for (const geometry of Object.values(meshes)) geometry.computeBoundingSphere();
    q.earth = new THREE.Mesh(q.geometries.desktop.ground, earthSurfaceMaterial(...q.maps, RADIUS));
    q.earth.name = 'production-earth';
    q.cloud = new THREE.Mesh(q.geometries.desktop.cloud, applyTerrellToMaterial(createEarthCloudMaterial(q.maps[2], () => BH.n > 0)));
    q.cloud.name = 'production-cloud';
    registerEarthCloudGround(q.cloud, q.earth);
    q.probe = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xff00ff, toneMapped: false }));
    q.probe.geometry.computeBoundingSphere(); q.probe.name = 'foreground-contact-probe'; q.probe.visible = false;
    q.scene.add(q.earth, q.cloud, q.probe);
    q.light = new THREE.PointLight(0xffffff, 3, 0, 0);
    q.scene.add(q.light);
    q.spin = TAU / 86164; q.cloudSpin = q.spin + TAU / (14 * 86400);
    q.shutter = .3 * TAU / q.spin;
    q.mode = 'guarded'; q.hookCalls = 0; q.renderedFrames = 0;
    const productionHook = q.cloud.material.onBeforeRender;
    // All draws call the real installed hook, after Three built its render list.
    // Only explicitly named diagnostic controls alter its result afterwards.
    q.cloud.material.onBeforeRender = function(...args) {
        productionHook.apply(this, args); q.hookCalls++;
        q.hookState = { ...this.userData.cloudDepthGuard };
        if (q.mode === 'unbiased' || q.mode === 'oracle') this.polygonOffset = false;
        if (q.mode === 'fixed-bias-diagnostic') this.polygonOffset = true;
        if (q.mode === 'oracle') {
            if (q.probe.visible || relUniforms.uBeta.value !== 0 || q.case.kind !== 'clear') throw new Error('Ordering oracle must never contain a foreground object or relativity');
            this.depthTest = false;
        }
        const lists = q.renderer.renderLists.get(q.scene, 0);
        q.drawLists = { opaque: lists.opaque.length, transmissive: lists.transmissive.length, transparent: lists.transparent.length,
            hasGround: lists.opaque.some(item => item.object === q.earth),
            hasCloud: lists.transparent.some(item => item.object === q.cloud),
            hasProbe: [...lists.opaque, ...lists.transmissive, ...lists.transparent].some(item => item.object === q.probe) };
    };
    q.programs = () => Object.fromEntries([['earth', q.earth], ['cloud', q.cloud]].map(([name, mesh]) => [name,
        [...q.renderer.properties.get(mesh.material).programs?.values() || []].map(program => program.id).sort((a, b) => a - b)]));
    q.configure = spec => {
        q.case = { ...spec }; q.mode = 'guarded'; relUniforms.uBeta.value = 0;
        q.earth.geometry = q.geometries[spec.tier].ground; q.cloud.geometry = q.geometries[spec.tier].cloud;
        q.earth.rotation.set(0, (spec.phase * 2.313) % TAU, 0);
        q.cloud.rotation.set(0, q.earth.rotation.y + spec.phase * .329, 0);
        if (spec.kind === 'limb') {
            q.camera.position.set(0, 0, spec.distance);
            q.tangent = new THREE.Vector3(CLOUD_RADIUS * Math.sqrt(spec.distance ** 2 - CLOUD_RADIUS ** 2) / spec.distance, 0, CLOUD_RADIUS ** 2 / spec.distance);
            q.camera.lookAt(q.tangent);
        } else {
            const yaw = -.4 + spec.phase * .173, pitch = .45 + (spec.phase % 3 - 1) * .23;
            q.camera.position.set(spec.distance * Math.cos(pitch) * Math.sin(yaw), spec.distance * Math.sin(pitch), spec.distance * Math.cos(pitch) * Math.cos(yaw));
            q.camera.lookAt(0, 0, 0);
        }
        q.camera.updateMatrixWorld(); q.scene.updateMatrixWorld(true);
        q.earth.material.uniforms.uCamera.value.copy(q.camera.position).applyMatrix4(q.earth.matrixWorld.clone().invert()).divideScalar(RADIUS);
        q.earth.material.uniforms.uCloudOffset.value = (q.earth.rotation.y - q.cloud.rotation.y) / TAU;
        const sun = q.camera.position.clone().normalize();
        q.light.position.copy(sun).multiplyScalar(100000);
        q.earth.material.uniforms.sunDir.value.copy(sun).transformDirection(q.earth.matrixWorld.clone().invert());
        updateEarthSurfaceExposure(q.earth.material, q.cloud.material, q.spin, q.cloudSpin, spec.mode === 'paused' ? 0 : q.shutter * (spec.mode === 'reverse' ? -1 : 1));
        q.probe.visible = spec.kind !== 'clear';
        q.probe.name = spec.kind + '-foreground-probe';
        if (q.probe.visible) {
            const baseDepth = spec.kind === 'limb' ? Math.sqrt(spec.distance ** 2 - CLOUD_RADIUS ** 2) : spec.distance - CLOUD_RADIUS;
            const depth = baseDepth - spec.gapKm * K;
            if (depth <= NEAR * 1.1) throw new Error('Probe would be behind the near plane');
            const direction = q.camera.getWorldDirection(new THREE.Vector3());
            q.probe.position.copy(q.camera.position).addScaledVector(direction, depth);
            q.probe.quaternion.copy(q.camera.quaternion);
            const size = 2 * depth * Math.tan(24 * Math.PI / 180) * 36 / SIZE;
            q.probe.scale.set(size, size, 1);
            q.probePlacement = { viewDepth: depth, gapKm: spec.gapKm, widthPixels: 36,
                meaning: spec.kind === 'contact' ? 'Ahead of the entire ideal cloud sphere nearest point; all probe points are physically foreground.' : 'Ahead of the ideal tangent along the camera ray; the finite plane intersects the limb and is not uniformly foreground.' };
        } else q.probePlacement = null;
        q.scene.updateMatrixWorld(true);
    };
    q.physical = () => JSON.stringify({ earth: q.earth.matrixWorld.toArray(), cloud: q.cloud.matrixWorld.toArray(), probe: q.probe.matrixWorld.toArray(),
        earthRadius: q.earth.geometry.parameters.radius, cloudRadius: q.cloud.geometry.parameters.radius, projection: q.camera.projectionMatrix.toArray(),
        exposureEarth: q.earth.material.userData.surfaceRotationExposure.turns.value, exposureCloud: q.cloud.material.userData.surfaceRotationExposure.turns.value });
    q.render = mode => {
        q.mode = mode; const material = q.cloud.material, before = q.hookCalls;
        if (!material.depthTest || material.depthWrite) throw new Error('Production cloud depth settings were not restored');
        let state;
        try {
            q.renderer.render(q.scene, q.camera); q.renderedFrames++;
            if (q.hookCalls !== before + 1) throw new Error('Production cloud material hook did not execute exactly once');
            state = { guard: { ...q.hookState }, lists: { ...q.drawLists }, offset: material.polygonOffset, depthTest: material.depthTest, depthWrite: material.depthWrite };
            const gl = q.renderer.getContext(), bytes = new Uint8Array(SIZE * SIZE * 4);
            gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            const error = gl.getError(); if (error !== gl.NO_ERROR || gl.isContextLost()) throw new Error(`Invalid GL readback ${error}`);
            return { bytes, state };
        } finally { material.depthTest = true; q.mode = 'guarded'; }
    };
    q.run = spec => {
        q.configure(spec); const physicalBefore = q.physical();
        const baseline = q.render('unbiased'), guarded = q.render('guarded');
        const control = q.render(spec.kind === 'clear' ? 'oracle' : 'fixed-bias-diagnostic');
        q.last = { baseline: baseline.bytes, guarded: guarded.bytes, [spec.kind === 'clear' ? 'isolated-ordering-oracle' : 'unsafe-fixed-bias-diagnostic']: control.bytes };
        const result = { ...spec, baseline: baseline.state, guarded: guarded.state, control: control.state,
            guardedVsBaseline: difference(guarded.bytes, baseline.bytes), controlVsBaseline: difference(control.bytes, baseline.bytes),
            physicalUnchanged: physicalBefore === q.physical(), programs: q.programs(), probePlacement: q.probePlacement };
        if (spec.kind === 'clear') result.guardedVsOracle = difference(guarded.bytes, control.bytes);
        else result.foreground = foregroundCoverage(baseline.bytes, guarded.bytes, control.bytes);
        return result;
    };
    q.sequence = async (tier, distance) => {
        const sample = async (phase, mode) => { q.configure({ kind: 'clear', tier, distance, phase, mode }); const state = q.render('guarded'); return { hash: await digest(state.bytes), ...state.state, physical: q.physical() }; };
        const paused = await sample(3, 'paused'), repeatedPause = await sample(3, 'paused');
        const active = await sample(3, 'active'), reverse = await sample(3, 'reverse');
        const moved = await sample(7, 'active'), returned = await sample(3, 'active'), pauseAgain = await sample(3, 'paused');
        return { tier, distance, paused, repeatedPause, active, reverse, moved, returned, pauseAgain,
            pausedExact: paused.hash === repeatedPause.hash && paused.hash === pauseAgain.hash,
            reverseExposureExact: active.hash === reverse.hash,
            returnToPhaseExact: active.hash === returned.hash,
            phaseChangesPixels: active.hash !== moved.hash, programs: q.programs() };
    };
    q.policyTransitions = () => {
        const oldBH = BH.n, oldBeta = relUniforms.uBeta.value;
        const states = [];
        try {
            q.configure({ kind: 'clear', tier: 'desktop', distance: 60, phase: 3, mode: 'paused' });
            for (const [name, holes, beta] of [['clear-initial', 0, 0], ['placed-black-hole', 1, 0], ['black-hole-cleared', 0, 0], ['relativistic', 0, .1], ['relativity-cleared', 0, 0]]) {
                BH.n = holes; relUniforms.uBeta.value = beta;
                const baseline = q.render('unbiased'), guarded = q.render('guarded');
                states.push({ name, holes: BH.n, beta: relUniforms.uBeta.value, ...guarded.state, guardedVsBaseline: difference(guarded.bytes, baseline.bytes) });
            }
            return { states, programs: q.programs() };
        } finally { BH.n = oldBH; relUniforms.uBeta.value = oldBeta; }
    };
    q.images = () => Object.entries(q.last).map(([name, bytes]) => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = SIZE;
        const context = canvas.getContext('2d'), pixels = new Uint8ClampedArray(bytes.length);
        for (let y = 0; y < SIZE; y++) pixels.set(bytes.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), (SIZE - 1 - y) * SIZE * 4);
        context.putImageData(new ImageData(pixels, SIZE, SIZE), 0, 0);
        return { name, data: canvas.toDataURL('image/png').split(',')[1] };
    });
    q.preparation = () => ({ ...surfaceExposurePreparation });
    q.environment = () => {
        const gl = q.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
        return { size: SIZE, webgl2: q.renderer.capabilities.isWebGL2, depthBits: gl.getParameter(gl.DEPTH_BITS), samples: gl.getParameter(gl.SAMPLES),
            renderer: gl.getParameter(gl.RENDERER), vendor: gl.getParameter(gl.VENDOR), unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
            contextAttributes: gl.getContextAttributes(), innerWidth,
            maps: q.maps.map(map => ({ source: new URL(map.image.src).pathname, width: map.image.width, height: map.image.height })),
            geometry: Object.fromEntries(Object.entries(q.geometries).map(([tier, geometries]) => [tier, { groundTriangles: geometries.ground.index.count / 3, cloud: containmentProof(geometries.cloud) }])) };
    };
    q.configure({ kind: 'clear', tier: 'desktop', distance: 60, phase: 0, mode: 'active' });
    q.ready = true;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.cloudDepthQA = { ready: false, error: null };
    start().catch(error => { window.cloudDepthQA.error = error.stack || String(error); });
}
