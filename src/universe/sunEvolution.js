// Sun life-cycle timeline (WP23b): the Sun's own evolving luminosity, radius
// and effective temperature under deep time warp, from today's main-sequence
// state through the subgiant/red-giant branch, the helium flash, the
// asymptotic giant branch, a planetary-nebula ejection, and finally
// white-dwarf cooling.
//
// Timeline anchors follow the standard published solar-evolution track —
// Schröder & Connon Smith 2008, MNRAS 386, 155, "Distant future of the Sun
// and Earth revisited": total main-sequence lifetime ~10.9 Gyr (the Sun is
// 4.6 Gyr old today, so ~6.3 Gyr of main-sequence life remain); red-giant-
// branch tip near stellar age ~12.1-12.2 Gyr (R ~170-256 Rsun depending on
// mass-loss treatment, L ~2300-3000 Lsun); the core-helium flash drops the
// star onto the horizontal-branch/red-clump (L ~40-50 Lsun); asymptotic-
// giant-branch superwind mass loss strips the envelope down to a ~0.54 Msun
// core (Schröder & Connon Smith Table 1 / §4), briefly visible as a
// planetary nebula, then a cooling white dwarf (Nauenberg 1972 mass-radius
// relation for the remnant's degenerate radius).
//
// This is a deterministic DECORATIVE timeline, not a stellar-structure code:
// every anchor point above is a published/derived number, but the segments
// between them are smooth interpolations rather than a simulated envelope
// integration. sunStateAt(simTSeconds) is a pure function of simulation time
// elapsed since "now" (the sim's t=0 epoch, at which the Sun is already
// 4.6 Gyr old) — negative/zero time clamps to today's exact main-sequence
// state.

const SEC_YEAR = 31557600; // Julian year, 365.25 days — matches constants.js SEC_YEAR
const GYR_SEC = 1e9 * SEC_YEAR;
const TSUN_K = 5772;

// --- phase boundaries, Gyr from now -----------------------------------------
const T_MS_END = 6.3;        // total MS life 10.9 Gyr - current age 4.6 Gyr
const T_SUBGIANT_END = 7.2;  // end of the Hertzsprung-gap crossing
const T_RGB_TIP = 7.5;       // ~12.1 Gyr stellar age, published RGB-tip anchor
const T_HEFLASH_END = 7.6;   // red-clump / horizontal-branch plateau
const T_AGB_TIP = 7.65;      // AGB superwind mass loss essentially complete
const T_WD_START = 7.66;     // envelope fully ejected, hot core exposed

export const PHASE_BOUNDARIES_GYR = {
    msEnd: T_MS_END, subgiantEnd: T_SUBGIANT_END, rgbTip: T_RGB_TIP,
    heFlashEnd: T_HEFLASH_END, agbTip: T_AGB_TIP, wdStart: T_WD_START,
};

// --- anchor points (L in Lsun, R in Rsun, Teff in K) ------------------------
const MS_L0 = 1.0, MS_TEFF0 = TSUN_K;               // today
const MS_L1 = 1.8, MS_TEFF1 = 5950;                 // end of main sequence
const SUBGIANT_L1 = 6, SUBGIANT_TEFF1 = 5000;       // end of subgiant branch
const RGB_L_TIP = 2300, RGB_TEFF_TIP = 3065;        // R ~170 Rsun
const CLUMP_L = 50, CLUMP_TEFF = 4700;              // post-flash horizontal branch
const AGB_L_TIP = 3000, AGB_TEFF_TIP = 2913;        // R ~215 Rsun
export const WD_MASS_MSUN = 0.54;                   // final remnant mass (Schröder & Connon Smith)
const WD_R_RSUN = 0.0123;                           // Nauenberg 1972 degenerate mass-radius relation at 0.54 Msun
const WD_TEFF_START = 100000;                       // freshly exposed core, before Mestel-style cooling
const WD_COOL_TAU_GYR = 2;                           // cooling decay timescale (qualitative, not a real cooling track)
// Stefan-Boltzmann self-consistent luminosity of the WD at the moment the
// envelope is gone (Teff=WD_TEFF_START, R=WD_R_RSUN) — computed, not
// hand-fit, so the PN->WD handoff is exactly continuous.
const WD_L_START = WD_R_RSUN * WD_R_RSUN * Math.pow(WD_TEFF_START / TSUN_K, 4);

