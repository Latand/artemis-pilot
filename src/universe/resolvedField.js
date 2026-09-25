// Procedural resolved star field: the individual stars of the model Milky Way
// that are bright enough, seen from the camera, to be drawn as points, and
// that no real catalog supplies.
//
// Continuity contract (see galaxyModel.js): the volumetric layer carries the
// light of every star fainter than M_lim(s) = RESOLVED_MAG_LIMIT - 5 log10(s /
// 10 pc) at camera distance s; this field draws exactly the complementary
// stars -- those brighter than M_lim(s) -- from the SAME luminosity function
// (resolvedLF.js, tabulated from galaxy.js) and the SAME component light
// densities (galaxyModel.js mwSample, including the young star-forming
// clumps). The number density of V-magnitude bin b of component c at x is
// j_c(x) * nu_c[b]. So the Galaxy's stellar structure emerges from its stars
// and the total light is conserved at every camera position.
//
// Handoffs, so no star is drawn twice:
//   - catalogs: a star the HYG / AT-HYG catalogs would contain (by magnitude
//     from the Sun, and the class/distance completeness model galaxy.js's
//     active tier uses) is left to them;
//   - active neighbourhood: inside the active-star radius around the ship,
//     galaxy.js's local tier supplies every star (with full physics).
//
// Provenance: PROCEDURAL. Positions, magnitudes and colours are statistical
// draws, not measured stars.
//
// Geometry: the field is generated in the frame that co-rotates with the
// spiral pattern (disk components) or with the bar (bar component), where the
// density model is static; the renderer rotates the frames with
// patternAngles(t). Space is split per magnitude bin into boxes whose size
// follows that bin's resolving radius R_b; a box's stars are a pure function
// of (seed, bin, frame, box) and are cached. Selection against the camera is
// cheap and re-run as the camera moves.
//
// Pure module (no THREE/DOM): runs in node smokes and in the worker.
import { LF_M_MIN, LF_M_STEP, LF_NBIN, LF_NU, LF_SAMPLES } from "./resolvedLF.js";
import { MW, mwSample, RESOLVED_MAG_LIMIT, BAR_NORM } from "./galaxyModel.js";
import { galaxyMaps } from "./galaxyMaps.js";
import { completeness } from "./astroConstants.js";
import { hashInts, makeRNG, samplePoisson } from "./prng.js";

export const FAMILY_DISK = 0, FAMILY_BAR = 1;
export const SUB_YOUNG = 0, SUB_THIN = 1, SUB_THICK = 2, SUB_HALO = 3, SUB_BAR = 4;
// Faintest apparent V magnitude a point can still show (the shared point
// material's display cut: stellarDisplayFlux reaches zero at magLimit + 4.25).
export const DISPLAY_MAG_LIMIT = 12.3;
const CLASS_LETTERS = "OBAFGKMLTY";
const LN10_04 = 0.4 * Math.LN10;
const SALT = 0x52464c44; // "RFLD"

// Box records: stride 9 floats, positions relative to the box origin.
export const REC = 9;
const R_X = 0, R_Y = 1, R_Z = 2, R_M = 3, R_TEFF = 4, R_CLS = 5, R_SUB = 6, R_U1 = 7, R_U2 = 8;

// z edges (pc, one side) the boxes never straddle: fine near the midplane
// where the young (100 pc) and thin (300 pc) layers live, coarse in the halo.
const Z_EDGES_HALF = [0, 50, 100, 200, 350, 550, 800, 1150, 1600, 2200, 3000, 4000, 5500, 7500, 10000, 15000, 25000];
const R_FIELD_MAX = 25000;

