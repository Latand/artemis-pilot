// Observational galaxy catalogs: decoders and loaders.
//
//   public/data/local-volume.json   Local Volume, ~11 Mpc: UNGC (Karachentsev,
//                                   Makarov & Kaisina 2013) with McConnachie
//                                   (2012) Local Group values. MEASURED distances.
//   public/data/2mrs.bin (+ 2mrs-manifest.json)
//                                   2MASS Redshift Survey (Huchra et al. 2012),
//                                   43.5k galaxies. REDSHIFT-SPACE distances.
//
// Built by scripts/build-galaxy-catalogs.mjs; provenance, caveats and required
// citations: docs/data/galaxy-catalogs.md.
//
// Pure module: no THREE, no DOM, no imports. The decoders take already-loaded
// data (so Node smokes can hand in fs buffers); the async loaders use fetch()
// with the app's convention of serving public/ at the site root.
//
// FRAME: everything here is ICRS/J2000 EQUATORIAL — unit vectors point
// x -> (RA 0, Dec 0), y -> (RA 90, Dec 0), z -> north celestial pole, the same
// equatorial convention as src/universe/coords.js. The runtime's world frame
// may differ (coords.js defines an ecliptic-J2000 world frame): rotate with
// coords.js equatorialToWorldInto() before placing objects in the scene.

export const LOCAL_VOLUME_PATH = "/data/local-volume.json";
export const TWOMRS_MANIFEST_PATH = "/data/2mrs-manifest.json";
export const CATALOG_FRAME = "equatorial-j2000";
export const MK_SUN = 3.28;   // solar absolute Ks magnitude (Binney & Merrifield 1998)
export const MB_SUN = 5.48;   // solar absolute B magnitude (Binney & Merrifield 1998)
export const MV_SUN = 4.83;   // solar absolute V magnitude (repo convention)

const DEG = Math.PI / 180;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Equatorial (ICRS/J2000) unit vector for a right ascension / declination.
 * @param {number} raDeg
 * @param {number} decDeg
 * @param {number[]|Float64Array|Float32Array} [out] receives x, y, z at [o..o+2]
 * @param {number} [o=0] offset into out
 * @returns the out array
 */
export function equatorialUnitVector(raDeg, decDeg, out = [0, 0, 0], o = 0) {
    const ra = raDeg * DEG, dec = decDeg * DEG, cd = Math.cos(dec);
    out[o] = cd * Math.cos(ra);
    out[o + 1] = cd * Math.sin(ra);
    out[o + 2] = Math.sin(dec);
    return out;
}

/**
 * Decode public/data/local-volume.json (object or JSON text).
 *
 * Returns an array (sorted by distance) of plain objects carrying every field
 * listed in json.fields — name, displayName, altNames, raDeg, decDeg (deg,
 * J2000), distMpc, distErrMpc (Mpc), distMethod, distQuality (1 best .. 3),
 * distSource, type (T-type), morph, MB (mag), LB (L_sun,B), MV (mag), lum
 * (L_sun in lumBand), lumBand ("V"|"B"), logLK (log10 L_sun,K), diamKpc (kpc),
 * a26Arcmin, ba, inclDeg, paDeg (deg E of N), paSource, hrv, vLG (km/s),
 * tidalIndex, mainDisturber, source ("UNGC"|"UNGC+M12"|"M12"), derived —
 * missing values are null. Each object also gets:
 *   index        its row index (what 2MRS lvIndex points at)
 *   ex, ey, ez   equatorial unit vector
 *   measured     true (observational catalog object, not procedural)
 *   distanceKind "measured"
 * The header (citations, units, field notes, exclusions) is attached to the
 * returned array as the non-enumerable property `meta`.
 */
