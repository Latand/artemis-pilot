// One desktop Proxima preparation proof. This cannot certify performance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { protocol, summarize, validateSample, assertHealthyState, assertMatchedState } from './river-radiance-paired-protocol.mjs';
import { transform, initializeDocument, initializeQA, readiness, readState } from './river-radiance-paired-browser.mjs';
import { validatePreparationFrame, validatePrefix, validateFence, settlementReadyWithinDeadline } from './river-radiance-preparation-qa.mjs';

assert(process.env.BASE_ROOT, 'Exact baseline root required');
const root=resolve(process.argv[2]||'.'), baseline=resolve(process.env.BASE_ROOT), out=resolve(process.argv[3]||'evidence/radiance-preparation');
const hash=value=>createHash('sha256').update(value).digest('hex');
const git=(dir,...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
const spec=protocol.fixtures.find(f=>f.subject==='proxima');
const fixture=JSON.parse(await readFile(new URL('./fixtures/river-radiance-proxima.json',import.meta.url),'utf8'));
const report={probeOnly:true,passed:null,shardComplete:false,device:'desktop',fixture:spec,
  scope:'One desktop Proxima preparation proof; no paired performance acceptance or omitted-trial substitute',
  method:'Exactly120 native-rAF production frames per revision for the fixed catalog prefix, then a separate five-minute asset/worker settlement deadline. Setup and120 warmup frames use native rAF without test-added finish/readPixels. Production-internal synchronization remains. Verified GPU fences follow settlement and warmup. Eight normal timer-task synchronized cost probes per revision follow; all are diagnostic only.',
  limits:{jobMinutes:60,prefixUpdates:120,assetSettlementMs:300000,warmupFrames:120,costFramesPerRevision:8},
  sources:{},prefix:{A:[],B:[]},settlement:{A:[],B:[],readiness:[]},warmup:{A:[],B:[]},fences:[],cost:{A:[],B:[]},errors:[]};
for(const [label,dir,expected]of[['A',baseline,protocol.baseline],['B',root,protocol.productionCandidate]]){
  if(label==='A')assert.equal(git(dir,'rev-parse','HEAD'),expected);
  git(dir,'diff','--exit-code',expected,'--','src','public','index.html','package.json');
  assert.equal(git(dir,'ls-files','--others','--exclude-standard','--','src','public','index.html','package.json'),'');
  report.sources[label]={revision:git(dir,'rev-parse','HEAD'),tree:git(dir,'rev-parse','HEAD^{tree}'),productionReference:expected};
  for(const path of ['src/main.js','src/river.js','src/render/bodySurfaceMaterial.js','src/universe/athygTier1.js']){
    const source=await readFile(resolve(dir,path),'utf8');
    execFileSync(process.execPath,['--input-type=module','--check'],{input:transform(source,'/'+path)});
  }
}
report.harness=Object.fromEntries(await Promise.all(['probe-river-radiance-preparation.mjs','river-radiance-preparation-qa.mjs','river-radiance-paired-browser.mjs','river-radiance-paired-protocol.mjs']
  .map(async p=>[p,hash(await readFile(new URL(p,import.meta.url)))])));
if(process.argv.includes('--validate')){console.log(JSON.stringify({hooks:'valid',browserRun:false,sources:report.sources}));process.exit(0);}
await mkdir(out,{recursive:true});
const save=()=>writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
let browser;const contexts=[],servers=[],caches=[],pages={};
const activate=async page=>{await page.bringToFront();await page.waitForFunction(()=>!document.hidden);};
async function deliver(page,synchronize){
  await activate(page);const start=performance.now();
  const sample=await page.evaluate(synchronize=>new Promise((resolve,reject)=>{
    const run=()=>{try{resolve(__pairedFrame(synchronize));}catch(error){reject(error);}};
    if(synchronize)setTimeout(run,0);else requestAnimationFrame(run);
  }),synchronize);
  sample.roundTripMs=performance.now()-start;
  sample.protocolAndSchedulingMs=Math.max(0,sample.roundTripMs-sample.frameAndFinishMs);
  (synchronize?validateSample:validatePreparationFrame)(sample);return sample;
}
async function pairedPreparation(target){
  for(const label of['A','B']){
    const sample=await deliver(pages[label],false),previous=target[label].at(-1);
    if(previous)assert.equal(sample.frameNo,previous.frameNo+1,'No omitted native-rAF production frame');
    target[label].push(sample);await save();
  }
}
async function fence(label,stage){
  await activate(pages[label]);
  const value=await pages[label].evaluate(()=>{
    const q=pairedQA,gl=q.scene.renderer.getContext(),pixel=new Uint8Array(4),before=__pairedWorkload().frameNo,start=performance.now();
    gl.finish();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    return {before,after:__pairedWorkload().frameNo,durationMs:performance.now()-start,pixel:Array.from(pixel),
      contextLost:gl.isContextLost(),error:gl.getError(),defaultFramebuffer:gl.getParameter(gl.FRAMEBUFFER_BINDING)===null};
  });
  validateFence(value);report.fences.push({label,stage,...value});await save();
}
async function snapshot(label){
  const state=await pages[label].evaluate(readState);state.river.textureHash=hash(Buffer.from(state.river.textureBase64,'base64'));delete state.river.textureBase64;return state;
}
try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']});
  report.browser=await browser.version();report.started=Date.now();
  for(const[label,dir]of[['A',baseline],['B',root]]){
    const cacheDir=await mkdtemp(resolve(os.tmpdir(),'radiance-preparation-'));caches.push(cacheDir);
    const server=await createServer({root:dir,cacheDir,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'radiance-preparation',enforce:'pre',transform}]});
    await server.listen();servers.push(server);
    const context=await browser.newContext({viewport:{width:1200,height:800},deviceScaleFactor:1});contexts.push(context);
    await context.addInitScript(initializeDocument);const page=await context.newPage();pages[label]=page;page.setDefaultTimeout(120000);
    page.on('pageerror',error=>report.errors.push({label,message:error.stack||error.message}));
    page.on('console',message=>{if(message.type()==='error')report.errors.push({label,message:message.text()});});
    await page.route('https://fonts.googleapis.com/**',route=>route.fulfill({status:200,body:''}));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?${new URLSearchParams(protocol.query)}`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__AP_READY&&window.__pairedFrame&&window.__pairedRadianceRead);
    report.sources[label].device=await page.evaluate(initializeQA,{fixture,spec,catalogSetupUpdates:protocol.catalogSetupUpdates});
    assert.equal(report.sources[label].device.mobile,false);await page.waitForFunction(()=>pairedQA.tier1.tier1Stats().initialized);await save();
  }
  assert.equal(report.sources.A.device.gpu,report.sources.B.device.gpu);
  const prefixStart=performance.now();
  for(let i=0;i<protocol.catalogSetupUpdates;i++){
    await pairedPreparation(report.prefix);
    const status={A:await pages.A.evaluate(readiness),B:await pages.B.evaluate(readiness)};
    for(const label of['A','B']){validatePrefix(status[label].catalogPrefix,i+1);report.prefix[label].at(-1).readiness=status[label];}
    await save();
  }
  report.prefixMs=performance.now()-prefixStart;
  const settlementStart=performance.now();
  while(true){
    const ready={A:await pages.A.evaluate(readiness),B:await pages.B.evaluate(readiness)};report.settlement.readiness.push(ready);
    for(const label of['A','B'])validatePrefix(ready[label].catalogPrefix,protocol.catalogSetupUpdates);
    await save();ready.elapsedMs=performance.now()-settlementStart;
    if(settlementReadyWithinDeadline(ready,ready.elapsedMs,report.limits.assetSettlementMs))break;
    await pairedPreparation(report.settlement);
  }
  report.settlementMs=performance.now()-settlementStart;
  for(const label of['A','B'])await fence(label,'settled');
  for(let i=0;i<protocol.warmupFrames;i++)await pairedPreparation(report.warmup);
  for(const label of['A','B'])await fence(label,'warm');
  report.before={A:await snapshot('A'),B:await snapshot('B')};
  for(const label of['A','B'])assertHealthyState(report.before[label],false,'proxima');
  assertMatchedState(report.before.A,report.before.B);await save();
  for(let i=0;i<report.limits.costFramesPerRevision;i++){
    for(const label of['A','B']){report.cost[label].push(await deliver(pages[label],true));await save();}
  }
  report.after={A:await snapshot('A'),B:await snapshot('B')};
  for(const label of['A','B'])assertHealthyState(report.after[label],false,'proxima');
  assertMatchedState(report.after.A,report.after.B);
  report.costSummary=Object.fromEntries(['A','B'].map(label=>[label,summarize(report.cost[label].map(f=>f.frameAndFinishMs))]));
  report.projection=Object.fromEntries(['A','B'].map(label=>[label,{measured1200Ms:report.costSummary[label].p50*1200,
    warmup240Ms:report.costSummary[label].p50*240,device3600MeasuredMs:report.costSummary[label].p50*3600,
    note:'Small settled diagnostic window only; projections cannot certify performance or another view/device'}]));
  assert.equal(report.errors.length,0,'All browser/shader errors remain blocking');report.preparationComplete=true;
  console.log(JSON.stringify({preparationComplete:true,performanceAcceptance:false,prefixMs:report.prefixMs,settlementMs:report.settlementMs,cost:report.costSummary,projection:report.projection}));
}catch(error){report.errors.push({message:error.stack||String(error)});report.preparationComplete=false;process.exitCode=1;console.error(error);}
finally{await save();for(const context of contexts)await context.close();await browser?.close();for(const server of servers)await server.close();for(const cache of caches)await rm(cache,{recursive:true,force:true});}
