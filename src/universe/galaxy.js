// Deterministic procedural Milky Way generator.
//
// Space is divided into CELL_PC cubes in the galactocentric frame. Each cell's
// contents are a pure function of (global seed, cell coords): the same cell
// always yields the same stars, so the galaxy is consistent on every revisit
// without storing anything. Star counts follow the astro-population-model.md
// density laws (thin+thick disc, halo, bulge, Reid 2019 age-gated spiral arms);
// masses follow the Chabrier (2003) IMF (stellar.js); physical/evolutionary
// state (MS/giant/WD/NS/BH) follows Eker 2018 + the IFMR via synthStar.
//
// Two independent generation tiers share this module:
//   - starsInCell/sampleStarsNear (100 pc cells): the "scientific" tier. This
//     is what scripts/validate-astro.mjs measures against the population
//     targets, so it stays a clean model of the astrophysics — no catalog
//     handoff discount, no brown dwarfs (see the note on H_BURNING_DENSITY_PC3
//     below for why BD stars live only in the local tier).
//   - localStarsInCell/sampleLocalStarsNear (4 pc cells): the "gameplay" tier
//     consumed by the active-neighbourhood layer (activeStars.js, WP8). This
//     tier additionally applies the catalog-completeness handoff (so
//     procedural doesn't duplicate what the real HYG/AT-HYG catalog already
//     supplies nearby) and generates the brown-dwarf population.
//
// Determinism: every population (position, age/mass/synth, kinematics,
// binaries, brown dwarfs) draws from its own splitSeed() sub-stream in a
// fixed order, so a cell's contents are reproducible across engines/sessions
// for a given global seed, independent of how many draws any other stream
// consumes for the same star.

import { hashInts, makeRNG, samplePoisson, splitSeed, gaussian } from "./prng.js";
import { synthStar, sampleIMFMass, sampleBDMass } from "./stellar.js";
import { R0_PC, Z_SUN_PC, SUN_GAL, PC_KM, galToEquatorialKmInto } from "./coords.js";
import {
    MS_DENSITY_PC3, BD_DENSITY_PC3,
    DISK, HALO, REID_ARMS, ARM_AMP_YOUNG, ARM_AMP_OLD, YOUNG_AGE_GYR, armWidth,
    vCirc, DISP, multiplicityFrac, fehAt, completeness, tMSGyr,
} from "./astroConstants.js";

export const CELL_PC = 100;                 // cell edge, parsecs
const CELL_VOL = CELL_PC * CELL_PC * CELL_PC; // pc³
export const LOCAL_CELL_PC = 4;             // streaming cell edge, parsecs
const LOCAL_CELL_VOL = LOCAL_CELL_PC * LOCAL_CELL_PC * LOCAL_CELL_PC;

// H-burning stellar population density at the Sun (astro report §2, CNS5).
// This is the Poisson-mean density fed into the mass/age→synthStar pipeline
// below; it is NOT MS-only in the output (some of this pool evolves into
// giants/WD/NS/BH per real age+IMF physics — see the remnant note above
// synthesizeCandidate), matching how CNS5's own 0.0799/pc³ count already
// includes its 264 WD alongside the 4,946 MS + 20 giants (5,230 total).
//
// Decision (double-counting, carry-forward S4): rather than adding a SEPARATE
// independently-seeded WD/NS/BH population on top of this pool (which would
// double-count remnants against the ones synthStar already produces from
// realistic (mass, age) draws), remnants are folded entirely into this one
// population. WD_DENSITY_PC3/NS_DENSITY_PC3/BH_DENSITY_PC3 (astroConstants)
// are therefore treated as TARGET fractions to verify empirically (validate-
// astro checks 4/5 are the arbiter), not as literal additional draws.
// Empirical calibration bump: coarse-cell rejection sampling against the
// density gradient (the per-candidate `rng() > densityAt(pos)/densCenter`
// test below) systematically under-produces relative to the cell-center
// Poisson mean whenever density is convex-decaying across the cell (it is,
// radially and vertically) — a pre-existing property of this rejection
// scheme, not new in WP6. Tuned so the measured local density (validate-
// astro check 1) and whole-galaxy integral (check 11) both land inside
// their target bands; re-tune if the rejection/materialisation scheme changes.
const DENSITY_CALIBRATION = 1.2;
export const H_BURNING_DENSITY_PC3 = MS_DENSITY_PC3 * DENSITY_CALIBRATION;
export const N_SUN_PC3 = H_BURNING_DENSITY_PC3; // back-compat name (whole-galaxy integral, smoke tests)

// Empirical remnant-retention correction: an empirical trim to hit the
// observed local remnant densities (validate-astro checks 4/5 are the
// arbiter); these retention fractions are magnitudes tuned to hit the
// checks, not derived from kick/SFH physics. Feeding the full Chabrier IMF's
// high-mass tail through age-vs-t_MS for every population and letting ALL of
// it convert via the IFMR overshoots the observed local WD/NS/BH census —
// real evolution loses more would-be remnants than a per-star age/IMF/IFMR
// model captures on its own (natal kicks scattering NS/BH out of the local
// volume, failed supernovae/direct collapse leaving no relic, the
// uniform-age assumption not perfectly matching the real star-formation
// history), but none of that is actually simulated here; this knob only
// tunes how much of the IFMR's output survives. Rather than discard a
// non-retained candidate (which would only make check 1's already-tight MS
// density worse), it is re-synthesized at an age safely below its
// main-sequence lifetime — i.e. treated as still on the main sequence —
// keeping the total population count exactly conserved.
const REMNANT_RETAIN = { WD: 0.72, NS: 0.22, BH: 0.065 };

