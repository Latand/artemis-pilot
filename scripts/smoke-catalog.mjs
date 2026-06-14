import { readFileSync, statSync } from "node:fs";
import { HYG_PHYSICAL_STARS } from "../src/generated/hygPhysicalStars.js";
import { cachedHygCatalogData, loadHygCatalogData, rememberHygCatalogData } from "../src/universe/catalogData.js";
import {
  findExistingCatalogStar,
  activeNeighborhoodRows,
  restorePromotedCatalogStars,
  searchCatalogLabels,
  serializePromotedCatalogStars,
  starFromCatalogRecord,
} from "../src/catalogSearch.js";
import { STARS } from "../src/constants.js";
import {
  ACTIVE_STAR_CONFIG,
  ACTIVE_STARS,
  activeStarForFocus,
  activeStarStats,
  hygCatalogFocusValue,
  refreshActiveStars,
} from "../src/universe/activeStars.js";
import {
  hygCatalogStats,
  hygStarById,
  registerHygCatalog,
  sampleHygStarsNear,
} from "../src/universe/hygActiveCatalog.js";
import { strongestActiveStarWell } from "../src/universe/starDominance.js";

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

const meta = JSON.parse(readFileSync(new URL("../public/data/hyg-stars-v41.json", import.meta.url), "utf8"));
const binPath = new URL("../public/data/hyg-stars-v41.bin", import.meta.url);
const bodiesSrc = readFileSync(new URL("../src/bodies.js", import.meta.url), "utf8");
const cosmicSrc = readFileSync(new URL("../src/cosmic.js", import.meta.url), "utf8");
const catalogDataSrc = readFileSync(new URL("../src/universe/catalogData.js", import.meta.url), "utf8");
const catalogSearchSrc = readFileSync(new URL("../src/catalogSearch.js", import.meta.url), "utf8");
const catalogWorkerSrc = readFileSync(new URL("../src/catalogWorker.js", import.meta.url), "utf8");
const activeStarsSrc = readFileSync(new URL("../src/universe/activeStars.js", import.meta.url), "utf8");
const hygActiveCatalogSrc = readFileSync(new URL("../src/universe/hygActiveCatalog.js", import.meta.url), "utf8");
const mainSrc = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const riverSrc = readFileSync(new URL("../src/river.js", import.meta.url), "utf8");
const realSkySrc = readFileSync(new URL("../src/realSky.js", import.meta.url), "utf8");
const savesSrc = readFileSync(new URL("../src/saves.js", import.meta.url), "utf8");
const starsSrc = readFileSync(new URL("../src/stars.js", import.meta.url), "utf8");
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
rememberHygCatalogData(meta, vals, new URL("../public/data/hyg-stars-v41.json", import.meta.url));
const cachedData = cachedHygCatalogData();
assert(cachedData?.meta === meta && cachedData?.vals === vals, "shared HYG catalog loader should retain cached metadata and values");
const loadedData = await loadHygCatalogData();
assert(loadedData.meta === meta && loadedData.vals === vals, "shared HYG catalog loader should reuse remembered catalog data");
assert(registerHygCatalog(meta, vals), "HYG active catalog should register the local binary");
const activeCatalogStats = hygCatalogStats();
assert(activeCatalogStats.loaded && activeCatalogStats.count === meta.count && activeCatalogStats.indexReady,
  "HYG active catalog should expose loaded ready-index stats");
assert(activeCatalogStats.indexedCells > 1000, "HYG active catalog should build a spatial index");
const nearbyHyg = sampleHygStarsNear(0, 0, 0, 20, 64);
assert(nearbyHyg.length > 20 && nearbyHyg.length <= 64, "HYG active sampler should return a bounded nearby real-star set");
assert(!hygStarById("hyg:58733"), "physically inconsistent HYG rows should stay out of active gravity sources");
assert(!sampleHygStarsNear(0, 0, 0, 20, 256).some(star => star.id === "hyg:58733"),
  "HYG active sampler should skip inconsistent evolved-star physics");
const gl65b = hygStarById("hyg:118076");
assert(gl65b?.radiusSolar >= 0.08 && gl65b?.mass > 0, "low-mass HYG M dwarfs with tiny source radii should receive runtime radius repair");
assert(registerHygCatalog(meta, vals, { deferIndex: true }), "re-registering the same HYG catalog should be accepted");
assert(hygCatalogStats().indexReady && sampleHygStarsNear(0, 0, 0, 20, 64).length === nearbyHyg.length,
  "re-registering the same HYG catalog should keep the ready spatial index live");
