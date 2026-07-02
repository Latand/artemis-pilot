// Physical constants and configuration. km, km/s, km³/s² everywhere;
// the scene uses K to map km → scene units (1 unit = 1,000 km).
import { HYG_PHYSICAL_STARS } from "./generated/hygPhysicalStars.js";
import { SPECIAL_OBJECTS } from "./universe/specialObjects.js";

export const MU_E = 398600.4418, MU_M = 4902.8001, MU_S = 132712440018;
export const R_EARTH = 6371, R_MOON = 1737.4, R_SUN = 696340;
const DEG = Math.PI / 180;
// Curated physical destinations use true 3-D equatorial placement from
// distance, right ascension, and declination. The HYG catalog layer remains a
// separate visual point cloud, while this list carries physical destinations.
const skyStar = (name, dLy, raDeg, decDeg, color, mass, radiusSolar, extra = {}) => {
    const ra = raDeg * DEG, dec = decDeg * DEG;
    const dKm = dLy * 9460730472580.8;
    const cd = Math.cos(dec);
    return {
        name, dLy, raDeg, decDeg, color, mass, R: radiusSolar * R_SUN,
        x: cd * Math.cos(ra) * dKm,
        y: cd * Math.sin(ra) * dKm,
        z: Math.sin(dec) * dKm,
        catalog: "nearby-real",
        ...extra,
    };
};
const catalogStar = row => skyStar(
    row.name,
    row.dLy,
    row.raDeg,
    row.decDeg,
    row.color,
    row.mass,
    row.radiusSolar,
    {
        catalog: "hyg-v41-physical",
        hip: row.hip,
        hd: row.hd,
        hr: row.hr,
        spect: row.spect,
        lumSolar: row.lumSolar,
        tempK: row.tempK,
        absMag: row.absMag,
        mag: row.mag,
    },
);
export const A_MOON = 384400;        // lunar semi-major axis, km (27.32-day month)
export const E_MOON = 0.0549;        // lunar eccentricity
// OMEGA is the Moon's MEAN-MOTION BOOKKEEPING rate used to advance its mean
// anomaly from the J2000 epoch to "now" (ephemeris.js's resetEphem). It is
// deliberately NOT sqrt((MU_E+MU_M)/A_MOON^3): that naive two-body Kepler
// rate gives a 27.2872-day period, but the Moon's real (observed) sidereal
// month is 27.321661 days — 0.126% longer, because the Sun's perturbation
// raises the Moon's effective period beyond the unperturbed two-body value.
// That 0.126% is invisible over a few months but compounds secularly over
// decades (~354 lunar orbits from J2000 to 2026): it was throwing the sim's
// simulated lunar phase off by nearly half a synodic month by 2026, enough
// to miss real eclipses entirely (see smoke:physics3d's eclipse check). The
// orbit's SHAPE (a, e, i) and instantaneous dynamics still come from
// MU_E+MU_M via keplerInit3/vis-viva as before — only the epoch-phase
// bookkeeping rate is swapped for the empirically observed one.
export const OMEGA = 2 * Math.PI / (27.321661 * 86400);
export const AM3 = A_MOON * A_MOON * A_MOON;
// Moon's inclination to the ecliptic (radians, same convention as PL[].i).
export const I_MOON = 5.145 * DEG;
// The Moon's ascending node regresses (18.6-yr nodal precession), so unlike
// the planets it needs both an epoch value and a rate rather than one fixed
// Om. Om0 is the J2000.0 longitude of ascending node (Meeus); OM_MOON_RATE
// is its regression rate in radians/day (source value -0.0529538 deg/day),
// applied as Om(t) = OM_MOON0 + OM_MOON_RATE * daysSinceJ2000 by WP13 — or a
// fixed epoch Om if WP13 decides that's simpler; both constants are provided.
export const OM_MOON0 = 125.1228 * DEG;
export const OM_MOON_RATE = -0.0529538 * DEG;
export const K = .001;
export const AU_KM = 149597870.7;
export const LY_KM = 9460730472580.8;
export const PC_KM = LY_KM * 3.2615637771674;
export const MPC_KM = PC_KM * 1e6;
export const LY_SCENE = LY_KM * K;
export const CAM_DIST_MAX = LY_SCENE * 4000000;
export const COSMIC_ZOOMS = {
    SOLAR: 5.6e6,
    MILKY_WAY: LY_SCENE * 120000,
    LOCAL_GROUP: LY_SCENE * 3200000,
};
export const SUN_DIST = AU_KM * K;
export const SUN_RADIUS = R_SUN * K;
export const STAR_CATALOG_META = {
    builtIn: "nearby physical destinations from published nearby-star values",
    hygUrl: "/data/hyg-stars-v41.json",
    hygSource: "Astronexus HYG v4.1: Hipparcos, Yale Bright Star, and Gliese merge",
    gaiaDr3AstrometricSourceCount: 1467744818,
    gaiaDr3GMagSourceCount: 1806254432,
    gaiaFprTotalSourceCount: 1812236358,
    gaiaDr4PlannedRelease: "2026-12-02",
};
export const CATALOG_PROMOTION_MAX = 128;
export const STARS = [
    skyStar("PROXIMA", 4.2465, 217.4292, -62.6795, 0xff8f66, .1221, .1542),
    skyStar("ALPHA CEN A", 4.37, 219.9021, -60.8339, 0xffd99a, 1.10, 1.224),
    skyStar("BARNARD", 5.963, 269.4521, 4.6934, 0xff9f75, .144, .196),
    skyStar("WOLF 359", 7.86, 164.1200, 7.0140, 0xff6a58, .11, .16),
    skyStar("SIRIUS A", 8.60, 101.2872, -16.7161, 0xbfd8ff, 2.06, 1.71),
    skyStar("EPSILON ERIDANI", 10.47, 53.2327, -9.4583, 0xffd38b, .82, .735),
    skyStar("TAU CETI", 11.91, 26.0170, -15.9375, 0xffd89d, .78, .793),
    skyStar("VEGA", 25.04, 279.2347, 38.7837, 0xdce8ff, 2.14, 2.36),
    // Galactic-center supermassive black hole. Contact surface = photon sphere
    // (1.5 r_s); position uses its observed sky direction.
    skyStar("SGR A*", 26000, 266.4168, -29.0078, 0xd9c8ff, 4.154e6, 1.839e7 / R_SUN, { bh: true, rs: 1.226e7 }),
    skyStar("ALPHA CEN B", 4.37, 219.9021, -60.8339, 0xffbf85, .907, .863, { companion: "ALPHA CEN A" }),
    skyStar("LUHMAN 16", 6.50, 162.3100, -53.3180, 0xb86a4f, .065, .10),
    skyStar("WISE 0855-0714", 7.43, 133.7925, -7.2450, 0x7d5b51, .005, .10),
    skyStar("LALANDE 21185", 8.31, 165.8340, 35.9700, 0xffad7a, .46, .39),
    skyStar("ROSS 154", 9.69, 279.2350, -23.8370, 0xff805f, .17, .24),
    skyStar("ROSS 248", 10.30, 355.4790, 44.1770, 0xff8162, .12, .16),
    skyStar("LACAILLE 9352", 10.74, 346.4667, -35.8531, 0xffa36f, .49, .47),
    skyStar("ROSS 128", 11.01, 176.9370, .7990, 0xff7f5f, .17, .20),
    skyStar("PROCYON A", 11.46, 114.8255, 5.2250, 0xf4f1d1, 1.50, 2.03),
    skyStar("61 CYGNI A", 11.40, 316.7240, 38.7500, 0xffc18a, .70, .67),
    skyStar("61 CYGNI B", 11.40, 316.7240, 38.7500, 0xffb37a, .63, .60, { companion: "61 CYGNI A" }),
    skyStar("GROOMBRIDGE 34 A", 11.62, 4.5840, 43.7830, 0xffa476, .38, .38),
    skyStar("EPSILON INDI A", 11.87, 330.8410, -56.7860, 0xffd49a, .76, .71),
    skyStar("TEEGARDEN", 12.58, 43.2540, 16.8820, 0xff765d, .089, .107),
    skyStar("KAPTEYN", 12.83, 77.9190, -45.0180, 0xff9870, .28, .29),
    skyStar("VAN MAANEN", 14.07, 12.2880, 5.3880, 0xdce8ff, .68, .011),
    skyStar("ALTAIR", 16.73, 297.6958, 8.8683, 0xe6eeff, 1.79, 1.63),
    skyStar("FOMALHAUT", 25.13, 344.4128, -29.6222, 0xdde9ff, 1.92, 1.84),
    skyStar("ARCTURUS", 36.7, 213.9154, 19.1825, 0xffbd7a, 1.08, 25.4),
    skyStar("CAPELLA", 42.9, 79.1723, 45.9980, 0xffd692, 2.57, 11.9),
    skyStar("ALDEBARAN", 65.3, 68.9800, 16.5093, 0xffa06b, 1.16, 44.2),
    skyStar("REGULUS", 79.3, 152.0929, 11.9672, 0xdde9ff, 3.8, 3.1),
    skyStar("SPICA", 250, 201.2983, -11.1614, 0xbfd8ff, 10.25, 7.47),
    skyStar("POLARIS", 447, 37.9550, 89.2641, 0xffe0aa, 5.4, 37.5),
    skyStar("BETELGEUSE", 548, 88.7929, 7.4071, 0xff7c4a, 16.5, 764),
    skyStar("ANTARES", 550, 247.3519, -26.4320, 0xff6d4c, 12, 680),
    skyStar("RIGEL", 860, 78.6345, -8.2016, 0xbfd8ff, 21, 78.9),
    skyStar("DENEB", 2615, 310.3580, 45.2803, 0xeaf2ff, 19, 203),
    ...HYG_PHYSICAL_STARS.map(catalogStar),
    ...SPECIAL_OBJECTS,
];
function finalizeStar(s) {
    if (s.x === undefined || s.y === undefined) {
        const len = Math.hypot(s.xDir, s.yDir) || 1;
        s.x = s.xDir / len * s.dLy * LY_KM;
        s.y = s.yDir / len * s.dLy * LY_KM;
    }
    if (s.z === undefined) s.z = 0;
    s.mu = MU_S * s.mass;
    s.flowC = .001 * Math.sqrt(2 * s.mu / 1000);
    s.flowSink = (s.bh ? s.rs : s.R) * K;
    return s;
}
for (const s of STARS) finalizeStar(s);
export const INITIAL_STAR_COUNT = STARS.length;
export function addRuntimeStar(star) {
    if (STARS.length - INITIAL_STAR_COUNT >= CATALOG_PROMOTION_MAX) {
        throw new Error("runtime catalog star promotion cap reached");
    }
    finalizeStar(star);
    STARS.push(star);
    return STARS.length - 1;
}
// Initial Sun/Earth geometry. The runtime integrates a live Earth world-state
// plus Earth-local relative states for the ship, Moon, planets, and holes.
export const SUN_D3 = AU_KM * AU_KM * AU_KM;
export const SUN_TH0 = Math.atan2(-.08, -1);
export const OM_YEAR = Math.sqrt((MU_S + MU_E) / SUN_D3); // ~365.25 d period
// Earth's own heliocentric orbital elements (J2000 mean values)
export const E_EARTH = 0.0167;
export const VARPI_EARTH = 102.95 * DEG;
// Earth defines the ecliptic reference plane the whole sim uses for z=0, so
// its inclination and node are zero by construction (not measured values).
export const I_EARTH = 0;
export const OM_EARTH = 0;
// planets: true radii, true μ, eccentric coplanar heliocentric orbits from
// J2000 mean elements (e, varpi = longitude of perihelion); `phase` is the
// initial MEAN anomaly M0 (values kept as-is for scenario continuity).
// atmH/atmD0: exponential atmosphere scale height (km) and surface density
// relative to Earth sea level; atmTop is where drag becomes negligible.
// i/Om: J2000 inclination to the ecliptic and longitude of ascending node,
// stored in radians like varpi (source values in degrees, converted by DEG).
// Not yet consumed by keplerInit (2-D only) — WP13 wires these into a 3-D
// keplerInit3 without changing the values here.
export const PL = [
    { name: "MERCURY", tag: "ME", a: 57.909e6, e: 0.2056, varpi: 77.46 * DEG, i: 7.005 * DEG, Om: 48.331 * DEG, R: 2439.7, mu: 22031.9, color: 0x9c8e7e, phase: 4.2, rotD: 58.6462, tilt: 0.034, gas: false, tex: "2k_mercury.jpg" },
    { name: "VENUS", tag: "VE", a: 108.21e6, e: 0.0068, varpi: 131.53 * DEG, i: 3.395 * DEG, Om: 76.680 * DEG, R: 6051.8, mu: 324858.6, color: 0xe6c98e, phase: 1.1, rotD: -243.018, tilt: 177.4, gas: false, tex: "2k_venus_atmosphere.jpg", atmH: 15.9, atmTop: 380, atmD0: 53 },
    { name: "MARS", tag: "MA", a: 227.956e6, e: 0.0934, varpi: 336.04 * DEG, i: 1.850 * DEG, Om: 49.558 * DEG, R: 3389.5, mu: 42828.4, color: 0xc96b4a, phase: 5.4, rotD: 1.02595676, tilt: 25.2, gas: false, tex: "2k_mars.jpg", atmH: 11.1, atmTop: 200, atmD0: 0.016 },
    { name: "JUPITER", tag: "JU", a: 778.479e6, e: 0.0484, varpi: 14.75 * DEG, i: 1.303 * DEG, Om: 100.464 * DEG, R: 69911, mu: 126686531, color: 0xc9a47a, phase: 2.6, rotD: 0.41354, tilt: 3.1, gas: true, tex: "2k_jupiter.jpg", atmH: 27, atmTop: 520, atmD0: 0.13 },
    { name: "SATURN", tag: "SA", a: 1432.041e6, e: 0.0542, varpi: 92.43 * DEG, i: 2.489 * DEG, Om: 113.665 * DEG, R: 58232, mu: 37931206, color: 0xe0d0a4, phase: 0.4, rotD: 0.44401, tilt: 26.7, gas: true, ring: [74500, 140200], tex: "2k_saturn.jpg", atmH: 59.5, atmTop: 1100, atmD0: 0.155 },
    { name: "URANUS", tag: "UR", a: 2867.043e6, e: 0.0472, varpi: 170.96 * DEG, i: 0.773 * DEG, Om: 74.006 * DEG, R: 25362, mu: 5793951, color: 0x9fd6dd, phase: 3.5, rotD: -0.71833, tilt: 97.8, gas: true, tex: "2k_uranus.jpg", atmH: 27.7, atmTop: 540, atmD0: 0.34 },
    { name: "NEPTUNE", tag: "NE", a: 4514.953e6, e: 0.0086, varpi: 44.97 * DEG, i: 1.770 * DEG, Om: 131.784 * DEG, R: 24622, mu: 6835100, color: 0x5d7fe8, phase: 5.9, rotD: 0.67125, tilt: 28.3, gas: true, tex: "2k_neptune.jpg", atmH: 19.7, atmTop: 390, atmD0: 0.37 },
];
for (const p of PL) {
    p.n = Math.sqrt(MU_S / (p.a * p.a * p.a));
    p.soi = p.a * Math.pow(p.mu / MU_S, .4);
    p.spin = Math.PI * 2 / (p.rotD * 86400);
    p.visualTilt = (p.tilt > 90 ? 180 - p.tilt : p.tilt) * DEG;
}
export const SOI_M = 66100;          // lunar dominance radius, km
export const SOI_E = 924000;         // Earth's heliocentric SOI, km
export const C_LIGHT = 299792.458;   // km/s
export const G_ACCEL_KMS2 = 9.80665e-3;
export const J2_E = 1.08262668e-3;   // Earth oblateness (equatorial-plane radial term)
export const OMEGA_EARTH = 7.2921159e-5; // rad/s sidereal surface rotation
export const DRAG_CD = 0.55, DRAG_H = 8.5, ATM_TOP = 160;
// Cosmological-constant acceleration in physical coordinates:
// a_Lambda = Omega_Lambda * H0^2 * r.
export const DARK_ENERGY = {
    H0_KM_S_MPC: 67.66,
    OMEGA_LAMBDA: 0.6889,
};
DARK_ENERGY.H0_PHYS = DARK_ENERGY.H0_KM_S_MPC / MPC_KM;
DARK_ENERGY.H_PHYS = Math.sqrt(DARK_ENERGY.OMEGA_LAMBDA) * DARK_ENERGY.H0_PHYS;
DARK_ENERGY.H2_PHYS = DARK_ENERGY.OMEGA_LAMBDA * DARK_ENERGY.H0_PHYS * DARK_ENERGY.H0_PHYS;
DARK_ENERGY.SUN_BALANCE_KM = Math.cbrt(MU_S / DARK_ENERGY.H2_PHYS);
DARK_ENERGY.VISIBLE_START_KM = DARK_ENERGY.SUN_BALANCE_KM * 0.35;
DARK_ENERGY.VISIBLE_FULL_KM = DARK_ENERGY.SUN_BALANCE_KM;
export const DARK_MATTER = {
    HALO_MASS_SOLAR: 1.0e12,
    VIRIAL_RADIUS_KPC: 211,
    CONCENTRATION: 12,
    SOFTENING_PC: 0.01,
    VISIBLE_START_PC: 100,
    VISIBLE_FULL_PC: 1000,
    ARROW_SECONDS: 1000000 * 31557600,
};
DARK_MATTER.VIRIAL_RADIUS_PC = DARK_MATTER.VIRIAL_RADIUS_KPC * 1000;
DARK_MATTER.SCALE_RADIUS_PC = DARK_MATTER.VIRIAL_RADIUS_PC / DARK_MATTER.CONCENTRATION;
DARK_MATTER.NFW_NORM = Math.log(1 + DARK_MATTER.CONCENTRATION) - DARK_MATTER.CONCENTRATION / (1 + DARK_MATTER.CONCENTRATION);
// the ephemeris advances in chunks of at most this many seconds while the
// ship integrates between flushes on linearly extrapolated body positions
export const EPH_CHUNK = 120;
export const MAIN_A = 0.006;         // km/s² at 100 % throttle
export const RCS_A = 0.0018;
export const BOOST = 4;
export const ROT_RATE = 2.0;         // rad/s of ship rotation, real-time
export const FUEL_DV0 = 9000;        // m/s of Δv in the tank (challenge mode only)
export const SEC_YEAR = 31557600;
// Slow-motion presets below real time, for watching fast events (e.g. a
// tidal disruption) frame by frame. Prepended to WARPS so digit-key presets
// keep their existing speeds — offset their WARPS index by WARP_SUBS.length.
export const WARP_SUBS = [0.01, 0.1, 0.5];
export const WARPS = [...WARP_SUBS, 1, 60, 600, 3600, 21600, 86400, 604800, 2592000, SEC_YEAR, 30 * SEC_YEAR, 1000 * SEC_YEAR, 1000000 * SEC_YEAR, 1000000000 * SEC_YEAR];
export const WARP_MAX = 1000000000 * SEC_YEAR;
export const WARP_MIN = -WARP_MAX;
export const WARP_DIGIT_OFFSET = WARP_SUBS.length;
export const warpStepDown = w => {
    if (w > 1) return Math.max(1, w / 2);
    if (w > 0.5) return 0.5;
    if (w > 0.1) return 0.1;
    if (w > 0.01) return 0.01;
    if (w >= 0) return -0.01;
    if (w >= -0.01) return -0.1;
    if (w >= -0.1) return -0.5;
    if (w > -1) return -1;
    return Math.max(WARP_MIN, w * 2);
};
export const warpStepUp = w => {
    if (w < -1) return w / 2;
    if (w < -0.5) return -0.5;
    if (w < -0.1) return -0.1;
    if (w < -0.01) return -0.01;
    if (w < 0) return 0.01;
    if (w < 0.1) return 0.1;
    if (w < 0.5) return 0.5;
    if (w < 1) return 1;
    return Math.min(WARP_MAX, w * 2);
};
export const MAX_STEPS_FRAME = 2400;
export const MOON_ANG0 = 2.2; // Moon's J2000 initial mean anomaly (varpi = 0)
export const warpLabel = w => {
    if (w < 0) {
        const mag = Math.abs(w);
        const label = warpLabel(mag);
        return mag < 1 ? "⏪ −" + label + " (reverse)" : "⏪ −" + label;
    }
    const f = x => +(Math.round(x * 10) / 10);
    if (w >= SEC_YEAR) {
        const yr = w / SEC_YEAR;
        if (yr >= 1e9) return f(yr / 1e9) + " Byr/s";
        if (yr >= 1e6) return f(yr / 1e6) + " Myr/s";
        if (yr >= 1000) return f(yr / 1000) + " kyr/s";
        return f(yr) + " yr/s";
    }
    if (w >= 86400) return f(w / 86400) + " d/s";
    if (w >= 3600) return f(w / 3600) + " h/s";
    if (w >= 60) return f(w / 60) + " min/s";
    if (w === 1) return "real time";
    if (w > 0 && w < 1) return +w.toFixed(2) + "×"; // slow-mo: 0.01×/0.1×/0.5× (trailing zeros stripped by the Number cast)
    return f(w) + "×";
};
// black holes: realistic point masses, μ = r_s·c²/2
export const BH_MAX = 6;
export const BH_SIZES = [
    0.001, 0.01, 0.1,
    1, 10, 100, 1000, 10000, 50000,
    100000, 500000, 1000000, 5000000,
]; // Schwarzschild radii, km
// river-model flow coefficients (scene units): v(r) = C/√r
export const FLOW = {
    CE: 0.001 * Math.sqrt(2 * MU_E / 1000),
    CM: 0.001 * Math.sqrt(2 * MU_M / 1000),
    CS: 0.001 * Math.sqrt(2 * MU_S / 1000),
};
