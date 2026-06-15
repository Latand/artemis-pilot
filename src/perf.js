export const PERF = {
    enabled: false,
    samples: Object.create(null),
    last: Object.create(null),
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
