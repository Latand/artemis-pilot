import { DARK_ENERGY, DARK_MATTER, MU_S, PC_KM } from "./constants.js";
import { equatorialKmToGal, galacticToEquatorial, R0_PC, Z_SUN_PC } from "./universe/coords.js";
import { smooth01 } from "./format.js";

const _haloA = [0, 0, 0];
const _haloO = [0, 0, 0];

// --- WP23-EXTENSION: bound systems decouple from the Hubble flow ----------
// Standard cosmology result: inside a virialized/gravitationally-bound
// structure, ordinary gravity overwhelms the cosmological-constant repulsion
// and the local metric does not expand (e.g. Cooperstock, Faraoni & Vollick
// 1998, "Cosmological expansion of a fundamental particle"; textbook
// treatment of "the Local Group is bound and does not expand"). Without this
// gate, darkEnergyAccel's a=H^2*r term is a genuine anti-spring around any
// reference point (Earth, here): an unstable equilibrium at r=0 whose
// exponential growth (rate ~sqrt(H2_PHYS)) is negligible over ordinary
// gameplay timescales but compounds into a real drift over Gyr-scale deep
// time, which is what let the solar system wander out of the galaxy in the
// user's T+34 Gyr report.

// Local Group total gravitating mass: Milky Way (this module's own NFW halo,
// ~1e12 Msun) + M31 (~1.5-2e12 Msun) + minor members. Not itemized in
// astroConstants.js's frozen contract (no per-galaxy position model exists
// here), so this is a constant point-mass floor applied beyond the Milky
// Way's own virial radius, representing the combined Local Group potential
// (order-of-magnitude consistent with van der Marel et al. 2012, ~3-4e12
// Msun total) rather than a modeled M31 orbit.
export const LOCAL_GROUP_MASS_SOLAR = 3.2e12;
export const LOCAL_GROUP_RADIUS_PC = 1.5e6; // ~1.5 Mpc, the scale at which Local Group binding fades

function galacticEnclosedMassSolar(rPc) {
    const mw = darkMatterEnclosedMassSolar(rPc);
    return rPc <= DARK_MATTER.VIRIAL_RADIUS_PC ? mw : Math.max(mw, LOCAL_GROUP_MASS_SOLAR);
}

// Gravitational acceleration (km/s^2) from the galaxy's own enclosed mass at
// galactocentric radius rPc: the Milky Way's NFW halo out to its virial
// radius, the Local Group's combined mass beyond it. Used both as the
// "is this point bound" reference for boundSuppression and as a reusable
// scale-independent estimate (exported so callers/tests can probe it at any
// radius without duplicating the mass law).
export function galacticGravAccelKmS2(rPc) {
    if (!(rPc > 0)) return 0;
    const r = haloForceRadiusPc(rPc);
    const m = galacticEnclosedMassSolar(rPc);
    const rKm = r * PC_KM;
    return MU_S * m / Math.max(1, rKm * rKm);
}

// darkEnergyAccel only receives an Earth-relative offset (not the ship's
// absolute galactic position), so its local-gravity estimate is necessarily
// approximate: the Sun's own pull at that same separation (dominant at any
// separation up to interplanetary scale) floored by the galaxy's own gravity
// at the Sun's fixed galactocentric radius (dominant at any separation up to
// hundreds of parsecs — the sim's whole system sits inside the galaxy by
// construction, so this floor holds regardless of the small, sub-AU error
// from ignoring the Earth<->Sun offset itself).
const SUN_GALACTIC_GRAV_KMS2 = galacticGravAccelKmS2(Math.hypot(R0_PC, Z_SUN_PC));
function localSystemGravAccelKmS2(rKm) {
    const r = Math.max(rKm, 1);
    return Math.max(MU_S / (r * r), SUN_GALACTIC_GRAV_KMS2);
}

// boundSuppression(rKm, localGravAccelKmS2) -> 0..1: how much of the H^2*r
// (Lambda) repulsion at Hubble-flow radius rKm to suppress, given the local
// gravitational acceleration localGravAccelKmS2 at that point. 1 = fully
// suppressed (bound: gravity beats Lambda by >~3x), 0 = fully active
// (unbound: Lambda beats gravity by >~3x, i.e. gravity < ~0.3x Lambda),
// smoothstep between in log-ratio space since the transition spans orders of
// magnitude. Pure function of its two inputs so it can be probed directly
// against real astrophysical g values (Earth's solar orbit, the galactic
// rotation curve, the Local Group's binding mass) without going through any
// particular caller's local-gravity estimate.
const BOUND_RATIO_HI = 3, BOUND_RATIO_LO = 0.3;
const BOUND_LOG_LO = Math.log10(BOUND_RATIO_LO), BOUND_LOG_HI = Math.log10(BOUND_RATIO_HI);
export function boundSuppression(rKm, localGravAccelKmS2) {
    if (!(rKm > 0)) return 1;
    const aLambda = DARK_ENERGY.H2_PHYS * rKm;
    if (!(aLambda > 0)) return 1;
    const g = Math.max(0, localGravAccelKmS2);
    if (g <= 0) return 0;
    const logRatio = Math.log10(g / aLambda);
    return smooth01(BOUND_LOG_LO, BOUND_LOG_HI, logRatio);
}

