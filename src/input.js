import { WARPS, WARP_MAX, PL, BH_SIZES, K } from "./constants.js";
import { G, keys, BH } from "./state.js";
import { cam } from "./scene.js";
import { initAudio, thrustGain } from "./audio.js";
import { toast } from "./achievements.js";
import { placeBHAtCursor, removeLastBH } from "./blackholes.js";
import { computePrediction } from "./trails.js";
import { help, hideHelp, toggleHelp } from "./hud.js";

export function setFocus(f) {
    G.focus = f;
    cam.dist = typeof f === "number" ? Math.max(PL[f].R * K * 7, 2) :
        f === "earth" ? 34 : f === "moon" ? 10 : f === "sun" ? 2600 : 2.6;
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
    if (e.code === "KeyZ") G.throttle = Math.max(.05, G.throttle / 1.3);
    if (e.code === "KeyX") G.throttle = Math.min(100, G.throttle * 1.3);
    if (e.code === "Comma") G.warp = Math.max(1, G.warp / 2);
    if (e.code === "Period") G.warp = Math.min(WARP_MAX, G.warp * 2);
    if (e.repeat) return;
    switch (e.code) {
        case "Space": G.paused = !G.paused; break;
        case "KeyT": G.hold = G.hold === "pro" ? null : "pro"; break;
        case "KeyY": G.hold = G.hold === "retro" ? null : "retro"; break;
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
        case "KeyI": G.infinite = !G.infinite; toast(G.infinite ? "Infinite propellant ON" : "Infinite propellant OFF"); break;
        case "KeyM": G.muted = !G.muted; if (thrustGain) thrustGain.gain.value = 0; break;
        case "KeyR": H.restart(); break;
        case "KeyB": placeBHAtCursor(); break;
        case "KeyV": removeLastBH(); break;
        case "BracketLeft": BH.sizeIdx = Math.max(0, BH.sizeIdx - 1); break;
        case "BracketRight": BH.sizeIdx = Math.min(BH_SIZES.length - 1, BH.sizeIdx + 1); break;
        case "KeyH": toggleHelp(); break;
        default: {
            const m = e.code.match(/^Digit([1-8])$/);
            if (m) G.warp = WARPS[Number(m[1]) - 1];
        }
    }
}
