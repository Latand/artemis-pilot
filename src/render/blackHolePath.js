// A small recent-motion buffer, in inertial scene coordinates. Camera motion
// never enters sampling. Slow bodies retain more real history, not a made-up
// tail; a stationary body cannot accumulate vertices.
import { RecentPath } from './recentPath.js';

export const HOLE_PATH_CAPACITY = 256;
export const HOLE_PATH_MIN_SECONDS = 3;
export const HOLE_PATH_MAX_SECONDS = 18;
// Reset callers stay independent of THREE / scene initialization.
const liveTrails = new Set();
export function registerBlackHoleTrail(trail) { liveTrails.add(trail); }
export function unregisterBlackHoleTrail(trail) { liveTrails.delete(trail); }
export function clearBlackHoleTrails() { for (const trail of liveTrails) trail.clear(); }
const COLOR = [1, .72, .42];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export class BlackHolePath {
    constructor() {
        this.history = new RecentPath(HOLE_PATH_CAPACITY, HOLE_PATH_MAX_SECONDS);
        this.lifetime = HOLE_PATH_MAX_SECONDS;
    }
    clear() { this.history.clear(); this.lifetime = HOLE_PATH_MAX_SECONDS; }
    sample(x, y, z, time, clock, { epoch = 0, scenePerPixel = 1, speed = 0, stepLimit = Infinity, enabled = true } = {}) {
        const h = this.history;
        if (!enabled) { this.clear(); return; }
        h.sync(time, epoch);
        const pixel = Math.max(Number.EPSILON, scenePerPixel);
        let spacing = .35 * pixel;
        if (h.hasHead) {
            const dt = time - h.lastTime;
            const distance = Math.hypot(x - h.head[0], y - h.head[1], z - h.head[2]);
            // A paused camera/scale change is not motion. A same-time edit is
            // a relocation and must not draw a connecting chord.
            if (dt === 0) {
                if (distance === 0) return;
                this.clear();
            } else if (dt > 0) {
                const elapsed = clock - h.head[4];
                if (distance > 0 && elapsed > 0) {
                    const displaySpeed = distance / elapsed;
                    this.lifetime = clamp(24 * pixel / displaySpeed, HOLE_PATH_MIN_SECONDS, HOLE_PATH_MAX_SECONDS);
                    spacing = Math.max(spacing, displaySpeed * this.lifetime / (HOLE_PATH_CAPACITY - 2));
                }
                if (h.count) {
                    const last = ((h.start + h.count - 1) % h.capacity) * 8;
                    // At slow speeds retain subpixel samples too. At most 12
                    // of these per active second fit the full 18-second tail.
                    if (clock - h.points[last + 4] >= 1 / 12 && distance > 0) spacing = 0;
                }
            }
        }
        h.wallLifetime = this.lifetime;
        h.sample(x, y, z, time, clock, COLOR, { epoch, spacing, dtLimit: stepLimit, speed });
    }
    write(positions, colors, fade, origin, time, clock) {
        return this.history.write(positions, colors, fade, origin, time, clock, Infinity);
    }
}