function clamp01(u) { return u < 0 ? 0 : u > 1 ? 1 : u; }
function smoothstep(u) { const c = clamp01(u); return c * c * (3 - 2 * c); }
function lerp(a, b, u) { return a + (b - a) * u; }
function logLerp(a, b, u) { return Math.pow(10, lerp(Math.log10(a), Math.log10(b), u)); }
// Stefan-Boltzmann link in solar units: L = R^2 * (Teff/Tsun)^4.
function radiusFromLTeff(L, Teff) { return Math.sqrt(L) * Math.pow(TSUN_K / Teff, 2); }

// Returns { phase, L, R, Teff, mass, ageIntoPhaseGyr, phaseDurationGyr } for
// a given "Gyr from now" already clamped to >= 0.
function stateAtGyr(tGyr) {
    if (tGyr < T_MS_END) {
        const dur = T_MS_END;
        const u = tGyr / dur;
        const L = MS_L0 * Math.pow(MS_L1 / MS_L0, u);
        const Teff = lerp(MS_TEFF0, MS_TEFF1, u);
        return { phase: "MS", L, Teff, R: radiusFromLTeff(L, Teff), mass: 1.0, ageIntoPhaseGyr: tGyr, phaseDurationGyr: dur };
    }
    if (tGyr < T_SUBGIANT_END) {
        const dur = T_SUBGIANT_END - T_MS_END, age = tGyr - T_MS_END;
        const su = smoothstep(age / dur);
        const L = logLerp(MS_L1, SUBGIANT_L1, su);
        const Teff = lerp(MS_TEFF1, SUBGIANT_TEFF1, su);
        return { phase: "subgiant", L, Teff, R: radiusFromLTeff(L, Teff), mass: 1.0, ageIntoPhaseGyr: age, phaseDurationGyr: dur };
    }
    if (tGyr < T_RGB_TIP) {
        const dur = T_RGB_TIP - T_SUBGIANT_END, age = tGyr - T_SUBGIANT_END;
        const su = smoothstep(age / dur);
        const L = logLerp(SUBGIANT_L1, RGB_L_TIP, su);
        const Teff = lerp(SUBGIANT_TEFF1, RGB_TEFF_TIP, su);
        return { phase: "RGB", L, Teff, R: radiusFromLTeff(L, Teff), mass: 1.0, ageIntoPhaseGyr: age, phaseDurationGyr: dur };
    }
    if (tGyr < T_HEFLASH_END) {
        const dur = T_HEFLASH_END - T_RGB_TIP, age = tGyr - T_RGB_TIP;
        // The flash itself is near-instantaneous; front-load the transition
        // (u^6 ease) so the star drops onto the clump quickly and then holds.
        const u = age / dur;
        const ease = 1 - Math.pow(1 - u, 6);
        const L = logLerp(RGB_L_TIP, CLUMP_L, ease);
        const Teff = lerp(RGB_TEFF_TIP, CLUMP_TEFF, ease);
        return { phase: "heliumFlash", L, Teff, R: radiusFromLTeff(L, Teff), mass: 1.0, ageIntoPhaseGyr: age, phaseDurationGyr: dur };
    }
    if (tGyr < T_AGB_TIP) {
        const dur = T_AGB_TIP - T_HEFLASH_END, age = tGyr - T_HEFLASH_END;
        const u = age / dur, su = smoothstep(u);
        const L = logLerp(CLUMP_L, AGB_L_TIP, su);
        const Teff = lerp(CLUMP_TEFF, AGB_TEFF_TIP, su);
        // Superwind mass loss is concentrated late in the AGB climb (u^2:
        // slow early, fast near the tip) — final mass reaches WD_MASS_MSUN
        // exactly at the AGB tip.
        const mass = lerp(1.0, WD_MASS_MSUN, u * u);
        return { phase: "AGB", L, Teff, R: radiusFromLTeff(L, Teff), mass, ageIntoPhaseGyr: age, phaseDurationGyr: dur };
    }
    if (tGyr < T_WD_START) {
        const dur = T_WD_START - T_AGB_TIP, age = tGyr - T_AGB_TIP;
        const su = smoothstep(age / dur);
        // Envelope ejection: L, Teff and R all move independently (this is
        // not equilibrium photospheric emission, so Stefan-Boltzmann doesn't
        // hold through the transition) toward the exposed-core WD values.
        const L = logLerp(AGB_L_TIP, WD_L_START, su);
        const Teff = logLerp(AGB_TEFF_TIP, WD_TEFF_START, su);
        const R = logLerp(radiusFromLTeff(AGB_L_TIP, AGB_TEFF_TIP), WD_R_RSUN, su);
        return { phase: "PN", L, Teff, R, mass: WD_MASS_MSUN, ageIntoPhaseGyr: age, phaseDurationGyr: dur };
    }
    const coolingGyr = tGyr - T_WD_START;
    const decay = 1 / (1 + coolingGyr / WD_COOL_TAU_GYR);
    const Teff = 5000 + (WD_TEFF_START - 5000) * decay;
    const R = WD_R_RSUN;
    const L = R * R * Math.pow(Teff / TSUN_K, 4); // Stefan-Boltzmann, self-consistent with PN handoff
    return { phase: "WD", L, Teff, R, mass: WD_MASS_MSUN, ageIntoPhaseGyr: coolingGyr, phaseDurationGyr: Infinity };
}