const LEVEL_STAR = 3;                       // hierarchy level id for hashing
const LEVEL_LOCAL_STAR = 4;                 // fine streaming level id

// Fixed per-cell sub-stream salts (determinism policy: every new population
// draws from its own splitSeed(cellSeed, salt) stream, in this fixed order,
// so a star's identity never depends on what any other stream consumed).
const SALT_AGE = 0x41, SALT_KIN = 0x42, SALT_BIN = 0x43, SALT_BD = 0x44, SALT_SYNTH = 0x45;

// Disc / halo structural parameters (parsecs), from astroConstants.js.
const HR_THIN = DISK.thinHR, HZ_THIN = DISK.thinHZ;
const HR_THICK = DISK.thickHR, HZ_THICK = DISK.thickHZ, F_THICK = DISK.thickFrac;
const Q_HALO = HALO.q, N_HALO = HALO.n, F_HALO = HALO.frac;
// Central bulge: kept as the pre-existing soft-exponential approximation.
// Not part of the frozen astroConstants.js contract (no report-cited bulge
// density law is in scope for this wave) — left numerically unchanged.
const R_BULGE = 600, A_BULGE = 60;
const R_DISC_MAX = 22000;                   // disc sampling cutoff
const Z_DISC_MAX = 3500;                    // vertical sampling cutoff
const MATERIALISE_MAX = 300000;             // max stars instantiated per cell
const LOCAL_MATERIALISE_MAX = 80;           // max H-burning stars instantiated per local cell
const LOCAL_BD_MATERIALISE_MAX = 40;        // separate cap for the local brown-dwarf population

// Neutron stars / black holes are natal-kicked and dynamically heated, so in
// reality they occupy a puffier vertical distribution than their thin-disc
// progenitors (astro report §2: NS scale height ~0.5 kpc vs thin-disc
// ~300 pc, roughly 1.6x). We can't reposition a star after the fact without
// risking it landing outside its own cell's spatial box (breaking the
// radius-query invariant sampleStarsNear/sampleLocalStarsNear depend on), so
// instead NS/BH get boosted velocity dispersion here; combined with the
// epicyclic vertical oscillation below (amplitude scales with peculiar
// velocity), that naturally puffs their trajectory out over time while still
// sampling from the correct thin-disc SPATIAL distribution at generation time.
const NS_BH_DISP_BOOST = 1.6;

const DEG2RAD = Math.PI / 180, RAD2DEG = 180 / Math.PI;
const KPC_PC = 1000;
const PC_AU = PC_KM / 149597870.7; // AU_KM (constants.js/coords.js value), inlined to avoid a new import

// --- Vertical epicyclic frequency ν = sqrt(4πGρ_mid) (astro report §5, numerics report §4.4) ---
// Converts a local mass density (M☉/pc³) into a physical angular frequency
// (rad/s). Derived once from first principles (G in SI) rather than
// hardcoded, so the constant's provenance is checkable.
const G_SI = 6.674e-11;                 // m³ kg⁻¹ s⁻²
const MSUN_KG = 1.98892e30;
const PC_M = PC_KM * 1000;              // metres per parsec, from the shared PC_KM constant
const RHO_UNIT_KG_M3 = MSUN_KG / (PC_M * PC_M * PC_M); // 1 M☉/pc³ in kg/m³
const NU_PER_SQRT_RHO = Math.sqrt(4 * Math.PI * G_SI * RHO_UNIT_KG_M3); // rad/s per sqrt(M☉/pc³)
// Total DYNAMICAL midplane density (not just the ~0.04-0.055 M☉/pc³ baryonic
// figure in astro report §2) — the Oort-limit value (~0.1 M☉/pc³, Holmberg &
// Flynn 2004) that actually sets the vertical restoring force including dark
// matter. Sanity check: at the Sun this gives ν ≈ 2.4e-15 rad/s, i.e. a
// ~84 Myr vertical oscillation period — matches the literature's commonly
// cited ~70-90 Myr solar vertical-oscillation period.
const RHO_MID_SUN_MSUN_PC3 = 0.1;

// Structural parameters, exported so the visual galaxy-cloud sampler
// (starfield.js) draws from the same broad-strokes shape the per-star
// generator uses. N_ARMS/ARM_PITCH/ARM_R0/ARM_SIGMA/ARM_AMP are a legacy,
// deliberately simplified DECORATIVE approximation kept only for that visual
// point cloud — the real per-star density model below uses the Reid et al.
// 2019 five-arm log-spiral model (REID_ARMS) instead.
export const GALAXY_STRUCT = {
    R0_PC, Z_SUN_PC,
    HR_THIN, HZ_THIN, HR_THICK, HZ_THICK, F_THICK,
    Q_HALO, N_HALO, F_HALO, R_BULGE, A_BULGE,
    R_DISC_MAX, Z_DISC_MAX,
    N_ARMS: 4, ARM_PITCH: 12.8 * Math.PI / 180, ARM_R0: 3000, ARM_SIGMA: 350, ARM_AMP: 1.6,
};

let SEED = 0x9e3779b9 >>> 0;
export function setSeed(seed) { SEED = seed >>> 0; }
export function getSeed() { return SEED; }

