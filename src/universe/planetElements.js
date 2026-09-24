// J2000 mean orbital elements for the major planets and the Earth-Moon
// barycentre, with their linear rates, from JPL's "Keplerian Elements for
// Approximate Positions of the Major Planets" (E. M. Standish, Table 1,
// valid 1800-2050 AD; https://ssd.jpl.nasa.gov/planets/approx_pos.html).
//
// Frame: the mean ecliptic and equinox of J2000 -- the simulator's world
// frame (see coords.js). Angles are stored in degrees exactly as tabulated
// and rates are per Julian century of TDB; the ~64 s TT-UTC offset is
// ignored, as everywhere else in the epoch code.
//
// Accuracy (Standish): a few arcseconds to ~10' in heliocentric longitude
// over 1800-2050 depending on the planet (worst: Saturn ~10'). Outside that
// window the linear rates still give a continuous, sane orbit but not an
// ephemeris-quality one; the n-body integrator takes over from the seed
// anyway.
//
// Pure: no imports, no DOM. Shared by ephemeris.js (initial conditions) and
// eventTimeline.js (analytic close-approach predictions) so both always seed
// the same phases.

const DEG = Math.PI / 180;
export const SEC_PER_JULIAN_CENTURY = 36525 * 86400;

// [a (au), e, I (deg), L (deg), varpi (deg), Omega (deg)] and per-century rates.
export const STANDISH_TABLE1 = Object.freeze({
    MERCURY: { el: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
        rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
    VENUS: { el: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
        rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418] },
    EMB: { el: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
        rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0] },
    MARS: { el: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
        rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
    JUPITER: { el: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
        rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
    SATURN: { el: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
        rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
    URANUS: { el: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
        rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589] },
    NEPTUNE: { el: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
        rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664] },
});

function wrapPi(x) {
    const t = x - 2 * Math.PI * Math.floor((x + Math.PI) / (2 * Math.PI));
    return t;
}

// Mean elements at `secondsSinceJ2000` for a Table 1 body ("MERCURY" ...
// "NEPTUNE", or "EMB"). Returns semimajor axis in km (auKm supplied by the
// caller so this module keeps no unit constants of its own), eccentricity,
// inclination / node / longitude of perihelion in radians, the mean anomaly
// M = L - varpi in radians wrapped to (-pi, pi], and the tabulated mean
// motion dL/dt in rad/s (the observed rate, which already includes planetary
// perturbations -- it differs slightly from sqrt(GM/a^3)).
export function meanElementsAt(key, secondsSinceJ2000, auKm, out = {}) {
    const row = STANDISH_TABLE1[key];
    if (!row) throw new Error("planetElements: unknown body " + key);
    const T = (Number.isFinite(secondsSinceJ2000) ? secondsSinceJ2000 : 0) / SEC_PER_JULIAN_CENTURY;
    const e0 = row.el, r = row.rate;
    const L = (e0[3] + r[3] * T) * DEG;
    const varpi = (e0[4] + r[4] * T) * DEG;
    out.a = (e0[0] + r[0] * T) * auKm;
    out.e = Math.min(0.99, Math.max(0, e0[1] + r[1] * T));
    out.i = (e0[2] + r[2] * T) * DEG;
    out.Om = (e0[5] + r[5] * T) * DEG;
    out.varpi = varpi;
    out.M = wrapPi(L - varpi);
    out.L = wrapPi(L);
    out.n = r[3] * DEG / SEC_PER_JULIAN_CENTURY;
    return out;
}

// Heliocentric ecliptic-J2000 position (km) from mean elements -- the same
// conic every consumer uses for its seed. Exported for smokes that compare
// the live simulator against the reference.
export function heliocentricPositionAt(key, secondsSinceJ2000, auKm, out = {}) {
    const el = meanElementsAt(key, secondsSinceJ2000, auKm, _el);
    let E = el.M;
    for (let k = 0; k < 12; k++) E -= (E - el.e * Math.sin(E) - el.M) / (1 - el.e * Math.cos(E));
    const xp = el.a * (Math.cos(E) - el.e);
    const yp = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
    const w = el.varpi - el.Om;
    const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(el.Om), sO = Math.sin(el.Om);
    const ci = Math.cos(el.i), si = Math.sin(el.i);
    out.x = (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp;
    out.y = (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp;
    out.z = (sw * si) * xp + (cw * si) * yp;
    out.r = el.a * (1 - el.e * Math.cos(E));
    out.a = el.a;
    return out;
}
const _el = {};

// Table 1 key for a PL[] entry name.
export function tableKeyForPlanet(name) {
    const key = String(name || "").toUpperCase();
    return STANDISH_TABLE1[key] ? key : null;
}
