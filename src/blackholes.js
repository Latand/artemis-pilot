import * as THREE from "three";
import { BH_MAX, BH_SIZES, C_LIGHT, MU_E, MU_M, MU_S, R_EARTH, R_MOON, R_SUN, PL, K } from "./constants.js";
import { BH, WORLD, bhRegister } from "./state.js";
import { eph, updEphem } from "./ephemeris.js";
import { fmtKm, mulberry32 } from "./format.js";
import { dotTexture, ringTexture } from "./textures.js";
import { scene, camera, cvHost, lastPtr } from "./scene.js";

export const BH_META = []; // visual groups, parallel to the data arrays

let H = { toast: () => { }, predict: () => { }, cataclysm: () => { } };
export function initBHHooks(hooks) { H = hooks; }

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
    g.add(disk, horizon, photon, glow, hawkGlow, hawk, coreMask);
    scene.add(g);
    BH_META.push({ g, disk, photon, glow, hawkGlow, hawk, coreMask, tex: diskTex, rs: rsKm });
    BH.n++;
    H.toast("⚫ Black hole: r_s " + fmtKm(rsKm) + " · " + bhMassLabel(rsKm) + " · " + bhHawkingLabel(rsKm));
    H.predict();
}
function removeBHIndex(i) {
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
function bhAccel(i, X, Y, out) {
    const x = X[i], y = Y[i];
    let ax = 0, ay = 0;
    if (!WORLD.earthDestroyed) {
        const rE = Math.max(1e-9, Math.hypot(x, y)), rE3 = rE * rE * rE;
        ax -= MU_E * x / rE3;
        ay -= MU_E * y / rE3;
    }
    const bodies = [];
    if (!WORLD.moonDestroyed) bodies.push([eph.moonX, eph.moonY, MU_M]);
    if (!WORLD.sunDestroyed) bodies.push([eph.sunX, eph.sunY, MU_S]);
    for (let p = 0; p < PL.length; p++) if (!WORLD.plDestroyed[p]) bodies.push([eph.plX[p], eph.plY[p], PL[p].mu]);
    for (const [bx, by, mu] of bodies) {
        const dx = x - bx, dy = y - by;
        const r = Math.max(1e-9, Math.hypot(dx, dy)), r3 = r * r * r;
        const r0 = Math.max(1e-9, Math.hypot(bx, by)), r03 = r0 * r0 * r0;
        ax -= mu * (dx / r3 + bx / r03);
        ay -= mu * (dy / r3 + by / r03);
    }
    for (let j = 0; j < BH.n; j++) {
        if (j !== i) {
            const dx = x - X[j], dy = y - Y[j];
            const d = Math.hypot(dx, dy);
            const eff = Math.max(d - BH.rs[j], BH.rs[j] * .02);
            const am = BH.mu[j] / (eff * eff) / Math.max(1e-9, d);
            ax -= dx * am; ay -= dy * am;
        }
        // indirect: every hole accelerates the Earth-centered frame origin
        const r0 = Math.hypot(X[j], Y[j]);
        const eff0 = Math.max(r0 - BH.rs[j], BH.rs[j] * .02);
        const am0 = BH.mu[j] / (eff0 * eff0) / Math.max(1e-9, r0);
        ax -= X[j] * am0; ay -= Y[j] * am0;
    }
    out[0] = ax; out[1] = ay;
}
const _ba = [0, 0];
const _bx = new Float64Array(BH_MAX), _by = new Float64Array(BH_MAX);
const _k = [];
for (let s = 0; s < 4; s++) _k.push({ x: new Float64Array(BH_MAX), y: new Float64Array(BH_MAX), vx: new Float64Array(BH_MAX), vy: new Float64Array(BH_MAX) });
function bhDerivAll(t, X, Y, VX, VY, K_) {
    updEphem(t);
    for (let i = 0; i < BH.n; i++) {
        bhAccel(i, X, Y, _ba);
        K_.x[i] = VX[i]; K_.y[i] = VY[i];
        K_.vx[i] = _ba[0]; K_.vy[i] = _ba[1];
    }
}
const _sx = new Float64Array(BH_MAX), _sy = new Float64Array(BH_MAX), _svx = new Float64Array(BH_MAX), _svy = new Float64Array(BH_MAX);
function bhRk4(t, dt) {
    const N = BH.n;
    bhDerivAll(t, BH.x, BH.y, BH.vx, BH.vy, _k[0]);
    for (const [f, kPrev, kCur] of [[.5, 0, 1], [.5, 1, 2], [1, 2, 3]]) {
        for (let i = 0; i < N; i++) {
            _sx[i] = BH.x[i] + f * dt * _k[kPrev].x[i];
            _sy[i] = BH.y[i] + f * dt * _k[kPrev].y[i];
            _svx[i] = BH.vx[i] + f * dt * _k[kPrev].vx[i];
            _svy[i] = BH.vy[i] + f * dt * _k[kPrev].vy[i];
        }
        bhDerivAll(t + f * dt, _sx, _sy, _svx, _svy, _k[kCur]);
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
            const d = Math.hypot(BH.x[i] - BH.x[j], BH.y[i] - BH.y[j]);
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
function bhBodyLimit(rs, radius, muBody, muBH) {
    const tidal = radius * Math.cbrt(muBH / Math.max(1e-9, muBody)) * .25;
    return Math.max(radius + rs * 1.5, Math.min(radius * 40, tidal));
}
function checkBHBodyBoundaries() {
    for (let i = 0; i < BH.n; i++) {
        const rs = BH.rs[i], mu = BH.mu[i];
        if (!WORLD.earthDestroyed && Math.hypot(BH.x[i], BH.y[i]) < bhBodyLimit(rs, R_EARTH, MU_E, mu)) {
            H.cataclysm("earth", rs, "black-hole tidal disruption");
        }
        if (!WORLD.moonDestroyed && Math.hypot(BH.x[i] - eph.moonX, BH.y[i] - eph.moonY) < bhBodyLimit(rs, R_MOON, MU_M, mu)) {
            H.cataclysm("moon", rs, "black-hole tidal disruption");
        }
        if (!WORLD.sunDestroyed && Math.hypot(BH.x[i] - eph.sunX, BH.y[i] - eph.sunY) < bhBodyLimit(rs, R_SUN, MU_S, mu)) {
            H.cataclysm("sun", rs, "black-hole photosphere breach");
        }
        for (let p = 0; p < PL.length; p++) {
            if (!WORLD.plDestroyed[p] && Math.hypot(BH.x[i] - eph.plX[p], BH.y[i] - eph.plY[p]) < bhBodyLimit(rs, PL[p].R, PL[p].mu, mu)) {
                H.cataclysm(p, rs, "black-hole tidal disruption");
            }
        }
    }
}
export function bhAdvance(dtTotal, tStart) {
    if (!BH.n) return;
    let rem = dtTotal, t = tStart, guard = 0;
    while (rem > 1e-9 && guard++ < 200 && BH.n) {
        // step: a fraction of the tightest orbital timescale in play
        let dt = Math.min(rem, 21600);
        for (let i = 0; i < BH.n; i++) {
            const rS = Math.hypot(BH.x[i] - eph.sunX, BH.y[i] - eph.sunY);
            dt = Math.min(dt, Math.sqrt(rS * rS * rS / MU_S) / 40);
            const r0 = Math.hypot(BH.x[i], BH.y[i]);
            dt = Math.min(dt, Math.sqrt(r0 * r0 * r0 / BH.mu[i]) / 40); // infall toward Earth
            for (let j = i + 1; j < BH.n; j++) {
                const d = Math.hypot(BH.x[i] - BH.x[j], BH.y[i] - BH.y[j]);
                dt = Math.min(dt, Math.sqrt(d * d * d / (BH.mu[i] + BH.mu[j])) / 40);
            }
        }
        dt = Math.max(dt, rem / (200 - guard + 1), 1e-3);
        dt = Math.min(dt, rem);
        bhRk4(t, dt);
        t += dt; rem -= dt;
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

export function updateBHVisuals(dtR, earthScX = 0, earthScZ = 0) {
    for (let bi = 0; bi < BH_META.length; bi++) {
        const m = BH_META[bi];
        m.g.position.set(earthScX + BH.sx[bi], 0, earthScZ + BH.sz[bi]);
        const dBH = camera.position.distanceTo(m.g.position);
        m.photon.scale.setScalar(Math.max(m.rs * K * 4.2, dBH * .006));
        m.glow.scale.setScalar(Math.max(m.rs * K * 8, dBH * .012));
        const hot = Math.min(1, Math.max(.14, Math.pow(1000 / Math.max(1, m.rs), .34)));
        m.glow.material.opacity = .12 + hot * .14;
        const hVis = Math.max(m.rs * K * 5.5, dBH * .0065);
        m.hawk.scale.setScalar(hVis);
        m.hawk.rotation.y += dtR * (1.4 + hot * 4.8);
        m.hawk.rotation.z -= dtR * (.35 + hot * 1.2);
        m.hawk.material.opacity = .06 + hot * .22;
        m.hawk.material.size = Math.max(.006, dBH * .00075) * (.55 + hot * .7);
        m.hawkGlow.scale.setScalar(Math.max(m.rs * K * 4.6, dBH * .0055));
        m.hawkGlow.material.opacity = .035 + hot * .11 * (0.65 + 0.35 * Math.sin(performance.now() * .004 + bi));
        if (m.coreMask) {
            m.coreMask.scale.setScalar(Math.max(m.rs * K * 3, dBH * .009));
            m.coreMask.material.opacity = 1;
            m.coreMask.quaternion.copy(camera.quaternion);
        }
        m.tex.rotation -= dtR * (.25 + 9 / Math.sqrt(m.rs));
    }
}
