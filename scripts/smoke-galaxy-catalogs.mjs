// Smoke test for the observational galaxy catalogs (no browser):
// public/data/local-volume.json, public/data/2mrs.bin + 2mrs-manifest.json,
// decoded through src/universe/galaxyCatalogs.js. Rebuild them with
// `npm run catalog:galaxies`.
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { decode2mrs, decodeLocalVolume, equatorialUnitVector, load2mrs, loadLocalVolume, MK_SUN } from "../src/universe/galaxyCatalogs.js";

const DATA = new URL("../public/data/", import.meta.url);
const lvPath = new URL("local-volume.json", DATA);
const binPath = new URL("2mrs.bin", DATA);
const manifestPath = new URL("2mrs-manifest.json", DATA);

const DEG = Math.PI / 180;
const C_KMS = 299792.458;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sepDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) / DEG;
// ICRS -> Galactic (Hipparcos), used for |b| cuts in the clustering control.
const NGP = [-0.8676661490190047, -0.1980763734312015, 0.4559837761750669];
const galLatDeg = u => Math.asin(dot(NGP, u)) / DEG;

// --- Equatorial convention ---------------------------------------------------
{
    const close = (u, v) => u.every((x, i) => Math.abs(x - v[i]) < 1e-12);
    assert(close(equatorialUnitVector(0, 0), [1, 0, 0]), "RA 0, Dec 0 -> +x");
    assert(close(equatorialUnitVector(90, 0), [0, 1, 0]), "RA 90, Dec 0 -> +y");
    assert(close(equatorialUnitVector(0, 90), [0, 0, 1]), "Dec +90 -> +z (NCP)");
    const out = new Float64Array(5);
    equatorialUnitVector(180, 0, out, 2);
    assert(close([out[2], out[3], out[4]], [-1, 0, 0]) && out[0] === 0, "offset write");
}

// --- Local Volume -------------------------------------------------------------
const lvJson = JSON.parse(readFileSync(lvPath, "utf8"));
const lv = decodeLocalVolume(lvJson);
assert(lv.length >= 850 && lv.length <= 950, `Local Volume count ${lv.length} outside 850..950 (UNGC has 869)`);
assert(lv.meta && lv.meta.sources?.some(s => s.vizier === "J/AJ/145/101") && lv.meta.sources.some(s => s.vizier === "J/AJ/144/4"),
    "LV header must cite UNGC (J/AJ/145/101) and McConnachie 2012 (J/AJ/144/4)");
assert(typeof lv.meta.license === "string" && lv.meta.license.length > 50, "LV header carries a license note");
for (const f of ["name", "raDeg", "decDeg", "distMpc", "type", "LB", "MB", "diamKpc", "ba", "source"]) {
    assert(lv.meta.fields.includes(f), `LV field ${f} present`);
}

for (const [i, g] of lv.entries()) {
    assert.equal(g.index, i);
    assert(g.measured === true && g.distanceKind === "measured", `${g.name}: measured flag`);
    assert(Number.isFinite(g.raDeg) && g.raDeg >= 0 && g.raDeg < 360, `${g.name}: RA ${g.raDeg}`);
    assert(Number.isFinite(g.decDeg) && Math.abs(g.decDeg) <= 90, `${g.name}: Dec ${g.decDeg}`);
    assert(Number.isFinite(g.distMpc) && g.distMpc > 0.001, `${g.name}: ${g.distMpc} Mpc is within 1 kpc of the Sun (Milky Way leaked in?)`);
    assert(g.distMpc < 40, `${g.name}: ${g.distMpc} Mpc is beyond the Local Volume`);
    assert(Math.abs(g.ex * g.ex + g.ey * g.ey + g.ez * g.ez - 1) < 1e-12, `${g.name}: unit vector`);
    assert(["UNGC", "UNGC+M12", "M12"].includes(g.source), `${g.name}: source ${g.source}`);
    assert(g.distSource === "UNGC" || g.distSource === "M12", `${g.name}: distSource`);
    assert([1, 2, 3].includes(g.distQuality), `${g.name}: distQuality`);
    for (const k of ["distErrMpc", "MB", "LB", "MV", "lum", "logLK", "diamKpc", "ba", "inclDeg", "paDeg", "hrv", "vLG", "type"]) {
        assert(g[k] === null || Number.isFinite(g[k]), `${g.name}: ${k} must be finite or null`);
    }
    if (g.LB !== null) {
        assert(g.LB > 0 && Math.abs(Math.log10(g.LB) + 0.4 * (g.MB - 5.48)) < 1e-3, `${g.name}: LB = 10^(-0.4 (MB - 5.48))`);
    }
    if (g.ba !== null) assert(g.ba > 0 && g.ba <= 1, `${g.name}: b/a ${g.ba}`);
    if (g.paDeg !== null) assert(g.paDeg >= 0 && g.paDeg < 180 && g.paSource, `${g.name}: PA ${g.paDeg}`);
    if (i) assert(lv[i - 1].distMpc <= g.distMpc, "LV rows sorted by distance");
}
for (const g of lv) {
    const names = [g.name, g.displayName, ...(g.altNames || [])].map(s => String(s).toLowerCase());
    assert(!names.some(s => s === "milky way" || s === "the galaxy" || s === "the mw"), `Milky Way must be excluded (${g.name})`);
}

