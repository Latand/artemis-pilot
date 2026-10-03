// Isolated production-material WebGL fixture. It deliberately excludes the
// atmosphere, galaxy, ship scene, labels and application clock. No performance
// or full-application acceptance is inferred from these bounded renderings.
import * as THREE from 'three';
import { captureCloudRasterProvenance } from './cloud-raster-provenance.mjs';
import { R_EARTH, K } from '../src/constants.js';
import { earthSurfaceMaterial, createEarthCloudMaterial, updateEarthSurfaceExposure, EARTH_CLOUD_HEIGHT_KM } from '../src/render/planetAppearance.js';
import { registerEarthCloudGround } from '../src/render/cloudDepthGuard.js';
import { createEarthCloudGeometry } from '../src/render/earthCloudGeometry.js';
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
export const FAILURE_REPLAY_MODES = ['unbiased', 'guarded', 'oracle', 'always-depth-oracle'];
export function failureReplayPlan(spec, originalNear = NEAR) {
    if (spec.kind !== 'clear' || !Number.isFinite(spec.distance)) throw new Error('Failure replay requires the exact failed clear case');
    const nearestCloudDepth = spec.distance - CLOUD_RADIUS;
    const diagnosticNear = Math.min(1, nearestCloudDepth * .5);
    if (!(diagnosticNear > originalNear && diagnosticNear < nearestCloudDepth)) throw new Error('No safe larger-near diagnostic for this camera');
    return [
        { label: 'original-msaa', alternateContext: false, near: originalNear },
        { label: 'larger-near-msaa', alternateContext: false, near: diagnosticNear },
        { label: 'original-near-no-msaa', alternateContext: true, near: originalNear },
    ];
}
function encodeImage(name, bytes) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = SIZE;
    const context = canvas.getContext('2d'), pixels = new Uint8ClampedArray(bytes.length);
    for (let y = 0; y < SIZE; y++) pixels.set(bytes.subarray(y * SIZE * 4, (y + 1) * SIZE * 4), (SIZE - 1 - y) * SIZE * 4);
    context.putImageData(new ImageData(pixels, SIZE, SIZE), 0, 0);
    return { name, data: canvas.toDataURL('image/png').split(',')[1] };
}

