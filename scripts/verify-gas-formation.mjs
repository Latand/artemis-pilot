// Real WebGL + actual desktop/touch controls. Run locally or in GitHub CI.
// Formation screenshots use exact simulated phases, not wall-clock guessing.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out=resolve(process.argv[2]||'evidence/gas-formation');
await mkdir(out,{recursive:true});
const report={profiles:[],errors:[]};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
 name:'gas-qa-controls',enforce:'pre',transform(source,id){
  if(!id.replaceAll('\\','/').endsWith('/src/main.js'))return;
  const marker='const firstFrameT0 = perfStart();';
  assert.equal(source.split(marker).length,2);
  return source.replace(marker,'G.t=0; G.paused=true; resetEphem();\n'+marker)+'\nwindow.__gasFrame=frame;window.__gasRestart=restart;';
 }
}]});
await server.listen();
const browser=await chromium.launch({args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 for(const mobile of [false,true]) {
  const name=mobile?'mobile':'desktop', viewport=mobile?{width:390,height:844}:{width:1280,height:800};
  const context=await browser.newContext({viewport,deviceScaleFactor:1,isMobile:mobile,hasTouch:mobile});
  const page=await context.newPage();page.setDefaultTimeout(45000);
  const entry={name,viewport,checks:[],frames:[]};report.profiles.push(entry);
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&/Shader|WebGL|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
  await context.addInitScript(()=>{Date.now=()=>Date.UTC(2026,9,1,12);localStorage.setItem('ap_introSeen','1');});
  await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?hidehelp=1&tier1=0&galaxyvol=0&galaxies=0&field=0&realsky=0&river=0&lens=0&bloom=0`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__AP_READY&&window.__gasFrame);
  await page.evaluate(async()=>{window.qaScene=await import('/src/scene.js');qaScene.renderer.setAnimationLoop(null);__G.paused=true;__G.gr=false;});
  const frames=async(n=2)=>{for(let i=0;i<n;i++)await page.evaluate(()=>{__gasFrame();qaScene.renderer.getContext().finish();});};
  const check=(pass,label)=>{entry.checks.push({label,pass});assert.ok(pass,`${name}: ${label}`);};
  const snap=async(label)=>{await frames();await page.screenshot({path:`${out}/${name}-${label}.png`});entry.frames.push(label);await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('CAPTURE',name,label);};
  const click=async(selector)=>{const el=page.locator(selector);if(mobile)await el.tap();else await el.click();await frames();};
  await click('[data-ui-mode="direct"]');
  await click('[data-create-kind="4"]');
  check(await page.locator('#gasRelease').isVisible(),'Gas creation is reachable');
  await click('#gasRelease');
  const source=await page.evaluate(async()=>{
   const d=await import('/src/universe/nebulaeData.js'),m=await import('/src/universe/gasFormation.js');
   const n=d.NEBULAE[0];return {n,birth:n.formation.bornAtSec+m.formationDuration(n),duration:m.formationDuration(n),count:d.NEBULAE.length,focus:__G.focus};
  });
  check(source.count===1&&source.focus==='neb:0','Release creates one cloud and focuses index zero');
  check(await page.evaluate(()=>__G.paused),'Placement preserves paused state');
  check(await page.locator('#gasStage').textContent()==='Gas cloud · 0%','Cloud exists before ignition');
  await snap('cloud');
  const frozen=await page.evaluate(async()=>JSON.stringify((await import('/src/universe/gasFormation.js')).gasStateAt((await import('/src/universe/nebulaeData.js')).NEBULAE[0],__G.t)));
  await frames(5);
  check(await page.evaluate(async()=>JSON.stringify((await import('/src/universe/gasFormation.js')).gasStateAt((await import('/src/universe/nebulaeData.js')).NEBULAE[0],__G.t)))===frozen,'Pause freezes every analytic stage');
  const phase=async(p)=>{await page.evaluate(async({t})=>{(await import('/src/state.js')).setSimTime(t);__G.paused=true;},{t:source.n.formation.bornAtSec+source.duration*p});await frames(3);};
  await phase(.55);await snap('collapse');
  await phase(.86);await snap('protostar');
  await phase(1.001);await snap('star');
  const born=await page.evaluate(async()=>{const d=await import('/src/universe/nebulaeData.js'),a=await import('/src/universe/activeStars.js');a.refreshActiveStars(__G.x,__G.y,__G.z,__G.focus,__G.t);return {stars:a.ACTIVE_STARS.filter(s=>s.formedStar).length,gas:d.NEBULAE.length,hasPoint:qaScene.scene.children.some(g=>g.children?.some(o=>o.isPoints)&&Math.abs(g.position.x-d.NEBULAE[0].xKm*.001)<1)};});
  check(born.stars===1&&born.gas===1,'Ignition creates exactly one active star from retained source');
  await page.evaluate(async()=>{const s=await import('/src/saves.js');window.assertSave=s.saveState();});
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('artemis.quicksave.v1')));
  check(saved.neb[0][6].massSolar===source.n.formation.massSolar,'Quicksave carries formation source');
  await phase(.2);
  await page.evaluate(async()=>{await (await import('/src/saves.js')).loadState();});await frames();
  check((await page.locator('#gasStage').textContent()).startsWith('Newborn star'),'Quickload restores formed stage and focus');
  await phase(.5);
  const reversed=await page.evaluate(async()=>{const a=await import('/src/universe/activeStars.js');a.refreshActiveStars(0,0,0,__G.focus,__G.t);return a.ACTIVE_STARS.filter(s=>s.formedStar).length;});
  check(reversed===0,'Rewind removes stellar gravity and returns the same cloud');
  await phase(0);
  await click('#gasWatch');
  check(await page.evaluate(async()=>!__G.paused&&(await import('/src/timeCtl.js')).jumpActive()),'Watch starts real cancellable simulation-time acceleration');
  await click('#tdPause');
  check(await page.evaluate(async()=>__G.paused&&!(await import('/src/timeCtl.js')).jumpActive()),'Pause cancels Watch rather than fighting user time controls');
  // Explicit world-step tests cover a large forward and reverse boundary crossing.
  const clock=await page.evaluate(async()=>{
   const d=await import('/src/universe/nebulaeData.js'),m=await import('/src/universe/gasFormation.js'),st=await import('/src/state.js'),w=await import('/src/worldStep.js'),a=await import('/src/universe/activeStars.js');
   const birth=d.NEBULAE[0].formation.bornAtSec+m.formationDuration(d.NEBULAE[0]);
   st.G.dead=true;st.setSimTime(birth-100);const forward=w.stepWorld(200);const f=a.ACTIVE_STARS.filter(s=>s.formedStar).length;
   const reverse=w.stepWorld(-200);const r=a.ACTIVE_STARS.filter(s=>s.formedStar).length;st.G.dead=false;
   return {forward,reverse,f,r,t:st.G.t,birth};
  });
  check(clock.forward===200&&clock.reverse===-200&&clock.f===1&&clock.r===0,'Delivered world steps cross birth in both directions');
  await phase(0);
  await click('[data-create-kind="4"]');
  // Leaving Create must always cancel the armed touch/click handler.
  await click('[data-ui-mode="observe"]');
  check(await page.evaluate(async()=>!(await import('/src/blackholes.js')).isBHPlacementMode()),'Leaving Create cancels gas placement');
  await click('[data-ui-mode="direct"]');
  await snap('controls');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
  const bounds=await page.locator('#bhPlacer').boundingBox();
  check(bounds.x>=0&&bounds.x+bounds.width<=viewport.width+1,'Create panel stays in viewport');
  await page.evaluate(()=>__gasRestart());await frames();
  check(await page.evaluate(async()=>(await import('/src/universe/nebulaeData.js')).NEBULAE.length===0),'Restart clears created gas and stars');
  await context.close();
 }
 assert.deepEqual(report.errors,[],'No runtime or shader errors');
 console.log('Gas creation, lifecycle, time controls, persistence, reset, desktop and mobile checks passed');
} finally {
 await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
 await browser.close();await server.close();
}
