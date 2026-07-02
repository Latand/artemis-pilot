globalThis.window = {};
const { MU_S, C_LIGHT, K } = await import("../src/constants.js");
const { BH, bhRegister } = await import("../src/state.js");
const { L_EDD_PER_MSUN, iscoKm } = await import("../src/tde.js");
const { hashInts, splitSeed } = await import("../src/universe/prng.js");
function assert(ok, m, c) { if (!ok) throw new Error(m + (c ? " " + JSON.stringify(c) : "")); }
// quasar presets: mu from rs must equal the target solar masses to 0.1%
for (const [rsKm, msun] of [[2.9532e8, 1e8], [2.9532e9, 1e9]]) {
  bhRegister(0, 0, 0, rsKm, 0, 0, null, 1, 0);
  assert(Math.abs(BH.mu[0] / (msun * MU_S) - 1) < 1e-3, "quasar mu off", { mu: BH.mu[0], msun });
  assert(BH.kind[0] === 1, "kind rail");
  assert(L_EDD_PER_MSUN * msun > 1e38 && L_EDD_PER_MSUN * msun < 2e40, "L_Edd sanity");
  assert(iscoKm(rsKm) === 3 * rsKm, "ISCO");
}
// pulsar: 1.4 Msun through the rs interface, surface sink
bhRegister(1, 0, 0, 4.1345, 0, 0, null, 2, 0.0334);
assert(Math.abs(BH.mu[1] / (1.4 * MU_S) - 1) < 1e-3, "pulsar mu", { mu: BH.mu[1] });
assert(Math.abs(BH.sinkS[1] - 12 * K) < 1e-12, "pulsar sink = NS surface");
assert(BH.period[1] === 0.0334, "period stored");
// placement seeds: deterministic, distinct per counter and kind
const s1 = splitSeed(hashInts(0x45584f21, 0), 1), s2 = splitSeed(hashInts(0x45584f21, 1), 1);
assert(s1 === splitSeed(hashInts(0x45584f21, 0), 1) && s1 !== s2, "placement seed determinism");
// pulsar sweep aliasing policy: Crab aliased at real time, visible in slow-mo;
// slow pulsars sweep live at warp 1
const aliased = (warp, period) => (warp / 60) > (period / 8);
assert(aliased(1, 0.0334) && !aliased(0.01, 0.0334), "Crab: time-avg at 1x, sweeps at 0.01x");
assert(!aliased(1, 1.3373) && aliased(60, 1.3373), "B1919: sweeps at 1x, time-avg at 60x");
// spin angle is pure sim time (deterministic)
const ang = (t, p) => (t % p) / p * 2 * Math.PI;
// periodicity is checked by adding exactly one PERIOD (the plan's +1.0 s is
// not an integer number of Crab periods: 1/0.0334 = 29.94)
assert(Math.abs(ang(0.777, 0.0334) - ang(0.777 + 0.0334, 0.0334)) < 1e-6, "spin angle periodic in sim time");
BH.n = 0; // leave state clean
console.log("exotic smoke passed");
