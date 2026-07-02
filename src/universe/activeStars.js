import { K, LY_KM, MU_S, R_SUN, STARS } from "../constants.js";
import { equatorialKmToGal, galToEquatorialKmInto, PC_KM } from "./coords.js";
import { getSeed, localStarById, sampleLocalStarsNear, starPositionAt } from "./galaxy.js";
import {
    hygCatalogFocusId, hygCatalogFocusValue, hygCatalogStats, hygStarById, sampleHygStarsNear,
} from "./hygActiveCatalog.js";
import { generateSystem, stableStarKey } from "./planetarySystem.js";
import { tier1MassFor } from "./athygTier1.js";

// --- Moving-star re-evaluation cadence (WP8) --------------------------------
// Procedural stars carry epicyclic parameters (galaxy.js's starPositionAt);
// recomputing their rendered position every frame regardless of how far sim
// time actually moved would be wasted trig for a pool this size. Budget: only
// re-evaluate once a star could plausibly have drifted POSITION_DRIFT_BUDGET_PC
// at a TYPICAL_STAR_SPEED_KMS relative speed (peculiar + circular-frame
// residual — a documented approximation sized just to budget the cadence,
// since every star's own precise epicyclic speed varies and computing it
// exactly per-star would defeat the point of a cheap cadence). At 1x warp
// this bucket only advances once every ~19.6 years —
// imperceptible for one flight session, so procedural/pinned stars stay
// visually static as expected. At high time-warp (e.g. Gyr/s) the bucket
// advances many times between frames, so every refreshActiveStars call lands
// in a new bucket and recomputes fresh positions, exactly when it matters.
const POSITION_DRIFT_BUDGET_PC = 0.001;
const TYPICAL_STAR_SPEED_KMS = 50;
const PROC_REEVAL_DT_S = (POSITION_DRIFT_BUDGET_PC * PC_KM) / TYPICAL_STAR_SPEED_KMS; // ≈ 19.6 years
function simTBucket(simT) {
    return Math.floor(simT / PROC_REEVAL_DT_S);
}
const GAL_POS_SCRATCH = [0, 0, 0];
const EQ_POS_SCRATCH = [0, 0, 0];

// 25-60 pc M-dwarf ACTIVE density is intentionally delegated to the tier-1
// visual layer (per-shell floor asserted in smoke-local-tier); follow-up WP
// makes tier-1 queryable.
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
    pins: -1, seed: undefined, hLoaded: false, hReady: false, hVersion: -1, hCount: -1, simTBucket: undefined,
};
let _focusSystem = { starId: "", system: null };

function sameFastRefresh(wx, wy, wz, focus, hStats, simT) {
    if (ACTIVE_STARS.length === 0 || GRAVITY_STARS.length === 0) return false;
    if (!Object.is(focus, FAST_REFRESH.focus) || PINNED_PROC.size !== FAST_REFRESH.pins) return false;
    if (getSeed() !== FAST_REFRESH.seed) return false;
    if (simTBucket(simT) !== FAST_REFRESH.simTBucket) return false;
    if (!!hStats.loaded !== FAST_REFRESH.hLoaded || !!hStats.indexReady !== FAST_REFRESH.hReady) return false;
    if ((hStats.version || 0) !== FAST_REFRESH.hVersion || (hStats.count || 0) !== FAST_REFRESH.hCount) return false;
    const drift = Math.max(Math.abs(wx - FAST_REFRESH.wx), Math.abs(wy - FAST_REFRESH.wy), Math.abs(wz - FAST_REFRESH.wz));
    return drift < ACTIVE_STAR_CONFIG.gravityRefreshGridPc * PC_KM * .18;
}

function rememberFastRefresh(wx, wy, wz, focus, hStats, simT) {
    FAST_REFRESH.wx = wx; FAST_REFRESH.wy = wy; FAST_REFRESH.wz = wz;
    FAST_REFRESH.focus = focus;
    FAST_REFRESH.pins = PINNED_PROC.size;
    FAST_REFRESH.seed = getSeed();
    FAST_REFRESH.simTBucket = simTBucket(simT);
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
    // deterministic short designation so it reads like a survey catalog ID
    // (e.g. "MW-7K3FQ") rather than raw coordinate seeds
    const id = String(src.id || "");
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return "MW-" + h.toString(36).toUpperCase().padStart(5, "0").slice(-5);
}

