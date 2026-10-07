import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bindContextLifecycle } from '../src/render/contextLifecycle.js';

function fixture() {
    const canvas = new EventTarget(), timers = new Map();
    let now = 0, serial = 0, notices = 0, holds = 0, restores = 0;
    const gl = { lost: false, isContextLost() { return this.lost; } };
    const context = bindContextLifecycle({ domElement: canvas, getContext: () => gl }, {
        onLost: () => holds++, onRestored: () => restores++, onRecoveryTimeout: () => notices++,
        schedule(fn, ms) { timers.set(++serial, { fn, at: now + ms }); return serial; },
        cancel(id) { timers.delete(id); },
    });
    function advance(ms) {
        now += ms;
        for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    }
    function lose() { gl.lost = true; canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })); }
    function restore() { gl.lost = false; canvas.dispatchEvent(new Event('webglcontextrestored')); }
    return { canvas, gl, context, timers, advance, lose, restore,
        counts: () => ({ holds, restores, notices }) };
}

const f = fixture();
f.gl.lost = true;
assert(f.context.isLost(), 'Poll starts the deadline even before the native loss event');
const oldDeadline = [...f.timers.values()][0].fn;
f.advance(4999); assert.equal(f.counts().notices, 0);
f.lose(); assert.equal(f.timers.size, 1, 'Delayed/duplicate events cannot postpone the deadline');
f.advance(1); assert.equal(f.counts().notices, 1); assert(f.context.recoveryTimedOut);
f.advance(120000); assert.equal(f.counts().notices, 1); assert(f.context.isLost(), 'Timeout never releases flight hold');
f.canvas.dispatchEvent(new Event('webglcontextrestored'));
assert(f.context.isLost(), 'A restore event while native GL is lost is not recovery');
f.restore(); assert(!f.context.isLost()); assert(!f.context.recoveryTimedOut);
assert.deepEqual(f.counts(), { holds: 1, restores: 1, notices: 1 });
f.lose(); oldDeadline(); assert.equal(f.counts().notices, 1, 'A stale callback cannot expire a newer outage');
f.advance(3000); f.restore(); f.advance(3000);
assert.equal(f.counts().notices, 1, 'Prompt recovery cancels the warning');
f.lose(); f.advance(5000); assert.equal(f.counts().notices, 2, 'Repeated outages each get a bounded escape');

// Execute the production pagehide registration, rather than a copied policy.
const scene = readFileSync(new URL('../src/scene.js', import.meta.url), 'utf8');
const registration = scene.split('\n').find(line => line.includes("window.addEventListener('pagehide'") && line.includes('renderContext.dispose()'));
assert(registration);
const page = new EventTarget();
vm.runInNewContext(registration, { window: page, renderContext: f.context });
const pagehide = persisted => { const event = new Event('pagehide'); event.persisted = persisted; page.dispatchEvent(event); };
f.restore(); f.lose(); f.advance(1000); pagehide(true);
assert.equal(f.timers.size, 1, 'BFCache suspension retains the original deadline');
f.advance(4000); assert.equal(f.counts().notices, 3); f.restore(); assert(!f.context.isLost());
f.lose(); const teardownDeadline = [...f.timers.values()][0].fn; pagehide(false);
assert.equal(f.timers.size, 0); teardownDeadline(); f.advance(5000);
assert.equal(f.counts().notices, 3, 'Teardown cancels even a queued callback');
const disposedCounts = f.counts(); f.restore(); f.lose();
assert.deepEqual(f.counts(), disposedCounts, 'Teardown releases listeners');
console.log('PASS: natural context-loss deadline, delayed event, never/late/repeated restore, stale timers, BFCache retention and teardown cleanup');