export function darkEnergyAccel(x, y, out, h2 = DARK_ENERGY.H2_PHYS, z = 0) {
    const r = Math.hypot(x, y, z);
    const suppression = boundSuppression(r, localSystemGravAccelKmS2(r));
    const a = h2 * (1 - suppression);
    out[0] = a * x;
    out[1] = a * y;
    if (out.length > 2) out[2] = a * z;
    return out;
}

export function darkEnergyAccelerationKmS2(rKm) {
    return DARK_ENERGY.H2_PHYS * Math.max(0, rKm);
}

export function darkEnergySpeedKmS(rKm) {
    return DARK_ENERGY.H_PHYS * Math.max(0, rKm);
}

export function darkEnergyVisibleFractionKm(rKm) {
    return smooth01(DARK_ENERGY.VISIBLE_START_KM, DARK_ENERGY.VISIBLE_FULL_KM, Math.max(0, rKm));
}

function nfwShape(x) {
    return Math.log(1 + x) - x / (1 + x);
}

function haloMassRadiusPc(rPc) {
    return Math.min(Math.max(rPc, DARK_MATTER.SOFTENING_PC), DARK_MATTER.VIRIAL_RADIUS_PC);
}

function haloForceRadiusPc(rPc) {
    return Math.max(rPc, DARK_MATTER.SOFTENING_PC);
}

export function darkMatterEnclosedMassSolar(rPc) {
    if (rPc <= 0) return 0;
    const r = haloMassRadiusPc(rPc);
    const x = r / DARK_MATTER.SCALE_RADIUS_PC;
    return DARK_MATTER.HALO_MASS_SOLAR * nfwShape(x) / DARK_MATTER.NFW_NORM;
}

export function darkMatterCircularSpeedKmSAtGalRadiusPc(rPc) {
    if (rPc <= 0) return 0;
    const r = haloForceRadiusPc(rPc);
    const m = darkMatterEnclosedMassSolar(rPc);
    return Math.sqrt(MU_S * m / Math.max(1, r * PC_KM));
}

export function darkMatterVisibleFractionPc(deltaPc) {
    return smooth01(DARK_MATTER.VISIBLE_START_PC, DARK_MATTER.VISIBLE_FULL_PC, Math.max(0, deltaPc));
}

// darkMatterRelativeAccel is a TIDAL term (the halo's absolute pull differenced
// between the ship's position and Earth's), not the H^2*r Hubble repulsion —
// real gravity, not Lambda. It still needs the same bound-system gate,
// though: measured directly (see WP23-EXTENSION debugging), the raw
// differential at a point ~135 pc from Earth is ~1.3e-15 km/s^2 — five orders
// of magnitude above the raw (pre-suppression) dark-energy accel at the same
// separation, and large enough that a single deep-time leapfrog kick
// (physics.js's shipCosmologyJump, dt ~0.1 Gyr per call) imparts a real,
// compounding km/s-scale velocity kick every call. That is a genuine
// consequence of representing a smooth galactic field as a point-to-point
// difference with no compensating local self-gravity in the jump model, not
// a sign of anything wrong with the NFW mass law itself (the raw ~1.6%
// difference over 135 pc at R0 matches the expected dM/M gradient exactly).
// Gating each endpoint's own raw pull by its own boundSuppression — zero
// wherever that endpoint sits deep in a bound structure (near Earth, in the
// disk, inside the Local Group) — collapses the ship-Earth differential back
// toward zero in exactly the regime that was diverging, while leaving it
// active for a point genuinely beyond the Local Group.
export function darkMatterHaloAccelAtEquatorialKm(x, y, z, out = [0, 0, 0]) {
    const [gx, gy, gz] = equatorialKmToGal(x, y, z);
    const rPc = Math.hypot(gx, gy, gz);
    if (rPc <= 1e-9) {
        out[0] = 0; out[1] = 0; out[2] = 0;
        return out;
    }
    const rSoftPc = haloForceRadiusPc(rPc);
    const rKm = rSoftPc * PC_KM;
    const m = darkMatterEnclosedMassSolar(rPc);
    const suppression = boundSuppression(rKm, galacticGravAccelKmS2(rPc));
    const a = MU_S * m / Math.max(1, rKm * rKm) * (1 - suppression);
    const inv = 1 / rSoftPc;
    const agx = -gx * inv * a;
    const agy = -gy * inv * a;
    const agz = -gz * inv * a;
    const eq = galacticToEquatorial([-agx, agy, agz]);
    out[0] = eq[0]; out[1] = eq[1]; out[2] = eq[2];
    return out;
}

export function darkMatterRelativeAccel(x, y, z, originX = 0, originY = 0, originZ = 0, out = [0, 0, 0]) {
    darkMatterHaloAccelAtEquatorialKm(originX + x, originY + y, originZ + z, _haloA);
    darkMatterHaloAccelAtEquatorialKm(originX, originY, originZ, _haloO);
    out[0] = _haloA[0] - _haloO[0];
    out[1] = _haloA[1] - _haloO[1];
    out[2] = _haloA[2] - _haloO[2];
    return out;
}

export function darkMatterLocalCircularSpeedKmS() {
    return darkMatterCircularSpeedKmSAtGalRadiusPc(Math.hypot(R0_PC, Z_SUN_PC));
}
