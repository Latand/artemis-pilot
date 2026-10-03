import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
globalThis.window = {};
const C = await import('../src/constants.js');
const M = await import('../src/universe/catalogMotion.js');
const F = await import('../src/universe/galacticClock.js');
const A = await import('../src/universe/activeStars.js');
const H = await import('../src/universe/hygActiveCatalog.js');
const P = await import('../src/universe/planetarySystem.js');
const E = await import('../src/universe/exploredSystem.js');
const R = await import('../src/render/catalogStars.js');
const { Group } = await import('three');
const { STARS, PC_KM, SEC_YEAR, K } = C;
const MYR = SEC_YEAR * 1e6;
const xyz = s => [s.x, s.y, s.z];
const dist = (a,b) => Math.hypot(...a.map((x,i)=>x-b[i]));
const epoch = STARS.map(xyz), ids = STARS.map(P.stableStarKey);
const magnitudes = STARS.map(R.curatedAbsMagV);
// Controlled catalog loading: build the real named buffer without fetching in Node.
globalThis.requestIdleCallback = () => 0;
const parent = new Group(); R.initCatalogStars(parent);
const star = STARS[0];
const sys = E.getExploredSystem('star:0'), child = P.planetFocusValue(0, sys);
const systemAtBirth = JSON.stringify(sys.planets);
const saved = E.serializeExploredSystem();
const history = new Map();
for (const years of [0, 1e6, 10e6, 541101036, 1e9, -1e6, -541101036, 1e6, 0]) {
    const t = years * SEC_YEAR;
    F.syncGalacticFrame(t); A.refreshActiveStars(star.x,star.y,star.z,'star:0',t,2*MYR); R.updateCatalogStars();
    const snapshot = STARS.map(xyz);
    if (history.has(years)) assert.deepEqual(snapshot, history.get(years), 'Seek/reverse is path independent');
    history.set(years, snapshot);
    assert.deepEqual(STARS.map(P.stableStarKey), ids, 'Motion never changes star/system identity');
    assert.equal(JSON.stringify(E.getExploredSystem(child, null, t).planets), systemAtBirth, 'Time never regenerates selected planets');
    assert.strictEqual(E.getExploredHost(), star);
    assert(A.GRAVITY_STARS.includes(star), 'Focused gravity source is the same moving object');
    const planet = P.planetWorldState(sys, 0, star, t, {}), offset = P.planetOffsetKm(sys.planets[0], sys.hostMass || star.mass, t, {});
    assert(dist(xyz(planet), xyz(offset).map((v,i)=>v+xyz(star)[i])) < 1, 'Planet offsets ride the canonical host');
    const mesh = parent.children.find(x => x.name === 'curated destinations');
    const index = STARS.filter(x => !x.bh).indexOf(star), pos = mesh.geometry.attributes.position.array;
    const actual = [pos[index*3]/K,-pos[index*3+2]/K,pos[index*3+1]/K];
    assert(dist(actual,xyz(star)) < Math.max(1,Math.hypot(...xyz(star))*1e-7), 'GPU named point buffer follows the source');
    for (let i=0;i<STARS.length;i++) assert(Object.is(magnitudes[i],R.curatedAbsMagV(STARS[i])), 'Motion does not change intrinsic luminosity');
    for (const comp of STARS.filter(s=>s.companion)) {
        const host=STARS.find(s=>s.name===comp.companion);
        assert(dist(xyz(comp),xyz(host)) < 1, 'Known unresolved companions share a moving host');
    }
}
assert.deepEqual(STARS.map(xyz),epoch,'Epoch state restored bit for bit');
for (const i of [0,1,4,6,12,18,25]) assert(dist(epoch[i],history.get(1e6)[i])>PC_KM,'Named stars move by pc over Myr');
assert.equal(E.restoreExploredSystem(saved,child),child,'Saved child identity still resolves');
const meta=JSON.parse(readFileSync(new URL('../public/data/hyg-stars-v41.json',import.meta.url),'utf8'));
const bin=readFileSync(new URL('../public/data/hyg-stars-v41.bin',import.meta.url));
H.registerHygCatalog(meta,new Float32Array(bin.buffer,bin.byteOffset,bin.byteLength/4));
const { starFromCatalogRecord, serializePromotedCatalogStars, restorePromotedCatalogStars }=await import('../src/catalogSearch.js');
const index=117953,row=meta.labels.find(r=>r[0]===index),vals=new Float32Array(bin.buffer,bin.byteOffset,bin.byteLength/4);
const promoted=starFromCatalogRecord(meta,vals,index,row); C.addRuntimeStar(promoted);
for(const t of [0,MYR,541101036*SEC_YEAR,-MYR]) {
    F.syncGalacticFrame(t);const direct=H.hygStarByIndex(index,M.catalogEvalTime(t));
    assert(dist(xyz(promoted),xyz(direct)) < Math.max(1,Math.hypot(...xyz(direct))*2e-10),'Promotion uses same epoch/identity orbit as active HYG');
}
const serialized=JSON.parse(JSON.stringify(serializePromotedCatalogStars()));
const savedEpoch=promoted.epochPosition; STARS.pop();
restorePromotedCatalogStars(serialized);const loaded=STARS.at(-1);
assert.deepEqual(loaded.epochPosition,savedEpoch,'Save retains immutable epoch instead of treating future position as birth');
F.syncGalacticFrame(MYR); const canonical=H.hygStarByIndex(index,M.catalogEvalTime(MYR));
assert(dist(xyz(loaded),xyz(canonical)) < PC_KM*1e-8);
const m=M.catalogMotionFor(loaded), independent=M.createCatalogMotion(...savedEpoch,{...loaded,name:'RENAMED'});
assert.deepEqual(M.catalogPositionAt(m,MYR),M.catalogPositionAt(independent,MYR),'Catalog identifiers, not labels, seed known motions');
const begin=performance.now(); for(let i=0;i<1000;i++) F.syncGalacticFrame(i*MYR);
const perFrame=(performance.now()-begin)/1000;
assert(perFrame<2,'Curated updates must stay bounded under 2ms/epoch');
console.log(`catalog-motion: reversible named/source/point/system state, epoch save/promotion parity and intrinsic brightness passed; ${perFrame.toFixed(3)} ms/curated epoch`);
