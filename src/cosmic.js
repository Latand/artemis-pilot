import * as THREE from "three";
import { AU_KM, CAM_DIST_MAX, COSMIC_ZOOMS, K, LY_SCENE, SEC_YEAR, STARS } from "./constants.js";
import { mulberry32, smooth01 } from "./format.js";
import { G } from "./state.js";
import { cam, camera } from "./scene.js";
import { toast } from "./achievements.js";
import { hygCatalogMetaUrl, loadHygCatalogData, rememberHygCatalogData } from "./universe/catalogData.js";
import { makeGalaxyCloudAsync, galacticCenterScene, galacticRingPositions } from "./universe/starfield.js";
import { registerHygCatalog } from "./universe/hygActiveCatalog.js";
import { PERF, markPerf } from "./perf.js";
import {
    BRIGHTNESS_CURVE, VIEW_BRIGHTNESS_GLSL, bvToTeff, teffToRGB, absMagFromApparent,
} from "./render/viewBrightness.js";

// Galactic-centre position in scene units (toward Sgr A*, ~26,000 ly). The
// procedural galaxy cloud and the real HYG catalog share this equatorial frame.
const GC_SCENE = galacticCenterScene();
export const GALAXY = {
    sunX: 0,
    sunZ: 0,
    centerX: GC_SCENE[0],
    centerY: GC_SCENE[1],
    centerZ: GC_SCENE[2],
};

let scaleEl = null;
let inited = false;
let sceneRef = null;
let layerBuilt = false;
let layerBuilding = false;
let layerBuildScheduled = false;
let layerBuildPromise = null;
const root = new THREE.Group();
const diskRoot = new THREE.Group();
const galaxyRoot = new THREE.Group();
const catalogRoot = new THREE.Group();
const nearStarRoot = new THREE.Group();
const localRoot = new THREE.Group();
const deepRoot = new THREE.Group();
const labelRoot = new THREE.Group();
diskRoot.add(galaxyRoot, catalogRoot, nearStarRoot);
root.add(diskRoot, localRoot, deepRoot, labelRoot);
root.visible = false;
let pointMap = null;
let catalogCount = 0;
let catalogStats = null;
let catalogLoading = false;
let catalogLoaded = false;
let catalogLoadScheduled = false;
const PC_SCENE = LY_SCENE * 3.261563777;
const PC_LY = 3.261563777;
const COSMIC_CATALOG_MIN_DIST = LY_SCENE * .002;
const LOCAL_GALAXIES = [];
let cosmicVisualBucket = "";

function idleSlice(timeout = 120) {
    return new Promise(resolve => {
        if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout });
        else setTimeout(resolve, 0);
    });
}

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

// True Teff-based hue — no apparent-magnitude gain baked in (WP16 a1/b: color
// is intrinsic, brightness is observer-relative and evaluated in the shader).
function starColor(tempK, bv, out) {
    return teffToRGB(tempK > 0 ? tempK : bvToTeff(bv), out);
}

function starAbsMag(lum, absMagField, mag, distPc) {
    if (lum > 0) return -2.5 * Math.log10(lum) + 4.74;
    if (Number.isFinite(absMagField)) return absMagField;
    return absMagFromApparent(mag, distPc);
}

function installCatalogObject(pos, col, absMag, count, stats) {
    const obj = viewBrightPoints(pos, col, absMag, { basePx: 1.9, maxPx: 14, opacity: .82 });
    obj.name = "HYG v4.1 catalog";
    catalogRoot.add(obj);
    catalogCount = count;
    catalogStats = stats || null;
    catalogLoaded = true;
    catalogLoading = false;
}

