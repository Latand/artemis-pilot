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
//   T2 (structural): split by how each field is derived.
//     T2a (exact)    positions (gx,gy,gz) and age come from uniforms through
//                    pure arithmetic (cell origin + u*size, age = u*span) and
//                    must hash identically at full 64-bit precision on ANY
//                    engine (hash dd945708, V8 12.4 == JavaScriptCore).
//     T2b (1e-12)    mass is NOT pure arithmetic: sampleIMFMass returns
//                    Math.pow(10, logm), an implementation-approximated
//                    transcendental. V8 12.x changed Math.pow's last bit, so
//                    52 of the 500 masses moved by 1 ulp and the old 5-field
//                    exact hash went 392d861 (JSC, older V8) -> 176505a1
//                    (node 22). Mass is therefore pinned through order-
//                    sensitive moments (sum m, sum m^2, sum (i+1) m) at a
//                    1e-12 relative tolerance: immune to last-ulp drift
//                    (which moves them ~1e-16) yet still broken by any real
//                    change to the IMF table, the rng streams or the order.
//                    (A 12- or 14-digit hash is NOT robust: a 1-ulp shift
//                    crosses a decimal rounding boundary with probability
//                    ~ulp/bin per value, i.e. a few percent over 500 masses.)
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
const ARITHMETIC = ["gx", "gy", "gz", "age"];
// Pinned on V8 12.4 (node 22) and JavaScriptCore (bun 1.3); both agree to
// the printed digits (the weighted sum differs in its 17th digit only).
const MASS_MOMENTS = { sum: 204.40440747906933, sumSq: 138.83863092264193, weighted: 52257.93605591413 };
const MASS_REL_TOL = 1e-12;
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

// T2a: arithmetic-only structural fields pinned cross-engine at full precision
const arithmetic = hashExact(a, ARITHMETIC).toString(16);
assert(arithmetic === "dd945708", "T2a positions+age exact hash must equal dd945708 (V8/JSC verified), got " + arithmetic);
// T2b: transcendental-derived mass pinned through order-sensitive moments
let mSum = 0, mSumSq = 0, mWeighted = 0;
a.forEach((s, i) => { mSum += s.mass; mSumSq += s.mass * s.mass; mWeighted += (i + 1) * s.mass; });
const rel = (got, want) => Math.abs(got - want) / Math.abs(want);
for (const [name, got] of [["sum", mSum], ["sumSq", mSumSq], ["weighted", mWeighted]]) {
    assert(rel(got, MASS_MOMENTS[name]) <= MASS_REL_TOL,
        "T2b mass moment " + name + " must match " + MASS_MOMENTS[name] + " within " + MASS_REL_TOL + ", got " + got);
}
// Informational only: the legacy all-structural exact hash (engine-dependent
// through mass; 392d861 on JSC/older V8, 176505a1 on V8 12.x).
const structural = hashExact(a, STRUCTURAL).toString(16);
// T3: full record pinned at 12 significant digits (verified V8 == JSC)
const full12 = hash12(a, FULL).toString(16);
assert(full12 === "ef2c1f9a", "T3 full-record 12-digit hash must equal ef2c1f9a (V8/JSC verified), got " + full12);

console.log("determinism smoke passed  arithmetic=" + arithmetic + "  massSum=" + mSum +
    "  full12=" + full12 + "  (legacy structural=" + structural + ", engine-dependent)");
