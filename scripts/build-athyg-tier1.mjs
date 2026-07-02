// Builds the Tier-1 "no known star missed" base layer from AT-HYG v3.3
// (Astronexus, https://codeberg.org/astronexus/athyg, CC BY-SA 4.0), HEALPix-tiled
// (order 5, nested scheme) for range-fetch streaming at runtime.
//
// Output:
//   public/data/athyg-tier1.bin              20 B/star records, tiles concatenated in pix order
//   public/data/athyg-tier1-manifest.json     { schema, order, npix, recordBytes, count, dedupCount, tiles:[[byteOffset,count],...] }
//
// Dedup decision (simplification of the plan's "flag" approach, recorded here per the
// work-package instructions): rows whose AT-HYG `hyg` id (== this project's Tier-0 HYG
// "id" field, verified against Sirius/Vega below) or `hip` id match a Tier-0 star are
// EXCLUDED from the Tier-1 tiles entirely at build time, rather than flagged and
// runtime-skipped. Tier-0 (119k stars) is always loaded, so build-time exclusion is
// strictly simpler and carries no runtime cost or risk of a missed flag check.

import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { ang2pix_nest, ORDER, NPIX } from "../src/universe/healpix.js";
import { msAbsMagFromColor } from "../src/universe/mainSequenceCM.js";

const CACHE_DIR = new URL("../cache/", import.meta.url);
const OUT_DIR = new URL("../public/data/", import.meta.url);
const OUT_BIN = new URL("../public/data/athyg-tier1.bin", import.meta.url);
const OUT_MANIFEST = new URL("../public/data/athyg-tier1-manifest.json", import.meta.url);
const OUT_EST_BIN = new URL("../public/data/athyg-tier1-estimated.bin", import.meta.url);
const OUT_EST_MANIFEST = new URL("../public/data/athyg-tier1-estimated-manifest.json", import.meta.url);
const TIER0_IDS_PATH = new URL("../public/data/hyg-tier0-ids.json", import.meta.url);

// AT-HYG ships via Codeberg's Git LFS; the plain `/raw/` endpoint returns only the
// LFS pointer stub, so the actual blob content must come from the `/media/` endpoint
// (verified: /raw/ gave a 133-byte pointer file, /media/ gave the real ~99-100 MB blob).
const FILES = [
    "https://codeberg.org/astronexus/athyg/media/branch/main/data/athyg_v33-1.csv.gz",
    "https://codeberg.org/astronexus/athyg/media/branch/main/data/athyg_v33-2.csv.gz",
];

const RECORD_BYTES = 20;

