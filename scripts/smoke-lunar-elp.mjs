globalThis.window = {};

const { moonEcliptic, lonRadJ2000ToOfDate, sunEclipticLongitude } = await import("../src/universe/lunarElp.js");
const { setEpochMs, secondsSinceJ2000 } = await import("../src/epoch.js");
const { resetEphem, eph } = await import("../src/ephemeris.js");

function assert(ok, msg) {
    if (!ok) {
        console.error("FAIL: " + msg);
        process.exit(1);
    }
}

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;
const SEC_PER_CENTURY = 36525 * 86400;

function mod360(v) {
    return ((v % 360) + 360) % 360;
}

function signedDeltaDeg(a, b) {
    return ((((a - b) + 180) % 360) + 360) % 360 - 180;
}

function referenceSunLonJ2000(sec) {
    const T = sec / SEC_PER_CENTURY;
    const T2 = T * T;
    const L0 = mod360(280.46646 + 36000.76983 * T + 0.0003032 * T2);
    const M = mod360(357.52911 + 35999.05029 * T - 0.0001537 * T2);
    const C = (1.914602 - 0.004817 * T - 0.000014 * T2) * Math.sin(M * RAD) +
        (0.019993 - 0.000101 * T) * Math.sin(2 * M * RAD) +
        0.000289 * Math.sin(3 * M * RAD);
    const precessionDeg = 1.396971 * T + 0.0003086 * T2;
    return mod360(L0 + C - precessionDeg);
}

function referenceSunLonApparentOfDate(sec) {
    const T = sec / SEC_PER_CENTURY;
    const T2 = T * T;
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T2;
    const M = 357.52911 + 35999.05029 * T - 0.0001537 * T2;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T2) * Math.sin(M * RAD) +
        (0.019993 - 0.000101 * T) * Math.sin(2 * M * RAD) +
        0.000289 * Math.sin(3 * M * RAD);
    return mod360(L0 + C - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * T) * RAD));
}

{
    const sec = secondsSinceJ2000(Date.UTC(1992, 3, 12, 0, 0, 0));
    const moon = moonEcliptic(sec);
    const lonOfDateDeg = lonRadJ2000ToOfDate(moon.lonRadJ2000, sec) * DEG;
    const latDeg = moon.latRad * DEG;
    const lonErrArcmin = Math.abs(signedDeltaDeg(lonOfDateDeg, 133.162655)) * 60;
    const latErrArcmin = Math.abs(latDeg - (-3.229126)) * 60;
    const distErrKm = Math.abs(moon.distKm - 368409.7);
    assert(lonErrArcmin < 1, "Meeus 1992 longitude should be within 1 arcmin, got " + lonErrArcmin.toFixed(3));
    assert(latErrArcmin < 1, "Meeus 1992 latitude should be within 1 arcmin, got " + latErrArcmin.toFixed(3));
    assert(distErrKm < 50, "Meeus 1992 distance should be close for the 10-term truncation, got " + distErrKm.toFixed(1) + " km");
    console.log("(a) Meeus 1992 check OK:",
        "lonErr=" + lonErrArcmin.toFixed(3) + " arcmin",
        "latErr=" + latErrArcmin.toFixed(3) + " arcmin",
        "distErr=" + distErrKm.toFixed(1) + " km");
}

function eclipseLongitudeSepDeg(epochMs) {
    const sec = secondsSinceJ2000(epochMs);
    const moon = moonEcliptic(sec);
    return Math.abs(signedDeltaDeg(moon.lonRadJ2000 * DEG, referenceSunLonJ2000(sec)));
}

{
    const nominalMs = Date.UTC(2026, 7, 12, 17, 46, 0);
    const stepMs = 60 * 1000;
    const windowMs = 15 * stepMs;
    let minSep = Infinity, minOffsetMs = 0;
    for (let d = -windowMs; d <= windowMs; d += stepMs) {
        const sep = eclipseLongitudeSepDeg(nominalMs + d);
        if (sep < minSep) { minSep = sep; minOffsetMs = d; }
    }
    assert(minSep < 0.55, "2026-08-12 lunar-solar conjunction should be < 0.55 deg, got " + minSep.toFixed(4));
    assert(Math.abs(minOffsetMs) <= windowMs, "2026-08-12 conjunction should land within +/-15 min");
    console.log("(b) 2026 eclipse longitude gate OK:",
        "minSep=" + minSep.toFixed(4) + " deg",
        "offset=" + (minOffsetMs / 60000).toFixed(0) + " min");

    const noEclipseSep = eclipseLongitudeSepDeg(Date.UTC(2026, 6, 6, 23, 30, 0));
    assert(noEclipseSep > 5, "2026-07-06 no-eclipse regression should stay > 5 deg, got " + noEclipseSep.toFixed(2));
    console.log("(c) no-eclipse regression OK: sep=" + noEclipseSep.toFixed(2) + " deg");
}

function sunMoonSepDeg(epochMs) {
    setEpochMs(epochMs);
    resetEphem();
    const sunMag = Math.hypot(eph.sunX, eph.sunY, eph.sunZ);
    const moonMag = Math.hypot(eph.moonX, eph.moonY, eph.moonZ);
    const dot = eph.sunX * eph.moonX + eph.sunY * eph.moonY + eph.sunZ * eph.moonZ;
    const cosTheta = Math.max(-1, Math.min(1, dot / (sunMag * moonMag)));
    return Math.acos(cosTheta) * DEG;
}

{
    const sec = secondsSinceJ2000(Date.UTC(2026, 7, 12, 17, 46, 0));
    const realSunLonDeg = sunEclipticLongitude(sec) * DEG;
    const refSunLonDeg = referenceSunLonApparentOfDate(sec);
    const errArcsec = Math.abs(signedDeltaDeg(realSunLonDeg, refSunLonDeg)) * 3600;
    assert(errArcsec < 1, "sunEclipticLongitude should match Meeus ch.25 reference, got " + errArcsec.toFixed(3) + " arcsec");
    console.log("(d) solar longitude helper OK: err=" + errArcsec.toFixed(3) + " arcsec");
}

{
    const EPS_DEG = 8;
    const j2000NewMoonMs = Date.UTC(2000, 0, 6, 18, 14, 0);
    const j2000Sep = sunMoonSepDeg(j2000NewMoonMs);
    assert(j2000Sep < EPS_DEG, "real seeding path near-J2000 Sun-Moon separation should be < " + EPS_DEG + " deg, got " + j2000Sep.toFixed(2));
    console.log("(g0) real seeding path near-J2000 OK: sep=" + j2000Sep.toFixed(2) + " deg");

    const nominalMs = Date.UTC(2026, 7, 12, 17, 46, 0);
    const windowMs = 2 * 86400 * 1000;
    const stepMs = 10 * 60 * 1000;
    let minSep = Infinity, minOffsetMs = 0;
    for (let d = -windowMs; d <= windowMs; d += stepMs) {
        const sep = sunMoonSepDeg(nominalMs + d);
        if (sep < minSep) { minSep = sep; minOffsetMs = d; }
    }
    const minOffsetHours = minOffsetMs / 3600000;
    assert(Math.abs(minOffsetHours) <= 1, "2026-08-12 real seeding path minimum should land within +/-1 h, got " + minOffsetHours.toFixed(2) + " h");
    console.log("(g) real seeding path 2026 eclipse OK:",
        "minSep=" + minSep.toFixed(4) + " deg",
        "offset=" + minOffsetHours.toFixed(2) + " h");
}

console.log("lunar ELP smoke passed");
