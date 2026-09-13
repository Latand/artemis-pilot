export function classifyContact(a, b, out = null) {
    const dKm = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    const relKmS = Math.hypot(a.vx - b.vx, a.vy - b.vy, a.vz - b.vz);
    const sumR = a.R + b.R;
    const big = a.mu >= b.mu ? a : b;
    const small = big === a ? b : a;
    const rocheKm = Math.min(
        big.rocheMax,
        2.44 * big.R * Math.cbrt(big.rho / Math.max(1e-12, small.rho)),
    );
    const escKmS = Math.sqrt(2 * (a.mu + b.mu) / Math.max(1, sumR));

    let kind = "none";
    if (dKm <= sumR) {
        const ratio = small.mu / big.mu;
        kind = ratio > .2 || relKmS > escKmS ? "impact-both" : "impact";
    } else if (dKm < rocheKm) {
        kind = "roche";
    }

    const result = out ?? {};
    result.kind = kind;
    result.dKm = dKm;
    result.relKmS = relKmS;
    result.rocheKm = rocheKm;
    result.escKmS = escKmS;
    return result;
}