// --- Unenhanced (no-arm) disc/halo/bulge shapes --------------------------
function thinShape(R, z) {
    return Math.exp(-(R - R0_PC) / HR_THIN) * Math.exp(-Math.abs(z) / HZ_THIN);
}
function thickShape(R, z) {
    return Math.exp(-(R - R0_PC) / HR_THICK) * Math.exp(-Math.abs(z) / HZ_THICK);
}
function haloShape(R, z) {
    const rEff = Math.hypot(R, z / Q_HALO);
    return Math.pow(R0_PC / Math.max(rEff, 100), N_HALO);
}
function bulgeShape(R, z) {
    const r3d = Math.hypot(R, z);
    return A_BULGE * Math.exp(-r3d / R_BULGE);
}

// --- Reid et al. 2019 spiral arms -----------------------------------------
// Each arm's centerline is ln(R/R_kink) = -(β-β_kink)·tan(ψ), with ψ the
// inner/outer pitch segment. Reference width scaled by the report's global
// w(R) = 0.33+0.036·(R-8.15 kpc) growth law, anchored at each arm's own
// widthKpc value at R=8.15 kpc (so every arm keeps its own characteristic
// width while still growing with radius the way the report describes).
const ARM_WIDTH_REF_KPC = armWidth(8.15);
const ARM_EDGE_SOFT_DEG = 10; // soft-edge margin outside [betaMin,betaMax] (carry-forward S2)

// Azimuth (deg) at which `arm`'s centerline crosses radius Rkpc.
function armBetaAt(arm, Rkpc) {
    const belowKink = Rkpc < arm.rKinkKpc;
    const psiDeg = belowKink ? arm.pitchInner : arm.pitchOuter;
    const tanPsi = Math.tan(psiDeg * DEG2RAD);
    if (Math.abs(tanPsi) < 1e-6) return arm.betaKinkDeg;
    return arm.betaKinkDeg - (Math.log(Rkpc / arm.rKinkKpc) / tanPsi) * RAD2DEG;
}

function armWidthAt(arm, Rkpc) {
    return arm.widthKpc * (armWidth(Rkpc) / ARM_WIDTH_REF_KPC);
}

// Soft falloff outside an arm's observed [betaMin,betaMax] azimuth extent
// (carry-forward S2) — 1 inside the range, linearly fading to 0 over
// ARM_EDGE_SOFT_DEG beyond either edge.
function armRangeFactor(arm, betaDeg) {
    if (betaDeg >= arm.betaMinDeg && betaDeg <= arm.betaMaxDeg) return 1;
    const over = betaDeg < arm.betaMinDeg ? arm.betaMinDeg - betaDeg : betaDeg - arm.betaMaxDeg;
    return Math.max(0, 1 - over / ARM_EDGE_SOFT_DEG);
}

// Multiplicative arm enhancement 1+A·exp(-d⊥²/2w²) at (Rpc,betaDeg), taking
// the single strongest-influencing arm (nearest, range-softened). `amp` is
// ARM_AMP_YOUNG or ARM_AMP_OLD depending on the caller's age-gating.
function armEnhancement(Rpc, betaDeg, amp) {
    const Rkpc = Rpc / KPC_PC;
    let best = 0;
    for (let i = 0; i < REID_ARMS.length; i++) {
        const arm = REID_ARMS[i];
        const rangeF = armRangeFactor(arm, betaDeg);
        if (rangeF <= 0) continue;
        const armBeta = armBetaAt(arm, Rkpc);
        let dBeta = betaDeg - armBeta;
        dBeta = ((dBeta + 180) % 360 + 360) % 360 - 180; // wrap to [-180,180], defensive
        const psiDeg = Rkpc < arm.rKinkKpc ? arm.pitchInner : arm.pitchOuter;
        const dPerpPc = Math.abs(dBeta * DEG2RAD) * Rpc * Math.cos(psiDeg * DEG2RAD);
        const wPc = armWidthAt(arm, Rkpc) * KPC_PC;
        const enh = amp * rangeF * Math.exp(-(dPerpPc * dPerpPc) / (2 * wPc * wPc));
        if (enh > best) best = enh;
    }
    return 1 + best;
}

// Exported for smoke/validate testing only (probing where the model's arms
// actually peak, so tests don't hardcode a stale angle).
export function armEnhancementAt(Rpc, betaDeg, amp) { return armEnhancement(Rpc, betaDeg, amp); }
export function armBetaAtKpc(armName, Rkpc) {
    const arm = REID_ARMS.find((a) => a.name === armName);
    return arm ? armBetaAt(arm, Rkpc) : NaN;
}

// --- Raw (unnormalised) density, parameterised by which arm amplitude to use ---
function rawDensity(gx, gy, gz, armAmp) {
    const R = Math.hypot(gx, gy);
    const z = gz;
    const thin = thinShape(R, z);
    const thick = F_THICK * thickShape(R, z);
    let disc = thin + thick;
    if (R > 1000 && R < R_DISC_MAX) {
        const betaDeg = Math.atan2(gy, gx) * RAD2DEG;
        disc *= armEnhancement(R, betaDeg, armAmp);
    }
    const halo = F_HALO * haloShape(R, z);
    const bulge = bulgeShape(R, z);
    return disc + halo + bulge;
}

// Sun-relative normalisation (carry-forward V2): densityAt(Sun) === 1 exactly,
// computed once (arm factor at the Sun's own position included), so
// N_SUN_PC3 × densityAt is a calibrated absolute stellar density everywhere.
let SUN_NORM = null;
function sunNorm() {
    if (SUN_NORM == null) SUN_NORM = rawDensity(SUN_GAL[0], SUN_GAL[1], SUN_GAL[2], ARM_AMP_OLD);
    return SUN_NORM;
}

