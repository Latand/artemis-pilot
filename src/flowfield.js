import { FLOW, PL, K } from "./constants.js";
import { BH, WORLD } from "./state.js";

// Scene-unit river field: the medium falls at v = √(2μ/r) toward every body.
// Earth, Sun, planets, and holes are sampled in world-space. The far-field
// terms subtract the local bulk flow so nearby tidal structure stays readable.
export const flowCtx = {
    earthScX: 0, earthScZ: 0,
    sunScX: 0, sunScZ: 0,
    plScX: new Float64Array(PL.length), plScZ: new Float64Array(PL.length),
    plC: PL.map(p => .001 * Math.sqrt(2 * p.mu / 1000)),
    plSink: PL.map(p => p.R * K),
};
export function flowVel(x, y, z, mx, my, mz, out) {
    const edx = x - flowCtx.earthScX, edz = z - flowCtx.earthScZ;
    const rE = Math.max(0.6, Math.hypot(edx, y, edz));
    const sE = WORLD.earthDestroyed ? 0 : FLOW.CE / Math.sqrt(rE) / rE;
    const dx = x - mx, dy = y - my, dz = z - mz;
    const rM = Math.max(0.4, Math.hypot(dx, dy, dz));
    const sM = WORLD.moonDestroyed ? 0 : FLOW.CM / Math.sqrt(rM) / rM;
    const sdx = x - flowCtx.sunScX, sdy = y, sdz = z - flowCtx.sunScZ;
    const rS = Math.max(1, Math.hypot(sdx, sdy, sdz));
    const sS = WORLD.sunDestroyed ? 0 : FLOW.CS / Math.sqrt(rS) / rS;
    const esx = flowCtx.earthScX - flowCtx.sunScX, esz = flowCtx.earthScZ - flowCtx.sunScZ;
    const rS0 = Math.max(1, Math.hypot(esx, esz));
    const sS0 = WORLD.sunDestroyed ? 0 : FLOW.CS / Math.sqrt(rS0) / rS0;
    let exVX = -sdx * sS + esx * sS0;
    let exVY = -sdy * sS;
    let exVZ = -sdz * sS + esz * sS0;
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const pdx = x - flowCtx.plScX[i], pdz = z - flowCtx.plScZ[i];
        const rP = Math.max(flowCtx.plSink[i] * .9, Math.hypot(pdx, y, pdz));
        if (rP > PL[i].soi * K * 4) continue; // negligible beyond a few SOI
        const sP = flowCtx.plC[i] / Math.sqrt(rP) / rP;
        exVX -= pdx * sP; exVY -= y * sP; exVZ -= pdz * sP;
    }
    let q = Math.min(1, Math.max(0, (rM - 20) / 120));
    q = q * q * (3 - 2 * q);
    const earthW = 0.32 + 0.68 * q;
    for (let i = 0; i < BH.n; i++) {
        // black-hole river: v = √(2μ/r) — exactly c at the horizon
        const bdx = x - (flowCtx.earthScX + BH.sx[i]), bdz = z - (flowCtx.earthScZ + BH.sz[i]);
        const br = Math.max(BH.sinkS[i] * .5, Math.hypot(bdx, y, bdz));
        const bs = BH.c[i] / Math.sqrt(br) / br;
        exVX -= bdx * bs; exVY -= y * bs; exVZ -= bdz * bs;
    }
    const vx = -edx * sE * earthW - dx * sM + exVX;
    const vy = -y * sE * earthW - dy * sM + exVY;
    const vz = -edz * sE * earthW - dz * sM + exVZ;
    out[0] = vx; out[1] = vy; out[2] = vz;
    return Math.hypot(vx, vy, vz);
}
