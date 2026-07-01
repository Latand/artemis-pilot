// Real-date epoch + Gregorian calendar helpers (WP21).
//
// Pure, dependency-free by design (no imports from constants.js or anywhere
// else) so this module can never be pulled into an import cycle and stays
// trivially testable: every exported function is deterministic given its
// arguments, with the sole exception of the lazy Date.now() default below.
//
// TT vs UTC: J2000.0 is conventionally 2000-01-01 12:00:00 **Terrestrial
// Time**, which is 2000-01-01 11:58:55.816 UTC (TT leads UTC by ~64.184 s at
// that date: 32 s TAI-UTC + 32.184 s TT-TAI). For a game-scale simulation the
// ~64 s offset is irrelevant next to the day/century timescales the HUD
// displays, so everywhere below treats wall-clock UTC millis as if they were
// TT millis and ignores the offset. J2000_MS is the UTC instant that is
// numerically closest to true J2000.0, i.e. Date.UTC(2000,0,1,11,58,55,816).

export const J2000_MS = Date.UTC(2000, 0, 1, 11, 58, 55, 816);
export const J2000_JD = 2451545.0;
const SEC_YEAR = 31557600; // Julian year, 365.25 days — matches constants.js SEC_YEAR
const SEC_DAY = 86400;

// --- epoch state -----------------------------------------------------------
// The ONLY permitted Date.now() call site in the codebase. It is deliberately
// lazy: the first call to getEpochMs() reads the real wall clock exactly
// once, so a restored save can call setEpochMs() before that first read and
// override it with the persisted value instead. src/epoch.js is NOT one of
// the files scanned by smoke-core.mjs's forbidden-source check (that scan is
// scoped to src/universe/*.js + validate-astro.mjs) — this is the intended,
// documented exception to the "no non-deterministic primitives" rule.
let _epochMs = null;
export function getEpochMs() {
    if (_epochMs === null) _epochMs = Date.now();
    return _epochMs;
}
export function setEpochMs(ms) { _epochMs = ms; }

export function secondsSinceJ2000(epochMs) {
    return (epochMs - J2000_MS) / 1000;
}
// Convenience for WP13's resetEphem hook: seconds from J2000 to the current
// epoch (real "now", or the restored save's epoch once setEpochMs() ran).
export function epochOffsetSeconds() {
    return secondsSinceJ2000(getEpochMs());
}

// Mean-anomaly advance over an elapsed interval for a body of the given
// orbital period (same units as elapsedSeconds). Unwrapped on purpose — sin/
// cos consumers are already 2π-periodic, so the caller (WP13) can add this
// straight onto a stored phase without a modulo step.
export function meanAnomalyAdvance(elapsedSeconds, periodSeconds) {
    return 2 * Math.PI * elapsedSeconds / periodSeconds;
}

// --- Julian Day -> proleptic Gregorian calendar -----------------------------
// Fliegel & Van Flandern / Meeus algorithm. Valid across the huge JD range we
// need (mode 'date' stays within +-270000 yr of J2000, i.e. JD within ~1e8 of
// 2451545 - far inside float64's exact-integer range). The Gregorian-reform
// correction (the alpha/A step) is applied UNCONDITIONALLY rather than only
// for JD >= the 1582 reform date: the reference implementation switches to
// the historical Julian calendar before 1582, but this app (and JS's own
// Date object) needs a purely proleptic Gregorian calendar with no Julian
// mixing, since nothing here represents historical Julian-calendar dates.
export function jdToGregorian(jd) {
    // Round to whole seconds AT THE JD LEVEL first (review F1): the day
    // number and the second-of-day then derive from the same integer, so a
    // time within 0.5 s of midnight rolls the calendar date forward instead
    // of producing hh=24 with the previous day's date.
    const totalSec = Math.round((jd + 0.5) * SEC_DAY);
    const Z = Math.floor(totalSec / SEC_DAY);
    let ss = totalSec - Z * SEC_DAY;
    const alpha = Math.floor((Z - 1867216.25) / 36524.25);
    const A = Z + 1 + alpha - Math.floor(alpha / 4);
    const B = A + 1524;
    const C = Math.floor((B - 122.1) / 365.25);
    const D = Math.floor(365.25 * C);
    const E = Math.floor((B - D) / 30.6001);
    const d = B - D - Math.floor(30.6001 * E);
    const month = E < 14 ? E - 1 : E - 13;
    const year = month > 2 ? C - 4716 : C - 4715;
    const hh = Math.floor(ss / 3600); ss -= hh * 3600;
    const mm = Math.floor(ss / 60); ss -= mm * 60;
    return { y: year, m: month, d, hh, mm, ss };
}

const DATE_MODE_MAX_YEARS = 270000; // ECMAScript-Date-safe-range-inspired bound (~273,790 yr); see plan WP21
const YEAR_MODE_MAX_YEARS = 1e12;

const yearGroupCache = new Map();
function fmtYearGrouped(y) {
    const yr = Math.floor(y);
    const cached = yearGroupCache.get(yr);
    if (cached !== undefined) return cached;
    const out = String(Math.abs(yr)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const signed = yr < 0 ? "-" + out : out;
    if (yearGroupCache.size > 512) yearGroupCache.clear();
    yearGroupCache.set(yr, signed);
    return signed;
}

// Civil date/year/deep-time state at (epochMs + simElapsedSeconds). Pure and
// deterministic given its two numeric inputs — no wall-clock reads.
export function civilDateAt(epochMs, simElapsedSeconds) {
    const totalSec = secondsSinceJ2000(epochMs) + simElapsedSeconds;
    const approxYear = 2000 + totalSec / SEC_YEAR;
    if (Math.abs(approxYear) < DATE_MODE_MAX_YEARS) {
        const jd = J2000_JD + totalSec / SEC_DAY;
        const g = jdToGregorian(jd);
        return { mode: "date", y: g.y, m: g.m, d: g.d, hh: g.hh, mm: g.mm, ss: g.ss };
    }
    if (Math.abs(approxYear) < YEAR_MODE_MAX_YEARS) {
        return { mode: "year", yearsCE: fmtYearGrouped(approxYear) };
    }
    return { mode: "myr", tPlusYears: totalSec / SEC_YEAR };
}

export function fmtCivil(civil) {
    if (civil.mode === "date") {
        const p2 = n => String(n).padStart(2, "0");
        return civil.y + "-" + p2(civil.m) + "-" + p2(civil.d) + " " +
            p2(civil.hh) + ":" + p2(civil.mm) + ":" + p2(civil.ss) + " UTC";
    }
    if (civil.mode === "year") return "Year " + civil.yearsCE + " CE";
    const gyr = civil.tPlusYears / 1e9;
    return "T+" + (Math.abs(gyr) >= 1e6 ? gyr.toExponential(2) : gyr.toFixed(2)) + " Gyr";
}
