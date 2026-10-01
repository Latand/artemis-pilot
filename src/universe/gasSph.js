// A deliberately low-resolution, bounded 3-D self-gravitating SPH experiment.
// It integrates forces; there is no elapsed-time -> star conversion.
//
// Units: initial cloud M = R = G = 1. Fixed cubic-spline smoothing conserves
// pair momentum, with Plummer-softened gravity and Monaghan shock viscosity.
// KDK steps use state-only quantized Courant/acceleration limits. Temperature
// is an ISOTHERMAL bath (P = rho kT/mu), appropriate only as a crude optically
// thin molecular-cloud closure. Net hydro work exchanged with the bath on
// each kick is accumulated by sign (radiated / background supplied); these
// are global energy counters, not spatial radiative fluxes. There is
// no radiative transfer, magnetic field, feedback, resolved fragmentation,
// stellar interior or nuclear fusion. A sink is an UNRESOLVED collapsing core.
// The sink scale is numerical resolution, NOT a physical protostar radius.
//
// Equations/scope: Price (2012) https://arxiv.org/abs/1012.1885 ; sink tests
// adapted from Bate et al. (1995) https://arxiv.org/abs/astro-ph/9510149 .
// Isothermal caveats: Whitehouse & Bate https://arxiv.org/abs/astro-ph/0511671 .
import { MU_S } from '../constants.js';
import { makeRNG } from './prng.js';

export const GAS_SPH_VERSION = 1;
export const GAS_SPH_MAX_PARTICLES = 128;
export const GAS_SPH_DEFAULT_PARTICLES = 96;
export const GAS_SPH_MAX_STEPS_PER_ADVANCE = 256;
const SOLAR_MASS_KG = 1.98847e30;
const KB_OVER_MU_MH_KM2_S2_K = 1.380649e-23 / (2.33 * 1.6735575e-27) / 1e6;
const MEAN_DENSITY = 3 / (4 * Math.PI);
const MAX_DT = 1 / 64;
const MIN_DT = MAX_DT / 1048576;
const ARRAY_FIELDS = ['positions', 'velocities', 'accelerations', 'hydroAccelerations', 'density', 'temperatureK', 'gravitationalPotential'];
const number = (v, fallback, lo, hi) => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const vec = () => new Float64Array(3);

function kernel(q, norm) {
    if (q < 1) return norm * (1 - 1.5 * q * q + .75 * q * q * q);
    if (q < 2) return norm * .25 * (2 - q) ** 3;
    return 0;
}
function kernelGradientOverR(r, h, norm) {
    if (r === 0 || r >= 2 * h) return 0;
    const q = r / h;
    return norm / (h * r) * (q < 1 ? -3 * q + 2.25 * q * q : -.75 * (2 - q) ** 2);
}

/** Options are physical mass/radius/temperature; initial velocities are in sqrt(GM/R).
 * turbulence is per-axis uniform random amplitude; radialVelocity > 0 expands.
 * Array coordinates/velocities and sink mass are dimensionless. Do not mutate
 * solver arrays between steps; snapshots are the supported serialization API. */