// --- Bins -------------------------------------------------------------------
export function binMagRange(b) {
    const lo = LF_M_MIN + b * LF_M_STEP;
    return [lo, lo + LF_M_STEP];
}
// Radius within which a star of the bin's brightest magnitude is resolved.
export function binRadiusPc(b, magLimit = RESOLVED_MAG_LIMIT) {
    return 10 * Math.pow(10, (magLimit - binMagRange(b)[0]) / 5);
}
export function binHasStars(b, family) {
    return family === FAMILY_BAR ? LF_NU.old[b] > 0 : (LF_NU.young[b] > 0 || LF_NU.old[b] > 0);
}
// Column edge for a bin: a fraction of its resolving radius at the reference
// limit (independent of the live limit, so cached boxes survive limit
// changes), capped so arm and clump structure is resolved by the quadrature.
export const BOX_REF_MAG = 10;
export function binBoxPc(b) {
    return Math.min(1000, Math.max(0.25, binRadiusPc(b, BOX_REF_MAG) / 2.5));
}
// Region that can hold field stars (galactocentric pc).
const XY_FIELD_MAX = R_FIELD_MAX, Z_FIELD_MAX = 12000;
const _zEdgeCache = new Map();
export function zEdgesFor(c) {
    let e = _zEdgeCache.get(c);
    if (e) return e;
    const half = [];
    for (let i = 0; i + 1 < Z_EDGES_HALF.length; i++) {
        const a = Z_EDGES_HALF[i], b = Z_EDGES_HALF[i + 1];
        const n = Math.max(1, Math.ceil((b - a) / c));
        for (let k = 0; k < n; k++) half.push(a + (b - a) * k / n);
    }
    half.push(Z_EDGES_HALF[Z_EDGES_HALF.length - 1]);
    e = [];
    for (let i = half.length - 1; i > 0; i--) e.push(-half[i]);
    for (let i = 0; i < half.length; i++) e.push(half[i]);
    _zEdgeCache.set(c, e);
    return e;
}

function fract(x) { return x - Math.floor(x); }
// Young star-forming complexes and their clusters below the structure maps'
// texel: the JS twin of galaxyModel's GLSL gdYoungField (same hashes, same
// cells, offsets and heights), so resolved young stars sit in the complexes
// and clusters the diffuse light shows.
function gdHash3(px, py, out) {
    let x = fract(px * 0.1031), y = fract(py * 0.1030), z = fract(px * 0.0973);
    const d = x * (y + 33.33) + y * (x + 33.33) + z * (z + 33.33);
    x += d; y += d; z += d;
    out[0] = fract((x + y) * z); out[1] = fract((x + z) * y); out[2] = fract((y + z) * x);
    return out;
}
function gdHash1(px, py) {
    let x = fract(px * 0.1031), y = fract(py * 0.1031), z = x;
    const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
    x += d; y += d; z += d;
    return fract((x + y) * z);
}
const _h3 = [0, 0, 0];
const LF_NORM = 1 / (1 + Math.log(1000));
// Complex of the 100 pc cell containing (x, y): [x, y, z] pc and its
// brightness (dN/dL ~ L^-2 over 3 decades, mean 1).
export function complexOfCell(x, y, out) {
    const cx = Math.floor(x / 100 + 11.3), cy = Math.floor(y / 100 + 11.3);
    gdHash3(cx, cy, _h3);
    const u = gdHash1(cx + 71.7, cy + 71.7) - 0.5;
    out[0] = (cx + _h3[0] - 11.3) * 100;
    out[1] = (cy + _h3[1] - 11.3) * 100;
    out[2] = -MW.hzYoung * Math.sign(u) * Math.log(Math.max(1 - 2 * Math.abs(u), 1e-4));
    out[3] = LF_NORM / Math.max(_h3[2], 1e-3);
    return out;
}
// Cluster m (1..3) of the complex of the 100 pc cell containing (x, y)
// (complex: that complexOfCell result): [x, y, z] pc and its brightness
// (mean 1/3).
export function clusterOfComplex(x, y, m, complex, out) {
    const cx = Math.floor(x / 100 + 11.3), cy = Math.floor(y / 100 + 11.3);
    gdHash3(cx + 17.3 * m, cy + 5.7 * m, _h3);
    const hz = gdHash1(cx + 3.1 * m, cy + 29.9);
    const r = 12 * Math.sqrt(-2 * Math.log(Math.max(_h3[0], 1e-6)));
    out[0] = complex[0] + r * Math.cos(2 * Math.PI * _h3[1]);
    out[1] = complex[1] + r * Math.sin(2 * Math.PI * _h3[1]);
    out[2] = complex[2] + 40 * hz - 20;
    out[3] = LF_NORM / 3 / Math.max(_h3[2], 1e-3);
    return out;
}
// Place a young star in that structure: 30% stay in the smooth layer, 35%
// join a complex, 35% a cluster, chosen among the complexes (or their
// clusters) of the 3 x 3 cells around it with probability proportional to
// their brightness, so a bright complex gathers stars in proportion to the
// light the diffuse layer gives it.
const _cand = new Float64Array(27 * 4), _cl = [0, 0, 0, 0], _ck = [0, 0, 0, 0];
function snapToClusters(rng, x, y, z, out) {
    out[0] = x; out[1] = y; out[2] = z;
    const r = rng();
    if (r < 0.3) return out;
    const clusters = r >= 0.65;
    let n = 0, tot = 0;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const px = x + i * 100, py = y + j * 100;
        complexOfCell(px, py, _cl);
        for (let m = 1; m <= (clusters ? 3 : 1); m++) {
            const c = clusters ? clusterOfComplex(px, py, m, _cl, _ck) : _cl;
            _cand[n * 4] = c[0]; _cand[n * 4 + 1] = c[1]; _cand[n * 4 + 2] = c[2]; _cand[n * 4 + 3] = c[3];
            tot += c[3]; n++;
        }
    }
    let pick = rng() * tot, k = 0;
    while (k < n - 1 && (pick -= _cand[k * 4 + 3]) > 0) k++;
    const sig = clusters ? 3 : 15;
    const g = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
    out[0] = _cand[k * 4] + sig * g(); out[1] = _cand[k * 4 + 1] + sig * g(); out[2] = _cand[k * 4 + 2] + sig * g();
    return out;
}
const _snap = [0, 0, 0];

