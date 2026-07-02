import { R_EARTH, MU_E } from "../constants.js";
import { PLANET_TYPE_COLOR, hzEdgesAU, massMeFromRadiusRe } from "./astroConstants.js";
import { getSeed } from "./galaxy.js";
import { hashInts, makeRNG, splitSeed } from "./prng.js";

const TAU = Math.PI * 2;
const SALT_PLANET = 3;
let hostsById = new Map();
let warned = false;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function stableKeyForSeed(star) {
    if (star?.procedural && star.id) return "proc:" + star.id;
    if (star?.tier1) return "t1:" + star.tier1.tileId + ":" + star.tier1.idx;
    return "cat:" + (star?.hip ?? star?.hyg ?? star?.hygIndex ?? star?.name ?? "unknown");
}

function systemSeedFor(star) {
    const key = stableKeyForSeed(star);
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
    return hashInts(getSeed(), h);
}

function hostMass(star) {
    return Math.max(0.001, Number(star?.mass) || 1);
}

function hostLum(star) {
    return Math.max(0, Number(star?.lumSolar ?? star?.L) || 0);
}

function massFromRadius(radiusRe, type) {
    if (type === "gas" || type === "hot-jupiter") return clamp(massMeFromRadiusRe(Math.max(4, radiusRe)), 10, 2000);
    return clamp(massMeFromRadiusRe(radiusRe), 0.03, 2000);
}

function radiusFromMass(massMe) {
    const m = Math.max(0.03, massMe);
    if (m < 2.04) return 1.008 * Math.pow(m, 0.279);
    if (m < 130) return 0.80811 * Math.pow(m, 0.589);
    return clamp(11.2 * Math.pow(m / 317.8, -0.044), 6, 16);
}

function aFromPeriod(hostMassSolar, periodDays) {
    return Math.pow(Math.max(0.001, hostMassSolar) * Math.pow(periodDays / 365.25, 2), 1 / 3);
}

function periodFromA(hostMassSolar, aAU) {
    return 365.25 * Math.sqrt(Math.pow(aAU, 3) / Math.max(0.001, hostMassSolar));
}

function planetType(radiusRe, a, hzInnerAU, hzOuterAU, L) {
    const inHZ = a >= hzInnerAU && a <= hzOuterAU;
    const Teq = 278 * Math.pow(Math.max(1e-6, L), 0.25) / Math.sqrt(Math.max(1e-6, a));
    if (radiusRe >= 6) return { type: "gas", inHZ, Teq };
    if (radiusRe >= 2) return { type: "sub-neptune", inHZ, Teq };
    if (inHZ && Teq >= 250 && Teq <= 320) return { type: "ocean", inHZ, Teq };
    if (Teq > 320) return { type: "desert", inHZ, Teq };
    if (Teq < 250) return { type: "ice", inHZ, Teq };
    return { type: "rocky", inHZ, Teq };
}

function atmosphere(type) {
    if (type === "ocean") return { atmH: 8.5, atmTop: 120, atmD0: 1.0 };
    if (type === "desert" || type === "ice") return { atmH: 7, atmTop: 80, atmD0: 0.25 };
    if (type === "sub-neptune") return { atmH: 40, atmTop: 700, atmD0: 0.6 };
    if (type === "gas" || type === "hot-jupiter") return { atmH: 27, atmTop: 520, atmD0: 0.13 };
    return { atmH: 0, atmTop: 0, atmD0: 0 };
}

function lookupKeys(star) {
    const keys = [];
    if (star?.hip != null) keys.push("cat:HIP" + star.hip);
    if (star?.hd != null) keys.push("cat:HD" + star.hd);
    if (star?.name) keys.push("cat:" + star.name);
    return keys;
}

function normalizeHosts(data) {
    const next = new Map();
    for (const [key, host] of Object.entries(data?.hosts || {})) {
        if (host?.planets?.length) next.set(key, host);
    }
    hostsById = next;
    warned = false;
    return hostsById;
}

export async function initExoplanets(url = "/data/exoplanets.json") {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        return normalizeHosts(await res.json());
    } catch (err) {
        hostsById = new Map();
        if (!warned) {
            warned = true;
            console.warn("exoplanets: overlay unavailable:", err?.message || err);
        }
        return hostsById;
    }
}

export function setExoplanetTableForTest(data) {
    return normalizeHosts(data);
}

export function clearExoplanetTableForTest() {
    hostsById = new Map();
    warned = false;
}

export function exoplanetSystemFor(star) {
    let host = null;
    for (const key of lookupKeys(star)) {
        host = hostsById.get(key);
        if (host) break;
    }
    if (!host) return null;
    const mass = hostMass(star);
    const L = hostLum(star);
    const hz = hzEdgesAU(L);
    const rng = makeRNG(splitSeed(systemSeedFor(star), SALT_PLANET));
    const planets = [];
    for (const row of host.planets || []) {
        const periodDays = Number(row.periodDays) > 0 ? Number(row.periodDays) : null;
        const a = Number(row.aAU) > 0 ? Number(row.aAU) : (periodDays ? aFromPeriod(mass, periodDays) : null);
        if (!(a > 0) || !Number.isFinite(a)) continue;
        const radiusRe = Number(row.radiusMe) > 0 ? Number(row.radiusMe) :
            (Number(row.massMe) > 0 ? radiusFromMass(Number(row.massMe)) : 1);
        const typed = planetType(radiusRe, a, hz.inner, hz.outer, L);
        const type = typed.type;
        const massMe = Number(row.massMe) > 0 ? Number(row.massMe) : massFromRadius(radiusRe, type);
        const e = clamp(Number(row.e) || 0, 0, 0.95);
        const P = periodDays || periodFromA(mass, a);
        const i = Number(row.inclDeg) > 0 ? Number(row.inclDeg) * Math.PI / 180 : 0;
        const rotSec = a < 0.05 ? P * 86400 : 24 * 3600;
        const gas = type === "gas" || type === "hot-jupiter" || type === "sub-neptune";
        planets.push({
            index: planets.length,
            letter: row.letter || null,
            name: host.hostname + (row.letter ? " " + row.letter : ""),
            a, e, i, Om: rng() * TAU, varpi: rng() * TAU, M0: rng() * TAU,
            massMe, radiusKm: radiusRe * R_EARTH, mu: massMe * MU_E, type, gas,
            inHZ: typed.inHZ, rotSec, tilt: 0, color: PLANET_TYPE_COLOR[type],
            ...atmosphere(type), real: true, moons: [], ring: null,
        });
    }
    planets.sort((a, b) => a.a - b.a);
    planets.forEach((planet, index) => { planet.index = index; });
    return planets.length ? { host, planets } : null;
}
