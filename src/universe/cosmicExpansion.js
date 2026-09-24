// Flat Lambda-CDM background expansion and the observer's past light cone.
//
// The large-scale layer (galaxy population, render/galaxyPopulationRender.js)
// needs three things this module provides:
//
//   1. the scale factor a(t) at any cosmic time, from the Big Bang to the
//      degenerate era (10^15 yr and beyond) without overflow -- everything is
//      carried as ln a;
//   2. the conformal time eta(a) = integral c dt / a, so the comoving distance
//      light covers between two epochs is eta(a_obs) - eta(a_emit);
//   3. the inverse: for an observer at a_obs and a source at comoving distance
//      chi, the scale factor a_emit at which the light now arriving left it
//      (the retarded time on the observer's past light cone).
//
// With those, a source at comoving distance chi (Mpc, normalised to a = 1
// today) is seen with redshift 1 + z = a_obs / a_emit, at angular-diameter
// distance d_A = a_emit chi and luminosity distance d_L = a_obs^2 chi / a_emit
// (flat space). Its surface brightness is dimmed by (1 + z)^-4.
//
// Model: matter + cosmological constant, radiation neglected (it changes the
// age by < 0.1 %). Planck 2018 VI (A&A 641, A6), TT,TE,EE+lowE+lensing+BAO:
// H0 = 67.66 km/s/Mpc (the value of constants.js DARK_ENERGY.H0_KM_S_MPC),
// Omega_m = 0.3111, Omega_Lambda = 0.6889. These give t0 = 13.79 Gyr, the
// Planck age. Closed forms (e.g. Peebles 1993, eq. 13.20):
//   a(t) = (Om/OL)^(1/3) sinh^(2/3)(1.5 sqrt(OL) H0 t)
//   t(a) = 2 / (3 sqrt(OL) H0) asinh(sqrt(OL/Om) a^(3/2))
//
// Bound structures (planetary systems, galaxies, groups, clusters) do not
// take part in this expansion: callers scale only the separations of
// unbound units by a (see galaxyPopulation.js group handling).
//
// Pure module: no THREE, no DOM. Units: Gyr, Mpc, km/s.

export const COSMO = Object.freeze({
    H0: 67.66,          // km/s/Mpc
    Om: 0.3111,
    OL: 0.6889,
    cKms: 299792.458,
});
export const KM_S_MPC_PER_GYR = 1 / 977.7922216807891; // 1 km/s/Mpc in 1/Gyr
export const H0_PER_GYR = COSMO.H0 * KM_S_MPC_PER_GYR;
export const HUBBLE_DISTANCE_MPC = COSMO.cKms / COSMO.H0;       // c / H0
export const GYR_S = 3.15576e16;                                 // Julian Gyr
export const MPC_LY = 3.2615637771674e6;
export const LY_PER_GYR_MPC = 1e9 / MPC_LY;                      // light covers this many Mpc per Gyr (0.3066)

const SQRT_OL = Math.sqrt(COSMO.OL);
const LAMBDA_RATE = 1.5 * SQRT_OL * H0_PER_GYR;                  // 1/Gyr
const LN_A_AMP = Math.log(COSMO.Om / COSMO.OL) / 3;

// ln(sinh x) without overflow.
function lnSinh(x) {
    if (x > 20) return x - Math.LN2 + Math.log1p(-Math.exp(-2 * x));
    return Math.log(Math.sinh(x));
}

// ln a at cosmic time t (Gyr since the Big Bang). t <= 0 returns -Infinity.
export function lnScaleFactorAt(tGyr) {
    if (!(tGyr > 0)) return -Infinity;
    return LN_A_AMP + (2 / 3) * lnSinh(LAMBDA_RATE * tGyr);
}

export function scaleFactorAt(tGyr) {
    return Math.exp(lnScaleFactorAt(tGyr));
}

// Cosmic time (Gyr) at ln a.
export function cosmicTimeAtLnA(lnA) {
    // asinh(sqrt(OL/Om) a^1.5) in log form for huge a
    const lnArg = 0.5 * Math.log(COSMO.OL / COSMO.Om) + 1.5 * lnA;
    const s = lnArg > 20 ? lnArg + Math.LN2 : Math.asinh(Math.exp(lnArg));
    return s / LAMBDA_RATE;
}

export const T0_GYR = cosmicTimeAtLnA(0);   // 13.79 Gyr

// Hubble rate H(a) in km/s/Mpc.
export function hubbleAtLnA(lnA) {
    const inv3 = Math.exp(Math.max(-3 * lnA, -700));
    return COSMO.H0 * Math.sqrt(COSMO.Om * (lnA < -230 ? Infinity : inv3) + COSMO.OL);
}

// Sim clock (seconds since the 2026 epoch, G.t) -> cosmic time (Gyr).
export function cosmicTimeGyr(simTSeconds) {
    const s = Number.isFinite(simTSeconds) ? simTSeconds : 0;
    return T0_GYR + s / GYR_S;
}

