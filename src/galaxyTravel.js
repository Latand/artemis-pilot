// A focus/zoom convenience, using the ordinary camera controller. Moving with
// WASD, wheel zoom and clicks remain authoritative. No simulation-clock writes,
// ship teleport, private animation loop or generated tour-only population.
import { G } from './state.js';
import { cam, camera } from './scene.js';
import { K, LY_SCENE } from './constants.js';
import { galaxyWorldKm } from './universe/galaxyRegistry.js';
import { getOrigin } from './universe/renderOrigin.js';

export function galaxyFocusPosition(focus, t, out) {
    const id = focus === 'galaxy:m31' ? 'm31' : focus === 'galaxy:mw' ? 'mw' : null;
    if (!id) return null;
    const p = galaxyWorldKm(id, id === 'm31' ? [10000, 0, 0] : [0, 0, 0], t), o = getOrigin();
    return out.set((p[0] - o.x) * K, (p[2] - o.z) * K, -(p[1] - o.y) * K);
}
export function approachGalaxy(id) {
    if (G.uiMode !== 'observe') return false;
    const target = galaxyFocusPosition('galaxy:' + id, G.t, cam.tgt.clone());
    if (!target) return false;
    // Re-aim without moving the camera: distance/yaw/pitch encode precisely
    // its current observer position relative to the new target.
    const delta = camera.position.clone().sub(target), distance = delta.length();
    G.focus = 'galaxy:' + id; G.cosmicOverview = false;
    cam.tgt.copy(target); cam.dist = Math.max(.03, distance);
    cam.yaw = Math.atan2(delta.z, delta.x);
    cam.pitch = Math.asin(Math.max(-1, Math.min(1, delta.y / Math.max(distance, 1e-30))));
    cam.distTarget = id === 'm31' ? LY_SCENE * 5 : LY_SCENE * 120000;
    return true;
}
export function initGalaxyTravel() {
    document.getElementById('exploreAndromeda')?.addEventListener('click', () => approachGalaxy('m31'));
    document.getElementById('exploreMilkyWayReturn')?.addEventListener('click', () => approachGalaxy('mw'));
    document.getElementById('exploreTravelStop')?.addEventListener('click', () => { cam.distTarget = null; });
    const exposure = document.getElementById('exploreExposure');
    exposure?.addEventListener('click', () => { G.cosmicOverview = !G.cosmicOverview; exposure.textContent = G.cosmicOverview ? 'Exposure: deep-sky overview' : 'Exposure: bounded travel'; });
}
