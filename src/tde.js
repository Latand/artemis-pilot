// Tidal-disruption model in code units: mu=GM km^3/s^2, radii km.
// Hills 1975; Rees 1988: tidal radius r_t = R_star q^(1/3).
export const TDE_ETA = 0.1;
export const L_EDD_PER_MSUN = 1.26e31;

const C_M = 299792458;
const C_KM = 299792.458;
const G_KM = 6.674e-20;          // km^3 kg^-1 s^-2
const MU_SUN = 132712440018;     // km^3/s^2
const BOUND_FRACTION = 0.5;

// Below this hole/body mass ratio the object is not a "tidal disrupter": the
// tidal radius R q^(1/3) sits within ~2 body radii, so a pericentre inside it
// is a stellar-collision / plunge problem, not a TDE. Micro-TDE studies of
// stars by stellar-mass holes start around q ~ 10 (Perets et al. 2016;
// Kremer et al. 2022).
export const Q_MIN_TDE = 10;
// r_p > 6 r_t: the equilibrium tide (R/r)^3 (M/m) < 5e-3 — nothing to model.
export const WATCH_FACTOR = 6;
export const BETA_DISTORT_MIN = 1 / WATCH_FACTOR;
// Neutron stars have a surface, not a horizon.
export const NS_SURFACE_KM = 12;

export function tidalRadiusKm(rKm, muBH, muBody) {
    return rKm * Math.cbrt(muBH / muBody);
}

// Rees 1988; Lacy, Townes & Hollenbach 1982: frozen-in energy spread.
// Stone, Sari & Loeb 2013 / Guillochon & Ramirez-Ruiz 2013: it is frozen in at
// r_t, so the spread does not grow as beta^2.
export function mostBoundEnergy(rKm, muBH, muBody) {
    const rt = tidalRadiusKm(rKm, muBH, muBody);
    return muBH * rKm / Math.max(1e-30, rt * rt);
}

// Rees 1988; Evans & Kochanek 1989; Stone, Sari & Loeb 2013.
export function fallbackTimeSec(rKm, muBH, muBody) {
    const eMb = mostBoundEnergy(rKm, muBH, muBody);
    return 2 * Math.PI * muBH / Math.pow(2 * eMb, 1.5);
}

// Ulmer 1999; Bonnerot et al. 2016: bound stream circularizes near 2 r_t
// (2 r_p for a deeper encounter: the returning stream shocks at pericentre).
export function circularizationKm(rKm, muBH, muBody) {
    return 2 * tidalRadiusKm(rKm, muBH, muBody);
}

// Schwarzschild ISCO: 6GM/c^2 = 3 r_s.
export function iscoKm(rsKm) {
    return 3 * rsKm;
}

// Rees 1988; Phinney 1989: nothing returns before the most-bound debris
// (t < t_fb); from t_fb the flat-dM/deps stream returns at
// Mdot = M*/(3 t_fb) (t/t_fb)^-5/3, whose integral is exactly the bound half
// M*/2 (see accretedMass). mStarKg is the disrupted mass (Delta M for a
// partial disruption).
export function fallbackRate(tSec, tFbSec, mStarKg) {
    if (!isFinite(tSec) || !isFinite(tFbSec) || tFbSec <= 0 || mStarKg <= 0) return 0;
    if (tSec < tFbSec) return 0;
    return mStarKg / (3 * tFbSec) * Math.pow(tSec / tFbSec, -5 / 3);
}

// Fraction of the bound debris that has fallen back by t:
// M_acc(t) = (M*/2) [1 - (t/t_fb)^(-2/3)] — the integral of fallbackRate.
export function accretedFraction(tSec, tFbSec) {
    if (!(tFbSec > 0) || !(tSec > tFbSec)) return 0;
    return 1 - Math.pow(tSec / tFbSec, -2 / 3);
}
export function accretedMass(tSec, tFbSec, boundMass) {
    return boundMass * accretedFraction(tSec, tFbSec);
}

export function tdeLuminosityW(tSec, tFbSec, mStarKg, mBhMsun) {
    const l = TDE_ETA * fallbackRate(tSec, tFbSec, mStarKg) * C_M * C_M;
    const lEdd = L_EDD_PER_MSUN * mBhMsun;
    return Math.min(l, lEdd);
}

export function boundFraction() {
    return BOUND_FRACTION;
}