// Key Local Group galaxies at their expected positions/distances (+-10 %).
const KEY = [
    { label: "M31", ra: 10.68, dec: 41.27, d: 0.78, alias: "M31" },
    { label: "M33", ra: 23.46, dec: 30.66, d: 0.86, alias: "M33" },
    { label: "LMC", ra: 80.89, dec: -69.76, d: 0.050, alias: "LMC" },
    { label: "SMC", ra: 13.19, dec: -72.83, d: 0.062, alias: "SMC" },
];
const keyRows = {};
for (const k of KEY) {
    const u = equatorialUnitVector(k.ra, k.dec);
    let best = null, bestSep = Infinity;
    for (const g of lv) {
        const s = sepDeg(u, [g.ex, g.ey, g.ez]);
        if (s < bestSep) { bestSep = s; best = g; }
    }
    assert(best && bestSep < 0.1, `${k.label}: no Local Volume galaxy within 0.1 deg of (${k.ra}, ${k.dec}); nearest ${best?.name} at ${bestSep.toFixed(3)} deg`);
    const names = [best.name, best.displayName, ...(best.altNames || [])];
    assert(names.includes(k.alias), `${k.label}: nearest row is ${best.name} (${names.join(", ")})`);
    assert(Math.abs(best.distMpc / k.d - 1) <= 0.10, `${k.label}: ${best.distMpc} Mpc vs expected ~${k.d}`);
    assert.equal(best.distSource, "M12", `${k.label}: Local Group distance should come from McConnachie 2012`);
    keyRows[k.label] = best;
}

// --- 2MRS -----------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const bin = readFileSync(binPath);
const g2 = decode2mrs(bin, manifest);
const n = g2.count;
assert(n >= 42000 && n <= 44599, `2MRS count ${n} outside 42000..44599`);
assert.equal(g2.distanceKind, "redshift");
assert.equal(manifest.distanceKind, "redshift");
assert(manifest.caveats.some(c => /fingers of god/i.test(c)), "manifest must carry the fingers-of-God caveat");
assert(manifest.sources.some(s => s.vizier === "J/ApJS/199/26"), "manifest cites 2MRS (J/ApJS/199/26)");
assert(typeof manifest.license === "string" && manifest.license.length > 50, "manifest carries a license note");
const totalBytes = statSync(binPath).size + statSync(manifestPath).size;
assert(totalBytes < 2 * 1024 * 1024, `2MRS payload ${totalBytes} bytes exceeds 2 MiB`);

// Cosmology: H0 must match the app's DARK_ENERGY constant; CMB apex (l, b) =
// (264.021, 48.253) is (RA, Dec) = (167.942, -6.944) in ICRS.
const H0 = manifest.cosmology.H0;
const constantsSrc = readFileSync(new URL("../src/constants.js", import.meta.url), "utf8");
const appH0 = Number(constantsSrc.match(/H0_KM_S_MPC:\s*([\d.]+)/)?.[1]);
assert(Number.isFinite(appH0), "could not read DARK_ENERGY.H0_KM_S_MPC from src/constants.js");
assert.equal(H0, appH0, `2MRS H0 ${H0} != src/constants.js H0 ${appH0}; rebuild with npm run catalog:galaxies`);
const dip = manifest.cosmology.cmbDipole;
assert(Math.abs(dip.raDeg - 167.942) < 0.01 && Math.abs(dip.decDeg + 6.944) < 0.01, `CMB apex RA/Dec ${dip.raDeg}, ${dip.decDeg}`);
const apex = equatorialUnitVector(dip.raDeg, dip.decDeg);
const beta = dip.vKms / C_KMS, gamma = 1 / Math.sqrt(1 - beta * beta);
const vFloor = manifest.cosmology.vFloorKms;