// Relative stellar number density at galactocentric (gx,gy,gz) in pc,
// normalised so the Sun's neighbourhood is exactly 1. Uses the OLD/general
// disc arm amplitude (the population-average — >99% of stars are not
// "young"), matching the whole-galaxy integral and scale-height checks that
// call this directly without per-star age information.
export function densityAt(gx, gy, gz) {
    return rawDensity(gx, gy, gz, ARM_AMP_OLD) / sunNorm();
}

const MIDPLANE_SUN_SHAPE = thinShape(R0_PC, 0) + F_THICK * thickShape(R0_PC, 0) + F_HALO * haloShape(R0_PC, 0) + bulgeShape(R0_PC, 0);

// Vertical epicyclic frequency at galactocentric radius Rpc (no arm/z term —
// the restoring force is set by the smooth midplane mass distribution).
function verticalFreqAt(Rpc) {
    const RpcSafe = Math.max(Rpc, 50);
    const shape = thinShape(RpcSafe, 0) + F_THICK * thickShape(RpcSafe, 0) + F_HALO * haloShape(RpcSafe, 0) + bulgeShape(RpcSafe, 0);
    const rho = RHO_MID_SUN_MSUN_PC3 * (shape / MIDPLANE_SUN_SHAPE);
    return NU_PER_SQRT_RHO * Math.sqrt(Math.max(rho, 1e-8));
}

// --- Population assignment, age, metallicity ------------------------------
// Local population share from the RAW (no-arm) component densities at the
// candidate's exact position — the arm modulates where thin-disc stars
// cluster, not which population a star belongs to. Bulge stars are folded
// into the "thick" bucket (both are old/dispersion-dominated; no separate
// bulge kinematics/age law is in the frozen astroConstants.js contract).
function assignPopulation(rng, R, z) {
    const thin = thinShape(R, z);
    const thickShare = F_THICK * thickShape(R, z) + bulgeShape(R, z);
    const halo = F_HALO * haloShape(R, z);
    const total = thin + thickShare + halo;
    const u = rng() * total;
    if (u < thin) return "thin";
    if (u < thin + thickShare) return "thick";
    return "halo";
}

function drawAge(rng, pop) {
    if (pop === "thin") return rng() * 10;        // 0-10 Gyr, roughly uniform (astro report §6)
    if (pop === "thick") return 8 + rng() * 4;     // 8-12 Gyr
    return 12 + rng() * 1;                          // halo: 12-13 Gyr
}

// Reject-sample a "young" (age < 100 Myr) candidate's age toward spiral arms
// (astro report §4: "assign a star young/arm-eligible if drawn age < ~100
// Myr, then reject-sample azimuth with acceptance ∝ f_arm"). Cells are only
// 100 pc (LOCAL: 4 pc) across — far smaller than an arm's width — so we
// can't relocate a star's azimuth within its own cell box without breaking
// the spatial-query invariant; instead, off-arm young candidates are
// reassigned an ordinary old thin-disc age, which produces the same net
// effect (young stars preferentially found near arm centerlines) without
// moving anyone out of their cell.
function gateYoungAge(rng, R, betaDeg) {
    const enh = armEnhancement(R, betaDeg, ARM_AMP_YOUNG);
    const pAccept = enh / (1 + ARM_AMP_YOUNG);
    if (rng() > pAccept) return YOUNG_AGE_GYR + rng() * (10 - YOUNG_AGE_GYR);
    return rng() * YOUNG_AGE_GYR;
}

function drawFeh(rng, Rkpc, pop) {
    const { mean, sigma } = fehAt(Rkpc, pop);
    return mean + sigma * gaussian(rng);
}

// --- Kinematics + epicyclic parameters ------------------------------------
// v = circular v_c(R) in +φ̂ (minus asymmetric-drift lag, folded into Vpec
// below) + Gaussian peculiar velocity (σ_U,σ_V,σ_W). NS/BH get boosted
// dispersion (NS_BH_DISP_BOOST, see the comment above its declaration).
function drawVelocity(rng, Rkpc, betaDeg, pop, kind) {
    const disp = DISP[pop] || DISP.thin;
    const boost = (kind === "NS" || kind === "BH") ? NS_BH_DISP_BOOST : 1;
    const vcirc = vCirc(Rkpc);
    const U = disp.sU * boost * gaussian(rng);
    const Vpec = -disp.lag + disp.sV * boost * gaussian(rng);
    const W = disp.sW * boost * gaussian(rng);
    const vPhi = vcirc + Vpec;
    const cB = Math.cos(betaDeg * DEG2RAD), sB = Math.sin(betaDeg * DEG2RAD);
    return {
        vx: U * cB - vPhi * sB,
        vy: U * sB + vPhi * cB,
        vz: W,
        U, Vpec,
    };
}