assert(nearbyHyg.every(star => star.activeCatalog && star.mu > 0 && star.R > 0 && star.id === "hyg:" + star.hygIndex),
  "HYG active sampler should emit runtime-ready physical stars");
const maskKm = 0.35 * 3.261563777 * 9460730472580.8;
const uniqueHyg = nearbyHyg.find(star => !STARS.some(known => {
  const dx = star.x - known.x, dy = star.y - known.y, dz = (star.z || 0) - (known.z || 0);
  return dx * dx + dy * dy + dz * dz <= maskKm * maskKm;
}));
assert(uniqueHyg, "HYG active sampler should include at least one non-duplicate nearby catalog row");
const hygFocus = hygCatalogFocusValue(uniqueHyg);
assert(hygStarById(hygFocus)?.hygIndex === uniqueHyg.hygIndex, "HYG active focus ID should restore the same catalog row");
const activeWithHyg = refreshActiveStars(0, 0, 0, hygFocus);
assert(activeWithHyg.catalog === ACTIVE_STAR_CONFIG.catalogLimit, "active set should include a full bounded HYG catalog subset after registration");
assert(activeWithHyg.total === ACTIVE_STARS.length && activeWithHyg.total <= ACTIVE_STAR_CONFIG.totalLimit,
  "HYG active stars should respect the global active-star cap");
assert(activeStarForFocus(hygFocus)?.id === hygFocus, "hyg focus should resolve through the active-star layer");
const activeHyg = ACTIVE_STARS.find(star => star.id === hygFocus);
assert(activeHyg, "forced HYG focus should appear as an active catalog star");
const hygOrbitR = activeHyg.R * 80;
assert(strongestActiveStarWell([activeHyg], activeHyg.x + hygOrbitR, activeHyg.y, activeHyg.z || 0, 0)?.star === activeHyg,
  "HYG active star should be eligible to own its local orbit well");
assert(ACTIVE_STARS.filter(star => star.activeCatalog).every(star => star.radiusSolar >= 0.01 &&
  !(star.mass > 4 && star.radiusSolar < 1 && star.lumSolar < 100)),
  "HYG active stars should avoid grossly inconsistent mass-radius-luminosity rows");
const activeRows = activeNeighborhoodRows(128);
assert(activeRows.length > 4 && activeRows.every(row => row.focus && row.star && row.dKm >= 0),
  "blank catalog panel should expose bounded active-neighborhood rows");
assert(activeRows.some(row => row.sourceKey === "procedural" && row.focus.startsWith("proc:")),
  "active-neighborhood browser should expose procedural focus tokens");
assert(activeRows.some(row => row.sourceKey === "hyg" && row.focus.startsWith("hyg:")),
  "active-neighborhood browser should expose active HYG focus tokens after catalog registration");
assert(activeRows.every((row, i, rows) => i === 0 || rows[i - 1].dKm <= row.dKm),
  "active-neighborhood browser should sort rows by ship-relative distance");
assert(activeStarForFocus(activeRows.find(row => row.sourceKey === "procedural").focus),
  "procedural active-neighborhood focus should resolve through active-star lookup");
const proximaHyg = searchCatalogLabels(meta, "proxima centauri", 1)[0];
assert(proximaHyg, "HYG labels should expose Proxima for duplicate-focus checks");
const proximaFocus = hygCatalogFocusValue(proximaHyg.index);
refreshActiveStars(0, 0, 0, proximaFocus);
const proximaResolved = activeStarForFocus(proximaFocus);
assert(proximaResolved?.name === "PROXIMA" && !proximaResolved.activeCatalog,
  "duplicate HYG focus should resolve to the curated physical destination");
assert(!ACTIVE_STARS.some(star => star.id === proximaFocus),
  "forced duplicate HYG focus should not add a second active gravity source");
