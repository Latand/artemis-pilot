// Self-contained NESTED-scheme HEALPix (Gorski et al. 2005, ApJ 622, 759) implementation.
// No external dependency. Fixed to the tiling order this project ships (order 5, 12288
// tiles), but ang2pix_nest/pix2ang_nest accept any order for reuse/testing.
//
// theta = colatitude (0 at the north pole, pi at the south pole), phi = longitude,
// both in radians internally; the public API takes/returns ra/dec in degrees.

export const ORDER = 5;
export const NSIDE = 1 << ORDER; // 32
export const NPIX = 12 * NSIDE * NSIDE; // 12288

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const TWOPI = Math.PI * 2;
const HALFPI = Math.PI / 2;

// Face layout tables (standard HEALPix constants; face_num in [0,11]).
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

// Bit-interleave (ix,iy) -> a single "in-face" pixel index: bit k of ix goes to
// output bit 2k, bit k of iy goes to output bit 2k+1. Loop-based since `order`
// is small (<=5 in this app, i.e. <=5 bits per coordinate) - no lookup table needed.
function xy2pixBits(ix, iy, nbits) {
    let ipf = 0;
    for (let i = 0; i < nbits; i++) {
        const bx = (ix >> i) & 1;
        const by = (iy >> i) & 1;
        ipf += bx << (2 * i);
        ipf += by << (2 * i + 1);
    }
    return ipf;
}

// Inverse of xy2pixBits: de-interleave even bits -> ix, odd bits -> iy.
function pix2xyBits(ipf, nbits) {
    let ix = 0, iy = 0;
    for (let i = 0; i < nbits; i++) {
        const bx = (ipf >> (2 * i)) & 1;
        const by = (ipf >> (2 * i + 1)) & 1;
        ix |= bx << i;
        iy |= by << i;
    }
    return [ix, iy];
}

function normalizeRad(a) {
    return ((a % TWOPI) + TWOPI) % TWOPI;
}

/**
 * ra/dec (degrees, J2000-like equatorial) -> nested HEALPix pixel index at `order`.
 */
export function ang2pix_nest(order, raDeg, decDeg) {
    const nside = 1 << order;
    const theta = (90 - decDeg) * DEG2RAD;
    const phi = normalizeRad(raDeg * DEG2RAD);
    const z = Math.cos(theta);
    const za = Math.abs(z);
    const tt = phi / HALFPI; // in [0,4)

    let faceNum, ix, iy;
    if (za <= 2 / 3) {
        // Equatorial belt.
        const temp1 = nside * (0.5 + tt);
        const temp2 = nside * (z * 0.75);
        const jp = Math.floor(temp1 - temp2); // ascending edge line index
        const jm = Math.floor(temp1 + temp2); // descending edge line index
        const ifp = Math.floor(jp / nside);
        const ifm = Math.floor(jm / nside);
        if (ifp === ifm) faceNum = (ifp % 4) + 4;
        else if (ifp < ifm) faceNum = ifp % 4;
        else faceNum = (ifm % 4) + 8;
        ix = ((jm % nside) + nside) % nside;
        iy = nside - (((jp % nside) + nside) % nside) - 1;
    } else {
        // Polar caps.
        let ntt = Math.floor(tt);
        if (ntt >= 4) ntt = 3;
        const tp = tt - ntt;
        const tmp = nside * Math.sqrt(3 * (1 - za));
        let jp = Math.floor(tp * tmp);
        let jm = Math.floor((1 - tp) * tmp);
        jp = Math.min(nside - 1, jp);
        jm = Math.min(nside - 1, jm);
        if (z >= 0) {
            faceNum = ntt;
            ix = nside - jm - 1;
            iy = nside - jp - 1;
        } else {
            faceNum = ntt + 8;
            ix = jp;
            iy = jm;
        }
    }
    const ipf = xy2pixBits(ix, iy, order);
    return ipf + faceNum * nside * nside;
}

