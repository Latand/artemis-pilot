// Physical facts for the focused body, assembled for the Explore panel.
//
// Every number here is read from a record the simulation already carries —
// the J2000 ephemeris, the PL table, the STARS catalogue, the live black-hole
// arrays, the Sun's evolution model. Nothing is invented and nothing is
// filled in with a plausible default: a quantity the record does not carry is
// simply omitted, so an absent row means "this build does not know", never
// "this is zero". Each body also reports which epistemic tier its numbers
// come from, using the vocabulary in epistemic.js.
//
// Earth's and the planets' Sun distance and orbital speed are read from the
// live n-body state. Since issue #6 that state starts from JPL's J2000 mean
// orbital elements at the current epoch (planetElements.js), so the values
// match the reference to ~0.5% near the present; the copy says where they
// come from and that they evolve with the simulation.
import { R_SUN, AU_KM, G_SI, PL } from "../constants.js";
import { eph } from "../ephemeris.js";
import { fmtDist } from "../format.js";
import { EPISTEMIC_TIERS } from "./epistemic.js";

const finite = v => Number.isFinite(v) && v !== 0;

// mu is a standard gravitational parameter in km^3/s^2; G_SI is in m^3/(kg s^2).
export function massKgFromMu(mu) {
    return finite(mu) ? mu * 1e9 / G_SI : null;
}

// Surface gravity from the same mu and the body's mean radius, in m/s^2.
export function surfaceGravity(mu, radiusKm) {
    return finite(mu) && finite(radiusKm) ? mu / (radiusKm * radiusKm) * 1000 : null;
}

function fmtKg(kg) {
    const e = Math.floor(Math.log10(Math.abs(kg)));
    return (kg / Math.pow(10, e)).toFixed(2) + "e" + e + " kg";
}

const fmtAu = km => (km / AU_KM).toFixed(3) + " AU";
const fmtRsun = km => (km / R_SUN).toFixed(2) + " R☉";

// Heliocentric geometry. The world frame is Earth-centred, so the Sun's
// stored position already is Earth's Sun-vector, and a planet's Sun-distance
// is its stored position measured against it.
const sunDistanceKm = (x, y, z) => Math.hypot(x - eph.sunX, y - eph.sunY, (z || 0) - eph.sunZ);
const sunRelativeSpeed = (vx, vy, vz) => Math.hypot(vx - eph.sunVx, vy - eph.sunVy, (vz || 0) - eph.sunVz);

function push(rows, label, value) {
    if (value !== null && value !== undefined && value !== "") rows.push({ label, value });
}

function massAndGravity(rows, mu, radiusKm) {
    const kg = massKgFromMu(mu);
    if (kg !== null) push(rows, "Mass", fmtKg(kg));
    const g = surfaceGravity(mu, radiusKm);
    if (g !== null) push(rows, "Surface gravity", g.toFixed(2) + " m/s²");
}

function starRows(rows, star) {
    if (star.spect) push(rows, "Spectral type", String(star.spect));
    if (finite(star.mass)) push(rows, "Mass", star.mass.toFixed(star.mass < 10 ? 3 : 1) + " M☉");
    if (finite(star.tempK)) push(rows, "Effective temperature", Math.round(star.tempK).toLocaleString("en-US") + " K");
    if (finite(star.lumSolar)) {
        push(rows, "Luminosity", (star.lumSolar >= 100 ? Math.round(star.lumSolar).toLocaleString("en-US")
            : star.lumSolar.toFixed(3)) + " L☉");
    }
    if (finite(star.dLy)) push(rows, "Distance from the Sun", star.dLy.toFixed(2) + " ly");
}

// body is the record built by explorerUI.selectedBody(); the optional raw
// fields it carries decide which rows can honestly be shown.
export function bodyFactRows(body) {
    const rows = [];
    if (!body) return rows;
    if (finite(body.R)) {
        push(rows, "Radius", body.star || body.sun
            ? fmtDist(body.R) + " · " + fmtRsun(body.R)
            : fmtDist(body.R));
    }

    if (body.sun) {
        const s = body.sun;
        if (finite(s.Teff)) push(rows, "Effective temperature", Math.round(s.Teff).toLocaleString("en-US") + " K");
        if (finite(s.L_Lsun)) push(rows, "Luminosity", (s.L_Lsun < 10 ? s.L_Lsun.toFixed(3) : Math.round(s.L_Lsun).toLocaleString("en-US")) + " L☉");
        if (finite(s.massLoss)) push(rows, "Mass", s.massLoss.toFixed(3) + " M☉");
    } else if (body.star) {
        starRows(rows, body.star);
    } else if (body.bhMass) {
        push(rows, "Mass", body.bhMass);
        if (finite(body.rs)) push(rows, "Schwarzschild radius", fmtDist(body.rs));
    } else {
        massAndGravity(rows, body.mu, body.R);
    }

    if (body.focusKey === "earth") {
        push(rows, "Sun distance", fmtAu(Math.hypot(eph.sunX, eph.sunY, eph.sunZ)));
        push(rows, "Orbital speed", sunRelativeSpeed(0, 0, 0) /* Earth-relative frame: Earth is at rest */.toFixed(2) + " km/s");
    } else if (body.focusKey === "moon") {
        push(rows, "Distance from Earth", fmtDist(Math.hypot(eph.moonX, eph.moonY, eph.moonZ)));
    } else if (hasSimulatedOrbit(body)) {
        const i = body.planetIndex;
        push(rows, "Sun distance", fmtAu(sunDistanceKm(eph.plX[i], eph.plY[i], eph.plZ[i])));
        push(rows, "Orbital speed", sunRelativeSpeed(eph.plVx[i], eph.plVy[i], eph.plVz[i]).toFixed(2) + " km/s");
    }

    const tier = EPISTEMIC_TIERS[body.basis];
    if (tier) push(rows, "Basis", tier.label);
    return rows;
}

const hasSimulatedOrbit = body => body?.focusKey === "earth" ||
    (Number.isInteger(body?.planetIndex) && !!PL[body.planetIndex]);

// Say exactly where the orbital rows come from: measured physical constants,
// plus a live simulation seeded from published mean elements.
const SIMULATED_ORBIT_BASIS = "Radius, mass and surface gravity are measured. Sun distance and orbital speed come from the live n-body simulation, started from JPL's J2000 mean orbital elements for today's date (within about 0.5% of the reference near the present); they evolve with the simulation.";

export function basisDescription(body) {
    if (hasSimulatedOrbit(body)) return SIMULATED_ORBIT_BASIS;
    return EPISTEMIC_TIERS[body?.basis]?.description || "";
}
