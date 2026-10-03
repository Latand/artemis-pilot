// Exercise the production point-pool block with real Three buffers and the
// actual HYG/active neighbourhood. Only the surrounding WebGL/DOM boot is
// omitted; membership, attributes and background-row ownership run unchanged.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { linearStarColor } from '../src/render/stellarAppearance.js';
import { teffToRGB, absMagVFromL } from '../src/render/viewBrightness.js';
import { inspectExploredHostPoint } from './explored-point-ownership.mjs';
globalThis.window = {};
const { K, PC_KM } = await import('../src/constants.js');
const A = await import('../src/universe/activeStars.js');
const H = await import('../src/universe/hygActiveCatalog.js');
const E = await import('../src/universe/exploredSystem.js');
const P = await import('../src/universe/planetarySystem.js');
const meta = JSON.parse(readFileSync(new URL('../public/data/hyg-stars-v41.json', import.meta.url)));
const bin = readFileSync(new URL('../public/data/hyg-stars-v41.bin', import.meta.url));
H.registerHygCatalog(meta, new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4));
const source = readFileSync(new URL('../src/stars.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('const activeProc ='), source.indexOf('// A black hole\'s own light'));
assert(block.includes('export function syncActiveProceduralPoints()'));
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), heldRows = new Set();
const dependencies = {
    THREE, K, ACTIVE_STARS: A.ACTIVE_STARS,
    activeStarsTime: A.activeStarsTime, activeStarSetRevision: A.activeStarSetRevision,
    activeForeignStarsStamp: A.activeForeignStarsStamp,
    getExploredHost: E.getExploredHost, scene, camera,
    holdCatalogRow: (row, held) => held ? heldRows.add(row) : heldRows.delete(row),
    makeStarPointMaterial: () => new THREE.PointsMaterial(), linearStarColor, teffToRGB,
    activeAbsMagV: (s, teff) => Number.isFinite(s.absMag) ? s.absMag : s.lumSolar > 0 ? absMagVFromL(s.lumSolar, teff || 5800) : NaN,
};
const pool = new Function(...Object.keys(dependencies), `
 let activePointMaterial = null; const _ptColor = new THREE.Color(), starRGB = [1,1,1];
 ${block.replace('export function', 'function')}
 return { sync: syncActiveProceduralPoints, mesh: () => activeProc.mesh };
`)(...Object.values(dependencies));
const id = s => s.id || s.name;
const legacyKey = () => [A.activeStarsTime(), A.ACTIVE_STARS.length, id(A.ACTIVE_STARS[0]), id(A.ACTIVE_STARS.at(-1))].join(':');
const pointStars = () => {
    const stars = [...A.ACTIVE_STARS], host = E.getExploredHost();
    if (host?.activeCatalog && !stars.some(s => s.id === host.id)) stars.push(host);
    return stars.filter(s => (s.procedural || s.activeCatalog) && !s.bh);
};
function checkPool() {
    const stars = pointStars(), mesh = pool.mesh(), attributes = mesh.geometry.attributes;
    assert.equal(mesh.geometry.drawRange.count, stars.length);
    assert.deepEqual(heldRows, new Set(stars.filter(s => s.activeCatalog).map(s => s.hygIndex)), 'Exactly the current HYG rows yield their background point');
    const color = new THREE.Color();
    stars.forEach((s, i) => {
        const teff = s.tempK || 5800, mag = dependencies.activeAbsMagV(s, teff);
        assert.deepEqual(Array.from(attributes.position.array.slice(i * 3, i * 3 + 3)), [s.x * K, (s.z || 0) * K, -s.y * K].map(Math.fround), 'Position slot belongs to its current star');
        assert.equal(attributes.absMag.array[i], Math.fround(Number.isFinite(mag) ? mag : 99));
        assert.equal(attributes.teffK.array[i], Math.fround(teff));
        assert.equal(attributes.radiusKm.array[i], Math.fround(s.R || 0));
        linearStarColor(teffToRGB(teff, [1,1,1]), color);
        assert.deepEqual(Array.from(attributes.color.array.slice(i * 3, i * 3 + 3)), [color.r, color.g, color.b].map(Math.fround), 'Photometry follows the same current identity as position');
    });
}
A.refreshActiveStars(8 * PC_KM, 0, 0, -1, 0);
pool.sync(); checkPool();
const beforeKey = legacyKey(), beforeIds = A.ACTIVE_STARS.map(id), beforeRevision = A.activeStarSetRevision();
const beforeRows = new Set(heldRows), beforeVersion = pool.mesh().geometry.attributes.absMag.version;
A.refreshActiveStars(8.1 * PC_KM, 0, 0, -1, 0);
assert.equal(legacyKey(), beforeKey, 'Fixture replaces middle members at identical time/count/first/last');
assert.notDeepEqual(A.ACTIVE_STARS.map(id), beforeIds);
assert(A.activeStarSetRevision() > beforeRevision);
pool.sync(); checkPool();
assert(pool.mesh().geometry.attributes.absMag.version > beforeVersion, 'Structural revision invalidates photometry even with a stationary camera');
assert([...beforeRows].some(row => !heldRows.has(row)), 'Dropped HYG rows return to the background');
assert([...heldRows].some(row => !beforeRows.has(row)), 'New HYG rows relinquish their duplicate background point');
console.log('Active point ownership: same-count middle replacement refreshes positions, photometry and HYG suppression');

// The actual retained HYG host is absent from the Earth-centred active set,
// but its single pooled point survives child selection, return and restore.
const system = E.getExploredSystem('hyg:87', null, 0), child = P.planetFocusValue(0, system);
const saved = JSON.parse(JSON.stringify(E.serializeExploredSystem()));
for (const route of ['retained', 'returned', 'restored']) {
    if (route === 'returned') { E.getExploredSystem('star:0', null, 0); E.getExploredSystem(child, null, 0); }
    if (route === 'restored') { E.getExploredSystem('star:0', null, 0); E.restoreExploredSystem(saved, child, 0); }
    A.refreshActiveStars(0, 0, 0, child, 0); pool.sync(); checkPool();
    const host = E.getExploredHost();
    assert.equal(host.hygIndex, 87); assert(!A.ACTIVE_STARS.some(s => s.hygIndex === 87));
    const ownership = inspectExploredHostPoint({ scene, camera, host, group: null, activeStars: A.ACTIVE_STARS, K,
        catalog: { loaded: true, held: heldRows.has(87), hidden: heldRows.has(87) ? 1 : 0 } });
    assert(ownership.pass, route + ': actual production pool owns exactly one retained HYG point');
    console.log(route + ': HYG87 pooled slot ' + ownership.expectedHostSlot + '/' + ownership.pooled.count + ', background held=' + heldRows.has(87));
}

// The shared pool must also republish foreign rows between catalog buckets,
// including an intervention restored while the coordinate clock is paused.
const { galaxyWorldKm } = await import('../src/universe/galaxyRegistry.js');
const { syncGalacticFrame } = await import('../src/universe/galacticClock.js');
const J = await import('../src/universe/universeJournal.js');
E.restoreExploredSystem(null,'free');
const world=galaxyWorldKm('m31',[10000,0,0],0);
A.refreshActiveStars(...world,'free',0);
const foreign=A.ACTIVE_STARS.find(s=>s.galaxyId);
assert(foreign);camera.position.set(foreign.x*K,foreign.z*K,-foreign.y*K);
pool.sync();const slot=pointStars().indexOf(foreign);
const position=()=>Array.from(pool.mesh().geometry.attributes.position.array.slice(slot*3,slot*3+3));
const epochPosition=position();
syncGalacticFrame(1e8);pool.sync();const movedPosition=position();
assert.notDeepEqual(movedPosition,epochPosition,'Stationary observer receives exact foreign time publication');
J.recordStarImpulse(foreign.id,0,[1000,0,0]);syncGalacticFrame(1e8);pool.sync();
assert.notDeepEqual(position(),movedPosition,'Same-clock intervention invalidates the actual point pool');
J.restoreUniverseJournal(null);syncGalacticFrame(1e8);pool.sync();
assert.deepEqual(position(),movedPosition,'Same-clock restore republishes the original point location');
console.log('Foreign point ownership: exact time and same-clock journal restoration invalidate the real shared pool');
