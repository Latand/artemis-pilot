import { mkdir, writeFile } from "node:fs/promises";

const HYG_URL = "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv";
const OUT = new URL("../public/data/hyg-stars-v41.json", import.meta.url);
const OUT_BIN = new URL("../public/data/hyg-stars-v41.bin", import.meta.url);
const OUT_PHYSICAL = new URL("../src/generated/hygPhysicalStars.js", import.meta.url);
const SOLAR_TEMP_K = 5772;
const SOLAR_ABS_MAG = 4.83;
const PC_LY = 3.261563777;
const PHYSICAL_STAR_LIMIT = 36;
const CURATED_NAMES = new Set([
    "PROXIMA", "ALPHA CEN A", "ALPHA CEN B", "BARNARD", "WOLF 359", "SIRIUS A",
    "EPSILON ERIDANI", "TAU CETI", "VEGA", "SGR A*", "LUHMAN 16", "WISE 0855-0714",
    "LALANDE 21185", "ROSS 154", "ROSS 248", "LACAILLE 9352", "ROSS 128",
    "PROCYON A", "61 CYGNI A", "61 CYGNI B", "GROOMBRIDGE 34 A", "EPSILON INDI A",
    "TEEGARDEN", "KAPTEYN", "VAN MAANEN", "ALTAIR", "FOMALHAUT", "ARCTURUS",
    "CAPELLA", "ALDEBARAN", "REGULUS", "SPICA", "POLARIS", "BETELGEUSE",
    "ANTARES", "RIGEL", "DENEB",
    "SIRIUS", "PROCYON", "RIGIL KENTAURUS", "TOLIMAN", "RAN",
]);

const round = (v, p) => Number.isFinite(v) ? +v.toFixed(p) : null;
const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

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

function colorTempFromBV(ci) {
    if (!Number.isFinite(ci)) return 5772;
    const bv = Math.max(-0.35, Math.min(2.0, ci));
    return Math.round(4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)));
}

function colorMix(a, b, t) {
    return [
        a[0] * (1 - t) + b[0] * t,
        a[1] * (1 - t) + b[1] * t,
        a[2] * (1 - t) + b[2] * t,
    ];
}

function colorHexFromBV(ci) {
    const bv = Number.isFinite(ci) ? Math.max(-0.35, Math.min(2.0, ci)) : 0.65;
    const t = Math.max(0, Math.min(1, (bv + .35) / 2.35));
    let c;
    if (t < .34) c = colorMix([.58, .68, 1.0], [.93, .96, 1.0], t / .34);
    else if (t < .58) c = colorMix([.93, .96, 1.0], [1.0, .86, .58], (t - .34) / .24);
    else c = colorMix([1.0, .86, .58], [1.0, .42, .28], (t - .58) / .42);
    const r = Math.round(clamp(c[0], 0, 1) * 255);
    const g = Math.round(clamp(c[1], 0, 1) * 255);
    const b = Math.round(clamp(c[2], 0, 1) * 255);
    return (r << 16) | (g << 8) | b;
}

