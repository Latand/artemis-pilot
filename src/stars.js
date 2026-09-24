import * as THREE from "three";
import { STARS, K, LY_SCENE } from "./constants.js";
import { CURATED_PHOTOMETRY } from "./render/curatedPhotometry.js";
import { photosphereMaterial } from "./render/planetAppearance.js";
import { stellarExposure, linearStarColor, meteredSkyExposure } from "./render/stellarAppearance.js";
import { teffToRGB, bvToTeff, absMagVFromL } from "./render/viewBrightness.js";
import { makeStarPointMaterial, starPointAlpha } from "./render/starPointMaterial.js";
import { curatedAbsMagV, holdCatalogRow } from "./render/catalogStars.js";
import { dotTexture } from "./textures.js";
import { renderQuality, scene, viewportSize } from "./scene.js";
import { smooth01 } from "./format.js";
import { ACTIVE_STARS, activeStarsTime } from "./universe/activeStars.js";
import { applyTerrellToMaterial } from "./relView.js";
import { holeRoot } from "./holeOptics.js";

// Physical renderings for the named stellar destinations and the active stars
// around the ship: each star gets a photosphere mesh that appears as its disk
// resolves; SGR A* gets an event horizon, an accretion disk, and polar jets.
// The unresolved point of a curated star is its row in the curated point
// layer (render/catalogStars.js). Every procedural star of the active
// neighbourhood (galaxy.js's local tier, the ball the resolved field leaves
// to it) is a point of the same shared material at its live position
// (syncActiveProceduralPoints). An active catalog star carries its own point
// at its live position while its static catalog point steps aside. So every
// star is drawn by exactly one point.
// Known limit: float32 world coordinates wobble at light-year distances —
// close approaches render, but sub-1000 km precision out there is not exact.

const entries = [];
const starRGB = [1,1,1];
const entryById = new Map();
const hexRgba = (hex, a) => "rgba(" + ((hex >> 16) & 255) + "," + ((hex >> 8) & 255) + "," + (hex & 255) + "," + a + ")";
const ACTIVE_VISUAL_MAX = 48;
const ACTIVE_VISUAL_RADIUS = LY_SCENE * .24;
const ACTIVE_VISUAL_SYNC_S = .12;
const ACTIVE_VISUAL_MOVE_SYNC = ACTIVE_VISUAL_RADIUS * .04;
// build/show the named-star visuals as soon as their labels appear (so you never
// see a label with no star under it); only the true LEO/solar near-field skips them
const LOCAL_VISUAL_SKIP_R = LY_SCENE * .0008;
let localVisualsHidden = false;
let namedStarsBuilt = false;
const forceNamedStarVisuals = new URLSearchParams(location.search).get("starvisuals") === "1";
const seg = (desktop, mobile) => renderQuality.mobile ? mobile : desktop;
const sphere = (r, desktopW, desktopH, mobileW, mobileH) =>
    new THREE.SphereGeometry(r, seg(desktopW, mobileW), seg(desktopH, mobileH));

function starVisualId(star) {
    if (star.id) return star.id;
    if (star.hygIndex !== undefined) return "hyg:" + star.hygIndex;
    return star.name;
}

// Label consumers read the rendered point and resolved-disk visibility
// (refreshed by updateStars). A resolved photosphere remains a visible target
// when its point has faded out.
export function starVisualAlpha(star) {
    const entry = entryById.get(starVisualId(star));
    if (!entry) return 0;
    if (entry.star.bh) return entry.g.visible ? entry.glow.material.opacity : 0;
    return entry.alpha;
}

let activePointMaterial = null;
function activeStarPoint(absMag, tempK, radiusKm) {
    activePointMaterial ||= makeStarPointMaterial({ radius: true });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3), 3));
    geo.setAttribute("absMag", new THREE.BufferAttribute(new Float32Array(1), 1));
    geo.setAttribute("teffK", new THREE.BufferAttribute(new Float32Array(1), 1));
    geo.setAttribute("radiusKm", new THREE.BufferAttribute(new Float32Array(1), 1));
    const pt = new THREE.Points(geo, activePointMaterial);
    pt.frustumCulled = false;
    pt.renderOrder = -3;
    setActivePointPhotometry(pt, absMag, tempK, radiusKm);
    return pt;
}
const _ptColor = new THREE.Color();
function setActivePointPhotometry(pt, absMag, tempK, radiusKm) {
    const a = pt.geometry.attributes;
    a.absMag.array[0] = Number.isFinite(absMag) ? absMag : 99;
    a.teffK.array[0] = tempK || 5800;
    a.radiusKm.array[0] = radiusKm || 0;
    linearStarColor(teffToRGB(tempK || 5800, starRGB), _ptColor);
    a.color.array[0] = _ptColor.r; a.color.array[1] = _ptColor.g; a.color.array[2] = _ptColor.b;
    a.absMag.needsUpdate = a.teffK.needsUpdate = a.radiusKm.needsUpdate = a.color.needsUpdate = true;
}
function activeAbsMagV(star, tempK) {
    if (Number.isFinite(star.absMag)) return star.absMag;
    return star.lumSolar > 0 ? absMagVFromL(star.lumSolar, tempK || 5800) : NaN;
}

