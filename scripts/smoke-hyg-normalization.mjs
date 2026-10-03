import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = {};
const N = await import('../src/universe/hygNormalization.js');
const H = await import('../src/universe/hygActiveCatalog.js');
const C = await import('../src/constants.js');
const search = await import('../src/catalogSearch.js');
const { bodyFactRows } = await import('../src/universe/bodyFacts.js');
const metaRaw=JSON.parse(readFileSync(new URL('../public/data/hyg-stars-v41.json',import.meta.url),'utf8'));
const bin=readFileSync(new URL('../public/data/hyg-stars-v41.bin',import.meta.url));
const raw=new Float32Array(bin.buffer,bin.byteOffset,bin.byteLength/4);
const stride=metaRaw.stride;
const sentinel=63464,measured=32262;
assert(Math.hypot(...raw.slice(sentinel*stride,sentinel*stride+3))>99990);
const values=Float32Array.from([...raw.slice(measured*stride,(measured+1)*stride),...raw.slice(sentinel*stride,(sentinel+1)*stride)]);
const makeMeta=()=>({...structuredClone(metaRaw),count:2,binary:'normalization-fixture.bin',labels:[measured,sentinel].map((index,i)=>{const row=metaRaw.labels.find(r=>r[0]===index)||[index,'FIXTURE '+index,'','','',''];return [i,...row.slice(1)];})});
const original=Array.from(values);
let workerValues;
const originalFetch=globalThis.fetch;
globalThis.fetch=async url=>String(url).endsWith('.bin')?{ok:true,arrayBuffer:async()=>{const b=values.buffer.slice(0);workerValues=new Float32Array(b);return b;}}:{ok:true,json:async()=>makeMeta()};
// Execute the actual loader path from a fresh module instance.
const loader=await import('../src/universe/catalogData.js?normalization-fixture');
const loaded=await loader.loadHygCatalogData();
assert.equal(loaded.meta.placeholderDistancesRepaired,1);
assert.equal(N.isPhotometricCatalogRow(loaded.meta,0),false);
assert.equal(N.isPhotometricCatalogRow(loaded.meta,1),true);
assert(Math.hypot(...loaded.vals.slice(stride,stride+3))>=499.99);
assert(Math.hypot(...loaded.vals.slice(stride,stride+3))<99990);
const once=Array.from(loaded.vals);N.normalizeHygCatalog(loaded.meta,loaded.vals);assert.deepEqual(Array.from(loaded.vals),once,'Repeated normalization is bit-identical');
// Direct registration starts with the same untouched raw fixture.
const directMeta=makeMeta(),directValues=Float32Array.from(original);
H.registerHygCatalog(directMeta,directValues);
assert.deepEqual(Array.from(directValues),once,'Direct registration agrees with normal loader');
const active=H.hygStarByIndex(1);assert(active&&active.distanceEstimated);
const promoted=search.starFromCatalogRecord(directMeta,directValues,1,directMeta.labels[1]);
assert(promoted.distanceEstimated);assert.deepEqual([promoted.x,promoted.y,promoted.z],active.epochPosition);
assert(bodyFactRows({star:active}).some(r=>r.value.includes('photometric estimate')),'Displayed distance is explicitly an estimate');
C.addRuntimeStar(promoted);const stored=search.serializePromotedCatalogStars();assert.equal(stored.at(-1).distanceEstimated,true);C.STARS.pop();
search.restorePromotedCatalogStars(stored);assert.equal(C.STARS.at(-1).distanceEstimated,true,'Save restoration retains estimate provenance');C.STARS.pop();
// Execute the actual worker handler with a stubbed fetch, without a browser.
let message;
globalThis.self={location:{href:'https://unit.invalid/'},postMessage:msg=>{message=msg;}};
await import('../src/universe/hygIndexWorker.js?normalization-fixture');
await self.onmessage({data:{url:'https://unit.invalid/fixture.json'}});
assert(message?.ok,JSON.stringify(message));
assert.deepEqual(Array.from(workerValues),once,'Worker applies the same frame and distance repair');
const coords=new Int32Array(message.coords),offsets=new Uint32Array(message.offsets),indices=new Int32Array(message.indices);
for(let cell=0;cell<message.cells;cell++)for(let j=offsets[cell];j<offsets[cell+1];j++){
 const i=indices[j];assert.deepEqual(Array.from(coords.slice(cell*3,cell*3+3)),Array.from(loaded.vals.slice(i*stride,i*stride+3),x=>Math.floor(x/8)),'Worker cell contains current normalized position');
}
assert.equal(indices.length,2,'Both measured and estimated fixture rows stay queryable');
globalThis.fetch=originalFetch;
console.log('hyg-normalization: raw loader/direct/worker parity, idempotence, query cells, explicit estimates and save provenance passed');
