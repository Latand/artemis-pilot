// Mamajek main-sequence B-V color index to absolute V magnitude anchors.
// Used only for explicitly flagged photometric-distance AT-HYG sidecar rows.

const MS_BV_MV = [
    [-0.30, -3.0],
    [-0.20, -1.1],
    [-0.10, 0.6],
    [0.00, 1.5],
    [0.15, 2.4],
    [0.30, 3.5],
    [0.45, 4.3],
    [0.57, 4.83],
    [0.65, 5.3],
    [0.80, 6.0],
    [1.00, 6.7],
    [1.20, 7.5],
    [1.40, 8.8],
    [1.50, 10.0],
    [1.60, 11.8],
    [1.80, 13.5],
    [2.00, 16.0],
];

export function msAbsMagFromColor(bv) {
    const ci = Number(bv);
    if (!Number.isFinite(ci)) return MS_BV_MV[8][1];
    if (ci <= MS_BV_MV[0][0]) return MS_BV_MV[0][1];
    const last = MS_BV_MV[MS_BV_MV.length - 1];
    if (ci >= last[0]) return last[1];

    for (let i = 1; i < MS_BV_MV.length; i++) {
        const [x1, y1] = MS_BV_MV[i];
        if (ci <= x1) {
            const [x0, y0] = MS_BV_MV[i - 1];
            const f = (ci - x0) / (x1 - x0);
            return y0 + (y1 - y0) * f;
        }
    }
    return last[1];
}

