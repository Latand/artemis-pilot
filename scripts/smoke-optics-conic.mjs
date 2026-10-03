import assert from 'node:assert/strict';
import * as T from 'three';
import { bodySilhouetteConic, bodyUvBounds } from '../src/render/ringSamplingDepth.js';

// Compare the CPU conic with exact post-affine sphere tangent points. Include
// off-axis, near-clipped, highly stretched and very distant tiny projections.
let samples=0;
for(const [width,height] of [[960,640],[390,700]])for(const lambda of [1,2.6,10])
for(const distance of [1.1,2,10,1e8])for(const [x,y]of [[0,0],[.25,.15],[-.3,-.2],[.7,.4],[-.8,-.6]]){
 const radius=58.232,camera=new T.PerspectiveCamera(48,width/height,.02,1e14);
 const matrix=new T.Matrix4().makeRotationZ(.37).multiply(new T.Matrix4().makeRotationY(.59))
  .multiply(new T.Matrix4().makeScale(lambda,1/Math.sqrt(lambda),1/Math.sqrt(lambda)));
 matrix.setPosition(x*radius*distance,y*radius*distance,-radius*distance);
 const inverse=matrix.clone().invert(),origin=new T.Vector3().setFromMatrixPosition(inverse);
 if(origin.length()<=radius)continue;
 const a=new T.Vector3(),b=new T.Vector4(),center=new T.Vector3(),bounds=new T.Vector4();
 bodySilhouetteConic(a,b,center,inverse,matrix,camera.projectionMatrix,radius,width,height);
 bodyUvBounds(bounds,matrix,camera.projectionMatrix,radius,width,height,camera.near);
 assert([...a.toArray(),...b.toArray(),...center.toArray()].every(Number.isFinite));
 const n=origin.clone().normalize(),tangent=new T.Vector3(0,1,0).cross(n).normalize(),bitangent=n.clone().cross(tangent);
 const circleCenter=origin.clone().multiplyScalar(radius*radius/origin.lengthSq());
 const circleRadius=radius*Math.sqrt(1-radius*radius/origin.lengthSq());
 const value=(u,v)=>{const px=u-center.x,py=v-center.y;return a.x*px*px+2*a.y*px*py+a.z*py*py+2*b.x*px+2*b.y*py+b.z;};
 for(let i=0;i<480;i++){
  const angle=i/480*Math.PI*2,point=circleCenter.clone().addScaledVector(tangent,Math.cos(angle)*circleRadius).addScaledVector(bitangent,Math.sin(angle)*circleRadius).applyMatrix4(matrix);
  if(point.z>=-camera.near)continue;
  point.applyMatrix4(camera.projectionMatrix);if(Math.abs(point.x)>1||Math.abs(point.y)>1)continue;const u=point.x*.5+.5,v=point.y*.5+.5;
  assert(u>=bounds.x&&u<=bounds.z&&v>=bounds.y&&v<=bounds.w);
  const px=u-center.x,py=v-center.y,scale=Math.max(Math.abs(a.x*px*px),Math.abs(a.z*py*py),Math.abs(b.z),1e-30);
  assert(Math.abs(value(u,v))<Math.max(1e-27,scale*2e-7),'conic contains exact silhouette');
  for(const offset of [0,.5,1,2]){
   const ou=u+Math.cos(angle+.3)*offset/width,ov=v+Math.sin(angle+.3)*offset/height;
   const dx=ou-center.x,dy=ov-center.y;
   const gx=(a.x*dx+a.y*dy+b.x)/width,gy=(a.y*dx+a.z*dy+b.y)/height;
   assert(Math.abs(value(ou,ov))<=4*Math.hypot(gx,gy)+b.w+1e-12,'two-pixel band is conservative');
  }
  // Positive discriminant is inward, with the correct pixel-aspect gradient.
  const gx=(a.x*px+a.y*py+b.x)/width,gy=(a.y*px+a.z*py+b.y)/height;
  const l=Math.hypot(gx,gy);
  if(l>1e-20){const e=1e-4;assert(value(u+e*gx/l/width,v+e*gy/l/height)>value(u-e*gx/l/width,v-e*gy/l/height),'gradient points inward');}
  samples++;
 }
}
assert(samples>10000);
console.log(`Projected conic, conservative two-pixel band and inward gradient: ${samples} exact affine silhouette samples passed`);

