// Smoke test for src/universe/cosmicEra.js (WP23c: deep-time cosmic era
// modulation — star-formation decline, field reddening, and the eventual
// degenerate era). Pure-Node, no DOM/Three.js dependency: eraModulation()
// is a plain deterministic function of simTSeconds.
import { eraModulation } from "../src/universe/cosmicEra.js";

function assert(cond, msg) {
  if (!cond) throw new Error("smoke-cosmic-era FAILED: " + msg);
}

// Julian Gyr, independently derived here (not imported from cosmicEra.js) so
// this test doesn't just echo the module's own unit conversion.
const GYR_S = 1e9 * 365.25 * 86400;
const secAt = (gyr) => gyr * GYR_S;

// All five fields are normalized to [0,1] by construction; every value below
// must land in that range and be finite everywhere from "now" out to well
// past the nominal 1e15 yr degenerate-era horizon.
const FIELDS = ["sfr", "blueFrac", "redshiftTint", "lumFactor", "degenerate"];
function assertShape(e, label) {
  for (const k of FIELDS) {
    assert(typeof e[k] === "number" && Number.isFinite(e[k]), `${label}: ${k} must be a finite number, got ${e[k]}`);
    assert(e[k] >= -1e-9 && e[k] <= 1 + 1e-9, `${label}: ${k}=${e[k]} out of [0,1]`);
  }
}

// --- era(now) is the unmodulated present day --------------------------------
{
  const e = eraModulation(0);
  assertShape(e, "t=0");
  assert(Math.abs(e.sfr - 1) < 1e-9, `sfr(now) must be ~1, got ${e.sfr}`);
  assert(Math.abs(e.blueFrac - 1) < 1e-9, `blueFrac(now) must be ~1, got ${e.blueFrac}`);
  assert(Math.abs(e.lumFactor - 1) < 1e-9, `lumFactor(now) must be ~1, got ${e.lumFactor}`);
  assert(e.degenerate < 1e-6, `degenerate(now) must be ~0, got ${e.degenerate}`);
}

// Also accept negative/garbage input (e.g. a save restored with a stale
// clock) without going non-finite or negative-time — must clamp to "now".
{
  const e = eraModulation(-12345);
  assertShape(e, "t<0");
  assert(Math.abs(e.sfr - 1) < 1e-9, "negative simT must clamp to t=0 behavior");
}

// --- sfr < 0.1 by +15 Gyr ----------------------------------------------------
{
  const e = eraModulation(secAt(15));
  assert(e.sfr < 0.1, `sfr at +15 Gyr must be < 0.1, got ${e.sfr}`);
}

// --- blueFrac ~0 within 1 Gyr after sfr first drops below 0.1 --------------
// Find the crossing by bisection on the (monotone-decreasing) sfr curve.
{
  let lo = 0, hi = 30; // Gyr; sfr(30) is already far below 0.1 (checked below)
  assert(eraModulation(secAt(hi)).sfr < 0.1, "bisection upper bound must already be below the sfr=0.1 threshold");
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (eraModulation(secAt(mid)).sfr < 0.1) hi = mid; else lo = mid;
  }
  const crossingGyr = hi;
  const eAfter = eraModulation(secAt(crossingGyr + 1));
  assert(eAfter.blueFrac < 0.05, `blueFrac must be ~0 within 1 Gyr after the sfr<0.1 crossing (${crossingGyr.toFixed(2)} Gyr), got ${eAfter.blueFrac}`);
}

// --- lumFactor < 0.01 by 1e13 yr --------------------------------------------
{
  const e = eraModulation(secAt(1e4)); // 1e13 yr = 1e4 Gyr
  assert(e.lumFactor < 0.01, `lumFactor at 1e13 yr must be < 0.01, got ${e.lumFactor}`);
}

// --- degenerate > 0.9 by 3e14 yr --------------------------------------------
{
  const e = eraModulation(secAt(3e5)); // 3e14 yr = 3e5 Gyr
  assert(e.degenerate > 0.9, `degenerate at 3e14 yr must be > 0.9, got ${e.degenerate}`);
}

// --- reddens between 10 and 100 Gyr -----------------------------------------
{
  const before = eraModulation(secAt(10));
  const after = eraModulation(secAt(100));
  assert(before.redshiftTint < 0.05, `redshiftTint at 10 Gyr must still be near 0, got ${before.redshiftTint}`);
  assert(after.redshiftTint > 0.95, `redshiftTint at 100 Gyr must be near saturated, got ${after.redshiftTint}`);
}

// --- monotonicity + continuity across 1e9..1e15 yr --------------------------
// sfr/blueFrac/lumFactor are non-increasing; redshiftTint/degenerate are
// non-decreasing. "No jumps > 5%" is read as an absolute difference bound of
// 0.05 between adjacent samples, since every field is already normalized to
// [0,1] (an absolute bound sidesteps relative-jump blow-up near zero, e.g.
// degenerate going 1e-10 -> 2e-10 is a meaningless "100% jump").
// N=3000 log-spaced samples give ~0.03 max adjacent jump empirically
// (verified against N=1000/2000/4000/8000 before picking this density) --
// comfortable margin under the 0.05 bound.
{
  const N = 3000;
  const loLog = Math.log10(1e9), hiLog = Math.log10(1e15);
  const NONINCREASING = ["sfr", "blueFrac", "lumFactor"];
  const NONDECREASING = ["redshiftTint", "degenerate"];
  const MONO_EPS = 1e-9;   // float-noise tolerance for the monotone check
  const JUMP_MAX = 0.05;
  let prev = null, prevT = null;
  for (let i = 0; i < N; i++) {
    const logYr = loLog + (hiLog - loLog) * i / (N - 1);
    const tYr = Math.pow(10, logYr);
    const e = eraModulation(tYr * (GYR_S / 1e9)); // tYr years -> seconds
    assertShape(e, `t=${tYr.toExponential(3)}yr`);
    if (prev) {
      for (const k of NONINCREASING) {
        assert(e[k] <= prev[k] + MONO_EPS, `${k} increased from ${prev[k]} to ${e[k]} between t=${prevT.toExponential(3)} and t=${tYr.toExponential(3)} yr`);
      }
      for (const k of NONDECREASING) {
        assert(e[k] >= prev[k] - MONO_EPS, `${k} decreased from ${prev[k]} to ${e[k]} between t=${prevT.toExponential(3)} and t=${tYr.toExponential(3)} yr`);
      }
      for (const k of FIELDS) {
        const jump = Math.abs(e[k] - prev[k]);
        assert(jump <= JUMP_MAX, `${k} jumped by ${jump.toFixed(4)} (> ${JUMP_MAX}) between t=${prevT.toExponential(3)} and t=${tYr.toExponential(3)} yr`);
      }
    }
    prev = e; prevT = tYr;
  }
}

// --- stays finite and sane far beyond the nominal 1e15 yr horizon ----------
{
  const e = eraModulation(secAt(1e12)); // 1e21 yr
  assertShape(e, "t=1e21yr");
  assert(e.degenerate > 0.999, "far future must be fully degenerate");
  assert(e.lumFactor < 1e-6, "far future field luminosity must be essentially extinguished");
}

console.log("cosmic-era smoke passed");
