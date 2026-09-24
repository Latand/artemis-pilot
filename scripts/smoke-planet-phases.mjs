// Issue #6 acceptance: Earth and every planet start where they really are.
//
// For three epochs (J2000.0, 2026-09-13, 2045-01-01) resetEphem() must place
// each body within 0.5% of the JPL "Keplerian Elements for Approximate
// Positions of the Major Planets" (Standish, Table 1) heliocentric distance
// and speed, and each planet's direction AS SEEN FROM EARTH (geocentric
// ecliptic longitude) within 1 degree of the reference. The reference is
// evaluated independently here from the published table values (not from
// the module under test), so a wrong table entry in planetElements.js would
// fail this check. Also verifies the world-frame contract: the real sky and
// the Solar System share the J2000 ecliptic (Regulus sits 0.46 deg from the
// ecliptic, the Sun's apparent path runs through the zodiac).
//
// Run: node scripts/smoke-planet-phases.mjs
globalThis.window = globalThis.window || { addEventListener() { } };
const { setEpochMs, secondsSinceJ2000, J2000_MS } = await import("../src/epoch.js");
const { eph, resetEphem } = await import("../src/ephemeris.js");
const { PL, AU_KM, MU_S, STARS } = await import("../src/constants.js");

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log("FAIL", msg); } else console.log("PASS", msg); };
const DEG = Math.PI / 180;

