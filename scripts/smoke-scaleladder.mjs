import { AU_KM, LY_KM, PC_KM, MPC_KM } from "../src/constants.js";
import { scaleRungLabel, lightTravelLabel } from "../src/scaleLadder.js";

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "   " + detail : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? "   " + detail : ""}`); }
};
const has = (actual, prefix, label) => ok(actual.startsWith(prefix), label, actual);
const approxText = (actual, expected, relTol, label) => {
  const value = Number.parseFloat(actual);
  ok(Number.isFinite(value) && Math.abs(value - expected) <= relTol * Math.abs(expected), label, actual);
};
const hr = t => console.log("\n" + "-".repeat(60) + "\n  " + t + "\n" + "-".repeat(60));

hr("Scale rung thresholds");
has(scaleRungLabel(0.1 * AU_KM - 1), "SUB-AU", "just under 0.1 AU is sub-AU");
has(scaleRungLabel(0.1 * AU_KM), "AU", "0.1 AU enters AU rung");
has(scaleRungLabel(0.5 * LY_KM - 1), "AU", "just under 0.5 ly stays AU");
has(scaleRungLabel(0.5 * LY_KM), "LIGHT-YEAR", "0.5 ly enters light-year rung");
has(scaleRungLabel(500 * LY_KM - 1), "LIGHT-YEAR", "just under 500 ly stays light-year");
has(scaleRungLabel(500 * LY_KM), "PARSEC", "500 ly enters parsec rung");
has(scaleRungLabel(2999.999 * PC_KM), "PARSEC", "just under 3000 pc stays parsec");
has(scaleRungLabel(3000 * PC_KM), "KILOPARSEC", "3000 pc enters kiloparsec rung");
has(scaleRungLabel(999999.9 * PC_KM), "KILOPARSEC", "just under 1e6 pc stays kiloparsec");
has(scaleRungLabel(1e6 * PC_KM), "MEGAPARSEC", "1e6 pc enters megaparsec rung");
has(scaleRungLabel(MPC_KM * 2.5), "MEGAPARSEC", "Mpc values format as megaparsec");

hr("Light-travel labels");
ok(lightTravelLabel(AU_KM) === "8.3 min", "1 AU is about 499 s / 8.3 min", lightTravelLabel(AU_KM));
approxText(lightTravelLabel(LY_KM), 1.00, 0.001, "1 ly is 1.00 yr");
approxText(lightTravelLabel(4.3 * LY_KM), 4.3, 0.001, "4.3 ly is 4.30 yr");

hr("Defensive clamps");
ok(!/NaN|· -/.test(scaleRungLabel(0)), "zero camera distance is finite", scaleRungLabel(0));
ok(!/NaN|· -/.test(scaleRungLabel(-42)), "negative camera distance clamps", scaleRungLabel(-42));
ok(lightTravelLabel(0) === "—", "zero light distance returns dash");
ok(lightTravelLabel(-42) === "—", "negative light distance returns dash");

console.log(`\nScale ladder smoke: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
