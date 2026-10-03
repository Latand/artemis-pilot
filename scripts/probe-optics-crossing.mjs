// Diagnostic paired frames: freeze one world, then vary only camera pitch,
// lensing, or tidal presentation. These ablations do not alter physics.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { transformCelestialSource } from './celestial-detail-fixtures.mjs';
const mobile=process.env.DEVICE==='mobile';
const out=resolve(process.env.ARTEMIS_EVIDENCE||'evidence/optics-crossing');await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mobile,errors:[],cases:[],diagnosticOnly:true,
 scope:'Frozen rendered Saturn + nearby quasar; screen-space lens and tidal-mesh ablations. Physical interpretation is not inferred from the photograph.',
 omissions:['unrelated cosmic background, HYG and tier-1 catalogs','gravity-flow overlay','bloom; direct production lensing compositor is tested first']};
let server,browser;
try{
 server=await createServer({configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'optics-crossing-diagnostic',enforce:'pre',resolveId(id){if(id==='virtual:galaxy-preview')return '\0off';},load(id){if(id==='\0off')return 'export default null;';},transform:transformCelestialSource}]});await server.listen();
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:mobile?{width:390,height:700}:{width:960,height:640},deviceScaleFactor:1,isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(180000);
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|Shader|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
 await page.addInitScript(()=>{Date.now=()=>Date.UTC(2026,9,3,12);localStorage.clear();localStorage.setItem('ap_introSeen','1');});
 await page.route(/fonts\.(googleapis|gstatic)\.com/,r=>r.fulfill({contentType:'text/css',body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=saturn&dist=600&bloom=0&river=0&field=0&realsky=0&tier1=0&galaxies=0&galaxyvol=0&galaxy=0&compile=0&hidehelp=1`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__celestialFrame);
 await page.evaluate(async()=>{
  window.qa={s:await import('/src/scene.js'),st:await import('/src/state.js'),b:await import('/src/bodies.js'),bh:await import('/src/blackholes.js'),c:await import('/src/constants.js'),e:await import('/src/ephemeris.js'),tde:await import('/src/tdeVisuals.js'),hole:await import('/src/holeOptics.js'),lens:await import('/src/lensing.js')};
  qa.sat=qa.c.PL.findIndex(p=>p.name==='SATURN');
  qa.st.G.paused=true;qa.st.G.gr=false;qa.st.G.predict=false;qa.st.G.focus='free';
  qa.bh.clearBlackHoles();
  // The hole is slightly in front of Saturn along the camera's +z sightline.
  qa.bh.addBlackHole(qa.e.eph.plX[qa.sat]-150000,qa.e.eph.plY[qa.sat]-100000,50000,0,0,true,null,1,0,qa.e.eph.plZ[qa.sat],0);
  await window.__celestialEnsureLensing();
  for(let i=0;i<8;i++)window.__celestialFrame();
 });
 for(const scenario of ['saturn-near-lens','disk-crossing'])for(const pitch of [.48,.08,.005,0,-.005,-.08,-.48]){
  const result=await page.evaluate(({scenario,pitch})=>{
   const{s,st,b,bh,tde,hole,lens,c,sat}=qa;const m=bh.BH_META[0];
   st.G.focus='free';s.cam.tgt.copy(scenario==='disk-crossing'?m.g.position:b.plGroups[sat].position);
   if(scenario==='saturn-near-lens')s.cam.tgt.x-=75;
   s.cam.dist=scenario==='disk-crossing'?st.BH.rs[0]*c.K*8:600;s.cam.distTarget=null;s.cam.yaw=Math.PI/2;s.cam.pitch=pitch;
   window.__celestialFrame();
   const state=tde.tidalState(sat),wasActive=state.active;
   const disk=m.optics.disk,wasDisk=disk.material.uniforms.uDiskOn.value;
   const gl=s.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
   const draw=(lensed,tides,diskOn=true)=>{
    state.active=tides&&wasActive;disk.material.uniforms.uDiskOn.value=diskOn?wasDisk:0;
    if(lensed){lens.updateLensing(s.camera,s.camera.aspect);lens.renderLensed(s.renderer,s.scene,s.camera);}
    else{hole.holeRoot.visible=true;s.renderSceneTiered(s.renderer,s.scene,s.camera);}
    const bytes=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
    return{bytes,png:s.renderer.domElement.toDataURL('image/png')};
   };
   const production=draw(true,true),noLens=draw(false,true),noTides=draw(true,false),plain=draw(false,false),noDisk=draw(true,true,false);
   state.active=wasActive;disk.material.uniforms.uDiskOn.value=wasDisk;
   let lensChanged=0,tidalChanged=0,diskPixels=0,diskLight=0;
   for(let i=0;i<production.bytes.length;i+=4){
    const l=(a)=>.2126*a[i]+.7152*a[i+1]+.0722*a[i+2];
    if(Math.abs(l(production.bytes)-l(noLens.bytes))>8)lensChanged++;
    if(Math.abs(l(noLens.bytes)-l(plain.bytes))>8)tidalChanged++;
    const emit=l(production.bytes)-l(noDisk.bytes);if(emit>4){diskPixels++;diskLight+=emit;}
   }
   return{images:{production:production.png,'no-lens':noLens.png,'no-tides':noTides.png,plain:plain.png,'no-disk':noDisk.png},metrics:{lensChanged,tidalChanged,diskPixels,diskLight},state:{tidalActive:wasActive,lambda:state.lambda,shrink:state.shrink,collapse:state.collapse,diskOn:wasDisk,normal:disk.material.uniforms.uNormal.value.toArray(),origin:disk.material.uniforms.uOrigin.value.toArray(),distanceRs:disk.material.uniforms.uDistance.value,near:s.camera.near,far:s.camera.far,lensCount:lens.lensingPass.uniforms.uN.value},glError:gl.getError()};
  },{scenario,pitch});
  for(const[k,png]of Object.entries(result.images))await writeFile(`${out}/${scenario}-${pitch}-${k}.png`,Buffer.from(png.split(',')[1],'base64'));
  delete result.images;report.cases.push({scenario,pitch,...result});await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  assert.equal(result.glError,0,'live error-free WebGL context');assert.equal(result.state.diskOn,1,'steady quasar disk stays enabled independent of camera side');
  console.log(scenario,pitch,JSON.stringify(result.metrics));
 }
 assert.deepEqual(report.errors,[]);report.completed=true;
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser?.close();await server?.close();}
