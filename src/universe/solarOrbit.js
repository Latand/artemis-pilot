// The Sun's own orbit around the Galactic centre (WP23-EXTENSION).
//
// Until now the Sun's galactic position was the FIXED anchor SUN_GAL
// (coords.js) — correct for "today" but wrong at any other simulation time:
// the Sun actually completes a ~230 Myr orbit around the galactic centre on
// a mildly eccentric, mildly out-of-plane epicyclic path. Over ordinary
// gameplay timescales that motion is imperceptible, but over the Gyr-scale
// deep time this sim supports it is not optional — treating the Sun as
// permanently fixed is itself part of what let the user's T+34 Gyr report
// show the solar system sitting motionless while dark energy pushed
// everything else away from it.
//
// This mirrors the closed-form local epicyclic approximation galaxy.js uses
// for every procedural star (Binney & Tremaine §3.2's guiding-centre +
// harmonic-oscillator approximation), specialised to the Sun's own known
// present-day position and velocity rather than a population draw. galaxy.js
// does not export its per-star epicyclic solver (computeEpicyclic/
// starPositionAt take an opaque `star` object with precomputed epi* fields),
// so the same math is reproduced here directly for the one "star" that is
// the Sun — small, self-contained, and independently checkable against
// galaxy.js's own derivation.

import { R0_PC, Z_SUN_PC, SUN_GAL, PC_KM } from "./coords.js";
import { vCirc } from "./astroConstants.js";

// Sun's velocity relative to the Local Standard of Rest (Schönrich, Binney &
// Dehnen 2010): U traditionally positive toward the Galactic centre, V
// positive in the direction of Galactic rotation, W positive toward the
// North Galactic Pole, km/s.
export const SOLAR_PECULIAR_KMS = { U: 11.1, V: 12.24, W: 7.25 };

const VCIRC_SUN_KMS = vCirc(R0_PC / 1000); // ~229 km/s at R0 (Eilers et al. 2019 rotation curve)
const R0_KM = R0_PC * PC_KM;
const OMEGA0 = VCIRC_SUN_KMS / R0_KM;       // rad/s, guiding-centre angular rate
const KAPPA0 = Math.SQRT2 * OMEGA0;         // rad/s, epicyclic frequency (flat rotation curve approximation)

// Time to complete one full trip around the Galactic centre ("galactic
// year"), exported for direct assertion (report figure: ~225-250 Myr).
export const GALACTIC_ORBIT_PERIOD_S = 2 * Math.PI / OMEGA0;

// Vertical epicyclic frequency at R0, derived the same way galaxy.js derives
// its verticalFreqAt (nu = sqrt(4*pi*G*rho_mid)) rather than a bare literal,
// so the number is checkable from first principles. At R = R0 galaxy.js's
// density-shape ratio is exactly 1 by construction (its own midplane
// normalisation is taken at R0), so this reduces to exactly the same value
// galaxy.js's verticalFreqAt(R0_PC) would return.
const G_SI = 6.674e-11;                 // m^3 kg^-1 s^-2
const MSUN_KG = 1.98892e30;
const PC_M = PC_KM * 1000;
const RHO_UNIT_KG_M3 = MSUN_KG / (PC_M * PC_M * PC_M);
const RHO_MID_SUN_MSUN_PC3 = 0.1;       // Oort-limit dynamical midplane density (Holmberg & Flynn 2004)
const NU_Z = Math.sqrt(4 * Math.PI * G_SI * RHO_UNIT_KG_M3 * RHO_MID_SUN_MSUN_PC3); // rad/s, ~84 Myr vertical period

// Radial epicyclic parameters solved from the Sun's own (outward-radial,
// azimuthal-peculiar) velocity at t=0, same construction as galaxy.js's
// computeEpicyclic: galaxy.js's "U" is the OUTWARD radial component (R-hat),
// the opposite sign convention from the traditional Schönrich U (positive
// toward the centre) — hence the negation below. "Vpec" is the azimuthal
// peculiar velocity beyond the circular speed, which for the Sun's own known
// motion is simply the traditional V (no population lag term to add, unlike
// galaxy.js's statistically-drawn stars).
const U_OUT_KMS = -SOLAR_PECULIAR_KMS.U;
const VPEC_KMS = SOLAR_PECULIAR_KMS.V;
const xKm = -VPEC_KMS / (2 * OMEGA0);
const yKm = -U_OUT_KMS / KAPPA0;
const EPI_X_PC = Math.hypot(xKm, yKm) / PC_KM;   // radial epicycle amplitude (~0.2-0.4 kpc, matches literature)
const EPI_PHI0 = Math.atan2(yKm, xKm);
const EPI_RG_PC = R0_PC - xKm / PC_KM;           // guiding-centre radius (R(0) = Rg + X*cos(phi0) = R0_PC exactly)
const THETA0 = Math.atan2(SUN_GAL[1], SUN_GAL[0]); // 0, by SUN_GAL's own definition (+X axis)

// Sun's galactocentric position + velocity (pc, km/s) at simulation time
// simTSeconds. At simTSeconds===0 this returns SUN_GAL exactly (bit-for-bit,
// short-circuited rather than relying on the trig round-trip, same pattern
// galaxy.js's starPositionAt uses) — the mandatory "today matches the
// existing fixed anchor" requirement. Zero-allocation when `out` is passed.
export function solarGalacticStateAt(simTSeconds, out) {
    out = out || { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    const t = simTSeconds || 0;
    if (t === 0) {
        out.x = SUN_GAL[0]; out.y = SUN_GAL[1]; out.z = SUN_GAL[2];
        out.vx = U_OUT_KMS; out.vy = VCIRC_SUN_KMS + VPEC_KMS; out.vz = SOLAR_PECULIAR_KMS.W;
        return out;
    }
    const kt = KAPPA0 * t;
    const cosK = Math.cos(kt + EPI_PHI0), sinK = Math.sin(kt + EPI_PHI0);
    const R = EPI_RG_PC + EPI_X_PC * cosK;
    const theta = THETA0 + OMEGA0 * t - (2 * OMEGA0 * EPI_X_PC) / (KAPPA0 * EPI_RG_PC) * (sinK - Math.sin(EPI_PHI0));
    const cosT = Math.cos(theta), sinT = Math.sin(theta);

    const dRdt_pcS = -EPI_X_PC * KAPPA0 * sinK;                                  // pc/s
    const dThetaDt = OMEGA0 - (2 * OMEGA0 * EPI_X_PC / EPI_RG_PC) * cosK;        // rad/s
    const vxPcS = dRdt_pcS * cosT - R * sinT * dThetaDt;
    const vyPcS = dRdt_pcS * sinT + R * cosT * dThetaDt;

    const nuT = NU_Z * t;
    const cosN = Math.cos(nuT), sinN = Math.sin(nuT);
    const zAmpPc = SOLAR_PECULIAR_KMS.W / NU_Z / PC_KM;
    const z = Z_SUN_PC * cosN + zAmpPc * sinN;
    const dzdt_pcS = -Z_SUN_PC * NU_Z * sinN + (SOLAR_PECULIAR_KMS.W / PC_KM) * cosN;

    out.x = R * cosT; out.y = R * sinT; out.z = z;
    out.vx = vxPcS * PC_KM; out.vy = vyPcS * PC_KM; out.vz = dzdt_pcS * PC_KM;
    return out;
}
