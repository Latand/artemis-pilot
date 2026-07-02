import { AU_KM, MU_E, MU_S, R_EARTH, R_SUN } from "../constants.js";
import { getSeed } from "./galaxy.js";
import { hashInts, makeRNG, splitSeed, gaussian, samplePoisson } from "./prng.js";
import {
    FORECASTER, PLANET_OCCURRENCE, PLANET_TYPE_COLOR,
    hzEdgesAU, massMeFromRadiusRe, occurrenceLambda,
} from "./astroConstants.js";
import { exoplanetSystemFor } from "./exoplanetHosts.js";

const TAU = Math.PI * 2;
export const SALT_COUNT = 1, SALT_ARCH = 2, SALT_PLANET = 3, SALT_MOON = 4, SALT_RING = 5;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const logUniform = (rng, lo, hi) => lo * Math.pow(hi / lo, rng());

export function stableStarKey(star) {
    if (star?.procedural && star.id) return "proc:" + star.id;
    if (star?.tier1) return "t1:" + star.tier1.tileId + ":" + star.tier1.idx;
    return "cat:" + (star?.hip ?? star?.hyg ?? star?.hygIndex ?? star?.name ?? "unknown");
}

export function systemSeed(star) {
    const key = stableStarKey(star);
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) >>> 0;
    return hashInts(getSeed(), h);
}

export function aFromPeriodDays(hostMassSolar, Pdays) {
    return Math.pow(Math.max(0.001, hostMassSolar) * Math.pow(Pdays / 365.25, 2), 1 / 3);
}

export function periodDaysFromA(hostMassSolar, aAU) {
    return 365.25 * Math.sqrt(Math.pow(aAU, 3) / Math.max(0.001, hostMassSolar));
}

export function planetFocusValue(index) { return "planet:" + index; }
export function planetFocusIndex(focus) {
    if (typeof focus !== "string") return -1;
    const m = focus.match(/^planet:(\d+)$/);
    const i = m ? Number(m[1]) : -1;
    return i >= 0 && i < 8 ? i : -1;
}
export function planetMoonFocusValue(planetIndex, moonIndex) { return "planet:" + planetIndex + ":moon:" + moonIndex; }
export function planetMoonFocusIndex(focus) {
    if (typeof focus !== "string") return null;
    const m = focus.match(/^planet:(\d+):moon:(\d+)$/);
    if (!m) return null;
    const planetIndex = Number(m[1]), moonIndex = Number(m[2]);
    return planetIndex >= 0 && planetIndex < 8 && moonIndex >= 0 && moonIndex < 6 ? { planetIndex, moonIndex } : null;
}

function hostFields(star) {
    const mass = Math.max(0, Number(star?.mass) || 0);
    const L = Math.max(0, Number(star?.lumSolar ?? star?.L) || 0);
    const Teff = Math.max(0, Number(star?.tempK ?? star?.Teff) || 0);
    const radiusSolar = Math.max(0.001, Number(star?.radiusSolar ?? (star?.R ? star.R / R_SUN : 1)) || 1);
    return { mass, L, Teff, radiusSolar, kind: star?.kind || "" };
}

function radiusMeToMassMe(radiusRe, type, rng) {
    if (type === "gas" || type === "hot-jupiter") return logUniform(rng, 50, 2000);
    return clamp(massMeFromRadiusRe(radiusRe), 0.03, 2000);
}

function planetType(radiusRe, a, hzInnerAU, hzOuterAU, hostL) {
    const inHZ = a >= hzInnerAU && a <= hzOuterAU;
    const Teq = 278 * Math.pow(Math.max(1e-6, hostL), 0.25) / Math.sqrt(Math.max(1e-6, a));
    if (radiusRe >= 6) return { type: "gas", inHZ, Teq };
    if (radiusRe >= 2) return { type: "sub-neptune", inHZ, Teq };
    if (inHZ && Teq >= 250 && Teq <= 320) return { type: "ocean", inHZ, Teq };
    if (Teq > 320) return { type: "desert", inHZ, Teq };
    if (Teq < 250) return { type: "ice", inHZ, Teq };
    return { type: "rocky", inHZ, Teq };
}

