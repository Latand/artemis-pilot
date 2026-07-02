import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { ang2pix_nest, ORDER, NPIX } from "../src/universe/healpix.js";

function assert(ok, message) {
    if (!ok) throw new Error(message);
}

function sha256(buf) {
    return createHash("sha256").update(buf).digest("hex");
}

const manifestPath = new URL("../public/data/athyg-tier1-estimated-manifest.json", import.meta.url);
const binPath = new URL("../public/data/athyg-tier1-estimated.bin", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const bin = readFileSync(binPath);

assert(manifest.schema === 1, "estimated manifest should be schema 1");
assert(manifest.order === 5, "estimated manifest should use HEALPix order 5");
assert(manifest.npix === 12288, "estimated manifest should have 12288 tiles");
assert(manifest.npix === NPIX, "estimated manifest npix should match healpix.js NPIX");
assert(manifest.recordBytes === 20, "estimated record stride should be 20 bytes");
assert(Array.isArray(manifest.tiles) && manifest.tiles.length === 12288, "estimated manifest should carry exactly 12288 tile entries");
assert(manifest.estimated === true, "estimated manifest should be flagged estimated=true");

let sumCounts = 0;
let expectedOffset = 0;
for (const [byteOffset, count] of manifest.tiles) {
    assert(byteOffset === expectedOffset, `tile byteOffset ${byteOffset} should equal running offset ${expectedOffset}`);
    expectedOffset += count * manifest.recordBytes;
    sumCounts += count;
}
assert(sumCounts === manifest.count, `sum of tile counts (${sumCounts}) should equal manifest.count (${manifest.count})`);
assert(expectedOffset === bin.byteLength, "final running offset should equal estimated bin length");
assert(statSync(binPath).size === manifest.count * manifest.recordBytes, "estimated binary size should equal count * recordBytes");
assert(manifest.count >= 55_000 && manifest.count <= 61_000, `estimated count should be near the 60,831 no-distance rows minus missing photometry/dedup, got ${manifest.count}`);

function xyzToRaDec(x, y, z) {
    const dist = Math.sqrt(x * x + y * y + z * z);
    const decDeg = Math.asin(z / dist) * 180 / Math.PI;
    let raDeg = Math.atan2(y, x) * 180 / Math.PI;
    if (raDeg < 0) raDeg += 360;
    return { raDeg, decDeg, dist };
}

let checked = 0;
for (let t = 0; t < manifest.tiles.length && checked < 500; t++) {
    const [byteOffset, count] = manifest.tiles[t];
    const limit = Math.min(count, 8);
    let prevMag = -Infinity;
    for (let i = 0; i < limit; i++) {
        const o = byteOffset + i * manifest.recordBytes;
        const x = bin.readFloatLE(o);
        const y = bin.readFloatLE(o + 4);
        const z = bin.readFloatLE(o + 8);
        const mag = bin.readInt16LE(o + 12) / 100;
        const ci = bin.readInt16LE(o + 14) / 1000;
        assert(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), "estimated positions should be finite");
        assert(Number.isFinite(mag) && mag >= -2 && mag <= 18, `estimated magnitude out of plausible range: ${mag}`);
        assert(Number.isFinite(ci), "estimated color index should be finite");
        assert(mag >= prevMag - 1e-6, "estimated stars within a tile should be sorted by magnitude ascending");
        prevMag = mag;
        const { raDeg, decDeg, dist } = xyzToRaDec(x, y, z);
        assert(Number.isFinite(dist) && dist > 0, "estimated distance should be positive and finite");
        const recomputedPix = ang2pix_nest(ORDER, raDeg, decDeg);
        assert(recomputedPix === t, `recomputed pix ${recomputedPix} from estimated position should match tile id ${t}`);
        checked++;
    }
}
assert(checked > 0, "estimated sidecar should contain decodable sample stars");

const primaryPath = new URL("../public/data/athyg-tier1.bin", import.meta.url);
const primary = readFileSync(primaryPath);
assert(primary.byteLength === 47_453_540, `primary Tier-1 bin size changed: ${primary.byteLength}`);
assert(sha256(primary.subarray(0, 4096)) === "08f2b044e463373e1d1e1dfa9d276b5af75a6f2cafbf8ee8de3973f70d43a375", "primary Tier-1 first 4 KiB changed");
assert(sha256(primary.subarray(primary.byteLength - 4096)) === "422f96fd27dddc637da10c42a88e6b1dcc2d2e88761c680658ac9b54bd827367", "primary Tier-1 last 4 KiB changed");

console.log(`catalog-tier1-est smoke passed: count=${manifest.count} tiles=${manifest.tiles.length} binSize=${bin.byteLength}`);