export function createGasSph(options = {}) {
    const count = Math.round(number(options.particleCount, GAS_SPH_DEFAULT_PARTICLES, 32, GAS_SPH_MAX_PARTICLES));
    const config = {
        massSolar: number(options.massSolar, 1, .01, 100),
        radiusKm: number(options.radiusKm, .045 * 9.4607e12, 1e6, 1e15),
        temperatureK: number(options.temperatureK, 10, 2.7, 10000),
        particleCount: count,
        seed: Number.isFinite(options.seed) ? options.seed >>> 0 : 2401,
        turbulence: number(options.turbulence, .025, 0, 10),
        radialVelocity: number(options.radialVelocity, 0, -10, 10),
        rotation: number(options.rotation, .035, 0, 5),
    };
    const unitVelocityKmS = Math.sqrt(MU_S * config.massSolar / config.radiusKm);
    const state = {
        version: GAS_SPH_VERSION, config, count, parcelMass: 1 / count,
        unitTimeSec: config.radiusKm / unitVelocityKmS, unitVelocityKmS,
        unitEnergyJ: SOLAR_MASS_KG * config.massSolar * (1000 * unitVelocityKmS) ** 2,
        unitDensityKgM3: SOLAR_MASS_KG * config.massSolar / (1000 * config.radiusKm) ** 3,
        time: 0, ageSec: 0, steps: 0, status: 'running',
        h: .28 * (96 / count) ** (1 / 3), softening: .07,
        sinkRadius: .18, sinkDensity: 16 * MEAN_DENSITY,
        soundSpeedSquared: KB_OVER_MU_MH_KM2_S2_K * config.temperatureK / unitVelocityKmS ** 2,
        active: new Uint8Array(count).fill(1),
        positions: new Float64Array(count * 3), velocities: new Float64Array(count * 3),
        accelerations: new Float64Array(count * 3), hydroAccelerations: new Float64Array(count * 3),
        gravitationalPotential: new Float64Array(count), density: new Float64Array(count), temperatureK: new Float64Array(count).fill(config.temperatureK),
        sink: { mass: 0, position: vec(), velocity: vec(), acceleration: vec(), angularMomentum: vec(), formedAtSec: null, accretedCount: 0 },
        radiatedEnergy: 0, backgroundHeatingEnergy: 0, unresolvedEnergy: 0,
        initialEnergy: 0, initialMomentum: vec(), initialCenterOfMass: vec(),
        lastDt: 0, initialPeakDensity: 0, maxSignalSpeed: 0,
    };
    // Rejection-sampled hard-core sphere: seeded, isotropic, no forced collapse
    // velocities. Minimum separation reduces SPH particle clumping noise.
    const rng = makeRNG(config.seed);
    const minSeparation2 = (.29 * (96 / count) ** (1 / 3)) ** 2;
    for (let i = 0; i < count; ++i) {
        let x = 0, y = 0, z = 0, accepted = false;
        for (let trial = 0; trial < 10000; ++trial) {
            x = 2 * rng() - 1; y = 2 * rng() - 1; z = 2 * rng() - 1;
            if (x * x + y * y + z * z > 1) continue;
            let clear = true;
            for (let j = 0; j < i; ++j) {
                const dx = x - state.positions[3 * j], dy = y - state.positions[3 * j + 1], dz = z - state.positions[3 * j + 2];
                if (dx * dx + dy * dy + dz * dz < minSeparation2) { clear = false; break; }
            }
            if (clear) { accepted = true; break; }
        }
        if (!accepted) throw new Error('Unable to initialize separated gas parcels');
        const k = 3 * i;
        state.positions[k] = x; state.positions[k + 1] = y; state.positions[k + 2] = z;
        state.velocities[k] = config.radialVelocity * x - config.rotation * y + config.turbulence * (2 * rng() - 1);
        state.velocities[k + 1] = config.radialVelocity * y + config.rotation * x + config.turbulence * (2 * rng() - 1);
        state.velocities[k + 2] = config.radialVelocity * z + config.turbulence * (2 * rng() - 1);
    }
    // Start in the barycentric frame; every later force is pair-antisymmetric.
    for (let axis = 0; axis < 3; ++axis) {
        let p = 0, v = 0;
        for (let i = 0; i < count; ++i) { p += state.positions[3 * i + axis] / count; v += state.velocities[3 * i + axis] / count; }
        for (let i = 0; i < count; ++i) { state.positions[3 * i + axis] -= p; state.velocities[3 * i + axis] -= v; }
    }
    evaluateForces(state);
    const d = gasSphDiagnostics(state);
    state.initialEnergy = d.totalEnergy;
    state.initialMomentum.set(d.momentum);
    state.initialCenterOfMass.set(d.centerOfMass);
    state.initialPeakDensity = d.peakDensity;
    return state;
}

