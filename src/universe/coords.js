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

// --- Galactic structure anchors ------------------------------------------
// Matches astroConstants.js R_SUN_KPC/Z_SUN_PC exactly (kept as independent
// literals, not an import, since coords.js has no other module dependencies
// and astroConstants.js documents itself as depending on nothing but pure
// data) — GRAVITY Collaboration 2019 (R_SUN, arXiv 1904.05721) and
// Bennett & Bovy 2019 (Z_SUN, arXiv 1809.03507). Was [8200, 0, 20]
// (McMillan 2017); WP6 carry-forward S3 makes this the single authoritative
// Sun-position anchor (previously duplicated with a slightly different value).
export const R0_PC = 8178;     // Sun → Galactic-centre distance
export const Z_SUN_PC = 20.8;  // Sun above the disc mid-plane

// Galactocentric frame (parsecs, right-handed): origin = Galactic centre, disc
// in X–Y, +Z → North Galactic Pole. +X points from the GC toward the Sun, so the
// Sun sits at (R0, 0, Z_SUN); +Y is the direction of Galactic rotation.
export const SUN_GAL = [R0_PC, 0, Z_SUN_PC];

// --- Dynamic Sun anchor (WP23-EXTENSION) ----------------------------------
// The Sun rides its own galactic orbit under deep time (src/universe/
// solarOrbit.js solarGalacticStateAt) rather than sitting fixed at SUN_GAL
// forever. This mutable anchor is what the equatorial<->galactic conversions
// below actually use; it defaults to today's SUN_GAL so every conversion is
// bit-identical until a caller starts moving it (main.js's frame loop calls
// setSunGalAnchor(...solarGalacticStateAt(G.t)) once per frame). Kept
// deliberately separate from the SUN_GAL export above: galaxy.js still reads
// SUN_GAL directly as its own frozen density-normalization/catalog-
// completeness reference, an unrelated purpose this anchor doesn't touch.
const _sunAnchor = [R0_PC, 0, Z_SUN_PC];
export function setSunGalAnchor(x, y, z) {
    _sunAnchor[0] = x; _sunAnchor[1] = y; _sunAnchor[2] = z;
}
// Reused array — do not retain/mutate (matches renderOrigin.js's getOrigin()).
export function getSunGalAnchor() { return _sunAnchor; }

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
    const hx = _sunAnchor[0] - gx, hy = gy - _sunAnchor[1], hz = gz - _sunAnchor[2];
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
    const hx = _sunAnchor[0] - gx, hy = gy - _sunAnchor[1], hz = gz - _sunAnchor[2];
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
    return [_sunAnchor[0] - gGC, gRot + _sunAnchor[1], gNGP + _sunAnchor[2]];
}
