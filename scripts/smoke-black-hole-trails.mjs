import assert from 'node:assert/strict';
import { BlackHolePath, HOLE_PATH_CAPACITY, HOLE_PATH_MAX_SECONDS, HOLE_PATH_MIN_SECONDS } from '../src/render/blackHolePath.js';
const options = { scenePerPixel: 1, speed: 1, stepLimit: 1, epoch: 100 };
const buffers = () => ({ p: new Float32Array(HOLE_PATH_CAPACITY*6), c: new Float32Array(HOLE_PATH_CAPACITY*6), a: new Float32Array(HOLE_PATH_CAPACITY*2) });
function write(path, time, clock, origin = [0,0,0]) { const b=buffers();return {...b,n:path.write(b.p,b.c,b.a,origin,time,clock)}; }
function run(speed, seconds, fps=60, offset=0) {
 const path=new BlackHolePath();
 for(let k=0;k<=seconds*fps;k++)path.sample(offset+speed*k/fps,0,0,k/fps,k/fps,{...options,speed});
 return path;
}
const slow=run(.5,30),s=write(slow,30,30,[15,0,0]);
assert(s.n>2);assert(slow.history.count<=HOLE_PATH_CAPACITY);assert.equal(slow.lifetime,HOLE_PATH_MAX_SECONDS);
assert(Math.min(...s.p.filter((_,i)=>i%3===0)) < -8, 'half-pixel/second movement retains a readable real trace');
assert(s.a.every(a=>a>=0&&a<=1));assert(s.a[s.n-1]>.99);assert(s.a[0]<.01);
console.log('PASS slow movement retains up to 18 seconds of actual, smoothly faded motion');
const fast=run(200,30,240),f=write(fast,30,30,[6000,0,0]);
assert.equal(fast.lifetime,HOLE_PATH_MIN_SECONDS);assert(fast.history.count<=HOLE_PATH_CAPACITY);assert(f.n<=HOLE_PATH_CAPACITY*2);assert(f.n>10);
assert(Math.min(...f.p.filter((_,i)=>i%3===0)) >= -200*HOLE_PATH_MIN_SECONDS-1);
console.log('PASS fast / 240 Hz motion remains short-lived with fixed memory and geometry');
const zero=run(0,40);assert.equal(write(zero,40,40).n,0);
const frozen=JSON.stringify(slow.history.points);for(let i=0;i<100;i++)slow.sample(15,0,0,30,30,{...options,scenePerPixel:10**(i/10)});
assert.equal(JSON.stringify(slow.history.points),frozen);assert.equal(write(slow,30,30,[15,0,0]).n,s.n);
assert.equal(write(slow,30,49,[15,0,0]).n,0);
console.log('PASS stationary objects draw no tail; paused camera / zoom cannot add motion; stopped history expires');
const jump=run(1,5);jump.sample(999,0,0,5,5,options);assert.equal(jump.history.count,1);assert.equal(write(jump,5,5).n,0);
jump.sample(1000,0,0,6,6,options);assert(write(jump,6,6).n>0);
jump.sample(1001,0,0,7,7,{...options,epoch:101});assert.equal(write(jump,7,7).n,0);
jump.sample(1002,0,0,6,8,options);assert.equal(write(jump,6,8).n,0);
jump.sample(1003,0,0,8,9,options);assert.equal(write(jump,8,9).n,0);
jump.sample(1004,0,0,9,10,{...options,enabled:false});assert.equal(jump.history.count,0);
console.log('PASS relocation, epoch reload, reverse, oversized step, and explicit disable reset without chords');
const many=Array.from({length:6},(_,i)=>run(i+1,30));const untouched=many[4].history.points.slice();many.splice(1,1);many[0].clear();
assert.deepEqual(many[3].history.points,untouched);assert.equal(many[0].history.count,0);
const remote=run(.5,30,60,1e9);const r=write(remote,30,30,[1e9+15,0,0]);assert.equal(r.n,s.n);
for(let i=0;i<r.n*3;i++)assert(Math.abs(r.p[i]-s.p[i])<1e-5);
console.log('PASS per-body histories stay independent and float64 world samples preserve far-from-origin traces');
