// Quicksave / quickload: one browser-storage slot holding the full simulation
// state — ship, world flags, the live n-body ephemeris, and every black hole.
import { C_LIGHT } from "./constants.js";
import { G, WORLD, BH, GS } from "./state.js";
import { snapshotEphem, loadEphemSnapshot } from "./ephemeris.js";
import { addBlackHole, clearBlackHoles } from "./blackholes.js";
import { clearTrail, pushTrail, computePrediction } from "./trails.js";
import { hideBanner, showBanner } from "./hud.js";
import { fmtMET } from "./format.js";
import { toast } from "./achievements.js";

const SLOT = "artemis.quicksave.v1";
const G_FIELDS = [
    "t", "cosmicT", "x", "y", "vx", "vy", "heading", "throttle", "warp", "paused",
    "fuel", "infinite", "dvUsed", "hold", "landed", "dead", "deadReason",
    "deathT", "leftHome", "maxRE", "gr", "predict", "darkEnergy", "muted", "focus",
    "cabin",
];

export function saveState() {
    const ephSt = snapshotEphem();
    const data = {
        v: 2,
        g: Object.fromEntries(G_FIELDS.map(k => [k, G[k]])),
        world: {
            earth: WORLD.earthDestroyed, moon: WORLD.moonDestroyed, sun: WORLD.sunDestroyed,
            pl: Array.from(WORLD.plDestroyed),
        },
        eph: {
            x: Array.from(ephSt.x), y: Array.from(ephSt.y),
            vx: Array.from(ephSt.vx), vy: Array.from(ephSt.vy),
            earthX: ephSt.earthX, earthY: ephSt.earthY,
            earthVx: ephSt.earthVx, earthVy: ephSt.earthVy,
        },
        bh: Array.from({ length: BH.n }, (_, i) => [BH.x[i], BH.y[i], BH.vx[i], BH.vy[i], BH.rs[i]]),
        // gravity-front bookkeeping: per-hole mass-gain events, plus the
        // phantom/ghost sources (Infinity survives JSON as null)
        bhEv: Array.from({ length: BH.n }, (_, i) => (BH.ev[i] || []).map(e => [e.x, e.y, e.t, e.dmu])),
        gs: GS.map(s => [s.x, s.y, s.vx, s.vy, s.mu, s.R, s.t0, isFinite(s.t) ? s.t : null]),
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

export function loadState() {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(SLOT)); } catch (e) { /* corrupt slot falls through */ }
    if (!data || (data.v !== 1 && data.v !== 2)) { toast("No saved state · K to save one"); return false; }
    Object.assign(G, data.g);
    if (typeof G.darkEnergy !== "boolean") G.darkEnergy = true;
    if (typeof G.cabin !== "boolean") G.cabin = false;
    if (typeof G.cosmicT !== "number") G.cosmicT = G.t;
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
        t: data.g.t, // gravity fronts measure from the saved clock
    });
    GS.length = 0;
    for (const [x, y, vx, vy, mu, R, t0, t] of data.gs || [])
        GS.push({ x, y, vx, vy, mu, R, t0, t: t === null ? Infinity : t });
    clearBlackHoles();
    data.bh.forEach(([x, y, vx, vy, rs], i) => {
        const raw = data.bhEv && data.bhEv[i];
        const ev = raw && raw.length ? raw.map(([ex, ey, et, dmu]) => ({ x: ex, y: ey, t: et, dmu }))
            : [{ x, y, t: -1e18, dmu: rs * C_LIGHT * C_LIGHT / 2 }]; // v1 saves: field counts as long-established
        addBlackHole(x, y, rs, vx, vy, true, ev);
    });
    if (typeof data.bhSizeIdx === "number") BH.sizeIdx = data.bhSizeIdx;
    hideBanner();
    clearTrail();
    pushTrail(true);
    computePrediction();
    if (G.dead) showBanner("VEHICLE LOST", G.deadReason + " · MET " + fmtMET(G.t), "R TO REBUILD SHIP");
    toast("Quickload · MET " + fmtMET(G.t));
    return true;
}