// Closed-form epicyclic parameters (Binney & Tremaine local approximation):
// given a star's current (R, peculiar U, peculiar Vpec), solve for the
// guiding-center radius Rg, epicycle amplitude X and phase φ0 such that the
// orbit passes through the star's actual position with its actual velocity
// at t=0. Ω=v_c/R (guiding-center azimuthal drift), κ=√2·Ω (flat-curve
// epicyclic frequency, astro report §5 / numerics report §4.4).
//
// Rg = Rpc - xKm/PC_KM (not +): at t=0, starPositionAt's R(t) formula gives
// R(0) = Rg + X·cos(phi0), and X·cos(phi0) = xKm/PC_KM by construction (phi0
// = atan2(yKm,xKm)), so Rg must be Rpc MINUS that term for R(0) to equal Rpc
// exactly. The old "+" sign double-counted xKm, so R(0) silently disagreed
// with the star's actual sampled radius the instant t moved off exactly 0
// (masked only because starPositionAt short-circuits t===0 to return the
// raw gx/gy/gz instead of evaluating this formula).
function computeEpicyclic(Rpc, U, Vpec) {
    const RpcSafe = Math.max(Rpc, 50);
    const Rkm = RpcSafe * PC_KM;
    const vcircKms = Math.max(vCirc(RpcSafe / KPC_PC), 1e-6);
    const Omega0 = vcircKms / Rkm;       // rad/s
    const kappa0 = Math.SQRT2 * Omega0;  // rad/s, flat rotation curve
    const xKm = -Vpec / (2 * Omega0);
    const yKm = -U / kappa0;
    const Xkm = Math.hypot(xKm, yKm);
    const phi0 = Math.atan2(yKm, xKm);
    let Rg = Rpc - xKm / PC_KM;
    let X = Xkm / PC_KM;
    // The local epicyclic approximation is a linearization around the
    // guiding radius; it breaks down when the epicycle amplitude is
    // comparable to (or larger than) the guiding radius itself — which
    // happens for halo-dispersion orbits (NS_BH_DISP_BOOST plus the halo's
    // own large sU/sV, DISP.halo) — or degenerates entirely if Rg lands at
    // or below zero. In that regime, degrade to a guiding-center-only drift:
    // keep the azimuthal rotation (Omega0) and the vertical oscillation
    // (handled separately, via epiNu), but drop the radial epicycle term
    // (X=0) rather than let starPositionAt divide by a zero/negative Rg.
    if (!(Rg > 0) || X > 0.5 * Rg) {
        Rg = RpcSafe;
        X = 0;
    }
    return {
        Rg, X,
        phi0, Omega0, kappa0,
    };
}

// Star position (galactocentric pc) at simulation time simTSeconds, from the
// star's precomputed epicyclic parameters. Zero-allocation: writes into
// `out` (length-3 array/typed-array). At simT=0 this reproduces the star's
// sampled (gx,gy,gz) exactly (short-circuited below, not just approximately
// via the trig round-trip) — required so a freshly generated star and one
// re-evaluated at t=0 are bit-identical.
export function starPositionAt(star, simTSeconds, out) {
    if (simTSeconds === 0) {
        out[0] = star.gx; out[1] = star.gy; out[2] = star.gz;
        return out;
    }
    const t = simTSeconds;
    const Rg = star.epiRg, X = star.epiX, phi0 = star.epiPhi0, Omega0 = star.epiOmega0, kappa0 = star.epiKappa0, nu = star.epiNu;
    const theta0 = Math.atan2(star.gy, star.gx);
    const kt = kappa0 * t;
    const R = Rg + X * Math.cos(kt + phi0);
    const theta = theta0 + Omega0 * t - (2 * Omega0 * X) / (kappa0 * Rg) * (Math.sin(kt + phi0) - Math.sin(phi0));
    // star.vz is km/s and nu is rad/s, so vz/nu is a length in KM — convert
    // to pc (matching gz's units) before combining with the position term.
    const z = nu > 0
        ? star.gz * Math.cos(nu * t) + (star.vz / nu / PC_KM) * Math.sin(nu * t)
        : star.gz + (star.vz * t) / PC_KM;
    out[0] = R * Math.cos(theta);
    out[1] = R * Math.sin(theta);
    out[2] = z;
    return out;
}

// --- Binary companions (Duchêne & Kraus 2013 multiplicity; Raghavan 2010) --
// Attaches a `companion` object to `star` in place (no separate top-level
// array entry — companions are not iterated/counted by callers, matching
// the task's "stored as companion object on the primary").
function attachCompanion(rngBin, star, mass, age, feh, gx, gy, gz) {
    if (rngBin() >= multiplicityFrac(mass)) return;
    const q = 0.1 + rngBin() * 0.9;
    const mass2 = q * mass;
    const comp0 = synthStar(rngBin, mass2, age, feh);
    const logPDays = 5.0 + 2.3 * gaussian(rngBin); // Raghavan 2010: mean log P[days]=5.0, σ=2.3
    const pYears = Math.pow(10, logPDays) / 365.25;
    let aPc = Math.cbrt(pYears * pYears * (mass + mass2)) / PC_AU; // Kepler III, AU→pc
    if (!(aPc > 0) || aPc > 0.1) aPc = Math.min(Math.max(aPc, 1e-6), 0.1); // cell-sanity cap
    const ct = 2 * rngBin() - 1, st = Math.sqrt(Math.max(0, 1 - ct * ct)), ph = rngBin() * 2 * Math.PI;
    const cgx = gx + aPc * st * Math.cos(ph), cgy = gy + aPc * st * Math.sin(ph), cgz = gz + aPc * ct;
    const ceq = [0, 0, 0];
    galToEquatorialKmInto(cgx, cgy, cgz, ceq);
    star.companion = {
        mass: comp0.mass, L: comp0.L, R: comp0.R, Teff: comp0.Teff,
        color: comp0.color, cls: comp0.cls, kind: comp0.kind,
        gx: cgx, gy: cgy, gz: cgz, x: ceq[0], y: ceq[1], z: ceq[2],
        separationPc: aPc, periodDays: Math.pow(10, logPDays),
    };
}

