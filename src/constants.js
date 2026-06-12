// Physical constants and configuration. km, km/s, km³/s² everywhere;
// the scene uses K to map km → scene units (1 unit = 1,000 km).
export const MU_E = 398600.4418, MU_M = 4902.8001, MU_S = 132712440018;
export const R_EARTH = 6371, R_MOON = 1737.4, R_SUN = 696340;
export const A_MOON = 398483.6;
export const OMEGA = Math.sqrt((MU_E + MU_M) / (A_MOON * A_MOON * A_MOON));
export const AM3 = A_MOON * A_MOON * A_MOON;
export const K = .001;
export const AU_KM = 149597870.7;
export const SUN_DIST = AU_KM * K;
export const SUN_RADIUS = R_SUN * K;
// Initial Sun/Earth geometry. The runtime integrates a live Earth world-state
// plus Earth-local relative states for the ship, Moon, planets, and holes.
export const SUN_D3 = AU_KM * AU_KM * AU_KM;
export const SUN_TH0 = Math.atan2(-.08, -1);
export const OM_YEAR = Math.sqrt((MU_S + MU_E) / SUN_D3); // ~365.25 d period
// planets: true radii, true μ, circular coplanar heliocentric orbits
export const PL = [
    { name: "MERCURY", tag: "ME", a: 57.909e6, R: 2439.7, mu: 22031.9, color: 0x9c8e7e, phase: 4.2, gas: false, tex: "2k_mercury.jpg" },
    { name: "VENUS", tag: "VE", a: 108.21e6, R: 6051.8, mu: 324858.6, color: 0xe6c98e, phase: 1.1, gas: false, tex: "2k_venus_atmosphere.jpg" },
    { name: "MARS", tag: "MA", a: 227.956e6, R: 3389.5, mu: 42828.4, color: 0xc96b4a, phase: 5.4, gas: false, tex: "2k_mars.jpg" },
    { name: "JUPITER", tag: "JU", a: 778.479e6, R: 69911, mu: 126686531, color: 0xc9a47a, phase: 2.6, gas: true, tex: "2k_jupiter.jpg" },
    { name: "SATURN", tag: "SA", a: 1432.041e6, R: 58232, mu: 37931206, color: 0xe0d0a4, phase: 0.4, gas: true, ring: [74500, 140200], tex: "2k_saturn.jpg" },
    { name: "URANUS", tag: "UR", a: 2867.043e6, R: 25362, mu: 5793951, color: 0x9fd6dd, phase: 3.5, gas: true, tex: "2k_uranus.jpg" },
    { name: "NEPTUNE", tag: "NE", a: 4514.953e6, R: 24622, mu: 6835100, color: 0x5d7fe8, phase: 5.9, gas: true, tex: "2k_neptune.jpg" },
];
for (const p of PL) {
    p.n = Math.sqrt(MU_S / (p.a * p.a * p.a));
    p.soi = p.a * Math.pow(p.mu / MU_S, .4);
}
export const SOI_M = 66100;          // lunar dominance radius, km
export const SOI_E = 924000;         // Earth's heliocentric SOI, km
export const C_LIGHT = 299792.458;   // km/s
export const DRAG_CD = 0.55, DRAG_H = 8.5, ATM_TOP = 160;
export const MAIN_A = 0.006;         // km/s² at 100 % throttle
export const RCS_A = 0.0018;
export const BOOST = 4;
export const ROT_RATE = 2.0;         // rad/s of ship rotation, real-time
export const FUEL_DV0 = 9000;        // m/s of Δv in the tank (challenge mode only)
export const WARPS = [1, 60, 600, 3600, 21600, 86400, 604800, 2592000];
export const WARP_MAX = 2592000;
export const MAX_STEPS_FRAME = 2400;
export const MOON_ANG0 = 2.2;
export const warpLabel = w => {
    const f = x => +(Math.round(x * 10) / 10);
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
