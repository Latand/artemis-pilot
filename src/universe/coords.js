// Coordinate frames and unit conversions for the full-scale universe layer.
//
// The existing sim places real stars (constants.js STARS) in a Sol-centred
// EQUATORIAL (ICRS) kilometre frame: x→(RA 0,Dec 0), y→(RA 90,Dec 0), z→NCP.
// The procedural galaxy is naturally described in a GALACTOCENTRIC parsec frame
// (disc in the X–Y plane). This module converts between them so procedural and
// real stars share one frame and the procedural Milky-Way band lines up with the
// real one. Unit values mirror constants.js exactly.

export const AU_KM = 149597870.7;
export const LY_KM = 9460730472580.8;
export const PC_LY = 3.2615637771674;          // 1 parsec in light-years
export const PC_KM = LY_KM * PC_LY;             // 1 parsec in km (≈3.0857e13)

// --- Sector (floating-origin) scale --------------------------------------
// A sector is a cube SECTOR_KM on a side. A position is (integer sector index,
// float64 local offset). At |offset| < SECTOR_KM/2 ≈ 5e8 km, float64 keeps
// sub-metre precision; the integer sector carries the magnitude exactly, so we
// never form catastrophic differences like (star.x − earth.x) at 1e13 km.
export const SECTOR_KM = 1e9;                   // ≈ 6.7 AU per sector

export function sectorOf(km) { return Math.round(km / SECTOR_KM); }
export function localOf(km, sector) { return km - sector * SECTOR_KM; }
// Precise separation between two sectorised points: (Δsector)·SECTOR_KM is exact
// (small integers), the local difference is float64 — no large-number cancel.
export function sectorSep(saIdx, saLoc, sbIdx, sbLoc) {
    return (saIdx - sbIdx) * SECTOR_KM + (saLoc - sbLoc);
}

// --- Galactic structure anchors (McMillan 2017) --------------------------
export const R0_PC = 8200;     // Sun → Galactic-centre distance
export const Z_SUN_PC = 20;    // Sun above the disc mid-plane

// Galactocentric frame (parsecs, right-handed): origin = Galactic centre, disc
// in X–Y, +Z → North Galactic Pole. +X points from the GC toward the Sun, so the
// Sun sits at (R0, 0, Z_SUN); +Y is the direction of Galactic rotation.
export const SUN_GAL = [R0_PC, 0, Z_SUN_PC];

// Equatorial (ICRS) → Galactic rotation matrix, J2000 (ESA/Hipparcos vol.1 §1.5).
// Rows map an equatorial unit vector into galactic axes [toward GC, toward
// l=90°, toward NGP]. The transpose maps galactic → equatorial.
const EQ2GAL = [
    [-0.0548755604, -0.8734370902, -0.4838350155],
    [0.4941094279, -0.4448296300, 0.7469822445],
    [-0.8676661490, -0.1980763734, 0.4559837762],
];

// Galactic Cartesian [toward GC, toward rotation, toward NGP] → equatorial.
export function galacticToEquatorial(g) {
    return [
        EQ2GAL[0][0] * g[0] + EQ2GAL[1][0] * g[1] + EQ2GAL[2][0] * g[2],
        EQ2GAL[0][1] * g[0] + EQ2GAL[1][1] * g[1] + EQ2GAL[2][1] * g[2],
        EQ2GAL[0][2] * g[0] + EQ2GAL[1][2] * g[1] + EQ2GAL[2][2] * g[2],
    ];
}

export function galToEquatorialPcInto(gx, gy, gz, out, o = 0) {
    const hx = R0_PC - gx, hy = gy, hz = gz - Z_SUN_PC;
    out[o] = EQ2GAL[0][0] * hx + EQ2GAL[1][0] * hy + EQ2GAL[2][0] * hz;
    out[o + 1] = EQ2GAL[0][1] * hx + EQ2GAL[1][1] * hy + EQ2GAL[2][1] * hz;
    out[o + 2] = EQ2GAL[0][2] * hx + EQ2GAL[1][2] * hy + EQ2GAL[2][2] * hz;
    return out;
}

export function galToEquatorialKmInto(gx, gy, gz, out, o = 0) {
    galToEquatorialPcInto(gx, gy, gz, out, o);
    out[o] *= PC_KM;
    out[o + 1] *= PC_KM;
    out[o + 2] *= PC_KM;
    return out;
}

export function galToSceneUnitsInto(gx, gy, gz, out, o = 0, sceneScale = .001) {
    const hx = R0_PC - gx, hy = gy, hz = gz - Z_SUN_PC;
    const sx = PC_KM * sceneScale;
    const ex = EQ2GAL[0][0] * hx + EQ2GAL[1][0] * hy + EQ2GAL[2][0] * hz;
    const ey = EQ2GAL[0][1] * hx + EQ2GAL[1][1] * hy + EQ2GAL[2][1] * hz;
    const ez = EQ2GAL[0][2] * hx + EQ2GAL[1][2] * hy + EQ2GAL[2][2] * hz;
    out[o] = ex * sx;
    out[o + 1] = ez * sx;
    out[o + 2] = -ey * sx;
    return out;
}

// Galactocentric parsecs → Sol-centred equatorial km (the constants.js STARS
// frame). Translate to heliocentric, express in the galactic (l,b) basis, rotate
// into equatorial, scale to km. The 20 pc solar offset tilts the basis by only
// ~0.14°, so we keep the basis axis-aligned and carry Z_SUN in the translation.
export function galToEquatorialKm(gx, gy, gz) {
    const eq = [0, 0, 0];
    galToEquatorialKmInto(gx, gy, gz, eq);
    return eq;
}

// Inverse: Sol-centred equatorial km → galactocentric parsecs. Used to find which
// procedural cells surround the ship when it is far from the Sun.
export function equatorialKmToGal(x, y, z) {
    const ex = x / PC_KM, ey = y / PC_KM, ez = z / PC_KM;
    // equatorial → galactic uses the forward matrix EQ2GAL
    const gGC = EQ2GAL[0][0] * ex + EQ2GAL[0][1] * ey + EQ2GAL[0][2] * ez;
    const gRot = EQ2GAL[1][0] * ex + EQ2GAL[1][1] * ey + EQ2GAL[1][2] * ez;
    const gNGP = EQ2GAL[2][0] * ex + EQ2GAL[2][1] * ey + EQ2GAL[2][2] * ez;
    // heliocentric galactic [toward GC, rot, NGP] → galactocentric
    return [R0_PC - gGC, gRot, gNGP + Z_SUN_PC];
}
