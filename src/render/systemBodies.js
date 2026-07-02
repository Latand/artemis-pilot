import * as THREE from "three";
import { K } from "../constants.js";
import { planetTextureProc, ringTextureProc } from "../textures.js";
import { moonOffsetKm, planetMoonFocusIndex, planetOffsetKm } from "../universe/planetarySystem.js";
import { worldToResidual } from "../universe/renderOrigin.js";

export const SYS_MAX_PLANETS = 8;
export const SYS_MAX_MOONS = 6;
const LABEL_DIST = 4e7 * K;
const TAU = Math.PI * 2;
const groups = [];
const offsets = Array.from({ length: SYS_MAX_PLANETS }, () => ({ x: 0, y: 0, z: 0 }));
const moonOffsets = Array.from({ length: SYS_MAX_PLANETS }, () => Array.from({ length: SYS_MAX_MOONS }, () => ({ x: 0, y: 0, z: 0 })));
const pos = new THREE.Vector3();
const starPos = new THREE.Vector3();
let sceneRef = null, renderedStarId = "";

function labelTexture(text, color) {
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext("2d");
    ctx.font = "bold 22px system-ui, sans-serif";
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = color;
    ctx.fillText(text, 14, 40);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

function orbitGeometry() {
    const pts = [];
    for (let i = 0; i < 128; i++) {
        const a = i / 128 * TAU;
        pts.push(Math.cos(a), 0, Math.sin(a));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
}

export function initSystemRender(scene) {
    sceneRef = scene;
    for (let i = 0; i < SYS_MAX_PLANETS; i++) {
        const group = new THREE.Group();
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.MeshStandardMaterial({ color: 0xffffff }));
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: .28, depthWrite: false }));
        const orbit = new THREE.LineLoop(orbitGeometry(), new THREE.LineBasicMaterial({ color: 0x6f9bd8, transparent: true, opacity: .22, depthWrite: false }));
        const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
        const moons = [];
        for (let j = 0; j < SYS_MAX_MOONS; j++) {
            const moon = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 1 }));
            moon.visible = false;
            group.add(moon);
            moons.push(moon);
        }
        const ring = new THREE.Mesh(new THREE.RingGeometry(1, 2, 96, 1), new THREE.MeshBasicMaterial({
            map: ringTextureProc(), transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: .5,
        }));
        ring.rotation.x = -Math.PI / 2;
        ring.visible = false;
        group.add(ring);
        group.add(mesh, glow, label);
        scene.add(group, orbit);
        group.visible = false; orbit.visible = false;
        groups.push({ group, mesh, glow, orbit, label, moons, ring, planet: null });
    }
}

function rebuild(system) {
    renderedStarId = system?.starId || "";
    for (let i = 0; i < SYS_MAX_PLANETS; i++) {
        const slot = groups[i], p = system?.planets?.[i] || null;
        slot.planet = p;
        if (!p) {
            slot.group.visible = false; slot.orbit.visible = false; slot.ring.visible = false;
            for (const moon of slot.moons) moon.visible = false;
            continue;
        }
        slot.mesh.material.map?.dispose?.();
        slot.mesh.material.map = planetTextureProc(p.color, p.gas, 7000 + i * 131);
        slot.mesh.material.color.setHex(0xffffff);
        slot.mesh.material.needsUpdate = true;
        slot.glow.material.color.setHex(p.color);
        slot.label.material.map?.dispose?.();
        slot.label.material.map = labelTexture("P" + (i + 1), "#" + p.color.toString(16).padStart(6, "0"));
        slot.label.material.needsUpdate = true;
        for (let j = 0; j < SYS_MAX_MOONS; j++) {
            const m = p.moons?.[j], moon = slot.moons[j];
            moon.material.color.setHex(m?.color || 0xaaaaaa);
            moon.visible = false;
        }
        if (p.ring) {
            const inner = (p.ring.inner ?? p.ring[0]) * K, outer = (p.ring.outer ?? p.ring[1]) * K;
            slot.ring.geometry.dispose();
            slot.ring.geometry = new THREE.RingGeometry(inner, outer, 96, 1);
            const posA = slot.ring.geometry.attributes.position, uvA = slot.ring.geometry.attributes.uv;
            for (let vi = 0; vi < posA.count; vi++) {
                const r = Math.hypot(posA.getX(vi), posA.getY(vi));
                uvA.setXY(vi, (r - inner) / Math.max(1e-12, outer - inner), .5);
            }
            slot.ring.material.opacity = p.ring.opacity ?? .5;
        }
        slot.ring.visible = false;
    }
}

