import { G } from "./state.js";

let AC = null, noiseBuf = null;
export let thrustGain = null;
export function initAudio() {
    if (AC) return;
    try {
        AC = new (window.AudioContext || window.webkitAudioContext)();
        const len = AC.sampleRate * 2, buf = AC.createBuffer(1, len, AC.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        noiseBuf = buf;
        // Quiet cabin/interface sonification of field load, not engine noise
        // or sound propagating through vacuum. Legacy export retains context
        // access for mute / ambient integrations.
        thrustGain = AC.createGain(); thrustGain.gain.value = 0;
        for (const hz of [72, 108]) {
            const tone = AC.createOscillator(); tone.type = 'sine';
            tone.frequency.value = hz;
            const voice = AC.createGain(); voice.gain.value = .5;
            tone.connect(voice); voice.connect(thrustGain); tone.start();
        }
        thrustGain.connect(AC.destination);
    } catch (e) { }
}
export function updateDriveAudio(level, dtReal, silent = false) {
    if (!thrustGain) return;
    const target = silent ? 0 : .018 * Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
    const dt = Number.isFinite(dtReal) ? Math.max(0, Math.min(.25, dtReal)) : 0;
    thrustGain.gain.value += (target - thrustGain.gain.value) * (1 - Math.exp(-dt * 12));
}
export function blip() {
    if (!AC || G.muted) return;
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(.0001, AC.currentTime);
    g.gain.exponentialRampToValueAtTime(.05, AC.currentTime + .02);
    g.gain.exponentialRampToValueAtTime(.0001, AC.currentTime + .5);
    o.connect(g); g.connect(AC.destination);
    o.start(); o.stop(AC.currentTime + .55);
}
export function boom() {
    if (!AC || G.muted || !noiseBuf) return;
    const src = AC.createBufferSource(); src.buffer = noiseBuf;
    const f = AC.createBiquadFilter(); f.type = "lowpass";
    f.frequency.setValueAtTime(900, AC.currentTime);
    f.frequency.exponentialRampToValueAtTime(60, AC.currentTime + 1.6);
    const g = AC.createGain();
    g.gain.setValueAtTime(.4, AC.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, AC.currentTime + 1.8);
    src.connect(f); f.connect(g); g.connect(AC.destination);
    src.start(); src.stop(AC.currentTime + 1.9);
}
