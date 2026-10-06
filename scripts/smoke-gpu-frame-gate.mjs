import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createGpuFrameGate } from '../src/render/gpuFrameGate.js';
import { createGraphicsRestart } from '../src/render/graphicsRestart.js';
import { createQualityController, pacedFrameTime } from '../src/render/adaptiveQuality.js';
function fakeGL() {
    let next = 0;
    return { SYNC_GPU_COMMANDS_COMPLETE: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3, TIMEOUT_EXPIRED: 4, WAIT_FAILED: 5,
        lost: false, status: 4, created: [], deleted: [], polled: [], flushes: 0,
        isContextLost() { return this.lost; }, fenceSync(condition, flags) { assert.equal(condition, 1); assert.equal(flags, 0); const s = ++next; this.created.push(s); return s; },
        deleteSync(s) { this.deleted.push(s); }, clientWaitSync(...args) { this.polled.push(args); return this.status; }, flush() { this.flushes++; } };
}
let gl = fakeGL(), notices = 0, recovered = 0;
const gate = createGpuFrameGate(() => gl, { onStall: () => notices++, onRecovered: () => recovered++ });
const account = () => assert.equal(gate.stats.fenced - gate.stats.completed - gate.stats.discarded, gate.stats.inFlight ? 1 : 0);
assert(gate.ready(0)); gate.submitted(0); account();
for (let time = 16; time <= 120000; time += 16) assert.equal(gate.ready(time), false);
assert.equal(gl.created.length, 1); assert.equal(gl.flushes, 1); assert.equal(notices, 1, 'A never-signaling GPU gets one bounded stall notice');
assert.equal(gate.stats.stalled, true); assert.equal(gate.stats.maxPendingMs, 120000);
assert(gl.polled.every(args => args[1] === 0 && args[2] === 0), 'Every poll is zero-timeout');
gl.status = gl.CONDITION_SATISFIED; assert(gate.ready(120016)); assert.equal(recovered, 1); assert.equal(gate.stats.stalled, false); account();
gate.submitted(120020); gate.reset(); account(); assert.equal(gate.stats.discarded, 1);
gate.submitted(120030); gl.lost = true; assert.equal(gate.ready(120040), false); account();
assert.deepEqual(gl.deleted, [1, 2], 'A lost context releases native syncs itself');
gl = fakeGL(); gate.reset(); gate.submitted(120050); gate.dispose(); account(); assert.equal(gate.ready(120060), false);
gate.reset(); gate.submitted(120070); gl.status = gl.WAIT_FAILED; assert(gate.ready(120080)); account(); assert(gate.stats.fallback);
gate.reset(); assert.equal(gate.stats.fallback, false);
const nullGL = fakeGL(); nullGL.fenceSync = () => null; const nullGate = createGpuFrameGate(() => nullGL);
nullGate.submitted(0); assert.equal(nullGate.stats.failures, 1); assert(nullGate.stats.fallback); assert(nullGate.ready(1));

for (const throws of [false, true]) {
    const failedGL = fakeGL(); let recovered = 0;
    const failed = createGpuFrameGate(() => failedGL, { onRecovered: () => recovered++ });
    failed.submitted(0); assert.equal(failed.ready(4000), false); assert(failed.stats.stalled);
    if (throws) failedGL.clientWaitSync = () => { throw Error('driver wait failure'); };
    else failedGL.status = failedGL.WAIT_FAILED;
    assert(failed.ready(4016)); assert(failed.stats.fallback); assert.equal(failed.stats.stalled, false);
    assert.equal(recovered, 1); assert.equal(failed.stats.discarded, 1); assert.equal(failed.stats.inFlight, false);
}

