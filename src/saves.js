// Quicksave / quickload: one browser-storage slot holding the full simulation
// state — ship, world flags, the live n-body ephemeris, and every black hole.
import { C_LIGHT, INITIAL_STAR_COUNT, STARS } from "./constants.js";
import { G, WORLD, BH, GS } from "./state.js";
import { snapshotEphem, loadEphemSnapshot } from "./ephemeris.js";
import { serializeLog, restoreLog } from "./discoveryLog.js";
import { addBlackHole, clearBlackHoles } from "./blackholes.js";
import { serializeNebulae, restoreNebulae } from "./render/nebulae.js";
import { clearTrail, pushTrail, computePrediction } from "./trails.js";
import { hideBanner, showBanner } from "./hud.js";
import { fmtMET } from "./format.js";
import { toast } from "./achievements.js";
import {
    hygCatalogFocusId, hygCatalogFocusValue, proceduralFocusId, proceduralFocusValue,
    restorePinnedProceduralStars, serializePinnedProceduralStars,
} from "./universe/activeStars.js";
import { getSeed, setSeed } from "./universe/galaxy.js";
import { getEpochMs, setEpochMs } from "./epoch.js";

const SLOT = "artemis.quicksave.v1";
const DEFAULT_SEED = 0x9e3779b9;
const G_FIELDS = [
    "t", "x", "y", "z", "vx", "vy", "vz", "heading", "pitch", "throttle", "warp", "paused",
    "fuel", "infinite", "dvUsed", "hold", "landed", "dead", "deadReason",
    "deathT", "leftHome", "maxRE", "gr", "predict", "constellations", "darkEnergy", "darkMatter", "muted", "ambientAudio", "focus",
    "cabin",
];
const SERIAL_STAR_FIELDS = [
    "name", "dLy", "x", "y", "z", "color", "mass", "R", "catalog", "hygIndex",
    "hip", "hd", "hr", "spect", "mag", "absMag", "lumSolar", "tempK", "estimated",
];

function serializePromotedCatalogStars() {
    return STARS.slice(INITIAL_STAR_COUNT)
        .filter(star => star.catalog === "hyg-v41-promoted" && Number.isFinite(star.hygIndex))
        .map(star => Object.fromEntries(SERIAL_STAR_FIELDS
            .filter(field => star[field] !== undefined)
            .map(field => [field, star[field]])));
}

async function restorePromotedCatalogStars(rows = []) {
    if (!rows?.length) return [];
    const mod = await import("./catalogSearch.js");
    return mod.restorePromotedCatalogStars(rows);
}

// epoch.js has landed (WP21), so the touch points use the static import
// directly: saveState stays SYNCHRONOUS with the keypress (review F2 — an
// await before localStorage.setItem could drop a quicksave on immediate
// tab-close, and a pre-try throw became an unhandled rejection).
function readEpochMs() {
    const ms = getEpochMs();
    return Number.isFinite(ms) ? ms : null;
}

function applyEpochMs(ms) {
    if (!Number.isFinite(ms)) return;
    setEpochMs(ms);
}

