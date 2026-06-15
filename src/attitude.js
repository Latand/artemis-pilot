// Compact attitude / heading dial — the 2D-ecliptic "navball" this sim was missing.
// Nose is fixed at the top; the prograde (green) and retrograde (red) markers ride
// the ring at (velocityAngle − heading), so the pilot can see exactly how far to
// rotate to align with — or against — the velocity vector.
const TAU = Math.PI * 2;
let cv = null, ctx = null, dpr = 1, R = 1, cx = 0, cy = 0;

export function initAttitude(canvas) {
    cv = canvas;
    if (!cv) return;
    ctx = cv.getContext("2d");
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const css = cv.clientWidth || 128;
    cv.width = Math.round(css * dpr);
    cv.height = Math.round(css * dpr);
    cx = cv.width / 2; cy = cv.height / 2;
    R = Math.min(cv.width, cv.height) * 0.40;
}

function ringPoint(rel, r) { return [cx + Math.sin(rel) * r, cy - Math.cos(rel) * r]; }

function marker(rel, color, filled) {
    const [x, y] = ringPoint(rel, R);
    ctx.lineWidth = 1.6 * dpr;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 5.2 * dpr, 0, TAU);
    filled ? ctx.fill() : ctx.stroke();
    // little center pip + radial ticks for the prograde "sun" look
    ctx.beginPath();
    ctx.moveTo(x - 7.5 * dpr, y); ctx.lineTo(x - 4 * dpr, y);
    ctx.moveTo(x + 4 * dpr, y); ctx.lineTo(x + 7.5 * dpr, y);
    ctx.moveTo(x, y - 7.5 * dpr); ctx.lineTo(x, y - 4 * dpr);
    ctx.stroke();
}

// heading, velAngle in radians (atan2, CCW from +x). Both world-frame.
export function drawAttitude(heading, velAngle, moving) {
    if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);

    // outer ring
    ctx.lineWidth = 1.4 * dpr;
    ctx.strokeStyle = "rgba(126,158,190,.4)";
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();

    // 30° ticks
    ctx.strokeStyle = "rgba(126,158,190,.28)";
    ctx.lineWidth = 1 * dpr;
    for (let i = 0; i < 12; i++) {
        const a = i / 12 * TAU;
        const r2 = R - (i % 3 === 0 ? 8 : 4.5) * dpr;
        const [x1, y1] = ringPoint(a, R), [x2, y2] = ringPoint(a, r2);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    if (moving) {
        const pro = velAngle - heading;
        marker(pro, "#54e0a4", false);            // prograde — green
        marker(pro + Math.PI, "#ff5a36", false);  // retrograde — red
    }

    // nose marker: fixed triangle at the top
    ctx.fillStyle = "#ffd36b";
    ctx.beginPath();
    ctx.moveTo(cx, cy - R - 3 * dpr);
    ctx.lineTo(cx - 6 * dpr, cy - R + 9 * dpr);
    ctx.lineTo(cx + 6 * dpr, cy - R + 9 * dpr);
    ctx.closePath(); ctx.fill();
    // nose down-line to centre
    ctx.strokeStyle = "rgba(255,211,107,.5)";
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath(); ctx.moveTo(cx, cy - R + 9 * dpr); ctx.lineTo(cx, cy - R * 0.42); ctx.stroke();

    // centre hub
    ctx.fillStyle = "rgba(234,241,251,.92)";
    ctx.beginPath(); ctx.arc(cx, cy, 2.4 * dpr, 0, TAU); ctx.fill();
}
