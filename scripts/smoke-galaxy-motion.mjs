import assert from 'node:assert/strict';
import { motionLayout, selectMotionTiles, MOTION_GRID, MOTION_MAX_RAYS } from '../src/render/galaxyMotionDetail.js';
function encoded(fn, w=48, h=30) {
    const a=new Uint8Array(w*h*4);
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
        const n=Math.max(0,Math.min(255,(Math.log2(Math.max(1e-12,fn(x,y)))+24)/40*255));
        a[(y*w+x)*4]=Math.floor(n);a[(y*w+x)*4+1]=Math.round((n%1)*255);a[(y*w+x)*4+3]=255;
    }
    return a;
}
for(const [w,h,dw,dh] of [[480,300,240,150],[800,500,400,250],[1440,900,504,315],[390,844,98,211],[2880,1800,720,450],[64,40,32,20]]) {
    const p=motionLayout(w,h,dw,dh);
    if(p) {
        assert(p.rayPixels<=Math.min(dw*dh,MOTION_MAX_RAYS));
        assert(p.count<=MOTION_GRID[0]*MOTION_GRID[1]);
        assert(p.atlasWidth*p.atlasHeight>=p.rayPixels);
        for(let i=0;i<p.count;i++)assert((Math.floor(i/p.cols)+1)*p.ch<=p.atlasHeight);
    }
}
assert.equal(motionLayout(480,300,480,300),null);
assert.equal(motionLayout(NaN,300,100,100),null);
assert.equal(motionLayout(8192,8192,64,40,64),null);
assert.equal(selectMotionTiles(encoded(()=>4),48,30,16).length,0);
assert.equal(selectMotionTiles(encoded(()=>0),48,30,16).length,0);
const b=encoded((x,y)=>x>=16&&x<24? 0.1+3*(y%2):0.1);
const a=selectMotionTiles(b,48,30,12);
assert(a.length>0&&a.length<=12);
assert.equal(new Set(a.map(t=>t.id)).size,a.length);
assert(a.every(t=>t.weight>=0&&t.weight<=1&&Number.isFinite(t.score)));
assert(a.every(t=>t.tx>=3&&t.tx<=6));
assert.deepEqual(a,selectMotionTiles(b,48,30,12));
assert.deepEqual(selectMotionTiles(new Uint8Array(2),48,30,12),[]);
console.log('PASS bounded native-ray layout, gutters, device limits, uniform fields, deterministic spatial priorities and finite blend weights');
