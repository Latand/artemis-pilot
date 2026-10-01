// Actual app + numerical SPH: desktop and touch, cold collapse vs hot dispersal,
// delivered-time limits, checkpoint replay, and persisted numerical state.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out=resolve(process.argv[2]||'evidence/gas-formation');await mkdir(out,{recursive:true});
const report={model:'numerical-isothermal-SPH',profiles:[],errors:[]};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
 name:'gas-qa-controls',enforce:'pre',transform(source,id){if(!id.replaceAll('\\','/').endsWith('/src/main.js'))return;
  const marker='const firstFrameT0 = perfStart();';assert.equal(source.split(marker).length,2);
  return source.replace(marker,'G.t=0; G.paused=true; resetEphem();\n'+marker)+'\nwindow.__gasFrame=frame;window.__gasRestart=restart;';}
}]});await server.listen();
const browser=await chromium.launch({args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 for(const mobile of [false,true]){
  const name=mobile?'mobile':'desktop',viewport=mobile?{width:390,height:844}:{width:1280,height:800};
  const context=await browser.newContext({viewport,deviceScaleFactor:1,isMobile:mobile,hasTouch:mobile});
  await context.addInitScript(()=>{Date.now=()=>Date.UTC(2026,9,1,12);localStorage.setItem('ap_introSeen','1');});
  const page=await context.newPage();page.setDefaultTimeout(45000);
  const entry={name,viewport,checks:[],frames:[]};report.profiles.push(entry);
  const check=(pass,label)=>{entry.checks.push({label,pass});assert.ok(pass,name+': '+label);};
  page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Shader|WebGL|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
  try{
   await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
   await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?hidehelp=1&tier1=0&galaxyvol=0&galaxies=0&field=0&realsky=0&river=0&lens=0&bloom=0`,{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.__AP_READY&&window.__gasFrame);
   await page.evaluate(async()=>{window.qaScene=await import('/src/scene.js');qaScene.renderer.setAnimationLoop(null);__G.paused=true;__G.gr=false;});
   const frames=async(n=2)=>{for(let i=0;i<n;i++)await page.evaluate(()=>{__gasFrame();qaScene.renderer.getContext().finish();});};
   const click=async(sel)=>{if(mobile)await page.locator(sel).tap();else await page.locator(sel).click();await frames();};
   const capture=async(label)=>{await frames();await page.screenshot({path:`${out}/${name}-${label}.png`});entry.frames.push(label);await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('CAPTURE',name,label);};
   const state=()=>page.evaluate(async()=>{const n=(await import('/src/universe/nebulaeData.js')).NEBULAE[Number(__G.focus.split(':')[1])];const m=await import('/src/universe/gasFormation.js');const s=m.gasStateAt(n,__G.t);return {t:__G.t,phase:s.phase,ready:s.ready,core:s.coreMassSolar,gas:s.gasMassSolar,temperature:s.temperatureK,steps:s.steps,density:s.densityContrast,rms:s.diagnostics.rmsRadius,positions:m.gasNumericalView(n,__G.t).a.positions};});
   // This invokes production world stepping, not a fabricated phase/time map.
   const evolve=async(fraction,index=0)=>page.evaluate(async({fraction,index})=>{
    const d=await import('/src/universe/nebulaeData.js'),m=await import('/src/universe/gasFormation.js'),world=await import('/src/worldStep.js');
    const n=d.NEBULAE[index],initial=m.gasNumericalView(n,n.formation.bornAtSec).a;
    const target=n.formation.bornAtSec+fraction*initial.unitTimeSec;
    let iterations=0,maxGasSteps=0,limited=0;
    while(Math.abs(__G.t-target)>Math.max(1,Math.abs(target)*1e-13)&&iterations++<2500){
     const wanted=target-__G.t;world.stepWorld(wanted);
     maxGasSteps=Math.max(maxGasSteps,world.WORLD_STEP.gasSteps||0);if(world.WORLD_STEP.limited)limited++;
    }
    __G.paused=true;return{iterations,maxGasSteps,limited,target,t:__G.t,ready:m.gasStateAt(n,__G.t).ready};
   },{fraction,index});
   await click('[data-ui-mode="direct"]');await click('[data-create-kind="4"]');
   await page.locator('#gasTemperature').selectOption('10');await page.locator('#gasMotion').selectOption('0');
   await click('#gasRelease');await page.waitForTimeout(4500);await frames();
   const initial=await state();
   check(initial.ready&&initial.core===0&&initial.gas===1,'Release creates cold numerical gas, not an instant star');
   check(await page.evaluate(()=>__G.paused),'Placement preserves pause');
   await capture('cloud');await frames(5);check(JSON.stringify((await state()).positions)===JSON.stringify(initial.positions),'Pause freezes numerical parcel positions');
   await click('#gasWatch');check(await page.evaluate(()=>!__G.paused&&__G.warp===1000*31557600),'Run physics changes only the shared clock speed');
   await click('#tdPause');check(await page.evaluate(()=>__G.paused),'Time pause stops gas integration');
   const collapseStep=await evolve(1.1);await frames();const collapse=await state();
   check(collapseStep.ready&&collapseStep.maxGasSteps<=4,'World advance limits SPH work to four steps per frame');
   check(collapseStep.limited>0,'Extreme requested warp reports limited delivered time');
   check(collapse.rms<initial.rms*.85&&collapse.core===0,'Cold gas contracts through forces before any sink exists');
   await capture('collapse');
   await page.evaluate(async()=>{(await import('/src/saves.js')).saveState();});
   const saved=await state();
   await evolve(1.7);await frames();const core=await state();
   check(core.core>0&&Math.abs(core.gas+core.core-1)<1e-12,'Bound collapsing gas becomes a mass-conserving protostellar sink');
   await capture('protostar');
   await evolve(2.2);await frames();await capture('core');await click('#gasWatch');await capture('core-close');
   const reverse=await evolve(1.1);await frames();const replay=await state();
   check(reverse.ready&&replay.core===0,'Reverse restores and replays gas history instead of reversing cooling');
   check(JSON.stringify(replay.positions)===JSON.stringify(saved.positions),'Replayed canonical parcel state is exact');
   await page.evaluate(async()=>{await(await import('/src/saves.js')).loadState();});await frames();
   check(JSON.stringify((await state()).positions)===JSON.stringify(saved.positions),'Quicksave restores numerical checkpoint arrays');
   // Hot counterexample via the same actual Create controls.
   if(mobile)await click('#gasCreateToggle');await click('[data-create-kind="4"]');
   await page.locator('#gasTemperature').selectOption('200');await page.locator('#gasMotion').selectOption('0');
   const point=await page.evaluate(()=>{for(let y=120;y<innerHeight-150;y+=20)for(let x=35;x<innerWidth-35;x+=20)if(document.elementFromPoint(x,y)===qaScene.renderer.domElement)return{x,y};return null;});
   check(!!point,'Canvas remains reachable beside Create controls');
   if(mobile)await page.touchscreen.tap(point.x,point.y);else await page.mouse.click(point.x,point.y);await frames();
   check(await page.evaluate(async()=>(await import('/src/universe/nebulaeData.js')).NEBULAE.length===2&&!(await import('/src/blackholes.js')).isBHPlacementMode()),'Mouse/touch release creates one cloud and disarms');
   const hotInitial=await state();await evolve(3,1);await frames();const hot=await state();
   check(hot.temperature===200&&hot.core===0&&hot.rms>hotInitial.rms*2,'Hot pressure-supported gas disperses without a scheduled star');
   await capture('hot-dispersal');
   check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
   await click('[data-ui-mode="observe"]');check(await page.evaluate(async()=>!(await import('/src/blackholes.js')).isBHPlacementMode()),'Leaving Create cancels placement');
   await page.evaluate(()=>__gasRestart());await frames();check(await page.evaluate(async()=>(await import('/src/universe/nebulaeData.js')).NEBULAE.length===0),'Restart clears gas and sinks');
  }catch(error){report.errors.push(name+': '+error.stack);console.error(name,error);await page.screenshot({path:`${out}/${name}-failure.png`}).catch(()=>{});}
  await context.close();
 }
 assert.deepEqual(report.errors,[],'No runtime, shader or numerical-control failures');
 console.log('Numerical gas desktop/mobile checks passed');
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
