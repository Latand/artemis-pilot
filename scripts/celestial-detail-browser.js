// Loaded virtually from the HEAD harness even when capturing BASE_ROOT.
import * as THREE from '/node_modules/three/build/three.module.js';
import * as s from '/src/scene.js';
import * as b from '/src/bodies.js';
import * as c from '/src/constants.js';
import * as stars from '/src/stars.js';
import { MOONS } from '/src/moons.js';
import { G, BH } from '/src/state.js';
import { eph } from '/src/ephemeris.js';
import { addBlackHole, BH_META } from '/src/blackholes.js';
import { stellarExposure } from '/src/render/stellarAppearance.js';
import { generateSystem } from '/src/universe/planetarySystem.js';
import { celestialQaSlots } from '/src/render/systemBodies.js';

const state = { target: null, quasar: -1, generated: null, shaderErrors: [] };
const require = (ok, message) => { if (!ok) throw new Error(message); };
const vec = () => new THREE.Vector3();
function loadedMap(map) {
    if (!map) return null;
    const image = map.image;
    return { width: image?.width || image?.videoWidth || 0, height: image?.height || image?.videoHeight || 0,
        url: image?.currentSrc || image?.src || null, procedural: !!map.userData?.procedural, colorSpace: map.colorSpace };
}
function materialInfo(material) {
    if (!material) return null;
    const uniforms = {};
    for (const [key, u] of Object.entries(material.uniforms || {})) {
        const v = u.value;
        if (typeof v === 'number' || typeof v === 'boolean') uniforms[key] = v;
        else if (v?.isTexture) uniforms[key] = loadedMap(v);
        else if (v?.toArray && !v.isMatrix4) uniforms[key] = v.toArray();
    }
    return { type: material.type, name: material.name, map: loadedMap(material.map),
        normalMap: loadedMap(material.normalMap), bumpMap: loadedMap(material.bumpMap),
        color: material.color?.toArray(), uniforms, userData: { appearanceProvenance: material.userData.appearanceProvenance, reliefProvenance: material.userData.reliefProvenance, surfaceDetailWidth: material.userData.surfaceDetailWidth, bodyAppearance: material.userData.bodyAppearance, photosphereProfile: material.userData.photosphere?.profile } };
}
function makeGeneratedFixture() {
    // A deterministic, explicitly unobserved system. The actual production
    // generator chooses its architecture; QA never invents a surface map.
    for (let i = 0; i < 64; i++) {
        const host = { id: `celestial-qa-unknown-${i}`, procedural: true, name: 'ILLUSTRATIVE QA HOST',
            x: 12 * c.AU_KM, y: 0, z: 0, R: c.R_SUN, mass: 1, mu: c.MU_S,
            lumSolar: 1, tempK: 5772, kind: 'MS', color: 0xfff1dc };
        const system = generateSystem(host);
        const index = system.planets.findIndex(p => p.moons?.length && !p.observed);
        if (index >= 0) return { ...system, hostStar: host, qaPlanetIndex: index };
    }
    throw new Error('Deterministic generated-system fixture has no planet with a moon');
}
export function initialize() {
    s.renderer.setAnimationLoop(null);
    G.paused = true; G.gr = false; G.predict = false; G.constellations = false; G.uiMode = 'observe';
    G.darkEnergy = false; G.darkMatter = false;
    document.getElementById('intro').style.display = 'none';
    s.renderer.debug.checkShaderErrors = true;
    s.renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
        state.shaderErrors.push({ program: gl.getProgramInfoLog(program), vertex: gl.getShaderInfoLog(vertex),
            fragment: gl.getShaderInfoLog(fragment), vertexSource: gl.getShaderSource(vertex), fragmentSource: gl.getShaderSource(fragment) });
    };
    window.__celestialFrame();
    const gl = s.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { mobile: s.renderQuality.mobile, dpr: s.renderer.getPixelRatio(), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        webglVersion: gl.getParameter(gl.VERSION), toneMapping: s.renderer.toneMapping, toneMappingExposure: s.renderer.toneMappingExposure };
}
export async function prepare(test) {
    window.__celestialSystem = null; s.scene.background = null;
    let target, mesh, radius, focus, model, entry;
    if (test.body === 'EARTH') { target = b.earthG; mesh = b.earth; radius = c.R_EARTH * c.K; focus = 'earth'; }
    else if (test.body === 'MOON') { target = mesh = b.moon; radius = c.R_MOON * c.K; focus = 'moon'; }
    else if (test.body === 'SUN') { target = mesh = b.sunCore; radius = c.SUN_RADIUS; focus = 'sun'; }
    else if (test.body.startsWith('unknown-')) {
        state.generated ||= makeGeneratedFixture();
        window.__celestialSystem = state.generated;
        const i = state.generated.qaPlanetIndex, p = state.generated.planets[i];
        if (test.body === 'unknown-planet') {
            focus = `planet:${i}`; radius = p.radiusKm * c.K; model = p;
        } else { focus = `planet:${i}:moon:0`; radius = p.moons[0].R * c.K; model = p.moons[0]; }
        G.focus = focus;
        // Populate actual production slots, then obtain the actual meshes.
        window.__celestialFrame();
        const slot = celestialQaSlots[i];
        if (test.body === 'unknown-planet') { target = slot.group; mesh = slot.mesh; }
        else { target = mesh = slot.moons[0]; }
        require(!!mesh, 'Generated system mesh was not built');
    } else if (test.body === 'placed-quasar') {
        if (state.quasar < 0) {
            const rsKm = 2 * c.MU_S * 1e9 / (c.C_LIGHT * c.C_LIGHT);
            state.quasar = addBlackHole(0, 0, rsKm, 0, 0, true, null, 1, 0, 0, 0);
            require(state.quasar >= 0, 'Quasar placement failed');
            // Fixture is an established source at this fixed epoch. Avoid a
            // zero-age quasar with a zero-length jet at every paused capture.
            BH_META[state.quasar].tBorn = -300 * rsKm / c.C_LIGHT;
        }
        entry = BH_META[state.quasar]; target = entry.g; mesh = entry.optics?.shadow || entry.horizon;
        radius = BH.rs[state.quasar] * c.K; focus = `bh:${state.quasar}`;
    } else {
        const pi = c.PL.findIndex(p => p.name === test.body), mi = MOONS.findIndex(m => m.name === test.body);
        if (pi >= 0) { target = b.plGroups[pi]; mesh = b.plSurfaces[pi]; radius = c.PL[pi].R * c.K; focus = pi; model = c.PL[pi]; }
        else if (mi >= 0) { target = b.moonGroups[mi]; mesh = b.moonSurfaces[mi]; radius = MOONS[mi].R * c.K; focus = `moon:${mi}`; model = MOONS[mi]; }
        else {
            const si = c.STARS.findIndex(star => star.name === test.body);
            require(si >= 0, `Missing named destination ${test.body}`);
            model = c.STARS[si]; entry = stars.addStarVisual(model); target = entry.g;
            mesh = entry.photosphere || entry.optics?.shadow || entry.horizon || entry.g.children.find(o => o.isMesh);
            radius = (model.bh ? model.rs : model.R) * c.K; focus = `star:${si}`;
            if (entry.disk) entry.disk.rotation.z = 0;
        }
    }
    require(target && mesh && radius > 0, `Missing target surface ${test.body}`);
    G.focus = focus; s.cam.distTarget = null; s.cam.dist = radius * test.radii;
    // One state update positions the focused production object before camera
    // placement. Then use an illuminated-side view, without moving its light.
    window.__celestialFrame(); s.scene.updateMatrixWorld(true);
    const position = target.getWorldPosition(vec());
    s.cam.tgt.copy(position);
    if (test.suite === 'bodies') {
        const light = test.body.startsWith('unknown-') ? new THREE.Vector3(state.generated.hostStar.x * c.K, 0, 0) : b.sunPos;
        const outward = vec().subVectors(light, position).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), .65);
        s.cam.yaw = Math.atan2(outward.z, outward.x); s.cam.pitch = test.body === 'SATURN' ? .4 : .22;
    } else { s.cam.yaw = .7; s.cam.pitch = test.pitch ?? .22; }
    s.cam.dist = radius * test.radii; s.cam.distTarget = null;
    s.camera.fov = 48; s.camera.updateProjectionMatrix();
    if (test.lookAway) {
        // Free camera preserves the same observer position, but looks toward
        // the escape-cone rim instead of directly into the hole.
        s.applyCamera();
        const eye = s.camera.position.clone();
        const inward = position.clone().sub(eye).normalize();
        const tangent = vec().crossVectors(inward, new THREE.Vector3(0, 1, 0)).normalize();
        const look = inward.multiplyScalar(Math.cos(test.lookAway)).addScaledVector(tangent, Math.sin(test.lookAway)).normalize();
        s.cam.tgt.copy(eye).addScaledVector(look, radius * test.radii);
        s.cam.yaw = Math.atan2(-look.z, -look.x); s.cam.pitch = Math.asin(-look.y);
        G.focus = focus = 'free';
        if (test.diagnosticSky) s.scene.background = new THREE.Color(0x263449);
    }
    if (test.suite === 'holes') await window.__celestialEnsureLensing();
    state.target = { test, target, mesh, radius, focus, model, entry };
    return { focus, radius, body: test.body, generated: test.body.startsWith('unknown-') ? { seedId: state.generated.starId, planetIndex: state.generated.qaPlanetIndex, model } : null };
}
export function ready() {
    const material = state.target?.mesh?.material;
    const profile = material?.userData.bodyAppearance;
    if (!profile) return true;
    return material.userData.surfaceDetailWidth >= 512 && (!profile.relief || !!material.normalMap);
}
export function frame() {
    const t0 = performance.now(); window.__celestialFrame(); s.renderer.getContext().finish(); return performance.now() - t0;
}
export function capture() {
    frame();
    const { test, target, mesh, radius, focus, model, entry } = state.target;
    const gl = s.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    s.scene.updateMatrixWorld(true);
    const position = target.getWorldPosition(vec()), distance = s.camera.position.distanceTo(position);
    const pixels = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let sum = 0, sum2 = 0, bright = 0, nonblack = 0, clipped = 0, centerSum = 0, centerN = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, l = .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
        sum += l; sum2 += l * l; if (l > 128) bright++; if (l > 3) nonblack++;
        if (Math.max(pixels[i], pixels[i + 1], pixels[i + 2]) >= 254) clipped++;
        if (Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) * .18) { centerSum += l; centerN++; }
    }
    const opticalRadii = entry?.optics?.shadow?.material?.uniforms?.uDistance?.value;
    const measuredRadii = Number.isFinite(opticalRadii) ? opticalRadii : distance / radius;
    const errors = []; for (let i = 0; i < 16; i++) { const error = gl.getError(); if (!error) break; errors.push(error); }
    const visible = (() => { for (let o = mesh; o; o = o.parent) if (!o.visible) return false; return true; })();
    const values = [distance, radius, s.cam.dist, ...s.camera.position.toArray(), ...s.camera.quaternion.toArray()];
    const assertions = {
        fixedEpoch: G.t === 0 && G.paused, intendedFocus: G.focus === focus,
        intendedDistance: Math.abs(measuredRadii - test.radii) < Math.max(.002, test.radii * .0005),
        cameraFinite: values.every(Number.isFinite), targetBuilt: !!target.parent && !!mesh.geometry,
        surfaceVisible: visible, targetDetailLoaded: ready(), noWebGLError: errors.length === 0, noShaderError: state.shaderErrors.length === 0,
        // Dormant holes and an observer inside the photon sphere can correctly
        // see a black frame. Don't turn that physical outcome into a test bug.
        bodyPixelsPresent: test.suite === 'holes' || nonblack > w * h * .005,
    };
    return { png: s.renderer.domElement.toDataURL('image/png'), assertions,
        state: { time: G.t, focus: G.focus, body: test.body, requestedRadii: test.radii, actualRadii: measuredRadii, absoluteCameraRadii: distance / radius, opticalRadii: opticalRadii ?? null,
            radius, targetPosition: position.toArray(), camera: { position: s.camera.position.toArray(), quaternion: s.camera.quaternion.toArray(),
                near: s.camera.near, far: s.camera.far, fov: s.camera.fov, aspect: s.camera.aspect, dist: s.cam.dist },
            mobile: s.renderQuality.mobile, dpr: s.renderer.getPixelRatio(), size: [w, h], exposure: stellarExposure.value,
            material: materialInfo(mesh.material), visible, lensing: window.__celestialLensingStatus(),
            hole: entry?.optics ? { disk: entry.optics.parameters?.diskOn ?? entry.optics.disk?.visible, jet: entry.optics.parameters?.jetOn ?? entry.optics.jet?.visible, shadow: entry.optics.shadow?.visible,
                diskMaterial: materialInfo(entry.optics.disk?.material) } : null,
            classification: model ? { name: model.name, observed: model.observed ?? null, type: model.type, gas: model.gas, tempK: model.tempK } : null,
            render: { ...s.renderer.info.render }, memory: { ...s.renderer.info.memory } },
        pixels: { meanLuma: sum / (w * h), lumaStdDev: Math.sqrt(Math.max(0, sum2 / (w * h) - (sum / (w * h)) ** 2)),
            centerMeanLuma: centerSum / centerN, brightFraction: bright / (w * h), nonblackFraction: nonblack / (w * h), clippedFraction: clipped / (w * h) },
        glErrors: errors, shaderErrors: state.shaderErrors };
}
