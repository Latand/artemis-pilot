// Sparse, replayable edits, independent of LOD caches. This is an extension
// point for interventions, not a galaxy-wide N-body integrator. A velocity
// impulse is a piecewise-linear residual on the prescribed host trajectory.
export const JOURNAL_LIMITS = Object.freeze({ events: 4096, stars: 64 });
let entries = [], revision = 0;
const byStar = new Map();
function validEvent(e) {
    return e?.type === 'star-impulse' && typeof e.starId === 'string' && /^gx:m31:\d+:-?\d+:-?\d+:-?\d+:\d+$/.test(e.starId) &&
        Number.isFinite(e.t) && Array.isArray(e.dvKmS) && e.dvKmS.length === 3 && e.dvKmS.every(Number.isFinite);
}
function index(event) {
    if (!byStar.has(event.starId)) byStar.set(event.starId, []);
    byStar.get(event.starId).push(event);
}
export function journalRevision() { return revision; }
export function recordStarImpulse(starId, t, dvKmS) {
    const event = { sequence: revision + 1, type: 'star-impulse', starId, t, dvKmS: Array.isArray(dvKmS) ? [...dvKmS] : dvKmS };
    if (!validEvent(event)) throw new TypeError('Invalid stellar impulse');
    if (entries.length >= JOURNAL_LIMITS.events || (!byStar.has(starId) && byStar.size >= JOURNAL_LIMITS.stars)) throw new RangeError('Universe intervention journal is full');
    entries.push(event); index(event); revision++;
    return event.sequence;
}
export function starResidualKm(starId, t, out = [0, 0, 0]) {
    out.fill(0);
    for (const event of byStar.get(starId) || []) if (t >= event.t)
        for (let i = 0; i < 3; i++) out[i] += event.dvKmS[i] * (t - event.t);
    return out;
}
export function journalStarIds() { return [...byStar.keys()]; }
export function serializeUniverseJournal() { return { version: 1, events: entries.map(e => ({ ...e, dvKmS: [...e.dvKmS] })) }; }
export function validUniverseJournal(record) {
    if (record == null) return true;
    return record.version === 1 && Array.isArray(record.events) && record.events.length <= JOURNAL_LIMITS.events &&
        record.events.every(validEvent) && new Set(record.events.map(e => e.starId)).size <= JOURNAL_LIMITS.stars;
}
export function restoreUniverseJournal(record) {
    if (!validUniverseJournal(record)) return false;
    entries = (record?.events || []).map((e, i) => ({ ...e, sequence: i + 1, dvKmS: [...e.dvKmS] }));
    byStar.clear(); for (const event of entries) index(event);
    revision++; return true;
}