assert(ACTIVE_STARS.filter(star => star.name === "PROXIMA").length === 1,
  "forced duplicate HYG focus should not duplicate the curated active star");

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
    riverSrc.includes("insertRiverStarPick") &&
    riverSrc.includes("ACTIVE_STARS") &&
    riverSrc.includes("river.renderShed") &&
    riverSrc.includes("if (drawCount !== river.drawCount)") &&
    riverSrc.includes("river.computeEvery = 1"),
  "river source cap and adaptive line density should keep bounded stellar sources with per-frame compute cadence",
);
assert(
  starsSrc.includes("function disposeStarVisual") &&
    starsSrc.includes("disposeStarVisual(e)") &&
    starsSrc.includes("texture.dispose()"),
  "dynamic active-star visuals should release GPU resources when removed",
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
  catalogSearchSrc.includes("export async function focusCatalogQuery") &&
    catalogSearchSrc.includes("hooks.onFocusCatalog") &&
    catalogSearchSrc.includes("hygCatalogFocusValue(index)") &&
    catalogSearchSrc.includes("btn.onclick = () => focusCatalogIndex(match.index)") &&
    catalogSearchSrc.includes("focusCatalogQuery(urlQuery)") &&
    mainSrc.includes("onFocusCatalog(index, star)") &&
    mainSrc.includes("setFocus(hygCatalogFocusValue(index))") &&
    catalogSearchSrc.includes("addRuntimeStar(star)") &&
    catalogSearchSrc.includes("CATALOG_PROMOTION_MAX") &&
    mainSrc.includes("initCatalogSearch") &&
    mainSrc.includes("ensureStarLabel") &&
    mainSrc.includes("addStarVisual(star)") &&
    catalogSearchSrc.includes("renderActiveNeighborhood") &&
    catalogSearchSrc.includes("hooks.onFocusActive") &&
    catalogSearchSrc.includes('btn.dataset.focus = row.focus') &&
    catalogSearchSrc.includes('btn.dataset.source = row.sourceKey'),
  "star catalog panel should direct-focus active-neighborhood rows and HYG search rows while preserving promoted-star restore support",
);
const canopusMatch = searchCatalogLabels(meta, "canopus", 1)[0];
const canopus = starFromCatalogRecord(meta, vals, canopusMatch.index, canopusMatch.row);
assert(findExistingCatalogStar(canopusMatch.index, canopusMatch.row, canopus) === -1, "CANOPUS should exercise new promoted-star restoration");
assert(!restorePromotedCatalogStars([{
  name: "HIP 58910", dLy: 17.99, x: 1, y: 1, z: 1, color: 0xffffff, mass: 10, R: 0.153 * 695700,
  catalog: "hyg-v41-promoted", hygIndex: 58733, spect: "F0Ib-II", lumSolar: 0.02484, tempK: 7200,
}]).length, "restored promoted HYG stars should share the active physics gate");
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
    savesSrc.includes("focusHygCatalog") &&
    savesSrc.includes("hygCatalogFocusValue(data.focusHygCatalog.id)") &&
    mainSrc.includes('reason === "restore"'),
  "quicksave should persist direct and promoted HYG destinations without changing saved focus flow",
);
assert(
    savesSrc.includes("focusProcedural") &&
    savesSrc.includes("procStars") &&
    savesSrc.includes("restorePinnedProceduralStars(data.procStars)") &&
    savesSrc.includes("proceduralFocusValue(data.focusProcedural.id)") &&
    mainSrc.includes("activeStarFocusValue(star)") &&
    mainSrc.includes("activeStarForFocus(G.focus)"),
  "quicksave and main focus should preserve procedural star destinations",
);
assert(
  hygActiveCatalogSrc.includes("INDEX_CELL_PC") &&
    hygActiveCatalogSrc.includes("rebuildSpatialIndex") &&
    catalogDataSrc.includes("rememberHygCatalogData") &&
    catalogDataSrc.includes("loadHygCatalogData") &&
    activeStarsSrc.includes("sampleHygStarsNear") &&
    activeStarsSrc.includes("catalogLimit") &&
    activeStarsSrc.includes("catalogOversampleLimit") &&
    activeStarsSrc.includes("hygCatalogFocusId(focus)") &&
    hygActiveCatalogSrc.includes("catalogPhysicsUsable") &&
    catalogSearchSrc.includes("catalogPhysicsUsable") &&
    catalogWorkerSrc.includes("inputVals") &&
    cosmicSrc.includes("loadHygCatalogData()") &&
    cosmicSrc.includes("workerVals.buffer") &&
    catalogSearchSrc.includes("loadHygCatalogData") &&
    hygActiveCatalogSrc.includes("loadHygCatalogData") &&
    cosmicSrc.includes("{ deferIndex: true }") &&
    cosmicSrc.includes("registerHygCatalog(msg.meta") &&
    catalogSearchSrc.includes("registerHygCatalog(meta, vals, { deferIndex: true })") &&
    hygActiveCatalogSrc.includes("waitForHygCatalogIndex") &&
    hygActiveCatalogSrc.includes("deferIndex: typeof window") &&
    mainSrc.includes("hygCatalogStats().loaded"),
  "HYG active catalog should use indexed bounded sampling and preserve pending focus during async load",
);

console.log("catalog smoke passed");
