import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { riverArcAttributes, fillRiverSpawnCdf, RiverTextureFrame, riverFitsNearTier } from '../src/riverResources.js';

// The indexed draw must produce precisely the old per-segment UV/index
// sequence, including mobile's one segment and >65K-vertex np overrides.
for (const width of [1, 64, 124, 136, 148]) {
    for (const segments of [1, 2]) {
        const arcs = riverArcAttributes(width, segments);
        const count = width * width;
        assert.equal(arcs.vertexCount, count * (segments + 1));
        assert.equal(arcs.indices.length, count * segments * 2);
        assert.equal(arcs.indices instanceof Uint32Array, arcs.vertexCount > 65536);
        for (let i = 0; i < count; i++) {
            const u = Math.fround(((i % width) + .5) / width);
            const v = Math.fround((Math.floor(i / width) + .5) / width);
            for (let s = 0; s < segments; s++) {
                for (let endpoint = 0; endpoint < 2; endpoint++) {
                    const index = arcs.indices[i * segments * 2 + s * 2 + endpoint];
                    assert.equal(arcs.segs[index], s + endpoint);
                    assert.equal(arcs.refs[index * 2], u);
                    assert.equal(arcs.refs[index * 2 + 1], v);
                    assert.equal(index, i * (segments + 1) + s + endpoint);
                }
            }
        }
    }
}
assert.throws(() => riverArcAttributes(0, 2), RangeError);
assert.throws(() => riverArcAttributes(64, 3), RangeError);
assert.equal(riverArcAttributes(124, 2).vertexCount, 46128); // previous: 61504

// Independent transcription of the old GLSL source-weight accumulation.
// float32 at input, sqrt result and accumulation matches the uploaded data.
const f = Math.fround;
for (const values of [[], [0], [0, 0, 0], [1, 4, 9, 16], [0, .02, 0, 16.29, .5, 3.6],
    Array.from({ length: 40 }, (_, i) => i % 7 === 0 ? 0 : 10 ** ((i - 20) / 3))]) {
    const cdf = new Float32Array(values.length + 2).fill(-1);
    const total = fillRiverSpawnCdf(values.map(w => ({ w })), values.length, cdf);
    let expectedTotal = 0;
    for (let i = 0; i < values.length; i++) {
        expectedTotal = f(expectedTotal + f(Math.sqrt(Math.max(f(values[i]), 0))));
        assert.equal(cdf[i], expectedTotal);
    }
    assert.equal(total, expectedTotal);
    assert.equal(cdf[values.length], -1, 'unused source slots must not affect active CDF');
    for (let j = 0; j < 10001 && total > 1e-6; j++) {
        const pick = f(f(j / 10000) * total);
        let acc = 0, oldChoice = -1;
        for (let i = 0; i < values.length; i++) {
            acc = f(acc + f(Math.sqrt(Math.max(f(values[i]), 0))));
            if (pick <= acc) { oldChoice = i; break; }
        }
        const newChoice = Array.from(cdf.subarray(0, values.length)).findIndex(weight => pick <= weight);
        assert.equal(newChoice, oldChoice);
    }
}

// Two skipped dispatches must accumulate a full origin shift. Their drawn
// positions must remain fixed in world space, then the next dispatch must
// rebase only once. Include large deep-time origins and all three axes.
for (const initial of [{ x: 0, y: 0, z: 0 }, { x: 1e16, y: -1e16, z: 5e15 }]) {
    const frame = new RiverTextureFrame();
    frame.commit(initial);
    const shift = {}, p = { x: 96, y: -144, z: 208 };
    let current;
    for (const step of [1, 2, 3]) {
        current = { x: initial.x + step * 16, y: initial.y - step * 8, z: initial.z + step * 24 };
        frame.shiftTo(current, shift);
        assert.deepEqual(shift, { x: step * 16, y: -step * 8, z: step * 24 });
        for (const axis of ['x', 'y', 'z']) {
            assert.equal(current[axis] + p[axis] - shift[axis], initial[axis] + p[axis]);
        }
    }
    const rebased = { x: p.x - shift.x, y: p.y - shift.y, z: p.z - shift.z };
    frame.commit(current);
    frame.shiftTo(current, shift);
    assert.deepEqual(shift, { x: 0, y: 0, z: 0 });
    for (const axis of ['x', 'y', 'z']) assert.equal(current[axis] + rebased[axis], initial[axis] + p[axis]);
    // A hard camera snap deliberately restarts the cloud in the new frame.
    const snap = { x: 1e18, y: 2e18, z: -3e18 };
    frame.commit(snap);
    frame.shiftTo(snap, shift);
    assert.deepEqual(shift, { x: 0, y: 0, z: 0 });
}

const split = 9460730472.5808 * .02;
assert(riverFitsNearTier(1.3e7, 3.64e7, split), 'solar survey should skip redundant far draw');
assert(riverFitsNearTier(3.99e7, 3.99e7 * 2.8, split), 'settled scale-fade edge still fits');
assert(!riverFitsNearTier(1e8, 1.2e8, split), 'transient crossing must keep far draw');
assert(!riverFitsNearTier(split / 1.05 - 1, 1, split), 'equality is not conservatively inside');
for (const invalid of [NaN, Infinity, -1]) assert(!riverFitsNearTier(invalid, 10, split));
assert(!riverFitsNearTier(10, 0, split));
// Worst orientation: head lies on the outward radial axis and the whole
// arc continues away from the camera. The bound must include the tail.
for (const d of [0, 1, 1e6, 1e8]) for (const r of [1, 1e5, 1.2e8]) {
    const farthest = (d + r) * (1 + .028 * 1.6);
    if (riverFitsNearTier(d, r, split)) assert(farthest < split);
}

// Integration guards: indices, uniforms and frame commits must remain wired
// to the production shader/dispatch rather than only the pure helpers.
const source = readFileSync(new URL('../src/river.js', import.meta.url), 'utf8');
assert(source.includes('setDrawRange(0, drawCount * IPP)'));
assert(source.includes('geom.setIndex(new THREE.BufferAttribute(arcs.indices, 1))'));
assert(source.includes('texture2D(uPos, ref).xyz - uDrawCenterShift'));
assert(source.includes('pick <= uSpawnCdf[i]'));
assert(!source.includes('totalW += sqrt('));
const dispatch = source.slice(source.indexOf('    if (shouldCompute) {'));
assert(dispatch.indexOf('renderer.render(computeScene, computeCam)') < dispatch.indexOf('textureFrame.commit(smoothCenter)'));
assert(dispatch.includes('uniformsShared.uDrawCenterShift.value.set(0, 0, 0)'));
assert(source.includes('registerNearTierOnlyWhen(lines'));
assert(source.includes('!renderer.xr.isPresenting && view === camera'));
console.log('River resource smoke passed: identical indexed arcs/CDF, skipped-frame rebasing, conservative tier bounds');
