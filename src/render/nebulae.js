import { G } from "../state.js";
import { gasWorldState } from "../universe/gasDynamics.js";
import { gasStateAt } from "../universe/gasFormation.js";
import { makeGasCloudVisual, updateGasCloudVisual, disposeGasCloudVisual } from "../gasCloudVisuals.js";
import * as THREE from "three";
import { K } from "../constants.js";
import { scene, renderQuality } from "../scene.js";
import { makeRNG, splitSeed } from "../universe/prng.js";
import { worldToResidual } from "../universe/renderOrigin.js";
import {
    NEBULAE, NEB_MAX, NEBULA_ARCHETYPES, addNebulaRecord, clearNebulaRecords,
    nebulaArchetypeIndex, removeNebulaRecord, restoreNebulaRecords, serializeNebulae,
} from "../universe/nebulaeData.js";

export { NEBULAE, NEB_MAX, NEBULA_ARCHETYPES, serializeNebulae };

const VIS = [];
const tmpPos = new THREE.Vector3();
const tmpAxis = new THREE.Vector3();

function colorStop(ctx, grad, offset, color, alphaScale = 1) {
    grad.addColorStop(offset, color.replace("α", String(alphaScale)));
}

function makeSoftBlobTexture(seed, archetype, layerIndex) {
    const size = 512;
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    const rng = makeRNG(splitSeed(seed, layerIndex));
    ctx.clearRect(0, 0, size, size);

    if (archetype === 2) {
        const cx = size * .5, cy = size * .5;
        const ring = ctx.createRadialGradient(cx, cy, size * .16, cx, cy, size * .48);
        ring.addColorStop(0, "rgba(90,255,220,0)");
        ring.addColorStop(.42, "rgba(90,255,220,0.18)");
        ring.addColorStop(.58, "rgba(255,130,210,0.22)");
        ring.addColorStop(.76, "rgba(120,170,255,0.08)");
        ring.addColorStop(1, "rgba(90,255,220,0)");
        ctx.fillStyle = ring;
        ctx.fillRect(0, 0, size, size);
        const core = ctx.createRadialGradient(cx, cy, 2, cx, cy, size * .22);
        core.addColorStop(0, "rgba(140,255,235,0.34)");
        core.addColorStop(1, "rgba(140,255,235,0)");
        ctx.fillStyle = core;
        ctx.fillRect(0, 0, size, size);
        return new THREE.CanvasTexture(cv);
    }

    const colors = archetype === 1
        ? ["rgba(120,160,255,α)", "rgba(190,210,255,α)"]
        : ["rgba(255,90,90,α)", "rgba(80,220,200,α)", "rgba(255,160,95,α)"];
    const count = 26 + Math.floor(rng() * 15);
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < count; i++) {
        let x = size * (.5 + (rng() - .5) * .62);
        let y = size * (.5 + (rng() - .5) * .62);
        let r = size * (.07 + rng() * .18);
        for (let oct = 0; oct < 3; oct++) {
            x += (rng() - .5) * size * .045;
            y += (rng() - .5) * size * .045;
            r *= .72 + rng() * .22;
            const g = ctx.createRadialGradient(x, y, 0, x, y, r);
            colorStop(ctx, g, 0, colors[(i + oct) % colors.length], (.035 + rng() * .045) / (oct + 1));
            g.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = g;
            ctx.fillRect(Math.max(0, x - r), Math.max(0, y - r), Math.min(size, r * 2), Math.min(size, r * 2));
        }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
}

function buildNebulaVisual(record) {
    if (record.formation) { const vis = makeGasCloudVisual(record); scene.add(vis.group); return vis; }
    const group = new THREE.Group();
    const layers = [];
    const count = renderQuality.mobile ? 2 : 4;
    const archetype = nebulaArchetypeIndex(record.archetype);
    for (let i = 0; i < count; i++) {
        const material = new THREE.SpriteMaterial({
            map: makeSoftBlobTexture(record.seed, archetype, i),
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            opacity: 1.0 / count * (renderQuality.mobile ? 1.6 : 1),
        });
        const sprite = new THREE.Sprite(material);
        sprite.renderOrder = -12;
        group.add(sprite);
        layers.push(sprite);
    }
    scene.add(group);
    return { group, layers, spin: 0 };
}

