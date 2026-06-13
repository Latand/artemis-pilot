import * as THREE from "three";
import { BH_MAX, BH_SIZES, C_LIGHT, MU_E, MU_M, MU_S, R_EARTH, R_MOON, R_SUN, PL, K } from "./constants.js";
import { G, BH, WORLD, EPHT, bhRegister, bhMuAt, gsPull, addPhantom } from "./state.js";
import { eph, setLiveGuard } from "./ephemeris.js";
import { fmtAccel, fmtDist, fmtKm, mulberry32 } from "./format.js";
import { dotTexture, ringTexture } from "./textures.js";
import { scene, camera, cam, cvHost, lastPtr, renderer } from "./scene.js";

export const BH_META = []; // visual groups, parallel to the data arrays

let H = {
    toast: () => { }, predict: () => { }, cataclysm: () => { },
    disrupt: () => "", absorbed: () => { },
};
export function initBHHooks(hooks) { H = { ...H, ...hooks }; }

const SOLAR_MASS_KG = 1.98847e30;
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
function makeSpaghettificationStream(seed) {
    const N = 920, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const phase = new Float32Array(N), lane = new Float32Array(N), jitter = new Float32Array(N);
    const rnd = mulberry32(seed);
    for (let i = 0; i < N; i++) {
        pos[i * 3] = 0; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = 0;
        phase[i] = rnd() * Math.PI * 2;
        lane[i] = rnd() < .5 ? -1 : 1;
        jitter[i] = rnd();
        col[i * 3] = .58;
        col[i * 3 + 1] = .36;
        col[i * 3 + 2] = .22;
    }
    const g = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(pos, 3);
    const colAttr = new THREE.BufferAttribute(col, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    colAttr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", attr);
    g.setAttribute("color", colAttr);
    const mat = new THREE.PointsMaterial({
        size: .035, vertexColors: true, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
        map: dotTexture("rgba(255,245,218,1)", "rgba(255,110,30,0.0)"),
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 7;
    const arms = 5, segs = 112;
    const linePos = new Float32Array(arms * (segs - 1) * 2 * 3);
    const lineG = new THREE.BufferGeometry();
    const lineAttr = new THREE.BufferAttribute(linePos, 3);
    lineAttr.setUsage(THREE.DynamicDrawUsage);
    lineG.setAttribute("position", lineAttr);
    const lines = new THREE.LineSegments(lineG, new THREE.LineBasicMaterial({
        color: 0xd7b073, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    lines.frustumCulled = false;
    lines.renderOrder = 6;
    const remnantUniforms = {
        uRock: { value: new THREE.Color(0x9b8068) },
        uHeat: { value: 0 },
        uAlpha: { value: 0 },
    };
    const remnant = new THREE.Mesh(new THREE.SphereGeometry(1, 72, 48), new THREE.ShaderMaterial({
        uniforms: remnantUniforms,
        transparent: true, depthWrite: false,
        vertexShader: /* glsl */`
            varying vec3 vN; varying vec3 vP;
            void main(){
                vN = normalize(normalMatrix * normal);
                vP = position;
                vec3 p = position;
                float pinch = smoothstep(-.25, .9, p.x);
                p.yz *= mix(1.0, .52, pinch);
                vec4 mv = modelViewMatrix * vec4(p, 1.0);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            uniform vec3 uRock; uniform float uHeat; uniform float uAlpha;
            varying vec3 vN; varying vec3 vP;
            float hash(vec3 p){ return fract(sin(dot(p, vec3(17.13, 71.91, 43.27))) * 43758.5453); }
            void main(){
                float grain = hash(floor((vP + 1.0) * 18.0));
                float nose = smoothstep(.05, 1.0, vP.x);
                float rim = pow(1.0 - abs(vN.z) * .55 - abs(vN.y) * .25, 2.0);
                vec3 hot = mix(vec3(1.0, .32, .06), vec3(1.0, .86, .56), nose);
                vec3 col = mix(uRock * (.72 + grain * .32), hot, clamp(uHeat * (.25 + nose * .75), 0.0, 1.0));
                col += vec3(1.0, .42, .12) * rim * uHeat * .35;
                gl_FragColor = vec4(col, uAlpha);
            }`,
    }));
    remnant.frustumCulled = false;
    remnant.renderOrder = 5;
    const fragCount = 210;
    const fragGeo = new THREE.DodecahedronGeometry(1, 0);
    const fragMat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const fragments = new THREE.InstancedMesh(fragGeo, fragMat, fragCount);
    fragments.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    fragments.frustumCulled = false;
    fragments.renderOrder = 8;
    const fragPhase = new Float32Array(fragCount);
    const fragQ = new Float32Array(fragCount);
    const fragLane = new Float32Array(fragCount);
    const fragSize = new Float32Array(fragCount);
    const c = new THREE.Color();
    for (let i = 0; i < fragCount; i++) {
        fragPhase[i] = rnd() * Math.PI * 2;
        fragQ[i] = Math.pow(rnd(), .7);
        fragLane[i] = rnd() < .5 ? -1 : 1;
        fragSize[i] = .35 + rnd() * 1.4;
        fragments.setColorAt(i, c.setRGB(.6, .38, .22));
    }
    if (fragments.instanceColor) fragments.instanceColor.needsUpdate = true;
    const group = new THREE.Group();
    group.add(lines, remnant, pts, fragments);
    return {
        group, pts, pos, col, attr, colAttr, mat, seed,
        phase, lane, jitter, lines, linePos, lineAttr,
        remnant, remnantUniforms, fragments, fragPhase, fragQ, fragLane, fragSize,
    };
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
    preview: null,
    ctx: null,
    canvas: null,
};
const placeRaycaster = new THREE.Raycaster();
const placeNdc = new THREE.Vector2();
const placeHit = new THREE.Vector3();
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
    const rect = renderer.domElement.getBoundingClientRect();
    const w = rect.width || cvHost.clientWidth || 1;
    const h = rect.height || cvHost.clientHeight || 1;
    const px = Number.isFinite(clientX) ? clientX : lastPtr ? lastPtr[0] : rect.left + w * .5;
    const py = Number.isFinite(clientY) ? clientY : lastPtr ? lastPtr[1] : rect.top + h * .5;
    placeNdc.set(((px - rect.left) / Math.max(1, w)) * 2 - 1, -((py - rect.top) / Math.max(1, h)) * 2 + 1);
    placeRaycaster.setFromCamera(placeNdc, camera);
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
    const hit = cursorPlaneHit(null, null, BH_PLACE.point);
    if (!hit) {
        p.g.visible = false;
        BH_PLACE.valid = false;
        return;
    }
    const rs = BH_SIZES[BH.sizeIdx];
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
    if (rail) {
        rail.textContent = "";
        for (let i = 0; i < BH_SIZES.length; i++) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "bhSizeBtn";
            b.textContent = bhSizeShort(BH_SIZES[i]);
            b.title = "Schwarzschild radius " + fmtKm(BH_SIZES[i]);
            b.onclick = e => {
                e.preventDefault();
                BH.sizeIdx = i;
                setBHPlacementMode(true);
                updateBHPlacementUI(true);
            };
            rail.appendChild(b);
        }
    }
}
function drawBHPanelPreview(rs, active) {
    ensureBHPanel();
    const cv = BH_PLACE.canvas, ctx = BH_PLACE.ctx;
    if (!cv || !ctx) return;
    const w = cv.width, h = cv.height, cx = w * .5, cy = h * .52;
    const massVis = smooth01(.5, 5000, rs);
    const diskVis = smooth01(50, 100000, rs);
    const spin = performance.now() * .00055;
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
    document.body.classList.toggle("bh-place-mode", BH_PLACE.active);
    const rs = BH_SIZES[BH.sizeIdx];
    const mu = rs * C_LIGHT * C_LIGHT / 2;
    const hint = document.getElementById("bhPlaceHint");
    const updateHint = () => {
        if (!hint) return;
        if (BH.n >= BH_MAX) hint.textContent = "Maximum " + BH_MAX + " active holes · V removes the last one";
        else if (BH_PLACE.active && BH_PLACE.valid) hint.textContent = "CLICK TO PLACE · ship distance " + fmtDist(Math.hypot(G.x - BH_PLACE.xKm, G.y - BH_PLACE.yKm, G.z));
        else if (BH_PLACE.active) hint.textContent = "AIM AT THE ORBITAL PLANE";
        else hint.textContent = "B arms placement · size buttons arm it too";
    };
    const key = [
        BH_PLACE.active ? 1 : 0,
        BH_PLACE.valid ? 1 : 0,
        BH.sizeIdx,
        BH.n,
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
    if (rsEl) rsEl.textContent = fmtKm(rs);
    if (massEl) massEl.textContent = bhMassLabel(rs);
    if (gravEl) gravEl.textContent = gravityPanelLabel(pwAccelMs2(mu, rs * 3, rs));
    updateHint();
    const buttons = document.querySelectorAll(".bhSizeBtn");
    buttons.forEach((b, i) => b.classList.toggle("active", i === BH.sizeIdx));
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
            row.innerHTML = "<span>BH " + (i + 1) + "</span><strong>r<sub>s</sub> " + fmtKm(BH.rs[i]) + "</strong>";
            row.onclick = e => {
                e.preventDefault();
                G.focus = "bh:" + i;
                if (BH_META[i]) cam.tgt.copy(BH_META[i].g.position);
                cam.dist = Math.max(cam.dist, Math.max(80, BH.rs[i] * K * 12));
            };
            list.appendChild(row);
        }
    }
    drawBHPanelPreview(rs, BH_PLACE.active);
}
export function isBHPlacementMode() { return BH_PLACE.active; }
export function setBHPlacementMode(active) {
    const requested = !!active;
    if (requested && BH.n >= BH_MAX) {
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
    const hit = cursorPlaneHit(clientX, clientY, placeHit);
    if (!hit) {
        H.toast("Aim the cursor at the orbital plane");
        return;
    }
    addBlackHole(hit.x / K - eph.earthX, -hit.z / K - eph.earthY, BH_SIZES[BH.sizeIdx]);
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
export function addBlackHole(xKm, yKm, rsKm, vx0 = 0, vy0 = 0, quiet = false, events = null) {
    if (BH.n >= BH_MAX) { if (!quiet) H.toast("Maximum " + BH_MAX + " black holes"); return -1; }
    const i = BH.n;
    bhRegister(i, xKm, yKm, rsKm, vx0, vy0, events);
    const g = new THREE.Group();
    g.position.set(BH.sx[i], 0, BH.sz[i]);
    const horizon = new THREE.Mesh(new THREE.SphereGeometry(rsKm * K, 128, 96), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    const photon = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture("rgba(255,244,224,0.82)", 512, 34), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .62 }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(168,150,255,0.22)", "rgba(90,90,255,0.08)"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .22 }));
    const hawkGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture("rgba(190,235,255,0.65)", 512, 26), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .18 }));
    const coreMask = new THREE.Sprite(new THREE.SpriteMaterial({ map: blackCoreTexture(), transparent: true, depthWrite: false, depthTest: false, opacity: 1 }));
    coreMask.renderOrder = 20;
    const hawk = makeHawkingPoints(8800 + i * 97);
    const spag = makeSpaghettificationStream(17000 + i * 173);
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
    g.add(disk, horizon, photon, glow, hawkGlow, hawk, spag.group, coreMask);
    scene.add(g);
    BH_META.push({ g, disk, horizon, photon, glow, hawkGlow, hawk, spag, coreMask, tex: diskTex, rs: rsKm, flare: 0 });
    BH.n++;
    if (quiet) return i;
    H.toast("⚫ Black hole: r_s " + fmtKm(rsKm) + " · " + bhMassLabel(rsKm) + " · " + bhHawkingLabel(rsKm));
    H.predict();
    return i;
}
function removeBHIndex(i) {
    for (let k = DISRUPT.length - 1; k >= 0; k--) {
        if (DISRUPT[k].bh === i) DISRUPT.splice(k, 1);
        else if (DISRUPT[k].bh > i) DISRUPT[k].bh--;
    }
    const m = BH_META.splice(i, 1)[0];
    scene.remove(m.g);
    m.g.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
    for (let k = i; k < BH.n - 1; k++) {
        BH.x[k] = BH.x[k + 1]; BH.y[k] = BH.y[k + 1];
        BH.vx[k] = BH.vx[k + 1]; BH.vy[k] = BH.vy[k + 1];
        BH.mu[k] = BH.mu[k + 1]; BH.rs[k] = BH.rs[k + 1];
        BH.sx[k] = BH.sx[k + 1]; BH.sz[k] = BH.sz[k + 1];
        BH.c[k] = BH.c[k + 1]; BH.sinkS[k] = BH.sinkS[k + 1];
        BH.obsT[k] = BH.obsT[k + 1];
        BH.ev[k] = BH.ev[k + 1];
    }
    BH.ev[BH.n - 1] = null;
    BH.n--;
}
export function removeLastBH() {
    if (!BH.n) { H.toast("No black holes placed"); return; }
    removeBHIndex(BH.n - 1);
    H.toast("Black hole removed");
    H.predict();
}
export function clearBlackHoles() {
    while (BH.n > 0) removeBHIndex(BH.n - 1);
}

// ---- black-hole dynamics ----
// Holes free-fall in the same Earth-relative n-body frame as the ship and
// planets, then attract each other via the Paczyński-Wiita acceleration.
// Close pairs merge, conserving momentum.
let _bax = 0, _bay = 0;
// rsI: the hole's Schwarzschild radius — the body→hole pull uses the same
// PW softening as the hole→body pull, so the pair obeys action–reaction
// (asymmetric laws pumped momentum into the frame and skewed the whole map)
function bodyPull(x, y, bx, by, mu, rsI) {
    const dx = x - bx, dy = y - by;
    const d = Math.sqrt(Math.max(1e-18, dx * dx + dy * dy));
    const eff = Math.max(d - rsI, rsI * .02);
    const w = mu / (eff * eff * d);
    _bax -= w * dx;
    _bay -= w * dy;
    if (!WORLD.earthDestroyed) {
        const r02 = Math.max(1e-18, bx * bx + by * by);
        const w0 = mu / (r02 * Math.sqrt(r02)); // indirect: pull on the frame origin
        _bax -= w0 * bx;
        _bay -= w0 * by;
    }
}
const _gp = [0, 0, 0];
// `tau` offsets body positions from the live ephemeris (holes integrate over
// the interval just *behind* the freshly advanced bodies, so tau ≤ 0).
function bhAccel(i, X, Y, tau, out) {
    const x = X[i], y = Y[i];
    const tEval = EPHT.t + tau;
    const rsI = BH.rs[i];
    _bax = 0; _bay = 0;
    if (!WORLD.earthDestroyed) {
        const r = Math.sqrt(Math.max(1e-18, x * x + y * y));
        const eff = Math.max(r - rsI, rsI * .02);
        const w = MU_E / (eff * eff * r);
        _bax -= w * x; _bay -= w * y;
    }
    if (!WORLD.moonDestroyed) bodyPull(x, y, eph.moonX + eph.moonVx * tau, eph.moonY + eph.moonVy * tau, MU_M, rsI);
    if (!WORLD.sunDestroyed) bodyPull(x, y, eph.sunX + eph.sunVx * tau, eph.sunY + eph.sunVy * tau, MU_S, rsI);
    for (let p = 0; p < PL.length; p++)
        if (!WORLD.plDestroyed[p]) bodyPull(x, y, eph.plX[p] + eph.plVx[p] * tau, eph.plY[p] + eph.plVy[p] * tau, PL[p].mu, rsI);
    // phantom debris & ghost shells pull the hole too
    _gp[0] = 0; _gp[1] = 0; _gp[2] = 0;
    gsPull(x, y, 0, tEval, _gp);
    let ax = _bax + _gp[0], ay = _bay + _gp[1];
    if (!WORLD.earthDestroyed) {
        _gp[0] = 0; _gp[1] = 0; _gp[2] = 0;
        gsPull(0, 0, 0, tEval, _gp);
        ax -= _gp[0]; ay -= _gp[1];
    }
    for (let j = 0; j < BH.n; j++) {
        if (j !== i) {
            const dx = x - X[j], dy = y - Y[j];
            const d = Math.sqrt(dx * dx + dy * dy);
            const mu = bhMuAt(j, x, y, 0, tEval);
            if (mu > 0) {
                // shared pair softening so unequal holes obey action–reaction
                const rsP = rsI + BH.rs[j];
                const eff = Math.max(d - rsP, rsP * .02);
                const am = mu / (eff * eff) / Math.max(1e-9, d);
                ax -= dx * am; ay -= dy * am;
            }
        }
        // indirect: every hole accelerates the Earth-centered frame origin
        if (!WORLD.earthDestroyed) {
            const mu0 = bhMuAt(j, 0, 0, 0, tEval);
            if (mu0 > 0) {
                const r0 = Math.sqrt(X[j] * X[j] + Y[j] * Y[j]);
                const eff0 = Math.max(r0 - BH.rs[j], BH.rs[j] * .02);
                const am0 = mu0 / (eff0 * eff0) / Math.max(1e-9, r0);
                ax -= X[j] * am0; ay -= Y[j] * am0;
            }
        }
    }
    out[0] = ax; out[1] = ay;
}
const _ba = [0, 0];
const _k = [];
for (let s = 0; s < 4; s++) _k.push({ x: new Float64Array(BH_MAX), y: new Float64Array(BH_MAX), vx: new Float64Array(BH_MAX), vy: new Float64Array(BH_MAX) });
function bhDerivAll(tau, X, Y, VX, VY, K_) {
    for (let i = 0; i < BH.n; i++) {
        bhAccel(i, X, Y, tau, _ba);
        K_.x[i] = VX[i]; K_.y[i] = VY[i];
        K_.vx[i] = _ba[0]; K_.vy[i] = _ba[1];
    }
}
const _sx = new Float64Array(BH_MAX), _sy = new Float64Array(BH_MAX), _svx = new Float64Array(BH_MAX), _svy = new Float64Array(BH_MAX);
function bhRk4(tau0, dt) {
    const N = BH.n;
    bhDerivAll(tau0, BH.x, BH.y, BH.vx, BH.vy, _k[0]);
    for (const [f, kPrev, kCur] of [[.5, 0, 1], [.5, 1, 2], [1, 2, 3]]) {
        for (let i = 0; i < N; i++) {
            _sx[i] = BH.x[i] + f * dt * _k[kPrev].x[i];
            _sy[i] = BH.y[i] + f * dt * _k[kPrev].y[i];
            _svx[i] = BH.vx[i] + f * dt * _k[kPrev].vx[i];
            _svy[i] = BH.vy[i] + f * dt * _k[kPrev].vy[i];
        }
        bhDerivAll(tau0 + f * dt, _sx, _sy, _svx, _svy, _k[kCur]);
    }
    for (let i = 0; i < N; i++) {
        BH.x[i] += dt / 6 * (_k[0].x[i] + 2 * _k[1].x[i] + 2 * _k[2].x[i] + _k[3].x[i]);
        BH.y[i] += dt / 6 * (_k[0].y[i] + 2 * _k[1].y[i] + 2 * _k[2].y[i] + _k[3].y[i]);
        BH.vx[i] += dt / 6 * (_k[0].vx[i] + 2 * _k[1].vx[i] + 2 * _k[2].vx[i] + _k[3].vx[i]);
        BH.vy[i] += dt / 6 * (_k[0].vy[i] + 2 * _k[1].vy[i] + 2 * _k[2].vy[i] + _k[3].vy[i]);
    }
}
function tryMerge() {
    for (let i = 0; i < BH.n; i++)
        for (let j = i + 1; j < BH.n; j++) {
            const dx = BH.x[i] - BH.x[j], dy = BH.y[i] - BH.y[j];
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < (BH.rs[i] + BH.rs[j]) * 1.2) {
                const muI = BH.mu[i], muJ = BH.mu[j], muTotal = muI + muJ;
                const x = (BH.x[i] * muI + BH.x[j] * muJ) / muTotal;
                const y = (BH.y[i] * muI + BH.y[j] * muJ) / muTotal;
                const vx = (BH.vx[i] * muI + BH.vx[j] * muJ) / muTotal;
                const vy = (BH.vy[i] * muI + BH.vy[j] * muJ) / muTotal;
                const eta = muI * muJ / (muTotal * muTotal);
                const gwLossFrac = clamp(.192 * eta, 0, .06);
                const muLoss = muTotal * gwLossFrac;
                const mu = muTotal - muLoss;
                const rs = 2 * mu / (C_LIGHT * C_LIGHT);
                const ev = BH.ev[i].concat(BH.ev[j]);
                if (muLoss > 0) ev.push({ x, y, z: 0, t: EPHT.t, dmu: -muLoss });
                removeBHIndex(j); removeBHIndex(i);
                addBlackHole(x, y, rs, vx, vy, false, ev);
                H.toast("⚫ Black-hole merger → r_s " + fmtKm(rs) + " · GW loss " + (gwLossFrac * 100).toFixed(1) + "%");
                return true;
            }
        }
    return false;
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
function absorbBody(i, target, x, y, vx, vy, muBody) {
    const mu0 = BH.mu[i], mu = mu0 + muBody;
    if (mu <= mu0) return;
    BH.x[i] = (BH.x[i] * mu0 + x * muBody) / mu;
    BH.y[i] = (BH.y[i] * mu0 + y * muBody) / mu;
    BH.vx[i] = (BH.vx[i] * mu0 + vx * muBody) / mu;
    BH.vy[i] = (BH.vy[i] * mu0 + vy * muBody) / mu;
    BH.mu[i] = mu;
    BH.ev[i].push({ x, y, z: 0, t: EPHT.t, dmu: muBody }); // mass gain spreads at c
    BH.rs[i] = 2 * mu / (C_LIGHT * C_LIGHT);
    BH.c[i] = .001 * Math.sqrt(2 * BH.mu[i] / 1000);
    BH.sinkS[i] = BH.rs[i] * K;
    BH.sx[i] = BH.x[i] * K;
    BH.sz[i] = -BH.y[i] * K;
    refreshBHSize(i, BH.rs[i]);
    if (BH_META[i]) BH_META[i].flare = 1;
    H.absorbed(target, BH.rs[i], i);
}
function bhBodyLimit(rs, radius, muBody, muBH) {
    const roche = radius * Math.cbrt(muBH / Math.max(1e-9, muBody));
    const tidal = Math.min(radius * 18, roche * .55);
    return Math.max(radius + rs * 2.2, tidal);
}
// disruption limits depend only on the hole's μ (and body constants), so they
// are cached and recomputed only after a merge or absorption changes the mass.
// Keyed on μ, the cache stays valid even when removeBHIndex shifts the arrays.
const _limCache = [];
function bhLimits(i) {
    let c = _limCache[i];
    if (!c) { c = { mu: -1, pl: new Float64Array(PL.length) }; _limCache[i] = c; }
    if (c.mu !== BH.mu[i]) {
        const mu = BH.mu[i], rs = BH.rs[i];
        c.mu = mu;
        c.earth = bhBodyLimit(rs, R_EARTH, MU_E, mu);
        c.moon = bhBodyLimit(rs, R_MOON, MU_M, mu);
        c.sun = bhBodyLimit(rs, R_SUN, MU_S, mu);
        for (let p = 0; p < PL.length; p++) c.pl[p] = bhBodyLimit(rs, PL[p].R, PL[p].mu, mu);
    }
    return c;
}
const DISRUPT = [];
window.__BH_DISRUPT = DISRUPT;
function targetLabel(target) {
    return target === "earth" ? "Earth" :
        target === "moon" ? "Moon" :
            target === "sun" ? "Sun" :
                typeof target === "number" && PL[target] ? PL[target].name : "Body";
}
function sameTarget(a, b) { return a === b; }
function isDisrupting(target) {
    return DISRUPT.some(d => sameTarget(d.target, target));
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function targetDisruptionColor(target) {
    if (target === "earth") return 0x4d78a8;
    if (target === "moon") return 0x9b9a93;
    if (target === "sun") return 0xff8a22;
    if (typeof target === "number" && PL[target]) return PL[target].color;
    return 0x9b8068;
}
function disruptionDuration(radius, dist, muBH, muBody, rel) {
    const r = Math.max(1, dist);
    const tidalAcc = 2 * muBH * radius / (r * r * r);
    const selfAcc = muBody / Math.max(1, radius * radius);
    const stress = Math.max(.02, tidalAcc / Math.max(1e-12, selfAcc));
    const dyn = Math.sqrt(radius / Math.max(1e-9, tidalAcc));
    const crossing = radius / Math.max(.05, rel);
    return clamp(Math.max(21600, dyn * 6, crossing * 10) / Math.sqrt(Math.min(60, stress)), 21600, 86400 * 90);
}
function disruptionBodyState(d) {
    if (d.phantom) {
        // the debris cloud coasts at the body's last velocity; the stream and
        // final absorption follow that coasting cloud.
        const ph = d.phantom, age = EPHT.t - ph.t0;
        d.x = ph.x + ph.vx * age; d.y = ph.y + ph.vy * age;
        d.vx = ph.vx; d.vy = ph.vy;
        return d;
    }
    if (d.target === "earth") {
        d.x = 0; d.y = 0; d.vx = 0; d.vy = 0;
    } else if (d.target === "moon") {
        d.x = eph.moonX; d.y = eph.moonY; d.vx = eph.moonVx; d.vy = eph.moonVy;
    } else if (d.target === "sun") {
        d.x = eph.sunX; d.y = eph.sunY; d.vx = eph.sunVx; d.vy = eph.sunVy;
    } else if (typeof d.target === "number" && d.target >= 0 && d.target < PL.length) {
        d.x = eph.plX[d.target]; d.y = eph.plY[d.target];
        d.vx = eph.plVx[d.target]; d.vy = eph.plVy[d.target];
    }
    return d;
}
function beginDisruption(i, target, x, y, vx, vy, radius, muBody, dist, limit) {
    if (isDisrupting(target) || i < 0 || i >= BH.n) return;
    const rel = Math.hypot(vx - BH.vx[i], vy - BH.vy[i]);
    const duration = disruptionDuration(radius, Math.max(dist, BH.rs[i] * 1.2), BH.mu[i], muBody, rel);
    const name = H.disrupt(target, BH.rs[i], "tidal disruption", i) || targetLabel(target);
    DISRUPT.push({
        bh: i, target, name, x, y, vx, vy, radius, muBody,
        age: 0, visual: 0, duration,
        color: targetDisruptionColor(target),
        limit: Math.max(limit, radius), bornRt: performance.now(),
        // the doomed body's mass keeps gravitating as frozen debris until the
        // absorption completes; deleting it here changed orbits system-wide
        // in a single step and scattered everything
        phantom: addPhantom(x, y, 0, vx, vy, 0, muBody, radius),
    });
    const m = BH_META[i];
    if (m) m.flare = Math.max(m.flare, .55);
    H.toast(name + " spaghettifying · mass transfer forming");
}
function advanceDisruptions(dt) {
    for (let k = DISRUPT.length - 1; k >= 0; k--) {
        const d = DISRUPT[k];
        if (d.bh < 0 || d.bh >= BH.n) { DISRUPT.splice(k, 1); continue; }
        disruptionBodyState(d);
        d.age += dt;
        const simDone = d.age >= d.duration;
        const visibleDone = d.visual >= .96 && performance.now() - d.bornRt > 5000;
        if (simDone && visibleDone) {
            const dx = d.x - BH.x[d.bh], dy = d.y - BH.y[d.bh];
            const r = Math.max(1e-9, Math.hypot(dx, dy));
            const horizon = Math.max(BH.rs[d.bh] * 1.08, 1e-6);
            const x = BH.x[d.bh] + dx / r * horizon;
            const y = BH.y[d.bh] + dy / r * horizon;
            absorbBody(d.bh, d.target, x, y, d.vx, d.vy, d.muBody);
            if (d.phantom) {
                // phantom → ghost: outside the expanding front the old debris
                // field persists; inside, the hole's new mass has taken over
                const ph = d.phantom, age = EPHT.t - ph.t0;
                ph.x += ph.vx * age; ph.y += ph.vy * age;
                ph.t0 = EPHT.t; ph.t = EPHT.t;
                d.phantom = null;
            }
            DISRUPT.splice(k, 1);
        }
    }
}
function checkBHBodyBoundaries() {
    for (let i = 0; i < BH.n; i++) {
        const L = bhLimits(i);
        const x = BH.x[i], y = BH.y[i];
        // a hole can only shred a body its gravity has actually reached
        if (!WORLD.earthDestroyed) {
            const d2 = x * x + y * y;
            if (d2 < L.earth * L.earth && bhMuAt(i, 0, 0, 0, EPHT.t) > 0) beginDisruption(i, "earth", 0, 0, 0, 0, R_EARTH, MU_E, Math.sqrt(d2), L.earth);
        }
        if (!WORLD.moonDestroyed) {
            const dx = x - eph.moonX, dy = y - eph.moonY, d2 = dx * dx + dy * dy;
            if (d2 < L.moon * L.moon && bhMuAt(i, eph.moonX, eph.moonY, 0, EPHT.t) > 0) beginDisruption(i, "moon", eph.moonX, eph.moonY, eph.moonVx, eph.moonVy, R_MOON, MU_M, Math.sqrt(d2), L.moon);
        }
        if (!WORLD.sunDestroyed) {
            const dx = x - eph.sunX, dy = y - eph.sunY, d2 = dx * dx + dy * dy;
            if (d2 < L.sun * L.sun && bhMuAt(i, eph.sunX, eph.sunY, 0, EPHT.t) > 0) beginDisruption(i, "sun", eph.sunX, eph.sunY, eph.sunVx, eph.sunVy, R_SUN, MU_S, Math.sqrt(d2), L.sun);
        }
        for (let p = 0; p < PL.length; p++) {
            if (WORLD.plDestroyed[p]) continue;
            const dx = x - eph.plX[p], dy = y - eph.plY[p], d2 = dx * dx + dy * dy;
            if (d2 < L.pl[p] * L.pl[p] && bhMuAt(i, eph.plX[p], eph.plY[p], 0, EPHT.t) > 0) beginDisruption(i, p, eph.plX[p], eph.plY[p], eph.plVx[p], eph.plVy[p], PL[p].R, PL[p].mu, Math.sqrt(d2), L.pl[p]);
        }
    }
}
setLiveGuard(checkBHBodyBoundaries);
export function bhAdvance(dtTotal, _tEnd) {
    if (!BH.n) return;
    while (tryMerge()) { }
    let rem = dtTotal, guard = 0;
    while (rem > 1e-9 && guard++ < 200 && BH.n) {
        // step: a fraction of the tightest orbital timescale in play
        let dt = Math.min(rem, 21600);
        for (let i = 0; i < BH.n; i++) {
            const mu = BH.mu[i];
            if (!WORLD.sunDestroyed) {
                const dx = BH.x[i] - eph.sunX, dy = BH.y[i] - eph.sunY, d2 = dx * dx + dy * dy;
                dt = Math.min(dt, Math.sqrt(d2 * Math.sqrt(d2) / (MU_S + mu)) / 40);
            }
            const r2 = BH.x[i] * BH.x[i] + BH.y[i] * BH.y[i];
            dt = Math.min(dt, Math.sqrt(r2 * Math.sqrt(r2) / (MU_E + mu)) / 40); // infall toward Earth
            if (!WORLD.moonDestroyed) {
                const dx = BH.x[i] - eph.moonX, dy = BH.y[i] - eph.moonY, d2 = dx * dx + dy * dy;
                dt = Math.min(dt, Math.sqrt(d2 * Math.sqrt(d2) / (MU_M + mu)) / 40);
            }
            for (let p = 0; p < PL.length; p++) {
                if (WORLD.plDestroyed[p]) continue;
                const dx = BH.x[i] - eph.plX[p], dy = BH.y[i] - eph.plY[p], d2 = dx * dx + dy * dy;
                dt = Math.min(dt, Math.sqrt(d2 * Math.sqrt(d2) / (PL[p].mu + mu)) / 40);
            }
            for (let j = i + 1; j < BH.n; j++) {
                const dx = BH.x[i] - BH.x[j], dy = BH.y[i] - BH.y[j], d2 = dx * dx + dy * dy;
                dt = Math.min(dt, Math.sqrt(d2 * Math.sqrt(d2) / (mu + BH.mu[j])) / 40);
            }
        }
        dt = Math.max(dt, rem / (200 - guard + 1), 1e-3);
        dt = Math.min(dt, rem);
        // the ephemeris is already at the end of the interval: holes catch up
        // through it, sampling bodies interpolated backward from now
        bhRk4(-rem, dt);
        rem -= dt;
        advanceDisruptions(dt);
        while (tryMerge()) { }
        checkBHBodyBoundaries();
    }
    for (let i = 0; i < BH.n; i++) {
        BH.sx[i] = BH.x[i] * K; BH.sz[i] = -BH.y[i] * K;
    }
}
export function placeBHAtCursor() {
    const p = cursorPlaneHit();
    if (!p) { H.toast("Aim the cursor at the orbital plane"); return; }
    addBlackHole(p.x / K - eph.earthX, -p.z / K - eph.earthY, BH_SIZES[BH.sizeIdx]);
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
const _fragObj = new THREE.Object3D();
const _fragCol = new THREE.Color();
const _bodyCol = new THREE.Color();
const _hotFragCol = new THREE.Color(1, .48, .12);
function updateSpagVisual(d, m, dtLocal, dBH, obsRate) {
    if (!m?.spag) return;
    const visualWindow = Math.max(5, Math.min(22, d.duration / 10800));
    const realAge = (performance.now() - d.bornRt) * .001;
    d.visual = Math.max(d.visual, clamp(realAge * obsRate / visualWindow, 0, 1));
    d.visual = clamp(d.visual + dtLocal / visualWindow, 0, 1);
    disruptionBodyState(d);
    const plasmaTarget = d.target === "sun" || (typeof d.target === "number" && PL[d.target]?.gas);
    const solidTarget = !plasmaTarget;
    const sourceRadiusU = d.radius * K;
    const visualRadiusU = plasmaTarget
        ? Math.max(m.rs * K * .08, Math.min(sourceRadiusU * .12, dBH * .0026))
        : sourceRadiusU;
    const debrisX = (d.x - BH.x[d.bh]) * K;
    const debrisZ = -(d.y - BH.y[d.bh]) * K;
    const len0 = Math.max(Math.hypot(debrisX, debrisZ), visualRadiusU * .5, m.rs * K * 4);
    const cap = Math.min(
        Math.max(visualRadiusU * (plasmaTarget ? 2.2 : 3.2), m.rs * K * 8),
        Math.max(m.rs * K * 4.5, dBH * .025),
    );
    const len = Math.min(len0, cap);
    const ux = len0 > 1e-9 ? debrisX / len0 : 1, uz = len0 > 1e-9 ? debrisZ / len0 : 0;
    const spag = m.spag;
    spag.group.rotation.y = Math.atan2(-uz, ux);
    const inner = Math.max(m.rs * K * 1.12, dBH * .0008);
    const radiusU = Math.max(visualRadiusU, m.rs * K * .018);
    const pixelU = Math.max(dBH * .00032, m.rs * K * .012);
    const stress = clamp((d.limit / Math.max(d.radius, 1) - 1) / 15, 0, 1);
    const tail = Math.max(inner * 1.12, len * (.16 + d.visual * (.42 + stress * .25)));
    const outer = Math.min(tail * .72, Math.max(len * .45, radiusU * 1.8));
    const heatPulse = .55 + .45 * Math.sin(performance.now() * .009 + d.visual * 9);
    const pos = spag.pos, col = spag.col;
    const rockBase = _bodyCol.setHex(d.color);
    const N = pos.length / 3;
    for (let n = 0; n < N; n++) {
        const q = n / Math.max(1, N - 1);
        const reveal = smooth01(q * .55, .18 + q * .92, d.visual);
        const qq = Math.pow(q, 1.18);
        const phase = spag.phase[n] + qq * 38 - d.visual * 24 + spag.lane[n] * stress;
        const neck = 1 - smooth01(.02, .34, q);
        const plasmaThin = plasmaTarget ? .42 : 1;
        const width = (radiusU * (.018 + Math.pow(q, 1.55) * .16) * plasmaThin + pixelU) * (1.05 - d.visual * .32);
        const spiral = Math.sin(phase) * width * (.42 + spag.jitter[n] * 1.35) * reveal;
        const lift = Math.cos(phase * .71 + spag.jitter[n] * 2.2) * width * (.34 + neck * .18) * reveal;
        const shear = Math.sin(phase * .31) * width * .55 * stress;
        const along = inner + qq * tail + shear;
        pos[n * 3] = along;
        pos[n * 3 + 1] = lift;
        pos[n * 3 + 2] = spiral;
        const hot = Math.pow(1 - q, plasmaTarget ? 2.4 : 3.2) * (.45 + heatPulse * .28);
        col[n * 3] = rockBase.r * (.34 + q * .5) + hot * (plasmaTarget ? 1.25 : .92);
        col[n * 3 + 1] = rockBase.g * (.33 + q * .42) + hot * (plasmaTarget ? .72 : .52);
        col[n * 3 + 2] = rockBase.b * (.32 + q * .38) + hot * (plasmaTarget ? .22 : .16);
    }
    spag.attr.needsUpdate = true;
    spag.colAttr.needsUpdate = true;
    spag.mat.size = Math.max(.01, dBH * (plasmaTarget ? .00072 : .00042) + stress * dBH * .0002);
    spag.mat.opacity = plasmaTarget
        ? clamp(.18 + .52 * Math.sin(Math.PI * Math.min(.98, d.visual)) + stress * .08, 0, .72)
        : clamp(.07 + .4 * Math.sin(Math.PI * Math.min(.98, d.visual)) + stress * .06, 0, .5);
    let li = 0;
    const arms = 5, segs = 112;
    for (let a = 0; a < arms; a++) {
        const armPhase = a / arms * Math.PI * 2 + d.visual * (5.2 + a * .13);
        for (let s = 0; s < segs - 1; s++) {
            for (let end = 0; end < 2; end++) {
                const q = (s + end) / (segs - 1);
                const qq = Math.pow(q, 1.08);
                const ang = armPhase + qq * (13 + stress * 8) - d.visual * 16;
                const width = (radiusU * (.012 + Math.pow(q, 1.35) * .105) * (plasmaTarget ? .38 : 1) + pixelU * .75) * (1 - d.visual * .18);
                spag.linePos[li++] = inner + qq * tail * (.78 + .16 * Math.sin(a * 1.7));
                spag.linePos[li++] = Math.sin(ang * .67 + a) * width * .36;
                spag.linePos[li++] = Math.cos(ang) * width;
            }
        }
    }
    spag.lineAttr.needsUpdate = true;
    spag.lines.material.opacity = plasmaTarget
        ? clamp(.06 + .22 * d.visual + stress * .07, 0, .32)
        : clamp(.018 + .1 * d.visual + stress * .05, 0, .16);
    const remnantAlpha = plasmaTarget ? clamp(.05 + (1 - Math.pow(d.visual, 1.6)) * .14, 0, .18) : 0;
    spag.remnant.visible = remnantAlpha > .015;
    if (spag.remnant.visible) {
        const wantBlend = plasmaTarget ? THREE.AdditiveBlending : THREE.NormalBlending;
        if (spag.remnant.material.blending !== wantBlend) {
            spag.remnant.material.blending = wantBlend;
            spag.remnant.material.needsUpdate = true;
        }
        spag.remnant.position.set(outer, 0, 0);
        if (plasmaTarget) {
            spag.remnant.scale.set(
                Math.min(radiusU * (1.4 + d.visual * 4.6), Math.max(radiusU * 1.25, tail * .16)),
                Math.max(radiusU * .28, radiusU * (1 - d.visual * .35)),
                Math.max(radiusU * .25, radiusU * (1 - d.visual * .32)),
            );
        } else {
            spag.remnant.scale.set(
                Math.min(radiusU * (1.05 + d.visual * (4.2 + stress * 4.8)), Math.max(radiusU * 1.25, tail * .11)),
                Math.max(radiusU * .32, radiusU * (1 - d.visual * .58)),
                Math.max(radiusU * .3, radiusU * (1 - d.visual * .55)),
            );
        }
        spag.remnant.rotation.x = Math.sin(d.visual * 5) * .18;
        spag.remnant.rotation.z = Math.cos(d.visual * 4.2) * .12;
        spag.remnantUniforms.uRock.value.setHex(d.color);
        spag.remnantUniforms.uHeat.value = plasmaTarget ? 1 : clamp(d.visual * 1.4 + stress * .45, 0, 1);
        spag.remnantUniforms.uAlpha.value = remnantAlpha;
    }
    const count = spag.fragments.count;
    for (let i = 0; i < count; i++) {
        const q = spag.fragQ[i];
        const reveal = smooth01(q * .35, .2 + q * .85, d.visual);
        const ang = spag.fragPhase[i] + q * (18 + stress * 10) - d.visual * (17 + spag.fragLane[i] * 4);
        const width = (radiusU * (.028 + Math.pow(q, 1.7) * .16) * (plasmaTarget ? .36 : 1) + pixelU) * reveal;
        const along = inner + Math.pow(q, 1.12) * tail + Math.sin(ang * .27) * width * .6;
        const y = Math.sin(ang * .71) * width * .45;
        const z = Math.cos(ang) * width;
        const scale = Math.max(.00001, radiusU * (.006 + .012 * spag.fragSize[i]) * reveal * (1 - d.visual * .35) * (plasmaTarget ? .32 : 1));
        _fragObj.position.set(along, y, z);
        _fragObj.rotation.set(ang * .17, ang * .31, ang * .23);
        _fragObj.scale.setScalar(scale);
        _fragObj.updateMatrix();
        spag.fragments.setMatrixAt(i, _fragObj.matrix);
        const hot = Math.pow(1 - q, 2.2) * clamp(d.visual * 1.3, 0, 1);
        spag.fragments.setColorAt(i, _fragCol.setHex(d.color).lerp(_hotFragCol, hot));
    }
    spag.fragments.instanceMatrix.needsUpdate = true;
    if (spag.fragments.instanceColor) spag.fragments.instanceColor.needsUpdate = true;
    spag.fragments.material.opacity = plasmaTarget
        ? clamp(.12 + d.visual * .38, 0, .48)
        : clamp(.12 + d.visual * .42, 0, .54);
}
function fadeSpagVisual(spag, dtR) {
    if (!spag) return;
    spag.mat.opacity = Math.max(0, spag.mat.opacity - dtR * .85);
    spag.lines.material.opacity = Math.max(0, spag.lines.material.opacity - dtR * .7);
    spag.fragments.material.opacity = Math.max(0, spag.fragments.material.opacity - dtR * .75);
    spag.remnantUniforms.uAlpha.value = Math.max(0, spag.remnantUniforms.uAlpha.value - dtR * .9);
    spag.remnant.visible = spag.remnantUniforms.uAlpha.value > .01;
}
export function updateBHVisuals(dtR, earthScX = 0, earthScZ = 0) {
    updateBHPlacementPreview(dtR);
    updateBHPlacementUI();
    for (let bi = 0; bi < BH_META.length; bi++) {
        const m = BH_META[bi];
        m.g.position.set(earthScX + BH.sx[bi], 0, earthScZ + BH.sz[bi]);
        const dBH = camera.position.distanceTo(m.g.position);
        const obsRate = observerTimeScaleForBH(bi, m.g.position);
        BH.obsT[bi] = obsRate;
        const dtLocal = dtR * obsRate;
        m.flare = Math.max(0, m.flare - dtLocal * .55);
        const massVis = smooth01(.5, 5000, m.rs);
        const diskVis = smooth01(50, 100000, m.rs);
        const screenRing = dBH * (.0026 + .002 * massVis);
        m.photon.scale.setScalar(Math.max(m.rs * K * 4.2, screenRing));
        m.glow.scale.setScalar(Math.max(m.rs * K * 8, dBH * (.0035 + .0055 * massVis)));
        const hot = Math.min(1, Math.max(.14, Math.pow(1000 / Math.max(1, m.rs), .34)));
        const flare = m.flare * m.flare;
        m.disk.material.opacity = .045 + diskVis * .6 + flare * .28;
        m.glow.material.opacity = .025 + hot * (.025 + .075 * massVis) + flare * .24;
        const hVis = Math.max(m.rs * K * 5.5, dBH * (.0015 + .0018 * massVis));
        m.hawk.scale.setScalar(hVis);
        m.hawk.rotation.y += dtLocal * (1.4 + hot * 4.8);
        m.hawk.rotation.z -= dtLocal * (.35 + hot * 1.2);
        m.hawk.material.opacity = (.018 + hot * .055) * (.35 + .65 * massVis) + flare * .08;
        m.hawk.material.size = Math.max(.0025, dBH * (.00018 + .00018 * massVis)) * (.65 + hot * .35);
        m.hawkGlow.scale.setScalar(Math.max(m.rs * K * (4.6 + flare * 5), dBH * (.0022 + .0035 * massVis + flare * .004)));
        m.hawkGlow.material.opacity = .015 + hot * (.018 + .052 * massVis) * (0.65 + 0.35 * Math.sin(performance.now() * .004 + bi)) + flare * .22;
        if (m.coreMask) {
            m.coreMask.scale.setScalar(Math.max(m.rs * K * 3, dBH * (.0025 + .0045 * massVis)));
            m.coreMask.material.opacity = 1;
            m.coreMask.quaternion.copy(camera.quaternion);
        }
        const d = DISRUPT.find(x => x.bh === bi);
        if (d) updateSpagVisual(d, m, dtLocal, dBH, obsRate);
        else fadeSpagVisual(m.spag, dtR);
        m.tex.rotation -= dtLocal * (.25 + 9 / Math.sqrt(m.rs));
    }
}