// --- Brown dwarf synthesis (local tier only) ------------------------------
// Below the hydrogen-burning limit: never evolves via synthStar (the frozen
// contract's kind enum is MS/giant/WD/NS/BH only — BDs don't fuse hydrogen,
// so they're not part of that pipeline; stellar.js's own comment on
// sampleBDMass notes this population is seeded separately). No established
// closed-form mass→(L,R,Teff) relation is in the research report for BDs, so
// this is a coarse, documented approximation good enough for a faint,
// barely-visible population (not covered by any validate-astro target).
function synthBrownDwarf(mass) {
    const t = (mass - 0.01) / (0.08 - 0.01);
    const Teff = 500 + 2200 * Math.max(0, Math.min(1, t));
    const L = 1e-6 * Math.pow(mass / 0.03, 3);
    const R = 0.1;
    return { kind: "BD", mass, L, R, Teff, color: 0x8a4a2a, cls: "BD" };
}

// --- Shared per-candidate synthesis ----------------------------------------
// Draws population/age/feh, mass, evolutionary state (synthStar), optional
// catalog-completeness rejection, kinematics and epicyclic parameters, and
// an optional binary companion. Returns null if the candidate is rejected
// (density gradient or, for the local tier, catalog completeness).
function synthesizeCandidate(gx, gy, gz, rng, rngAge, rngKin, rngBin, rngSynth, applyCompleteness) {
    const R = Math.hypot(gx, gy);
    const betaDeg = Math.atan2(gy, gx) * RAD2DEG;
    const Rkpc = R / KPC_PC;

    const pop = assignPopulation(rngAge, R, gz);
    let age = drawAge(rngAge, pop);
    if (pop === "thin" && age < YOUNG_AGE_GYR) age = gateYoungAge(rngAge, R, betaDeg);
    const feh = drawFeh(rngAge, Rkpc, pop);

    let mass = sampleIMFMass(rng);
    let s0 = synthStar(rngSynth, mass, age, feh);
    const retain = REMNANT_RETAIN[s0.kind];
    if (retain !== undefined && rngSynth() >= retain) {
        // Not retained (see REMNANT_RETAIN doc above). Resurrecting the SAME
        // high initial mass as a living star manufactures O/B/A/F "ghosts"
        // out of thin air: every non-retained candidate's mass was, by
        // construction, drawn from the IMF's massive tail, so putting it
        // back on the main sequence just because it wasn't retained as a
        // remnant systematically over-populates the hot classes (measured:
        // in a 100 pc sample, 100% of O, 92% of B, 60% of A and 22% of F
        // were these ghosts) while diluting every other class's fraction.
        // Substitute an independent mass draw from the same IMF instead,
        // rejected until it is still alive (MS or giant) at this candidate's
        // actual age — physically "whatever ordinary star the IMF would
        // have put here instead of a would-be remnant". This conserves the
        // total count without distorting the high-mass PDMF (the discarded
        // heavy mass isn't reused anywhere else). Chabrier's steep low-mass
        // weighting means a living draw is found almost immediately; the
        // fallback (0.1 M⊙, alive past 3000 Gyr) only matters for
        // pathological ages.
        let newMass = 0.1;
        for (let tries = 0; tries < 32; tries++) {
            const m = sampleIMFMass(rngSynth);
            if (age < 1.1 * tMSGyr(m)) { newMass = m; break; }
        }
        mass = newMass;
        s0 = synthStar(rngSynth, mass, age, feh);
    }

    if (applyCompleteness) {
        // Statistical catalog handoff (catalog-strategy.md §2): thin out
        // procedural candidates the real HYG/AT-HYG catalog already supplies
        // at this distance/class, so procedural fills in only where the
        // catalog doesn't reach. Inside ~25 pc this sends M-dwarfs to ~0
        // (CNS5/Tier-0 already has them all) by design.
        const dPc = Math.hypot(gx - SUN_GAL[0], gy - SUN_GAL[1], gz - SUN_GAL[2]);
        const comp = completeness(s0.cls, dPc);
        if (comp > 0 && rngAge() < comp) return null;
    }

    const vel = drawVelocity(rngKin, Rkpc, betaDeg, pop, s0.kind);
    const epi = computeEpicyclic(R, vel.U, vel.Vpec);
    const nu = verticalFreqAt(R);

    const eq = [0, 0, 0];
    galToEquatorialKmInto(gx, gy, gz, eq);
    const star = {
        gx, gy, gz,
        x: eq[0], y: eq[1], z: eq[2],
        mass: s0.mass, L: s0.L, R: s0.R, Teff: s0.Teff,
        color: s0.color, cls: s0.cls, kind: s0.kind,
        age, feh,
        vx: vel.vx, vy: vel.vy, vz: vel.vz,
        epiRg: epi.Rg, epiX: epi.X, epiPhi0: epi.phi0, epiOmega0: epi.Omega0, epiKappa0: epi.kappa0, epiNu: nu,
    };
    attachCompanion(rngBin, star, mass, age, feh, gx, gy, gz);
    return star;
}

// Per-cell generation cache (revisits are pure but caching avoids recompute).
const cache = new Map();
const CACHE_MAX = 4096;
function cacheKey(seed, ci, cj, ck) { return (seed >>> 0) + "," + ci + "," + cj + "," + ck; }
const localCache = new Map();
const LOCAL_CACHE_MAX = 8192;
function localCacheKey(seed, ci, cj, ck) { return (seed >>> 0) + "," + ci + "," + cj + "," + ck; }

