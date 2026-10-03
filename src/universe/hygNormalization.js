import { ensureWorldFrameRecords } from "./coords.js";
import { msAbsMagFromColor } from "./mainSequenceCM.js";

// Every consumer of the shared HYG values sees WORLD-frame (ecliptic J2000)
// positions: the rotation happens once here (ensureWorldFrameRecords tags
// meta.frame so the shared values are never rotated twice).
export function normalizeHygCatalog(meta, vals) {
    const fields = meta?.fields || [];
    const stride = meta?.stride || fields.length || 10;
    const ix = fields.indexOf("xPc"), iy = fields.indexOf("yPc"), iz = fields.indexOf("zPc");
    ensureWorldFrameRecords(meta, vals, stride, ix >= 0 ? ix : 0, iy >= 0 ? iy : 1, iz >= 0 ? iz : 2);
    repairPlaceholderDistances(meta, vals);
    return vals;
}

// HYG v4.1 marks stars without a valid parallax with dist = 100000 pc. Left
// there they are ~10,000 "hypergiants" (absolute V ~ -9 to -11, derived from
// the placeholder distance) on a 100 kpc shell around the Sun: invisible as
// such from the Solar System, where only direction and apparent magnitude
// matter, but a ring of false stars around the Galaxy from anywhere else.
// They get a photometric distance instead: the main-sequence distance from
// their colour (mainSequenceCM.js, as for the flagged AT-HYG sidecar rows),
// but no nearer than 500 pc -- a star Hipparcos could not measure a
// parallax for (sigma ~1 mas) is not a nearby dwarf, and the red ones are
// mostly giants. Sky position and apparent magnitude are kept; absolute
// magnitude, luminosity, mass and radius are re-derived from the distance.
// Tagged on the meta so the shared values are repaired once.
export const HYG_PLACEHOLDER_PC = 99990;
const HYG_NO_PARALLAX_MIN_PC = 500;
export function repairPlaceholderDistances(meta, vals) {
    if (!meta || !vals || meta.placeholderDistancesRepaired !== undefined) return 0;
    const fields = meta.fields || [];
    const stride = meta.stride || fields.length || 10;
    const at = name => fields.indexOf(name);
    const ix = at("xPc"), iy = at("yPc"), iz = at("zPc"), imag = at("mag"), ibv = at("bv");
    const iabs = at("absMag"), ilum = at("lumSolar"), iT = at("tempK"), imass = at("massSolar"), irad = at("radiusSolar");
    if (ix < 0 || iy < 0 || iz < 0 || imag < 0 || ibv < 0) { meta.photometricDistanceRows = []; meta.placeholderDistancesRepaired = 0; return 0; }
    let n = 0;
    const estimatedRows = [];
    for (let j = 0; j + stride <= vals.length; j += stride) {
        const x = vals[j + ix], y = vals[j + iy], z = vals[j + iz];
        const d = Math.hypot(x, y, z);
        if (!(d >= HYG_PLACEHOLDER_PC)) continue;
        const mag = vals[j + imag];
        const dPc = Math.max(HYG_NO_PARALLAX_MIN_PC, Math.pow(10, (mag - msAbsMagFromColor(vals[j + ibv]) + 5) / 5));
        const k = dPc / d;
        vals[j + ix] = x * k; vals[j + iy] = y * k; vals[j + iz] = z * k;
        const M = mag - 5 * Math.log10(dPc / 10);
        const L = Math.pow(10, -0.4 * (M - 4.83));
        if (iabs >= 0) vals[j + iabs] = M;
        if (ilum >= 0) vals[j + ilum] = L;
        if (imass >= 0) vals[j + imass] = Math.min(30, Math.max(0.1, Math.pow(L, 0.25)));   // coarse prior
        if (irad >= 0 && iT >= 0 && vals[j + iT] > 0) {
            const t = 5772 / vals[j + iT];
            vals[j + irad] = Math.sqrt(L) * t * t;                       // Stefan-Boltzmann
        }
        estimatedRows.push(j / stride);
        n++;
    }
    meta.photometricDistanceRows = estimatedRows;
    meta.placeholderDistancesRepaired = n;
    return n;
}

const estimateCache = new WeakMap();
export function isPhotometricCatalogRow(meta, index) {
    if (!meta) return false;
    const rows = meta.photometricDistanceRows || [];
    let cached = estimateCache.get(meta);
    if (!cached || cached.rows !== rows) {
        cached = { rows, indices: new Set(rows) };
        estimateCache.set(meta, cached);
    }
    return cached.indices.has(index);
}
