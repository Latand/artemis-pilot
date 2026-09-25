import * as THREE from "three";
import { stellarExposure } from "./render/stellarAppearance.js";
import { AU_KM, CAM_DIST_MAX, COSMIC_ZOOMS, K, LY_SCENE, SEC_YEAR, MPC_KM } from "./constants.js";
import { mulberry32, smooth01 } from "./format.js";
import { G } from "./state.js";
import { cam } from "./scene.js";
import { toast } from "./achievements.js";
import { makeGalaxyCloudAsync, galacticCenterScene, galacticRingPositions, applyEraToCloud } from "./universe/starfield.js";
import { galToSceneUnitsInto } from "./universe/coords.js";
import { GALACTIC_ORBIT_PERIOD_S } from "./universe/solarOrbit.js";
import { eraModulation, setMergerEpochGyr } from "./universe/cosmicEra.js";
import {
    onMergerTable, mergerEpochGyr, mergerSeparationKpcAt, mergerDisruptFractionAt, mergerDebugState,
    andromedaOffsetMpc, localGroupBarycentreMpc,
} from "./universe/localGroupOrbit.js";
export { mergerEpochGyr, mergerSeparationKpcAt, mergerDisruptFractionAt, mergerDebugState, andromedaOffsetMpc, localGroupBarycentreMpc };
import { PERF, markPerf } from "./perf.js";
import { galaxyVolumeEnabled } from "./render/galaxyVolume.js";

// Galactic-centre position in scene units (toward Sgr A*, ~26,700 ly). The
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
const galaxyMotionRoot = new THREE.Group();
const galaxyRoot = new THREE.Group();
const labelRoot = new THREE.Group();
galaxyMotionRoot.position.set(GC_SCENE[0], GC_SCENE[1], GC_SCENE[2]);
galaxyRoot.position.set(-GC_SCENE[0], -GC_SCENE[1], -GC_SCENE[2]);
galaxyMotionRoot.add(galaxyRoot);
diskRoot.add(galaxyMotionRoot);
root.add(diskRoot, labelRoot);
root.visible = false;
let pointMap = null;
const GALAXY_OMEGA0 = Math.PI * 2 / GALACTIC_ORBIT_PERIOD_S;
const GALACTIC_NORTH_SCENE_AXIS = (() => {
    const gc = [0, 0, 0], north = [0, 0, 0];
    galToSceneUnitsInto(0, 0, 0, gc, 0, K);
    galToSceneUnitsInto(0, 0, 1, north, 0, K);
    return new THREE.Vector3(north[0] - gc[0], north[1] - gc[1], north[2] - gc[2]).normalize();
})();
let cosmicVisualBucket = "";

// Milky Way - Andromeda orbit: universe/localGroupOrbit.js (pure).
onMergerTable(tbl => setMergerEpochGyr(tbl.mergedSec / (1e9 * SEC_YEAR)));

export function isCosmicLayerBuilt() {
    return layerBuilt;
}

function setDisruptUniforms(uniforms, disrupt, eraRed) {
    if (!uniforms) return;
    if (uniforms.uDisrupt) uniforms.uDisrupt.value = disrupt;
    if (uniforms.uEraRed) uniforms.uEraRed.value = eraRed;
}

let mwDiskMergeUniforms = null;

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

