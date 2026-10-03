// Headless integration for the production presentation layer. Real Three
// geometry, frusta, orbit math and the existing label-state cache run here;
// only the app's WebGL/DOM boot dependencies are replaced with small fixtures.
// This does not replace the full-app GPU captures in verify-orbital-exposure.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { AU_KM, K, MU_E, MU_M, MU_S, PL } from '../src/constants.js';
import { MOONS } from '../src/moons.js';

const day = 86400;
const moduleUrl = new URL('../src/render/orbitalExposure.js', import.meta.url);
const object = () => new THREE.Object3D();
const marker = opacity => ({ material: { opacity } });
const label = () => ({ style: { opacity: '', filter: '', transform: '' } });
const earthG = object(), moon = object(), sunPos = new THREE.Vector3();
earthG.position.set(AU_KM * K, 0, 0);
moon.position.set((AU_KM + 384400) * K, 0, 0);
const earthBeacon = marker(.9), moonBeacon = marker(.5);
const plGroups = PL.map(object), plGlows = PL.map(() => marker(.9));
const moonGroups = MOONS.map(object), moonGlows = MOONS.map(() => marker(.8));
const labels = { earth: label(), moon: label(), planets: PL.map(label), moons: MOONS.map(label) };
const G = { t: 0, paused: true, focus: 'free' };
const WORLD = {
    earthDestroyed: false, moonDestroyed: false, sunDestroyed: false,
    plDestroyed: new Uint8Array(PL.length).fill(1),
    muScale: new Float64Array(PL.length + 3).fill(1),
};
const eph = {
    sunX: -AU_KM, sunY: 0, sunZ: 0,
    sunVx: 0, sunVy: -Math.sqrt((MU_S + MU_E) / AU_KM), sunVz: 0,
    moonX: 384400, moonY: 0, moonZ: 0,
    moonVx: 0, moonVy: Math.sqrt((MU_E + MU_M) / 384400), moonVz: 0,
};
const scene = new THREE.Scene();
const viewportSize = { w: 1280, h: 820, pxScale: 820 / (2 * Math.tan(24 * Math.PI / 180)) };
const dock = { children: [], append(node) { this.children.push(node); } };
const document = {
    createElement() { return { style: {}, hidden: false }; },
    getElementById(id) { return id === 'timeDock' ? dock : null; },
};
const fixture = {
    eph, G, WORLD, scene, viewportSize, document,
    earthG, earthBeacon, moon, plGroups, plGlows, moonGroups, moonGlows, sunPos,
    IDX_MOON: 0, IDX_SUN: 1, IDX_PLANETS: 2,
    liveEarthMu: () => WORLD.earthDestroyed ? 0 : MU_E * WORLD.muScale[PL.length + 2],
    liveBodyMu: i => {
        if (i === 0) return WORLD.moonDestroyed ? 0 : MU_M * WORLD.muScale[i];
        if (i === 1) return WORLD.sunDestroyed ? 0 : MU_S * WORLD.muScale[i];
        return WORLD.plDestroyed[i - 2] ? 0 : PL[i - 2].mu * WORLD.muScale[i];
    },
};
// Keep production imports for Three and pure modules. Redirect only modules
// that otherwise boot a renderer or depend on the whole browser application.
const injected = new Set(['../ephemeris.js', '../state.js', '../scene.js', '../bodies.js']);
const source = await readFile(moduleUrl, 'utf8');
const isolated = source.replace(/^import\s+(.+?)\s+from\s+(['"])([^'"]+)\2;$/gm, (line, bindings, quote, specifier) => {
    if (injected.has(specifier)) {
        assert(bindings.startsWith('{'), `Expected named fixture import: ${line}`);
        return `const ${bindings} = globalThis.__orbitalExposureFixture;`;
    }
    const resolved = specifier.startsWith('.') ? new URL(specifier, moduleUrl).href : import.meta.resolve(specifier);
    return `import ${bindings} from ${JSON.stringify(resolved)};`;
});
globalThis.__orbitalExposureFixture = fixture;
globalThis.document = document;
const { orbitalExposure, updateOrbitalExposure, hideOrbitalExposure, applyOrbitalExposureMarkers } =
    await import(`data:text/javascript;base64,${Buffer.from(isolated).toString('base64')}`);

// Exercise the actual existing cached label writer, rather than implementing
// a second cache that might mask future changes in the production helper.
const sceneSource = await readFile(new URL('../src/scene.js', import.meta.url), 'utf8');
const cacheStart = sceneSource.indexOf('const labelState = new WeakMap();');
const cacheEnd = sceneSource.indexOf('export function setLabelDisplay', cacheStart);
assert(cacheStart >= 0 && cacheEnd > cacheStart, 'Production label cache fixture remains identifiable');
const cacheSource = sceneSource.slice(cacheStart, cacheEnd).replace(/^export /gm, '');
const { setLabelState, hideLabel } = new Function(`${cacheSource}\nreturn { setLabelState, hideLabel };`)();

const camera = new THREE.PerspectiveCamera(48, viewportSize.w / viewportSize.h, .02, 1e12);
const pose = (x, y, z, tx, ty, tz) => {
    camera.position.set(x, y, z);
    camera.lookAt(tx, ty, tz);
    camera.updateMatrixWorld(true);
};
pose(AU_KM * K / 2, 0, 0, AU_KM * K, 0, 0);
const earthEntry = () => orbitalExposure.entries.find(entry => entry.key === 'earth');
const apply = () => applyOrbitalExposureMarkers(moonBeacon, labels);
const update = (advance = 256 * day / 60, disabled = false) => updateOrbitalExposure(camera, advance, 1 / 60, disabled);
const snapshot = () => JSON.stringify({ G, WORLD, eph, earth: earthG.position.toArray(), moon: moon.position.toArray(), sun: sunPos.toArray() });

// Initial paused/ordinary frames must preserve the legacy Moon brightness.
update(); apply();
assert.equal(orbitalExposure.active, 0);
assert.equal(moonBeacon.material.opacity, .5, 'Paused Moon beacon retains its original .5 base opacity');
assert.equal(dock.children.length, 1, 'Presentation notice is allocated once');

// A parent behind the camera cannot exclude the forward part of its orbit.
G.paused = false;
const before = snapshot();
assert(sunPos.clone().project(camera).z > 1, 'Fixture host is behind camera');
assert(Math.abs(earthG.position.clone().project(camera).x) < 1, 'Fixture body is in view');
update();
assert(earthEntry().line.visible && earthEntry().blend > .99, 'Visible orbit survives host-behind-camera/inside-envelope culling');
assert.equal(snapshot(), before, 'Exposure never mutates clock, world, ephemeris, targets or body transforms');
assert(orbitalExposure.entries.every(entry => entry.pos.every(Number.isFinite)), 'Production geometry buffers are finite');
assert(orbitalExposure.samples <= (PL.length + MOONS.length + 2) * 65, 'Sampling stays bounded');

// Hidden/offscreen/decluttered labels keep their cached base opacity. Calling
// hideLabel again must work even when its cache already contains zero.
hideLabel(labels.earth);
apply();
assert.equal(labels.earth.style.opacity, '0', 'Exposure does not reveal a hidden label');
hideLabel(labels.earth);
assert.equal(labels.earth.style.opacity, '0', 'Repeated cached hide remains effective');
setLabelState(labels.earth, '1', 'translate(10px,10px)');
apply();
assert.equal(labels.earth.style.opacity, '1', 'Exposure preserves visible label base opacity');
assert.equal(labels.earth.style.filter, 'opacity(0)', 'Exposure applies a separate display multiplier');

// Rate/focus/paused/disabled returns remove the multiplier immediately.
G.paused = true; update(); apply();
assert.equal(labels.earth.style.opacity, '1');
assert.equal(labels.earth.style.filter, '', 'Pause restores the pre-existing label appearance');
assert.equal(moonBeacon.material.opacity, .5, 'Pause restores Moon base opacity');
hideLabel(labels.earth); apply(); hideLabel(labels.earth);
assert.equal(labels.earth.style.opacity, '0', 'Paused presentation preserves hidden-label cache');
G.paused = false; G.focus = 'earth'; update();
assert.equal(earthEntry().blend, 0, 'Focused body remains exact');
G.focus = 'free'; update(); assert(earthEntry().blend > .99);
update(256 * day / 60, true); apply();
assert.equal(orbitalExposure.active, 0, 'Disabled/cabin/VR layer clears');
assert.equal(labels.earth.style.filter, '');
assert.equal(labels.earth.style.opacity, '0');
assert.equal(moonBeacon.material.opacity, .5);
update(0); assert.equal(orbitalExposure.active, 0, 'Zero delivered time clears exposure');

// Moon partial/full suppression respects its original opacity, independently
// of the cadence at which ordinary labels and other markers are updated.
const moonEntry = orbitalExposure.entries.find(entry => entry.key === 'moon');
moonEntry.blend = .4; apply();
assert.equal(moonBeacon.material.opacity, .3);
moonEntry.blend = 1; apply(); assert.equal(moonBeacon.material.opacity, 0);
hideOrbitalExposure(); apply(); assert.equal(moonBeacon.material.opacity, .5);

// A stripped/destroyed central body cannot retain a fictitious bound band.
// This velocity is circular before mass loss and unbound at 40% host mass.
WORLD.muScale[1] = .4;
update(); assert.equal(earthEntry().line.visible, false, 'Sun mass loss excludes newly unbound Earth exposure');
WORLD.muScale[1] = 1;
update(); assert.equal(earthEntry().line.visible, true);
WORLD.sunDestroyed = true;
update(); assert.equal(earthEntry().line.visible, false, 'Destroyed Sun excludes Earth exposure');
WORLD.sunDestroyed = false;
pose(earthG.position.x, 1500, 0, earthG.position.x, 0, 0);
update(); assert.equal(moonEntry.line.visible, true, 'Earth-Moon fixture exposes unresolved lunar motion');
WORLD.muScale[PL.length + 2] = .4;
update(); assert.equal(moonEntry.line.visible, false, 'Earth mass loss excludes newly unbound Moon exposure');
WORLD.muScale[PL.length + 2] = 1;
WORLD.earthDestroyed = true;
update(); assert.equal(moonEntry.line.visible, false, 'Destroyed Earth excludes Moon exposure');
WORLD.earthDestroyed = false;
WORLD.moonDestroyed = true;
update(); assert.equal(moonEntry.line.visible, false, 'Destroyed Moon excludes its exposure');
WORLD.moonDestroyed = false;

// Reject a fully offscreen envelope; repeated updates reuse GPU allocations.
pose(AU_KM * K * 5, 0, 0, AU_KM * K * 6, 0, 0);
update(); assert.equal(orbitalExposure.active, 0, 'Entirely behind-camera envelopes are culled');
pose(AU_KM * K / 2, 0, 0, AU_KM * K, 0, 0);
const allocations = orbitalExposure.entries.map(entry => [entry.line, entry.line.geometry, entry.line.material, entry.pos, entry.colors]);
const sceneCount = scene.children.length;
for (let i = 0; i < 20; i++) update(i % 2 ? 1e6 * day : -1e6 * day);
assert.equal(earthEntry().averaged, 1, 'Many periods per frame produce a complete band');
assert.equal(scene.children.length, sceneCount);
for (let i = 0; i < allocations.length; i++) {
    const entry = orbitalExposure.entries[i];
    const current = [entry.line, entry.line.geometry, entry.line.material, entry.pos, entry.colors];
    for (let j = 0; j < current.length; j++) assert.equal(current[j], allocations[i][j]);
}
assert.equal(dock.children.length, 1);
assert.equal(snapshot(), before, 'Repeated reverse/forward presentation still leaves physical state exact');
hideOrbitalExposure(); apply();
assert.equal(dock.children[0].hidden, true);
console.log('orbital exposure integration: Moon base opacity, cached hidden labels, pause/focus/disable restoration, conservative envelope culling, live mass/destruction, finite bounded reuse and exact state passed');
