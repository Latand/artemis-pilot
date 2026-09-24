// Builds the galaxy population (universe/galaxyPopulation.js) off the main
// thread and packs it into per-chunk GPU attribute arrays for
// render/galaxyPopulationRender.js.
//
// Frame handed back: world-frame axes, COMOVING Mpc, origin at the Galactic
// centre at the catalog epoch (the population itself is Sun-centred; the
// Milky Way entry's position is subtracted). Chunks are spatially compact
// (sorted along a Morton curve, split into equal runs) so each can carry its
// own float64 origin: attributes are float32 offsets from the chunk centre.
import { decodeLocalVolume, decode2mrs, LOCAL_VOLUME_PATH, TWOMRS_MANIFEST_PATH } from "../universe/galaxyCatalogs.js";
import { buildGalaxyPopulation, PROV } from "../universe/galaxyPopulation.js";

const CHUNK = 8192;

function morton3(x, y, z) {
    // 10 bits per axis
    const part = v => {
        v &= 0x3ff;
        v = (v | (v << 16)) & 0x030000ff;
        v = (v | (v << 8)) & 0x0300f00f;
        v = (v | (v << 4)) & 0x030c30c3;
        v = (v | (v << 2)) & 0x09249249;
        return v;
    };
    return (part(x) | (part(y) << 1) | (part(z) << 2)) >>> 0;
}

export function packPopulation(pop) {
    const n = pop.count;
    const mw = pop.mwIndex;
    const ox = pop.pos[mw * 3], oy = pop.pos[mw * 3 + 1], oz = pop.pos[mw * 3 + 2];
    const lg = pop.localGroupUnit;
    // GC-relative positions and unit centres (LG members: unit = origin, the
    // offset carries their full proper position; bound, no expansion).
    const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
    const ux = new Float64Array(n), uy = new Float64Array(n), uz = new Float64Array(n);
    let ext = 1;
    for (let i = 0; i < n; i++) {
        px[i] = pop.pos[i * 3] - ox; py[i] = pop.pos[i * 3 + 1] - oy; pz[i] = pop.pos[i * 3 + 2] - oz;
        const u = pop.unit[i];
        if (u === lg) { ux[i] = 0; uy[i] = 0; uz[i] = 0; }
        else if (u >= 0) {
            ux[i] = pop.units.center[u * 3] - ox; uy[i] = pop.units.center[u * 3 + 1] - oy; uz[i] = pop.units.center[u * 3 + 2] - oz;
        } else { ux[i] = px[i]; uy[i] = py[i]; uz[i] = pz[i]; }
        ext = Math.max(ext, Math.abs(ux[i]), Math.abs(uy[i]), Math.abs(uz[i]));
    }
    // Local Group members go to their own (first) chunk: the renderer moves
    // the dynamic ones (M31 and its satellites) every frame.
    const lgIdx = [], rest = [];
    for (let i = 0; i < n; i++) (pop.unit[i] === lg ? lgIdx : rest).push(i);
    const keys = new Uint32Array(rest.length);
    const q = v => Math.max(0, Math.min(1023, Math.floor((v / ext * 0.5 + 0.5) * 1023)));
    for (let k = 0; k < rest.length; k++) { const i = rest[k]; keys[k] = morton3(q(ux[i]), q(uy[i]), q(uz[i])); }
    const order = Array.from(rest.keys()).sort((a, b) => keys[a] - keys[b] || rest[a] - rest[b]).map(k => rest[k]);
    const runs = [lgIdx];
    for (let s = 0; s < order.length; s += CHUNK) runs.push(order.slice(s, s + CHUNK));
    const chunks = [];
    const transfer = [];
    for (let c = 0; c < runs.length; c++) {
        const idx = runs[c];
        const m = idx.length;
        let cx = 0, cy = 0, cz = 0;
        if (c > 0) {
            for (const i of idx) { cx += ux[i]; cy += uy[i]; cz += uz[i]; }
            cx /= Math.max(1, m); cy /= Math.max(1, m); cz /= Math.max(1, m);
        }
        const unit = new Float32Array(m * 3), delta = new Float32Array(m * 3), shape = new Float32Array(m * 4), phot = new Float32Array(m * 4), tt = new Float32Array(m);
        const gid = new Int32Array(m);
        let rMax = 0, minMV = 99, maxH = 0;
        for (let k = 0; k < m; k++) {
            const i = idx[k];
            unit[k * 3] = ux[i] - cx; unit[k * 3 + 1] = uy[i] - cy; unit[k * 3 + 2] = uz[i] - cz;
            delta[k * 3] = px[i] - ux[i]; delta[k * 3 + 1] = py[i] - uy[i]; delta[k * 3 + 2] = pz[i] - uz[i];
            shape[k * 4] = pop.normal[i * 3]; shape[k * 4 + 1] = pop.normal[i * 3 + 1]; shape[k * 4 + 2] = pop.normal[i * 3 + 2]; shape[k * 4 + 3] = pop.q0[i];
            phot[k * 4] = pop.MV[i]; phot[k * 4 + 1] = pop.bv[i]; phot[k * 4 + 2] = pop.hKpc[i]; phot[k * 4 + 3] = pop.bulge[i];
            tt[k] = pop.prov[i] === PROV.MILKY_WAY ? 100 + pop.T[i] : pop.T[i];   // +100 flags the Milky Way entry
            gid[k] = i;
            if (pop.MV[i] < minMV) minMV = pop.MV[i];
            if (pop.hKpc[i] > maxH) maxH = pop.hKpc[i];
            rMax = Math.max(rMax, Math.hypot(ux[i] - cx, uy[i] - cy, uz[i] - cz) + Math.hypot(delta[k * 3], delta[k * 3 + 1], delta[k * 3 + 2]));
        }
        chunks.push({ center: [cx, cy, cz], count: m, radiusMpc: rMax, minMV, maxHKpc: maxH, unit, delta, shape, phot, t: tt, gid, lg: c === 0 });
        transfer.push(unit.buffer, delta.buffer, shape.buffer, phot.buffer, tt.buffer, gid.buffer);
    }
    // CPU-side catalog for labels and picking (GC-relative, comoving Mpc).
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = px[i]; pos[i * 3 + 1] = py[i]; pos[i * 3 + 2] = pz[i]; }
    const catalog = {
        count: n, pos, MV: pop.MV, prov: pop.prov, name: pop.name, names: pop.names, T: pop.T, hKpc: pop.hKpc,
        unit: pop.unit, mwIndex: mw, localGroupUnit: lg, unitCount: pop.units.count,
        gcHelioMpc: [ox, oy, oz], stats: pop.stats,
    };
    transfer.push(pos.buffer, pop.MV.buffer, pop.prov.buffer, pop.name.buffer, pop.T.buffer, pop.hKpc.buffer, pop.unit.buffer);
    return { chunks, catalog, transfer };
}

