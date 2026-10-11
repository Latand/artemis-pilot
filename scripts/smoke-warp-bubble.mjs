import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bubbleShape,bubbleMetric,bubbleComovingFlow,bubbleThetaDisplay,bubbleMarkerSpacing,createWarpState,stepWarp,stopWarp,resetWarp,steerWarp,noteWarpShift,takeWarpShift,
    warpDisplayRate,warpRegime,warpSpeedLabel,WARP_C,WARP_MAX_C,BUBBLE_SIGMA } from '../src/warpBubble.js';
const close=(a,b,e=1e-7)=>assert(Math.abs(a-b)<=e*Math.max(1,Math.abs(b)),`${a} ~ ${b}`);
// Alcubierre eq. 6: unit at the centre, analytic derivative, smooth decay.
close(bubbleShape(0).f,1); close(bubbleShape(0).df,0);
for(const r of [.1,.5,.9,1,1.2,2,3]){
 const h=1e-5;close(bubbleShape(r).df,(bubbleShape(r+h).f-bubbleShape(r-h).f)/(2*h));
}
let previous=1;for(let r=.05;r<4;r+=.05){const f=bubbleShape(r).f;assert(f<previous&&f>0,'f falls monotonically');previous=f;}
assert(bubbleShape(1).f>.4&&bubbleShape(1).f<.6,'thick wall: half strength at R');
assert(bubbleShape(2).f<.1&&bubbleShape(3).f<2e-3&&bubbleShape(5).f<1e-6,'field fades over about one radius');
// Natário: theta = div X with X = beta f(r) along y. Eq. 12 must equal the
// numerical divergence, change sign front/back and keep the energy scaling.
const X=(x,y,z,beta)=>beta*bubbleShape(Math.hypot(x,y,z)).f;
for(const beta of [.1,1,100,1e9]){
 const front=bubbleMetric(0,1,0,beta),back=bubbleMetric(0,-1,0,beta),side=bubbleMetric(1,0,0,beta);
 assert(front.expansion<0&&back.expansion>0,'contraction ahead, expansion behind');close(front.expansion,-back.expansion);
 close(front.energy,0);assert(side.energy<0,'negative energy in the wall');close(side.expansion,0);
 const center=bubbleMetric(0,0,0,beta);close(center.expansion,0);close(center.energy,0);close(center.shift,-beta);
 close(side.energy,bubbleMetric(1,0,0,1).energy*beta*beta);
 for(const [x,y,z] of [[.3,.8,-.2],[0,1.3,.4],[-.5,-.7,.1],[.2,.1,1.6]]){
  const h=1e-5,div=(X(x,y+h,z,beta)-X(x,y-h,z,beta))/(2*h);
  close(bubbleMetric(x,y,z,beta).expansion,div,1e-5);
 }
}
// Ship chart X' = X - v_s: same divergence, calm centre, full stream far out.
close(bubbleComovingFlow(0),0);close(bubbleComovingFlow(6),-1,1e-6);
for(const r of [.2,.7,1,1.5]){
 assert(bubbleComovingFlow(r)<bubbleComovingFlow(r-.1),'stream speeds up away from the hull');
 close(bubbleComovingFlow(r,1)-bubbleComovingFlow(r,0),-1);
}
// Marker spacing (display mapping of theta): rows bunch ahead, spread behind,
// stay even beside the hull, at the sides and far away; strongest at the wall.
{const k=Math.log(3.5),sp=(x,y,z)=>bubbleMarkerSpacing(x,y,z,k);
 assert(sp(0,1,0)<.5&&sp(0,-1,0)>2,'ahead close-set, behind wide');close(sp(0,1,0)*sp(0,-1,0),1,1e-9);
 assert(Math.abs(sp(0,.05,0)-1)<.06&&Math.abs(sp(0,.2,0)-1)<.2&&Math.abs(sp(0,4,0)-1)<.01&&Math.abs(sp(1,0,0)-1)<1e-9,'even at the hull, far away and at the sides');
 let peak=0,at=0;for(let y=.05;y<3;y+=.05){const d=Math.abs(Math.log(sp(0,y,0)));if(d>peak){peak=d;at=y;}}assert(at>.7&&at<1.4,`largest change at the wall (y=${at})`);
 for(const [x,y,z] of [[.3,.9,.1],[0,1.2,.5],[.2,-.8,-.3]])close(bubbleThetaDisplay(x,y,z),Math.max(-1,Math.min(1,bubbleMetric(x,y,z,1).expansion/.95)),1e-12);}
const riverSrc=readFileSync(new URL('../src/river.js',import.meta.url),'utf8');
assert(riverSrc.includes('return clamp(rdf * (rn > 1e-6 ? dot(q, uBubbleAxis.xyz) / rn : 0.0) / 0.95, -1.0, 1.0);')&&riverSrc.includes('float bubbleSpacing(vec3 p) { return exp(uBubbleMarks.y * bubbleTheta(p)); }'),'GLSL mirrors the marker spacing');
// Display slow motion: one uniform factor, never faster than the model,
// and a stream of 0.3 to 1.2 radii per second at any superluminal speed.
assert.equal(warpDisplayRate(0,100),1);assert.equal(warpDisplayRate(1e-3,100),1);
let lastRate=1,lastStream=0;
for(let e=-2;e<=Math.log10(WARP_C*WARP_MAX_C);e+=.5){
 const v=10**e,R=200,rate=warpDisplayRate(v,R),stream=rate*v/R;
 assert(rate>0&&rate<=1&&Number.isFinite(rate));assert(rate<=lastRate+1e-15,'slow-motion factor never rises with speed');
 assert(stream>=lastStream-1e-9,'displayed stream never slows as speed rises');
 if(v*rate>.3*R*1.0001)assert(stream>=.3&&stream<=1.21);
 lastRate=rate;lastStream=stream;
}
close(warpRegime(WARP_C*WARP_MAX_C),1);assert.equal(warpRegime(0),0);
// Smooth axis turn: bounded step, unit length, converges, snaps at rest.
const turn=createWarpState();turn.enabled=true;turn.speed=1e6;
let angleStep=0;for(let i=0;i<180;i++){const d0=[turn.dx,turn.dy];steerWarp(turn,0,1,0,1/60);
 angleStep=Math.max(angleStep,Math.acos(Math.min(1,d0[0]*turn.dx+d0[1]*turn.dy)));close(Math.hypot(turn.dx,turn.dy,turn.dz),1,1e-12);}
