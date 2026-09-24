// Tidal-disruption visuals: the debris of tdeDebris.js drawn as glowing fluid
// elements, and live tidal distortion of the body meshes. Everything is a
// function of simulation time (G.t) — never the wall clock — so a paused
// frame is frozen and any warp shows the same state at the same sim time.
//
// Debris. Each element's position comes from its own (precessing) conic
// about the hole (see tdeDebris.js: frozen-in energy spread, centre-of-mass
// angular momentum, circularization of the returning stream, asymptotic
// plunge). The stream, the bound/unbound split and the fallback emerge from
// those orbits. The colour is a blackbody that heats as the stream is
// compressed near the hole and cools as it expands (the more bound half a
// little hotter), redshifted by sqrt(1 - r_s/r) with brightness x g^4 near
// the horizon.
//
// Distortion. Before disruption (and for flybys and partials) each body mesh
// is stretched along the live body->hole axis by the equilibrium tide:
// elongation 1 + h2 s, s = (M/m)(R/r)^3, with a volume-preserving transverse
// compression, applied to the mesh's world matrix at render time. A
// partially disrupted body keeps a shrunken remnant; a fully disrupted one
// hands over to its debris at the freeze epoch.
import * as THREE from "three";
import { K, PL, C_LIGHT } from "./constants.js";
import { G, BH, WORLD, bodyScaleIndex, isBodyDestroyed } from "./state.js";
import { eph } from "./ephemeris.js";
import { ENC, TDES, CAPTURES, BODY_TARGETS, bodyState, bodyMuLive, bodyRadiusLive } from "./bhEncounters.js";
import { DebrisModel, debrisCountFor, loveH2, tidalElongation } from "./tdeDebris.js";
import { scene, viewportSize } from "./scene.js";
import { sunCore, sunCorona, earth, clouds, earthAtmo, moon, plGroups } from "./bodies.js";

export const DEBRIS_BUDGET = 4096;

// ---- small colour helpers ----
function srgbToLinear(c) { return c <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4); }
// Blackbody colour (Tanner Helland fit), linear RGB, max component 1.
export function blackbodyLinear(T, out) {
    const t = Math.max(10, Math.min(400, T / 100));
    let r, g, b;
    if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
    else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
    if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    out[0] = srgbToLinear(Math.min(1, Math.max(0, r / 255)));
    out[1] = srgbToLinear(Math.min(1, Math.max(0, g / 255)));
    out[2] = srgbToLinear(Math.min(1, Math.max(0, b / 255)));
    return out;
}
function hexLinear(hex, out) {
    out[0] = srgbToLinear(((hex >> 16) & 255) / 255);
    out[1] = srgbToLinear(((hex >> 8) & 255) / 255);
    out[2] = srgbToLinear((hex & 255) / 255);
    return out;
}

// ---- body properties for the visuals ----
function bodyHexColor(target) {
    if (target === "earth") return 0x4d78a8;
    if (target === "moon") return 0x9b9a93;
    if (target === "sun") return 0xffd2a0;
    return typeof target === "number" && PL[target] ? PL[target].color : 0x9b8068;
}
const SUN_TEFF = 5772;

// ---- debris systems ----
const tdeGroup = new THREE.Group();
tdeGroup.name = "tde.debris";
scene.add(tdeGroup);
export function tdeVisualGroup() { return tdeGroup; }
const SYSTEMS = new Map(); // spec -> DebrisSystem
let budgetUsed = 0;

