import { K, LY_KM, MU_S, R_SUN } from "../constants.js";
import { hygCatalogMetaUrl, loadHygCatalogData } from "./catalogData.js";
import { equatorialKmToGal, galToEquatorialKmInto } from "./coords.js";
import { starPositionAt } from "./galaxy.js";
import { DISP, vCirc } from "./astroConstants.js";
import { gaussian, hashInts, makeRNG, splitSeed } from "./prng.js";

const PC_LY = 3.261563777;
const PC_KM = LY_KM * PC_LY;
const SOLAR_TEMP_K = 5772;
const CACHE_GRID_PC = 2;
const INDEX_CELL_PC = 8;
const MIN_ACTIVE_RADIUS_SOLAR = 0.01;
const INDEX_STEP_MAX = 1024;
const INDEX_STEP_MIN_BUDGET_MS = 1.25;
const INDEX_STEP_MAX_BUDGET_MS = 3.5;
const INDEX_APPLY_STEP_MAX = 4096;

// --- Tier-0 catalog motion (WP8) --------------------------------------------
// The HYG binary carries only a static epoch position (schema v2's 10-float
// stride has no proper-motion fields — real pm arrives with the AT-HYG Tier-1
// integration, WP9). Until then each catalog row gets a STATISTICALLY
// PLAUSIBLE synthetic velocity, drawn deterministically from the star's own
// stable catalog identity — HIP, else HD, else HR, else (only for the id-less
// remainder) its row index; see tier0SeedInts below for the fallback ladder
// and why identity beats row index (a real star has one true motion
// regardless of which procedural universe seed the player is on, so the draw
// is keyed purely to the star's identity, ignoring the global seed), then
// advected with the same closed-form epicyclic
// approximation galaxy.js uses for procedural stars. That helper
// (computeEpicyclic) isn't exported, and galaxy.js is a consumed module this
// wave, so this is an intentional, documented duplicate of its math —
// starPositionAt itself (which IS exported) still does the actual per-frame
// trig; this only derives the (Rg,X,phi0,Omega0,kappa0) input it needs.
const TIER0_VEL_SALT = 0x54494552; // 'TIER', arbitrary fixed salt
const TIER0_MOTION = new Map(); // index -> {epiRg,epiX,epiPhi0,epiOmega0,epiKappa0,epiNu,vz}, derived once per row and cached

// Sun's own vertical epicyclic frequency ν=sqrt(4πGρ_mid), reused as a shared
// approximation for every tier-0 row: galaxy.js derives ν per-position from
// the local mass density, but tier-0 rows all sit within tens of pc of the
// Sun (same disc environment), so sharing one constant is an acceptable
// simplification for this placeholder motion (real value ≈2.4e-15 rad/s,
// an ~84 Myr vertical oscillation period, matching galaxy.js's own solar
// figure).
const G_SI = 6.674e-11, MSUN_KG = 1.98892e30;
const PC_M = PC_KM * 1000;
const RHO_MID_SUN_MSUN_PC3 = 0.1; // Oort-limit dynamical midplane density (Holmberg & Flynn 2004)
const TIER0_NU_S = Math.sqrt(4 * Math.PI * G_SI * (MSUN_KG / (PC_M * PC_M * PC_M)) * RHO_MID_SUN_MSUN_PC3);

// Re-evaluation cadence: same drift-budget policy as activeStars.js's
// procedural cadence (recompute once a moving star could have drifted
// ~0.001 pc at a typical ~50 km/s) — kept as an independent constant here
// since these two modules intentionally share no internals this wave.
const TIER0_REEVAL_DRIFT_PC = 0.001;
const TIER0_REEVAL_SPEED_KMS = 50;
const TIER0_REEVAL_DT_S = (TIER0_REEVAL_DRIFT_PC * PC_KM) / TIER0_REEVAL_SPEED_KMS; // ≈19.6 years
function tier0SimTBucket(simT) {
    return Math.floor(simT / TIER0_REEVAL_DT_S);
}

const GAL_MOTION_SCRATCH = [0, 0, 0];
const EQ_MOTION_SCRATCH = [0, 0, 0];

