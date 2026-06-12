import * as THREE from "three";
import { BH_MAX, BH_SIZES, C_LIGHT, MU_E, MU_M, MU_S, R_EARTH, R_MOON, R_SUN, PL, K } from "./constants.js";
import { BH, WORLD, bhRegister } from "./state.js";
import { eph } from "./ephemeris.js";
import { fmtKm, mulberry32 } from "./format.js";
import { dotTexture, ringTexture } from "./textures.js";
import { scene, camera, cvHost, lastPtr } from "./scene.js";

export const BH_META = []; // visual groups, parallel to the data arrays

let H = {
    toast: () => { }, predict: () => { }, cataclysm: () => { },
    disrupt: () => "", absorbed: () => { },
};
export function initBHHooks(hooks) { H = { ...H, ...hooks }; }

export function bhMassLabel(rs) {
    const msun = rs * C_LIGHT * C_LIGHT / 2 / MU_S;
    return (msun >= 100 ? Math.round(msun).toLocaleString("en-US") : msun.toFixed(2)) + " M☉";
}
const HBAR = 1.054571817e-34, C_M = 299792458, KB = 1.380649e-23;
function sci(v, unit) {
    if (!isFinite(v) || v <= 0) return "0 " + unit;
    if (v >= .01 && v < 1000) return (v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toPrecision(2)) + " " + unit;
    const e = Math.floor(Math.log10(v));
    const m = v / Math.pow(10, e);
    return m.toFixed(2) + "e" + e + " " + unit;
}
export function hawkingStats(rsKm) {
    const r = rsKm * 1000;
    return {
        tempK: HBAR * C_M / (4 * Math.PI * KB * r),
        powerW: HBAR * C_M * C_M / (3840 * Math.PI * r * r),
    };
}
export function bhHawkingLabel(rsKm) {
    const h = hawkingStats(rsKm);
    return "Hawking T " + sci(h.tempK, "K") + " · P " + sci(h.powerW, "W");
}
function makeHawkingPoints(seed) {
    const N = 180, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const rnd = mulberry32(seed);
    for (let i = 0; i < N; i++) {
        const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
        const r = 1.2 + Math.pow(rnd(), .55) * 7.8;
        pos[i * 3] = Math.sin(ph) * Math.cos(th) * r;
        pos[i * 3 + 1] = (rnd() - .5) * .9;
        pos[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * r;
        const hot = Math.pow(1 / r, .35);
        col[i * 3] = .45 + hot * .55;
        col[i * 3 + 1] = .7 + hot * .3;
        col[i * 3 + 2] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
        size: .02, vertexColors: true, transparent: true, opacity: .55,
        depthWrite: false, blending: THREE.AdditiveBlending,
        map: dotTexture("rgba(230,250,255,1)", "rgba(90,170,255,0.0)"),
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 5;
    return pts;
}
function makeSpaghettificationStream(seed) {
    const N = 320, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const rnd = mulberry32(seed);
    for (let i = 0; i < N; i++) {
        pos[i * 3] = 0; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = 0;
        const hot = Math.pow(i / Math.max(1, N - 1), .45);
        col[i * 3] = .65 + hot * .35;
        col[i * 3 + 1] = .26 + hot * .58;
        col[i * 3 + 2] = .12 + hot * .88;
        // keep the PRNG stream deterministic for later geometry refreshes
        rnd();
    }
    const g = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(pos, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", attr);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
        size: .035, vertexColors: true, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
        map: dotTexture("rgba(255,245,218,1)", "rgba(255,110,30,0.0)"),
    });
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 7;
    return { pts, pos, attr, mat, seed };
}
function blackCoreTexture() {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 96;
    const ctx = cv.getContext("2d");
    const g = ctx.createRadialGradient(48, 48, 4, 48, 48, 48);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(.52, "rgba(0,0,0,1)");
    g.addColorStop(.78, "rgba(0,0,0,.72)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 96, 96);
    return new THREE.CanvasTexture(cv);
}
export function addBlackHole(xKm, yKm, rsKm, vx0 = 0, vy0 = 0) {
    if (BH.n >= BH_MAX) { H.toast("Maximum " + BH_MAX + " black holes"); return; }
    const i = BH.n;
    bhRegister(i, xKm, yKm, rsKm, vx0, vy0);
    const g = new THREE.Group();
    g.position.set(BH.sx[i], 0, BH.sz[i]);
    const horizon = new THREE.Mesh(new THREE.SphereGeometry(rsKm * K, 48, 32), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    const photon = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture("rgba(255,244,224,0.82)"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .62 }));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(168,150,255,0.22)", "rgba(90,90,255,0.08)"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .22 }));
    const hawkGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture("rgba(190,235,255,0.65)"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .18 }));
    const coreMask = new THREE.Sprite(new THREE.SpriteMaterial({ map: blackCoreTexture(), transparent: true, depthWrite: false, depthTest: false, opacity: 1 }));
    coreMask.renderOrder = 20;
    const hawk = makeHawkingPoints(8800 + i * 97);
    const spag = makeSpaghettificationStream(17000 + i * 173);
    const cv = document.createElement("canvas");
    cv.width = cv.height = 256;
    const ctx = cv.getContext("2d");
    const gr = ctx.createRadialGradient(128, 128, 34, 128, 128, 128);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(.16, "rgba(255,240,210,0.7)");
    gr.addColorStop(.4, "rgba(255,158,66,0.34)");
    gr.addColorStop(.75, "rgba(196,76,28,0.12)");
    gr.addColorStop(1, "rgba(120,40,20,0)");
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, 256, 256);
    ctx.globalCompositeOperation = "destination-out";
    const rnd2 = mulberry32(1234 + i * 77);
    for (let k = 0; k < 26; k++) {
        ctx.beginPath();
        ctx.lineWidth = .6 + rnd2() * 1.8;
        ctx.strokeStyle = "rgba(0,0,0," + (.12 + rnd2() * .3) + ")";
        const rr = 38 + rnd2() * 88, a0 = rnd2() * 7;
        ctx.arc(128, 128, rr, a0, a0 + 1.5 + rnd2() * 3);
        ctx.stroke();
    }
    const diskTex = new THREE.CanvasTexture(cv);
    diskTex.center.set(.5, .5);
    const disk = new THREE.Mesh(new THREE.PlaneGeometry(rsKm * K * 13, rsKm * K * 13), new THREE.MeshBasicMaterial({ map: diskTex, transparent: true, opacity: .82, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    disk.rotation.x = -Math.PI / 2;
    g.add(disk, horizon, photon, glow, hawkGlow, hawk, spag.pts, coreMask);
    scene.add(g);
    BH_META.push({ g, disk, horizon, photon, glow, hawkGlow, hawk, spag, coreMask, tex: diskTex, rs: rsKm, flare: 0 });
    BH.n++;
    H.toast("⚫ Black hole: r_s " + fmtKm(rsKm) + " · " + bhMassLabel(rsKm) + " · " + bhHawkingLabel(rsKm));
    H.predict();
}
function removeBHIndex(i) {
    for (let k = DISRUPT.length - 1; k >= 0; k--) {
        if (DISRUPT[k].bh === i) DISRUPT.splice(k, 1);
        else if (DISRUPT[k].bh > i) DISRUPT[k].bh--;
    }
    const m = BH_META.splice(i, 1)[0];
    scene.remove(m.g);
    m.g.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
    for (let k = i; k < BH.n - 1; k++) {
        BH.x[k] = BH.x[k + 1]; BH.y[k] = BH.y[k + 1];
        BH.vx[k] = BH.vx[k + 1]; BH.vy[k] = BH.vy[k + 1];
        BH.mu[k] = BH.mu[k + 1]; BH.rs[k] = BH.rs[k + 1];
        BH.sx[k] = BH.sx[k + 1]; BH.sz[k] = BH.sz[k + 1];
        BH.c[k] = BH.c[k + 1]; BH.sinkS[k] = BH.sinkS[k + 1];
        BH.obsT[k] = BH.obsT[k + 1];
    }
    BH.n--;
}
export function removeLastBH() {
    if (!BH.n) { H.toast("No black holes placed"); return; }
    removeBHIndex(BH.n - 1);
    H.toast("Black hole removed");
    H.predict();
}

// ---- black-hole dynamics ----
// Holes free-fall in the same Earth-relative n-body frame as the ship and
// planets, then attract each other via the Paczyński-Wiita acceleration.
// Close pairs merge, conserving momentum.
let _bax = 0, _bay = 0;
function bodyPull(x, y, bx, by, mu) {
    const dx = x - bx, dy = y - by;
    const r2 = Math.max(1e-18, dx * dx + dy * dy);
    const w = mu / (r2 * Math.sqrt(r2));
    const r02 = Math.max(1e-18, bx * bx + by * by);
    const w0 = mu / (r02 * Math.sqrt(r02)); // indirect: pull on the frame origin
    _bax -= w * dx + w0 * bx;
    _bay -= w * dy + w0 * by;
}
// `tau` offsets body positions from the live ephemeris (holes integrate over
// the interval just *behind* the freshly advanced bodies, so tau ≤ 0).
function bhAccel(i, X, Y, tau, out) {
    const x = X[i], y = Y[i];
    _bax = 0; _bay = 0;
    if (!WORLD.earthDestroyed) {
        const r2 = Math.max(1e-18, x * x + y * y);
        const w = MU_E / (r2 * Math.sqrt(r2));
        _bax -= w * x; _bay -= w * y;
    }
    if (!WORLD.moonDestroyed) bodyPull(x, y, eph.moonX + eph.moonVx * tau, eph.moonY + eph.moonVy * tau, MU_M);
    if (!WORLD.sunDestroyed) bodyPull(x, y, eph.sunX + eph.sunVx * tau, eph.sunY + eph.sunVy * tau, MU_S);
    for (let p = 0; p < PL.length; p++)
        if (!WORLD.plDestroyed[p]) bodyPull(x, y, eph.plX[p] + eph.plVx[p] * tau, eph.plY[p] + eph.plVy[p] * tau, PL[p].mu);
    let ax = _bax, ay = _bay;
    for (let j = 0; j < BH.n; j++) {
        if (j !== i) {
            const dx = x - X[j], dy = y - Y[j];
            const d = Math.sqrt(dx * dx + dy * dy);
            const eff = Math.max(d - BH.rs[j], BH.rs[j] * .02);
            const am = BH.mu[j] / (eff * eff) / Math.max(1e-9, d);
            ax -= dx * am; ay -= dy * am;
        }
        // indirect: every hole accelerates the Earth-centered frame origin
        const r0 = Math.sqrt(X[j] * X[j] + Y[j] * Y[j]);
        const eff0 = Math.max(r0 - BH.rs[j], BH.rs[j] * .02);
        const am0 = BH.mu[j] / (eff0 * eff0) / Math.max(1e-9, r0);
        ax -= X[j] * am0; ay -= Y[j] * am0;
    }
    out[0] = ax; out[1] = ay;
}
const _ba = [0, 0];
const _k = [];
for (let s = 0; s < 4; s++) _k.push({ x: new Float64Array(BH_MAX), y: new Float64Array(BH_MAX), vx: new Float64Array(BH_MAX), vy: new Float64Array(BH_MAX) });
function bhDerivAll(tau, X, Y, VX, VY, K_) {
    for (let i = 0; i < BH.n; i++) {
        bhAccel(i, X, Y, tau, _ba);
        K_.x[i] = VX[i]; K_.y[i] = VY[i];
        K_.vx[i] = _ba[0]; K_.vy[i] = _ba[1];
    }
}
const _sx = new Float64Array(BH_MAX), _sy = new Float64Array(BH_MAX), _svx = new Float64Array(BH_MAX), _svy = new Float64Array(BH_MAX);
function bhRk4(tau0, dt) {
    const N = BH.n;
    bhDerivAll(tau0, BH.x, BH.y, BH.vx, BH.vy, _k[0]);
    for (const [f, kPrev, kCur] of [[.5, 0, 1], [.5, 1, 2], [1, 2, 3]]) {
        for (let i = 0; i < N; i++) {
            _sx[i] = BH.x[i] + f * dt * _k[kPrev].x[i];
            _sy[i] = BH.y[i] + f * dt * _k[kPrev].y[i];
            _svx[i] = BH.vx[i] + f * dt * _k[kPrev].vx[i];
            _svy[i] = BH.vy[i] + f * dt * _k[kPrev].vy[i];
        }
        bhDerivAll(tau0 + f * dt, _sx, _sy, _svx, _svy, _k[kCur]);
    }
    for (let i = 0; i < N; i++) {
        BH.x[i] += dt / 6 * (_k[0].x[i] + 2 * _k[1].x[i] + 2 * _k[2].x[i] + _k[3].x[i]);
        BH.y[i] += dt / 6 * (_k[0].y[i] + 2 * _k[1].y[i] + 2 * _k[2].y[i] + _k[3].y[i]);
        BH.vx[i] += dt / 6 * (_k[0].vx[i] + 2 * _k[1].vx[i] + 2 * _k[2].vx[i] + _k[3].vx[i]);
        BH.vy[i] += dt / 6 * (_k[0].vy[i] + 2 * _k[1].vy[i] + 2 * _k[2].vy[i] + _k[3].vy[i]);
    }
}
function tryMerge() {
    for (let i = 0; i < BH.n; i++)
        for (let j = i + 1; j < BH.n; j++) {
            const dx = BH.x[i] - BH.x[j], dy = BH.y[i] - BH.y[j];
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < (BH.rs[i] + BH.rs[j]) * 1.2) {
                const mu = BH.mu[i] + BH.mu[j];
                const x = (BH.x[i] * BH.mu[i] + BH.x[j] * BH.mu[j]) / mu;
                const y = (BH.y[i] * BH.mu[i] + BH.y[j] * BH.mu[j]) / mu;
                const vx = (BH.vx[i] * BH.mu[i] + BH.vx[j] * BH.mu[j]) / mu;
                const vy = (BH.vy[i] * BH.mu[i] + BH.vy[j] * BH.mu[j]) / mu;
                const rs = BH.rs[i] + BH.rs[j];
                removeBHIndex(j); removeBHIndex(i);
                addBlackHole(x, y, rs, vx, vy);
                H.toast("⚫ Black-hole merger → r_s " + fmtKm(rs));
                return true;
            }
        }
    return false;
}
function refreshBHSize(i, rs) {
    const m = BH_META[i];
    if (!m) return;
    const oldRs = Math.max(1e-9, m.rs);
    const ratio = rs / oldRs;
    m.rs = rs;
    if (m.horizon) m.horizon.scale.multiplyScalar(ratio);
    if (m.disk) m.disk.scale.multiplyScalar(ratio);
}
function absorbBody(i, target, x, y, vx, vy, muBody) {
    const mu0 = BH.mu[i], mu = mu0 + muBody;
    if (mu <= mu0) return;
    BH.x[i] = (BH.x[i] * mu0 + x * muBody) / mu;
    BH.y[i] = (BH.y[i] * mu0 + y * muBody) / mu;
    BH.vx[i] = (BH.vx[i] * mu0 + vx * muBody) / mu;
    BH.vy[i] = (BH.vy[i] * mu0 + vy * muBody) / mu;
    BH.mu[i] = mu;
    BH.rs[i] = 2 * mu / (C_LIGHT * C_LIGHT);
    BH.c[i] = .001 * Math.sqrt(2 * BH.mu[i] / 1000);
    BH.sinkS[i] = BH.rs[i] * K;
    BH.sx[i] = BH.x[i] * K;
    BH.sz[i] = -BH.y[i] * K;
    refreshBHSize(i, BH.rs[i]);
    if (BH_META[i]) BH_META[i].flare = 1;
    H.absorbed(target, BH.rs[i], i);
}
function bhBodyLimit(rs, radius, muBody, muBH) {
    const roche = radius * Math.cbrt(muBH / Math.max(1e-9, muBody));
    const tidal = Math.min(radius * 18, roche * .55);
    return Math.max(radius + rs * 2.2, tidal);
}
// disruption limits depend only on the hole's μ (and body constants), so they
// are cached and recomputed only after a merge or absorption changes the mass.
// Keyed on μ, the cache stays valid even when removeBHIndex shifts the arrays.
const _limCache = [];
function bhLimits(i) {
    let c = _limCache[i];
    if (!c) { c = { mu: -1, pl: new Float64Array(PL.length) }; _limCache[i] = c; }
    if (c.mu !== BH.mu[i]) {
        const mu = BH.mu[i], rs = BH.rs[i];
        c.mu = mu;
        c.earth = bhBodyLimit(rs, R_EARTH, MU_E, mu);
        c.moon = bhBodyLimit(rs, R_MOON, MU_M, mu);
        c.sun = bhBodyLimit(rs, R_SUN, MU_S, mu);
        for (let p = 0; p < PL.length; p++) c.pl[p] = bhBodyLimit(rs, PL[p].R, PL[p].mu, mu);
    }
    return c;
}
const DISRUPT = [];
window.__BH_DISRUPT = DISRUPT;
function targetLabel(target) {
    return target === "earth" ? "Earth" :
        target === "moon" ? "Moon" :
            target === "sun" ? "Sun" :
                typeof target === "number" && PL[target] ? PL[target].name : "Body";
}
function sameTarget(a, b) { return a === b; }
function isDisrupting(target) {
    return DISRUPT.some(d => sameTarget(d.target, target));
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function disruptionDuration(radius, dist, muBH, muBody, rel) {
    const r = Math.max(1, dist);
    const tidalAcc = 2 * muBH * radius / (r * r * r);
    const selfAcc = muBody / Math.max(1, radius * radius);
    const stress = Math.max(.02, tidalAcc / Math.max(1e-12, selfAcc));
    const dyn = Math.sqrt(radius / Math.max(1e-9, tidalAcc));
    const crossing = radius / Math.max(.05, rel);
    return clamp(Math.max(21600, dyn * 6, crossing * 10) / Math.sqrt(Math.min(60, stress)), 21600, 86400 * 90);
}
function disruptionBodyState(d) {
    if (d.target === "earth") {
        d.x = 0; d.y = 0; d.vx = 0; d.vy = 0;
    } else if (d.target === "moon") {
        d.x = eph.moonX; d.y = eph.moonY; d.vx = eph.moonVx; d.vy = eph.moonVy;
    } else if (d.target === "sun") {
        d.x = eph.sunX; d.y = eph.sunY; d.vx = eph.sunVx; d.vy = eph.sunVy;
    } else if (typeof d.target === "number" && d.target >= 0 && d.target < PL.length) {
        d.x = eph.plX[d.target]; d.y = eph.plY[d.target];
        d.vx = eph.plVx[d.target]; d.vy = eph.plVy[d.target];
    }
    return d;
}
function beginDisruption(i, target, x, y, vx, vy, radius, muBody, dist, limit) {
    if (isDisrupting(target) || i < 0 || i >= BH.n) return;
    const rel = Math.hypot(vx - BH.vx[i], vy - BH.vy[i]);
    const duration = disruptionDuration(radius, Math.max(dist, BH.rs[i] * 1.2), BH.mu[i], muBody, rel);
    const name = H.disrupt(target, BH.rs[i], "tidal disruption", i) || targetLabel(target);
    DISRUPT.push({
        bh: i, target, name, x, y, vx, vy, radius, muBody,
        age: 0, visual: 0, duration,
        limit: Math.max(limit, radius), bornRt: performance.now(),
    });
    const m = BH_META[i];
    if (m) m.flare = Math.max(m.flare, .55);
    H.toast(name + " spaghettifying · mass transfer forming");
}
function advanceDisruptions(dt) {
    for (let k = DISRUPT.length - 1; k >= 0; k--) {
        const d = DISRUPT[k];
        if (d.bh < 0 || d.bh >= BH.n) { DISRUPT.splice(k, 1); continue; }
        disruptionBodyState(d);
        d.age += dt;
        const simDone = d.age >= d.duration;
        const visibleDone = d.visual >= .96 && performance.now() - d.bornRt > 5000;
        if (simDone && visibleDone) {
            const dx = d.x - BH.x[d.bh], dy = d.y - BH.y[d.bh];
            const r = Math.max(1e-9, Math.hypot(dx, dy));
            const horizon = Math.max(BH.rs[d.bh] * 1.08, 1e-6);
            const x = BH.x[d.bh] + dx / r * horizon;
            const y = BH.y[d.bh] + dy / r * horizon;
            absorbBody(d.bh, d.target, x, y, d.vx, d.vy, d.muBody);
            DISRUPT.splice(k, 1);
        }
    }
}
function checkBHBodyBoundaries() {
    for (let i = 0; i < BH.n; i++) {
        const L = bhLimits(i);
        const x = BH.x[i], y = BH.y[i];
        if (!WORLD.earthDestroyed) {
            const d2 = x * x + y * y;
            if (d2 < L.earth * L.earth) beginDisruption(i, "earth", 0, 0, 0, 0, R_EARTH, MU_E, Math.sqrt(d2), L.earth);
        }
        if (!WORLD.moonDestroyed) {
            const dx = x - eph.moonX, dy = y - eph.moonY, d2 = dx * dx + dy * dy;
            if (d2 < L.moon * L.moon) beginDisruption(i, "moon", eph.moonX, eph.moonY, eph.moonVx, eph.moonVy, R_MOON, MU_M, Math.sqrt(d2), L.moon);
        }
        if (!WORLD.sunDestroyed) {
            const dx = x - eph.sunX, dy = y - eph.sunY, d2 = dx * dx + dy * dy;
            if (d2 < L.sun * L.sun) beginDisruption(i, "sun", eph.sunX, eph.sunY, eph.sunVx, eph.sunVy, R_SUN, MU_S, Math.sqrt(d2), L.sun);
        }
        for (let p = 0; p < PL.length; p++) {
            if (WORLD.plDestroyed[p]) continue;
            const dx = x - eph.plX[p], dy = y - eph.plY[p], d2 = dx * dx + dy * dy;
            if (d2 < L.pl[p] * L.pl[p]) beginDisruption(i, p, eph.plX[p], eph.plY[p], eph.plVx[p], eph.plVy[p], PL[p].R, PL[p].mu, Math.sqrt(d2), L.pl[p]);
        }
    }
}
export function bhAdvance(dtTotal, _tEnd) {
    if (!BH.n) return;
    let rem = dtTotal, guard = 0;
    while (rem > 1e-9 && guard++ < 200 && BH.n) {
        // step: a fraction of the tightest orbital timescale in play
        let dt = Math.min(rem, 21600);
        for (let i = 0; i < BH.n; i++) {
            const mu = BH.mu[i];
            if (!WORLD.sunDestroyed) {
                const dx = BH.x[i] - eph.sunX, dy = BH.y[i] - eph.sunY, d2 = dx * dx + dy * dy;
                dt = Math.min(dt, Math.sqrt(d2 * Math.sqrt(d2) / (MU_S + mu)) / 40);
            }
            const r2 = BH.x[i] * BH.x[i] + BH.y[i] * BH.y[i];
            dt = Math.min(dt, Math.sqrt(r2 * Math.sqrt(r2) / (MU_E + mu)) / 40); // infall toward Earth
            if (!WORLD.moonDestroyed) {
                const dx = BH.x[i] - eph.moonX, dy = BH.y[i] - eph.moonY, d2 = dx * dx + dy * dy;
                dt = Math.min(dt, Math.sqrt(d2 * Math.sqrt(d2) / (MU_M + mu)) / 40);
            }
            for (let p = 0; p < PL.length; p++) {
                if (WORLD.plDestroyed[p]) continue;
                const dx = BH.x[i] - eph.plX[p], dy = BH.y[i] - eph.plY[p], d2 = dx * dx + dy * dy;
                dt = Math.min(dt, Math.sqrt(d2 * Math.sqrt(d2) / (PL[p].mu + mu)) / 40);
            }
            for (let j = i + 1; j < BH.n; j++) {
                const dx = BH.x[i] - BH.x[j], dy = BH.y[i] - BH.y[j], d2 = dx * dx + dy * dy;
                dt = Math.min(dt, Math.sqrt(d2 * Math.sqrt(d2) / (mu + BH.mu[j])) / 40);
            }
        }
        dt = Math.max(dt, rem / (200 - guard + 1), 1e-3);
        dt = Math.min(dt, rem);
        // the ephemeris is already at the end of the interval: holes catch up
        // through it, sampling bodies interpolated backward from now
        bhRk4(-rem, dt);
        rem -= dt;
        advanceDisruptions(dt);
        tryMerge();
        checkBHBodyBoundaries();
    }
    for (let i = 0; i < BH.n; i++) {
        BH.sx[i] = BH.x[i] * K; BH.sz[i] = -BH.y[i] * K;
    }
}
const raycaster = new THREE.Raycaster();
export function placeBHAtCursor() {
    const w = cvHost.clientWidth || 1, h = cvHost.clientHeight || 1;
    const px = lastPtr ? lastPtr[0] : w * .5, py = lastPtr ? lastPtr[1] : h * .5;
    raycaster.setFromCamera(new THREE.Vector2(px / w * 2 - 1, -(py / h * 2 - 1)), camera);
    const t = -raycaster.ray.origin.y / raycaster.ray.direction.y;
    if (!isFinite(t) || t <= 0) { H.toast("Aim the cursor at the orbital plane"); return; }
    const p = raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, t);
    addBlackHole(p.x / K - eph.earthX, -p.z / K - eph.earthY, BH_SIZES[BH.sizeIdx]);
}
window.__addBH = addBlackHole; // debug/testing handle

function lapseAt(rKm, rsKm) {
    const r = Math.max(rsKm * 1.002, rKm);
    return Math.sqrt(Math.max(.012, 1 - rsKm / r));
}
export function observerTimeScaleForBH(bi, scenePos = null) {
    if (bi < 0 || bi >= BH.n) return 1;
    const p = scenePos || BH_META[bi]?.g.position;
    if (!p) return 1;
    const obsR = Math.max(BH.rs[bi] * 1.002, camera.position.distanceTo(p) / K);
    const eventR = Math.max(BH.rs[bi] * 1.08, BH.rs[bi] + 1e-6);
    return clamp(lapseAt(eventR, BH.rs[bi]) / lapseAt(obsR, BH.rs[bi]), .08, 2.4);
}
function updateSpagVisual(d, m, dtLocal, dBH, obsRate) {
    if (!m?.spag) return;
    const visualWindow = Math.max(4, Math.min(16, d.duration / 14400));
    const realAge = (performance.now() - d.bornRt) * .001;
    d.visual = Math.max(d.visual, clamp(realAge * obsRate / visualWindow, 0, 1));
    d.visual = clamp(d.visual + dtLocal / visualWindow, 0, 1);
    const pos = m.spag.pos;
    const rnd = mulberry32(m.spag.seed + Math.floor(d.visual * 1000));
    disruptionBodyState(d);
    const debrisX = (d.x - BH.x[d.bh]) * K;
    const debrisZ = -(d.y - BH.y[d.bh]) * K;
    const len0 = Math.max(Math.hypot(debrisX, debrisZ), d.radius * K * .5, m.rs * K * 4);
    const cap = Math.max(d.radius * K * 10, m.rs * K * 60, dBH * .12);
    const len = Math.min(len0, cap);
    const ux = len0 > 1e-9 ? debrisX / len0 : 1, uz = len0 > 1e-9 ? debrisZ / len0 : 0;
    const px = -uz, pz = ux;
    const inner = Math.max(m.rs * K * 1.18, dBH * .002);
    const tail = Math.max(inner * 1.4, len * (1 + d.visual * 1.5));
    const N = pos.length / 3;
    for (let n = 0; n < N; n++) {
        const q = n / Math.max(1, N - 1);
        const phase = q * 36 + d.visual * 19;
        const along = inner + (1 - q) * tail;
        const pinch = Math.pow(q, .55);
        const spread = (1 - pinch) * Math.max(d.radius * K * .18, dBH * .0015);
        const swirl = Math.sin(phase) * spread * (0.35 + rnd() * .65);
        const lift = Math.cos(phase * .73) * spread * .22;
        pos[n * 3] = ux * along + px * swirl;
        pos[n * 3 + 1] = lift;
        pos[n * 3 + 2] = uz * along + pz * swirl;
    }
    m.spag.attr.needsUpdate = true;
    m.spag.mat.size = Math.max(.018, dBH * .0009);
    m.spag.mat.opacity = .78 * Math.sin(Math.PI * d.visual) + .18 * (1 - d.visual);
}
export function updateBHVisuals(dtR, earthScX = 0, earthScZ = 0) {
    for (let bi = 0; bi < BH_META.length; bi++) {
        const m = BH_META[bi];
        m.g.position.set(earthScX + BH.sx[bi], 0, earthScZ + BH.sz[bi]);
        const dBH = camera.position.distanceTo(m.g.position);
        const obsRate = observerTimeScaleForBH(bi, m.g.position);
        BH.obsT[bi] = obsRate;
        const dtLocal = dtR * obsRate;
        m.flare = Math.max(0, m.flare - dtLocal * .55);
        m.photon.scale.setScalar(Math.max(m.rs * K * 4.2, dBH * .006));
        m.glow.scale.setScalar(Math.max(m.rs * K * 8, dBH * .012));
        const hot = Math.min(1, Math.max(.14, Math.pow(1000 / Math.max(1, m.rs), .34)));
        const flare = m.flare * m.flare;
        m.glow.material.opacity = .12 + hot * .14 + flare * .34;
        const hVis = Math.max(m.rs * K * 5.5, dBH * .0065);
        m.hawk.scale.setScalar(hVis);
        m.hawk.rotation.y += dtLocal * (1.4 + hot * 4.8);
        m.hawk.rotation.z -= dtLocal * (.35 + hot * 1.2);
        m.hawk.material.opacity = .06 + hot * .22;
        m.hawk.material.size = Math.max(.006, dBH * .00075) * (.55 + hot * .7);
        m.hawkGlow.scale.setScalar(Math.max(m.rs * K * (4.6 + flare * 5), dBH * (.0055 + flare * .009)));
        m.hawkGlow.material.opacity = .035 + hot * .11 * (0.65 + 0.35 * Math.sin(performance.now() * .004 + bi)) + flare * .38;
        if (m.coreMask) {
            m.coreMask.scale.setScalar(Math.max(m.rs * K * 3, dBH * .009));
            m.coreMask.material.opacity = 1;
            m.coreMask.quaternion.copy(camera.quaternion);
        }
        const d = DISRUPT.find(x => x.bh === bi);
        if (d) updateSpagVisual(d, m, dtLocal, dBH, obsRate);
        else if (m.spag) {
            m.spag.mat.opacity = Math.max(0, m.spag.mat.opacity - dtR * .85);
        }
        m.tex.rotation -= dtLocal * (.25 + 9 / Math.sqrt(m.rs));
    }
}
