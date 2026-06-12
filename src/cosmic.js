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
            const r = Math.pow(rnd(), .55) * radius;
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
    const count = 2400 + STARS.length;
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
    while (n < count) {
        const r = Math.pow(rnd(), .36) * 140 * LY_SCENE;
        const th = rnd() * Math.PI * 2;
        const ph = Math.acos(2 * rnd() - 1);
        pos[n * 3] = Math.sin(ph) * Math.cos(th) * r;
        pos[n * 3 + 1] = Math.cos(ph) * r * .22;
        pos[n * 3 + 2] = Math.sin(ph) * Math.sin(th) * r;
        const warm = rnd();
        const c = colorMix([.62, .74, 1], [1, .64, .42], warm, (rnd() - .5) * .05);
        col[n * 3] = c[0];
        col[n * 3 + 1] = c[1];
        col[n * 3 + 2] = c[2];
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
        opacity,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    }));
    obj.frustumCulled = false;
    return obj;
}

function diskGalaxy(cx, cy, cz, radiusLy, tilt, colorA, colorB, seed, count = 9000) {
    const rnd = mulberry32(seed);
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const arm = Math.floor(rnd() * 3);
        const r = Math.pow(rnd(), .5) * radiusLy * LY_SCENE;
        const th = arm / 3 * Math.PI * 2 + r / (radiusLy * LY_SCENE) * 5.6 + (rnd() - .5) * .62;
        const x = Math.cos(th) * r;
        const y = (rnd() - .5) * radiusLy * LY_SCENE * .018;
        const z = Math.sin(th) * r * .55;
        pos[i * 3] = cx + x;
        pos[i * 3 + 1] = cy + y * Math.cos(tilt) - z * Math.sin(tilt);
        pos[i * 3 + 2] = cz + y * Math.sin(tilt) + z * Math.cos(tilt);
        const warm = Math.max(0, 1 - r / (radiusLy * LY_SCENE));
        const c = colorMix(colorA, colorB, warm, (rnd() - .5) * .04);
        col[i * 3] = c[0];
        col[i * 3 + 1] = c[1];
        col[i * 3 + 2] = c[2];
    }
    return points({ pos, col }, 1.25, .52);
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
    localRoot.add(points({ pos, col }, 2.4, .5));
}

export function initCosmicLayer(scene) {
    if (inited) return;
    inited = true;
    galaxyRoot.position.set(GALAXY.centerX, 0, GALAXY.centerZ);
    galaxyRoot.add(points(makeMilkyWayStars(), 1.2, .58));
    galaxyRoot.add(ring(0, 0, 0, 26000, 0x53617a, .34));
    galaxyRoot.add(ring(0, 0, 0, 54000, 0x344058, .28));
    nearStarRoot.add(points(makeLocalStars(), 2.2, .78));
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
    const group = smooth01(LY_SCENE * 70000, LY_SCENE * 1200000, cam.dist);
    root.visible = true;
    diskRoot.visible = true;
    galaxyRoot.rotation.y = G.t / (SEC_YEAR * 230000000) * Math.PI * 2;
    localRoot.visible = group > .01;
    for (const child of galaxyRoot.children) if (child.material) {
        child.visible = child.isPoints || gal > .01;
        child.material.opacity = child.isPoints ? .12 + .52 * gal * (1 - group * .55) : .12 + .5 * gal * (1 - group * .55);
    }
    for (const child of nearStarRoot.children) if (child.material) {
        child.visible = true;
        child.material.opacity = .22 + .52 * gal * (1 - group * .35);
    }
    for (const child of localRoot.children) if (child.material) child.material.opacity = .1 + .48 * group;
    if (scaleEl) {
        scaleEl.style.opacity = gal > .01 ? "1" : "0";
        scaleEl.textContent = "COSMIC SCALE · " + cosmicScaleLabel();
    }
}

export { CAM_DIST_MAX };
