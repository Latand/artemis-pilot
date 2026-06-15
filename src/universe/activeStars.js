import { K, LY_KM, MU_S, R_SUN, STARS } from "../constants.js";
import { equatorialKmToGal, PC_KM } from "./coords.js";
import { getSeed, localStarById, sampleLocalStarsNear } from "./galaxy.js";
import {
    hygCatalogFocusId, hygCatalogFocusValue, hygCatalogStats, hygStarById, sampleHygStarsNear,
} from "./hygActiveCatalog.js";

export const ACTIVE_STAR_CONFIG = {
    proceduralRadiusPc: 8,
    refreshGridPc: 2,
    knownLimit: 256,
    catalogRadiusPc: 20,
    catalogLimit: 96,
    catalogOversampleLimit: 640,
    proceduralLimit: 420,
    pinnedProceduralLimit: 384,
    totalLimit: 640,
    gravityLimit: 64,
    gravityRefreshGridPc: 0.25,
    realMaskPc: 0.35,
};

export const ACTIVE_STARS = [];
export const GRAVITY_STARS = [];
const ACTIVE_IDS = new Set();
const GRAVITY_IDS = new Set();
const PINNED_PROC = new Map();
const PROC_CACHE = { key: "", stars: [] };
const PROC_NEAREST = [];
const PROC_POOL = [];
const GRAVITY_RANK = [];
const STATS = {
    known: 0,
    catalog: 0,
    procedural: 0,
    total: 0,
    gravity: 0,
    seed: getSeed(),
    radiusPc: ACTIVE_STAR_CONFIG.proceduralRadiusPc,
};
let ACTIVE_REFRESH_KEY = "";
let GRAVITY_REFRESH_KEY = "";
const FAST_REFRESH = {
    wx: Infinity, wy: Infinity, wz: Infinity, focus: undefined,
    pins: -1, seed: undefined, hLoaded: false, hReady: false, hVersion: -1, hCount: -1,
};

function sameFastRefresh(wx, wy, wz, focus, hStats) {
    if (ACTIVE_STARS.length === 0 || GRAVITY_STARS.length === 0) return false;
    if (!Object.is(focus, FAST_REFRESH.focus) || PINNED_PROC.size !== FAST_REFRESH.pins) return false;
    if (getSeed() !== FAST_REFRESH.seed) return false;
    if (!!hStats.loaded !== FAST_REFRESH.hLoaded || !!hStats.indexReady !== FAST_REFRESH.hReady) return false;
    if ((hStats.version || 0) !== FAST_REFRESH.hVersion || (hStats.count || 0) !== FAST_REFRESH.hCount) return false;
    const drift = Math.max(Math.abs(wx - FAST_REFRESH.wx), Math.abs(wy - FAST_REFRESH.wy), Math.abs(wz - FAST_REFRESH.wz));
    return drift < ACTIVE_STAR_CONFIG.gravityRefreshGridPc * PC_KM * .18;
}

function rememberFastRefresh(wx, wy, wz, focus, hStats) {
    FAST_REFRESH.wx = wx; FAST_REFRESH.wy = wy; FAST_REFRESH.wz = wz;
    FAST_REFRESH.focus = focus;
    FAST_REFRESH.pins = PINNED_PROC.size;
    FAST_REFRESH.seed = getSeed();
    FAST_REFRESH.hLoaded = !!hStats.loaded;
    FAST_REFRESH.hReady = !!hStats.indexReady;
    FAST_REFRESH.hVersion = hStats.version || 0;
    FAST_REFRESH.hCount = hStats.count || 0;
}

function focusStarIndex(focus) {
    if (typeof focus !== "string") return -1;
    const m = focus.match(/^star:(\d+)$/);
    return m ? Number(m[1]) : -1;
}

export function proceduralFocusId(focus) {
    if (typeof focus !== "string") return "";
    const m = focus.match(/^proc:(.+)$/);
    return m ? m[1] : "";
}

export function proceduralFocusValue(idOrStar) {
    const id = typeof idOrStar === "string" ? idOrStar : idOrStar?.id;
    return id ? "proc:" + id : "";
}

