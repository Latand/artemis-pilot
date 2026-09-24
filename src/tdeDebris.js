// Headless tidal-debris model: the fluid elements of a disrupted body on
// individual orbits about the hole, as pure functions of simulation time.
// tdeVisuals.js draws them; scripts/smoke-tde-regimes.mjs tests them.
//
// Birth. At the freeze epoch t0 (the inbound crossing of r_t for a full
// disruption; the pericentre for a partial stripping; the capture for a body
// swallowed whole) the elements are sampled over the tidally stretched body
// with a centrally condensed density ~ (1 - r^2)^n. Each gets the frozen-in
// specific energy
//     eps_i = eps_cm + (G M R / r_t^2) (x_i . r_hat) / R,
// with eps_cm the centre of mass's conserved (Paczynski–Wiita) orbital
// energy, and the centre of mass's angular momentum |h_cm|, its orbital plane
// tilted just enough to contain its own position.
//
// Orbits. The hole's potential is the Paczynski–Wiita -mu/(r - r_s). Its
// orbits have no closed form, but the potential -mu/r - B/r^2 does: the radial
// motion is exactly a Kepler orbit of angular momentum h' = kappa h,
// kappa^2 = 1 - 2B/h^2, and the angle swept is psi/kappa, psi being that
// Kepler orbit's true anomaly (a precessing conic). B is calibrated per
// debris system so the centre of mass sweeps the same apsidal angle as its
// Paczynski–Wiita orbit; each element then rides a precessing conic solved in
// closed form (universal variables, warm-started) at whatever sim time is
// asked for, so a paused frame is frozen and any warp gives the same state at
// the same sim time. The stream, the bound/unbound split, the fallback and its
// return rate emerge from those orbits; nothing about them is drawn by hand.
//
// Return. A bound element back at pericentre meets the precessed stream and
// circularizes at fixed angular momentum (semi-latus rectum 2q, eccentricity
// dissipating over ~an orbit), drifts inward through the disk and is accreted
// at the ISCO. Elements whose orbit crosses the capture sphere approach the
// horizon asymptotically, e-folding every 2 r_s / c as a distant observer
// sees them.
import { C_LIGHT, PL } from "./constants.js";
import { makeConic, conicFromState, perifocalAt, timeToRadiusInbound, propagateState } from "./universe/keplerTools.js";
import { pwPericentre } from "./tde.js";
import { mulberry32 } from "./format.js";

export const LAMBDA_MAX = 2.6;
export const VISC_ORBITS = 24; // inflow time of a circularized ring, in orbits at 2 q
const LN_TINY = -60;
const TAU = 2 * Math.PI;

// Surface-displacement Love number of a fluid body, h2 = 1 + k2 (an n = 3
// star: k2 ~ 0.014; giant planets ~ 0.5; rocky bodies yield like a fluid
// under tides this strong).
export function loveH2(target) {
    if (target === "sun") return 1.01;
    if (typeof target === "number" && PL[target]?.gas) return 1.5;
    return 1.9;
}
// Equilibrium-tide elongation for tidal strain s = (M/m)(R/r)^3: 1 + h2 s,
// saturating toward LAMBDA_MAX as the body approaches disruption.
export function tidalElongation(s, h2) {
    const k = LAMBDA_MAX - 1;
    return 1 + k * Math.tanh(h2 * Math.max(0, s) / k);
}

// Angle swept from pericentre to apocentre (bound) or to infinity (unbound)
// by an orbit of specific energy E and angular momentum L in the
// Paczynski–Wiita potential, pericentre rp. Midpoint quadrature in an angle
// variable that removes the turning-point singularities; exactly pi for
// rs = 0.
export function pwApsidalSweep(E, L, mu, rs, rp, n = 1200) {
    const up = 1 / rp, L2 = L * L;
    const F = u => 2 * (E + mu * u / (1 - rs * u)) - L2 * u * u; // v_r^2
    let s = 0;
    if (E >= 0) {
        // u = up cos^2(th), th in [0, pi/2]
        const dth = Math.PI / 2 / n;
        for (let k = 0; k < n; k++) {
            const th = (k + .5) * dth, c = Math.cos(th);
            const f = F(up * c * c);
            if (f > 0) s += 2 * L * up * c * Math.sin(th) / Math.sqrt(f);
        }
        return s * dth;
    }
    // apocentre: the other root of F below up
    let um = 0, fm = -Infinity;
    for (let k = 1; k < 256; k++) {
        const u = up * k / 256, f = F(u);
        if (f > fm) { fm = f; um = u; }
    }
    if (!(fm > 0)) return Math.PI;
    let lo = 0, hi = um;
    for (let k = 0; k < 200; k++) {
        const m = .5 * (lo + hi);
        if (F(m) < 0) lo = m; else hi = m;
        if (hi - lo <= 1e-15 * hi) break;
    }
    const ua = hi, h = .5 * (up - ua);
    // u = ua + h (1 - cos th), th in [0, pi]
    const dth = Math.PI / n;
    for (let k = 0; k < n; k++) {
        const th = (k + .5) * dth;
        const f = F(ua + h * (1 - Math.cos(th)));
        if (f > 0) s += L * h * Math.sin(th) / Math.sqrt(f);
    }
    return s * dth;
}

