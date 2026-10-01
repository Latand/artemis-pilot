// External monopole dynamics of each gas+core system. Internal SPH coordinates
// stay local: no claim of resolved external tides, stripping or fragmentation.
// Galactic transport is a prescribed circular guiding orbit with a vertical
// harmonic term; local gravitational kicks evolve the displacement around it.
import { MU_S } from '../constants.js';
import { BH, EPHT, bhMuAt } from '../state.js';
import { NEBULAE } from './nebulaeData.js';
import { gasStateAt } from './gasFormation.js';
import { solarGalacticStateAt } from './solarOrbit.js';
import { vCirc } from './astroConstants.js';
import { PC_KM, worldKmToGalFromInto, galToWorldKmFromInto, galDeltaToWorldKmInto } from './coords.js';

export const GAS_DYNAMICS_SCOPE = 'Gas + core monopole COM; mutual local gravity with placed holes and Solar-System bodies; prescribed galactic guiding orbit; no external SPH tides. Ejected stellar mass leaves the modeled gravitating system.';
const MATERIAL_ACCEL = 1e-12; // km/s²: below this, analytic background/restoring flow may bridge.
export const GAS_GALACTIC_DOMAIN = Object.freeze({ minRadiusPc: 5000, maxRadiusPc: 25000, maxHeightPc: 3000 });
export function gasGalacticDomain(record) {
    const sun = solarGalacticStateAt(record.formation?.bornAtSec || 0), p = [0, 0, 0];
    worldKmToGalFromInto(record.xKm, record.yKm, record.zKm, sun.x, sun.y, sun.z, p);
    const radiusPc = Math.hypot(p[0], p[1]), heightPc = Math.abs(p[2]);
    const supported = radiusPc >= GAS_GALACTIC_DOMAIN.minRadiusPc && radiusPc <= GAS_GALACTIC_DOMAIN.maxRadiusPc && heightPc <= GAS_GALACTIC_DOMAIN.maxHeightPc;
    return { supported, radiusPc, heightPc, note: supported ? 'Milky Way disk guiding-orbit approximation' : 'Outside the supported Milky Way disk domain (R 5–25 kpc, |z| ≤3 kpc); no galactic orbit is inferred' };
}
const anchors = new WeakMap();
let predictionGas = null;
let excludedBirth = NaN;
let cacheT = NaN, cacheRows = [], cacheRecords = [], cacheSignature = '';
export function invalidateGasDynamics() { cacheT = NaN; }
export function beginGasDynamicsStep(t, dt) { excludedBirth = Math.max(t, t + dt); invalidateGasDynamics(); }
export function endGasDynamicsStep() { excludedBirth = NaN; invalidateGasDynamics(); }
export function hasGasDynamics() { return NEBULAE.some(n => !!n.formation); }
export function normalizeGasDynamics(value, bornAtSec = 0) {
    const valid = value?.v === 1 && Number.isFinite(value.t) && value.t >= bornAtSec && Math.abs(value.t) <= 1e30 &&
        [value.offsetKm, value.velocityKmS].every((a, i) => Array.isArray(a) && a.length === 3 &&
            Array.from(a).every(v => Number.isFinite(v) && Math.abs(v) <= (i === 0 ? 1e30 : 1e12)));
    return valid ? { v: 1, t: value.t, offsetKm: [...value.offsetKm], velocityKmS: [...value.velocityKmS] }
        : { v: 1, t: bornAtSec, offsetKm: [0, 0, 0], velocityKmS: [0, 0, 0] };
}
function data(record) { return record.formation.dynamics || normalizeGasDynamics(null, record.formation.bornAtSec); }
function mutableData(record) {
    return record.formation.dynamics ||= normalizeGasDynamics(null, record.formation.bornAtSec);
}
function anchor(record) {
    let a = anchors.get(record);
    if (a) return a;
    const t = record.formation.bornAtSec, sun = solarGalacticStateAt(t), p = [0, 0, 0];
    worldKmToGalFromInto(record.xKm, record.yKm, record.zKm, sun.x, sun.y, sun.z, p);
    const radius = Math.max(1, Math.hypot(p[0], p[1]));
    const supported = gasGalacticDomain(record).supported;
    const omega = supported ? vCirc(radius / 1000) / (radius * PC_KM) : 0;
    const raw = [0, 0, 0];
    galToWorldKmFromInto(p[0], p[1], p[2], sun.x, sun.y, sun.z, raw);
    a = { t, p, omega, supported, nu: 2.7 * omega, correction: [record.xKm - raw[0], record.yKm - raw[1], record.zKm - raw[2]] };
    anchors.set(record, a);
    return a;
}
function background(record, simT, out) {
    const a = anchor(record), dt = Math.max(0, simT - a.t), th = a.omega * dt;
    out.galacticSupported = a.supported;
    if (!a.supported) return Object.assign(out, { x: record.xKm, y: record.yKm, z: record.zKm, vx: 0, vy: 0, vz: 0 });
    const c = Math.cos(th), s = Math.sin(th), x = a.p[0] * c - a.p[1] * s, y = a.p[0] * s + a.p[1] * c;
    const z = a.p[2] * Math.cos(a.nu * dt), vz = -a.p[2] * a.nu * Math.sin(a.nu * dt);
    const sun = solarGalacticStateAt(Math.max(a.t, simT));
    const p = [0, 0, 0], v = [0, 0, 0];
    galToWorldKmFromInto(x, y, z, sun.x, sun.y, sun.z, p);
    galDeltaToWorldKmInto(-a.omega * y - sun.vx / PC_KM, a.omega * x - sun.vy / PC_KM, vz - sun.vz / PC_KM, v);
    // Exact release placement avoids the finite-precision matrix round trip.
    out.x = dt === 0 ? record.xKm : p[0] + a.correction[0]; out.y = dt === 0 ? record.yKm : p[1] + a.correction[1]; out.z = dt === 0 ? record.zKm : p[2] + a.correction[2];
    out.vx = v[0]; out.vy = v[1]; out.vz = v[2];
    return out;
}
// Exact bounded restoring flow for the residual. This is a declared reduced-
// order background, not ballistic v*t extrapolation over galactic times.
function residualAt(record, d, t, out) {
    const dt = t - d.t, omega = anchor(record).omega;
    const angle = omega * dt, c = Math.cos(angle), sn = Math.sin(angle);
    const sinc = Math.abs(angle) < 1e-5 ? dt * (1 - angle * angle / 6) : sn / omega;
    for (let k = 0; k < 3; k++) {
        const q = d.offsetKm[k], v = d.velocityKmS[k];
        out.offsetKm[k] = q * c + v * sinc;
        out.velocityKmS[k] = v * c - q * omega * sn;
    }
    out.t = t;
    return out;
}
export function gasWorldState(record, simT, out = {}) {
    if (!record?.formation) return Object.assign(out, { x: record?.xKm || 0, y: record?.yKm || 0, z: record?.zKm || 0, vx: 0, vy: 0, vz: 0 });
    background(record, simT, out);
    if (simT < record.formation.bornAtSec) return out;
    const d = residualAt(record, data(record), simT, { offsetKm: [0, 0, 0], velocityKmS: [0, 0, 0] });
    out.x += d.offsetKm[0]; out.y += d.offsetKm[1]; out.z += d.offsetKm[2];
    out.vx += d.velocityKmS[0]; out.vy += d.velocityKmS[1]; out.vz += d.velocityKmS[2];
    const a = anchor(record), amplitude = Math.hypot(...d.offsetKm) + (a.omega > 0 ? Math.hypot(...d.velocityKmS) / a.omega : 0);
    out.guidingApproximationValid = a.supported && amplitude <= .1 * Math.hypot(a.p[0], a.p[1]) * PC_KM;
    out.dynamicsNote = !a.supported ? 'Inertial local coupling; no galactic background outside the MW disk model domain' :
        out.guidingApproximationValid ? 'Prescribed circular guide and harmonic response; approximate galactic motion' :
            'Strong displacement exceeds the small-perturbation guide model; galactic escape is not resolved';
    return out;
}
export function serializeGasDynamics(record, simT) {
    const d = normalizeGasDynamics(data(record), record.formation.bornAtSec);
    const t = Math.max(record.formation.bornAtSec, simT);
    residualAt(record, d, t, d);
    return d;
}
export function resetGasDynamics() {
    for (const n of NEBULAE) if (n.formation) n.formation.dynamics = normalizeGasDynamics(null, n.formation.bornAtSec);
    invalidateGasDynamics();
}
// Predictions hold the current inventory/extent while transporting the COM;
// they must not manufacture future SPH samples or lose an unprepared source.
export function beginPredictionGas(simT = EPHT.t) {
    predictionGas = null;
    invalidateGasDynamics();
    predictionGas = gasGravitySources(simT).map(s => ({ ...s,
        record: { xKm: s.record.xKm, yKm: s.record.yKm, zKm: s.record.zKm,
            formation: { bornAtSec: s.record.formation.bornAtSec, dynamics: serializeGasDynamics(s.record, simT) } },
        acceleration: [0, 0, 0],
    }));
}
export function endPredictionGas() { predictionGas = null; invalidateGasDynamics(); }
export function gasGravitySources(simT) {
    if (predictionGas) return predictionGas.map(s => ({ ...s, ...gasWorldState(s.record, simT), acceleration: [0, 0, 0] }));
    if (!hasGasDynamics()) return [];
    const signature = NEBULAE.map(n => n.formation ? `${n.seed}:${n.formation.bornAtSec}:${n.formation.massSolar}` : '-').join('|');
    if (cacheT === simT && signature === cacheSignature && cacheRecords.length === NEBULAE.length && cacheRecords.every((n, i) => n === NEBULAE[i])) return cacheRows;
    cacheRows = []; cacheRecords = [...NEBULAE]; cacheT = simT; cacheSignature = signature;
    for (const record of NEBULAE) {
        if (!record.formation || simT < record.formation.bornAtSec || record.formation.bornAtSec === excludedBirth) continue;
        const s = gasStateAt(record, simT);
        if (!s?.present) continue;
        const stellarMass = s.stellarMassSolar ?? s.coreMassSolar;
        const mass = s.gasMassSolar + stellarMass;
        if (!(mass > 0)) continue;
        // One monopole for gas + core. Its extent is the gas mass-weighted
        // rms size plus the unresolved core softening while gas remains.
        const eps = s.gasMassSolar > 0 ? Math.max(s.softeningKm,
            s.diagnostics.rmsRadius * record.radiusKm * Math.sqrt(s.gasMassSolar / mass)) : 0;
        cacheRows.push({ record, ...gasWorldState(record, simT), mu: MU_S * mass, massSolar: mass,
            softeningKm: eps, radiusKm: s.stellar?.radiusKm || s.sinkRadiusKm, rs: s.stellar?.kind === "BH" ? s.stellar.radiusKm : 0,
            acceleration: [0, 0, 0] });
    }
    return cacheRows;
}
// A single symmetric Plummer/Paczyński–Wiita kernel, used for both sides of
// every aggregate pair. Diffuse cloud extent removes its centre singularity.
export function gasPairWeight(dx, dy, dz, softeningKm, rs = 0) {
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz + softeningKm * softeningKm);
    if (!(r > 1e-12)) return 0;
    const eff = Math.max(r - rs, rs * .02, 1e-12);
    return 1 / (r * eff * eff);
}
export function gasFieldAt(wx, wy, wz, simT, out, holeIndex = -1, ex = 0, ey = 0) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    if (!predictionGas && !hasGasDynamics()) return out;
    for (const s of gasGravitySources(simT)) {
        const dx = wx - s.x, dy = wy - s.y, dz = wz - s.z;
        // Symmetric activation: the mass front reaching the aggregate gates
        // both kicks, so a newly created hole cannot receive a one-sided kick.
        const gate = holeIndex >= 0 && BH.mu[holeIndex] > 0 ? bhMuAt(holeIndex, s.x - ex, s.y - ey, s.z, simT) / BH.mu[holeIndex] : 1;
        const w = s.mu * gate * gasPairWeight(dx, dy, dz, s.softeningKm, s.rs + (holeIndex >= 0 ? BH.rs[holeIndex] : 0));
        out[0] -= w * dx; out[1] -= w * dy; out[2] -= w * dz;
    }
    return out;
}
// Solar sources are world-km {x,y,z,mu}; no Earth-frame term is applied to the
// aggregate because its displacement is stored in world axes, not Earth-local.
export function kickGasDynamics(st, dt, solarSources) {
    const rows = gasGravitySources(st.t);
    for (const s of rows) {
        const a = s.acceleration; a.fill(0);
        for (const body of solarSources) {
            if (!(body.mu > 0)) continue;
            const dx = s.x - body.x, dy = s.y - body.y, dz = s.z - body.z;
            const w = body.mu * gasPairWeight(dx, dy, dz, s.softeningKm, s.rs);
            a[0] -= w * dx; a[1] -= w * dy; a[2] -= w * dz;
        }
        for (let j = 0; j < BH.n; j++) {
            const dx = s.x - (st.earthX + BH.x[j]), dy = s.y - (st.earthY + BH.y[j]), dz = s.z - BH.z[j];
            const mu = bhMuAt(j, s.x - st.earthX, s.y - st.earthY, s.z, st.t);
            const w = mu * gasPairWeight(dx, dy, dz, s.softeningKm, s.rs + BH.rs[j]);
            a[0] -= w * dx; a[1] -= w * dy; a[2] -= w * dz;
        }
    }
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i], b = rows[j], dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        const w = gasPairWeight(dx, dy, dz, Math.hypot(a.softeningKm, b.softeningKm), a.rs + b.rs);
        for (const [axis, d] of [[0, dx], [1, dy], [2, dz]]) { a.acceleration[axis] -= b.mu * w * d; b.acceleration[axis] += a.mu * w * d; }
    }
    for (const s of rows) {
        const d = mutableData(s.record);
        residualAt(s.record, d, st.t, d);
        for (let axis = 0; axis < 3; axis++) d.velocityKmS[axis] += dt * s.acceleration[axis];
    }
    invalidateGasDynamics();
}
export function driftGasDynamics(tEnd) {
    for (const n of NEBULAE) {
        if (!n.formation || tEnd < n.formation.bornAtSec) continue;
        const d = mutableData(n);
        residualAt(n, d, tEnd, d);
    }
    invalidateGasDynamics();
}
export function gasEncounterStep(st, solarSources, maxStep = Infinity) {
    let step = maxStep;
    const rows = gasGravitySources(st.t);
    for (const s of rows) {
        const pair = (x, y, z, mu, vx = 0, vy = 0, vz = 0, rs = 0) => {
            if (!(mu > 0)) return;
            const dx = s.x - x, dy = s.y - y, dz = s.z - z;
            const r = Math.sqrt(dx * dx + dy * dy + dz * dz + s.softeningKm ** 2);
            const pairRs = rs + s.rs;
            const eff = Math.max(r - pairRs, pairRs * .02, 1e-12);
            const acceleration = Math.max(mu, s.mu) / (eff * eff);
            if (acceleration < MATERIAL_ACCEL) return;
            const speed = Math.hypot(s.vx - vx, s.vy - vy, s.vz - vz);
            step = Math.min(step, Math.sqrt(eff * eff * r / (mu + s.mu)) / 90,
                .05 * Math.max(eff, s.softeningKm) / Math.max(speed, 1e-9));
        };
        for (const b of solarSources) pair(b.x, b.y, b.z, b.mu, b.vx, b.vy, b.vz);
        for (let j = 0; j < BH.n; j++) pair(st.earthX + BH.x[j], st.earthY + BH.y[j], BH.z[j], BH.mu[j],
            st.earthVx + BH.vx[j], st.earthVy + BH.vy[j], BH.vz[j], BH.rs[j]);
        for (const other of rows) if (s !== other) pair(other.x, other.y, other.z, other.mu, other.vx, other.vy, other.vz);
    }
    return step;
}
export function gasNeedsIntegrated(st, solarSources) { return Number.isFinite(gasEncounterStep(st, solarSources)); }