function evaluateForces(s) {
    const { count: n, positions: p, velocities: v, accelerations: a, hydroAccelerations: ah, density: rho, active, parcelMass: m, h, sink } = s;
    const norm = 1 / (Math.PI * h ** 3), eps2 = s.softening ** 2;
    a.fill(0); ah.fill(0); rho.fill(0); s.gravitationalPotential.fill(0); sink.acceleration.fill(0);
    for (let i = 0; i < n; ++i) if (active[i]) rho[i] = m * norm;
    for (let i = 0; i < n; ++i) if (active[i]) {
        const k = 3 * i;
        for (let j = i + 1; j < n; ++j) if (active[j]) {
            const l = 3 * j, dx = p[k] - p[l], dy = p[k + 1] - p[l + 1], dz = p[k + 2] - p[l + 2];
            const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const contribution = m * kernel(r / h, norm);
            rho[i] += contribution; rho[j] += contribution;
        }
    }
    const cs = Math.sqrt(s.soundSpeedSquared);
    let maxSignalSpeed = 2 * cs;
    for (let i = 0; i < n; ++i) if (active[i]) {
        const k = 3 * i;
        for (let j = i + 1; j < n; ++j) if (active[j]) {
            const l = 3 * j, dx = p[k] - p[l], dy = p[k + 1] - p[l + 1], dz = p[k + 2] - p[l + 2];
            const r2 = dx * dx + dy * dy + dz * dz, r = Math.sqrt(r2);
            const invDistance = 1 / Math.sqrt(r2 + eps2);
            const gravity = -m * invDistance ** 3;
            s.gravitationalPotential[i] -= m * invDistance; s.gravitationalPotential[j] -= m * invDistance;
            const approach = (v[k] - v[l]) * dx + (v[k + 1] - v[l + 1]) * dy + (v[k + 2] - v[l + 2]) * dz;
            let viscosity = 0;
            if (approach < 0 && r < 2 * h) {
                const mu = h * approach / (r2 + .01 * h * h);
                viscosity = (-cs * mu + 2 * mu * mu) / (.5 * (rho[i] + rho[j]));
                maxSignalSpeed = Math.max(maxSignalSpeed, 2 * cs - 3 * mu);
            }
            const hydro = -m * (s.soundSpeedSquared * (1 / rho[i] + 1 / rho[j]) + viscosity) * kernelGradientOverR(r, h, norm);
            const f = gravity + hydro;
            a[k] += f * dx; a[k + 1] += f * dy; a[k + 2] += f * dz;
            a[l] -= f * dx; a[l + 1] -= f * dy; a[l + 2] -= f * dz;
            ah[k] += hydro * dx; ah[k + 1] += hydro * dy; ah[k + 2] += hydro * dz;
            ah[l] -= hydro * dx; ah[l + 1] -= hydro * dy; ah[l + 2] -= hydro * dz;
        }
        if (sink.mass > 0) {
            const dx = p[k] - sink.position[0], dy = p[k + 1] - sink.position[1], dz = p[k + 2] - sink.position[2];
            const invDistance = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
            const f = -(invDistance ** 3);
            s.gravitationalPotential[i] -= sink.mass * invDistance;
            a[k] += sink.mass * f * dx; a[k + 1] += sink.mass * f * dy; a[k + 2] += sink.mass * f * dz;
            sink.acceleration[0] -= m * f * dx; sink.acceleration[1] -= m * f * dy; sink.acceleration[2] -= m * f * dz;
        }
    }
    s.maxSignalSpeed = maxSignalSpeed;
}

