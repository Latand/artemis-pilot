import * as THREE from "three";
import { AU_KM, CAM_DIST_MAX, COSMIC_ZOOMS, K, LY_SCENE, STARS } from "./constants.js";
import { mulberry32, smooth01 } from "./format.js";
import { G } from "./state.js";
import { cam } from "./scene.js";
import { toast } from "./achievements.js";
import { loadHygCatalogData } from "./universe/catalogData.js";
import { makeGalaxyCloud, galacticCenterScene, galacticRingPositions } from "./universe/starfield.js";
import { registerHygCatalog } from "./universe/hygActiveCatalog.js";

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
const root = new THREE.Group();
const diskRoot = new THREE.Group();
const galaxyRoot = new THREE.Group();
const catalogRoot = new THREE.Group();
const nearStarRoot = new THREE.Group();
const localRoot = new THREE.Group();
const labelRoot = new THREE.Group();
diskRoot.add(galaxyRoot, catalogRoot, nearStarRoot);
root.add(diskRoot, localRoot, labelRoot);
let pointMap = null;
let catalogCount = 0;
let catalogStats = null;
let catalogLoading = false;
let catalogLoaded = false;
const PC_SCENE = LY_SCENE * 3.261563777;
const PC_LY = 3.261563777;

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

function bvColor(ci, mag, out) {
    const bv = Number.isFinite(ci) ? Math.max(-0.35, Math.min(2.0, ci)) : 0.65;
    const t = Math.max(0, Math.min(1, (bv + .35) / 2.35));
    let c;
    if (t < .34) c = colorMix([.58, .68, 1.0], [.93, .96, 1.0], t / .34);
    else if (t < .58) c = colorMix([.93, .96, 1.0], [1.0, .86, .58], (t - .34) / .24);
    else c = colorMix([1.0, .86, .58], [1.0, .42, .28], (t - .58) / .42);
    const gain = Math.max(.32, Math.min(1.55, 1.12 - ((Number.isFinite(mag) ? mag : 9) - 5) * .055));
    out[0] = Math.min(1, c[0] * gain);
    out[1] = Math.min(1, c[1] * gain);
    out[2] = Math.min(1, c[2] * gain);
}

function installCatalogObject(pos, col, count, stats) {
    const obj = points({ pos, col }, 1.18, .5);
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
            bvColor(vals[j + iBv], vals[j + iMag], c);
            col[out * 3] = c[0];
            col[out * 3 + 1] = c[1];
            col[out * 3 + 2] = c[2];
            const mass = iMass === null ? NaN : vals[j + iMass];
            const radius = iRadius === null ? NaN : vals[j + iRadius];
            const lum = iLum === null ? NaN : vals[j + iLum];
            const temp = iTemp === null ? NaN : vals[j + iTemp];
            if (mass > 0) { stats.massEstimated++; stats.massSolarSum += mass; }
            if (radius > 0) stats.radiusEstimated++;
            if (lum > 0) stats.lumEstimated++;
            if (temp > 0) stats.tempEstimated++;
            out++;
        }
        installCatalogObject(pos, col, kept, stats);
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
            const data = await loadHygCatalogData();
            registerHygCatalog(data.meta, data.vals, { deferIndex: true });
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
                if (msg.vals) registerHygCatalog(msg.meta, new Float32Array(msg.vals), { deferIndex: true });
                installCatalogObject(
                    new Float32Array(msg.pos),
                    new Float32Array(msg.col),
                    msg.count,
                    msg.stats,
                );
                worker.terminate();
            };
            const workerVals = data.vals.slice();
            worker.postMessage({
                meta: data.meta,
                metaUrl: data.metaUrl,
                vals: workerVals.buffer,
                pcScene: PC_SCENE,
                suppress: destinationSuppressPc(),
            }, [workerVals.buffer]);
            return;
        } catch (err) {
            fallback(err?.message || String(err));
            return;
        }
    }
    await loadCatalogStarsFallback();
}

function scheduleCatalogLoad() {
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

// A ring in the real Galactic plane at galactocentric radius Rpc (parsecs),
// transformed into the equatorial scene frame so it tilts correctly.
function galacticPlaneRing(Rpc, color, opacity) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(galacticRingPositions(Rpc), 3));
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
    // galaxyRoot stays at the scene origin: makeGalaxyCloud returns absolute
    // Sol-centred equatorial coordinates with the Galactic centre toward Sgr A*,
    // so the band lines up with the real HYG catalog rather than the old ~87°
    // misaligned decorative spiral.
    galaxyRoot.add(points(makeGalaxyCloud(170000), 1.20, .5));
    galaxyRoot.add(galacticPlaneRing(8200, 0x53617a, .30));
    galaxyRoot.add(galacticPlaneRing(16000, 0x344058, .24));
    catalogRoot.frustumCulled = false;
    nearStarRoot.add(points(makeLocalStars(), 2.4, .78));
    buildLocalGroup();
    root.frustumCulled = false;
    scene.add(root);
    scaleEl = document.getElementById("cosmicScale");
    scheduleCatalogLoad();
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
    root.visible = true;
    diskRoot.visible = true;
    catalogRoot.visible = catalog > .01;
    nearStarRoot.visible = near > .01;
    localRoot.visible = group > .01;
    for (const child of galaxyRoot.children) if (child.material) {
        child.visible = child.isPoints || gal > .01;
        child.material.opacity = child.isPoints ? .12 + .60 * gal * (1 - group * .6) : .05 + .20 * gal * (1 - group * .55);
    }
    for (const child of nearStarRoot.children) if (child.material) {
        child.visible = near > .01;
        child.material.opacity = (.55 + .25 * gal) * near;
    }
    for (const child of catalogRoot.children) if (child.material) {
        child.visible = catalog > .01;
        child.material.opacity = (.50 + .22 * gal) * catalog * (1 - group * .55);
    }
    for (const child of localRoot.children) if (child.material) child.material.opacity = .03 + .2 * group;
    if (scaleEl) {
        scaleEl.style.opacity = gal > .01 ? "1" : "0";
        scaleEl.textContent = "COSMIC SCALE · " + cosmicScaleLabel() + catalogCoverageLabel();
    }
}

export { CAM_DIST_MAX };