// Unsupported/failed fences use the ONE actual phase-preserving frame pacer,
// never a second delay measured from completion of CPU submission.
for (const refreshHz of [50, 60, 75, 80, 90, 120, 144]) for (const cpuMs of [0, 2, 8]) for (const mobile of [false, true]) {
    const fallback = createGpuFrameGate(() => ({ isContextLost: () => false }));
    const c = createQualityController({ mobile }); let now = 0;
    while (now < 14000) { now += 120; c.sample(now, { targetMs: c.state.level === 3 || mobile ? 1000 / 30 : 1000 / 60 }); }
    assert.equal(c.state.level, 3);
    let phase = -Infinity, busyUntil = 0, delivered = 0, first = 0, last = 0;
    const end = now + 90000;
    while (now < end) {
        now += 1000 / refreshHz;
        if (now < busyUntil || !fallback.ready(now)) continue;
        const hz = mobile || c.state.level === 3 || fallback.stats.fallback ? 30 : 0;
        const next = pacedFrameTime(now, phase, hz); if (next === null) continue;
        phase = next; delivered++; if (!first) first = now; last = now;
        c.sample(now, { mobile, targetMs: Math.max(hz ? 1000 / hz : 1000 / 60, fallback.stats.fallbackIntervalMs) });
        busyUntil = now + cpuMs; fallback.submitted(busyUntil);
    }
    assert.equal(c.state.level, 0, `${refreshHz} Hz/${cpuMs} ms/${mobile}: fallback recovers`);
    assert(Math.abs((last - first) / (delivered - 1) - 1000 / 30) < .3);
}

// Run the actual renderFrame implementation and scheduling wrapper for EVERY
// render exit in frameStep, across direct/lens/composer/cockpit paths.
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const wrapper = main.slice(main.indexOf('function frame() {'), main.indexOf('function frameStep() {'));
const render = main.slice(main.indexOf('function renderFrame(showCockpit) {'), main.indexOf('function finishFramePerf('));
const body = main.slice(main.indexOf('function frameStep() {'), main.indexOf('// setAnimationLoop lets WebXR'));
const exits = [...body.matchAll(/renderFrame\(([^)]+)\);/g)].map(m => m[1]); assert.equal(exits.length, 4);
for (const exit of exits) for (const path of ['direct', 'lens', 'composer']) for (const cabin of [false, true]) {
    const c = { renderSubmissionSerial: 0, submissions: 0, events: [], window: {}, VR: { active: false }, PERF: { enabled: false },
        document: { hidden: false, getElementById: () => ({ style: { display: 'none' } }) }, performance: { now: () => 1 },
        renderContext: { isLost: () => false }, bloomPass: { enabled: path === 'composer' }, lensingPass: { enabled: path === 'lens' },
        renderQuality: {}, scene: {}, camera: {}, cockpitScene: {}, cockpitCam: {}, moonBeacon: {}, lblE: {}, lblM: {}, plLabels: [], moonLabels: [],
        applyOrbitalExposureMarkers() {}, perfStart() { return 0; }, perfEnd() {}, sampleRendererInfo() {},
        sampleMemory() { c.events.push('telemetry'); }, compileCockpitNow() { c.events.push('compile-cockpit'); } };
    c.renderer = { clearDepth() { c.events.push('clear-depth'); }, render() { c.events.push('cockpit'); } };
    c.composer = { render() { c.events.push('composer'); } };
    c.renderLensedImpl = () => c.events.push('lens'); c.renderSceneTiered = () => c.events.push('direct');
    c.frameStep = () => { c.events.push('river-compute'); c.renderFrame(exit === 'false' ? false : cabin); }; // deliberately returns undefined
    c.renderFrameGate = { ready: () => true, submitted: () => { assert.equal(c.events.at(-1), 'telemetry'); assert.equal(c.renderSubmissionSerial, 1); c.submissions++; } };
    vm.createContext(c); vm.runInContext(render + wrapper + '\nframe(1);', c);
    assert.equal(c.submissions, 1); assert.equal(c.window.__AP_FIRST_FRAME, true);
    assert(c.events.includes(path)); assert.equal(c.events.includes('cockpit'), exit !== 'false' && cabin);
    const before = c.submissions; vm.runInContext('frame();', c); assert.equal(c.submissions, before, 'Explicit caller owns its completion');
}
for (const active of [false, true]) for (const ready of [false, true]) for (const xr of [false, true]) {
    const c = { renderSubmissionSerial: 0, VR: { active: xr }, document: { hidden: !active, getElementById: () => ({ style: { display: 'none' } }) },
        renderContext: { isLost: () => false }, performance: { now: () => 1 }, calls: 0, submissions: 0 };
    c.frameStep = () => { c.calls++; if (active) c.renderSubmissionSerial++; };
    c.renderFrameGate = { stats: { stalled: !ready }, ready: () => ready, submitted: () => c.submissions++ };
    c.drains = 0; c.clock = { getDelta() { c.drains++; } };
    vm.createContext(c); vm.runInContext(wrapper + '\nframe(1);', c);
    assert.equal(c.drains, active && !ready && !xr ? 1 : 0);
    assert.equal(c.calls, active && !ready && !xr ? 0 : 1); assert.equal(c.submissions, active && ready && !xr ? 1 : 0);
}
assert(body.includes('renderFrameGate.stats.fallback ? 30 : 0'));
assert(!readFileSync(new URL('../src/render/gpuFrameGate.js', import.meta.url), 'utf8').includes('gl.finish('));

