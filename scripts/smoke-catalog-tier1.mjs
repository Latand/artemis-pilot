import { readFileSync, statSync } from "node:fs";
import { ang2pix_nest, pix2ang_nest, ORDER, NPIX, TILE_CIRCUMRADIUS_DEG } from "../src/universe/healpix.js";

function assert(ok, message) {
    if (!ok) throw new Error(message);
}

const manifestPath = new URL("../public/data/athyg-tier1-manifest.json", import.meta.url);
const binPath = new URL("../public/data/athyg-tier1.bin", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const bin = readFileSync(binPath);

// --- manifest shape ---------------------------------------------------------
assert(manifest.schema === 1, "Tier-1 manifest should be schema 1");
assert(manifest.order === 5, "Tier-1 manifest should use HEALPix order 5");
assert(manifest.npix === 12288, "Tier-1 manifest should have 12288 tiles");
assert(manifest.npix === NPIX, "manifest npix should match healpix.js NPIX");
assert(manifest.recordBytes === 20, "Tier-1 record stride should be 20 bytes");
assert(Array.isArray(manifest.tiles) && manifest.tiles.length === 12288, "manifest should carry exactly 12288 tile entries");

// --- count consistency -------------------------------------------------------
let sumCounts = 0;
for (const [, count] of manifest.tiles) sumCounts += count;
assert(sumCounts === manifest.count, `sum of tile counts (${sumCounts}) should equal manifest.count (${manifest.count})`);
// The plan's back-of-envelope "~2.4M" estimate (2.55M rows - ~110k dupes) didn't
// account for rows AT-HYG itself lacks a usable distance for (~61k, correctly
// skipped per the build spec); the real post-dedup, post-distance-filter count is
// ~2.37M. Assert against that observed reality with headroom, not the estimate.
assert(manifest.count >= 2_300_000, `Tier-1 star count should be >= 2.3M after dedup, got ${manifest.count}`);
assert(statSync(binPath).size === manifest.count * manifest.recordBytes, "Tier-1 binary size should equal count * recordBytes");

// tile byte offsets should be non-decreasing and consistent with counts
let expectedOffset = 0;
for (const [byteOffset, count] of manifest.tiles) {
    assert(byteOffset === expectedOffset, `tile byteOffset ${byteOffset} should equal running offset ${expectedOffset}`);
    expectedOffset += count * manifest.recordBytes;
}
assert(expectedOffset === bin.byteLength, "final running offset should equal file length");

// --- HEALPix round-trip anchors ---------------------------------------------
const anchors = [
    [0, 0], [180, 0], [90, 45], [270, -45], [0, 89], [0, -89], [123.456, -12.34],
];
for (const [ra, dec] of anchors) {
    const pix = ang2pix_nest(ORDER, ra, dec);
    assert(pix >= 0 && pix < NPIX, `ang2pix_nest should return an in-range pixel for ra=${ra} dec=${dec}`);
    const { raDeg, decDeg } = pix2ang_nest(ORDER, pix);
    const dRa = ((raDeg - ra + 540) % 360) - 180;
    const dDec = decDeg - dec;
    const sepApprox = Math.sqrt((dRa * Math.cos(dec * Math.PI / 180)) ** 2 + dDec ** 2);
    assert(sepApprox < 2 * TILE_CIRCUMRADIUS_DEG,
        `pix2ang(ang2pix(ra=${ra},dec=${dec})) should stay within one tile radius, got ${sepApprox} deg`);
}

// --- decode sample tiles: mags plausible, positions finite, membership consistent ---
function decodeTile(byteOffset, count) {
    const records = [];
    for (let i = 0; i < count; i++) {
        const o = byteOffset + i * manifest.recordBytes;
        const x = bin.readFloatLE(o);
        const y = bin.readFloatLE(o + 4);
        const z = bin.readFloatLE(o + 8);
        const mag = bin.readInt16LE(o + 12) / 100;
        const ci = bin.readInt16LE(o + 14) / 1000;
        const pmRa = bin.readInt16LE(o + 16) / 10;
        const pmDec = bin.readInt16LE(o + 18) / 10;
        records.push({ x, y, z, mag, ci, pmRa, pmDec });
    }
    return records;
}

function xyzToRaDec(x, y, z) {
    const dist = Math.sqrt(x * x + y * y + z * z);
    const decDeg = Math.asin(z / dist) * 180 / Math.PI;
    let raDeg = Math.atan2(y, x) * 180 / Math.PI;
    if (raDeg < 0) raDeg += 360;
    return { raDeg, decDeg, dist };
}

const nonEmptyTileIds = [];
for (let t = 0; t < manifest.tiles.length && nonEmptyTileIds.length < 200; t++) {
    if (manifest.tiles[t][1] > 0) nonEmptyTileIds.push(t);
}
assert(nonEmptyTileIds.length > 0, "there should be at least some non-empty Tier-1 tiles");

const sampleTileIds = [
    nonEmptyTileIds[0],
    nonEmptyTileIds[Math.floor(nonEmptyTileIds.length / 2)],
    nonEmptyTileIds[nonEmptyTileIds.length - 1],
];
for (const t of sampleTileIds) {
    const [byteOffset, count] = manifest.tiles[t];
    const records = decodeTile(byteOffset, count);
    assert(records.length === count, "decoded record count should match manifest tile count");
    let prevMag = -Infinity;
    for (const r of records) {
        assert(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z), "Tier-1 positions should be finite");
        assert(r.mag >= -2 && r.mag <= 16, `Tier-1 magnitude out of plausible range: ${r.mag}`);
        assert(r.mag >= prevMag - 1e-6, "stars within a tile should be sorted by magnitude ascending");
        prevMag = r.mag;
        const { raDeg, decDeg } = xyzToRaDec(r.x, r.y, r.z);
        const recomputedPix = ang2pix_nest(ORDER, raDeg, decDeg);
        assert(recomputedPix === t, `recomputed pix ${recomputedPix} from decoded position should match tile id ${t}`);
    }
}