export function decodeLocalVolume(json) {
    const doc = typeof json === "string" ? JSON.parse(json) : json;
    if (!doc || !Array.isArray(doc.fields) || !Array.isArray(doc.rows)) {
        throw new Error("local-volume: expected { fields: [...], rows: [[...]] }");
    }
    if (doc.schema !== 1) throw new Error("local-volume: unsupported schema " + doc.schema);
    const fields = doc.fields;
    const nf = fields.length;
    const out = new Array(doc.rows.length);
    const u = [0, 0, 0];
    for (let i = 0; i < doc.rows.length; i++) {
        const row = doc.rows[i];
        if (!Array.isArray(row) || row.length !== nf) throw new Error(`local-volume: row ${i} has ${row?.length} values, expected ${nf}`);
        const g = { index: i };
        for (let f = 0; f < nf; f++) g[fields[f]] = row[f];
        equatorialUnitVector(g.raDeg, g.decDeg, u);
        g.ex = u[0]; g.ey = u[1]; g.ez = u[2];
        g.measured = true;
        g.distanceKind = "measured";
        out[i] = g;
    }
    const { rows, ...meta } = doc;
    Object.defineProperty(out, "meta", { value: meta, enumerable: false });
    return out;
}

function float32Column(bytes, byteOffset, count) {
    const abs = bytes.byteOffset + byteOffset;
    if (LITTLE_ENDIAN && abs % 4 === 0) return new Float32Array(bytes.buffer, abs, count);
    const dv = new DataView(bytes.buffer, abs, count * 4);
    const col = new Float32Array(count);
    for (let i = 0; i < count; i++) col[i] = dv.getFloat32(i * 4, true);
    return col;
}

/**
 * Decode public/data/2mrs.bin with its manifest (public/data/2mrs-manifest.json).
 * @param {ArrayBuffer|ArrayBufferView} arrayBuffer the binary (a Node Buffer works)
 * @param {object} manifest the parsed manifest JSON
 * @returns struct-of-arrays, one entry per galaxy (row order = 2MRS table order):
 *   count
 *   raDeg, decDeg   Float32Array  deg, ICRS/J2000
 *   distMpc         Float32Array  Mpc, redshift-space Hubble-flow distance vCmb/H0
 *                                 (vCmb floored at manifest.cosmology.vFloorKms)
 *   cz              Float32Array  km/s, heliocentric (barycentric) c*z as published
 *   vCmb            Float32Array  km/s, CMB-frame c*z (Planck 2018 dipole)
 *   KsMag           Float32Array  mag, 2MASS Ks total, extinction corrected
 *   type            Float32Array  ZCAT T-type code, NaN = none (manifest.typeCodes)
 *   ba              Float32Array  axis ratio b/a
 *   pa              Float32Array  deg E of N in [0, 180), NaN = unavailable
 *   lvIndex         Int32Array    row of the duplicate in local-volume.json, -1 = none
 *                                 (prefer that row's measured distance / skip this one)
 *   ex, ey, ez      Float64Array  equatorial unit vector
 *   LK              Float64Array  L_sun,K from KsMag and distMpc (M_K,sun = 3.28)
 *   distanceKind    "redshift"
 *   frame           "equatorial-j2000"
 *   H0              km/s/Mpc used for distMpc
 *   manifest        the manifest object
 * The Float32 columns are zero-copy views when the buffer allows it.
 */