export function saveState() {
    const ephSt = snapshotEphem();
    const focusMatch = typeof G.focus === "string" && G.focus.match(/^star:(\d+)$/);
    const focusStar = focusMatch ? STARS[Number(focusMatch[1])] : null;
    const focusProcId = proceduralFocusId(G.focus);
    const focusHygId = hygCatalogFocusId(G.focus);
    const procStars = Array.from(new Set(serializePinnedProceduralStars().concat(focusProcId ? [focusProcId] : [])));
    const epochMs = readEpochMs();
    const data = {
        v: 11,
        galaxySeed: getSeed(),
        epochMs,
        g: Object.fromEntries(G_FIELDS.map(k => [k, G[k]])),
        focusCatalog: focusStar && focusStar.catalog === "hyg-v41-promoted"
            ? { hygIndex: focusStar.hygIndex, name: focusStar.name }
            : null,
        focusHygCatalog: focusHygId ? { id: focusHygId } : null,
        focusProcedural: focusProcId ? { id: focusProcId } : null,
        procStars,
        hygStars: serializePromotedCatalogStars(),
        world: {
            earth: WORLD.earthDestroyed, moon: WORLD.moonDestroyed, sun: WORLD.sunDestroyed,
            pl: Array.from(WORLD.plDestroyed),
        },
        log: serializeLog(),
        eph: {
            x: Array.from(ephSt.x), y: Array.from(ephSt.y),
            vx: Array.from(ephSt.vx), vy: Array.from(ephSt.vy),
            earthX: ephSt.earthX, earthY: ephSt.earthY,
            earthVx: ephSt.earthVx, earthVy: ephSt.earthVy,
            // 3-D ephemeris (WP13) isn't shipped yet; serialize the z/vz
            // fields speculatively so this format needs no bump once it lands.
            ...(ephSt.z !== undefined ? { z: Array.from(ephSt.z) } : {}),
            ...(ephSt.vz !== undefined ? { vz: Array.from(ephSt.vz) } : {}),
            ...(Number.isFinite(ephSt.earthZ) ? { earthZ: ephSt.earthZ } : {}),
            ...(Number.isFinite(ephSt.earthVz) ? { earthVz: ephSt.earthVz } : {}),
        },
        bh: Array.from({ length: BH.n }, (_, i) => [BH.x[i], BH.y[i], BH.vx[i], BH.vy[i], BH.rs[i], BH.kind[i], BH.period[i]]),
        neb: serializeNebulae(),
        // gravity-front bookkeeping: per-hole mass-gain events, plus the
        // phantom/ghost sources (Infinity survives JSON as null)
        bhEv: Array.from({ length: BH.n }, (_, i) => (BH.ev[i] || []).map(e => [e.x, e.y, e.z || 0, e.t, e.dmu])),
        gs: GS.map(s => [s.x, s.y, s.z || 0, s.vx, s.vy, s.vz || 0, s.mu, s.R, s.t0, isFinite(s.t) ? s.t : null]),
        bhSizeIdx: BH.sizeIdx,
    };
    try {
        localStorage.setItem(SLOT, JSON.stringify(data));
        toast("Quicksaved · MET " + fmtMET(G.t) + " · L to load");
        return true;
    } catch (e) {
        toast("Save failed: " + e.message);
        return false;
    }
}

