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

// ---------------------------------------------------------------------------
// Bolometric correction by leading spectral class letter.
// Simple single-value BC per class; enough for lum estimation from Mv.
// ---------------------------------------------------------------------------
const BC_BY_CLASS = { O: -4.0, B: -2.0, A: -0.3, F: -0.1, G: -0.07, K: -0.2, M: -1.2 };

function bolomCorr(spectClass) {
    return BC_BY_CLASS[spectClass] ?? -0.1;
}

// ---------------------------------------------------------------------------
// Parse the leading spectral class letter (O B A F G K M W etc.) from the
// HYG spect string, which may look like "G2V", "M1-2 Ia", "K5III", "DA", "".
// ---------------------------------------------------------------------------
function parseSpectClass(spect) {
    if (!spect) return null;
    const m = spect.match(/^([OBAFGKMLTWCS])/i);
    return m ? m[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Parse luminosity class from the spect string.
// Returns "Ia" | "Ib" | "II" | "III" | "IV" | "V" | null (null => treat as V).
// We look for roman-numeral sequences after the spectral-type letters/digits.
// ---------------------------------------------------------------------------
function parseLumClass(spect) {
    if (!spect) return null;
    // Strip only the temperature subclass (letter + digits/decimal/range-dash),
    // NOT the luminosity class roman numerals.  e.g. "K5III" -> "III", "M1-2 Ia" -> "Ia".
    const tail = spect.replace(/^[A-Z][0-9]*(?:\.[0-9]+)?(?:[-–][0-9]+)?\s*/i, "").trim();
    // Match roman-numeral luminosity class at start of remainder.
    if (/^Ia/i.test(tail))                               return "Ia";
    if (/^Ib/i.test(tail))                               return "Ib";
    if (/^III/i.test(tail))                              return "III";
    if (/^II([^I]|$)/i.test(tail))                      return "II";
    if (/^IV/i.test(tail))                               return "IV";
    if (/^V([^I]|$)/i.test(tail))                       return "V";
    return null;
}

// ---------------------------------------------------------------------------
// Eker et al. (2018, MNRAS 479, 5491) mass-luminosity relation (main sequence).
// Segments defined as [massLo, massHi, a, b]: log10(L) = a*log10(M) + b
// ---------------------------------------------------------------------------
const EKER_MLR = [
    [0.00,  0.45,  2.028, -0.976],
    [0.45,  0.72,  4.572, -0.102],
    [0.72,  1.05,  5.743, -0.007],
    [1.05,  2.40,  4.329,  0.010],
    [2.40,  7.00,  3.967,  0.093],
    [7.00, 31.0,   2.865,  1.105],
];

// Forward: mass -> log10(L) using Eker MLR.
function ekerLumFromMass(mass) {
    const logM = Math.log10(mass);
    for (const [lo, hi, a, b] of EKER_MLR) {
        if (mass >= lo && mass < hi) return a * logM + b;
    }
    // Beyond 31 Msun: extrapolate last segment
    const [, , a, b] = EKER_MLR[EKER_MLR.length - 1];
    return a * logM + b;
}

// Inverse: log10(L) -> mass, picking self-consistent Eker segment.
// Iterates segments and returns the mass whose forward prediction matches.
function ekerMassFromLum(lum) {
    if (!(lum > 0)) return null;
    const logL = Math.log10(lum);
    for (const [lo, hi, a, b] of EKER_MLR) {
        // log10(L) = a*log10(M)+b => log10(M) = (logL-b)/a
        const logM = (logL - b) / a;
        const mass = Math.pow(10, logM);
        if (mass >= lo && mass < hi) return clamp(mass, 0.08, 120);
    }
    // Fallback to last segment
    const [lo, , a, b] = EKER_MLR[EKER_MLR.length - 1];
    const logM = (logL - b) / a;
    return clamp(Math.pow(10, logM), 0.08, 120);
}

// ---------------------------------------------------------------------------
// Eker mass-radius relation for 0.179 <= M <= 1.5 Msun (main sequence).
// R = 0.438*M^2 + 0.479*M + 0.075
// ---------------------------------------------------------------------------
function ekerRadiusFromMass(mass) {
    return 0.438 * mass * mass + 0.479 * mass + 0.075;
}

// Stefan-Boltzmann radius: R/Rsun = sqrt(L) * (Tsun/Teff)^2
function sbRadius(lum, tempK) {
    if (!(lum > 0) || !(tempK > 0)) return null;
    return Math.sqrt(lum) * Math.pow(SOLAR_TEMP_K / tempK, 2);
}

// ---------------------------------------------------------------------------
// Coarse evolved-star mass priors (low-confidence, used for giants/supergiants).
// Eker 2018 MLR is strictly for main-sequence; evolved stars have left it.
// ---------------------------------------------------------------------------
const EVOLVED_MASS_PRIOR = { Ia: 12, Ib: 10, II: 6, III: 2.5, IV: 1.5 };

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

// ---------------------------------------------------------------------------
// Compute physical properties for one HYG star row.
// Uses Eker et al. (2018) MLR/MRR for main-sequence stars.
// Giants/supergiants get Stefan-Boltzmann radius and an evolved-star mass prior.
// ---------------------------------------------------------------------------
function physicalRow(row) {
    const ci      = num(row[IDX.ci]);
    const mag     = num(row[IDX.mag]);
    const absMag  = num(row[IDX.absmag]);
    const spect   = row[IDX.spect] || "";
    const spectClass = parseSpectClass(spect);
    const lumClass   = parseLumClass(spect);

    // 1) Temperature: Ballesteros (2012) B-V -> T formula (best available here).
    const tempK = colorTempFromBV(ci);

    // 2) Luminosity: prefer catalog lum; fall back to Mv with bolometric correction.
    const lumRaw = num(row[IDX.lum]);
    let lum;
    if (lumRaw && lumRaw > 0) {
        lum = lumRaw;
    } else if (Number.isFinite(absMag)) {
        const bc  = bolomCorr(spectClass);
        const mBol = absMag + bc;
        lum = Math.pow(10, (SOLAR_ABS_MAG - mBol) / 2.5);
    } else {
        lum = null;
    }

    // 3) Mass and radius depend on luminosity class.
    let mass, radius;
    const isGiant = lumClass === "Ia" || lumClass === "Ib" ||
                    lumClass === "II" || lumClass === "III";
    const isSubgiant = lumClass === "IV";

    if (isGiant) {
        // Evolved star: radius from Stefan-Boltzmann (correct for large R),
        // mass from coarse prior (low-confidence).
        radius = sbRadius(lum, tempK);
        mass   = clamp(EVOLVED_MASS_PRIOR[lumClass] ?? 2.5, 0.5, 200);
    } else if (isSubgiant) {
        // Subgiant (IV): expanded past the main sequence, so its radius is the
        // Stefan-Boltzmann value from L and T (a main-sequence MRR would
        // underestimate it); mass is still near main-sequence (Eker inversion).
        radius = sbRadius(lum, tempK);
        mass   = lum ? ekerMassFromLum(lum) : EVOLVED_MASS_PRIOR.IV;
    } else {
        // Main sequence (V, IV, or unknown): invert Eker MLR for mass.
        mass = lum ? ekerMassFromLum(lum) : null;
        if (mass !== null) {
            // Eker MRR valid for 0.179 <= M <= 1.5; S-B beyond that.
            if (mass >= 0.179 && mass <= 1.5) {
                radius = ekerRadiusFromMass(mass);
            } else {
                radius = sbRadius(lum, tempK);
            }
        } else {
            radius = null;
        }
    }

    // Safety clamps.
    if (mass   !== null) mass   = clamp(mass,   0.01, 300);
    if (radius !== null) radius = clamp(radius, 0.001, 2000);

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
        luminosity: "HYG lum when present; otherwise from absMag with per-class bolometric correction (Eker 2018 / Mv_sun=4.83)",
        temperature: "Ballesteros (2012) B-V color-temperature formula, clamped to HYG ci range",
        mass: "Eker et al. (2018, MNRAS 479, 5491) mass-luminosity relation (main seq); coarse prior for giants/supergiants",
        radius: "Eker (2018) mass-radius polynomial (0.179-1.5 Msun); Stefan-Boltzmann otherwise; S-B for all giants (correct large R)",
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