function luminosityFromAbsMag(absMag) {
    return Number.isFinite(absMag) ? Math.pow(10, (SOLAR_ABS_MAG - absMag) / 2.5) : null;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function massFromLum(lum) {
    if (!(lum > 0)) return null;
    let mass;
    if (lum < .033) mass = Math.pow(lum / .23, 1 / 2.3);
    else if (lum < 16) mass = Math.pow(lum, .25);
    else mass = Math.pow(lum / 1.5, 1 / 3.5);
    return clamp(mass, .01, 150);
}

function radiusFromLumTemp(lum, tempK) {
    if (!(lum > 0) || !(tempK > 0)) return null;
    return Math.sqrt(lum) * Math.pow(tempK / SOLAR_TEMP_K, -2);
}

function radiusFromMass(mass) {
    if (!(mass > 0)) return null;
    if (mass < 1) return Math.pow(mass, .8);
    return Math.pow(mass, .57);
}

function finiteOrNull(v) {
    return Number.isFinite(v) ? v : null;
}

function cleanName(v) {
    return String(v || "")
        .replace(/[^\x20-\x7E]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();
}

function physicalRow(row) {
    const ci = num(row[IDX.ci]);
    const mag = num(row[IDX.mag]);
    const absMag = num(row[IDX.absmag]);
    const lumRaw = num(row[IDX.lum]);
    const lum = lumRaw && lumRaw > 0 ? lumRaw : luminosityFromAbsMag(absMag);
    const tempK = colorTempFromBV(ci);
    const mass = massFromLum(lum);
    const radius = radiusFromLumTemp(lum, tempK) ?? radiusFromMass(mass);
    return { ci, mag, absMag, lum, tempK, mass, radius };
}

const res = await fetch(HYG_URL);
if (!res.ok) throw new Error(`HYG fetch failed: ${res.status} ${res.statusText}`);
const csv = await res.text();
const lines = csv.trim().split(/\r?\n/);
const header = parseCsvLine(lines.shift());
const at = name => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing HYG column ${name}`);
    return i;
};

const IDX = Object.fromEntries(["id", "hip", "hd", "hr", "gl", "bf", "proper", "ra", "dec", "dist", "mag", "absmag", "spect", "ci", "x", "y", "z", "lum"].map(k => [k, at(k)]));
const values = [];
const labels = [];
const physicalCandidates = [];
const stats = {
    massEstimated: 0,
    radiusEstimated: 0,
    lumEstimated: 0,
    tempEstimated: 0,
    massSolarSum: 0,
};

for (const line of lines) {
    if (!line) continue;
    const row = parseCsvLine(line);
    const proper = row[IDX.proper] || "";
    if (proper === "Sol") continue;
    const x = num(row[IDX.x]), y = num(row[IDX.y]), z = num(row[IDX.z]), dist = num(row[IDX.dist]);
    if (!(dist > 0) || x === null || y === null || z === null) continue;
    const raHours = num(row[IDX.ra]);
    const decDeg = num(row[IDX.dec]);
    const phys = physicalRow(row);
    const i = values.length / 10;
    values.push(
        round(x, 4), round(y, 4), round(z, 4),
        round(phys.ci, 3), round(phys.mag, 2), round(phys.absMag, 2),
        round(phys.lum, 5), round(phys.tempK, 0),
        round(phys.mass, 5), round(phys.radius, 5),
    );
    if (phys.mass > 0) { stats.massEstimated++; stats.massSolarSum += phys.mass; }
    if (phys.radius > 0) stats.radiusEstimated++;
    if (phys.lum > 0) stats.lumEstimated++;
    if (phys.tempK > 0) stats.tempEstimated++;
    const label = proper || row[IDX.bf] || row[IDX.gl] || "";
    if (label || (phys.mag !== null && phys.mag <= 3.5) || dist <= 8) {
        labels.push([
            i, label, row[IDX.hip] || "", row[IDX.hd] || "", row[IDX.hr] || "", row[IDX.spect] || "",
            round(phys.mass, 5), round(phys.radius, 5), round(phys.lum, 5), round(phys.tempK, 0),
        ]);
    }
    const navName = cleanName(label || row[IDX.proper] || row[IDX.bf] || row[IDX.gl]);
    const dLy = dist * PC_LY;
    const navWorthy = navName && !CURATED_NAMES.has(navName) && phys.mass > 0 && phys.radius > 0 &&
        raHours !== null && decDeg !== null && (dLy <= 80 || (phys.mag !== null && phys.mag <= 5.2) || proper);
    if (navWorthy) {
        const magScore = Number.isFinite(phys.mag) ? phys.mag : 12;
        const score = dLy * .18 + magScore * 2.4 - Math.log10(phys.mass + .02) * 4 + (proper ? -8 : 0);
        physicalCandidates.push({
            score,
            name: navName,
            dLy: round(dLy, 4),
            raDeg: round(raHours * 15, 5),
            decDeg: round(decDeg, 5),
            color: colorHexFromBV(phys.ci),
            mass: round(phys.mass, 5),
            radiusSolar: round(phys.radius, 5),
            lumSolar: round(phys.lum, 5),
            tempK: round(phys.tempK, 0),
            absMag: round(phys.absMag, 2),
            mag: round(phys.mag, 2),
            hip: row[IDX.hip] || "",
            hd: row[IDX.hd] || "",
            hr: row[IDX.hr] || "",
            spect: row[IDX.spect] || "",
        });
    }
}

await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
const bin = Buffer.allocUnsafe(values.length * 4);
for (let i = 0; i < values.length; i++) bin.writeFloatLE(values[i] ?? NaN, i * 4);
await writeFile(OUT_BIN, bin);
const physicalStars = physicalCandidates
    .sort((a, b) => a.score - b.score)
    .filter((star, idx, arr) => arr.findIndex(s => s.name === star.name) === idx)
    .slice(0, PHYSICAL_STAR_LIMIT)
    .map(({ score, ...star }) => star);
await writeFile(OUT, JSON.stringify({
    schema: 2,
    source: "Astronexus HYG v4.1, combining Hipparcos, Yale Bright Star, and Gliese catalog data",
    sourceUrl: HYG_URL,
    binary: "hyg-stars-v41.bin",
    license: "CC BY-SA 4.0",
    epoch: "J2000",
    units: { position: "parsec", luminosity: "solar", temperature: "kelvin", mass: "solar", radius: "solar" },
    fields: ["xPc", "yPc", "zPc", "bv", "mag", "absMag", "lumSolar", "tempK", "massSolar", "radiusSolar"],
    encoding: "Float32 little-endian",
    stride: 10,
    count: values.length / 10,
    physicalModel: {
        luminosity: "HYG lum when present, otherwise inferred from absolute magnitude and solar Mv=4.83",
        temperature: "Ballesteros B-V color-temperature approximation, clamped to the useful HYG color-index range",
        mass: "piecewise main-sequence mass-luminosity estimate in solar masses",
        radius: "Stefan-Boltzmann estimate from luminosity and temperature, with a mass-radius fallback",
    },
    stats: {
        ...stats,
        massSolarSum: round(stats.massSolarSum, 3),
    },
    labels,
}));
const physicalJs = `// Generated by scripts/build-hyg-catalog.mjs from HYG v4.1.\n` +
    `// Compact physical subset used by runtime gravity/render/navigation loops.\n` +
    `export const HYG_PHYSICAL_SOURCE = ${JSON.stringify({
        source: "Astronexus HYG v4.1",
        sourceUrl: HYG_URL,
        count: physicalStars.length,
        selection: "nearest, bright, or named HYG stars with estimated mass and radius, excluding curated built-ins",
        fullCatalogCount: values.length / 10,
    }, null, 2)};\n\n` +
    `export const HYG_PHYSICAL_STARS = [\n` +
    physicalStars.map(star => {
        const fields = [
            `name: ${JSON.stringify(star.name)}`,
            `dLy: ${star.dLy}`,
            `raDeg: ${star.raDeg}`,
            `decDeg: ${star.decDeg}`,
            `color: 0x${star.color.toString(16).padStart(6, "0")}`,
            `mass: ${star.mass}`,
            `radiusSolar: ${star.radiusSolar}`,
            `lumSolar: ${star.lumSolar}`,
            `tempK: ${star.tempK}`,
            `absMag: ${star.absMag}`,
            `mag: ${star.mag}`,
            `hip: ${JSON.stringify(star.hip)}`,
            `hd: ${JSON.stringify(star.hd)}`,
            `hr: ${JSON.stringify(star.hr)}`,
            `spect: ${JSON.stringify(star.spect)}`,
        ];
        return `    { ${fields.join(", ")} },`;
    }).join("\n") +
    `\n];\n`;
await writeFile(OUT_PHYSICAL, physicalJs);

console.log(`wrote ${values.length / 10} HYG stars, ${labels.length} labels, ${stats.massEstimated} mass estimates, ${physicalStars.length} physical runtime stars, ${OUT.pathname}, ${OUT_BIN.pathname}, and ${OUT_PHYSICAL.pathname}`);