let floorRows = 0, dupRows = 0, typed = 0, withPa = 0, maxCmbResid = 0;
for (let i = 0; i < n; i++) {
    const ra = g2.raDeg[i], dec = g2.decDeg[i], d = g2.distMpc[i];
    assert(Number.isFinite(ra) && ra >= 0 && ra < 360 && Number.isFinite(dec) && Math.abs(dec) <= 90, `2MRS row ${i}: position`);
    assert(Number.isFinite(g2.cz[i]) && Number.isFinite(g2.vCmb[i]) && Number.isFinite(g2.KsMag[i]), `2MRS row ${i}: cz/vCmb/Ks finite`);
    assert(Number.isFinite(d) && d > 0, `2MRS row ${i}: distance ${d} must be positive`);
    assert(Number.isFinite(g2.LK[i]) && g2.LK[i] > 0, `2MRS row ${i}: LK`);
    const norm = g2.ex[i] * g2.ex[i] + g2.ey[i] * g2.ey[i] + g2.ez[i] * g2.ez[i];
    assert(Math.abs(norm - 1) < 1e-12, `2MRS row ${i}: unit vector norm ${norm}`);
    assert(g2.KsMag[i] > -3 && g2.KsMag[i] < 13, `2MRS row ${i}: Ks ${g2.KsMag[i]}`);
    // decoded columns: NaN allowed only where the manifest says "missing"
    if (!Number.isNaN(g2.type[i])) { assert(Number.isInteger(g2.type[i]) && g2.type[i] >= -9 && g2.type[i] <= 20, `row ${i}: type ${g2.type[i]}`); typed++; }
    if (!Number.isNaN(g2.ba[i])) assert(g2.ba[i] > 0 && g2.ba[i] <= 1, `row ${i}: b/a ${g2.ba[i]}`);
    if (!Number.isNaN(g2.pa[i])) { assert(g2.pa[i] >= 0 && g2.pa[i] < 180, `row ${i}: PA ${g2.pa[i]}`); withPa++; }
    // CMB frame: 1 + z_cmb = (1 + z_hel) / (gamma (1 - beta cos theta))
    const cosT = g2.ex[i] * apex[0] + g2.ey[i] * apex[1] + g2.ez[i] * apex[2];
    const vPred = C_KMS * ((1 + g2.cz[i] / C_KMS) / (gamma * (1 - beta * cosT)) - 1);
    maxCmbResid = Math.max(maxCmbResid, Math.abs(vPred - g2.vCmb[i]));
    // Hubble-flow distance with the velocity floor
    const dPred = Math.max(g2.vCmb[i], vFloor) / H0;
    assert(Math.abs(d / dPred - 1) < 1e-6, `row ${i}: distMpc ${d} != max(vCmb, floor)/H0 = ${dPred}`);
    if (g2.vCmb[i] < vFloor) floorRows++;
    const k = g2.lvIndex[i];
    assert(Number.isInteger(k) && k >= -1 && k < lv.length, `row ${i}: lvIndex ${k}`);
    if (k >= 0) {
        dupRows++;
        assert(g2.vCmb[i] < 3000, `row ${i}: LV duplicate with vCmb ${g2.vCmb[i]}`);
        assert(sepDeg([g2.ex[i], g2.ey[i], g2.ez[i]], [lv[k].ex, lv[k].ey, lv[k].ez]) * 60 < 15, `row ${i}: LV duplicate too far from ${lv[k].name}`);
    }
}
assert(maxCmbResid < 0.05, `CMB-frame velocities inconsistent with the dipole transform (max residual ${maxCmbResid} km/s)`);
assert(withPa / n > 0.95, `only ${withPa}/${n} galaxies carry a position angle`);
assert(typed / n > 0.5, `only ${typed}/${n} galaxies carry a morphological type`);
assert(dupRows >= 100 && dupRows <= 400, `LV duplicates ${dupRows} outside 100..400`);

