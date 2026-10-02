// Shared by Node analytic tests and the full-app GPU parity test.
export function shipFlowFixtures() {
 const body=(x,y,z,w,sink=2,hole=0)=>({x,y,z,w,sink,hole});
 const cases=[
  {name:'single-source',point:[4,0,0],bodies:[body(0,0,0,8)],expected:[-4,0,0]},
  {name:'softened-core',point:[.1,0,0],bodies:[body(0,0,0,8)],expected:[-.8,0,0]},
  {name:'noncollinear-attraction',point:[0,0,0],bodies:[body(1,0,0,4,.1),body(0,4,0,8,.1)],expected:[16*Math.sqrt(32/272),4*Math.sqrt(32/272),0]},
  {name:'no-sources',point:[3,1,-2],bodies:[],expected:[0,0,0]},
  {name:'cancelled-sources',point:[0,0,0],bodies:[body(-1,0,0,2,.1),body(1,0,0,2,.1)],expected:[0,0,0]},
  {name:'relative-translation',point:[16388,16384,16384],bodies:[body(16384,16384,16384,8)],expected:[-4,0,0]},
 ];
 for(const radius of [10,3000,1e7])cases.push({name:`hole-radius-${radius}`,point:[.1,.2,.3],radius,bodies:[body(0,0,0,8,.001,1)]});
 for(const de of [.02,1,10])for(const frameW of [0,.5,1])cases.push({name:`de-${de}-frame-${frameW}`,point:[2,1,.5],origin:[-1,.5,.3],de,frameW,frame:[.7,-.4,.2],bodies:[body(0,0,0,3,.2)]});
 cases.push({name:'forty-sources',point:[.3,.2,.1],bodies:Array.from({length:40},(_,i)=>body(i%5+1,Math.floor(i/5)+1,i%3+1,.2+i*.1,.1,i%7===0?1:0))});
 return cases;
}
export function shipFlowUniforms(test,Vector3,Vector4) {
 const vec=a=>new Vector3(...(a||[0,0,0]));
 return {uWarpShip:{value:vec(test.point)},uOrigin:{value:vec(test.origin)},uRadius:{value:test.radius||10},uNB:{value:test.bodies.length},uBody:{value:test.bodies.map(b=>new Vector4(b.x,b.y,b.z,b.w))},uSink:{value:test.bodies.map(b=>b.sink)},uHole:{value:test.bodies.map(b=>b.hole)},uDE:{value:test.de||0},uFrameVel:{value:vec(test.frame)},uFrameW:{value:test.frameW||0}};
}
