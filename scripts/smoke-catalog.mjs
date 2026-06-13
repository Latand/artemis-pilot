import { readFileSync, statSync } from "node:fs";
import { HYG_PHYSICAL_STARS } from "../src/generated/hygPhysicalStars.js";
import {
  findExistingCatalogStar,
  restorePromotedCatalogStars,
  searchCatalogLabels,
  serializePromotedCatalogStars,
  starFromCatalogRecord,
} from "../src/catalogSearch.js";
import { STARS } from "../src/constants.js";

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

const meta = JSON.parse(readFileSync(new URL("../public/data/hyg-stars-v41.json", import.meta.url), "utf8"));
const binPath = new URL("../public/data/hyg-stars-v41.bin", import.meta.url);
const bodiesSrc = readFileSync(new URL("../src/bodies.js", import.meta.url), "utf8");
const cosmicSrc = readFileSync(new URL("../src/cosmic.js", import.meta.url), "utf8");
const catalogSearchSrc = readFileSync(new URL("../src/catalogSearch.js", import.meta.url), "utf8");
const mainSrc = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const riverSrc = readFileSync(new URL("../src/river.js", import.meta.url), "utf8");
const realSkySrc = readFileSync(new URL("../src/realSky.js", import.meta.url), "utf8");
const savesSrc = readFileSync(new URL("../src/saves.js", import.meta.url), "utf8");
const bin = readFileSync(binPath);
const vals = new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);

assert(meta.schema === 2, "HYG catalog should use physical schema v2");
assert(meta.stride === 10, "HYG binary stride should include physical fields");
for (const field of ["xPc", "yPc", "zPc", "bv", "mag", "absMag", "lumSolar", "tempK", "massSolar", "radiusSolar"]) {
  assert(meta.fields.includes(field), "HYG catalog missing field " + field);
}
assert(statSync(binPath).size === meta.count * meta.stride * 4, "HYG binary size should match count and stride");
assert(vals.length === meta.count * meta.stride, "HYG binary float count should match metadata");
assert(meta.count >= 119000, "HYG catalog should retain the full v4.1 source-scale point cloud");
assert(meta.stats.massEstimated >= meta.count * 0.95, "HYG catalog should carry mass estimates for nearly all entries");
assert(meta.stats.radiusEstimated >= meta.count * 0.95, "HYG catalog should carry radius estimates for nearly all entries");
assert(meta.labels.some(row => row.length >= 10 && row[6] > 0 && row[7] > 0), "HYG labels should expose physical metadata");

const iMass = meta.fields.indexOf("massSolar");
const iRadius = meta.fields.indexOf("radiusSolar");
let sampledMasses = 0;
for (let i = 0, j = 0; i < meta.count; i += 97, j = i * meta.stride) {
  if (vals[j + iMass] > 0 && vals[j + iRadius] > 0) sampledMasses++;
}
assert(sampledMasses > 1000, "HYG binary physical fields should be populated across the file");

