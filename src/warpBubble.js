// Alcubierre (1994), gr-qc/0009013, equations 6, 12 and 19.
// Analytic prescribed geometry, NOT a solved matter evolution or engine.
// Coordinates below are bubble-radius units; beta = coordinate speed / c.
export const BUBBLE_SIGMA = 5;
export function bubbleShape(r, sigma = BUBBLE_SIGMA) {
    const a = Math.tanh(sigma * (r + 1)), b = Math.tanh(sigma * (r - 1));
    const norm = 2 * Math.tanh(sigma);
    return { f: (a - b) / norm, df: sigma * (b*b - a*a) / norm };
}
export function bubbleMetric(x, y, z, beta = 1) {
    const r = Math.hypot(x,y,z), { f, df } = bubbleShape(r);
    const axial = r > 1e-12 ? y/r : 0;
    // y is the forward direction. theta * R/c, rho * G R²/c⁴.
    return { f, shift: -beta*f, expansion: beta*df*axial,
        energy: -beta*beta*df*df*(1-axial*axial)/(32*Math.PI) };
}
export const WARP_C = 299792.458; // km/s
export const WARP_MAX_C = 1e9; // numerical/navigation guard, not a physics limit
export const WARP_MAX_LOG = Math.log1p(WARP_MAX_C*WARP_C);
export function createWarpState() {
    return { enabled:false, logSpeed:0, rate:0, speed:0, meanSpeed:0,
        dx:1, dy:0, dz:0, phase:'off', limited:false, reason:'' };
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
export function warpSpeedLabel(speed) {
    if (!(speed>0)) return '0 km/s';
    return speed<WARP_C ? `${speed<100?speed.toFixed(2):speed.toFixed(0)} km/s` :
        `${(speed/WARP_C).toLocaleString('en-US',{maximumFractionDigits:2})} c`;
}