function parseCsvLine(line) {
    const out = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (ch === '"') quoted = false;
            else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") { out.push(cur); cur = ""; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}

const num = v => {
    if (v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

function clampInt16(v) {
    const r = Math.round(v);
    return Math.max(-32768, Math.min(32767, r));
}

async function downloadWithRetry(url, destPath, attempt = 1) {
    if (existsSync(destPath)) {
        const st = await stat(destPath);
        if (st.size > 0) {
            console.log(`cache hit: ${destPath} (${st.size} bytes)`);
            return;
        }
    }
    console.log(`downloading ${url} -> ${destPath} (attempt ${attempt})`);
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
        const expected = Number(res.headers.get("content-length") || 0);
        await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
        const st = await stat(destPath);
        if (expected && st.size !== expected) {
            throw new Error(`downloaded size ${st.size} does not match content-length ${expected}`);
        }
        console.log(`downloaded ${destPath} (${st.size} bytes)`);
    } catch (err) {
        if (attempt >= 2) throw err;
        console.warn(`download failed (${err.message}), retrying once...`);
        await downloadWithRetry(url, destPath, attempt + 1);
    }
}

// A minimal growable typed-array-backed column store, since the final star count
// isn't known ahead of streaming the CSVs (distance-missing rows and dedup hits are
// both discovered row-by-row).
class Column {
    constructor(Ctor, initialCapacity) {
        this.Ctor = Ctor;
        this.buf = new Ctor(initialCapacity);
        this.len = 0;
    }
    push(v) {
        if (this.len >= this.buf.length) {
            const grown = new this.Ctor(this.buf.length * 2);
            grown.set(this.buf);
            this.buf = grown;
        }
        this.buf[this.len++] = v;
    }
    view() {
        return this.buf.subarray(0, this.len);
    }
}

function makeColumns(initialCapacity) {
    return {
        x: new Column(Float64Array, initialCapacity),
        y: new Column(Float64Array, initialCapacity),
        z: new Column(Float64Array, initialCapacity),
        mag: new Column(Float64Array, initialCapacity),
        ci: new Column(Float64Array, initialCapacity),
        pmra: new Column(Float64Array, initialCapacity),
        pmdec: new Column(Float64Array, initialCapacity),
        pix: new Column(Int32Array, initialCapacity),
    };
}

function pushStar(cols, x, y, z, mag, ci, pmra, pmdec, pix) {
    cols.x.push(x); cols.y.push(y); cols.z.push(z);
    cols.mag.push(mag); cols.ci.push(ci); cols.pmra.push(pmra); cols.pmdec.push(pmdec);
    cols.pix.push(pix);
}

async function emitCatalog({ columns, count, outBin, outManifest, manifestExtra = {} }) {
    const x = columns.x.view(), y = columns.y.view(), z = columns.z.view();
    const mag = columns.mag.view(), ci = columns.ci.view(), pmra = columns.pmra.view(), pmdec = columns.pmdec.view();
    const pix = columns.pix.view();

    // Stable sort by (pix, mag) so within each tile stars are mag-ascending and the
    // whole file is deterministic across runs.
    const order = new Uint32Array(count);
    for (let i = 0; i < count; i++) order[i] = i;
    const orderArr = Array.from(order);
    orderArr.sort((a, b) => (pix[a] - pix[b]) || (mag[a] - mag[b]) || (a - b));

    const outBuf = Buffer.allocUnsafe(count * RECORD_BYTES);
    const tiles = new Array(NPIX);
    let cursor = 0;
    let byteOffset = 0;
    for (let t = 0; t < NPIX; t++) {
        const start = cursor;
        while (cursor < count && pix[orderArr[cursor]] === t) cursor++;
        const tileCount = cursor - start;
        tiles[t] = [byteOffset, tileCount];
        for (let k = start; k < cursor; k++) {
            const idx = orderArr[k];
            let o = byteOffset;
            outBuf.writeFloatLE(x[idx], o); o += 4;
            outBuf.writeFloatLE(y[idx], o); o += 4;
            outBuf.writeFloatLE(z[idx], o); o += 4;
            outBuf.writeInt16LE(clampInt16(mag[idx] * 100), o); o += 2;
            outBuf.writeInt16LE(clampInt16(ci[idx] * 1000), o); o += 2;
            outBuf.writeInt16LE(clampInt16(pmra[idx] * 10), o); o += 2;
            outBuf.writeInt16LE(clampInt16(pmdec[idx] * 10), o); o += 2;
            byteOffset += RECORD_BYTES;
        }
    }
    if (cursor !== count) throw new Error(`tile bucketing did not consume all rows: cursor=${cursor} count=${count}`);
    if (byteOffset !== count * RECORD_BYTES) throw new Error("byte offset mismatch after packing");

    await writeFile(outBin, outBuf);
    await writeFile(outManifest, JSON.stringify({
        schema: 1,
        source: "AT-HYG v3.3 (Astronexus, https://codeberg.org/astronexus/athyg), CC BY-SA 4.0",
        order: ORDER,
        npix: NPIX,
        recordBytes: RECORD_BYTES,
        fields: ["xPc", "yPc", "zPc", "magX100", "ciX1000", "pmRaMasYrX10", "pmDecMasYrX10"],
        encoding: "xyz: Float32 LE parsecs; mag/ci/pmRa/pmDec: Int16 LE scaled as named",
        units: { position: "parsec", pm: "mas/yr" },
        count,
        ...manifestExtra,
        tiles,
    }));

    return stat(outBin);
}

async function ensureTier0Ids() {
    if (existsSync(TIER0_IDS_PATH)) return;
    console.log("public/data/hyg-tier0-ids.json missing; running catalog:hyg to produce it...");
    execFileSync("node", [new URL("./build-hyg-catalog.mjs", import.meta.url).pathname], {
        stdio: "inherit",
        cwd: new URL("../", import.meta.url).pathname,
    });
}

async function main() {
    await mkdir(CACHE_DIR, { recursive: true });
    await mkdir(OUT_DIR, { recursive: true });
    await ensureTier0Ids();

    const tier0 = JSON.parse(await readFile(TIER0_IDS_PATH, "utf8"));
    const tier0HygIds = new Set(tier0.hyg);
    const tier0HipIds = new Set(tier0.hip);
    console.log(`Tier-0 dedup keys: ${tier0HygIds.size} hyg ids, ${tier0HipIds.size} hip ids`);

    const cachePaths = FILES.map(url => new URL(url.split("/").pop(), CACHE_DIR));
    for (let i = 0; i < FILES.length; i++) {
        await downloadWithRetry(FILES[i], cachePaths[i].pathname);
    }

    const primaryCols = makeColumns(2_800_000);
    const estimatedCols = makeColumns(70_000);

    let IDX = null;
    let rowsSeen = 0;
    let noDistance = 0;
    let noDistanceMissingPhotometry = 0;
    let dedupedCount = 0;
    let dedupedEstimatedCount = 0;
    let accepted = 0;
    let estimatedAccepted = 0;

    const DEG2RAD = Math.PI / 180;

    function processRow(cols) {
        rowsSeen++;
        const dist = num(cols[IDX.dist]);
        const mag = num(cols[IDX.mag]);
        const ciRaw = num(cols[IDX.ci]);
        if (!(dist > 0)) {
            noDistance++;
            if (mag === null || ciRaw === null) {
                noDistanceMissingPhotometry++;
                return;
            }

            const hygId = num(cols[IDX.hyg]);
            const hipId = num(cols[IDX.hip]);
            if ((hygId !== null && tier0HygIds.has(hygId)) || (hipId !== null && tier0HipIds.has(hipId))) {
                dedupedEstimatedCount++;
                return;
            }

            const raHours = num(cols[IDX.ra]);
            const decDeg = num(cols[IDX.dec]);
            if (raHours === null || decDeg === null) return;
            const raDeg = raHours * 15;
            const absMag = msAbsMagFromColor(ciRaw);
            const distPc = Math.pow(10, (mag - absMag + 5) / 5);
            if (!(distPc > 0) || !Number.isFinite(distPc)) return;
            const raRad = raDeg * DEG2RAD, decRad = decDeg * DEG2RAD;
            const cosDec = Math.cos(decRad);
            const x = distPc * cosDec * Math.cos(raRad);
            const y = distPc * cosDec * Math.sin(raRad);
            const z = distPc * Math.sin(decRad);
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
            const pmra = num(cols[IDX.pm_ra]) ?? 0;
            const pmdec = num(cols[IDX.pm_dec]) ?? 0;
            const pix = ang2pix_nest(ORDER, raDeg, decDeg);
            pushStar(estimatedCols, x, y, z, mag, ciRaw, pmra, pmdec, pix);
            estimatedAccepted++;
            return;
        }

        const hygId = num(cols[IDX.hyg]);
        const hipId = num(cols[IDX.hip]);
        if ((hygId !== null && tier0HygIds.has(hygId)) || (hipId !== null && tier0HipIds.has(hipId))) {
            dedupedCount++;
            return;
        }

        const raHours = num(cols[IDX.ra]);
        const decDeg = num(cols[IDX.dec]);
        if (raHours === null || decDeg === null) return;
        const raDeg = raHours * 15;

        let x = num(cols[IDX.x0]);
        let y = num(cols[IDX.y0]);
        let z = num(cols[IDX.z0]);
        if (x === null || y === null || z === null) {
            // Fallback: derive from ra/dec/dist using the same equatorial-cartesian
            // convention as the precomputed x0/y0/z0 columns (verified identical to
            // Tier-0's xPc/yPc/zPc for Sirius and Vega to within rounding).
            const raRad = raDeg * DEG2RAD, decRad = decDeg * DEG2RAD;
            const cosDec = Math.cos(decRad);
            x = dist * cosDec * Math.cos(raRad);
            y = dist * cosDec * Math.sin(raRad);
            z = dist * Math.sin(decRad);
        }
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;

        if (mag === null) return;
        const ci = ciRaw ?? 0;
        const pmra = num(cols[IDX.pm_ra]) ?? 0;
        const pmdec = num(cols[IDX.pm_dec]) ?? 0;

        const pix = ang2pix_nest(ORDER, raDeg, decDeg);

        pushStar(primaryCols, x, y, z, mag, ci, pmra, pmdec, pix);
        accepted++;
    }

    // File 1 carries the header; file 2 is a raw continuation with no header of its own
    // (verified: file 2's first bytes are already a data row, not a header line).
    for (let fi = 0; fi < cachePaths.length; fi++) {
        const gunzip = createGunzip();
        const rl = createInterface({
            input: createReadStream(cachePaths[fi].pathname).pipe(gunzip),
            crlfDelay: Infinity,
        });
        let isFirstLine = true;
        for await (const line of rl) {
            if (!line) continue;
            if (fi === 0 && isFirstLine) {
                const header = parseCsvLine(line);
                const at = name => {
                    const i = header.indexOf(name);
                    if (i < 0) throw new Error(`missing AT-HYG column ${name}`);
                    return i;
                };
                IDX = Object.fromEntries(
                    ["hyg", "hip", "ra", "dec", "dist", "x0", "y0", "z0", "mag", "ci", "pm_ra", "pm_dec"]
                        .map(k => [k, at(k)]),
                );
                isFirstLine = false;
                continue;
            }
            isFirstLine = false;
            processRow(parseCsvLine(line));
        }
        console.log(`processed file ${fi + 1}/${cachePaths.length}: rowsSeen=${rowsSeen} accepted=${accepted} estimated=${estimatedAccepted} noDistance=${noDistance} noDistanceMissingPhotometry=${noDistanceMissingPhotometry} deduped=${dedupedCount} dedupedEstimated=${dedupedEstimatedCount}`);
    }

    if (!IDX) throw new Error("never found AT-HYG header row (file 1 empty?)");

    const n = accepted;
    console.log(`total AT-HYG rows seen: ${rowsSeen}, accepted into Tier-1: ${n}, estimated sidecar: ${estimatedAccepted}, skipped (no distance): ${noDistance}, missing mag/ci among no-distance: ${noDistanceMissingPhotometry}, deduped vs Tier-0: ${dedupedCount}, estimated deduped vs Tier-0: ${dedupedEstimatedCount}`);

    const stBin = await emitCatalog({
        columns: primaryCols,
        count: n,
        outBin: OUT_BIN,
        outManifest: OUT_MANIFEST,
        manifestExtra: {
            dedupCount: dedupedCount,
            skippedNoDistance: noDistance,
            rowsSeen,
        },
    });
    const stEstBin = await emitCatalog({
        columns: estimatedCols,
        count: estimatedAccepted,
        outBin: OUT_EST_BIN,
        outManifest: OUT_EST_MANIFEST,
        manifestExtra: {
            estimated: true,
            distanceModel: "main-sequence B-V photometric distance; M_V from src/universe/mainSequenceCM.js",
            dedupCount: dedupedEstimatedCount,
            skippedNoDistanceMissingPhotometry: noDistanceMissingPhotometry,
            skippedNoDistance: noDistance,
            rowsSeen,
        },
    });

    console.log(`wrote ${OUT_BIN.pathname} (${stBin.size} bytes, ${(stBin.size / 1e6).toFixed(1)} MB) and ${OUT_MANIFEST.pathname}`);
    console.log(`wrote ${OUT_EST_BIN.pathname} (${stEstBin.size} bytes, ${(stEstBin.size / 1e6).toFixed(1)} MB) and ${OUT_EST_MANIFEST.pathname}`);
    console.log(`count=${n} dedupCount=${dedupedCount} skippedNoDistance=${noDistance} estimatedCount=${estimatedAccepted} estimatedDedupCount=${dedupedEstimatedCount} noDistanceMissingPhotometry=${noDistanceMissingPhotometry}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
