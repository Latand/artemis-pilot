import * as THREE from "three";
import { AU_KM, K } from "../constants.js";
import { CURATED_MINOR_BODIES, MINOR_STRIDE } from "../universe/minorBodies.js";
import { worldToResidualArr } from "../universe/renderOrigin.js";

const VERT = /* glsl */`
attribute float size;
attribute float brightness;
varying float vBrightness;
void main() {
    vBrightness = brightness;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * clamp(900.0 / max(1.0, -mvPosition.z), 0.45, 3.5);
    gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAG = /* glsl */`
uniform vec3 uColor;
varying float vBrightness;
void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r2 = dot(uv, uv);
    float g = exp(-r2 * 14.0);
    if (g < 0.006) discard;
    gl_FragColor = vec4(uColor * vBrightness, g * vBrightness);
}
`;

const TAIL_VERT = /* glsl */`
attribute float aSeg;
attribute float aFade;
varying vec3 vColor;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uSegs;
void main() {
    float segT = aSeg / max(1.0, uSegs);
    float cometFade = mix(0.94, 0.08, pow(segT, 0.8));
    vColor = uColor * aFade * cometFade * uOpacity;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const TAIL_FRAG = /* glsl */`
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }
`;

function makePointsMaterial(color) {
    return new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(color) } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    });
}

function makeTailMaterial(color) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uColor: { value: new THREE.Color(color) },
            uOpacity: { value: 1 },
            uSegs: { value: 23 },
        },
        vertexShader: TAIL_VERT,
        fragmentShader: TAIL_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
    });
}

export function createMinorBodyPoints(parent, capacity, { color = 0xcfc8aa, size = 1.8, brightness = 0.55, renderOrder = -2 } = {}) {
    const geometry = new THREE.BufferGeometry();
    const pos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    const sizeAttr = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    const brightAttr = new THREE.BufferAttribute(new Float32Array(capacity), 1);
    for (let i = 0; i < capacity; i++) {
        sizeAttr.array[i] = size;
        brightAttr.array[i] = brightness;
    }
    geometry.setAttribute("position", pos);
    geometry.setAttribute("size", sizeAttr);
    geometry.setAttribute("brightness", brightAttr);
    geometry.setDrawRange(0, 0);
    const mesh = new THREE.Points(geometry, makePointsMaterial(color));
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    if (parent) parent.add(mesh);
    return { mesh, geometry, capacity, worldKm: new Float64Array(capacity * 3), cursor: 0 };
}

export function createMinorBodyRenderers({ scene, farTierGroup, swarms }) {
    return Object.freeze({
        belt: createMinorBodyPoints(scene, swarms.meta.counts.belt, { color: 0xd9c28f, size: 1.55, brightness: 0.42 }),
        kuiper: createMinorBodyPoints(scene, swarms.meta.counts.kuiper, { color: 0x9fc7ff, size: 1.35, brightness: 0.35 }),
        oort: createMinorBodyPoints(farTierGroup || scene, swarms.meta.counts.oort, { color: 0xbad8ff, size: 1.1, brightness: 0.20 }),
        curated: createMinorBodyPoints(scene, CURATED_MINOR_BODIES.length, { color: 0xfff2c0, size: 3.4, brightness: 0.9 }),
    });
}

export function refreshResidualRange(group, startIdx = 0, count = group.capacity) {
    const start = Math.max(0, startIdx | 0);
    const end = Math.min(group.capacity, start + Math.max(0, count | 0));
    const arr = group.geometry.attributes.position.array;
    for (let i = start; i < end; i++) {
        worldToResidualArr(group.worldKm[i * 3], group.worldKm[i * 3 + 1], group.worldKm[i * 3 + 2], arr, i * 3, K);
    }
    const attr = group.geometry.attributes.position;
    attr.addUpdateRange(start * 3, (end - start) * 3);
    attr.needsUpdate = true;
    group.geometry.setDrawRange(0, Math.max(group.geometry.drawRange.count || 0, end));
    return { start, count: end - start };
}

export function updateWorldPositions(group, worldKm, startIdx = 0, count = group.capacity) {
    const start = Math.max(0, startIdx | 0);
    const end = Math.min(group.capacity, start + Math.max(0, count | 0));
    group.worldKm.set(worldKm.subarray(start * 3, end * 3), start * 3);
    return refreshResidualRange(group, start, end - start);
}

function setTailVertex(arr, idx, x, y, z) {
    worldToResidualArr(x, y, z, arr, idx * 3, K);
}

function normalize3(x, y, z) {
    const d = Math.hypot(x, y, z) || 1;
    return [x / d, y / d, z / d];
}

export function createCometTailPair(parent, segments = 24) {
    const makeStrip = color => {
        const geometry = new THREE.BufferGeometry();
        const pos = new THREE.BufferAttribute(new Float32Array(segments * 3), 3);
        pos.setUsage(THREE.DynamicDrawUsage);
        const seg = new THREE.BufferAttribute(new Float32Array(segments), 1);
        const fade = new THREE.BufferAttribute(new Float32Array(segments), 1);
        for (let i = 0; i < segments; i++) {
            seg.array[i] = i;
            fade.array[i] = 1;
        }
        geometry.setAttribute("position", pos);
        geometry.setAttribute("aSeg", seg);
        geometry.setAttribute("aFade", fade);
        const line = new THREE.Line(geometry, makeTailMaterial(color));
        line.frustumCulled = false;
        line.renderOrder = -1;
        line.visible = false;
        if (parent) parent.add(line);
        return line;
    };
    return { ion: makeStrip(0x88bbff), dust: makeStrip(0xffe0a0), segments };
}

export function updateCometTail(pair, bodyWorld, sunWorld, velocity, { maxAu = 0.3, activeAu = 6 } = {}) {
    const rx = bodyWorld.x - sunWorld[0], ry = bodyWorld.y - sunWorld[1], rz = bodyWorld.z - sunWorld[2];
    const rAu = Math.hypot(rx, ry, rz) / AU_KM;
    if (!(rAu > 0) || rAu > activeAu) {
        pair.ion.visible = false;
        pair.dust.visible = false;
        return false;
    }
    const antiSun = normalize3(rx, ry, rz);
    const antiVel = normalize3(-velocity.vx, -velocity.vy, -velocity.vz);
    const strength = Math.min(1, 1 / (rAu * rAu));
    const ionL = maxAu * AU_KM * strength;
    const dustL = ionL * 0.62;
    const write = (line, len, curve) => {
        const arr = line.geometry.attributes.position.array;
        for (let i = 0; i < pair.segments; i++) {
            const t = i / Math.max(1, pair.segments - 1);
            const bend = curve * t * t;
            const dx = antiSun[0] * (1 - bend) + antiVel[0] * bend;
            const dy = antiSun[1] * (1 - bend) + antiVel[1] * bend;
            const dz = antiSun[2] * (1 - bend) + antiVel[2] * bend;
            const nd = normalize3(dx, dy, dz);
            setTailVertex(arr, i, bodyWorld.x + nd[0] * len * t, bodyWorld.y + nd[1] * len * t, bodyWorld.z + nd[2] * len * t);
        }
        line.geometry.attributes.position.addUpdateRange(0, pair.segments * 3);
        line.geometry.attributes.position.needsUpdate = true;
        line.material.uniforms.uOpacity.value = strength;
        line.visible = true;
    };
    write(pair.ion, ionL, 0.03);
    write(pair.dust, dustL, 0.55);
    return true;
}
