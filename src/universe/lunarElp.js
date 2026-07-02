const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const SEC_PER_CENTURY = 36525 * 86400;
const FD_SECONDS = 60;

function degMod(v) {
    return ((v % 360) + 360) % 360;
}

function sinDeg(v) {
    return Math.sin(degMod(v) * DEG);
}

function cosDeg(v) {
    return Math.cos(degMod(v) * DEG);
}

function eFactor(E, m) {
    const k = Math.abs(m);
    return k === 0 ? 1 : k === 1 ? E : E * E;
}

const LON_TERMS = [
    [0, 0, 1, 0, 6288774],
    [2, 0, -1, 0, 1274027],
    [2, 0, 0, 0, 658314],
    [0, 0, 2, 0, 213618],
    [0, 1, 0, 0, -185116],
    [0, 0, 0, 2, -114332],
    [2, 0, -2, 0, 58793],
    [2, -1, -1, 0, 57066],
    [2, 0, 1, 0, 53322],
    [2, -1, 0, 0, 45758],
    [0, 1, -1, 0, -40923],
    [1, 0, 0, 0, -34720],
    [0, 1, 1, 0, -30383],
    [2, 0, -2, -2, 15327],
    [0, 0, 1, 2, -12528],
    [0, 0, 1, -2, 10980],
    [4, 0, -1, 0, 10675],
    [0, 0, 3, 0, 10034],
];

const LAT_TERMS = [
    [0, 0, 0, 1, 5128122],
    [0, 0, 1, 1, 280602],
    [0, 0, 1, -1, 277693],
    [2, 0, 0, -1, 173237],
    [2, 0, -1, 1, 55413],
    [2, 0, -1, -1, 46271],
    [2, 0, 0, 1, 32573],
    [0, 0, 2, 1, 17198],
    [2, 0, 1, -1, 9266],
    [0, 0, 2, -1, 8822],
    [2, -1, 0, -1, 8216],
    [2, 0, -2, -1, 4324],
];

const DIST_TERMS = [
    [0, 0, 1, 0, -20905355],
    [2, 0, -1, 0, -3699111],
    [2, 0, 0, 0, -2955968],
    [0, 0, 2, 0, -569925],
    [0, 1, 0, 0, 48888],
    [0, 0, 0, 2, -3149],
    [2, 0, -2, 0, 246158],
    [2, -1, -1, 0, -152138],
    [2, 0, 1, 0, -170733],
    [2, -1, 0, 0, -204586],
];

function termArg(D, M, Mp, F, dMul, mMul, mpMul, fMul) {
    return dMul * D + mMul * M + mpMul * Mp + fMul * F;
}

export function moonEcliptic(secondsSinceJ2000) {
    const T = secondsSinceJ2000 / SEC_PER_CENTURY;
    const T2 = T * T, T3 = T2 * T, T4 = T2 * T2;
    const Lp = degMod(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000);
    const D = degMod(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000);
    const M = degMod(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000);
    const Mp = degMod(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000);
    const F = degMod(93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000);
    const E = 1 - 0.002516 * T - 0.0000074 * T2;

    let sumL = 0, sumB = 0, sumR = 0;
    for (const [dMul, mMul, mpMul, fMul, coeff] of LON_TERMS) {
        sumL += coeff * eFactor(E, mMul) * sinDeg(termArg(D, M, Mp, F, dMul, mMul, mpMul, fMul));
    }
    for (const [dMul, mMul, mpMul, fMul, coeff] of LAT_TERMS) {
        sumB += coeff * eFactor(E, mMul) * sinDeg(termArg(D, M, Mp, F, dMul, mMul, mpMul, fMul));
    }
    for (const [dMul, mMul, mpMul, fMul, coeff] of DIST_TERMS) {
        sumR += coeff * eFactor(E, mMul) * cosDeg(termArg(D, M, Mp, F, dMul, mMul, mpMul, fMul));
    }

    const A1 = degMod(119.75 + 131.849 * T);
    const A2 = degMod(53.09 + 479264.290 * T);
    const A3 = degMod(313.45 + 481266.484 * T);
    sumL += 3958 * sinDeg(A1) + 1962 * sinDeg(Lp - F) + 318 * sinDeg(A2);
    sumB += -2235 * sinDeg(Lp) + 382 * sinDeg(A3) + 175 * sinDeg(A1 - F) +
        175 * sinDeg(A1 + F) + 127 * sinDeg(Lp - Mp) - 115 * sinDeg(Lp + Mp);

    const lonOfDateDeg = Lp + sumL / 1e6;
    const latDeg = sumB / 1e6;
    const distKm = 385000.56 + sumR / 1000;
    const precessionDeg = 1.396971 * T + 0.0003086 * T2;
    return {
        lonRadJ2000: degMod(lonOfDateDeg - precessionDeg) * DEG,
        latRad: latDeg * DEG,
        distKm,
    };
}

export function moonGeocentricCartesian(secondsSinceJ2000, out = {}) {
    const m = moonEcliptic(secondsSinceJ2000);
    const cb = Math.cos(m.latRad);
    out.x = m.distKm * cb * Math.cos(m.lonRadJ2000);
    out.y = m.distKm * cb * Math.sin(m.lonRadJ2000);
    out.z = m.distKm * Math.sin(m.latRad);
    return out;
}

export function moonGeocentricState(secondsSinceJ2000, out = {}) {
    moonGeocentricCartesian(secondsSinceJ2000, out);
    const x = out.x, y = out.y, z = out.z;
    moonGeocentricCartesian(secondsSinceJ2000 + FD_SECONDS, out);
    out.vx = (out.x - x) / FD_SECONDS;
    out.vy = (out.y - y) / FD_SECONDS;
    out.vz = (out.z - z) / FD_SECONDS;
    out.x = x; out.y = y; out.z = z;
    return out;
}

export function lonRadJ2000ToOfDate(lonRadJ2000, secondsSinceJ2000) {
    const T = secondsSinceJ2000 / SEC_PER_CENTURY;
    return degMod(lonRadJ2000 * RAD + 1.396971 * T + 0.0003086 * T * T) * DEG;
}
