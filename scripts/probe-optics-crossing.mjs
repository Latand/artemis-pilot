// Diagnostic paired frames: freeze one world, then vary only camera pitch,
// lensing, or tidal presentation. These ablations do not alter physics.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { transformCelestialSource } from './celestial-detail-fixtures.mjs';
import { verifyDepthCoverageFixture } from './optics-depth-fixture.mjs';
const mobile=process.env.DEVICE==='mobile';
const bloom=process.env.BLOOM==='1';
const out=resolve(process.env.ARTEMIS_EVIDENCE||'evidence/optics-crossing');await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mobile,bloom,errors:[],cases:[],diagnosticOnly:true,
 scope:'Frozen rendered Saturn + nearby quasar; screen-space lens and tidal-mesh ablations. Physical interpretation is not inferred from the photograph.',
 omissions:['unrelated cosmic background, HYG and tier-1 catalogs','gravity-flow overlay',...(bloom?[]:['bloom; direct production lensing compositor'])]};
let server,browser;
try{
 server=await createServer({configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'optics-crossing-diagnostic',enforce:'pre',resolveId(id){if(id==='virtual:galaxy-preview')return '\0off';},load(id){if(id==='\0off')return 'export default null;';},transform(source,id){
 if(id.split('?')[0].endsWith('/src/render/ringSamplingDepth.js')){
  const token='u.uRingBodyRadius.value = bodyRadius;';assert.equal(source.split(token).length,2);
  return source.replace(token,'u.uRingBodyRadius.value = window.__qaCoverageEdge === false ? 0 : bodyRadius;');
 }
 return transformCelestialSource(source,id);
}}]});await server.listen();
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:mobile?{width:390,height:700}:{width:960,height:640},deviceScaleFactor:1,isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(180000);
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|Shader|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
 await page.addInitScript(bloom=>{window.__qaBloom=bloom;Date.now=()=>Date.UTC(2026,9,3,12);localStorage.clear();localStorage.setItem('ap_introSeen','1');},bloom);
 await page.route(/fonts\.(googleapis|gstatic)\.com/,r=>r.fulfill({contentType:'text/css',body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=saturn&dist=600&bloom=${bloom?1:0}&river=0&field=0&realsky=0&tier1=0&galaxies=0&galaxyvol=0&galaxy=0&compile=0&hidehelp=1`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__celestialFrame);
 await page.evaluate(async()=>{
  window.qa={bloom:!!window.__qaBloom,s:await import('/src/scene.js'),st:await import('/src/state.js'),b:await import('/src/bodies.js'),bh:await import('/src/blackholes.js'),c:await import('/src/constants.js'),e:await import('/src/ephemeris.js'),tde:await import('/src/tdeVisuals.js'),hole:await import('/src/holeOptics.js'),lens:await import('/src/lensing.js'),ring:await import('/src/render/ringSamplingDepth.js'),enc:await import('/src/bhEncounters.js')};
  qa.sat=qa.c.PL.findIndex(p=>p.name==='SATURN');
  qa.st.G.paused=true;qa.st.G.gr=false;qa.st.G.predict=false;qa.st.G.focus='free';
  qa.bh.clearBlackHoles();
  // The hole is slightly in front of Saturn along the camera's +z sightline.
  qa.bh.addBlackHole(qa.e.eph.plX[qa.sat]-150000,qa.e.eph.plY[qa.sat]-100000,50000,0,0,true,null,1,0,qa.e.eph.plZ[qa.sat],0);
  await window.__celestialEnsureLensing();
  for(let i=0;i<8;i++)window.__celestialFrame();
  qa.initialHole={x:qa.st.BH.x[0],y:qa.st.BH.y[0]};
 });
 report.depthFixture=await verifyDepthCoverageFixture(page);
 for(const[name,png]of Object.entries(report.depthFixture.images))await writeFile(`${out}/depth-fixture-${name}.png`,Buffer.from(png.split(',')[1],'base64'));
 delete report.depthFixture.images;await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
 const coarse=[.48,.08,.005,0,-.005,-.08,-.48];
 const dense=[.0008,.0007,.00065,.0006,.00055,.0005,.0004,0,-.0004,-.0005,-.00055,-.0006,-.00065,-.0007,-.0008];
 for(const scenario of ['saturn-near-lens','saturn-foreground-lens','disk-crossing'])for(const pitch of scenario==='disk-crossing'?[...new Set([...coarse,...dense])]:scenario==='saturn-foreground-lens'?[.48,0,-.48]:coarse){
  const result=await page.evaluate(({scenario,pitch})=>{
   const{s,st,b,bh,tde,hole,lens,c,sat,bloom}=qa;const m=bh.BH_META[0];
   const foreground=scenario==='saturn-foreground-lens';
   st.BH.x[0]=qa.initialHole.x+(foreground?150000:0);st.BH.y[0]=qa.initialHole.y+(foreground?2000000:0);
   qa.enc.syncHoleScene(); // paused frames intentionally do not step physical caches
   const physicalHole=m.g.position.clone().set((qa.e.eph.earthX+st.BH.x[0])*c.K,st.BH.z[0]*c.K,-(qa.e.eph.earthY+st.BH.y[0])*c.K);
   st.G.focus='free';s.cam.tgt.copy(scenario==='disk-crossing'?physicalHole:b.plGroups[sat].position);
   if(scenario.startsWith('saturn-'))s.cam.tgt.x-=75;
   s.cam.dist=scenario==='disk-crossing'?st.BH.rs[0]*c.K*8:600;s.cam.distTarget=null;s.cam.yaw=Math.PI/2;s.cam.pitch=pitch;
   window.__celestialFrame();
   bh.updateBHVisuals(0,qa.e.eph.earthX*c.K,-qa.e.eph.earthY*c.K); // bypass only fixture wall-clock cadence
   const meshSourceError=m.g.position.distanceTo(physicalHole);
   const physicalLensDepth=-physicalHole.clone().applyMatrix4(s.camera.matrixWorldInverse).z;
   const state=tde.tidalState(sat),wasActive=state.active;
   const disk=m.optics.disk,wasDisk=disk.material.uniforms.uDiskOn.value;
   const gl=s.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
   const draw=(lensed,tides,diskOn=true,ringDepth=true,bloomEffects=true,edgeCoverage=true,bend=true)=>{
    window.__qaCoverageEdge=edgeCoverage;const renderStart=performance.now();
    state.active=tides&&wasActive;disk.visible=diskOn;
    if(lensed){lens.updateLensing(s.camera,s.camera.aspect);if(!ringDepth)qa.ring.beginRingSamplingDepth();}
    else{lens.lensingPass.enabled=false;hole.holeRoot.visible=true;}
    const lensCount=lens.lensingPass.uniforms.uN.value;if(!bend)lens.lensingPass.uniforms.uN.value=0;
    if(bloom){const enabled=s.bloomPass.enabled;s.bloomPass.enabled=enabled&&bloomEffects;try{s.composer.render();}finally{s.bloomPass.enabled=enabled;}}
    else if(lensed)lens.renderLensed(s.renderer,s.scene,s.camera);
    else s.renderSceneTiered(s.renderer,s.scene,s.camera);
    lens.lensingPass.uniforms.uN.value=lensCount;
    const bytes=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
    const renderMs=performance.now()-renderStart;
    return{bytes,png:s.renderer.domElement.toDataURL('image/png'),ringPresent:qa.ring.ringSamplingUniforms.uRingPresent.value,bodyRadius:qa.ring.ringSamplingUniforms.uRingBodyRadius.value,renderMs};
   };
   const production=draw(true,true),noLens=draw(false,true),noTides=draw(true,false),plain=draw(false,false),noDisk=draw(true,true,false),noRingDepth=scenario.startsWith('saturn-')?draw(true,false,true,false):noTides;
   const noEdgeDepth=scenario.startsWith('saturn-')?draw(true,false,true,true,true,false):noTides;
   // Additive bloom may legitimately scatter nearby disk light over a body.
   // Isolate opaque occlusion with that one filter disabled, retaining the
   // same direct/composer lens and hole passes in their production order.
   const opaqueLensed=foreground&&bloom?draw(true,false,true,true,false):noTides;
   // Use an identity lens in the SAME render-target path. Mobile's lens
   // target has samples=0 while the direct canvas is antialiased; comparing
   // against the direct canvas confounds ring-edge rasterization with bending.
   const opaquePlain=foreground?draw(true,false,true,true,false,true,false):plain;
   const edgePerformance=[];
   if(scenario==='saturn-near-lens'&&pitch===.48){
    for(const edge of [false,true])for(let i=0;i<3;i++)draw(true,false,true,true,true,edge);
    for(const order of ['ABBA','BAAB','ABBA','BAAB','ABBA']){
     const times={A:[],B:[]};for(const key of order)for(let i=0;i<3;i++)times[key].push(draw(true,false,true,true,true,key==='B').renderMs);
     const p95=a=>[...a].sort((a,b)=>a-b)[Math.ceil(a.length*.95)-1];
     edgePerformance.push({order,times,p95A:p95(times.A),p95B:p95(times.B),ratio:p95(times.B)/p95(times.A)});
    }
   }
   state.active=wasActive;disk.visible=true;
   const bodyCenter=b.plGroups[sat].position.clone().project(s.camera);
   const bodyDepth=-b.plGroups[sat].position.clone().applyMatrix4(s.camera.matrixWorldInverse).z;
   const bodyRadius=c.PL[sat].R*c.K/bodyDepth*s.camera.projectionMatrix.elements[5]*h*.5;
   let opaquePixels=0,opaqueChanged=0,identityVsDirectChanged=0;
   let lensChanged=0,lensUndeformed=0,tidalChanged=0,ringDepthChanged=0,edgeDepthChanged=0,diskPixels=0,diskLight=0;
   for(let i=0;i<production.bytes.length;i+=4){
    const l=(a)=>.2126*a[i]+.7152*a[i+1]+.0722*a[i+2];
    if(foreground){const px=(i/4)%w+.5,py=Math.floor(i/4/w)+.5;
     if(Math.hypot(px-(bodyCenter.x*.5+.5)*w,py-(bodyCenter.y*.5+.5)*h)<bodyRadius*.55&&l(opaquePlain.bytes)>8){opaquePixels++;if(Math.abs(l(opaqueLensed.bytes)-l(opaquePlain.bytes))>1)opaqueChanged++;if(!bloom&&Math.abs(l(opaquePlain.bytes)-l(plain.bytes))>1)identityVsDirectChanged++;}
    }
    if(Math.abs(l(production.bytes)-l(noLens.bytes))>8)lensChanged++;
    if(Math.abs(l(noTides.bytes)-l(plain.bytes))>8)lensUndeformed++;
    if(Math.abs(l(noLens.bytes)-l(plain.bytes))>8)tidalChanged++;
    if(Math.abs(l(noTides.bytes)-l(noRingDepth.bytes))>8)ringDepthChanged++;
    if(Math.abs(l(noTides.bytes)-l(noEdgeDepth.bytes))>8)edgeDepthChanged++;
    const emit=l(production.bytes)-l(noDisk.bytes);if(emit>4){diskPixels++;diskLight+=emit;}
   }
   return{images:{...(foreground?{'identity-reference':opaquePlain.png}:{}),production:production.png,'no-lens':noLens.png,'no-tides':noTides.png,plain:plain.png,'no-disk':noDisk.png,...(scenario.startsWith('saturn-')?{'no-ring-depth-no-tides':noRingDepth.png,'no-edge-depth-no-tides':noEdgeDepth.png}:{})},edgePerformance,metrics:{lensChanged,lensUndeformed,tidalChanged,ringDepthChanged,edgeDepthChanged,opaquePixels,opaqueChanged,identityVsDirectChanged,diskPixels,diskLight},state:{meshSourceError,physicalLensDepth,bodyDepth,lensDepthError:Math.min(...Array.from(lens.lensingPass.uniforms.uDist.value).slice(0,lens.lensingPass.uniforms.uN.value).map(z=>Math.abs(z-physicalLensDepth))),opaqueComparison:'same compositor/target with lens mapping versus identity; additive bloom disabled',edgeRadiusNoTides:noTides.bodyRadius,edgeRadiusAblated:noEdgeDepth.bodyRadius,ringProxyNoTides:noTides.ringPresent,ringProxyAblated:noRingDepth.ringPresent,tidalActive:wasActive,lambda:state.lambda,shrink:state.shrink,collapse:state.collapse,diskOn:wasDisk,normal:disk.material.uniforms.uNormal.value.toArray(),origin:disk.material.uniforms.uOrigin.value.toArray(),distanceRs:disk.material.uniforms.uDistance.value,near:s.camera.near,far:s.camera.far,lensCount:lens.lensingPass.uniforms.uN.value},glError:gl.getError()};
  },{scenario,pitch});
  for(const[k,png]of Object.entries(result.images).filter(([kind])=>coarse.includes(pitch)||kind==='production'))await writeFile(`${out}/${scenario}-${pitch}-${k}.png`,Buffer.from(png.split(',')[1],'base64'));
  delete result.images;report.cases.push({scenario,pitch,...result});await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  assert.equal(result.glError,0,'live error-free WebGL context');assert(result.state.meshSourceError<1e-6,'drawn hole and physical lens positions match');assert(result.state.lensDepthError<.01,'selected lens depth matches drawn hole');assert.equal(result.state.diskOn,1,'steady quasar disk stays enabled independent of camera side');
  if(scenario.startsWith('saturn-')){assert.equal(result.state.ringProxyNoTides,1,'real ring draw publishes sampling depth');assert.equal(result.state.ringProxyAblated,0,'source-depth ablation is independent of TDE');assert(result.state.edgeRadiusNoTides>0,'silhouette coverage enabled');assert.equal(result.state.edgeRadiusAblated,0,'silhouette ablation leaves the ring proxy active');}
  if(scenario==='saturn-foreground-lens'){assert(result.state.physicalLensDepth>result.state.bodyDepth+500,'test lens is behind the complete body and rings');assert(result.metrics.opaquePixels>50,'foreground body mask samples visible opaque surface');assert.equal(result.metrics.opaqueChanged,0,'a lens behind the body cannot alter its opaque interior');}
  console.log(scenario,pitch,JSON.stringify(result.metrics));
 }
 const perf=report.cases.flatMap(c=>c.edgePerformance);
 assert.equal(perf.length,5,'all five fixed-order edge-coverage performance trials retained');
 report.edgePerformance={scope:'Actual frozen production renderer/compositor with GPU-synchronized full readback; edge coverage off/on ablation, not a complete baseline-head comparison',medianPairedP95Ratio:perf.map(p=>p.ratio).sort((a,b)=>a-b)[2]};
 assert(report.edgePerformance.medianPairedP95Ratio<=1.05,'edge coverage full-frame paired p95 stays within five percent');
 const edge=report.cases.filter(c=>c.scenario==='disk-crossing');
 const exact=edge.find(c=>c.pitch===0),near=edge.filter(c=>Math.abs(c.pitch)===.005);
 const crossing=edge.filter(c=>dense.includes(c.pitch)).sort((a,b)=>b.pitch-a.pitch);
 const outer=crossing.filter(c=>Math.abs(c.pitch)===.0008).map(c=>c.metrics.diskLight);
 assert(crossing.every(c=>c.metrics.diskLight<=Math.max(...outer)*1.25&&c.metrics.diskLight>=Math.min(...outer)*.75),'Normalized disk footprint avoids a crossing flash or dropout');
 assert(crossing.every((c,i)=>!i||Math.abs(c.metrics.diskLight-crossing[i-1].metrics.diskLight)<=Math.max(...outer)*.2),'Dense signed crossing remains continuous');
 assert(exact.metrics.diskPixels>near.reduce((s,c)=>s+c.metrics.diskPixels,0)/near.length*.5,'No all-dark edge-on disk dropout');
 assert.deepEqual(report.errors,[]);report.completed=true;
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser?.close();await server?.close();}