async function loadCatalogStarsFallback(reason) {
    if (reason) console.warn("HYG catalog worker unavailable, using main thread", reason);
    try {
        const { meta: data, vals } = await loadHygCatalogData();
        registerHygCatalog(data, vals, { deferIndex: true });
        const fields = data.fields || [];
        const field = name => {
            const i = fields.indexOf(name);
            return i >= 0 ? i : null;
        };
        const stride = data.stride || fields.length || 5;
        const iX = field("xPc") ?? 0;
        const iY = field("yPc") ?? 1;
        const iZ = field("zPc") ?? 2;
        const iBv = field("bv") ?? 3;
        const iMag = field("mag") ?? 4;
        const iMass = field("massSolar");
        const iRadius = field("radiusSolar");
        const iLum = field("lumSolar");
        const iTemp = field("tempK");
        const iAbsMagField = field("absMag");
        const count = Math.floor(vals.length / stride);
        const keep = new Uint8Array(count);
        let kept = 0;
        const suppress = destinationSuppressPc();
        const suppressR2 = 0.18 * 0.18;
        for (let i = 0, j = 0; i < count; i++, j += stride) {
            let suppressed = false;
            for (let k = 0; k < suppress.length; k += 3) {
                const dx = vals[j + iX] - suppress[k], dy = vals[j + iY] - suppress[k + 1], dz = vals[j + iZ] - suppress[k + 2];
                if (dx * dx + dy * dy + dz * dz <= suppressR2) { suppressed = true; break; }
            }
            if (!suppressed) { keep[i] = 1; kept++; }
        }
        const pos = new Float32Array(kept * 3);
        const col = new Float32Array(kept * 3);
        const absMag = new Float32Array(kept);
        const c = [1, 1, 1];
        const stats = {
            sourceCount: count,
            massEstimated: 0,
            radiusEstimated: 0,
            lumEstimated: 0,
            tempEstimated: 0,
            massSolarSum: 0,
        };
        let out = 0;
        for (let i = 0, j = 0; i < count; i++, j += stride) {
            if (!keep[i]) continue;
            const xPc = vals[j + iX], yPc = vals[j + iY], zPc = vals[j + iZ];
            pos[out * 3] = xPc * PC_SCENE;
            pos[out * 3 + 1] = zPc * PC_SCENE;
            pos[out * 3 + 2] = -yPc * PC_SCENE;
            const mass = iMass === null ? NaN : vals[j + iMass];
            const radius = iRadius === null ? NaN : vals[j + iRadius];
            const lum = iLum === null ? NaN : vals[j + iLum];
            const temp = iTemp === null ? NaN : vals[j + iTemp];
            const absMagField = iAbsMagField === null ? NaN : vals[j + iAbsMagField];
            const distPc = Math.sqrt(xPc * xPc + yPc * yPc + zPc * zPc);
            absMag[out] = starAbsMag(lum, absMagField, vals[j + iMag], distPc);
            starColor(temp, vals[j + iBv], c);
            col[out * 3] = c[0];
            col[out * 3 + 1] = c[1];
            col[out * 3 + 2] = c[2];
            if (mass > 0) { stats.massEstimated++; stats.massSolarSum += mass; }
            if (radius > 0) stats.radiusEstimated++;
            if (lum > 0) stats.lumEstimated++;
            if (temp > 0) stats.tempEstimated++;
            out++;
        }
        installCatalogObject(pos, col, absMag, kept, stats);
    } catch (err) {
        console.warn("HYG catalog layer unavailable", err);
        catalogLoading = false;
    }
}

async function loadCatalogStars() {
    if (catalogLoading || catalogLoaded) return;
    catalogLoading = true;
    if (window.Worker) {
        let worker = null;
        let settled = false;
        const fallback = reason => {
            if (settled) return;
            settled = true;
            if (worker) worker.terminate();
            loadCatalogStarsFallback(reason);
        };
        try {
            worker = new Worker(new URL("./catalogWorker.js", import.meta.url), { type: "module" });
            worker.onerror = e => fallback(e?.message || "worker error");
            worker.onmessage = e => {
                if (settled) return;
                const msg = e.data || {};
                if (!msg.ok) {
                    fallback(msg.error || "worker returned failure");
                    return;
                }
                settled = true;
                if (msg.vals) {
                    const vals = new Float32Array(msg.vals);
                    rememberHygCatalogData(msg.meta, vals, hygCatalogMetaUrl());
                    registerHygCatalog(msg.meta, vals, { deferIndex: true });
                }
                installCatalogObject(
                    new Float32Array(msg.pos),
                    new Float32Array(msg.col),
                    new Float32Array(msg.absMag),
                    msg.count,
                    msg.stats,
                );
                worker.terminate();
            };
            worker.postMessage({
                url: hygCatalogMetaUrl(),
                pcScene: PC_SCENE,
                suppress: destinationSuppressPc(),
            });
            return;
        } catch (err) {
            fallback(err?.message || String(err));
            return;
        }
    }
    await loadCatalogStarsFallback();
}