// Generate the stars in one galactocentric cell. Pure in (SEED, ci, cj, ck).
// Returns an array of star objects:
//   { gx,gy,gz (pc, galactocentric), x,y,z (km, Sol-centred equatorial),
//     mass,L,R(R⊙),Teff,color,cls,kind, age,feh, vx,vy,vz (km/s),
//     epiRg,epiX,epiPhi0,epiOmega0,epiKappa0,epiNu, [companion], id }
export function starsInCell(ci, cj, ck) {
    const seed = SEED >>> 0;
    const key = cacheKey(seed, ci, cj, ck);
    const hit = cache.get(key);
    if (hit) return hit;

    const ox = ci * CELL_PC, oy = cj * CELL_PC, oz = ck * CELL_PC;
    const cx = ox + CELL_PC / 2, cy = oy + CELL_PC / 2, cz = oz + CELL_PC / 2;
    const R = Math.hypot(cx, cy);

    let out;
    if (R > R_DISC_MAX + 500 || Math.abs(cz) > Z_DISC_MAX) {
        out = [];
    } else {
        const dens = densityAt(cx, cy, cz);
        let expected = H_BURNING_DENSITY_PC3 * dens * CELL_VOL;
        // Materialisation cap: a memory guard for the dense inner galaxy/bulge,
        // set well above the local-disc count (~1.3e5/cell) so the Solar
        // neighbourhood is never throttled. Inner-galaxy LOD subsampling (which
        // renders dense regions without materialising every star) is task #10.
        if (expected > MATERIALISE_MAX) expected = MATERIALISE_MAX;
        const cellSeed = hashInts(seed, LEVEL_STAR, ci, cj, ck);
        const rng = makeRNG(cellSeed);
        const rngAge = makeRNG(splitSeed(cellSeed, SALT_AGE));
        const rngKin = makeRNG(splitSeed(cellSeed, SALT_KIN));
        const rngBin = makeRNG(splitSeed(cellSeed, SALT_BIN));
        const rngSynth = makeRNG(splitSeed(cellSeed, SALT_SYNTH));
        const n = samplePoisson(rng, expected);
        out = new Array(n);
        let w = 0;
        const densCenter = Math.max(dens, 1e-9);
        for (let k = 0; k < n; k++) {
            const gx = ox + rng() * CELL_PC;
            const gy = oy + rng() * CELL_PC;
            const gz = oz + rng() * CELL_PC;
            // Light rejection against the local density so the within-cell
            // distribution follows the gradient (esp. the vertical falloff).
            if (rng() > densityAt(gx, gy, gz) / densCenter) continue;
            const star = synthesizeCandidate(gx, gy, gz, rng, rngAge, rngKin, rngBin, rngSynth, false);
            if (!star) continue;
            star.id = "g:" + seed + ":" + ci + ":" + cj + ":" + ck + ":" + k;
            out[w++] = star;
        }
        out.length = w;
    }

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, out);
    return out;
}

// All procedurally generated stars within radiusPc of a galactocentric point.
export function sampleStarsNear(gx, gy, gz, radiusPc) {
    const ciLo = Math.floor((gx - radiusPc) / CELL_PC), ciHi = Math.floor((gx + radiusPc) / CELL_PC);
    const cjLo = Math.floor((gy - radiusPc) / CELL_PC), cjHi = Math.floor((gy + radiusPc) / CELL_PC);
    const ckLo = Math.floor((gz - radiusPc) / CELL_PC), ckHi = Math.floor((gz + radiusPc) / CELL_PC);
    const r2 = radiusPc * radiusPc;
    const found = [];
    for (let ci = ciLo; ci <= ciHi; ci++)
        for (let cj = cjLo; cj <= cjHi; cj++)
            for (let ck = ckLo; ck <= ckHi; ck++) {
                const stars = starsInCell(ci, cj, ck);
                for (let s = 0; s < stars.length; s++) {
                    const st = stars[s];
                    const dx = st.gx - gx, dy = st.gy - gy, dz = st.gz - gz;
                    if (dx * dx + dy * dy + dz * dz <= r2) found.push(st);
                }
            }
    return found;
}

// Fine-grained deterministic sample for the active ship neighbourhood. It uses
// 4 pc cells so runtime streaming never materialises a full 100 pc catalogue
// cell just to find the few stars around the ship.
export function sampleLocalStarsNear(gx, gy, gz, radiusPc, limit = 512) {
    const ciLo = Math.floor((gx - radiusPc) / LOCAL_CELL_PC), ciHi = Math.floor((gx + radiusPc) / LOCAL_CELL_PC);
    const cjLo = Math.floor((gy - radiusPc) / LOCAL_CELL_PC), cjHi = Math.floor((gy + radiusPc) / LOCAL_CELL_PC);
    const ckLo = Math.floor((gz - radiusPc) / LOCAL_CELL_PC), ckHi = Math.floor((gz + radiusPc) / LOCAL_CELL_PC);
    const r2 = radiusPc * radiusPc;
    const found = [];
    for (let ci = ciLo; ci <= ciHi; ci++)
        for (let cj = cjLo; cj <= cjHi; cj++)
            for (let ck = ckLo; ck <= ckHi; ck++) {
                for (const st of localStarsInCell(ci, cj, ck)) {
                    const dx = st.gx - gx, dy = st.gy - gy, dz = st.gz - gz;
                    const d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 <= r2) found.push({ ...st, d2 });
                }
            }
    found.sort((a, b) => a.d2 - b.d2 || (a.id < b.id ? -1 : 1));
    if (found.length > limit) found.length = limit;
    for (const st of found) delete st.d2;
    return found;
}

