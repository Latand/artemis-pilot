import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] || '.'), out = resolve(process.argv[3] || 'evidence/navigation');
await mkdir(out, {recursive:true});
const baseline = process.env.BASELINE === '1';
const report = {root, baseline, errors:[], captures:[], checks:[]};
const check = (pass, name) => { report.checks.push({pass, name}); if (!pass && !baseline) throw new Error(name); };
const html = `<!doctype html><html><body style="margin:0;background:black"><div id="gl" style="width:100vw;height:100vh"></div>
<script type="module">
import * as THREE from '/node_modules/three/build/three.module.js';
import { makeGalaxyChunkForTest } from '/src/render/galaxyPopulationRender.js';
import { galaxyDisplayGain } from '/src/render/galaxyVolume.js';
import { renderer, camera, scene } from '/src/scene.js';
import { MPC_KM, K } from '/src/constants.js';
const scale = MPC_KM*K;
renderer.setPixelRatio(1);renderer.setSize(innerWidth,innerHeight);renderer.setAnimationLoop(null);
camera.position.set(0,0,.07*scale);camera.near=.1;camera.far=scale;camera.fov=48;camera.aspect=innerWidth/innerHeight;camera.lookAt(0,0,0);camera.updateProjectionMatrix();camera.updateMatrixWorld();
const c={lg:true,count:1,unit:new Float32Array(3),delta:new Float32Array(3),shape:new Float32Array([0,1,0,.12]),phot:new Float32Array([-21,.68,4,.22]),t:new Float32Array([4]),gid:new Uint32Array([42]),center:[0,0,0],radiusMpc:.05};
const {mesh,shared}=makeGalaxyChunkForTest(c);scene.add(mesh);
const R=camera.matrixWorldInverse.elements;
shared.uWorldToView.value.set(R[0],-R[8],R[4],R[1],-R[9],R[5],R[2],-R[10],R[6]);
const px=innerHeight/(2*Math.tan(camera.fov*Math.PI/360));
shared.uGainExposure.value=galaxyDisplayGain(px);shared.uPxScale.value=px;shared.uViewport.value.set(innerWidth,innerHeight);shared.uFarClamp.value=.8*scale;shared.uDepthRange.value.set(0,1e30);shared.uAObs.value=1;shared.uLnAObs.value=0;shared.uMwLum.value=1;shared.uCull.value=.0005;shared.uStretch.value=.3;mesh.material.uniforms.uCamRel.value.set(0,-.07,0);
window.preview={stats(){renderer.render(scene,camera);const gl=renderer.getContext(), b=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,b);let light=0,nonblack=0;for(let i=0;i<b.length;i+=4){let v=.2126*b[i]+.7152*b[i+1]+.0722*b[i+2];light+=v;if(v>2)nonblack++;}return {light,nonblack,pixels:b.length/4};},THREE,renderer,camera,scene,mesh,c,shared,draw(type,inclination=0){c.t[0]=type;c.phot[3]=type<0?1:.22;const a=inclination*Math.PI/180;c.shape.set([0,Math.cos(a),Math.sin(a),type<0?.65:.12]);mesh.geometry.attributes.aT.needsUpdate=true;mesh.geometry.attributes.aPhot.needsUpdate=true;mesh.geometry.attributes.aShape.needsUpdate=true;renderer.render(scene,camera);renderer.getContext().finish();return renderer.domElement.toDataURL();}};
</script></body></html>`;
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'navigation-review',configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/__galaxy-review')){res.setHeader('Content-Type','text/html');res.end(html);}else next();});}}]});
await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
const page=await browser.newPage({viewport:{width:900,height:650}});page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error' && /Shader|WebGL|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__galaxy-review`);
await page.waitForFunction(()=>window.preview,{},{timeout:60000});
for(const [name,type,inc] of [['spiral',4,0],['inclined',4,60],['edge',4,82],['irregular',10,25],['elliptical',-5,40]]){
 const png=await page.evaluate(([t,i])=>preview.draw(t,i),[type,inc]);await writeFile(`${out}/${name}.png`,Buffer.from(png.split(',')[1],'base64'));const stats=await page.evaluate(()=>preview.stats());check(stats.nonblack>50,`${name}: actual shader output is nonblack`);report.captures.push({name,type,inc,...stats});console.log('captured',name);
}
const returnPng = await page.evaluate(()=>preview.draw(4,0));
const original = await import('node:fs/promises').then(m=>m.readFile(`${out}/spiral.png`));
check(original.equals(Buffer.from(returnPng.split(',')[1],'base64')), 'Returning to same galaxy/type/view is pixel-identical');
// Splitting equal radiance among more particles must not whiten the image.
if(!baseline) {
 const tidal = await page.evaluate(async()=>{
  const {LinearTidalPass}=await import('/src/render/linearTidalPass.js');
  const {THREE,renderer}=preview,pass=new LinearTidalPass(262144);
  const source=new THREE.Scene(),g=new THREE.PlaneGeometry(2,2),cam=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const materials=[];
  function frame(n){source.clear();for(let i=0;i<n;i++){
   const m=new THREE.ShaderMaterial({uniforms:{light:{value:.18/n}},depthTest:false,depthWrite:false,toneMapped:false,transparent:true,blending:THREE.AdditiveBlending,
    vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:'uniform float light; void main(){gl_FragColor=vec4(vec3(light),1.);}'});
   source.add(new THREE.Mesh(g,m));materials.push(m);
  }renderer.setRenderTarget(null);renderer.setClearColor(0,0);renderer.clear();pass.render(renderer,source,cam,1);
   const gl=renderer.getContext(),b=new Uint8Array(4);gl.readPixels(50,50,1,1,gl.RGBA,gl.UNSIGNED_BYTE,b);return [...b];}
  const one=frame(1),many=frame(16);
  const rt=new THREE.WebGLRenderTarget(180,120),u={value:2};
  renderer.setPixelRatio(2);renderer.setRenderTarget(rt);renderer.setViewport(2,3,55,45);renderer.setScissor(4,5,80,70);renderer.setScissorTest(true);renderer.autoClear=false;renderer.setClearColor(0x123456,.3);
  const saved=()=>({viewport:renderer.getViewport(new THREE.Vector4()).toArray(),scissor:renderer.getScissor(new THREE.Vector4()).toArray(),physicalViewport:renderer.getCurrentViewport(new THREE.Vector4()).toArray(),physicalScissor:[...renderer.getContext().getParameter(renderer.getContext().SCISSOR_BOX)],test:renderer.getScissorTest(),auto:renderer.autoClear,color:renderer.getClearColor(new THREE.Color()).getHex(),alpha:renderer.getClearAlpha(),xr:renderer.xr.enabled});
  const before=saved();pass.render(renderer,source,cam,1,u);const after=saved();
  const restored=JSON.stringify(before)===JSON.stringify(after)&&renderer.getRenderTarget()===rt&&u.value===2;
  const bytes=pass.stats().bytes;
  renderer.setPixelRatio(1);renderer.setRenderTarget(null);renderer.setViewport(0,0,innerWidth,innerHeight);renderer.setScissorTest(false);renderer.autoClear=true;renderer.setClearColor(0,1);
  rt.dispose();pass.dispose();g.dispose();for(const m of materials)m.dispose();return {one,many,restored,bytes};
 });
 check(tidal.one[0]>20&&Math.abs(tidal.one[0]-tidal.many[0])<=2,'Equal summed radiance is independent of particle splitting');
 check(tidal.restored,'Linear tidal pass restores target, viewport, scissor, clear state and DPR');
 check(tidal.bytes<=262144*8,'Tidal HDR target respects its memory budget');
 report.tidalPass=tidal;
}
// Exercise the real trails.js adapter, not a screenshot of a synthetic line.
await page.evaluate(async()=>{
 const {renderer,camera,scene,THREE,mesh}=preview;mesh.visible=false;
 const before=new Set(scene.children),trails=await import('/src/trails.js'),{G,WORLD}=await import('/src/state.js'),{eph}=await import('/src/ephemeris.js'),{K,MU_S,R_SUN}=await import('/src/constants.js');
 const paths=scene.children.filter(m=>!before.has(m)&&m.isLine&&!m.isLineLoop).slice(0,2);
 for(const m of scene.children) if(!before.has(m))m.visible=false;
 const r=0.6*149597870.7,period=2*Math.PI*Math.sqrt(r*r*r/MU_S),speed=Math.sqrt(MU_S/r);
 eph.earthX=eph.earthY=eph.earthZ=eph.earthVx=eph.earthVy=eph.earthVz=0;
 eph.moonX=384400;eph.moonY=eph.moonZ=0;eph.sunX=0;eph.sunY=eph.sunZ=0;
 for(let i=0;i<eph.plX.length;i++){eph.plX[i]=1e9;eph.plY[i]=eph.plZ[i]=0;}
 G.uiMode='pilot';G.warp=1;G.paused=true;G.dead=false;G.predict=false;WORLD.earthDestroyed=true;WORLD.moonDestroyed=true;WORLD.sunDestroyed=false;
 camera.position.set(0,r*K*3.2,0);camera.up.set(0,0,-1);camera.lookAt(0,0,0);camera.near=r*K*.01;camera.far=r*K*12;camera.updateProjectionMatrix();camera.updateMatrixWorld();
 const centralBody=new THREE.Mesh(new THREE.SphereGeometry(R_SUN*K,32,16),new THREE.MeshBasicMaterial({color:0xffe0a3}));scene.add(centralBody);
 const ship=new THREE.Mesh(new THREE.SphereGeometry(r*K*.012,12,8),new THREE.MeshBasicMaterial({color:0xe6ebe9}));scene.add(ship);
 function position(theta,time){G.t=time;G.x=r*Math.cos(theta);G.y=r*Math.sin(theta);G.z=0;G.vx=-speed*Math.sin(theta);G.vy=speed*Math.cos(theta);G.vz=0;ship.position.set(G.x*K,0,-G.y*K);}
 function draw(){renderer.render(scene,camera);renderer.getContext().finish();return {png:renderer.domElement.toDataURL(),paths:trails.flightTrailStatus?.()||paths.map(m=>({visible:m.visible,vertices:m.geometry.drawRange.count})),time:G.t,period,primary:'Sun',orbitalRadiusAu:0.6};}
 preview.trailFade=(age)=>{G.t=preview.fadeStart+age*period;trails.setJourneyOpacity(0);return draw();};
 preview.trailCase=(name)=>{
  trails.clearTrail();for(const p of paths)p.visible=true;G.uiMode='pilot';G.warp=1;
  const start=performance.now();
  if(name==='recent')for(let i=0;i<4320;i++){position(i/720*2*Math.PI,i/720*period);trails.pushTrail(false);trails.pushJourney();trails.setJourneyOpacity(0);}
  else for(let i=0;i<180;i++){position(i*.37*2*Math.PI,i*.37*period);trails.pushTrail(false);trails.pushJourney();trails.setJourneyOpacity(0);}
  if(name==='hidden-explore'){G.uiMode='observe';trails.setJourneyOpacity(.3);}
  if(name==='high-warp'){G.warp=1e13;trails.setJourneyOpacity(.3);}
  preview.fadeStart=G.t;const result=draw();result.cpuMs=performance.now()-start;return result;
 };
});
for(const name of ['recent','undersampled','hidden-explore','high-warp']){
 const result=await page.evaluate(n=>preview.trailCase(n),name);
 await writeFile(`${out}/trail-${name}.png`,Buffer.from(result.png.split(',')[1],'base64'));delete result.png;
 report.captures.push({name:`trail-${name}`,...result});
 if(name==='recent')check(result.paths[0].visible&&result.paths[0].vertices>2&&result.paths[0].vertices<=1536,'Recent flight is visible and bounded');
 else check(result.paths.every(p=>!p.visible||p.vertices<=1),`${name}: no fictitious or unwanted flight chords`);
 console.log('captured trail',name);
}
// Epoch replacement while paused has no new sample to invalidate the path.
await page.evaluate(() => preview.trailCase('recent'));
const changedEpoch = await page.evaluate(async () => {
 const { getEpochMs, setEpochMs } = await import('/src/epoch.js');
 const { setJourneyOpacity, flightTrailStatus } = await import('/src/trails.js');
 const oldEpoch = getEpochMs();
 try {
  setEpochMs(oldEpoch + 86400000);
  setJourneyOpacity(0);
  return flightTrailStatus?.() || [];
 } finally { setEpochMs(oldEpoch); }
});
check(changedEpoch.length === 2 && changedEpoch.every(p => !p.visible && p.count === 0 && p.vertices === 0),
 'Paused epoch replacement clears trail history and GPU draw range');
// No further samples: old history must fade out instead of lingering forever.
await page.evaluate(()=>preview.trailCase('recent'));
for(const age of [0,.25,.5,.75,1,1.2]) {
 const v=await page.evaluate(a=>preview.trailFade(a),age);
 await writeFile(`${out}/trail-fade-${age}.png`,Buffer.from(v.png.split(',')[1],'base64'));
 if(age===1.2)check(v.paths.every(p=>!p.visible||p.vertices===0),'Expired trajectory leaves no geometry');
}
await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
if(report.errors.length)throw new Error(report.errors.join('\n'));
} finally {await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
