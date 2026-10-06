import assert from 'node:assert/strict';
import { boundedDiagnostic } from './qa-bounded-diagnostic.mjs';
assert.deepEqual(await boundedDiagnostic(() => 42), { ok: true, value: 42 });
assert.match((await boundedDiagnostic(() => { throw new Error('original'); })).error, /original/);
const start = performance.now();
assert.match((await boundedDiagnostic(() => new Promise(() => {}), 20)).error, /timed out/);
assert(performance.now() - start < 250, 'Blocked diagnostics return within the declared deadline');
let rejectLate;
assert.equal((await boundedDiagnostic(() => new Promise((_, reject) => { rejectLate = reject; }), 5)).ok, false);
rejectLate(new Error('late renderer failure'));
await new Promise(resolve => setTimeout(resolve, 0));
console.log('Time Dock diagnostics: success, error, blocked renderer and late rejection passed');

// Execute the actual live fixture pulse with skipped and delivered callbacks.
const { readFileSync } = await import('node:fs');
const source = readFileSync(new URL('./smoke-time-dock.mjs', import.meta.url), 'utf8');
const startPulse = source.indexOf('    // Wait for a produced physics tick');
const pulse = source.slice(startPulse, source.indexOf('    return expected;', startPulse));
assert(startPulse >= 0 && pulse.includes('}, 3000)'));
const runPulse = new Function('WORLD','setWarp','requestAnimationFrame','setTimeout','clearTimeout', `return (async()=>{${pulse}})()`);
for (const skipped of [0,1,5,120]) {
  const world = { reverseBlocked: false }, queued = [], calls = []; let deadline, cancelled = 0;
  const result = runPulse(world, (...args) => calls.push(args), fn => queued.push(fn), fn => { deadline=fn; return 7; }, id => { assert.equal(id,7);cancelled++; });
  for (let i=0;i<skipped;i++) { queued.shift()(); assert.equal(calls.length,0); assert.equal(queued.length,1); }
  world.reverseBlocked=true;queued.shift()();await result;
  assert.deepEqual(calls,[[3600,'dock-smoke-release']]);assert.equal(cancelled,1);assert.equal(queued.length,0);
}
const queued = [], calls = []; let expire;
const never = runPulse({reverseBlocked:false},()=>calls.push('release'),fn=>queued.push(fn),fn=>{expire=fn;},()=>{});
const rejected = assert.rejects(never,/No production reverse-block pulse within 3000ms/);
expire();queued.shift()();await rejected;assert.equal(calls.length,0);assert.equal(queued.length,0);
assert(source.includes('timeout: 3000') && source.includes('latchStartedAt + 1000') && source.includes('latchStartedAt + 1700'));
console.log('Time Dock pulse: release follows one actual blocked production step despite skipped RAF callbacks; never-produced pulse still fails within3s.');
