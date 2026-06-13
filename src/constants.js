// Physical constants and configuration. km, km/s, km³/s² everywhere;
// the scene uses K to map km → scene units (1 unit = 1,000 km).
export const MU_E = 398600.4418, MU_M = 4902.8001, MU_S = 132712440018;
export const R_EARTH = 6371, R_MOON = 1737.4, R_SUN = 696340;
const DEG = Math.PI / 180;
export const A_MOON = 384400;        // lunar semi-major axis, km (27.32-day month)
export const E_MOON = 0.0549;        // lunar eccentricity
export const OMEGA = Math.sqrt((MU_E + MU_M) / (A_MOON * A_MOON * A_MOON));
export const AM3 = A_MOON * A_MOON * A_MOON;
export const K = .001;
export const AU_KM = 149597870.7;
export const LY_KM = 9460730472580.8;
export const LY_SCENE = LY_KM * K;
export const CAM_DIST_MAX = LY_SCENE * 4000000;
export const COSMIC_ZOOMS = {
    SOLAR: 5.6e6,
    MILKY_WAY: LY_SCENE * 120000,
    LOCAL_GROUP: LY_SCENE * 3200000,
};
export const SUN_DIST = AU_KM * K;
export const SUN_RADIUS = R_SUN * K;
export const STARS = [
    { name: "PROXIMA", dLy: 4.246, xDir: -0.8, yDir: 0.22, color: 0xff8f66, mass: .122, R: 107280 },
    { name: "ALPHA CEN", dLy: 4.37, xDir: -0.78, yDir: 0.24, color: 0xffd99a, mass: 1.1, R: 854000 },
    { name: "BARNARD", dLy: 5.96, xDir: 0.35, yDir: -0.9, color: 0xff9f75, mass: .144, R: 136000 },
    { name: "WOLF 359", dLy: 7.86, xDir: 0.82, yDir: .12, color: 0xff6a58, mass: .11, R: 111000 },
    { name: "SIRIUS", dLy: 8.61, xDir: -0.22, yDir: -0.72, color: 0xbfd8ff, mass: 2.06, R: 1189000 },
    { name: "EPSILON ERIDANI", dLy: 10.5, xDir: .64, yDir: .42, color: 0xffd38b, mass: .82, R: 512000 },
    { name: "TAU CETI", dLy: 11.9, xDir: -.52, yDir: .68, color: 0xffd89d, mass: .78, R: 552000 },
    { name: "VEGA", dLy: 25.0, xDir: .18, yDir: -.36, color: 0xdce8ff, mass: 2.14, R: 1670000 },
    // the galactic-center supermassive black hole: contact surface = photon
    // sphere (1.5 r_s); placed to coincide with the Milky Way disk center in
    // cosmic.js (GALAXY.centerX = -26,000 ly, centerZ = 0)
    { name: "SGR A*", dLy: 26000, xDir: -1, yDir: 0, color: 0xd9c8ff, mass: 4.154e6, R: 1.839e7, bh: true, rs: 1.226e7 },
];
for (const s of STARS) {
    const len = Math.hypot(s.xDir, s.yDir) || 1;
    s.x = s.xDir / len * s.dLy * LY_KM;
    s.y = s.yDir / len * s.dLy * LY_KM;
    s.mu = MU_S * s.mass;
}
// Initial Sun/Earth geometry. The runtime integrates a live Earth world-state
// plus Earth-local relative states for the ship, Moon, planets, and holes.
export const SUN_D3 = AU_KM * AU_KM * AU_KM;
export const SUN_TH0 = Math.atan2(-.08, -1);
export const OM_YEAR = Math.sqrt((MU_S + MU_E) / SUN_D3); // ~365.25 d period
// Earth's own heliocentric orbital elements (J2000 mean values)
export const E_EARTH = 0.0167;
export const VARPI_EARTH = 102.95 * DEG;
// planets: true radii, true μ, eccentric coplanar heliocentric orbits from
// J2000 mean elements (e, varpi = longitude of perihelion); `phase` is the
// initial MEAN anomaly M0 (values kept as-is for scenario continuity).
// atmH/atmD0: exponential atmosphere scale height (km) and surface density
// relative to Earth sea level; atmTop is where drag becomes negligible.
export const PL = [
    { name: "MERCURY", tag: "ME", a: 57.909e6, e: 0.2056, varpi: 77.46 * DEG, R: 2439.7, mu: 22031.9, color: 0x9c8e7e, phase: 4.2, rotD: 58.6462, tilt: 0.034, gas: false, tex: "2k_mercury.jpg" },
    { name: "VENUS", tag: "VE", a: 108.21e6, e: 0.0068, varpi: 131.53 * DEG, R: 6051.8, mu: 324858.6, color: 0xe6c98e, phase: 1.1, rotD: -243.018, tilt: 177.4, gas: false, tex: "2k_venus_atmosphere.jpg", atmH: 15.9, atmTop: 380, atmD0: 53 },
    { name: "MARS", tag: "MA", a: 227.956e6, e: 0.0934, varpi: 336.04 * DEG, R: 3389.5, mu: 42828.4, color: 0xc96b4a, phase: 5.4, rotD: 1.02595676, tilt: 25.2, gas: false, tex: "2k_mars.jpg", atmH: 11.1, atmTop: 200, atmD0: 0.016 },
    { name: "JUPITER", tag: "JU", a: 778.479e6, e: 0.0484, varpi: 14.75 * DEG, R: 69911, mu: 126686531, color: 0xc9a47a, phase: 2.6, rotD: 0.41354, tilt: 3.1, gas: true, tex: "2k_jupiter.jpg", atmH: 27, atmTop: 520, atmD0: 0.13 },
    { name: "SATURN", tag: "SA", a: 1432.041e6, e: 0.0542, varpi: 92.43 * DEG, R: 58232, mu: 37931206, color: 0xe0d0a4, phase: 0.4, rotD: 0.44401, tilt: 26.7, gas: true, ring: [74500, 140200], tex: "2k_saturn.jpg", atmH: 59.5, atmTop: 1100, atmD0: 0.155 },
    { name: "URANUS", tag: "UR", a: 2867.043e6, e: 0.0472, varpi: 170.96 * DEG, R: 25362, mu: 5793951, color: 0x9fd6dd, phase: 3.5, rotD: -0.71833, tilt: 97.8, gas: true, tex: "2k_uranus.jpg", atmH: 27.7, atmTop: 540, atmD0: 0.34 },
    { name: "NEPTUNE", tag: "NE", a: 4514.953e6, e: 0.0086, varpi: 44.97 * DEG, R: 24622, mu: 6835100, color: 0x5d7fe8, phase: 5.9, rotD: 0.67125, tilt: 28.3, gas: true, tex: "2k_neptune.jpg", atmH: 19.7, atmTop: 390, atmD0: 0.37 },
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
export const J2_E = 1.08262668e-3;   // Earth oblateness (equatorial-plane radial term)
export const OMEGA_EARTH = 7.2921159e-5; // rad/s sidereal surface rotation
export const DRAG_CD = 0.55, DRAG_H = 8.5, ATM_TOP = 160;
// Cosmological-constant style expansion: a = H²r. H_PHYS is the observed
// order of magnitude; H_SIM is boosted so the sandbox shows an effect before
// multi-million-year warps.
export const DARK_ENERGY = {
    H_PHYS: 2.2e-18,
    H_SIM: 3.0e-10,
};
DARK_ENERGY.H2_SIM = DARK_ENERGY.H_SIM * DARK_ENERGY.H_SIM;
DARK_ENERGY.H2_PHYS = DARK_ENERGY.H_PHYS * DARK_ENERGY.H_PHYS;
export function darkEnergyAccel(x, y, out, h2 = DARK_ENERGY.H2_SIM) {
    out[0] = h2 * x;
    out[1] = h2 * y;
    return out;
}
// the ephemeris advances in chunks of at most this many seconds while the
// ship integrates between flushes on linearly extrapolated body positions
export const EPH_CHUNK = 120;
export const MAIN_A = 0.006;         // km/s² at 100 % throttle
export const RCS_A = 0.0018;
export const BOOST = 4;
export const ROT_RATE = 2.0;         // rad/s of ship rotation, real-time
export const FUEL_DV0 = 9000;        // m/s of Δv in the tank (challenge mode only)
export const SEC_YEAR = 31557600;
export const WARPS = [1, 60, 600, 3600, 21600, 86400, 604800, 2592000, SEC_YEAR, 30 * SEC_YEAR, 1000 * SEC_YEAR, 1000000 * SEC_YEAR, 1000000000 * SEC_YEAR];
export const WARP_MAX = 1000000000 * SEC_YEAR;
export const MAX_STEPS_FRAME = 2400;
export const MOON_ANG0 = 2.2; // Moon's initial mean anomaly (varpi = 0, arbitrary epoch)
export const warpLabel = w => {
    const f = x => +(Math.round(x * 10) / 10);
    if (w >= SEC_YEAR) {
        const yr = w / SEC_YEAR;
        if (yr >= 1e9) return f(yr / 1e9) + " Byr/s";
        if (yr >= 1e6) return f(yr / 1e6) + " Myr/s";
        if (yr >= 1000) return f(yr / 1000) + " kyr/s";
        return f(yr) + " yr/s";
    }
    return w >= 86400 ? f(w / 86400) + " d/s" : w >= 3600 ? f(w / 3600) + " h/s" : w >= 60 ? f(w / 60) + " min/s" : w === 1 ? "real time" : f(w) + "×";
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
