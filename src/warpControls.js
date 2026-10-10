import { setUiMode, onModeChange } from './uiMode.js';
import { WARP, resetWarp, stopWarp, warpSpeedLabel, WARP_MAX_C } from './warpBubble.js';
import { G } from './state.js';
import { apOff } from './autopilot.js';
import { relCancel } from './relTravel.js';
import { setWarp } from './timeCtl.js';
import { toast } from './achievements.js';
import { shipVisuals } from './shipVisuals.js';
let buttons=[],stops=[],readouts=[],notes=[],guides=[];
const WARP_NOTE='ALCUBIERRE SHIFT IN THE GRAVITY RIVER\nShort bright dashes: space contracts ahead\nLong violet strokes: space expands behind\nHypothetical metric · not a working engine';
const DRIVE_NOTE='FICTIONAL CURVATURE DRIVE\nEffective field model · no GR solver';
export function initWarpControls() {
    notes=[...document.querySelectorAll('[data-warp-note]')];
    buttons=[...document.querySelectorAll('[data-bubble-drive]')];
    stops=[...document.querySelectorAll('[data-bubble-stop]')];
    readouts=[...document.querySelectorAll('[data-bubble-status]')];
    guides=[...document.querySelectorAll('[data-warp-visual]')];
    for(const button of buttons) button.addEventListener('click',()=>{
        if (WARP.enabled) resetWarp();
        else if (G.dead || G.landed) { toast('Launch into free flight before engaging the warp sandbox'); return; }
        else {
            resetWarp(); WARP.enabled=true; WARP.phase='ready'; G.hold=null;
            apOff('warp sandbox',toast); relCancel('warp sandbox',toast);
            setUiMode('pilot',false); G.focus='ship'; setWarp(1,'user');
            // The bubble is drawn only through the shared field lines.
            const linesOn=!G.gr; G.gr=true;
            toast('Hypothetical warp sandbox · time 1× · W ramp, S brake, release cruise'+(linesOn?' · gravity river on':''));
        }
        button.blur(); updateWarpControls();
    });
    for(const button of stops) button.addEventListener('click',()=>{stopWarp(WARP,'Emergency bubble collapse');button.blur();updateWarpControls();});
    onModeChange(mode=>{if(mode!=='pilot')stopWarp(WARP,'Left pilot mode');});
    updateWarpControls();
}
export function updateWarpControls() {
    for(const b of buttons) {const label=`Warp sandbox · ${WARP.enabled?'ON':'OFF'}`;if(b.textContent!==label)b.textContent=label;b.setAttribute('aria-pressed',String(WARP.enabled));}
    for(const b of stops) b.disabled=!WARP.enabled || WARP.speed===0;
    // The curvature-drive guide has nothing to show while the bubble flies.
    for(const b of guides) b.hidden=WARP.enabled;
    const text=WARP.enabled ? `WARP ${warpSpeedLabel(WARP.speed)} · ${G.paused?'paused':WARP.phase}\nBubble coordinate speed · local ${Math.hypot(G.vx,G.vy,G.vz).toFixed(2)} km/s\n${WARP.reason || 'W ramp / S brake / release cruise'}${WARP.limited?' · '+WARP_MAX_C.toExponential(0)+' c simulation guard':''}` : 'Local flight · warp sandbox off';
    for(const note of notes) {
        const label=WARP.enabled?WARP_NOTE:DRIVE_NOTE;
        if(note.textContent!==label)note.textContent=label;
        note.hidden=!(WARP.enabled||shipVisuals.enabled);
    }
    for(const r of readouts) if(r.textContent!==text)r.textContent=text;
}