import {readFileSync} from 'node:fs';
const lens=readFileSync(new URL('../src/lensing.js',import.meta.url),'utf8');
assert.equal((lens.match(/bodyCoverageSourceDepth\(/g)||[]).length,2,'repair both endpoints only');
const loop=lens.slice(lens.indexOf('for (int iteration'),lens.indexOf('// The initial pixel'));
assert(!loop.includes('bodyCoverageSourceDepth'),'no silhouette repair in tentative depth iterations');
assert(lens.indexOf('bodyCoverageSourceDepth(vUv')<lens.indexOf('for (int iteration'),'initial foreground coverage is protected');
assert(lens.indexOf('bodyCoverageSourceDepth(finalUv')<lens.indexOf('vec2 verifiedQ'),'final source repair precedes residual validation');

assert(loop.includes('if (iteration < 2) sourceZ = ringSourceDepth'), 'final opaque sample reaches coverage before transparent ring depth');

// Emulate each shader float32 arithmetic step, including uniform/varying
// uploads. A centre near the camera plane must not be expanded at huge UV.
const f=Math.fround,add=(a,b)=>f(f(a)+f(b)),mul=(a,b)=>f(f(a)*f(b));
function floatBand(a,b,center,u,v,width,height){
 const x=f(f(u)-f(center.x)),y=f(f(v)-f(center.y));
 const hx=add(add(mul(a.x,x),mul(a.y,y)),b.x),hy=add(add(mul(a.y,x),mul(a.z,y)),b.y);
 const value=add(add(mul(x,add(hx,b.x)),mul(y,add(hy,b.y))),b.z);
 const gx=mul(hx,f(1/width)),gy=mul(hy,f(1/height));
 const bound=add(mul(4,f(Math.sqrt(add(mul(gx,gx),mul(gy,gy))))),b.w);
 return Math.abs(value)<=bound;
}
let floatSamples=0;
for(const [width,height]of [[960,640],[390,700]])for(const z of [-.1,0,.001,.01,.1,1,10])
for(const lambda of [1,2.6,10]){
 const radius=58.232,camera=new T.PerspectiveCamera(48,width/height,.02,1e10);
 const matrix=new T.Matrix4().makeScale(1,lambda,1/Math.sqrt(lambda)).setPosition(61.1436,0,-z);
 const inverse=matrix.clone().invert(),origin=new T.Vector3().setFromMatrixPosition(inverse);
 const a=new T.Vector3(),b=new T.Vector4(),center=new T.Vector3();
 bodySilhouetteConic(a,b,center,inverse,matrix,camera.projectionMatrix,radius,width,height);
 assert(center.x>=0&&center.x<=1&&center.y>=0&&center.y<=1);
 const n=origin.clone().normalize(),tangent=new T.Vector3(0,1,0).cross(n).normalize(),bitangent=n.clone().cross(tangent);
 const circleCenter=origin.clone().multiplyScalar(radius*radius/origin.lengthSq());
 const circleRadius=radius*Math.sqrt(1-radius*radius/origin.lengthSq());
 for(let i=0;i<8192;i++){
  const angle=i/8192*Math.PI*2;
  const point=circleCenter.clone().addScaledVector(tangent,Math.cos(angle)*circleRadius).addScaledVector(bitangent,Math.sin(angle)*circleRadius).applyMatrix4(matrix);
  if(point.z>=-camera.near)continue;
  point.applyMatrix4(camera.projectionMatrix);if(Math.abs(point.x)>1||Math.abs(point.y)>1)continue;
  const u=point.x*.5+.5,v=point.y*.5+.5;
  assert(floatBand(a,b,center,u,v,width,height),`float32 side-on silhouette dropped at z=${z}, lambda=${lambda}`);
  // Include a one-pixel raster footprint on both sides of the tangent.
  for(const sign of [-1,1])assert(floatBand(a,b,center,u+sign/width,v,width,height));
  floatSamples++;
 }
}
assert(floatSamples>10000);
console.log(`Near-clipped/side-on float32 conic band: ${floatSamples} visible tangent samples and two raster offsets passed`);
