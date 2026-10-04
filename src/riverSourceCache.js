// Publish only already-selected sources. Ranking/discovery remains outside
// this per-frame path; no catalog scan or temporary arrays are needed.
export function publishRiverSourcePositions(selected, count, scale, flow, bodies, offset, center) {
    for (let i = 0; i < count; i++) {
        const source = selected[i];
        const x = source.x * scale, y = (source.z || 0) * scale, z = -source.y * scale;
        flow.starX[i] = x; flow.starY[i] = y; flow.starZ[i] = z;
        bodies[offset + i].set(x - center.x, y - center.y, z - center.z, flow.starC[i]);
    }
}