// --- Component densities in a frame ------------------------------------------
const ANG0 = { spiral: 0, bar: 0 };
const _s = {};
// Light densities (Lsun/pc^3) of the family's components at a frame point.
function familyDensity(family, x, y, z, out) {
    mwSample(x, y, z, ANG0, null, 0, _s, 1e9, 1e9, 1e9);
    if (family === FAMILY_BAR) {
        out.young = 0; out.old = _s.bar;
        out.thin = 0; out.thick = 0; out.halo = 0; out.bar = _s.bar;
    } else {
        out.young = _s.young;
        out.thin = _s.thin; out.thick = _s.thick; out.halo = _s.halo; out.bar = 0;
        out.old = _s.thin + _s.thick + _s.halo;
    }
    return out;
}

// --- Box generation -----------------------------------------------------------
const GL3 = [[-Math.sqrt(0.6), 5 / 9], [0, 8 / 9], [Math.sqrt(0.6), 5 / 9]];
const _d = {};
const NSUB = 3;                           // xy sub-cells per box side
const _w = new Float64Array(NSUB * NSUB * 6);   // per sub-cell: young, thin, thick, halo, bar, youngMax
const HZ_OF = [MW.hzYoung, MW.hzThin, MW.hzThick];

// z drawn from exp(-|z|/h) restricted to [z0, z1] (exact inverse CDF).
function sampleExpZ(u, z0, z1, h) {
    const e = z => Math.sign(z) * h * (1 - Math.exp(-Math.abs(z) / h));   // primitive
    const a = e(z0), b = e(z1);
    const v = a + u * (b - a);
    const w = Math.min(0.999999999, Math.abs(v) / h);
    return Math.sign(v) * -h * Math.log(1 - w);
}