// Real astronomical identity (HIP/HD/HR catalog number), not this build's row
// index, is what a star's synthetic velocity should be seeded from — the row
// index a star lands at is an artifact of HYG CSV ordering and would change
// if the catalog were ever re-exported/re-sorted, silently reseeding every
// star's "random" motion even though the star itself hasn't changed. Ladder:
// HIP (Hipparcos, the most universally-assigned id in this catalog) first,
// then HD, then HR, then — only for the id-less remainder LABELS has no
// entry for at all — the row index itself as a last resort (still fully
// deterministic, just not tied to the star's real-world identity). Each rung
// gets its own small integer tag folded into the same hashInts call so e.g.
// HIP 100 and row-index 100 don't hash to the same seed.
function tier0SeedInts(index) {
    const row = LABELS.get(index);
    const hip = row?.[2], hd = row?.[3], hr = row?.[4];
    if (hip) return [1, Number(hip)];
    if (hd) return [2, Number(hd)];
    if (hr) return [3, Number(hr)];
    return [0, index];
}

function tier0MotionFor(index, gx, gy) {
    let m = TIER0_MOTION.get(index);
    if (m) return m;
    const [tag, seedId] = tier0SeedInts(index);
    const rng = makeRNG(splitSeed(hashInts(TIER0_VEL_SALT, tag, seedId), 1));
    const disp = DISP.thin;
    const U = disp.sU * gaussian(rng);
    const Vpec = -disp.lag + disp.sV * gaussian(rng);
    const W = disp.sW * gaussian(rng);
    const Rpc = Math.max(Math.hypot(gx, gy), 50);
    const Rkm = Rpc * PC_KM;
    const vcircKms = Math.max(vCirc(Rpc / 1000), 1e-6);
    const Omega0 = vcircKms / Rkm;
    const kappa0 = Math.SQRT2 * Omega0;
    const xKm = -Vpec / (2 * Omega0), yKm = -U / kappa0;
    const Xkm = Math.hypot(xKm, yKm);
    const phi0 = Math.atan2(yKm, xKm);
    let Rg = Rpc - xKm / PC_KM, X = Xkm / PC_KM;
    if (!(Rg > 0) || X > 0.5 * Rg) { Rg = Rpc; X = 0; } // same linearization-breakdown guard as galaxy.js's computeEpicyclic
    m = { epiRg: Rg, epiX: X, epiPhi0: phi0, epiOmega0: Omega0, epiKappa0: kappa0, epiNu: TIER0_NU_S, vz: W };
    TIER0_MOTION.set(index, m);
    return m;
}

// Advances a catalog star's epoch position (xKm,yKm,zKm) to simT seconds,
// writing the result into `out` (length-3, reused by the caller — matches
// EQ_MOTION_SCRATCH's role in the simT!==0 branch, so neither branch
// allocates a fresh array per call). simT===0 copies the exact catalog
// position untouched (no round-trip through the galactocentric frame at
// all), matching the "positions must remain EXACTLY the catalog position at
// simT=0" contract.
function tier0PositionAt(index, xKm, yKm, zKm, simT, out) {
    if (simT === 0) { out[0] = xKm; out[1] = yKm; out[2] = zKm; return out; }
    const [gx, gy, gz] = equatorialKmToGal(xKm, yKm, zKm);
    const mot = tier0MotionFor(index, gx, gy);
    starPositionAt({ gx, gy, gz, ...mot }, simT, GAL_MOTION_SCRATCH);
    galToEquatorialKmInto(GAL_MOTION_SCRATCH[0], GAL_MOTION_SCRATCH[1], GAL_MOTION_SCRATCH[2], out);
    return out;
}

let META = null;
let VALS = null;
let LABELS = new Map();
let FIELD = Object.create(null);
let INDEX = new Map();
let INDEX_READY = false;
let INDEXING = false;
let INDEX_WAITERS = [];
let INDEX_WORKER = null;
let INDEX_WORKER_SIG = "";
let VERSION = 0;
let SIGNATURE = "";
let loadPromise = null;
const SAMPLE_CACHE = { key: "", stars: [] };

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function colorMix(a, b, t) {
    return [
        a[0] * (1 - t) + b[0] * t,
        a[1] * (1 - t) + b[1] * t,
        a[2] * (1 - t) + b[2] * t,
    ];
}

function colorHexFromBV(ci) {
    const bv = Number.isFinite(ci) ? clamp(ci, -0.35, 2.0) : 0.65;
    const t = clamp((bv + .35) / 2.35, 0, 1);
    let c;
    if (t < .34) c = colorMix([.58, .68, 1.0], [.93, .96, 1.0], t / .34);
    else if (t < .58) c = colorMix([.93, .96, 1.0], [1.0, .86, .58], (t - .34) / .24);
    else c = colorMix([1.0, .86, .58], [1.0, .42, .28], (t - .58) / .42);
    const r = Math.round(clamp(c[0], 0, 1) * 255);
    const g = Math.round(clamp(c[1], 0, 1) * 255);
    const b = Math.round(clamp(c[2], 0, 1) * 255);
    return (r << 16) | (g << 8) | b;
}