function scheduleCatalogLoad() {
    if (catalogLoadScheduled || catalogLoading || catalogLoaded) return;
    catalogLoadScheduled = true;
    const start = () => loadCatalogStars();
    if (window.requestIdleCallback) window.requestIdleCallback(start, { timeout: 2400 });
    else setTimeout(start, 0);
}

function destinationSuppressPc() {
    const out = [];
    for (const star of STARS) {
        if (!Number.isFinite(star.raDeg) || !Number.isFinite(star.decDeg) || !Number.isFinite(star.dLy)) continue;
        const ra = star.raDeg * Math.PI / 180, dec = star.decDeg * Math.PI / 180;
        const dPc = star.dLy / PC_LY, cd = Math.cos(dec);
        out.push(Math.cos(ra) * cd * dPc, Math.sin(ra) * cd * dPc, Math.sin(dec) * dPc);
    }
    return out;
}

function makeLocalStars() {
    const rnd = mulberry32(33177);
    const count = STARS.length;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    let n = 0;
    for (const star of STARS) {
        pos[n * 3] = star.x * K;
        pos[n * 3 + 1] = (star.z || 0) * K + (rnd() - .5) * Math.min(star.dLy * LY_SCENE * .015, LY_SCENE * .04);
        pos[n * 3 + 2] = -star.y * K;
        col[n * 3] = ((star.color >> 16) & 255) / 255;
        col[n * 3 + 1] = ((star.color >> 8) & 255) / 255;
        col[n * 3 + 2] = (star.color & 255) / 255;
        n++;
    }
    return { pos, col };
}

// Observer-relative-brightness point cloud: unlike `points()` (plain
// PointsMaterial, size/alpha baked in at build time from apparent magnitude),
// every star's on-screen size/alpha/HDR intensity is recomputed in the vertex
// shader every frame from its absMag attribute and the live camera distance
// (WP16 a1). This is what makes the catalog cloud's brightness match a
// procedural star at the same camera distance instead of staying anchored to
// "distance from Sol" — the fix for the near-Sun bubble at galaxy zoom.
const PC_SCENE_UNITS = PC_SCENE;
function viewBrightPoints(pos, col, absMag, opts = {}) {
    const curve = { ...BRIGHTNESS_CURVE, ...opts };
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geom.setAttribute("absMag", new THREE.BufferAttribute(absMag, 1));
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uBasePx: { value: curve.basePx },
            uMagRef: { value: curve.magRef },
            uMinPx: { value: curve.minPx },
            uMaxPx: { value: curve.maxPx },
            uMagLimit: { value: curve.magLimit },
            uPcScene: { value: PC_SCENE_UNITS },
            uOpacity: { value: curve.opacity ?? 1 },
        },
        vertexShader: /* glsl */`
            attribute float absMag;
            varying vec3 vColor;
            varying float vHdr;
            uniform float uBasePx, uMagRef, uMinPx, uMaxPx, uMagLimit, uPcScene;
            ${VIEW_BRIGHTNESS_GLSL}
            void main() {
                vColor = color;
                vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
                float camDistPc = length(mvPosition.xyz) / uPcScene;
                float mag = obmApparentMagAt(absMag, camDistPc);
                gl_PointSize = obmSizePx(mag, uBasePx, uMagRef, uMinPx, uMaxPx);
                vHdr = obmHdrIntensity(mag, uMagLimit);
                gl_Position = projectionMatrix * mvPosition;
            }`,
        fragmentShader: /* glsl */`
            varying vec3 vColor;
            varying float vHdr;
            uniform float uOpacity;
            void main() {
                vec2 uv = gl_PointCoord - 0.5;
                float r2 = dot(uv, uv);
                float g = exp(-r2 * 14.0) + exp(-r2 * 60.0) * max(0.0, vHdr - 1.0) * 0.6;
                if (g < 0.006) discard;
                gl_FragColor = vec4(vColor * max(vHdr, 1.0), clamp(g, 0.0, 4.0) * uOpacity);
            }`,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    });
    mat.userData.baseOpacity = curve.opacity ?? 1;
    const obj = new THREE.Points(geom, mat);
    obj.frustumCulled = false;
    return obj;
}

