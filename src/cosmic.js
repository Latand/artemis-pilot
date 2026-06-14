import * as THREE from "three";
import { AU_KM, CAM_DIST_MAX, COSMIC_ZOOMS, K, LY_SCENE, SEC_YEAR, STARS } from "./constants.js";
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
const LOCAL_GALAXIES = [];
let cosmicVisualBucket = "";

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
    addMovingGalaxy({ id: "m31", name: "ANDROMEDA", xLy: 2537000, yLy: 18000, zLy: -420000, radiusLy: 110000, tilt: .35, colorA: [.56, .65, .9], colorB: [1, .82, .55], seed: 8102, approachKmS: 110 });
    addMovingGalaxy({ id: "m33", name: "TRIANGULUM", xLy: 1610000, yLy: -24000, zLy: 980000, radiusLy: 45000, tilt: -.25, colorA: [.54, .68, 1], colorB: [.9, .88, .74], seed: 8117, approachKmS: 44 });
    addMovingGalaxy({ id: "lmc", name: "LARGE MAGELLANIC CLOUD", xLy: -142000, yLy: -36000, zLy: 68000, radiusLy: 16000, colorA: [.62, .72, 1], colorB: [.95, .86, .7], seed: 8131, velocityKmS: [57, -226, 221] });
    addMovingGalaxy({ id: "smc", name: "SMALL MAGELLANIC CLOUD", xLy: -184000, yLy: -62000, zLy: 104000, radiusLy: 9500, colorA: [.58, .68, .96], colorB: [.9, .82, .68], seed: 8149, velocityKmS: [19, -153, 174] });
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
    updateLocalGalaxyMotion();
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
    const label = "COSMIC SCALE · " + cosmicScaleLabel() + catalogCoverageLabel();
    const bucket = [
        Math.round(gal * 100),
        Math.round(near * 100),
        Math.round(catalog * 100),
        Math.round(group * 100),
        catalogCount,
        label,
    ].join("|");
    root.visible = true;
    diskRoot.visible = true;
    catalogRoot.visible = catalog > .01;
    nearStarRoot.visible = near > .01;
    localRoot.visible = group > .01;
    if (bucket === cosmicVisualBucket) return;
    cosmicVisualBucket = bucket;
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
    setTreeOpacity(localRoot, .16 + .84 * group);
    if (scaleEl) {
        scaleEl.style.opacity = gal > .01 ? "1" : "0";
        scaleEl.textContent = label;
    }
}

export { CAM_DIST_MAX };
