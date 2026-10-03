import * as THREE from 'three';
import { CLOUD_UNIT_DATA, CLOUD_VERTEX_COUNT, CLOUD_TRIANGLE_COUNT } from './earthCloudGeometryData.js';

let template;
function unitMesh() {
    if (template) return template;
    const binary = atob(CLOUD_UNIT_DATA), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const view = new DataView(bytes.buffer); let offset = 0;
    const positions = new Float32Array(CLOUD_VERTEX_COUNT * 3), uv = new Float32Array(CLOUD_VERTEX_COUNT * 2), indices = new Uint16Array(CLOUD_TRIANGLE_COUNT * 3);
    for (const array of [positions, uv]) for (let i = 0; i < array.length; i++, offset += 4) array[i] = view.getFloat32(offset, true);
    for (let i = 0; i < indices.length; i++, offset += 2) indices[i] = view.getUint16(offset, true);
    if (offset !== bytes.length) throw new Error('Invalid packed cloud geometry length');
    return template = { positions, uv, indices };
}

// A cloud-only display tessellation. Its vertices retain the physical radius;
// every compact-mesh face encloses the ideal ground sphere with >0.85 km
// clearance at Earth's six-kilometre cloud altitude. Indexing preserves UV
// seam duplicates while reducing vertex work and GPU storage. The bounded
// unit template remains cached on the CPU once.
export function createEarthCloudGeometry(radius, mobile) {
    if (!mobile) return new THREE.SphereGeometry(radius, 96, 72);
    const data = unitMesh(), positions = data.positions.slice();
    for (let i = 0; i < positions.length; i++) positions[i] *= radius;
    const geometry = new THREE.BufferGeometry();
    geometry.name = 'Earth capped geodesic cloud shell';
    geometry.parameters = { radius, detail: 18, capDegrees: 5 };
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.positions.slice(), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uv.slice(), 2));
    geometry.setIndex(new THREE.BufferAttribute(data.indices.slice(), 1));
    return geometry;
}