/** Dimensionless timestep determined only by current solver state. */
export function gasSphNextDt(s) {
    if (s.status !== 'running') return 0;
    let maxAcceleration = 0, maxSpeed = 0;
    for (let i = 0; i < s.count; ++i) if (s.active[i]) {
        const k = 3 * i;
        maxAcceleration = Math.max(maxAcceleration, Math.hypot(s.accelerations[k], s.accelerations[k + 1], s.accelerations[k + 2]));
        maxSpeed = Math.max(maxSpeed, Math.hypot(s.velocities[k], s.velocities[k + 1], s.velocities[k + 2]));
    }
    maxAcceleration = Math.max(maxAcceleration, Math.hypot(...s.sink.acceleration));
    const bound = Math.min(MAX_DT, .2 * s.h / Math.max(s.maxSignalSpeed, 1e-12), .18 * Math.sqrt(s.softening / Math.max(maxAcceleration, 1e-12)), .2 * s.softening / Math.max(maxSpeed, 1e-12));
    if (!Number.isFinite(bound) || bound < MIN_DT) return 0;
    return MAX_DT / 2 ** Math.max(0, Math.ceil(Math.log2(MAX_DT / bound)));
}

export const nextGasSphDt = gasSphNextDt;

function kick(s, dt) {
    let hydroWork = 0;
    for (let i = 0; i < s.count; ++i) if (s.active[i]) for (let axis = 0; axis < 3; ++axis) {
        const k = 3 * i + axis, dv = s.accelerations[k] * dt;
        // Exact work of the hydro share of this kick, at the mean velocity.
        hydroWork += s.parcelMass * (s.velocities[k] + .5 * dv) * s.hydroAccelerations[k] * dt;
        s.velocities[k] += dv;
    }
    if (hydroWork < 0) s.radiatedEnergy -= hydroWork;
    else s.backgroundHeatingEnergy += hydroWork;
    if (s.sink.mass > 0) for (let axis = 0; axis < 3; ++axis) s.sink.velocity[axis] += s.sink.acceleration[axis] * dt;
}

function mergeIntoSink(s, ids) {
    const before = gasSphDiagnostics(s).totalEnergy;
    const sink = s.sink, oldMass = sink.mass, newMass = oldMass + ids.length * s.parcelMass;
    const center = vec(), velocity = vec(), spin = Float64Array.from(sink.angularMomentum);
    for (let axis = 0; axis < 3; ++axis) {
        center[axis] = oldMass * sink.position[axis]; velocity[axis] = oldMass * sink.velocity[axis];
        for (const i of ids) { center[axis] += s.parcelMass * s.positions[3 * i + axis]; velocity[axis] += s.parcelMass * s.velocities[3 * i + axis]; }
        center[axis] /= newMass; velocity[axis] /= newMass;
    }
    const addSpin = (mass, p, v, k) => {
        const x = p[k] - center[0], y = p[k + 1] - center[1], z = p[k + 2] - center[2];
        const vx = v[k] - velocity[0], vy = v[k + 1] - velocity[1], vz = v[k + 2] - velocity[2];
        spin[0] += mass * (y * vz - z * vy); spin[1] += mass * (z * vx - x * vz); spin[2] += mass * (x * vy - y * vx);
    };
    addSpin(oldMass, sink.position, sink.velocity, 0);
    for (const i of ids) { addSpin(s.parcelMass, s.positions, s.velocities, 3 * i); s.active[i] = 0; s.density[i] = 0; }
    sink.mass = newMass; sink.position.set(center); sink.velocity.set(velocity); sink.angularMomentum.set(spin);
    if (oldMass === 0) sink.formedAtSec = s.ageSec;
    sink.accretedCount += ids.length;
    // Signed energy transferred to unresolved degrees of freedom, including
    // changed gravitational self-energy. It is not all radiated luminosity.
    s.unresolvedEnergy += before - gasSphDiagnostics(s).totalEnergy;
}

