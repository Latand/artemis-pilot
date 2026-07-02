// Tidal-disruption model in code units: mu=GM km^3/s^2, radii km.
// Hills 1975; Rees 1988: tidal radius r_t = R_star q^(1/3).
export const TDE_ETA = 0.1;
export const L_EDD_PER_MSUN = 1.26e31;

const C_M = 299792458;
const BOUND_FRACTION = 0.5;

export function tidalRadiusKm(rKm, muBH, muBody) {
    return rKm * Math.cbrt(muBH / muBody);
}

// Rees 1988; Lacy, Townes & Hollenbach 1982: frozen-in energy spread.
export function mostBoundEnergy(rKm, muBH, muBody) {
    const rt = tidalRadiusKm(rKm, muBH, muBody);
    return muBH * rKm / Math.max(1e-30, rt * rt);
}

// Rees 1988; Evans & Kochanek 1989; Stone, Sari & Loeb 2013.
export function fallbackTimeSec(rKm, muBH, muBody) {
    const eMb = mostBoundEnergy(rKm, muBH, muBody);
    return 2 * Math.PI * muBH / Math.pow(2 * eMb, 1.5);
}

// Ulmer 1999; Bonnerot et al. 2016: bound stream circularizes near 2 r_t.
export function circularizationKm(rKm, muBH, muBody) {
    return 2 * tidalRadiusKm(rKm, muBH, muBody);
}

// Schwarzschild ISCO: 6GM/c^2 = 3 r_s.
export function iscoKm(rsKm) {
    return 3 * rsKm;
}

// Rees 1988; Phinney 1989: fallback peaks at t_fb, then follows t^-5/3.
export function fallbackRate(tSec, tFbSec, mStarKg) {
    if (!isFinite(tSec) || !isFinite(tFbSec) || tFbSec <= 0 || mStarKg <= 0) return 0;
    const peak = mStarKg / (3 * tFbSec);
    if (tSec <= 0) return 0;
    if (tSec < tFbSec) return peak * (tSec / tFbSec);
    return peak * Math.pow(tSec / tFbSec, -5 / 3);
}

export function tdeLuminosityW(tSec, tFbSec, mStarKg, mBhMsun) {
    const l = TDE_ETA * fallbackRate(tSec, tFbSec, mStarKg) * C_M * C_M;
    const lEdd = L_EDD_PER_MSUN * mBhMsun;
    return Math.min(l, lEdd);
}

export function boundFraction() {
    return BOUND_FRACTION;
}