function displayName(row, index) {
    return String(row?.[1] || (row?.[2] ? "HIP " + row[2] : row?.[3] ? "HD " + row[3] : "HYG " + index)).toUpperCase();
}

function isEvolvedSpectralClass(spect) {
    const s = String(spect || "").toUpperCase().replace(/IV/g, "");
    return /(^|[^A-Z])(I|II|III)(A|B|AB)?([^A-Z]|$)/.test(s);
}

// 25-60 pc M-dwarf ACTIVE density is intentionally delegated to the tier-1
// visual layer (per-shell floor asserted in smoke-local-tier); follow-up WP
// makes tier-1 queryable.
function isLowMassMDwarf(mass, spect) {
    return mass > 0 && mass <= .25 && /(^|[^A-Z])D?M|^M|\bM\d/i.test(String(spect || ""));
}

export function catalogRuntimeRadiusSolar(mass, radius, spect = "") {
    const m = Number(mass), r = Number(radius);
    if (r >= MIN_ACTIVE_RADIUS_SOLAR) return r;
    if (isLowMassMDwarf(m, spect)) return clamp(m * 1.05, .08, .28);
    return r;
}

export function catalogPhysicsUsable(mass, radius, lum, spect = "") {
    const m = Number(mass), r = Number(radius), l = Number.isFinite(Number(lum)) ? Number(lum) : 0;
    const activeRadius = catalogRuntimeRadiusSolar(m, r, spect);
    if (!(m > 0) || !(activeRadius >= MIN_ACTIVE_RADIUS_SOLAR)) return false;
    if (m > 4 && r < 1 && l < 100) return false;
    if (m > 8 && l < 100) return false;
    if (isEvolvedSpectralClass(spect) && r < 1 && l < 1) return false;
    return true;
}

function physicalRowUsable(index, base) {
    return catalogPhysicsUsable(
        VALS[base + FIELD.mass],
        VALS[base + FIELD.radius],
        VALS[base + FIELD.lum],
        LABELS.get(index)?.[5],
    );
}

function field(name, fallback) {
    const i = META?.fields?.indexOf(name) ?? -1;
    return i >= 0 ? i : fallback;
}

function rebuildFieldMap() {
    FIELD = {
        x: field("xPc", 0),
        y: field("yPc", 1),
        z: field("zPc", 2),
        bv: field("bv", 3),
        mag: field("mag", 4),
        absMag: field("absMag", 5),
        lum: field("lumSolar", 6),
        temp: field("tempK", 7),
        mass: field("massSolar", 8),
        radius: field("radiusSolar", 9),
    };
}

function indexKey(ci, cj, ck) {
    return ci + "," + cj + "," + ck;
}

function rebuildSpatialIndex() {
    INDEX = new Map();
    INDEX_READY = false;
    INDEXING = false;
    if (!META || !VALS) return;
    const stride = META.stride || 10;
    for (let i = 0, base = 0; i < META.count; i++, base += stride) {
        if (!physicalRowUsable(i, base)) continue;
        const ci = Math.floor(VALS[base + FIELD.x] / INDEX_CELL_PC);
        const cj = Math.floor(VALS[base + FIELD.y] / INDEX_CELL_PC);
        const ck = Math.floor(VALS[base + FIELD.z] / INDEX_CELL_PC);
        const key = indexKey(ci, cj, ck);
        let bucket = INDEX.get(key);
        if (!bucket) INDEX.set(key, bucket = []);
        bucket.push(i);
    }
    INDEX_READY = true;
    resolveIndexWaiters();
}

function scheduleIndexStep(fn) {
    if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 80 });
    else setTimeout(() => fn(null), 16);
}

function resolveIndexWaiters() {
    const waiters = INDEX_WAITERS;
    INDEX_WAITERS = [];
    for (const resolve of waiters) resolve(hygCatalogStats());
}

export function waitForHygCatalogIndex() {
    if (INDEX_READY) return Promise.resolve(hygCatalogStats());
    if (!INDEXING) return Promise.resolve(hygCatalogStats());
    return new Promise(resolve => INDEX_WAITERS.push(resolve));
}