// Dedupe: the 2MRS rows at M31/M33 point at the Local Volume rows, and 2MRS K
// photometry at the measured LV distance reproduces UNGC's log L_K.
const nearest2mrs = u => {
    let best = -1, bestSep = Infinity;
    for (let i = 0; i < n; i++) {
        const s = sepDeg(u, [g2.ex[i], g2.ey[i], g2.ez[i]]);
        if (s < bestSep) { bestSep = s; best = i; }
    }
    return { i: best, sepArcmin: bestSep * 60 };
};
for (const label of ["M31", "M33"]) {
    const row = keyRows[label];
    const hit = nearest2mrs([row.ex, row.ey, row.ez]);
    assert(hit.sepArcmin < 2, `${label}: no 2MRS counterpart within 2'`);
    assert.equal(g2.lvIndex[hit.i], row.index, `${label}: 2MRS row should be flagged as a duplicate of LV row ${row.index}`);
}
const dLogLK = [];
for (let i = 0; i < n; i++) {
    const k = g2.lvIndex[i];
    if (k < 0 || lv[k].logLK === null) continue;
    const MK = g2.KsMag[i] - 5 * Math.log10(lv[k].distMpc * 1e5);
    dLogLK.push(Math.abs(0.4 * (MK_SUN - MK) - lv[k].logLK));
}
dLogLK.sort((a, b) => a - b);
const medDLogLK = dLogLK[dLogLK.length >> 1];
assert(medDLogLK < 0.25, `median |2MRS vs UNGC log L_K| = ${medDLogLK.toFixed(3)} dex at the LV distance`);

// --- Large-scale structure: cluster overdensities vs equal-area random caps ------
function capCount(center, radiusDeg, v0, v1) {
    const cr = Math.cos(radiusDeg * DEG);
    let count = 0;
    for (let i = 0; i < n; i++) {
        const cz = g2.cz[i];
        if (cz <= v0 || cz >= v1) continue;
        if (g2.ex[i] * center[0] + g2.ey[i] * center[1] + g2.ez[i] * center[2] >= cr) count++;
    }
    return count;
}
let seed = 0x2a2a2a2a;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const VIRGO = equatorialUnitVector(187.7, 12.4);
const COMA = equatorialUnitVector(194.95, 27.98);
// Control: equal-area caps at uniformly random directions inside the survey
// footprint (|b| >= 20 deg) and >= 20 deg from both clusters.
function controlMean(radiusDeg, v0, v1, caps = 600) {
    let total = 0, max = 0, k = 0;
    while (k < caps) {
        const z = 2 * rand() - 1, phi = 2 * Math.PI * rand(), r = Math.sqrt(1 - z * z);
        const c = [r * Math.cos(phi), r * Math.sin(phi), z];
        if (Math.abs(galLatDeg(c)) < 20 || sepDeg(c, VIRGO) < 20 || sepDeg(c, COMA) < 20) continue;
        const cnt = capCount(c, radiusDeg, v0, v1);
        total += cnt; max = Math.max(max, cnt); k++;
    }
    return { mean: total / caps, max };
}
// Virgo (~16.5 Mpc): 6 deg ~ 1.7 Mpc. Coma (~100 Mpc): a 2 deg cap spans a
// similar ~3.5 Mpc; at 6 deg the Coma cap is dominated by field galaxies.
const virgo = { n: capCount(VIRGO, 6, 800, 2800), ...controlMean(6, 800, 2800) };
const coma = { n: capCount(COMA, 2, 5000, 9500), ...controlMean(2, 5000, 9500) };
assert(virgo.n >= 140, `Virgo: only ${virgo.n} galaxies within 6 deg at 800 < cz < 2800 (expected >= 140; measured 152 at build time)`);
assert(virgo.n >= 10 * virgo.mean, `Virgo overdensity ${(virgo.n / virgo.mean).toFixed(1)}x < 10x the random-cap mean ${virgo.mean.toFixed(2)}`);
assert(virgo.n > virgo.max, `Virgo count ${virgo.n} must exceed every random control cap (max ${virgo.max})`);
assert(coma.n >= 100, `Coma: only ${coma.n} galaxies within 2 deg at 5000 < cz < 9500 (expected >= 100; measured 125 at build time)`);
assert(coma.n >= 10 * coma.mean, `Coma overdensity ${(coma.n / coma.mean).toFixed(1)}x < 10x the random-cap mean ${coma.mean.toFixed(2)}`);
assert(coma.n > coma.max, `Coma count ${coma.n} must exceed every random control cap (max ${coma.max})`);