function fresnelShell(radius, color, power, gain) {
    return new THREE.Mesh(sphere(radius, 48, 32, 24, 16), new THREE.ShaderMaterial({
        transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
        uniforms: { c: { value: new THREE.Color(color) }, uP: { value: power }, uG: { value: gain } },
        vertexShader: /* glsl */`
            varying float vF; uniform float uP;
            void main(){
                vec3 n = normalize(normalMatrix * normal);
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vF = pow(1.0 + dot(normalize(mv.xyz), n), uP);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            uniform vec3 c; uniform float uG; varying float vF;
            void main(){ gl_FragColor = vec4(c, clamp(vF * uG, 0.0, 1.0)); }`,
    }));
}

function accretionTexture(hex) {
    const cv = document.createElement("canvas");
    cv.width = 512; cv.height = 16;
    const ctx = cv.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 512, 0);
    // inner edge white-hot, cooling outward through the star's tint
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(.12, "rgba(255,236,200,0.9)");
    g.addColorStop(.34, hexRgba(hex, .62));
    g.addColorStop(.62, hexRgba(hex, .3));
    g.addColorStop(1, hexRgba(hex, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 16);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function radialRing(rIn, rOut, map) {
    const rg = new THREE.RingGeometry(rIn, rOut, seg(96, 48), 1);
    const posA = rg.attributes.position, uvA = rg.attributes.uv;
    for (let vi = 0; vi < posA.count; vi++) {
        const r = Math.hypot(posA.getX(vi), posA.getY(vi));
        uvA.setXY(vi, (r - rIn) / (rOut - rIn), .5);
    }
    return new THREE.Mesh(rg, new THREE.MeshBasicMaterial({
        map, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
}

function collectMaterialTextures(material, textures) {
    if (!material) return;
    const mats = Array.isArray(material) ? material : [material];
    for (const mat of mats) {
        for (const key in mat) {
            const value = mat[key];
            if (value?.isTexture) textures.add(value);
        }
        if (mat.uniforms) {
            for (const key in mat.uniforms) {
                const value = mat.uniforms[key]?.value;
                if (value?.isTexture) textures.add(value);
            }
        }
    }
}

function disposeMaterial(material) {
    if (!material) return;
    const mats = Array.isArray(material) ? material : [material];
    for (const mat of mats) mat.dispose();
}

function disposeStarVisual(entry) {
    const textures = new Set();
    if (entry.star.activeCatalog) holdCatalogRow(entry.star.hygIndex, false);
    entry.g.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material === activePointMaterial) return;
        collectMaterialTextures(obj.material, textures);
        disposeMaterial(obj.material);
    });
    for (const texture of textures) texture.dispose();
}

export function addStarVisual(star) {
    const id = starVisualId(star);
    const existing = entryById.get(id);
    if (existing) {
        existing.star = star;
        if (star.tempK > 0 && existing.photosphere) {
            existing.tempK = star.tempK;
            linearStarColor(teffToRGB(star.tempK, starRGB), existing.photosphere.material.color);
        }
        const m = existing.active ? activeAbsMagV(star, existing.tempK) : curatedAbsMagV(star);
        if (Number.isFinite(m)) existing.absMag = m;
        if (existing.point) setActivePointPhotometry(existing.point, existing.absMag, existing.tempK, star.R);
        return existing;
    }
    const g = new THREE.Group();
    let disk = null;
    let photosphere = null;
    const photometry = CURATED_PHOTOMETRY[star.name];
    const tempK = star.tempK || photometry?.tempK || (Number.isFinite(star.bv) ? bvToTeff(star.bv) : null);
    const active = !!(star.procedural || star.activeCatalog);
    const absMag = active ? activeAbsMagV(star, tempK) : curatedAbsMagV(star);
    if (star.bh) {
        const rsU = star.rs * K;
        g.add(new THREE.Mesh(sphere(rsU, 48, 32, 24, 16), applyTerrellToMaterial(new THREE.MeshBasicMaterial({ color: 0x000000 }))));
        // thin photon-ring halo hugging the horizon
        g.add(fresnelShell(rsU * 1.06, 0xfff2d8, 5.0, .9));
        disk = radialRing(rsU * 1.9, rsU * 7.5, accretionTexture(0xffb46a));
        disk.rotation.x = -Math.PI / 2 + .3;
        g.add(disk);
        // polar jets: stretched additive sprites
        const jetMap = dotTexture("rgba(190,220,255,0.9)", "rgba(120,160,255,0.25)");
        for (const dir of [1, -1]) {
            const jet = new THREE.Sprite(new THREE.SpriteMaterial({ map: jetMap, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .55 }));
            jet.scale.set(rsU * 1.6, rsU * 14, 1);
            jet.position.y = dir * rsU * 7.5;
            g.add(jet);
        }
    } else {
        const color = tempK ? linearStarColor(teffToRGB(tempK, starRGB)) : new THREE.Color(star.color);
        photosphere = new THREE.Mesh(sphere(star.R * K, 64, 48, 32, 24), applyTerrellToMaterial(photosphereMaterial(color)));
        g.add(photosphere);
    }
    const glow = star.bh
        ? new THREE.Sprite(new THREE.SpriteMaterial({
            map: dotTexture(hexRgba(star.color, 1), hexRgba(star.color, .4)),
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .9,
        }))
        : null;
    if (glow) g.add(glow);
    const point = !star.bh && star.activeCatalog ? activeStarPoint(absMag, tempK, star.R) : null;
    if (point) g.add(point);
    if (star.activeCatalog) holdCatalogRow(star.hygIndex, true);
    g.position.set(star.x * K, (star.z || 0) * K, -star.y * K);
    // a hole's own light sits at the lens: drawn unbent after it (lensing.js)
    (star.bh ? holeRoot : scene).add(g);
    const entry = { g, glow, point, disk, photosphere, tempK, absMag, star, id, active, alpha: 0 };
    entries.push(entry);
    entryById.set(id, entry);
    return entry;
}

function buildNamedStarVisuals() {
    if (namedStarsBuilt) return;
    for (const star of STARS) addStarVisual(star);
    namedStarsBuilt = true;
}

export function buildStars() {
    if (forceNamedStarVisuals) buildNamedStarVisuals();
}

const _procPos = new THREE.Vector3();
const _lastActiveVisualSync = new THREE.Vector3();
let activeVisualSynced = false;
let activeVisualSyncAge = Infinity;
const activeVisualKeep = new Set();
const activeVisualCands = [];
function syncActiveStarVisuals(camera, dtR = 0) {
    activeVisualSyncAge += dtR;
    const moved = activeVisualSynced ? camera.position.distanceTo(_lastActiveVisualSync) : Infinity;
    if (activeVisualSyncAge < ACTIVE_VISUAL_SYNC_S && moved < ACTIVE_VISUAL_MOVE_SYNC) return;
    activeVisualKeep.clear();
    activeVisualCands.length = 0;
    for (const star of ACTIVE_STARS) {
        if (!star.procedural && !star.activeCatalog) continue;
        _procPos.set(star.x * K, (star.z || 0) * K, -star.y * K);
        const d = camera.position.distanceTo(_procPos);
        if (d < ACTIVE_VISUAL_RADIUS) activeVisualCands.push({ star, d, id: starVisualId(star) });
    }
    activeVisualCands.sort((a, b) => a.d - b.d);
    for (let i = 0; i < activeVisualCands.length && i < ACTIVE_VISUAL_MAX; i++) {
        activeVisualKeep.add(activeVisualCands[i].id);
        addStarVisual(activeVisualCands[i].star);
    }
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if ((!e.star.procedural && !e.star.activeCatalog) || activeVisualKeep.has(e.id)) continue;
        scene.remove(e.g);
        disposeStarVisual(e);
        entryById.delete(e.id);
        entries.splice(i, 1);
    }
    _lastActiveVisualSync.copy(camera.position);
    activeVisualSynced = true;
    activeVisualSyncAge = 0;
}