export function planetScenePosition(system, index, simT, out = pos) {
    const p = system?.planets?.[index];
    if (!system?.hostStar || !p) return null;
    planetOffsetKm(p, system.hostMass, simT, offsets[index]);
    return worldToResidual(
        system.hostStar.x + offsets[index].x,
        system.hostStar.y + offsets[index].y,
        (system.hostStar.z || 0) + offsets[index].z,
        out,
        K,
    );
}

export function moonScenePosition(system, planetIndex, moonIndex, simT, out = pos) {
    const p = system?.planets?.[planetIndex], m = p?.moons?.[moonIndex];
    if (!system?.hostStar || !p || !m) return null;
    planetOffsetKm(p, system.hostMass, simT, offsets[planetIndex]);
    moonOffsetKm(m, simT, moonOffsets[planetIndex][moonIndex]);
    return worldToResidual(
        system.hostStar.x + offsets[planetIndex].x + moonOffsets[planetIndex][moonIndex].x,
        system.hostStar.y + offsets[planetIndex].y + moonOffsets[planetIndex][moonIndex].y,
        (system.hostStar.z || 0) + offsets[planetIndex].z + moonOffsets[planetIndex][moonIndex].z,
        out,
        K,
    );
}

export function updateSystemRender(system, simT, camera, focus = "") {
    if (!sceneRef || !groups.length) return;
    if (!system || !system.hostStar) {
        if (renderedStarId) rebuild(null);
        return;
    }
    if (renderedStarId !== system.starId) rebuild(system);
    worldToResidual(system.hostStar.x, system.hostStar.y, system.hostStar.z || 0, starPos, K);
    const focusedMoon = planetMoonFocusIndex(focus);
    for (let i = 0; i < SYS_MAX_PLANETS; i++) {
        const slot = groups[i], p = slot.planet;
        if (!p) continue;
        const ppos = planetScenePosition(system, i, simT, slot.group.position);
        if (!ppos) { slot.group.visible = false; slot.orbit.visible = false; continue; }
        const dCam = camera.position.distanceTo(slot.group.position);
        const rScene = p.radiusKm * K;
        slot.mesh.scale.setScalar(Math.max(rScene, dCam * .0025));
        slot.glow.scale.setScalar(Math.max(rScene * 4, dCam * .01));
        slot.label.position.set(0, Math.max(rScene * 4, slot.mesh.scale.x * 2.4), 0);
        slot.label.scale.setScalar(dCam * .028);
        slot.label.visible = dCam < LABEL_DIST;
        slot.group.visible = true;
        slot.orbit.position.copy(starPos);
        slot.orbit.scale.setScalar(p.a * 149597870.7 * K);
        slot.orbit.visible = dCam < LABEL_DIST * 3;
        slot.ring.visible = !!p.ring && (dCam < LABEL_DIST || focusedMoon?.planetIndex === i);
        if (p.ring) slot.ring.rotation.z = p.ring.tilt ?? p.tilt ?? 0;
        const showMoons = focusedMoon?.planetIndex === i || dCam < Math.max(LABEL_DIST, p.radiusKm * K * 9000);
        for (let j = 0; j < SYS_MAX_MOONS; j++) {
            const moon = slot.moons[j], m = p.moons?.[j];
            if (!m || !showMoons) { moon.visible = false; continue; }
            moonOffsetKm(m, simT, moonOffsets[i][j]);
            moon.position.set(moonOffsets[i][j].x * K, moonOffsets[i][j].z * K, -moonOffsets[i][j].y * K);
            const dMoon = camera.position.distanceTo(moon.getWorldPosition(pos));
            moon.scale.setScalar(Math.max(m.R * K, dMoon * .0017));
            moon.visible = true;
        }
    }
}

export function disposeSystemRender() {
    for (const slot of groups) {
        sceneRef?.remove(slot.group);
        sceneRef?.remove(slot.orbit);
    }
    groups.length = 0;
    renderedStarId = "";
}
