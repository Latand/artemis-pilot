import { STARS, PC_KM } from "./constants.js";
import { G } from "./state.js";
import { nearestActiveStar } from "./universe/activeStars.js";
import { hashInts } from "./universe/prng.js";
import { SPECIAL_OBJECTS } from "./universe/specialObjects.js";

const TAU = 0.15;
const CLICK_LOOKAHEAD = 0.5;
const PULSAR_D0 = 2 * PC_KM;
const BH_R0 = 0.5 * PC_KM;
const WIND_R0 = 0.2 * PC_KM;
const WASH_CELL = 50 * PC_KM;
const PENTATONIC = [55, 82.5, 110, 146.8, 220];
const PULSAR_PERIODS = {
    "CRAB PULSAR": 0.0334,
    "VELA PULSAR": 0.0893,
    "PSR B1919+21": 1.3373,
    GEMINGA: 0.2371,
};

let AC = null;
let ambientMaster = null;
let accretionGain = null;
let accretionFilter = null;
let rumbleFilter = null;
let windGain = null;
let washGain = null;
let pulsarSlots = [];
let washOscs = [];
let lastCellX = NaN, lastCellY = NaN, lastCellZ = NaN;
let duckUntil = -Infinity;
let nodeCount = 0;
const placedPulsarObjects = []; // mutable {x,y,z,name} refs, world km - owner: blackholes.js

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function distKm(a, wx, wy, wz) {
    const dx = wx - a.x, dy = wy - a.y, dz = wz - (a.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function paramTarget(param, value, now, tau = TAU) {
    if (param.setTargetAtTime) param.setTargetAtTime(value, now, tau);
    else param.value = value;
    param._ambientTarget = value;
}
function paramSet(param, value, when) {
    if (param.setValueAtTime) param.setValueAtTime(value, when);
    else param.value = value;
}
function paramRamp(param, value, when) {
    if (param.exponentialRampToValueAtTime) param.exponentialRampToValueAtTime(value, when);
    else paramSet(param, value, when);
}
function connect(a, b) {
    if (a?.connect) a.connect(b);
}
function count(node) {
    nodeCount++;
    return node;
}
function makeNoiseBuffer(ac) {
    const len = ac.sampleRate * 2;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
}
function makeConstantSource(ac) {
    if (ac.createConstantSource) {
        const src = count(ac.createConstantSource());
        if (src.offset) src.offset.value = 1;
        return src;
    }
    const src = count(ac.createBufferSource());
    const buf = ac.createBuffer(1, Math.max(1, ac.sampleRate || 44100), ac.sampleRate || 44100);
    buf.getChannelData(0).fill(1);
    src.buffer = buf;
    src.loop = true;
    return src;
}
function startNode(node) {
    try { node.start(); } catch (e) { }
}
function retuneWash(wx, wy, wz, now) {
    const cx = Math.floor(wx / WASH_CELL), cy = Math.floor(wy / WASH_CELL), cz = Math.floor(wz / WASH_CELL);
    if (cx === lastCellX && cy === lastCellY && cz === lastCellZ) return;
    lastCellX = cx; lastCellY = cy; lastCellZ = cz;
    const h = hashInts(cx, cy, cz);
    for (let i = 0; i < washOscs.length; i++) {
        const base = PENTATONIC[(h >>> (i * 5)) % PENTATONIC.length];
        const octave = 1 + ((h >>> (16 + i * 3)) & 1);
        const cents = ((h >>> (22 + i * 3)) & 7) - 3;
        paramTarget(washOscs[i].frequency, base * octave, now, 0.6);
        if (washOscs[i].detune) paramTarget(washOscs[i].detune, cents, now, 1.2);
    }
}
function schedulePulsar(slot, gain, now) {
    if (gain <= 0.02) {
        slot.nextClickTime = Math.max(slot.nextClickTime, now);
        return;
    }
    if (!Number.isFinite(slot.nextClickTime) || slot.nextClickTime < now) slot.nextClickTime = now + 0.01;
    const end = now + CLICK_LOOKAHEAD;
    while (slot.nextClickTime < end) {
        const t = slot.nextClickTime;
        paramSet(slot.clickGain.gain, 0.0001, t);
        paramRamp(slot.clickGain.gain, 0.08, t + 0.003);
        paramRamp(slot.clickGain.gain, 0.0001, t + 0.018);
        slot.scheduledTimes[slot.scheduledIndex % slot.scheduledTimes.length] = t;
        slot.scheduledIndex++;
        slot.nextClickTime += slot.period;
    }
}

export function registerPlacedPulsar(obj, period) {
    if (!AC || pulsarSlots.length >= 6) return;
    const slotGain = count(AC.createGain());
    slotGain.gain.value = 0;
    const clickGain = pulsarSlots[0]?.clickGain;
    if (!clickGain) return;
    connect(clickGain, slotGain); connect(slotGain, ambientMaster);
    placedPulsarObjects.push(obj);
    pulsarSlots.push({ object: obj, period, gain: slotGain, clickGain, nextClickTime: NaN, scheduledTimes: new Float64Array(32), scheduledIndex: 0 });
}

export function unregisterPlacedPulsar(obj) {
    const oi = placedPulsarObjects.indexOf(obj);
    if (oi >= 0) placedPulsarObjects.splice(oi, 1);
    const si = pulsarSlots.findIndex(slot => slot.object === obj);
    if (si < 0) return;
    const slot = pulsarSlots.splice(si, 1)[0];
    try { slot.gain.disconnect?.(); } catch (e) { }
}

export function initAmbient(ac) {
    if (AC) return;
    AC = ac;
    const noise = makeNoiseBuffer(ac);
    ambientMaster = count(ac.createGain());
    ambientMaster.gain.value = 0;
    connect(ambientMaster, ac.destination);

    const accSrc = count(ac.createBufferSource());
    accSrc.buffer = noise; accSrc.loop = true;
    accretionFilter = count(ac.createBiquadFilter());
    accretionFilter.type = "lowpass"; accretionFilter.frequency.value = 60;
    accretionGain = count(ac.createGain());
    accretionGain.gain.value = 0;
    connect(accSrc, accretionFilter); connect(accretionFilter, accretionGain); connect(accretionGain, ambientMaster);

    rumbleFilter = count(ac.createBiquadFilter());
    rumbleFilter.type = "lowpass"; rumbleFilter.frequency.value = 800;
    connect(accSrc, rumbleFilter); connect(rumbleFilter, accretionGain);

    const windSrc = count(ac.createBufferSource());
    windSrc.buffer = noise; windSrc.loop = true;
    const windFilter = count(ac.createBiquadFilter());
    windFilter.type = "highpass"; windFilter.frequency.value = 2000;
    windGain = count(ac.createGain());
    windGain.gain.value = 0;
    connect(windSrc, windFilter); connect(windFilter, windGain); connect(windGain, ambientMaster);
    startNode(accSrc); startNode(windSrc);

    const clickSrc = makeConstantSource(ac);
    const clickFilter = count(ac.createBiquadFilter());
    clickFilter.type = "bandpass"; clickFilter.frequency.value = 1200; if (clickFilter.Q) clickFilter.Q.value = 8;
    const clickGain = count(ac.createGain());
    clickGain.gain.value = 0.0001;
    connect(clickSrc, clickFilter); connect(clickFilter, clickGain);
    pulsarSlots = SPECIAL_OBJECTS.filter(o => o.pulsar && PULSAR_PERIODS[o.name]).slice(0, 4).map(o => {
        const slotGain = count(ac.createGain());
        slotGain.gain.value = 0;
        connect(clickGain, slotGain); connect(slotGain, ambientMaster);
        return { object: o, period: PULSAR_PERIODS[o.name], gain: slotGain, clickGain, nextClickTime: NaN, scheduledTimes: new Float64Array(32), scheduledIndex: 0 };
    });
    startNode(clickSrc);

    washGain = count(ac.createGain());
    washGain.gain.value = 0;
    connect(washGain, ambientMaster);
    washOscs = [];
    for (let i = 0; i < 3; i++) {
        const osc = count(ac.createOscillator());
        const g = count(ac.createGain());
        osc.type = "sine"; osc.frequency.value = PENTATONIC[i]; g.gain.value = 0.025;
        connect(osc, g); connect(g, washGain);
        startNode(osc);
        washOscs.push(osc);
    }
}

export function updateAmbient(pos, dtSec, muted, warp) {
    if (!AC || !ambientMaster) return;
    const now = AC.currentTime || 0;
    const ambientEnabled = G.ambientAudio !== false;
    let maxPulsarGain = 0;
    for (let i = 0; i < pulsarSlots.length; i++) {
        const slot = pulsarSlots[i];
        const d = distKm(slot.object, pos.wx, pos.wy, pos.wz);
        const pg = 0.5 / (1 + (d / PULSAR_D0) * (d / PULSAR_D0));
        maxPulsarGain = Math.max(maxPulsarGain, pg);
        paramTarget(slot.gain.gain, pg, now);
        schedulePulsar(slot, pg, now);
    }

    let nearestBh = Infinity, nearestRs = 1;
    for (let i = 0; i < SPECIAL_OBJECTS.length; i++) {
        const o = SPECIAL_OBJECTS[i];
        if (!o.bh) continue;
        const d = distKm(o, pos.wx, pos.wy, pos.wz);
        if (d < nearestBh) { nearestBh = d; nearestRs = o.rs || o.R || 1; }
    }
    for (let i = 0; i < STARS.length; i++) {
        const o = STARS[i];
        if (!o.bh) continue;
        const d = distKm(o, pos.wx, pos.wy, pos.wz);
        if (d < nearestBh) { nearestBh = d; nearestRs = o.rs || o.R || 1; }
    }
    const bhProx = Number.isFinite(nearestBh) ? clamp((BH_R0 / Math.max(nearestBh, nearestRs)) ** 2, 0, 1) : 0;
    const accTarget = 0.6 * bhProx;
    paramTarget(accretionGain.gain, accTarget, now);
    paramTarget(accretionFilter.frequency, 60 + 340 * bhProx, now);
    paramTarget(rumbleFilter.frequency, 220 + 580 * bhProx, now);

    const near = nearestActiveStar(pos.wx, pos.wy, pos.wz);
    let windTarget = 0;
    if (near?.star && !near.star.bh && near.star.kind !== "BH" && near.d > 0) {
        const lum = Math.min(1, Number.isFinite(near.star.lumSolar) ? near.star.lumSolar : 1);
        windTarget = clamp(0.35 * (WIND_R0 / near.d) * (WIND_R0 / near.d), 0, 0.35) * lum;
    }
    paramTarget(windGain.gain, windTarget, now);

    retuneWash(pos.wx, pos.wy, pos.wz, now);
    const voided = nearestBh > BH_R0 * 6 && maxPulsarGain < (0.5 / (1 + 36)) && windTarget < 0.01;
    paramTarget(washGain.gain, voided ? 0.03 : 0.05, now);

    let master = muted || !ambientEnabled ? 0 : 1;
    if (G.throttle > 0.05 || G.boost) master *= 0.4;
    if (now < duckUntil) master *= 0.5;
    if (warp > 1e6) master *= 0.2;
    paramTarget(ambientMaster.gain, master, now, dtSec > 0 ? TAU : 0.01);
}

export function resumeAmbient() {
    if (AC?.resume) AC.resume();
}

export function suspendAmbient() {
    if (!AC || !ambientMaster) return;
    paramTarget(ambientMaster.gain, 0, AC.currentTime || 0, 0.05);
}

export function duck() {
    if (!AC) return;
    duckUntil = Math.max(duckUntil, (AC.currentTime || 0) + 0.3);
}

export function __ambientDebug() {
    return {
        nodeCount,
        masterTarget: ambientMaster?.gain?._ambientTarget ?? ambientMaster?.gain?.value ?? 0,
        accretionTarget: accretionGain?.gain?._ambientTarget ?? accretionGain?.gain?.value ?? 0,
        windTarget: windGain?.gain?._ambientTarget ?? windGain?.gain?.value ?? 0,
        washTarget: washGain?.gain?._ambientTarget ?? washGain?.gain?.value ?? 0,
        pulsars: pulsarSlots.map(slot => ({
            name: slot.object.name,
            period: slot.period,
            gainTarget: slot.gain.gain._ambientTarget ?? slot.gain.gain.value,
            scheduled: Array.from(slot.scheduledTimes).filter(t => t > 0),
        })),
    };
}
