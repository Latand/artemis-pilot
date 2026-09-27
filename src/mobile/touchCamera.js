// Coalesce both contacts before applying a gesture. Symmetric pinch must not
// detach the camera from its selected object.
export class TouchCameraGesture {
    constructor(apply, active = () => {}) {
        this.apply = apply; this.active = active;
        this.points = new Map(); this.anchor = null; this.changed = false;
    }
    sample() {
        const p = [...this.points.values()];
        if (!p.length) return null;
        if (p.length === 1) return { n: 1, x: p[0].x, y: p[0].y, d: 0 };
        return { n: 2, x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2,
            d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
    }
    down(id, x, y) {
        if (this.points.size >= 2 || !Number.isFinite(x + y)) return;
        this.flush(); this.points.set(id, { x, y }); this.anchor = this.sample(); this.changed = false; this.active(true);
    }
    move(id, x, y) {
        if (!this.points.has(id) || !Number.isFinite(x + y)) return;
        this.points.set(id, { x, y }); this.changed = true; this.active(true);
    }
    up(id, cancelled = false) {
        if (!this.points.has(id)) return;
        if (!cancelled) this.flush();
        this.points.delete(id); this.anchor = this.sample(); this.changed = false; this.active(this.points.size > 0);
    }
    flush() {
        if (!this.changed) return;
        const p = this.sample(), a = this.anchor; this.changed = false; this.anchor = p;
        if (!a || !p || a.n !== p.n) return;
        const dx = p.x - a.x, dy = p.y - a.y;
        const zoom = p.n === 2 && p.d >= 12 && a.d >= 12 ? Math.log(a.d / p.d) : 0;
        // A pathological event cannot jump several universe tiers at once.
        this.apply({ fingers: p.n, dx: Math.max(-100, Math.min(100, dx)), dy: Math.max(-100, Math.min(100, dy)),
            zoom: Math.max(-.22, Math.min(.22, zoom)) });
    }
    cancel() { this.points.clear(); this.anchor = null; this.changed = false; this.active(false); }
}

export function bindTouchCamera(canvas, apply, activity) {
    const gesture = new TouchCameraGesture(apply, activity);
    const touch = e => e.pointerType === 'touch';
    canvas.addEventListener('pointerdown', e => {
        if (!touch(e)) return;
        e.preventDefault();
        gesture.down(e.pointerId, e.clientX, e.clientY);
        try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already cancelled */ }
    });
    window.addEventListener('pointermove', e => { if (touch(e)) gesture.move(e.pointerId, e.clientX, e.clientY); });
    window.addEventListener('pointerup', e => { if (touch(e)) gesture.up(e.pointerId); });
    window.addEventListener('pointercancel', e => { if (touch(e)) gesture.up(e.pointerId, true); });
    canvas.addEventListener('lostpointercapture', e => { if (touch(e)) gesture.up(e.pointerId, true); });
    window.addEventListener('blur', () => gesture.cancel());
    document.addEventListener('visibilitychange', () => { if (document.hidden) gesture.cancel(); });
    // Safari's legacy gesture events are cancelled only over the canvas.
    // Browser accessibility zoom in controls/documents is not disabled globally.
    for (const event of ['gesturestart', 'gesturechange', 'gestureend']) {
        canvas.addEventListener(event, e => e.preventDefault(), { passive: false });
    }
    return gesture;
}
