// Deep-time modulation of the galactic stellar field: star-formation decline
// after the Milky Way-Andromeda merger, progressive reddening of the aggregate
// stellar population, fading total field luminosity, and the eventual
// transition to the "Degenerate Era" (Adams & Laughlin 1997, Rev. Mod. Phys.
// 69, 337, "A dying universe: the long-term fate and evolution of
// astrophysical objects") in which star formation has ceased everywhere and
// only cooling white dwarfs, neutron stars and black holes remain.
//
// eraModulation(simTSeconds) is pure and deterministic in `simTSeconds`
// (seconds of sim time since the epoch start, i.e. "now" = 0, matching G.t).
// It owns no render state: WP16 (star shaders) and WP23a (cosmic.js, the
// Local-Group/galaxy-cloud owner) multiply their own color/population terms
// by this module's output under this frozen contract.

const GYR_S = 3.15576e16; // 1 Julian Gyr = 1e9 * 365.25 * 86400 s

// Merger timing anchored to WP23a's smoke:merger contract: first passage
// ~4.5 Gyr, merged/relaxed "Milkomeda" elliptical state flagged by ~7 Gyr.
const T_MERGER_GYR = 7;
// Post-merger gas-exhaustion e-folding time. A "wet" major merger drives a
// starburst that rapidly consumes the remaining gas reservoir, after which
// the remnant quenches on a few-Gyr timescale (Hopkins et al. 2008, ApJS 175,
// 356, "A Cosmological Framework for the Co-Evolution of Quasars,
// Supermassive Black Holes, and Elliptical Galaxies" — post-starburst decay
// tau ~ 2-3 Gyr for a Milky-Way-mass merger remnant).
const TAU_QUENCH_GYR = 2.5;
// Mild secular decline of the pre-merger disk's own star formation (the
// Milky Way's SFR has itself been slowly falling for several Gyr already;
// small next to the merger-driven quench).
const TAU_SECULAR_GYR = 50;

// Field reddening window: O/B/A supergiants and the upper main sequence are
// gone within ~1 Gyr of quenching (their lifetimes), but F/G stars still
// carry meaningful blue-white light for tens of Gyr after that, so the
// *aggregate* population color keeps drifting redder out to ~10^11 yr as F/G
// fade and K/M dwarfs (10^11-10^13 yr main-sequence lifetimes) take over the
// light budget (Adams & Laughlin 1997 §II; Laughlin, Bodenheimer & Adams 1997,
// ApJ 482, 420, low-mass-star lifetimes).
const REDDEN_START_GYR = 10;
const REDDEN_END_GYR = 100;

// Luminosity model: today's field light is dominated by short-lived,
// intrinsically bright O-M-early-type stars (`blueFrac` term) even though
// they are numerically rare; a much smaller, long-lived background from K/M
// dwarfs persists for a very long time before those too exhaust their fuel
// (`backgroundDecline`, e-folding over a couple hundred Gyr, still non-
// negligible at 10^13 yr, per the stelliferous-era timeline of Adams &
// Laughlin 1997 Table 1).
const LUM_MASSIVE_WEIGHT = 0.8;
const LUM_BACKGROUND_WEIGHT = 0.2;
const LUM_BACKGROUND_TAU_GYR = 100;

// Degenerate-era transition: Adams & Laughlin (1997) place the end of the
// Stelliferous Era (last stars stop forming/shining) around 10^14 yr, with
// the Degenerate Era (starlight gone, only degenerate remnants) fully
// established by ~10^15 yr. Modeled as a logistic in log10(t) centered at
// 1.2e14 yr so the transition is smooth and spans roughly that decade.
const DEGENERATE_CENTER_LOG10_YR = Math.log10(1.2e14);
const DEGENERATE_WIDTH_LOG10 = 0.065;

function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Smoothstep on [a,b], clamped outside.
function smooth01(x, a, b) {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
}

function toGyr(simTSeconds) {
    const s = Number.isFinite(simTSeconds) ? simTSeconds : 0;
    return Math.max(0, s) / GYR_S;
}

// Star-formation rate relative to today. Flat-ish (mild secular decline)
// until the merger, then an exponential post-merger quench. Continuous at
// t = T_MERGER_GYR (both branches equal 1 * secular there); monotonically
// non-increasing in t.
function sfrAt(tGyr) {
    const secular = Math.exp(-tGyr / TAU_SECULAR_GYR);
    const postMerger = tGyr <= T_MERGER_GYR ? 1 : Math.exp(-(tGyr - T_MERGER_GYR) / TAU_QUENCH_GYR);
    return clamp01(secular * postMerger);
}

export function eraModulation(simTSeconds) {
    const tGyr = toGyr(simTSeconds);

    const sfr = sfrAt(tGyr);

    // Massive/blue (O-B-A) stars live ~1-100 Myr: their surviving fraction
    // tracks the SFR tightly with only a short lag, so a power-law sharpening
    // of `sfr` is a cheap deterministic stand-in for that fast-lifetime
    // convolution (falls at least as fast as SFR, ~0 shortly after SFR is).
    const blueFrac = clamp01(sfr * sfr);

    // Aggregate-population reddening: negligible while the disk is still
    // forming O/B/A stars, ramps through the F/G-fade window.
    const redshiftTint = smooth01(tGyr, REDDEN_START_GYR, REDDEN_END_GYR);

    // Total field luminosity vs today: bright massive-star contribution
    // (tracks blueFrac) plus a small, slowly-fading long-lived background.
    const backgroundDecline = 1 / (1 + tGyr / LUM_BACKGROUND_TAU_GYR);
    const lumFactor = clamp01(LUM_MASSIVE_WEIGHT * blueFrac + LUM_BACKGROUND_WEIGHT * backgroundDecline);

    // Degenerate era: logistic in log10(years) so the multi-order-of-magnitude
    // transition (1e14 -> 1e15 yr) is smooth on both linear and log axes.
    const tYr = tGyr * 1e9;
    const degenerate = tYr <= 0
        ? 0
        : clamp01(1 / (1 + Math.exp(-(Math.log10(tYr) - DEGENERATE_CENTER_LOG10_YR) / DEGENERATE_WIDTH_LOG10)));

    return { sfr, blueFrac, redshiftTint, lumFactor, degenerate };
}
