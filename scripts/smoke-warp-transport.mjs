// Same minimal headless DOM/WebGL fixture as smoke-reltravel.
const glProxy = new Proxy({}, {
  get(target, prop) {
    if (prop === "canvas") return target.canvas;
    if (prop === "VERSION") return 0x1F02;
    if (prop === "SHADING_LANGUAGE_VERSION") return 0x8B8C;
    if (prop === "VENDOR") return 0x1F00;
    if (prop === "RENDERER") return 0x1F01;
    if (prop === "getExtension") return () => null;
    if (prop === "getParameter") return p => {
      if (p === 0x1F02) return "WebGL 2.0";
      if (p === 0x8B8C) return "WebGL GLSL ES 3.00";
      if (p === 0x1F00 || p === 0x1F01) return "smoke";
      return 16;
    };
    if (prop === "getShaderPrecisionFormat") return () => ({ precision: 23, rangeMin: 127, rangeMax: 127 });
    if (prop === "createShader" || prop === "createProgram" || prop === "createBuffer" || prop === "createTexture" ||
        prop === "createFramebuffer" || prop === "createRenderbuffer" || prop === "createVertexArray") return () => ({});
    if (prop === "checkFramebufferStatus") return () => 0x8CD5;
    if (prop === "getProgramParameter" || prop === "getShaderParameter") return () => true;
    if (prop === "getProgramInfoLog" || prop === "getShaderInfoLog") return () => "";
    if (prop === "getAttribLocation") return () => 0;
    if (prop === "getUniformLocation") return () => ({});
    if (prop === "drawingBufferWidth" || prop === "drawingBufferHeight") return 1;
    if (!(prop in target)) target[prop] = () => {};
    return target[prop];
  },
});
function makeCanvas() {
  const canvas = {
    style: {},
    width: 1,
    height: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
    getContext: () => glProxy,
  };
  glProxy.canvas = canvas;
  return canvas;
}

globalThis.window = {
  devicePixelRatio: 1,
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
};
globalThis.document = {
  getElementById: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {}, removeEventListener: () => {} }),
  createElement: () => makeCanvas(),
  createElementNS: () => makeCanvas(),
  addEventListener: () => {},
  body: { appendChild: () => {} },
};
globalThis.location = { search: "" };
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};


import assert from 'node:assert/strict';
const {G,WORLD,BH,resetShip}=await import('../src/state.js');
const {eph,resetEphem}=await import('../src/ephemeris.js');
const {warpTravelStep,warpSegmentBlocked}=await import('../src/warpTravel.js');
const {WARP,resetWarp,stopWarp}=await import('../src/warpBubble.js');
const {stepWorld}=await import('../src/worldStep.js');
const {R_SUN,SEC_YEAR,STARS}=await import('../src/constants.js');
const {getPhysicalSystem,ACTIVE_STARS}=await import('../src/universe/activeStars.js');
const {planetWorldState}=await import('../src/universe/planetarySystem.js');
resetShip();resetEphem();
assert(warpSegmentBlocked(-1e4,0,0,1e4,0,0),'swept Earth crossing');
G.t=7.5e9*SEC_YEAR;
assert(warpSegmentBlocked(eph.sunX+2*R_SUN,eph.sunY,eph.sunZ,eph.sunX+3*R_SUN,eph.sunY,eph.sunZ),'evolved Sun photosphere');
resetShip();resetEphem();
let sys;for(const star of STARS){sys=getPhysicalSystem(star);if(sys?.planets?.length)break;}
assert(sys?.planets?.length,'fixture has cached planets');
if(sys?.planets?.length){const p=sys.planets[0],b={};planetWorldState(sys,p.index,sys.hostStar,G.t,b);
 assert(warpSegmentBlocked(b.x-eph.earthX-p.radiusKm*2,b.y-eph.earthY,b.z,b.x-eph.earthX+p.radiusKm*2,b.y-eph.earthY,b.z),'cached planet crossing');}
const px=2e12,py=2e12,pz=2e12;
BH.n=1;BH.x[0]=px;BH.y[0]=py+100;BH.z[0]=pz;BH.vx[0]=0;BH.vy[0]=200;BH.vz[0]=0;BH.kind[0]=2;BH.rs[0]=1;
assert(warpSegmentBlocked(px,py,pz,px,py,pz,1),'moving pulsar crosses stationary segment');
assert(warpSegmentBlocked(px+10,py+100,pz,px+10,py+100,pz),'pulsar physical 12km surface');BH.n=0;
const previous=ACTIVE_STARS.splice(0);const sink={x:px+eph.earthX,y:py+eph.earthY,z:pz,R:1e6,gasSink:true};ACTIVE_STARS.push(sink);
assert(!warpSegmentBlocked(px,py,pz,px,py,pz),'gas sink has no hard surface');sink.gasSink=false;
assert(warpSegmentBlocked(px,py,pz,px,py,pz),'physical stellar surface');ACTIVE_STARS.splice(0,1,...previous);
G.x=1e12;G.y=1e12;G.z=1e12;G.vx=3;G.vy=4;G.vz=5;G.landed=null;G.dead=false;
WARP.enabled=true;WARP.speed=WARP.meanSpeed=1e6;WARP.dx=1;WARP.dy=WARP.dz=0;
const t=G.t,tau=G.tau,x=G.x;const dt=stepWorld(.1);
assert(Math.abs(dt-.1)<1e-9);assert(Math.abs(G.t-t-dt)<1e-9);assert.equal(G.tau-tau,dt);
assert.deepEqual([G.vx,G.vy,G.vz],[3,4,5]);assert(Math.abs(G.x-x-(1e6+3)*dt)<1e-3);
assert.equal(warpTravelStep(100),1,'bounded surface sweep / delivered time');
G.x=5e23;G.y=G.z=0;WARP.meanSpeed=1e20;warpTravelStep(.1);assert.equal(WARP.speed,0);assert.match(WARP.reason,/Coordinate guard/);
WARP.speed=WARP.meanSpeed=1e6;const reverse=warpTravelStep(-1);assert.equal(reverse,0);assert.equal(WARP.speed,0);
WARP.limited=true;stopWarp();assert(!WARP.limited);resetWarp();
console.log('Warp transport PASS: swept Earth, live giant Sun, cached planets, actual world/proper time, distinct local velocity, frame bound, reverse and coordinate interlock.');