function catalogSignature(meta, vals) {
    return [
        meta.schema || 1,
        meta.count || Math.floor(vals.length / (meta.stride || 10)),
        meta.stride || 10,
        vals.length,
        meta.binary || "",
        meta.source || "",
    ].join(":");
}

function finishSpatialIndex(next) {
    INDEX = next;
    INDEX_READY = true;
    INDEXING = false;
    INDEX_WORKER_SIG = "";
    VERSION++;
    SAMPLE_CACHE.key = "";
    SAMPLE_CACHE.stars = [];
    resolveIndexWaiters();
}

function applyWorkerIndex(msg) {
    if (!msg || msg.signature !== SIGNATURE) return false;
    const coords = new Int32Array(msg.coords);
    const offsets = new Uint32Array(msg.offsets);
    const indices = new Int32Array(msg.indices);
    const cells = Math.min(msg.cells || 0, Math.floor(coords.length / 3), Math.max(0, offsets.length - 1));
    const next = new Map();
    INDEX = next;
    INDEX_READY = false;
    INDEXING = true;
    let cell = 0;
    const step = deadline => {
        const t0 = performance.now();
        const idleLeft = deadline && typeof deadline.timeRemaining === "function" ? deadline.timeRemaining() : 0;
        const budgetMs = deadline?.didTimeout ? INDEX_STEP_MIN_BUDGET_MS :
            Math.max(INDEX_STEP_MIN_BUDGET_MS, Math.min(INDEX_STEP_MAX_BUDGET_MS, idleLeft - .35));
        let processed = 0;
        while (cell < cells && processed++ < INDEX_APPLY_STEP_MAX) {
            const p = cell * 3;
            next.set(indexKey(coords[p], coords[p + 1], coords[p + 2]), indices.subarray(offsets[cell], offsets[cell + 1]));
            cell++;
            if ((processed & 255) === 0 && performance.now() - t0 >= budgetMs) break;
        }
        if (cell < cells) {
            scheduleIndexStep(step);
            return;
        }
        finishSpatialIndex(next);
    };
    scheduleIndexStep(step);
    return true;
}

function startSpatialIndexWorker() {
    if (typeof Worker === "undefined") return false;
    try {
        if (INDEX_WORKER) INDEX_WORKER.terminate();
        const worker = new Worker(new URL("./hygIndexWorker.js", import.meta.url), { type: "module" });
        INDEX_WORKER = worker;
        INDEX_WORKER_SIG = SIGNATURE;
        worker.onmessage = e => {
            if (worker !== INDEX_WORKER) return;
            INDEX_WORKER = null;
            if (e.data?.ok && applyWorkerIndex(e.data)) {
                worker.terminate();
                return;
            }
            worker.terminate();
            if (INDEXING && INDEX_WORKER_SIG === SIGNATURE) startSpatialIndexBuildMain();
        };
        worker.onerror = () => {
            if (worker !== INDEX_WORKER) return;
            INDEX_WORKER = null;
            worker.terminate();
            if (INDEXING && INDEX_WORKER_SIG === SIGNATURE) startSpatialIndexBuildMain();
        };
        worker.postMessage({ url: hygCatalogMetaUrl(), signature: SIGNATURE });
        return true;
    } catch (e) {
        INDEX_WORKER = null;
        return false;
    }
}

function startSpatialIndexBuildMain() {
    const meta = META, vals = VALS, fieldMap = FIELD;
    if (!meta || !vals) return;
    const next = new Map();
    const stride = meta.stride || 10;
    let i = 0, base = 0;
    INDEX = new Map();
    INDEX_READY = false;
    INDEXING = true;
    const step = deadline => {
        const t0 = performance.now();
        const idleLeft = deadline && typeof deadline.timeRemaining === "function" ? deadline.timeRemaining() : 0;
        const budgetMs = deadline?.didTimeout ? INDEX_STEP_MIN_BUDGET_MS :
            Math.max(INDEX_STEP_MIN_BUDGET_MS, Math.min(INDEX_STEP_MAX_BUDGET_MS, idleLeft - .35));
        let processed = 0;
        while (i < meta.count && processed++ < INDEX_STEP_MAX) {
            const mass = vals[base + fieldMap.mass];
            const radius = vals[base + fieldMap.radius];
            const lum = vals[base + fieldMap.lum];
            if (catalogPhysicsUsable(mass, radius, lum, LABELS.get(i)?.[5])) {
                const ci = Math.floor(vals[base + fieldMap.x] / INDEX_CELL_PC);
                const cj = Math.floor(vals[base + fieldMap.y] / INDEX_CELL_PC);
                const ck = Math.floor(vals[base + fieldMap.z] / INDEX_CELL_PC);
                const key = indexKey(ci, cj, ck);
                let bucket = next.get(key);
                if (!bucket) next.set(key, bucket = []);
                bucket.push(i);
            }
            i++;
            base += stride;
            if ((processed & 127) === 0 && performance.now() - t0 >= budgetMs) break;
        }
        if (i < meta.count) {
            scheduleIndexStep(step);
            return;
        }
        finishSpatialIndex(next);
    };
    scheduleIndexStep(step);
}

