import { Vector3 } from 'three';
// Re-aim at another target while retaining the physical observer position.
// The orbit controller still owns the subsequent smooth distance approach.
export function aimExplorationCamera(cam, camera, target, goal) {
    const previous = camera.userData.systemAnchor, orbit = camera.userData.preciseOrbit;
    const delta = new Vector3();
    if (previous && orbit && orbit.worldPosition.equals(camera.position))
        delta.copy(previous.origin).sub(target.origin).add(previous.offset).sub(target.offset).add(orbit.offset);
    else delta.copy(camera.position).sub(target.origin).sub(target.offset);
    const distance = delta.length();
    cam.preciseTarget = { origin: target.origin.clone(), offset: target.offset.clone() };
    cam.tgt.copy(target.origin).add(target.offset); cam.dist = Math.max(.03, distance);
    cam.yaw = Math.atan2(delta.z, delta.x);
    cam.pitch = Math.asin(Math.max(-1, Math.min(1, delta.y / Math.max(distance, 1e-30))));
    cam.distTarget = goal;
    return distance;
}
