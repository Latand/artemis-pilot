// Production gas and stellar rendering. Test control only freezes the frame
// clock; no material, force law, numerical source or photosphere is replaced.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
const out=process.env.ARTEMIS_EVIDENCE||'evidence/gas-stellar';await mkdir(out,{recursive:true});
const mobile=process.env.DEVICE==='mobile';
const report={mobile,errors:[],checks:[],frames:[],omissions:['AT-HYG streaming','procedural field background','HYG sky background']};
const check=(value,name)=>{report.checks.push({name,pass:!!value});assert(value,name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'stellar-qa',enforce:'pre',transform(source,id){
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 const marker='const firstFrameT0 = perfStart();';assert.equal(source.split(marker).length,2);
 return source.replace(marker,'G.t=0;G.paused=true;G.gr=false;resetEphem();clock.getDelta=()=>1/60;'+marker)
 .replace('renderer.setAnimationLoop(frame);','')+'\nwindow.__stellarFrame=()=>{clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;frame();renderer.getContext().finish();};';
}}]});await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:mobile?{width:430,height:932}:{width:1280,height:800},isMobile:mobile,hasTouch:mobile,deviceScaleFactor:1});page.setDefaultTimeout(120000);
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');Date.now=()=>Date.UTC(2026,9,1,12);});
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error'&&/Shader|GL_INVALID|THREE/.test(m.text()))report.errors.push(m.text());});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?hidehelp=1&tier1=0&field=0&realsky=0&river=0&bloom=0&compile=0`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__stellarFrame);
 const frames=async(n=3)=>{for(let i=0;i<n;i++)await page.evaluate(()=>__stellarFrame());};
 const click=async(q)=>{if(mobile)await page.locator(q).tap();else await page.locator(q).click();await frames();};
 const save=async name=>{await frames(8);await page.screenshot({path:`${out}/${mobile?'mobile':'desktop'}-${name}.png`,timeout:180000});report.frames.push(name);console.log('CAPTURE',name);};
 await click('[data-ui-mode="direct"]');await click('[data-create-kind="4"]');
 await page.locator('#gasMass').fill('31');check(await page.locator('#gasRelease').isDisabled(),'Invalid mass cannot be released');
 await page.locator('#gasMass').fill('10');check(!(await page.locator('#gasRelease').isDisabled()),'Continuous mass input accepts 10 solar masses');
 await save('choose-mass');await click('#gasRelease');
 check(await page.evaluate(async()=>{const n=(await import('/src/universe/nebulaeData.js')).NEBULAE[0];return n.formation.massSolar===10&&__G.paused;}),'Release respects selected mass and pause');
 const evolve=async(phase)=>page.evaluate(async phase=>{
  const gas=await import('/src/universe/gasFormation.js'),{NEBULAE}=await import('/src/universe/nebulaeData.js'),{stepWorld}=await import('/src/worldStep.js');const n=NEBULAE[0];
  const initial=gas.gasNumericalView(n,0).a;
  __G.warp=(phase==='assembled'?1000:1e8)*31557600;
  let target=initial.unitTimeSec*3;
  if(phase!=='assembled'){
   const s=gas.gasStateAt(n,__G.t),assembly=gas.gasNumericalView(n,__G.t).a.sink.assembledAtSec;
   target=assembly+s.stellar.contractionSec+s.stellar.mainSequenceSec*(phase==='main-sequence'?.2:phase==='giant'?1.05:1.2);
  }
  let calls=0;while(Math.abs(target-__G.t)>Math.max(1,target*1e-12)&&calls++<3000)stepWorld(target-__G.t);
  __G.paused=true;const s=gas.gasStateAt(n,__G.t);return{calls,target,t:__G.t,phase:s.phase,assembled:s.assembled,mass:s.stellarMassSolar,ejecta:s.ejectedMassSolar,stellar:s.stellar};
 },phase);
 const assembled=await evolve('assembled');report.assembled=assembled;check(assembled.assembled&&assembled.calls<3000,'Numerical collapse fully assembles a protostar');
 await save('protostar-context');await click('#gasWatch');await save('protostar-close');
 for(const phase of ['main-sequence','giant','remnant']){
  const result=await evolve(phase);report[phase]=result;check(result.calls<3000,`${phase} shares actual delivered clock`);
  // Reframe the live physical radius through the actual inspect controls.
  await click('#gasWatch');await click('#gasWatch');await save(phase);
 }
 check(report.remnant.stellar.kind==='NS'&&Math.abs(report.remnant.mass+report.remnant.ejecta-10)<1e-11,'Ten solar masses yields a remnant with an explicit ejecta ledger');
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
 const precision=await page.evaluate(async()=>{const {cam,camera,scene}=await import('/src/scene.js');const {formedStarForNebula}=await import('/src/universe/nebulaeData.js');const s=formedStarForNebula(0,__G.t);const entries=[];scene.traverse(o=>{if(o.name.includes('photosphere')&&o.parent?.visible&&o.visible)entries.push(o.name);});return {camera:[camera.position.x,camera.position.y,camera.position.z],distance:cam.dist,R:s.R,entries};});report.visual=precision;
 check(precision.entries.some(x=>x.startsWith('PROTOSTAR')||x.startsWith('NEUTRON')),'Formed star uses actual photosphere geometry');
 check(report.errors.length===0,'No runtime or shader errors');
}finally{await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
