import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

globalThis.window = {};

class Param {
    constructor(value = 0) {
        this.value = value;
        this.calls = [];
    }
    setTargetAtTime(value, time, tau) {
        this.value = value;
        this._ambientTarget = value;
        this.calls.push(["target", value, time, tau]);
    }
    setValueAtTime(value, time) {
        this.value = value;
        this.calls.push(["set", value, time]);
    }
    exponentialRampToValueAtTime(value, time) {
        this.value = value;
        this.calls.push(["exp", value, time]);
    }
}

class Node {
    constructor(kind, ac) {
        this.kind = kind;
        this.context = ac;
        this.connections = [];
        if (kind === "gain") this.gain = new Param(1);
        if (kind === "filter") {
            this.frequency = new Param(350);
            this.Q = new Param(1);
        }
        if (kind === "osc") {
            this.frequency = new Param(440);
            this.detune = new Param(0);
        }
        if (kind === "constant") this.offset = new Param(1);
    }
    connect(node) { this.connections.push(node); return node; }
    start() { this.started = true; }
    stop(time) { this.stoppedAt = time; }
}

class BufferStub {
    constructor(channels, length) {
        this.data = Array.from({ length: channels }, () => new Float32Array(length));
    }
    getChannelData(i) { return this.data[i]; }
}

class AudioContextStub {
    constructor() {
        this.sampleRate = 44100;
        this.currentTime = 0;
        this.destination = { kind: "destination" };
        this.created = [];
        this.resumeCalls = 0;
    }
    node(kind) {
        const node = new Node(kind, this);
        this.created.push(node);
        return node;
    }
    createGain() { return this.node("gain"); }
    createBufferSource() { return this.node("bufferSource"); }
    createBiquadFilter() { return this.node("filter"); }
    createOscillator() { return this.node("osc"); }
    createConstantSource() { return this.node("constant"); }
    createBuffer(channels, length) { return new BufferStub(channels, length); }
    resume() { this.resumeCalls++; return Promise.resolve(); }
}

const ambient = await import("../src/ambientAudio.js");
const { SPECIAL_OBJECTS } = await import("../src/universe/specialObjects.js");
const { STARS, PC_KM } = await import("../src/constants.js");
const { G } = await import("../src/state.js");

function near(obj, pc) {
    return { wx: obj.x + pc * PC_KM, wy: obj.y, wz: obj.z || 0 };
}

const ac = new AudioContextStub();
ambient.initAmbient(ac);
const firstCount = ac.created.length;
ambient.initAmbient(ac);
assert.equal(ac.created.length, firstCount, "initAmbient should be idempotent");
assert.ok(firstCount <= 32, "ambient graph should stay bounded, got " + firstCount);

const crab = SPECIAL_OBJECTS.find(o => o.name === "CRAB PULSAR");
assert.ok(crab?.pulsar, "Crab should be flagged as a pulsar");
ambient.updateAmbient(near(crab, 0.5), 1 / 60, false, 60);
let dbg = ambient.__ambientDebug();
const crabSlot = dbg.pulsars.find(p => p.name === "CRAB PULSAR");
assert.ok(crabSlot.gainTarget > 0.1, "Crab slot gain should rise near the pulsar");
assert.ok(crabSlot.scheduled.length >= 3, "Crab should schedule multiple clicks");
assert.ok(Math.abs((crabSlot.scheduled[1] - crabSlot.scheduled[0]) - 0.0334) < 1e-9,
    "Crab click spacing should match the real period");

const sgr = STARS.find(s => s.name === "SGR A*");
ac.currentTime += 1;
ambient.updateAmbient(near(sgr, 0.3), 1 / 60, false, 60);
dbg = ambient.__ambientDebug();
assert.ok(dbg.accretionTarget > 0.1, "SGR A* proximity should raise accretion");

ac.currentTime += 1;
ambient.updateAmbient({ wx: 1e20, wy: -2e20, wz: 3e20 }, 1 / 60, false, 60);
dbg = ambient.__ambientDebug();
assert.ok(dbg.washTarget >= 0.03 && dbg.washTarget <= 0.05, "deep void should keep a wash floor");
assert.ok(dbg.accretionTarget < 0.001, "deep void should drop accretion");
assert.ok(dbg.windTarget < 0.01, "deep void should drop stellar wind");

ac.currentTime += 1;
ambient.updateAmbient(near(crab, 0.5), 1 / 60, true, 60);
dbg = ambient.__ambientDebug();
assert.equal(dbg.masterTarget, 0, "muted ambient should ramp master to zero");

ambient.resumeAmbient();
assert.equal(ac.resumeCalls, 1, "resumeAmbient should call AudioContext.resume");

const source = readFileSync(new URL("../src/ambientAudio.js", import.meta.url), "utf8");
const randomLines = source.split("\n").map((line, i) => [i + 1, line]).filter(([, line]) => line.includes("Math.random"));
assert.equal(randomLines.length, 1, "Math.random should only appear in the noise-buffer fill");
assert.ok(randomLines[0][1].includes("d[i]"), "Math.random occurrence should fill the noise buffer");

console.log("ambient smoke passed nodes=" + firstCount);
