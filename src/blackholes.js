import * as THREE from "three";
import { BH_MAX, BH_SIZES, C_LIGHT, MU_S, K, LY_SCENE, LY_KM } from "./constants.js";
import { tdeLuminosityW, L_EDD_PER_MSUN } from "./tde.js";
import { G, BH } from "./state.js";
import { eph } from "./ephemeris.js";
import { fmtAccel, fmtDist, fmtKm, mulberry32 } from "./format.js";
import { dotTexture, ringTexture } from "./textures.js";
import { scene, camera, cam, cvHost, lastPtr, renderer, renderQuality } from "./scene.js";
import { noteNotable } from "./discoveryLog.js";
import { hashInts, splitSeed } from "./universe/prng.js";
import { registerPlacedPulsar, unregisterPlacedPulsar } from "./ambientAudio.js";
import { addNebula } from "./render/nebulae.js";
import { NEBULAE, NEB_MAX, NEBULA_ARCHETYPES, nebulaRadiusKmFromPreset } from "./universe/nebulaeData.js";
import { initEncounterHooks, addHoleData, removeHoleData, TDES } from "./bhEncounters.js";
// the encounter physics lives in bhEncounters.js (headless); these stay
// importable from here for the HUD / events panel
export { activeTde, bhAdvance, tdeInProgress } from "./bhEncounters.js";

export const BH_META = []; // visual groups, parallel to the data arrays

let H = {
    toast: () => { }, predict: () => { }, cataclysm: () => { },
    disrupt: () => "", absorbed: () => { },
    event: () => { },
};
export function initBHHooks(hooks) {
    H = { ...H, ...hooks };
    initEncounterHooks(hooks);
}

