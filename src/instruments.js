import * as THREE from "three";
import { STARS, PL, LY_SCENE, K, FUEL_DV0, SEC_YEAR, warpLabel } from "./constants.js";
import { G } from "./state.js";
import { fmtDist } from "./format.js";
import { AP } from "./autopilot.js";
import { activeStarForFocus } from "./universe/activeStars.js";

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
    ctx.font = "600 20px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(label, 16, 30);
}
const norm = a => ((a % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;

// ---- MFD 0: attitude / heading tape ----
function drawAttitude(ctx, oi) {
    header(ctx, "ATTITUDE");
    // vel/alt share the top row — the screen bottom can sit behind the deck
    ctx.font = "17px ui-monospace, monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = TXT;
    ctx.fillText(Math.hypot(G.vx, G.vy, G.vz).toFixed(3) + " km/s", W - 16, 30);
    ctx.fillStyle = DIM;
    ctx.fillText("ALT " + fmtDist(Math.max(0, oi.r - oi.R)), W - 16, 56);
    const hdg = (-G.heading * 180 / Math.PI % 360 + 360) % 360; // compass-style
    const cy = 120;
    ctx.save();
    ctx.beginPath();
    ctx.rect(16, 60, W - 32, 110);
    ctx.clip();
    ctx.font = "17px ui-monospace, monospace";
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
    ctx.font = "18px ui-monospace, monospace";
    ctx.fillStyle = G.hold ? OK : DIM;
    ctx.fillText(G.hold === "pro" ? "HOLD PROGRADE" : G.hold === "retro" ? "HOLD RETROGRADE" : "MANUAL", W / 2, 252);
}

// ---- MFD 1: nav orbit map ----
function drawNav(ctx, oi) {
    header(ctx, "NAV · " + oi.body);
    // readouts live at the TOP: the screen tilts away, the bottom forshortens
    ctx.font = "17px ui-monospace, monospace";
    ctx.fillStyle = DIM;
    ctx.fillText("APO", 16, 62);
    ctx.fillText("PERI", 16, 86);
    ctx.fillStyle = TXT;
    ctx.fillText(oi.ra === Infinity ? "ESCAPE" : fmtDist(Math.max(0, oi.ra - oi.R)), 76, 62);
    ctx.fillText(fmtDist(Math.max(0, oi.rp - oi.R)), 76, 86);
    ctx.textAlign = "right";
    ctx.fillStyle = DIM;
    ctx.fillText("e " + oi.e.toFixed(3), W - 16, 62);
    ctx.fillText(oi.E < 0 ? "BOUND" : "HYPERBOLIC", W - 16, 86);
    ctx.textAlign = "left";
    const cx = W / 2, cy = H / 2 + 44;
    // scale: fit the larger of current radius and apoapsis
    const fit = Math.max(oi.r * 1.15, oi.ra !== Infinity ? oi.ra * 1.08 : oi.r * 2.2, oi.R * 2.5);
    const s = 132 / fit;
    // range rings every half-fit for instant scale reading
    ctx.strokeStyle = GRID;
    ctx.setLineDash([3, 5]);
    for (const f of [.5, 1]) {
        ctx.beginPath();
        ctx.arc(cx, cy, 132 * f, 0, 7);
        ctx.stroke();
    }
    ctx.setLineDash([]);
    // dominant body
    ctx.fillStyle = "#3a587a";
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(5, oi.R * s), 0, 7);
    ctx.fill();
    ctx.strokeStyle = "#5f87ad";
    ctx.stroke();
    // osculating ellipse from the eccentricity vector (2D, exact)
    const { rx, ry, rvx, rvy, mu, e, E } = oi;
    if (E < 0 && e < .999 && mu > 1) {
        const v2 = rvx * rvx + rvy * rvy, r = Math.hypot(rx, ry);
        const ex = ((v2 - mu / r) * rx - (rx * rvx + ry * rvy) * rvx) / mu;
        const ey = ((v2 - mu / r) * ry - (rx * rvx + ry * rvy) * rvy) / mu;
        const a = -mu / (2 * E);
        const peri = Math.atan2(ey, ex);
        ctx.strokeStyle = "#9fd8ff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i <= 96; i++) {
            const th = i / 96 * Math.PI * 2;
            // ellipse around focus: r(ν) = p/(1+e cos ν), rotated by peri
            const rr = a * (1 - e * e) / (1 + e * Math.cos(th));
            const px = cx + rr * Math.cos(th + peri) * s;
            const py = cy - rr * Math.sin(th + peri) * s;
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
    ctx.arc(sx, sy, 7, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(sx, sy, 2.6, 0, 7);
    ctx.fill();
    const vm = Math.hypot(rvx, rvy) || 1;
    ctx.strokeStyle = "#ff7a5e";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + rvx / vm * 30, sy - rvy / vm * 30);
    ctx.stroke();
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
    const proc = activeStarForFocus(f);
    if (proc) return { name: proc.name, dist: null, star: proc };
    if (typeof f === "number") return { name: PL[f].name };
    if (f === "moon" || f === "earth" || f === "sun") return { name: f.toUpperCase() };
    return null;
}
function drawSys(ctx, oi, eph) {
    header(ctx, "SYS · DRIVE");
    ctx.font = "17px ui-monospace, monospace";
    ctx.textAlign = "left";
    // two-column top layout: everything important above the deck line
    ctx.fillStyle = DIM;
    ctx.fillText("THR", 16, 60);
    ctx.fillStyle = TXT;
    ctx.fillText(Math.round(G.throttle * 100) + "%", 64, 60);
    bar(ctx, 140, 48, 96, Math.min(1, G.throttle), ACC);
    ctx.fillStyle = DIM;
    ctx.fillText("FUEL", 16, 86);
    ctx.fillStyle = G.infinite || G.fuel / FUEL_DV0 > .15 ? TXT : WARN;
    ctx.fillText(G.infinite ? "∞" : Math.round(G.fuel) + " m/s", 64, 86);
    if (!G.infinite) bar(ctx, 140, 74, 96, G.fuel / FUEL_DV0, G.fuel / FUEL_DV0 > .15 ? OK : WARN);
    ctx.fillStyle = DIM;
    ctx.fillText("WARP", 256, 60);
    ctx.fillStyle = G.warp > 30 * SEC_YEAR ? GOLD : TXT;
    ctx.fillText(warpLabel(G.warp) + (G.paused ? " ❚❚" : ""), 318, 60);
    ctx.fillStyle = DIM;
    ctx.fillText("Δv", 256, 86);
    ctx.fillStyle = TXT;
    ctx.fillText(Math.round(G.dvUsed).toLocaleString("en-US") + " m/s", 318, 86);
    // autopilot strip directly below — still in the visible band
    const apOn = AP.mode !== "off";
    ctx.fillStyle = apOn ? OK : DIM;
    ctx.font = "600 18px ui-monospace, monospace";
    ctx.fillText("AP · " + (apOn ? AP.mode.toUpperCase() + (AP.phase ? " · " + AP.phase.toUpperCase() : "") : "OFF"), 16, 122);
    ctx.font = "17px ui-monospace, monospace";
    ctx.fillStyle = TXT;
    const t = targetInfo();
    ctx.fillText(apOn ? (AP.msg || "") : t ? "FOCUS " + t.name + " · ⇧T GO · ⇧C CIRC" : "SET FOCUS, THEN ⇧T", 16, 150);
    ctx.fillStyle = DIM;
    ctx.fillText(apOn ? "MANUAL INPUT TAKES OVER · ⇧X OFF" : "⇧C CIRCULARIZE HERE", 16, 176);
    // engine state
    ctx.fillStyle = G.boost ? GOLD : DIM;
    ctx.fillText(G.boost ? "BOOST ×4" : "", 16, 206);
}

let tick = 0;
export function updateInstruments(oi, eph) {
    if (tick++ % 2) return; // 30 Hz is plenty for canvas MFDs
    drawAttitude(canvases[0].getContext("2d"), oi);
    drawNav(canvases[1].getContext("2d"), oi);
    drawSys(canvases[2].getContext("2d"), oi, eph);
    for (const t of mfdTextures) t.needsUpdate = true;
}
