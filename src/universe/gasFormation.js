// An illustrative, reversible single-core birth sequence, NOT hydrodynamics.
// Uniform-sphere free-fall time sets the order of magnitude; phase timings,
// colour and radius easing are art-directed. No pressure, cooling or feedback.
import { MU_S, R_SUN, SEC_YEAR, WARPS } from "../constants.js";

export const GAS_RADIUS_KM = 0.045 * 9.4607e12;
export const GAS_MASSES = [0.3, 1, 3];
export const GAS_MODEL_VERSION = 1;
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = x => { const t = clamp(x); return t * t * (3 - 2 * t); };

export function normalizeFormation(value) {
    if (!value || value.v !== GAS_MODEL_VERSION || !Number.isFinite(value.bornAtSec) ||
        !GAS_MASSES.includes(value.massSolar)) return null;
    return { v: GAS_MODEL_VERSION, bornAtSec: value.bornAtSec, massSolar: value.massSolar };
}

export function formationDuration(record) {
    // t_ff = pi/sqrt(8) * sqrt(R^3/GM), evaluated without cubing huge radii.
    return Math.PI / Math.sqrt(8) * record.radiusKm * Math.sqrt(record.radiusKm / (MU_S * record.formation.massSolar));
}

export function gasStateAt(record, simT, out = {}) {
    const f = record.formation;
    if (!f) return null;
    const durationSec = formationDuration(record);
    const ageSec = simT - f.bornAtSec;
    const born = Number.isFinite(simT) && simT >= f.bornAtSec + durationSec;
    const progress = born ? 1 : clamp(ageSec / durationSec);
    const present = Number.isFinite(simT) && ageSec >= 0;
    const coreFraction = smooth((progress - .25) / .75);
    const radiusSolar = Math.pow(f.massSolar, .8);
    const radiusKm = born ? radiusSolar * R_SUN : radiusSolar * R_SUN + (record.radiusKm - radiusSolar * R_SUN) * Math.pow(1 - progress, 1.2);
    const lumSolar = Math.pow(f.massSolar, 3.5);
    const tempK = 5772 * Math.pow(lumSolar / (radiusSolar * radiusSolar), .25);
    return Object.assign(out, {
        present, born, progress, ageSec, durationSec,
        phase: !present ? "Before release" : born ? "Newborn star" : progress < .3 ? "Gas cloud" : progress < .75 ? "Collapsing cloud" : "Protostar",
        radiusKm, radiusSolar, lumSolar, tempK,
        totalMassSolar: f.massSolar,
        coreMassSolar: present ? f.massSolar * coreFraction : 0,
        gasMassSolar: present ? f.massSolar * (1 - coreFraction) : 0,
        durationYears: durationSec / SEC_YEAR,
    });
}

// Keep every preset visible for at least eight seconds. The coarse time ladder
// has a 1000→1,000,000 yr/s gap: choosing the next faster rung skips the birth.
export function gasWatchWarp(remainingSec, feasibleWarp = Infinity) {
    if (!(remainingSec > 0) || !Number.isFinite(remainingSec) || !(feasibleWarp > 0)) return 0;
    const warp = WARPS.filter(w => w <= remainingSec / 8 && w <= feasibleWarp).at(-1) || 0;
    return warp > 0 && remainingSec / warp <= 180 ? warp : 0;
}
