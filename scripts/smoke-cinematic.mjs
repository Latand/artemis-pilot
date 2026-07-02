import assert from "node:assert/strict";
import {
    bindCinematic, loadKeyframes, getKeyframes, sampleAt, play, tick, isPlaying, stop, duration,
} from "../src/cinematic.js";

const calls = [];
const camera = {
    position: {
        x: 0, y: 0, z: 0,
        set(x, y, z) { this.x = x; this.y = y; this.z = z; },
    },
    lookAt(v) { calls.push(["lookAt", v.x, v.y, v.z]); },
};
const cam = {
    tgt: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    distTarget: 10,
};
const G = { focus: "ship", warp: 1 };
const renderer = { toneMappingExposure: 1.12 };
let roll = 0;
bindCinematic({
    camera, cam, G, renderer,
    setCamRoll(r) { roll = r; },
    applyCameraRoll() { calls.push(["roll", roll]); },
});

const keys = [
    { pos: [0, 0, 0], target: [10, 0, 0], roll: 0, warp: 1, t: 0, exposure: 1.0 },
    { pos: [10, 10, 0], target: [20, 10, 0], roll: .1, warp: 8, t: 2, exposure: 1.2 },
    { pos: [20, 20, 0], target: [30, 20, 0], roll: .2, warp: 64, t: 5, exposure: 1.4 },
    { pos: [30, 30, 0], target: [40, 30, 0], roll: .3, warp: 512, t: 9, exposure: 1.1 },
];
loadKeyframes(keys);

function d3(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function nearly(a, b, eps = 1e-9) {
    assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
}

for (const k of keys) {
    const s = sampleAt(k.t);
    assert.ok(d3(s.pos, k.pos) < 1e-6, "sampleAt must pass through keyframe pos");
    assert.ok(d3(s.target, k.target) < 1e-6, "sampleAt must pass through keyframe target");
    nearly(s.roll, k.roll, 1e-9);
    nearly(s.warp, k.warp, 1e-9);
}

const mid = sampleAt(3.5);
assert.ok(mid.pos[0] > keys[1].pos[0] && mid.pos[0] < keys[2].pos[0], "position t should be monotonic on segment");
assert.ok(mid.pos[1] > keys[1].pos[1] && mid.pos[1] < keys[2].pos[1], "position t should be monotonic on segment");
nearly(sampleAt(keys[0].t).warp, keys[0].warp);
nearly(sampleAt(keys[keys.length - 1].t).warp, keys[keys.length - 1].warp);

for (let i = 0; i < keys.length - 1; i++) {
    const s = sampleAt((keys[i].t + keys[i + 1].t) * .5);
    const controls = [
        keys[Math.max(0, i - 1)].pos,
        keys[i].pos,
        keys[i + 1].pos,
        keys[Math.min(keys.length - 1, i + 2)].pos,
    ];
    for (let axis = 0; axis < 3; axis++) {
        const lo = Math.min(...controls.map(p => p[axis])) - 1e-6;
        const hi = Math.max(...controls.map(p => p[axis])) + 1e-6;
        assert.ok(s.pos[axis] >= lo && s.pos[axis] <= hi, "Catmull-Rom segment escaped control bounding box");
    }
}

const roundTrip = getKeyframes();
loadKeyframes(roundTrip);
assert.deepEqual(getKeyframes(), roundTrip, "loadKeyframes(getKeyframes()) round-trip");
assert.equal(duration(), 9);

assert.equal(play(), true);
assert.equal(G.focus, "free");
assert.equal(cam.distTarget, null);
assert.equal(isPlaying(), true);
tick(20);
assert.equal(isPlaying(), false);
assert.ok(calls.length > 0, "applyFrame should drive camera");
stop();

console.log("smoke-cinematic OK");
