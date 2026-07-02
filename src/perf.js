export const PERF = {
    enabled: false,
    samples: Object.create(null),
    last: Object.create(null),
    // renderer.info snapshot (draw calls / triangles / geometries / textures);
    // populated by sampleRendererInfo(), reused in place every call.
    renderInfo: { calls: 0, triangles: 0, points: 0, lines: 0, geometries: 0, textures: 0 },
    // per-frame JS heap allocation sentinel; populated by sampleMemory().
    mem: { supported: false, usedMB: 0, deltaMB: 0, maxDeltaMB: 0 },
    // WebXR perf state (foveation/dynamic-res/bloom gate); populated in place
    // by src/render/xrPerf.js while enabled — null until that module ticks once.
    xr: null,
};

try {
    const q = new URLSearchParams(location.search);
    PERF.enabled = q.get("perf") === "1" || localStorage.getItem("ap_perf") === "1";
} catch (e) { }

export function markPerf(name, ms, detail = null) {
    if (!PERF.enabled) return;
    let s = PERF.samples[name];
    if (!s) s = PERF.samples[name] = { count: 0, avg: 0, max: 0 };
    s.count++;
    s.avg += (ms - s.avg) / Math.min(s.count, 180);
    s.max = Math.max(s.max * .995, ms);
    PERF.last[name] = detail ? { ms, ...detail } : { ms };
}

// Zero-alloc: reuses PERF.renderInfo in place, no object literal per call.
export function sampleRendererInfo(renderer) {
    if (!PERF.enabled || !renderer) return;
    const r = renderer.info.render, m = renderer.info.memory;
    const info = PERF.renderInfo;
    info.calls = r.calls;
    info.triangles = r.triangles;
    info.points = r.points;
    info.lines = r.lines;
    info.geometries = m.geometries;
    info.textures = m.textures;
}

// Lightweight per-frame allocation sentinel via the nonstandard (Chrome-only)
// performance.memory API. Zero-alloc: reuses PERF.mem in place.
export function sampleMemory() {
    if (!PERF.enabled) return;
    const perfMem = typeof performance !== "undefined" ? performance.memory : null;
    const mem = PERF.mem;
    if (!perfMem) { mem.supported = false; return; }
    const usedMB = perfMem.usedJSHeapSize / 1048576;
    if (mem.supported) {
        const delta = usedMB - mem.usedMB;
        mem.deltaMB = delta;
        if (delta > mem.maxDeltaMB) mem.maxDeltaMB = delta;
    }
    mem.supported = true;
    mem.usedMB = usedMB;
}

if (typeof window !== "undefined") {
    PERF.setEnabled = enabled => {
        PERF.enabled = !!enabled;
        try { localStorage.setItem("ap_perf", PERF.enabled ? "1" : "0"); } catch (e) { }
    };
    PERF.clear = () => {
        PERF.samples = Object.create(null);
        PERF.last = Object.create(null);
    };
    window.__PERF = PERF;
}
