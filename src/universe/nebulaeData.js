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
    if (NEBULAE.length >= NEB_MAX) return -1;
    const archetype = nebulaArchetypeIndex(record.archetype);
    const row = {
        xKm: Number(record.xKm) || 0,
        yKm: Number(record.yKm) || 0,
        zKm: Number(record.zKm) || 0,
        radiusKm: Number(record.radiusKm) || NEBULA_RADIUS_PRESETS_KM[1],
        archetype,
        seed: Number(record.seed) >>> 0,
    };
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
    return NEBULAE.map(n => [n.xKm, n.yKm, n.zKm, n.radiusKm, nebulaArchetypeIndex(n.archetype), n.seed >>> 0]);
}

export function restoreNebulaRecords(rows = []) {
    clearNebulaRecords();
    for (const row of rows || []) {
        if (!Array.isArray(row) || row.length < 6) continue;
        addNebulaRecord({
            xKm: row[0], yKm: row[1], zKm: row[2],
            radiusKm: row[3], archetype: row[4], seed: row[5],
        });
    }
    return NEBULAE.length;
}
