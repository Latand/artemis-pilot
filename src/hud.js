import { PL, R_EARTH, R_MOON, R_SUN, MU_E, MU_M, MU_S, BH_SIZES, FUEL_DV0, warpLabel } from "./constants.js";
import { G, BH, WORLD } from "./state.js";
import { eph } from "./ephemeris.js";
import { fmtKm, fmtDist, fmtMET, escapeKmS, accelMs2, fmtAccel } from "./format.js";
import { bhHawkingLabel, bhMassLabel, pwAccelMs2 } from "./blackholes.js";
import { clockRateAtShip, clockRateLabel } from "./relativity.js";
import { darkEnergyAccelerationKmS2, darkMatterRelativeAccel } from "./cosmology.js";

const $ = id => document.getElementById(id);
const bhFocusIndex = f => {
    if (typeof f !== "string") return -1;
    const m = f.match(/^bh:(\d+)$/);
    return m ? Number(m[1]) : -1;
};
export const metEl = $("met"), warpEl = $("warpLine"), engineEl = $("engineLine"), throttleEl = $("throttleLine");
export const fuelTxtEl = $("fuelTxt"), fuelFillEl = $("fuelFill");
export const cAltL = $("cAltL"), cAlt = $("cAlt"), cVel = $("cVel"), cApPe = $("cApPe"), cMoon = $("cMoon"), cSun = $("cSun"), cDv = $("cDv"), cGrav = $("cGrav");
export const fFlow = $("fFlow"), fDark = $("fDark"), fHalo = $("fHalo"), fShip = $("fShip"), fClock = $("fClock"), fEsc = $("fEsc"), fEscM = $("fEscM"), fAcc = $("fAcc");
export const flowPanelEl = $("flowPanel"), bannerEl = $("banner"), helpEl = $("help");
export const lblE = $("lblE"), lblM = $("lblM"), lblO = $("lblO"), lblS = $("lblS");

export function showBanner(title, sub, hint) {
    bannerEl.style.display = "block";
    bannerEl.innerHTML = '<div style="font-size:13px;letter-spacing:.22em;color:#fff">' + title +
        '</div><div style="font-size:10px;color:#9fb0c2;margin-top:6px;line-height:1.7;max-width:380px">' + sub +
        '</div><div style="font-size:10px;color:#ff8a73;margin-top:10px;letter-spacing:.1em">' + hint + '</div>';
}
export function hideBanner() { bannerEl.style.display = "none"; }

// help shows on the very first visit only; any dismissal is remembered
export const help = { shown: true };
export function hideHelp() {
    helpEl.style.display = "none";
    help.shown = false;
    try { localStorage.setItem("ap_helpSeen", "1"); } catch (e) { }
}
export function toggleHelp() {
    if (help.shown) hideHelp();
    else { helpEl.style.display = "block"; help.shown = true; }
}
try { if (localStorage.getItem("ap_helpSeen")) { helpEl.style.display = "none"; help.shown = false; } } catch (e) { }