// Standish Table 1 (J2000, valid 1800-2050), transcribed independently.
const TABLE = {
    MERCURY: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
    VENUS: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255], [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
    EMB: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
    MARS: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
    JUPITER: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
    SATURN: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
    URANUS: [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503], [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
    NEPTUNE: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
};
function reference(name, T) {
    const [e0, r] = TABLE[name];
    const el = e0.map((v, i) => v + r[i] * T);
    const [aAu, e, I, L, w, O] = el;
    let M = ((L - w) % 360 + 540) % 360 - 180;
    M *= DEG;
    let E = M;
    for (let k = 0; k < 30; k++) E = M + e * Math.sin(E);
    const a = aAu * AU_KM;
    const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const ww = (w - O) * DEG, OO = O * DEG, II = I * DEG;
    const x = (Math.cos(ww) * Math.cos(OO) - Math.sin(ww) * Math.sin(OO) * Math.cos(II)) * xp + (-Math.sin(ww) * Math.cos(OO) - Math.cos(ww) * Math.sin(OO) * Math.cos(II)) * yp;
    const y = (Math.cos(ww) * Math.sin(OO) + Math.sin(ww) * Math.cos(OO) * Math.cos(II)) * xp + (-Math.sin(ww) * Math.sin(OO) + Math.cos(ww) * Math.cos(OO) * Math.cos(II)) * yp;
    const z = Math.sin(ww) * Math.sin(II) * xp + Math.cos(ww) * Math.sin(II) * yp;
    const rr = a * (1 - e * Math.cos(E));
    return { x, y, z, r: rr, v: Math.sqrt(MU_S * (2 / rr - 1 / a)) };
}
const lonDeg = (x, y) => Math.atan2(y, x) / DEG;
const dLon = (a, b) => { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return Math.abs(d); };

const EPOCHS = [
    ["J2000.0", J2000_MS],
    ["2026-09-13", Date.UTC(2026, 8, 13, 0, 0, 0)],
    ["2045-01-01", Date.UTC(2045, 0, 1, 0, 0, 0)],
];
for (const [label, ms] of EPOCHS) {
    setEpochMs(ms);
    resetEphem();
    const T = secondsSinceJ2000(ms) / (36525 * 86400);
    // Earth: heliocentric = -(Earth-relative Sun). Compare with the EMB
    // (Earth sits ~4,700 km from the barycentre; far below the tolerance).
    const earthRef = reference("EMB", T);
    const ex = -eph.sunX, ey = -eph.sunY, ez = -eph.sunZ;
    const er = Math.hypot(ex, ey, ez);
    const ev = Math.hypot(eph.earthVx - (eph.earthVx + eph.sunVx), eph.earthVy - (eph.earthVy + eph.sunVy), eph.earthVz - (eph.earthVz + eph.sunVz));
    check(Math.abs(er / earthRef.r - 1) < 0.005, `${label} Earth Sun distance ${(er / AU_KM).toFixed(5)} AU vs ${(earthRef.r / AU_KM).toFixed(5)} AU`);
    check(Math.abs(ev / earthRef.v - 1) < 0.005, `${label} Earth orbital speed ${ev.toFixed(3)} vs ${earthRef.v.toFixed(3)} km/s`);
    check(dLon(lonDeg(-ex, -ey), lonDeg(-earthRef.x, -earthRef.y)) < 0.05, `${label} geocentric solar longitude within 0.05 deg`);
    for (let i = 0; i < PL.length; i++) {
        const p = PL[i];
        const ref = reference(p.name, T);
        const hx = eph.plX[i] - eph.sunX, hy = eph.plY[i] - eph.sunY, hz = eph.plZ[i] - eph.sunZ;
        const hvx = eph.plVx[i] - eph.sunVx, hvy = eph.plVy[i] - eph.sunVy, hvz = eph.plVz[i] - eph.sunVz;
        const r = Math.hypot(hx, hy, hz), v = Math.hypot(hvx, hvy, hvz);
        check(Math.abs(r / ref.r - 1) < 0.005, `${label} ${p.name} Sun distance ${(r / AU_KM).toFixed(4)} vs ${(ref.r / AU_KM).toFixed(4)} AU`);
        check(Math.abs(v / ref.v - 1) < 0.005, `${label} ${p.name} orbital speed ${v.toFixed(3)} vs ${ref.v.toFixed(3)} km/s`);
        // Direction from Earth (geocentric ecliptic longitude).
        const gl = lonDeg(eph.plX[i], eph.plY[i]);
        const gref = lonDeg(ref.x - earthRef.x, ref.y - earthRef.y);
        check(dLon(gl, gref) < 1, `${label} ${p.name} longitude from Earth ${gl.toFixed(2)} vs ${gref.toFixed(2)} deg`);
    }
}

// World frame = mean ecliptic of J2000: real stars sit at their ecliptic
// latitudes (Regulus +0.46 deg, Spica -2.05 deg, Sgr A* -5.61 deg).
const byName = n => STARS.find(s => s.name === n);
const eclLat = s => Math.asin((s.z || 0) / Math.hypot(s.x, s.y, s.z || 0)) / DEG;
for (const [name, lat] of [["REGULUS", 0.465], ["SPICA", -2.05], ["SGR A*", -5.61], ["ANTARES", -4.57]]) {
    const s = byName(name);
    check(s && Math.abs(eclLat(s) - lat) < 0.05, `${name} ecliptic latitude ${s ? eclLat(s).toFixed(3) : "missing"} vs ${lat}`);
}
// On 2026-09-13 the Sun stands in front of Leo/Virgo near longitude 170.6 deg:
// Regulus (lon 149.8) is ~21 deg west of it and Spica (lon 203.8) ~33 deg east.
setEpochMs(Date.UTC(2026, 8, 13, 12, 0, 0));
resetEphem();
const sunLon = lonDeg(eph.sunX, eph.sunY);
const regLon = lonDeg(byName("REGULUS").x, byName("REGULUS").y);
check(dLon(sunLon, 170.6) < 0.3, `2026-09-13 solar ecliptic longitude ${sunLon.toFixed(2)} deg (Meeus ~170.6)`);
check(dLon(sunLon, regLon) > 15 && dLon(sunLon, regLon) < 26, `Sun-Regulus elongation ${dLon(sunLon, regLon).toFixed(1)} deg`);

if (failures) { console.error(`smoke-planet-phases: ${failures} failure(s)`); process.exit(1); }
console.log("smoke-planet-phases passed");