// Calibrates the precessing-conic model -mu/r - B/r^2 to the
// Paczynski–Wiita orbit (E, L) at radius rNow: kappa such that the model's
// apsidal sweep psi_sweep / kappa equals the PW sweep. kappa = 1, B = 0 for
// rs = 0 or a plunging orbit.
const _pwc = { rp: 0, captured: false, rBarrier: 0 };
export function precessionModel(E, L, mu, rs, rNow, out = { kappa: 1, B: 0, rp: NaN, captured: false, sweep: Math.PI }) {
    out.kappa = 1; out.B = 0; out.rp = NaN; out.captured = false; out.sweep = Math.PI;
    if (!(rs > 0) || !(L > 0)) return out;
    const pw = pwPericentre(E, L, mu, rs, rNow, _pwc);
    if (pw.captured) { out.captured = true; return out; }
    out.rp = pw.rp;
    const sweep = pwApsidalSweep(E, L, mu, rs, pw.rp);
    out.sweep = sweep;
    let kappa = Math.PI / sweep;
    if (E > 0) {
        // the Kepler sweep to infinity is arccos(-1/e'), e' of h' = kappa L
        for (let k = 0; k < 8; k++) {
            const hp = kappa * L;
            const e = Math.sqrt(1 + 2 * E * hp * hp / (mu * mu));
            kappa = Math.acos(-1 / e) / sweep;
        }
    }
    kappa = Math.min(1, Math.max(.2, kappa));
    out.kappa = kappa;
    out.B = .5 * (1 - kappa * kappa) * L * L;
    return out;
}

export function debrisCountFor(spec) {
    const f = spec.kind === "partial" ? Math.max(.15, Math.min(1, spec.massLossFrac || 0)) : 1;
    return Math.round((spec.kind === "full" ? 3000 : spec.kind === "captured" ? 1600 : 2200) * f);
}

const _el = makeConic();
const _cb = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, chi: 0 };
const _pf = [0, 0, 0, 0];
const _vel = [0, 0, 0];
const C_KM_S = 299792.458;
// which leg of its history an element is on at a given time
export const LEG_NONE = 0, LEG_KEPLER = 1, LEG_RING = 2, LEG_PLUNGE = 3;
const _pm = { kappa: 1, B: 0, rp: NaN, captured: false, sweep: Math.PI };

// Particle flags
export const DEBRIS_BOUND = 1, DEBRIS_PLUNGE = 2;

