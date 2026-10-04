import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { captureCompletedAppMotionFrame, instrumentAppMotionCompletion } from './galaxy-app-motion-capture.mjs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const start = 'function frameStep() {', end = '    const frameT0 = perfStart();';
assert.equal(main.split(start).length, 2);
const entry = main.slice(main.indexOf(start) + start.length);
assert.equal(entry.split(end).length, 2);
// Use the production early-return/throttle code, not a mock that always draws.
const actualGuard = entry.slice(0, entry.indexOf(end));
let checks = 0;
function ok(name, fn) { fn(); checks++; console.log('PASS', name); }
async function rejects(name, run, pattern) { await assert.rejects(run, pattern); checks++; console.log('PASS', name); }

function fixture(options = {}) {
    const state = { now: 34, completed: 0, frame: 0, alpha: 0, pngCalls: 0, reads: 0, delays: 0 };
    const vector = values => ({ toArray: () => values.slice() });
    const G = { t: 0, paused: true, focus: 'sun', x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6 };
    const cam = { dist: 1e7, distTarget: null, tgt: vector([0, 0, 0]), yaw: .1, pitch: .2 };
    const camera = { fov: 18, aspect: 1, position: vector([1, 2, 3]), quaternion: vector([0, 0, 0, 1]), projectionMatrix: vector([1, 0, 0, 1]) };
    const gl = { drawingBufferWidth: options.wrongSize ? 1 : 2, drawingBufferHeight: 2,
        RGBA: 6408, UNSIGNED_BYTE: 5121, NO_ERROR: 0,
        VENDOR: 7936, RENDERER: 7937, VERSION: 7938, SHADING_LANGUAGE_VERSION: 35724,
        getExtension: () => null, getParameter: parameter => 'fixture-' + parameter,
        isContextLost: () => false, getError: () => options.glError ? 1282 : 0,
        readPixels(x, y, w, h, format, type, pixels) {
            state.reads++; pixels.fill(0);
            for (let i = 3; i < pixels.length; i += 4) pixels[i] = state.alpha;
        } };
    const renderer = { getContext: () => gl, getPixelRatio: () => options.wrongDpr ? .5 : 1,
        getRenderTarget: () => options.offscreen ? {} : null,
        domElement: { toDataURL() { state.pngCalls++; return 'data:image/png;base64,' + (state.alpha ? 'opaque' : 'transparent'); } } };
    const window = { __G: G, appTest: { s: { cam, camera, renderer, renderQuality: { mobile: true } }, ship: [1, 2, 3, 4, 5, 6],
        v: { galaxyVolumeStats: () => ({ draft: options.staleSettled
            ? state.completed >= 2 && state.completed < 4 : !!options.settling && state.completed < 3, renders: state.completed }) } },
        __captureAppFrameState: () => ({ completed: state.completed, frame: state.frame }) };
    const context = vm.createContext({ window, state, options, performance: { now: () => state.now },
        renderContext: { isLost: () => false }, document: { hidden: false, getElementById: () => ({ style: { display: 'none' } }) },
        clock: { getDelta: () => 0 }, renderQuality: { mobile: true }, VR: { active: false },
        innerWidth: options.wrongHost ? 3 : 2, innerHeight: 2,
        setTimeout(fn, ms) { state.delays++; state.now += ms; state.alpha = 0; if (options.moveWhileWaiting) cam.dist++; fn(); } });
    vm.runInContext(`let lastMobileFrame=0;
        window.__captureAppFrame=()=>{${actualGuard}
            if(!options.freezeFrame)state.frame++;
            if(!options.noCompletion)state.completed++;
            state.alpha=options.transparent?0:255;
            if(options.advanceTime)window.__G.t++;
        };`, context);
    const run = (settings = {}) => vm.runInContext(`(${captureCompletedAppMotionFrame.toString()})`, context)({
        distance: 1e7, width: 2, height: 2, timeoutMs: 80, ...settings });
    const settleThenTaskBoundary = () => { window.__captureAppFrame(); state.now++; state.alpha = 0; };
    return { state, window, renderer, run, settleThenTaskBoundary };
}

for (const name of ['app-start', 'app-stop', 'app-return']) {
    const f = fixture(); f.settleThenTaskBoundary(); const before = f.state.completed;
    f.window.__captureAppFrame();
    ok(`${name}: former separate-task capture is throttled and transparent`, () => {
        assert.equal(f.state.completed, before);
        assert.equal(f.renderer.domElement.toDataURL(), 'data:image/png;base64,transparent');
    });
    const captured = await f.run({ settled: true });
    ok(`${name}: wait for real completed frame, copy pixels and PNG in same task`, () => {
        assert(captured.capture.skipped > 0 && f.state.delays > 0);
        assert(captured.capture.after.completed > captured.capture.before.completed);
        assert(captured.capture.after.frame > captured.capture.before.frame);
        assert.equal(captured.png, 'data:image/png;base64,opaque');
        assert.equal(captured.capture.alphaNonzero, 4);
        assert.equal(captured.time, 0);
        assert.equal(JSON.stringify(captured.ship), '[1,2,3,4,5,6]');
    });
}

const black = await fixture().run();
ok('Genuinely black opaque frames are valid', () => {
    assert.equal(black.capture.litPixels, 0);
    assert.equal(black.capture.opaquePixels, 4);
});
await rejects('Completed transparent image is rejected, without retrying it', () => fixture({ transparent: true }).run(), /Transparent completed/);
const missing = fixture({ noCompletion: true });
await rejects('Frame entry without completed render cannot capture', () => missing.run(), /No completed/);
ok('No readback or PNG from an uncompleted render', () => { assert.equal(missing.state.reads, 0); assert.equal(missing.state.pngCalls, 0); });
await rejects('Render counter alone without frame advancement cannot capture', () => fixture({ freezeFrame: true }).run(), /No completed/);
await rejects('Wrong drawing-buffer dimensions fail', () => fixture({ wrongSize: true }).run(), /wrong viewport/);
await rejects('Wrong host dimensions fail', () => fixture({ wrongHost: true }).run(), /wrong viewport/);
await rejects('Wrong DPR fails', () => fixture({ wrongDpr: true }).run(), /wrong viewport/);
await rejects('Offscreen target fails', () => fixture({ offscreen: true }).run(), /default framebuffer/);
await rejects('GL readback error fails', () => fixture({ glError: true }).run(), /WebGL readback error/);
await rejects('Unexpected requested distance fails', () => fixture().run({ distance: 2e7 }), /Unexpected requested/);
await rejects('Physical epoch advancement fails', () => fixture({ advanceTime: true }).run(), /epoch or requested camera changed/);
const moved = fixture({ moveWhileWaiting: true }); moved.settleThenTaskBoundary();
await rejects('Requested camera movement during cadence wait fails', () => moved.run(), /state changed while waiting/);
const settled = await fixture({ settling: true }).run({ settled: true, timeoutMs: 160 });
ok('Settled view waits for a completed nondraft render', () => { assert.equal(settled.volume.draft, false); assert.equal(settled.volume.renders, 3); });
const stale = fixture({ staleSettled: true }); stale.settleThenTaskBoundary();
ok('Old settled metadata can precede a throttled capture', () => assert.equal(stale.window.appTest.v.galaxyVolumeStats().draft, false));
const refreshed = await stale.run({ settled: true, timeoutMs: 240 });
ok('Stale settled metadata cannot bypass fresh completed convergence', () => {
    assert.equal(refreshed.volume.draft, false); assert.equal(refreshed.volume.renders, 4);
    assert.equal(stale.state.pngCalls, 1);
});

ok('Exact production completion seam is instrumented once', () => {
    assert(instrumentAppMotionCompletion(main).includes('window.__captureAppFrameState'));
    assert.throws(() => instrumentAppMotionCompletion(main.replace('    sampleMemory();\n}', '    sampleMemory();\n /* unknown */}')), /completed renderFrame seam/);
    assert.throws(() => instrumentAppMotionCompletion(main + '\n    sampleMemory();\n}'), /completed renderFrame seam/);
});
const hookWindow = {}, hookState = { lost: false, duringDrawLoss: false };
const hookContext = vm.createContext({ window: hookWindow, frameNo: 7, renderContext: { isLost: () => hookState.lost },
    draw: () => { if (hookState.duringDrawLoss) hookState.lost = true; }, sampleMemory: () => {} });
vm.runInContext(instrumentAppMotionCompletion('function renderFrame(){\n    if(renderContext.isLost())return;\n    draw();\n    sampleMemory();\n}'), hookContext);
vm.runInContext('renderFrame()', hookContext);
ok('Completed draw increments real hook telemetry', () => assert.equal(hookWindow.__captureAppFrameState().completed, 1));
hookState.lost = true; vm.runInContext('renderFrame()', hookContext);
ok('Context early return does not increment completion', () => assert.equal(hookWindow.__captureAppFrameState().completed, 1));
hookState.lost = false; hookState.duringDrawLoss = true; vm.runInContext('renderFrame()', hookContext);
ok('Loss during draw does not increment completion', () => assert.equal(hookWindow.__captureAppFrameState().completed, 1));
console.log(`PASS ${checks} app-motion completed-capture controls; production throttle unchanged`);