function findSinkMaterial(s) {
    const { sink, positions: p, velocities: v, active, parcelMass: m } = s;
    if (sink.mass > 0) {
        const ids = [];
        for (let i = 0; i < s.count; ++i) if (active[i]) {
            const k = 3 * i, x = p[k] - sink.position[0], y = p[k + 1] - sink.position[1], z = p[k + 2] - sink.position[2];
            const vx = v[k] - sink.velocity[0], vy = v[k + 1] - sink.velocity[1], vz = v[k + 2] - sink.velocity[2];
            const r2 = x * x + y * y + z * z;
            // Only inward-moving bound gas inside the numerical accretion
            // radius, with too little angular momentum to orbit outside it.
            const l2 = (y * vz - z * vy) ** 2 + (z * vx - x * vz) ** 2 + (x * vy - y * vx) ** 2;
            const binding = (sink.mass + m) / Math.sqrt(r2 + s.softening ** 2);
            if (r2 < s.sinkRadius ** 2 && x * vx + y * vy + z * vz < 0 &&
                .5 * (vx * vx + vy * vy + vz * vz) + 1.5 * s.soundSpeedSquared < binding && l2 < (sink.mass + m) * s.sinkRadius) ids.push(i);
        }
        if (ids.length) mergeIntoSink(s, ids);
        return ids.length > 0;
    }
    let peak = -1;
    for (let i = 0; i < s.count; ++i) if (active[i] && (peak < 0 || s.gravitationalPotential[i] < s.gravitationalPotential[peak])) peak = i;
    if (peak < 0 || s.density[peak] < s.sinkDensity) return false;
    const ids = [], center = vec(), velocity = vec(), pk = 3 * peak;
    for (let i = 0; i < s.count; ++i) if (active[i]) {
        const k = 3 * i, r2 = (p[k] - p[pk]) ** 2 + (p[k + 1] - p[pk + 1]) ** 2 + (p[k + 2] - p[pk + 2]) ** 2;
        if (r2 <= s.sinkRadius ** 2) { ids.push(i); for (let axis = 0; axis < 3; ++axis) { center[axis] += p[k + axis]; velocity[axis] += v[k + axis]; } }
    }
    // At least sixteen parcels around a gravitational-potential minimum;
    // one noisy dense pair must never make a core.
    if (ids.length < 16) return false;
    for (let axis = 0; axis < 3; ++axis) { center[axis] /= ids.length; velocity[axis] /= ids.length; }
    let kinetic = 0, potential = 0, convergence = 0;
    for (let a = 0; a < ids.length; ++a) {
        const k = 3 * ids[a];
        for (let axis = 0; axis < 3; ++axis) {
            const dv = v[k + axis] - velocity[axis];
            kinetic += .5 * m * dv * dv;
            convergence += m * (p[k + axis] - center[axis]) * dv;
        }
        for (let b = a + 1; b < ids.length; ++b) {
            const l = 3 * ids[b];
            potential -= m * m / Math.sqrt((p[k] - p[l]) ** 2 + (p[k + 1] - p[l + 1]) ** 2 + (p[k + 2] - p[l + 2]) ** 2 + s.softening ** 2);
        }
    }
    const thermal = 1.5 * ids.length * m * s.soundSpeedSquared;
    // Negative dI/dt, gravitational binding, and thermal Jeans/virial support
    // test are instantaneous dynamical criteria, entirely independent of age.
    if (convergence < -1e-8 && kinetic + thermal + potential < 0 && 2 * thermal < -potential) {
        mergeIntoSink(s, ids); return true;
    }
    return false;
}

/** One KDK step. Optional dt is dimensionless, positive and <= the stable bound. */
export function stepGasSph(s, dt = gasSphNextDt(s)) {
    if (s.status !== 'running') return false;
    const bound = gasSphNextDt(s);
    if (!(bound > 0)) { s.status = 'resolution-limit'; return false; }
    if (!(dt > 0) || !Number.isFinite(dt) || dt > bound * (1 + 1e-12)) throw new RangeError('Gas SPH timestep exceeds its stable bound');
    kick(s, .5 * dt);
    for (let i = 0; i < s.count; ++i) if (s.active[i]) for (let axis = 0; axis < 3; ++axis) s.positions[3 * i + axis] += s.velocities[3 * i + axis] * dt;
    if (s.sink.mass > 0) for (let axis = 0; axis < 3; ++axis) s.sink.position[axis] += s.sink.velocity[axis] * dt;
    evaluateForces(s);
    kick(s, .5 * dt);
    s.time += dt; s.ageSec = s.time * s.unitTimeSec; s.lastDt = dt; ++s.steps;
    findSinkMaterial(s);
    // Viscosity depends on velocity, so evaluate again at the final full-step
    // velocity. This also refreshes forces after any mass-conserving accretion.
    evaluateForces(s);
    return true;
}