function startSpatialIndexBuild() {
    if (!META || !VALS || INDEXING) return;
    if (INDEX_WORKER) {
        INDEX_WORKER.terminate();
        INDEX_WORKER = null;
    }
    INDEX = new Map();
    INDEX_READY = false;
    INDEXING = true;
    if (typeof window !== "undefined" && startSpatialIndexWorker()) return;
    INDEXING = false;
    startSpatialIndexBuildMain();
}

export function registerHygCatalog(meta, values, options = {}) {
    if (!meta || !values) return false;
    const vals = values instanceof Float32Array ? values : new Float32Array(values);
    const stride = meta.stride || meta.fields?.length || 10;
    const count = Math.floor(vals.length / stride);
    if (!(count > 0) || count < meta.count) return false;
    const sig = catalogSignature(meta, vals);
    const sameCatalog = sig === SIGNATURE;
    META = meta;
    VALS = vals;
    LABELS = new Map((meta.labels || []).map(row => [row[0], row]));
    rebuildFieldMap();
    if (sameCatalog && (INDEX_READY || INDEXING)) {
        VERSION++;
        SAMPLE_CACHE.key = "";
        SAMPLE_CACHE.stars = [];
        return true;
    }
    SIGNATURE = sig;
    VERSION++;
    if (options.deferIndex) startSpatialIndexBuild();
    else rebuildSpatialIndex();
    SAMPLE_CACHE.key = "";
    SAMPLE_CACHE.stars = [];
    return true;
}

export function hygCatalogStats() {
    return {
        loaded: !!(META && VALS),
        version: VERSION,
        count: META?.count || 0,
        indexedCells: INDEX.size,
        indexReady: INDEX_READY,
        indexing: INDEXING,
        worker: !!INDEX_WORKER,
        source: META?.source || "HYG v4.1",
    };
}

export function hygCatalogFocusId(focus) {
    if (typeof focus !== "string") return "";
    const m = focus.match(/^hyg:(\d+)$/);
    return m ? "hyg:" + Number(m[1]) : "";
}

export function hygCatalogFocusValue(indexOrStar) {
    if (typeof indexOrStar === "number") return "hyg:" + indexOrStar;
    if (typeof indexOrStar === "string" && /^hyg:\d+$/.test(indexOrStar)) return indexOrStar;
    const index = Number(indexOrStar?.hygIndex);
    return Number.isFinite(index) && index >= 0 ? "hyg:" + index : "";
}

export function hygStarById(id, simT = 0) {
    const m = String(id || "").match(/^hyg:(\d+)$/);
    return m ? hygStarByIndex(Number(m[1]), simT) : null;
}

