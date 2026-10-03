// Bounded camera-neighbourhood detail. The same provider serves physical
// ship discovery. A promoted ID leaves this point layer exactly once.
import * as THREE from 'three';
import { K } from '../constants.js';
import { sampleForeignStars, updateForeignStar } from '../universe/foreignStars.js';
import { makeStarPointMaterial } from './starPointMaterial.js';
import { absMagVFromL, teffToRGB } from './viewBrightness.js';
import { linearStarColor } from './stellarAppearance.js';
import { ACTIVE_STARS } from '../universe/activeStars.js';
import { getSeed } from '../universe/galaxy.js';
import { journalRevision } from '../universe/universeJournal.js';
import { PC_KM } from '../universe/coords.js';

let mesh, last = '', rows = [], lastT = NaN;
const color = new THREE.Color(), rgb = [1, 1, 1];
export function foreignCameraStars() { return rows; }
export function initForeignStarField(scene) {
    const g = new THREE.BufferGeometry();
    for (const [name, size] of [['position', 3], ['color', 3], ['absMag', 1], ['teffK', 1], ['radiusKm', 1]])
        g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(420 * size), size));
    mesh = new THREE.Points(g, makeStarPointMaterial({ radius: true }));
    mesh.name = 'persistent Andromeda stars'; mesh.frustumCulled = false; mesh.renderOrder = -3;
    scene.add(mesh);
}
export function updateForeignStarField(camera, world, t) {
    if (!mesh) return;
    // Small spatial cells amortize discovery; exact time publication is separate.
    const key = [getSeed(), ...world.map(v => Math.floor(v / PC_KM)), Math.floor(t / 31557600), journalRevision()].join(':');
    if (key !== last) { rows = sampleForeignStars(world, t); last = key; }
    if (lastT !== t) { for (const star of rows) updateForeignStar(star, t); lastT = t; }
    const promoted = new Set(ACTIVE_STARS.map(s => s.id));
    const a = mesh.geometry.attributes; let n = 0;
    for (const star of rows) {
        if (promoted.has(star.id)) continue;
        a.position.setXYZ(n, (star.x - world[0]) * K, (star.z - world[2]) * K, -(star.y - world[1]) * K);
        linearStarColor(teffToRGB(star.tempK, rgb), color); a.color.setXYZ(n, color.r, color.g, color.b);
        a.absMag.setX(n, absMagVFromL(star.lumSolar, star.tempK)); a.teffK.setX(n, star.tempK); a.radiusKm.setX(n, star.R); n++;
    }
    mesh.position.copy(camera.position); mesh.geometry.setDrawRange(0, n);
    for (const attr of Object.values(a)) attr.needsUpdate = true;
    mesh.visible = n > 0;
}
