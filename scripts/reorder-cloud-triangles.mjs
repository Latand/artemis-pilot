// Offline-only, deterministic adjacency/LRU triangle reorder.
// Preserves each triangle's original three indices exactly; never remaps vertices.
export function reorderCloudTriangles(indices, vertexCount) {
    if (indices.length % 3) throw new Error('Triangle index count must be divisible by three');
    const count = indices.length / 3;
    const adjacent = Array.from({ length: vertexCount }, () => []);
    for (let triangle = 0; triangle < count; triangle++) {
        for (let corner = 0; corner < 3; corner++) {
            const vertex = indices[triangle * 3 + corner];
            if (vertex >= vertexCount) throw new Error('Out-of-range vertex index');
            adjacent[vertex].push(triangle);
        }
    }
    const remaining = Int32Array.from(adjacent, triangles => triangles.length);
    const emitted = new Uint8Array(count);
    const cachePosition = new Int32Array(vertexCount).fill(-1);
    const cache = [];
    const output = new indices.constructor(indices.length);
    const score = vertex => {
        if (!remaining[vertex]) return -1;
        const position = cachePosition[vertex];
        const cacheScore = position < 0 ? 0 : position < 3 ? .75 : ((32 - position) / 29) ** 1.5;
        return cacheScore + 2 / Math.sqrt(remaining[vertex]);
    };
    let firstRemaining = 0;
    for (let out = 0; out < count; out++) {
        const candidates = new Set();
        for (const vertex of cache) for (const triangle of adjacent[vertex]) {
            if (!emitted[triangle]) candidates.add(triangle);
        }
        let best = -1, bestScore = -Infinity;
        for (const triangle of candidates) {
            const start = triangle * 3;
            const value = score(indices[start]) + score(indices[start + 1]) + score(indices[start + 2]);
            if (value > bestScore || value === bestScore && triangle < best) {
                best = triangle;
                bestScore = value;
            }
        }
        if (best < 0) {
            while (emitted[firstRemaining]) firstRemaining++;
            best = firstRemaining;
        }
        emitted[best] = 1;
        for (const vertex of cache) cachePosition[vertex] = -1;
        for (let corner = 0; corner < 3; corner++) {
            const vertex = indices[best * 3 + corner];
            output[out * 3 + corner] = vertex;
            remaining[vertex]--;
            const existing = cache.indexOf(vertex);
            if (existing >= 0) cache.splice(existing, 1);
            cache.unshift(vertex);
            if (cache.length > 32) cache.pop();
        }
        for (let position = 0; position < cache.length; position++) cachePosition[cache[position]] = position;
    }
    return output;
}