export function addNebula(record) {
    const i = addNebulaRecord(record);
    if (i < 0) return -1;
    VIS[i] = buildNebulaVisual(NEBULAE[i]);
    return i;
}

export function removeNebula(i) {
    const vis = VIS[i];
    if (vis) {
        scene.remove(vis.group);
        if (vis.volume) disposeGasCloudVisual(vis);
        for (const layer of vis.layers) layer.material.map?.dispose?.();
        for (const layer of vis.layers) layer.material.dispose();
    }
    VIS.splice(i, 1);
    return removeNebulaRecord(i);
}

export function clearNebulae() {
    while (VIS.length) {
        const vis = VIS.pop();
        scene.remove(vis.group);
        if (vis.volume) disposeGasCloudVisual(vis);
        for (const layer of vis.layers) layer.material.map?.dispose?.();
        for (const layer of vis.layers) layer.material.dispose();
    }
    clearNebulaRecords();
}

export function restoreNebulae(rows = []) {
    clearNebulae();
    restoreNebulaRecords(rows);
    for (let i = 0; i < NEBULAE.length; i++) VIS[i] = buildNebulaVisual(NEBULAE[i]);
    return NEBULAE.length;
}

export function nebulaScenePos(i, out = tmpPos) {
    const n = NEBULAE[i];
    if (!n) return null;
    const origin=gasWorldState(n,G.t);
    if(n.formation&&n.inspectStar){
        const s=gasStateAt(n,G.t);
        if(s.born)return worldToResidual(origin.x+s.sinkPosition[0]*n.radiusKm,origin.y+s.sinkPosition[1]*n.radiusKm,origin.z+s.sinkPosition[2]*n.radiusKm,out,K);
    }
    return worldToResidual(origin.x, origin.y, origin.z, out, K);
}

export function updateNebulae(camera, dtReal = 0) {
    for (let i = 0; i < NEBULAE.length; i++) {
        const record = NEBULAE[i];
        const vis = VIS[i];
        if (!record || !vis) continue;
        // Focus may follow the photosphere; the gas buffer stays at its patch origin.
        const origin=gasWorldState(record,G.t);
        const base = worldToResidual(origin.x,origin.y,origin.z,vis.group.position,K);
        if (record.formation) {
            const state = gasStateAt(record, G.t);
            updateGasCloudVisual(vis, record, state, camera);
            continue;
        }
        const radiusScene = record.radiusKm * K;
        tmpAxis.copy(base).sub(camera.position);
        if (tmpAxis.lengthSq() < 1e-18) tmpAxis.set(0, 0, -1);
        else tmpAxis.normalize();
        const L = vis.layers.length;
        for (let j = 0; j < L; j++) {
            const layer = vis.layers[j];
            const depthOffset = (j - (L - 1) / 2) * radiusScene * .22;
            layer.position.copy(tmpAxis).multiplyScalar(depthOffset);
            layer.scale.setScalar(radiusScene * (1 + j * .18) * 2);
            layer.rotation.z += dtReal * .004 * (j % 2 ? 1 : -1);
        }
    }
}

export function nebulaHudSummary(i) {
    const n = NEBULAE[i];
    if (!n) return "";
    if (n.formation) { const s = gasStateAt(n, G.t); return s.phase.toUpperCase() + " · " + Math.round(s.progress * 100) + "% in sink · " + s.totalMassSolar + " M☉ · numerical SPH"; }
    const ly = n.radiusKm / 9.4607e12;
    return NEBULA_ARCHETYPES[nebulaArchetypeIndex(n.archetype)] + " NEBULA · radius " + ly.toFixed(ly >= 10 ? 0 : 1) +
        " ly · visual impostor · real cloud mass ~10^2-10^4 M☉ spread over light-years - locally negligible";
}

export function nebulaViewRadius(i) {
    const n = NEBULAE[i];
    if(n?.formation){const s=gasStateAt(n,G.t);return n.inspectStar&&s.born?s.stellar.radiusKm:s.radiusKm;}
    return n?.radiusKm || 1;
}
export function clearFormingNebulae() {
    for (let i = NEBULAE.length - 1; i >= 0; i--) if (NEBULAE[i].formation) removeNebula(i);
}