function points(data, size, opacity) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(data.pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(data.col, 3));
    const mat = new THREE.PointsMaterial({
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
    });
    mat.userData.baseOpacity = opacity;
    const obj = new THREE.Points(geom, mat);
    obj.frustumCulled = false;
    return obj;
}

function sphericalCloud(count, radiusLy, seed, colorA, colorB, coreBias = 1.9, flatness = 1) {
    const rnd = mulberry32(seed);
    const radius = radiusLy * LY_SCENE;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const u = rnd() * 2 - 1;
        const th = rnd() * Math.PI * 2;
        const r = radius * Math.pow(rnd(), coreBias);
        const side = Math.sqrt(Math.max(0, 1 - u * u));
        pos[i * 3] = Math.cos(th) * side * r;
        pos[i * 3 + 1] = u * r * flatness;
        pos[i * 3 + 2] = Math.sin(th) * side * r;
        const mix = Math.pow(rnd(), .7);
        const c = colorMix(colorA, colorB, mix, (rnd() - .5) * .045);
        col[i * 3] = Math.max(0, Math.min(1, c[0]));
        col[i * 3 + 1] = Math.max(0, Math.min(1, c[1]));
        col[i * 3 + 2] = Math.max(0, Math.min(1, c[2]));
    }
    return { pos, col };
}

function globularCloud(count, radiusLy, seed, colorA, colorB) {
    const rnd = mulberry32(seed);
    const radius = radiusLy * LY_SCENE;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const u = rnd() * 2 - 1;
        const th = rnd() * Math.PI * 2;
        const r = radius * (.12 + Math.pow(rnd(), .72) * .88);
        const side = Math.sqrt(Math.max(0, 1 - u * u));
        pos[i * 3] = Math.cos(th) * side * r;
        pos[i * 3 + 1] = u * r * .88;
        pos[i * 3 + 2] = Math.sin(th) * side * r;
        const c = colorMix(colorA, colorB, rnd(), .04 + rnd() * .05);
        col[i * 3] = Math.min(1, c[0]);
        col[i * 3 + 1] = Math.min(1, c[1]);
        col[i * 3 + 2] = Math.min(1, c[2]);
    }
    return { pos, col };
}

function offsetCloud(data, x, y, z) {
    const pos = data.pos;
    for (let i = 0; i < pos.length; i += 3) {
        pos[i] += x;
        pos[i + 1] += y;
        pos[i + 2] += z;
    }
    return data;
}

