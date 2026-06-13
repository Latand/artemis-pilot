import { WARPS, WARP_MAX, PL, STARS, BH_SIZES, K, LY_SCENE } from "./constants.js";
import { G, keys, BH } from "./state.js";
import { cam } from "./scene.js";
import { initAudio, thrustGain } from "./audio.js";
import { toast } from "./achievements.js";
import { cancelBHPlacementMode, isBHPlacementMode, removeLastBH, toggleBHPlacementMode } from "./blackholes.js";
import { computePrediction } from "./trails.js";
import { saveState, loadState } from "./saves.js";
import { help, hideHelp, toggleHelp } from "./hud.js";
import { cycleCosmicScale } from "./cosmic.js";
import { look } from "./cockpit.js";
import { apTravelToFocus, apCircularize, apOff } from "./autopilot.js";
import { toggleScenarioMenu } from "./scenarios.js";
import { openCatalogSearch } from "./catalogSearch.js";

export function setFocus(f) {
    G.focus = f;
    const bi = blackHoleFocusIndex(f);
    const si = starFocusIndex(f);
    cam.dist = bi >= 0 && bi < BH.n ? Math.max(80, BH.rs[bi] * K * 12) :
        si >= 0 && si < STARS.length ? Math.max(STARS[si].R * K * (STARS[si].bh ? 30 : 12), 1) :
        typeof f === "number" ? Math.max(PL[f].R * K * 7, 2) :
        f === "earth" ? 34 : f === "moon" ? 10 : f === "sun" ? 2600 : 2.6;
}
export function blackHoleFocusIndex(f) {
    if (typeof f !== "string") return -1;
    const m = f.match(/^bh:(\d+)$/);
    return m ? Number(m[1]) : -1;
}
export function starFocusIndex(f) {
    if (typeof f !== "string") return -1;
    const m = f.match(/^star:(\d+)$/);
    return m ? Number(m[1]) : -1;
}
function focusNextBlackHole() {
    if (!BH.n) { toast("No black holes placed"); return; }
    const cur = blackHoleFocusIndex(G.focus);
    const next = (cur + 1) % BH.n;
    setFocus("bh:" + next);
    toast("Black-hole focus " + (next + 1) + "/" + BH.n);
}
function focusNextStar() {
    const cur = starFocusIndex(G.focus);
    const next = (cur + 1) % STARS.length;
    setFocus("star:" + next);
    toast("Destination " + STARS[next].name + " · " + STARS[next].dLy.toFixed(2) + " ly");
}

let H = { restart: () => { } };
export function initInput(hooks) {
    H = hooks;
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", e => keys.delete(e.code));
    window.addEventListener("blur", () => keys.clear());
}
function onKeyDown(e) {
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
    initAudio();
    keys.add(e.code);
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code) && help.shown) hideHelp();
    if (e.code === "KeyZ" && !e.shiftKey) G.throttle = Math.max(.05, G.throttle / 1.3);
    if (e.code === "KeyX" && !e.shiftKey) G.throttle = Math.min(100, G.throttle * 1.3);
    if (e.code === "KeyX" && e.shiftKey) apOff("cancelled", toast);
    if (e.code === "Comma") G.warp = Math.max(1, G.warp / 2);
    if (e.code === "Period") G.warp = Math.min(WARP_MAX, G.warp * 2);
    if (e.repeat) return;
    switch (e.code) {
        case "Escape":
            if (isBHPlacementMode()) cancelBHPlacementMode();
            break;
        case "Space": G.paused = !G.paused; break;
        case "KeyT":
            if (e.shiftKey) apTravelToFocus(toast);
            else G.hold = G.hold === "pro" ? null : "pro";
            break;
        case "KeyY": G.hold = G.hold === "retro" ? null : "retro"; break;
        case "KeyS":
            if (e.shiftKey) { keys.delete("KeyS"); toggleScenarioMenu(); } // plain S stays reverse thrust
            break;
        case "KeyF":
            if (e.shiftKey) { // cycle the planets
                const cur = typeof G.focus === "number" ? G.focus : -1;
                setFocus((cur + 1) % PL.length);
            } else {
                setFocus(G.focus === "ship" ? "moon" : G.focus === "moon" ? "earth" : G.focus === "earth" ? "sun" : "ship");
            }
            break;
        case "Digit0": setFocus("ship"); break;
        case "KeyP": G.predict = !G.predict; computePrediction(); break;
        case "KeyG": G.gr = !G.gr; break;
        case "KeyO": G.darkEnergy = !G.darkEnergy; computePrediction(); toast(G.darkEnergy ? "Dark energy expansion ON" : "Dark energy expansion OFF"); break;
        case "KeyC":
            if (e.shiftKey) apCircularize(toast);
            else cycleCosmicScale();
            break;
        case "KeyJ":
            G.cabin = !G.cabin;
            look.yaw = 0; look.pitch = 0;
            if (G.cabin) { G.focus = "ship"; toast("Cabin view · drag to look around"); } else toast("External view");
            break;
        case "KeyI": G.infinite = !G.infinite; toast(G.infinite ? "Infinite propellant ON" : "Infinite propellant OFF"); break;
        case "KeyM": G.muted = !G.muted; if (thrustGain) thrustGain.gain.value = 0; break;
        case "KeyR": H.restart(); break;
        case "KeyK": saveState(); break;
        case "KeyL": loadState(); break;
        case "KeyN": focusNextBlackHole(); break;
        case "KeyU":
            if (e.shiftKey) {
                e.preventDefault();
                openCatalogSearch();
            }
            else focusNextStar();
            break;
        case "KeyB": toggleBHPlacementMode(); break;
        case "KeyV": removeLastBH(); break;
        case "BracketLeft": BH.sizeIdx = Math.max(0, BH.sizeIdx - 1); break;
        case "BracketRight": BH.sizeIdx = Math.min(BH_SIZES.length - 1, BH.sizeIdx + 1); break;
        case "KeyH": toggleHelp(); break;
        default: {
            const m = e.code.match(/^Digit([1-9])$/);
            if (m) G.warp = WARPS[Number(m[1]) - 1];
        }
    }
}
