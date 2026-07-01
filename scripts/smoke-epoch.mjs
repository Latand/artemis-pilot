// Smoke test for src/epoch.js (WP21: real-date epoch + Gregorian calendar HUD).
// Deterministic: every epochMs/simElapsedSeconds input below is passed
// explicitly. No Date.now() call happens in this file — getEpochMs() is only
// exercised after setEpochMs() has already primed the module state, so the
// lazy Date.now() fallback inside epoch.js is never reached here.
import {
  J2000_MS, J2000_JD,
  jdToGregorian, civilDateAt, fmtCivil,
  secondsSinceJ2000, epochOffsetSeconds, meanAnomalyAdvance,
  getEpochMs, setEpochMs,
} from "../src/epoch.js";

function assert(cond, msg) {
  if (!cond) throw new Error("smoke-epoch FAILED: " + msg);
}
function deepEq(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

// --- jdToGregorian round-trips, independent of J2000_MS's epoch offset -----
// Reference JD is derived straight from the well-known Unix-epoch<->JD
// constant (JD 2440587.5 == 1970-01-01T00:00:00Z), NOT from anything in
// epoch.js, so this validates jdToGregorian as a pure JD<->calendar function.
function refJD(y, m, d, hh = 0, mm = 0, ss = 0) {
  const ms = Date.UTC(y, m - 1, d, hh, mm, ss);
  return 2440587.5 + ms / 86400000;
}
const roundTripCases = [
  { y: 2000, m: 1, d: 1, hh: 12, mm: 0, ss: 0 },   // J2000.0 itself: JD must land exactly on 2451545.0
  { y: 2026, m: 7, d: 2, hh: 0, mm: 0, ss: 0 },     // today
  { y: 2024, m: 2, d: 29, hh: 0, mm: 0, ss: 0 },    // leap day
  { y: 2100, m: 2, d: 28, hh: 0, mm: 0, ss: 0 },    // century non-leap (2100 % 400 != 0): Feb has only 28 days
  { y: -4800, m: 1, d: 1, hh: 0, mm: 0, ss: 0 },    // ancient date -> negative JD sanity
];
for (const c of roundTripCases) {
  const jd = refJD(c.y, c.m, c.d, c.hh, c.mm, c.ss);
  const g = jdToGregorian(jd);
  assert(deepEq(g, c), `jdToGregorian round-trip for ${c.y}-${c.m}-${c.d} got ${JSON.stringify(g)}`);
}
assert(refJD(2000, 1, 1, 12, 0, 0) === J2000_JD, "refJD(2000-01-01 12:00 UTC) must equal J2000_JD exactly");
assert(refJD(-4800, 1, 1) < 0, "the ancient-date case must actually exercise a negative JD");

// --- civilDateAt: mode selection wiring (JD/year math delegated to the -----
// already-validated jdToGregorian above) ------------------------------------
function civilAtYears(years) {
  // epochMs = J2000_MS so secondsSinceJ2000(epochMs) == 0; simElapsedSeconds
  // alone then carries the full offset from year 2000.
  const simElapsedSeconds = (years - 2000) * 31557600;
  return civilDateAt(J2000_MS, simElapsedSeconds);
}
assert(civilAtYears(2026).mode === "date", "year 2026 must be mode 'date'");
assert(civilAtYears(269999).mode === "date", "year 269,999 must still be mode 'date' (below the 270,000 boundary)");
assert(civilAtYears(270001).mode === "year", "year 270,001 must be mode 'year' (above the 270,000 boundary)");
assert(civilAtYears(999999999999).mode === "year", "year ~1e12-1 must still be mode 'year'");
assert(civilAtYears(1000000000001).mode === "myr", "year >1e12 must be mode 'myr'");

// civilDateAt(J2000_MS, 0): totalSec since J2000 is exactly 0, so JD is
// exactly J2000_JD (2451545.0) -> the standard JD convention gives noon UTC.
// This is the documented ~64.184s TT-vs-UTC approximation epoch.js accepts:
// J2000_MS is the real 11:58:55.816Z UTC instant, but because it is *defined*
// as the zero-point of secondsSinceJ2000, it maps to the same civil instant
// as JD 2451545.0's canonical "noon" rendering.
const atJ2000 = civilDateAt(J2000_MS, 0);
assert(deepEq(atJ2000, { mode: "date", y: 2000, m: 1, d: 1, hh: 12, mm: 0, ss: 0 }),
  "civilDateAt(J2000_MS, 0) must render as 2000-01-01 12:00:00 UTC, got " + JSON.stringify(atJ2000));

// A "today"-ish case, cross-checked against the independently-validated
// jdToGregorian rather than a hand-picked magic string.
{
  const epochMs = Date.UTC(2026, 6, 2, 15, 30, 0);
  const simElapsedSeconds = 12345;
  const totalSec = secondsSinceJ2000(epochMs) + simElapsedSeconds;
  const expected = jdToGregorian(J2000_JD + totalSec / 86400);
  const got = civilDateAt(epochMs, simElapsedSeconds);
  assert(got.mode === "date", "the 2026 case must be mode 'date'");
  assert(deepEq(got, { mode: "date", ...expected }), `civilDateAt/jdToGregorian mismatch: ${JSON.stringify(got)} vs ${JSON.stringify(expected)}`);
}

// --- fmtCivil formatting ----------------------------------------------------
assert(fmtCivil({ mode: "date", y: 2026, m: 7, d: 2, hh: 0, mm: 0, ss: 0 }) === "2026-07-02 00:00:00 UTC",
  "fmtCivil date formatting/padding");
assert(fmtCivil({ mode: "date", y: 2024, m: 2, d: 29, hh: 9, mm: 5, ss: 3 }) === "2024-02-29 09:05:03 UTC",
  "fmtCivil single-digit padding");
assert(fmtCivil({ mode: "year", yearsCE: "4,512,034,871" }) === "Year 4,512,034,871 CE",
  "fmtCivil year-mode formatting");
assert(fmtCivil({ mode: "myr", tPlusYears: 34.4e9 }) === "T+34.40 Gyr", "fmtCivil myr-mode (Gyr range) formatting");
assert(fmtCivil({ mode: "myr", tPlusYears: 5e18 }) === "T+5.00e+9 Gyr", "fmtCivil myr-mode (exponential range) formatting");

// yearsCE digit grouping, produced by civilDateAt itself
{
  const g = civilAtYears(4512034871);
  assert(g.mode === "year" && g.yearsCE === "4,512,034,871", "civilDateAt digit-grouped yearsCE, got " + JSON.stringify(g));
}

// --- meanAnomalyAdvance / epoch offset helpers ------------------------------
assert(Math.abs(meanAnomalyAdvance(1000, 1000) - 2 * Math.PI) < 1e-12, "meanAnomalyAdvance(period, period) ~= 2pi");
assert(Math.abs(meanAnomalyAdvance(500, 1000) - Math.PI) < 1e-12, "meanAnomalyAdvance(period/2, period) ~= pi");
assert(secondsSinceJ2000(J2000_MS) === 0, "secondsSinceJ2000(J2000_MS) must be exactly 0");

// getEpochMs/setEpochMs: prime the module state via setEpochMs() BEFORE the
// first getEpochMs() read, so the lazy Date.now() fallback is never invoked.
setEpochMs(946684800000);
assert(getEpochMs() === 946684800000, "setEpochMs must override the lazy epoch state");
assert(epochOffsetSeconds() === secondsSinceJ2000(946684800000), "epochOffsetSeconds must compose getEpochMs+secondsSinceJ2000");

// --- midnight-boundary rounding (review F1) --------------------------------
// A time within 0.5 s below midnight must roll the DATE forward and read
// 00:00:00 — never hh=24 on the previous day.
{
  const g = jdToGregorian(2451545.4999995); // 2000-01-01 23:59:59.957 UT
  assert(g.y === 2000 && g.m === 1 && g.d === 2 && g.hh === 0 && g.mm === 0 && g.ss === 0,
    "midnight-boundary rounding must roll to next day 00:00:00, got " + JSON.stringify(g));
  const h = jdToGregorian(2451545.5); // exactly midnight
  assert(h.y === 2000 && h.m === 1 && h.d === 2 && h.hh === 0 && h.mm === 0 && h.ss === 0,
    "exact midnight must be next day 00:00:00, got " + JSON.stringify(h));
}

console.log("epoch smoke passed");
