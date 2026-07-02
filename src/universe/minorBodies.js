import { AU_KM, MU_S, PL } from "../constants.js";
import { gaussian, makeRNG, samplePoisson, splitSeed } from "./prng.js";

const TAU = Math.PI * 2;
const DAY_S = 86400;
const J2000_JD = 2451545.0;

export const MINOR_STRIDE = 6;
export const OORT_AU_MIN = 2000;
export const OORT_AU_MAX = 100000;
export const KIRKWOOD_GAPS_AU = Object.freeze([2.502, 2.825, 2.958, 3.279]);

const BELT_COUNT = 20000;
const KUIPER_CLASSICAL_COUNT = 8000;
const KUIPER_RESONANT_COUNT = 2000;
const OORT_COUNT = 4000;

function salt32(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

function rngFor(seed, salt) {
    return makeRNG(splitSeed(seed >>> 0, salt32(salt)));
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function uniform(rng, lo, hi) {
    return lo + (hi - lo) * rng();
}

function fillElements(arr, idx, aAu, e, inc, om, varpi, m0) {
    const off = idx * MINOR_STRIDE;
    arr[off] = aAu * AU_KM;
    arr[off + 1] = e;
    arr[off + 2] = inc;
    arr[off + 3] = om;
    arr[off + 4] = varpi;
    arr[off + 5] = m0;
}

function kirkwoodSurvival(rng, aAu) {
    for (const gap of KIRKWOOD_GAPS_AU) {
        const x = (aAu - gap) / 0.015;
        if (rng() < Math.exp(-(x * x))) return false;
    }
    return true;
}

function sampleBelt(seed) {
    const rng = rngFor(seed, "belt");
    const out = new Float64Array(BELT_COUNT * MINOR_STRIDE);
    let n = 0;
    while (n < BELT_COUNT) {
        const aAu = uniform(rng, 2.06, 3.28);
        if (!kirkwoodSurvival(rng, aAu)) continue;
        fillElements(
            out,
            n++,
            aAu,
            clamp(Math.abs(gaussian(rng)) * 0.07, 0, 0.35),
            Math.abs(gaussian(rng)) * 0.13,
            rng() * TAU,
            rng() * TAU,
            rng() * TAU,
        );
    }
    return out;
}

function sampleKuiper(seed) {
    const classical = rngFor(seed, "kbo");
    const resonant = rngFor(seed, "plutino");
    const out = new Float64Array((KUIPER_CLASSICAL_COUNT + KUIPER_RESONANT_COUNT) * MINOR_STRIDE);
    let n = 0;
    for (; n < KUIPER_CLASSICAL_COUNT; n++) {
        fillElements(
            out,
            n,
            uniform(classical, 42, 48),
            clamp(Math.abs(gaussian(classical)) * 0.05, 0, 0.35),
            Math.abs(gaussian(classical)) * 0.09,
            classical() * TAU,
            classical() * TAU,
            classical() * TAU,
        );
    }
    for (let j = 0; j < KUIPER_RESONANT_COUNT; j++, n++) {
        const twotino = j & 1;
        const center = twotino ? 47.8 : 39.4;
        fillElements(
            out,
            n,
            center + gaussian(resonant) * 0.18,
            clamp(Math.abs(gaussian(resonant)) * 0.15, 0, 0.65),
            Math.abs(gaussian(resonant)) * 0.12,
            resonant() * TAU,
            resonant() * TAU,
            resonant() * TAU,
        );
    }
    return out;
}

function sampleOort(seed) {
    const rng = rngFor(seed, "oort");
    const out = new Float64Array(OORT_COUNT * MINOR_STRIDE);
    const lo = Math.log(OORT_AU_MIN), hi = Math.log(OORT_AU_MAX);
    for (let n = 0; n < OORT_COUNT; n++) {
        const rAu = Math.exp(uniform(rng, lo, hi));
        const z = uniform(rng, -1, 1);
        const phi = rng() * TAU;
        const inc = Math.acos(z);
        const om = phi;
        fillElements(out, n, rAu, 0.99 + rng() * 0.008, inc, om, rng() * TAU, rng() * TAU);
    }
    return out;
}

function jdUtc(year, month, day) {
    const a = Math.floor((14 - month) / 12);
    const y = year + 4800 - a;
    const m = month + 12 * a - 3;
    return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

function m0FromPerihelion(aAu, year, month, day) {
    const dt = (jdUtc(year, month, day) - J2000_JD) * DAY_S;
    const n = Math.sqrt(MU_S / ((aAu * AU_KM) ** 3));
    return n * dt;
}

const DEG = Math.PI / 180;
function curated(body, aAu, e, iDeg, omDeg, varpiDeg, m0Deg, extra = {}) {
    return Object.freeze({
        body,
        name: body,
        a: aAu * AU_KM,
        aAu,
        e,
        i: iDeg * DEG,
        Om: omDeg * DEG,
        varpi: varpiDeg * DEG,
        M0: m0Deg * DEG,
        ...extra,
    });
}

export const CURATED_MINOR_BODIES = Object.freeze([
    curated("Ceres", 2.7658, 0.0785, 10.59, 80.33, 73.60, 95.99, { class: "asteroid" }),
    curated("Vesta", 2.3617, 0.0887, 7.14, 103.81, 151.20, 20.86, { class: "asteroid" }),
    curated("Pallas", 2.7727, 0.2299, 34.84, 173.10, 310.05, 40.61, { class: "asteroid" }),
    curated("1P/Halley", 17.834, 0.9671, 162.26, 58.42, 111.33, m0FromPerihelion(17.834, 1986, 2, 9) / DEG, { class: "comet", perihelion: "1986-02-09" }),
    curated("Hale-Bopp", 186.0, 0.9951, 89.43, 282.47, 130.6, m0FromPerihelion(186.0, 1997, 4, 1) / DEG, { class: "comet", perihelion: "1997-04-01" }),
]);

export function curatedElementsArray() {
    const out = new Float64Array(CURATED_MINOR_BODIES.length * MINOR_STRIDE);
    for (let i = 0; i < CURATED_MINOR_BODIES.length; i++) {
        const b = CURATED_MINOR_BODIES[i];
        const off = i * MINOR_STRIDE;
        out[off] = b.a;
        out[off + 1] = b.e;
        out[off + 2] = b.i;
        out[off + 3] = b.Om;
        out[off + 4] = b.varpi;
        out[off + 5] = b.M0;
    }
    return out;
}

export function generateSwarms(seed) {
    samplePoisson(rngFor(seed, "meta"), 0.001);
    const belt = sampleBelt(seed);
    const kuiper = sampleKuiper(seed);
    const oort = sampleOort(seed);
    return Object.freeze({
        belt,
        kuiper,
        oort,
        curated: curatedElementsArray(),
        meta: Object.freeze({
            seed: seed >>> 0,
            stride: MINOR_STRIDE,
            counts: Object.freeze({
                belt: belt.length / MINOR_STRIDE,
                kuiper: kuiper.length / MINOR_STRIDE,
                oort: oort.length / MINOR_STRIDE,
                curated: CURATED_MINOR_BODIES.length,
            }),
            kirkwoodGapsAu: KIRKWOOD_GAPS_AU,
        }),
    });
}

const _state = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const _planar = { x: 0, y: 0, vx: 0, vy: 0 };

function keplerInitLocal(a, e, varpi, m0, mu, out) {
    let E = m0;
    for (let i = 0; i < 12; i++) {
        E -= (E - e * Math.sin(E) - m0) / (1 - e * Math.cos(E));
    }
    const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    const r = a * (1 - e * Math.cos(E));
    const c = Math.sqrt(mu / (a * (1 - e * e)));
    const vr = c * e * Math.sin(nu);
    const vt = c * (1 + e * Math.cos(nu));
    const th = varpi + nu;
    const ct = Math.cos(th), st = Math.sin(th);
    out.x = r * ct;
    out.y = r * st;
    out.vx = vr * ct - vt * st;
    out.vy = vr * st + vt * ct;
    return out;
}

function keplerInit3Local(a, e, inc, om, varpi, m0, mu, out) {
    keplerInitLocal(a, e, varpi - om, m0, mu, _planar);
    const ci = Math.cos(inc), si = Math.sin(inc);
    const cO = Math.cos(om), sO = Math.sin(om);
    const y1 = _planar.y * ci, z1 = _planar.y * si;
    const vy1 = _planar.vy * ci, vz1 = _planar.vy * si;
    const x1 = _planar.x, vx1 = _planar.vx;
    out.x = x1 * cO - y1 * sO;
    out.y = x1 * sO + y1 * cO;
    out.z = z1;
    out.vx = vx1 * cO - vy1 * sO;
    out.vy = vx1 * sO + vy1 * cO;
    out.vz = vz1;
    return out;
}

export function propagateInto(swarm, simT, outWorldKmFloat64, sunWorld = [0, 0, 0], startIdx = 0, count = Infinity, result = null) {
    const n = Math.floor(swarm.length / MINOR_STRIDE);
    const start = clamp(startIdx | 0, 0, n);
    const span = Number.isFinite(count) ? Math.max(0, count | 0) : n - start;
    const end = Math.min(n, start + span);
    for (let i = start; i < end; i++) {
        const off = i * MINOR_STRIDE;
        const a = swarm[off];
        const e = swarm[off + 1];
        const mean = swarm[off + 5] + Math.sqrt(MU_S / (a * a * a)) * simT;
        keplerInit3Local(a, e, swarm[off + 2], swarm[off + 3], swarm[off + 4], mean, MU_S, _state);
        const j = i * 3;
        outWorldKmFloat64[j] = _state.x + sunWorld[0];
        outWorldKmFloat64[j + 1] = _state.y + sunWorld[1];
        outWorldKmFloat64[j + 2] = _state.z + sunWorld[2];
    }
    const out = result || {};
    out.start = start;
    out.count = end - start;
    out.nextIdx = end >= n ? 0 : end;
    return out;
}

export function propagateOne(elementArray, idx, simT, sunWorld = [0, 0, 0], out = {}) {
    const off = idx * MINOR_STRIDE;
    const a = elementArray[off];
    const mean = elementArray[off + 5] + Math.sqrt(MU_S / (a * a * a)) * simT;
    keplerInit3Local(a, elementArray[off + 1], elementArray[off + 2], elementArray[off + 3], elementArray[off + 4], mean, MU_S, out);
    out.x += sunWorld[0];
    out.y += sunWorld[1];
    out.z += sunWorld[2];
    return out;
}