export function makeGeometry(tier) {
    return {
        ground: new THREE.SphereGeometry(RADIUS, tier === 'mobile' ? 48 : 96, tier === 'mobile' ? 32 : 72),
        cloud: createEarthCloudGeometry(CLOUD_RADIUS, tier === 'mobile'),
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
        if (q.mode === 'unbiased' || q.mode === 'oracle' || q.mode === 'always-depth-oracle') this.polygonOffset = false;
        if (q.mode === 'fixed-bias-diagnostic') this.polygonOffset = true;
        if (q.mode === 'oracle' || q.mode === 'always-depth-oracle') {
            if (q.probe.visible || relUniforms.uBeta.value !== 0 || q.case.kind !== 'clear') throw new Error('Ordering oracle must never contain a foreground object or relativity');
            this.depthTest = q.mode === 'always-depth-oracle';
            if (q.mode === 'always-depth-oracle') this.depthFunc = THREE.AlwaysDepth;
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
        q.mode = mode; const material = q.cloud.material, before = q.hookCalls, originalDepthFunc = material.depthFunc;
        if (!material.depthTest || material.depthWrite) throw new Error('Production cloud depth settings were not restored');
        let state;
        try {
            q.renderer.render(q.scene, q.camera); q.renderedFrames++;
            if (q.hookCalls !== before + 1) throw new Error('Production cloud material hook did not execute exactly once');
            state = { guard: { ...q.hookState }, lists: { ...q.drawLists }, offset: material.polygonOffset, depthTest: material.depthTest, depthWrite: material.depthWrite, depthFunc: material.depthFunc };
            const gl = q.renderer.getContext(), bytes = new Uint8Array(SIZE * SIZE * 4);
            gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
            const error = gl.getError(); if (error !== gl.NO_ERROR || gl.isContextLost()) throw new Error(`Invalid GL readback ${error}`);
            return { bytes, state };
        } finally { material.depthTest = true; material.depthFunc = originalDepthFunc; q.mode = 'guarded'; }
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
    q.images = () => Object.entries(q.last).map(([name, bytes]) => encodeImage(name, bytes));
    q.preparation = () => ({ ...surfaceExposurePreparation });
    q.environment = () => {
        const gl = q.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
        return { size: SIZE, webgl2: q.renderer.capabilities.isWebGL2, depthBits: gl.getParameter(gl.DEPTH_BITS), samples: gl.getParameter(gl.SAMPLES),
            renderer: gl.getParameter(gl.RENDERER), vendor: gl.getParameter(gl.VENDOR), unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
            contextAttributes: gl.getContextAttributes(), innerWidth,
            maps: q.maps.map(map => ({ source: new URL(map.image.src).pathname, width: map.image.width, height: map.image.height })),
            geometry: Object.fromEntries(Object.entries(q.geometries).map(([tier, geometries]) => [tier, { groundTriangles: geometries.ground.index.count / 3, cloud: containmentProof(geometries.cloud) }])) };
    };
    q.failureProvenance = browserVersion => captureCloudRasterProvenance({ renderer: q.renderer, earthMaterial: q.earth.material, cloudMaterial: q.cloud.material, browserVersion });
    // Failure diagnostics only. These rows never replace a failed acceptance
    // result and are never compared across antialiasing contexts as a gate.
    q.failureReplay = spec => {
        if (spec.kind !== 'clear' || JSON.stringify(spec) !== JSON.stringify(q.case)) throw new Error('Replay must use exactly the preserved failed clear case');
        if (q.probe.visible || BH.n !== 0 || relUniforms.uBeta.value !== 0) throw new Error('Failure replay requires the isolated non-relativistic Earth/cloud scene');
        const material = q.cloud.material, originalGL = q.renderer.getContext();
        const depthFunctions = new Map([[originalGL.NEVER, THREE.NeverDepth], [originalGL.ALWAYS, THREE.AlwaysDepth], [originalGL.LESS, THREE.LessDepth],
            [originalGL.LEQUAL, THREE.LessEqualDepth], [originalGL.EQUAL, THREE.EqualDepth], [originalGL.GEQUAL, THREE.GreaterEqualDepth],
            [originalGL.GREATER, THREE.GreaterDepth], [originalGL.NOTEQUAL, THREE.NotEqualDepth]]);
        const saved = { renderer: q.renderer, near: q.camera.near, projection: q.camera.projectionMatrix.clone(), inverseProjection: q.camera.projectionMatrixInverse.clone(),
            case: q.case, mode: q.mode, last: q.last, hookState: q.hookState, drawLists: q.drawLists, guard: { ...material.userData.cloudDepthGuard },
            depthTest: material.depthTest, depthWrite: material.depthWrite, depthFunc: material.depthFunc, offset: material.polygonOffset,
            factor: material.polygonOffsetFactor, units: material.polygonOffsetUnits, physical: q.physical(), programs: JSON.stringify(q.programs()),
            frames: q.renderedFrames, hooks: q.hookCalls, actualDepth: { test: originalGL.isEnabled(originalGL.DEPTH_TEST), write: originalGL.getParameter(originalGL.DEPTH_WRITEMASK),
                func: originalGL.getParameter(originalGL.DEPTH_FUNC), offset: originalGL.isEnabled(originalGL.POLYGON_OFFSET_FILL),
                factor: originalGL.getParameter(originalGL.POLYGON_OFFSET_FACTOR), units: originalGL.getParameter(originalGL.POLYGON_OFFSET_UNITS) } };
        const stages = failureReplayPlan(spec, saved.near), maximumFrames = stages.length * FAILURE_REPLAY_MODES.length + 5;
        const result = { diagnosticOnly: true, acceptanceUnchanged: true, case: { ...spec }, maximumFrames,
            note: 'AlwaysDepth keeps depth testing enabled but unconditionally accepts cloud samples; cloud depth writes stay off. The larger near plane changes depth precision only and is not a proposed production change. No cross-antialias pixel comparison is an acceptance gate.',
            contexts: [], errors: [], restored: null };
        let secondary;
        try {
            for (const stage of stages) {
                if (stage.alternateContext) {
                    const attributes = saved.renderer.getContext().getContextAttributes();
                    secondary = new THREE.WebGLRenderer({ alpha: attributes.alpha, antialias: false, depth: attributes.depth, stencil: attributes.stencil,
                        premultipliedAlpha: attributes.premultipliedAlpha, preserveDrawingBuffer: true, precision: saved.renderer.capabilities.precision });
                    secondary.setPixelRatio(saved.renderer.getPixelRatio()); secondary.setSize(SIZE, SIZE);
                    secondary.setClearColor(saved.renderer.getClearColor(new THREE.Color()), saved.renderer.getClearAlpha());
                    for (const key of ['outputColorSpace', 'toneMapping', 'toneMappingExposure', 'autoClear', 'autoClearColor', 'autoClearDepth', 'autoClearStencil', 'sortObjects']) secondary[key] = saved.renderer[key];
                    q.renderer = secondary;
                } else q.renderer = saved.renderer;
                q.camera.near = stage.near; q.camera.updateProjectionMatrix(); q.configure(spec);
                const context = { ...stage, actual: q.environment(), near: q.camera.near, far: q.camera.far,
                    nearestCloudDepth: spec.distance - CLOUD_RADIUS,
                    nearPlaneInFrontOfWholePlanet: q.camera.near < spec.distance - CLOUD_RADIUS,
                    xyProjectionUnchanged: q.camera.projectionMatrix.elements.every((value, i) => i === 10 || i === 14 || value === saved.projection.elements[i]),
                    draws: {}, comparisons: {}, images: [] };
                result.contexts.push(context);
                const frames = {};
                for (const mode of FAILURE_REPLAY_MODES) {
                    if (q.renderedFrames - saved.frames >= maximumFrames) throw new Error('Failure replay draw budget exceeded');
                    const frame = q.render(mode); frames[mode] = frame.bytes; context.draws[mode] = frame.state;
                    context.images.push(encodeImage(mode, frame.bytes));
                }
                context.comparisons = {
                    guardedVsUnbiased: difference(frames.guarded, frames.unbiased),
                    guardedVsDepthDisabledOracle: difference(frames.guarded, frames.oracle),
                    guardedVsAlwaysDepthOracle: difference(frames.guarded, frames['always-depth-oracle']),
                    alwaysDepthVsDepthDisabledOracle: difference(frames['always-depth-oracle'], frames.oracle),
                    unbiasedVsDepthDisabledOracle: difference(frames.unbiased, frames.oracle),
                };
                if (stage.label === 'original-msaa') context.replayVsPreservedFailure = {
                    baseline: difference(frames.unbiased, saved.last.baseline), guarded: difference(frames.guarded, saved.last.guarded),
                    oracle: difference(frames.oracle, saved.last['isolated-ordering-oracle']),
                };
            }
            // Independent same-context coverage masks. These diagnose whether
            // rejected MSAA pixels are truly partial silhouettes; they never
            // exclude pixels from the original strict acceptance comparison.
            q.renderer = saved.renderer; q.camera.near = saved.near;
            q.camera.updateProjectionMatrix(); q.configure(spec);
            const beforeMasks = { earthVisible: q.earth.visible, cloudVisible: q.cloud.visible,
                alphaMap: material.alphaMap, opacity: material.opacity,
                turns: material.userData.surfaceRotationExposure.turns.value, programs: JSON.stringify(q.programs()) };
            const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
            white.generateMipmaps = false; white.wrapS = THREE.RepeatWrapping; white.needsUpdate = true;
            const coverage = { label: 'original-msaa-coverage', diagnosticOnly: true,
                actual: q.environment(), images: [], draws: {}, classifications: {}, restoration: null };
            result.contexts.push(coverage);
            let earthMask, cloudMask;
            try {
                q.cloud.visible = false; q.earth.visible = true;
                const previousHooks = q.hookCalls;
                q.renderer.render(q.scene, q.camera); q.renderedFrames++;
                if (q.hookCalls !== previousHooks) throw new Error('Earth-only mask unexpectedly drew clouds');
                const gl = q.renderer.getContext(); earthMask = new Uint8Array(SIZE * SIZE * 4);
                gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, earthMask);
                if (gl.getError() !== gl.NO_ERROR || gl.isContextLost()) throw new Error('Invalid Earth mask readback');
                coverage.draws.earth = { originalMaterial: true, expectedOpaqueAlpha: 1, programs: q.programs() };
                q.earth.visible = false; q.cloud.visible = true;
                material.alphaMap = white; material.opacity = 1;
                material.userData.surfaceRotationExposure.turns.value = 0;
                const cloudFrame = q.render('oracle'); cloudMask = cloudFrame.bytes;
                coverage.draws.cloud = { sameCompiledMaterial: true, whiteAlphaMap: true, opacity: 1, exposureTurns: 0,
                    state: cloudFrame.state, programs: q.programs() };
                coverage.images.push(encodeImage('earth-coverage-mask', earthMask), encodeImage('cloud-coverage-mask', cloudMask));
                const classify = (a, b) => {
                    const counts = { bothFull: 0, partial: 0, eitherZero: 0, total: 0 }, pixels = [];
                    for (let i = 0; i < a.length; i += 4) {
                        if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
                        const ea = earthMask[i + 3], ca = cloudMask[i + 3];
                        const category = ea === 255 && ca === 255 ? 'bothFull' : ea === 0 || ca === 0 ? 'eitherZero' : 'partial';
                        counts[category]++; counts.total++;
                        pixels.push({ x: (i / 4) % SIZE, y: Math.floor(i / 4 / SIZE), earthAlpha: ea, cloudAlpha: ca, category });
                    }
                    return { counts, pixels };
                };
                coverage.classifications = {
                    baselineVsOracle: classify(saved.last.baseline, saved.last['isolated-ordering-oracle']),
                    guardedVsOracle: classify(saved.last.guarded, saved.last['isolated-ordering-oracle']),
                    guardedVsBaseline: classify(saved.last.guarded, saved.last.baseline),
                };
            } finally {
                q.earth.visible = beforeMasks.earthVisible; q.cloud.visible = beforeMasks.cloudVisible;
                material.alphaMap = beforeMasks.alphaMap; material.opacity = beforeMasks.opacity;
                material.userData.surfaceRotationExposure.turns.value = beforeMasks.turns;
                white.dispose();
            }
            // Three exact replays verify restoration after the two mask draws.
            const replay = {};
            for (const [mode, key] of [['unbiased', 'baseline'], ['guarded', 'guarded'], ['oracle', 'isolated-ordering-oracle']]) {
                const frame = q.render(mode);
                replay[key] = difference(frame.bytes, saved.last[key]);
            }
            coverage.restoration = { comparisons: replay, originalMap: material.alphaMap === beforeMasks.alphaMap,
                opacity: material.opacity === beforeMasks.opacity, exposureTurns: material.userData.surfaceRotationExposure.turns.value === beforeMasks.turns,
                programs: JSON.stringify(q.programs()) === beforeMasks.programs, physical: q.physical() === saved.physical };
            if (q.renderedFrames - saved.frames > maximumFrames) throw new Error('Coverage diagnostic exceeded its fixed five additional draws');
        } catch (error) { result.errors.push(error.stack || String(error)); }
        finally {
            q.renderer = saved.renderer; q.camera.near = saved.near;
            q.camera.projectionMatrix.copy(saved.projection); q.camera.projectionMatrixInverse.copy(saved.inverseProjection);
            material.depthTest = saved.depthTest; material.depthWrite = saved.depthWrite; material.depthFunc = saved.depthFunc;
            material.polygonOffset = saved.offset; material.polygonOffsetFactor = saved.factor; material.polygonOffsetUnits = saved.units;
            Object.assign(material.userData.cloudDepthGuard, saved.guard);
            q.case = saved.case; q.mode = saved.mode; q.last = saved.last; q.hookState = saved.hookState; q.drawLists = saved.drawLists;
            saved.renderer.state.buffers.depth.setFunc(depthFunctions.get(saved.actualDepth.func));
            saved.renderer.state.buffers.depth.setTest(saved.actualDepth.test); saved.renderer.state.buffers.depth.setMask(saved.actualDepth.write);
            saved.renderer.state.setPolygonOffset(saved.actualDepth.offset, saved.actualDepth.factor, saved.actualDepth.units);
            if (secondary) {
                try { secondary.dispose(); secondary.forceContextLoss(); } catch (error) { result.errors.push('Secondary-context cleanup: ' + String(error)); }
            }
            result.renderedFrames = q.renderedFrames - saved.frames; result.hookCalls = q.hookCalls - saved.hooks;
            result.restored = { renderer: q.renderer === saved.renderer, near: q.camera.near === saved.near,
                projection: q.camera.projectionMatrix.equals(saved.projection) && q.camera.projectionMatrixInverse.equals(saved.inverseProjection),
                physical: q.physical() === saved.physical, programs: JSON.stringify(q.programs()) === saved.programs,
                actualGLDepth: originalGL.isEnabled(originalGL.DEPTH_TEST) === saved.actualDepth.test && originalGL.getParameter(originalGL.DEPTH_WRITEMASK) === saved.actualDepth.write &&
                    originalGL.getParameter(originalGL.DEPTH_FUNC) === saved.actualDepth.func && originalGL.isEnabled(originalGL.POLYGON_OFFSET_FILL) === saved.actualDepth.offset,
                originalPixels: q.last === saved.last, material: material.depthTest === saved.depthTest && material.depthWrite === saved.depthWrite && material.depthFunc === saved.depthFunc && material.polygonOffset === saved.offset,
                nearValue: q.camera.near, depthFunc: material.depthFunc, depthTest: material.depthTest, depthWrite: material.depthWrite };
        }
        return result;
    };
    q.configure({ kind: 'clear', tier: 'desktop', distance: 60, phase: 0, mode: 'active' });
    q.ready = true;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.cloudDepthQA = { ready: false, error: null };
    start().catch(error => { window.cloudDepthQA.error = error.stack || String(error); });
}