const SOLAR_MASS_KG = 1.98847e30;
const G_KM = 6.674e-20;
const TDE_WATCH_WARP = 600;
const AU_KM = 149597870.7;
const PULSAR_ALIAS_SHIMMER_HZ = 2;
const EXO_PRESETS = {
    1: [{ label: "10⁸ M☉", rsKm: 2.9532e8 }, { label: "10⁹ M☉", rsKm: 2.9532e9 }],
    2: [{ label: "CRAB 33 ms", rsKm: 4.1345, period: 0.0334 }, { label: "VELA 89 ms", rsKm: 4.1345, period: 0.0893 }, { label: "B1919 1.34 s", rsKm: 4.1345, period: 1.3373 }],
    3: [
        { label: "EMISSION 1 ly", archetype: 0, radiusKm: 9.4607e12 },
        { label: "REFLECT 4 ly", archetype: 1, radiusKm: 4 * 9.4607e12 },
        { label: "PLANETARY 10 ly", archetype: 2, radiusKm: 10 * 9.4607e12 },
    ],
};
const EXO_KINDS = [
    { label: "HOLE", kind: 0 },
    { label: "QUASAR", kind: 1 },
    { label: "PULSAR", kind: 2 },
    { label: "NEBULA", kind: 3, title: "zoom out to interstellar scale to place nebulae" },
];
export function bhMassLabel(rs) {
    const msun = rs * C_LIGHT * C_LIGHT / 2 / MU_S;
    if (msun >= 100) return Math.round(msun).toLocaleString("en-US") + " M☉";
    if (msun >= .01) return msun.toFixed(2) + " M☉";
    return sci(msun * SOLAR_MASS_KG, "kg") + " · " + msun.toExponential(2) + " M☉";
}
function smooth01(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / Math.max(1e-12, b - a)));
    return t * t * (3 - 2 * t);
}
const HBAR = 1.054571817e-34, C_M = 299792458, KB = 1.380649e-23;
function sci(v, unit) {
    if (!isFinite(v) || v <= 0) return "0 " + unit;
    if (v >= .01 && v < 1000) return (v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toPrecision(2)) + " " + unit;
    const e = Math.floor(Math.log10(v));
    const m = v / Math.pow(10, e);
    return m.toFixed(2) + "e" + e + " " + unit;
}
export function hawkingStats(rsKm) {
    const r = rsKm * 1000;
    return {
        tempK: HBAR * C_M / (4 * Math.PI * KB * r),
        powerW: HBAR * C_M * C_M / (3840 * Math.PI * r * r),
    };
}
export function bhHawkingLabel(rsKm) {
    const h = hawkingStats(rsKm);
    return "Hawking T " + sci(h.tempK, "K") + " · P " + sci(h.powerW, "W");
}
function bhSizeShort(rsKm) {
    if (rsKm < 1) return Math.round(rsKm * 1000) + " m";
    if (rsKm < 1000) return Math.round(rsKm) + " km";
    if (rsKm < 1000000) return Math.round(rsKm / 1000) + "k";
    return (rsKm / 1000000).toFixed(rsKm >= 1000000 ? 1 : 2).replace(/\.0$/, "") + "M";
}
function gravityPanelLabel(ms2) {
    return ms2 >= 1e5 ? sci(ms2, "m/s²") : fmtAccel(ms2);
}
function pulsarAliased(period) {
    return period > 0 && (G.warp / 60) > (period / 8);
}
function pulsarAliasLabel(period) {
    return pulsarAliased(period) ? "TIME-AVG" : "SWEEP";
}
function pulsarFactsLabel(period) {
    const p = Math.max(1e-9, period || 0);
    return "P " + p.toFixed(p < 0.1 ? 4 : 3) + " s · f " + (1 / p).toFixed(p < 0.1 ? 1 : 2) + " Hz · " + pulsarAliasLabel(p);
}
export function pwAccelMs2(mu, rKm, rsKm) {
    const eff = Math.max(rKm - rsKm, rsKm * .02);
    return 1000 * mu / Math.max(1e-30, eff * eff);
}
function makeHawkingPoints(seed) {
    const N = 140, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const rnd = mulberry32(seed);
    for (let i = 0; i < N; i++) {
        const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
        const r = .16 + Math.pow(rnd(), .55) * 1.1;
        pos[i * 3] = Math.sin(ph) * Math.cos(th) * r;
        pos[i * 3 + 1] = (rnd() - .5) * .16;
        pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * r;
        const hot = Math.pow(1 / r, .35);
        col[i * 3] = .22 + hot * .32;
        col[i * 3 + 1] = .52 + hot * .32;
        col[i * 3 + 2] = .9 + hot * .1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
        size: .008, vertexColors: true, transparent: true, opacity: .16,
        depthWrite: false, blending: THREE.AdditiveBlending,
        map: dotTexture("rgba(230,250,255,1)", "rgba(90,170,255,0.0)"),
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 5;
    return pts;
}
function makeTdeJet() {
    const seg = 36, verts = [], idx = [];
    for (let side = 0; side < 2; side++) {
        const dir = side === 0 ? 1 : -1;
        const base = verts.length / 3;
        verts.push(0, dir * .5, 0);
        verts.push(0, 0, 0);
        for (let s = 0; s < seg; s++) {
            const a = s / seg * Math.PI * 2;
            verts.push(Math.cos(a) * .06, 0, Math.sin(a) * .06);
        }
        for (let s = 0; s < seg; s++) idx.push(base, base + 2 + s, base + 2 + ((s + 1) % seg));
        for (let s = 0; s < seg; s++) idx.push(base + 1, base + 2 + ((s + 1) % seg), base + 2 + s);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
        color: 0x9fd7ff, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
    });
    const jet = new THREE.Mesh(g, mat);
    jet.frustumCulled = false;
    jet.renderOrder = 9;
    return jet;
}
function makePulsarVisuals(rsKm, period) {
    const spin = new THREE.Group();
    const magnetic = new THREE.Group();
    const star = new THREE.Mesh(
        new THREE.SphereGeometry(12 * K, 24, 16),
        new THREE.MeshBasicMaterial({ color: 0xdfe9ff })
    );
    const beams = makeTdeJet();
    const beamLen = rsKm * K * 2e5;
    beams.material.opacity = 0.5;
    beams.material.color.setHex(0x9fd7ff);
    beams.scale.set(rsKm * K * 9000, beamLen, rsKm * K * 9000);
    beams.rotation.z = 0.6109;
    const emissionRing = new THREE.Sprite(new THREE.SpriteMaterial({
        map: ringTexture("rgba(159,215,255,0.72)", 512, 38),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.22,
    }));
    emissionRing.scale.setScalar(beamLen);
    emissionRing.visible = false;
    magnetic.add(beams);
    spin.add(star, magnetic);
    return { spin, magnetic, star, beams, beamLen, emissionRing, shimmerT: 0, period };
}
function polishCanvasTexture(t, srgb = false) {
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy?.() || 1);
    t.needsUpdate = true;
    return t;
}
function blackCoreTexture(size = 512) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    const c = size * .5;
    const g = ctx.createRadialGradient(c, c, size * .04, c, c, c);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(.52, "rgba(0,0,0,1)");
    g.addColorStop(.78, "rgba(0,0,0,.72)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return polishCanvasTexture(new THREE.CanvasTexture(cv));
}
const BH_PLACE = {
    active: false,
    valid: false,
    point: new THREE.Vector3(),
    xKm: 0,
    yKm: 0,
    uiReady: false,
    uiKey: "",
    sizeRailKey: "",
    kind: 0,
    presetIdx: 0,
    bodyMode: null,
    hintKey: "",
    hintText: "",
    previewKey: "",
    previewT: 0,
    preview: null,
    ctx: null,
    canvas: null,
};
function activePreset() {
    if (BH_PLACE.kind === 0) return { label: bhSizeShort(BH_SIZES[BH.sizeIdx]), rsKm: BH_SIZES[BH.sizeIdx], period: 0 };
    const rows = EXO_PRESETS[BH_PLACE.kind] || [];
    const idx = Math.max(0, Math.min(BH_PLACE.presetIdx, rows.length - 1));
    return rows[idx] || { label: "", rsKm: BH_SIZES[BH.sizeIdx], period: 0 };
}
const placeRaycaster = new THREE.Raycaster();
const placeNdc = new THREE.Vector2();
const placeHit = new THREE.Vector3();
function nebulaPlacementEnabled() {
    return cam.dist > LY_SCENE * .5;
}
function setPlacementRay(clientX = null, clientY = null) {
    const rect = renderer.domElement.getBoundingClientRect();
    const w = rect.width || cvHost.clientWidth || 1;
    const h = rect.height || cvHost.clientHeight || 1;
    const px = Number.isFinite(clientX) ? clientX : lastPtr ? lastPtr[0] : rect.left + w * .5;
    const py = Number.isFinite(clientY) ? clientY : lastPtr ? lastPtr[1] : rect.top + h * .5;
    placeNdc.set(((px - rect.left) / Math.max(1, w)) * 2 - 1, -((py - rect.top) / Math.max(1, h)) * 2 + 1);
    placeRaycaster.setFromCamera(placeNdc, camera);
    return placeRaycaster.ray;
}
function ensureBHPlacementPreview() {
    if (BH_PLACE.preview) return BH_PLACE.preview;
    const g = new THREE.Group();
    g.visible = false;
    const disk = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
            map: ringTexture("rgba(255,184,88,0.72)", 512, 42),
            transparent: true, opacity: .68, depthWrite: false,
            blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        }));
    disk.rotation.x = -Math.PI / 2;
    const horizon = new THREE.Mesh(
        new THREE.SphereGeometry(1, 80, 48),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: .92 }));
    const photon = new THREE.Sprite(new THREE.SpriteMaterial({
        map: ringTexture("rgba(245,232,255,0.9)", 512, 30),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .72,
    }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: dotTexture("rgba(181,156,255,0.32)", "rgba(80,70,210,0.0)"),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .34,
    }));
    const core = new THREE.Sprite(new THREE.SpriteMaterial({
        map: blackCoreTexture(), transparent: true, depthWrite: false, depthTest: false, opacity: .96,
    }));
    core.renderOrder = 30;
    const aim = new THREE.Mesh(
        new THREE.RingGeometry(.84, 1, 96),
        new THREE.MeshBasicMaterial({
            color: 0x9d86ff, transparent: true, opacity: .55,
            depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        }));
    aim.rotation.x = -Math.PI / 2;
    g.add(glow, disk, horizon, photon, core, aim);
    scene.add(g);
    BH_PLACE.preview = { g, disk, horizon, photon, glow, core, aim };
    return BH_PLACE.preview;
}
function cursorPlaneHit(clientX = null, clientY = null, out = placeHit) {
    setPlacementRay(clientX, clientY);
    const dy = placeRaycaster.ray.direction.y;
    if (Math.abs(dy) < 1e-10) return null;
    const t = -placeRaycaster.ray.origin.y / dy;
    if (!isFinite(t) || t <= 0) return null;
    return out.copy(placeRaycaster.ray.origin).addScaledVector(placeRaycaster.ray.direction, t);
}
function updateBHPlacementPreview(dtR = 0) {
    const p = ensureBHPlacementPreview();
    if (!BH_PLACE.active) {
        p.g.visible = false;
        BH_PLACE.valid = false;
        return;
    }
    if (BH_PLACE.kind === 3) {
        const ray = setPlacementRay();
        p.g.visible = false;
        BH_PLACE.valid = nebulaPlacementEnabled();
        BH_PLACE.point.copy(ray.origin).addScaledVector(ray.direction, cam.dist);
        BH_PLACE.xKm = BH_PLACE.point.x / K;
        BH_PLACE.yKm = -BH_PLACE.point.z / K;
        return;
    }
    const hit = cursorPlaneHit(null, null, BH_PLACE.point);
    if (!hit) {
        p.g.visible = false;
        BH_PLACE.valid = false;
        return;
    }
    const preset = activePreset();
    const rs = preset.rsKm;
    const dCam = camera.position.distanceTo(hit);
    const massVis = smooth01(.5, 5000, rs);
    const diskVis = smooth01(50, 100000, rs);
    const visualCore = Math.max(rs * K * 2.2, dCam * (.0018 + .0024 * massVis));
    p.g.visible = true;
    p.g.position.copy(hit);
    p.horizon.scale.setScalar(visualCore);
    p.photon.scale.setScalar(Math.max(rs * K * 4.2, dCam * (.006 + .004 * massVis)));
    p.glow.scale.setScalar(Math.max(rs * K * 9, dCam * (.016 + .012 * massVis)));
    p.core.scale.setScalar(Math.max(rs * K * 4.8, dCam * (.006 + .006 * massVis)));
    p.core.quaternion.copy(camera.quaternion);
    p.disk.scale.setScalar(Math.max(rs * K * 13, dCam * (.018 + .02 * diskVis)));
    p.disk.material.opacity = .14 + diskVis * .58;
    p.disk.rotation.z -= dtR * (.45 + 8 / Math.sqrt(Math.max(.001, rs)));
    p.aim.scale.setScalar(Math.max(rs * K * 18, dCam * (.018 + .012 * massVis)));
    p.aim.material.opacity = .34 + .22 * (0.5 + 0.5 * Math.sin(performance.now() * .006));
    BH_PLACE.valid = true;
    BH_PLACE.xKm = hit.x / K - eph.earthX;
    BH_PLACE.yKm = -hit.z / K - eph.earthY;
}
function ensureBHPanel() {
    if (BH_PLACE.uiReady) return;
    BH_PLACE.uiReady = true;
    BH_PLACE.canvas = document.getElementById("bhPreviewCanvas");
    BH_PLACE.ctx = BH_PLACE.canvas?.getContext("2d") || null;
    const rail = document.getElementById("bhSizeRail");
    if (rail && !document.getElementById("bhKindRail")) {
        const kindRail = document.createElement("div");
        kindRail.id = "bhKindRail";
        kindRail.setAttribute("aria-label", "Exotic object kind selector");
        kindRail.style.display = "grid";
        kindRail.style.gridTemplateColumns = "repeat(4, minmax(0, 1fr))";
        kindRail.style.gap = "5px";
        kindRail.style.marginTop = "11px";
        for (const row of EXO_KINDS) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "bhKindBtn bhSizeBtn";
            b.textContent = row.label;
            b.disabled = !!row.disabled;
            if (row.title) b.title = row.title;
            b.onclick = e => {
                e.preventDefault();
                BH_PLACE.kind = row.kind;
                BH_PLACE.presetIdx = 0;
                setBHPlacementMode(true);
                updateBHPlacementUI(true);
            };
            kindRail.appendChild(b);
        }
        rail.before(kindRail);
    }
}
function renderBHSizeRail() {
    const rail = document.getElementById("bhSizeRail");
    if (!rail) return;
    const railKey = BH_PLACE.kind + ":" + BH_SIZES.length + ":" + (EXO_PRESETS[BH_PLACE.kind]?.length || 0);
    if (railKey === BH_PLACE.sizeRailKey) return;
    BH_PLACE.sizeRailKey = railKey;
    rail.textContent = "";
    const rows = BH_PLACE.kind === 0
        ? BH_SIZES.map((rsKm, i) => ({ label: bhSizeShort(rsKm), rsKm, index: i }))
        : EXO_PRESETS[BH_PLACE.kind] || [];
    for (let i = 0; i < rows.length; i++) {
        const preset = rows[i];
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bhSizeBtn";
        b.textContent = preset.label;
        b.title = BH_PLACE.kind === 3
            ? NEBULA_ARCHETYPES[preset.archetype] + " nebula radius " + (preset.radiusKm / LY_KM).toFixed(0) + " ly"
            : "Schwarzschild radius " + fmtKm(preset.rsKm);
        b.onclick = e => {
            e.preventDefault();
            if (BH_PLACE.kind === 0) BH.sizeIdx = preset.index;
            else BH_PLACE.presetIdx = i;
            setBHPlacementMode(true);
            updateBHPlacementUI(true);
        };
        rail.appendChild(b);
    }
}
function drawBHPanelPreview(rs, active, force = false) {
    ensureBHPanel();
    const cv = BH_PLACE.canvas, ctx = BH_PLACE.ctx;
    if (!cv || !ctx) return;
    const now = performance.now();
    const key = rs + ":" + (active ? 1 : 0) + ":" + cv.width + ":" + cv.height;
    if (!force && key === BH_PLACE.previewKey) {
        if (!active || now - BH_PLACE.previewT < 90) return;
    }
    BH_PLACE.previewKey = key;
    BH_PLACE.previewT = now;
    const w = cv.width, h = cv.height, cx = w * .5, cy = h * .52;
    const massVis = smooth01(.5, 5000, rs);
    const diskVis = smooth01(50, 100000, rs);
    const spin = active ? now * .00055 : 0;
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createRadialGradient(cx, cy, 2, cx, cy, w * .55);
    bg.addColorStop(0, "rgba(78,61,132,.42)");
    bg.addColorStop(.56, "rgba(9,12,20,.92)");
    bg.addColorStop(1, "rgba(3,5,8,.98)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-.18 + spin);
    ctx.scale(1.78, .34);
    const diskR = 30 + diskVis * 38 + massVis * 18;
    const dg = ctx.createRadialGradient(0, 0, diskR * .18, 0, 0, diskR);
    dg.addColorStop(0, "rgba(255,255,255,0)");
    dg.addColorStop(.25, "rgba(255,221,170,.58)");
    dg.addColorStop(.5, "rgba(255,137,57,.32)");
    dg.addColorStop(1, "rgba(108,44,24,0)");
    ctx.fillStyle = dg;
    ctx.beginPath();
    ctx.arc(0, 0, diskR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    const glow = ctx.createRadialGradient(cx, cy, 8, cx, cy, 58 + massVis * 30);
    glow.addColorStop(0, "rgba(191,174,255,.42)");
    glow.addColorStop(.42, "rgba(124,96,255,.16)");
    glow.addColorStop(1, "rgba(42,36,110,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    const coreR = 18 + massVis * 16;
    ctx.fillStyle = "#020205";
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = active ? "rgba(226,217,255,.8)" : "rgba(154,137,210,.42)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 1.38, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = active ? "rgba(220,210,255,.9)" : "rgba(126,138,160,.8)";
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(active ? "ARMED" : "SELECTED", cx, h - 12);
}
function updateBHPlacementUI(force = false) {
    ensureBHPanel();
    renderBHSizeRail();
    if (BH_PLACE.bodyMode !== BH_PLACE.active) {
        document.body.classList.toggle("bh-place-mode", BH_PLACE.active);
        BH_PLACE.bodyMode = BH_PLACE.active;
    }
    const preset = activePreset();
    const rs = preset.rsKm || 0;
    const mu = rs * C_LIGHT * C_LIGHT / 2;
    const msun = mu / MU_S;
    const hint = document.getElementById("bhPlaceHint");
    const updateHint = () => {
        if (!hint) return;
        let hintKey = "", text = "";
        if (BH_PLACE.kind === 3 && NEBULAE.length >= NEB_MAX) {
            hintKey = "neb-max:" + NEBULAE.length;
            text = "Maximum " + NEB_MAX + " nebulae";
        } else if (BH_PLACE.kind !== 3 && BH.n >= BH_MAX) {
            hintKey = "max:" + BH.n;
            text = "Maximum " + BH_MAX + " active holes - V removes the last one";
        } else if (BH_PLACE.kind === 3 && !nebulaPlacementEnabled()) {
            hintKey = "neb-zoom";
            text = "zoom out to interstellar scale to place nebulae";
        } else if (BH_PLACE.kind === 3 && BH_PLACE.active) {
            hintKey = "neb-valid:" + Math.round(cam.dist);
            text = "CLICK TO PLACE - cursor ray range " + fmtDist(cam.dist / K);
        } else if (BH_PLACE.active && BH_PLACE.valid) {
            const dist = Math.hypot(G.x - BH_PLACE.xKm, G.y - BH_PLACE.yKm, G.z);
            const bucket = dist > 1e7 ? Math.round(dist / 10000) * 10000 :
                dist > 1e5 ? Math.round(dist / 100) * 100 :
                Math.round(dist);
            hintKey = "valid:" + bucket;
            text = "CLICK TO PLACE - ship distance " + fmtDist(bucket);
        } else if (BH_PLACE.active) {
            hintKey = "aim";
            text = "AIM AT THE ORBITAL PLANE";
        } else {
            hintKey = "idle";
            text = "B arms placement - size buttons arm it too";
        }
        if (hintKey !== BH_PLACE.hintKey) {
            hint.textContent = text;
            BH_PLACE.hintText = text;
            BH_PLACE.hintKey = hintKey;
        }
    };
    const key = [
        BH_PLACE.active ? 1 : 0,
        BH_PLACE.valid ? 1 : 0,
        BH_PLACE.kind,
        BH_PLACE.presetIdx,
        BH.sizeIdx,
        BH.n,
        NEBULAE.length,
        nebulaPlacementEnabled() ? 1 : 0,
        Array.from({ length: BH.n }, (_, i) => BH.kind[i]).join(","),
        Array.from({ length: BH.n }, (_, i) => Math.round(BH.rs[i] * 1000)).join(","),
    ].join(":");
    if (!force && key === BH_PLACE.uiKey) {
        updateHint();
        drawBHPanelPreview(rs, BH_PLACE.active);
        return;
    }
    BH_PLACE.uiKey = key;
    const pill = document.getElementById("bhModePill");
    const rsEl = document.getElementById("bhRsVal");
    const massEl = document.getElementById("bhMassVal");
    const gravEl = document.getElementById("bhGravityVal");
    if (pill) pill.textContent = BH_PLACE.active ? "ARMED" : "B ARM";
    if (rsEl) rsEl.textContent = BH_PLACE.kind === 3 ? (preset.radiusKm / LY_KM).toFixed(0) + " ly radius" : BH_PLACE.kind === 1 ? (rs / AU_KM).toFixed(2) + " AU" : BH_PLACE.kind === 2 ? "12 km surface" : fmtKm(rs);
    if (massEl) massEl.textContent = BH_PLACE.kind === 3 ? NEBULA_ARCHETYPES[preset.archetype] + " NEBULA" : BH_PLACE.kind === 2 ? bhMassLabel(rs) + " · " + pulsarFactsLabel(preset.period || 0) : bhMassLabel(rs);
    if (gravEl) gravEl.textContent = BH_PLACE.kind === 3
        ? "visual impostor · real cloud mass ~10^2-10^4 M☉ spread over light-years - locally negligible"
        : BH_PLACE.kind === 1
        ? "L_bol ≈ L_Edd = " + (L_EDD_PER_MSUN * msun).toExponential(2) + " W"
        : BH_PLACE.kind === 2 ? "NS surface · " + pulsarAliasLabel(preset.period || 0)
        : gravityPanelLabel(pwAccelMs2(mu, rs * 3, rs));
    updateHint();
    const kindButtons = document.querySelectorAll("#bhKindRail .bhKindBtn");
    kindButtons.forEach((b, i) => {
        const kind = EXO_KINDS[i]?.kind;
        const disabled = kind === 3 && !nebulaPlacementEnabled();
        b.disabled = !!disabled;
        b.title = disabled ? "zoom out to interstellar scale to place nebulae" : (EXO_KINDS[i]?.title || "");
        b.classList.toggle("active", kind === BH_PLACE.kind);
    });
    const buttons = document.querySelectorAll("#bhSizeRail .bhSizeBtn");
    buttons.forEach((b, i) => b.classList.toggle("active", BH_PLACE.kind === 0 ? i === BH.sizeIdx : i === BH_PLACE.presetIdx));
    const list = document.getElementById("bhActiveList");
    if (list) {
        list.textContent = "";
        const count = document.createElement("div");
        count.className = "bhActiveRow bhActiveEmpty";
        count.innerHTML = "<span>ACTIVE</span><strong>" + BH.n + " / " + BH_MAX + "</strong>";
        list.appendChild(count);
        for (let i = 0; i < BH.n; i++) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "bhActiveRow";
            const label = BH.kind[i] === 1 ? "QUASAR " : BH.kind[i] === 2 ? "PULSAR " : "BH ";
            row.innerHTML = "<span>" + label + (i + 1) + "</span><strong>r<sub>s</sub> " + fmtKm(BH.rs[i]) + "</strong>";
            row.onclick = e => {
                e.preventDefault();
                G.focus = "bh:" + i;
                if (BH_META[i]) cam.tgt.copy(BH_META[i].g.position);
                cam.dist = Math.max(cam.dist, Math.max(80, BH.rs[i] * K * 12));
            };
            list.appendChild(row);
        }
    }
    drawBHPanelPreview(rs, BH_PLACE.active, true);
}
export function isBHPlacementMode() { return BH_PLACE.active; }
export function setBHPlacementMode(active) {
    const requested = !!active;
    if (requested && BH_PLACE.kind === 3 && !nebulaPlacementEnabled()) {
        H.toast("zoom out to interstellar scale to place nebulae");
        active = false;
    } else if (requested && BH_PLACE.kind === 3 && NEBULAE.length >= NEB_MAX) {
        H.toast("Maximum " + NEB_MAX + " nebulae");
        active = false;
    } else if (requested && BH_PLACE.kind !== 3 && BH.n >= BH_MAX) {
        H.toast("Maximum " + BH_MAX + " black holes");
        active = false;
    }
    const was = BH_PLACE.active;
    BH_PLACE.active = !!active;
    ensureBHPlacementPreview();
    updateBHPlacementPreview();
    updateBHPlacementUI(true);
    if (was !== BH_PLACE.active) H.toast(BH_PLACE.active ? "Black-hole placement armed · click the orbital plane" : "Black-hole placement off");
}
export function toggleBHPlacementMode() { setBHPlacementMode(!BH_PLACE.active); }
export function cancelBHPlacementMode() {
    if (!BH_PLACE.active) return;
    setBHPlacementMode(false);
}
function commitBHPlacement(clientX, clientY) {
    if (BH_PLACE.kind === 3) {
        if (!nebulaPlacementEnabled()) {
            H.toast("zoom out to interstellar scale to place nebulae");
            return;
        }
        if (NEBULAE.length >= NEB_MAX) {
            H.toast("Maximum " + NEB_MAX + " nebulae");
            return;
        }
        const preset = activePreset();
        const ray = setPlacementRay(clientX, clientY);
        placeHit.copy(ray.origin).addScaledVector(ray.direction, cam.dist);
        const seed = splitSeed(hashInts(0x45584f21, BH.placeCount++), 3);
        const archetype = preset.archetype ?? 0;
        addNebula({
            xKm: placeHit.x / K,
            yKm: -placeHit.z / K,
            zKm: placeHit.y / K,
            radiusKm: preset.radiusKm || nebulaRadiusKmFromPreset(1),
            archetype,
            seed,
        });
        noteNotable("nebula", NEBULA_ARCHETYPES[archetype] + " NEBULA");
        updateBHPlacementPreview();
        updateBHPlacementUI(true);
        return;
    }
    const hit = cursorPlaneHit(clientX, clientY, placeHit);
    if (!hit) {
        H.toast("Aim the cursor at the orbital plane");
        return;
    }
    const preset = activePreset();
    splitSeed(hashInts(0x45584f21, BH.placeCount++), BH_PLACE.kind);
    addBlackHole(hit.x / K - eph.earthX, -hit.z / K - eph.earthY, preset.rsKm, 0, 0, false, null, BH_PLACE.kind, preset.period || 0);
    if (BH.n >= BH_MAX) BH_PLACE.active = false;
    updateBHPlacementPreview();
    updateBHPlacementUI(true);
}
renderer.domElement.addEventListener("pointerdown", e => {
    if (!BH_PLACE.active || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    commitBHPlacement(e.clientX, e.clientY);
}, true);
function buildHoleVisual(i) {
    const rsKm = BH.rs[i], kind = BH.kind[i], period = BH.period[i];
    const g = new THREE.Group();
    g.position.set(BH.sx[i], BH.sy[i], BH.sz[i]);
    const horizon = new THREE.Mesh(new THREE.SphereGeometry(rsKm * K, 128, 96), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    const photon = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture("rgba(255,244,224,0.82)", 512, 34), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .62 }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(168,150,255,0.22)", "rgba(90,90,255,0.08)"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .22 }));
    const hawkGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture("rgba(190,235,255,0.65)", 512, 26), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .18 }));
    const coreMask = new THREE.Sprite(new THREE.SpriteMaterial({ map: blackCoreTexture(), transparent: true, depthWrite: false, depthTest: false, opacity: 1 }));
    coreMask.renderOrder = 20;
    const hawk = makeHawkingPoints(8800 + i * 97);
    const cv = document.createElement("canvas");
    const diskRes = 1024;
    cv.width = cv.height = diskRes;
    const ctx = cv.getContext("2d");
    const dc = diskRes * .5;
    const gr = ctx.createRadialGradient(dc, dc, diskRes * .133, dc, dc, dc);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(.16, "rgba(255,240,210,0.7)");
    gr.addColorStop(.4, "rgba(255,158,66,0.34)");
    gr.addColorStop(.75, "rgba(196,76,28,0.12)");
    gr.addColorStop(1, "rgba(120,40,20,0)");
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, diskRes, diskRes);
    ctx.globalCompositeOperation = "destination-out";
    const rnd2 = mulberry32(1234 + i * 77);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let k = 0; k < 96; k++) {
        ctx.beginPath();
        ctx.lineWidth = diskRes * (.0012 + rnd2() * .0032);
        ctx.strokeStyle = "rgba(0,0,0," + (.055 + rnd2() * .18) + ")";
        const rr = diskRes * (.148 + rnd2() * .344), a0 = rnd2() * Math.PI * 2;
        ctx.arc(dc, dc, rr, a0, a0 + .9 + rnd2() * 3.6);
        ctx.stroke();
    }
    const diskTex = polishCanvasTexture(new THREE.CanvasTexture(cv), true);
    diskTex.center.set(.5, .5);
    const disk = new THREE.Mesh(new THREE.PlaneGeometry(rsKm * K * 13, rsKm * K * 13), new THREE.MeshBasicMaterial({ map: diskTex, transparent: true, opacity: .82, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    disk.rotation.x = -Math.PI / 2;
    const jet = makeTdeJet();
    let pulsar = null, audioObj = null;
    const quasarLights = BH_META.reduce((n, m) => n + (m?.quasarLight ? 1 : 0), 0);
    let quasarLight = null;
    if (kind === 1) {
        disk.scale.setScalar(2.2);
        jet.scale.set(rsKm * K * .45, rsKm * K * 30, rsKm * K * .45);
        // Cap quasar point lights at two on desktop; mobile uses the additive sprites only.
        if (!renderQuality.mobile && quasarLights < 2) {
            quasarLight = new THREE.PointLight(0xcfe0ff, 4.0, BH.sinkS[i] * 600, 2);
            g.add(quasarLight);
        }
    }
    if (kind === 2) {
        pulsar = makePulsarVisuals(rsKm, period);
        glow.material.map = dotTexture("rgba(210,235,255,0.36)", "rgba(75,150,255,0.0)");
        glow.material.opacity = .34;
        audioObj = { x: 0, y: 0, z: 0, name: "PLACED PULSAR" };
        registerPlacedPulsar(audioObj, period);
        g.add(glow, pulsar.spin, pulsar.emissionRing);
    } else {
        g.add(disk, horizon, photon, glow, hawkGlow, hawk, jet, coreMask);
    }
    scene.add(g);
    return {
        g, disk, diskBaseRs: rsKm, jet: kind === 2 ? null : jet, quasarLight, horizon, photon, glow, hawkGlow, hawk, coreMask, tex: diskTex, rs: rsKm, flare: 0,
        pulsar, audioObj,
    };
}
function disposeHoleVisual(m) {
    if (!m) return;
    if (m.audioObj) unregisterPlacedPulsar(m.audioObj);
    scene.remove(m.g);
    m.g.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
}
// data-layer callbacks (bhEncounters.js owns the hole arrays)
function onHoleRemoved(i) {
    const m = BH_META.splice(i, 1)[0];
    disposeHoleVisual(m);
}
function onHoleMerged(i) {
    disposeHoleVisual(BH_META[i]);
    BH_META[i] = buildHoleVisual(i);
    if (BH_META[i]) BH_META[i].flare = 1;
}
function onHoleResized(i) {
    refreshBHSize(i, BH.rs[i]);
    if (BH_META[i]) BH_META[i].flare = 1;
}
initEncounterHooks({ onRemove: onHoleRemoved, onMerged: onHoleMerged, onResize: onHoleResized });

export function addBlackHole(xKm, yKm, rsKm, vx0 = 0, vy0 = 0, quiet = false, events = null, kind = 0, period = 0, zKm = 0, vz0 = 0) {
    if (BH.n >= BH_MAX) { if (!quiet) H.toast("Maximum " + BH_MAX + " black holes"); return -1; }
    const i = addHoleData(xKm, yKm, rsKm, vx0, vy0, events, kind, period, zKm, vz0);
    if (i < 0) return -1;
    BH_META[i] = buildHoleVisual(i);
    if (quiet) return i;
    if (kind === 1) noteNotable("quasar", "QUASAR " + bhMassLabel(rsKm));
    if (kind === 2) noteNotable("pulsar", "PULSAR " + pulsarFactsLabel(period));
    H.toast(kind === 2
        ? "PULSAR: " + pulsarFactsLabel(period) + " · 12 km surface · " + bhMassLabel(rsKm)
        : "⚫ Black hole: r_s " + fmtKm(rsKm) + " · " + bhMassLabel(rsKm) + " · " + bhHawkingLabel(rsKm));
    H.predict();
    return i;
}
function removeBHIndex(i) {
    removeHoleData(i);
}
export function removeLastBH() {
    if (!BH.n) { H.toast("No black holes placed"); return; }
    removeBHIndex(BH.n - 1);
    H.toast("Black hole removed");
    H.predict();
}
export function clearBlackHoles() {
    while (BH.n > 0) removeBHIndex(BH.n - 1);
    // visuals left behind by a partial reset (e.g. a harness zeroing BH.n)
    while (BH_META.length) disposeHoleVisual(BH_META.pop());
}
function refreshBHSize(i, rs) {
    const m = BH_META[i];
    if (!m) return;
    const oldRs = Math.max(1e-9, m.rs);
    const ratio = rs / oldRs;
    m.rs = rs;
    if (m.horizon) m.horizon.scale.multiplyScalar(ratio);
    if (m.disk) m.disk.scale.multiplyScalar(ratio);
}
export function placeBHAtCursor() {
    const p = cursorPlaneHit();
    if (!p) { H.toast("Aim the cursor at the orbital plane"); return; }
    const preset = activePreset();
    splitSeed(hashInts(0x45584f21, BH.placeCount++), BH_PLACE.kind);
    addBlackHole(p.x / K - eph.earthX, -p.z / K - eph.earthY, preset.rsKm, 0, 0, false, null, BH_PLACE.kind, preset.period || 0);
}
window.__addBH = addBlackHole; // debug/testing handle

function lapseAt(rKm, rsKm) {
    const r = Math.max(rsKm * 1.002, rKm);
    return Math.sqrt(Math.max(.012, 1 - rsKm / r));
}
export function observerTimeScaleForBH(bi, scenePos = null) {
    if (bi < 0 || bi >= BH.n) return 1;
    const p = scenePos || BH_META[bi]?.g.position;
    if (!p) return 1;
    const obsR = Math.max(BH.rs[bi] * 1.002, camera.position.distanceTo(p) / K);
    const eventR = Math.max(BH.rs[bi] * 1.08, BH.rs[bi] + 1e-6);
    return clamp(lapseAt(eventR, BH.rs[bi]) / lapseAt(obsR, BH.rs[bi]), .08, 2.4);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
// strongest running flare on hole bi (coordinate time)
function holeFlare(bi, t) {
    let best = null, bestL = 0;
    for (let k = 0; k < TDES.length; k++) {
        const d = TDES[k];
        if (d.bh !== bi || !d.active) continue;
        const L = tdeLuminosityW(t - d.t0, d.tFb, d.mStarKg, d.mBhMsun);
        if (!best || L > bestL) { best = d; bestL = L; }
    }
    _flare.tde = best; _flare.L = bestL;
    return _flare;
}
const _flare = { tde: null, L: 0 };
export function updateBHVisuals(dtR, earthScX = 0, earthScZ = 0) {
    updateBHPlacementPreview(dtR);
    updateBHPlacementUI();
    for (let bi = 0; bi < BH_META.length && bi < BH.n; bi++) {
        const m = BH_META[bi];
        if (!m) continue;
        m.g.position.set(earthScX + BH.sx[bi], BH.sy[bi], earthScZ + BH.sz[bi]);
        if (m.rs !== BH.rs[bi]) refreshBHSize(bi, BH.rs[bi]);
        if (m.audioObj) {
            m.audioObj.x = eph.earthX + BH.x[bi];
            m.audioObj.y = eph.earthY + BH.y[bi];
            m.audioObj.z = BH.z[bi];
        }
        const dBH = camera.position.distanceTo(m.g.position);
        const obsRate = observerTimeScaleForBH(bi, m.g.position);
        BH.obsT[bi] = obsRate;
        const dtLocal = dtR * obsRate;
        m.flare = Math.max(0, m.flare - dtLocal * .55);
        const massVis = smooth01(.5, 5000, m.rs);
        const diskVis = smooth01(50, 100000, m.rs);
        if (BH.kind[bi] === 2 && m.pulsar) {
            const p = Math.max(1e-9, BH.period[bi]);
            const spinAngle = (G.t % p) / p * Math.PI * 2;
            const aliased = pulsarAliased(p);
            m.pulsar.spin.rotation.y = spinAngle;
            m.pulsar.beams.visible = !aliased;
            m.pulsar.emissionRing.visible = aliased;
            m.pulsar.shimmerT += dtR;
            // Render-only 2 Hz shimmer marks time-average mode; it is not the real spin period.
            const shimmer = 1 + 0.06 * Math.sin(m.pulsar.shimmerT * PULSAR_ALIAS_SHIMMER_HZ * Math.PI * 2);
            m.pulsar.emissionRing.scale.setScalar(m.pulsar.beamLen * shimmer);
            m.pulsar.emissionRing.material.opacity = aliased ? 0.22 * shimmer : 0;
            m.glow.scale.setScalar(Math.max(12 * K * 24, dBH * .006));
            m.glow.material.opacity = .24 * (aliased ? shimmer : 1);
            continue;
        }
        const fl = holeFlare(bi, G.t);
        const lum = fl.tde ? clamp(fl.L / Math.max(1e-30, fl.tde.LEddW), 0, 1) : 0;
        const screenRing = dBH * (.0026 + .002 * massVis);
        m.photon.scale.setScalar(Math.max(m.rs * K * 4.2, screenRing));
        m.glow.scale.setScalar(Math.max(m.rs * K * 8, dBH * (.0035 + .0055 * massVis)));
        const hot = Math.min(1, Math.max(.14, Math.pow(1000 / Math.max(1, m.rs), .34)));
        const flare = m.flare * m.flare;
        const tdeFlare = Math.max(flare, lum);
        const baseDiskScale = m.rs / Math.max(1e-9, m.diskBaseRs);
        const circScale = fl.tde && fl.tde.rCirc > 0
            ? clamp((fl.tde.rCirc * K * .5) / Math.max(1e-9, m.diskBaseRs * K * 6.5), baseDiskScale, baseDiskScale * 8)
            : baseDiskScale;
        m.disk.scale.setScalar(circScale * (BH.kind[bi] === 1 ? 2.2 : 1) * (1 + lum * .38));
        let targetOpacity = .045 + diskVis * .6 + lum * .5 + (fl.tde ? 0 : flare * .28);
        if (BH.kind[bi] === 1) targetOpacity = Math.max(targetOpacity, 0.85);
        m.disk.material.opacity = targetOpacity;
        m.glow.material.opacity = .025 + hot * (.025 + .075 * massVis) + flare * .24 + lum * .4;
        const hVis = Math.max(m.rs * K * 5.5, dBH * (.0015 + .0018 * massVis));
        m.hawk.scale.setScalar(hVis);
        m.hawk.rotation.y += dtLocal * (1.4 + hot * 4.8);
        m.hawk.rotation.z -= dtLocal * (.35 + hot * 1.2);
        m.hawk.material.opacity = (.018 + hot * .055) * (.35 + .65 * massVis) + flare * .08 + lum * .16;
        m.hawk.material.size = Math.max(.0025, dBH * (.00018 + .00018 * massVis)) * (.65 + hot * .35);
        m.hawkGlow.scale.setScalar(Math.max(m.rs * K * (4.6 + tdeFlare * 5), dBH * (.0022 + .0035 * massVis + tdeFlare * .004)));
        m.hawkGlow.material.opacity = .015 + hot * (.018 + .052 * massVis) * (0.65 + 0.35 * Math.sin(performance.now() * .004 + bi)) + flare * .22 + lum * .4;
        if (m.jet) {
            const jetOp = BH.kind[bi] === 1 ? 0.55 : lum > .8 ? .3 * (lum - .8) / .2 : 0;
            m.jet.material.opacity = jetOp;
            const jetLen = BH.kind[bi] === 1 ? m.rs * K * 30 : Math.max(m.rs * K * 7, dBH * (.02 + .04 * lum));
            const jetRad = Math.max(m.rs * K * .45, dBH * .0012);
            m.jet.scale.set(jetRad, jetLen, jetRad);
            m.jet.visible = jetOp > .001;
        }
        if (m.coreMask) {
            m.coreMask.scale.setScalar(Math.max(m.rs * K * 3, dBH * (.0025 + .0045 * massVis)));
            m.coreMask.material.opacity = 1;
            m.coreMask.quaternion.copy(camera.quaternion);
        }
        m.tex.rotation -= dtLocal * (.25 + 9 / Math.sqrt(m.rs));
    }
}
