import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
globalThis.window = {};
const { STARS } = await import('../src/constants.js');
const { G } = await import('../src/state.js');
const { setSeed, getSeed, localStarsInCell } = await import('../src/universe/galaxy.js');
const { getFocusedSystem, getCachedFocusedSystem, refreshActiveStars, nearestActiveStar, pinProceduralStarById, proceduralFocusValue } = await import('../src/universe/activeStars.js');
const P = await import('../src/universe/planetarySystem.js');
const E = await import('../src/universe/exploredSystem.js');
const { getBodyAppearance } = await import('../src/render/bodyAppearanceProfiles.js');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parameters = system => digest({ starId: system.starId, planets: system.planets });
const appearance = sys => sys.planets.map((p, i) => {
    const id = sys.starId + ':' + (p.name || 'planet:' + i);
    return [getBodyAppearance(p, id).seed, ...p.moons.map((m, j) => getBodyAppearance(m, id + ':' + (m.name || 'moon:' + j)).seed)];
});
setSeed(0x9e3779b9);
refreshActiveStars(0, 0, 0, 'earth', 0);
const nearest = nearestActiveStar(0, 0, 0).star;
const hosts = STARS.map((star, i) => ({ star, i, sys: P.generateSystem(star) })).filter(h => h.star !== nearest && h.sys.planets.some(p => p.moons?.length));
assert(hosts.length >= 2);
const initialShip = JSON.stringify(G);
for (const { star, i } of hosts) {
    const focus = 'star:' + i;
    const sys = E.getExploredSystem(focus, nearest, 12345), pi = sys.planets.findIndex(p => p.moons?.length);
    const child = P.planetFocusValue(pi, sys), moon = P.planetMoonFocusValue(pi, 0, sys);
    const snapshot = parameters(sys), surface = appearance(sys);
    for (let route = 0; route < 20; route++) {
        for (const target of [focus, child, moon, 'free', 'ship', moon, child, focus]) {
            const actual = E.getExploredSystem(target, nearest, 12345);
            assert.strictEqual(actual, sys, 'Repeated routes reuse the same one cached system');
            assert.equal(actual.hostStar, star, 'Ship-nearest star must never steal a selected host');
            assert.equal(parameters(actual), snapshot);
            assert.deepEqual(appearance(actual), surface);
        }
    }
    assert.equal(E.qualifySystemFocus('planet:' + pi), child);
    assert.equal(E.qualifySystemFocus('planet:' + pi + ':moon:0'), moon);
    const record = JSON.parse(JSON.stringify(E.serializeExploredSystem()));
    E.getExploredSystem('star:' + (i === 0 ? 1 : 0), nearest);
    assert.equal(E.getSystemForTarget(child), null, 'A stale flight target never aliases a new system slot');
    assert.equal(E.restoreExploredSystem(record, moon), moon);
    assert.equal(parameters(E.getExploredSystem(moon, nearest, 12345)), snapshot);
    assert.deepEqual(appearance(E.getSystemForTarget(moon)), surface);
    // Stable key, not the saved array index, owns restored identity.
    const other = i === 0 ? 1 : 0;
    [STARS[i], STARS[other]] = [STARS[other], STARS[i]];
    try { assert.equal(E.restoreExploredSystem(record, moon), moon); assert.equal(E.getSystemForTarget(moon).hostStar, star); }
    finally { [STARS[i], STARS[other]] = [STARS[other], STARS[i]]; }
}
assert.equal(JSON.stringify(G), initialShip, 'Exploration does not write ship, clock or pause state');
E.restoreExploredSystem(null, 'earth');
for (const invalid of ['planet:0', 'planet:0:moon:0', 'planet:8', 'planet:-1', 'planet:0:moon:6', 'system:%:planet:0', 'system:unknown:planet:0']) {
    assert.equal(E.restoreExploredSystem(null, invalid), 'earth', 'Ambiguous or invalid saved child uses explicit safe home fallback: ' + invalid);
}
assert.equal(E.getExploredSystem('planet:0', nearest), null, 'Legacy child cannot attach itself to ship proximity');
const escaped = P.planetMoonFocusValue(7, 5, 'cat:A/B:% bright star');
assert.deepEqual(P.parseSystemFocus(escaped), { starId: 'cat:A/B:% bright star', planetIndex: 7, moonIndex: 5 });
assert.equal(P.planetFocusIndex(escaped), -1);
const first = hosts[0];
const oldSys = E.getExploredSystem('star:' + first.i), oldSnapshot = parameters(oldSys);
setSeed(123456);
const newSys = E.getExploredSystem('star:' + first.i);
assert.notStrictEqual(newSys, oldSys, 'Changing the universe seed invalidates same-host generation');
assert.notEqual(parameters(newSys), oldSnapshot);
setSeed(0x9e3779b9);
assert.equal(parameters(E.getExploredSystem('star:' + first.i)), oldSnapshot);

