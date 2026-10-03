// Split host + orbital offset until observer subtraction. A single global
// float64 cannot represent kilometre offsets at Andromeda's distance.
import * as THREE from 'three';
import { K } from '../constants.js';
import { planetOffsetKm, moonOffsetKm, planetFocusIndex, planetMoonFocusIndex } from '../universe/planetarySystem.js';
const offset = { x: 0, y: 0, z: 0 }, satellite = { x: 0, y: 0, z: 0 };
export function systemAnchor(system, planetIndex, moonIndex, t) {
    const host = system?.hostStar, planet = system?.planets?.[planetIndex];
    if (!host?.galaxyId || !planet) return null;
    planetOffsetKm(planet, system.hostMass, t, offset);
    if (moonIndex != null && planet.moons?.[moonIndex]) {
        moonOffsetKm(planet.moons[moonIndex], t, satellite);
        offset.x += satellite.x; offset.y += satellite.y; offset.z += satellite.z;
    }
    return { origin: new THREE.Vector3(host.x * K, host.z * K, -host.y * K),
        offset: new THREE.Vector3(offset.x * K, offset.z * K, -offset.y * K) };
}
export function prepareSystemCameraAnchor(cam, system, focus, t) {
    if (focus === 'free') return cam.preciseTarget || null;
    const moon = planetMoonFocusIndex(focus), planet = moon?.planetIndex ?? planetFocusIndex(focus);
    const host = system?.hostStar;
    cam.preciseTarget = planet >= 0 ? systemAnchor(system, planet, moon?.moonIndex, t)
        : focus === 'proc:' + host?.id && host?.galaxyId
            ? { origin: new THREE.Vector3(host.x * K, host.z * K, -host.y * K), offset: new THREE.Vector3() } : null;
    return cam.preciseTarget;
}

export function bindSystemObjectAnchor(object, anchor) {
    object.userData.systemAnchor = anchor;
    // Three's CPU frustum test sees rounded global transforms before the
    // material repairs model-view translation. Tiny foreign bodies can be
    // rejected there even when centered. The bounded system gate still owns
    // visibility; GPU clipping uses the corrected local model-view matrix.
    object.frustumCulled = !anchor;
}
