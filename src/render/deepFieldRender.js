// Extragalactic deep-field renderer (WP24). Draws src/universe/deepField.js's
// procedural galaxy catalog as a distance-shell LOD skybox that replaces
// cosmic.js's old fixed 16k-point deepFieldLayer.
//
// FROZEN CONTRACT for WP23a (cosmic.js, parallel/never edited by this WP):
//   import("../render/deepFieldRender.js").then(m => { m.initDeepField(farGroup); ... })
//   initDeepField(farGroup)         -- idempotent; builds once, adds meshes to farGroup.
//   updateDeepField(camera, simT)   -- call every frame; O(1), zero per-frame allocation.
//   deepFieldReady()                -- true once build finished; only then should the
//                                      caller hide/remove the old deepFieldLayer, so
//                                      there is no frame with neither field visible.
// `farGroup` is expected to be a plain, non-animated Object3D sitting at the
// scene root (e.g. scene.js's `farTierGroup`) -- this module does not read or
// depend on its transform beyond that assumption.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A SKYBOX, NOT A WORLD-FRAME POINT CLOUD (read before changing
// the radius math below):
//
// Every other star layer in this app (Tier-0/Tier-1 catalogs, procedural
// Milky Way) places stars at real Sol-centered world-frame kilometres and
// leans on renderOrigin.js's camera-relative residuals to stay float32-safe,
// because the CAMERA can actually travel to be near those stars (interstellar
// flight, deep jumps). That trick only works because rebasing the residual
// origin onto the camera shrinks the distance between camera and target close
// to zero once the camera is actually there.
//
// Nothing in this game ever leaves the Local Group (the ship's travel range
// stays orders of magnitude inside the 3 Mpc INNER_RADIUS_MPC where
// deepField.js starts generating). So the camera can never get "close" to a
// deep-field galaxy the way it can get close to a star -- the residual
// between camera and a 100 Mpc-distant galaxy stays ~100 Mpc forever, and at
// K=0.001 that is ~1e17 scene units, which is both larger than a physically
// meaningful residual AND still needs to fit in a float32 GPU buffer with no
// meaningful precision gained from rebasing.
//
// So instead of literal physical positions, every galaxy here is stored as
// (direction, distMpc-within-its-shell) and mapped onto a bounded per-shell
// DISPLAY radius (a fraction of CAM_DIST_MAX, comfortably under
// scene.js's camera.far) that preserves ordering (near shell always closer
// than mid, mid always closer than far) and within-shell relative depth, but
// is NOT 1:1 physical Mpc-to-scene-unit -- exactly the same "arbitrary large
// safe radius" choice the OLD deepFieldLayer already shipped with
// (`radius = CAM_DIST_MAX * .78`), just split across three shells instead of
// one.
//
// Parallax honesty: the near shell (3-50 Mpc, sprites) is NOT parented to a
// camera-tracking group -- its instance/point positions are ordinary
// Object3D-space coordinates, so normal Three.js camera math gives it real
// (if visually tiny at ship speeds, genuinely visible if the camera crosses
// the whole ~3.2 Mly Local Group) parallax for free. The mid/far shells ARE
// explicitly locked to camera.position every frame (see `skyboxGroup` below)
// -- a true skybox with zero parallax, chosen because at 50-307 Mpc even the
// full Local-Group-diameter camera excursion is too small a fraction of the
// distance to be worth the extra bookkeeping, and it keeps those two (the
// bulk of the point budget) at a truly fixed, cheap-to-draw geometry.
//
// No shell re-tiling/regeneration is implemented: shells are generated once
// at init. The plan's "skybox with parallax only across shells, regenerate as
// the camera crosses shell boundaries" scenario matters for a game where the
// camera can leave the Local Group; this one's camera cannot, so there is
// nothing to regenerate. If a future WP allows extragalactic travel, this
// module needs real re-tiling -- flagged here rather than silently assumed.
// ---------------------------------------------------------------------------

import * as THREE from "three";
import { K, CAM_DIST_MAX } from "../constants.js";
import { getSeed } from "../universe/galaxy.js";
import { generateDeepField, SHELLS, OUTER_RADIUS_MPC } from "../universe/deepField.js";
import { teffToRGB } from "./viewBrightness.js";

