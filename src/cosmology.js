import { DARK_ENERGY, DARK_MATTER, MU_S, PC_KM } from "./constants.js";
import { equatorialKmToGal, galacticToEquatorial, R0_PC, Z_SUN_PC } from "./universe/coords.js";
import { smooth01 } from "./format.js";

const _haloA = [0, 0, 0];
const _haloO = [0, 0, 0];

export function darkEnergyAccel(x, y, out, h2 = DARK_ENERGY.H2_PHYS, z = 0) {
    out[0] = h2 * x;
    out[1] = h2 * y;
    if (out.length > 2) out[2] = h2 * z;
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
    const a = MU_S * m / Math.max(1, rKm * rKm);
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
