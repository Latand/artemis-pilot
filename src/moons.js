// Planetary moons. The integrated n-body field carries Earth, Sun, the Moon,
// and the eight major bodies; adding ~20 small fast moons to that RK4 set would
// stiffen the integrator and break the deep-time Kepler jumps. So the planetary
// moons here are analytic: each rides a fixed Keplerian ellipse around its
// parent planet (parent μ; the moon's own mass is negligible for its orbit),
// evaluated directly from the sim clock. They are visual + focusable navigation
// targets, not gravity sources — flying *to* a moon works, capturing a stable
// orbit around one does not (the parent's pull dominates the analytic point).
import { PL, K } from "./constants.js";

const TAU = Math.PI * 2;

// a: semi-major axis (km), e: eccentricity, R: mean radius (km).
// p: parent planet index into PL. phase: initial mean anomaly (rad).
// retro: retrograde orbit (Triton). Values are J2000-era mean elements.
export const MOONS = [
    // ---- Mars ----
    { p: 2, name: "PHOBOS", a: 9376, e: 0.0151, R: 11.27, color: 0x8b7d6b, phase: 0.3 },
    { p: 2, name: "DEIMOS", a: 23463, e: 0.0002, R: 6.2, color: 0x9c8c76, phase: 2.0 },
    // ---- Jupiter (Galilean) ----
    { p: 3, name: "IO", a: 421800, e: 0.0041, R: 1821.6, color: 0xe6d27a, phase: 0.0 },
    { p: 3, name: "EUROPA", a: 671100, e: 0.0094, R: 1560.8, color: 0xcdd6e4, phase: 1.4 },
    { p: 3, name: "GANYMEDE", a: 1070400, e: 0.0013, R: 2634.1, color: 0xb3a691, phase: 2.7 },
    { p: 3, name: "CALLISTO", a: 1882700, e: 0.0074, R: 2410.3, color: 0x7c6c5b, phase: 4.1 },
    // ---- Saturn ----
    { p: 4, name: "MIMAS", a: 185539, e: 0.0196, R: 198.2, color: 0xc9c6bd, phase: 0.5 },
    { p: 4, name: "ENCELADUS", a: 238042, e: 0.0047, R: 252.1, color: 0xf2f4f7, phase: 1.6 },
    { p: 4, name: "TETHYS", a: 294619, e: 0.0001, R: 531.1, color: 0xd8d6cf, phase: 2.5 },
    { p: 4, name: "DIONE", a: 377396, e: 0.0022, R: 561.4, color: 0xcccabf, phase: 3.4 },
    { p: 4, name: "RHEA", a: 527108, e: 0.0013, R: 763.8, color: 0xc6c2b6, phase: 4.6 },
    { p: 4, name: "TITAN", a: 1221870, e: 0.0288, R: 2574.7, color: 0xd9a441, phase: 5.5 },
    { p: 4, name: "IAPETUS", a: 3560820, e: 0.0286, R: 734.5, color: 0x8f8266, phase: 1.1 },
    // ---- Uranus ----
    { p: 5, name: "MIRANDA", a: 129390, e: 0.0013, R: 235.8, color: 0xb7c0c6, phase: 0.8 },
    { p: 5, name: "ARIEL", a: 190900, e: 0.0012, R: 578.9, color: 0xc4ccd1, phase: 2.2 },
    { p: 5, name: "UMBRIEL", a: 266000, e: 0.0039, R: 584.7, color: 0x8f989e, phase: 3.6 },
    { p: 5, name: "TITANIA", a: 435910, e: 0.0011, R: 788.4, color: 0xbcc4c9, phase: 5.0 },
    { p: 5, name: "OBERON", a: 583520, e: 0.0014, R: 761.4, color: 0xa6aeb3, phase: 0.2 },
    // ---- Neptune ----
    { p: 6, name: "TRITON", a: 354759, e: 0.000016, R: 1353.4, color: 0xcdbfe0, phase: 1.0, retro: true },
    { p: 6, name: "PROTEUS", a: 117647, e: 0.00053, R: 210, color: 0x8a8d92, phase: 3.0 },
    { p: 6, name: "NEREID", a: 5513400, e: 0.7507, R: 170, color: 0x9aa0a6, phase: 4.7 },
];

for (const m of MOONS) {
    m.mu = PL[m.p].mu;                                  // parent dominates the moon's orbit
    m.n = Math.sqrt(m.mu / (m.a * m.a * m.a)) * (m.retro ? -1 : 1);
}

// Analytic position of a moon relative to its parent planet at sim time t.
// Returns the in-plane (ecliptic) offset in km via out.{x,y}; varpi = 0 so the
// ellipse's perihelion points along +x — orientation is only cosmetic here.
export function moonOffset(m, t, out) {
    const M = m.phase + m.n * t;
    let E = M;
    for (let i = 0; i < 6; i++) E -= (E - m.e * Math.sin(E) - M) / (1 - m.e * Math.cos(E));
    const cE = Math.cos(E), sE = Math.sin(E);
    out.x = m.a * (cE - m.e);
    out.y = m.a * Math.sqrt(1 - m.e * m.e) * sE;
    return out;
}

export function moonFocusValue(i) { return "moon:" + i; }
export function moonFocusIndex(f) {
    if (typeof f !== "string") return -1;
    const m = f.match(/^moon:(\d+)$/);
    const i = m ? Number(m[1]) : -1;
    return i >= 0 && i < MOONS.length ? i : -1;
}
// distance from camera (scene units) below which a moon's label is worth drawing
// — keeps ~20 labels from cluttering the sky until you are near the system
export const MOON_LABEL_DIST = i => Math.max(MOONS[i].a * K * 26, MOONS[i].R * K * 900);
