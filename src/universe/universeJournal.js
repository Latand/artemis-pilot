// Sparse, replayable edits, independent of LOD caches. This is an extension
// point for interventions, not a galaxy-wide N-body integrator. A velocity
// impulse is a piecewise-linear residual on the prescribed host trajectory.
const MAX_EVENTS = 4096;
let entries = [], revision = 0;
export function journalRevision() { return revision; }
export function recordStarImpulse(starId, t, dvKmS) {
    if (typeof starId !== 'string' || !starId.startsWith('gx:m31:') || !Number.isFinite(t) ||
        !Array.isArray(dvKmS) || dvKmS.length !== 3 || !dvKmS.every(Number.isFinite)) throw new TypeError('Invalid stellar impulse');
    if (entries.length >= MAX_EVENTS) throw new RangeError('Universe intervention journal is full');
    const event = { sequence: revision + 1, type: 'star-impulse', starId, t, dvKmS: [...dvKmS] };
    entries.push(event); revision++;
    return event.sequence;
}
export function starResidualKm(starId, t, out = [0, 0, 0]) {
    out.fill(0);
    for (const event of entries) if (event.starId === starId && t >= event.t)
        for (let i = 0; i < 3; i++) out[i] += event.dvKmS[i] * (t - event.t);
    return out;
}
export function journalStarIds() { return [...new Set(entries.map(e => e.starId))]; }
export function serializeUniverseJournal() { return { version: 1, events: entries.map(e => ({ ...e, dvKmS: [...e.dvKmS] })) }; }
export function restoreUniverseJournal(record) {
    if (record == null) { entries = []; revision++; return true; }
    if (record.version !== 1 || !Array.isArray(record.events) || record.events.length > MAX_EVENTS) return false;
    const valid = record.events.every(e => e.type === 'star-impulse' && typeof e.starId === 'string' && e.starId.startsWith('gx:m31:') &&
        Number.isFinite(e.t) && Array.isArray(e.dvKmS) && e.dvKmS.length === 3 && e.dvKmS.every(Number.isFinite));
    if (!valid) return false;
    entries = record.events.map((e, i) => ({ ...e, sequence: i + 1, dvKmS: [...e.dvKmS] }));
    revision++; return true;
}

export function validUniverseJournal(record) {
    if (record == null) return true;
    return record.version === 1 && Array.isArray(record.events) && record.events.length <= MAX_EVENTS && record.events.every(e =>
        e.type === "star-impulse" && typeof e.starId === "string" && e.starId.startsWith("gx:m31:") && Number.isFinite(e.t) &&
        Array.isArray(e.dvKmS) && e.dvKmS.length === 3 && e.dvKmS.every(Number.isFinite));
}
