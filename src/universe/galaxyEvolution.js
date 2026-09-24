// Stellar-population evolution of whole galaxies over cosmic time.
//
// Every galaxy in the population (universe/galaxyPopulation.js) carries its
// PRESENT-DAY luminosity and colour. What an observer sees is the galaxy at
// the epoch its light left it (render/galaxyPopulationRender.js evaluates
// the past light cone), and in deep time galaxies change: star formation
// declines, the light of massive stars disappears, the population reddens
// and fades, and after ~10^13 yr the last red dwarfs die.
//
// Model (reduced-order, per morphological type):
//   star formation   delayed-tau history SFR(t) ~ (t - t_f) exp(-(t - t_f)/tau),
//                    formation at t_f = 1 Gyr, tau from 0.7 Gyr (ellipticals)
//                    to 20 Gyr (irregulars) -- the standard parameterisation
//                    of galaxy SEDs (e.g. Lee et al. 2010; Simha et al. 2014);
//   light per mass   a simple stellar population's V-band light fades as
//                    age^-0.8 from ~10 Myr to ~10 Gyr (Tinsley 1980; Bruzual
//                    & Charlot 2003 give M/L_V ~ t^0.8), continued to the
//                    death of the lowest-mass stars at ~10^13 yr (Laughlin,
//                    Bodenheimer & Adams 1997: 0.1 Msun lives ~6-12 Tyr);
//   colour           an SSP's B-V rises with log age (0.35 at 0.1 Gyr to ~1.0
//                    at 12 Gyr); the galaxy's colour is the luminosity-weighted
//                    mix, expressed as an OFFSET from today so present-day
//                    colours stay exactly the catalogue / morphology values;
//   degenerate era   the same logistic in log t at 1.2e14 yr as cosmicEra.js
//                    (Adams & Laughlin 1997), so every galaxy and the Milky
//                    Way reach darkness together.
// The table stores, per type and time: luminosity relative to today, the
// B-V offset, and the passive ("old population") factor the volumetric
// Milky Way applies to its old light (its young component already follows
// cosmicEra's star formation).
//
// Pure module, deterministic. Times in Gyr of cosmic time (since the Big Bang).

import { T0_GYR } from "./cosmicExpansion.js";

export const EVOLUTION_T = Object.freeze([-5, -2.5, 0, 2, 4, 6, 8, 10]);
const TAU_GYR = [0.7, 1.2, 2.0, 3.5, 5.5, 8.0, 12.0, 20.0];
export const T_FORM_GYR = 1.0;
export const EVOLUTION_LOG_T0 = Math.log10(0.5);    // table from 0.5 Gyr ...
export const EVOLUTION_LOG_T1 = Math.log10(1e6);    // ... to 10^15 yr
export const EVOLUTION_NT = 160;
const DEGENERATE_CENTER_LOG10_YR = Math.log10(1.2e14);
const DEGENERATE_WIDTH_LOG10 = 0.065;
const M_DWARF_DEATH_GYR = 1.2e4;

// V-band light per unit stellar mass formed, for a population of this age (Gyr).
export function sspLight(ageGyr) {
    const a = Math.max(ageGyr, 0.01);
    return Math.pow(a, -0.8) / (1 + Math.pow(a / M_DWARF_DEATH_GYR, 4));
}
// SSP B-V at this age (Gyr).
export function sspBV(ageGyr) {
    const a = Math.max(ageGyr, 0.005);
    return Math.max(-0.05, Math.min(1.05, 0.35 + 0.31 * Math.log10(a / 0.1)));
}
function sfr(tGyr, tau) {
    const x = tGyr - T_FORM_GYR;
    return x > 0 ? x / (tau * tau) * Math.exp(-x / tau) : 0;
}
export function degenerateFactor(tGyr) {
    const yr = tGyr * 1e9;
    if (!(yr > 0)) return 1;
    return 1 / (1 + Math.exp((Math.log10(yr) - DEGENERATE_CENTER_LOG10_YR) / DEGENERATE_WIDTH_LOG10));
}

// Integrated V light, B light (relative units) and passive light at cosmic time t.
// Two quadratures: over formation time (log-spaced after t_f, where the star
// formation history peaks) for stars older than ageCut, and over age
// (log-spaced from 1 Myr) for the young stars that dominate the light while
// star formation is on.
function accumulate(out, age, dM) {
    if (dM <= 0) return;
    const l = sspLight(age) * dM;
    out.L += l;
    out.B += l * Math.pow(10, -0.4 * (sspBV(age) - 0.65));
}
function integrate(tGyr, tau, out) {
    out.L = 0; out.B = 0;
    const span = tGyr - T_FORM_GYR;
    if (!(span > 0)) return out;
    const ageCut = Math.min(1, span * 0.5);
    const N = 360;
    // (a) formation times t' in [t_f, t - ageCut]: x = t' - t_f log-spaced
    const x1 = span - ageCut;
    if (x1 > 0) {
        const lx0 = Math.log(1e-4 * tau), lx1 = Math.log(x1);
        const d = (lx1 - lx0) / N;
        for (let k = 0; k < N; k++) {
            const x = Math.exp(lx0 + (k + 0.5) * d);
            accumulate(out, tGyr - (T_FORM_GYR + x), sfr(T_FORM_GYR + x, tau) * x * d);
        }
        // the sliver [t_f, t_f + 1e-4 tau] is negligible
    }
    // (b) ages in [1 Myr, ageCut]
    const la0 = Math.log(1e-3), la1 = Math.log(ageCut);
    if (la1 > la0) {
        const d = (la1 - la0) / N;
        for (let k = 0; k < N; k++) {
            const age = Math.exp(la0 + (k + 0.5) * d);
            accumulate(out, age, sfr(tGyr - age, tau) * age * d);
        }
    }
    return out;
}

