// Served from the HEAD harness while imports resolve against the source tree
// under test. These are live application objects and live catalog records.
import * as THREE from '/node_modules/three/build/three.module.js';
import * as s from '/src/scene.js';
import { G } from '/src/state.js';
import { K, MPC_KM } from '/src/constants.js';
import * as population from '/src/render/galaxyPopulationRender.js';
import { mergerTidesStatus } from '/src/render/mergerTidesRender.js';
import { renderLinearFrame } from '/src/render/linearFrame.js';
const MPC = K * MPC_KM;
const GYR_S = 1e9 * 31557600;
const LY = MPC / 3.2615637771674e6;
const state = { test: null, gid: null, desired: null, shaderErrors: [], normalExposure: new Map() };
const mark = name => console.log('EXTERNAL_QA_PHASE ' + JSON.stringify({ name, browserMs: Math.round(performance.now()),
    programs: s.renderer.info.programs?.length || 0, geometries: s.renderer.info.memory.geometries,
    textures: s.renderer.info.memory.textures }));
const demand = (pass, message) => { if (!pass) throw new Error(message); };
const v3 = a => new THREE.Vector3(...a);
const axisMap = p => new THREE.Vector3(p[0], p[2], -p[1]);
export function initialize() {
    s.renderer.setAnimationLoop(null); G.paused = true; G.gr = false; G.predict = false;
    G.constellations = false; G.uiMode = 'observe'; G.darkEnergy = false; G.darkMatter = false;
    document.getElementById('intro').style.display = 'none';
    s.renderer.debug.checkShaderErrors = true;
    s.renderer.debug.onShaderError = (gl, program, vertex, fragment) => state.shaderErrors.push({
        program: gl.getProgramInfoLog(program), vertex: gl.getShaderInfoLog(vertex), fragment: gl.getShaderInfoLog(fragment),
        vertexSource: gl.getShaderSource(vertex), fragmentSource: gl.getShaderSource(fragment),
    });
    const gl = s.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { mobile: s.renderQuality.mobile, dpr: s.renderer.getPixelRatio(), size: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION) };
}
function targetRecord(name = state.test.target) {
    const ps = population.externalGalaxyQaState(), cat = population.galaxyCatalog();
    const nameId = cat.names.indexOf(name), gid = Array.from(cat.name).indexOf(nameId);
    demand(nameId >= 0 && gid >= 0, `Missing catalog target: ${name}`);
    const mesh = ps.chunks.find(m => m.userData.source.gid.includes(gid));
    demand(mesh, `No live production chunk contains ${name}`);
    const index = mesh.userData.source.gid.indexOf(gid), a = mesh.geometry.attributes;
    const normal = axisMap([a.aShape.getX(index), a.aShape.getY(index), a.aShape.getZ(index)]).normalize();
    const scale = a.aPhot.getZ(index) * .001 * MPC;
    const gc = v3(window.__externalGalaxyApp.gc());
    const unit = v3([a.aUnit.getX(index), a.aUnit.getY(index), a.aUnit.getZ(index)]).add(v3(mesh.userData.center));
    const delta = v3([a.aDelta.getX(index), a.aDelta.getY(index), a.aDelta.getZ(index)]);
    // This is exact for Local Group fixtures; present-day external fixtures
    // differ from light-cone distance only below ~0.1%, recorded explicitly.
    const center = axisMap(unit.multiplyScalar(ps.shared.uAObs.value).add(delta).toArray()).multiplyScalar(MPC).add(gc);
    const u = new THREE.Vector3().crossVectors(normal, Math.abs(normal.y) > .9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(normal, u).normalize();
    return { mesh, index, gid, normal, u, v, center, scale, q: a.aShape.getW(index), type: cat.T[gid], provenance: cat.prov[gid] };
}
function positionCamera(test, record) {
    const { center, normal: n, u, v, scale: h } = record;
    let eye, aim;
    const distance = test.distanceKpc ? test.distanceKpc * .001 * MPC : test.height * h;
    if (test.view === 'exactcenter' || test.view === 'nearcenterbehind') {
        eye = center.clone().addScaledVector(u, (test.offsetLy || 0) * LY);
        aim = eye.clone().addScaledVector(u, h);
    } else if (test.view === 'catalog') {
        eye = center.clone().addScaledVector(center.clone().negate().normalize(), distance); aim = center.clone();
    } else if (test.view === 'edge') {
        eye = center.clone().addScaledVector(u, distance).addScaledVector(n, .04 * h); aim = center.clone();
    } else if (test.view === 'offaxis') {
        eye = center.clone().addScaledVector(n, distance); aim = center.clone().addScaledVector(u, test.aim * h);
    } else if (test.view === 'behind') {
        eye = center.clone().addScaledVector(u, test.radius * h).addScaledVector(n, distance);
        aim = eye.clone().addScaledVector(u, h).addScaledVector(n, -.09 * h);
    } else if (test.view === 'diskpatch') {
        aim = center.clone().addScaledVector(u, test.radius * h).addScaledVector(v, .35 * h);
        eye = aim.clone().addScaledVector(n, distance);
    } else { eye = center.clone().addScaledVector(n, distance); aim = center.clone(); }
    const offset = eye.clone().sub(aim);
    s.cam.tgt.copy(aim); s.cam.dist = offset.length(); s.cam.distTarget = null;
    s.cam.yaw = Math.atan2(offset.z, offset.x); s.cam.pitch = Math.asin(offset.y / offset.length());
    s.setCamRoll(test.roll || 0); s.camera.fov = 48; s.camera.updateProjectionMatrix();
    G.focus = 'free'; s.applyCamera();
    state.desired = { eye: eye.toArray(), aim: aim.toArray() };
}
export function prepare(test) {
    state.test = test; window.__externalGalaxyApp.setEpoch((test.epochGyr || 0) * GYR_S);
    // A state frame first positions M31 at this epoch, then the next updates
    // its retarded position at the new observer. A second placement absorbs
    // that small shift; both revisions receive the same cadence.
    mark('prepare-initial-state'); frame();
    mark('prepare-first-camera'); positionCamera(test, targetRecord()); frame();
    mark('prepare-refine-camera'); positionCamera(test, targetRecord());
    state.centerPlacement = null;
    if (test.view === 'exactcenter' || test.view === 'nearcenterbehind') {
        const trace = [];
        for (let i = 0; i < 6; i++) {
            mark('prepare-center-convergence-' + i);
            const before = targetRecord(); positionCamera(test, before); frame();
            const after = targetRecord();
            const shiftLy = after.center.distanceTo(before.center) / LY;
            trace.push({ iteration: i, centerShiftLy: shiftLy, actualOffsetLy: s.camera.position.distanceTo(after.center) / LY });
            if (shiftLy < 1e-7) break;
        }
        // Final placement uses the actual live attribute row, not the catalog
        // or an approximate requested center. capture() measures it again.
        positionCamera(test, targetRecord()); state.centerPlacement = trace;
    }
    population.externalGalaxyQaResetMeter();
    const r = targetRecord(); state.gid = r.gid;
    return { name: test.target, id: r.gid, type: r.type, provenance: r.provenance, scaleKpc: r.scale / MPC * 1000,
        normalScene: r.normal.toArray(), catalogCenterScene: r.center.toArray(), requestedCamera: state.desired, epochSeconds: G.t,
        requestedCenterOffsetLy: test.offsetLy ?? null, centerPlacement: state.centerPlacement };
}
export function epochReady() { const status = mergerTidesStatus(); if (status.error) throw new Error(status.error); return !status.started || status.ready; }
export function frame() {
    mark('app-frame-start'); const start = performance.now(); window.__externalGalaxyApp.frame();
    mark('app-frame-submitted'); s.renderer.getContext().finish(); const elapsed = performance.now() - start;
    mark('app-frame-finished'); return elapsed;
}
function pixels() {
    const gl = s.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const data = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    let sum = 0, sum2 = 0, nonblack = 0, clipped = 0, peak = 0, gradient = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, l = .2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2];
        sum += l; sum2 += l * l; peak = Math.max(peak, l); if (l > 3) nonblack++;
        if (Math.max(data[i], data[i + 1], data[i + 2]) >= 254) clipped++;
        if (x) gradient += Math.abs(l - (.2126 * data[i - 4] + .7152 * data[i - 3] + .0722 * data[i - 2]));
    }
    const n = w * h;
    return { meanLuma: sum / n, lumaStdDev: Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2)), peakLuma: peak,
        nonblackFraction: nonblack / n, clippedFraction: clipped / n, horizontalGradientMean: gradient / n };
}
function geometryCoverage(r) {
    const camera = s.camera, center = r.center.clone().applyMatrix4(camera.matrixWorldInverse);
    const projected = r.center.clone().project(camera);
    const origin = camera.position.clone().sub(r.center);
    const coords = p => new THREE.Vector3(p.dot(r.u) / r.scale, p.dot(r.v) / r.scale, p.dot(r.normal) / (r.scale * Math.max(.06, r.q)));
    const o = coords(origin); let intersecting = 0, total = 0;
    // Independent conservative ellipsoid/ray geometry. It says only whether
    // luminous support can overlap the screen, not what morphology must be.
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
        // Form a direction without adding a near-plane offset to the huge
        // extragalactic observer position (that subtraction can become zero).
        const p = camera.projectionMatrix.elements;
        const ray = new THREE.Vector3((x / 4 * .95 + p[8]) / p[0], (y / 4 * .95 + p[9]) / p[5], -1)
            .applyQuaternion(camera.quaternion).normalize();
        const d = coords(ray), a = d.lengthSq(), b = 2 * o.dot(d), c = o.lengthSq() - 6.5 ** 2, disc = b * b - 4 * a * c;
        if (disc >= 0 && (-b + Math.sqrt(disc)) / (2 * a) > 0) intersecting++; total++;
    }
    return { centerCameraZ: center.z, centerNdc: projected.toArray(), centerBehind: center.z > 0,
        centerOutside: center.z > 0 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1,
        conservativeSupportRayFraction: intersecting / total };
}
function targetDiagnostic(record) {
    // A copy of only the actual live instance's attribute row. Material and
    // every uniform are the exact objects just used by the full app.
    mark('target-geometry-copy');
    const original = record.mesh, geometry = original.geometry.clone(), index = record.index;
    for (const [name, attribute] of Object.entries(original.geometry.attributes)) {
        if (!name.startsWith('a') && !(original.isPoints && name === 'position')) continue;
        const data = attribute.array.slice(index * attribute.itemSize, (index + 1) * attribute.itemSize);
        const A = attribute.isInstancedBufferAttribute ? THREE.InstancedBufferAttribute : THREE.BufferAttribute;
        geometry.setAttribute(name, new A(data, attribute.itemSize, attribute.normalized));
    }
    if (geometry.isInstancedBufferGeometry) geometry.instanceCount = 1;
    const mesh = original.isPoints ? new THREE.Points(geometry, original.material) : new THREE.Mesh(geometry, original.material);
    mesh.frustumCulled = false; const scene = new THREE.Scene(); scene.add(mesh);
    const near = s.camera.near, far = s.camera.far, depth = original.material.uniforms.uDepthRange.value.clone();
    const autoClear = s.renderer.autoClear;
    const savedProjection = s.camera.projectionMatrix.clone(), savedProjectionInverse = s.camera.projectionMatrixInverse.clone();
    try {
        // The external galaxy lives in the production far tier. With no
        // foreground or other background hooks, this isolates its pixels.
        s.camera.near = Math.max(near, s.TIER_SPLIT_UNITS); s.camera.updateProjectionMatrix();
        const offset = state.test.projectionOffset || [0, 0];
        if (state.test.projectionOffset) {
            // Only this live-material diagnostic draw is asymmetric. Leave
            // population update uniforms untouched to catch a stale main-eye
            // ray projection. This is not a headset/VR integration claim.
            s.camera.projectionMatrix.elements[8] += offset[0];
            s.camera.projectionMatrix.elements[9] += offset[1];
            s.camera.projectionMatrixInverse.copy(s.camera.projectionMatrix).invert();
        }
        const projection = { kind: state.test.projectionOffset ? 'per-draw asymmetric diagnostic; not headset QA' : 'production symmetric draw',
            offset: [...offset], matrix: s.camera.projectionMatrix.toArray(),
            targetCenterNdc: record.center.clone().project(s.camera).toArray() };
        original.material.uniforms.uDepthRange.value.set(s.camera.near, 1e38);
        s.renderer.setRenderTarget(null); s.renderer.autoClear = true;
        const draw = () => s.renderer.render(scene, s.camera);
        mark('target-draw-start');
        if (!renderLinearFrame(s.renderer, draw)) draw();
        mark('target-draw-submitted');
        s.renderer.getContext().finish();
        mark('target-png-read');
        const png = s.renderer.domElement.toDataURL('image/png');
        mark('target-pixel-read'); const stats = pixels(); mark('target-diagnostic-done');
        return { png, pixels: stats, projection };
    } finally {
        original.material.uniforms.uDepthRange.value.copy(depth);
        s.camera.near = near; s.camera.far = far; s.camera.projectionMatrix.copy(savedProjection); s.camera.projectionMatrixInverse.copy(savedProjectionInverse); s.renderer.autoClear = autoClear; geometry.dispose();
    }
}
export function capture() {
    frame(); const record = targetRecord(), gl = s.renderer.getContext(); s.camera.updateMatrixWorld();
    mark('app-png-read'); const png = s.renderer.domElement.toDataURL('image/png');
    mark('app-pixel-read'); const appPixels = pixels(); mark('app-pixels-done');
    const coverage = geometryCoverage(record), diagnostic = targetDiagnostic(record), errors = [];
    for (let i = 0; i < 16; i++) { const error = gl.getError(); if (!error) break; errors.push(error); }
    const material = record.mesh.material, uniforms = {};
    for (const [name, u] of Object.entries(material.uniforms)) {
        if (typeof u.value === 'number') uniforms[name] = u.value;
        else if (u.value?.isVector2 || u.value?.isVector3) uniforms[name] = u.value.toArray();
    }
    const gain = uniforms.uGainExposure;
    if (state.test.name.endsWith('-normal') && !state.test.epochGyr && Number.isFinite(gain) && gain > 0) {
        state.normalExposure.set(state.test.target, { gain, case: state.test.name });
    }
    const reference = state.normalExposure.get(state.test.target);
    const exposureComparison = { currentGain: gain, normalGain: reference?.gain ?? null,
        referenceCase: reference?.case ?? null, ratio: reference?.gain > 0 ? gain / reference.gain : null,
        boundedNearCase: ['behind', 'exactcenter', 'nearcenterbehind'].includes(state.test.view), maxRatio: 4 };
    const camera = { position: s.camera.position.toArray(), quaternion: s.camera.quaternion.toArray(), near: s.camera.near,
        far: s.camera.far, fov: s.camera.fov, aspect: s.camera.aspect };
    const unresolved = state.test.height >= 1000;
    const actualCenterOffsetLy = s.camera.position.distanceTo(record.center) / LY;
    const centerFixture = ['exactcenter', 'nearcenterbehind'].includes(state.test.view);
    const assertions = {
        fixedEpoch: G.paused && G.t === (state.test.epochGyr || 0) * GYR_S,
        intendedCamera: s.camera.position.distanceTo(v3(state.desired.eye)) < Math.max(1, record.scale * 1e-7),
        finiteCamera: [...camera.position, ...camera.quaternion, camera.near, camera.far].every(Number.isFinite),
        targetBuilt: record.mesh.geometry && record.mesh.visible && record.gid === state.gid,
        catalogProvenance: record.provenance === 1 || record.provenance === 2,
        noWebGLError: !errors.length, noShaderError: !state.shaderErrors.length,
        intendedDiagnosticProjection: !state.test.projectionOffset || (diagnostic.projection.matrix[8] === state.test.projectionOffset[0] && diagnostic.projection.matrix[9] === state.test.projectionOffset[1]),
        targetPixelsPresent: diagnostic.pixels.nonblackFraction > (unresolved ? 0 : .0001),
        behindFixtureActuallyBehind: !['behind', 'nearcenterbehind'].includes(state.test.view) || coverage.centerBehind,
        exactCenterPosition: state.test.view !== 'exactcenter' || actualCenterOffsetLy < 1e-6,
        nearCenterPosition: state.test.view !== 'nearcenterbehind' || Math.abs(actualCenterOffsetLy - state.test.offsetLy) < 1e-5,
        centerFixtureSeesLight: !centerFixture || (coverage.conservativeSupportRayFraction > .9 && diagnostic.pixels.nonblackFraction > .005),
        boundedNearExposure: !exposureComparison.boundedNearCase || (Number.isFinite(exposureComparison.ratio) && exposureComparison.ratio <= exposureComparison.maxRatio),
        offAxisFixtureActuallyOffAxis: state.test.view !== 'offaxis' || coverage.centerOutside,
        supportSurvivesCenterCull: !['behind', 'offaxis'].includes(state.test.view) ||
            (coverage.conservativeSupportRayFraction > .05 && diagnostic.pixels.nonblackFraction > .005),
    };
    return { png, targetPng: diagnostic.png, assertions, pixels: appPixels, targetPixels: diagnostic.pixels, targetProjection: diagnostic.projection, coverage,
        state: { target: state.test.target, type: record.type, provenance: record.provenance, time: G.t, camera,
            actualCenterScene: record.center.toArray(), distanceScaleLengths: s.camera.position.distanceTo(record.center) / record.scale,
            scaleKpc: record.scale / MPC * 1000, actualCenterOffsetLy, requestedCenterOffsetLy: state.test.offsetLy ?? null,
            centerPlacement: state.centerPlacement, exposureComparison, normal: record.normal.toArray(), axialRatio: record.q,
            targetChunkRepresentation: record.mesh.isPoints ? 'points' : 'quads', chunkInstances: record.mesh.geometry.attributes.aT.count,
            population: population.galaxyPopulationStatus(), tides: mergerTidesStatus(), uniforms, mobile: s.renderQuality.mobile,
            render: { ...s.renderer.info.render }, memory: { ...s.renderer.info.memory } },
        glErrors: errors, shaderErrors: state.shaderErrors };
}
