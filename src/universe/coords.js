// Coordinate frames and unit conversions for the full-scale universe layer.
//
// WORLD FRAME. The simulator has exactly one world frame: heliocentric
// (barycentric at seed time) kilometres on the mean ECLIPTIC and equinox of
// J2000 -- x toward the vernal equinox, z toward the north ecliptic pole. The
// Solar System ephemeris is natively ecliptic (Earth's orbit defines z = 0),
// so every source that arrives in equatorial (ICRS/J2000) coordinates -- the
// HYG / AT-HYG catalogs, curated RA/Dec destinations, the galactic transform,
// external galaxies -- is rotated into this frame exactly once, through
// equatorialToWorldInto() below. Before this existed the stars stayed
// equatorial while the planets were ecliptic, so the sky and the Solar System
// disagreed by the full 23.44 deg obliquity (the Sun and planets appeared in
// the wrong constellations).
//
// EQUATORIAL functions (galToEquatorial*, equatorialKmToGal) are kept as true
// ICRS conversions for astrometric checks; runtime code uses the *World*
// variants. The procedural galaxy is described in a GALACTOCENTRIC parsec
// frame (disc in the X–Y plane). Unit values mirror constants.js exactly.

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

// --- Equatorial <-> world (ecliptic J2000) --------------------------------
// IAU 2006 obliquity of the ecliptic at J2000: 84381.406 arcsec.
export const OBLIQUITY_J2000_RAD = 84381.406 / 3600 * Math.PI / 180;
export const WORLD_FRAME = "ecliptic-j2000";
const COS_EPS = Math.cos(OBLIQUITY_J2000_RAD), SIN_EPS = Math.sin(OBLIQUITY_J2000_RAD);

// r_world = R_x(+eps) r_eq. The celestial pole lands at ecliptic longitude
// 90 deg, latitude 90 - eps; the June solstice point (RA 6h, Dec +eps) lands
// on the ecliptic at longitude 90 deg.
export function equatorialToWorldInto(x, y, z, out, o = 0) {
    out[o] = x;
    out[o + 1] = COS_EPS * y + SIN_EPS * z;
    out[o + 2] = -SIN_EPS * y + COS_EPS * z;
    return out;
}
export function worldToEquatorialInto(x, y, z, out, o = 0) {
    out[o] = x;
    out[o + 1] = COS_EPS * y - SIN_EPS * z;
    out[o + 2] = SIN_EPS * y + COS_EPS * z;
    return out;
}
// Unit vector (world frame) for a J2000 right ascension / declination.
export function raDecToWorldUnitInto(raDeg, decDeg, out, o = 0) {
    const ra = raDeg * Math.PI / 180, dec = decDeg * Math.PI / 180, cd = Math.cos(dec);
    return equatorialToWorldInto(cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec), out, o);
}

// Rotate a packed catalog (x/y/z columns in any length unit, equatorial) into
// the world frame in place. Idempotent through `meta.frame`: loaders call it
// on every path (worker, fallback, cache) and only the first call rotates.
export function ensureWorldFrameRecords(meta, vals, stride, ix, iy, iz) {
    if (meta && meta.frame === WORLD_FRAME) return false;
    const n = Math.floor(vals.length / stride);
    for (let i = 0, j = 0; i < n; i++, j += stride) {
        const y = vals[j + iy], z = vals[j + iz];
        vals[j + iy] = COS_EPS * y + SIN_EPS * z;
        vals[j + iz] = -SIN_EPS * y + COS_EPS * z;
    }
    if (meta) meta.frame = WORLD_FRAME;
    return true;
}

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

// Galactocentric parsecs → absolute scene units (world frame, scene axis map
// (x, z, -y)·K). Rendering only.
export function galToSceneUnitsInto(gx, gy, gz, out, o = 0, sceneScale = .001) {
    const hx = _sunAnchor[0] - gx, hy = gy - _sunAnchor[1], hz = gz - _sunAnchor[2];
    const sx = PC_KM * sceneScale;
    const wx = W2G[0][0] * hx + W2G[1][0] * hy + W2G[2][0] * hz;
    const wy = W2G[0][1] * hx + W2G[1][1] * hy + W2G[2][1] * hz;
    const wz = W2G[0][2] * hx + W2G[1][2] * hy + W2G[2][2] * hz;
    out[o] = wx * sx;
    out[o + 1] = wz * sx;
    out[o + 2] = -wy * sx;
    return out;
}

// --- Galactic <-> world (ecliptic J2000) ------------------------------------
// W2G = EQ2GAL · R_x(eps)^T: rows map a world-frame vector onto the galactic
// axes [toward GC, toward rotation, toward NGP].
export const W2G = EQ2GAL.map(row => [
    row[0],
    COS_EPS * row[1] + SIN_EPS * row[2],
    -SIN_EPS * row[1] + COS_EPS * row[2],
]);

export function galacticToWorld(g) {
    return [
        W2G[0][0] * g[0] + W2G[1][0] * g[1] + W2G[2][0] * g[2],
        W2G[0][1] * g[0] + W2G[1][1] * g[1] + W2G[2][1] * g[2],
        W2G[0][2] * g[0] + W2G[1][2] * g[1] + W2G[2][2] * g[2],
    ];
}

