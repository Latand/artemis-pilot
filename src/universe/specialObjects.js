// WP19 curated special-objects overlay: real stellar-mass black holes and
// famous pulsars, always-on additions to the destination table alongside
// Sgr A* (already curated in src/constants.js). Records use the exact shape
// produced by constants.js's skyStar()/finalizeStar() pipeline so they run
// through the same physics once spread into STARS.
//
// skyStar() itself is not exported from constants.js (the WP19 integration
// there is capped at an import + a spread line), so the RA/Dec/distance ->
// Cartesian placement math is replicated below as specialStar(); keep it in
// sync with constants.js's skyStar() if that math changes.
//
// Sources (scratchpad/research/catalog-strategy.md §5, catalog-strategy
// research pass 2026-07-01, web-verified):
// - Gaia BH1: El-Badry et al. 2023 (9.62 Msun, 477 pc).
// - Gaia BH2: El-Badry et al. 2023 (8.9 Msun, 1160 pc).
// - Gaia BH3: Gaia Collaboration / Panuzzo et al. 2024, announced Apr 2024
//   (32.7 Msun, 590 pc) -- most massive known stellar-origin black hole in
//   the Galaxy.
// - Cygnus X-1: Miller-Jones et al. 2021 (21.2 Msun, 2200 pc).
// - Crab pulsar (PSR B0531+21 / J0534+2200), Vela pulsar (PSR B0833-45),
//   PSR B1919+21 (first pulsar discovered, Hewish & Bell 1967), Geminga
//   (PSR J0633+1746): ATNF Pulsar Catalogue,
//   https://www.atnf.csiro.au/research/pulsar/psrcat/

const R_SUN = 696340;               // km; must match constants.js R_SUN
const PC_LY = 3.2615637771674;      // parsecs -> light-years; must match constants.js PC_KM/LY_KM
const LY_KM = 9460730472580.8;      // km per light-year; must match constants.js LY_KM
const DEG = Math.PI / 180;
// Schwarzschild radius per solar mass, km (r_s = 2GM/c^2 -> 2.9532 km/Msun).
const RS_PER_SOLAR_MASS = 2.9532;
// Representative neutron-star radius. Individual NS radii are not precisely
// measured for these objects; 12 km is a standard illustrative value (the
// visual/contact geometry here is approximate, unlike the mass/distance/
// position values which are the cited real numbers).
const NS_RADIUS_KM = 12;

const hmsToDeg = (h, m, s) => 15 * (h + m / 60 + s / 3600);
const dmsToDeg = (sign, d, m, s) => sign * (d + m / 60 + s / 3600);

// Replicated from constants.js's skyStar() -- see file header note.
function specialStar(name, dLy, raDeg, decDeg, color, mass, radiusSolar, extra = {}) {
    const ra = raDeg * DEG, dec = decDeg * DEG;
    const dKm = dLy * LY_KM;
    const cd = Math.cos(dec);
    return {
        name, dLy, raDeg, decDeg, color, mass, R: radiusSolar * R_SUN,
        x: cd * Math.cos(ra) * dKm,
        y: cd * Math.sin(ra) * dKm,
        z: Math.sin(dec) * dKm,
        catalog: "special-object",
        ...extra,
    };
}

// Contact surface uses the photon sphere (1.5 r_s), the same convention as
// the curated Sgr A* entry in constants.js; flowSink for bh:true objects
// reads `rs` (the true Schwarzschild radius), not `R`.
function blackHole(name, distPc, raDeg, decDeg, color, massSolar) {
    const rsKm = RS_PER_SOLAR_MASS * massSolar;
    const photonSphereKm = 1.5 * rsKm;
    return specialStar(name, distPc * PC_LY, raDeg, decDeg, color, massSolar, photonSphereKm / R_SUN, { bh: true, rs: rsKm });
}

// Neutron stars are compact but not black holes: no event horizon, no `bh`
// flag, so the shared finalizeStar() flowSink falls back to `R` (the NS
// radius) rather than a Schwarzschild radius.
function neutronStar(name, distPc, raDeg, decDeg, color, massSolar = 1.4) {
    return specialStar(name, distPc * PC_LY, raDeg, decDeg, color, massSolar, NS_RADIUS_KM / R_SUN);
}

const BH_COLOR = 0xd9c8ff;   // same accretion-glow hue used for Sgr A* in constants.js
const NS_COLOR = 0xcfe8ff;   // pale blue-white, evoking the extreme surface temperature

export const SPECIAL_OBJECTS = [
    // Stellar-mass black holes (Gaia astrometric binaries + the Cygnus X-1 X-ray binary).
    blackHole("GAIA BH1", 477, hmsToDeg(17, 28, 41), dmsToDeg(-1, 0, 34, 52), BH_COLOR, 9.62),
    blackHole("GAIA BH2", 1160, hmsToDeg(13, 50, 17), dmsToDeg(-1, 59, 14, 20), BH_COLOR, 8.9),
    blackHole("GAIA BH3", 590, hmsToDeg(19, 39, 19), dmsToDeg(1, 14, 55, 54), BH_COLOR, 32.7),
    blackHole("CYGNUS X-1", 2200, hmsToDeg(19, 58, 22), dmsToDeg(1, 35, 12, 6), BH_COLOR, 21.2),

    // Famous pulsars / neutron stars.
    neutronStar("CRAB PULSAR", 2000, hmsToDeg(5, 34, 31.97), dmsToDeg(1, 22, 0, 52.1), NS_COLOR),
    neutronStar("VELA PULSAR", 287, hmsToDeg(8, 35, 20.61149), dmsToDeg(-1, 45, 10, 34.8751), NS_COLOR),
    neutronStar("PSR B1919+21", 1000, hmsToDeg(19, 21, 44.815), dmsToDeg(1, 21, 53, 2.25), NS_COLOR),
    neutronStar("GEMINGA", 250, hmsToDeg(6, 33, 54.15), dmsToDeg(1, 17, 46, 12.9), NS_COLOR),
];