// --- Per-shell compressed display-radius bands (fractions of CAM_DIST_MAX).
// Contiguous and increasing outward so shell boundaries never overlap or gap:
// near sits just beyond the Local Group's own COSMIC_ZOOMS.LOCAL_GROUP ring
// (~0.80 * CAM_DIST_MAX), far approaches but stays under camera.far
// (CAM_DIST_MAX * 1.35, scene.js) with headroom for the fade-to-black edge.
const DISPLAY_BANDS = {
    near: [0.82, 0.90],
    mid: [0.90, 0.95],
    far: [0.95, 0.985],
};

// A galaxy's TRUE angular size (physical sizeKpc / distMpc, small-angle) is
// sub-pixel at any of these distances -- rendering it literally would make
// every sprite an invisible speck (real extragalactic angular sizes are
// arcseconds-to-arcminutes; the "cheat the angular size for visibility"
// trade every space game makes for distant bodies). So the true angular size
// only drives RELATIVE ranking (bigger/closer galaxies read as bigger
// sprites); the actual on-screen angular half-size is a log-percentile
// remap into a fixed, always-sane [MIN,MAX] band, applied against the
// shell's own compressed display radius `r`. This is a clamp, not a raw
// multiplier -- a naive `angularSize * bigConstant` blew up to a
// multi-degree half-angle for the largest/closest near-shell galaxies
// (screen-filling quads, caught in the isolated-scene verification render).
const SPRITE_ANGULAR_HALF_MIN = 0.004; // ~0.23 deg
const SPRITE_ANGULAR_HALF_MAX = 0.012; // ~0.7 deg
// Cap near-shell sprites to a "few hundred" (WP budget) -- the brightest
// (highest apparent flux) galaxies in the near shell get the textured
// billboard treatment; the rest of that shell renders as ordinary points
// alongside the mid/far bulk, same technique, no visual gap.
const NEAR_SPRITE_CAP = 220;

let built = false;
let building = false;
let root = null;       // added directly to farGroup: near sprites + near-faint points (real parallax)
let skyboxGroup = null; // added directly to farGroup: mid+far points (camera-locked, zero parallax)
let atlasTexture = null;

export function deepFieldReady() {
    return built;
}

// --- direction mapping: reuse the app's world-km -> scene axis convention
// (renderOrigin.js/coords.js: scene = (x, z, -y)) so "up" matches every
// other layer, even though these coordinates are decorative Mpc, not real
// equatorial km.
function sceneDir(xMpc, yMpc, zMpc, out) {
    const len = Math.hypot(xMpc, yMpc, zMpc) || 1;
    out.x = xMpc / len; out.y = zMpc / len; out.z = -yMpc / len;
    return out;
}

function displayRadius(shellKey, rMinMpc, rMaxMpc, distMpc) {
    const [lo, hi] = DISPLAY_BANDS[shellKey];
    const t = Math.max(0, Math.min(1, (distMpc - rMinMpc) / (rMaxMpc - rMinMpc)));
    return (lo + t * (hi - lo)) * CAM_DIST_MAX;
}

function fluxOf(g) {
    return (g.Lx / (g.distMpc * g.distMpc)) * g.dimming;
}

// Log-percentile brightness gain within a shell's own flux range -- purely a
// display normalization (no absolute photometric calibration is meaningful
// for a decorative field), tuned so the shell's faintest galaxies stay
// visible above black while its brightest stand out.
function brightnessStats(galaxies) {
    let minF = Infinity, maxF = -Infinity;
    for (const g of galaxies) {
        const f = fluxOf(g);
        if (f < minF) minF = f;
        if (f > maxF) maxF = f;
    }
    if (!(maxF > minF)) { minF = 0; maxF = 1; }
    return { minLog: Math.log10(Math.max(minF, 1e-30)), maxLog: Math.log10(Math.max(maxF, 1e-30)) };
}
function gainOf(g, stats) {
    const lf = Math.log10(Math.max(fluxOf(g), 1e-30));
    const span = stats.maxLog - stats.minLog || 1;
    const t = Math.max(0, Math.min(1, (lf - stats.minLog) / span));
    return 0.22 + Math.pow(t, 0.6) * 0.78;
}