// --- dedup: famous Tier-0 stars must not reappear in Tier-1 -----------------
const tier0Meta = JSON.parse(readFileSync(new URL("../public/data/hyg-stars-v41.json", import.meta.url), "utf8"));
const tier0Bin = readFileSync(new URL("../public/data/hyg-stars-v41.bin", import.meta.url));
const tier0Vals = new Float32Array(tier0Bin.buffer, tier0Bin.byteOffset, tier0Bin.byteLength / 4);

function tier0StarByHip(hip) {
    const row = tier0Meta.labels.find(r => String(r[2]) === String(hip));
    if (!row) return null;
    const i = row[0] * tier0Meta.stride;
    return { x: tier0Vals[i], y: tier0Vals[i + 1], z: tier0Vals[i + 2] };
}

for (const [name, hip] of [["Sirius", 32349], ["Vega", 91262]]) {
    const star = tier0StarByHip(hip);
    assert(star, `smoke fixture needs ${name} (hip ${hip}) present in Tier-0`);
    const { raDeg, decDeg } = xyzToRaDec(star.x, star.y, star.z);
    const pix = ang2pix_nest(ORDER, raDeg, decDeg);
    const [byteOffset, count] = manifest.tiles[pix];
    const records = decodeTile(byteOffset, count);
    const nearby = records.find(r => {
        const dx = r.x - star.x, dy = r.y - star.y, dz = r.z - star.z;
        return dx * dx + dy * dy + dz * dz < 0.01 * 0.01;
    });
    assert(!nearby, `${name} (hip ${hip}) should be deduped out of Tier-1, but a record within 0.01 pc was found in its tile`);
}

console.log(`catalog-tier1 smoke passed: count=${manifest.count} dedupCount=${manifest.dedupCount} tiles=${manifest.tiles.length} binSize=${bin.byteLength}`);