function galaxyCoreTexture(colorA, colorB) {
    const W = 128;
    const cv = document.createElement("canvas");
    cv.width = cv.height = W;
    const ctx = cv.getContext("2d");
    const g = ctx.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
    const ca = `rgba(${Math.round(colorB[0] * 255)},${Math.round(colorB[1] * 255)},${Math.round(colorB[2] * 255)},`;
    const cb = `rgba(${Math.round(colorA[0] * 255)},${Math.round(colorA[1] * 255)},${Math.round(colorA[2] * 255)},`;
    g.addColorStop(0, ca + ".70)");
    g.addColorStop(.25, ca + ".25)");
    g.addColorStop(.65, cb + ".055)");
    g.addColorStop(1, cb + "0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, W);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function diskGalaxy(cx, cy, cz, radiusLy, tilt, colorA, colorB, seed, count = 9000) {
    const rnd = mulberry32(seed);
    const radius = radiusLy * LY_SCENE;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const arm = Math.floor(rnd() * 4);
        const rn = Math.pow(rnd(), 1.55);
        const r = radius * rn;
        const spiral = arm * Math.PI * .5 + rn * 5.1 + (rnd() - .5) * (.55 + rn * .75);
        const bar = Math.max(0, 1 - rn * 8);
        const stretch = 1 + bar * 1.9;
        const x = Math.cos(spiral) * r * stretch;
        const z = Math.sin(spiral) * r * (.62 + bar * .25);
        const y = (rnd() + rnd() - 1) * radius * (.018 + .018 * rn);
        pos[i * 3] = cx + x;
        pos[i * 3 + 1] = cy + y;
        pos[i * 3 + 2] = cz + z;
        const core = Math.max(0, 1 - rn * 4.5);
        const hot = .18 + core * .75 + rnd() * .08;
        const c = colorMix(colorA, colorB, Math.min(1, hot), (rnd() - .5) * .035);
        col[i * 3] = Math.max(0, Math.min(1, c[0]));
        col[i * 3 + 1] = Math.max(0, Math.min(1, c[1]));
        col[i * 3 + 2] = Math.max(0, Math.min(1, c[2]));
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
        vertexColors: true,
        size: 1.18,
        sizeAttenuation: false,
        transparent: true,
        map: cosmicPointMap(),
        alphaTest: .015,
        opacity: .66,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    });
    mat.userData.baseOpacity = .66;
    const disk = new THREE.Points(geom, mat);
    disk.frustumCulled = false;
    const coreMat = new THREE.SpriteMaterial({
        map: galaxyCoreTexture(colorA, colorB),
        transparent: true,
        opacity: .32,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    });
    coreMat.userData.baseOpacity = .32;
    const core = new THREE.Sprite(coreMat);
    core.scale.set(radius * .55, radius * .28, 1);
    core.frustumCulled = false;
    const group = new THREE.Group();
    group.add(disk, core);
    group.rotation.set(tilt || 0, seed * .017, (seed % 31) * .021);
    group.frustumCulled = false;
    return group;
}

function galaxyHalo(radiusLy, seed, colorA, colorB, richness = 1) {
    const group = new THREE.Group();
    const haloCount = Math.max(240, Math.round(900 * richness));
    const clusterCount = Math.max(60, Math.round(160 * richness));
    const halo = points(sphericalCloud(haloCount, radiusLy * 2.6, seed ^ 0x51ed, colorA, colorB, 1.35, .82), .72, .22);
    const clusters = points(globularCloud(clusterCount, radiusLy * 2.05, seed ^ 0xa71, [.72, .82, 1], [1, .9, .66]), 1.75, .58);
    group.add(halo, clusters);
    group.frustumCulled = false;
    return group;
}

function milkyWayHalo() {
    const group = new THREE.Group();
    group.add(points(
        offsetCloud(sphericalCloud(4600, 210000, 48879, [.42, .52, .82], [.95, .82, .58], 1.08, .72), GALAXY.centerX, GALAXY.centerY, GALAXY.centerZ),
        .66,
        .18,
    ));
    group.add(points(
        offsetCloud(globularCloud(520, 165000, 48881, [.70, .82, 1], [1, .88, .62]), GALAXY.centerX, GALAXY.centerY, GALAXY.centerZ),
        1.65,
        .48,
    ));
    group.frustumCulled = false;
    return group;
}

function deepFieldLayer(count = 16000) {
    const rnd = mulberry32(0x9e3779);
    const radius = CAM_DIST_MAX * .78;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const u = rnd() * 2 - 1;
        const th = rnd() * Math.PI * 2;
        const side = Math.sqrt(Math.max(0, 1 - u * u));
        const r = radius * (.94 + rnd() * .04);
        pos[i * 3] = Math.cos(th) * side * r;
        pos[i * 3 + 1] = u * r;
        pos[i * 3 + 2] = Math.sin(th) * side * r;
        const warm = rnd() < .34;
        const base = warm ? [.92, .73, .52] : [.48, .60, .92];
        const hi = warm ? [1, .88, .67] : [.72, .82, 1];
        const c = colorMix(base, hi, Math.pow(rnd(), .55), (rnd() - .5) * .035);
        const gain = .45 + Math.pow(rnd(), 5.0) * .55;
        col[i * 3] = Math.max(0, Math.min(1, c[0] * gain));
        col[i * 3 + 1] = Math.max(0, Math.min(1, c[1] * gain));
        col[i * 3 + 2] = Math.max(0, Math.min(1, c[2] * gain));
    }
    const obj = points({ pos, col }, 1.25, .62);
    obj.material.depthTest = false;
    obj.material.userData.baseOpacity = .62;
    obj.renderOrder = -1;
    return obj;
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
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    mat.userData.baseOpacity = opacity;
    const line = new THREE.LineLoop(geom, mat);
    line.frustumCulled = false;
    return line;
}