// Redshift color reddening: a decorative exaggeration (real (1+z) shift at
// z<0.072 is far too subtle to read on screen) of the standard cosmological
// reddening direction -- cooler effective color temperature at higher z.
function reddenedTeff(teffK, z) {
    return teffK / (1 + 2.2 * z);
}

const _dir = new THREE.Vector3();
const _rgb = [1, 1, 1];

// --- shared "soft dot" sprite texture for the bulk point layers (mirrors
// cosmic.js's cosmicPointMap, duplicated locally since that one is private to
// cosmic.js and this module must not import from it).
let _dotTex = null;
function dotTexture() {
    if (_dotTex) return _dotTex;
    const cv = document.createElement("canvas");
    cv.width = cv.height = 64;
    const ctx = cv.getContext("2d");
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,0.85)");
    g.addColorStop(.22, "rgba(255,255,255,0.30)");
    g.addColorStop(.6, "rgba(255,255,255,0.05)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    _dotTex = new THREE.CanvasTexture(cv);
    _dotTex.colorSpace = THREE.SRGBColorSpace;
    return _dotTex;
}

// Small 2-cell procedural galaxy atlas (spiral disk-with-arms | elliptical
// blob) for the near-shell billboard sprites. Deterministic layout (fixed
// hand-placed arcs, not per-instance) since this is one shared texture asset,
// not per-galaxy data.
function buildGalaxyAtlas() {
    if (atlasTexture) return atlasTexture;
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = 128;
    const ctx = cv.getContext("2d");

    // --- cell 0 (x: 0..128): spiral, face-on-ish disk with arm streaks ---
    ctx.save();
    ctx.translate(64, 64);
    let g = ctx.createRadialGradient(0, 0, 0, 0, 0, 60);
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(.12, "rgba(235,230,255,0.65)");
    g.addColorStop(.4, "rgba(180,190,255,0.22)");
    g.addColorStop(1, "rgba(120,140,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    for (let arm = 0; arm < 2; arm++) {
        ctx.save();
        ctx.rotate(arm * Math.PI + 0.3);
        ctx.beginPath();
        for (let t = 0; t <= 1; t += 0.02) {
            const a = t * Math.PI * 2.2;
            const r = 6 + t * 46;
            const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.62;
            if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = "rgba(200,210,255,0.28)";
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.restore();
    }
    ctx.restore();

    // --- cell 1 (x: 128..256): elliptical, smooth warm blob ---
    ctx.save();
    ctx.translate(192, 64);
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, 52);
    g.addColorStop(0, "rgba(255,250,235,0.95)");
    g.addColorStop(.25, "rgba(255,225,190,0.5)");
    g.addColorStop(.65, "rgba(255,200,160,0.14)");
    g.addColorStop(1, "rgba(255,200,160,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(0, 0, 52, 40, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    atlasTexture = new THREE.CanvasTexture(cv);
    atlasTexture.colorSpace = THREE.SRGBColorSpace;
    return atlasTexture;
}

// --- bulk point layer (near-faint / mid / far): plain PointsMaterial, fixed
// pixel size, per-vertex color carries the brightness variation -- the same
// proven technique the procedural Milky Way cloud and the old deepFieldLayer
// already use for tens of thousands of points in one draw call.
function buildPointLayer(shell, galaxies, size, opacity, renderOrder) {
    const n = galaxies.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const stats = brightnessStats(galaxies);
    for (let i = 0; i < n; i++) {
        const g = galaxies[i];
        const r = displayRadius(shell.key, shell.rMinMpc, shell.rMaxMpc, g.distMpc);
        sceneDir(g.xMpc, g.yMpc, g.zMpc, _dir);
        pos[i * 3] = _dir.x * r;
        pos[i * 3 + 1] = _dir.y * r;
        pos[i * 3 + 2] = _dir.z * r;
        teffToRGB(reddenedTeff(g.teffK, g.z), _rgb);
        const gain = gainOf(g, stats);
        col[i * 3] = _rgb[0] * gain;
        col[i * 3 + 1] = _rgb[1] * gain;
        col[i * 3 + 2] = _rgb[2] * gain;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
        vertexColors: true,
        size,
        sizeAttenuation: false,
        transparent: true,
        map: dotTexture(),
        alphaTest: .02,
        opacity,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geom, mat);
    pts.frustumCulled = false;
    pts.renderOrder = renderOrder;
    pts.name = "deepField." + shell.key + ".points";
    return pts;
}

// --- instanced billboard layer (near-shell bright sprites): one draw call
// via a shared InstancedBufferAttribute set on a single quad geometry.
// instanceMatrix carries pure translation (no baked rotation/scale) so the
// vertex shader can billboard toward the camera every frame in view space.
const SPRITE_VERT = /* glsl */`
attribute vec3 instColor;
attribute float instSize;
attribute float instSquish;
attribute float instAtlas;
varying vec3 vColor;
varying vec2 vUv;
varying float vAtlas;
void main() {
    vColor = instColor;
    vUv = position.xy + 0.5;
    vAtlas = instAtlas;
    vec3 center = instanceMatrix[3].xyz;
    vec4 mvCenter = modelViewMatrix * vec4(center, 1.0);
    vec2 corner = position.xy * instSize;
    corner.y *= instSquish;
    mvCenter.xy += corner;
    gl_Position = projectionMatrix * mvCenter;
}`;
const SPRITE_FRAG = /* glsl */`
uniform sampler2D uAtlas;
varying vec3 vColor;
varying vec2 vUv;
varying float vAtlas;
void main() {
    vec2 uv = vec2(vUv.x * 0.5 + vAtlas * 0.5, vUv.y);
    vec4 tex = texture2D(uAtlas, uv);
    if (tex.a < 0.02) discard;
    gl_FragColor = vec4(vColor * tex.rgb * 1.4, tex.a);
}`;

function galaxyAngularSize(g) {
    return (g.sizeKpc / 1000) / g.distMpc; // radians, small-angle (physical, uncompressed)
}

// Log-percentile remap of true angular size into the fixed, always-sane
// [SPRITE_ANGULAR_HALF_MIN, MAX] band -- see the constants' comment for why
// this is a clamp/remap rather than a raw multiplier.
function angularSizeStats(galaxies) {
    let minA = Infinity, maxA = -Infinity;
    for (const g of galaxies) {
        const a = galaxyAngularSize(g);
        if (a < minA) minA = a;
        if (a > maxA) maxA = a;
    }
    if (!(maxA > minA)) { minA = 1e-6; maxA = 1e-5; }
    return { minLog: Math.log10(minA), maxLog: Math.log10(maxA) };
}
function angularHalfRad(g, stats) {
    const la = Math.log10(Math.max(galaxyAngularSize(g), 1e-8));
    const span = stats.maxLog - stats.minLog || 1;
    const t = Math.max(0, Math.min(1, (la - stats.minLog) / span));
    return SPRITE_ANGULAR_HALF_MIN + t * (SPRITE_ANGULAR_HALF_MAX - SPRITE_ANGULAR_HALF_MIN);
}

function buildSpriteLayer(shell, galaxies, renderOrder) {
    const stats = brightnessStats(galaxies);
    const ranked = galaxies.map(g => ({ g, f: fluxOf(g) })).sort((a, b) => b.f - a.f);
    const picked = ranked.slice(0, Math.min(NEAR_SPRITE_CAP, ranked.length)).map(r => r.g);
    const n = picked.length;
    const sizeStats = angularSizeStats(picked);

    const quad = new THREE.BufferGeometry();
    quad.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
        -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0,
        -0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));

    const mesh = new THREE.InstancedMesh(quad, new THREE.ShaderMaterial({
        uniforms: { uAtlas: { value: buildGalaxyAtlas() } },
        vertexShader: SPRITE_VERT,
        fragmentShader: SPRITE_FRAG,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.NormalBlending,
    }), Math.max(1, n));

    const instColor = new Float32Array(n * 3);
    const instSize = new Float32Array(n);
    const instSquish = new Float32Array(n);
    const instAtlas = new Float32Array(n);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
        const g = picked[i];
        const r = displayRadius(shell.key, shell.rMinMpc, shell.rMaxMpc, g.distMpc);
        sceneDir(g.xMpc, g.yMpc, g.zMpc, _dir);
        m.makeTranslation(_dir.x * r, _dir.y * r, _dir.z * r);
        mesh.setMatrixAt(i, m);

        teffToRGB(reddenedTeff(g.teffK, g.z), _rgb);
        const gain = gainOf(g, stats);
        instColor[i * 3] = _rgb[0] * gain;
        instColor[i * 3 + 1] = _rgb[1] * gain;
        instColor[i * 3 + 2] = _rgb[2] * gain;

        instSize[i] = angularHalfRad(g, sizeStats) * r;
        instSquish[i] = g.type === "spiral" ? Math.max(.18, Math.cos(g.inclination)) : 1;
        instAtlas[i] = g.type === "spiral" ? 0 : 1;
    }
    mesh.geometry.setAttribute("instColor", new THREE.InstancedBufferAttribute(instColor, 3));
    mesh.geometry.setAttribute("instSize", new THREE.InstancedBufferAttribute(instSize, 1));
    mesh.geometry.setAttribute("instSquish", new THREE.InstancedBufferAttribute(instSquish, 1));
    mesh.geometry.setAttribute("instAtlas", new THREE.InstancedBufferAttribute(instAtlas, 1));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    mesh.name = "deepField.near.sprites";
    return { mesh, pickedSet: new Set(picked) };
}

