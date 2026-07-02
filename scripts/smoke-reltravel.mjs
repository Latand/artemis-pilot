import {
  G_ACCEL_KMS2,
  betaAtCoordTime,
  brachistochronePlan,
  brachistochroneSample,
  coordTimeForDistance,
  coordTimeForProperTime,
  distAtCoordTime,
  properTimeAtCoordTime,
} from "../src/relTravel.js";
import { LY_KM, SEC_YEAR } from "../src/constants.js";

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "   " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "   " + detail : ""}`); }
};
const approx = (actual, expected, rel, label) => {
  const err = Math.abs(actual - expected);
  ok(err <= rel * Math.abs(expected), label, `got ${actual}`);
};
const hr = (t) => console.log("\n" + "-".repeat(60) + "\n  " + t + "\n" + "-".repeat(60));

hr("4.3 ly 1g brachistochrone gate");
const p = brachistochronePlan(4.3 * LY_KM);
approx(p.properTotal / SEC_YEAR, 3.559, 0.02, "ship proper time ~= 3.559 yr");
approx(p.coordTotal / SEC_YEAR, 5.928, 0.02, "Earth coordinate time ~= 5.928 yr");
approx(p.peakGamma, 3.219, 0.02, "peak gamma ~= 3.219");

hr("Closed-form inverse identities");
for (const t of [1e5, 1e7, 1e8]) {
  approx(coordTimeForDistance(G_ACCEL_KMS2, distAtCoordTime(G_ACCEL_KMS2, t)), t, 1e-9, `distance inverse at t=${t}`);
  approx(coordTimeForProperTime(G_ACCEL_KMS2, properTimeAtCoordTime(G_ACCEL_KMS2, t)), t, 1e-9, `proper-time inverse at t=${t}`);
}

hr("Brachistochrone endpoints");
ok(brachistochroneSample(p, 0).beta === 0, "departure beta is exactly zero");
ok(brachistochroneSample(p, p.T).beta <= 1e-9, "arrival beta is near zero");
approx(brachistochroneSample(p, p.tHalf).gamma, p.peakGamma, 1e-9, "midpoint gamma matches peak gamma");
approx(brachistochroneSample(p, p.T).properElapsed, p.properTotal, 1e-9, "arrival proper elapsed matches plan");

hr("Monotonicity and sub-c samples");
const samples = 64;
let prevBeta = -Infinity, prevDist = -Infinity;
let monotonic = true, subC = true;
for (let i = 0; i <= samples; i++) {
  const s = p.T * i / samples;
  const sample = brachistochroneSample(p, s);
  subC = subC && sample.beta < 1 && betaAtCoordTime(p.a, Math.min(s, p.T - s)) < 1;
  if (i > 0) monotonic = monotonic && sample.distKm > prevDist;
  if (s <= p.tHalf) monotonic = monotonic && sample.beta >= prevBeta;
  else monotonic = monotonic && sample.beta <= prevBeta;
  prevBeta = sample.beta;
  prevDist = sample.distKm;
}
ok(monotonic, "beta rises then falls and distance strictly increases");
ok(subC, "sampled beta remains below c");

hr("27000 ly Sgr A* lore gate");
const sgrA = brachistochronePlan(27000 * LY_KM);
const sgrShipYr = sgrA.properTotal / SEC_YEAR;
const sgrEarthYr = sgrA.coordTotal / SEC_YEAR;
ok(sgrShipYr > 10 && sgrShipYr < 60, "27000 ly ship time is decades", `got ${sgrShipYr}`);
approx(sgrEarthYr, 27002, 0.001, "27000 ly Earth time ~= 27002 yr");

console.log("\n" + "=".repeat(60));
console.log(`  ${pass} PASSED   ${fail} FAILED   (${pass + fail} checks)`);
console.log("=".repeat(60));
process.exit(fail ? 1 : 0);