// A ring in the real Galactic plane at galactocentric radius Rpc (parsecs),
// transformed into the equatorial scene frame so it tilts correctly.
function galacticPlaneRing(Rpc, color, opacity) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(galacticRingPositions(Rpc), 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    mat.userData.baseOpacity = opacity;
    const line = new THREE.LineLoop(geom, mat);
    line.frustumCulled = false;
    return line;
}

function setTreeOpacity(obj, opacity) {
    obj.traverse(child => {
        if (!child.material) return;
        const base = child.material.userData.baseOpacity ?? child.material.opacity ?? 1;
        child.material.opacity = base * opacity;
    });
}

function addMovingGalaxy(cfg) {
    const group = new THREE.Group();
    group.name = cfg.name;
    const base = new THREE.Vector3(cfg.xLy * LY_SCENE, cfg.yLy * LY_SCENE, cfg.zLy * LY_SCENE);
    group.position.copy(base);
    group.add(diskGalaxy(0, 0, 0, cfg.radiusLy, cfg.tilt || 0, cfg.colorA, cfg.colorB, cfg.seed, cfg.count || 9000));
    group.add(galaxyHalo(cfg.radiusLy, cfg.seed, cfg.colorA, cfg.colorB, cfg.richness || 1));
    localRoot.add(group);
    const velocity = new THREE.Vector3();
    if (cfg.approachKmS) velocity.copy(base).normalize().multiplyScalar(-cfg.approachKmS * K);
    if (cfg.velocityKmS) velocity.add(new THREE.Vector3(cfg.velocityKmS[0] * K, cfg.velocityKmS[2] * K, -cfg.velocityKmS[1] * K));
    LOCAL_GALAXIES.push({ id: cfg.id, name: cfg.name, group, base, velocity });
    return group;
}

function updateLocalGalaxyMotion() {
    const t = Math.min(Math.max(G.t, -5e9 * SEC_YEAR), 5e9 * SEC_YEAR);
    for (const g of LOCAL_GALAXIES) {
        g.group.position.set(
            g.base.x + g.velocity.x * t,
            g.base.y + g.velocity.y * t,
            g.base.z + g.velocity.z * t,
        );
    }
}

function buildLocalGroup() {
    addMovingGalaxy({ id: "m31", name: "ANDROMEDA", xLy: 2537000, yLy: 18000, zLy: -420000, radiusLy: 110000, tilt: .35, colorA: [.56, .65, .9], colorB: [1, .82, .55], seed: 8102, approachKmS: 110, richness: 1.35 });
    addMovingGalaxy({ id: "m33", name: "TRIANGULUM", xLy: 1610000, yLy: -24000, zLy: 980000, radiusLy: 45000, tilt: -.25, colorA: [.54, .68, 1], colorB: [.9, .88, .74], seed: 8117, approachKmS: 44, richness: .85 });
    addMovingGalaxy({ id: "lmc", name: "LARGE MAGELLANIC CLOUD", xLy: -142000, yLy: -36000, zLy: 68000, radiusLy: 16000, colorA: [.62, .72, 1], colorB: [.95, .86, .7], seed: 8131, velocityKmS: [57, -226, 221], richness: .45 });
    addMovingGalaxy({ id: "smc", name: "SMALL MAGELLANIC CLOUD", xLy: -184000, yLy: -62000, zLy: 104000, radiusLy: 9500, colorA: [.58, .68, .96], colorB: [.9, .82, .68], seed: 8149, velocityKmS: [19, -153, 174], richness: .32 });
    localRoot.add(ring(0, 0, 0, 1200000, 0x31405b, .2));
    localRoot.add(ring(0, 0, 0, 3200000, 0x26344b, .16));
    const rnd = mulberry32(8814);
    const count = 1800;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const r = (180000 + Math.pow(rnd(), .6) * 2900000) * LY_SCENE;
        const th = rnd() * Math.PI * 2;
        pos[i * 3] = Math.cos(th) * r;
        pos[i * 3 + 1] = (rnd() - .5) * 360000 * LY_SCENE;
        pos[i * 3 + 2] = Math.sin(th) * r * .68;
        col[i * 3] = .62 + rnd() * .28;
        col[i * 3 + 1] = .68 + rnd() * .24;
        col[i * 3 + 2] = .82 + rnd() * .18;
    }
    localRoot.add(points({ pos, col }, 1.2, .42));
}

