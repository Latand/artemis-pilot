// Runtime-layer smoke for WP9 (Tier-1 streaming + renderer): exercises the
// *pure* parts of the worker decode path and the render-group bookkeeping
// directly against public/data/athyg-tier1.bin on disk, with no Worker, no
// DOM, and no IndexedDB — those pure functions are exported from
// src/workers/athygTileWorker.js and src/render/athygStars.js exactly so this
// script can import and call them. (Static manifest/binary shape is already
// covered by smoke-catalog-tier1.mjs; this smoke covers the runtime decode +
// scheduling logic added on top of it.)

import { readFileSync } from "node:fs";
import { ang2pix_nest, pix2ang_nest, ORDER, NPIX } from "../src/universe/healpix.js";
import { decodeTileRecords, RECORD_BYTES } from "../src/workers/athygTileWorker.js";
import { computeGroupCapacities, createGroupLayout, addTileToLayout, groupIndexForTile, GROUP_TILE_SPAN } from "../src/render/athygStars.js";
import { computeGlobalPriorityOrder } from "../src/universe/athygTier1.js";
import { makeRNG } from "../src/universe/prng.js";

function assert(ok, message) {
    if (!ok) throw new Error(message);
}

const manifest = JSON.parse(readFileSync(new URL("../public/data/athyg-tier1-manifest.json", import.meta.url), "utf8"));
const bin = readFileSync(new URL("../public/data/athyg-tier1.bin", import.meta.url));

assert(manifest.recordBytes === RECORD_BYTES, `worker RECORD_BYTES (${RECORD_BYTES}) should match manifest.recordBytes (${manifest.recordBytes})`);

function xyzToRaDec(x, y, z) {
    const dist = Math.sqrt(x * x + y * y + z * z);
    const decDeg = Math.asin(z / dist) * 180 / Math.PI;
    let raDeg = Math.atan2(y, x) * 180 / Math.PI;
    if (raDeg < 0) raDeg += 360;
    return { raDeg, decDeg };
}

// --- decode 5 sample tiles off disk with the worker's pure decode function --

const nonEmpty = [];
for (let t = 0; t < manifest.tiles.length && nonEmpty.length < 400; t++) {
    if (manifest.tiles[t][1] > 0) nonEmpty.push(t);
}
assert(nonEmpty.length >= 5, "need at least 5 non-empty Tier-1 tiles to sample");
const sampleStep = Math.max(1, Math.floor(nonEmpty.length / 5));
const sampleTileIds = [0, 1, 2, 3, 4].map(k => nonEmpty[Math.min(nonEmpty.length - 1, k * sampleStep)]);

const decodedPool = []; // {tileId, x, y, z, mag, ci}
for (const tileId of sampleTileIds) {
    const [byteOffset, count] = manifest.tiles[tileId];
    const rec = decodeTileRecords(bin.buffer, bin.byteOffset + byteOffset, count);
    assert(rec.count === count, `decoded count should match manifest for tile ${tileId}`);
    assert(rec.positions.length === count * 3, "positions array should be count*3 floats");
    assert(rec.magCi.length === count * 2, "magCi array should be count*2 int16s");
    assert(rec.pm.length === count * 2, "pm array should be count*2 int16s");
    for (let i = 0; i < count; i++) {
        const x = rec.positions[i * 3], y = rec.positions[i * 3 + 1], z = rec.positions[i * 3 + 2];
        assert(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), `decoded position should be finite (tile ${tileId}, star ${i})`);
        const mag = rec.magCi[i * 2] / 100;
        const ci = rec.magCi[i * 2 + 1] / 1000;
        assert(mag >= -2 && mag <= 16, `decoded magnitude out of plausible range: ${mag} (tile ${tileId}, star ${i})`);
        assert(Number.isFinite(ci), `decoded ci should be finite (tile ${tileId}, star ${i})`);
        decodedPool.push({ tileId, x, y, z, mag, ci });
    }
}
console.log(`decoded ${decodedPool.length} stars across ${sampleTileIds.length} sample tiles (ids: ${sampleTileIds.join(",")})`);

// --- recompute ang2pix on 100 random decoded stars, assert tile membership --

