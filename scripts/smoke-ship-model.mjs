import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { createShipModel } from '../src/shipModel.js';
const model = createShipModel();
assert.equal(model.name, 'Artemis twin-ring explorer');
assert.equal(model.userData.design, 'speculative-twin-ring');
assert.equal(model.children.length, 7, 'One bounded batch for each material');
const bounds = new THREE.Box3().setFromObject(model);
assert(Math.abs(bounds.min.y + 1.05) < .065, 'Aft extremity stays attached to existing exhaust anchor');
assert(bounds.min.y > -1.06 && bounds.max.y > 1.3 && bounds.max.y < 1.5, 'Nose +Y and tail retain orientation / exhaust offset contract');
assert(Math.abs(bounds.max.x + bounds.min.x) < 1e-6 && Math.abs(bounds.max.z + bounds.min.z) < 1e-6, 'Rings are centered on the hull axis');
assert(bounds.max.x < 1.1 && bounds.max.z < 1.1, 'Ship remains within the existing adaptive-size footprint');
const geometries = new Set(), materials = new Set();
let triangles = 0, bytes = 0;
for (const mesh of model.children) {
 assert(mesh.isMesh && mesh.geometry.index && mesh.geometry.boundingSphere?.radius > 0);
 assert(!Array.isArray(mesh.material), 'No hidden per-group material draw calls');
 assert(mesh.geometry.groups.length === 0, 'Each batch remains one draw call');
 assert.equal(mesh.material.transparent, false, 'Opaque surfaces avoid sorting defects');
 assert.equal(mesh.material.depthWrite, true);
 assert.equal(mesh.material.map, null, 'No texture requests');
 const g = mesh.geometry;
 geometries.add(g); materials.add(mesh.material); triangles += g.index.count / 3;
 bytes += g.index.array.byteLength;
 for (const [key, attr] of Object.entries(g.attributes)) {
  assert([...attr.array].every(Number.isFinite), `${mesh.name} ${key} finite`);
  bytes += attr.array.byteLength;
 }
 for (let i=0;i<g.attributes.normal.count;i++) {
  const n = new THREE.Vector3().fromBufferAttribute(g.attributes.normal,i);
  assert(Math.abs(n.length()-1)<1e-4,`${mesh.name} unit normals`);
 }
}
assert(triangles <= 9000 && bytes <= 300000, 'Fixed mobile geometry budget');
assert.equal(geometries.size,7);assert.equal(materials.size,7);
// The two annuli must have outward-facing outer walls and inward-facing
// inner walls; normals determine whether real application light reveals them.
const hull=model.getObjectByName('ship.ceramic').geometry;
for(const cy of [-.61,.48]) {
 let outward=0,inward=0;
 for(let i=0;i<hull.attributes.position.count;i++) {
  const p=new THREE.Vector3().fromBufferAttribute(hull.attributes.position,i),n=new THREE.Vector3().fromBufferAttribute(hull.attributes.normal,i);
  const r=Math.hypot(p.x,p.z),radial=(p.x*n.x+p.z*n.z)/r;
  if(Math.abs(p.y-cy)<.1&&r>1.05&&radial>.6)outward++;
  if(Math.abs(p.y-cy)<.1&&r<.8&&r>.78&&radial<-.6)inward++;
 }
 assert(outward>60&&inward>60,`Ring ${cy} correctly faces both surfaces`);
}
// A conventional engine aperture must not be buried behind the solid hull.
model.updateMatrixWorld(true);
for (const x of [.01,.05,.10,.13]) {
 const ray = new THREE.Raycaster(new THREE.Vector3(x,-2,0),new THREE.Vector3(0,1,0));
 assert.equal(ray.intersectObject(model,true)[0]?.object.name,'ship.cyan','Aft aperture remains visible through the nozzle');
}
// Visible cyan arcs sit in front of the graphite liner, not inside it.
for (const y of [-.61,.48]) for (const theta of [.02,.05,.1,.2,.25]) {
 const direction = new THREE.Vector3(Math.cos(theta),0,Math.sin(theta));
 const ray = new THREE.Raycaster(direction.clone().multiplyScalar(.4).add(new THREE.Vector3(0,y,0)),direction);
 assert.equal(ray.intersectObject(model,true)[0]?.object.name,'ship.cyan','Inner-ring illumination is exposed');
}
const second=createShipModel();
assert.deepEqual(model.children.map(o=>[o.name,...o.geometry.attributes.position.array]),second.children.map(o=>[o.name,...o.geometry.attributes.position.array]),'Construction is deterministic');
assert(model.children.every((o,i)=>o.geometry!==second.children[i].geometry&&o.material!==second.children[i].material),'Separate models own their disposable resources');
let disposed=0;
for(const m of [model,second])m.traverse(o=>{if(!o.isMesh)return; o.geometry.addEventListener('dispose',()=>disposed++);o.material.addEventListener('dispose',()=>disposed++);o.geometry.dispose();o.material.dispose();});
assert.equal(disposed,28);
const source=readFileSync(new URL('../src/ship.js',import.meta.url),'utf8');
assert(source.includes('export const craft = createShipModel();'));
console.log('Twin-ring ship model PASS',JSON.stringify({drawCalls:7,triangles,geometryBytes:bytes,bounds:bounds.toArray?.()||{min:bounds.min.toArray(),max:bounds.max.toArray()}}));
