// WP20 cross-engine determinism gate.
//
// Policy (decided after the Wave-1 review, documented in the upgrade plan):
// the determinism GUARANTEE is anchored at the uniform-draw level — the PRNG
// pipeline (hashInts / mulberry32 / splitSeed) uses only 32-bit integer ops
// plus exact power-of-two division, so it is provably bit-identical on every
// conforming engine. Quantities derived through ECMAScript's
// implementation-approximated transcendentals (Math.pow/log10 in the Eker
// relations, cos/sin azimuth projections, the AS241 tail's log) may differ in
// the final ULPs between engines.
//
// Tiers asserted here:
//   T1 (exact):      same-engine reruns are bit-identical, full precision.
//   T2 (exact):      STRUCTURAL fields — positions (gx,gy,gz), mass, age —
//                    derive from uniforms via pure arithmetic (inverse-CDF
//                    tables, rejection sampling) and must hash identically
//                    at full 64-bit precision on ANY engine.
//   T3 (12 digits):  the FULL record (adding L, Teff, vx, vy, vz, feh) must
//                    hash identically after rounding to 12 significant
//                    digits — the same precision bar smoke-physics3d's
//                    digest uses. Verified matching on V8 (node) and
//                    JavaScriptCore (bun): hash12 = ef2c1f9a @ seed
//                    0x9e3779b9, 500 stars. If T3 fails on a new engine but
//                    T2 passes, the universe's STRUCTURE is still identical
//                    and only last-ULP photometry differs — investigate but
//                    the guarantee holds.
//
// Run under BOTH engines and compare stdout:
//   node scripts/smoke-determinism.mjs && bun scripts/smoke-determinism.mjs
globalThis.window = {};
const { sampleStarsNear, setSeed } = await import("../src/universe/galaxy.js");

function assert(ok, msg) { if (!ok) { console.error("FAIL: " + msg); process.exit(1); } }

const SEED = 0x9e3779b9, N = 500;
const STRUCTURAL = ["gx", "gy", "gz", "mass", "age"];
const FULL = ["gx", "gy", "gz", "mass", "L", "Teff", "vx", "vy", "vz", "age", "feh"];

function sample() {
    setSeed(SEED);
    return sampleStarsNear(8178, 0, 20.8, 30).slice(0, N);
}

const dv = new DataView(new ArrayBuffer(8));
function hashExact(stars, fields) {
    let h = 2166136261;
    for (const s of stars) for (const f of fields) {
        dv.setFloat64(0, s[f] ?? 0);
        h = (Math.imul(h ^ dv.getUint32(0), 16777619) ^ Math.imul(dv.getUint32(4), 2654435761)) >>> 0;
    }
    return h >>> 0;
}
function hash12(stars, fields) {
    let h = 2166136261;
    for (const s of stars) for (const f of fields) {
        const str = Number(s[f] ?? 0).toPrecision(12);
        for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0;
    }
    return h >>> 0;
}

const a = sample(), b = sample();
assert(a.length === b.length && a.length >= N, "sample size stable, got " + a.length);

// T1: same-engine rerun, full precision, all fields
assert(hashExact(a, FULL) === hashExact(b, FULL), "T1 same-engine rerun must be bit-identical");

// T2: structural fields pinned cross-engine at full precision
const structural = hashExact(a, STRUCTURAL).toString(16);
assert(structural === "392d861", "T2 structural exact hash must equal 392d861 (V8/JSC verified), got " + structural);
// T3: full record pinned at 12 significant digits (verified V8 == JSC)
const full12 = hash12(a, FULL).toString(16);
assert(full12 === "ef2c1f9a", "T3 full-record 12-digit hash must equal ef2c1f9a (V8/JSC verified), got " + full12);

console.log("determinism smoke passed  structural=" + structural + "  full12=" + full12);
