// Render-only river resources. Kept DOM/WebGL-free for exact topology,
// sampling and skipped-compute frame tests.
export function riverArcAttributes(texWidth, segments) {
    if (!Number.isInteger(texWidth) || texWidth < 1 || ![1, 2].includes(segments)) {
        throw new RangeError('River arcs require a positive texture width and one or two segments');
    }
    const count = texWidth * texWidth;
    const verticesPerParticle = segments + 1;
    const indicesPerParticle = segments * 2;
    const vertexCount = count * verticesPerParticle;
    const refs = new Float32Array(vertexCount * 2);
    const segs = new Float32Array(vertexCount);
    const IndexArray = vertexCount <= 65536 ? Uint16Array : Uint32Array;
    const indices = new IndexArray(count * indicesPerParticle);
    for (let i = 0; i < count; i++) {
        const u = ((i % texWidth) + .5) / texWidth, v = (Math.floor(i / texWidth) + .5) / texWidth;
        const base = i * verticesPerParticle;
        for (let s = 0; s <= segments; s++) {
            refs[(base + s) * 2] = u;
            refs[(base + s) * 2 + 1] = v;
            segs[base + s] = s;
        }
        for (let s = 0; s < segments; s++) {
            const index = i * indicesPerParticle + s * 2;
            indices[index] = base + s;
            indices[index + 1] = base + s + 1;
        }
    }
    return { refs, segs, indices, vertexCount, verticesPerParticle, indicesPerParticle };
}

// The old shader accumulated sqrt(C) in source order, separately in every
// respawning particle. Do that once per source update, keeping float32
// rounding and the same (un-normalized) cumulative thresholds / <= rule.
export function fillRiverSpawnCdf(bodies, count, out) {
    let total = 0;
    for (let i = 0; i < count; i++) {
        const weight = Math.fround(Math.sqrt(Math.max(Math.fround(bodies[i].w), 0)));
        total = Math.fround(total + weight);
        out[i] = total;
    }
    return total;
}

// A position texture retains the origin of its most recent compute pass,
// not of the previous animation frame. Drawing on a skipped frame subtracts
// this same shift; only a successful dispatch commits the new origin.
export class RiverTextureFrame {
    constructor() { this.x = 0; this.y = 0; this.z = 0; }
    commit(center) { this.x = center.x; this.y = center.y; this.z = center.z; }
    shiftTo(center, out) {
        out.x = center.x - this.x;
        out.y = center.y - this.y;
        out.z = center.z - this.z;
        return out;
    }
}

export function riverFitsNearTier(cameraDistance, radius, split) {
    // Only heads inside radius have nonzero ink. The full backward arc is
    // at most .028 * 1.6 of head-to-camera distance (river.js maxL clamp).
    // Triangle inequality bounds every lit endpoint by 1.0448 * (D + R).
    // Round outward to 1.05. Unknown bounds retain both depth-tier draws.
    return Number.isFinite(cameraDistance) && Number.isFinite(radius) &&
        cameraDistance >= 0 && radius > 0 &&
        (cameraDistance + radius) * 1.05 < split;
}