// A disk point-cloud that can progressively scatter into a spheroid and
// redden, driven by `uDisrupt` (WP23a merger visual) and `uEraRed` (WP23c
// era hook) uniforms. Used for both the Milky Way's own procedural disk
// cloud (the fallback drawn only when the volumetric layer is off).
//
// `scatterTarget` is a per-point randomized position on a puffed-out
// spheroid with the same characteristic radius as the source disk
// (precomputed once, deterministic in `seed`) - at uDisrupt=1 the cloud
// looks like a pressure-supported elliptical remnant instead of flying
// apart to infinity.
function mergeableDiskPoints(pos, col, opts = {}) {
    const { size = 1.2, opacity = .5, seed = 1 } = opts;
    const count = pos.length / 3;
    const scatter = new Float32Array(count * 3);
    const rnd = mulberry32(seed | 0);
    let maxR = 1;
    for (let i = 0; i < count; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        const r = Math.sqrt(x * x + y * y * 4 + z * z);
        if (r > maxR) maxR = r;
        const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2;
        const side = Math.sqrt(Math.max(0, 1 - u * u));
        scatter[i * 3] = Math.cos(th) * side * r;
        scatter[i * 3 + 1] = u * r * .7;
        scatter[i * 3 + 2] = Math.sin(th) * side * r;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geom.setAttribute("scatterTarget", new THREE.BufferAttribute(scatter, 3));
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uSize: { value: size },
            uOpacity: { value: opacity },
            uDisrupt: { value: 0 },
            uEraRed: { value: 0 },
            uRadiusScale: { value: maxR },
        },
        vertexShader: /* glsl */`
            attribute vec3 scatterTarget;
            varying vec3 vColor;
            uniform float uSize, uDisrupt, uEraRed, uRadiusScale;
            void main() {
                float m = smoothstep(0.0, 1.0, uDisrupt);
                // Shear/twist the still-disk-like points before they fully
                // leave the plane (inner region shears faster, mimicking
                // differential rotation winding up during the approach).
                float rr = length(position.xz);
                float twist = uDisrupt * 2.4 * (1.0 - clamp(rr / uRadiusScale, 0.0, 1.0));
                float tc = cos(twist), ts = sin(twist);
                vec3 sheared = vec3(position.x * tc - position.z * ts, position.y, position.x * ts + position.z * tc);
                vec3 mixed = mix(sheared, scatterTarget, m);
                float red = clamp(m * .85 + uEraRed * .5, 0.0, 1.0);
                vColor = mix(color, vec3(1.0, 0.62, 0.42), red);
                vec4 mvPosition = modelViewMatrix * vec4(mixed, 1.0);
                gl_PointSize = uSize;
                gl_Position = projectionMatrix * mvPosition;
            }`,
        fragmentShader: /* glsl */`
            varying vec3 vColor;
            uniform float uOpacity;
            void main() {
                vec2 uv = gl_PointCoord - 0.5;
                float r2 = dot(uv, uv);
                if (r2 > 0.25) discard;
                float g = exp(-r2 * 10.0);
                gl_FragColor = vec4(vColor, g * uOpacity);
            }`,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
    });
    mat.userData.baseOpacity = opacity;
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

// The Milky Way fallback cloud (only drawn with ?galaxyvol=0) follows the
// Galactic centre as the Sun orbits, rotates with the disk, and takes the
// merger's disk -> spheroid disruption.
function updateLocalGalaxyMotion() {
    const t = G.t;
    const gc = galacticCenterScene();
    diskRoot.position.set(gc[0] - GC_SCENE[0], gc[1] - GC_SCENE[1], gc[2] - GC_SCENE[2]);
    galaxyMotionRoot.quaternion.setFromAxisAngle(GALACTIC_NORTH_SCENE_AXIS, GALAXY_OMEGA0 * t);
    setDisruptUniforms(mwDiskMergeUniforms, mergerDisruptFractionAt(t), eraModulation(t).redshiftTint);
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
        // WP23a: built with the disruptable/reddenable shader (mergeableDiskPoints)
        // instead of the plain points() helper, so the MW's own disk can puff
        // into "Milkomeda" alongside M31's disk during the merger.
        // Only needed as the fallback for ?galaxyvol=0.
        if (!galaxyVolumeEnabled()) {
            const mwCloud = await makeGalaxyCloudAsync(170000, 0x6d57, 4096, idleSlice);
            const mwDisk = mergeableDiskPoints(mwCloud.pos, mwCloud.col, { size: 1.20, opacity: .5, seed: 0x6d57 ^ 0x77 });
            mwDiskMergeUniforms = mwDisk.material.uniforms;
            galaxyRoot.add(mwDisk);
            await idleSlice();
            galaxyRoot.add(milkyWayHalo());
            galaxyRoot.add(galacticPlaneRing(8178, 0x53617a, .30));
            galaxyRoot.add(galacticPlaneRing(16000, 0x344058, .24));
            await idleSlice();
        }
        // Curated destinations and the HYG catalog are drawn at every scale by
        // render/catalogStars.js (shared resolved-star material), not here.
        // Other galaxies -- the Local Group, the Local Volume, 2MRS and the
        // statistical universe beyond -- are one population drawn by
        // render/galaxyPopulationRender.js.
        layerBuilt = true;
        cosmicVisualBucket = "";
        if (PERF.enabled) markPerf("cosmic.buildLayer", performance.now() - t0, { fallbackCloud: !galaxyVolumeEnabled() });
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
    if (ly < 1e9) return (ly / 1e6).toFixed(ly < 1e7 ? 2 : 0) + " Mly";
    return (ly / 1e9).toFixed(2) + " Gly";
}