function finishPlanet(raw, k, host, hzInnerAU, hzOuterAU, rng, multi = true) {
    const typed = planetType(raw.radiusRe, raw.a, hzInnerAU, hzOuterAU, host.L);
    const type = raw.type || typed.type;
    const gas = type === "gas" || type === "hot-jupiter" || type === "sub-neptune";
    const massMe = raw.massMe || radiusMeToMassMe(raw.radiusRe, type, rng);
    const P = periodDaysFromA(host.mass, raw.a);
    const eSigma = (!multi && gas) ? 0.2 : 0.03;
    const e = clamp(eSigma * Math.sqrt(-2 * Math.log(Math.max(1e-12, 1 - rng()))), 0, 0.8);
    const inc = (1.5 * Math.PI / 180) * Math.sqrt(-2 * Math.log(Math.max(1e-12, 1 - rng())));
    const rotSec = raw.a < 0.05 ? P * 86400 : logUniform(rng, 6 * 3600, 48 * 3600);
    const atm = type === "ocean" ? { atmH: 8.5, atmTop: 120, atmD0: 1.0 } :
        type === "desert" || type === "ice" ? { atmH: 7, atmTop: 80, atmD0: 0.25 } :
            type === "sub-neptune" ? { atmH: 40, atmTop: 700, atmD0: 0.6 } :
                type === "gas" || type === "hot-jupiter" ? { atmH: 27, atmTop: 520, atmD0: 0.13 } :
                    { atmH: 0, atmTop: 0, atmD0: 0 };
    return {
        index: k, a: raw.a, e, i: inc, Om: rng() * TAU, varpi: rng() * TAU, M0: rng() * TAU,
        massMe, radiusKm: raw.radiusRe * R_EARTH, mu: massMe * MU_E, type, gas,
        inHZ: typed.inHZ, rotSec, tilt: gaussian(rng) * 25 * Math.PI / 180,
        color: PLANET_TYPE_COLOR[type], ...atm, real: false, moons: [], ring: null,
    };
}

function roman(n) {
    return ["I", "II", "III", "IV", "V", "VI"][n] || String(n + 1);
}

function moonOffsetRaw(m, t, out) {
    const n = Math.sqrt((m.orbitMu || m.mu) / (m.a * m.a * m.a));
    let M = (m.phase || 0) + n * t;
    M %= TAU;
    let E = M;
    for (let i = 0; i < 6; i++) E -= (E - m.e * Math.sin(E) - M) / (1 - m.e * Math.cos(E));
    const cE = Math.cos(E), sE = Math.sin(E);
    out.x = m.a * (cE - m.e);
    out.y = m.a * Math.sqrt(1 - m.e * m.e) * sE;
    out.z = 0;
    return out;
}

export function moonOffsetKm(moon, simT, out) {
    return moonOffsetRaw(moon, simT, out);
}

