// Execute the actual scene cancellation functions with pointer-state doubles.
// No graphics context is required and no implementation is copied into tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/scene.js',import.meta.url),'utf8');
const slice=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const released=[],cleared=[];
const state={active:true,pending:true,armed:true,id:91,timer:42,vx:99,vy:88,vz:77};
const context=vm.createContext({shipGrab:state,ptrs:new Map([[91,{}],[92,{}]]),pinchD:20,Set,
 clearTimeout:id=>cleared.push(id),el:{hasPointerCapture:()=>true,releasePointerCapture:id=>released.push(id)},
 document:{body:{classList:{contains:name=>name==='scenario-playing'}}}});
vm.runInContext(slice('function resetShipGrab()','function startShipGrab(e)')+slice('function cancelPointerGestures()','window.addEventListener("ap:releaseflightinput"')+slice('function startShipGrab(e)','function activateShipGrab(e'),context);
vm.runInContext('cancelPointerGestures()',context);
assert.equal(state.active,false);assert.equal(state.pending,false);assert.equal(state.armed,false);assert.equal(state.id,-1);assert.equal(state.timer,0);
assert.deepEqual(cleared,[42]);assert.deepEqual(released,[91,92]);assert.equal(context.ptrs.size,0);assert.equal(context.pinchD,0);
assert.equal(vm.runInContext('startShipGrab({})',context),false,'guided ownership rejects new ship grabs before any state mutation');
vm.runInContext('cancelPointerGestures()',context);assert.deepEqual(cleared,[42],'repeated cancellation harmless');
console.log('Production ship-grab cancellation releases timers and captures without throwing the restored ship');