function recoveryFixture(available = true) {
    const canvas = new EventTarget(), timers = new Map(), states = []; let id = 0;
    const gl = { lost: false, isContextLost() { return this.lost; }, getExtension: () => available ? extension : null };
    const extension = { losses: 0, restores: 0, loseContext() { this.losses++; gl.lost = true; }, restoreContext() { this.restores++; } };
    const controller = createGraphicsRestart({ domElement: canvas, getContext: () => gl }, {
        schedule(fn, ms) { timers.set(++id, { fn, ms }); return id; }, cancel(key) { timers.delete(key); }, onState: s => states.push(s) });
    const fire = ms => { const [key, timer] = [...timers].find(([, t]) => t.ms === ms) || []; assert(timer); timers.delete(key); timer.fn(); };
    return { canvas, timers, states, gl, extension, controller, fire };
}
const r = recoveryFixture(); assert(r.controller.restart()); assert.equal(r.controller.restart(), false);
assert.equal(r.extension.losses, 1); assert.equal(r.extension.restores, 0); assert(![...r.timers.values()].some(t => t.ms === 100));
r.canvas.dispatchEvent(new Event('webglcontextlost')); r.fire(100); assert.equal(r.extension.restores, 1);
r.canvas.dispatchEvent(new Event('webglcontextrestored')); assert(r.controller.state.pending, 'A fake restore while native GL is lost is not success');
r.gl.lost = false; r.canvas.dispatchEvent(new Event('webglcontextrestored')); assert.equal(r.controller.state.status, 'restored'); assert.equal(r.timers.size, 0);
const timeout = recoveryFixture(); timeout.controller.restart(); timeout.fire(5000); assert.equal(timeout.controller.state.status, 'timeout'); assert.equal(timeout.extension.losses, 1); assert.equal(timeout.extension.restores, 0);
const unavailable = recoveryFixture(false); assert.equal(unavailable.controller.restart(), false); assert.equal(unavailable.controller.state.status, 'unavailable'); assert.equal(unavailable.timers.size, 0);
const disposed = recoveryFixture(); disposed.controller.restart(); disposed.canvas.dispatchEvent(new Event('webglcontextlost')); disposed.controller.dispose();
assert.equal(disposed.controller.state.pending, false); assert.equal(disposed.controller.state.status, 'cancelled'); assert.equal(disposed.timers.size, 0); assert.equal(disposed.controller.restart(), false);
const alreadyLost = recoveryFixture(); alreadyLost.gl.lost = true; alreadyLost.canvas.dispatchEvent(new Event('webglcontextlost')); alreadyLost.controller.restart(); alreadyLost.fire(100); assert.equal(alreadyLost.extension.losses, 0); assert.equal(alreadyLost.extension.restores, 1);
for (const operation of ['loseContext', 'restoreContext']) {
    const failure = recoveryFixture(); failure.extension[operation] = () => { throw Error('driver failure'); };
    failure.controller.restart();
    if (operation === 'restoreContext') { failure.canvas.dispatchEvent(new Event('webglcontextlost')); failure.fire(100); }
    assert.equal(failure.controller.state.status, 'failed'); assert.equal(failure.timers.size, 0);
}
const scene = readFileSync(new URL('../src/scene.js', import.meta.url), 'utf8');
assert(scene.includes("event => { if (!event.persisted) graphicsRestart.dispose(); }"), 'BFCache preserves a pending user-requested restart');
assert(readFileSync(new URL('../src/render/qualityControls.css', import.meta.url), 'utf8').includes('#restartGraphics[hidden] { display:none!important; }'));
console.log('GPU backpressure: every actual render exit, one outstanding sync, 120s stall notice, accounting/lifecycle, phase-correct fallback with CPU cost, user-only bounded restart and BFCache controls pass.');