// Evaluates `src`'s (galaxy.js generator record) position at simT seconds and
// writes the resulting Sol-centred equatorial km into `out` (length-3, reused
// by callers — zero allocation here). simT===0 skips the trig entirely and
// copies the birth position directly (matches starPositionAt's own t=0
// short-circuit), so a freshly generated star and a "moving" one evaluated at
// t=0 are identical.
function proceduralPositionAt(src, simT, out) {
    if (simT === 0) { out[0] = src.x; out[1] = src.y; out[2] = src.z || 0; return out; }
    starPositionAt(src, simT, GAL_POS_SCRATCH);
    galToEquatorialKmInto(GAL_POS_SCRATCH[0], GAL_POS_SCRATCH[1], GAL_POS_SCRATCH[2], out);
    return out;
}

// Static birth-time separation (Sol-centred equatorial km) between a
// procedural primary and its companion, from the seeded orientation angle
// galaxy.js's attachCompanion drew at generation time. No per-frame orbital
// integration this wave (task carry-forward) — the companion rigidly co-moves
// with its primary's live position instead.
function companionOffsetKm(src) {
    const c = src.companion;
    if (!c) return null;
    return { x: c.x - src.x, y: c.y - src.y, z: c.z - src.z };
}

function runtimeProceduralStar(src, simT = 0) {
    const radiusKm = Math.max(0.02, src.R) * R_SUN;
    proceduralPositionAt(src, simT, EQ_POS_SCRATCH);
    const star = {
        id: src.id,
        name: proceduralName(src),
        catalog: "procedural-milky-way",
        procedural: true,
        generatedSeed: getSeed(),
        x: EQ_POS_SCRATCH[0], y: EQ_POS_SCRATCH[1], z: EQ_POS_SCRATCH[2],
        dLy: Math.hypot(EQ_POS_SCRATCH[0], EQ_POS_SCRATCH[1], EQ_POS_SCRATCH[2]) / LY_KM,
        mass: src.mass,
        mu: MU_S * src.mass,
        R: radiusKm,
        radiusSolar: src.R,
        lumSolar: src.L,
        tempK: src.Teff,
        color: src.color,
        cls: src.cls,
        // MS/giant/WD/NS/BH (WP6 remnants). BH rows carry L=0/Teff=0/color
        // 0x000000 by design (stellar.js synthRemnant) — this module only
        // scores stars by mass (mu/d2), never brightness, so that's safe as-is;
        // any future renderer consuming `kind === "BH"` here must guard its
        // own log-brightness/magnitude path instead of dividing/logging L/Teff.
        kind: src.kind,
        age: src.age,
        flowC: .001 * Math.sqrt(2 * MU_S * src.mass / 1000),
        flowSink: radiusKm * K,
        _posSimT: simT,
    };
    const offset = companionOffsetKm(src);
    if (offset) { star.companionOffset = offset; star.companionData = src.companion; }
    return star;
}

// Re-evaluates a previously-created procedural runtime star's position for a
// new simT — used for PINNED_PROC entries, which persist across many
// refreshActiveStars calls instead of being recreated from a fresh
// runtimeProceduralStar() every time. Re-derives the generator record via
// localStarById (already cache-backed in galaxy.js) rather than storing
// epicyclic fields on the runtime object itself.
function repositionProceduralStar(star, simT) {
    if (star._posSimT === simT) return;
    const src = localStarById(star.id);
    if (!src) return;
    proceduralPositionAt(src, simT, EQ_POS_SCRATCH);
    star.x = EQ_POS_SCRATCH[0]; star.y = EQ_POS_SCRATCH[1]; star.z = EQ_POS_SCRATCH[2];
    star.dLy = Math.hypot(star.x, star.y, star.z) / LY_KM;
    const offset = companionOffsetKm(src);
    if (offset) { star.companionOffset = offset; star.companionData = src.companion; }
    star._posSimT = simT;
}