export { hygCatalogFocusId, hygCatalogFocusValue, hygCatalogStats };

export function activeStarFocusValue(star) {
    if (!star) return "";
    if (star.procedural) return proceduralFocusValue(star);
    if (star.activeCatalog) return hygCatalogFocusValue(star);
    return "";
}

function activeId(star, fallback = "") {
    if (star.id) return star.id;
    const knownIndex = STARS.indexOf(star);
    if (knownIndex >= 0) return "known:" + knownIndex;
    if (star.hygIndex !== undefined) return "hyg:" + star.hygIndex;
    return star.name || fallback;
}

function pushActive(star, id, kind) {
    if (!star || ACTIVE_IDS.has(id)) return false;
    if (ACTIVE_STARS.length >= ACTIVE_STAR_CONFIG.totalLimit) return false;
    ACTIVE_IDS.add(id);
    ACTIVE_STARS.push(star);
    if (kind === "procedural") STATS.procedural++;
    else if (kind === "catalog") STATS.catalog++;
    else STATS.known++;
    return true;
}

function scoreKnownStar(star, wx, wy, wz, index, forcedIndex) {
    const dx = wx - star.x, dy = wy - star.y, dz = wz - (star.z || 0);
    const d2 = Math.max(1, dx * dx + dy * dy + dz * dz);
    let score = star.mu / d2;
    if (star.bh) score *= 1e6;
    if (index === forcedIndex) score = Infinity;
    return { star, index, score, d2 };
}

function proceduralName(src) {
    const parts = String(src.id || "").split(":").slice(1, 5).join(".");
    return "MW " + (parts || "STAR");
}

function runtimeProceduralStar(src) {
    const radiusKm = Math.max(0.02, src.R) * R_SUN;
    const star = {
        id: src.id,
        name: proceduralName(src),
        catalog: "procedural-milky-way",
        procedural: true,
        generatedSeed: getSeed(),
        gx: src.gx, gy: src.gy, gz: src.gz,
        x: src.x, y: src.y, z: src.z || 0,
        dLy: Math.hypot(src.x, src.y, src.z || 0) / LY_KM,
        mass: src.mass,
        mu: MU_S * src.mass,
        R: radiusKm,
        radiusSolar: src.R,
        lumSolar: src.L,
        tempK: src.Teff,
        color: src.color,
        cls: src.cls,
        flowC: .001 * Math.sqrt(2 * MU_S * src.mass / 1000),
        flowSink: radiusKm * K,
    };
    return star;
}

export function proceduralStarById(id) {
    const src = localStarById(id);
    return src ? runtimeProceduralStar(src) : null;
}

export function pinProceduralStarById(id) {
    const cached = PINNED_PROC.get(id);
    if (cached) {
        PINNED_PROC.delete(id);
        PINNED_PROC.set(id, cached);
        trimPinnedProcedural(id);
        ACTIVE_REFRESH_KEY = "";
        return cached;
    }
    const star = proceduralStarById(id);
    if (!star) return null;
    PINNED_PROC.set(id, star);
    trimPinnedProcedural(id);
    ACTIVE_REFRESH_KEY = "";
    return star;
}

function trimPinnedProcedural(keepId = "") {
    const limit = Math.max(0, Math.min(ACTIVE_STAR_CONFIG.pinnedProceduralLimit, ACTIVE_STAR_CONFIG.totalLimit));
    if (keepId && PINNED_PROC.has(keepId)) {
        const kept = PINNED_PROC.get(keepId);
        PINNED_PROC.delete(keepId);
        PINNED_PROC.set(keepId, kept);
    }
    while (PINNED_PROC.size > limit) {
        const oldest = PINNED_PROC.keys().next().value;
        if (oldest === undefined) break;
        PINNED_PROC.delete(oldest);
    }
}

export function activeStarById(id) {
    for (const star of ACTIVE_STARS) if (activeId(star) === id) return star;
    return PINNED_PROC.get(id) || proceduralStarById(id) || catalogStarById(id);
}

