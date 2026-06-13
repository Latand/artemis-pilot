import * as THREE from "three";
import { PL } from "./constants.js";
import { mulberry32, makeNoise } from "./format.js";

// ---------- procedural fallbacks (used when a NASA map fails to load) ----------
export function earthTextureProc() {
    const W = 1024, H = 512, cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H);
    const n1 = makeNoise(7041, 24, 12), n2 = makeNoise(913, 48, 24);
    for (let y = 0; y < H; y++) {
        const v = y / H, lat = Math.abs(v - .5) * 2;
        for (let x = 0; x < W; x++) {
            const u = x / W;
            const c = n1(u * 1.9, v * 1.9) + .32 * n2(u * 4, v * 4) - .16;
            const i = (y * W + x) * 4;
            let r, g, b;
            if (c > .52) {
                const t = n2(u * 6 + 3, v * 6);
                r = 78 + t * 90; g = 96 + t * 70; b = 52 + t * 38;
                if (c > .66) { r = 120 + t * 60; g = 104 + t * 50; b = 70 + t * 36; }
            } else {
                const d = Math.min(1, (.52 - c) * 3.2);
                r = 16 + 14 * (1 - d); g = 42 + 30 * (1 - d); b = 86 + 58 * (1 - d);
            }
            if (lat > .86 || (c > .52 && lat > .78)) { r = 224; g = 232; b = 240; }
            img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
export function cloudTextureProc() {
    const W = 1024, H = 512, cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H);
    const n = makeNoise(551, 32, 16);
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const a = Math.max(0, n(x / W * 3, y / H * 3) - .52) * 3.4;
            const i = (y * W + x) * 4;
            const g = Math.min(225, a * 255);
            img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
        }
    ctx.putImageData(img, 0, 0);
    return new THREE.CanvasTexture(cv);
}
export function moonBumpProc() {
    const W = 1280, H = 640;
    const cBmp = document.createElement("canvas"); cBmp.width = W; cBmp.height = H;
    const xBmp = cBmp.getContext("2d");
    const iBmp = xBmp.createImageData(W, H);
    const n1 = makeNoise(99, 48, 24), n2 = makeNoise(777, 128, 64);
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const u = x / W, v = y / H;
            const hgt = n1(u * 4, v * 4) * .62 + n2(u * 11, v * 11) * .38;
            const i = (y * W + x) * 4;
            const g = hgt * 255;
            iBmp.data[i] = g; iBmp.data[i + 1] = g; iBmp.data[i + 2] = g; iBmp.data[i + 3] = 255;
        }
    xBmp.putImageData(iBmp, 0, 0);
    const rnd = mulberry32(4242);
    for (let c = 0; c < 440; c++) {
        const big = rnd() < .07;
        const cx = rnd() * W, cy = H * (.04 + rnd() * .92);
        const r = big ? 14 + rnd() * 26 : 1.4 + rnd() * rnd() * 11;
        const gr = xBmp.createRadialGradient(cx, cy, 0, cx, cy, r);
        gr.addColorStop(0, "rgba(0,0,0,0.62)"); gr.addColorStop(.62, "rgba(0,0,0,0.2)");
        gr.addColorStop(.8, "rgba(255,255,255,0.55)"); gr.addColorStop(1, "rgba(255,255,255,0)");
        xBmp.fillStyle = gr; xBmp.beginPath(); xBmp.arc(cx, cy, r, 0, 7); xBmp.fill();
    }
    return new THREE.CanvasTexture(cBmp);
}
export function moonColorProc() {
    const W = 1280, H = 640;
    const cCol = document.createElement("canvas"); cCol.width = W; cCol.height = H;
    const xCol = cCol.getContext("2d");
    const iCol = xCol.createImageData(W, H);
    const n1 = makeNoise(99, 48, 24), n2 = makeNoise(777, 128, 64);
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            const u = x / W, v = y / H;
            const hgt = n1(u * 4, v * 4) * .62 + n2(u * 11, v * 11) * .38;
            const i = (y * W + x) * 4;
            const t = 112 + (hgt - .5) * 96;
            iCol.data[i] = t; iCol.data[i + 1] = t; iCol.data[i + 2] = t + 5; iCol.data[i + 3] = 255;
        }
    xCol.putImageData(iCol, 0, 0);
    const t2 = new THREE.CanvasTexture(cCol);
    t2.colorSpace = THREE.SRGBColorSpace;
    return t2;
}
export function planetTextureProc(hex, gas, seed) {
    const W = 256, H = 128;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H);
    const n = makeNoise(seed, 32, 16);
    const r0 = (hex >> 16) & 255, g0 = (hex >> 8) & 255, b0 = hex & 255;
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            let t;
            if (gas) t = .55 + .3 * Math.sin(y / H * 24 + 5 * n(x / W * 1.2, y / H * 5)) + .18 * (n(x / W * 4, y / H * 8) - .5);
            else t = .5 + .8 * (n(x / W * 5, y / H * 5) - .45) + .25 * (n(x / W * 13, y / H * 13) - .5);
            t = Math.max(.25, Math.min(1.15, t));
            const i = (y * W + x) * 4;
            img.data[i] = r0 * t; img.data[i + 1] = g0 * t; img.data[i + 2] = b0 * t; img.data[i + 3] = 255;
        }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
export function ringTextureProc() {
    const rc = document.createElement("canvas");
    rc.width = 512; rc.height = 16;
    const rctx = rc.getContext("2d");
    const rg = rctx.createLinearGradient(0, 0, 512, 0);
    rg.addColorStop(0, "rgba(214,196,150,0)");
    rg.addColorStop(.08, "rgba(214,196,150,.55)");
    rg.addColorStop(.35, "rgba(190,170,128,.7)");
    rg.addColorStop(.42, "rgba(120,104,76,.1)");
    rg.addColorStop(.55, "rgba(214,196,150,.65)");
    rg.addColorStop(.78, "rgba(196,178,138,.5)");
    rg.addColorStop(1, "rgba(196,178,138,0)");
    rctx.fillStyle = rg;
    rctx.fillRect(0, 0, 512, 16);
    const t = new THREE.CanvasTexture(rc);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
// ---------- sprite helpers ----------
export function dotTexture(color, glow) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const ctx = cv.getContext("2d");
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, color); g.addColorStop(.35, color);
    g.addColorStop(.55, glow); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(cv);
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
}
export function ringTexture(color, size = 128, lineWidth = Math.max(5, size * .078)) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    const c = size * .5;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.arc(c, c, size * .344, 0, Math.PI * 2);
    ctx.stroke();
    const t = new THREE.CanvasTexture(cv);
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
}

// ---------- NASA maps (solarsystemscope.com renditions, CC BY 4.0) ----------
const loader = new THREE.TextureLoader();
function tryLoad(file, srgb = true) {
    return loader.loadAsync("textures/" + file).then(t => {
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        return t;
    }).catch(() => null);
}
export async function loadAllMaps() {
    const names = {
        earth: tryLoad("2k_earth_daymap.jpg"),
        earthNight: tryLoad("2k_earth_nightmap.jpg"),
        clouds: tryLoad("2k_earth_clouds.jpg", false),
        moon: tryLoad("2k_moon.jpg"),
        sun: tryLoad("2k_sun.jpg"),
        ring: tryLoad("2k_saturn_ring_alpha.png"),
        milky: tryLoad("2k_stars_milky_way.jpg"),
    };
    const plMaps = PL.map(p => tryLoad(p.tex));
    const out = {};
    for (const k of Object.keys(names)) out[k] = await names[k];
    out.planets = await Promise.all(plMaps);
    return out;
}
