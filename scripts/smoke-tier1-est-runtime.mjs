import { readFileSync } from "node:fs";
import { ang2pix_nest, ORDER } from "../src/universe/healpix.js";
import { decodeTileRecords, RECORD_BYTES } from "../src/workers/athygTileWorker.js";
import { absMagFromApparent } from "../src/render/viewBrightness.js";

function assert(ok, message) {
    if (!ok) throw new Error(message);
}

const manifest = JSON.parse(readFileSync(new URL("../public/data/athyg-tier1-estimated-manifest.json", import.meta.url), "utf8"));
const bin = readFileSync(new URL("../public/data/athyg-tier1-estimated.bin", import.meta.url));

assert(manifest.estimated === true, "estimated runtime manifest should be flagged estimated=true");
assert(manifest.recordBytes === RECORD_BYTES, `worker RECORD_BYTES (${RECORD_BYTES}) should match estimated manifest.recordBytes (${manifest.recordBytes})`);
assert(bin.byteLength === manifest.count * manifest.recordBytes, "estimated bin size should match count * recordBytes");

function xyzToRaDec(x, y, z) {
    const dist = Math.sqrt(x * x + y * y + z * z);
    const decDeg = Math.asin(z / dist) * 180 / Math.PI;
    let raDeg = Math.atan2(y, x) * 180 / Math.PI;
    if (raDeg < 0) raDeg += 360;
    return { raDeg, decDeg, dist };
}

const sampleTiles = [];
for (let t = 0; t < manifest.tiles.length && sampleTiles.length < 5; t++) {
    if (manifest.tiles[t][1] > 0) sampleTiles.push(t);
}
assert(sampleTiles.length > 0, "estimated runtime smoke needs non-empty sidecar tiles");

let decodedCount = 0;
for (const tileId of sampleTiles) {
    const [byteOffset, count] = manifest.tiles[tileId];
    const rec = decodeTileRecords(bin.buffer, bin.byteOffset + byteOffset, count);
    assert(rec.count === count, `decoded count should match estimated manifest for tile ${tileId}`);
    assert(rec.positions.length === count * 3, "positions array should be count*3 floats");
    assert(rec.magCi.length === count * 2, "magCi array should be count*2 int16s");
    assert(rec.pm.length === count * 2, "pm array should be count*2 int16s");

    const limit = Math.min(count, 40);
    for (let i = 0; i < limit; i++) {
        const x = rec.positions[i * 3], y = rec.positions[i * 3 + 1], z = rec.positions[i * 3 + 2];
        const mag = rec.magCi[i * 2] / 100;
        const ci = rec.magCi[i * 2 + 1] / 1000;
        assert(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), `estimated decoded position should be finite (tile ${tileId}, star ${i})`);
        assert(Number.isFinite(mag), `estimated decoded magnitude should be finite (tile ${tileId}, star ${i})`);
        assert(Number.isFinite(ci), `estimated decoded ci should be finite (tile ${tileId}, star ${i})`);
        const { raDeg, decDeg, dist } = xyzToRaDec(x, y, z);
        assert(raDeg >= 0 && raDeg < 360, `estimated ra should be plausible: ${raDeg}`);
        assert(decDeg >= -90 && decDeg <= 90, `estimated dec should be plausible: ${decDeg}`);
        assert(dist > 0 && Number.isFinite(dist), `estimated distance should be positive and finite: ${dist}`);
        assert(ang2pix_nest(ORDER, raDeg, decDeg) === tileId, `estimated decoded star should belong to tile ${tileId}`);
        const absMag = absMagFromApparent(mag, dist);
        assert(Number.isFinite(absMag) && absMag >= -12 && absMag <= 25, `estimated absMag should be finite and plausible: ${absMag}`);
        decodedCount++;
    }
}

console.log(`tier1-est-runtime smoke passed: decoded ${decodedCount} estimated stars across ${sampleTiles.length} sample tiles`);