function buildLayers(field) {
    root = new THREE.Group();
    root.name = "deepField.near";
    skyboxGroup = new THREE.Group();
    skyboxGroup.name = "deepField.skybox";

    const near = field.shells.find(s => s.key === "near");
    const mid = field.shells.find(s => s.key === "mid");
    const far = field.shells.find(s => s.key === "far");

    const { mesh: spriteMesh, pickedSet } = buildSpriteLayer(near, near.galaxies, -3);
    root.add(spriteMesh);
    const nearFaint = near.galaxies.filter(g => !pickedSet.has(g));
    if (nearFaint.length > 0) root.add(buildPointLayer(near, nearFaint, 2.1, .58, -4));

    skyboxGroup.add(buildPointLayer(mid, mid.galaxies, 1.5, .40, -5));
    skyboxGroup.add(buildPointLayer(far, far.galaxies, 1.15, .22, -6));

    return { spriteCount: spriteMesh.count, nearFaintCount: nearFaint.length, midCount: mid.galaxies.length, farCount: far.galaxies.length };
}

export function initDeepField(farGroup) {
    if (built || building || !farGroup) return built;
    building = true;
    try {
        const field = generateDeepField(getSeed());
        const stats = buildLayers(field);
        farGroup.add(root, skyboxGroup);
        built = true;
        if (typeof console !== "undefined") {
            console.log(
                "[deepField] built: near sprites=" + stats.spriteCount +
                " near points=" + stats.nearFaintCount +
                " mid points=" + stats.midCount +
                " far points=" + stats.farCount +
                " outerRadiusMpc=" + OUTER_RADIUS_MPC.toFixed(1) +
                " shells=" + SHELLS.map(s => s.key).join(","),
            );
        }
    } finally {
        building = false;
    }
    return built;
}

