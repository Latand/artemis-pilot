// CPU-only tests: execute the exact production hover callbacks while paused.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { appendReadOnlyHoverInspection, productionHoverCallbacks, installPointerAudit,
    assertParkedPointer, assertFrozenPointer, assertPointerCaptures, parkNeutralPointer, POINTER_FIXTURE_POLICY } from './disk-pointer-fixture.mjs';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const scene = readFileSync(new URL('../src/scene.js', import.meta.url), 'utf8');
const appended = appendReadOnlyHoverInspection(main);
assert(appended.startsWith(main), 'Inspection appends a getter without editing production callbacks');
assert.throws(() => appendReadOnlyHoverInspection(main.replace('function updateHover(w, h) {', 'function changedHover() {')));

class Vector {
    constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
    set(x, y, z) { Object.assign(this, { x, y, z }); return this; }
    normalize() { const n = Math.hypot(this.x, this.y, this.z) || 1; return this.set(this.x / n, this.y / n, this.z / n); }
    distanceTo(p) { return Math.hypot(this.x - p.x, this.y - p.y, this.z - p.z); }
    setScalar(n) { return this.set(n, n, n); }
    toArray() { return [this.x, this.y, this.z]; }
}
const identity = { toArray: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
const glyph = () => ({ visible: false, position: new Vector(), scale: new Vector(1, 1, 1), matrixWorld: identity,
    quaternion: { setFromUnitVectors() {}, toArray: () => [0, 0, 0, 1] }, material: { opacity: .9, depthTest: false, depthWrite: true } });
const eventCallbacks = {}, canvasCallbacks = {}, target = new Vector(10, 20, 30);
const context = { window: {}, BODY_NONE: -99, BODY_EARTH: -3, BODY_MOON: -2, BODY_SUN: -1,
    hoverBodyTarget: -99, lockedBodyTarget: -99, labelHoverTarget: -99, labelPtr: null, labelPtrPos: [0, 0],
    lastPtr: null, lastPtrPos: [0, 0], G: { paused: true, t: 0, focus: 'free' }, BH: { n: 1, vx: [0], vy: [0], rs: [50000] },
    eph: { earthVx: 10, earthVy: 20 }, _hv: {}, _bhFocusPos: {}, _hoverProbePos: {}, hoverProject: [],
    isBHTarget: value => value === 'bh:0', targetBHIndex: () => 0, bhFocusValue: () => 'bh:0',
    stellarTarget: () => false, isTargetDestroyed: () => false, bhScenePos: () => target,
    camera: { position: new Vector() }, cam: { dist: 600 }, LY_SCENE: 1e10,
    WORLD: { earthDestroyed: true, moonDestroyed: true, sunDestroyed: true }, PL: [],
    screenDistance: (_, x, y) => Math.hypot(x - 10, y - 20),
    _hoverBestPos: { copy: value => value }, velocityGuideFade: () => 1, fmtKm: String,
    hoverTipEl: { style: {}, textContent: '' }, hovDir: new Vector(), upHover: new Vector(0, 1, 0),
    hovLine: glyph(), hovCone: glyph(), hovLinePos: new Float32Array(6), hovLineAttr: { version: 0 },
    el: { addEventListener: (name, callback) => { canvasCallbacks[name] = callback; } } };
vm.createContext(context);
vm.runInContext(productionHoverCallbacks(main), context);
vm.runInContext(appended.slice(main.length), context);
const label = { addEventListener: (name, callback) => { eventCallbacks[name] = callback; } };
context.bindBodyLabel(label, 'bh:0', () => {});
eventCallbacks.pointerenter({ clientX: 10, clientY: 20 });
assert.equal(context.labelHoverTarget, 'bh:0');
context.updateHover(960, 640);
assert(context.hovLine.visible && context.hovCone.visible, 'Exact production callbacks activate both glyphs despite paused G.t');
assert.equal(context.G.t, 0); assert(context.G.paused);
const snapshot = context.window.__diskPlaneHoverSnapshot();
snapshot.line.positions[0] = 999;
assert.notEqual(context.hovLinePos[0], 999, 'Read-only inspection returns copies');
eventCallbacks.pointerleave();
context.updateHover(960, 640);
assert.equal(context.labelHoverTarget, -99); assert.equal(context.hoverBodyTarget, -99);
assert(!context.hovLine.visible && !context.hovCone.visible, 'Normal pointerleave and the next production update hide both glyphs');
assert.equal(context.G.t, 0);

// The scene's actual listener retains lastPtr. Leaving a label alone cannot
// clear a stale canvas pointer; acceptance must inspect the production result.
const start = scene.indexOf('el.addEventListener("pointermove", e => {');
const end = scene.indexOf('\n});', start);
assert(start >= 0 && end > start);
vm.runInContext(scene.slice(start, end + 4), context);
canvasCallbacks.pointermove({ clientX: 10, clientY: 20 });
context.updateHover(960, 640);
assert(context.hovCone.visible); assert.equal(context.labelHoverTarget, -99);

const neutral = () => ({ sequence: 1, event: { sequence: 1, trusted: true, pointerType: 'mouse', buttons: 0,
    x: 20, y: 30, controlId: 'exploreHelp' }, control: { id: 'exploreHelp', visible: true, hovered: true, pointInside: true },
    hit: { controlId: 'exploreHelp', scene: false, label: false },
    production: { paused: true, t: 0, bodyNone: -99, hoverBodyTarget: -99, labelHoverTarget: -99, labelPtr: null,
        hoverTipDisplay: 'none', line: { visible: false }, cone: { visible: false } } });
assertFrozenPointer(neutral());
assert.throws(() => assertFrozenPointer({ ...neutral(), production: context.window.__diskPlaneHoverSnapshot() }), /active production hover/);
for (const change of [
    s => { s.event.trusted = false; }, s => { s.event.pointerType = 'touch'; }, s => { s.event.buttons = 1; },
    s => { s.control.hovered = false; }, s => { s.control.visible = false; }, s => { s.control.pointInside = false; },
    s => { s.hit.controlId = null; }, s => { s.hit.scene = true; }, s => { s.hit.label = true; },
    s => { s.production.line.visible = true; }, s => { s.production.cone.visible = true; },
    s => { s.production.labelHoverTarget = 'bh:0'; }, s => { s.production.hoverBodyTarget = 'bh:0'; },
    s => { s.production.labelPtr = [10, 20]; }, s => { s.production.t = 1; }, s => { s.production = null; },
]) { const s = neutral(); change(s); assert.throws(() => assertFrozenPointer(s), /Pointer fixture blocked/); }
assert.throws(() => assertParkedPointer(neutral(), 1), /not verified/, 'stale input cannot prove a new park');

// Execute the exact browser-side audit against a minimal DOM. It observes
// trusted events and live hit/:hover state without dispatching or clearing.
let pointerListener, hovered = true, hitControl = true;
const control = { id: 'exploreHelp', tagName: 'BUTTON', isConnected: true,
    getBoundingClientRect: () => ({ x: 10, y: 20, left: 10, right: 50, top: 20, bottom: 60, width: 40, height: 40 }),
    matches: () => hovered, closest: selector => selector === '#exploreHelp' ? control : null };
const audit = { window: { addEventListener: (name, callback) => { assert.equal(name, 'pointermove'); pointerListener = callback; },
    __diskPlaneHoverSnapshot: () => neutral().production }, document: { querySelector: () => control,
    elementFromPoint: () => hitControl ? control : { tagName: 'CANVAS', closest: selector => selector === '#gl' ? {} : null } },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
vm.runInNewContext(`(${installPointerAudit.toString()})()`, audit);
pointerListener({ clientX: 20, clientY: 30, isTrusted: true, pointerType: 'mouse', buttons: 0, timeStamp: 123, target: control });
assertFrozenPointer(audit.window.__diskPlanePointerSnapshot());
hovered = false; assert.throws(() => assertParkedPointer(audit.window.__diskPlanePointerSnapshot())); hovered = true;
hitControl = false; assert.throws(() => assertParkedPointer(audit.window.__diskPlanePointerSnapshot())); hitControl = true;

function mockPage({ blocked = false, missing = false } = {}) {
    let sequence = 0, read = 0, moves = [];
    const page = { locator(selector) { assert.equal(selector, '#exploreHelp'); return {
        waitFor: async options => assert.equal(options.state, 'visible'),
        boundingBox: async () => missing ? null : ({ x: 10, y: 20, width: 40, height: 40 }) }; },
        mouse: { move: async (x, y) => { moves.push([x, y]); sequence++; } },
        evaluate: async () => {
            if (++read % 2) return sequence;
            const s = neutral(); s.sequence = s.event.sequence = sequence;
            if (blocked) s.hit.scene = true;
            return s;
        } };
    return { page, moves };
}
const parked = mockPage();
for (let i = 1; i <= 5; i++) assert.equal((await parkNeutralPointer(parked.page)).operation, i);
assert.equal(parked.moves.length, 5, 'exactly one real move per planned operation');
assert.notDeepEqual(parked.moves[0], parked.moves[1]);
const blocked = mockPage({ blocked: true }); await assert.rejects(parkNeutralPointer(blocked.page), /Pointer fixture blocked/);
assert.equal(blocked.moves.length, 1, 'blocked park has no retry or synthetic fallback');
const missing = mockPage({ missing: true }); await assert.rejects(parkNeutralPointer(missing.page), /usable visible bounds/);
assert.equal(missing.moves.length, 0);
assert.equal(POINTER_FIXTURE_POLICY.addedAppFrames, 0); assert.equal(POINTER_FIXTURE_POLICY.addedReadbacks, 0);

const probe = readFileSync(new URL('./probe-disk-plane.mjs', import.meta.url), 'utf8');
assert(probe.indexOf('before-hole-setup') < probe.indexOf('qa.bh.addBlackHole('));
assert(probe.includes('local.pointerParks.push({ phase, ...await parkNeutralPointer(page) });'));
assert(probe.includes('pointer.after = window.__diskPlanePointerSnapshot();'));
const cleanupStart = probe.indexOf('// POINTER_AFTER_CLEANUP_BEGIN');
const cleanupEnd = probe.indexOf('// POINTER_AFTER_CLEANUP_END', cleanupStart);
const cleanup = probe.slice(probe.indexOf('\n', cleanupStart) + 1, cleanupEnd);
const afterFailure = { pointer: { before: neutral(), after: null },
    window: { __diskPlanePointerSnapshot() { throw Error('after snapshot failure'); } },
    lens: { lensingPass: { uniforms: { uN: { value: 0 } } } }, lensCount: 1,
    s: { bloomPass: { enabled: false } }, bloomEnabled: true,
    disk: { material: { depthTest: false }, onAfterRender() {} }, diskAfterRender() {}, original: { diskDepthTest: true } };
vm.runInNewContext(cleanup, afterFailure);
assert.equal(afterFailure.lens.lensingPass.uniforms.uN.value, 1);
assert.equal(afterFailure.s.bloomPass.enabled, true);
assert.equal(afterFailure.disk.material.depthTest, true);
assert.equal(afterFailure.disk.onAfterRender, afterFailure.diskAfterRender);
assert.match(afterFailure.pointer.afterReadError, /after snapshot failure/);
assert.throws(() => assertPointerCaptures([afterFailure.pointer]), /after-draw inspection failed/);
assert(probe.indexOf('await preservePointerCaptures(variant, test, phase, [result])') < probe.indexOf('assertLiveCase(result);'));
assert(probe.includes("await preservePointerCaptures(variant, test, 'original-stability', [a, b])"));
assert(!probe.includes('dispatchEvent(') && !probe.includes('hoverBodyTarget =') && !probe.includes('hovCone.visible ='), 'Browser fixture never simulates clearing the production hover state');
console.log('Pointer fixture CPU smoke passed: exact paused production pointer/hover callbacks, retained lastPtr negative, read-only glyph snapshots, trusted hit/:hover evidence, one-move parks, blocked-state rejection, and no synthetic clearing. No browser/GPU executed.');
