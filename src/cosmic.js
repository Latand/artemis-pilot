import * as THREE from "three";
import { AU_KM, CAM_DIST_MAX, COSMIC_ZOOMS, K, LY_SCENE, SEC_YEAR, STARS } from "./constants.js";
import { mulberry32, smooth01 } from "./format.js";
import { G } from "./state.js";
import { cam } from "./scene.js";
import { toast } from "./achievements.js";

export const GALAXY = {
    sunX: 0,
    sunZ: 0,
    centerX: -26000 * LY_SCENE,
    centerZ: 0,
};

let scaleEl = null;
let inited = false;
const root = new THREE.Group();
const diskRoot = new THREE.Group();
const galaxyRoot = new THREE.Group();
const nearStarRoot = new THREE.Group();
const localRoot = new THREE.Group();
const labelRoot = new THREE.Group();
diskRoot.add(galaxyRoot, nearStarRoot);
root.add(diskRoot, localRoot, labelRoot);
let pointMap = null;

function cosmicPointMap() {
    if (!pointMap) {
        const cv = document.createElement("canvas");
        cv.width = cv.height = 64;
        const ctx = cv.getContext("2d");
        const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        g.addColorStop(0, "rgba(255,255,255,0.82)");
        g.addColorStop(.18, "rgba(255,255,255,0.24)");
        g.addColorStop(.58, "rgba(255,255,255,0.045)");
        g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 64, 64);
        pointMap = new THREE.CanvasTexture(cv);
        pointMap.colorSpace = THREE.SRGBColorSpace;
    }
    return pointMap;
}

function colorMix(a, b, t, jitter = 0) {
    return [
        a[0] * (1 - t) + b[0] * t + jitter,
        a[1] * (1 - t) + b[1] * t + jitter,
        a[2] * (1 - t) + b[2] * t + jitter,
    ];
}

function makeMilkyWayStars() {
    const rnd = mulberry32(240612);
    const count = 52000;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const arms = 4;
    const radius = 54000 * LY_SCENE;
    const thick = 980 * LY_SCENE;
    for (let i = 0; i < count; i++) {
        const halo = rnd() < .12;
        let gx, gy, gz, warmth;
        if (halo) {
            const r = Math.pow(rnd(), .32) * radius * 1.18;
            const th = rnd() * Math.PI * 2;
            const ph = Math.acos(2 * rnd() - 1);
            gx = Math.sin(ph) * Math.cos(th) * r * .82;
            gy = Math.cos(ph) * r * .18;
            gz = Math.sin(ph) * Math.sin(th) * r * .58;
            warmth = .25 + rnd() * .25;
        } else {
            const arm = Math.floor(rnd() * arms);
            const r = Math.pow(rnd(), .68) * radius;
            const spin = r / radius * 7.4;
            const th = arm / arms * Math.PI * 2 + spin + (rnd() - .5) * .42;
            const rr = r * (.86 + rnd() * .22);
            gx = Math.cos(th) * rr;
            gy = (rnd() - .5) * thick * (1 + Math.pow(rnd(), 3) * 5);
            gz = Math.sin(th) * rr * .72;
            warmth = Math.max(0, 1 - r / radius);
        }
        pos[i * 3] = gx;
        pos[i * 3 + 1] = gy;
        pos[i * 3 + 2] = gz;
        const c = colorMix([.52, .64, .95], [1.0, .78, .48], warmth, (rnd() - .5) * .06);
        col[i * 3] = c[0];
        col[i * 3 + 1] = c[1];
        col[i * 3 + 2] = c[2];
    }
    return { pos, col };
}

function makeLocalStars() {
    const rnd = mulberry32(33177);
    const count = STARS.length;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    let n = 0;
    for (const star of STARS) {
        pos[n * 3] = star.x * K;
        pos[n * 3 + 1] = (rnd() - .5) * star.dLy * LY_SCENE * .08;
        pos[n * 3 + 2] = -star.y * K;
        col[n * 3] = ((star.color >> 16) & 255) / 255;
        col[n * 3 + 1] = ((star.color >> 8) & 255) / 255;
        col[n * 3 + 2] = (star.color & 255) / 255;
        n++;
    }
    return { pos, col };
}