async function buildCosmicLayer() {
    if (!sceneRef || layerBuilt) return layerBuildPromise;
    if (layerBuilding) return layerBuildPromise;
    layerBuilding = true;
    const t0 = PERF.enabled ? performance.now() : 0;
    layerBuildPromise = (async () => {
        // The 170k Milky Way cloud is visually important but not needed for the
        // first solar-system frame. Generate it in slices so startup and play
        // remain responsive while the far-scale layer warms up.
        galaxyRoot.add(points(await makeGalaxyCloudAsync(170000, 0x6d57, 4096, idleSlice), 1.20, .5));
        await idleSlice();
        galaxyRoot.add(milkyWayHalo());
        galaxyRoot.add(galacticPlaneRing(8178, 0x53617a, .30));
        galaxyRoot.add(galacticPlaneRing(16000, 0x344058, .24));
        catalogRoot.frustumCulled = false;
        await idleSlice();
        nearStarRoot.add(points(makeLocalStars(), 2.4, .78));
        await idleSlice();
        buildLocalGroup();
        await idleSlice();
        deepRoot.add(deepFieldLayer());
        deepRoot.frustumCulled = false;
        layerBuilt = true;
        cosmicVisualBucket = "";
        if (PERF.enabled) markPerf("cosmic.buildLayer", performance.now() - t0, {
            galaxyPoints: 170000,
            localGalaxies: LOCAL_GALAXIES.length,
        });
    })().catch(err => {
        console.warn("cosmic layer unavailable", err);
    }).finally(() => {
        layerBuilding = false;
    });
    return layerBuildPromise;
}

export function scheduleCosmicLayerBuild() {
    if (layerBuilt || layerBuilding || layerBuildScheduled || !sceneRef) return layerBuildPromise;
    layerBuildScheduled = true;
    const start = () => {
        layerBuildScheduled = false;
        buildCosmicLayer();
    };
    if (typeof requestIdleCallback === "function") requestIdleCallback(start, { timeout: 2400 });
    else setTimeout(start, 800);
    return layerBuildPromise;
}