// All procedural active stars as one point layer, re-synced whenever the
// active set or its evaluation time changes. Offsets from the first star keep
// float32 precision independent of the distance to the Sun.
const activeProc = { mesh: null, capacity: 0, sig: "" };
export function syncActiveProceduralPoints() {
    const n0 = ACTIVE_STARS.length;
    const sig = activeStarsTime() + ":" + n0 + ":" + (n0 ? ACTIVE_STARS[0].id || ACTIVE_STARS[0].name : "") + ":" + (n0 ? ACTIVE_STARS[n0 - 1].id || ACTIVE_STARS[n0 - 1].name : "");
    if (sig === activeProc.sig) return;
    activeProc.sig = sig;
    let n = 0;
    for (const s of ACTIVE_STARS) if (s.procedural && !s.bh) n++;
    if (!activeProc.mesh || n > activeProc.capacity) {
        if (activeProc.mesh) { scene.remove(activeProc.mesh); activeProc.mesh.geometry.dispose(); }
        const cap = Math.max(64, Math.ceil(n * 1.5));
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
        geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
        geo.setAttribute("absMag", new THREE.BufferAttribute(new Float32Array(cap), 1));
        geo.setAttribute("teffK", new THREE.BufferAttribute(new Float32Array(cap), 1));
        geo.setAttribute("radiusKm", new THREE.BufferAttribute(new Float32Array(cap), 1));
        activePointMaterial ||= makeStarPointMaterial({ radius: true });
        activeProc.mesh = new THREE.Points(geo, activePointMaterial);
        activeProc.mesh.name = "active procedural stars";
        activeProc.mesh.frustumCulled = false;
        activeProc.mesh.renderOrder = -3;
        activeProc.capacity = cap;
        scene.add(activeProc.mesh);
    }
    const a = activeProc.mesh.geometry.attributes;
    let i = 0, cx = 0, cy = 0, cz = 0;
    for (const s of ACTIVE_STARS) {
        if (!s.procedural || s.bh) continue;
        if (i === 0) { cx = s.x; cy = s.y; cz = s.z || 0; }
        a.position.array[i * 3] = (s.x - cx) * K;
        a.position.array[i * 3 + 1] = ((s.z || 0) - cz) * K;
        a.position.array[i * 3 + 2] = -(s.y - cy) * K;
        const teff = s.tempK || 5800;
        const m = activeAbsMagV(s, teff);
        a.absMag.array[i] = Number.isFinite(m) ? m : 99;
        a.teffK.array[i] = teff;
        a.radiusKm.array[i] = s.R || 0;
        linearStarColor(teffToRGB(teff, starRGB), _ptColor);
        a.color.array[i * 3] = _ptColor.r; a.color.array[i * 3 + 1] = _ptColor.g; a.color.array[i * 3 + 2] = _ptColor.b;
        i++;
    }
    activeProc.mesh.position.set(cx * K, cz * K, -cy * K);
    activeProc.mesh.geometry.setDrawRange(0, i);
    for (const key of ["position", "color", "absMag", "teffK", "radiusKm"]) a[key].needsUpdate = true;
}