// Each particle is a soft sprite of a fixed physical size (a fraction of the
// body radius: a fluid element), never smaller than uMinPx on screen. Close
// up the elements overlap into a continuous glowing cloud; as the stream
// stretches they separate into the beaded filament seen in SPH renderings;
// from afar they are a thin line of minimum-size points. A sprite only a
// couple of pixels across would sample just the tail of a Gaussian at the
// pixel centres, so the profile flattens as the sprite shrinks.
const debrisMaterial = () => new THREE.ShaderMaterial({
    uniforms: {
        uSize: { value: 1 },        // element diameter, scene units
        uProj: { value: 800 },      // px per unit angle: viewport height / (2 tan(fov/2))
        uMinPx: { value: 2 },
        uMaxPx: { value: 72 },
        uPixelRatio: { value: 1 },
    },
    vertexShader: /* glsl */`
        attribute vec3 aColor;
        attribute float aAlpha;
        uniform float uSize, uProj, uMinPx, uMaxPx, uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vK;
        void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            float px = uSize * uProj / max(1e-9, -mv.z);
            float s = clamp(px, uMinPx, uMaxPx);
            // an unresolved element is drawn at the minimum size, dimmed
            // toward (but not below) a visibility floor: a stream far
            // thinner than a pixel still reads as a thin line
            vAlpha = aAlpha * (px < uMinPx ? max(.6, px / uMinPx) : 1.0);
            vK = mix(.35, 3.2, clamp((s - uMinPx) / 6.0, 0.0, 1.0));
            vColor = aColor;
            gl_PointSize = aAlpha > 0.0 ? s * uPixelRatio : 0.0;
        }`,
    fragmentShader: /* glsl */`
        varying vec3 vColor;
        varying float vAlpha;
        varying float vK;
        void main() {
            vec2 d = gl_PointCoord - 0.5;
            float r2 = dot(d, d) * 4.0;
            if (r2 > 1.0) discard;
            float a = vAlpha * exp(-r2 * vK);
            gl_FragColor = vec4(vColor * a, a);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
        }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});

const _pf = [0, 0, 0];
const _c3 = [0, 0, 0], _c3b = [0, 0, 0];

class DebrisSystem {
    constructor(spec, count) {
        this.spec = spec;
        this.count = count;
        this.m = new DebrisModel(spec, count);
        this.pos = new Float32Array(count * 3);
        this.col = new Float32Array(count * 3);
        this.alp = new Float32Array(count);
        this.lastT = NaN;
        this.last = { x: 0, y: 0, z: 0 };
        const g = new THREE.BufferGeometry();
        this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
        this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
        this.alpAttr = new THREE.BufferAttribute(this.alp, 1).setUsage(THREE.DynamicDrawUsage);
        g.setAttribute("position", this.posAttr);
        g.setAttribute("aColor", this.colAttr);
        g.setAttribute("aAlpha", this.alpAttr);
        // a fluid element: ~3 mean interparticle spacings across, so the
        // fresh cloud overlaps into a continuous body
        const vFrac = spec.kind === "partial" ? Math.max(.04, .35 * (spec.massLossFrac || 0)) : 1;
        this.elemKm = 3 * spec.R * Math.cbrt(4 * Math.PI * vFrac / (3 * count));
        this.points = new THREE.Points(g, debrisMaterial());
        this.points.material.uniforms.uSize.value = this.elemKm * K;
        this.points.frustumCulled = false;
        this.points.renderOrder = 7;
        tdeGroup.add(this.points);
    }
    update(t) {
        if (t === this.lastT) return;
        this.lastT = t;
        const sp = this.spec, n = this.count;
        const rt = sp.rt, rs = Math.max(1e-12, sp.rs);
        const star = sp.target === "sun";
        const base = hexLinear(bodyHexColor(sp.target), _c3b);
        const b0 = base[0], b1 = base[1], b2 = base[2];
        const tBody = star ? SUN_TEFF : 900;
        let sx = 0, sy = 0, sz = 0, live = 0;
        const out = _pf;
        const m = this.m;
        for (let i = 0; i < n; i++) {
            let a = m.particleAt(i, t, out);
            const j = i * 3;
            if (!(a > 0)) { this.alp[i] = 0; continue; }
            const x = out[0], y = out[1], z = out[2];
            const r = Math.hypot(x, y, z);
            // gravitational redshift for a distant observer: frequency x g,
            // surface brightness x g^4
            const g2 = Math.max(0, 1 - rs / Math.max(r, rs));
            const gz = Math.sqrt(g2);
            a *= g2 * g2;
            // compression heats the stream near the hole, expansion cools it
            // until hydrogen recombination holds its photosphere at a few
            // thousand K; the more bound half (u < 0, born on the near side)
            // is the half that returns and shocks, so it runs a little hotter
            const heat = Math.min(4.5, Math.max(.7, Math.sqrt(rt / Math.max(r, 1e-9)))) * (1 - .14 * m.u[i]);
            const T = tBody * heat * gz;
            let cr, cg, cb;
            if (star) {
                blackbodyLinear(T, _c3);
                cr = _c3[0]; cg = _c3[1]; cb = _c3[2];
            } else {
                // rock and gas debris: reflected colour, glowing where the tide
                // compresses and shocks it
                const glow = Math.min(1, Math.max(0, (heat - .9) * .9));
                blackbodyLinear(Math.max(1200, 2200 * heat) * gz, _c3);
                cr = b0 * (1 - glow) + _c3[0] * glow;
                cg = b1 * (1 - glow) + _c3[1] * glow;
                cb = b2 * (1 - glow) + _c3[2] * glow;
            }
            // denser, brighter near the hole; the far stream thins out
            a *= Math.min(1.5, Math.max(.6, Math.pow(rt / Math.max(r, 1e-9), .3)));
            this.pos[j] = x * K; this.pos[j + 1] = z * K; this.pos[j + 2] = -y * K;
            this.col[j] = cr; this.col[j + 1] = cg; this.col[j + 2] = cb;
            this.alp[i] = Math.min(1, a * .5);
            sx += x; sy += y; sz += z; live++;
        }
        this.live = live;
        if (live) { this.last.x = sx / live; this.last.y = sy / live; this.last.z = sz / live; }
        this.posAttr.needsUpdate = true;
        this.colAttr.needsUpdate = true;
        this.alpAttr.needsUpdate = true;
    }
    dispose() {
        tdeGroup.remove(this.points);
        this.points.geometry.dispose();
        this.points.material.dispose();
    }
}

function specOwnerHole(spec) {
    for (let k = 0; k < TDES.length; k++) if (TDES[k].debris === spec) return TDES[k].bh;
    for (let k = 0; k < CAPTURES.length; k++) if (CAPTURES[k].debris === spec) return CAPTURES[k].bh;
    for (let k = 0; k < ENC.length; k++) if (ENC[k].debris === spec) return ENC[k].bh;
    return -1;
}
const _live = new Set();
function syncSystems(t) {
    _live.clear();
    const consider = spec => {
        if (!spec || _live.has(spec)) return;
        if (t < spec.t0) return;
        // a long-finished system retires (the flare itself lives on)
        const tFb = spec.tFb > 0 ? spec.tFb : 86400;
        if (t - spec.t0 > 60 * tFb && spec.kind !== "captured") return;
        if (spec.kind === "captured" && t - spec.t0 > 3e3 * Math.max(1, spec.rCap / C_LIGHT) + 30 * Math.sqrt(Math.pow(Math.max(spec.rt, spec.rCap), 3) / spec.mu)) return;
        _live.add(spec);
    };
    for (let k = 0; k < ENC.length; k++) consider(ENC[k].debris);
    for (let k = 0; k < TDES.length; k++) consider(TDES[k].debris);
    for (let k = 0; k < CAPTURES.length; k++) consider(CAPTURES[k].debris);
    for (const [spec, sys] of SYSTEMS) {
        if (!_live.has(spec)) { budgetUsed -= sys.count; sys.dispose(); SYSTEMS.delete(spec); }
    }
    for (const spec of _live) {
        if (SYSTEMS.has(spec)) continue;
        const want = debrisCountFor(spec);
        const count = Math.min(want, DEBRIS_BUDGET - budgetUsed);
        if (count < 128) continue;
        SYSTEMS.set(spec, new DebrisSystem(spec, count));
        budgetUsed += count;
    }
}

// ---- tidal distortion of body meshes ----
const DEFORM = new Map(); // target -> { lambda, ax, ay, az (scene axis), shrink, collapse }
BODY_TARGETS.forEach(t => DEFORM.set(t, { lambda: 1, ax: 1, ay: 0, az: 0, shrink: 1, collapse: 0, active: false, holeX: 0, holeY: 0, holeZ: 0 }));
const _bs = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
let hooked = false;
const _m4 = new THREE.Matrix4(), _t4 = new THREE.Matrix4();
function deformBefore() {
    const st = DEFORM.get(this.userData.tdeTarget);
    if (!st || !st.active) return;
    const me = this.matrixWorld.elements;
    this.userData.tdeSaved.copy(this.matrixWorld);
    const cx = me[12], cy = me[13], cz = me[14];
    // axis toward the hole in scene space, measured from this mesh's centre
    let ax = st.holeX - cx, ay = st.holeY - cy, az = st.holeZ - cz;
    const al = Math.hypot(ax, ay, az);
    if (al > 1e-12) { ax /= al; ay /= al; az /= al; } else { ax = st.ax; ay = st.ay; az = st.az; }
    const s = st.shrink * (1 - st.collapse);
    const lam = st.lambda, mp = 1 / Math.sqrt(lam);
    const d = lam - mp;
    // D = s [ mp I + (lam - mp) a a^T ] about the body centre
    _m4.set(
        s * (mp + d * ax * ax), s * d * ax * ay, s * d * ax * az, 0,
        s * d * ay * ax, s * (mp + d * ay * ay), s * d * ay * az, 0,
        s * d * az * ax, s * d * az * ay, s * (mp + d * az * az), 0,
        0, 0, 0, 1);
    _t4.makeTranslation(-cx, -cy, -cz);
    _m4.multiply(_t4);
    _t4.makeTranslation(cx, cy, cz);
    _m4.premultiply(_t4);
    this.matrixWorld.premultiply(_m4);
}
function deformAfter() {
    const st = DEFORM.get(this.userData.tdeTarget);
    if (!st || !st.active) return;
    this.matrixWorld.copy(this.userData.tdeSaved);
}
function hookMesh(mesh, target) {
    if (!mesh || mesh.userData.tdeHooked) return;
    mesh.userData.tdeHooked = true;
    mesh.userData.tdeTarget = target;
    mesh.userData.tdeSaved = new THREE.Matrix4();
    const prevB = mesh.onBeforeRender, prevA = mesh.onAfterRender;
    mesh.onBeforeRender = function (...a) { prevB.apply(this, a); deformBefore.call(this); };
    mesh.onAfterRender = function (...a) { deformAfter.call(this); prevA.apply(this, a); };
}
function installHooks() {
    if (hooked || !sunCore || !earth || !moon || plGroups.length !== PL.length) return;
    hooked = true;
    hookMesh(sunCore, "sun");
    hookMesh(sunCorona, "sun");
    hookMesh(earth, "earth");
    hookMesh(clouds, "earth");
    hookMesh(earthAtmo, "earth");
    hookMesh(moon, "moon");
    for (let p = 0; p < PL.length; p++) plGroups[p].traverse(o => { if (o.isMesh) hookMesh(o, p); });
}
function updateDeformations(t, earthScX, earthScZ) {
    for (let b = 0; b < BODY_TARGETS.length; b++) {
        const target = BODY_TARGETS[b];
        const st = DEFORM.get(target);
        st.active = false;
        st.collapse = 0;
        if (isBodyDestroyed(target)) continue;
        st.shrink = WORLD.rScale[bodyScaleIndex(target)];
        const muB = bodyMuLive(target);
        if (!(muB > 0)) continue;
        const R = bodyRadiusLive(target, t); // includes a stripped core's shrink
        bodyState(target, _bs);
        let best = 0, bi = -1, bx = 0, by = 0, bz = 0;
        for (let i = 0; i < BH.n; i++) {
            const dx = BH.x[i] - _bs.x, dy = BH.y[i] - _bs.y, dz = BH.z[i] - _bs.z;
            const r = Math.max(Math.hypot(dx, dy, dz), 1.2 * R);
            const s = BH.mu[i] / muB * Math.pow(R / r, 3);
            if (s > best) { best = s; bi = i; bx = dx; by = dy; bz = dz; }
        }
        const lam = bi >= 0 ? tidalElongation(best, loveH2(target)) : 1;
        st.lambda = lam;
        // scene axis (world km -> scene: x, z, -y)
        const al = Math.hypot(bx, by, bz) || 1;
        st.ax = bx / al; st.ay = bz / al; st.az = -by / al;
        if (bi >= 0) {
            st.holeX = earthScX + BH.sx[bi]; st.holeY = BH.sy[bi]; st.holeZ = earthScZ + BH.sz[bi];
        }
        // the debris has taken over from the mesh once its orbits have started
        for (const spec of SYSTEMS.keys()) {
            if (spec.target === target && spec.kind !== "partial" && t >= spec.t0) st.collapse = 1;
        }
        st.active = lam > 1.0005 || st.shrink < .9995 || st.collapse > 0;
    }
}

// Per frame (from blackholes.js updateBHVisuals). Hole groups are already
// positioned; debris positions are relative to their hole.
export function updateTdeVisuals(earthScX, earthScZ, pixelRatio = 1, t = G.t) {
    installHooks();
    syncSystems(t);
    for (const [spec, sys] of SYSTEMS) {
        const bi = specOwnerHole(spec);
        if (bi < 0 || bi >= BH.n) { sys.points.visible = false; continue; }
        sys.points.visible = true;
        sys.points.position.set(earthScX + BH.sx[bi], BH.sy[bi], earthScZ + BH.sz[bi]);
        const u = sys.points.material.uniforms;
        u.uPixelRatio.value = pixelRatio;
        u.uProj.value = viewportSize.pxScale;
        sys.update(t);
    }
    updateDeformations(t, earthScX, earthScZ);
}
export function tdeDebrisStats() {
    let particles = 0, live = 0;
    for (const sys of SYSTEMS.values()) { particles += sys.count; live += sys.live || 0; }
    return { systems: SYSTEMS.size, particles, live, budget: DEBRIS_BUDGET };
}
export function tidalState(target) { return DEFORM.get(target); }
// Inspection (captures, tests): per debris system its target, kind, live
// particle count, and the centroid / radius of the live cloud relative to its
// hole (km, world axes).
export function debrisSystemsInfo() {
    const out = [];
    for (const sys of SYSTEMS.values()) {
        let r2 = 0, n = 0;
        const c = sys.last;
        const cen = sys.m.census(sys.lastT);
        const rr = [];
        for (let i = 0; i < sys.count; i++) {
            if (!(sys.alp[i] > 0)) continue;
            const j = i * 3;
            const hx = sys.pos[j] / K, hy = -sys.pos[j + 2] / K, hz = sys.pos[j + 1] / K;
            rr.push(Math.hypot(hx, hy, hz));
            const x = hx - c.x, y = hy - c.y, z = hz - c.z;
            r2 += x * x + y * y + z * z; n++;
        }
        rr.sort((a, b) => a - b);
        out.push({
            target: sys.spec.target, kind: sys.spec.kind, count: sys.count, live: n, cx: c.x, cy: c.y, cz: c.z,
            radius: n ? Math.sqrt(r2 / n) : 0, bh: specOwnerHole(sys.spec), t0: sys.spec.t0,
            bound: cen.bound, unbound: cen.unbound, returned: cen.returned, plunged: cen.plunged, accreted: cen.accreted,
            kappa: sys.m.model.kappa, epsCm: sys.m.model.epsCm, dEps: sys.m.model.dEps,
            rMin: rr[0] || 0, rMedian: rr[rr.length >> 1] || 0, rMax: rr[rr.length - 1] || 0,
        });
    }
    return out;
}
