import { systemAnchor } from './systemPrecision.js';
import * as THREE from "three";
import { K, LY_SCENE } from "../constants.js";
import { dotTexture, ringTextureProc } from "../textures.js";
import { moonOffsetKm, planetFocusIndex, planetMoonFocusIndex, planetOffsetKm } from "../universe/planetarySystem.js";
import { worldToResidual } from "../universe/renderOrigin.js";
import { getBodyAppearance } from './bodyAppearanceProfiles.js';
import { createBodySurfaceMaterial, requestBodySurfaceDetail, updateBodySurface } from './bodySurfaceMaterial.js';
import { teffToRGB } from './viewBrightness.js';
import { applyTerrellToMaterial } from '../relView.js';

export const SYS_MAX_PLANETS = 8;
export const SYS_MAX_MOONS = 6;
const LABEL_DIST = 4e7 * K;
const TAU = Math.PI * 2;
const groups = [];
const offsets = Array.from({ length: SYS_MAX_PLANETS }, () => ({ x: 0, y: 0, z: 0 }));
const moonOffsets = Array.from({ length: SYS_MAX_PLANETS }, () => Array.from({ length: SYS_MAX_MOONS }, () => ({ x: 0, y: 0, z: 0 })));
const pos = new THREE.Vector3();
const starPos = new THREE.Vector3();
const hostDirection = new THREE.Vector3(), hostColor = new THREE.Color();
const hostRGB = [1, 1, 1];
let sceneRef = null, renderedStarId = "", renderedSystem = null;
let gateOpen = false;

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
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 80, 56), new THREE.MeshStandardMaterial({ color: 0xffffff }));
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(255,255,255,1)", "rgba(255,255,255,0)"), color: 0xffffff, transparent: true, opacity: .28, depthWrite: false }));
        const orbit = new THREE.LineLoop(orbitGeometry(), new THREE.LineBasicMaterial({ color: 0x6f9bd8, transparent: true, opacity: .22, depthWrite: false }));
        const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
        const moons = [], moonGlows = [];
        for (let j = 0; j < SYS_MAX_MOONS; j++) {
            const moon = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 40), new THREE.MeshStandardMaterial({ color: 0xaaaaaa, roughness: 1 }));
            moon.visible = false;
            group.add(moon);
            moons.push(moon);
            const beacon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow.material.map, color: 0xcccccc, transparent: true, depthWrite: false, opacity: .3 }));
            beacon.visible = false;
            group.add(beacon);
            moonGlows.push(beacon);
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
        groups.push({ group, mesh, glow, orbit, label, moons, moonGlows, ring, planet: null });
    }
}

