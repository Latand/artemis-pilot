// Render budgets only. Never change integration, source selection or save data.
export const QUALITY_MODES = ['auto', 'high', 'balanced', 'low', 'minimal'];
export const QUALITY_NAMES = ['High', 'Balanced', 'Low', 'Minimal'];
export function qualityMode(value) { return QUALITY_MODES.includes(value) ? value : 'auto'; }
export function isSoftwareRenderer(name = '') {
    return /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render|\bwarp\b/i.test(name);
}
export function readRendererName(gl) {
    try {
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        return String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || 'unknown');
    } catch { return 'unknown'; }
}
export function qualityBudget(level, mobile = false) {
    level = Math.max(0, Math.min(3, level | 0));
    return {
        dprCap: [mobile ? 1.15 : 1.5, 1, .75, .5][level],
        maxPixels: [4.2e6, 1.5e6, .75e6, .3e6][level],
        riverDraw: [1, .8, .45, .2][level],
        riverEvery: [1, 1, 2, 4][level],
        galaxyScale: [1, .7, .4, .2][level],
        lensSamples: level === 0 && !mobile ? 4 : 0,
        minimal: level === 3,
    };
}
export function qualityPixelRatio({ level, mobile, device = 1, override = 0, width = 1, height = 1 }) {
    // Explicit DPR is an absolute debugging override; auto still adapts other
    // visual work. A quality change does not silently discard that override.
    if (Number.isFinite(override) && override > 0) return Math.max(.25, Math.min(2.5, override));
    const b = qualityBudget(level, mobile);
    return Math.max(.25, Math.min(device, b.dprCap, Math.sqrt(b.maxPixels / Math.max(1, width * height))));
}
export function createQualityController({ mobile = false, software = false, mode = 'auto' } = {}) {
    const s = { mode: qualityMode(mode), mobile, software, level: software ? 3 : 1,
        frameMs: 0, samples: 0, changes: 0, reason: software ? 'software renderer' : 'conservative startup' };
    let last = null, total = 0, count = 0, slow = 0, fast = 0, severe = 0, settleUntil = 0;
    const floor = () => s.software ? 3 : 0;
    function reset(now = 0) {
        last = null; total = count = slow = fast = severe = 0; settleUntil = now + 1500;
    }
    function setMode(value, now = 0) {
        s.mode = qualityMode(value);
        s.level = s.mode === 'auto' ? (s.software ? 3 : 1) : QUALITY_MODES.indexOf(s.mode) - 1;
        s.reason = s.mode === 'auto' ? (s.software ? 'software renderer' : 'conservative startup') : 'manual';
        reset(now);
    }
    function sample(now, { active = true, mobile: nextMobile = s.mobile, targetMs = nextMobile ? 1000 / 30 : 1000 / 60 } = {}) {
        if (nextMobile !== s.mobile) { s.mobile = nextMobile; reset(now); }
        if (!active || !Number.isFinite(now)) { reset(Number.isFinite(now) ? now : 0); return false; }
        const dt = last === null ? 0 : now - last; last = now;
        if (dt <= 0 || now < settleUntil) return false;
        // This is the interval between delivered frames, including GPU queue
        // stalls. Do not use CPU submission duration as a GPU timing proxy.
        s.samples++;
        severe = dt >= 250 ? severe + 1 : 0;
        if (s.mode === 'auto' && severe >= 2 && s.level < 3) {
            s.frameMs = dt; s.level++; s.changes++; s.reason = 'repeated frame stalls';
            reset(now); return true;
        }
        total += Math.min(dt, 1000); count++;
        if (total < 1000 || count < 3) return false;
        s.frameMs = total / count; total = count = 0;
        if (s.mode !== 'auto') return false;
        const tooSlow = s.frameMs > Math.max(42, targetMs * 1.45);
        const comfortable = s.frameMs < Math.max(22, targetMs * 1.12);
        slow = tooSlow ? slow + 1 : 0;
        fast = comfortable ? fast + 1 : 0;
        let next = s.level;
        if (slow >= 2 && next < 3) { next++; s.reason = 'sustained slow frames'; }
        else if (fast >= 12 && next > floor()) { next--; s.reason = 'sustained recovery'; }
        if (next === s.level) return false;
        s.level = next; s.changes++; reset(now); return true;
    }
    setMode(s.mode);
    return { state: s, reset, setMode, sample };
}

// Retain the pacing phase rather than restarting an interval after each draw.
// Otherwise 30 Hz on a 75 Hz display becomes a permanent 25 Hz (40 ms),
// which falsely looks too slow to the controller's recovery window.
export function pacedFrameTime(now, previous, hz = 0) {
    if (!hz || !Number.isFinite(previous) || now < previous - 1) return now;
    const interval = 1000 / hz, elapsed = now - previous;
    if (elapsed < interval - .5) return null;
    return previous + Math.max(1, Math.floor((elapsed + .5) / interval)) * interval;
}
