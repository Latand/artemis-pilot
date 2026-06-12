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
        const src = AC.createBufferSource();
        src.buffer = buf; src.loop = true;
        const filt = AC.createBiquadFilter();
        filt.type = "lowpass"; filt.frequency.value = 160;
        thrustGain = AC.createGain(); thrustGain.gain.value = 0;
        src.connect(filt); filt.connect(thrustGain); thrustGain.connect(AC.destination);
        src.start();
    } catch (e) { }
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
