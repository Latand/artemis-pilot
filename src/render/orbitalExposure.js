import { systemSurfaceExposureState } from './systemBodies.js';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { AU_KM, K, PL, R_EARTH, R_MOON } from '../constants.js';
import { eph, liveBodyMu, liveEarthMu, IDX_SUN, IDX_MOON, IDX_PLANETS } from '../ephemeris.js';
import { G, WORLD } from '../state.js';
import { MOONS, moonFocusIndex, moonOffset } from '../moons.js';
import { scene, viewportSize } from '../scene.js';
import { earthG, earthBeacon, moon, plGroups, plGlows, moonGroups, moonGlows, sunPos, surfaceExposureState } from '../bodies.js';
import { exposurePolicy, osculatingOrbit, sampleOrbit, presentationExposureSeconds } from './orbitalExposureMath.js';

const SEGMENTS = 64;
const entries = [];
const point = { x: 0, y: 0, z: 0 }, moonNow = { x: 0, y: 0 }, moonPast = { x: 0, y: 0 };
const axis = new THREE.Vector3(), envelope = new THREE.Sphere();
const frustum = new THREE.Frustum(), projectionView = new THREE.Matrix4();
let note;
export const orbitalExposure = { active: 0, averaged: 0, samples: 0, seconds: 0, entries };
function createEntry(key, color, radius, a) {
    const geometry = new LineGeometry();
    geometry.setPositions(new Float32Array((SEGMENTS + 1) * 3));
    geometry.setColors(new Float32Array((SEGMENTS + 1) * 3));
    const material = new LineMaterial({ color, linewidth: 3, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, depthTest: true });
    const line = new Line2(geometry, material);
    line.name = `Orbital exposure ${key}`;
    line.visible = false; line.frustumCulled = false;
    scene.add(line);
    const entry = { key, radius, a, line, blend: 0, averaged: 0, orbit: {}, pos: geometry.attributes.instanceStart.data.array, colors: geometry.attributes.instanceColorStart.data.array };
    entries.push(entry);
    return entry;
}
function init() {
    if (entries.length) return;
    createEntry('earth', 0x69afff, R_EARTH, AU_KM);
    createEntry('moon', 0xc8ccdd, R_MOON, 384400);
    PL.forEach((p, i) => createEntry(i, p.color, p.R, p.a));
    MOONS.forEach((m, i) => createEntry(`moon:${i}`, m.color, m.R, m.a));
    note = document.createElement('div'); note.id = 'orbitalExposureNote'; note.hidden = true;
    note.textContent = 'Orbit motion averaged · pause for exact positions';
    note.title = 'Fast unresolved bodies use approximate two-body exposure arcs. The simulation clock, physical positions and selection targets stay exact.';
    Object.assign(note.style, { fontSize: '10px', color: '#adc3d7', paddingTop: '3px' });
    document.getElementById('timeDock')?.append(note);
}
function orbitFor(entry) {
    const key = entry.key;
    if (key === 'earth') return osculatingOrbit(-eph.sunX, -eph.sunY, -eph.sunZ, -eph.sunVx, -eph.sunVy, -eph.sunVz, liveBodyMu(IDX_SUN) + liveEarthMu(), entry.orbit);
    if (key === 'moon') return osculatingOrbit(eph.moonX, eph.moonY, eph.moonZ, eph.moonVx, eph.moonVy, eph.moonVz, liveEarthMu() + liveBodyMu(IDX_MOON), entry.orbit);
    if (typeof key === 'number') return osculatingOrbit(eph.plX[key] - eph.sunX, eph.plY[key] - eph.sunY, eph.plZ[key] - eph.sunZ, eph.plVx[key] - eph.sunVx, eph.plVy[key] - eph.sunVy, eph.plVz[key] - eph.sunVz, liveBodyMu(IDX_SUN) + liveBodyMu(IDX_PLANETS + key), entry.orbit);
    const m = MOONS[moonFocusIndex(key)];
    entry.orbit.period = Math.abs(2 * Math.PI / m.n);
    return entry.orbit;
}
export function hideOrbitalExposure(hideNote = true) {
    orbitalExposure.active = orbitalExposure.averaged = orbitalExposure.samples = 0;
    orbitalExposure.seconds = 0;
    for (const entry of entries) { entry.blend = 0; entry.line.visible = false; }
    if (hideNote && note && !note.hidden) note.hidden = true;
}
export function updateOrbitalExposure(camera, advance, realDt, disabled = false) {
    init(); hideOrbitalExposure(false);
    if (disabled || G.paused || !advance) { if (!note.hidden) note.hidden = true; return; }
    orbitalExposure.seconds = presentationExposureSeconds(advance, realDt);
    frustum.setFromProjectionMatrix(projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const entry of entries) {
        const key = entry.key, mi = moonFocusIndex(key), isPlanet = typeof key === 'number';
        const object = key === 'earth' ? earthG : key === 'moon' ? moon : isPlanet ? plGroups[key] : moonGroups[mi];
        const destroyed = key === 'earth' ? WORLD.earthDestroyed || WORLD.sunDestroyed : key === 'moon' ? WORLD.moonDestroyed || WORLD.earthDestroyed : isPlanet ? WORLD.plDestroyed[key] || WORLD.sunDestroyed : WORLD.plDestroyed[MOONS[mi].p];
        const host = key === 'moon' ? earthG.position : mi >= 0 ? plGroups[MOONS[mi].p].position : sunPos;
        if (destroyed || (mi >= 0 && !object.visible)) continue;
        const distance = Math.max(entry.radius * K, camera.position.distanceTo(object.position));
        const hostDistance = Math.max(entry.a * K, camera.position.distanceTo(host));
        const orbitPx = entry.a * K * viewportSize.pxScale / hostDistance;
        const radiusPx = entry.radius * K * viewportSize.pxScale / distance;
        if (radiusPx >= 6 || orbitPx <= 3 || G.focus === key) continue;
        const orbit = orbitFor(entry);
        if (!orbit) continue;
        // World-space envelope culling remains conservative from inside an
        // orbit, across the near plane, and while its parent is behind us.
        envelope.center.copy(host);
        envelope.radius = mi >= 0 ? MOONS[mi].a * (1 + MOONS[mi].e) * K : orbit.a * (1 + orbit.e) * K;
        if (!frustum.intersectsSphere(envelope)) continue;
        const policy = exposurePolicy({ advance, realDt, period: orbit.period, orbitPx, radiusPx });
        if (policy.blend < .005) continue;
        entry.blend = policy.blend; entry.averaged = policy.averaged;
        const line = entry.line;
        line.position.copy(host);
        line.material.resolution.set(viewportSize.w, viewportSize.h);
        line.material.linewidth = Math.max(2, Math.min(6, radiusPx * 2));
        line.material.opacity = .72 * policy.blend;
        // The periapsis-anchored complete band has no moving seam. Arc->band
        // blends its temporal weighting continuously as the shutter expands.
        if (mi >= 0) moonOffset(MOONS[mi], G.t, moonNow);
        const phaseOrigin = policy.averaged === 1 ? (mi >= 0 ? -MOONS[mi].phase / MOONS[mi].n : -orbit.M / orbit.n) : 0;
        for (let j = 0; j <= SEGMENTS; j++) {
            const u = j / SEGMENTS;
            const dt = -policy.span * u;
            if (mi >= 0) {
                moonOffset(MOONS[mi], policy.averaged === 1 ? phaseOrigin + dt : G.t + dt, moonPast);
                point.x = moonPast.x; point.y = moonPast.y; point.z = 0;
            } else sampleOrbit(orbit, phaseOrigin + dt, point);
            // Local float32 geometry around the current parent anchor avoids
            // astronomical-world-coordinate precision loss.
            axis.set(point.x * K, point.z * K, -point.y * K);
            const brightness = policy.averaged + (1 - policy.averaged) * (.15 + .85 * (1 - u));
            if (j < SEGMENTS) {
                entry.pos[j * 6] = axis.x; entry.pos[j * 6 + 1] = axis.y; entry.pos[j * 6 + 2] = axis.z;
                entry.colors.fill(brightness, j * 6, j * 6 + 3);
            }
            if (j > 0) {
                entry.pos[j * 6 - 3] = axis.x; entry.pos[j * 6 - 2] = axis.y; entry.pos[j * 6 - 1] = axis.z;
                entry.colors.fill(brightness, (j - 1) * 6 + 3, j * 6);
            }
        }
        line.geometry.attributes.instanceStart.data.needsUpdate = true;
        line.geometry.attributes.instanceColorStart.data.needsUpdate = true;
        line.visible = true;
        orbitalExposure.active++; orbitalExposure.samples += SEGMENTS + 1;
        if (policy.averaged > .5) orbitalExposure.averaged++;
    }
    const surfaceActive = surfaceExposureState.active + systemSurfaceExposureState.active;
    const noteHidden = !orbitalExposure.active && !surfaceActive;
    if (note.hidden !== noteHidden) note.hidden = noteHidden;
    const noteText = surfaceActive
        ? (orbitalExposure.active ? 'Orbit and surface motion averaged · pause for exact detail' : 'Surface rotation averaged · pause for exact detail')
        : 'Orbit motion averaged · pause for exact positions';
    if (note.textContent !== noteText) note.textContent = noteText;
}
// Called once at the render boundary, after every beacon/label update. It
// never changes object transforms, camera targets, orbit guides or hit tests.
export function applyOrbitalExposureMarkers(moonBeacon, labels) {
    for (const entry of entries) {
        const key = entry.key, mi = moonFocusIndex(key);
        const marker = key === 'earth' ? earthBeacon : key === 'moon' ? moonBeacon : typeof key === 'number' ? plGlows[key] : moonGlows[mi];
        // Marker opacity is recomputed by production shaders each frame,
        // except the legacy Moon beacon, whose base opacity is constant.
        if (key === 'moon') marker.material.opacity = .5 * (1 - entry.blend);
        else marker.material.opacity *= 1 - entry.blend;
        const label = key === 'earth' ? labels.earth : key === 'moon' ? labels.moon : typeof key === 'number' ? labels.planets[key] : labels.moons[mi];
        if (label) { const filter = entry.blend > 0 ? `opacity(${1 - entry.blend})` : ''; if (label.style.filter !== filter) label.style.filter = filter; }
    }
}