// ---- encounter regimes -----------------------------------------------------
// Polytropic response: gamma = 5/3 (n = 1.5: rocky and giant planets,
// fully convective low-mass stars), gamma = 4/3 (n = 3: Sun-like stars).
// By mass: Sun-like stars (>= 0.5 Msun) are radiative-core n = 3 polytropes;
// everything lighter here (fully convective dwarfs, giant and rocky planets)
// is taken as n = 1.5.
export function gammaForBody(muBody, _kind = "") {
    return muBody / MU_SUN >= 0.5 ? 4 / 3 : 5 / 3;
}
// Guillochon & Ramirez-Ruiz 2013 (ApJ 767, 25), Appendix A fits of the
// stripped mass fraction; beta_d = full-disruption threshold.
export function partialBetaThreshold(gamma) { return gamma > 1.5 ? 0.5 : 0.6; }
export function fullBetaThreshold(gamma) { return gamma > 1.5 ? 0.9 : 1.85; }
function grrFit(b, a0, a1, a2, b1, b2) {
    return Math.exp((a0 + a1 * b + a2 * b * b) / (1 + b1 * b + b2 * b * b));
}
export function massLossFraction(beta, gamma = 4 / 3) {
    if (!(beta >= partialBetaThreshold(gamma))) return 0;
    if (beta >= fullBetaThreshold(gamma)) return 1;
    const f = gamma > 1.5
        ? grrFit(beta, 3.1647, -6.3777, 3.1797, -3.4137, 2.4616)
        : grrFit(beta, 12.996, -31.149, 12.865, -5.3232, 6.4262);
    return Math.min(1, Math.max(0, f));
}

// Where infalling matter is lost: the marginally bound radius 2 r_s
// (4GM/c^2, the pericentre of the critical L = 4GM/c parabola) for a hole, the
// ~12 km surface for a neutron star.
export function captureRadiusKm(rsKm, kind = 0) {
    return kind === 2 ? Math.max(NS_SURFACE_KM, 2 * rsKm) : 2 * rsKm;
}

// Pericentre in the Paczyński–Wiita potential Phi = -mu/(r - r_s) for
// specific energy E (same potential) and specific angular momentum L.
// captured = no centrifugal barrier stops the infall: the effective potential
// L^2/2r^2 + Phi has its maximum at the unstable circular orbit r_u in
// (r_s, 3 r_s), and E >= V(r_u) (or L below the ISCO value, no barrier at
// all). For E = 0 this is exactly L <= 4GM/c, the Schwarzschild criterion.
const _pw = { rp: 0, captured: false, rBarrier: 0 };
export function pwPericentre(E, L, mu, rs, rStart, out = _pw) {
    out.captured = false; out.rp = rStart; out.rBarrier = 0;
    const L2 = L * L;
    const f = r => 2 * (E + mu / (r - rs)) - L2 / (r * r); // = v_r^2
    if (!(rs > 0)) {
        // Newtonian limit: rp from E, L directly
        if (!(L2 > 0)) { out.rp = 0; out.captured = true; return out; }
        const e = Math.sqrt(Math.max(0, 1 + 2 * E * L2 / (mu * mu)));
        out.rp = L2 / (mu * (1 + e));
        return out;
    }
    const rHi = Math.max(rStart, 3 * rs * (1 + 1e-9));
    // no barrier below the ISCO angular momentum sqrt(27/4 mu rs)
    if (!(L2 > 6.75 * mu * rs)) { out.rp = rs; out.captured = true; return out; }
    // unstable circular orbit: L^2 (r - rs)^2 = mu r^3 on (rs, 3 rs)
    let lo = rs * (1 + 1e-12), hi = 3 * rs;
    for (let k = 0; k < 200; k++) {
        const m = .5 * (lo + hi);
        if (L2 * (m - rs) * (m - rs) - mu * m * m * m < 0) lo = m; else hi = m;
        if (hi - lo <= rs * 1e-14) break;
    }
    const ru = .5 * (lo + hi);
    out.rBarrier = ru;
    if (f(ru) >= 0) { out.rp = rs; out.captured = true; return out; }
    // pericentre: the root of v_r^2 between the barrier and the start radius
    lo = ru; hi = rHi;
    if (f(hi) < 0) { out.rp = hi; return out; } // start state sits at its own turning point
    for (let k = 0; k < 200; k++) {
        const m = .5 * (lo + hi);
        if (f(m) < 0) lo = m; else hi = m;
        if (hi - lo <= Math.max(1e-12, hi * 1e-14)) break;
    }
    out.rp = hi;
    return out;
}