// Stars of bin b in box (i, j, k) of the family's frame, minus the ones the
// real catalogs hold as seen from `sun` (frame pc) with reach catalogMagLimit
// (null = keep all). Returns { ox, oy, oz, n, rec: Float32Array(n * REC) }
// (positions box-relative).
//
// Sampling: per xy sub-cell (3x3) and component, the box light integral
// comes from a midpoint x 3-point Gauss-Legendre quadrature; a star picks a
// sub-cell by weight, z exactly from its component's exponential layer
// (disk) or uniformly in the slab (halo, bar), and x, y uniformly in the
// sub-cell -- except young stars, which are rejection-sampled against the
// exact density so they trace the arms and star-forming clumps.
export function generateBox(seed, family, b, i, j, k, sun = null, catalogMagLimit = 11) {
    const c = binBoxPc(b);
    const ze = zEdgesFor(c);
    const x0 = i * c, y0 = j * c, z0 = ze[k], z1 = ze[k + 1];
    const out = { ox: x0, oy: y0, oz: z0, n: 0, rec: null };
    if (z1 === undefined || Math.hypot(x0 + c / 2, y0 + c / 2) > R_FIELD_MAX + c) return out;
    const nuY = family === FAMILY_BAR ? 0 : LF_NU.young[b], nuO = LF_NU.old[b];
    if (!(nuY > 0 || nuO > 0)) return out;
    const hz = z1 - z0, sc = c / NSUB;
    const subVol = sc * sc * hz / 2;          // x (GL weights sum to 2)
    const tot = [0, 0, 0, 0, 0];
    for (let a = 0; a < NSUB; a++) for (let bb = 0; bb < NSUB; bb++) {
        const o = (a * NSUB + bb) * 6;
        const xs = x0 + (a + 0.5) * sc, ys = y0 + (bb + 0.5) * sc;
        let y = 0, th = 0, tk = 0, hl = 0, br = 0, ymax = 0;
        for (const [g, w] of GL3) {
            familyDensity(family, xs, ys, z0 + hz * (0.5 + 0.5 * g), _d);
            y += _d.young * w; th += _d.thin * w; tk += _d.thick * w; hl += _d.halo * w; br += _d.bar * w;
            if (_d.young > ymax) ymax = _d.young;
        }
        _w[o] = y * subVol * nuY; _w[o + 1] = th * subVol * nuO; _w[o + 2] = tk * subVol * nuO;
        _w[o + 3] = hl * subVol * nuO; _w[o + 4] = br * subVol * nuO; _w[o + 5] = ymax;
        for (let q = 0; q < 5; q++) tot[q] += _w[o + q];
    }
    const rng = makeRNG(hashInts(seed, SALT, family, b, i, j, k));
    const counts = tot.map(m => samplePoisson(rng, m));
    const n = counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
    if (!n) return out;
    const rec = new Float32Array(n * REC);
    const [mLo] = binMagRange(b);
    const samplesY = LF_SAMPLES.young[b], samplesO = LF_SAMPLES.old[b];
    let kept = 0;
    for (let comp = 0; comp < 5; comp++) {
        for (let s = 0; s < counts[comp]; s++) {
            // sub-cell by weight
            let u = rng() * tot[comp], cell = 0;
            for (; cell < NSUB * NSUB - 1; cell++) { u -= _w[cell * 6 + comp]; if (u <= 0) break; }
            const cx = x0 + Math.floor(cell / NSUB) * sc, cy = y0 + (cell % NSUB) * sc;
            let x = cx + rng() * sc, y = cy + rng() * sc, z;
            if (comp === SUB_YOUNG) {
                const bound = _w[cell * 6 + 5] * 3 + 1e-30;
                for (let tries = 0; tries < 24; tries++) {
                    z = sampleExpZ(rng(), z0, z1, HZ_OF[0]);
                    familyDensity(family, x, y, z, _d);
                    if (rng() * bound <= _d.young) break;
                    x = cx + rng() * sc; y = cy + rng() * sc;
                }
                // the star clusters of the diffuse light (below the maps' texel)
                snapToClusters(rng, x, y, z, _snap);
                x = _snap[0]; y = _snap[1]; z = _snap[2];
            } else if (comp <= SUB_THICK) z = sampleExpZ(rng(), z0, z1, HZ_OF[comp]);
            else z = z0 + rng() * hz;
            const samples = comp === SUB_YOUNG ? samplesY : samplesO;
            const smp = samples.length ? samples[Math.floor(rng() * samples.length)] : [5800, 4, 0];
            const M = mLo + rng() * LF_M_STEP;
            const cls = smp[2] ? -1 - smp[1] : smp[1];
            const u1 = rng(), u2 = rng();
            if (sun && catalogMagLimit !== null) {
                // left to the catalogs (never drawn by the field from any camera)
                const sx = x - sun[0], sy = y - sun[1], sz = z - sun[2];
                const dSun2 = Math.max(sx * sx + sy * sy + sz * sz, 1e-12);
                const mSun = M + 2.5 * Math.log10(dSun2 / 100) + pathExtinctionV(sun[0], sun[1], sun[2], x, y, z);
                if (u1 < catalogCompleteness(cls, Math.sqrt(dSun2), mSun, catalogMagLimit)) continue;
            }
            const o = kept * REC;
            rec[o + R_X] = x - x0; rec[o + R_Y] = y - y0; rec[o + R_Z] = z - z0;
            rec[o + R_M] = M;
            rec[o + R_TEFF] = smp[0];
            rec[o + R_CLS] = cls;
            rec[o + R_SUB] = comp;
            rec[o + R_U1] = u1;
            rec[o + R_U2] = u2;
            kept++;
        }
    }
    out.n = kept;
    out.rec = kept === n ? rec : rec.slice(0, kept * REC);
    out.drawn = n;
    return out;
}