/**
 * Frozen contract (WP23b): the Sun's evolutionary state at simulation time
 * `simTSeconds` (seconds elapsed since the sim's "now" epoch, where the Sun
 * is already 4.6 Gyr old). Pure/deterministic — no RNG, no external state.
 *
 * Returns:
 *   phase:     'MS'|'subgiant'|'RGB'|'heliumFlash'|'AGB'|'PN'|'WD'
 *   L_Lsun:    luminosity in solar units
 *   R_Rsun:    radius in solar units (multiply by constants.js R_SUN for km)
 *   Teff:      effective temperature, K
 *   massLoss:  the Sun's CURRENT mass in solar units (1.0 today, declining
 *              to ~0.54 across the AGB superwind, then constant) — named
 *              `massLoss` per the frozen contract; `1 - massLoss` is the
 *              fraction of the original mass shed so far. physics.js reads
 *              this directly to scale the Sun's gravitational parameter.
 *
 * Bonus (non-contract, additive) fields for visual consumers:
 *   ageIntoPhaseSec / phaseDurationSec: how far into the current phase, and
 *   how long the phase lasts (Infinity for WD) — e.g. drives the bodies.js
 *   planetary-nebula shell's expansion during the 'PN' phase.
 */
export function sunStateAt(simTSeconds) {
    const tGyr = Math.max(0, (simTSeconds || 0) / GYR_SEC);
    const s = stateAtGyr(tGyr);
    return {
        phase: s.phase,
        L_Lsun: s.L,
        R_Rsun: s.R,
        Teff: s.Teff,
        massLoss: s.mass,
        ageIntoPhaseSec: s.ageIntoPhaseGyr * GYR_SEC,
        phaseDurationSec: Number.isFinite(s.phaseDurationGyr) ? s.phaseDurationGyr * GYR_SEC : Infinity,
    };
}

// Convenience alias for physics.js's mu-scaling consumer.
export function sunMassMsunAt(simTSeconds) {
    return sunStateAt(simTSeconds).massLoss;
}

// R(t) is NOT monotonic: it climbs to a first local peak at the RGB tip
// (170 Rsun), collapses at the helium flash, climbs again to a second,
// higher peak at the AGB tip (215 Rsun), then only ever shrinks (PN -> WD).
// A contact/engulfment check that compares a_planet against the
// INSTANTANEOUS radius (sunStateAt(t).R_Rsun) is only correct if the caller
// samples time finely enough to land inside whichever peak's window matters
// for that planet — Earth's AGB-tip window is only ~1 Myr wide (215 Rsun is
// barely 0.001 AU past Earth's own 1 AU orbit), narrower than a single
// advance() call's span at the game's own top warp speed (~17 Myr/frame).
// This closed-form "largest radius reached by time t" is exact (no
// sampling) precisely because the shape above has only two local maxima,
// both at known times/values — so physics.js can safely compare a_planet
// against THIS instead and get the right answer regardless of how coarsely
// (or discontinuously — see smoke-sun-evolution.mjs's teleport-based deep
// warp test) simulation time is advanced.
export function sunMaxRadiusReachedRsunAt(simTSeconds) {
    const tGyr = Math.max(0, (simTSeconds || 0) / GYR_SEC);
    if (tGyr < T_RGB_TIP) return stateAtGyr(tGyr).R;               // still climbing to peak 1
    if (tGyr < T_HEFLASH_END) return stateAtGyr(T_RGB_TIP).R;      // held at peak 1 while falling
    if (tGyr < T_AGB_TIP) return Math.max(stateAtGyr(T_RGB_TIP).R, stateAtGyr(tGyr).R); // climbing toward peak 2
    return stateAtGyr(T_AGB_TIP).R;                                 // held at the global peak forever after
}

// The AGB-tip radius (Rsun) — the largest the Sun ever gets, right before
// envelope ejection. bodies.js uses this as the PN shell's fixed size
// reference (the shell keeps expanding through the 'PN' phase independently
// of the rapidly-shrinking exposed core, so it can't be scaled off R_Rsun).
export const AGB_TIP_R_RSUN = radiusFromLTeff(AGB_L_TIP, AGB_TEFF_TIP);