function populateMoonsAndRing(planet, host, hzOuterAU, seed) {
    const rngMoon = makeRNG(splitSeed(seed, SALT_MOON + planet.index));
    const rngRing = makeRNG(splitSeed(seed, SALT_RING + planet.index));
    planet.moons = [];
    planet.ring = null;
    const rHillAU = planet.a * Math.cbrt((planet.massMe * MU_E) / Math.max(1, 3 * host.mass * MU_S));
    const rHillKm = rHillAU * AU_KM;
    if (planet.massMe >= 0.5 && planet.a >= 0.1 && rHillKm > planet.radiusKm * 6.25) {
        let nMoons = 0;
        if (planet.type === "gas" || planet.type === "hot-jupiter") nMoons = Math.min(6, 2 + samplePoisson(rngMoon, 2));
        else if (planet.type === "sub-neptune") nMoons = Math.floor(rngMoon() * 3);
        else nMoons = Math.min(1, samplePoisson(rngMoon, 0.4));
        const loA = 2.5 * planet.radiusKm, hiA = Math.min(0.4 * rHillKm, 0.5 * rHillKm);
        if (hiA > loA) {
            for (let i = 0; i < nMoons; i++) {
                const R = clamp(logUniform(rngMoon, 0.002 * planet.radiusKm, 0.05 * planet.radiusKm), 100, 2600);
                const massMoonMe = Math.pow(R / R_EARTH, 3) * 0.6;
                const a = logUniform(rngMoon, loA, hiA);
                const e = clamp(0.005 * Math.sqrt(-2 * Math.log(Math.max(1e-12, 1 - rngMoon()))), 0, 0.08);
                planet.moons.push({
                    name: (planet.name || ("P" + (planet.index + 1))) + " " + roman(i),
                    a, e, R, phase: rngMoon() * TAU,
                    color: planet.a > hzOuterAU ? 0xd6e2ec : 0x9a938a,
                    mu: Math.max(1, massMoonMe * MU_E), orbitMu: planet.mu,
                });
            }
        }
    }
    const ringType = planet.type === "gas" || planet.type === "hot-jupiter" || planet.type === "sub-neptune";
    const gasGiant = planet.type === "gas" || planet.type === "hot-jupiter";
    if (ringType && (planet.a > 1.5 * hzOuterAU || (gasGiant && rngRing() < 0.08))) {
        planet.ring = [1.2 * planet.radiusKm, (1.8 + rngRing() * 0.9) * planet.radiusKm];
        planet.ring.opacity = 0.35 + rngRing() * 0.35;
        planet.ring.tilt = planet.tilt + (rngRing() - 0.5) * 0.18;
    }
}

function radiusValley(radiusRe, rng) {
    if (radiusRe >= 1.5 && radiusRe <= 2.0) return rng() < 0.5 ? 1.3 : 2.4;
    return radiusRe;
}

