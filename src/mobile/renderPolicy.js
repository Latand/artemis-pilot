// Mobile budgets are fixed within a quality level. They do not track every
// pinch event or every fast/slow frame, which would repeatedly resize targets.
export const MOBILE_PROFILES = Object.freeze([
    { dpr: 1.15, canvasPixels: 600000, draftPixels: 28000, fullPixels: 160000, refinePixels: 12000 },
    { dpr: 1, canvasPixels: 400000, draftPixels: 16000, fullPixels: 100000, refinePixels: 8000 },
    { dpr: .8, canvasPixels: 240000, draftPixels: 8000, fullPixels: 60000, refinePixels: 4000 },
]);
export function mobileProfile(level = 0) {
    return MOBILE_PROFILES[Math.max(0, Math.min(2, level | 0))];
}
export function pixelRatioForSize(width, height, desired, pixelBudget, maxDimension = 4096) {
    const w = Math.max(1, width), h = Math.max(1, height);
    return Math.min(Math.max(.1, desired || 1), Math.sqrt(pixelBudget / (w * h)), maxDimension / Math.max(w, h));
}
export function boundedTargetSize(width, height, maxPixels, maxScale = 1) {
    const w = Math.max(1, width), h = Math.max(1, height);
    const s = Math.min(maxScale, Math.sqrt(maxPixels / (w * h)));
    return [Math.max(1, Math.floor(w * s)), Math.max(1, Math.floor(h * s))];
}
// A request is applied once after a quiet interval. Unchanged requests do not
// restart the interval; this matters when a layout observer repeats a value.
export class ResizeSettler {
    constructor(delay = 140) { this.delay = delay; this.pending = null; this.applied = null; this.since = 0; }
    request(w, h, ratio, now) {
        const next = [Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), ratio];
        if (this.pending?.every((x, i) => x === next[i])) return;
        if (this.applied?.every((x, i) => x === next[i])) { this.pending = null; return; }
        this.pending = next; this.since = now;
    }
    take(now, immediate = false) {
        if (!this.pending || (!immediate && now - this.since < this.delay)) return null;
        const next = this.pending; this.pending = null; this.applied = next;
        return next;
    }
}
