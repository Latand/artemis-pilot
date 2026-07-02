import { readFileSync } from "node:fs";
import { decodeTileRecords, RECORD_BYTES } from "../src/workers/athygTileWorker.js";
import { deriveStar, ekerMassForL } from "../src/universe/stellar.js";

function assert(ok, message) {
    if (!ok) throw new Error(message);
}

function closeRel(a, b, rel, message) {
    const denom = Math.max(1e-12, Math.abs(b));
    assert(Math.abs(a - b) / denom <= rel, `${message}: got ${a}, expected ${b}`);
}

function massChain(x, y, z, mag) {
    const distPc = Math.hypot(x, y, z);
    const absMag = mag - 5 * Math.log10(distPc / 10);
    const L = Math.pow(10, -0.4 * (absMag - 4.74));
    const mass = ekerMassForL(L);
    return { distPc, absMag, L, mass };
}

const manifest = JSON.parse(readFileSync(new URL("../public/data/athyg-tier1-manifest.json", import.meta.url), "utf8"));
const bin = readFileSync(new URL("../public/data/athyg-tier1.bin", import.meta.url));

assert(manifest.recordBytes === RECORD_BYTES, `manifest recordBytes ${manifest.recordBytes} should match worker RECORD_BYTES ${RECORD_BYTES}`);

for (const M of [0.2, 0.5, 1.0, 2.0, 8.0]) {
    const derived = deriveStar(M);
    const roundTrip = ekerMassForL(derived.L);
    closeRel(roundTrip, M, 0.02, `ekerMassForL round-trip for ${M} Msun`);
}
console.log("ekerMassForL round-trip checks passed");

const nonEmptyTiles = [];
for (let tileId = 0; tileId < manifest.tiles.length && nonEmptyTiles.length < 16; tileId++) {
    if (manifest.tiles[tileId][1] > 0) nonEmptyTiles.push(tileId);
}
assert(nonEmptyTiles.length >= 3, "need at least 3 non-empty Tier-1 tiles");

const samples = [];
for (const tileId of nonEmptyTiles) {
    const [byteOffset, count] = manifest.tiles[tileId];
    const rec = decodeTileRecords(bin.buffer, bin.byteOffset + byteOffset, count, manifest.recordBytes);
    for (let idx = 0; idx < rec.count && samples.length < 3; idx++) {
        const x = rec.positions[idx * 3];
        const y = rec.positions[idx * 3 + 1];
        const z = rec.positions[idx * 3 + 2];
        const mag = rec.magCi[idx * 2] / 100;
        if (Math.hypot(x, y, z) > 0 && Number.isFinite(mag)) {
            samples.push({ tileId, idx, x, y, z, mag });
        }
    }
    if (samples.length >= 3) break;
}
assert(samples.length === 3, "need 3 finite Tier-1 sample stars");

const chain = samples.map(s => ({ ...s, ...massChain(s.x, s.y, s.z, s.mag) }));
for (const s of chain) {
    assert(Number.isFinite(s.mass) && s.mass >= 0.08 && s.mass <= 120, `finite clamped mass for tile ${s.tileId} star ${s.idx}`);
    assert(Number.isFinite(s.L) && s.L > 0, `finite luminosity for tile ${s.tileId} star ${s.idx}`);
    const independentAbsMag = s.mag + 5 - 5 * Math.log10(s.distPc);
    closeRel(s.absMag, independentAbsMag, 1e-12, `distance modulus for tile ${s.tileId} star ${s.idx}`);
}

const sorted = [...chain].sort((a, b) => a.L - b.L);
for (let i = 1; i < sorted.length; i++) {
    assert(sorted[i].mass >= sorted[i - 1].mass, "Eker L-to-mass inversion should be monotone over samples");
}

console.log(`tier1 mass-chain checks passed for ${chain.map(s => `${s.tileId}:${s.idx}`).join(", ")}`);
console.log("tier1-queryable smoke passed");