assert(decodedPool.length >= 100, "need at least 100 decoded stars across the sample tiles to run the membership check");
const rng = makeRNG(0xa7415eed);
const pickIdx = new Set();
while (pickIdx.size < 100) pickIdx.add(Math.floor(rng() * decodedPool.length));
let checked = 0;
for (const idx of pickIdx) {
    const star = decodedPool[idx];
    const { raDeg, decDeg } = xyzToRaDec(star.x, star.y, star.z);
    const recomputedPix = ang2pix_nest(ORDER, raDeg, decDeg);
    assert(recomputedPix === star.tileId, `recomputed pix ${recomputedPix} should match source tile ${star.tileId} for a decoded star`);
    checked++;
}
assert(checked === 100, "should have checked exactly 100 random decoded stars");
console.log(`ang2pix membership check passed for ${checked} random decoded stars`);

// --- group/drawRange bookkeeping: synthetic 3-tile load-order sequence -----

{
    const layout = createGroupLayout(30);
    const a = addTileToLayout(layout, 7, 10);
    assert(a.isNew && a.offset === 0 && a.count === 10, "first tile should land at offset 0");
    assert(layout.filledCount === 10, "filledCount should track the first tile's count");

    const b = addTileToLayout(layout, 3, 15);
    assert(b.isNew && b.offset === 10 && b.count === 15, "second tile should land right after the first regardless of tile id order");
    assert(layout.filledCount === 25, "filledCount should accumulate across tiles");

    const c = addTileToLayout(layout, 99, 5);
    assert(c.isNew && c.offset === 25 && c.count === 5, "third tile should land after the second");
    assert(layout.filledCount === 30, "filledCount should equal the layout capacity once fully loaded");

    // Idempotency: re-adding an already-loaded tile must not double-count or move its slot.
    const aAgain = addTileToLayout(layout, 7, 10);
    assert(!aAgain.isNew && aAgain.offset === 0 && aAgain.count === 10, "re-adding a loaded tile should return its existing slot unchanged");
    assert(layout.filledCount === 30, "re-adding a loaded tile must not change filledCount");

    // Overflow: a tile that would exceed the preallocated capacity must throw, not silently truncate.
    let threw = false;
    try { addTileToLayout(layout, 123, 1); } catch { threw = true; }
    assert(threw, "adding a tile beyond the group's manifest-derived capacity should throw");

    console.log("group/drawRange bookkeeping (synthetic 3-tile sequence) passed");
}

// --- group capacity / index math against the real manifest ------------------

{
    const capacities = computeGroupCapacities(manifest.tiles, GROUP_TILE_SPAN);
    const expectedGroups = Math.ceil(manifest.tiles.length / GROUP_TILE_SPAN);
    assert(capacities.length === expectedGroups, `expected ${expectedGroups} groups at span ${GROUP_TILE_SPAN}, got ${capacities.length}`);
    assert(capacities.length <= 48, `Tier-1 draw calls should stay at or under 48 groups (budget <100), got ${capacities.length}`);
    const totalCapacity = capacities.reduce((s, c) => s + c, 0);
    assert(totalCapacity === manifest.count, `sum of group capacities (${totalCapacity}) should equal manifest.count (${manifest.count})`);
    assert(groupIndexForTile(0, GROUP_TILE_SPAN) === 0, "tile 0 should be in group 0");
    assert(groupIndexForTile(GROUP_TILE_SPAN, GROUP_TILE_SPAN) === 1, "the first tile of the span should start group 1");
    console.log(`group capacity math passed: ${capacities.length} groups, total capacity ${totalCapacity}`);
}

// --- global priority order: a permutation of every tile id, computed pure --

{
    const order = computeGlobalPriorityOrder(ORDER);
    assert(order.length === NPIX, `priority order should visit every tile exactly once, got length ${order.length}`);
    const seen = new Uint8Array(NPIX);
    for (const t of order) {
        assert(t >= 0 && t < NPIX, `priority order tile id out of range: ${t}`);
        assert(seen[t] === 0, `priority order should not repeat tile ${t}`);
        seen[t] = 1;
    }
    for (let t = 0; t < NPIX; t++) assert(seen[t] === 1, `priority order should include tile ${t}`);
    console.log("global priority order permutation check passed");
}

console.log("tier1-runtime smoke passed");