export function generateSystem(star) {
    const host = hostFields(star);
    const hz = hzEdgesAU(host.L);
    const base = { starId: stableStarKey(star), hostMass: host.mass, hostL: host.L, hostTeff: host.Teff, hostKind: host.kind, hzInnerAU: hz.inner, hzOuterAU: hz.outer, planets: [] };
    if (host.kind === "BH" || host.kind === "NS" || !(host.mass > 0)) return base;
    const seed = systemSeed(star);
    const rngCount = makeRNG(splitSeed(seed, SALT_COUNT));
    const rngArch = makeRNG(splitSeed(seed, SALT_ARCH));
    const rng = makeRNG(splitSeed(seed, SALT_PLANET));
    if (host.kind === "WD" && rngCount() >= PLANET_OCCURRENCE.wdSystemFrac) return base;
    let nCore = host.mass < 0.08 ? (rngCount() < 0.25 ? 1 : 0) : Math.min(7, samplePoisson(rngCount, occurrenceLambda(host.mass)));
    if (host.kind === "WD") nCore = Math.min(nCore, 2);
    const raw = [];
    if (nCore > 0) {
        let P = logUniform(rngArch, 1.5, 12);
        const rChar = clamp(2.0 * Math.pow(10, 0.4 * gaussian(rngArch)), 0.5, 14);
        for (let k = 0; k < nCore; k++) {
            if (k > 0) {
                let ratio = 1.3 + rngArch() * 1.4;
                if ((ratio >= 1.98 && ratio <= 2.02) || (ratio >= 1.48 && ratio <= 1.52)) ratio += 0.03;
                P *= ratio;
            }
            const r = clamp(radiusValley(rChar * (1 + 0.15 * gaussian(rngArch)), rng), 0.5, 14);
            raw.push({ a: aFromPeriodDays(host.mass, P), radiusRe: r });
        }
    }
    const hjProb = host.mass < 0.6 ? PLANET_OCCURRENCE.hotJupiterM : host.mass < 1.4 ? PLANET_OCCURRENCE.hotJupiterFGK : 0;
    if (hjProb > 0 && rng() < hjProb) raw.push({ a: logUniform(rng, 0.02, 0.06), radiusRe: 11 + rng() * 2, type: "hot-jupiter", massMe: logUniform(rng, 50, 2000) });
    const pGiant = clamp(PLANET_OCCURRENCE.giantBase * host.mass * Math.pow(10, PLANET_OCCURRENCE.giantFehPower * (star?.feh ?? 0)), 0, PLANET_OCCURRENCE.giantMax);
    if (host.mass >= 0.08 && rng() < pGiant) {
        raw.push({ a: logUniform(rng, Math.max(3, 1.5 * hz.outer), Math.max(15, 6 * hz.outer)), radiusRe: 9 + rng() * 3, type: "gas", massMe: logUniform(rng, 50, 2000) });
    }
    let minA = 0, maxA = Infinity;
    if (host.kind === "giant") minA = 1.5 * host.radiusSolar * R_SUN / AU_KM;
    if (star?.companionOf || star?.companionData) maxA = Math.max(0, 0.3 * (star.separationPc ?? star.companionData?.separationPc ?? 0) * 206265);
    base.planets = raw
        .filter(p => p.a > minA && p.a < maxA && Number.isFinite(p.a))
        .sort((a, b) => a.a - b.a)
        .slice(0, 8)
        .map((p, i, arr) => finishPlanet(p, i, host, hz.inner, hz.outer, rng, arr.length > 1));
    const real = exoplanetSystemFor(star);
    if (real?.planets?.length) {
        const planets = real.planets.slice();
        for (const p of base.planets) {
            if (planets.length >= 9) break;
            const overlaps = planets.some(rp => Math.abs(p.a - rp.a) / Math.max(rp.a, 1e-9) <= 0.25);
            if (!overlaps) planets.push(p);
        }
        planets.sort((a, b) => a.a - b.a).splice(9);
        for (let i = 0; i < planets.length; i++) {
            const p = planets[i];
            const typed = planetType(p.radiusKm / R_EARTH, p.a, hz.inner, hz.outer, host.L);
            p.index = i;
            p.inHZ = typed.inHZ;
        }
        base.planets = planets;
    }
    for (const p of base.planets) populateMoonsAndRing(p, host, hz.outer, seed);
    return base;
}

export function planetOffsetKm(planet, hostMassSolar, simT, out) {
    const aKm = planet.a * AU_KM;
    const n = Math.sqrt(MU_S * hostMassSolar / (aKm * aKm * aKm));
    let M = planet.M0 + n * simT;
    M %= TAU;
    let E = M;
    for (let j = 0; j < 7; j++) E -= (E - planet.e * Math.sin(E) - M) / (1 - planet.e * Math.cos(E));
    const cE = Math.cos(E), sE = Math.sin(E);
    const x = aKm * (cE - planet.e);
    const y = aKm * Math.sqrt(1 - planet.e * planet.e) * sE;
    const cw = Math.cos(planet.varpi - planet.Om), sw = Math.sin(planet.varpi - planet.Om);
    const x1 = x * cw - y * sw, y1 = x * sw + y * cw;
    const ci = Math.cos(planet.i), si = Math.sin(planet.i), cO = Math.cos(planet.Om), sO = Math.sin(planet.Om);
    out.x = x1 * cO - y1 * ci * sO;
    out.y = x1 * sO + y1 * ci * cO;
    out.z = y1 * si;
    return out;
}

