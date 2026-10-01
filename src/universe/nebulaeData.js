import { K, MU_S, LY_KM } from "../constants.js";
import { normalizeFormation, gasStateAt } from "./gasFormation.js";

export const NEBULA_RADIUS_PRESETS_LY = [1, 4, 10];
export const NEBULA_RADIUS_PRESETS_KM = NEBULA_RADIUS_PRESETS_LY.map(ly => ly * 9.4607e12);
export const NEBULA_ARCHETYPES = ["EMISSION", "REFLECTION", "PLANETARY"];
export const NEB_MAX = 4;
export const NEBULAE = [];

export function nebulaArchetypeName(index) {
    return NEBULA_ARCHETYPES[Math.max(0, Math.min(NEBULA_ARCHETYPES.length - 1, index | 0))];
}

export function nebulaArchetypeIndex(nameOrIndex) {
    if (Number.isFinite(Number(nameOrIndex))) {
        return Math.max(0, Math.min(NEBULA_ARCHETYPES.length - 1, Number(nameOrIndex) | 0));
    }
    const idx = NEBULA_ARCHETYPES.indexOf(String(nameOrIndex || "").toUpperCase());
    return idx >= 0 ? idx : 0;
}

export function nebulaRadiusKmFromPreset(index) {
    return NEBULA_RADIUS_PRESETS_KM[Math.max(0, Math.min(NEBULA_RADIUS_PRESETS_KM.length - 1, index | 0))];
}

export function nebulaRadiusLy(radiusKm) {
    return radiusKm / 9.4607e12;
}

export function addNebulaRecord(record) {
    if (!record || typeof record !== "object") return -1;
    if (NEBULAE.length >= NEB_MAX) return -1;
    if (![record.xKm, record.yKm, record.zKm, record.radiusKm].every(Number.isFinite) || !(record.radiusKm > 0)) return -1;
    const archetype = nebulaArchetypeIndex(record.archetype);
    const row = {
        xKm: Number(record.xKm) || 0,
        yKm: Number(record.yKm) || 0,
        zKm: Number(record.zKm) || 0,
        radiusKm: Number(record.radiusKm) || NEBULA_RADIUS_PRESETS_KM[1],
        archetype,
        seed: Number(record.seed) >>> 0,
        ...(normalizeFormation(record.formation) ? { formation: normalizeFormation(record.formation) } : {}),
    };
    if (row.formation && NEBULAE.some(n => n.formation && formationId(n) === formationId(row))) return -1;
    NEBULAE.push(row);
    return NEBULAE.length - 1;
}

export function removeNebulaRecord(i) {
    if (i < 0 || i >= NEBULAE.length) return false;
    NEBULAE.splice(i, 1);
    return true;
}

export function clearNebulaRecords() {
    NEBULAE.length = 0;
}

export function serializeNebulae() {
    return NEBULAE.map(n => [n.xKm, n.yKm, n.zKm, n.radiusKm, nebulaArchetypeIndex(n.archetype), n.seed >>> 0, ...(n.formation ? [{ ...n.formation }] : [])]);
}

export function restoreNebulaRecords(rows = []) {
    clearNebulaRecords();
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!Array.isArray(row) || row.length < 6) continue;
        addNebulaRecord({
            xKm: row[0], yKm: row[1], zKm: row[2],
            radiusKm: row[3], archetype: row[4], seed: row[5], formation: row[6],
        });
    }
    return NEBULAE.length;
}

// Stars are views of their source records, never appended to the catalogue.
// Stable identities survive save/load; bounded by the same NEB_MAX slots.
const formedCache = new WeakMap();
function formationId(n) { return "formed:" + [n.seed, n.formation.v, n.formation.bornAtSec, n.formation.massSolar, n.radiusKm, n.xKm, n.yKm, n.zKm].join(":"); }
export function formedStarForNebula(i, simT, includeBoundary = true) {
    const n = NEBULAE[i];
    if (!n?.formation || !gasStateAt(n, simT).born) return null;
    if (!includeBoundary && simT <= n.formation.bornAtSec + gasStateAt(n, simT).durationSec) return null;
    let star = formedCache.get(n);
    if (!star) {
        const s = gasStateAt(n, simT);
        star = {
            id: formationId(n), name: "NEWBORN " + (i + 1), formedStar: true,
            nebulaIndex: i, catalog: "illustrative-formation", estimated: true,
            x: n.xKm, y: n.yKm, z: n.zKm, dLy: Math.hypot(n.xKm, n.yKm, n.zKm) / LY_KM,
            mass: s.totalMassSolar, mu: MU_S * s.totalMassSolar,
            R: s.radiusKm, radiusSolar: s.radiusSolar, lumSolar: s.lumSolar, tempK: s.tempK,
            color: 0xffefdb, kind: "MS", flowC: .001 * Math.sqrt(2 * MU_S * s.totalMassSolar / 1000),
            flowSink: s.radiusKm * K,
        };
        formedCache.set(n, star);
    }
    star.nebulaIndex = i;
    return star;
}
export function formedStarsAt(simT, includeBoundary = true) {
    const stars = [];
    for (let i = 0; i < NEBULAE.length; i++) {
        const star = formedStarForNebula(i, simT, includeBoundary);
        if (star) stars.push(star);
    }
    return stars;
}
export function nextFormationBoundary(t, requested) {
    let next = t + requested, split = false;
    for (const n of NEBULAE) {
        if (!n.formation) continue;
        const birth = n.formation.bornAtSec + gasStateAt(n, t).durationSec;
        // Reverse at the boundary samples just before birth before integrating.
        if (requested > 0 && birth > t && birth < next) { next = birth; split = true; }
        if (requested < 0 && birth < t && birth > next) { next = birth; split = true; }
    }
    // Preserve sub-ULP requested deltas for the compensated simulation clock.
    return split ? next - t : requested;
}
export function clearFormingNebulaRecords() {
    for (let i = NEBULAE.length - 1; i >= 0; i--) if (NEBULAE[i].formation) NEBULAE.splice(i, 1);
}
