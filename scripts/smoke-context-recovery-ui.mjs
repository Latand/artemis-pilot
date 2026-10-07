import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bindContextLifecycle } from '../src/render/contextLifecycle.js';
import { createGraphicsRestart } from '../src/render/graphicsRestart.js';
import { createGpuFrameGate } from '../src/render/gpuFrameGate.js';

// Execute production UI wiring with real lifecycle/restart/fence controllers.
// This checks callback ordering, not browser layout or physical GPU recovery.
const source = readFileSync(new URL('../src/scene.js', import.meta.url), 'utf8');
const start = source.indexOf('const contextStatus =');
const end = source.indexOf('export const scene =');
assert(start >= 0 && end > start, 'Production recovery UI source is present');
const code = source.slice(start, end).replace('export const renderContext', 'const renderContext');
class Element extends EventTarget {
    constructor() { super(); this.style = {}; this.children = []; }
    setAttribute() {}
    appendChild(el) {
        if (el.parentNode) el.parentNode.children = el.parentNode.children.filter(child => child !== el);
        this.children.push(el); el.parentNode = this; el.mounts = (el.mounts || 0) + 1;
    }
}
let time = 0, id = 0, reloads = 0;
const timers = new Map();
const schedule = (fn, ms) => { timers.set(++id, { fn, at: time + ms }); return id; };
const cancel = id => timers.delete(id);
const canvas = new Element();
const gl = {
    lost: false,
    isContextLost() { return this.lost; },
    getExtension() { return ext; },
    fenceSync() { return {}; },
    deleteSync() {},
    clientWaitSync() { return 1; },
    flush() {},
    TIMEOUT_EXPIRED: 1,
};
const ext = {
    losses: 0, restores: 0,
    loseContext() { this.losses++; gl.lost = true; },
    restoreContext() { this.restores++; },
};
const renderer = { domElement: canvas, getContext: () => gl, setRenderTarget() {} };
const window = new EventTarget();
const document = Object.assign(new EventTarget(), { body: new Element(), fullscreenElement: null,
    createElement: () => new Element() });
const c = {
    window,
    document,
    cvHost: new Element(), renderer, keys: new Set(), G: {}, Event,
    location: { reload() { reloads++; } },
    resetRenderPerformance() {},
    createGraphicsRestart: (r, o) => createGraphicsRestart(r, { ...o, schedule, cancel }),
    bindContextLifecycle: (r, o) => bindContextLifecycle(r, { ...o, schedule, cancel }),
};
vm.createContext(c);
c.renderFrameGate = createGpuFrameGate(() => gl, {
    onStall: () => vm.runInContext('showRenderStall()', c),
    onRecovered: () => vm.runInContext('clearRenderStall()', c),
});
vm.runInContext(code, c);
const read = () => vm.runInContext('({ hidden: contextStatus.hidden, buttonHidden: restartGraphics.hidden, disabled: restartGraphics.disabled, text: restartGraphics.textContent, message: contextMessage.textContent, lost: renderContext.lost, reloadRequired, pending: graphicsRestart.state.pending })', c);
const fire = ms => {
    time += ms;
    for (const [key, timer] of [...timers]) if (timer.at <= time) { timers.delete(key); timer.fn(); }
};
const lose = () => { gl.lost = true; canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); };
const restore = () => { gl.lost = false; canvas.dispatchEvent(new Event('webglcontextrestored')); };
const notice = vm.runInContext('contextStatus', c);
assert.equal(notice.parentNode, document.body, 'Notice escapes the canvas/root stacking context');
window.dispatchEvent(new Event('pageshow'));
assert.equal(notice.mounts, 1, 'An unchanged host does not detach a potentially focused Reload button');

// Natural loss preempts a diagnosed fence stall; reset's onRecovered cannot hide the loss.
c.renderFrameGate.submitted(0);
assert(!c.renderFrameGate.ready(4500));
assert(!read().buttonHidden);
lose();
assert(!read().hidden);
assert(read().buttonHidden);
fire(5000);
assert(read().reloadRequired);
assert(!read().buttonHidden);
assert(read().lost);
assert.equal(reloads, 0);
const fullscreenRoot = new Element();
document.fullscreenElement = fullscreenRoot; document.dispatchEvent(new Event('fullscreenchange'));
assert.equal(notice.parentNode, fullscreenRoot, 'Fullscreen retains the existing notice and Reload button');
assert(read().reloadRequired && read().lost);
const pagehide = persisted => { const event = new Event('pagehide'); event.persisted = persisted; window.dispatchEvent(event); };
pagehide(true);
document.fullscreenElement = null; // Fullscreen can end while the document is suspended.
window.dispatchEvent(new Event('pageshow'));
assert.equal(notice.parentNode, document.body, 'BFCache return remounts at the current page/fullscreen root');
document.fullscreenElement = fullscreenRoot; document.dispatchEvent(new Event('fullscreenchange'));
assert.equal(notice.parentNode, fullscreenRoot, 'BFCache keeps fullscreen listeners');
document.fullscreenElement = null; document.dispatchEvent(new Event('fullscreenchange'));
assert.equal(notice.parentNode, document.body);
assert(read().reloadRequired && read().lost);
restore();
assert(read().hidden);
assert(!read().lost);
assert.equal(timers.size, 0);

// Synthetic restart's listener fires first on restoration: lifecycle must clear the final UI.
vm.runInContext('showRenderStall(); restartGraphics.dispatchEvent(new Event("click"))', c);
assert(read().pending);
assert(read().disabled);
canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
fire(100);
assert.equal(ext.restores, 1);
restore();
assert(read().hidden);
assert(!read().pending);
assert(!read().reloadRequired);
assert.equal(timers.size, 0);

// Restart deadline may precede a delayed native loss event; recovery remains usable.
vm.runInContext('showRenderStall(); restartGraphics.dispatchEvent(new Event("click"))', c);
fire(5000);
assert(read().reloadRequired);
canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
assert(read().buttonHidden);
fire(5000);
assert(read().reloadRequired);
assert(!read().buttonHidden);
restore();
assert(read().hidden);
assert.equal(reloads, 0);
pagehide(false);
document.fullscreenElement = fullscreenRoot; document.dispatchEvent(new Event('fullscreenchange'));
window.dispatchEvent(new Event('pageshow'));
assert.equal(notice.parentNode, document.body, 'Teardown releases fullscreen and pageshow listeners');
assert.equal(timers.size, 0);
console.log('PASS integrated production UI callbacks: page/fullscreen mounting, natural loss during diagnosed fence stall, ordered synthetic restore, delayed loss after restart timeout; no automatic reload.');