// Boxes of bin b that intersect the sphere (cx, cy, cz, r) in frame pc.
export function boxesAround(b, cx, cy, cz, r, out = []) {
    out.length = 0;
    const c = binBoxPc(b);
    const ze = zEdgesFor(c);
    const i0 = Math.floor(Math.max(cx - r, -XY_FIELD_MAX) / c), i1 = Math.floor(Math.min(cx + r, XY_FIELD_MAX) / c);
    const j0 = Math.floor(Math.max(cy - r, -XY_FIELD_MAX) / c), j1 = Math.floor(Math.min(cy + r, XY_FIELD_MAX) / c);
    const zLo = Math.max(cz - r, -Z_FIELD_MAX), zHi = Math.min(cz + r, Z_FIELD_MAX);
    if (zLo >= zHi || i0 > i1 || j0 > j1) return out;
    // first/last z box overlapping [zLo, zHi]
    let k0 = 0;
    while (k0 + 1 < ze.length - 1 && ze[k0 + 1] <= zLo) k0++;
    let k1 = k0;
    while (k1 + 1 < ze.length - 1 && ze[k1 + 1] < zHi) k1++;
    for (let i = i0; i <= i1; i++) {
        const dx = Math.max(i * c - cx, 0, cx - (i + 1) * c);
        for (let j = j0; j <= j1; j++) {
            const dy = Math.max(j * c - cy, 0, cy - (j + 1) * c);
            const dxy2 = dx * dx + dy * dy;
            if (dxy2 > r * r) continue;
            for (let k = k0; k <= k1; k++) {
                const dz = Math.max(ze[k] - cz, 0, cz - ze[k + 1]);
                if (dxy2 + dz * dz <= r * r) out.push(i, j, k);
            }
        }
    }
    return out;
}

