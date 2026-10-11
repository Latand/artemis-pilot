// Hypothetical warp sandbox: Alcubierre (1994), gr-qc/0009013, eqs. 6, 8, 12, 19,
// read through Natário (2002), gr-qc/0110086. Every metric of the form
//   ds² = −c²dt² + Σ (dxⁱ − Xⁱ dt)²
// is fixed by one shift field X: Eulerian (normal) observers move at X and
// their volume expansion is θ = ∇·X. The gravity river already draws such a
// field (Painlevé–Gullstrand, X = −√(2μ/r) r̂ per mass); Alcubierre's choice is
// X = v_s f(r_s) n̂. This is a prescribed geometry. It is neither a solved
// matter evolution nor a demonstrated engine, and summing it with the river
// is a visualization superposition that solves no Einstein equations.
// Coordinates below are bubble-radius units; beta = coordinate speed / c.
export const BUBBLE_SIGMA = 1.8; // σR: a thick wall, so the field fades over ~R
const TANH_SIGMA = Math.tanh(BUBBLE_SIGMA);
// Alcubierre eq. 6; df is R·df/dr.
export function bubbleShape(r, sigma = BUBBLE_SIGMA) {
    const a = Math.tanh(sigma * (r + 1)), b = Math.tanh(sigma * (r - 1));
    const norm = 2 * Math.tanh(sigma);
    return { f: (a - b) / norm, df: sigma * (b*b - a*a) / norm };
}
// y is the forward direction. shift is the metric shift β^y = −βf (eq. 8);
// expansion θ·R/c (eq. 12); energy ρ·G R²/c⁴ seen by Eulerian observers (eq. 19).
export function bubbleMetric(x, y, z, beta = 1, sigma = BUBBLE_SIGMA) {
    const r = Math.hypot(x,y,z), { f, df } = bubbleShape(r, sigma);
    const axial = r > 1e-12 ? y/r : 0;
    return { f, shift: -beta*f, expansion: beta*df*axial,
        energy: -beta*beta*df*df*(1-axial*axial)/(32*Math.PI) };
}
// Chart moving with the ship (x' = x − ∫v_s n̂ dt) keeps the same metric form
// with X' = X − v_s n̂: calm interior, contraction ahead, expansion behind.
// Returned in units of v_s along n̂. Mirrors BUBBLE_GLSL in river.js.
export function bubbleComovingFlow(r, frameW = 1, sigma = BUBBLE_SIGMA) {
    return bubbleShape(r, sigma).f - frameW;
}
export const WARP_C = 299792.458; // km/s
export const WARP_MAX_C = 1e9; // numerical/navigation guard of this simulation
export const WARP_MAX_LOG = Math.log1p(WARP_MAX_C*WARP_C);
// Display-only regime of the coordinate speed, 0 at rest to 1 at the guard.
export function warpRegime(speed) {
    return speed > 0 ? Math.min(1, Math.log1p(speed) / WARP_MAX_LOG) : 0;
}
// Seconds of model time the river plays per second of sim time. One uniform
// factor (≤ 1) keeps every direction and speed ratio of the flow while the
// stream past the ship stays slow enough to follow single markers: it grows
// from ~0.3 to ~1.2 bubble radii per second as the coordinate speed rises
// through 18 decades.
export const WARP_STREAM_MIN = .3, WARP_STREAM_GAIN = .9;
export function warpDisplayRate(speed, radiusKm) {
    if (!(speed > 0) || !(radiusKm > 0)) return 1;
    return Math.min(1, (WARP_STREAM_MIN + WARP_STREAM_GAIN * warpRegime(speed)) * radiusKm / speed);
}
export function createWarpState() {
    return { enabled:false, logSpeed:0, rate:0, speed:0, meanSpeed:0,
        dx:1, dy:0, dz:0, phase:'off', limited:false, reason:'',
        shiftX:0, shiftY:0, shiftZ:0 };
}
export const WARP = createWarpState();
export function resetWarp(s = WARP) { Object.assign(s,createWarpState()); }
export function stopWarp(s = WARP, reason = '') {
    s.logSpeed=0; s.rate=0; s.speed=0; s.meanSpeed=0;
    s.phase=s.enabled?'ready':'off'; s.reason=reason; s.limited=false;
}
export function stepWarp(s, command, throttle, boost, dt, allowed = true) {
    if (!s.enabled) { stopWarp(s); return s; }
    if (!allowed || !(dt>0) || !Number.isFinite(dt)) { s.meanSpeed=0; return s; }
    dt=Math.min(dt,.1); // no background-tab catch-up
    command=Number.isFinite(command)?Math.max(-1,Math.min(1,command)):0;
    throttle=Number.isFinite(throttle)?Math.max(0,Math.min(100,throttle)):1;
    if (command>0) s.reason='';
    const target=command>0 ? .85*Math.min(3,Math.sqrt(throttle))*(boost?2:1) : command<0 ? -3.5 : 0;
    const tau=.5, q0=s.logSpeed, r0=s.rate;
    const at=t=>Math.max(0,Math.min(WARP_MAX_LOG,q0+target*t+(r0-target)*tau*(-Math.expm1(-t/tau))));
    const v=t=>Math.expm1(at(t));
    s.meanSpeed=(v(0)+4*v(dt/2)+v(dt))/6;
    s.logSpeed=at(dt); s.speed=Math.expm1(s.logSpeed);
    s.rate=target+(r0-target)*Math.exp(-dt/tau);
    if (s.logSpeed===0 && s.rate<0) s.rate=0;
    if (s.logSpeed===WARP_MAX_LOG && s.rate>0) s.rate=0;
    s.limited=s.logSpeed===WARP_MAX_LOG;
    s.phase=s.limited?'numerical limit':command<0?'braking':command>0?'ramping':s.speed>0?'cruise':'ready';
    return s;
}
// The bubble axis turns toward the commanded heading at a bounded angular
// rate with an eased start, so a turn bends the path and the field smoothly.
// At rest the axis simply follows the hull.
export function steerWarp(s, hx, hy, hz, dt, tau = .45) {
    const hn = Math.hypot(hx, hy, hz);
    if (!(hn > 0) || !Number.isFinite(hn)) return s;
    hx /= hn; hy /= hn; hz /= hn;
    if (!(s.speed > 0)) { s.dx = hx; s.dy = hy; s.dz = hz; return s; }
    if (!(dt > 0)) return s; // paused: the moving bubble keeps its axis
    const dot = Math.max(-1, Math.min(1, s.dx*hx + s.dy*hy + s.dz*hz));
    const angle = Math.acos(dot);
    if (angle < 1e-9) { s.dx = hx; s.dy = hy; s.dz = hz; return s; }
    let ax = s.dy*hz - s.dz*hy, ay = s.dz*hx - s.dx*hz, az = s.dx*hy - s.dy*hx;
    let an = Math.hypot(ax, ay, az);
    if (an < 1e-9) { // exactly opposite: turn about any perpendicular axis
        ax = -s.dy; ay = s.dx; az = 0; an = Math.hypot(ax, ay);
        if (an < 1e-9) { ax = 1; ay = 0; az = 0; an = 1; }
    }
    ax /= an; ay /= an; az /= an;
    const step = angle * -Math.expm1(-Math.min(dt, .1) / tau);
    const c = Math.cos(step), sn = Math.sin(step), k = (ax*s.dx + ay*s.dy + az*s.dz) * (1 - c);
    const nx = s.dx*c + (ay*s.dz - az*s.dy)*sn + ax*k;
    const ny = s.dy*c + (az*s.dx - ax*s.dz)*sn + ay*k;
    const nz = s.dz*c + (ax*s.dy - ay*s.dx)*sn + az*k;
    const nn = Math.hypot(nx, ny, nz);
    s.dx = nx/nn; s.dy = ny/nn; s.dz = nz/nn;
    return s;
}
// Bubble transport since the river last re-anchored its particles, in km.
export function noteWarpShift(dx, dy, dz, s = WARP) { s.shiftX += dx; s.shiftY += dy; s.shiftZ += dz; }
export function takeWarpShift(out, s = WARP) {
    out[0] = s.shiftX; out[1] = s.shiftY; out[2] = s.shiftZ;
    s.shiftX = 0; s.shiftY = 0; s.shiftZ = 0;
    return out;
}
// At most 8 characters, so the HUD cell keeps its unit on a 360 px phone
// at every speed up to the guard: m/s, km/s, then c with k/M/B multiples.
const WARP_MULTIPLES = [[1, ''], [1e3, 'k'], [1e6, 'M'], [1e9, 'B']];
export function warpSpeedLabel(speed) {
    if (!(speed > 0)) return '0 km/s';
    if (speed < 1) return `${Math.round(speed * 1000)} m/s`;
    if (speed < 999.5) return `${speed < 9.95 ? speed.toFixed(1) : speed.toFixed(0)} km/s`;
    const c = speed / WARP_C;
    if (c < .00995) return `${c.toFixed(4)} c`;
    if (c < 9.995) return `${c.toFixed(2)} c`;
    for (const [unit, name] of WARP_MULTIPLES) {
        const m = c / unit;
        if (m < 999.5 || unit === 1e9) return `${m.toFixed(m < 9.995 ? 2 : m < 99.95 ? 1 : 0)}${name} c`;
    }
}
