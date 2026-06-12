import * as THREE from "three";
import { STARS, PL, LY_SCENE, K, FUEL_DV0, SEC_YEAR, warpLabel } from "./constants.js";
import { G } from "./state.js";
import { fmtDist } from "./format.js";
import { AP } from "./autopilot.js";

// Three cockpit MFDs drawn into CanvasTextures: ATTITUDE (heading tape +
// prograde/retrograde), NAV (osculating-orbit minimap around the dominant
// body), SYS (drive gauges + autopilot + target). Redrawn every other frame.
const W = 512, H = 384;
const canvases = [0, 1, 2].map(() => {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    return cv;
});
export const mfdTextures = canvases.map(cv => {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
});

const BG = "#06090d", GRID = "#13202b", TXT = "#cfe8f6", DIM = "#5d7587";
const ACC = "#7cc4f2", OK = "#58c87f", WARN = "#ff8a73", GOLD = "#ffd34d";

function header(ctx, label) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 2;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.fillStyle = DIM;
    ctx.font = "600 17px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(label, 16, 28);
}
const norm = a => ((a % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;

// ---- MFD 0: attitude / heading tape ----
function drawAttitude(ctx, oi) {
    header(ctx, "ATTITUDE");
    const hdg = (-G.heading * 180 / Math.PI % 360 + 360) % 360; // compass-style
    const cy = 120;
    ctx.save();
    ctx.beginPath();
    ctx.rect(16, 60, W - 32, 110);
    ctx.clip();
    ctx.font = "15px ui-monospace, monospace";
    ctx.textAlign = "center";
    const pxPerDeg = 3.4;
    for (let d = -80; d <= 80; d += 5) {
        const deg = Math.round((hdg + d) / 5) * 5;
        const off = (deg - hdg + 540) % 360 - 180;
        const x = W / 2 + off * pxPerDeg;
        const major = ((deg % 30) + 360) % 360 === 0;
        ctx.strokeStyle = major ? TXT : GRID;
        ctx.beginPath();
        ctx.moveTo(x, cy + 22);
        ctx.lineTo(x, cy + (major ? 4 : 14));
        ctx.stroke();
        if (major) {
            ctx.fillStyle = DIM;
            ctx.fillText(String(((deg % 360) + 360) % 360).padStart(3, "0"), x, cy - 6);
        }
    }
    // prograde / retrograde carets relative to nose
    if (!G.landed) {
        const vAng = Math.atan2(G.vy, G.vx);
        for (const [ang, col, sym] of [[vAng, OK, "▲"], [vAng + Math.PI, WARN, "▼"]]) {
            const off = norm(G.heading - ang) * 180 / Math.PI; // nose-relative, screen-right = turn right
            if (Math.abs(off) < 82) {
                ctx.fillStyle = col;
                ctx.font = "17px ui-monospace, monospace";
                ctx.fillText(sym, W / 2 - off * pxPerDeg, cy + 44);
            }
        }
    }
    ctx.restore();
    // nose marker
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(W / 2, cy - 2);
    ctx.lineTo(W / 2, cy + 26);
    ctx.stroke();
    ctx.fillStyle = TXT;
    ctx.font = "700 30px ui-monospace, monospace";
    ctx.textAlign = "center";
    ctx.fillText(String(Math.round(hdg)).padStart(3, "0") + "°", W / 2, 222);
    ctx.font = "16px ui-monospace, monospace";
    ctx.fillStyle = G.hold ? OK : DIM;
    ctx.fillText(G.hold === "pro" ? "HOLD PROGRADE" : G.hold === "retro" ? "HOLD RETROGRADE" : "MANUAL", W / 2, 252);
    // bottom: speed/alt
    ctx.textAlign = "left";
    ctx.fillStyle = DIM;
    ctx.font = "15px ui-monospace, monospace";
    ctx.fillText("VEL", 26, 305);
    ctx.fillText("ALT " + oi.body, 26, 345);
    ctx.fillStyle = TXT;
    ctx.font = "700 21px ui-monospace, monospace";
    ctx.fillText(Math.hypot(G.vx, G.vy).toFixed(3) + " km/s", 110, 305);
    ctx.fillText(fmtDist(Math.max(0, oi.r - oi.R)), 110, 345);
}

// ---- MFD 1: nav orbit map ----
function drawNav(ctx, oi) {
    header(ctx, "NAV · " + oi.body);
    const cx = W / 2, cy = H / 2 + 14;
    // scale: fit the larger of current radius and apoapsis
    const fit = Math.max(oi.r * 1.15, oi.ra !== Infinity ? oi.ra * 1.08 : oi.r * 2.2, oi.R * 2.5);
    const s = 150 / fit;
    // dominant body
    ctx.fillStyle = "#27405a";
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(3, oi.R * s), 0, 7);
    ctx.fill();
    ctx.strokeStyle = GRID;
    ctx.stroke();
    // osculating ellipse from the eccentricity vector (2D, exact)
    const { rx, ry, rvx, rvy, mu, e, E } = oi;
    if (E < 0 && e < .999 && mu > 1) {
        const h = rx * rvy - ry * rvx;
        const v2 = rvx * rvx + rvy * rvy, r = Math.hypot(rx, ry);
        const ex = ((v2 - mu / r) * rx - (rx * rvx + ry * rvy) * rvx) / mu;
        const ey = ((v2 - mu / r) * ry - (rx * rvx + ry * rvy) * rvy) / mu;
        const a = -mu / (2 * E);
        const peri = Math.atan2(ey, ex);
        const b = a * Math.sqrt(Math.max(0, 1 - e * e));
        ctx.strokeStyle = ACC;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i <= 96; i++) {
            const th = i / 96 * Math.PI * 2;
            // ellipse around focus: r(ν) = p/(1+e cos ν), rotated by peri
            const rr = a * (1 - e * e) / (1 + e * Math.cos(th));
            const px = cx + rr * Math.cos(th + peri) * s;
            const py = cy - rr * Math.sin(th + peri) * s * (h >= 0 ? 1 : 1);
            i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.stroke();
        // apo / peri markers
        ctx.fillStyle = GOLD;
        ctx.beginPath();
        ctx.arc(cx + oi.rp * Math.cos(peri) * s, cy - oi.rp * Math.sin(peri) * s, 4, 0, 7);
        ctx.fill();
        if (oi.ra !== Infinity) {
            ctx.fillStyle = WARN;
            ctx.beginPath();
            ctx.arc(cx - oi.ra * Math.cos(peri) * s, cy + oi.ra * Math.sin(peri) * s, 4, 0, 7);
            ctx.fill();
        }
    }
    // ship + velocity
    const sx = cx + rx * s, sy = cy - ry * s;
    ctx.fillStyle = "#ff7a5e";
    ctx.beginPath();
    ctx.arc(sx, sy, 5, 0, 7);
    ctx.fill();
    const vm = Math.hypot(rvx, rvy) || 1;
    ctx.strokeStyle = "#ff7a5e";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + rvx / vm * 26, sy - rvy / vm * 26);
    ctx.stroke();
    // readouts
    ctx.font = "15px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillStyle = DIM;
    ctx.fillText("APO", 22, H - 44);
    ctx.fillText("PERI", 22, H - 20);
    ctx.fillStyle = TXT;
    ctx.fillText(oi.ra === Infinity ? "ESCAPE" : fmtDist(Math.max(0, oi.ra - oi.R)), 75, H - 44);
    ctx.fillText(fmtDist(Math.max(0, oi.rp - oi.R)), 75, H - 20);
    ctx.fillStyle = DIM;
    ctx.textAlign = "right";
    ctx.fillText("e " + oi.e.toFixed(3), W - 22, H - 44);
    ctx.fillText(oi.E < 0 ? "BOUND" : "HYPERBOLIC", W - 22, H - 20);
}

