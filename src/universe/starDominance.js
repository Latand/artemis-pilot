export const STAR_DOMINANCE_MARGIN = 50;

export function strongestActiveStarWell(stars, wx, wy, wz, baseAcc = 0, margin = STAR_DOMINANCE_MARGIN) {
    let best = null, bestAcc = 0, bestRx = 0, bestRy = 0, bestRz = 0;
    let second = null, secondAcc = 0;
    for (const star of stars || []) {
        const rx = wx - star.x, ry = wy - star.y, rz = wz - (star.z || 0);
        const d2 = rx * rx + ry * ry + rz * rz;
        if (d2 <= 1e-18 || !(star.mu > 0)) continue;
        const soft2 = (star.softeningKm || 0) ** 2;
        const acc = soft2 > 0 ? star.mu * Math.sqrt(d2) / Math.pow(d2 + soft2, 1.5) : star.mu / d2;
        if (acc > bestAcc) {
            second = best;
            secondAcc = bestAcc;
            best = star;
            bestAcc = acc;
            bestRx = rx;
            bestRy = ry;
            bestRz = rz;
        } else if (acc > secondAcc) {
            second = star;
            secondAcc = acc;
        }
    }
    if (!best) return null;
    return {
        star: best,
        secondStar: second,
        secondAcc,
        acc: bestAcc,
        d: Math.hypot(bestRx, bestRy, bestRz),
        dominant: !(best.gasSink && Math.hypot(bestRx,bestRy,bestRz) < 10 * best.softeningKm) && bestAcc > Math.max(baseAcc, secondAcc) * Math.max(1, margin),
        rx: bestRx,
        ry: bestRy,
        rz: bestRz,
    };
}