function points(data, size, opacity) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(data.pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(data.col, 3));
    const obj = new THREE.Points(geom, new THREE.PointsMaterial({
        vertexColors: true,
        size,
        sizeAttenuation: false,
        transparent: true,
        map: cosmicPointMap(),
        alphaTest: .02,
        opacity,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    }));
    obj.frustumCulled = false;
    return obj;
}

function galaxySpriteTexture(colorA, colorB, seed) {
    const rnd = mulberry32(seed);
    const W = 512, H = 256;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) {
        const yy = (y / H - .5) * 2.4;
        for (let x = 0; x < W; x++) {
            const xx = (x / W - .5) * 2.2;
            const r = Math.hypot(xx, yy * 1.75);
            const a = Math.atan2(yy * 1.75, xx);
            const arm = .5 + .5 * Math.cos(a * 3.0 - r * 8.6 + seed * .013);
            const dust = .5 + .5 * Math.sin(a * 5.0 + r * 17.0 + seed * .031);
            const disk = Math.exp(-r * 2.8);
            const core = Math.exp(-r * r * 28.0);
            const alpha = Math.min(1, disk * (.18 + .56 * Math.pow(arm, 2.2)) + core * .34);
            const warm = Math.min(1, core * 1.3 + arm * .25 + rnd() * .035);
            const c = colorMix(colorA, colorB, warm, 0);
            const shade = .62 + .38 * dust;
            const i = (y * W + x) * 4;
            img.data[i] = Math.min(255, c[0] * shade * 255);
            img.data[i + 1] = Math.min(255, c[1] * shade * 255);
            img.data[i + 2] = Math.min(255, c[2] * shade * 255);
            img.data[i + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
        }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function diskGalaxy(cx, cy, cz, radiusLy, tilt, colorA, colorB, seed, count = 9000) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: galaxySpriteTexture(colorA, colorB, seed),
        transparent: true,
        opacity: .34,
        depthWrite: false,
        depthTest: true,
        blending: THREE.NormalBlending,
    }));
    sprite.position.set(cx, cy, cz);
    sprite.scale.set(radiusLy * LY_SCENE * 2.25, radiusLy * LY_SCENE * 1.05, 1);
    sprite.frustumCulled = false;
    return sprite;
}