// Local tier: same physics as starsInCell, plus the catalog-completeness
// handoff and a separately-seeded brown-dwarf population (both gameplay-only
// concerns kept out of the coarse/scientific tier — see the module header).
export function localStarsInCell(ci, cj, ck, seed = SEED) {
    seed >>>= 0;
    const key = localCacheKey(seed, ci, cj, ck);
    const hit = localCache.get(key);
    if (hit) return hit;
    const ox = ci * LOCAL_CELL_PC, oy = cj * LOCAL_CELL_PC, oz = ck * LOCAL_CELL_PC;
    const cx = ox + LOCAL_CELL_PC / 2, cy = oy + LOCAL_CELL_PC / 2, cz = oz + LOCAL_CELL_PC / 2;
    const R = Math.hypot(cx, cy);
    let out = [];
    if (R <= R_DISC_MAX + 500 && Math.abs(cz) <= Z_DISC_MAX) {
        const dens = densityAt(cx, cy, cz);
        if (dens > 0) {
            const cellSeed = hashInts(seed, LEVEL_LOCAL_STAR, ci, cj, ck);
            const rng = makeRNG(cellSeed);
            const rngAge = makeRNG(splitSeed(cellSeed, SALT_AGE));
            const rngKin = makeRNG(splitSeed(cellSeed, SALT_KIN));
            const rngBin = makeRNG(splitSeed(cellSeed, SALT_BIN));
            const rngSynth = makeRNG(splitSeed(cellSeed, SALT_SYNTH));
            const expected = Math.min(LOCAL_MATERIALISE_MAX, H_BURNING_DENSITY_PC3 * dens * LOCAL_CELL_VOL);
            const densCenter = Math.max(dens, 1e-9);
            const n = samplePoisson(rng, expected);
            for (let k = 0; k < n; k++) {
                const sx = ox + rng() * LOCAL_CELL_PC;
                const sy = oy + rng() * LOCAL_CELL_PC;
                const sz = oz + rng() * LOCAL_CELL_PC;
                if (rng() > densityAt(sx, sy, sz) / densCenter) continue;
                const star = synthesizeCandidate(sx, sy, sz, rng, rngAge, rngKin, rngBin, rngSynth, true);
                if (!star) continue;
                star.id = "p:" + seed + ":" + ci + ":" + cj + ":" + ck + ":" + k;
                out.push(star);
            }

            // Brown dwarfs: own seeded sub-population, no completeness thinning
            // (not a well-surveyed population even nearby — see synthBrownDwarf).
            const rngBD = makeRNG(splitSeed(cellSeed, SALT_BD));
            const expectedBD = Math.min(LOCAL_BD_MATERIALISE_MAX, BD_DENSITY_PC3 * dens * LOCAL_CELL_VOL);
            const nBD = samplePoisson(rngBD, expectedBD);
            for (let k = 0; k < nBD; k++) {
                const sx = ox + rngBD() * LOCAL_CELL_PC;
                const sy = oy + rngBD() * LOCAL_CELL_PC;
                const sz = oz + rngBD() * LOCAL_CELL_PC;
                if (rngBD() > densityAt(sx, sy, sz) / densCenter) continue;
                const mass = sampleBDMass(rngBD);
                const bd = synthBrownDwarf(mass);
                const R = Math.hypot(sx, sy);
                const betaDeg = Math.atan2(sy, sx) * RAD2DEG;
                const vel = drawVelocity(rngBD, R / KPC_PC, betaDeg, "thin", "BD");
                const epi = computeEpicyclic(R, vel.U, vel.Vpec);
                const eq = [0, 0, 0];
                galToEquatorialKmInto(sx, sy, sz, eq);
                out.push({
                    gx: sx, gy: sy, gz: sz,
                    x: eq[0], y: eq[1], z: eq[2],
                    mass: bd.mass, L: bd.L, R: bd.R, Teff: bd.Teff,
                    color: bd.color, cls: bd.cls, kind: bd.kind,
                    age: 5, feh: 0, // BDs don't evolve via synthStar; placeholders so age/feh stay finite for any generic consumer
                    vx: vel.vx, vy: vel.vy, vz: vel.vz,
                    epiRg: epi.Rg, epiX: epi.X, epiPhi0: epi.phi0, epiOmega0: epi.Omega0, epiKappa0: epi.kappa0,
                    epiNu: verticalFreqAt(R),
                    id: "p:" + seed + ":" + ci + ":" + cj + ":" + ck + ":bd" + k,
                });
            }
        }
    }
    if (localCache.size >= LOCAL_CACHE_MAX) localCache.clear();
    localCache.set(key, out);
    return out;
}

export function localStarById(id) {
    const m = String(id || "").match(/^p:(\d+):(-?\d+):(-?\d+):(-?\d+):(\w+)$/);
    if (!m) return null;
    const seed = Number(m[1]) >>> 0;
    const ci = Number(m[2]), cj = Number(m[3]), ck = Number(m[4]);
    const stars = localStarsInCell(ci, cj, ck, seed);
    return stars.find(st => st.id === id) || null;
}

export function clearCache() { cache.clear(); localCache.clear(); }
