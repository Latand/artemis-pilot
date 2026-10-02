// Camera-only persistence. World-space target survives a render-origin change;
// no simulation state is read or written here.
import { K } from '../constants.js';
export function serializeExplorationCamera(cam, origin) {
    return { dist: cam.dist, yaw: cam.yaw, pitch: cam.pitch,
        targetWorldKm: [origin.x + cam.tgt.x / K, origin.y - cam.tgt.z / K, origin.z + cam.tgt.y / K] };
}
export function restoreExplorationCamera(record, cam, origin) {
    if (!record || !Number.isFinite(record.dist) || record.dist <= 0 || !Number.isFinite(record.yaw) || !Number.isFinite(record.pitch) ||
        !Array.isArray(record.targetWorldKm) || record.targetWorldKm.length !== 3 || !record.targetWorldKm.every(Number.isFinite)) return false;
    cam.dist = record.dist;
    cam.distTarget = null;
    cam.yaw = record.yaw;
    cam.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, record.pitch));
    const [x, y, z] = record.targetWorldKm;
    cam.tgt.set((x - origin.x) * K, (z - origin.z) * K, -(y - origin.y) * K);
    return true;
}