export function updateStars(camera, dtR) {
    syncActiveProceduralPoints();
    const cameraSolarDistance = camera.position.length();
    if (cameraSolarDistance < LOCAL_VISUAL_SKIP_R) {
        if (!localVisualsHidden) {
            for (const e of entries) e.g.visible = false;
            localVisualsHidden = true;
        }
        // Active stars keep their points (their catalog rows are held):
        // only the photosphere meshes are skipped this close to the Sun.
        for (const e of entries) {
            if (!e.point) continue;
            e.g.position.set(e.star.x * K, (e.star.z || 0) * K, -e.star.y * K);
            e.g.visible = true;
            e.photosphere.visible = false;
        }
        activeVisualSyncAge = Infinity;
        return;
    }
    buildNamedStarVisuals();
    localVisualsHidden = false;
    syncActiveStarVisuals(camera, dtR);
    for (const e of entries) {
        if (e.star.bh) continue;
        e.g.position.set(e.star.x * K, (e.star.z || 0) * K, -e.star.y * K);
        stellarExposure.value = Math.min(stellarExposure.value, meteredSkyExposure(camera, e.g.position, e.star.R * K));
    }
    const pxScale = viewportSize.pxScale;
    for (const e of entries) {
        e.g.position.set(e.star.x * K, (e.star.z || 0) * K, -e.star.y * K);
        const d = camera.position.distanceTo(e.g.position);
        if (!e.star.bh) {
            // The point (catalogStars.js curated layer, or e.point for an
            // active star) fades 0.75 -> 3 px as the photosphere resolves.
            const rScene = e.star.R * K;
            const radiusPx = rScene * pxScale / Math.max(rScene, d);
            const disk = THREE.MathUtils.smoothstep(radiusPx, .75, 3);
            e.photosphere.visible = radiusPx > .3;
            e.g.visible = e.photosphere.visible || !!e.point;
            e.alpha = Math.max(Number.isFinite(e.absMag) ? starPointAlpha(e.absMag, d, e.star.R, stellarExposure.value, pxScale) : 0, e.photosphere.visible ? disk : 0);
        } else {
            const local = 1 - smooth01(LY_SCENE * .015, LY_SCENE * .16, d);
            const skyBeacon = smooth01(LY_SCENE * .0006, LY_SCENE * .02, cameraSolarDistance);
            const alpha = Math.max(.82 * local, .85 * skyBeacon);
            e.g.visible = alpha > .012;
            e.glow.material.opacity = alpha;
            const localScale = Math.min(e.star.rs * K * 14, Math.max(e.star.rs * K * 2.2, d * .002));
            e.glow.scale.setScalar(Math.max(localScale, d * .0075 * skyBeacon));
        }
        if (e.disk) e.disk.rotation.z += dtR * .05;
    }
}
