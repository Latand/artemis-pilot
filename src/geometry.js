export function segmentSphereHit(x0, y0, z0, x1, y1, z1, radius) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const l2 = dx * dx + dy * dy + dz * dz;
    let t = l2 > 1e-12 ? -(x0 * dx + y0 * dy + z0 * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = x0 + dx * t, qy = y0 + dy * t, qz = z0 + dz * t;
    return qx * qx + qy * qy + qz * qz < radius * radius;
}