assert(HYG_PHYSICAL_STARS.length === 36, "runtime HYG physical subset should stay capped");
const names = new Set();
for (const star of HYG_PHYSICAL_STARS) {
  assert(star.name && !names.has(star.name), "runtime HYG physical stars should have unique names");
  names.add(star.name);
  assert(star.dLy > 0 && Number.isFinite(star.raDeg) && Number.isFinite(star.decDeg), "runtime HYG star needs a real sky position");
  assert(star.mass > 0 && star.radiusSolar > 0 && star.lumSolar > 0 && star.tempK > 0, "runtime HYG star needs physical fields");
}
for (const duplicate of ["SIRIUS", "PROCYON", "RIGIL KENTAURUS", "TOLIMAN", "RAN"]) {
  assert(!names.has(duplicate), "runtime HYG subset should filter curated alias " + duplicate);
}
assert(
  cosmicSrc.includes("worker.onerror") &&
    cosmicSrc.includes("loadCatalogStarsFallback") &&
    cosmicSrc.includes("catalogLoaded") &&
    cosmicSrc.includes("est mass "),
  "runtime catalog loader should fall back when module workers fail",
);
assert(
  riverSrc.includes("const RIVER_STAR_SOURCE_MAX = 48") &&
    riverSrc.includes("const MAXB = 3 + PL.length + BH_MAX + RIVER_STAR_SOURCE_MAX") &&
    riverSrc.includes("riverStarPick.sort"),
  "river source cap should cover planets, max black holes, and a bounded stellar subset",
);
assert(
  realSkySrc.includes("const MAG_LIMIT = 6.5") &&
    realSkySrc.includes("HYG real naked-eye sky") &&
    realSkySrc.includes("const ASTERISMS") &&
    realSkySrc.includes("ORION") &&
    realSkySrc.includes("URSA MAJOR") &&
    realSkySrc.includes("SUMMER TRIANGLE") &&
    realSkySrc.includes("CANIS MAJOR") &&
    realSkySrc.includes("PEGASUS") &&
    realSkySrc.includes("LineSegments") &&
    realSkySrc.includes("PointsMaterial") &&
    bodiesSrc.includes("initRealSky(skyStars)") &&
    bodiesSrc.includes('location.search.includes("realsky=0")') &&
    mainSrc.includes("smooth01(2.0e7, 7.0e7, cam.dist)") &&
    riverSrc.includes("mix(0.46, 1.0, visibleTime)") &&
    riverSrc.includes("depthTest: false"),
  "real solar sky and wider river visibility should stay wired",
);
for (const starName of ["BETELGEUSE", "RIGEL", "MINTAKA", "VEGA", "DENEB", "ALTAIR", "DUBHE", "MERAK", "POLARIS", "SIRIUS", "REGULUS", "ALPHERATZ", "FOMALHAUT"]) {
  assert(meta.labels.some(row => String(row[1]).toUpperCase() === starName), "HYG labels should include constellation anchor " + starName);
}
const polluxMatch = searchCatalogLabels(meta, "pollux", 4)[0];
assert(polluxMatch && polluxMatch.index >= 0, "HYG search should find named catalog stars");
const pollux = starFromCatalogRecord(meta, vals, polluxMatch.index, polluxMatch.row);
assert(pollux.name === "POLLUX" && pollux.mass > 0 && pollux.R > 0 && pollux.mu === undefined, "catalog record conversion should expose physical star fields before registration");
const numericMatch = searchCatalogLabels(meta, String(polluxMatch.index), 1)[0];
assert(numericMatch?.index === polluxMatch.index, "HYG search should support direct catalog index promotion");
const siriusMatch = searchCatalogLabels(meta, "sirius", 1)[0];
const sirius = starFromCatalogRecord(meta, vals, siriusMatch.index, siriusMatch.row);
const existingSirius = findExistingCatalogStar(siriusMatch.index, siriusMatch.row, sirius);
assert(existingSirius >= 0 && STARS[existingSirius].name === "SIRIUS A", "HYG alias promotion should reuse curated stellar destinations");
for (const [query, expected] of [
  ["rigil", "ALPHA CEN A"],
  ["toliman", "ALPHA CEN B"],
  ["ran", "EPSILON ERIDANI"],
  ["barnard", "BARNARD"],
  ["van maanen", "VAN MAANEN"],
]) {
  const match = searchCatalogLabels(meta, query, 4)[0];
  assert(match, "HYG search should find alias query " + query);
  const star = starFromCatalogRecord(meta, vals, match.index, match.row);
  const existing = findExistingCatalogStar(match.index, match.row, star);
  assert(existing >= 0 && STARS[existing].name === expected, "HYG alias " + star.name + " should reuse " + expected);
}
assert(
  catalogSearchSrc.includes("addRuntimeStar(star)") &&
    catalogSearchSrc.includes("CATALOG_PROMOTION_MAX") &&
    mainSrc.includes("initCatalogSearch") &&
    mainSrc.includes("ensureStarLabel") &&
    mainSrc.includes("addStarVisual(star)"),
  "HYG catalog search should promote stars into runtime visuals, labels, and physics state",
);
const canopusMatch = searchCatalogLabels(meta, "canopus", 1)[0];
const canopus = starFromCatalogRecord(meta, vals, canopusMatch.index, canopusMatch.row);
assert(findExistingCatalogStar(canopusMatch.index, canopusMatch.row, canopus) === -1, "CANOPUS should exercise new promoted-star restoration");
const baseStars = STARS.length;
const restored = restorePromotedCatalogStars([canopus]);
assert(restored.length === 1 && STARS.length === baseStars + 1, "saved promoted HYG stars should restore into runtime destinations");
assert(STARS[restored[0]].name === "CANOPUS" && STARS[restored[0]].mu > 0, "restored HYG destination should regain physical runtime fields");
const duplicateRestore = restorePromotedCatalogStars([canopus]);
assert(duplicateRestore[0] === restored[0] && STARS.length === baseStars + 1, "restoring the same HYG destination should reuse the existing runtime star");
const serialized = serializePromotedCatalogStars();
assert(serialized.some(star => star.hygIndex === canopus.hygIndex && star.name === "CANOPUS"), "promoted HYG destinations should serialize for quicksave");
assert(
  catalogSearchSrc.includes("restorePromotedCatalogStars") &&
    savesSrc.includes("hygStars: serializePromotedCatalogStars()") &&
    savesSrc.includes("restorePromotedCatalogStars(data.hygStars)") &&
    savesSrc.includes("focusCatalog") &&
    mainSrc.includes('reason === "restore"'),
  "quicksave should persist promoted HYG destinations and restore visuals without changing saved focus flow",
);

console.log("catalog smoke passed");