// simT (seconds): sim time to evaluate the row's statistically-plausible
// motion at (see the "Tier-0 catalog motion" block above). Defaults to 0 —
// the exact catalog epoch position — so every pre-existing caller keeps its
// current behaviour untouched.
export function hygStarByIndex(index, simT = 0) {
    if (!META || !VALS || !Number.isInteger(index) || index < 0 || index >= META.count) return null;
    const stride = META.stride || 10;
    const base = index * stride;
    if (base + stride > VALS.length) return null;
    const xPc = VALS[base + FIELD.x], yPc = VALS[base + FIELD.y], zPc = VALS[base + FIELD.z];
    const mass = VALS[base + FIELD.mass], rawRadiusSolar = VALS[base + FIELD.radius];
    const dPc = Math.hypot(xPc, yPc, zPc);
    if (!(dPc > 0) || !physicalRowUsable(index, base)) return null;
    const row = LABELS.get(index);
    const radiusSolar = catalogRuntimeRadiusSolar(mass, rawRadiusSolar, row?.[5]);
    const radiusKm = radiusSolar * R_SUN;
    const [x, y, z] = tier0PositionAt(index, xPc * PC_KM, yPc * PC_KM, zPc * PC_KM, simT, EQ_MOTION_SCRATCH);
    return {
        id: "hyg:" + index,
        name: displayName(row, index),
        catalog: "hyg-v41-active",
        activeCatalog: true,
        hygIndex: index,
        hip: row?.[2] || "",
        hd: row?.[3] || "",
        hr: row?.[4] || "",
        spect: row?.[5] || "",
        x, y, z,
        dLy: Math.hypot(x, y, z) / LY_KM,
        color: colorHexFromBV(VALS[base + FIELD.bv]),
        mass,
        mu: MU_S * mass,
        R: radiusKm,
        radiusSolar,
        // NS/WD luminosities are tiny but finite (stellar.js's synthRemnant);
        // this module never logs them so that's safe as-is. Real HYG rows
        // don't carry an evolutionary "kind" (no per-row IFMR), so catalog
        // stars stay plain photometric points — no BH rows exist in this tier.
        lumSolar: VALS[base + FIELD.lum],
        tempK: VALS[base + FIELD.temp] || SOLAR_TEMP_K,
        mag: VALS[base + FIELD.mag],
        absMag: VALS[base + FIELD.absMag],
        estimated: true,
        flowC: .001 * Math.sqrt(2 * MU_S * mass / 1000),
        flowSink: radiusKm * K,
    };
}

export function sampleHygStarsNear(wx, wy, wz, radiusPc = 20, limit = 96, simT = 0) {
    if (!META || !VALS || !INDEX_READY) return [];
    const gx = wx / PC_KM, gy = wy / PC_KM, gz = wz / PC_KM;
    const key = [
        VERSION,
        Math.floor(gx / CACHE_GRID_PC),
        Math.floor(gy / CACHE_GRID_PC),
        Math.floor(gz / CACHE_GRID_PC),
        radiusPc,
        limit,
        tier0SimTBucket(simT),
    ].join(":");
    if (SAMPLE_CACHE.key === key) return SAMPLE_CACHE.stars;
    const stride = META.stride || 10;
    const r2 = radiusPc * radiusPc;
    const found = [];
    const ciLo = Math.floor((gx - radiusPc) / INDEX_CELL_PC), ciHi = Math.floor((gx + radiusPc) / INDEX_CELL_PC);
    const cjLo = Math.floor((gy - radiusPc) / INDEX_CELL_PC), cjHi = Math.floor((gy + radiusPc) / INDEX_CELL_PC);
    const ckLo = Math.floor((gz - radiusPc) / INDEX_CELL_PC), ckHi = Math.floor((gz + radiusPc) / INDEX_CELL_PC);
    for (let ci = ciLo; ci <= ciHi; ci++)
        for (let cj = cjLo; cj <= cjHi; cj++)
            for (let ck = ckLo; ck <= ckHi; ck++) {
                const bucket = INDEX.get(indexKey(ci, cj, ck));
                if (!bucket) continue;
                for (const i of bucket) {
                    const base = i * stride;
                    const dx = VALS[base + FIELD.x] - gx;
                    const dy = VALS[base + FIELD.y] - gy;
                    const dz = VALS[base + FIELD.z] - gz;
                    const d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 <= r2) {
                        const mass = VALS[base + FIELD.mass];
                        found.push({ index: i, d2, score: mass / Math.max(d2, .0001) });
                    }
                }
            }
    found.sort((a, b) => b.score - a.score || a.d2 - b.d2 || a.index - b.index);
    if (found.length > limit) found.length = limit;
    SAMPLE_CACHE.key = key;
    SAMPLE_CACHE.stars = found.map(item => hygStarByIndex(item.index, simT)).filter(Boolean);
    return SAMPLE_CACHE.stars;
}

export async function ensureHygCatalogLoaded() {
    if (META && VALS) return waitForHygCatalogIndex();
    if (!loadPromise) {
        loadPromise = (async () => {
            const { meta, vals } = await loadHygCatalogData();
            registerHygCatalog(meta, vals, { deferIndex: typeof window !== "undefined" });
            return waitForHygCatalogIndex();
        })();
    }
    return loadPromise;
}

if (typeof window !== "undefined") {
    window.__HYG_CATALOG = {
        stats: hygCatalogStats,
        waitForIndex: waitForHygCatalogIndex,
    };
}