async function load(base, fetchImpl = fetch) {
    const lvRes = await fetchImpl(base + LOCAL_VOLUME_PATH);
    if (!lvRes.ok) throw new Error("local volume: HTTP " + lvRes.status);
    const lv = decodeLocalVolume(await lvRes.json());
    const manRes = await fetchImpl(base + TWOMRS_MANIFEST_PATH);
    if (!manRes.ok) throw new Error("2mrs manifest: HTTP " + manRes.status);
    const manifest = await manRes.json();
    const binUrl = (base + TWOMRS_MANIFEST_PATH).replace(/[^/]*$/, manifest.binary);
    const binRes = await fetchImpl(binUrl);
    if (!binRes.ok) throw new Error("2mrs: HTTP " + binRes.status);
    const mrs = decode2mrs(await binRes.arrayBuffer(), manifest);
    return { lv, mrs };
}

export async function handleBuild(m, fetchImpl) {
    const t0 = performance.now();
    const { lv, mrs } = await load(m.base || "", fetchImpl);
    const t1 = performance.now();
    const pop = buildGalaxyPopulation(lv, mrs, m.options || {});
    const t2 = performance.now();
    const packed = packPopulation(pop);
    return { type: "built", id: m.id, chunks: packed.chunks, catalog: packed.catalog, transfer: packed.transfer, ms: { load: t1 - t0, build: t2 - t1, pack: performance.now() - t2 } };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
    self.onmessage = async e => {
        const m = e.data;
        if (m?.type !== "build") return;
        try {
            const r = await handleBuild(m);
            const { transfer, ...msg } = r;
            self.postMessage(msg, transfer);
        } catch (err) {
            self.postMessage({ type: "error", id: m.id, message: String(err?.message || err) });
        }
    };
}