export class DebrisModel {
    constructor(spec, count) {
        this.spec = spec;
        this.count = count;
        this.q = new Float64Array(count);       // pericentre of the equivalent Kepler orbit
        this.alpha = new Float64Array(count);   // 1/a
        this.tp = new Float64Array(count);      // pericentre time
        this.kap = new Float64Array(count);     // precession factor kappa
        this.ex = new Float64Array(count); this.ey = new Float64Array(count); this.ez = new Float64Array(count); // pericentre direction
        this.qx = new Float64Array(count); this.qy = new Float64Array(count); this.qz = new Float64Array(count); // along the pericentre velocity
        this.chi = new Float64Array(count).fill(NaN);
        this.flags = new Uint8Array(count);
        this.tRet = new Float64Array(count);    // bound: first return to pericentre
        this.tX = new Float64Array(count);      // plunge: crossing of the capture sphere
        this.rX = new Float64Array(count);
        this.dx = new Float32Array(count); this.dy = new Float32Array(count); this.dz = new Float32Array(count);
        this.u = new Float32Array(count);       // x.r_hat / R at birth: the element's place in the energy spread
        this.ox = new Float32Array(count); this.oy = new Float32Array(count); this.oz = new Float32Array(count); // birth offset from the centre of mass
        this.eps = new Float64Array(count);     // specific orbital energy
        this.model = { kappa: 1, B: 0, rp: NaN, captured: false, sweep: Math.PI, epsCm: 0, dEps: 0, hCm: 0 };
        this.lastLeg = LEG_NONE;
        this.build();
    }
    build() {
        const sp = this.spec, n = this.count;
        const mu = sp.mu, R = sp.R, rs = Math.max(0, sp.rs || 0);
        const rnd = mulberry32(sp.seed | 0);
        // tidal frame at the epoch: nH toward the body from the hole, tH along
        // the motion, bH normal to the orbital plane
        const rc = Math.hypot(sp.x, sp.y, sp.z);
        const nx = sp.x / rc, ny = sp.y / rc, nz = sp.z / rc;
        const hx = sp.y * sp.vz - sp.z * sp.vy, hy = sp.z * sp.vx - sp.x * sp.vz, hz = sp.x * sp.vy - sp.y * sp.vx;
        const hMag = Math.hypot(hx, hy, hz) || 1e-30;
        const bx = hx / hMag, by = hy / hMag, bz = hz / hMag;
        const tx = by * nz - bz * ny, ty = bz * nx - bx * nz, tz = bx * ny - by * nx;
        const vr = (sp.x * sp.vx + sp.y * sp.vy + sp.z * sp.vz) / rc;
        const v2 = sp.vx * sp.vx + sp.vy * sp.vy + sp.vz * sp.vz;
        // the conserved orbital energy of the centre of mass (PW potential)
        const epsCm = Number.isFinite(sp.epsCm) ? sp.epsCm : .5 * v2 - mu / Math.max(rc - rs, 1e-9 * rc);
        const dEps = mu * R / (sp.rt * sp.rt);
        const pm = precessionModel(epsCm, hMag, mu, rs, rc, _pm);
        const B = pm.B;
        const M = this.model;
        M.kappa = pm.kappa; M.B = B; M.rp = pm.rp; M.captured = pm.captured; M.sweep = pm.sweep;
        M.epsCm = epsCm; M.dEps = dEps; M.hCm = hMag;
        // the body as it was when frozen: stretched by the tide it felt there
        const lam = tidalElongation(Math.pow(sp.rt / rc, 3), loveH2(sp.target));
        const mperp = 1 / Math.sqrt(lam);
        const partial = sp.kind === "partial";
        const whole = sp.kind === "captured" && sp.rt <= sp.rCap * 3;
        const nPoly = sp.target === "sun" ? 3 : 1.5;
        const shell = partial ? Math.cbrt(Math.max(0, 1 - (sp.massLossFrac || 0))) : 0;
        for (let i = 0; i < n; i++) {
            // Full disruptions: mass uniform along the tidal axis, i.e. flat
            // dM/d(eps) over eps_cm -/+ Delta eps: the distribution behind
            // t_fb, Mdot_peak = M*/(3 t_fb) and the t^-5/3 return, which the
            // orbits then reproduce. Partials: the outer shell, concentrated
            // toward the tidal axis (the L1/L2 lobes). A body swallowed whole:
            // centrally condensed ~ (1 - r^2)^n (its energies play no role).
            let ux = 0, uy = 0, uz = 0;
            for (let tries = 0; tries < 400; tries++) {
                ux = rnd() * 2 - 1; uy = rnd() * 2 - 1; uz = rnd() * 2 - 1;
                if (!partial && !whole) {
                    const w2 = 1 - ux * ux;
                    if (uy * uy + uz * uz > 1) continue;
                    const w = Math.sqrt(w2);
                    uy *= w; uz *= w;
                    break;
                }
                const r2 = ux * ux + uy * uy + uz * uz;
                if (r2 > 1) continue;
                if (partial) {
                    if (r2 < shell * shell) continue;
                    const along = Math.abs(ux) / Math.max(1e-9, Math.sqrt(r2));
                    if (rnd() > Math.pow(along, 4)) continue;
                    break;
                }
                if (rnd() <= Math.pow(1 - r2, nPoly)) break;
            }
            // (ux: along nH, uy: along tH, uz: along bH)
            const px = sp.x + R * (lam * ux * nx + mperp * (uy * tx + uz * bx));
            const py = sp.y + R * (lam * ux * ny + mperp * (uy * ty + uz * by));
            const pz = sp.z + R * (lam * ux * nz + mperp * (uy * tz + uz * bz));
            const pr = Math.hypot(px, py, pz);
            const rx = px / pr, ry = py / pr, rz = pz / pr;
            let vx, vy, vz, B_i = B;
            if (whole) {
                // swallowed intact: every element keeps the centre-of-mass
                // velocity (Newtonian conics to the capture sphere)
                vx = sp.vx; vy = sp.vy; vz = sp.vz; B_i = 0;
                this.eps[i] = .5 * v2 - mu / pr;
            } else {
                // frozen-in energy with the centre-of-mass |h|, the orbital
                // plane tilted to contain this element; the energy is exact
                // (if the element sits inside the angular-momentum barrier its
                // |h| gives way instead)
                const eps = epsCm + dEps * ux;
                this.eps[i] = eps;
                const hd = hx * rx + hy * ry + hz * rz;
                let ix = hx - hd * rx, iy = hy - hd * ry, iz = hz - hd * rz;
                const im = Math.hypot(ix, iy, iz) || 1;
                ix /= im; iy /= im; iz /= im;
                const qx = iy * rz - iz * ry, qy = iz * rx - ix * rz, qz = ix * ry - iy * rx;
                const vv = Math.sqrt(Math.max(0, 2 * (eps + mu / pr + B / (pr * pr))));
                const vt = Math.min(hMag / pr, vv);
                const vri = (vr < 0 ? -1 : 1) * Math.sqrt(Math.max(0, vv * vv - vt * vt));
                vx = vri * rx + vt * qx; vy = vri * ry + vt * qy; vz = vri * rz + vt * qz;
            }
            // equivalent Kepler orbit: same r and v_r, transverse speed x kappa
            const vrr = vx * rx + vy * ry + vz * rz;
            let wx = vx - vrr * rx, wy = vy - vrr * ry, wz = vz - vrr * rz;
            const vt = Math.hypot(wx, wy, wz);
            const hI = pr * vt;
            const k2 = hI > 0 ? 1 - 2 * B_i / (hI * hI) : 1;
            const kap = Math.sqrt(Math.max(.04, k2));
            this.kap[i] = kap;
            const vxE = vrr * rx + kap * wx, vyE = vrr * ry + kap * wy, vzE = vrr * rz + kap * wz;
            conicFromState(px, py, pz, vxE, vyE, vzE, mu, _el);
            this.q[i] = Math.max(1e-6, _el.rp);
            this.alpha[i] = _el.alpha;
            this.tp[i] = sp.t0 - _el.tSincePeri;
            // the actual pericentre direction: the element's direction rotated
            // back by phi0 = psi0 / kappa within its orbital plane
            const phi0 = _el.nu / kap;
            const c0 = Math.cos(phi0), s0 = Math.sin(phi0);
            const hhx = _el.hx, hhy = _el.hy, hhz = _el.hz;
            const ttx = hhy * rz - hhz * ry, tty = hhz * rx - hhx * rz, ttz = hhx * ry - hhy * rx;
            const ex = c0 * rx - s0 * ttx, ey = c0 * ry - s0 * tty, ez = c0 * rz - s0 * ttz;
            this.ex[i] = ex; this.ey[i] = ey; this.ez[i] = ez;
            this.qx[i] = hhy * ez - hhz * ey; this.qy[i] = hhz * ex - hhx * ez; this.qz[i] = hhx * ey - hhy * ex;
            this.u[i] = ux;
            this.ox[i] = px - sp.x; this.oy[i] = py - sp.y; this.oz[i] = pz - sp.z;
            let f = 0;
            if (_el.alpha > 0) {
                f |= DEBRIS_BOUND;
                this.tRet[i] = this.tp[i] + _el.period;
            }
            if (sp.kind === "captured" || this.q[i] < sp.rCap || k2 < .04) {
                f |= DEBRIS_PLUNGE;
                // where the orbit crosses the capture sphere (or its pericentre)
                const sig = (px * vxE + py * vyE + pz * vzE) / Math.sqrt(mu);
                const lead = timeToRadiusInbound(pr, sig, _el.alpha, mu, sp.rCap);
                if (Number.isFinite(lead)) { this.tX[i] = sp.t0 + lead; this.rX[i] = sp.rCap; }
                else { this.tX[i] = this.tp[i]; this.rX[i] = this.q[i]; }
                this.directionAt(i, this.tX[i]);
            }
            this.flags[i] = f;
        }
    }
    // unit direction of element i at time t on its (precessing) conic -> dx/dy/dz[i]
    directionAt(i, t) {
        const dt = t - this.tp[i];
        perifocalAt(this.q[i], this.alpha[i], this.spec.mu, dt, NaN, _pf);
        const phi = this.anomaly(i, dt, _pf[0], _pf[1]) / this.kap[i];
        const c = Math.cos(phi), s = Math.sin(phi);
        this.dx[i] = c * this.ex[i] + s * this.qx[i];
        this.dy[i] = c * this.ey[i] + s * this.qy[i];
        this.dz[i] = c * this.ez[i] + s * this.qz[i];
    }
    // continuous Kepler true anomaly of element i at dt after its pericentre
    anomaly(i, dt, X, Y) {
        let psi = Math.atan2(Y, X);
        if (this.alpha[i] > 0) {
            const P = this.tRet[i] - this.tp[i];
            if (P > 0) psi += TAU * Math.round(dt / P);
        }
        return psi;
    }
    // Position of element i relative to the hole at sim time t (km, world
    // axes) into out[0..2]; returns a brightness factor (0: not there).
    legAt(i, t) {
        if (t < this.spec.t0) return LEG_NONE;
        const f = this.flags[i];
        if ((f & DEBRIS_PLUNGE) && t >= this.tX[i]) return LEG_PLUNGE;
        if ((f & DEBRIS_BOUND) && t >= this.tRet[i]) return LEG_RING;
        return LEG_KEPLER;
    }
    // Element i as an observer at world (ox, oy, oz) sees it at coordinate time
    // t: at its own retarded time t_i = t - |x_i(t_i) - x_obs| / c, starting
    // from the hole's retarded time tH (the hole now at world hx, hy, hz). On
    // a Kepler leg with little angle swept in between, the light-cone
    // condition is solved for straight-line motion at the element's velocity
    // (exact to first order in the curvature); otherwise it is iterated.
    seenAt(i, t, tH, hx, hy, hz, ox, oy, oz, out) {
        let a = this.particleAt(i, tH, out, true);
        if (!(a > 0)) return a;
        let dx = hx + out[0] - ox, dy = hy + out[1] - oy, dz = hz + out[2] - oz;
        let d = Math.hypot(dx, dy, dz);
        const lag = C_KM_S * (t - tH) - d; // light-path mismatch at tH (km)
        if (Math.abs(lag) < 1e-3 * C_KM_S) return a;
        if (this.lastLeg === LEG_KEPLER) {
            const vx = _vel[0], vy = _vel[1], vz = _vel[2];
            // |d0 + v s| = c (t - tH - s)  ->  s = lag / (c + d_hat . v)
            const s = lag / (C_KM_S + (dx * vx + dy * vy + dz * vz) / Math.max(d, 1e-30));
            const r = Math.hypot(out[0], out[1], out[2]);
            if (Math.hypot(vx, vy, vz) * Math.abs(s) < .05 * r && this.legAt(i, tH + s) === LEG_KEPLER) {
                out[0] += vx * s; out[1] += vy * s; out[2] += vz * s;
                return a;
            }
        }
        // iterate the light-cone condition (converges by ~v/c per pass)
        let ti = t - d / C_KM_S;
        for (let k = 0; k < 4; k++) {
            a = this.particleAt(i, ti, out);
            if (!(a > 0)) return a;
            dx = hx + out[0] - ox; dy = hy + out[1] - oy; dz = hz + out[2] - oz;
            const tn = t - Math.hypot(dx, dy, dz) / C_KM_S;
            if (Math.abs(tn - ti) < 1e-3) break;
            ti = tn;
        }
        return a;
    }
    // wantVel: on a Kepler leg also leave the velocity in the module scratch
    particleAt(i, t, out, wantVel = false) {
        const sp = this.spec, mu = sp.mu;
        this.lastLeg = LEG_NONE;
        if (t < sp.t0) return 0;
        const f = this.flags[i];
        if ((f & DEBRIS_PLUNGE) && t >= this.tX[i]) {
            this.lastLeg = LEG_PLUNGE;
            // seen from afar, matter approaches the horizon asymptotically,
            // e-folding every 2 r_s / c
            const rs = Math.max(1e-9, sp.rs);
            const x = -(t - this.tX[i]) * C_LIGHT / (2 * rs);
            if (x < LN_TINY) return 0;
            const r = rs + (this.rX[i] - rs) * Math.exp(x);
            out[0] = this.dx[i] * r; out[1] = this.dy[i] * r; out[2] = this.dz[i] * r;
            return 1;
        }
        if ((f & DEBRIS_BOUND) && t >= this.tRet[i]) {
            this.lastLeg = LEG_RING;
            // Back at pericentre the element meets the precessed stream and
            // circularizes at fixed angular momentum: semi-latus rectum 2q,
            //   r = r_c / (1 + e cos th),  e = exp(-age / P0),
            // then drifts inward, r_c = 2q (1 + age/tau_v)^(-2/3), a law whose
            // Kepler phase integrates in closed form (th = w0 (age +
            // age^2 / 2 tau_v)). Accreted at the ISCO.
            const age = t - this.tRet[i];
            const r0 = 2 * this.q[i];
            const rIn = 3 * sp.rs;
            if (r0 <= rIn) return 0;
            const w0 = Math.sqrt(mu / (r0 * r0 * r0));
            const P0 = TAU / w0;
            const tauV = VISC_ORBITS * P0;
            const rc = r0 * Math.pow(1 + age / tauV, -2 / 3);
            if (rc <= rIn) return 0;
            const e = Math.exp(-age / P0);
            const th = w0 * (age + age * age / (2 * tauV));
            const r = rc / (1 + e * Math.cos(th));
            const ph = TAU / this.kap[i] + th; // from the precessed pericentre
            const c = Math.cos(ph), s = Math.sin(ph);
            out[0] = r * (c * this.ex[i] + s * this.qx[i]);
            out[1] = r * (c * this.ey[i] + s * this.qy[i]);
            out[2] = r * (c * this.ez[i] + s * this.qz[i]);
            return Math.min(1, (rc - rIn) / (.25 * rIn));
        }
        this.lastLeg = LEG_KEPLER;
        const dt = t - this.tp[i];
        const q = this.q[i], al = this.alpha[i], kap = this.kap[i];
        const chi = perifocalAt(q, al, mu, dt, this.chi[i], _pf);
        if (Number.isFinite(chi)) this.chi[i] = chi;
        const r = _pf[2];
        const phi = this.anomaly(i, dt, _pf[0], _pf[1]) / kap;
        const c = Math.cos(phi), s = Math.sin(phi);
        const ex = this.ex[i], ey = this.ey[i], ez = this.ez[i], qx = this.qx[i], qy = this.qy[i], qz = this.qz[i];
        out[0] = r * (c * ex + s * qx);
        out[1] = r * (c * ey + s * qy);
        out[2] = r * (c * ez + s * qz);
        if (wantVel) {
            // dr/dt along r_hat, r dphi/dt along phi_hat; dphi/dt = h' / (kappa r^2)
            const rd = _pf[3];
            const hp = q * Math.sqrt(Math.max(0, mu * (2 / q - al)));
            const vt = hp / (kap * r);
            _vel[0] = rd * (c * ex + s * qx) + vt * (c * qx - s * ex);
            _vel[1] = rd * (c * ey + s * qy) + vt * (c * qy - s * ey);
            _vel[2] = rd * (c * ez + s * qz) + vt * (c * qz - s * ez);
        }
        return 1;
    }
    // Before the freeze epoch the body is still whole: its centre of mass on
    // the (Kepler) orbit it arrived on, at time t < t0, into out — for drawing
    // the intact body as a distant observer still sees it after the
    // simulation has already disrupted it (light-travel time).
    centreBefore(t, out) {
        const sp = this.spec;
        propagateState(sp.x, sp.y, sp.z, sp.vx, sp.vy, sp.vz, sp.mu, t - sp.t0, _cb);
        out[0] = _cb.x; out[1] = _cb.y; out[2] = _cb.z;
        return out;
    }
    // counts at sim time t (inspection / tests)
    census(t) {
        let bound = 0, returned = 0, plunged = 0, accreted = 0;
        for (let i = 0; i < this.count; i++) {
            const f = this.flags[i];
            if (f & DEBRIS_BOUND) bound++;
            if ((f & DEBRIS_PLUNGE) && t >= this.tX[i]) plunged++;
            else if ((f & DEBRIS_BOUND) && t >= this.tRet[i]) {
                returned++;
                if (this.particleAt(i, t, _pf) === 0) accreted++;
            }
        }
        return { count: this.count, bound, unbound: this.count - bound, returned, plunged, accreted };
    }
}