const _worldPrev = { x: 0, y: 0, z: 0 };
const _worldNext = { x: 0, y: 0, z: 0 };
export function planetWorldState(system, planetIndex, hostStar, simT, out) {
    const p = system?.planets?.[planetIndex];
    if (!p || !hostStar) return null;
    planetOffsetKm(p, system.hostMass || hostStar.mass || 1, simT, out);
    const h = 0.5;
    planetOffsetKm(p, system.hostMass || hostStar.mass || 1, simT - h, _worldPrev);
    planetOffsetKm(p, system.hostMass || hostStar.mass || 1, simT + h, _worldNext);
    out.vx = (hostStar.vx || 0) + (_worldNext.x - _worldPrev.x) / (2 * h);
    out.vy = (hostStar.vy || 0) + (_worldNext.y - _worldPrev.y) / (2 * h);
    out.vz = (hostStar.vz || 0) + (_worldNext.z - _worldPrev.z) / (2 * h);
    out.x += hostStar.x || 0;
    out.y += hostStar.y || 0;
    out.z += hostStar.z || 0;
    return out;
}

const _moonParent = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const _moonOffPrev = { x: 0, y: 0, z: 0 };
const _moonOffNext = { x: 0, y: 0, z: 0 };
export function moonWorldState(system, planetIndex, moonIndex, hostStar, simT, out) {
    const moon = system?.planets?.[planetIndex]?.moons?.[moonIndex];
    if (!moon || !planetWorldState(system, planetIndex, hostStar, simT, _moonParent)) return null;
    const h = 0.5;
    moonOffsetKm(moon, simT - h, _moonOffPrev);
    moonOffsetKm(moon, simT + h, _moonOffNext);
    moonOffsetKm(moon, simT, out);
    out.vx = _moonParent.vx + (_moonOffNext.x - _moonOffPrev.x) / (2 * h);
    out.vy = _moonParent.vy + (_moonOffNext.y - _moonOffPrev.y) / (2 * h);
    out.vz = _moonParent.vz + (_moonOffNext.z - _moonOffPrev.z) / (2 * h);
    out.x += _moonParent.x;
    out.y += _moonParent.y;
    out.z += _moonParent.z;
    return out;
}

const _domPlanetState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
const _domMoonState = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
export function dominantSystemBody(sys, hostStar, shipWorld, simT) {
    if (!sys?.planets?.length || !hostStar || !shipWorld) return null;
    let best = null;
    for (const p of sys.planets) {
        planetWorldState(sys, p.index, hostStar, simT, _domPlanetState);
        const d = Math.hypot(shipWorld.x - _domPlanetState.x, shipWorld.y - _domPlanetState.y, shipWorld.z - _domPlanetState.z);
        const soi = Math.max(p.radiusKm * 3, p.a * AU_KM * Math.pow(p.mu / Math.max(1, hostStar.mu || MU_S), 0.4));
        const acc = p.mu / Math.max(1, d * d);
        if (d < soi && (!best || acc > best.acc)) {
            best = { planet: p, index: p.index, d, soi, acc, dominant: true };
            for (let i = 0; i < (p.moons?.length || 0); i++) {
                const m = p.moons[i];
                moonWorldState(sys, p.index, i, hostStar, simT, _domMoonState);
                const dm = Math.hypot(shipWorld.x - _domMoonState.x, shipWorld.y - _domMoonState.y, shipWorld.z - _domMoonState.z);
                const soiMoon = Math.max(3 * m.R, m.a * Math.pow(m.mu / Math.max(1, p.mu), 0.4));
                if (dm < soiMoon) {
                    const accMoon = m.mu / Math.max(1, dm * dm);
                    best = { planet: p, index: p.index, moon: m, moonIndex: i, d: dm, soi: soiMoon, acc: accMoon, dominant: true };
                }
            }
        }
    }
    return best;
}

export function dominantSystemPlanet(sys, hostStar, shipWorld, simT) {
    const b = dominantSystemBody(sys, hostStar, shipWorld, simT);
    return b?.moon ? { ...b, moon: undefined, moonIndex: undefined } : b;
}