// ---- escape tracker: speed milestones vs Earth / Sun / nearest black hole ----
// collapsed behind a small toggle header; the open state survives a refresh
const vRowsEl = document.getElementById("vRows");
const escToggleEl = document.getElementById("escToggle");
let escOpen = false;
try { escOpen = localStorage.getItem("ap_escOpen") === "1"; } catch (e) { }
function applyEscOpen() {
    vRowsEl.style.display = escOpen ? "block" : "none";
    escToggleEl.textContent = escOpen ? "ESC ▾ ESCAPE TRACKER" : "ESC ▸";
}
escToggleEl.onclick = () => {
    escOpen = !escOpen;
    try { localStorage.setItem("ap_escOpen", escOpen ? "1" : "0"); } catch (e) { }
    applyEscOpen();
};
applyEscOpen();
const fmtV = v => v >= 1000 ? Math.round(v).toLocaleString("en-US") : v >= 100 ? v.toFixed(1) : v.toFixed(2);
export function updateEscapeTracker(oi) {
    if (!escOpen) return;
    const v = Math.hypot(G.vx, G.vy, G.vz);
    // heliocentric speed in the current n-body state
    const vH = Math.hypot(G.vx - eph.sunVx, G.vy - eph.sunVy, G.vz);
    const rows = [
        { name: "EARTH ESC", v, need: WORLD.earthDestroyed ? Infinity : Math.sqrt(2 * MU_E / Math.max(R_EARTH, oi.rE)) },
        { name: "SUN ESC", v: vH, need: WORLD.sunDestroyed ? Infinity : Math.sqrt(2 * MU_S / Math.max(R_SUN, oi.rS)) },
    ];
    let bi = -1, bd = Infinity;
    for (let i = 0; i < BH.n; i++) {
        const d = Math.hypot(G.x - BH.x[i], G.y - BH.y[i], G.z);
        if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0) rows.push({
        name: "BH ESC · r_s " + Math.round(BH.rs[bi]) + " km",
        v, need: Math.sqrt(2 * BH.mu[bi] / Math.max(bd - BH.rs[bi], BH.rs[bi] * .02)),
    });
    let html = "";
    for (const r of rows) {
        const ok = r.v >= r.need;
        const frac = Math.min(100, r.v / r.need * 100);
        html += '<div class="vRow"><div class="vName"><span>' + r.name + (ok ? ' <span class="ok">✓</span>' : "") +
            '</span><span class="' + (ok ? "ok" : "") + '">' + fmtV(r.v) + " / " + fmtV(r.need) + ' km/s</span></div>' +
            '<div class="vBar"><div class="vFill ' + (ok ? "ok" : "") + '" style="width:' + frac.toFixed(1) + '%"></div></div></div>';
    }
    vRowsEl.innerHTML = html;
}

