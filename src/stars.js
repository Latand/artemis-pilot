import * as THREE from "three";
import { STARS, K, LY_SCENE } from "./constants.js";
import { dotTexture } from "./textures.js";
import { renderQuality, scene } from "./scene.js";
import { smooth01 } from "./format.js";
import { ACTIVE_STARS } from "./universe/activeStars.js";

// Physical renderings for the named stellar destinations. Until now a star
// was only a point in the cosmic layer: flying 4 ly to Proxima showed a dot.
// Each star gets a photosphere mesh + fresnel shell + distance-scaled glow;
// SGR A* gets an event horizon, an accretion disk, and polar jets.
// Known limit: float32 world coordinates wobble at light-year distances —
// close approaches render, but sub-1000 km precision out there is not exact.

const entries = [];
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
    entry.g.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
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
        return existing;
    }
    const g = new THREE.Group();
    let disk = null;
    if (star.bh) {
        const rsU = star.rs * K;
        g.add(new THREE.Mesh(sphere(rsU, 48, 32, 24, 16), new THREE.MeshBasicMaterial({ color: 0x000000 })));
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
        const col = new THREE.Color(star.color);
        g.add(new THREE.Mesh(sphere(star.R * K, 48, 32, 24, 16), new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.15) })));
        g.add(fresnelShell(star.R * K * 1.3, star.color, 2.2, .5));
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: dotTexture(hexRgba(star.color, 1), hexRgba(star.color, .4)),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .9,
    }));
    g.add(glow);
    g.position.set(star.x * K, (star.z || 0) * K, -star.y * K);
    scene.add(g);
    const entry = { g, glow, disk, star, id };
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

export function updateStars(camera, dtR) {
    const cameraSolarDistance = camera.position.length();
    if (cameraSolarDistance < LOCAL_VISUAL_SKIP_R) {
        if (!localVisualsHidden) {
            for (const e of entries) e.g.visible = false;
            localVisualsHidden = true;
        }
        activeVisualSyncAge = Infinity;
        return;
    }
    buildNamedStarVisuals();
    localVisualsHidden = false;
    syncActiveStarVisuals(camera, dtR);
    for (const e of entries) {
        e.g.position.set(e.star.x * K, (e.star.z || 0) * K, -e.star.y * K);
        const d = camera.position.distanceTo(e.g.position);
        const local = 1 - smooth01(LY_SCENE * .015, LY_SCENE * .16, d);
        // beacon brightness must ramp in at the SAME zoom the labels do, otherwise
        // you see a name floating over empty space. Reach full brightness early.
        const skyBeacon = smooth01(LY_SCENE * .0006, LY_SCENE * .02, cameraSolarDistance);
        // sky-beacon stars read as crisp bright balls, not just their labels:
        // hold the glow at full opacity so Proxima / Sirius / Vega show as small
        // luminous points the way the eye expects real stars to look.
        const farAlpha = (e.star.bh ? .85 : 1) * skyBeacon;
        const alpha = Math.max(.82 * local, farAlpha);
        e.g.visible = alpha > .012;
        e.glow.material.opacity = alpha;
        const localScale = e.star.bh
            ? Math.min(e.star.rs * K * 14, Math.max(e.star.rs * K * 2.2, d * .002))
            : Math.min(e.star.R * K * 48, Math.max(e.star.R * K * 4.5, d * .0022));
        // brighter / more luminous stars get a fatter dot so the sky has a hierarchy;
        // the beacon tracks distance so its on-screen size stays roughly constant
        // every named star should read as a clear bright ball; brighter/larger
        // stars get a fatter dot on top of a solid floor so none of them vanish
        const beaconGain = e.star.bh ? 1 : 1.2 + Math.min(1.1, (e.star.lumSolar ? Math.log10(e.star.lumSolar + 1) * .14 : (e.star.R || 1) > 3 ? .4 : 0));
        const skyScale = d * (e.star.bh ? .0075 : .0048) * skyBeacon * beaconGain;
        e.glow.scale.setScalar(Math.max(localScale, skyScale));
        if (e.disk) e.disk.rotation.z += dtR * .05;
    }
}