// Scale stops: Solar System -> Milky Way -> Local Group (its barycentre) ->
// cosmic web (the Local Supercluster and beyond, centred on the Local Group).
const _lg = [0, 0, 0];
function localGroupScene(out) {
    localGroupBarycentreMpc(G.t, _lg);
    const gc = galacticCenterScene();
    const k = MPC_KM * K;
    out.set(gc[0] + _lg[0] * k, gc[1] + _lg[2] * k, gc[2] - _lg[1] * k);
    return out;
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
        localGroupScene(cam.tgt);
        toast("Scale: Local Group · " + cosmicScaleLabel());
    } else if (cam.dist < LY_SCENE * 5e7) {
        cam.dist = COSMIC_ZOOMS.COSMIC_WEB;
        G.focus = "free";
        localGroupScene(cam.tgt);
        toast("Scale: cosmic web · " + cosmicScaleLabel());
    } else {
        cam.dist = COSMIC_ZOOMS.SOLAR;
        G.focus = "ship";
        toast("Scale: Solar System");
    }
}

export function updateCosmicLayer() {
    // The main loop skips body updates at cosmic scales. Reset metering here
    // so an Earth close-up cannot leave the galactic sky underexposed.
    // (Beyond the Local Group the galaxy layer meters its own exposure,
    // render/galaxyPopulationRender.js.)
    if (cam.dist > LY_SCENE * .2) stellarExposure.value = 1;
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
    const gal = smooth01(LY_SCENE * 40, LY_SCENE * 5000, cam.dist);
    const galaxyVisible = gal > .01;
    updateLocalGalaxyMotion();
    const label = "COSMIC SCALE · " + cosmicScaleLabel();
    const bucket = [Math.round(gal * 100), galaxyVisible ? 1 : 0, label].join("|");
    // The Milky Way's own light comes from the volumetric model
    // (render/galaxyVolume.js); this point cloud remains only as the
    // fallback when that layer is disabled (?galaxyvol=0).
    const fallback = galaxyVisible && !galaxyVolumeEnabled();
    root.visible = fallback;
    diskRoot.visible = fallback;
    galaxyRoot.visible = fallback;
    if (fallback) {
        const era = eraModulation(G.t);
        for (const child of galaxyRoot.children) {
            if (child.material) {
                child.material.userData.baseOpacity = child.isPoints ? .18 + .72 * gal : .07 + .24 * gal;
                applyEraToCloud(child, era);
            } else {
                applyEraToCloud(child, { lumFactor: (.22 + .68 * gal) * era.lumFactor, redshiftTint: era.redshiftTint });
            }
        }
    }
    if (bucket === cosmicVisualBucket) return;
    cosmicVisualBucket = bucket;
    if (scaleEl) {
        scaleEl.style.opacity = gal > .01 ? "1" : "0";
        scaleEl.textContent = label;
    }
}

export { CAM_DIST_MAX };
