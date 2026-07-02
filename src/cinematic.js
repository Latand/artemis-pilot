import { K, WARP_MAX, WARP_SUBS } from "./constants.js";
import { getOrigin, worldToResidual } from "./universe/renderOrigin.js";

const DEFAULT_GAP = 3;
const DEFAULT_EXPOSURE = 1.12;
const MIN_WARP = WARP_SUBS[0];

const keyframes = [];
let playing = false;
let playT = 0;
let recording = false;
let cleanRender = false;

let cameraRef = null;
let camRef = null;
let GRef = null;
let rendererRef = null;
let setRollRef = null;
let applyRollRef = null;

const p0 = [0, 0, 0], p1 = [0, 0, 0], p2 = [0, 0, 0], p3 = [0, 0, 0];
const outPos = [0, 0, 0], outTarget = [0, 0, 0];
const scratchSample = { pos: outPos, target: outTarget, roll: 0, warp: 1, exposure: DEFAULT_EXPOSURE };
const scratchScenePos = { x: 0, y: 0, z: 0 };
const scratchSceneTarget = { x: 0, y: 0, z: 0 };

export function bindCinematic({ camera, cam, G, renderer, setCamRoll, applyCameraRoll } = {}) {
    cameraRef = camera || cameraRef;
    camRef = cam || camRef;
    GRef = G || GRef;
    rendererRef = renderer || rendererRef;
    setRollRef = setCamRoll || setRollRef;
    applyRollRef = applyCameraRoll || applyRollRef;
}

function finite(n, fallback = 0) {
    return Number.isFinite(n) ? n : fallback;
}

function normalizeFrame(k, prevT = 0) {
    const pos = Array.isArray(k?.pos) ? k.pos : [0, 0, 0];
    const target = Array.isArray(k?.target) ? k.target : [0, 0, 0];
    return {
        pos: [finite(pos[0]), finite(pos[1]), finite(pos[2])],
        target: [finite(target[0]), finite(target[1]), finite(target[2])],
        roll: finite(k?.roll),
        warp: Math.min(WARP_MAX, Math.max(MIN_WARP, finite(k?.warp, 1))),
        t: Math.max(prevT, finite(k?.t, prevT)),
        exposure: Math.max(0.02, finite(k?.exposure, DEFAULT_EXPOSURE)),
    };
}

function copy3(dst, src) {
    dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2];
    return dst;
}

function worldFromScene(v, out) {
    const origin = getOrigin();
    out[0] = origin.x + v.x / K;
    out[1] = origin.y - v.z / K;
    out[2] = origin.z + v.y / K;
    return out;
}