// Materialises a procedural star's binary companion (if any) as its own
// ACTIVE_STARS entry: position = primary's CURRENT position + the fixed
// birth-time separation (see companionOffsetKm above).
function companionActiveStar(primary) {
    const c = primary.companionData, off = primary.companionOffset;
    if (!c || !off) return null;
    const radiusKm = Math.max(0.02, c.R) * R_SUN;
    const x = primary.x + off.x, y = primary.y + off.y, z = primary.z + off.z;
    return {
        id: primary.id + ":B",
        name: primary.name + " B",
        catalog: "procedural-milky-way",
        procedural: true,
        companionOf: primary.id,
        generatedSeed: getSeed(),
        x, y, z,
        dLy: Math.hypot(x, y, z) / LY_KM,
        mass: c.mass,
        mu: MU_S * c.mass,
        R: radiusKm,
        radiusSolar: c.R,
        lumSolar: c.L,
        tempK: c.Teff,
        color: c.color,
        cls: c.cls,
        kind: c.kind, // see the BH note in runtimeProceduralStar above — applies equally to companions
        separationPc: c.separationPc,
        periodDays: c.periodDays,
        flowC: .001 * Math.sqrt(2 * MU_S * c.mass / 1000),
        flowSink: radiusKm * K,
    };
}

// Pushes `primary`'s companion into ACTIVE_STARS if it has one, respecting
// the same totalLimit/dedup rules as any other active star (pushActive already
// enforces both, so a full pool simply drops the companion rather than
// overflowing). Masked against the curated STARS list, the same check the
// primary itself already passed before being pushed — masking against the
// live ACTIVE_STARS pool would make every companion mask itself out, since it
// sits only a fraction of a pc from its own primary by construction.
function pushCompanionIfAny(primary) {
    if (!primary?.companionData) return;
    const comp = companionActiveStar(primary);
    if (comp && !maskedByKnown(comp, STARS)) pushActive(comp, comp.id, "procedural");
}

export function proceduralStarById(id, simT = 0) {
    const src = localStarById(id);
    return src ? runtimeProceduralStar(src, simT) : null;
}

