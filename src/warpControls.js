import { setUiMode, onModeChange } from './uiMode.js';
import { WARP, resetWarp, stopWarp, warpSpeedLabel, WARP_MAX_C } from './warpBubble.js';
import { G } from './state.js';
import { apOff } from './autopilot.js';
import { relCancel } from './relTravel.js';
import { setWarp } from './timeCtl.js';
import { toast } from './achievements.js';
let buttons=[],stops=[],readouts=[],notes=[];
export function initWarpControls() {
    notes=[...document.querySelectorAll('[data-warp-note]')];
    buttons=[...document.querySelectorAll('[data-bubble-drive]')];
    stops=[...document.querySelectorAll('[data-bubble-stop]')];
    readouts=[...document.querySelectorAll('[data-bubble-status]')];
    for(const button of buttons) button.addEventListener('click',()=>{
        if (WARP.enabled) resetWarp();
        else if (G.dead || G.landed) { toast('Launch into free flight before engaging the warp sandbox'); return; }
        else {
            resetWarp(); WARP.enabled=true; WARP.phase='ready'; G.hold=null;
            apOff('warp sandbox',toast); relCancel('warp sandbox',toast);
            setUiMode('pilot',false); G.focus='ship'; setWarp(1,'user');
            toast('Hypothetical warp sandbox · time set to 1× · W ramp, S brake, release cruise');
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
    const text=WARP.enabled ? `BUBBLE ${warpSpeedLabel(WARP.speed)} · ${G.paused?'paused':WARP.phase}\nCoordinate speed, not local speed · ${WARP.reason || 'W ramp / S brake / release cruise'}${WARP.limited?' · '+WARP_MAX_C+'c numerical guard':''}` : 'Local flight · warp sandbox off';
    for(const note of notes) {const label=WARP.enabled?'ALCUBIERRE MODEL · HYPOTHETICAL\nCyan: contraction · pink: expansion\nViolet: negative-energy wall · normalized guide':'FICTIONAL CURVATURE DRIVE\nEffective field model · no GR solver';if(note.textContent!==label)note.textContent=label;}
    for(const r of readouts) if(r.textContent!==text)r.textContent=text;
}
