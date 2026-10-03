import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildCappedEarthCloudUnitMesh } from './build-earth-cloud-mesh.mjs';
import { reorderCloudTriangles } from './reorder-cloud-triangles.mjs';
import { createEarthCloudGeometry } from '../src/render/earthCloudGeometry.js';
import { CLOUD_UNIT_DATA, CLOUD_DATA_SHA256, CLOUD_VERTEX_COUNT, CLOUD_TRIANGLE_COUNT } from '../src/render/earthCloudGeometryData.js';
import { updateEarthSurfaceExposure, createEarthCloudMaterial } from '../src/render/planetAppearance.js';

const payload = Buffer.from(CLOUD_UNIT_DATA, 'base64');
assert.equal(createHash('sha256').update(payload).digest('hex'), CLOUD_DATA_SHA256);
assert.equal(payload.byteLength, 135740);
assert.equal(CLOUD_VERTEX_COUNT, 4351); assert.equal(CLOUD_TRIANGLE_COUNT, 8120);
const original = buildCappedEarthCloudUnitMesh(), originalIndices = original.indices.slice();
const ordered = reorderCloudTriangles(original.indices, original.positions.length / 3);
assert.deepEqual(original.indices, originalIndices, 'offline reorder never mutates its input');
assert.deepEqual(ordered, reorderCloudTriangles(original.indices, original.positions.length / 3), 'fixed tie-break order is reproducible');
const orientedTriangles = indices => Array.from({ length: indices.length / 3 }, (_, i) => `${indices[i * 3]},${indices[i * 3 + 1]},${indices[i * 3 + 2]}`).sort();
assert.deepEqual(orientedTriangles(ordered), orientedTriangles(original.indices), 'every oriented triangle triple is unchanged');
assert.equal(ordered.byteLength, original.indices.byteLength);
const templateView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
let templateOffset = 0;
for (const values of [original.positions, original.uv]) for (const value of values) {
    assert.equal(templateView.getFloat32(templateOffset, true), value, 'packed position and UV bytes retain the original capped mesh'); templateOffset += 4;
}
for (const value of ordered) { assert.equal(templateView.getUint16(templateOffset, true), value); templateOffset += 2; }
assert.equal(templateOffset, payload.byteLength);
const geometry = createEarthCloudGeometry(6.377, true), other = createEarthCloudGeometry(6.377, true);
assert(geometry.index.array instanceof Uint16Array);
assert.equal(Object.values(geometry.attributes).reduce((n, attribute) => n + attribute.array.byteLength, geometry.index.array.byteLength), 187952);
for (const key of ['position', 'normal', 'uv']) assert.notEqual(geometry.attributes[key].array.buffer, other.attributes[key].array.buffer, 'each geometry owns its attributes');
assert.notEqual(geometry.index.array.buffer, other.index.array.buffer);
other.attributes.position.array[0] = NaN; other.dispose();
assert(Number.isFinite(geometry.attributes.position.array[0]), 'editing/disposal cannot mutate the shared template');
const fresh = createEarthCloudGeometry(6.377, true);
assert.deepEqual(fresh.attributes.position.array, geometry.attributes.position.array, 'template survives a mutated instance'); fresh.dispose();

const positions = geometry.attributes.position, normals = geometry.attributes.normal, uv = geometry.attributes.uv;
const point = new THREE.Vector3(), normal = new THREE.Vector3();
let maxPhaseError = 0, maxLatitudeError = 0;
const periodicDistance = (a, b) => Math.abs((a - b) - Math.round(a - b));
for (let i = 0; i < positions.count; i++) {
    point.fromBufferAttribute(positions, i); normal.fromBufferAttribute(normals, i);
    assert(Math.abs(point.length() - 6.377) < 5e-7, 'every vertex retains physical radius');
    assert(Math.abs(normal.length() - 1) < 1e-7 && normal.clone().cross(point).length() < 1e-6, 'normals stay radial');
    const v = 1 - Math.acos(point.y / point.length()) / Math.PI;
    maxLatitudeError = Math.max(maxLatitudeError, Math.abs(uv.getY(i) - v));
    if (Math.hypot(point.x, point.z) < 1e-7) continue;
    const u = Math.atan2(point.z, -point.x) / (2 * Math.PI);
    // The same periodic longitude offset used by Earth's cloud-shadow shader
    // must remain correct under independent forward/reverse cloud rotations.
    for (const rotation of [-8, -2, -.31, 0, .01, 1, 3.7, 9]) {
        maxPhaseError = Math.max(maxPhaseError, periodicDistance(uv.getX(i) + rotation / (2 * Math.PI), u + rotation / (2 * Math.PI)));
    }
}
assert(maxPhaseError < 1e-7 && maxLatitudeError < 1e-7, 'map/shadow phase and latitude remain aligned');