// ---- MFD 2: systems / drive / target ----
function bar(ctx, x, y, w, frac, col) {
    ctx.fillStyle = "#111922";
    ctx.fillRect(x, y, w, 13);
    ctx.fillStyle = col;
    ctx.fillRect(x, y, w * Math.min(1, Math.max(0, frac)), 13);
    ctx.strokeStyle = GRID;
    ctx.strokeRect(x, y, w, 13);
}
function targetInfo() {
    const f = G.focus;
    const m = typeof f === "string" && f.match(/^star:(\d+)$/);
    if (m) {
        const st = STARS[+m[1]];
        return { name: st.name, dist: null, star: st };
    }
    if (typeof f === "number") return { name: PL[f].name };
    if (f === "moon" || f === "earth" || f === "sun") return { name: f.toUpperCase() };
    return null;
}
function drawSys(ctx, oi, eph) {
    header(ctx, "SYS · DRIVE");
    ctx.font = "15px ui-monospace, monospace";
    ctx.textAlign = "left";
    const rows = [
        ["THROTTLE", Math.round(G.throttle * 100) + "%", Math.min(1, G.throttle), ACC],
        ["FUEL Δv", G.infinite ? "∞" : Math.round(G.fuel) + " m/s", G.infinite ? 1 : G.fuel / FUEL_DV0, G.infinite || G.fuel / FUEL_DV0 > .15 ? OK : WARN],
    ];
    let y = 64;
    for (const [lab, val, frac, col] of rows) {
        ctx.fillStyle = DIM;
        ctx.fillText(lab, 26, y);
        ctx.fillStyle = TXT;
        ctx.fillText(val, 150, y);
        bar(ctx, 280, y - 12, 200, frac, col);
        y += 38;
    }
    ctx.fillStyle = DIM;
    ctx.fillText("WARP", 26, y);
    ctx.fillStyle = G.warp > 30 * SEC_YEAR ? GOLD : TXT;
    ctx.fillText(warpLabel(G.warp) + (G.paused ? " · PAUSED" : ""), 150, y);
    y += 38;
    ctx.fillStyle = DIM;
    ctx.fillText("Δv USED", 26, y);
    ctx.fillStyle = TXT;
    ctx.fillText(Math.round(G.dvUsed) + " m/s", 150, y);
    y += 50;
    // autopilot block
    ctx.strokeStyle = GRID;
    ctx.strokeRect(16, y - 26, W - 32, 88);
    ctx.fillStyle = AP.mode !== "off" ? OK : DIM;
    ctx.font = "600 16px ui-monospace, monospace";
    ctx.fillText("AUTOPILOT · " + AP.mode.toUpperCase() + (AP.phase ? " · " + AP.phase.toUpperCase() : ""), 26, y);
    ctx.font = "15px ui-monospace, monospace";
    ctx.fillStyle = TXT;
    const t = targetInfo();
    ctx.fillText(AP.mode !== "off" ? (AP.msg || "") : t ? "FOCUS " + t.name + " · ⇧T TRAVEL · ⇧C CIRCULARIZE" : "SET FOCUS, THEN ⇧T", 26, y + 26);
    ctx.fillStyle = DIM;
    ctx.fillText(AP.mode !== "off" ? "ANY MANUAL INPUT TAKES OVER · ⇧X CANCEL" : "⇧X CANCEL", 26, y + 50);
}

let tick = 0;
export function updateInstruments(oi, eph) {
    if (tick++ % 2) return; // 30 Hz is plenty for canvas MFDs
    drawAttitude(canvases[0].getContext("2d"), oi);
    drawNav(canvases[1].getContext("2d"), oi);
    drawSys(canvases[2].getContext("2d"), oi, eph);
    for (const t of mfdTextures) t.needsUpdate = true;
}