function dist3(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function lerp(a, b, u) {
    return a + (b - a) * u;
}

function catPoint(a, b, c, d, u, out) {
    const t0 = 0;
    let t1 = Math.pow(dist3(a, b), .5);
    let t2 = t1 + Math.pow(dist3(b, c), .5);
    let t3 = t2 + Math.pow(dist3(c, d), .5);
    if (t1 <= 1e-12) t1 = 1;
    if (t2 <= t1 + 1e-12) t2 = t1 + 1;
    if (t3 <= t2 + 1e-12) t3 = t2 + 1;
    const t = lerp(t1, t2, u);
    for (let i = 0; i < 3; i++) {
        const A1 = ((t1 - t) / (t1 - t0)) * a[i] + ((t - t0) / (t1 - t0)) * b[i];
        const A2 = ((t2 - t) / (t2 - t1)) * b[i] + ((t - t1) / (t2 - t1)) * c[i];
        const A3 = ((t3 - t) / (t3 - t2)) * c[i] + ((t - t2) / (t3 - t2)) * d[i];
        const B1 = ((t2 - t) / (t2 - t0)) * A1 + ((t - t0) / (t2 - t0)) * A2;
        const B2 = ((t3 - t) / (t3 - t1)) * A2 + ((t - t1) / (t3 - t1)) * A3;
        out[i] = ((t2 - t) / (t2 - t1)) * B1 + ((t - t1) / (t2 - t1)) * B2;
    }
    return out;
}

function findSegment(t) {
    if (keyframes.length <= 1) return 0;
    if (t <= keyframes[0].t) return 0;
    for (let i = 0; i < keyframes.length - 1; i++) {
        if (t <= keyframes[i + 1].t) return i;
    }
    return keyframes.length - 2;
}

function sampleInto(t, out) {
    if (!keyframes.length) {
        copy3(out.pos, [0, 0, 0]);
        copy3(out.target, [0, 0, 0]);
        out.roll = 0; out.warp = 1; out.exposure = DEFAULT_EXPOSURE;
        return out;
    }
    if (keyframes.length === 1 || t <= keyframes[0].t) {
        const k = keyframes[0];
        copy3(out.pos, k.pos); copy3(out.target, k.target);
        out.roll = k.roll; out.warp = k.warp; out.exposure = k.exposure;
        return out;
    }
    const last = keyframes[keyframes.length - 1];
    if (t >= last.t) {
        copy3(out.pos, last.pos); copy3(out.target, last.target);
        out.roll = last.roll; out.warp = last.warp; out.exposure = last.exposure;
        return out;
    }
    const i = findSegment(t);
    const a = keyframes[Math.max(0, i - 1)];
    const b = keyframes[i];
    const c = keyframes[i + 1];
    const d = keyframes[Math.min(keyframes.length - 1, i + 2)];
    const span = Math.max(1e-9, c.t - b.t);
    const u = Math.max(0, Math.min(1, (t - b.t) / span));
    catPoint(a.pos, b.pos, c.pos, d.pos, u, out.pos);
    catPoint(a.target, b.target, c.target, d.target, u, out.target);
    out.roll = lerp(b.roll, c.roll, u);
    out.warp = Math.min(WARP_MAX, Math.max(MIN_WARP, Math.exp(lerp(Math.log(b.warp), Math.log(c.warp), u))));
    out.exposure = lerp(b.exposure, c.exposure, u);
    return out;
}

export function addKeyframe() {
    if (!cameraRef || !camRef) return null;
    const pos = worldFromScene(cameraRef.position, [0, 0, 0]);
    const target = worldFromScene(camRef.tgt, [0, 0, 0]);
    const t = keyframes.length ? keyframes[keyframes.length - 1].t + DEFAULT_GAP : 0;
    const k = normalizeFrame({ pos, target, roll: 0, warp: GRef?.warp || 1, t, exposure: rendererRef?.toneMappingExposure || DEFAULT_EXPOSURE }, t);
    keyframes.push(k);
    rebuildCine();
    return k;
}

export function removeKeyframe(i) {
    if (i >= 0 && i < keyframes.length) keyframes.splice(i, 1);
    rebuildCine();
}

export function clearKeyframes() {
    keyframes.length = 0;
    stop();
    rebuildCine();
}

export function getKeyframes() {
    return keyframes.map(k => ({
        pos: k.pos.slice(),
        target: k.target.slice(),
        roll: k.roll,
        warp: k.warp,
        t: k.t,
        exposure: k.exposure,
    }));
}

export function loadKeyframes(arr) {
    keyframes.length = 0;
    let prevT = 0;
    for (const item of Array.isArray(arr) ? arr : []) {
        const k = normalizeFrame(item, prevT);
        keyframes.push(k);
        prevT = k.t;
    }
    playT = 0;
    rebuildCine();
}

export function duration() {
    return keyframes.length ? keyframes[keyframes.length - 1].t : 0;
}

export function sampleAt(t) {
    const out = { pos: [0, 0, 0], target: [0, 0, 0], roll: 0, warp: 1, exposure: DEFAULT_EXPOSURE };
    return sampleInto(t, out);
}

export function applyFrame(t) {
    if (!cameraRef) return null;
    const s = sampleInto(t, scratchSample);
    worldToResidual(s.pos[0], s.pos[1], s.pos[2], scratchScenePos, K);
    worldToResidual(s.target[0], s.target[1], s.target[2], scratchSceneTarget, K);
    cameraRef.position.set(scratchScenePos.x, scratchScenePos.y, scratchScenePos.z);
    if (camRef?.tgt?.set) camRef.tgt.set(scratchSceneTarget.x, scratchSceneTarget.y, scratchSceneTarget.z);
    if (setRollRef) setRollRef(s.roll);
    cameraRef.lookAt(scratchSceneTarget);
    if (applyRollRef) applyRollRef();
    if (GRef) GRef.warp = s.warp;
    if (rendererRef) rendererRef.toneMappingExposure = s.exposure;
    return s;
}

export function play() {
    if (!keyframes.length) return false;
    playing = true;
    playT = keyframes[0].t;
    if (GRef) GRef.focus = "free";
    if (camRef) camRef.distTarget = null;
    applyFrame(playT);
    rebuildCine();
    return true;
}

export function stop() {
    playing = false;
    if (setRollRef) setRollRef(0);
    rebuildCine();
}

export function tick(dtR) {
    if (!playing) return;
    playT += Math.max(0, finite(dtR));
    applyFrame(playT);
    if (playT >= duration()) stop();
}

export function isPlaying() { return playing; }
export function isRecording() { return recording; }
export function setRecording(b) { recording = !!b; rebuildCine(); }

export function setCleanRender(b) {
    cleanRender = !!b;
    if (typeof document !== "undefined") document.body?.classList.toggle("mode-clean", cleanRender);
    rebuildCine();
}

export function isCleanRender() { return cleanRender; }

let panel = null;
let countEl = null;
let cleanEl = null;

export function initCine() {
    if (typeof document === "undefined") return;
    panel = document.getElementById("cinePanel");
    countEl = document.getElementById("cineCount");
    cleanEl = document.getElementById("cineClean");
    document.getElementById("cineAdd")?.addEventListener("click", () => addKeyframe());
    document.getElementById("cineDelete")?.addEventListener("click", () => removeKeyframe(keyframes.length - 1));
    document.getElementById("cinePlay")?.addEventListener("click", () => play());
    document.getElementById("cineStop")?.addEventListener("click", () => stop());
    document.getElementById("cineClear")?.addEventListener("click", () => clearKeyframes());
    cleanEl?.addEventListener("change", () => setCleanRender(cleanEl.checked));
    rebuildCine();
}

export function toggleCine() {
    if (!panel) initCine();
    if (!panel) return false;
    const open = panel.style.display !== "block";
    panel.style.display = open ? "block" : "none";
    rebuildCine();
    return open;
}

export function rebuildCine() {
    if (countEl) countEl.textContent = String(keyframes.length);
    if (cleanEl) cleanEl.checked = cleanRender;
}

if (typeof window !== "undefined") {
    window.__cinematic = {
        loadKeyframes, getKeyframes, addKeyframe, removeKeyframe, clearKeyframes,
        play, stop, sampleAt, setCleanRender, isCleanRender, applyFrame, duration,
        isPlaying,
    };
}