export function pinProceduralStarById(id, simT = 0) {
    const cached = PINNED_PROC.get(id);
    if (cached) {
        PINNED_PROC.delete(id);
        PINNED_PROC.set(id, cached);
        trimPinnedProcedural(id);
        ACTIVE_REFRESH_KEY = "";
        repositionProceduralStar(cached, simT);
        return cached;
    }
    const star = proceduralStarById(id, simT);
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

// A companion's id is always "<primaryId>:B" (see companionActiveStar below),
// never its own generator record, so activeStarById's normal fallbacks
// (PINNED_PROC.get/proceduralStarById/catalogStarById) can't resolve one on
// their own — only pushCompanionIfAny materializes it, and only once its
// primary is active. Falling back to deriving the companion straight from
// its primary here means focus resolution works even on the very first call
// (before refreshActiveStars has had a chance to push the companion into
// ACTIVE_STARS itself).
export function activeStarForFocus(focus) {
    const id = proceduralFocusId(focus) || hygCatalogFocusId(focus);
    if (!id) return null;
    const direct = activeStarById(id);
    if (direct) return direct;
    if (id.endsWith(":B")) {
        const primary = activeStarById(id.slice(0, -2));
        if (primary) return companionActiveStar(primary);
    }
    return null;
}

export function getFocusedSystem(star, simT = 0) {
    if (!star) return null;
    const id = stableStarKey(star);
    if (_focusSystem.starId !== id) {
        const system = generateSystem(star);
        system.hostStar = star;
        _focusSystem = { starId: id, system };
    } else if (_focusSystem.system) _focusSystem.system.hostStar = star;
    return _focusSystem.system;
}

export function getCachedFocusedSystem() {
    return _focusSystem.system;
}

export function promoteTier1Star(tileId, idx) {
    const info = tier1MassFor(tileId, idx);
    if (!info?.position) return null;
    const star = {
        id: "t1:" + tileId + ":" + idx,
        name: "AT-HYG " + tileId + ":" + idx,
        catalog: "athyg-tier1",
        tier1: { tileId, idx },
        x: info.position.x, y: info.position.y, z: info.position.z,
        dLy: Math.hypot(info.position.x, info.position.y, info.position.z) / LY_KM,
        mass: info.mass,
        mu: MU_S * info.mass,
        R: info.R * R_SUN,
        radiusSolar: info.R,
        lumSolar: info.L,
        tempK: info.Teff,
        color: 0xfff4dc,
        kind: "MS",
        flowC: .001 * Math.sqrt(2 * MU_S * info.mass / 1000),
        flowSink: info.R * R_SUN * K,
    };
    pushActive(star, star.id, "catalog");
    return star;
}

function cacheKey(gx, gy, gz, simT = 0) {
    const g = ACTIVE_STAR_CONFIG.refreshGridPc;
    return [
        getSeed(),
        Math.floor(gx / g),
        Math.floor(gy / g),
        Math.floor(gz / g),
        simTBucket(simT),
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

function proceduralStarsFor(wx, wy, wz, simT = 0) {
    const [gx, gy, gz] = equatorialKmToGal(wx, wy, wz);
    const key = cacheKey(gx, gy, gz, simT);
    if (PROC_CACHE.key !== key) {
        PROC_CACHE.key = key;
        PROC_CACHE.stars = sampleLocalStarsNear(
            gx,
            gy,
            gz,
            ACTIVE_STAR_CONFIG.proceduralRadiusPc,
            ACTIVE_STAR_CONFIG.proceduralLimit,
        ).map(src => runtimeProceduralStar(src, simT));
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

function catalogStarById(id, simT = 0) {
    const star = hygStarById(id, simT);
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

// simT (seconds, sim/mission-elapsed time): when to evaluate moving stars at.
// Defaults to 0 (every pre-WP8 caller, and physics.js's deep-jump recompute,
// still gets the exact static birth/epoch pool). main.js threads the real
// value through once its frame loop is wired up (WP10).
export function refreshActiveStars(wx = 0, wy = 0, wz = 0, focus = -1, simT = 0) {
    const hStats = hygCatalogStats();
    if (sameFastRefresh(wx, wy, wz, focus, hStats, simT)) return activeStarStats();
    const forcedIndex = focusStarIndex(focus);
    const forcedProcId = proceduralFocusId(focus);
    const forcedCatalogId = hygCatalogFocusId(focus);
    const gal = equatorialKmToGal(wx, wy, wz);
    const refreshKey = [
        cacheKey(gal[0], gal[1], gal[2], simT),
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
        rememberFastRefresh(wx, wy, wz, focus, hStats, simT);
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
        const forcedCatalog = catalogStarById(forcedCatalogId, simT);
        if (forcedCatalog) pushActive(forcedCatalog, activeId(forcedCatalog), forcedCatalog.activeCatalog ? "catalog" : "known");
    }
    if (forcedProcId) {
        // A companion (id "<primaryId>:B") has no generator record of its own
        // — pinProceduralStarById/localStarById can only look up primaries —
        // so a focus on a companion pins its PRIMARY instead; the companion
        // then re-materializes via pushCompanionIfAny below, same as any
        // other already-pinned primary's companion. activeStarForFocus
        // resolves the ":B" id back out of that once the primary is active.
        const primaryProcId = forcedProcId.endsWith(":B") ? forcedProcId.slice(0, -2) : forcedProcId;
        const forcedProc = pinProceduralStarById(primaryProcId, simT);
        if (forcedProc) { pushActive(forcedProc, forcedProc.id, "procedural"); pushCompanionIfAny(forcedProc); }
    }
    for (const [id, star] of PINNED_PROC) {
        if (ACTIVE_STARS.length >= ACTIVE_STAR_CONFIG.totalLimit) break;
        repositionProceduralStar(star, simT);
        pushActive(star, id, "procedural");
        pushCompanionIfAny(star);
    }

    const catalogSlotsLeft = Math.max(0, ACTIVE_STAR_CONFIG.catalogLimit - STATS.catalog);
    const catalog = sampleHygStarsNear(
        wx,
        wy,
        wz,
        ACTIVE_STAR_CONFIG.catalogRadiusPc,
        Math.min(ACTIVE_STAR_CONFIG.catalogOversampleLimit, ACTIVE_STAR_CONFIG.totalLimit),
        simT,
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
        const procStars = proceduralStarsFor(wx, wy, wz, simT);
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
        pushCompanionIfAny(item.star);
    }
    STATS.total = ACTIVE_STARS.length;
    ACTIVE_REFRESH_KEY = refreshKey;
    rebuildGravityStars(wx, wy, wz, forcedIndex, forcedProcId, forcedCatalogId, gravKey);
    rememberFastRefresh(wx, wy, wz, focus, hStats, simT);
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