function edgeAudit(mesh) {
    const p = mesh.attributes.position, t = mesh.attributes.uv, ids = new Map(), welded = [], edges = new Map(), faces = new Set();
    const vertexId = index => {
        const key = `${p.getX(index)},${p.getY(index)},${p.getZ(index)}`;
        if (!ids.has(key)) ids.set(key, ids.size);
        return ids.get(key);
    };
    for (let i = 0; i < p.count; i++) welded.push(vertexId(i));
    const count = mesh.index?.count ?? p.count;
    for (let i = 0; i < count; i += 3) {
        const indices = [0, 1, 2].map(j => mesh.index ? mesh.index.getX(i + j) : i + j);
        const corners = indices.map(j => welded[j]), faceKey = [...corners].sort((a, b) => a - b).join(',');
        assert.equal(new Set(corners).size, 3, 'no collapsed welded face');
        assert(!faces.has(faceKey), 'no duplicate triangle'); faces.add(faceKey);
        const [a, b, c] = indices.map(j => new THREE.Vector3().fromBufferAttribute(p, j));
        assert(b.clone().sub(a).cross(c.clone().sub(a)).dot(a) > 0, 'all faces point outward');
        for (let j = 0; j < 3; j++) {
            const ia = indices[j], ib = indices[(j + 1) % 3], aId = welded[ia], bId = welded[ib];
            const key = aId < bId ? `${aId},${bId}` : `${bId},${aId}`;
            const pole = Math.hypot(p.getX(ia), p.getZ(ia)) < 1e-7 || Math.hypot(p.getX(ib), p.getZ(ib)) < 1e-7;
            const entry = { u: (t.getX(ia) + t.getX(ib)) / 2, v: (t.getY(ia) + t.getY(ib)) / 2, pole };
            if (!edges.has(key)) edges.set(key, []);
            edges.get(key).push(entry);
        }
    }
    let maximumJump = 0, maximumOrdinaryJump = 0;
    for (const adjacent of edges.values()) {
        assert.equal(adjacent.length, 2, 'every welded edge has two adjacent faces');
        const [a, b] = adjacent, jump = periodicDistance(a.u, b.u);
        maximumJump = Math.max(maximumJump, jump);
        if (!a.pole && !b.pole) maximumOrdinaryJump = Math.max(maximumOrdinaryJump, jump);
        assert(Math.abs(a.v - b.v) < 1e-7, 'latitude agrees across every shared edge');
    }
    assert.equal(ids.size - edges.size + faces.size, 2, 'closed sphere Euler characteristic');
    return { maximumJump, maximumOrdinaryJump, weldedVertices: ids.size, edges: edges.size };
}
const audit = edgeAudit(geometry);
assert(audit.maximumJump <= 1 / 192 + 1e-7, 'narrow polar fan is no worse than96-sector SphereGeometry');
assert(audit.maximumOrdinaryJump < 1e-7, 'no new ordinary UV seam or cap/belt crease');

const map = new THREE.Texture(), cloud = createEarthCloudMaterial(map);
map.wrapS = THREE.ClampToEdgeWrapping; map.generateMipmaps = false;
const initialVersion = map.version;
updateEarthSurfaceExposure(null, cloud, 0, 0, 0);
assert.equal(map.wrapS, THREE.RepeatWrapping, 'periodic unwrapped seam also works with mips disabled');
assert.equal(map.version, initialVersion + 1);
for (let i = 0; i < 20; i++) updateEarthSurfaceExposure(null, cloud, 0, 0, 0);
assert.equal(map.version, initialVersion + 1, 'seam setup never repeatedly uploads a map');
cloud.dispose(); map.dispose(); geometry.dispose();
const desktop = createEarthCloudGeometry(6.377, false);
const reference = new THREE.SphereGeometry(6.377, 96, 72);
for (const key of ['position', 'normal', 'uv']) assert.deepEqual(desktop.attributes[key].array, reference.attributes[key].array, 'desktop cloud topology remains exact');
assert.deepEqual(desktop.index.array, reference.index.array); desktop.dispose(); reference.dispose();
const runtimeSource = readFileSync(new URL('../src/render/earthCloudGeometry.js', import.meta.url), 'utf8');
assert(!runtimeSource.includes('ConvexHull') && !runtimeSource.includes('IcosahedronGeometry'), 'runtime imports only packed bounded geometry');
console.log('Packed cloud geometry passed:', JSON.stringify({ payloadBytes: payload.byteLength, geometryBytes: 187952, maxPhaseError, maxLatitudeError, ...audit }));