// --- Conformal time --------------------------------------------------------
// eta(a) = (c/H0) * integral_0^a da' / (a'^2 E(a')),  E = sqrt(Om a^-3 + OL),
// tabulated in u = ln a. Below the table the matter-era limit
// eta ~ (c/H0) 2 sqrt(a / Om) applies; above it the Lambda-era tail
// eta_inf - eta(a) ~ (c/H0) / (sqrt(OL) a).
const LN_A_MIN = -12, LN_A_MAX = 14, ETA_N = 4097;
const ETA = new Float64Array(ETA_N);
const DU = (LN_A_MAX - LN_A_MIN) / (ETA_N - 1);
let ETA_INF = 0;
(function buildEta() {
    const dh = HUBBLE_DISTANCE_MPC;
    const f = u => {           // d eta / du = (c/H0) / (a E(a))
        const a = Math.exp(u);
        return dh / (a * Math.sqrt(COSMO.Om / (a * a * a) + COSMO.OL));
    };
    let eta = dh * 2 * Math.sqrt(Math.exp(LN_A_MIN) / COSMO.Om);
    ETA[0] = eta;
    for (let i = 1; i < ETA_N; i++) {
        const u0 = LN_A_MIN + (i - 1) * DU, u1 = u0 + DU, um = u0 + DU / 2;
        eta += DU / 6 * (f(u0) + 4 * f(um) + f(u1));   // Simpson per cell
        ETA[i] = eta;
    }
    const aTop = Math.exp(LN_A_MAX);
    // tail beyond the table: integral_aTop^inf da/(a^2 E) with E -> sqrt(OL)
    // plus the first matter correction (-Om / (2 OL) a^-3 in 1/E).
    ETA_INF = eta + dh * (1 / (SQRT_OL * aTop) - COSMO.Om / (8 * COSMO.OL * SQRT_OL * aTop ** 4));
})();
export const ETA_INFINITY_MPC = ETA_INF;

// Conformal time (comoving Mpc light has covered since the Big Bang) at ln a.
export function conformalTimeAtLnA(lnA) {
    if (lnA === -Infinity) return 0;
    if (lnA <= LN_A_MIN) return HUBBLE_DISTANCE_MPC * 2 * Math.sqrt(Math.exp(lnA) / COSMO.Om);
    if (lnA >= LN_A_MAX) {
        const inv = Math.exp(-lnA);
        return ETA_INF - HUBBLE_DISTANCE_MPC * inv / SQRT_OL;
    }
    const x = (lnA - LN_A_MIN) / DU;
    const i = Math.min(ETA_N - 2, Math.floor(x));
    const f = x - i;
    return ETA[i] + (ETA[i + 1] - ETA[i]) * f;
}

// Inverse of conformalTimeAtLnA. eta <= 0 -> -Infinity, eta >= eta_inf -> +Infinity.
export function lnAAtConformalTime(eta) {
    if (!(eta > 0)) return -Infinity;
    if (eta >= ETA_INF) return Infinity;
    if (eta <= ETA[0]) {
        const r = eta / (2 * HUBBLE_DISTANCE_MPC);
        return Math.log(r * r * COSMO.Om);
    }
    if (eta >= ETA[ETA_N - 1]) return Math.log(HUBBLE_DISTANCE_MPC / (SQRT_OL * (ETA_INF - eta)));
    let lo = 0, hi = ETA_N - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ETA[mid] <= eta) lo = mid; else hi = mid;
    }
    const f = (eta - ETA[lo]) / (ETA[hi] - ETA[lo]);
    return LN_A_MIN + (lo + f) * DU;
}

// Comoving distance to the cosmic event horizon for an observer at ln a:
// light emitted now from beyond it never arrives.
export function eventHorizonComovingMpc(lnA) {
    return ETA_INF - conformalTimeAtLnA(lnA);
}

// The light an observer at ln a_obs receives from comoving distance chi
// (Mpc, a = 1 normalisation) left the source at ln a_emit (-Infinity when it
// would have to predate the Big Bang: beyond the particle horizon).
export function emissionLnA(lnAObs, chiMpc) {
    return lnAAtConformalTime(conformalTimeAtLnA(lnAObs) - Math.max(0, chiMpc));
}

// Everything a renderer needs about one source, written into `out`:
//   lnAEmit, tEmitGyr, z (redshift), dA (angular-diameter distance, Mpc),
//   dL (luminosity distance, Mpc), sbDim = (1+z)^-4, visible (false beyond
//   the particle horizon).
export function lightConeView(lnAObs, chiMpc, out = {}) {
    const lnAE = emissionLnA(lnAObs, chiMpc);
    out.lnAEmit = lnAE;
    out.visible = lnAE > -Infinity;
    if (!out.visible) {
        out.tEmitGyr = 0; out.z = Infinity; out.dA = 0; out.dL = Infinity; out.sbDim = 0;
        return out;
    }
    const aE = Math.exp(lnAE), aO = Math.exp(lnAObs);
    out.tEmitGyr = cosmicTimeAtLnA(lnAE);
    out.z = aO / aE - 1;
    out.dA = aE * chiMpc;
    out.dL = aO * aO * chiMpc / aE;
    const r = aE / aO;
    out.sbDim = r * r * r * r;
    return out;
}

// Small-distance limit check helper: proper distance now of a comoving chi.
export function properDistanceMpc(lnA, chiMpc) {
    return Math.exp(lnA) * chiMpc;
}

// --- GPU table ----------------------------------------------------------------
// The galaxy layer evaluates the light cone per vertex. It samples a 1-D
// table of (ln a_emit - ln a_obs) against comoving distance chi in
// [0, chiMaxMpc] for the CURRENT observer epoch (rebuilt when the epoch
// changes; cheap). The value is clamped to >= -40: (a_e/a_o)^4 < 1e-69 is
// black for any display. Beyond the particle horizon it is -40 too.
export function buildLightConeTable(lnAObs, chiMaxMpc, n = 512, out = new Float32Array(n)) {
    const etaO = conformalTimeAtLnA(lnAObs);
    for (let i = 0; i < n; i++) {
        const chi = chiMaxMpc * i / (n - 1);
        const lnA = lnAAtConformalTime(etaO - chi);
        const d = lnA - lnAObs;
        out[i] = Number.isFinite(d) ? Math.max(-40, Math.min(0, d)) : (d > 0 ? 0 : -40);
    }
    return { table: out, etaObs: etaO, lnAObs, chiMaxMpc };
}