function rebuild(system) {
    gateOpen = false;
    renderedStarId = system?.starId || "";
    renderedSystem = system;
    for (let i = 0; i < SYS_MAX_PLANETS; i++) {
        const slot = groups[i], p = system?.planets?.[i] || null;
        slot.planet = p;
        if (!p) {
            slot.group.visible = false; slot.orbit.visible = false; slot.ring.visible = false;
            for (const moon of [...slot.moons, ...slot.moonGlows]) moon.visible = false;
            continue;
        }
        slot.mesh.material.dispose();
        const identity = system.starId + ':' + (p.name || 'planet:' + i);
        slot.mesh.material = applyTerrellToMaterial(createBodySurfaceMaterial(getBodyAppearance(p, identity), { hostLit: true }));
        slot.mesh.userData.appearanceIdentity = identity;
        slot.glow.material.color.setHex(p.color);
        slot.label.material.map?.dispose?.();
        slot.label.material.map = labelTexture(p.name || "P" + (i + 1), "#" + p.color.toString(16).padStart(6, "0"));
        slot.label.material.needsUpdate = true;
        for (let j = 0; j < SYS_MAX_MOONS; j++) {
            const m = p.moons?.[j], moon = slot.moons[j];
            if (m) {
                moon.material.dispose();
                moon.material = applyTerrellToMaterial(createBodySurfaceMaterial(getBodyAppearance(m, identity + ':' + (m.name || 'moon:' + j)), { hostLit: true }));
                slot.moonGlows[j].material.color.setHex(m.color || 0xaaaaaa);
            }
            moon.visible = false;
            slot.moonGlows[j].visible = false;
        }
        if (p.ring) {
            const ringMap = slot.ring.material.map;
            // Retain the ring's own texture across material swaps.
            slot.ring.material.map = null;
            slot.ring.material.dispose();
            slot.ring.material = createBodySurfaceMaterial(getBodyAppearance({ color: 0xffffff, gas: true }, identity + ':ring'), { map: ringMap, hostLit: true });
            slot.ring.material.transparent = true;
            slot.ring.material.side = THREE.DoubleSide;
            slot.ring.material.depthWrite = false;
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
    if (renderedSystem !== system) rebuild(system);
    worldToResidual(system.hostStar.x, system.hostStar.y, system.hostStar.z || 0, starPos, K);
    // Beacon gate: a system's planets/glows/labels only render when the
    // camera is plausibly near that system (or explicitly flying to one of
    // its planets). Without this, the nearest OTHER star's synthetic planets
    // rendered as permanent sky-fixed min-size beacons from inside Sol —
    // the owner's "gray square with a circle". 15% hysteresis so the
    // boundary doesn't flicker.
    const maxA = system.planets.reduce((m, p) => Math.max(m, p?.a || 0), 0);
    const gateR = Math.max(maxA * 149597870.7 * K * 60, LY_SCENE * 0.01);
    const dHost = camera.position.distanceTo(starPos);
    if (!gateOpen && dHost < gateR) gateOpen = true;
    else if (gateOpen && dHost > gateR * 1.15) gateOpen = false;
    const focusTargets = planetFocusIndex(focus) >= 0 || !!planetMoonFocusIndex(focus);
    if (!gateOpen && !focusTargets) {
        for (const slot of groups) {
            slot.group.visible = false; slot.orbit.visible = false;
            for (const moon of [...slot.moons, ...slot.moonGlows]) moon.visible = false;
        }
        return;
    }
    const focusedMoon = planetMoonFocusIndex(focus);
    const pxScale = (typeof window !== 'undefined' ? window.innerHeight : 900) / (2 * Math.tan(camera.fov * Math.PI / 360));
    const mobile = typeof window !== 'undefined' && window.innerWidth < 720;
    teffToRGB(system.hostTeff || 5772, hostRGB);
    hostColor.setRGB(hostRGB[0], hostRGB[1], hostRGB[2], THREE.SRGBColorSpace);
    for (let i = 0; i < SYS_MAX_PLANETS; i++) {
        const slot = groups[i], p = slot.planet;
        if (!p) continue;
        const ppos = planetScenePosition(system, i, simT, slot.group.position);
        if (!ppos) { slot.group.visible = false; slot.orbit.visible = false; continue; }
        const anchor = systemAnchor(system, i, null, simT);
        slot.mesh.userData.systemAnchor = anchor; slot.ring.userData.systemAnchor = anchor;
        const eye = camera.userData.systemAnchor;
        const dCam = anchor && eye && camera.userData.preciseOrbit
            ? pos.copy(anchor.origin).sub(eye.origin).add(anchor.offset).sub(eye.offset).sub(camera.userData.preciseOrbit.offset).length()
            : camera.position.distanceTo(slot.group.position);
        const rScene = p.radiusKm * K;
        const rpx = rScene * pxScale / Math.max(rScene, dCam);
        slot.mesh.scale.setScalar(rScene);
        slot.mesh.rotation.set(0, ((simT / Math.max(1, p.rotSec || 86400)) * TAU) % TAU, p.tilt || 0);
        requestBodySurfaceDetail(slot.mesh.material, undefined, rpx, mobile);
        hostDirection.copy(starPos).sub(slot.group.position).normalize();
        updateBodySurface(slot.mesh.material, simT, hostDirection, hostColor);
        updateBodySurface(slot.ring.material, simT, hostDirection, hostColor);
        slot.glow.scale.setScalar(dCam * 9 / Math.max(1, pxScale));
        slot.glow.material.opacity = .6 * (1 - THREE.MathUtils.smoothstep(rpx, 1, 4));
        slot.glow.visible = slot.glow.material.opacity > .01;
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
            if (!m || !showMoons) { moon.visible = false; slot.moonGlows[j].visible = false; continue; }
            moonOffsetKm(m, simT, moonOffsets[i][j]);
            moon.position.set(moonOffsets[i][j].x * K, moonOffsets[i][j].z * K, -moonOffsets[i][j].y * K);
            const dMoon = camera.position.distanceTo(moon.getWorldPosition(pos));
            const moonPx = m.R * K * pxScale / Math.max(m.R * K, dMoon);
            moon.userData.systemAnchor = systemAnchor(system, i, j, simT);
            moon.scale.setScalar(m.R * K);
            const moonRate = Math.sqrt((m.orbitMu || m.mu) / (m.a * m.a * m.a));
            moon.rotation.y = ((m.phase || 0) + moonRate * simT) % TAU;
            requestBodySurfaceDetail(moon.material, undefined, moonPx, mobile);
            hostDirection.copy(starPos).sub(pos).normalize();
            updateBodySurface(moon.material, simT, hostDirection, hostColor);
            moon.visible = true;
            const beacon = slot.moonGlows[j];
            beacon.position.copy(moon.position);
            beacon.scale.setScalar(dMoon * 6 / Math.max(1, pxScale));
            beacon.material.opacity = .5 * (1 - THREE.MathUtils.smoothstep(moonPx, 1, 4));
            beacon.visible = beacon.material.opacity > .01;
        }
    }
}

export function disposeSystemRender() {
    for (const slot of groups) {
        sceneRef?.remove(slot.group);
        sceneRef?.remove(slot.orbit);
        slot.group.traverse(object => {
            object.geometry?.dispose();
            if (object.material) {
                // Surface-owned procedural maps are released by their material.
                if (!object.material.userData.bodyAppearance) object.material.map?.dispose?.();
                object.material.dispose();
            }
        });
        slot.orbit.geometry.dispose();
        slot.orbit.material.dispose();
    }
    groups.length = 0;
    renderedStarId = "";
    renderedSystem = null;
}

export function systemBodyRenderState() { return groups.slice(); }
