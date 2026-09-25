// Builds procedural resolved-field bins off the main thread
// (universe/resolvedField.js). Holds the box cache; each request selects one
// bin for one camera and returns transferable arrays ready for a point layer.
import { createFieldCache, trimFieldCache, buildBin, makeSelectionOut } from "../universe/resolvedField.js";
import { ensureGalaxyMaps } from "../universe/galaxyMaps.js";
import { teffToRGB } from "../render/viewBrightness.js";

const cache = createFieldCache(3.5e6);
const _rgb = [1, 1, 1];
const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export function handleBuild(m) {
    // the stars follow the same arms, knots and bar as the diffuse light
    ensureGalaxyMaps();
    const out = makeSelectionOut(1024);
    const t0 = performance.now();
    buildBin(cache, m.seed, m.family, m.bin, m.params, out);
    trimFieldCache(cache);
    const n = out.n;
    const pos = out.pos.slice(0, n * 3), absMag = out.absMag.slice(0, n), teff = out.teff.slice(0, n);
    const color = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        teffToRGB(teff[i], _rgb);
        color[i * 3] = lin(_rgb[0]); color[i * 3 + 1] = lin(_rgb[1]); color[i * 3 + 2] = lin(_rgb[2]);
    }
    return {
        id: m.id, gen: m.gen, family: m.family, bin: m.bin, n, pos, absMag, teff, color,
        ref: m.params.ref, cam: m.params.cam, overflow: n > (m.params.maxStars ?? Infinity),
        ms: performance.now() - t0, cached: cache.stars,
    };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
    self.onmessage = e => {
        const m = e.data;
        if (m?.type !== "build") return;
        const r = handleBuild(m);
        self.postMessage(r, [r.pos.buffer, r.absMag.buffer, r.teff.buffer, r.color.buffer]);
    };
}