export function activeStarForFocus(focus) {
    const id = proceduralFocusId(focus) || hygCatalogFocusId(focus);
    return id ? activeStarById(id) : null;
}

function cacheKey(gx, gy, gz) {
    const g = ACTIVE_STAR_CONFIG.refreshGridPc;
    return [
        getSeed(),
        Math.floor(gx / g),
        Math.floor(gy / g),
        Math.floor(gz / g),
    ].join(":");
}

function gravityCacheKey(gx, gy, gz, focus, activeKey) {
    const g = ACTIVE_STAR_CONFIG.gravityRefreshGridPc;
    return [
        activeKey,
        String(focus),
        Math.floor(gx / g),
        Math.floor(gy / g),
        Math.floor(gz / g),
    ].join(":");
}

function proceduralStarsFor(wx, wy, wz) {
    const [gx, gy, gz] = equatorialKmToGal(wx, wy, wz);
    const key = cacheKey(gx, gy, gz);
    if (PROC_CACHE.key !== key) {
        PROC_CACHE.key = key;
        PROC_CACHE.stars = sampleLocalStarsNear(
            gx,
            gy,
            gz,
            ACTIVE_STAR_CONFIG.proceduralRadiusPc,
            ACTIVE_STAR_CONFIG.proceduralLimit,
        ).map(runtimeProceduralStar);
    }
    return PROC_CACHE.stars;
}

function maskedByKnown(star, known) {
    const maskKm = ACTIVE_STAR_CONFIG.realMaskPc * PC_KM;
    const mask2 = maskKm * maskKm;
    for (const k of known) {
        const dx = star.x - k.x, dy = star.y - k.y, dz = (star.z || 0) - (k.z || 0);
        if (dx * dx + dy * dy + dz * dz <= mask2) return true;
    }
    return false;
}

function insertNearestProcedural(star, d2, limit) {
    if (limit <= 0) return;
    const count = PROC_NEAREST.length;
    if (count >= limit && d2 >= PROC_NEAREST[count - 1].d2) return;
    const nextCount = count < limit ? count + 1 : count;
    let item;
    if (count < limit) {
        item = PROC_POOL[nextCount - 1] || (PROC_POOL[nextCount - 1] = { star: null, d2: 0 });
        PROC_NEAREST.length = nextCount;
    } else item = PROC_NEAREST[count - 1];
    let p = Math.min(count, limit - 1);
    while (p > 0 && d2 < PROC_NEAREST[p - 1].d2) {
        PROC_NEAREST[p] = PROC_NEAREST[p - 1];
        p--;
    }
    item.star = star;
    item.d2 = d2;
    PROC_NEAREST[p] = item;
}

function knownDuplicateFor(star) {
    if (!star?.activeCatalog) return null;
    const maskKm = ACTIVE_STAR_CONFIG.realMaskPc * PC_KM;
    const mask2 = maskKm * maskKm;
    for (const known of STARS) {
        const dx = star.x - known.x, dy = star.y - known.y, dz = (star.z || 0) - (known.z || 0);
        if (dx * dx + dy * dy + dz * dz <= mask2) return known;
    }
    return null;
}

function catalogStarById(id) {
    const star = hygStarById(id);
    return knownDuplicateFor(star) || star;
}

function starInfluence(star, wx, wy, wz) {
    const dx = wx - star.x, dy = wy - star.y, dz = wz - (star.z || 0);
    const d2 = Math.max(1, dx * dx + dy * dy + dz * dz);
    return { star, score: star.mu / d2, d2 };
}

function priorityGravityStar(star, id, d2, forcedIndex, forcedProcId, forcedCatalogId) {
    if (star.bh) return true;
    if (forcedIndex >= 0 && id === "known:" + forcedIndex) return true;
    if (forcedProcId && id === forcedProcId) return true;
    if (forcedCatalogId && id === forcedCatalogId) return true;
    const contactR = Math.max(star.bh ? (star.rs || star.R) : star.R, star.R || 0);
    return contactR > 0 && d2 <= contactR * contactR * 1600;
}