export async function loadState() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SLOT)); } catch (e) { /* corrupt slot falls through */ }
    if (!data || (data.v < 1 || data.v > 11)) { toast("No saved state · K to save one"); return false; }
    // The procedural galaxy is a pure function of (seed, cell coords), so the
    // seed must land before any procedural star is regenerated from a saved id.
    setSeed(data.v >= 9 && Number.isFinite(data.galaxySeed) ? (data.galaxySeed >>> 0) : DEFAULT_SEED);
    applyEpochMs(data.v >= 9 ? data.epochMs : null);
    const restoredStars = data.v >= 5 ? await restorePromotedCatalogStars(data.hygStars) : [];
    const restoredProc = data.v >= 6 ? restorePinnedProceduralStars(data.procStars) : [];
    Object.assign(G, data.g);
    if (data.v >= 10 && data.log) restoreLog(data.log);
    else restoreLog(null);
    if (data.focusCatalog && Number.isFinite(Number(data.focusCatalog.hygIndex))) {
        const focusIndex = STARS.findIndex(star => star.hygIndex === Number(data.focusCatalog.hygIndex));
        if (focusIndex >= 0) G.focus = "star:" + focusIndex;
    }
    if (data.focusHygCatalog?.id) {
        const focusValue = hygCatalogFocusValue(data.focusHygCatalog.id);
        if (focusValue) G.focus = focusValue;
    }
    if (data.focusProcedural?.id && restoredProc.includes(data.focusProcedural.id)) {
        G.focus = proceduralFocusValue(data.focusProcedural.id);
    }
    if (!Number.isFinite(data.g.z)) G.z = 0;
    if (!Number.isFinite(data.g.vz)) G.vz = 0;
    if (!Number.isFinite(data.g.pitch)) G.pitch = 0;
    for (const k of ["x", "y", "z", "vx", "vy", "vz", "heading", "pitch"])
        if (!Number.isFinite(G[k])) G[k] = 0;
    if (typeof G.darkEnergy !== "boolean") G.darkEnergy = true;
    if (typeof G.darkMatter !== "boolean") G.darkMatter = true;
    if (typeof G.predict !== "boolean") G.predict = false;
    if (typeof G.constellations !== "boolean") G.constellations = true;
    if (typeof G.cabin !== "boolean") G.cabin = false;
    G.observerMode = false;
    G.deathRt = G.dead ? performance.now() : 0;
    G.boost = false;
    WORLD.earthDestroyed = !!data.world.earth;
    WORLD.moonDestroyed = !!data.world.moon;
    WORLD.sunDestroyed = !!data.world.sun;
    WORLD.plDestroyed.set(data.world.pl);
    loadEphemSnapshot({
        x: Float64Array.from(data.eph.x), y: Float64Array.from(data.eph.y),
        vx: Float64Array.from(data.eph.vx), vy: Float64Array.from(data.eph.vy),
        earthX: data.eph.earthX, earthY: data.eph.earthY,
        earthVx: data.eph.earthVx, earthVy: data.eph.earthVy,
        // Pre-WP13 saves (and pre-WP13 code reading a v9 save) simply have no
        // z/vz keys here; only pass them through when both are present.
        ...(data.eph.z ? { z: Float64Array.from(data.eph.z) } : {}),
        ...(data.eph.vz ? { vz: Float64Array.from(data.eph.vz) } : {}),
        ...(Number.isFinite(data.eph.earthZ) ? { earthZ: data.eph.earthZ } : {}),
        ...(Number.isFinite(data.eph.earthVz) ? { earthVz: data.eph.earthVz } : {}),
        t: data.g.t, // gravity fronts measure from the saved clock
    });
    GS.length = 0;
    for (const row of data.gs || []) {
        const [x, y, z, vx, vy, vz, mu, R, t0, t] = row.length >= 10
            ? row
            : [row[0], row[1], 0, row[2], row[3], 0, row[4], row[5], row[6], row[7]];
        GS.push({ x, y, z, vx, vy, vz, mu, R, t0, t: t === null ? Infinity : t });
    }
    clearBlackHoles();
    restoreNebulae(data.neb || []);
    data.bh.forEach(([x, y, vx, vy, rs, kind, period], i) => {
        const raw = data.bhEv && data.bhEv[i];
        const ev = raw && raw.length ? raw.map(row => row.length >= 5
            ? { x: row[0], y: row[1], z: row[2], t: row[3], dmu: row[4] }
            : { x: row[0], y: row[1], z: 0, t: row[2], dmu: row[3] })
            : [{ x, y, z: 0, t: -1e18, dmu: rs * C_LIGHT * C_LIGHT / 2 }]; // v1 saves: field counts as long-established
        addBlackHole(x, y, rs, vx, vy, true, ev, kind ?? 0, period ?? 0);
    });
    if (typeof data.bhSizeIdx === "number") BH.sizeIdx = data.bhSizeIdx;
    hideBanner();
    clearTrail();
    pushTrail(true);
    computePrediction();
    if (G.dead) showBanner("VEHICLE LOST", G.deadReason + " · MET " + fmtMET(G.t), "R TO REBUILD SHIP");
    toast("Quickload · MET " + fmtMET(G.t) + (restoredStars.length ? " · HYG " + restoredStars.length : "") +
        (restoredProc.length ? " · PROC " + restoredProc.length : ""));
    return true;
}
