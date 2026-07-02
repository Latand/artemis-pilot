#!/usr/bin/env node
/**
 * Build the compact NASA Exoplanet Archive overlay table.
 *
 * TAP endpoint:
 *   https://exoplanetarchive.ipac.caltech.edu/TAP/sync
 * SQL:
 *   select hostname, hip_name, hd_name, pl_letter, pl_orbsmax, pl_orbeccen,
 *   pl_orbper, pl_rade, pl_bmasse, pl_orbincl, ra, dec, sy_dist from ps
 *   where default_flag=1
 *
 * The raw JSON response is cached in scripts/.cache/exoplanets-ps-default.json.
 * Set EXOPLANET_REFRESH=1 to refresh from the TAP service; cached runs are
 * byte-stable and avoid network.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_PATH = resolve(ROOT, "scripts/.cache/exoplanets-ps-default.json");
const OUT_PATH = resolve(ROOT, "public/data/exoplanets.json");
const TAP_URL = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";
const SQL = "select hostname, hip_name, hd_name, pl_letter, pl_orbsmax, pl_orbeccen, pl_orbper, pl_rade, pl_bmasse, pl_orbincl, ra, dec, sy_dist from ps where default_flag=1";

function asNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function cleanId(v) {
    return String(v || "").trim().replace(/\s+/g, " ");
}

function catalogNumber(v, prefix) {
    const s = cleanId(v).toUpperCase();
    const m = s.match(new RegExp("^" + prefix + "\\s*(\\d+)$"));
    return m ? m[1] : "";
}

function hostKeys(host) {
    const keys = [];
    if (host.hip) keys.push("cat:HIP" + host.hip);
    if (host.hd) keys.push("cat:HD" + host.hd);
    if (host.hostname) keys.push("cat:" + host.hostname);
    return keys;
}

function existingGeneratedUTC() {
    if (!existsSync(OUT_PATH)) return null;
    try {
        const prior = JSON.parse(readFileSync(OUT_PATH, "utf8"));
        return typeof prior.generatedUTC === "string" ? prior.generatedUTC : null;
    } catch (err) {
        return null;
    }
}

async function loadRows() {
    if (existsSync(CACHE_PATH) && process.env.EXOPLANET_REFRESH !== "1") {
        return { rows: JSON.parse(readFileSync(CACHE_PATH, "utf8")), generatedUTC: existingGeneratedUTC() || "cache" };
    }
    const url = TAP_URL + "?query=" + encodeURIComponent(SQL) + "&format=json";
    const res = await fetch(url);
    if (!res.ok) throw new Error("NASA TAP request failed: " + res.status + " " + res.statusText);
    const rows = await res.json();
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(rows, null, 2) + "\n");
    return { rows, generatedUTC: new Date().toISOString() };
}

function buildTable(rows, generatedUTC) {
    const canonical = new Map();
    for (const row of rows) {
        const hostname = cleanId(row.hostname);
        if (!hostname) continue;
        let host = canonical.get(hostname);
        if (!host) {
            host = {
                hostname,
                hip: catalogNumber(row.hip_name, "HIP") || null,
                hd: catalogNumber(row.hd_name, "HD") || null,
                raDeg: asNum(row.ra),
                decDeg: asNum(row.dec),
                distPc: asNum(row.sy_dist),
                planets: [],
            };
            canonical.set(hostname, host);
        }
        host.planets.push({
            letter: cleanId(row.pl_letter) || null,
            aAU: asNum(row.pl_orbsmax),
            e: asNum(row.pl_orbeccen),
            periodDays: asNum(row.pl_orbper),
            radiusMe: asNum(row.pl_rade),
            massMe: asNum(row.pl_bmasse),
            inclDeg: asNum(row.pl_orbincl),
        });
    }

    const hosts = {};
    const ordered = [...canonical.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
    for (const host of ordered) {
        host.planets.sort((a, b) =>
            (a.aAU ?? Infinity) - (b.aAU ?? Infinity) ||
            (a.periodDays ?? Infinity) - (b.periodDays ?? Infinity) ||
            String(a.letter || "").localeCompare(String(b.letter || "")));
        for (const key of hostKeys(host)) hosts[key] = host;
    }
    return {
        generatedUTC,
        count: ordered.reduce((sum, host) => sum + host.planets.length, 0),
        hosts,
    };
}

const { rows, generatedUTC } = await loadRows();
const table = buildTable(rows, generatedUTC);
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(table, null, 2) + "\n");
const uniqueHosts = new Set(Object.values(table.hosts)).size;
console.log(`exoplanets: wrote ${table.count} planets across ${uniqueHosts} hosts to ${OUT_PATH}`);
