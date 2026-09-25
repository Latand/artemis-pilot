// Runs the Milky Way - Andromeda tidal-debris simulation
// (universe/mergerTides.js, ~2 s for the default 2 x 3072 particles) off the
// main thread and hands the keyframes back as transferable arrays.
import { buildDebrisNeighbours } from "../render/debrisShape.js";
import { simulateMergerTides } from "../universe/mergerTides.js";

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
    self.onmessage = e => {
        const m = e.data;
        if (m?.type !== "simulate") return;
        try {
            const t0 = performance.now();
            const r = simulateMergerTides(m.options || {});
            const initial = Float32Array.from(r.pos.subarray(0, r.n * 3), x => x * r.scale[0]);
            r.neighbours = buildDebrisNeighbours(initial, r.nMW);
            const transfer = [r.times, r.pos, r.scale, r.w, r.sigma, r.keepMW, r.keepMWTotal, r.keepM31, r.binEdgesKpc, r.neighbours].map(a => a.buffer);
            self.postMessage({ type: "done", id: m.id, model: r, ms: performance.now() - t0 }, transfer);
        } catch (err) {
            self.postMessage({ type: "error", id: m.id, message: String(err?.message || err) });
        }
    };
}