// --- Extinction ---------------------------------------------------------------
// V-band extinction (mag) along a straight path between two frame points,
// from the smooth part of galaxyModel's dust law: exponential in R and |z|,
// the gas-poor bar hole, and the era factor. The |z| integral is exact; the
// radial factor is taken at the path midpoint.
export function pathExtinctionV(ax, ay, az, bx, by, bz, dustScale = 1) {
    const d = Math.hypot(bx - ax, by - ay, bz - az);
    if (d < 1e-9) return 0;
    const Rm = Math.hypot(0.5 * (ax + bx), 0.5 * (ay + by));
    const h = MW.hzDust;
    const hole = smooth(MW.dustHoleR * 0.45, MW.dustHoleR, Rm);
    const kR = MW.kappaSun * Math.exp(-(Rm - MW.R0) / MW.hrDust) * hole * dustScale;
    const dz = bz - az;
    let zCol;
    if (Math.abs(dz) < 1e-6 * d + 1e-9) zCol = d * Math.exp(-Math.abs(0.5 * (az + bz)) / h);
    else zCol = d * (zPrim(bz, h) - zPrim(az, h)) / dz;
    return 1.0857362047581294 * kR * zCol;
}
function zPrim(z, h) { return Math.sign(z) * h * (1 - Math.exp(-Math.abs(z) / h)); }
function smooth(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

const CLASS_REACH_PC = 1000;
// Fraction of stars of this kind at this brightness the real catalogs hold:
// the class/distance completeness galaxy.js's active tier uses (dwarfs), or
// the catalogs' magnitude reach from the Sun (Tycho-based AT-HYG ~V 11,
// HYG alone ~V 8), whichever is larger.
export function catalogCompleteness(clsCode, dSunPc, mSunV, catalogMagLimit) {
    const giant = clsCode < 0;
    const cls = CLASS_LETTERS[giant ? -1 - clsCode : clsCode] || "G";
    // The class model is a volume-completeness statement for nearby dwarfs;
    // past 1 kpc the magnitude reach alone decides.
    const byClass = giant || dSunPc > CLASS_REACH_PC ? 0 : completeness(cls, dSunPc);
    const byMag = 1 - smooth(catalogMagLimit - 0.5, catalogMagLimit + 1, mSunV);
    return Math.max(byClass, byMag);
}

// --- Selection -------------------------------------------------------------
// Parameters (frame pc): cam, sun, active (or null) + activeR, era factors,
// catalog reach. Appends selected stars of one box to the output arrays:
// position relative to `ref`, V absolute magnitude INCLUDING extinction to the
// camera (so the shader's distance modulus gives the observed magnitude), Teff.
export function selectBox(box, p, out) {
    const { rec, n, ox, oy, oz } = box;
    if (!n) return 0;
    const cam = p.cam, sun = p.sun, act = p.active;
    const mLim = p.magLimit ?? RESOLVED_MAG_LIMIT, dispLim = p.displayLimit ?? DISPLAY_MAG_LIMIT;
    const actR2 = act ? p.activeR * p.activeR : 0;
    const youngKeep = (p.sfr ?? 1) * (p.keep ?? 1), thinKeep = p.keep ?? 1;
    const dust = (0.25 + 0.75 * (p.sfr ?? 1)) * (p.keep ?? 1);
    let added = 0;
    for (let s = 0; s < n; s++) {
        const o = s * REC;
        const sub = rec[o + R_SUB];
        if (sub === SUB_YOUNG ? rec[o + R_U2] >= youngKeep : sub === SUB_THIN && rec[o + R_U2] >= thinKeep) continue;
        const x = ox + rec[o + R_X], y = oy + rec[o + R_Y], z = oz + rec[o + R_Z];
        const dx = x - cam[0], dy = y - cam[1], dz = z - cam[2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (!(d2 > 1e-12)) continue;
        const M = rec[o + R_M];
        const mu = 2.5 * Math.log10(d2 / 100);           // 5 log10(d / 10 pc)
        if (M + mu >= mLim) continue;                     // unresolved even without dust
        if (act) {
            const ax = x - act[0], ay = y - act[1], az = z - act[2];
            if (ax * ax + ay * ay + az * az < actR2) continue;   // active tier supplies it
        }
        // The partition is in OBSERVED magnitude: a star dimmed past the
        // limit by dust is part of the volume's (equally dimmed) light.
        const aCam = pathExtinctionV(cam[0], cam[1], cam[2], x, y, z, dust);
        if (M + mu + aCam >= Math.min(mLim, dispLim)) continue;
        const i = out.n;
        if (i >= out.capacity) growOut(out);
        out.pos[i * 3] = x - p.ref[0]; out.pos[i * 3 + 1] = y - p.ref[1]; out.pos[i * 3 + 2] = z - p.ref[2];
        out.absMag[i] = M + aCam;
        out.teff[i] = rec[o + R_TEFF];
        out.n = i + 1;
        added++;
    }
    return added;
}

export function makeSelectionOut(capacity = 4096) {
    return { n: 0, capacity, pos: new Float32Array(capacity * 3), absMag: new Float32Array(capacity), teff: new Float32Array(capacity) };
}
function growOut(out) {
    const cap = out.capacity * 2;
    const pos = new Float32Array(cap * 3); pos.set(out.pos);
    const absMag = new Float32Array(cap); absMag.set(out.absMag);
    const teff = new Float32Array(cap); teff.set(out.teff);
    out.pos = pos; out.absMag = absMag; out.teff = teff; out.capacity = cap;
}

// --- Box cache + one-call bin builder -------------------------------------------
export function createFieldCache(maxStars = 6e6) {
    return { map: new Map(), stars: 0, maxStars, tick: 0 };
}
// The catalog cut is applied at generation for the Sun of that moment, so
// boxes are keyed by the Sun's position on a SUN_KEY_PC grid (only boxes the
// catalogs can reach depend on it) and by the catalogs' magnitude reach.
const SUN_KEY_PC = 25;
function cachedBox(cache, seed, family, b, i, j, k, sun, catLim) {
    const c = binBoxPc(b);
    const bx = (i + 0.5) * c - sun[0], by = (j + 0.5) * c - sun[1];
    const reach = Math.max(binRadiusPc(b, catLim + 1.5), CLASS_REACH_PC) + c;
    const sunKey = bx * bx + by * by < reach * reach
        ? Math.round(sun[0] / SUN_KEY_PC) + "," + Math.round(sun[1] / SUN_KEY_PC) + "," + Math.round(sun[2] / SUN_KEY_PC) + "," + catLim
        : "-";
    const key = seed + ":" + family + ":" + b + ":" + i + ":" + j + ":" + k + ":" + sunKey;
    let e = cache.map.get(key);
    if (e) { e.t = ++cache.tick; return e.box; }
    const sunQ = sunKey === "-" ? null : [Math.round(sun[0] / SUN_KEY_PC) * SUN_KEY_PC, Math.round(sun[1] / SUN_KEY_PC) * SUN_KEY_PC, Math.round(sun[2] / SUN_KEY_PC) * SUN_KEY_PC];
    const box = generateBox(seed, family, b, i, j, k, sunQ, catLim);
    cache.map.set(key, { box, t: ++cache.tick });
    cache.stars += box.n;
    return box;
}
export function trimFieldCache(cache) {
    if (cache.stars <= cache.maxStars) return;
    const entries = [...cache.map.entries()].sort((a, b) => a[1].t - b[1].t);
    for (const [key, e] of entries) {
        if (cache.stars <= cache.maxStars * 0.8) break;
        cache.map.delete(key);
        cache.stars -= e.box.n;
    }
}

// --- Camera-dependent pruning (no box generated that cannot contribute) -----
// Upper bound of a family's light density anywhere in a box: every factor of
// mwSample at its most favourable (inner radius, nearest the plane, arm
// centerline, clump peak, bar core).
// Peak young and old modulation of the structure maps (normalized), times
// the sub-texel clump peak; generous fallbacks before the maps exist.
let _peaks = null;
function mapPeaks() {
    if (_peaks) return _peaks;
    const m = galaxyMaps();
    if (!m) return { young: 30, old: 1.5 };
    let y = 0, o = 0;
    for (let i = 0; i < m.young.length; i++) { if (m.young[i] > y) y = m.young[i]; if (m.old[i] > o) o = m.old[i]; }
    const k = MW.youngClump;
    _peaks = { young: y / m.norm.young * Math.exp(k - 0.5 * k * k * 0.16), old: o / m.norm.old };
    return _peaks;
}
export function densityBound(family, x0, y0, z0, c, hz) {
    const rMin = Math.max(0, Math.hypot(Math.max(0, Math.abs(x0 + c / 2) - c / 2), Math.max(0, Math.abs(y0 + c / 2) - c / 2)));
    const zMin = z0 > 0 ? z0 : z0 + hz < 0 ? -(z0 + hz) : 0;
    const j0 = MW.jSun;
    if (family === FAMILY_BAR) {
        // bulge: exp(-|q|) with |q| >= the nearest point scaled by the longest
        // axis; long bar: its value on the major axis at that radius
        const q = Math.max(0, Math.hypot(rMin / MW.barA, zMin / MW.barC));
        return BAR_NORM.bulge * Math.exp(-q) + BAR_NORM.long * Math.exp(-Math.pow(rMin / MW.longBarL, 4)) * Math.exp(-zMin / MW.longBarZ);
    }
    const pk = mapPeaks();
    const dr = rMin - MW.R0;
    const young = j0 * MW.fYoung * Math.exp(-dr / MW.hrThin) * Math.exp(-zMin / MW.hzYoung) * pk.young;
    const thin = j0 * MW.fThin * Math.exp(-dr / MW.hrThin) * Math.exp(-zMin / MW.hzThin) * pk.old;
    const thick = j0 * MW.fThick * Math.exp(-dr / MW.hrThick) * Math.exp(-zMin / MW.hzThick);
    const rEff = Math.hypot(rMin, zMin / MW.haloQ);
    const halo = j0 * MW.fHalo * Math.pow(MW.R0 / Math.max(rEff, 300), MW.haloN);
    // the Central Molecular Zone's ring (galaxyModel cmzRing, any bar angle)
    const cmz = rMin < MW.cmzR + 4 * MW.cmzW ? j0 * MW.fYoung * MW.cmzYoung * Math.exp(-zMin / MW.cmzZ) : 0;
    return { young: young + cmz, old: thin + thick + halo };
}

const _boxes = [];
// All selected stars of bin b / family for the camera parameters p. Boxes are
// skipped (never generated) when, seen from this camera, every star they could
// hold is (a) fainter than the display limit even with the least extinction
// the box allows, (b) already in the catalogs, or (c) so improbable that the
// box is almost surely empty.
export function buildBin(cache, seed, family, b, p, out = makeSelectionOut(), stats = null) {
    out.n = 0;
    if (!binHasStars(b, family)) return out;
    const mLim = p.magLimit ?? RESOLVED_MAG_LIMIT, dispLim = p.displayLimit ?? DISPLAY_MAG_LIMIT;
    const catLim = p.catalogMagLimit ?? 11;
    const r = binRadiusPc(b, mLim);
    const c = binBoxPc(b), ze = zEdgesFor(c);
    const maxStars = p.maxStars ?? Infinity;
    const [mLo, mHi] = binMagRange(b);
    const nuY = family === FAMILY_BAR ? 0 : LF_NU.young[b], nuO = LF_NU.old[b];
    const cam = p.cam, sun = p.sun;
    const dust = (0.25 + 0.75 * (p.sfr ?? 1)) * (p.keep ?? 1);
    boxesAround(b, cam[0], cam[1], cam[2], r, _boxes);
    for (let q = 0; q < _boxes.length && out.n <= maxStars; q += 3) {
        const i = _boxes[q], j = _boxes[q + 1], k = _boxes[q + 2];
        const x0 = i * c, y0 = j * c, z0 = ze[k], hz = ze[k + 1] - z0;
        // (c) expected count bound
        const bound = densityBound(family, x0, y0, z0, c, hz);
        const nMax = family === FAMILY_BAR ? bound * nuO * c * c * hz : (bound.young * nuY + bound.old * nuO) * c * c * hz;
        if (nMax < 2e-3) { if (stats) stats.skipEmpty++; continue; }
        // nearest box point to the camera
        const nx = Math.min(Math.max(cam[0], x0), x0 + c), ny = Math.min(Math.max(cam[1], y0), y0 + c), nz = Math.min(Math.max(cam[2], z0), z0 + hz);
        const dMin2 = Math.max((nx - cam[0]) ** 2 + (ny - cam[1]) ** 2 + (nz - cam[2]) ** 2, 1e-6);
        // (a) resolve limit in observed magnitude: brightest star, nearest
        // point, 60% of that path's dust
        const aMin = 0.6 * pathExtinctionV(cam[0], cam[1], cam[2], nx, ny, nz, dust);
        if (mLo + 2.5 * Math.log10(dMin2 / 100) + aMin > Math.min(mLim, dispLim)) { if (stats) stats.skipDust++; continue; }
        // (b) catalogs: the faintest star at the box's farthest point from the
        // Sun, with generous dust, is still inside the catalogs' magnitude reach
        const fx = Math.abs(sun[0] - x0) > Math.abs(sun[0] - x0 - c) ? x0 : x0 + c;
        const fy = Math.abs(sun[1] - y0) > Math.abs(sun[1] - y0 - c) ? y0 : y0 + c;
        const fz = Math.abs(sun[2] - z0) > Math.abs(sun[2] - z0 - hz) ? z0 : z0 + hz;
        const dFar2 = (fx - sun[0]) ** 2 + (fy - sun[1]) ** 2 + (fz - sun[2]) ** 2;
        if (mHi + 2.5 * Math.log10(Math.max(dFar2, 1e-6) / 100) + 1.5 * pathExtinctionV(sun[0], sun[1], sun[2], fx, fy, fz, dust) < catLim - 0.5) {
            if (stats) stats.skipCatalog++;
            continue;
        }
        if (stats) stats.boxes++;
        selectBox(cachedBox(cache, seed, family, b, i, j, k, sun, catLim), p, out);
    }
    return out;
}
export const FIELD_BINS = LF_NBIN;
