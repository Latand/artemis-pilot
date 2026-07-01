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

const CACHE_DIR = new URL("../cache/", import.meta.url);
const OUT_DIR = new URL("../public/data/", import.meta.url);
const OUT_BIN = new URL("../public/data/athyg-tier1.bin", import.meta.url);
const OUT_MANIFEST = new URL("../public/data/athyg-tier1-manifest.json", import.meta.url);
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

    const INITIAL_CAP = 2_800_000;
    const cx = new Column(Float64Array, INITIAL_CAP);
    const cy = new Column(Float64Array, INITIAL_CAP);
    const cz = new Column(Float64Array, INITIAL_CAP);
    const cmag = new Column(Float64Array, INITIAL_CAP);
    const cci = new Column(Float64Array, INITIAL_CAP);
    const cpmra = new Column(Float64Array, INITIAL_CAP);
    const cpmdec = new Column(Float64Array, INITIAL_CAP);
    const cpix = new Column(Int32Array, INITIAL_CAP);

    let IDX = null;
    let rowsSeen = 0;
    let noDistance = 0;
    let dedupedCount = 0;
    let accepted = 0;

    const DEG2RAD = Math.PI / 180;

    function processRow(cols) {
        rowsSeen++;
        const dist = num(cols[IDX.dist]);
        if (!(dist > 0)) { noDistance++; return; }

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

        const mag = num(cols[IDX.mag]);
        if (mag === null) return;
        const ci = num(cols[IDX.ci]) ?? 0;
        const pmra = num(cols[IDX.pm_ra]) ?? 0;
        const pmdec = num(cols[IDX.pm_dec]) ?? 0;

        const pix = ang2pix_nest(ORDER, raDeg, decDeg);

        cx.push(x); cy.push(y); cz.push(z);
        cmag.push(mag); cci.push(ci); cpmra.push(pmra); cpmdec.push(pmdec);
        cpix.push(pix);
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
        console.log(`processed file ${fi + 1}/${cachePaths.length}: rowsSeen=${rowsSeen} accepted=${accepted} noDistance=${noDistance} deduped=${dedupedCount}`);
    }

    if (!IDX) throw new Error("never found AT-HYG header row (file 1 empty?)");

    const n = accepted;
    console.log(`total AT-HYG rows seen: ${rowsSeen}, accepted into Tier-1: ${n}, skipped (no distance): ${noDistance}, deduped vs Tier-0: ${dedupedCount}`);

    const x = cx.view(), y = cy.view(), z = cz.view();
    const mag = cmag.view(), ci = cci.view(), pmra = cpmra.view(), pmdec = cpmdec.view();
    const pix = cpix.view();

    // Stable sort by (pix, mag) so within each tile stars are mag-ascending and the
    // whole file is deterministic across runs.
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const orderArr = Array.from(order);
    orderArr.sort((a, b) => (pix[a] - pix[b]) || (mag[a] - mag[b]) || (a - b));

    const outBuf = Buffer.allocUnsafe(n * RECORD_BYTES);
    const tiles = new Array(NPIX);
    let cursor = 0;
    let byteOffset = 0;
    for (let t = 0; t < NPIX; t++) {
        const start = cursor;
        while (cursor < n && pix[orderArr[cursor]] === t) cursor++;
        const count = cursor - start;
        tiles[t] = [byteOffset, count];
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
    if (cursor !== n) throw new Error(`tile bucketing did not consume all rows: cursor=${cursor} n=${n}`);
    if (byteOffset !== n * RECORD_BYTES) throw new Error("byte offset mismatch after packing");

    await writeFile(OUT_BIN, outBuf);
    await writeFile(OUT_MANIFEST, JSON.stringify({
        schema: 1,
        source: "AT-HYG v3.3 (Astronexus, https://codeberg.org/astronexus/athyg), CC BY-SA 4.0",
        order: ORDER,
        npix: NPIX,
        recordBytes: RECORD_BYTES,
        fields: ["xPc", "yPc", "zPc", "magX100", "ciX1000", "pmRaMasYrX10", "pmDecMasYrX10"],
        encoding: "xyz: Float32 LE parsecs; mag/ci/pmRa/pmDec: Int16 LE scaled as named",
        units: { position: "parsec", pm: "mas/yr" },
        count: n,
        dedupCount: dedupedCount,
        skippedNoDistance: noDistance,
        rowsSeen,
        tiles,
    }));

    const stBin = await stat(OUT_BIN);
    console.log(`wrote ${OUT_BIN.pathname} (${stBin.size} bytes, ${(stBin.size / 1e6).toFixed(1)} MB) and ${OUT_MANIFEST.pathname}`);
    console.log(`count=${n} dedupCount=${dedupedCount} skippedNoDistance=${noDistance}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