// Per-frame update: O(1), zero allocation. Only the mid/far skybox group
// needs any work -- it stays locked to the camera every frame (see the file
// header for why). The near shell needs nothing here: its content sits at
// ordinary Object3D-space coordinates, so normal camera/view matrix math
// already gives it parallax without any per-frame recomputation.
export function updateDeepField(camera /*, simT */) {
    if (!built || !skyboxGroup || !camera) return;
    skyboxGroup.position.copy(camera.position);
}

// --- optional standalone self-test gate -------------------------------------
// `?deepfield=1` on the app URL force-inits this module into the live scene
// and wires a per-frame update, independent of whether WP23a's cosmic.js
// integration has landed yet. Intended for manual/automated visual
// verification (see scripts, run-time console: this module logs its own
// build stats on init). Documented for WP23a as an example call shape.
if (typeof window !== "undefined") {
    let selfGateStarted = false;
    const startSelfGate = async () => {
        if (selfGateStarted) return;
        let params;
        try { params = new URLSearchParams(window.location.search); } catch { return; }
        if (params.get("deepfield") !== "1") return;
        selfGateStarted = true;
        const [{ camera, farTierGroup }, { G }] = await Promise.all([
            import("../scene.js"),
            import("../state.js"),
        ]);
        initDeepField(farTierGroup);
        const tick = () => {
            updateDeepField(camera, G.t || 0);
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };
    if (document.readyState === "complete" || document.readyState === "interactive") startSelfGate();
    else window.addEventListener("DOMContentLoaded", startSelfGate);
}