/** Whole canonical steps only, never a target-dependent shortened step.
 * May overshoot target by one step. maxSteps always has an absolute hard cap.
 * Caller owns interpolation, replay on rewind, and any outstanding backlog. */
export function advanceGasSph(s, targetAgeSec, { maxSteps = 64 } = {}) {
    if (!Number.isFinite(targetAgeSec)) throw new RangeError('Gas target age must be finite');
    if (targetAgeSec < s.ageSec) return { steps: 0, complete: false, rewindRequired: true, ageSec: s.ageSec };
    const budget = Math.floor(number(maxSteps, 64, 0, GAS_SPH_MAX_STEPS_PER_ADVANCE));
    let steps = 0;
    while (s.ageSec < targetAgeSec && steps < budget && stepGasSph(s)) ++steps;
    return { steps, complete: s.ageSec >= targetAgeSec, rewindRequired: false, ageSec: s.ageSec, pendingSec: Math.max(0, targetAgeSec - s.ageSec), status: s.status };
}

export function gasSphDiagnostics(s) {
    const { sink, active, positions: p, velocities: v, parcelMass: m } = s;
    let activeCount = 0, kinetic = 0, potential = 0, peakDensity = 0, radiusSquared = 0, maxRadius = 0;
    const momentum = vec(), centerOfMass = vec(), angularMomentum = Float64Array.from(sink.angularMomentum);
    for (let axis = 0; axis < 3; ++axis) { momentum[axis] = sink.mass * sink.velocity[axis]; centerOfMass[axis] = sink.mass * sink.position[axis]; kinetic += .5 * sink.mass * sink.velocity[axis] ** 2; }
    const addAngular = (mass, pos, vel, k) => {
        angularMomentum[0] += mass * (pos[k + 1] * vel[k + 2] - pos[k + 2] * vel[k + 1]);
        angularMomentum[1] += mass * (pos[k + 2] * vel[k] - pos[k] * vel[k + 2]);
        angularMomentum[2] += mass * (pos[k] * vel[k + 1] - pos[k + 1] * vel[k]);
    };
    addAngular(sink.mass, sink.position, sink.velocity, 0);
    for (let i = 0; i < s.count; ++i) if (active[i]) {
        ++activeCount; peakDensity = Math.max(peakDensity, s.density[i]);
        const k = 3 * i;
        for (let axis = 0; axis < 3; ++axis) { momentum[axis] += m * v[k + axis]; centerOfMass[axis] += m * p[k + axis]; kinetic += .5 * m * v[k + axis] ** 2; }
        addAngular(m, p, v, k);
        for (let j = i + 1; j < s.count; ++j) if (active[j]) {
            const l = 3 * j;
            potential -= m * m / Math.sqrt((p[k] - p[l]) ** 2 + (p[k + 1] - p[l + 1]) ** 2 + (p[k + 2] - p[l + 2]) ** 2 + s.softening ** 2);
        }
        if (sink.mass > 0) potential -= m * sink.mass / Math.sqrt((p[k] - sink.position[0]) ** 2 + (p[k + 1] - sink.position[1]) ** 2 + (p[k + 2] - sink.position[2]) ** 2 + s.softening ** 2);
    }
    const gasMass = activeCount * m, totalMass = gasMass + sink.mass;
    for (let axis = 0; axis < 3; ++axis) centerOfMass[axis] /= totalMass;
    for (let i = 0; i < s.count; ++i) if (active[i]) {
        const k = 3 * i, r2 = (p[k] - centerOfMass[0]) ** 2 + (p[k + 1] - centerOfMass[1]) ** 2 + (p[k + 2] - centerOfMass[2]) ** 2;
        radiusSquared += m * r2; maxRadius = Math.max(maxRadius, Math.sqrt(r2));
    }
    const thermal = 1.5 * gasMass * s.soundSpeedSquared, totalEnergy = kinetic + potential + thermal;
    const energyBalanceError = totalEnergy + s.radiatedEnergy - s.backgroundHeatingEnergy + s.unresolvedEnergy - s.initialEnergy;
    const momentumError = Math.hypot(...momentum.map((v, i) => v - s.initialMomentum[i]));
    const centerOfMassError = Math.hypot(...centerOfMass.map((v, i) => v - s.initialCenterOfMass[i] - s.initialMomentum[i] * s.time));
    return {
        activeCount, totalMass, gasMass, sinkMass: sink.mass,
        totalMassSolar: totalMass * s.config.massSolar, gasMassSolar: gasMass * s.config.massSolar, sinkMassSolar: sink.mass * s.config.massSolar,
        centerOfMass, momentum, angularMomentum, momentumError, centerOfMassError, massError: totalMass - 1,
        kineticEnergy: kinetic, potentialEnergy: potential, thermalEnergy: thermal, totalEnergy, energyBalanceError,
        radiatedEnergy: s.radiatedEnergy, backgroundHeatingEnergy: s.backgroundHeatingEnergy, unresolvedEnergy: s.unresolvedEnergy,
        virialRatio: potential < 0 ? 2 * (kinetic + thermal) / -potential : Infinity,
        rmsRadius: gasMass > 0 ? Math.sqrt(radiusSquared / gasMass) : 0, maxRadius,
        peakDensity, peakDensityKgM3: peakDensity * s.unitDensityKgM3,
        densityContrast: peakDensity / MEAN_DENSITY,
        temperatureK: s.config.temperatureK, ageSec: s.ageSec, steps: s.steps,
        formedAtSec: sink.formedAtSec, status: s.status,
    };
}

