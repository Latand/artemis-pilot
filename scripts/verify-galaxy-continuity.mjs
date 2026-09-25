import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
const root=process.argv[2] || process.cwd(), out=process.argv[3] || 'evidence/galaxy';
await mkdir(out,{recursive:true});
const server=await createServer({root,server:{host:'127.0.0.1',port:0,hmr:false},logLevel:'error'}); await server.listen();
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM || undefined,headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
const page=await browser.newPage({viewport:{width:640,height:400},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('ERROR',e.message));
page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text().slice(0,700));});
await page.addInitScript(()=>{Date.now=()=>Date.UTC(2026,8,13,12);localStorage.setItem('ap_intro_seen','1');});
await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?hidehelp=1&dpr=1&tier1=0&galadapt=0&focus=sun&dist=1e4&realsky=0&river=0`,{waitUntil:'domcontentloaded',timeout:120000});
await page.waitForFunction(()=>window.__AP_READY,null,{timeout:120000});console.log('APP READY');
await page.evaluate(async()=>{const {setPaused}=await import('/src/timeCtl.js');setPaused(true,'capture');__G.predict=false;});
await page.waitForFunction(()=>__volStatus().mapsReady,null,{timeout:120000});
await page.evaluate(async()=>{
 const s=await import('/src/scene.js'),v=await import('/src/render/galaxyVolume.js'),c=await import('/src/universe/coords.js'),{K}=await import('/src/constants.js'),e=await import('/src/render/stellarAppearance.js');
 s.renderer.setAnimationLoop(null);window.test={s,v,c,K,e};e.stellarExposure.value=.15;e.extragalacticExposure.blend=0;e.extragalacticExposure.stretch=0;
 const p=[0,0,0];c.galToSceneUnitsInto(8178,0,20.8,p,0,K);s.camera.position.set(...p);c.galToSceneUnitsInto(0,0,0,p,0,K);s.camera.lookAt(...p);s.camera.updateMatrixWorld();
 window.draw=()=>{v.updateGalaxyVolume(s.camera,0);s.renderer.setRenderTarget(null);s.renderer.setScissorTest(false);s.renderer.autoClear=true;s.renderer.clear();v.renderGalaxyVolume(s.renderer);const gl=s.renderer.getContext();gl.finish();const w=gl.drawingBufferWidth,h=gl.drawingBufferHeight,buf=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,buf);let sum=0,nz=0;for(let i=0;i<buf.length;i+=4){sum+=buf[i]+buf[i+1]+buf[i+2];if(buf[i]+buf[i+1]+buf[i+2]>3)nz++;}return {stats:v.galaxyVolumeStats(),mean:sum/w/h/3,nonzero:nz/w/h,size:[w,h]};};
});
const readings=[];for(let i=0;i<12;i++){const r=await page.evaluate(()=>draw());readings.push(r);console.log('DRAW',i,JSON.stringify(r));await page.waitForTimeout(70);}
await page.addStyleTag({content:'body *{visibility:hidden!important}#gl,#gl canvas{visibility:visible!important}'});await page.screenshot({path:out+'/before-resize.png'});
const resized=await page.evaluate(()=>{test.s.renderer.setSize(800,500);return draw();});console.log('RESIZE',JSON.stringify(resized));await writeFile(out+'/probe.json',JSON.stringify({readings,resized},null,2));await page.screenshot({path:out+'/after-resize.png'});console.log('RESIZE NEXT',await page.evaluate(()=>draw()));
await writeFile(out+'/gpu.json',JSON.stringify(await page.evaluate(()=>{const gl=test.s.renderer.getContext(),x=gl.getExtension('WEBGL_debug_renderer_info');return {vendor:gl.getParameter(x.UNMASKED_VENDOR_WEBGL),renderer:gl.getParameter(x.UNMASKED_RENDERER_WEBGL)};}),null,2));
} finally {await browser.close();await server.close();}
