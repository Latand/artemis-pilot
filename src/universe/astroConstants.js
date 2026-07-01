// Shared astrophysical constants for the procedural Milky Way model.
//
// Single source of truth for every number the galaxy/stellar synthesis code
// needs, so build-time tooling and runtime generation agree. Pure data plus
// small stateless helpers — no imports from galaxy.js/stellar.js (they import
// this module, not the other way around), so it has zero dependencies.
//
// Every constant here is transcribed from
//   research/astro-population-model.md   (population model, §1-9)
//   research/catalog-strategy.md         (catalog completeness, §2)
// Citations to the underlying papers live in those reports; comments below
// point at the report section for anything non-obvious.

// --- Sun's position in the Galaxy (astro report §3) -----------------------
export const R_SUN_KPC = 8.178;   // GRAVITY 2019 (Reid 2019: 8.15 ± 0.15, consistent)
export const Z_SUN_PC = 20.8;    // Bennett & Bovy 2019

// --- Local stellar number densities, stars/pc³ (astro report §2) ---------
// CNS5 (Golovin+ 2023) 25 pc census: (7.99 ± 0.11)e-2 living MS stars/pc³.
export const MS_DENSITY_PC3 = 0.08;
// Remnant/substellar densities are order-of-magnitude (larger uncertainties);
// midpoints of the report's ranges.
export const WD_DENSITY_PC3 = 5e-3;   // white dwarfs, ~5e-3 (up to ~0.014 in some surveys)
export const NS_DENSITY_PC3 = 2e-4;   // neutron stars, 2-4e-4
export const BH_DENSITY_PC3 = 3e-5;   // stellar black holes, 2-6e-5
export const BD_DENSITY_PC3 = 0.03;   // brown dwarfs, ~0.02-0.05 (star:BD ratio 4-6:1)

// --- Disk structure, parsecs (astro report §3) ----------------------------
// Double-exponential thin+thick disks (TRILEGAL/Galaxia form).
export const DISK = {
    thinHR: 2600,   // thin-disk radial scale length
    thinHZ: 300,    // thin-disk vertical scale height
    thickHR: 2000,  // thick-disk radial scale length
    thickHZ: 900,   // thick-disk vertical scale height
    thickFrac: 0.05, // thick:thin local number-density normalization at midplane (report range 0.04-0.12)
};

// --- Stellar halo, power-law spheroid (astro report §3) -------------------
export const HALO = {
    q: 0.6,       // flattening (report range 0.6-0.76; use 0.6)
    n: 2.8,       // power-law index (report range 2.5-3.0)
    frac: 0.002,  // local normalization vs thin disk, ~1/500 (~0.2%)
};

// --- Spiral arms (Reid et al. 2019 maser parallaxes; astro report §4) ----
// Per-arm log-spiral centerline: ln(R/R_kink) = -(β - β_kink)·tan(ψ), with a
// pitch angle ψ that itself kinks at R_kink (inner segment inside R_kink,
// outer segment outside). Only the five major arms are modelled here (the
// report's table also lists 3-kpc and Norma, dropped per the frozen contract).
//
// betaKinkDeg (the Galactocentric azimuth at which each arm's pitch kinks) is
// not itemized in astro-population-model.md (which only carries R_kink/pitch/
// width from Reid 2019 Table 2) — these are the paper's own Table 2 β_kink
// values, verified against Reid et al. 2019 Table 2
// (https://iopscience.iop.org/article/10.3847/1538-4357/ab4a11) on 2026-07-01.
// betaMinDeg/betaMaxDeg are that same table's observed azimuth extent per arm.
export const REID_ARMS = [
    { name: "Sct-Cen", rKinkKpc: 4.91, pitchInner: 14.1, pitchOuter: 12.1, widthKpc: 0.23, betaKinkDeg: 23, betaMinDeg: 0, betaMaxDeg: 104 },
    { name: "Sgr-Car", rKinkKpc: 6.04, pitchInner: 17.1, pitchOuter: 1.0, widthKpc: 0.27, betaKinkDeg: 24, betaMinDeg: 2, betaMaxDeg: 97 },
    { name: "Local", rKinkKpc: 8.26, pitchInner: 11.4, pitchOuter: 11.4, widthKpc: 0.31, betaKinkDeg: 9, betaMinDeg: -8, betaMaxDeg: 34 },
    { name: "Perseus", rKinkKpc: 8.87, pitchInner: 10.3, pitchOuter: 8.7, widthKpc: 0.35, betaKinkDeg: 40, betaMinDeg: -23, betaMaxDeg: 115 },
    { name: "Outer", rKinkKpc: 12.24, pitchInner: 3.0, pitchOuter: 9.4, widthKpc: 0.65, betaKinkDeg: 18, betaMinDeg: -16, betaMaxDeg: 71 },
];

// Arm enhancement is age-gated: young/OB population gets a strong contrast,
// the general old disk only a mild one (astro report §4).
export const ARM_AMP_YOUNG = 3;     // report range 2-5 for OB/young stars
export const ARM_AMP_OLD = 0.3;     // report range 0.2-0.5 for the old disk
export const YOUNG_AGE_GYR = 0.1;   // "young" = age < 100 Myr

// Arm cross-section width grows with radius (astro report §4).
export function armWidth(Rkpc) {
    return 0.33 + 0.036 * (Rkpc - 8.15);
}

