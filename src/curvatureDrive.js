// Fictional, local effective-field drive. This is not a GR metric/solver,
// reactionless-engine prediction, or FTL model. Natural gravity is untouched.
// Phi(r) = -(a . r) (1 - |r/R|^2)^3 inside R, zero outside.
// The ship samples -grad(Phi) at its centre. R is a display-normalized
// envelope radius, not a claimed engineering dimension or source of gravity.
export const DRIVE_MAX_ACCEL = 2.5; // km/s²; bounds the existing 100x/boost envelope
export const DRIVE_RESPONSE_SEC = .18; // operator-time field response, not universe time
export const DRIVE_NOMINAL_ACCEL = .006;
export function createDriveState() {
    return { x: 0, y: 0, z: 0, ax: 0, ay: 0, az: 0, magnitude: 0, level: 0, engaged: false };
}
export const DRIVE = createDriveState();
export function resetDrive(state = DRIVE) { Object.assign(state, createDriveState()); return state; }

// Returns the exact frame-average of the exponential actuator response;
// partitioning one held command into 30/60/144 Hz frames preserves delta-v.
// Release is an immediate field disconnect, preserving exact ballistic coast.
export function stepDrive(state, ax, ay, az, dtReal, allowed = true) {
    if (!allowed || !Number.isFinite(ax + ay + az) || !(dtReal > 0) || !Number.isFinite(dtReal)) return resetDrive(state);
    const command = Math.hypot(ax, ay, az);
    if (!(command > 0)) return resetDrive(state);
    const cap = Math.min(1, DRIVE_MAX_ACCEL / command);
    ax *= cap; ay *= cap; az *= cap;
    const dt = Math.min(.25, dtReal);
    const decay = Math.exp(-dt / DRIVE_RESPONSE_SEC);
    const average = DRIVE_RESPONSE_SEC * (1 - decay) / dt;
    state.ax = ax + (state.x - ax) * average;
    state.ay = ay + (state.y - ay) * average;
    state.az = az + (state.z - az) * average;
    state.x = ax + (state.x - ax) * decay;
    state.y = ay + (state.y - ay) * decay;
    state.z = az + (state.z - az) * decay;
    state.magnitude = Math.hypot(state.ax, state.ay, state.az);
    state.level = Math.min(1, Math.sqrt(state.magnitude / DRIVE_NOMINAL_ACCEL));
    state.engaged = state.magnitude > 0;
    return state;
}

export function drivePotential(x, y, z, ax, ay, az, radius = 1) {
    if (!(radius > 0) || !Number.isFinite(radius + x + y + z + ax + ay + az)) return 0;
    const q = (x*x + y*y + z*z) / (radius*radius);
    return q < 1 ? -(ax*x + ay*y + az*z) * (1-q)**3 : 0;
}
export function sampleDriveGradient(out, x, y, z, ax, ay, az, radius = 1) {
    const q = (x*x + y*y + z*z) / (radius*radius);
    if (!(radius > 0) || !Number.isFinite(q + ax + ay + az) || q >= 1) { out[0]=out[1]=out[2]=0; return out; }
    const s = 1-q, radial = 6 * (ax*x + ay*y + az*z) * s*s / (radius*radius);
    out[0] = ax*s*s*s - radial*x;
    out[1] = ay*s*s*s - radial*y;
    out[2] = az*s*s*s - radial*z;
    return out;
}
