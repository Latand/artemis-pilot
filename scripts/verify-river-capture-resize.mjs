// Short hosted preflight for the actual coverage capture helper and production
// scene ResizeObserver. It renders a bright empty scene, not the 1200-frame
// physical river fixture; success here never substitutes for that full gate.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root=resolve(process.env.BASE_ROOT||process.cwd());
const mobile=process.env.DEVICE==='mobile';
const viewport=mobile?{width:215,height:466}:{width:768,height:512};
const captureViewport=mobile?{width:430,height:932}:{width:960,height:640};
const out=resolve(process.env.ARTEMIS_EVIDENCE||'evidence/river-capture-resize');
const source=await readFile(new URL('./verify-river-coverage.mjs',import.meta.url),'utf8');
const start=source.indexOf(' const setViewportStable=async size=>{');
const end=source.indexOf(' check(await page.evaluate(async mobile=>',start);
assert(start>0&&end>start);
const helper=source.slice(start,end);
assert(helper.includes('page.waitForFunction(size=>{'));
assert(!helper.includes('page.waitForFunction(async'));
const dprHook='window.__coverageDpr=pr=>{renderQuality.dpr=pr;renderer.setPixelRatio(pr);resizePostProcessing();};';
assert(source.includes(dprHook),'preflight uses the exact coverage DPR hook');
// This compiles the same helper, including its same-task readPixels/toDataURL
// and UI capture, instead of maintaining a second approximation of it.
const makeCapture=new Function('page','viewport','captureViewport','mobile','report','out','check','writeFile','Buffer',`return (async()=>{${helper}\nreturn {screenshot,setViewportStable};})()`);
if(process.argv.includes('--validate')){console.log('River rapid-resize helper and synchronous predicate validated');process.exit(0);}

