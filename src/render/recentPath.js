// Bounded history of *sampled* motion. A time jump is not a measured chord.
// Coordinates stay float64 until the camera-local GPU upload.
const STRIDE = 8; // x, y, z, simulation time, display time, r, g, b
const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

export class RecentPath {
    constructor(capacity = 768, wallLifetime = 24) {
        if (!Number.isInteger(capacity) || capacity < 2) throw new RangeError('Path capacity must be >= 2');
        this.capacity = capacity;
        this.wallLifetime = wallLifetime;
        this.points = new Float64Array(capacity * STRIDE);
        this.head = new Float64Array(STRIDE);
        this.start = 0; this.count = 0; this.hasHead = false;
        this.lastTime = NaN; this.epoch = null; this.breaks = 0;
    }
    clear() {
        this.start = 0; this.count = 0; this.hasHead = false; this.lastTime = NaN;
    }
    sync(time, epoch) {
        if (!Number.isFinite(time) || (this.epoch !== null && this.epoch !== epoch) ||
            (this.hasHead && time < this.lastTime)) {
            this.clear(); this.breaks++;
        }
        this.epoch = epoch;
    }
    // dtLimit follows the shortest locally relevant orbital timescale. The
    // speed test also breaks teleports made without advancing the clock.
    sample(x, y, z, time, clock, color, { epoch = 0, spacing = 0.02, dtLimit = Infinity, speed = Infinity } = {}) {
        if (![x, y, z, time, clock].every(Number.isFinite)) { this.clear(); return false; }
        let broken = this.epoch !== null && this.epoch !== epoch;
        if (this.hasHead) {
            const dt = time - this.lastTime;
            const d = Math.hypot(x - this.head[0], y - this.head[1], z - this.head[2]);
            if (dt < 0 || dt > dtLimit || d > Math.max(spacing * 8, speed * Math.max(0, dt) * 4)) broken = true;
        }
        if (broken) { this.clear(); this.breaks++; }
        this.epoch = epoch; this.lastTime = time;
        this.head.set([x, y, z, time, clock, color[0], color[1], color[2]]);
        this.hasHead = true;
        let commit = this.count === 0;
        if (!commit) {
            const i = ((this.start + this.count - 1) % this.capacity) * STRIDE;
            const dx = x - this.points[i], dy = y - this.points[i + 1], dz = z - this.points[i + 2];
            const d = Math.hypot(dx, dy, dz);
            commit = d >= spacing;
            if (!commit && this.count > 1 && d > spacing * 0.15) {
                const j = ((this.start + this.count - 2) % this.capacity) * STRIDE;
                const ax = this.points[i] - this.points[j], ay = this.points[i + 1] - this.points[j + 1], az = this.points[i + 2] - this.points[j + 2];
                const a = Math.hypot(ax, ay, az);
                commit = a > 0 && (ax * dx + ay * dy + az * dz) / (a * d) < 0.9986; // three degrees
            }
        }
        if (commit) {
            if (this.count === this.capacity) { this.start = (this.start + 1) % this.capacity; this.count--; }
            this.points.set(this.head, ((this.start + this.count) % this.capacity) * STRIDE);
            this.count++;
        }
        return !broken;
    }
    expire(time, clock, lifetime) {
        while (this.count) {
            const i = this.start * STRIDE;
            if (time - this.points[i + 3] < lifetime && clock - this.points[i + 4] < this.wallLifetime) break;
            this.start = (this.start + 1) % this.capacity; this.count--;
        }
        if (this.hasHead && (time - this.head[3] >= lifetime || clock - this.head[4] >= this.wallLifetime)) this.hasHead = false;
    }
    // Independent line segments cannot connect across a reset or ring wrap.
    // Tail opacity reaches zero before old samples leave the buffer.
    write(positions, colors, alpha, origin, time, clock, lifetime) {
        this.sync(time, this.epoch);
        this.expire(time, clock, lifetime);
        let vertices = 0;
        const emit = (p, i, ordinal) => {
            const o = vertices * 3;
            positions[o] = p[i] - origin[0]; positions[o + 1] = p[i + 1] - origin[1]; positions[o + 2] = p[i + 2] - origin[2];
            colors[o] = p[i + 5]; colors[o + 1] = p[i + 6]; colors[o + 2] = p[i + 7];
            const age = Math.max((time - p[i + 3]) / lifetime, (clock - p[i + 4]) / this.wallLifetime);
            const tail = this.count > 8 ? smooth(ordinal / Math.min(32, this.count * 0.2)) : 1;
            alpha[vertices++] = smooth(1 - age) * tail;
        };
        for (let n = 1; n < this.count; n++) {
            emit(this.points, ((this.start + n - 1) % this.capacity) * STRIDE, n - 1);
            emit(this.points, ((this.start + n) % this.capacity) * STRIDE, n);
        }
        if (this.count && this.hasHead) {
            const i = ((this.start + this.count - 1) % this.capacity) * STRIDE;
            if (Math.hypot(this.head[0] - this.points[i], this.head[1] - this.points[i + 1], this.head[2] - this.points[i + 2]) > 1e-9) {
                emit(this.points, i, this.count - 1); emit(this.head, 0, this.count);
            }
        }
        return vertices;
    }
}
