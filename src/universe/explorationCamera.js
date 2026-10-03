import { Vector3 } from 'three';
// Camera-only persistence. World-space target survives a render-origin change;
// no simulation state is read or written here.
import { K } from '../constants.js';
export function serializeExplorationCamera(cam, origin) {
    return { dist: cam.dist, yaw: cam.yaw, pitch: cam.pitch,
        ...(cam.preciseTarget ? { targetSplitWorldKm: {
            origin: [origin.x + cam.preciseTarget.origin.x / K, origin.y - cam.preciseTarget.origin.z / K, origin.z + cam.preciseTarget.origin.y / K],
            offset: [cam.preciseTarget.offset.x / K, -cam.preciseTarget.offset.z / K, cam.preciseTarget.offset.y / K],
        } } : {}),
        targetWorldKm: [origin.x + cam.tgt.x / K, origin.y - cam.tgt.z / K, origin.z + cam.tgt.y / K] };
}
export function restoreExplorationCamera(record, cam, origin) {
    if (!record || !Number.isFinite(record.dist) || record.dist <= 0 || !Number.isFinite(record.yaw) || !Number.isFinite(record.pitch) ||
        !Array.isArray(record.targetWorldKm) || record.targetWorldKm.length !== 3 || !record.targetWorldKm.every(Number.isFinite)) return false;
    const split = record.targetSplitWorldKm;
    if (split && (!['origin', 'offset'].every(key => Array.isArray(split[key]) && split[key].length === 3 && split[key].every(Number.isFinite)))) return false;
    cam.preciseTarget = split ? { origin: new Vector3((split.origin[0] - origin.x) * K, (split.origin[2] - origin.z) * K, -(split.origin[1] - origin.y) * K),
        offset: new Vector3(split.offset[0] * K, split.offset[2] * K, -split.offset[1] * K) } : null;
    cam.dist = record.dist;
    cam.distTarget = null;
    cam.yaw = record.yaw;
    cam.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, record.pitch));
    const [x, y, z] = record.targetWorldKm;
    cam.tgt.set((x - origin.x) * K, (z - origin.z) * K, -(y - origin.y) * K);
    return true;
}

// Preserve small movement in a galaxy-scale frame. cam.tgt remains the
// rounded broad-phase position; preciseTarget owns the local residual.
export function moveExplorationTarget(cam, delta, scale = 1) {
    if (cam.preciseTarget) {
        cam.preciseTarget.offset.addScaledVector(delta, scale);
        cam.tgt.copy(cam.preciseTarget.origin).add(cam.preciseTarget.offset);
    } else cam.tgt.addScaledVector(delta, scale);
}