export function updateHUD(oi, aMag, mainIn, sp, kVLoc, fB) {
    metEl.textContent = "T+ " + fmtMET(G.t);
    warpEl.textContent = "⏩ " + warpLabel(G.warp) +
        (aMag > 0 && G.warp > 600 ? " · ⚠ THRUST AT HIGH WARP" : "") + (G.paused ? " · ❚❚ PAUSED" : "");
    warpEl.className = G.paused ? "warn" : "";
    if (G.dead) engineEl.textContent = "VEHICLE LOST — " + G.deadReason;
    else if (G.landed) engineEl.textContent = G.landed.body === "earth" ? "ON THE SURFACE — SHIFT+W TO LIFT OFF" :
        G.landed.body === "planet" ? "ON " + PL[G.landed.i].name + " — W TO LIFT OFF (SHIFT HELPS)" : "ON THE LUNAR SURFACE — W TO LIFT OFF";
    else if (aMag > 0) engineEl.textContent = (mainIn ? "MAIN ENGINE " + Math.round(G.throttle * 100) + "%" : "RCS") + (G.boost ? " · BOOST ×4" : "") + " · Δv flowing";
    else engineEl.textContent = "ENGINE OFF — gravity shapes the path";
    throttleEl.textContent = "THROTTLE " + Math.round(G.throttle * 100) + "% · " +
        (G.hold === "pro" ? "HOLD PROGRADE" : G.hold === "retro" ? "HOLD RETROGRADE" : "MANUAL ATTITUDE");
    fuelTxtEl.textContent = G.infinite ? "∞" : Math.round(G.fuel) + " m/s Δv";
    const frFuel = G.infinite ? 1 : G.fuel / FUEL_DV0;
    fuelFillEl.style.width = (frFuel * 100).toFixed(1) + "%";
    fuelFillEl.style.background = frFuel < .15 ? "linear-gradient(90deg,#7d2e2e,#c85858)" : "linear-gradient(90deg,#2e7d4f,#58c87f)";
    cAltL.textContent = "ALT · " + oi.body;
    cAlt.textContent = fmtDist(Math.max(0, oi.r - oi.R));
    cVel.textContent = sp.toFixed(3) + " km/s";
    cApPe.textContent = (oi.ra === Infinity ? "ESC" : fmtDist(Math.max(0, oi.ra - oi.R))) + " / " + fmtDist(Math.max(0, oi.rp - oi.R));
    cMoon.textContent = fmtDist(oi.rM);
    cSun.textContent = fmtDist(oi.rS);
    cDv.textContent = Math.round(G.dvUsed) + " m/s";
    const aShE = WORLD.earthDestroyed ? 0 : MU_E / Math.pow(Math.max(R_EARTH, oi.rE), 2);
    const aShM = WORLD.moonDestroyed ? 0 : MU_M / Math.pow(Math.max(R_MOON, oi.rM), 2);
    const aShS = WORLD.sunDestroyed ? 0 : MU_S / Math.pow(Math.max(R_SUN, oi.rS), 2);
    let aShB = 0;
    for (let bi = 0; bi < BH.n; bi++) {
        const dB = Math.hypot(G.x - BH.x[bi], G.y - BH.y[bi], G.z);
        const effB = Math.max(dB - BH.rs[bi], BH.rs[bi] * .02);
        aShB += BH.mu[bi] / (effB * effB);
    }
    const aShP = oi.pNear >= 0 && !WORLD.plDestroyed[oi.pNear] ? PL[oi.pNear].mu / Math.pow(Math.max(PL[oi.pNear].R, oi.pNearD), 2) : 0;
    const aDE = G.darkEnergy ? darkEnergyAccelerationKmS2(Math.hypot(G.x, G.y, G.z)) : 0;
    const dm = [0, 0, 0];
    if (G.darkMatter) darkMatterRelativeAccel(G.x, G.y, G.z, eph.earthX, eph.earthY, 0, dm);
    const aDM = Math.hypot(dm[0], dm[1], dm[2]);
    const gTot = aShE + aShM + aShS + aShB + aShP + aDE + aDM;
    const shares = [["E", aShE], ["M", aShM], ["S", aShS], ["⚫", aShB], [oi.pNear >= 0 ? PL[oi.pNear].tag : "P", aShP], ["DE", aDE], ["DM", aDM]].sort((p, q) => q[1] - p[1]);
    cGrav.textContent = gTot > 0 ? shares[0][0] + " " + Math.round(shares[0][1] / gTot * 100) + "% · " + shares[1][0] + " " + Math.round(shares[1][1] / gTot * 100) + "%" : "—";
    const focusBH = bhFocusIndex(G.focus);
    let bhReadoutRs = BH_SIZES[BH.sizeIdx], bhNearestD = Infinity;
    for (let bi = 0; bi < BH.n; bi++) {
        const dB = Math.hypot(G.x - BH.x[bi], G.y - BH.y[bi], G.z);
        if (dB < bhNearestD) { bhNearestD = dB; bhReadoutRs = BH.rs[bi]; }
    }
    if (focusBH >= 0 && focusBH < BH.n) {
        const dShip = Math.hypot(G.x - BH.x[focusBH], G.y - BH.y[focusBH], G.z);
        const vFrame = Math.hypot(BH.vx[focusBH], BH.vy[focusBH]);
        const vSun = Math.hypot(BH.vx[focusBH] + eph.earthVx, BH.vy[focusBH] + eph.earthVy);
        document.getElementById("bhLine").textContent = "⚫ BH " + (focusBH + 1) + "/" + BH.n +
            " · v " + vFrame.toFixed(2) + " km/s · helio " + vSun.toFixed(2) + " km/s · ship " + fmtDist(dShip) +
            " · g " + fmtAccel(pwAccelMs2(BH.mu[focusBH], dShip, BH.rs[focusBH])) + " · r_s " + fmtKm(BH.rs[focusBH]);
    } else document.getElementById("bhLine").textContent = "⚫ r_s " + fmtKm(bhReadoutRs) + " · " + bhMassLabel(bhReadoutRs) + " · " + bhHawkingLabel(bhReadoutRs) + " · B PLACE · N FOCUS · [ ] SIZE" + (BH.n ? " · ACTIVE " + BH.n + "/6" : "");
    if (fB > .25) {
        const clock = clockRateAtShip();
        fShip.textContent = kVLoc.toFixed(2) + " km/s";
        fClock.textContent = clockRateLabel(clock.rate);
        fEsc.textContent = escapeKmS(MU_E, Math.max(R_EARTH, oi.rE)).toFixed(2) + " km/s";
        fEscM.textContent = escapeKmS(MU_M, Math.max(R_MOON, oi.rM)).toFixed(2) + " km/s";
        if (fHalo) fHalo.textContent = G.darkMatter ? fmtAccel(aDM * 1000) : "OFF";
        fAcc.textContent = fmtAccel(accelMs2(MU_E, Math.max(R_EARTH, oi.rE)) + accelMs2(MU_M, Math.max(R_MOON, oi.rM)) + accelMs2(MU_S, Math.max(R_SUN, oi.rS)) + (aShB + aShP + aDE + aDM) * 1000);
    }
    flowPanelEl.style.display = fB > .25 ? "block" : "none";
}