// Pure regime classifier. Masses are gravitational parameters (mu = GM,
// km^3/s^2): mBh (hole), mStar (body); rStar and rp in km; rs is the hole's
// Schwarzschild radius (km); kind 0 hole, 1 quasar, 2 neutron star.
// rp is the Newtonian osculating pericentre of the body about the hole. When
// the relative specific energy E and angular momentum L are known (live
// encounters), the relativistic capture test and pericentre use them;
// otherwise the orbit is taken as parabolic with that rp.
export function classifyTidalEncounter(o) {
    const muBh = o.mBh ?? o.muBh, muStar = o.mStar ?? o.muStar;
    const R = o.rStar, rs = o.rs ?? 2 * muBh / (C_KM * C_KM), kind = o.kind ?? 0;
    const gamma = o.gamma ?? gammaForBody(muStar, o.bodyKind || "");
    const mu = muBh + muStar;
    const q = muBh / muStar;
    const rt = tidalRadiusKm(R, muBh, muStar);
    const rCap = captureRadiusKm(rs, kind);
    let E = o.E, L = o.L;
    const rpN = Math.max(0, o.rp);
    if (!Number.isFinite(L)) {
        E = Number.isFinite(E) ? E : 0;
        L = Math.sqrt(Math.max(0, 2 * rpN * rpN * (E + mu / Math.max(1e-30, rpN))));
    }
    if (!Number.isFinite(E)) E = 0;
    const rStart = Math.max(o.rNow ?? 0, rpN * 1.0001, 10 * rpN, 4 * rs);
    const pw = pwPericentre(E, L, mu, rs, rStart, {});
    const rpRel = pw.captured ? 0 : pw.rp;
    const beta = rt / Math.max(1e-30, pw.captured ? rpN : rpRel);
    const betaP = partialBetaThreshold(gamma), betaD = fullBetaThreshold(gamma);
    const hills = rt <= rCap;
    const res = {
        regime: "none", reason: "", q, gamma, beta, rt, rp: rpN, rpRel, rCapture: rCap, hills,
        betaPartial: betaP, betaFull: betaD, E, L,
        massLossFrac: 0, boundMass: 0, unboundMass: 0, coreMass: muStar, swallowedMass: 0,
        tFbSec: 0, mdotPeakKgS: 0, deltaEps: 0, rCirc: 0, strainAtPeri: 0,
    };
    const ns = kind === 2;
    if (q < Q_MIN_TDE) {
        res.reason = "mass ratio " + q.toPrecision(3) + " < " + Q_MIN_TDE + ": no tidal disruption (scattering only)";
        return res;
    }
    if (pw.captured || rpRel <= rCap) {
        res.regime = "captured";
        res.reason = ns ? "impacts the neutron-star surface"
            : hills ? "swallowed whole — tidal radius inside the horizon"
                : "swallowed whole — plunging orbit inside the capture radius (L < 4GM/c)";
        res.massLossFrac = 1;
        res.coreMass = 0;
        res.swallowedMass = muStar;
        return res;
    }
    res.strainAtPeri = beta * beta * beta;
    if (beta < BETA_DISTORT_MIN) {
        res.reason = "r_p = " + (1 / beta).toFixed(1) + " r_t: tide negligible";
        return res;
    }
    const tFb = fallbackTimeSec(R, muBh, muStar);
    res.tFbSec = tFb;
    res.deltaEps = mostBoundEnergy(R, muBh, muStar);
    res.rCirc = 2 * rpRel;
    if (beta < betaP) {
        res.regime = "distort";
        res.reason = "tidal flyby: beta " + beta.toFixed(2) + " < " + betaP + " (elongation only)";
        return res;
    }
    const f = massLossFraction(beta, gamma);
    res.massLossFrac = f;
    res.boundMass = BOUND_FRACTION * f * muStar;
    res.unboundMass = (1 - BOUND_FRACTION) * f * muStar;
    res.coreMass = (1 - f) * muStar;
    res.mdotPeakKgS = f * muStar / G_KM / (3 * tFb);
    if (beta < betaD) {
        res.regime = "partial";
        res.reason = "partial disruption: beta " + beta.toFixed(2) + " < beta_d " + betaD + ", " + (100 * f).toFixed(1) + "% stripped, core survives";
    } else {
        res.regime = "full";
        res.reason = "full disruption: beta " + beta.toFixed(2) + " >= beta_d " + betaD;
    }
    return res;
}

export const TDE_CONST = { C_KM, G_KM, MU_SUN };