let TABLE = null;
// Float32Array [NT * nTypes * 4]: (L/L_today, dBV, passive factor, 0), row-major by type.
export function evolutionTable() {
    if (TABLE) return TABLE;
    const nT = EVOLUTION_T.length, nt = EVOLUTION_NT;
    const data = new Float32Array(nt * nT * 4);
    const tmp = {}, now = {};
    for (let j = 0; j < nT; j++) {
        const tau = TAU_GYR[j];
        integrate(T0_GYR, tau, now);
        const bvNow = -2.5 * Math.log10(now.B / now.L) + 0.65;
        // passive: today's stars only (no new formation), for the old-light factor
        for (let i = 0; i < nt; i++) {
            const t = Math.pow(10, EVOLUTION_LOG_T0 + (EVOLUTION_LOG_T1 - EVOLUTION_LOG_T0) * i / (nt - 1));
            integrate(t, tau, tmp);
            const deg = degenerateFactor(t);
            const L = tmp.L > 0 ? tmp.L / now.L * deg : 0;
            const bv = tmp.L > 0 ? -2.5 * Math.log10(tmp.B / tmp.L) + 0.65 : bvNow;
            // passive fading of the population that exists today (age ~ t0 - t_f)
            const agedNow = Math.max(0.5, T0_GYR - T_FORM_GYR) * 0.7;     // light-weighted age of today's old light
            const passive = t >= T0_GYR ? sspLight(agedNow + (t - T0_GYR)) / sspLight(agedNow) * deg : 1;
            const o = (j * nt + i) * 4;
            data[o] = L; data[o + 1] = Math.max(-0.6, Math.min(0.6, bv - bvNow)); data[o + 2] = passive; data[o + 3] = 0;
        }
    }
    TABLE = data;
    return TABLE;
}

function typeRow(T) {
    let best = 0, bd = Infinity;
    for (let j = 0; j < EVOLUTION_T.length; j++) {
        const d = Math.abs(EVOLUTION_T[j] - T);
        if (d < bd) { bd = d; best = j; }
    }
    return best;
}
// CPU lookup: { L, dBV, passive } for morphological type T at cosmic time t (Gyr).
export function evolutionAt(T, tGyr, out = {}) {
    const tab = evolutionTable();
    const j = typeRow(T), nt = EVOLUTION_NT;
    const u = (Math.log10(Math.max(tGyr, 1e-3)) - EVOLUTION_LOG_T0) / (EVOLUTION_LOG_T1 - EVOLUTION_LOG_T0) * (nt - 1);
    if (u <= 0) {
        const o = j * nt * 4;
        out.L = tGyr < T_FORM_GYR ? 0 : tab[o]; out.dBV = tab[o + 1]; out.passive = tab[o + 2];
        return out;
    }
    const i = Math.min(nt - 2, Math.floor(u)), f = Math.min(1, u - i);
    const o0 = (j * nt + i) * 4, o1 = o0 + 4;
    out.L = tab[o0] + (tab[o1] - tab[o0]) * f;
    out.dBV = tab[o0 + 1] + (tab[o1 + 1] - tab[o0 + 1]) * f;
    out.passive = tab[o0 + 2] + (tab[o1 + 2] - tab[o0 + 2]) * f;
    return out;
}

// GLSL: sample the table texture (width EVOLUTION_NT, height = number of types).
export const GALAXY_EVOLUTION_GLSL = /* glsl */`
uniform sampler2D uEvolution;
const float EVO_NT = ${EVOLUTION_NT}.0;
const float EVO_NTYPE = ${EVOLUTION_T.length}.0;
const float EVO_LT0 = ${EVOLUTION_LOG_T0.toFixed(8)};
const float EVO_LT1 = ${EVOLUTION_LOG_T1.toFixed(8)};
float evoRow(float T) {
    // rows at T = -5, -2.5, 0, 2, 4, 6, 8, 10
    float r = T < -3.75 ? 0.0 : T < -1.25 ? 1.0 : T < 1.0 ? 2.0 : T < 3.0 ? 3.0 : T < 5.0 ? 4.0 : T < 7.0 ? 5.0 : T < 9.0 ? 6.0 : 7.0;
    return (r + 0.5) / EVO_NTYPE;
}
// (L / L_today, B-V offset) at cosmic time tGyr for type T.
vec2 galaxyEvolution(float T, float tGyr) {
    if (tGyr < ${T_FORM_GYR.toFixed(3)}) return vec2(0.0, 0.0);
    float u = clamp((log(max(tGyr, 1e-3)) / log(10.0) - EVO_LT0) / (EVO_LT1 - EVO_LT0), 0.0, 1.0) * (EVO_NT - 1.0);
    float i0 = floor(u);
    float f = u - i0;
    float y = evoRow(T);
    vec4 a = texture2D(uEvolution, vec2((i0 + 0.5) / EVO_NT, y));
    vec4 b = texture2D(uEvolution, vec2((min(i0 + 1.0, EVO_NT - 1.0) + 0.5) / EVO_NT, y));
    vec4 v = mix(a, b, f);
    return v.xy;
}
`;
