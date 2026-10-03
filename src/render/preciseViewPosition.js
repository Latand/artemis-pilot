// Keep a small orbit offset separate from its galactic world position until
// after subtraction. Applying the inverse world matrix to an absolute point
// first loses kilometre-scale offsets through cancellation, even in doubles.
// Mutates point, just like Vector3.applyMatrix4(). The ordinary matrix path is
// retained for cockpit, XR, and any camera moved since applyCamera().
export function preciseViewPosition(point, camera) {
    const orbit = camera.userData.preciseOrbit;
    const world = camera.matrixWorld.elements;
    if (!orbit || orbit.worldPosition.x !== world[12] ||
        orbit.worldPosition.y !== world[13] || orbit.worldPosition.z !== world[14]) {
        return point.applyMatrix4(camera.matrixWorldInverse);
    }
    const anchor = camera.userData.systemAnchor;
    if (anchor) point.sub(anchor.origin).sub(anchor.offset).sub(orbit.offset);
    else point.sub(orbit.target).sub(orbit.offset);
    const x = point.x, y = point.y, z = point.z;
    const view = camera.matrixWorldInverse.elements;
    return point.set(
        view[0] * x + view[4] * y + view[8] * z,
        view[1] * x + view[5] * y + view[9] * z,
        view[2] * x + view[6] * y + view[10] * z,
    );
}