function ring(cx, cy, cz, rLy, color, opacity) {
    const segs = 420;
    const pos = new Float32Array(segs * 3);
    for (let i = 0; i < segs; i++) {
        const a = i / segs * Math.PI * 2;
        pos[i * 3] = cx + Math.cos(a) * rLy * LY_SCENE;
        pos[i * 3 + 1] = cy;
        pos[i * 3 + 2] = cz + Math.sin(a) * rLy * LY_SCENE;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const line = new THREE.LineLoop(geom, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    line.frustumCulled = false;
    return line;
}

function buildLocalGroup() {
    const andX = 2537000 * LY_SCENE;
    const andZ = -420000 * LY_SCENE;
    const triX = 1610000 * LY_SCENE;
    const triZ = 980000 * LY_SCENE;
    localRoot.add(diskGalaxy(andX, 18000 * LY_SCENE, andZ, 110000, .35, [.56, .65, .9], [1, .82, .55], 8102, 13000));
    localRoot.add(diskGalaxy(triX, -24000 * LY_SCENE, triZ, 45000, -.25, [.54, .68, 1], [.9, .88, .74], 8117, 6200));
    localRoot.add(ring(0, 0, 0, 1200000, 0x31405b, .2));
    localRoot.add(ring(0, 0, 0, 3200000, 0x26344b, .16));
    const rnd = mulberry32(8814);
    const count = 120;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const r = (180000 + Math.pow(rnd(), .6) * 2900000) * LY_SCENE;
        const th = rnd() * Math.PI * 2;
        pos[i * 3] = Math.cos(th) * r;
        pos[i * 3 + 1] = (rnd() - .5) * 360000 * LY_SCENE;
        pos[i * 3 + 2] = Math.sin(th) * r * .68;
        col[i * 3] = .55 + rnd() * .24;
        col[i * 3 + 1] = .62 + rnd() * .2;
        col[i * 3 + 2] = .78 + rnd() * .2;
    }
    localRoot.add(points({ pos, col }, .85, .18));
}

export function initCosmicLayer(scene) {
    if (inited) return;
    inited = true;
    galaxyRoot.position.set(GALAXY.centerX, 0, GALAXY.centerZ);
    galaxyRoot.add(points(makeMilkyWayStars(), 1.05, .45));
    galaxyRoot.add(ring(0, 0, 0, 26000, 0x53617a, .34));
    galaxyRoot.add(ring(0, 0, 0, 54000, 0x344058, .28));
    nearStarRoot.add(points(makeLocalStars(), 2.4, .78));
    buildLocalGroup();
    root.frustumCulled = false;
    scene.add(root);
    scaleEl = document.getElementById("cosmicScale");
}

export function cosmicScaleLabel(dist = cam.dist) {
    const ly = dist / LY_SCENE;
    if (ly < .01) return (dist / (AU_KM * .001)).toFixed(2) + " AU";
    if (ly < 1000) return ly.toFixed(2) + " ly";
    if (ly < 1e6) return (ly / 1000).toFixed(1) + " kly";
    return (ly / 1e6).toFixed(2) + " Mly";
}

export function cycleCosmicScale() {
    if (cam.dist < LY_SCENE * 1000) {
        cam.dist = COSMIC_ZOOMS.MILKY_WAY;
        G.focus = "free";
        cam.tgt.set(GALAXY.centerX, 0, GALAXY.centerZ);
        toast("Scale: Milky Way · " + cosmicScaleLabel());
    } else if (cam.dist < LY_SCENE * 800000) {
        cam.dist = COSMIC_ZOOMS.LOCAL_GROUP;
        G.focus = "free";
        cam.tgt.set(900000 * LY_SCENE, 0, 160000 * LY_SCENE);
        toast("Scale: Local Group · " + cosmicScaleLabel());
    } else {
        cam.dist = COSMIC_ZOOMS.SOLAR;
        G.focus = "ship";
        toast("Scale: Solar System");
    }
}

export function updateCosmicLayer() {
    if (!inited) return;
    const gal = smooth01(LY_SCENE * .15, LY_SCENE * 2500, cam.dist);
    const near = 1 - smooth01(LY_SCENE * 80, LY_SCENE * 1200, cam.dist);
    const group = smooth01(LY_SCENE * 70000, LY_SCENE * 1200000, cam.dist);
    root.visible = true;
    diskRoot.visible = true;
    nearStarRoot.visible = near > .01;
    galaxyRoot.rotation.y = G.t / (SEC_YEAR * 230000000) * Math.PI * 2;
    localRoot.visible = group > .01;
    for (const child of galaxyRoot.children) if (child.material) {
        child.visible = child.isPoints || gal > .01;
        child.material.opacity = child.isPoints ? .08 + .42 * gal * (1 - group * .7) : .06 + .2 * gal * (1 - group * .55);
    }
    for (const child of nearStarRoot.children) if (child.material) {
        child.visible = near > .01;
        child.material.opacity = (.12 + .34 * gal) * near;
    }
    for (const child of localRoot.children) if (child.material) child.material.opacity = .03 + .2 * group;
    if (scaleEl) {
        scaleEl.style.opacity = gal > .01 ? "1" : "0";
        scaleEl.textContent = "COSMIC SCALE · " + cosmicScaleLabel();
    }
}

export { CAM_DIST_MAX };