function pushGravity(star, id) {
    if (!star || GRAVITY_IDS.has(id)) return false;
    GRAVITY_IDS.add(id);
    GRAVITY_STARS.push(star);
    return true;
}

function rebuildGravityStars(wx, wy, wz, forcedIndex, forcedProcId, forcedCatalogId, key) {
    GRAVITY_STARS.length = 0;
    GRAVITY_IDS.clear();
    GRAVITY_RANK.length = 0;
    const limit = Math.max(1, Math.min(ACTIVE_STAR_CONFIG.gravityLimit, ACTIVE_STAR_CONFIG.totalLimit));
    for (const star of ACTIVE_STARS) {
        const id = activeId(star);
        const dx = wx - star.x, dy = wy - star.y, dz = wz - (star.z || 0);
        const d2 = Math.max(1, dx * dx + dy * dy + dz * dz);
        let score = star.mu / d2;
        if (star.bh) score *= 1e6;
        if (priorityGravityStar(star, id, d2, forcedIndex, forcedProcId, forcedCatalogId)) {
            pushGravity(star, id);
            score = Infinity;
        }
        GRAVITY_RANK.push({ star, id, score, d2 });
    }
    GRAVITY_RANK.sort((a, b) => b.score - a.score || a.d2 - b.d2 || a.id.localeCompare(b.id));
    for (const item of GRAVITY_RANK) {
        if (GRAVITY_STARS.length >= limit) break;
        pushGravity(item.star, item.id);
    }
    STATS.gravity = GRAVITY_STARS.length;
    GRAVITY_REFRESH_KEY = key;
}