/**
 * nested HEALPix pixel index at `order` -> tile-center ra/dec (degrees).
 */
export function pix2ang_nest(order, pix) {
    const nside = 1 << order;
    const npface = nside * nside;
    const faceNum = Math.floor(pix / npface);
    const ipf = pix % npface;
    const [ix, iy] = pix2xyBits(ipf, order);

    const jrt = ix + iy;
    const jpt = ix - iy;
    const jr = JRLL[faceNum] * nside - jrt - 1;

    const fact1 = 1 / (3 * nside * nside);
    const fact2 = 2 / (3 * nside);
    let nr, z, kshift;
    if (jr < nside) {
        // North polar cap.
        nr = jr;
        z = nr > 0 ? 1 - (nr * nr) * fact1 : 1;
        kshift = 0;
    } else if (jr > 3 * nside) {
        // South polar cap.
        nr = 4 * nside - jr;
        z = nr > 0 ? -1 + (nr * nr) * fact1 : -1;
        kshift = 0;
    } else {
        // Equatorial belt.
        nr = nside;
        z = (2 * nside - jr) * fact2;
        kshift = (jr - nside) & 1;
    }

    const nl4 = 4 * nside;
    let phi;
    if (nr > 0) {
        let jp = Math.floor((JPLL[faceNum] * nr + jpt + 1 + kshift) / 2);
        if (jp > nl4) jp -= nl4;
        if (jp < 1) jp += nl4;
        phi = (jp - (kshift + 1) * 0.5) * (HALFPI / nr);
    } else {
        // Degenerate at the exact pole pixel: longitude is undefined, use 0.
        phi = 0;
    }

    const zc = Math.max(-1, Math.min(1, z));
    const theta = Math.acos(zc);
    const decDeg = 90 - theta * RAD2DEG;
    const raDeg = ((phi * RAD2DEG) % 360 + 360) % 360;
    return { raDeg, decDeg };
}

// Equal-area-circle radius for one order-5 tile, times a safety factor so the
// conservative disc query below can never miss a tile whose area intersects
// the query disc (a HEALPix "square" tile's true circumradius exceeds the
// equal-area radius by a bounded factor well under 2x).
const TILE_EQUAL_AREA_RADIUS_DEG = Math.sqrt(4 * Math.PI / NPIX) * RAD2DEG;
export const TILE_CIRCUMRADIUS_DEG = TILE_EQUAL_AREA_RADIUS_DEG * 2;

function angularSepDeg(ra1Deg, dec1Deg, ra2Deg, dec2Deg) {
    const ra1 = ra1Deg * DEG2RAD, dec1 = dec1Deg * DEG2RAD;
    const ra2 = ra2Deg * DEG2RAD, dec2 = dec2Deg * DEG2RAD;
    // Haversine great-circle distance (numerically stable for small and large separations).
    const dDec = dec2 - dec1;
    const dRa = ra2 - ra1;
    const a = Math.sin(dDec / 2) ** 2 + Math.cos(dec1) * Math.cos(dec2) * Math.sin(dRa / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    return c * RAD2DEG;
}

/**
 * Conservative disc query: returns every tile id at `order` whose center lies
 * within `radiusDeg` + one tile circumradius of (raDeg, decDeg). May over-return
 * (tiles just outside the true disc), but must never miss a tile that actually
 * intersects the disc. Brute-forced over all NPIX tile centers; cheap at order 5.
 */
export function queryDisc(order, raDeg, decDeg, radiusDeg) {
    const nside = 1 << order;
    const npix = 12 * nside * nside;
    const margin = radiusDeg + TILE_CIRCUMRADIUS_DEG;
    const out = [];
    for (let pix = 0; pix < npix; pix++) {
        const { raDeg: tRa, decDeg: tDec } = pix2ang_nest(order, pix);
        if (angularSepDeg(raDeg, decDeg, tRa, tDec) <= margin) out.push(pix);
    }
    return out;
}
