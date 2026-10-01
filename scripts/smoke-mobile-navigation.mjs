import assert from 'node:assert/strict';
import { MOBILE_PROFILES, pixelRatioForSize, boundedTargetSize, ResizeSettler } from '../src/mobile/renderPolicy.js';
import { TouchCameraGesture } from '../src/mobile/touchCamera.js';
import { AsyncPixelRead } from '../src/render/asyncPixelRead.js';
let checks = 0;
const check = (pass, label) => { assert.ok(pass, label); checks++; };
for (const p of MOBILE_PROFILES) for (const [w,h] of [[430,932],[932,430],[320,568],[2048,2048]]) {
    const d = pixelRatioForSize(w,h,3,p.canvasPixels);
    check(w*h*d*d <= p.canvasPixels + 1e-6, 'canvas budget at DPR3');
    const [x,y]=boundedTargetSize(w,h,p.draftPixels,.5);
    check(x*y <= p.draftPixels, 'ray target budget');
}
const resize = new ResizeSettler(140);
resize.request(430,932,1,0); check(resize.take(100)===null,'resize is deferred');
check(resize.take(140)?.[0]===430,'settled resize applies');
for(let i=0;i<100;i++)resize.request(430,932,1,200+i);
check(resize.take(1000)===null,'unchanged observer events allocate nothing');
for(let i=0;i<100;i++)resize.request(430+i,932,1,1100+i);
check(resize.take(1200)===null,'burst deferred');check(resize.take(1400)?.[0]===529,'burst coalesced');
resize.request(700,932,1,1500);resize.request(529,932,1,1510);check(resize.pending===null,'return to applied size cancels resize');
const output=[];const g=new TouchCameraGesture(x=>output.push(x));
g.down(1,100,100);g.down(2,200,100);g.move(1,90,100);g.move(2,210,100);
check(output.length===0,'event handlers do not apply camera work');g.flush();
check(output.length===1&&output[0].dx===0&&output[0].dy===0&&output[0].zoom<0,'symmetric pinch changes only scale');
g.move(1,100,130);g.move(2,220,130);g.flush();check(output.at(-1).dx===10&&output.at(-1).dy===30,'centroid pan is independent of event order');
g.up(2);const n=output.length;g.flush();check(output.length===n,'finger transition has no jump');
g.move(1,110,130);g.flush();check(output.at(-1).fingers===1&&output.at(-1).dx===10,'remaining finger gets new anchor');
g.down(2,110,130);g.move(2,110.00001,130);g.flush();check(output.at(-1).zoom===0,'coincident fingers cannot explode zoom');
g.move(1,200,200);g.up(1,true);const n2=output.length;g.flush();check(output.length===n2,'cancel discards pending deltas');
g.cancel();check(g.points.size===0,'cancellation releases every contact');
g.down(1,0,0);g.down(2,20,0);g.move(2,1e12,0);g.flush();check(Math.abs(output.at(-1).zoom)<=.22,'per-frame zoom jump bounded');
g.cancel();
const gl={PIXEL_PACK_BUFFER_BINDING:1,PIXEL_PACK_BUFFER:2,STREAM_READ:3,RGBA:4,UNSIGNED_BYTE:5,SYNC_GPU_COMMANDS_COMPLETE:6,TIMEOUT_EXPIRED:7,WAIT_FAILED:8,
    lost:false,status:7,reads:0,copies:0,deletes:0,isContextLost(){return this.lost;},getParameter(){return null;},createBuffer(){return {};},bindBuffer(){},bufferData(){},
    readPixels(){this.reads++;},fenceSync(){return {};},flush(){},clientWaitSync(s,f,timeout){assert.equal(timeout,0);return this.status;},deleteSync(){},deleteBuffer(){this.deletes++;},getBufferSubData(){this.copies++;}};
const a=new AsyncPixelRead();check(a.enqueue(gl,48,30),'async read queued');check(!a.enqueue(gl,48,30)&&gl.reads===1,'only one outstanding read');
check(!a.poll(new Uint8Array(5760))&&gl.copies===0,'no copy before GPU fence signals');gl.status=9;check(a.poll(new Uint8Array(5760))&&gl.copies===1,'copy follows completed fence');
a.dispose();check(gl.deletes===1&&a.bytes===0,'PBO is disposed');a.enqueue(gl,48,30);gl.lost=true;a.dispose();check(a.sync===null&&a.buffer===null,'lost-context handles abandoned');
console.log(`Mobile policy / gesture / asynchronous readback: ${checks} checks passed`);
