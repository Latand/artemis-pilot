// A bounded, permanent procedural population. Galaxy/seed/birth-cell/index
// identities never depend on observer, zoom, time bucket or query order.
// This first provider uses a rigid prescribed disk rotation, not self-gravity.
import { K, LY_KM, MU_S, R_SUN } from '../constants.js';
import { PC_KM } from './coords.js';
import { getSeed } from './galaxy.js';
import { hashInts, makeRNG, samplePoisson } from './prng.js';
import { sampleIMFMass, synthStar } from './stellar.js';
import { galaxyById, galaxyLocalPc, galaxyWorldKm } from './galaxyRegistry.js';
import { JOURNAL_LIMITS, journalRevision, journalStarIds, starResidualKm } from './universeJournal.js';

export const FOREIGN_LIMITS = Object.freeze({ cellPc: 8, radiusPc: 12, cellsPerQuery: 125, starsPerCell: 80, starsPerQuery: 420, cachedCells: 256, cachedStars: 2048 });
const cells = new Map(), stars = new Map(), exceptions = new Map();
let exceptionRevision = -1;
const PERIOD = 250e6 * 31557600;
let lastSeed;
function checkSeed() { const seed = getSeed(); if (seed !== lastSeed) { cells.clear(); stars.clear(); exceptions.clear(); exceptionRevision = -1; lastSeed = seed; } return seed; }
function trim(cache, limit) { while (cache.size > limit) cache.delete(cache.keys().next().value); }
function rotation(p, t) { const a = (t % PERIOD) / PERIOD * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]; }
function cellRecords(cx, cy, cz) {
    const seed = checkSeed(), key = `${cx},${cy},${cz}`;
    if (cells.has(key)) { const cached = cells.get(key); cells.delete(key); cells.set(key, cached); return cached; }
    const g = galaxyById('m31'), size = FOREIGN_LIMITS.cellPc;
    const r = Math.hypot((cx + .5) * size, (cy + .5) * size), z = Math.abs((cz + .5) * size);
    const density = r < g.radiusPc ? .08 * Math.exp((10000 - r) / g.scalePc - z / g.heightPc) : 0;
    const rng = makeRNG(hashInts(seed, 0x4d3331, cx, cy, cz));
    const count = Math.min(FOREIGN_LIMITS.starsPerCell, samplePoisson(rng, density * size ** 3));
    const rows = [];
    for (let i = 0; i < count; i++) {
        const local = [(cx + rng()) * size, (cy + rng()) * size, (cz + rng()) * size];
        const physical = synthStar(rng, sampleIMFMass(rng), 1 + rng() * 9);
        // Remnant populations follow in the physics milestone. Preserve all
        // indices so filtering a dark remnant never renumbers another star.
        if (!(physical.L > 0) || physical.kind === 'BH' || physical.kind === 'NS') continue;
        rows.push({ id: `gx:m31:${seed}:${cx}:${cy}:${cz}:${i}`, local, ...physical });
    }
    cells.set(key, rows); trim(cells, FOREIGN_LIMITS.cachedCells); return rows;
}
export function isForeignStarId(id) { return typeof id === 'string' && id.startsWith('gx:m31:'); }
function sourceFor(id) {
    const m = /^gx:m31:(\d+):(-?\d+):(-?\d+):(-?\d+):(\d+)$/.exec(id);
    if (!m || Number(m[1]) !== checkSeed() || m.slice(2, 5).some(x => !Number.isSafeInteger(Number(x)) || Math.abs(Number(x)) > 10000)) return null;
    return cellRecords(+m[2], +m[3], +m[4]).find(s => s.id === id) || null;
}
export function updateForeignStar(star, t) {
    if (!star?.galaxyLocalEpochPc || !Number.isFinite(t)) return star;
    if (star._foreignT === t && star._journalRevision === journalRevision()) return star;
    const local = rotation(star.galaxyLocalEpochPc, t), p = galaxyWorldKm('m31', local, t), delta = starResidualKm(star.id, t);
    star.x = p[0] + delta[0]; star.y = p[1] + delta[1]; star.z = p[2] + delta[2];
    star.galaxyLocalPc = local;
    star.dLy = Math.hypot(star.x, star.y, star.z) / LY_KM;
    star._foreignT = t; star._posSimT = t; star._journalRevision = journalRevision();
    return star;
}
export function foreignStarById(id, t = 0) {
    checkSeed();
    let star = stars.get(id);
    if (!star) {
        const source = sourceFor(id); if (!source) return null;
        const radius = Math.max(.02, source.R) * R_SUN;
        star = { id, name: 'M31-' + id.split(':').slice(3).join('.'), galaxyId: 'm31', galaxyLocalEpochPc: source.local,
            catalog: 'procedural-andromeda', procedural: true, generatedSeed: getSeed(),
            mass: source.mass, mu: MU_S * source.mass, R: radius, radiusSolar: source.R, lumSolar: source.L,
            tempK: source.Teff, color: source.color, cls: source.cls, kind: source.kind,
            flowC: .001 * Math.sqrt(2 * MU_S * source.mass / 1000), flowSink: radius * K };
        stars.set(id, star); trim(stars, FOREIGN_LIMITS.cachedStars);
    }
    stars.delete(id); stars.set(id, star);
    return updateForeignStar(star, t);
}
export function sampleForeignStars(world, t = 0, limit = FOREIGN_LIMITS.starsPerQuery) {
    checkSeed();
    // Edited stars may leave the disk. Materialize at most 64 exceptions once
    // per journal revision, then retain their source records independently of
    // the ordinary LRU. Normal queries never scan 4,096 birth cells.
    if (exceptionRevision !== journalRevision()) {
        exceptions.clear();
        for (const id of journalStarIds()) { const star = foreignStarById(id, t); if (star) exceptions.set(id, star); }
        exceptionRevision = journalRevision();
    }
    const p = galaxyLocalPc('m31', world, t), g = galaxyById('m31'), radius = FOREIGN_LIMITS.radiusPc;
    const inside = Math.hypot(p[0], p[1]) <= g.radiusPc + radius && Math.abs(p[2]) <= 6 * g.heightPc;
    const ids = new Set(), ranked = [];
    if (inside) {
        const birth = rotation(p, -t), size = FOREIGN_LIMITS.cellPc, c = birth.map(v => Math.floor(v / size));
        for (let x = c[0] - 2; x <= c[0] + 2; x++) for (let y = c[1] - 2; y <= c[1] + 2; y++) for (let z = c[2] - 2; z <= c[2] + 2; z++)
            for (const source of cellRecords(x, y, z)) if (Math.hypot(...source.local.map((v, i) => v - birth[i])) <= radius) ids.add(source.id);
    }
    const add = star => {
        const d2 = (star.x - world[0]) ** 2 + (star.y - world[1]) ** 2 + (star.z - world[2]) ** 2;
        if (d2 <= (radius * PC_KM) ** 2) ranked.push({ s: star, d2 });
    };
    for (const star of exceptions.values()) { updateForeignStar(star, t); add(star); ids.delete(star.id); }
    for (const id of ids) { const star = foreignStarById(id, t); if (star) add(star); }
    ranked.sort((a, b) => a.d2 - b.d2 || a.s.id.localeCompare(b.s.id));
    return ranked.slice(0, Math.min(limit, FOREIGN_LIMITS.starsPerQuery)).map(row => row.s);
}
export function foreignProviderStats() { return { cells: cells.size, stars: stars.size, editedStars: exceptions.size, editedStarLimit: JOURNAL_LIMITS.stars, ...FOREIGN_LIMITS }; }
