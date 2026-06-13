import { DARK_ENERGY, FLOW, PL, K, STARS } from "./constants.js";
import { G, BH, WORLD } from "./state.js";
import { smooth01 } from "./format.js";

// Scene-unit river field: the medium falls at v = sqrt(2mu/r) toward every
// body. This is the same absolute field used by the GPU river shader.
export const flowCtx = {
    earthScX: 0, earthScZ: 0,
    sunScX: 0, sunScZ: 0,
    plScX: new Float64Array(PL.length), plScZ: new Float64Array(PL.length),
    plC: PL.map(p => .001 * Math.sqrt(2 * p.mu / 1000)),
    plSink: PL.map(p => p.R * K),
    starC: STARS.map(s => .001 * Math.sqrt(2 * s.mu / 1000)),
    starSink: STARS.map(s => (s.bh ? s.rs : s.R) * K),
};
export function flowVel(x, y, z, mx, my, mz, out) {
    const edx = x - flowCtx.earthScX, edz = z - flowCtx.earthScZ;
    const rE = Math.max(0.6, Math.hypot(edx, y, edz));
    const sE = WORLD.earthDestroyed ? 0 : FLOW.CE / Math.sqrt(rE) / rE;
    let pullX = WORLD.earthDestroyed ? 0 : -edx * FLOW.CE * FLOW.CE / (rE * rE * rE);
    let pullY = WORLD.earthDestroyed ? 0 : -y * FLOW.CE * FLOW.CE / (rE * rE * rE);
    let pullZ = WORLD.earthDestroyed ? 0 : -edz * FLOW.CE * FLOW.CE / (rE * rE * rE);
    const dx = x - mx, dy = y - my, dz = z - mz;
    const rM = Math.max(0.4, Math.hypot(dx, dy, dz));
    const sM = WORLD.moonDestroyed ? 0 : FLOW.CM / Math.sqrt(rM) / rM;
    if (!WORLD.moonDestroyed) {
        const mPull = FLOW.CM * FLOW.CM / (rM * rM * rM);
        pullX -= dx * mPull; pullY -= dy * mPull; pullZ -= dz * mPull;
    }
    const sdx = x - flowCtx.sunScX, sdy = y, sdz = z - flowCtx.sunScZ;
    const rS = Math.max(1, Math.hypot(sdx, sdy, sdz));
    const sS = WORLD.sunDestroyed ? 0 : FLOW.CS / Math.sqrt(rS) / rS;
    if (!WORLD.sunDestroyed) {
        const sunPull = FLOW.CS * FLOW.CS / (rS * rS * rS);
        pullX -= sdx * sunPull; pullY -= sdy * sunPull; pullZ -= sdz * sunPull;
    }
    let exVX = -sdx * sS;
    let exVY = -sdy * sS;
    let exVZ = -sdz * sS;
    for (let i = 0; i < PL.length; i++) {
        if (WORLD.plDestroyed[i]) continue;
        const pdx = x - flowCtx.plScX[i], pdz = z - flowCtx.plScZ[i];
        const rP = Math.max(flowCtx.plSink[i] * .9, Math.hypot(pdx, y, pdz));
        if (rP > PL[i].soi * K * 4) continue; // negligible beyond a few SOI
        const sP = flowCtx.plC[i] / Math.sqrt(rP) / rP;
        exVX -= pdx * sP; exVY -= y * sP; exVZ -= pdz * sP;
        const pPull = flowCtx.plC[i] * flowCtx.plC[i] / (rP * rP * rP);
        pullX -= pdx * pPull; pullY -= y * pPull; pullZ -= pdz * pPull;
    }
    for (let i = 0; i < STARS.length; i++) {
        const sdx0 = x - STARS[i].x * K, sdz0 = z + STARS[i].y * K;
        const rStar = Math.max(flowCtx.starSink[i] * .9, Math.hypot(sdx0, y, sdz0));
        const sStar = flowCtx.starC[i] / Math.sqrt(rStar) / rStar;
        exVX -= sdx0 * sStar; exVY -= y * sStar; exVZ -= sdz0 * sStar;
        const starPull = flowCtx.starC[i] * flowCtx.starC[i] / (rStar * rStar * rStar);
        pullX -= sdx0 * starPull; pullY -= y * starPull; pullZ -= sdz0 * starPull;
    }
    for (let i = 0; i < BH.n; i++) {
        // black-hole river: v = √(2μ/r) — exactly c at the horizon
        const bdx = x - (flowCtx.earthScX + BH.sx[i]), bdz = z - (flowCtx.earthScZ + BH.sz[i]);
        const br = Math.max(BH.sinkS[i] * .5, Math.hypot(bdx, y, bdz));
        const cBH = BH.c[i] * Math.max(.08, BH.obsT[i] || 1);
        const bs = cBH / Math.sqrt(br) / br;
        exVX -= bdx * bs; exVY -= y * bs; exVZ -= bdz * bs;
        const bPull = cBH * cBH / (br * br * br);
        pullX -= bdx * bPull; pullY -= y * bPull; pullZ -= bdz * bPull;
    }
    let deX = 0, deY = 0, deZ = 0;
    if (G.darkEnergy) {
        deX = edx * DARK_ENERGY.H_SIM;
        deY = y * DARK_ENERGY.H_SIM;
        deZ = edz * DARK_ENERGY.H_SIM;
        exVX += deX; exVY += deY; exVZ += deZ;
    }
    const vx = -edx * sE - dx * sM + exVX;
    const vy = -y * sE - dy * sM + exVY;
    const vz = -edz * sE - dz * sM + exVZ;
    const rawLen = Math.hypot(vx, vy, vz);
    const pullLen = Math.hypot(pullX, pullY, pullZ);
    if (rawLen > 1e-12 && pullLen > 1e-18) {
        const deInk = smooth01(0.45, 0.92, Math.hypot(deX, deY, deZ) / rawLen);
        const gx = pullX / pullLen * rawLen, gy = pullY / pullLen * rawLen, gz = pullZ / pullLen * rawLen;
        out[0] = gx + (vx - gx) * deInk;
        out[1] = gy + (vy - gy) * deInk;
        out[2] = gz + (vz - gz) * deInk;
        return rawLen;
    }
    out[0] = vx; out[1] = vy; out[2] = vz;
    return rawLen;
}