export function initCosmicLayer(scene) {
    if (inited) return;
    inited = true;
    sceneRef = scene;
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

function catalogCoverageLabel() {
    if (!catalogCount) return "";
    const massEstimated = catalogStats?.massEstimated || 0;
    const phys = massEstimated ? " · est mass " + Math.round(massEstimated / 1000) + "K" : "";
    return " · HYG " + Math.round(catalogCount / 1000) + "K" + phys;
}

export function cycleCosmicScale() {
    scheduleCosmicLayerBuild();
    if (cam.dist < LY_SCENE * 1000) {
        cam.dist = COSMIC_ZOOMS.MILKY_WAY;
        G.focus = "free";
        cam.tgt.set(GALAXY.centerX, GALAXY.centerY, GALAXY.centerZ);
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
    if (!layerBuilt) {
        if (cam.dist > LY_SCENE * .2) {
            scheduleCosmicLayerBuild();
            if (scaleEl) {
                scaleEl.style.opacity = "1";
                scaleEl.textContent = "COSMIC SCALE - warming";
            }
        }
        root.visible = false;
        return;
    }
    // LOD cross-fade tuned so a star field is ALWAYS visible while zooming:
    //  - near: 73 curated bright stars, accents up close
    //  - catalog: 119k real HYG stars — the dominant local field; kept bright and
    //    visible far out (real data spans kpc) so it overlaps the galaxy band
    //  - galaxy: procedural Milky Way band, fades in to back the catalog
    // The earlier tuning let the catalog die out (~300–2000 ly) before the galaxy
    // appeared, leaving an empty "dead zone" that flickered while zooming.
    const gal = smooth01(LY_SCENE * 40, LY_SCENE * 5000, cam.dist);
    const near = 1 - smooth01(LY_SCENE * 500, LY_SCENE * 8000, cam.dist);
    const catalog = 1 - smooth01(LY_SCENE * 12000, LY_SCENE * 110000, cam.dist);
    const group = smooth01(LY_SCENE * 70000, LY_SCENE * 1200000, cam.dist);
    const deep = smooth01(LY_SCENE * 220000, LY_SCENE * 1600000, cam.dist);
    const catalogLoadShed = G.warp > 600 && cam.dist < LY_SCENE * .2;
    const galaxyVisible = gal > .01;
    const catalogVisible = !catalogLoadShed && catalog > .01 && cam.dist > COSMIC_CATALOG_MIN_DIST;
    const nearVisible = near > .01 && cam.dist > COSMIC_CATALOG_MIN_DIST;
    const groupVisible = group > .01;
    const deepVisible = deep > .01;
    if (catalogVisible) scheduleCatalogLoad();
    if (groupVisible) updateLocalGalaxyMotion();
    const label = "COSMIC SCALE · " + cosmicScaleLabel() + catalogCoverageLabel();
    const bucket = [
        Math.round(gal * 100),
        Math.round(near * 100),
        Math.round(catalog * 100),
        Math.round(group * 100),
        Math.round(deep * 100),
        galaxyVisible ? 1 : 0,
        catalogVisible ? 1 : 0,
        nearVisible ? 1 : 0,
        catalogLoadShed ? 1 : 0,
        catalogCount,
        label,
    ].join("|");
    root.visible = galaxyVisible || catalogVisible || nearVisible || groupVisible || deepVisible;
    diskRoot.visible = galaxyVisible || catalogVisible || nearVisible;
    catalogRoot.visible = catalogVisible;
    nearStarRoot.visible = nearVisible;
    galaxyRoot.visible = galaxyVisible;
    localRoot.visible = groupVisible;
    deepRoot.visible = deepVisible;
    if (deepRoot.visible) deepRoot.position.copy(camera.position);
    if (bucket === cosmicVisualBucket) return;
    cosmicVisualBucket = bucket;
    for (const child of galaxyRoot.children) {
        if (child.material) {
            child.visible = galaxyVisible;
            child.material.opacity = child.isPoints ? .18 + .72 * gal * (1 - group * .55) : .07 + .24 * gal * (1 - group * .55);
        } else {
            child.visible = galaxyVisible;
            setTreeOpacity(child, (.22 + .68 * gal) * (1 - group * .35));
        }
    }
    for (const child of nearStarRoot.children) if (child.material) {
        child.visible = nearVisible;
        child.material.opacity = Math.min(1, (.74 + .26 * gal) * near);
    }
    for (const child of catalogRoot.children) if (child.material) {
        child.visible = catalogVisible;
        // viewBrightPoints is a custom ShaderMaterial: brightness is driven by
        // its own uOpacity uniform (baked into vHdr/alpha in-shader), not the
        // generic Material.opacity property other clouds here use.
        const fade = Math.min(1, (.68 + .30 * gal) * catalog * (1 - group * .48));
        if (child.material.uniforms?.uOpacity) child.material.uniforms.uOpacity.value = (child.material.userData.baseOpacity ?? 1) * fade;
        else child.material.opacity = fade;
    }
    setTreeOpacity(localRoot, .16 + .84 * group);
    setTreeOpacity(deepRoot, deep);
    if (scaleEl) {
        scaleEl.style.opacity = gal > .01 ? "1" : "0";
        scaleEl.textContent = label;
    }
}

export { CAM_DIST_MAX };