// Procedural identity survives clearing the exploration context and restoring
// a saved descriptor. No physical movement toward this star is needed.
const proc = localStarsInCell(0, 0, 0).map(s => pinProceduralStarById(s.id)).find(s => s && P.generateSystem(s).planets.length);
assert(proc);
const procSys = E.getExploredSystem(proceduralFocusValue(proc), nearest), procChild = P.planetFocusValue(0, procSys);
const procRecord = E.serializeExploredSystem(), procSnapshot = parameters(procSys);
E.restoreExploredSystem(null, 'ship');
assert.equal(E.restoreExploredSystem(procRecord, procChild), procChild);
assert.equal(parameters(E.getSystemForTarget(procChild)), procSnapshot);
assert.equal(E.getExploredSystem('free', nearest).starId, procSys.starId);
assert.equal(getCachedFocusedSystem().starId, procSys.starId);
console.log(`smoke-explored-systems passed: ${hosts.length * 20} non-nearest-host routes; stable parameters/surfaces, save identity, seed invalidation, safe legacy fallback`);

// Real missing-HIP records formerly collapsed to the empty cat: key. Validate
// both identity uniqueness and standalone HYG children after another visit.
const staticKeys = STARS.map(P.stableStarKey);
assert.equal(new Set(staticKeys).size, staticKeys.length, 'Every current curated host has a unique system key');
assert.notEqual(P.stableStarKey({ hip: '', hygIndex: 88 }), P.stableStarKey({ hip: 88 }), 'HIP and HYG namespaces cannot collide');
const { readFileSync } = await import('node:fs');
const H = await import('../src/universe/hygActiveCatalog.js');
const meta = JSON.parse(readFileSync(new URL('../public/data/hyg-stars-v41.json', import.meta.url), 'utf8'));
const binary = readFileSync(new URL('../public/data/hyg-stars-v41.bin', import.meta.url));
H.registerHygCatalog(meta, new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / 4));
for (const index of [87, 117953]) {
    const star = H.hygStarByIndex(index), sys = E.getExploredSystem('hyg:' + index);
    assert(star && sys.planets.length);
    const child = P.planetFocusValue(0, sys), snapshot = parameters(sys);
    E.getExploredSystem('star:0');
    const revisited = E.getExploredSystem(child);
    assert(revisited, 'A HYG child contains a resolvable catalog locator');
    assert.equal(revisited.hostStar.hygIndex, index);
    assert.equal(parameters(revisited), snapshot);
    E.restoreExploredSystem(null, 'ship');
    assert.equal(E.restoreExploredSystem(null, child), child);
    assert.equal(E.getSystemForTarget(child).hostStar.hygIndex, index);
}
console.log('Missing-HIP collision and standalone HYG child regressions passed');

const recordBeforeSeedChange = E.serializeExploredSystem();
const selectedBeforeSeedChange = P.planetFocusValue(0, getCachedFocusedSystem());
setSeed(123456);
assert.equal(E.restoreExploredSystem(recordBeforeSeedChange, selectedBeforeSeedChange), 'earth', 'Camera restore cannot reinterpret a saved child in another universe seed');
setSeed(0x9e3779b9);

// Physics keeps one independent CPU-only local system while the single
// rendered/explored system stays remote. Test actual production orbit/landing.
const { eph, updEphem } = await import('../src/ephemeris.js');
const { orbitInfo, snapLanded } = await import('../src/physics.js');
const { getPhysicalSystem, getCachedPhysicalSystem } = await import('../src/universe/activeStars.js');
G.t = 0; G.dead = false; G.landed = null; updEphem();
const proxima = STARS[0], physical = getPhysicalSystem(proxima), localPlanet = physical.planets[0];
assert(localPlanet);
const pos = P.planetWorldState(physical, 0, proxima, 0, {});
Object.assign(G, { x: pos.x + localPlanet.radiusKm * 1.01 - eph.earthX, y: pos.y - eph.earthY, z: pos.z,
    vx: pos.vx - eph.earthVx, vy: pos.vy - eph.earthVy, vz: pos.vz, focus: 'ship' });
refreshActiveStars(eph.earthX + G.x, eph.earthY + G.y, G.z, G.focus, G.t);
assert(orbitInfo().domSysPlanet, 'Ship starts near its local Proxima planet');
const remote = E.getExploredSystem('star:1');
E.getExploredSystem('ship', proxima);
const localOrbit = orbitInfo();
assert(localOrbit.domSysPlanet && localOrbit.sysStarId === physical.starId, 'Pilot return preserves local planet physics while another host is explored');
assert.strictEqual(getCachedFocusedSystem(), remote, 'Physics never replaces rendered selection');
assert.strictEqual(getCachedPhysicalSystem(), physical);
G.landed = { body: 'sysplanet', starId: physical.starId, i: 0, ang: 0, uz: 0 };
snapLanded();
assert(G.landed && G.landed.starId === physical.starId, 'Remote exploration never drops local planetary landing');
assert(Math.abs(G.x + eph.earthX - pos.x - localPlanet.radiusKm - .01) < .01);
assert.strictEqual(getCachedFocusedSystem(), remote);
console.log('Seed-mismatch camera restore and independent local orbit/landing regressions passed');