/** JSON-safe checkpoint: includes everything needed for exact same-engine replay. */
export function snapshotGasSph(s) {
    const snapshot = { ...s, config: { ...s.config }, sink: { ...s.sink } };
    for (const key of ARRAY_FIELDS) snapshot[key] = Array.from(s[key]);
    snapshot.active = Array.from(s.active);
    for (const key of ['initialMomentum', 'initialCenterOfMass']) snapshot[key] = Array.from(s[key]);
    for (const key of ['position', 'velocity', 'acceleration', 'angularMomentum']) snapshot.sink[key] = Array.from(s.sink[key]);
    return snapshot;
}
export function restoreGasSph(snapshot) {
    const invalid = () => { throw new TypeError('Invalid gas SPH snapshot'); };
    const finite = Number.isFinite;
    const positive = x => finite(x) && x > 0;
    const nonnegative = x => finite(x) && x >= 0;
    // Array.every skips sparse holes; materialize them as undefined so an
    // untrusted sparse array cannot become NaN in Float64Array.from.
    const everyEntry = (v, predicate) => Array.from(v).every(predicate);
    const vector = v => Array.isArray(v) && v.length === 3 && everyEntry(v, finite);
    const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
    if (!snapshot || snapshot.version !== GAS_SPH_VERSION || !Number.isInteger(snapshot.count) || snapshot.count < 32 || snapshot.count > GAS_SPH_MAX_PARTICLES) invalid();
    const { config, sink, count } = snapshot;
    if (!config || config.particleCount !== count || !positive(config.massSolar) || config.massSolar < .01 || config.massSolar > 100 ||
        !positive(config.radiusKm) || config.radiusKm < 1e6 || config.radiusKm > 1e15 ||
        !positive(config.temperatureK) || config.temperatureK < 2.7 || config.temperatureK > 10000 ||
        !Number.isInteger(config.seed) || config.seed < 0 || config.seed > 0xffffffff ||
        !nonnegative(config.turbulence) || config.turbulence > 10 || !finite(config.radialVelocity) || Math.abs(config.radialVelocity) > 10 ||
        !nonnegative(config.rotation) || config.rotation > 5) invalid();
    for (const key of ['unitTimeSec', 'unitVelocityKmS', 'unitEnergyJ', 'unitDensityKgM3', 'parcelMass', 'h', 'softening', 'sinkRadius', 'sinkDensity', 'soundSpeedSquared', 'maxSignalSpeed', 'initialPeakDensity']) if (!positive(snapshot[key])) invalid();
    for (const key of ['time', 'ageSec', 'lastDt', 'radiatedEnergy', 'backgroundHeatingEnergy']) if (!nonnegative(snapshot[key])) invalid();
    if (!finite(snapshot.initialEnergy) || !finite(snapshot.unresolvedEnergy) || !Number.isSafeInteger(snapshot.steps) || snapshot.steps < 0 || !['running', 'resolution-limit'].includes(snapshot.status)) invalid();
    if (!close(snapshot.ageSec, snapshot.time * snapshot.unitTimeSec) || !close(snapshot.parcelMass, 1 / count) ||
        !close(snapshot.unitVelocityKmS, Math.sqrt(MU_S * config.massSolar / config.radiusKm)) ||
        !close(snapshot.unitTimeSec, config.radiusKm / snapshot.unitVelocityKmS) ||
        !close(snapshot.unitEnergyJ, SOLAR_MASS_KG * config.massSolar * (1000 * snapshot.unitVelocityKmS) ** 2) ||
        !close(snapshot.unitDensityKgM3, SOLAR_MASS_KG * config.massSolar / (1000 * config.radiusKm) ** 3) ||
        !close(snapshot.soundSpeedSquared, KB_OVER_MU_MH_KM2_S2_K * config.temperatureK / snapshot.unitVelocityKmS ** 2)) invalid();
    if (!sink || !nonnegative(sink.mass) || sink.mass > 1 + 1e-12 || !Number.isInteger(sink.accretedCount) || sink.accretedCount < 0 || sink.accretedCount > count ||
        !close(sink.mass, sink.accretedCount / count) || !(sink.mass > 0 ? nonnegative(sink.formedAtSec) && sink.formedAtSec <= snapshot.ageSec : sink.formedAtSec === null)) invalid();
    for (const key of ['initialMomentum', 'initialCenterOfMass']) if (!vector(snapshot[key])) invalid();
    for (const key of ['position', 'velocity', 'acceleration', 'angularMomentum']) if (!vector(sink[key])) invalid();
    const s = { ...snapshot, config: { ...config }, sink: { ...sink } };
    for (const key of ARRAY_FIELDS) {
        const length = ['density', 'temperatureK', 'gravitationalPotential'].includes(key) ? count : 3 * count;
        if (!Array.isArray(snapshot[key]) || snapshot[key].length !== length || !everyEntry(snapshot[key], finite)) invalid();
        s[key] = Float64Array.from(snapshot[key]);
    }
    if (!everyEntry(snapshot.density, nonnegative) || !everyEntry(snapshot.temperatureK, positive)) invalid();
    if (!Array.isArray(snapshot.active) || snapshot.active.length !== count || !everyEntry(snapshot.active, v => v === 0 || v === 1) || snapshot.active.reduce((sum, v) => sum + v, 0) + sink.accretedCount !== count) invalid();
    s.active = Uint8Array.from(snapshot.active);
    for (const key of ['initialMomentum', 'initialCenterOfMass']) s[key] = Float64Array.from(snapshot[key]);
    for (const key of ['position', 'velocity', 'acceleration', 'angularMomentum']) s.sink[key] = Float64Array.from(sink[key]);
    return s;
}