export function decode2mrs(arrayBuffer, manifest) {
    if (!manifest || manifest.schema !== 1 || manifest.layout !== "columnar" || !Array.isArray(manifest.fields)) {
        throw new Error("2mrs: unsupported manifest (expected schema 1, columnar layout)");
    }
    const bytes = ArrayBuffer.isView(arrayBuffer)
        ? new Uint8Array(arrayBuffer.buffer, arrayBuffer.byteOffset, arrayBuffer.byteLength)
        : new Uint8Array(arrayBuffer);
    const count = manifest.count;
    if (!(count > 0) || bytes.byteLength !== manifest.byteLength || bytes.byteLength !== manifest.fields.length * count * 4) {
        throw new Error(`2mrs: binary is ${bytes.byteLength} bytes, manifest expects ${manifest.byteLength} (${manifest.fields.length} fields x ${count})`);
    }
    const cols = {};
    for (const f of manifest.fields) {
        if (f.byteOffset + count * 4 > bytes.byteLength) throw new Error(`2mrs: field ${f.name} overruns the binary`);
        cols[f.name] = float32Column(bytes, f.byteOffset, count);
    }
    for (const need of ["raDeg", "decDeg", "distMpc", "cz", "vCmb", "KsMag", "type", "ba", "pa", "lvIndex"]) {
        if (!cols[need]) throw new Error(`2mrs: manifest lacks field ${need}`);
    }
    const lvIndex = new Int32Array(count);
    const ex = new Float64Array(count), ey = new Float64Array(count), ez = new Float64Array(count);
    const LK = new Float64Array(count);
    const u = [0, 0, 0];
    const { raDeg, decDeg, distMpc, KsMag } = cols;
    for (let i = 0; i < count; i++) {
        lvIndex[i] = cols.lvIndex[i];
        equatorialUnitVector(raDeg[i], decDeg[i], u);
        ex[i] = u[0]; ey[i] = u[1]; ez[i] = u[2];
        // M_K = Ks - 5 log10(D / 10 pc) with D in Mpc -> 5 log10(D * 1e5)
        LK[i] = Math.pow(10, -0.4 * (KsMag[i] - 5 * Math.log10(distMpc[i] * 1e5) - MK_SUN));
    }
    return {
        count,
        raDeg, decDeg, distMpc,
        cz: cols.cz, vCmb: cols.vCmb, KsMag,
        type: cols.type, ba: cols.ba, pa: cols.pa,
        lvIndex, ex, ey, ez, LK,
        distanceKind: manifest.distanceKind || "redshift",
        frame: CATALOG_FRAME,
        H0: manifest.cosmology?.H0 ?? null,
        manifest,
    };
}

// --- Browser loaders ---------------------------------------------------------
// Memoised per URL (a failed load is forgotten so a retry can succeed).
const loads = new Map();

function dataUrl(baseUrl, path) {
    return String(baseUrl ?? "").replace(/\/+$/, "") + path;
}

function memo(key, factory) {
    if (!loads.has(key)) {
        const p = factory();
        loads.set(key, p);
        p.catch(() => loads.delete(key));
    }
    return loads.get(key);
}

async function fetchOk(url, fetchImpl) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res;
}

/**
 * Fetch and decode the Local Volume catalog.
 * @param {string} [baseUrl=""] prefix for the site root ("" serves /data/... )
 * @param {{fetch?: typeof fetch}} [opts]
 * @returns {Promise<object[]>} decodeLocalVolume() result
 */
export function loadLocalVolume(baseUrl = "", opts = {}) {
    const fetchImpl = opts.fetch || globalThis.fetch;
    const url = dataUrl(baseUrl, LOCAL_VOLUME_PATH);
    return memo("lv " + url, async () => decodeLocalVolume(await (await fetchOk(url, fetchImpl)).json()));
}

/**
 * Fetch and decode the 2MRS catalog (manifest, then the binary it names).
 * @param {string} [baseUrl=""] prefix for the site root ("" serves /data/... )
 * @param {{fetch?: typeof fetch}} [opts]
 * @returns {Promise<object>} decode2mrs() result
 */
export function load2mrs(baseUrl = "", opts = {}) {
    const fetchImpl = opts.fetch || globalThis.fetch;
    const manifestUrl = dataUrl(baseUrl, TWOMRS_MANIFEST_PATH);
    return memo("2mrs " + manifestUrl, async () => {
        const manifest = await (await fetchOk(manifestUrl, fetchImpl)).json();
        const binUrl = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1) + manifest.binary;
        const buf = await (await fetchOk(binUrl, fetchImpl)).arrayBuffer();
        return decode2mrs(buf, manifest);
    });
}