export function refreshActiveStars(wx = 0, wy = 0, wz = 0, focus = -1) {
    const hStats = hygCatalogStats();
    if (sameFastRefresh(wx, wy, wz, focus, hStats)) return activeStarStats();
    const forcedIndex = focusStarIndex(focus);
    const forcedProcId = proceduralFocusId(focus);
    const forcedCatalogId = hygCatalogFocusId(focus);
    const gal = equatorialKmToGal(wx, wy, wz);
    const refreshKey = [
        cacheKey(gal[0], gal[1], gal[2]),
        String(focus),
        PINNED_PROC.size,
        hStats.loaded ? 1 : 0,
        hStats.indexReady ? 1 : 0,
        hStats.version || 0,
        hStats.count || 0,
    ].join("|");
    const gravKey = gravityCacheKey(gal[0], gal[1], gal[2], focus, refreshKey);
    if (refreshKey === ACTIVE_REFRESH_KEY && ACTIVE_STARS.length > 0) {
        if (gravKey !== GRAVITY_REFRESH_KEY || GRAVITY_STARS.length === 0) {
            rebuildGravityStars(wx, wy, wz, forcedIndex, forcedProcId, forcedCatalogId, gravKey);
        }
        rememberFastRefresh(wx, wy, wz, focus, hStats);
        return activeStarStats();
    }
    ACTIVE_STARS.length = 0;
    ACTIVE_IDS.clear();
    STATS.known = 0;
    STATS.catalog = 0;
    STATS.procedural = 0;
    STATS.gravity = 0;
    STATS.seed = getSeed();
    const known = [];
    for (let i = 0; i < STARS.length; i++) known.push(scoreKnownStar(STARS[i], wx, wy, wz, i, forcedIndex));
    known.sort((a, b) => b.score - a.score || a.d2 - b.d2);
    const knownKeep = Math.min(ACTIVE_STAR_CONFIG.knownLimit, known.length);
    for (let i = 0; i < knownKeep; i++) pushActive(known[i].star, "known:" + known[i].index, "known");
    if (forcedIndex >= 0 && forcedIndex < STARS.length) pushActive(STARS[forcedIndex], "known:" + forcedIndex, "known");
    for (let i = 0; i < STARS.length; i++) if (STARS[i].bh) pushActive(STARS[i], "known:" + i, "known");
    if (forcedCatalogId) {
        const forcedCatalog = catalogStarById(forcedCatalogId);
        if (forcedCatalog) pushActive(forcedCatalog, activeId(forcedCatalog), forcedCatalog.activeCatalog ? "catalog" : "known");
    }
    if (forcedProcId) {
        const forcedProc = pinProceduralStarById(forcedProcId);
        if (forcedProc) pushActive(forcedProc, forcedProc.id, "procedural");
    }
    for (const [id, star] of PINNED_PROC) {
        if (ACTIVE_STARS.length >= ACTIVE_STAR_CONFIG.totalLimit) break;
        pushActive(star, id, "procedural");
    }

    const catalogSlotsLeft = Math.max(0, ACTIVE_STAR_CONFIG.catalogLimit - STATS.catalog);
    const catalog = sampleHygStarsNear(
        wx,
        wy,
        wz,
        ACTIVE_STAR_CONFIG.catalogRadiusPc,
        Math.min(ACTIVE_STAR_CONFIG.catalogOversampleLimit, ACTIVE_STAR_CONFIG.totalLimit),
    )
        .filter(st => !maskedByKnown(st, ACTIVE_STARS))
        .map(star => starInfluence(star, wx, wy, wz))
        .sort((a, b) => b.score - a.score || a.d2 - b.d2 || activeId(a.star).localeCompare(activeId(b.star)))
        .slice(0, catalogSlotsLeft)
        .map(item => item.star);
    for (const star of catalog) {
        if (ACTIVE_STARS.length >= ACTIVE_STAR_CONFIG.totalLimit) break;
        pushActive(star, activeId(star), "catalog");
    }
    PROC_NEAREST.length = 0;
    const procLimit = ACTIVE_STAR_CONFIG.totalLimit - ACTIVE_STARS.length;
    if (procLimit > 0) {
        const procStars = proceduralStarsFor(wx, wy, wz);
        for (let i = 0; i < procStars.length; i++) {
            const st = procStars[i];
            if (maskedByKnown(st, ACTIVE_STARS)) continue;
            const dx = wx - st.x, dy = wy - st.y, dz = wz - (st.z || 0);
            insertNearestProcedural(st, dx * dx + dy * dy + dz * dz, procLimit);
        }
    }
    for (const item of PROC_NEAREST) {
        if (ACTIVE_STARS.length >= ACTIVE_STAR_CONFIG.totalLimit) break;
        pushActive(item.star, activeId(item.star), "procedural");
    }
    STATS.total = ACTIVE_STARS.length;
    ACTIVE_REFRESH_KEY = refreshKey;
    rebuildGravityStars(wx, wy, wz, forcedIndex, forcedProcId, forcedCatalogId, gravKey);
    rememberFastRefresh(wx, wy, wz, focus, hStats);
    return activeStarStats();
}

export function activeStarStats() {
    return { ...STATS };
}

export function nearestActiveStar(wx, wy, wz) {
    let best = null, bestD = Infinity;
    for (const star of ACTIVE_STARS) {
        const d = Math.hypot(wx - star.x, wy - star.y, wz - (star.z || 0));
        if (d < bestD) { bestD = d; best = star; }
    }
    return { star: best, d: bestD };
}

export function nearestProceduralStar(wx, wy, wz) {
    let best = null, bestD = Infinity;
    for (const star of ACTIVE_STARS) {
        if (!star.procedural) continue;
        const d = Math.hypot(wx - star.x, wy - star.y, wz - (star.z || 0));
        if (d < bestD) { bestD = d; best = star; }
    }
    return { star: best, d: bestD };
}

export function serializePinnedProceduralStars() {
    return Array.from(PINNED_PROC.keys());
}

export function restorePinnedProceduralStars(ids = []) {
    const requested = new Set(ids || []);
    for (const id of requested) pinProceduralStarById(id);
    return Array.from(PINNED_PROC.keys()).filter(id => requested.has(id));
}

refreshActiveStars(0, 0, 0);
if (typeof window !== "undefined") window.__ACTIVE_STARS = ACTIVE_STARS;
if (typeof window !== "undefined") window.__GRAVITY_STARS = GRAVITY_STARS;
