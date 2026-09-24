#!/usr/bin/env node
/**
 * Build the observational galaxy catalogs used for the data-driven large-scale
 * universe (runtime decoder: src/universe/galaxyCatalogs.js; provenance notes:
 * docs/data/galaxy-catalogs.md).
 *
 * Inputs (downloaded once, cached raw under cache/galaxy-catalogs/, gitignored):
 *   - Updated Nearby Galaxy Catalog, UNGC (Karachentsev, Makarov & Kaisina 2013,
 *     AJ 145, 101; VizieR J/AJ/145/101): ReadMe, table1.dat, table2.dat, table6.dat
 *   - McConnachie 2012 (AJ 144, 4; VizieR J/AJ/144/4) Local Group dwarfs:
 *     ReadMe, table1.dat, table2.dat, table3.dat
 *   - 2MASS Redshift Survey, 2MRS (Huchra et al. 2012, ApJS 199, 26; VizieR
 *     J/ApJS/199/26): ReadMe, table3.dat.gz (main catalog, 44,599 galaxies)
 *   - 2MASS XSC (VizieR VII/233/xsc) super-coadd position angles for the 2MRS
 *     galaxies (2MRS itself ships b/a but no position angle), fetched as small
 *     RA-sliced VizieR ASU-TSV queries.
 *
 * Fixed-width files are decoded from their own ReadMe "Byte-by-byte" layouts
 * (labels, byte ranges and "?=" null sentinels are parsed, not hand-copied), and
 * each data file's row count is checked against the ReadMe "File Summary".
 *
 * Outputs:
 *   public/data/local-volume.json   compact JSON: header (citations, license
 *                                   note, fields + units) and rows-as-arrays
 *   public/data/2mrs.bin            columnar Float32 little-endian
 *   public/data/2mrs-manifest.json  fields, units, byte offsets, cosmology,
 *                                   caveats, citation, usage note
 *
 * Usage:  node scripts/build-galaxy-catalogs.mjs [--offline] [--refresh]
 *   --offline  never touch the network (fails if a cached input is missing)
 *   --refresh  re-download every input even if cached
 * Output is a pure function of the cached inputs (no wall-clock data), so
 * re-running from cache is byte-identical. If Node's fetch ignores your HTTPS
 * proxy, run with NODE_USE_ENV_PROXY=1 (Node >= 22.21).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const ROOT = new URL("../", import.meta.url);
const CACHE_DIR = new URL("cache/galaxy-catalogs/", ROOT);
const OUT_DIR = new URL("public/data/", ROOT);
const OUT_LV = new URL("local-volume.json", OUT_DIR);
const OUT_2MRS_BIN = new URL("2mrs.bin", OUT_DIR);
const OUT_2MRS_MANIFEST = new URL("2mrs-manifest.json", OUT_DIR);
const RETRIEVED_PATH = new URL("retrieved.json", CACHE_DIR);

const args = new Set(process.argv.slice(2));
const OFFLINE = args.has("--offline") || process.env.GALCAT_OFFLINE === "1";
const REFRESH = args.has("--refresh") || process.env.GALCAT_REFRESH === "1";

const CDS_FTP = "https://cdsarc.cds.unistra.fr/ftp/";
const VIZIER_ASU_TSV = "https://vizier.cds.unistra.fr/viz-bin/asu-tsv";

// --- Physical constants and conventions -----------------------------------
const C_KMS = 299792.458;
// Planck 2018 (Planck Collaboration VI 2020, A&A 641, A6) — the same value the
// app uses in src/constants.js DARK_ENERGY.H0_KM_S_MPC (smoke checks for drift).
const H0 = 67.66;
// Solar-system barycentre velocity w.r.t. the CMB: Planck 2018 I (Planck
// Collaboration I 2020, A&A 641, A1): 369.82 +/- 0.11 km/s toward
// (l, b) = (264.021 +/- 0.011, 48.253 +/- 0.005) deg.
const CMB_DIPOLE = { vKms: 369.82, lDeg: 264.021, bDeg: 48.253 };
// Solar absolute magnitudes: B = 5.48 and K = 3.28 (Binney & Merrifield 1998;
// K = 3.28 is also what UNGC used for its logL_K), V = 4.83 (as used across
// this repo, e.g. scripts/build-hyg-catalog.mjs SOLAR_ABS_MAG).
const MB_SUN = 5.48;
const MV_SUN = 4.83;
const MK_SUN = 3.28;
// 2MRS rows whose CMB-frame velocity is below this floor get distMpc =
// V_FLOOR/H0: their redshift distance is meaningless (the peculiar velocity is
// as large as the Hubble flow; several Virgo members even have cz < 0).
const V_FLOOR_KMS = 100;
// LV <-> 2MRS duplicate matching (the brief: v_cmb < 3000 km/s, 2 arcmin).
const DUP_VMAX_KMS = 3000;
const DUP_RADIUS_ARCMIN = 2;
const DUP_NAME_RADIUS_ARCMIN = 15;   // name-confirmed rescue for big galaxies
// ...and the redshifts must agree when the LV galaxy has one (rejects chance
// alignments such as a cz = 2564 km/s galaxy < 2' from the dwarf MCG +08-25-028).
const DUP_MAX_DV_KMS = 400;
// McConnachie values override UNGC for objects within this distance.
const MCC_PREFER_WITHIN_MPC = 3;
const MCC_POS_MATCH_ARCMIN = 10;

const DEG = Math.PI / 180;
// ICRS -> Galactic rotation (ESA 1997, Hipparcos vol. 1, sect. 1.5.3, eq. 1.5.11).
// Rows are the Galactic axes (toward GC, toward l=90, toward NGP) expressed in
// equatorial coordinates; the transpose maps Galactic -> equatorial. Same
// matrix as src/universe/coords.js EQ2GAL, at full published precision.
const A_G = [
    [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
    [+0.4941094278755837, -0.4448296299600112, +0.7469822444972189],
    [-0.8676661490190047, -0.1980763734312015, +0.4559837761750669],
];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
const round = (v, p) => (v === null || v === undefined || !Number.isFinite(v)) ? null : Number(v.toFixed(p));
const sig = (v, s) => (v === null || v === undefined || !Number.isFinite(v)) ? null : Number(v.toPrecision(s));
const isNum = v => typeof v === "number" && Number.isFinite(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function unitVector(raDeg, decDeg) {
    const ra = raDeg * DEG, dec = decDeg * DEG, cd = Math.cos(dec);
    return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)];
}

function galacticToEquatorialDeg(lDeg, bDeg) {
    const l = lDeg * DEG, b = bDeg * DEG, cb = Math.cos(b);
    const g = [cb * Math.cos(l), cb * Math.sin(l), Math.sin(b)];
    const x = A_G[0][0] * g[0] + A_G[1][0] * g[1] + A_G[2][0] * g[2];
    const y = A_G[0][1] * g[0] + A_G[1][1] * g[1] + A_G[2][1] * g[2];
    const z = A_G[0][2] * g[0] + A_G[1][2] * g[1] + A_G[2][2] * g[2];
    let ra = Math.atan2(y, x) / DEG;
    if (ra < 0) ra += 360;
    return { raDeg: ra, decDeg: Math.asin(Math.max(-1, Math.min(1, z))) / DEG, unit: [x, y, z] };
}

function equatorialToGalacticDeg(raDeg, decDeg) {
    const e = unitVector(raDeg, decDeg);
    const gx = A_G[0][0] * e[0] + A_G[0][1] * e[1] + A_G[0][2] * e[2];
    const gy = A_G[1][0] * e[0] + A_G[1][1] * e[1] + A_G[1][2] * e[2];
    const gz = A_G[2][0] * e[0] + A_G[2][1] * e[1] + A_G[2][2] * e[2];
    let l = Math.atan2(gy, gx) / DEG;
    if (l < 0) l += 360;
    return { lDeg: l, bDeg: Math.asin(Math.max(-1, Math.min(1, gz))) / DEG };
}

// Angular separation in arcmin between two unit vectors (numerically stable).
function sepArcmin(a, b) {
    const cx = a[1] * b[2] - a[2] * b[1];
    const cy = a[2] * b[0] - a[0] * b[2];
    const cz = a[0] * b[1] - a[1] * b[0];
    const s = Math.hypot(cx, cy, cz);
    const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return Math.atan2(s, c) / DEG * 60;
}

function sha256(buf) {
    return createHash("sha256").update(buf).digest("hex");
}

function writeAtomic(url, data) {
    const tmp = new URL(url.href + ".part");
    writeFileSync(tmp, data);
    renameSync(tmp, url);
}

// ---------------------------------------------------------------------------
// Cached downloads
// ---------------------------------------------------------------------------
const retrieved = existsSync(RETRIEVED_PATH) ? JSON.parse(readFileSync(RETRIEVED_PATH, "utf8")) : {};
const inputs = [];   // provenance: every raw input actually consumed

async function cachedFetch(url, relPath, validate) {
    const path = new URL(relPath, CACHE_DIR);
    let buf = null;
    if (!REFRESH && existsSync(path) && statSync(path).size > 0) {
        buf = readFileSync(path);
    } else {
        if (OFFLINE) throw new Error(`--offline: missing cached input ${path.pathname} (source ${url})`);
        let lastErr = null;
        for (let attempt = 1; attempt <= 4 && !buf; attempt++) {
            try {
                console.log(`download ${url}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
                const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
                if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
                const got = Buffer.from(await res.arrayBuffer());
                if (validate) validate(got);
                buf = got;
            } catch (err) {
                lastErr = err;
                if (attempt < 4) await sleep(1500 * attempt);
            }
        }
        if (!buf) {
            throw new Error(`failed to download ${url}: ${lastErr?.message || lastErr}` +
                " (behind a proxy? try NODE_USE_ENV_PROXY=1; or place the file at " + path.pathname + ")");
        }
        mkdirSync(new URL("./", path), { recursive: true });
        writeAtomic(path, buf);
        retrieved[relPath] = { url, utc: new Date().toISOString().slice(0, 10) };
        mkdirSync(CACHE_DIR, { recursive: true });
        writeFileSync(RETRIEVED_PATH, JSON.stringify(retrieved, null, 2) + "\n");
    }
    inputs.push({ file: relPath, url, bytes: buf.length, sha256: sha256(buf), retrievedUTC: retrieved[relPath]?.utc ?? null });
    return buf;
}

const mustContain = needle => buf => {
    if (!buf.toString("latin1").includes(needle)) throw new Error(`unexpected content (missing "${needle}")`);
};

// ---------------------------------------------------------------------------
// CDS ReadMe "Byte-by-byte" parser + fixed-width decoder
// ---------------------------------------------------------------------------
function expandCdsFileList(spec) {
    const out = [];
    for (const token of spec.split(/[\s,]+/).filter(Boolean)) {
        const m = token.match(/^(.*)\[([^\]]+)\](.*)$/);
        if (m) for (const ch of m[2]) out.push(m[1] + ch + m[3]);
        else out.push(token);
    }
    return out;
}

function parseCdsReadme(text) {
    const lines = text.split(/\r?\n/);
    const layouts = new Map();
    const records = new Map();
    const fsIdx = lines.findIndex(l => /^File Summary:/.test(l));
    if (fsIdx >= 0) {
        let dashes = 0;
        for (let i = fsIdx + 1; i < lines.length; i++) {
            if (/^-{20,}/.test(lines[i])) { if (++dashes === 3) break; continue; }
            if (dashes < 2) continue;
            const m = lines[i].match(/^\s*(\S+)\s+(\d+)\s+(\d+)\s/);
            if (m) records.set(m[1], Number(m[3]));
        }
    }
    for (let i = 0; i < lines.length; i++) {
        const head = lines[i].match(/^Byte-by-byte Description of file:\s*(.+?)\s*$/);
        if (!head) continue;
        const cols = [];
        let dashes = 0, j = i + 1;
        for (; j < lines.length; j++) {
            if (/^-{20,}/.test(lines[j])) { if (++dashes === 3) break; continue; }
            if (dashes !== 2) continue;
            const m = lines[j].match(/^\s*(\d+)(?:\s*-\s*(\d+))?\s+([AIFE]\d+(?:\.\d+)?)\s+(\S+)\s+(\S+)(.*)$/);
            if (!m) continue;   // explanation continuation line
            const explanation = m[6].trim();
            const nullMatch = explanation.match(/\?=(\S+)/);
            cols.push({
                start: Number(m[1]), end: Number(m[2] ?? m[1]), format: m[3], units: m[4], label: m[5],
                nullValue: nullMatch ? nullMatch[1] : null,
            });
        }
        if (!cols.length) throw new Error(`ReadMe: empty byte-by-byte layout for ${head[1]}`);
        for (const f of expandCdsFileList(head[1])) layouts.set(f, cols);
        i = j;
    }
    return { layouts, records };
}

function decodeFixedWidth(text, readme, fileName, wanted = null) {
    const layout = readme.layouts.get(fileName);
    if (!layout) throw new Error(`ReadMe has no byte-by-byte layout for ${fileName}`);
    const cols = wanted ? wanted.map(label => {
        const c = layout.find(col => col.label === label);
        if (!c) throw new Error(`${fileName}: ReadMe has no column "${label}" (have: ${layout.map(x => x.label).join(", ")})`);
        return c;
    }) : layout;
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const rec = {};
        for (const c of cols) {
            const raw = line.slice(c.start - 1, c.end);
            if (c.format[0] === "A") { rec[c.label] = raw.trim(); continue; }
            const s = raw.trim();
            if (!s || (c.nullValue !== null && s === c.nullValue)) { rec[c.label] = null; continue; }
            const n = Number(s);
            rec[c.label] = Number.isFinite(n) ? n : null;
        }
        rows.push(rec);
    }
    const expected = readme.records.get(fileName);
    if (expected !== undefined && rows.length !== expected) {
        throw new Error(`${fileName}: decoded ${rows.length} rows but the ReadMe File Summary says ${expected} (corrupt cache? re-run with --refresh)`);
    }
    return rows;
}

function sexagesimalToDeg(rec) {
    if (!isNum(rec.RAh) || !isNum(rec.DEd)) return null;
    const raDeg = 15 * (rec.RAh + (rec.RAm ?? 0) / 60 + (rec.RAs ?? 0) / 3600);
    const dAbs = rec.DEd + (rec.DEm ?? 0) / 60 + (rec.DEs ?? 0) / 3600;
    return { raDeg, decDeg: rec["DE-"] === "-" ? -dAbs : dAbs };
}

// ---------------------------------------------------------------------------
// Galaxy-name normalisation for cross-matching (UNGC / McConnachie / 2MRS CAT)
// ---------------------------------------------------------------------------
const ROMAN = /^(X{0,3})(IX|IV|V?I{0,3})$/;
function romanToInt(s) {
    const v = { I: 1, V: 5, X: 10 };
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const a = v[s[i]], b = v[s[i + 1]] || 0;
        n += a < b ? -a : a;
    }
    return n;
}

function normName(raw) {
    if (!raw) return "";
    let s = String(raw).replace(/_/g, " ");
    // multi-word parentheticals are descriptions ("Wolf-Lundmark-Melotte",
    // "Local Group Suspect 3"); single tokens are designations ("(I)", "(A)").
    s = s.replace(/\(([^)]*)\)/g, (m, inner) => /[\s-]/.test(inner.trim()) ? " " : ` ${inner} `);
    s = s.replace(/([a-z])([A-Z])/g, "$1 $2");          // "LeoIV" -> "Leo IV", "CVnII" -> "CVn II"
    s = s.toUpperCase();
    s = s.replace(/\bCANES VENATICI\b/g, "CVN").replace(/\bURSA MAJOR\b/g, "UMA").replace(/\bURSA MINOR\b/g, "UMI")
        .replace(/\bCOMA BERENICES\b/g, "COMA").replace(/\bANDROMEDA\b/g, "AND").replace(/\bSAGITTARIUS\b/g, "SAG")
        .replace(/\bPEGASUS\b/g, "PEG").replace(/\bCASS[IE]OPE?IA\b/g, "CAS").replace(/\bMESSIER\b/g, "M")
        .replace(/\bD ?IRR\b/g, "D IR");                    // "dIrr" (McConnachie) vs "dIr" (UNGC)
    let tokens = s.match(/[A-Z]+|\d+/g) || [];
    if (tokens[0] === "MESSIER") tokens[0] = "M";
    if (tokens[0] === "ESO") tokens = tokens.filter((t, i) => i === 0 || t !== "G");
    tokens = tokens.map((t, i) => {
        if (/^\d+$/.test(t)) return String(Number(t));
        if (i > 0 && t.length && ROMAN.test(t)) return String(romanToInt(t));
        return t;
    });
    return tokens.join(" ");
}

// Messier galaxies -> NGC (standard cross-identifications). Bridges 2MRS CAT
// names ("MESSIER_051a") and UNGC designations ("NGC5194"), and gives UNGC
// rows their familiar Messier display name.
const MESSIER_GALAXIES = [
    [31, "NGC 224"], [32, "NGC 221"], [33, "NGC 598"], [49, "NGC 4472"], [51, "NGC 5194"], [58, "NGC 4579"],
    [59, "NGC 4621"], [60, "NGC 4649"], [61, "NGC 4303"], [63, "NGC 5055"], [64, "NGC 4826"], [65, "NGC 3623"],
    [66, "NGC 3627"], [74, "NGC 628"], [77, "NGC 1068"], [81, "NGC 3031"], [82, "NGC 3034"], [83, "NGC 5236"],
    [84, "NGC 4374"], [85, "NGC 4382"], [86, "NGC 4406"], [87, "NGC 4486"], [88, "NGC 4501"], [89, "NGC 4552"],
    [90, "NGC 4569"], [91, "NGC 4548"], [94, "NGC 4736"], [95, "NGC 3351"], [96, "NGC 3368"], [98, "NGC 4192"],
    [99, "NGC 4254"], [100, "NGC 4321"], [101, "NGC 5457"], [102, "NGC 5866"], [104, "NGC 4594"], [105, "NGC 3379"],
    [106, "NGC 4258"], [108, "NGC 3556"], [109, "NGC 3992"], [110, "NGC 205"],
];
const MESSIER_KEY_TO_NGC_KEY = new Map();
const NGC_KEY_TO_MESSIER = new Map();
for (const [m, ngc] of MESSIER_GALAXIES) {
    MESSIER_KEY_TO_NGC_KEY.set(`M ${m}`, normName(ngc));
    NGC_KEY_TO_MESSIER.set(normName(ngc), `M${m}`);
}
MESSIER_KEY_TO_NGC_KEY.set("M 51 A", normName("NGC 5194"));
MESSIER_KEY_TO_NGC_KEY.set("M 51 B", normName("NGC 5195"));

// All normalised keys a name answers to (itself plus its Messier/NGC twin).
function nameKeys(raw) {
    const k = normName(raw);
    const keys = new Set(k ? [k] : []);
    const ngc = MESSIER_KEY_TO_NGC_KEY.get(k);
    if (ngc) keys.add(ngc);
    const mes = NGC_KEY_TO_MESSIER.get(k);
    if (mes) keys.add(normName(mes));
    return keys;
}

function prettyDesignation(name) {
    const m = name.match(/^(MESSIER|NGC|IC|UGCA|UGC|DDO|KKH|KKR|KKS|KK|KDG|PGC|AGC|ESO|MCG|FGC|CGCG|MRK)0*(\d+)(.*)$/i);
    if (!m) return name;
    const prefix = m[1].toUpperCase() === "MESSIER" ? "M" : m[1];
    return (prefix === "M" ? "M" : prefix + " ") + m[2] + m[3];
}

// ---------------------------------------------------------------------------
// Local Volume: UNGC + McConnachie 2012
// ---------------------------------------------------------------------------
const PRIMARY_METHODS = new Set(["geom", "Cep", "TRGB", "RR", "HB", "CMD", "SN", "SBF", "PNLF", "RSP"]);
const SECONDARY_METHODS = new Set(["TF", "FP", "BS", "mem"]);
function distQuality(method, uncertain) {
    if (PRIMARY_METHODS.has(method)) return uncertain ? 2 : 1;
    if (SECONDARY_METHODS.has(method)) return 2;
    return 3;   // h, h' (Hubble flow), txt (texture only), unknown
}

// UNGC-style T-type for McConnachie-only rows (only a handful of dwarfs).
function tTypeFromMcc(mtype) {
    const t = (mtype || "").replace(/[()?]/g, "");
    if (/^dSph|^dE/.test(t)) return -3;
    if (/Irr/.test(t)) return 10;
    if (/^cE|^E/.test(t)) return -5;
    const sp = t.match(/^S\(?B?\)?([abcdm]+)/);
    if (sp) return { a: 1, ab: 2, b: 3, bc: 4, c: 5, cd: 6, d: 7, dm: 8, m: 9 }[sp[1]] ?? null;
    return null;
}

const MCC_EXCLUDE = new Map([
    ["The Galaxy", "the Milky Way itself (modelled separately by the app)"],
    ["Canis Major", "disputed overdensity at ~7 kpc inside the Milky Way disc (likely a warp/flare feature); not in UNGC"],
]);
// Explicit McConnachie -> UNGC name pairs the normaliser cannot infer.
const MCC_TO_UNGC_ALIAS = new Map([
    ["HIZSS 3(A)", "HIZSS003"],
]);

async function buildLocalVolume() {
    const ungcReadme = parseCdsReadme((await cachedFetch(CDS_FTP + "J/AJ/145/101/ReadMe", "J_AJ_145_101/ReadMe", mustContain("Byte-by-byte"))).toString("latin1"));
    const t1 = decodeFixedWidth((await cachedFetch(CDS_FTP + "J/AJ/145/101/table1.dat", "J_AJ_145_101/table1.dat")).toString("latin1"), ungcReadme, "table1.dat");
    const t2 = decodeFixedWidth((await cachedFetch(CDS_FTP + "J/AJ/145/101/table2.dat", "J_AJ_145_101/table2.dat")).toString("latin1"), ungcReadme, "table2.dat");
    const t6 = decodeFixedWidth((await cachedFetch(CDS_FTP + "J/AJ/145/101/table6.dat", "J_AJ_145_101/table6.dat")).toString("latin1"), ungcReadme, "table6.dat");

    const mccReadme = parseCdsReadme((await cachedFetch(CDS_FTP + "J/AJ/144/4/ReadMe", "J_AJ_144_4/ReadMe", mustContain("Byte-by-byte"))).toString("latin1"));
    const m1 = decodeFixedWidth((await cachedFetch(CDS_FTP + "J/AJ/144/4/table1.dat", "J_AJ_144_4/table1.dat")).toString("latin1"), mccReadme, "table1.dat");
    const m2 = decodeFixedWidth((await cachedFetch(CDS_FTP + "J/AJ/144/4/table2.dat", "J_AJ_144_4/table2.dat")).toString("latin1"), mccReadme, "table2.dat");
    const m3 = decodeFixedWidth((await cachedFetch(CDS_FTP + "J/AJ/144/4/table3.dat", "J_AJ_144_4/table3.dat")).toString("latin1"), mccReadme, "table3.dat");

    const byName = (rows, what) => {
        const map = new Map();
        for (const r of rows) {
            if (map.has(r.Name)) throw new Error(`${what}: duplicate name ${r.Name}`);
            map.set(r.Name, r);
        }
        return map;
    };
    const t2ByName = byName(t2, "UNGC table2");
    const t6ByName = byName(t6, "UNGC table6");
    byName(t1, "UNGC table1");
    const m2ByName = byName(m2, "McConnachie table2");
    const m3ByName = byName(m3, "McConnachie table3");
    byName(m1, "McConnachie table1");

    const excluded = [];
    // --- UNGC rows ---------------------------------------------------------
    const ungc = [];
    for (const a of t1) {
        const b = t2ByName.get(a.Name);
        if (!b) throw new Error(`UNGC: ${a.Name} missing from table2`);
        if (/^milky way$/i.test(a.Name)) {
            excluded.push({ name: a.Name, source: "UNGC", reason: "the Milky Way itself (modelled separately by the app)" });
            continue;
        }
        const pos = sexagesimalToDeg(a);
        if (!pos || !isNum(a.Dist) || !(a.Dist > 0)) {
            excluded.push({ name: a.Name, source: "UNGC", reason: "no position or distance" });
            continue;
        }
        // table1 Dist is rounded to 0.01 Mpc (a +-10 % step at the LMC's 0.05);
        // table6 lists the adopted distance modulus for 783 galaxies. Use it
        // when it agrees with Dist to within that rounding. UNGC's own derived
        // quantities (BMag, logL_K, A26) are consistent with this distance.
        const d6 = t6ByName.get(a.Name);
        let dist = a.Dist, distErr = null, method = a.f_Dist || (d6?.n_DM ?? "");
        if (d6 && isNum(d6.DM)) {
            const dFromDm = Math.pow(10, d6.DM / 5 + 1) / 1e6;
            if (Math.abs(dFromDm - a.Dist) <= 0.0051 + 0.01 * a.Dist) {
                dist = dFromDm;
                if (isNum(d6.e_DM)) distErr = dist * Math.LN10 / 5 * d6.e_DM;
                if (!method && d6.n_DM) method = d6.n_DM;
            }
        }
        ungc.push({ a, b, pos, dist, distErr, method: method || null, unit: unitVector(pos.raDeg, pos.decDeg) });
    }

    // --- McConnachie rows --------------------------------------------------
    const mcc = [];
    for (const r of m1) {
        if (MCC_EXCLUDE.has(r.Name)) {
            excluded.push({ name: r.Name, source: "M12", reason: MCC_EXCLUDE.get(r.Name) });
            continue;
        }
        const p2 = m2ByName.get(r.Name), p3 = m3ByName.get(r.Name);
        const pos = sexagesimalToDeg(r);
        const dm = p2?.["(m-M)"];
        if (!pos || !isNum(dm)) {
            excluded.push({ name: r.Name, source: "M12", reason: "no position or distance modulus" });
            continue;
        }
        const dist = Math.pow(10, dm / 5 + 1) / 1e6;
        const eHi = p2["E_(m-M)"], eLo = p2["e_(m-M)"];
        const eDm = isNum(eHi) && isNum(eLo) ? (eHi + eLo) / 2 : (isNum(eHi) ? eHi : (isNum(eLo) ? eLo : null));
        mcc.push({
            r, p2, p3, pos, dist,
            distErr: eDm === null ? null : dist * Math.LN10 / 5 * eDm,
            distFlag: (p2["u_(m-M)"] || "").trim(),
            unit: unitVector(pos.raDeg, pos.decDeg),
            names: [r.Name, ...String(r.OName || "").split(",")].map(s => s.trim()).filter(Boolean),
        });
    }

    // --- Cross-match McConnachie -> UNGC (names first, then position) ------
    const ungcByNorm = new Map();
    for (const u of ungc) {
        const k = normName(u.a.Name);
        if (!ungcByNorm.has(k)) ungcByNorm.set(k, []);
        ungcByNorm.get(k).push(u);
    }
    const ungcByName = new Map(ungc.map(u => [u.a.Name, u]));
    const matchLog = { byName: 0, byPosition: 0, unmatched: [] };
    const taken = new Set();
    const accept = (m, u, how) => {
        const sep = sepArcmin(m.unit, u.unit);
        const dRatio = Math.abs(Math.log10(m.dist / u.dist));
        if (sep > 30 || dRatio > 0.3) {
            console.warn(`  reject McC match ${m.r.Name} -> ${u.a.Name} (${how}): sep ${sep.toFixed(1)}' dlogD ${dRatio.toFixed(2)}`);
            return false;
        }
        m.ungc = u; u.mcc = m; taken.add(u);
        matchLog[how === "name" ? "byName" : "byPosition"]++;
        if (how !== "name" || sep > 5) console.log(`  McC ${m.r.Name} -> UNGC ${u.a.Name} by ${how} (sep ${sep.toFixed(1)}', D ${m.dist.toFixed(3)} vs ${u.dist.toFixed(3)} Mpc)`);
        return true;
    };
    for (const m of mcc) {
        const alias = MCC_TO_UNGC_ALIAS.get(m.r.Name);
        if (alias && ungcByName.has(alias) && !taken.has(ungcByName.get(alias))) { accept(m, ungcByName.get(alias), "name"); continue; }
        for (const nm of m.names) {
            const cands = (ungcByNorm.get(normName(nm)) || []).filter(u => !taken.has(u));
            if (cands.length === 1 && accept(m, cands[0], "name")) break;
        }
    }
    for (const m of mcc) {
        if (m.ungc) continue;
        let best = null, bestSep = Infinity;
        for (const u of ungc) {
            if (taken.has(u)) continue;
            const sep = sepArcmin(m.unit, u.unit);
            if (sep < bestSep) { bestSep = sep; best = u; }
        }
        if (best && bestSep <= MCC_POS_MATCH_ARCMIN && Math.abs(Math.log10(m.dist / best.dist)) < 0.2 && accept(m, best, "position")) continue;
        matchLog.unmatched.push(m.r.Name);
    }
    console.log(`McConnachie cross-match: ${matchLog.byName} by name, ${matchLog.byPosition} by position, ${matchLog.unmatched.length} McConnachie-only: ${matchLog.unmatched.join(", ")}`);

    // --- Assemble rows -----------------------------------------------------
    const rows = [];
    const stats = { ungc: 0, ungcPlusMcc: 0, mccOnly: 0, mbDerived: 0, lkDerived: 0, diamDerived: 0, lumV: 0, lumB: 0 };
    const mccPA = p3 => {
        const pa = p3?.PA;
        return isNum(pa) ? ((pa % 180) + 180) % 180 : null;
    };
    const mccBa = p3 => (isNum(p3?.Ell) ? 1 - p3.Ell : null);
    const mccMV = p3 => (isNum(p3?.VMag) ? p3.VMag : null);

    for (const u of ungc) {
        const { a, b } = u;
        const m = u.mcc && u.mcc.dist <= MCC_PREFER_WITHIN_MPC ? u.mcc : null;
        const derived = [];
        const dAdopt = m ? m.dist : u.dist;
        const dRatio = dAdopt / u.dist;             // rescale UNGC distance-dependent values
        const dmAdopt = 5 * Math.log10(dAdopt * 1e6 / 10);
        // Absolute B (Galactic + internal extinction corrected) at the adopted distance.
        let MB = null;
        if (isNum(b.BMag)) MB = b.BMag - 5 * Math.log10(dRatio);
        else if (isNum(a.Bmag)) {
            MB = a.Bmag - (a.AB ?? 0) - (b.ABi ?? 0) - dmAdopt;
            derived.push("MB");
        }
        // log L_K (L_sun, M_K,sun = 3.28), extinction corrected as in UNGC note 18.
        let logLK = null;
        if (isNum(b.KLum)) logLK = b.KLum + 2 * Math.log10(dRatio);
        else if (isNum(a.Kmag)) {
            const Kc = a.Kmag - 0.085 * ((a.AB ?? 0) + (b.ABi ?? 0));
            logLK = 0.4 * (MK_SUN - (Kc - dmAdopt));
            derived.push("logLK");
        }
        if (a.f_Kmag === "*" && logLK !== null) derived.push("Kmag~B");   // UNGC note 7: K estimated from B and type
        let diamKpc = null;
        if (isNum(b.A26)) diamKpc = b.A26 * dRatio;
        else if (isNum(a.a26)) { diamKpc = dAdopt * 1000 * a.a26 * Math.PI / 10800; derived.push("diamKpc"); }
        const MV = m ? mccMV(m.p3) : null;
        let lum = null, lumBand = null;
        if (MV !== null) { lum = Math.pow(10, -0.4 * (MV - MV_SUN)); lumBand = "V"; stats.lumV++; }
        else if (MB !== null) { lum = Math.pow(10, -0.4 * (MB - MB_SUN)); lumBand = "B"; stats.lumB++; }
        if (derived.includes("MB")) stats.mbDerived++;
        if (derived.includes("logLK")) stats.lkDerived++;
        if (derived.includes("diamKpc")) stats.diamDerived++;
        const method = m ? "RSP" : u.method;
        const uncertainFlag = m ? /[:l]/.test(m.distFlag) : false;
        const pretty = prettyDesignation(a.Name);
        const messier = NGC_KEY_TO_MESSIER.get(normName(a.Name));
        const displayName = u.mcc ? u.mcc.r.Name : (messier || pretty);
        const altNames = [];
        const addAlt = s => { if (s && s !== a.Name && s !== displayName && !altNames.includes(s)) altNames.push(s); };
        addAlt(pretty);
        if (messier) addAlt(messier);
        if (u.mcc) for (const nm of u.mcc.names) addAlt(nm);
        const hrv = m && isNum(m.p2.HRV) ? m.p2.HRV : (isNum(a.HRV) ? a.HRV : null);
        const morph = [a.Mcl, a.Tdw].filter(Boolean).join(" ") || (u.mcc?.r.MType ?? "") || null;
        // "UNGC+M12" only when McConnachie values were actually applied; a
        // cross-identified galaxy beyond 3 Mpc keeps UNGC values (and M12 names).
        const source = m ? "UNGC+M12" : "UNGC";
        if (m) stats.ungcPlusMcc++; else stats.ungc++;
        rows.push({
            name: a.Name,
            displayName,
            altNames: altNames.length ? altNames : null,
            raDeg: m ? m.pos.raDeg : u.pos.raDeg,
            decDeg: m ? m.pos.decDeg : u.pos.decDeg,
            distMpc: dAdopt,
            distErrMpc: m ? m.distErr : u.distErr,
            distMethod: method,
            distQuality: distQuality(method, uncertainFlag),
            distSource: m ? "M12" : "UNGC",
            type: isNum(a.TT) ? a.TT : null,
            morph,
            MB,
            LB: MB === null ? null : Math.pow(10, -0.4 * (MB - MB_SUN)),
            MV,
            lum,
            lumBand,
            logLK,
            diamKpc,
            a26Arcmin: isNum(a.a26) ? a.a26 : null,
            ba: isNum(a["b/a"]) ? a["b/a"] : (m ? mccBa(m.p3) : null),
            inclDeg: isNum(b.i) ? b.i : null,
            paDeg: m ? mccPA(m.p3) : null,
            paSource: m && mccPA(m.p3) !== null ? "M12" : null,
            hrv,
            vLG: isNum(b.Vlg) ? b.Vlg : null,
            tidalIndex: isNum(b.Ti1) ? b.Ti1 : null,
            mainDisturber: b.MD || null,
            source,
            derived: derived.length ? derived : null,
        });
    }
    for (const m of mcc) {
        if (m.ungc) continue;
        const MV = mccMV(m.p3);
        stats.mccOnly++;
        if (MV !== null) stats.lumV++;
        const altNames = m.names.slice(1);
        rows.push({
            name: m.r.Name,
            displayName: m.r.Name,
            altNames: altNames.length ? altNames : null,
            raDeg: m.pos.raDeg,
            decDeg: m.pos.decDeg,
            distMpc: m.dist,
            distErrMpc: m.distErr,
            distMethod: "RSP",
            distQuality: distQuality("RSP", /[:l]/.test(m.distFlag)),
            distSource: "M12",
            type: tTypeFromMcc(m.r.MType),
            morph: m.r.MType || null,
            MB: null,
            LB: null,
            MV,
            lum: MV === null ? null : Math.pow(10, -0.4 * (MV - MV_SUN)),
            lumBand: MV === null ? null : "V",
            logLK: null,
            diamKpc: null,
            a26Arcmin: null,
            ba: mccBa(m.p3),
            inclDeg: null,
            paDeg: mccPA(m.p3),
            paSource: mccPA(m.p3) !== null ? "M12" : null,
            hrv: isNum(m.p2.HRV) ? m.p2.HRV : null,
            vLG: null,
            tidalIndex: null,
            mainDisturber: null,
            source: "M12",
            derived: null,
        });
    }
    rows.sort((x, y) => (x.distMpc - y.distMpc) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const r of rows) {
        if (!(r.distMpc > 0.001)) throw new Error(`LV row ${r.name} at ${r.distMpc} Mpc: inside 1 kpc of the Sun`);
        r.unit = unitVector(r.raDeg, r.decDeg);
    }
    return { rows, excluded, stats, matchLog };
}

// Field schema for local-volume.json (row order in the array).
const LV_FIELDS = [
    ["name", null, "catalog designation (UNGC Name; McConnachie Name for M12-only rows)"],
    ["displayName", null, "human-friendly name (McConnachie name when matched, else the UNGC designation with padding removed)"],
    ["altNames", null, "array of alternative designations or null"],
    ["raDeg", "deg", "right ascension, ICRS/J2000"],
    ["decDeg", "deg", "declination, ICRS/J2000"],
    ["distMpc", "Mpc", "adopted heliocentric distance (McConnachie distance modulus when matched and < 3 Mpc, else UNGC)"],
    ["distErrMpc", "Mpc", "1-sigma distance error from the distance-modulus error (null if not published)"],
    ["distMethod", null, "distance method: UNGC codes (TRGB, Cep, geom, SN, SBF, mem, TF, FP, BS, CMD, HB, RR, PNLF, h, h', txt) or RSP = resolved stellar populations (McConnachie 2012 note 7)"],
    ["distQuality", null, "1 = primary (stellar-population / geometric / SN / SBF / PNLF), 2 = secondary (TF, FP, BS, group membership) or flagged uncertain, 3 = velocity- or texture-based"],
    ["distSource", null, "UNGC or M12"],
    ["type", null, "morphological T-type (UNGC de Vaucouleurs code, -3..11; dSph/dE typically -3..-1, Ir = 10); McConnachie-only rows mapped from their Hubble type"],
    ["morph", null, "UNGC dwarf class + surface-brightness class (e.g. 'Sph L', 'Ir N') or McConnachie Hubble type"],
    ["MB", "mag", "absolute B magnitude corrected for Galactic + internal extinction, at the adopted distance"],
    ["LB", "Lsun_B", "B-band luminosity 10^(-0.4 (MB - 5.48))"],
    ["MV", "mag", "absolute V magnitude from McConnachie 2012 (Local Group rows only)"],
    ["lum", "Lsun", "preferred optical luminosity in band lumBand (McConnachie M_V when available, else UNGC M_B)"],
    ["lumBand", null, "V or B (solar M_V = 4.83, M_B = 5.48)"],
    ["logLK", "log10 Lsun_K", "Ks-band luminosity (UNGC, M_K,sun = 3.28), rescaled to the adopted distance"],
    ["diamKpc", "kpc", "Holmberg (26.5 B mag/arcsec^2) linear diameter, rescaled to the adopted distance"],
    ["a26Arcmin", "arcmin", "Holmberg angular diameter (UNGC)"],
    ["ba", null, "apparent axial ratio b/a (UNGC; McConnachie 1 - ellipticity for M12-only rows)"],
    ["inclDeg", "deg", "inclination from face-on (UNGC)"],
    ["paDeg", "deg", "major-axis position angle, east of north, [0, 180): McConnachie 2012, else the 2MASS XSC super-coadd PA of the matching 2MRS galaxy; null elsewhere"],
    ["paSource", null, "M12, 2MASX or null"],
    ["hrv", "km/s", "heliocentric radial velocity (McConnachie when matched, else UNGC)"],
    ["vLG", "km/s", "radial velocity in the Local Group frame (UNGC)"],
    ["tidalIndex", null, "UNGC tidal index Theta_1 (> 0: member of the group of mainDisturber)"],
    ["mainDisturber", null, "UNGC main disturber (the neighbour with the largest tidal influence)"],
    ["source", null, "row provenance: UNGC, UNGC+M12 (UNGC row with McConnachie values applied) or M12"],
    ["derived", null, "fields computed by this build rather than taken from the catalogs (MB, logLK, diamKpc) plus 'Kmag~B' when UNGC estimated Ks from B; null = all catalog values"],
];

function lvRowArray(r) {
    const val = {
        ...r,
        raDeg: round(r.raDeg, 5), decDeg: round(r.decDeg, 5),
        distMpc: sig(r.distMpc, 5), distErrMpc: sig(r.distErrMpc, 3),
        MB: round(r.MB, 2), LB: sig(r.LB, 4), MV: round(r.MV, 2), lum: sig(r.lum, 4),
        logLK: round(r.logLK, 3), diamKpc: sig(r.diamKpc, 4), a26Arcmin: round(r.a26Arcmin, 2),
        ba: round(r.ba, 3), paDeg: round(r.paDeg, 1), hrv: round(r.hrv, 1), tidalIndex: round(r.tidalIndex, 1),
    };
    return LV_FIELDS.map(([k]) => (val[k] === undefined ? null : val[k]));
}

// ---------------------------------------------------------------------------
// 2MRS
// ---------------------------------------------------------------------------
const TWOMRS_FIELDS = [
    ["raDeg", "deg", "right ascension, ICRS/J2000 (2MASS)"],
    ["decDeg", "deg", "declination, ICRS/J2000 (2MASS)"],
    ["distMpc", "Mpc", "redshift-space Hubble-flow distance vCmb / H0 (vCmb floored at vFloorKms); NOT a measured distance"],
    ["cz", "km/s", "heliocentric (solar-system barycentre) redshift c*z, as published"],
    ["vCmb", "km/s", "c*z in the CMB rest frame: 1 + z_cmb = (1 + z_hel) / (gamma (1 - beta cos theta)), theta = angle to the CMB dipole apex"],
    ["KsMag", "mag", "2MASS Ks total extrapolated magnitude, Galactic-extinction corrected (2MRS Ktmag)"],
    ["type", null, "ZCAT morphological T-type code (first two characters of the 2MRS type field), -9..20; NaN = no morphology (blank, 98 'never visually examined', or the undocumented 99). See typeCodes"],
    ["ba", null, "axis ratio b/a of the J+H+Ks super-coadd at the 3-sigma isophote (2MRS)"],
    ["pa", "deg", "position angle of the same ellipse, east of north, [0, 180) (2MASS XSC sup_phi, joined on the 2MASS ID); NaN = unavailable"],
    ["lvIndex", null, "row index into local-volume.json when this galaxy duplicates a Local Volume galaxy (prefer that row's measured distance); -1 = none"],
];

const ZCAT_TYPE_CODES = {
    "-9": "QSO/AGN", "-7": "unclassified elliptical", "-6": "compact elliptical", "-5": "E, dwarf E", "-4": "E/S0",
    "-3": "L-, S0-", "-2": "L, S0", "-1": "L+, S0+", "0": "S0/a", "1": "Sa", "2": "Sab", "3": "Sb", "4": "Sbc", "5": "Sc",
    "6": "Scd", "7": "Sd", "8": "Sdm", "9": "Sm", "10": "Im / dwarf irregular", "11": "compact irregular / extragalactic HII region",
    "12": "extragalactic HI cloud", "15": "peculiar / unclassifiable", "16": "Irr II", "19": "unclassified galaxy",
    "20": "unclassified spiral", "98": "never visually examined (stored as NaN)",
    "99": "not defined in the 2MRS ReadMe (stored as NaN; see stats.typeUndocumented99)",
};

// Verified redshift errors in 2MRS table3, corrected before any derivation and
// listed in the manifest ("errata"). Keyed by 2MASS designation.
const TWOMRS_ERRATA = new Map([
    ["05332175-2156447", {
        object: "NGC 1964",
        field: "cz",
        adopted: 1656,
        reference: "SIMBAD radial velocity 1655.7 km/s (Meyer et al. 2004, MNRAS 350, 1195, HIPASS)",
        note: "the published cz = -248 km/s (6dFGS) is the spectrum of the superposed foreground star UCAC4 341-008108, 0.8 arcsec from the nucleus of this bright Sb galaxy",
    }],
]);

async function fetchXscPositionAngles(rows) {
    // Slice by RA so every VizieR query answers in a couple of seconds (one
    // all-sky query sits silent long enough for proxies to drop it). The Ks
    // limit per slice covers the faintest 2MRS isophotal magnitude in the slice
    // before extinction correction (A_K ~ 0.35 E(B-V) in 2MRS; 0.40 for margin).
    const SLICE = 15;
    const byId = new Map();
    for (let ra0 = 0; ra0 < 360; ra0 += SLICE) {
        let kLim = 0;
        for (const r of rows) {
            if (r.raDeg >= ra0 && r.raDeg < ra0 + SLICE) kLim = Math.max(kLim, r.kIso + 0.40 * (r.ebv ?? 0));
        }
        if (!kLim) continue;
        kLim = Math.min(14, Math.ceil((kLim + 0.02) * 10) / 10);
        const url = `${VIZIER_ASU_TSV}?-source=VII/233/xsc&-out=2MASX,Sb/a,Spa&-out.max=unlimited` +
            `&RAJ2000=${ra0}..${ra0 + SLICE}&K.K20e=%3C${kLim.toFixed(1)}`;
        const rel = `VII_233_xsc/ra${String(ra0).padStart(3, "0")}-${String(ra0 + SLICE).padStart(3, "0")}_k${kLim.toFixed(1)}.tsv`;
        const text = (await cachedFetch(url, rel, buf => {
            const t = buf.toString("latin1");
            if (/^#INFO\s+Error/m.test(t)) throw new Error(t.match(/^#INFO\s+Error.*$/m)[0]);
            if (!/^2MASX\t/m.test(t)) throw new Error("no 2MASX header in VizieR response");
        })).toString("latin1");
        const lines = text.split(/\r?\n/);
        const header = lines.findIndex(l => l.startsWith("2MASX\t"));
        const cols = lines[header].split("\t");
        const iId = cols.indexOf("2MASX"), iBa = cols.indexOf("Sb/a"), iPa = cols.indexOf("Spa");
        for (let i = header + 3; i < lines.length; i++) {
            const line = lines[i];
            if (!line || line.startsWith("#")) continue;
            const c = line.split("\t");
            const id = (c[iId] || "").trim();
            if (!id) continue;
            const pa = c[iPa]?.trim() ? Number(c[iPa]) : NaN;
            const ba = c[iBa]?.trim() ? Number(c[iBa]) : NaN;
            byId.set(id, { pa, ba });
        }
    }
    return byId;
}

async function build2mrs(lvRows) {
    const readme = parseCdsReadme((await cachedFetch(CDS_FTP + "J/ApJS/199/26/ReadMe", "J_ApJS_199_26/ReadMe", mustContain("Byte-by-byte"))).toString("latin1"));
    const gz = await cachedFetch(CDS_FTP + "J/ApJS/199/26/table3.dat.gz", "J_ApJS_199_26/table3.dat.gz", buf => {
        if (buf[0] !== 0x1f || buf[1] !== 0x8b) throw new Error("not gzip data");
    });
    const recs = decodeFixedWidth(gunzipSync(gz).toString("latin1"), readme, "table3.dat",
        ["ID", "RAdeg", "DEdeg", "GLAT", "Kcmag", "Ktmag", "E(B-V)", "b/a", "type", "cz", "CAT"]);

    const apex = galacticToEquatorialDeg(CMB_DIPOLE.lDeg, CMB_DIPOLE.bDeg);
    const beta = CMB_DIPOLE.vKms / C_KMS;
    const gamma = 1 / Math.sqrt(1 - beta * beta);

    const rows = [];
    const errata = [];
    let noCz = 0, typeNeverExamined = 0, typeUndocumented = 0;
    for (const r of recs) {
        const fix = TWOMRS_ERRATA.get(r.ID);
        if (fix) {
            errata.push({ id: r.ID, object: fix.object, field: fix.field, published: r[fix.field], adopted: fix.adopted, reference: fix.reference, note: fix.note });
            r[fix.field] = fix.adopted;
        }
        if (!isNum(r.cz)) { noCz++; continue; }
        if (!isNum(r.RAdeg) || !isNum(r.DEdeg) || !isNum(r.Ktmag)) throw new Error(`2MRS ${r.ID}: missing position or Ktmag`);
        const unit = unitVector(r.RAdeg, r.DEdeg);
        const cosTheta = unit[0] * apex.unit[0] + unit[1] * apex.unit[1] + unit[2] * apex.unit[2];
        const zCmb = (1 + r.cz / C_KMS) / (gamma * (1 - beta * cosTheta)) - 1;
        const vCmb = C_KMS * zCmb;
        // ZCAT T-type = first two characters; 98 ("never visually examined")
        // and the undocumented 99 carry no morphology -> NaN like a blank.
        let tt = parseInt(String(r.type || "").slice(0, 2), 10);
        if (tt === 98) typeNeverExamined++;
        if (tt === 99) typeUndocumented++;
        if (tt >= 98) tt = NaN;
        rows.push({
            id: r.ID, cat: r.CAT, raDeg: r.RAdeg, decDeg: r.DEdeg, unit, glat: r.GLAT,
            cz: r.cz, vCmb, KsMag: r.Ktmag, kIso: r.Kcmag, ebv: r["E(B-V)"],
            // b/a = 9.999 is an undeclared missing-value sentinel (one row)
            type: Number.isFinite(tt) ? tt : NaN, ba: r["b/a"] > 0 && r["b/a"] <= 1 ? r["b/a"] : NaN,
            pa: NaN, lvIndex: -1,
        });
    }

    // Position angles from the 2MASS XSC (joined on the 2MASS designation).
    const xsc = await fetchXscPositionAngles(rows);
    let paJoined = 0, baAgree = 0, baCompared = 0;
    for (const r of rows) {
        const x = xsc.get(r.id);
        if (!x) continue;
        if (Number.isFinite(x.pa)) { r.pa = ((x.pa % 180) + 180) % 180; paJoined++; }
        if (Number.isFinite(x.ba) && Number.isFinite(r.ba)) { baCompared++; if (Math.abs(x.ba - r.ba) <= 0.011) baAgree++; }
    }
    if (baCompared && baAgree / baCompared < 0.95) {
        throw new Error(`2MASX join sanity check failed: only ${baAgree}/${baCompared} b/a values agree with 2MRS`);
    }

    // Local Volume duplicates: nearest LV galaxy within 2', else a name match
    // (incl. Messier <-> NGC twins) within 15' for galaxies whose catalogued
    // centres disagree (UNGC places NGC 5194 = M51a 2.4' north of its nucleus).
    const lvKeys = lvRows.map(lv => {
        const keys = new Set();
        for (const nm of [lv.name, lv.displayName, ...(lv.altNames || [])]) for (const k of nameKeys(nm)) keys.add(k);
        return keys;
    });
    let dupByPos = 0, dupByName = 0, floorCount = 0;
    const floorWithoutLv = [];
    const nameOnlyMatches = [];
    const velocityRejected = [];
    const velocityOk = (r, lvRow) => {
        if (lvRow.hrv === null || Math.abs(r.cz - lvRow.hrv) <= DUP_MAX_DV_KMS) return true;
        velocityRejected.push({ id: r.id, cat: r.cat, cz: r.cz, lv: lvRow.name, lvHrv: lvRow.hrv });
        return false;
    };
    for (const r of rows) {
        if (r.vCmb < DUP_VMAX_KMS) {
            let best = -1, bestSep = Infinity;
            for (let i = 0; i < lvRows.length; i++) {
                const s = sepArcmin(r.unit, lvRows[i].unit);
                if (s < bestSep) { bestSep = s; best = i; }
            }
            if (best >= 0 && bestSep <= DUP_RADIUS_ARCMIN) {
                if (velocityOk(r, lvRows[best])) { r.lvIndex = best; dupByPos++; }
            } else {
                const keys = nameKeys(r.cat);
                for (let i = 0; i < lvRows.length && keys.size; i++) {
                    if (![...keys].some(k => lvKeys[i].has(k))) continue;
                    const s = sepArcmin(r.unit, lvRows[i].unit);
                    if (s <= DUP_NAME_RADIUS_ARCMIN && velocityOk(r, lvRows[i])) {
                        r.lvIndex = i; dupByName++;
                        nameOnlyMatches.push({ id: r.id, cat: r.cat, lv: lvRows[i].name, sepArcmin: round(s, 2) });
                        break;
                    }
                }
            }
        }
        r.distMpc = Math.max(r.vCmb, V_FLOOR_KMS) / H0;
        if (r.vCmb < V_FLOOR_KMS) {
            floorCount++;
            if (r.lvIndex < 0) floorWithoutLv.push({ id: r.id, cat: r.cat, cz: r.cz, vCmb: round(r.vCmb, 1) });
        }
    }

    return {
        rows, noCz, apex, beta, gamma, errata,
        stats: {
            parsed: recs.length, withCz: rows.length, noCz, paJoined, baCompared, baAgree,
            typeClassified: rows.filter(r => Number.isFinite(r.type)).length, typeNeverExamined, typeUndocumented99: typeUndocumented,
            lvDuplicates: dupByPos + dupByName, lvDuplicatesByPosition: dupByPos, lvDuplicatesByNameOnly: dupByName,
            lvNameOnlyMatches: nameOnlyMatches,
            lvVelocityRejected: velocityRejected,
            velocityFloorApplied: floorCount, velocityFloorWithoutLvMatch: floorWithoutLv,
            zAbove0p1: rows.filter(r => r.vCmb > 0.1 * C_KMS).length,
            vCmbMin: round(rows.reduce((m, r) => Math.min(m, r.vCmb), Infinity), 1),
            vCmbMax: round(rows.reduce((m, r) => Math.max(m, r.vCmb), -Infinity), 1),
            vCmbMedian: round(rows.map(r => r.vCmb).sort((a, b) => a - b)[rows.length >> 1], 1),
        },
    };
}

// ---------------------------------------------------------------------------
// Citations / usage
// ---------------------------------------------------------------------------
const CITE_UNGC = {
    id: "UNGC",
    citation: "Karachentsev, I. D., Makarov, D. I., & Kaisina, E. I. 2013, AJ, 145, 101, \"Updated Nearby Galaxy Catalog\"",
    bibcode: "2013AJ....145..101K",
    doi: "10.1088/0004-6256/145/4/101",
    vizier: "J/AJ/145/101",
    url: "https://cdsarc.cds.unistra.fr/viz-bin/cat/J/AJ/145/101",
};
const CITE_MCC = {
    id: "M12",
    citation: "McConnachie, A. W. 2012, AJ, 144, 4, \"The Observed Properties of Dwarf Galaxies in and around the Local Group\"",
    bibcode: "2012AJ....144....4M",
    doi: "10.1088/0004-6256/144/1/4",
    vizier: "J/AJ/144/4",
    url: "https://cdsarc.cds.unistra.fr/viz-bin/cat/J/AJ/144/4",
};
const CITE_2MRS = {
    id: "2MRS",
    citation: "Huchra, J. P., Macri, L. M., Masters, K. L., et al. 2012, ApJS, 199, 26, \"The 2MASS Redshift Survey - Description and Data Release\"",
    bibcode: "2012ApJS..199...26H",
    doi: "10.1088/0067-0049/199/2/26",
    vizier: "J/ApJS/199/26",
    url: "https://cdsarc.cds.unistra.fr/viz-bin/cat/J/ApJS/199/26",
};
const CITE_2MASX = {
    id: "2MASX",
    citation: "Skrutskie, M. F., Cutri, R. M., Stiening, R., et al. 2006, AJ, 131, 1163, \"The Two Micron All Sky Survey (2MASS)\"; Jarrett, T. H., et al. 2000, AJ, 119, 2498 (Extended Source Catalog)",
    bibcode: "2006AJ....131.1163S",
    vizier: "VII/233",
    url: "https://cdsarc.cds.unistra.fr/viz-bin/cat/VII/233",
    usedFor: "super-coadd position angle (sup_phi) of the 2MRS galaxies",
};
const CITE_PLANCK = [
    "Planck Collaboration I 2020, A&A, 641, A1 (CMB dipole: 369.82 +/- 0.11 km/s toward l = 264.021, b = 48.253 deg)",
    "Planck Collaboration VI 2020, A&A, 641, A6 (H0 = 67.66 km/s/Mpc, TT,TE,EE+lowE+lensing+BAO)",
];
const LICENSE_NOTE = "Catalog data retrieved from CDS/VizieR. VizieR terms (https://cds.unistra.fr/vizier-org/licences_vizier.html): " +
    "the data are free to use in a scientific context provided the original authors and publications (including the publisher, here the AAS journals AJ/ApJS) " +
    "are explicitly cited; commercial reuse is subject to the originating publisher's policy. No separate open licence is declared in these catalogs' ReadMe files. " +
    "Derived values (see field notes) are this project's computations, not catalog values.";
const ACK_VIZIER = "This research has made use of the VizieR catalogue access tool, CDS, Strasbourg, France (DOI: 10.26093/cds/vizier).";
const ACK_2MASS = "This publication makes use of data products from the Two Micron All Sky Survey, which is a joint project of the University of Massachusetts " +
    "and the Infrared Processing and Analysis Center/California Institute of Technology, funded by the National Aeronautics and Space Administration and the National Science Foundation.";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    mkdirSync(CACHE_DIR, { recursive: true });
    mkdirSync(OUT_DIR, { recursive: true });

    const lv = await buildLocalVolume();
    const lvInputs = inputs.splice(0);
    const tm = await build2mrs(lv.rows);

    // Position angles for LV galaxies that McConnachie does not cover, taken
    // from their 2MRS duplicate (2MASS XSC sup_phi; brightest duplicate wins).
    let paBackfilled = 0;
    for (const r of tm.rows) {
        if (r.lvIndex < 0 || !Number.isFinite(r.pa)) continue;
        const target = lv.rows[r.lvIndex];
        if (target.paDeg !== null) continue;
        target.paDeg = r.pa;
        target.paSource = "2MASX";
        paBackfilled++;
    }
    lv.stats.paFromM12 = lv.rows.filter(r => r.paSource === "M12").length;
    lv.stats.paFrom2MASX = paBackfilled;

    const lvDoc = {
        schema: 1,
        name: "Local Volume galaxies (UNGC, with McConnachie 2012 Local Group values)",
        generatedBy: "scripts/build-galaxy-catalogs.mjs",
        sources: [CITE_UNGC, CITE_MCC, { ...CITE_2MASX, usedFor: "paDeg where paSource = 2MASX (joined through the 2MRS duplicate, see 2mrs-manifest.json)" }],
        license: LICENSE_NOTE,
        acknowledgment: ACK_VIZIER,
        frame: "ICRS/J2000 equatorial positions; heliocentric distances",
        distanceKind: "measured",
        constants: { MB_SUN, MV_SUN, MK_SUN },
        selection: `UNGC (869 galaxies: individual distances within ~11 Mpc or V_LG < 600 km/s) minus the Milky Way, plus McConnachie 2012 galaxies absent from UNGC. ` +
            `McConnachie distances (from (m-M)_0), positions, M_V, radial velocities and position angles replace UNGC values for matched galaxies within ${MCC_PREFER_WITHIN_MPC} Mpc; ` +
            `UNGC distance-dependent quantities (MB, logLK, diamKpc) are rescaled to the adopted distance. Rows are sorted by distance.`,
        derivations: {
            distMpc: "10^((m-M)_0/5 + 1) pc; UNGC table1 Dist (rounded to 0.01 Mpc) is replaced by its table6 distance modulus when consistent",
            distErrMpc: "D * ln(10)/5 * sigma(m-M)",
            MB: "UNGC table2 BMag - 5 log10(D_adopted/D_UNGC); if absent: Bmag - A_B - A_B,int - 5 log10(D/10 pc)",
            LB: "10^(-0.4 (MB - 5.48))",
            lum: "10^(-0.4 (MV - 4.83)) when McConnachie M_V exists, else LB",
            logLK: "UNGC table2 logL_K + 2 log10(D_adopted/D_UNGC); if absent: 0.4 (3.28 - (Ks - 0.085 (A_B + A_B,int) - 5 log10(D/10 pc)))",
            diamKpc: "UNGC table2 A26 * D_adopted/D_UNGC; if absent: D * a26 (arcmin -> rad)",
        },
        fields: LV_FIELDS.map(([k]) => k),
        units: Object.fromEntries(LV_FIELDS.map(([k, u]) => [k, u])),
        fieldNotes: Object.fromEntries(LV_FIELDS.map(([k, , d]) => [k, d])),
        excluded: lv.excluded,
        stats: { count: lv.rows.length, ...lv.stats, mccMatchedByName: lv.matchLog.byName, mccMatchedByPosition: lv.matchLog.byPosition },
        inputs: lvInputs,
        count: lv.rows.length,
        rows: lv.rows.map(lvRowArray),
    };
    const lvJson = JSON.stringify(lvDoc);
    writeAtomic(OUT_LV, lvJson);

    const n = tm.rows.length;
    const bin = Buffer.alloc(TWOMRS_FIELDS.length * n * 4);
    TWOMRS_FIELDS.forEach(([k], f) => {
        const base = f * n * 4;
        for (let i = 0; i < n; i++) bin.writeFloatLE(tm.rows[i][k], base + i * 4);
    });
    writeAtomic(OUT_2MRS_BIN, bin);

    const manifest = {
        schema: 1,
        name: "2MASS Redshift Survey (2MRS) main catalog, redshift-space positions",
        generatedBy: "scripts/build-galaxy-catalogs.mjs",
        binary: "2mrs.bin",
        byteLength: bin.length,
        count: n,
        layout: "columnar",
        encoding: "Float32 little-endian; field f occupies bytes [f*count*4, (f+1)*count*4); missing values are NaN (lvIndex uses -1)",
        fields: TWOMRS_FIELDS.map(([name, unit, description], f) => ({ name, unit, description, byteOffset: f * n * 4 })),
        rowOrder: "2MRS table3 order (ascending isophotal Ks)",
        distanceKind: "redshift",
        frame: "ICRS/J2000 equatorial positions; distances are redshift-space",
        cosmology: {
            H0: H0,
            H0Source: "Planck 2018 (A&A 641, A6); same value as src/constants.js DARK_ENERGY.H0_KM_S_MPC",
            cKms: C_KMS,
            distance: "distMpc = max(vCmb, vFloorKms) / H0 (linear Hubble law, no peculiar-velocity model)",
            vFloorKms: V_FLOOR_KMS,
            cmbDipole: {
                vKms: CMB_DIPOLE.vKms, lDeg: CMB_DIPOLE.lDeg, bDeg: CMB_DIPOLE.bDeg,
                raDeg: round(tm.apex.raDeg, 4), decDeg: round(tm.apex.decDeg, 4),
                source: "Planck 2018 I (Planck Collaboration I 2020, A&A 641, A1)",
                conversion: "(l, b) -> ICRS with the Hipparcos Galactic rotation matrix (ESA 1997 vol. 1 sect. 1.5.3)",
                velocityTransform: "1 + z_cmb = (1 + z_hel) / (gamma (1 - beta cos theta)), beta = vKms/c, theta = angle between the galaxy and the apex; first order: vCmb ~ cz + vKms cos theta",
            },
        },
        luminosity: {
            MK_SUN,
            note: "decode2mrs derives LK = 10^(-0.4 (KsMag - 5 log10(distMpc*1e5) - 3.28)) from the redshift distance (no K-correction; <~0.1 mag at 2MRS depths)",
        },
        caveats: [
            "Distances are redshift-space (Hubble-flow) estimates, not measurements: every galaxy carries a peculiar-velocity error of typically 200-600 km/s (3-9 Mpc at H0 = 67.66).",
            "Galaxy clusters appear stretched along the line of sight ('fingers of God'): 2MRS galaxies within 6 deg of the Virgo cluster centre span cz = -261..+2800 km/s (dispersion ~670 km/s, a +-10 Mpc smear in distMpc) although the cluster sits at ~16.5 Mpc; coherent infall squashes structures across the line of sight (Kaiser effect).",
            `Below vCmb = ${V_FLOOR_KMS} km/s the redshift distance is meaningless; such rows are pinned to ${round(V_FLOOR_KMS / H0, 3)} Mpc. Most have lvIndex >= 0 (a measured distance in local-volume.json - prefer it); the rest (stats.velocityFloorWithoutLvMatch) are blueshifted Virgo-cluster members (M86, M90, NGC 4419: really ~16.5 Mpc away) and a few unnamed low-latitude sources with unconfirmed negative redshifts.`,
            "Rows with lvIndex >= 0 duplicate a Local Volume galaxy (vCmb < 3000 km/s, within 2 arcmin - or a matching name within 15 arcmin - and |cz - hrv| <= 400 km/s): render them from local-volume.json instead.",
            "The linear Hubble law ignores the expansion history: vCmb/H0 exceeds the Planck 2018 comoving distance by ~1.2% at z = 0.05 and ~2.3% at z = 0.1 (see stats.zAbove0p1 for the few rows beyond).",
            "Selection: Ks <= 11.75 mag (isophotal, extinction corrected), |b| >= 5 deg (>= 8 deg toward the bulge); the Galactic plane is empty (zone of avoidance), and number density falls with distance (flux-limited sample).",
            "Position angles exist only where the 2MRS galaxy is found in the 2MASS XSC under the same designation; morphological types are nearly complete only for Ks <= 11.25 and |b| >= 10 deg.",
        ],
        selection: "2MRS main catalog (table3): Ks <= 11.75 mag and |b| >= 5 deg (8 deg toward the bulge); rows without a published cz are omitted",
        errata: tm.errata,
        typeCodes: ZCAT_TYPE_CODES,
        sources: [CITE_2MRS, CITE_2MASX],
        cosmologySources: CITE_PLANCK,
        license: LICENSE_NOTE,
        acknowledgment: [ACK_VIZIER, ACK_2MASS],
        localVolume: {
            file: "local-volume.json",
            count: lv.rows.length,
            dupMatch: `vCmb < ${DUP_VMAX_KMS} km/s and the nearest Local Volume galaxy within ${DUP_RADIUS_ARCMIN}' (or a matching name, incl. Messier/NGC twins, within ${DUP_NAME_RADIUS_ARCMIN}'), ` +
                `rejected if the LV heliocentric velocity differs from cz by more than ${DUP_MAX_DV_KMS} km/s`,
        },
        stats: tm.stats,
        inputs: inputs.splice(0),
    };
    writeAtomic(OUT_2MRS_MANIFEST, JSON.stringify(manifest, null, 1) + "\n");

    const kb = b => (b / 1024).toFixed(1) + " KiB";
    console.log(`CMB dipole apex (Planck 2018): l=${CMB_DIPOLE.lDeg} b=${CMB_DIPOLE.bDeg} -> RA=${tm.apex.raDeg.toFixed(4)} Dec=${tm.apex.decDeg.toFixed(4)} (check: back to l/b = ${JSON.stringify(Object.fromEntries(Object.entries(equatorialToGalacticDeg(tm.apex.raDeg, tm.apex.decDeg)).map(([k, v]) => [k, round(v, 6)])))})`);
    console.log(`local-volume.json: ${lv.rows.length} galaxies (${lv.stats.ungc} UNGC, ${lv.stats.ungcPlusMcc} UNGC+M12, ${lv.stats.mccOnly} M12-only; excluded ${lv.excluded.map(e => e.name).join(", ")}) ${kb(Buffer.byteLength(lvJson))}`);
    console.log(`2mrs.bin: ${n} galaxies x ${TWOMRS_FIELDS.length} Float32 fields = ${kb(bin.length)}; manifest ${kb(statSync(OUT_2MRS_MANIFEST).size)}`);
    console.log(`2MRS stats: ${JSON.stringify(tm.stats)}`);
}

main().catch(err => {
    console.error(err?.stack || err);
    process.exit(1);
});