// --- Rotation curve (Eilers et al. 2019; astro report §5) -----------------
// v_c(R) = 229.0 - 1.7·(R - 8.18 kpc) km/s for 5 <= R <= 25 kpc; linear ramp
// from 0 at the center up to the flat-curve value at 5 kpc; beyond 25 kpc the
// fit isn't calibrated, so we clamp to the R=25 value rather than extrapolate.
export function vCirc(Rkpc) {
    if (Rkpc <= 0) return 0;
    if (Rkpc < 5) {
        const v5 = 229.0 - 1.7 * (5 - 8.18);
        return v5 * (Rkpc / 5);
    }
    const R = Math.min(Rkpc, 25);
    return 229.0 - 1.7 * (R - 8.18);
}

// --- Velocity dispersions, km/s (astro report §5) --------------------------
// sU=radial, sV=azimuthal, sW=vertical, lag=asymmetric-drift lag vs v_c.
export const DISP = {
    thin: { sU: 35, sV: 20, sW: 16, lag: 10 },
    thick: { sU: 67, sV: 38, sW: 35, lag: 45 },
    halo: { sU: 160, sV: 90, sW: 90, lag: 200 },
};

// --- Main-sequence lifetime (astro report §1d) -----------------------------
// t_MS ~ 10 Gyr * (M/Msun)^-2.5 (good to a factor ~2).
export function tMSGyr(m) {
    return 10 * Math.pow(m, -2.5);
}

// --- Initial-final mass relation for remnants (astro report §7) -----------
// M_init < 8 -> white dwarf (Cummings 2018); 8-22 -> neutron star (peak ~1.35
// Msun); >= 22 -> black hole (report range 0.2-0.5*M_init, 0.35 midpoint used).
export function IFMR(mInit) {
    if (mInit < 8) return { kind: "WD", mass: 0.09 * mInit + 0.44 };
    if (mInit < 22) return { kind: "NS", mass: 1.35 };
    // Field black holes from stellar collapse typically land 5-20 M☉; Gaia
    // BH3 (~33 M☉) is an exceptional low-metallicity outlier, so cap the
    // linear relation rather than let mass grow unbounded with M_init.
    return { kind: "BH", mass: Math.min(0.35 * mInit, 25) };
}

// --- Multiplicity fraction vs primary mass (Duchêne & Kraus 2013; §2) ----
// Piecewise step function over the report's mass bins (plain piecewise, not
// smoothed, since the report gives discrete bin midpoints rather than a
// continuous fit).
export function multiplicityFrac(m) {
    if (m <= 0.1) return 0.21;
    if (m <= 0.5) return 0.26;
    if (m <= 0.7) return 0.30;  // interpolated: report has no bin edge here
    if (m <= 1.3) return 0.44;
    if (m <= 1.5) return 0.52;  // interpolated: report has no bin edge here
    if (m <= 5) return 0.60;
    return 0.85;
}

// --- Metallicity gradient (astro report §6) --------------------------------
// Returns {mean, sigma} in [Fe/H] dex for a population at galactocentric
// radius Rkpc. Thin disk: -0.06 dex/kpc gradient around the solar value;
// thick/halo are flat means per the report.
export function fehAt(Rkpc, pop = "thin") {
    if (pop === "thick") return { mean: -0.5, sigma: 0.25 };
    if (pop === "halo") return { mean: -1.5, sigma: 0.5 };
    return { mean: -0.06 * (Rkpc - R_SUN_KPC), sigma: 0.15 };
}

// --- Catalog completeness handoff (catalog report §2) ---------------------
// Smoothly interpolate between two (distance, completeness) anchor points
// using a cosine ease, so the procedural/catalog handoff has no visible seam.
function fadeBetween(d, d0, v0, d1, v1) {
    if (d <= d0) return v0;
    if (d >= d1) return v1;
    const t = (d - d0) / (d1 - d0);
    const s = 0.5 * (1 - Math.cos(Math.PI * t));
    return v0 + (v1 - v0) * s;
}

// Fraction of type-cls stars already present in the real catalog at distance
// dPc from the Sun (the rest is procedural's to fill in). Anchor radii from
// catalog-strategy.md §2:
//   M dwarfs      complete to  ~25 pc (CNS5), fading out by ~60 pc
//   K/early-M     complete to ~100 pc,        fading out by ~200 pc
//   G/F dwarfs    complete to ~300 pc,        fading out by ~1000 pc (~1 kpc)
//   A/B/O         complete to ~500 pc; bright stars stay partially known far
//                 out (not volume-complete), so completeness eases down to a
//                 0.9 floor by ~2000 pc rather than dropping straight to 0,
//                 then fades out fully by ~5000 pc.
export function completeness(cls, dPc) {
    const d = Math.max(0, dPc);
    switch (cls) {
        case "M": return d <= 25 ? 1 : fadeBetween(d, 25, 1, 60, 0);
        case "K": return d <= 100 ? 1 : fadeBetween(d, 100, 1, 200, 0);
        case "G":
        case "F": return d <= 300 ? 1 : fadeBetween(d, 300, 1, 1000, 0);
        case "A":
        case "B":
        case "O":
            if (d <= 500) return 1;
            if (d <= 2000) return fadeBetween(d, 500, 1, 2000, 0.9);
            return fadeBetween(d, 2000, 0.9, 5000, 0);
        default: return 0;
    }
}