// --- Browser loaders (fetch injected; public/ is served at the site root) -------
const served = [];
const fakeFetch = async url => {
    served.push(url);
    const m = String(url).match(/^(?:https:\/\/example\.test\/app)?\/data\/([\w.-]+)$/);
    if (!m) return { ok: false, status: 404 };
    const buf = readFileSync(new URL(m[1], DATA));
    return {
        ok: true,
        status: 200,
        json: async () => JSON.parse(buf.toString("utf8")),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
};
const lvLoaded = await loadLocalVolume("", { fetch: fakeFetch });
assert.equal(lvLoaded.length, lv.length, "loadLocalVolume decodes every row");
assert.equal(await loadLocalVolume("", { fetch: fakeFetch }), lvLoaded, "loadLocalVolume memoises per URL");
const g2Loaded = await load2mrs("https://example.test/app/", { fetch: fakeFetch });
assert.equal(g2Loaded.count, n, "load2mrs decodes every row");
assert.equal(g2Loaded.distMpc[123], g2.distMpc[123]);
assert.deepEqual(served, ["/data/local-volume.json", "https://example.test/app/data/2mrs-manifest.json", "https://example.test/app/data/2mrs.bin"],
    "loaders fetch <baseUrl>/data/... and the binary named by the manifest");
await assert.rejects(loadLocalVolume("https://missing.test", { fetch: fakeFetch }), /HTTP 404/);
await assert.rejects(loadLocalVolume("https://missing.test", { fetch: fakeFetch }), /HTTP 404/, "failed loads are not memoised");
assert.equal(served.filter(u => u.startsWith("https://missing.test")).length, 2);

const kb = b => (b / 1024).toFixed(1) + " KiB";
console.log("smoke-galaxy-catalogs ok");
console.log(`  local-volume.json  ${lv.length} galaxies (${lv.filter(g => g.source !== "UNGC").length} with McConnachie values), ${kb(statSync(lvPath).size)}; nearest ${lv[0].displayName} ${lv[0].distMpc} Mpc, farthest ${lv[lv.length - 1].displayName} ${lv[lv.length - 1].distMpc} Mpc`);
for (const k of KEY) {
    const g = keyRows[k.label];
    console.log(`    ${k.label.padEnd(4)} ${g.displayName.padEnd(11)} RA ${g.raDeg.toFixed(3).padStart(7)} Dec ${g.decDeg.toFixed(3).padStart(7)}  ${g.distMpc.toFixed(4)} Mpc (${g.distSource}, ${g.distMethod})`);
}
console.log(`  2mrs.bin           ${n} galaxies, ${kb(bin.length)} + manifest ${kb(statSync(manifestPath).size)}; ${dupRows} flagged as LV duplicates, ${floorRows} on the ${vFloor} km/s floor, PA for ${withPa}, type for ${typed}`);
console.log(`    CMB apex RA ${dip.raDeg} Dec ${dip.decDeg}; max dipole residual ${maxCmbResid.toFixed(4)} km/s; H0 ${H0} (matches src/constants.js)`);
console.log(`    median |dlogL_K| 2MRS@LV-distance vs UNGC: ${medDLogLK.toFixed(3)} dex over ${dLogLK.length} duplicates`);
console.log(`  Virgo  6 deg, 800<cz<2800 : ${virgo.n} galaxies vs random-cap mean ${virgo.mean.toFixed(2)} (max ${virgo.max}) -> ${(virgo.n / virgo.mean).toFixed(1)}x`);
console.log(`  Coma   2 deg, 5000<cz<9500: ${coma.n} galaxies vs random-cap mean ${coma.mean.toFixed(2)} (max ${coma.max}) -> ${(coma.n / coma.mean).toFixed(1)}x`);