assert(angleStep<.06,'axis turns gradually per frame');assert(turn.dy>.999,'axis reaches the heading');
steerWarp(turn,0,-1,0,1/60);assert(Math.hypot(turn.dx,turn.dy,turn.dz)>.999999&&turn.dy<1,'opposite heading turns about a perpendicular');
const held=[turn.dx,turn.dy,turn.dz];steerWarp(turn,1,0,0,0);assert.deepEqual([turn.dx,turn.dy,turn.dz],held,'pause keeps the moving axis');
turn.speed=0;steerWarp(turn,1,0,0,1/60);assert.deepEqual([turn.dx,turn.dy,turn.dz],[1,0,0]);
// Transport hand-off to the river is consumed exactly once.
const carry=createWarpState(),out=[0,0,0];noteWarpShift(1,2,3,carry);noteWarpShift(1,0,0,carry);
assert.deepEqual(takeWarpShift(out,carry),[2,2,3]);assert.deepEqual(takeWarpShift(out,carry),[0,0,0]);
for(const [v,t] of [[0,'0 km/s'],[.09,'90 m/s'],[4.2,'4.2 km/s'],[42,'42 km/s'],[999,'999 km/s'],[2000,'0.0067 c'],[WARP_C*2.5,'2.50 c'],[WARP_C*58.36,'58.4 c'],[WARP_C*12345.678,'12.3k c'],[WARP_C*999999,'1.00M c'],[WARP_C*1.47e6,'1.47M c'],[WARP_C*WARP_MAX_C,'1.00B c']])assert.equal(warpSpeedLabel(v),t);
for(let e=-3;e<=Math.log10(WARP_C*WARP_MAX_C);e+=.01){const t=warpSpeedLabel(10**e);assert(t.length<=8&&/ (m\/s|km\/s|[kMB]?c)$/.test(t),t);}
// The shared river carries the same shift term in its one flow field.
const river=readFileSync(new URL('../src/river.js',import.meta.url),'utf8');
assert.equal((river.match(/uFrameVel \* uFrameW \+ bubbleShift\(p\)/g)||[]).length,2,'both flowField returns add the bubble');
assert.match(river,/\(tanhSafe\(s \* \(rn \+ 1\.0\)\) - tanhSafe\(s \* \(rn - 1\.0\)\)\) \/ \(2\.0 \* tanhSafe\(s\)\)/,'GLSL mirrors eq. 6');
assert.match(river,/uBubbleAxis\.w \* \(f - uBubbleShape\.y\)/,'GLSL chart term mirrors bubbleComovingFlow');
assert.match(readFileSync(new URL('../src/shipVisuals.js',import.meta.url),'utf8'),/sigma: BUBBLE_SIGMA/,'river receives the model sigma');
assert(!/warpMetricField|warpWaves|createWarpMetricField/.test(readFileSync(new URL('../src/shipVisuals.js',import.meta.url),'utf8')+readFileSync(new URL('../src/main.js',import.meta.url),'utf8')),'no separate warp sphere or ring layers');
const samples=[];
for(const fps of [30,60,144]){
 const s=createWarpState();s.enabled=true;let distance=0;
 for(let i=0;i<fps*24;i++){stepWarp(s,1,1,false,1/fps);distance+=s.meanSpeed/fps;}
 assert(s.speed>WARP_C);samples.push({speed:s.speed,distance});
 const local=s.speed;stepWarp(s,0,1,false,1/fps,false);assert.equal(s.speed,local);assert.equal(s.meanSpeed,0);
 for(let i=0;i<fps*3;i++)stepWarp(s,0,1,false,1/fps);
 const coast=s.speed;for(let i=0;i<fps*3;i++)stepWarp(s,0,1,false,1/fps);close(s.speed,coast,.002);
 for(let i=0;i<fps*15;i++)stepWarp(s,-1,1,false,1/fps);
 assert.equal(s.speed,0);assert.equal(s.logSpeed,0);
 for(let i=0;i<fps*100;i++)stepWarp(s,1,100,true,1/fps);
 close(s.speed,WARP_C*WARP_MAX_C);assert(s.limited);assert(Number.isFinite(s.meanSpeed));
 stopWarp(s,'test');assert.equal(s.speed,0);assert(s.enabled);resetWarp(s);assert.deepEqual(s,createWarpState());
}
for(const s of samples){close(s.speed,samples[0].speed);close(s.distance,samples[0].distance,1e-6);}
assert.equal(BUBBLE_SIGMA,1.8);
console.log('Warp bubble PASS: eq. 6 shape and decay, eq. 12 theta = div X, ship-chart shift, negative energy scaling, bounded display slow motion, smooth axis turns, single transport hand-off, river GLSL parity, no separate layers, 30/60/144Hz ramp distance, pause/coast/brake, finite guard and reset.');