await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),mobile,viewport,captureViewport,cycles:32,scope:'Production scene/ResizeObserver and real coverage capture helper; bright empty scene isolates viewport synchronization. Full river physics/1200-frame coverage remains separate.',checks:[],errors:[],captures:[],restored:[],passed:false};
const check=(ok,name)=>{report.checks.push({name,pass:!!ok});assert(ok,name);};
const save=()=>writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
let server,browser;
try{
 server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'river-capture-resize-preflight',enforce:'pre',transform(text,id){
  if(id.split('?')[0].endsWith('/src/scene.js'))return text+'\n'+dprHook;
 },configureServer(server){server.middlewares.use((req,res,next)=>{
  if(req.url?.split('?')[0]!=='/__river-resize-qa')return next();
  res.setHeader('Content-Type','text/html');
  res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#gl{position:fixed;inset:0}</style><div id="gl"></div><script type="module">
   import * as s from '/src/scene.js';
   s.renderer.setClearColor(0x336699,1);
   window.__coverageFrame=()=>{s.renderer.setRenderTarget(null);s.renderer.render(s.scene,s.camera);};
   window.__resizeReady=true;
  </script>`);
 });}}]});
 await server.listen();
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport,hasTouch:mobile,isMobile:mobile,deviceScaleFactor:1});page.setDefaultTimeout(15000);
 page.on('pageerror',error=>report.errors.push(error.stack||error.message));
 page.on('console',message=>{if(message.type()==='error'&&/THREE|Shader|GL_INVALID/.test(message.text()))report.errors.push(message.text());});
 await page.addInitScript(()=>{
  const Native=window.ResizeObserver;
  const state=window.__resizeProbe={hold:false,delayFrames:0,pending:[],callbacks:0};
  state.release=()=>{state.hold=false;for(const run of state.pending.splice(0))run();};
  // Retain native layout/observer delivery. Only delay callback delivery to
  // make the old race deterministic and stress real settlement afterward.
  window.ResizeObserver=class extends Native{
   constructor(callback){super((entries,observer)=>{
    const run=()=>{callback(entries,observer);state.callbacks++;};
    const later=left=>{if(state.hold)state.pending.push(run);else if(left>0)requestAnimationFrame(()=>later(left-1));else run();};
    later(state.delayFrames);
   });}
  };
 });
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__river-resize-qa?dpr=.5&compile=0`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__resizeReady);
 const capture=await makeCapture(page,viewport,captureViewport,mobile,report,out,check,writeFile,Buffer);
 await capture.setViewportStable(viewport);

 await page.evaluate(()=>{window.__resizeProbe.hold=true;});
 await page.setViewportSize(captureViewport);
 // Exact former predicate: Playwright accepts its Promise immediately even
 // when the imported scene reports that the resize has NOT completed.
 const oldResult=await page.waitForFunction(async size=>{const s=await import('/src/scene.js');return s.viewportSize.w===size.width&&s.viewportSize.h===size.height;},captureViewport);
 report.legacyResolvedValue=await oldResult.jsonValue();await oldResult.dispose();
 check(report.legacyResolvedValue===false,'former async wait incorrectly accepts false while the observer is held');
 report.legacyCapture=await page.evaluate(async()=>{
  const s=await import('/src/scene.js');window.__coverageDpr(1);window.__coverageFrame();
  const gl=s.renderer.getContext();return{width:gl.drawingBufferWidth,height:gl.drawingBufferHeight,dpr:s.renderer.getPixelRatio(),mobile:s.renderQuality.mobile,viewport:{...s.viewportSize}};
 });
 check(report.legacyCapture.width===viewport.width&&report.legacyCapture.height===viewport.height,'old ordering deterministically captures the stale soak dimensions');
 check(report.legacyCapture.dpr===1&&report.legacyCapture.mobile===mobile,'reproduction retains correct DPR and device tier');
 await page.evaluate(()=>{window.__resizeProbe.release();});
 await capture.setViewportStable(viewport);await page.evaluate(()=>window.__coverageDpr(.5));

 for(let i=0;i<report.cycles;i++){
  await page.evaluate(delay=>{window.__resizeProbe.delayFrames=delay;},i%4);
  // Burst a third layout between soak and capture. Delayed observers read
  // the live host, exactly as production resize() does.
  await page.setViewportSize({width:viewport.width+11,height:viewport.height+7});
  await capture.screenshot(`resize-${i}`);
  const restored=await page.evaluate(()=>{
   const s=window.__coverageScene,gl=s.renderer.getContext();
   return{viewport:{...s.viewportSize},host:[s.cvHost.clientWidth,s.cvHost.clientHeight],aspect:s.camera.aspect,dpr:s.renderer.getPixelRatio(),width:gl.drawingBufferWidth,height:gl.drawingBufferHeight,mobile:s.renderQuality.mobile,contextLost:gl.isContextLost(),error:gl.getError()};
  });
  report.restored.push(restored);
  check(restored.viewport.w===viewport.width&&restored.viewport.h===viewport.height&&restored.host[0]===viewport.width&&restored.host[1]===viewport.height,`${i}: exact soak host and viewport restored`);
  check(restored.dpr===.5&&restored.width===Math.floor(viewport.width*.5)&&restored.height===Math.floor(viewport.height*.5)&&Math.abs(restored.aspect-viewport.width/viewport.height)<1e-9,`${i}: soak DPR, buffer and camera restored`);
  check(restored.mobile===mobile&&!restored.contextLost&&restored.error===0,`${i}: device tier and GL health retained`);
  if(i%8===0){console.log('rapid resize',mobile?'mobile':'desktop',i);await save();}
 }
 check(report.captures.length===32&&report.restored.length===32,'all 32 rapid full-resolution capture/restore cycles completed');
 check(report.errors.length===0,'no shader/runtime errors');report.passed=true;
}catch(error){report.failure=error.stack||String(error);process.exitCode=1;}
finally{await save();await browser?.close();await server?.close();}