// Galactocentric parsecs → world-frame parsecs relative to the (moving) Sun.
export function galToWorldPcInto(gx, gy, gz, out, o = 0) {
    const hx = _sunAnchor[0] - gx, hy = gy - _sunAnchor[1], hz = gz - _sunAnchor[2];
    out[o] = W2G[0][0] * hx + W2G[1][0] * hy + W2G[2][0] * hz;
    out[o + 1] = W2G[0][1] * hx + W2G[1][1] * hy + W2G[2][1] * hz;
    out[o + 2] = W2G[0][2] * hx + W2G[1][2] * hy + W2G[2][2] * hz;
    return out;
}

export function galToWorldKmInto(gx, gy, gz, out, o = 0) {
    galToWorldPcInto(gx, gy, gz, out, o);
    out[o] *= PC_KM;
    out[o + 1] *= PC_KM;
    out[o + 2] *= PC_KM;
    return out;
}

export function galToWorldKm(gx, gy, gz) {
    return galToWorldKmInto(gx, gy, gz, [0, 0, 0]);
}

// World-frame km (Sun-relative) → galactocentric parsecs.
export function worldKmToGal(x, y, z) {
    const ex = x / PC_KM, ey = y / PC_KM, ez = z / PC_KM;
    const gGC = W2G[0][0] * ex + W2G[0][1] * ey + W2G[0][2] * ez;
    const gRot = W2G[1][0] * ex + W2G[1][1] * ey + W2G[1][2] * ez;
    const gNGP = W2G[2][0] * ex + W2G[2][1] * ey + W2G[2][2] * ez;
    return [_sunAnchor[0] - gGC, gRot + _sunAnchor[1], gNGP + _sunAnchor[2]];
}

// Allocation-free variant writing galactocentric pc into `out`.
export function worldKmToGalInto(x, y, z, out, o = 0) {
    const ex = x / PC_KM, ey = y / PC_KM, ez = z / PC_KM;
    out[o] = _sunAnchor[0] - (W2G[0][0] * ex + W2G[0][1] * ey + W2G[0][2] * ez);
    out[o + 1] = W2G[1][0] * ex + W2G[1][1] * ey + W2G[1][2] * ez + _sunAnchor[1];
    out[o + 2] = W2G[2][0] * ex + W2G[2][1] * ey + W2G[2][2] * ez + _sunAnchor[2];
    return out;
}

// --- Explicit-anchor conversions (deep time) -------------------------------
// The module anchor above tracks the Sun "now". Epoch-referenced data (the
// catalogs are a t = 0 snapshot) and positions evaluated at some other time
// must name the Sun they are relative to instead of borrowing it: converting
// a catalog star with the CURRENT anchor and then adding its own orbital
// rotation counted the Galactic rotation twice (catalog stars within 20 pc
// sat ~230 pc away after 1 Myr and 12-18 kpc away after 100 Myr).

// World-frame km relative to a Sun at galactocentric (sunX, sunY, sunZ) pc →
// galactocentric pc. With SUN_GAL this is the catalog epoch's frame.
export function worldKmToGalFromInto(x, y, z, sunX, sunY, sunZ, out, o = 0) {
    const ex = x / PC_KM, ey = y / PC_KM, ez = z / PC_KM;
    out[o] = sunX - (W2G[0][0] * ex + W2G[0][1] * ey + W2G[0][2] * ez);
    out[o + 1] = W2G[1][0] * ex + W2G[1][1] * ey + W2G[1][2] * ez + sunY;
    out[o + 2] = W2G[2][0] * ex + W2G[2][1] * ey + W2G[2][2] * ez + sunZ;
    return out;
}

// Galactocentric pc → world-frame km relative to an explicit Sun position
// (galactocentric pc), e.g. solarGalacticStateAt(simT). Same arithmetic as
// galToWorldKmInto, so with SUN_GAL it reproduces the epoch values exactly.
export function galToWorldKmFromInto(gx, gy, gz, sunX, sunY, sunZ, out, o = 0) {
    const hx = sunX - gx, hy = gy - sunY, hz = gz - sunZ;
    out[o] = (W2G[0][0] * hx + W2G[1][0] * hy + W2G[2][0] * hz) * PC_KM;
    out[o + 1] = (W2G[0][1] * hx + W2G[1][1] * hy + W2G[2][1] * hz) * PC_KM;
    out[o + 2] = (W2G[0][2] * hx + W2G[1][2] * hy + W2G[2][2] * hz) * PC_KM;
    return out;
}

// A galactocentric DISPLACEMENT (pc) → world-frame km (anchor-free).
export function galDeltaToWorldKmInto(dgx, dgy, dgz, out, o = 0) {
    const hx = -dgx;
    out[o] = (W2G[0][0] * hx + W2G[1][0] * dgy + W2G[2][0] * dgz) * PC_KM;
    out[o + 1] = (W2G[0][1] * hx + W2G[1][1] * dgy + W2G[2][1] * dgz) * PC_KM;
    out[o + 2] = (W2G[0][2] * hx + W2G[1][2] * dgy + W2G[2][2] * dgz) * PC_KM;
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
