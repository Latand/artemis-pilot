import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const device=process.env.DEVICE||'desktop',landscape=device==='landscape',mobile=device!=='desktop',out=process.env.ARTEMIS_EVIDENCE||'evidence/gravity-inspector';await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mobile,landscape,errors:[],checks:[],frames:[],omissions:['AT-HYG streaming','procedural resolved field','HYG background']};
const check=(pass,name)=>{report.checks.push({name,pass:!!pass});assert(pass,name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'inspector-qa',enforce:'pre',transform(source,id){
 if(id.split('?')[0].endsWith('/src/trails.js'))return source+'\nexport function inspectorQAPrediction(){return {shipPoints:prGeom.drawRange.count,bodyPoints:bpGeom.drawRange.count,bounded:boundedInspectionPrediction,focus:inspectionPredictionFocus}};';
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 const marker='const firstFrameT0 = perfStart();';assert.equal(source.split(marker).length,2);
 return source.replace(marker,'G.t=0;G.paused=true;resetEphem();clock.getDelta=()=>1/60;'+marker).replace('renderer.setAnimationLoop(frame);','')+'\nwindow.__inspectorFrame=()=>{clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;frame();renderer.getContext().finish();};window.__inspectorBodyLock=()=>lockedBodyTarget;';
}}]});await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:landscape?{width:568,height:320}:mobile?{width:430,height:932}:{width:1100,height:760},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});page.setDefaultTimeout(120000);
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');Date.now=()=>Date.UTC(2026,9,1,12);});
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|Shader|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=earth&dist=25&hidehelp=1&tier1=0&field=0&realsky=0&river=0&bloom=0&compile=0`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__inspectorFrame);
 const frames=async(n=2)=>{for(let i=0;i<n;i++)await page.evaluate(()=>__inspectorFrame());};
 const click=async(q)=>{if(mobile)await page.locator(q).tap();else await page.locator(q).click();await frames();};
 const capture=async name=>{await frames(3);await page.screenshot({path:`${out}/${device}-${name}.png`,timeout:180000});report.frames.push(name);await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log('CAPTURE',name);};
 await frames(3);check(await page.locator('#gravityInspector>summary').isVisible(),'Gravity control is reachable without opening object details');
 if(landscape){
  const box=await page.locator('#gravityInspector>summary').boundingBox();
  check(box&&box.height>=44&&box.y>=0&&box.y+box.height<=320,'Landscape collapsed Gravity summary has a reachable 44px target');
  await capture('landscape-collapsed');
 }
 const before=await page.evaluate(async()=>({focus:__G.focus,dist:(await import('/src/scene.js')).cam.dist}));
 await click('#gravityInspector>summary');
 check(await page.locator('#gravityInspector').evaluate(e=>e.open),'Inspector opens');
 check(await page.evaluate(async before=>__G.focus===before.focus&&(await import('/src/scene.js')).cam.dist===before.dist,before),'Opening inspector never changes selection or zoom');
 check((await page.locator('.gravityContributors li').count())>0,'Applied contributors appear');
 check((await page.locator('.gravityContributors').innerText()).includes('Sun'),'Sun is identified as an Earth contributor');
 const force=await page.evaluate(async()=>{const {getLocalGravityInspection}=await import('/src/gravityInspection.js');const s=getLocalGravityInspection(__G.focus);const net=[0,0,0];for(const r of s.contributions)r.acceleration.forEach((v,i)=>net[i]+=v);return{sum:net,net:s.net};});
 check(force.sum.every((v,i)=>Math.abs(v-force.net[i])<1e-15),'Displayed source ledger sums to the actual model acceleration');
 check(await page.evaluate(()=>document.querySelector('#gravityNetVector').parentElement===document.querySelector('#root')),'Scene arrow shares the UI stacking context and stays beneath panels');
 check(await page.locator('.gravityDirection').isVisible(),'Net row retains a visible screen-projected direction cue');
 check(await page.evaluate(()=>{const a=document.querySelector('#explorePanel').getBoundingClientRect(),b=document.querySelector('#timeDock').getBoundingClientRect();return a.right<=b.left||b.right<=a.left||a.bottom<=b.top||b.bottom<=a.top;}),'Expanded inspector and time dock do not overlap');
 await capture('earth-local');
 // At 25k km the world-XY Earth path is mostly off-screen. Capture it
 // at a useful scene scale without changing the selected body or physics.
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js');cam.dist=3000;cam.distTarget=null;});await frames(3);
 const prediction=await page.evaluate(async()=>{
  const {snapshotEphem}=await import('/src/ephemeris.js'),before=snapshotEphem();document.querySelector('.gravityPrediction').click();
  const {bodyCoastStatus}=await import('/src/trails.js');return{before,after:snapshotEphem(),status:{...bodyCoastStatus},predict:__G.predict};
 });
 check(prediction.predict&&prediction.status.bounded&&prediction.status.points>=16&&prediction.status.seconds>0,'Prediction uses a bounded integrated path');
 check(JSON.stringify(prediction.before)===JSON.stringify(prediction.after),'Prediction restores the live ephemeris exactly');
 await frames();await capture('short-coast');
 await page.evaluate(()=>{__G.focus='moon';});await frames();
 check(await page.locator('.gravityPrediction').getAttribute('aria-pressed')==='false','Changing selection never labels an old path as the new target prediction');
 await click('.gravityPrediction');
 check(await page.evaluate(async()=> (await import('/src/trails.js')).bodyCoastStatus.target===-2),'Prediction retargets to selected Moon');
 await click('.gravityPrediction');check(await page.evaluate(()=>!__G.predict),'Prediction can be turned off repeatedly');
 // Real input transitions: inspector Earth path must not leak into normal
 // Ship/Pilot prediction or retain the old Earth lock after P off/on.
 await page.evaluate(()=>{__G.focus='earth';});await frames();await click('.gravityPrediction');
 await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('0');await frames();
 await page.keyboard.press('p');await page.keyboard.press('p');await frames();
 const normalPrediction=await page.evaluate(async()=>({predict:__G.predict,focus:__G.focus,lock:__inspectorBodyLock(),...(await import('/src/trails.js')).inspectorQAPrediction()}));
 check(normalPrediction.predict&&normalPrediction.shipPoints>1&&!normalPrediction.bounded&&normalPrediction.bodyPoints===0&&normalPrediction.lock===-99,'Ship + P off/on restores normal path without stale inspector mode or body lock');
 await click('[data-ui-mode="pilot"]');await capture('pilot-prediction-restored');await click('[data-ui-mode="observe"]');
 await page.evaluate(async()=>{(await import('/src/input.js')).setFocus('earth');__G.predict=false;});await frames();
 await click('#gravityInspector>summary');await click('.gravityPrediction');
 check(await page.evaluate(async()=> (await import('/src/saves.js')).saveState()),'Save succeeds with an inspector coast active');
 await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('r');await page.evaluate(()=>{__G.paused=true;});await frames();
 check(await page.evaluate(async()=>{const s=(await import('/src/trails.js')).inspectorQAPrediction();return !s.bounded&&s.bodyPoints===0&&__inspectorBodyLock()===-99;}),'Ship reset clears the inspection session and stale body lock');
 await click('.gravityPrediction');
 check(await page.evaluate(async()=> (await import('/src/saves.js')).loadState()),'Quickload succeeds after another inspector coast');await frames();
 check(await page.evaluate(async()=>{const s=(await import('/src/trails.js')).inspectorQAPrediction();return !s.bounded&&s.bodyPoints===0&&__inspectorBodyLock()===-99;}),'Quickload clears the transient inspector session even for the same saved target');
 await page.evaluate(()=>{__G.predict=false;__G.focus='star:0';});await frames();
 check((await page.locator('.gravityNet').innerText()).includes('No complete applied-force'),'Catalog target is not given fabricated acceleration');
 check(await page.locator('.gravityPrediction').isHidden(),'Catalog target is not offered a fabricated forecast');
 await page.evaluate(()=>{__G.focus='earth';});await frames();
 if(mobile){await click('#explorePanelToggle');check(await page.locator('#gravityInspector').evaluate(e=>!e.open),'Object details close gravity inspector on compact screens');await click('#gravityInspector>summary');}
 // Camera zoom changes only display context, retaining the selected Earth.
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js'),{LY_KM,K}=await import('/src/constants.js');cam.dist=30000*LY_KM*K;cam.distTarget=null;cam.pitch=.8;});
 await frames(5);await page.waitForFunction(async()=> (await import('/src/render/galaxyPopulationRender.js')).galaxyPopulationStatus().ready);await frames(4);
 check(await page.locator('.gravityScope').innerText()==='Estimated','Galaxy scale is explicitly estimated');
 check(await page.evaluate(()=>__G.focus==='earth'),'Galaxy zoom retains the pinned object');
 check(await page.locator('.gravityPrediction').isHidden(),'No invented galaxy-wide forecast is offered');
 check((await page.locator('.gravityContributors').innerText()).includes('Andromeda'),'Neighboring galaxy replaces stellar-member clutter');
 const galaxyLedger=await page.evaluate(async()=>{const s=(await import('/src/gravityGalaxyInspection.js')).getGalaxyGravityInspection();return {ids:s.contributions.map(r=>r.id),count:s.contributions.length};});
 check(new Set(galaxyLedger.ids).size===galaxyLedger.count,'Local and distant aggregate cell identities remain distinct');
 check(await page.evaluate(()=>{const t=document.querySelector('.gravityTarget').getBoundingClientRect(),p=document.querySelector('#explorePanel').getBoundingClientRect();return t.top>=p.top&&t.bottom<=p.bottom;}),'Scale switch keeps its context heading visible');
 await capture('galaxy-context');
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js'),{LY_KM,K}=await import('/src/constants.js');cam.dist=3000000*LY_KM*K;cam.distTarget=null;});await capture('local-group');
 const hysteresis=await page.evaluate(async()=>{const {cam}=await import('/src/scene.js'),{LY_KM,K}=await import('/src/constants.js');const states=[];for(const d of [19000,21000,18000,13000]){cam.dist=d*LY_KM*K;cam.distTarget=null;__inspectorFrame();states.push(document.querySelector('.gravityScope').textContent);}return states;});
 check(JSON.stringify(hysteresis)===JSON.stringify(['Estimated','Estimated','Estimated','Local']),'Scale hysteresis avoids boundary flicker');
 // A numerical system exposes its actual local kicks with the prescribed
 // Galactic contribution excluded, rather than a made-up total acceleration.
 await page.evaluate(async()=>{const {addNebulaRecord}=await import('/src/universe/nebulaeData.js'),{GAS_RADIUS_KM}=await import('/src/universe/gasFormation.js'),{LY_KM,K}=await import('/src/constants.js'),{cam}=await import('/src/scene.js');addNebulaRecord({xKm:LY_KM*.5,yKm:0,zKm:0,radiusKm:GAS_RADIUS_KM,seed:2401,formation:{v:3,bornAtSec:0,massSolar:1,temperatureK:10}});__G.focus='neb:0';cam.dist=GAS_RADIUS_KM*K*4;cam.distTarget=null;});
 await frames(4);check((await page.locator('.gravityTarget').innerText()).includes('Local perturbation only'),'Gas model clearly separates local kicks from the Galactic guide');check(await page.locator('.gravityPrediction').isHidden(),'No coupled gas encounter forecast is invented');await capture('gas-local-kicks');
 await page.locator('#gravityInspector>summary').focus();await page.keyboard.press('Escape');await frames();check(await page.locator('#gravityInspector').evaluate(e=>!e.open),'Escape closes inspector');
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
 check(report.errors.length===0,'No runtime or shader errors');
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
