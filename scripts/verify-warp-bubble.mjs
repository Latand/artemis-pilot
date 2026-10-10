import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync,writeFileSync,existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const mobile=process.env.DEVICE==='mobile',out=process.env.ARTEMIS_EVIDENCE||'evidence/warp';mkdirSync(out,{recursive:true});
const report={device:mobile?'mobile':'desktop',checks:[],errors:[],frames:[]};
const check=(ok,name)=>{report.checks.push({name,pass:!!ok});assert(ok,name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'warp-qa',enforce:'pre',transform(s,id){
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 return s.replace('const firstFrameT0 = perfStart();','clock.getDelta=()=>1/60;const firstFrameT0 = perfStart();').replace('renderer.setAnimationLoop(frame);','')+
 '\nwindow.__warpFrame=()=>{lastMobileFrame=-Infinity;frame();renderer.getContext().finish();return {t:G.t,x:G.x,y:G.y,z:G.z,v:[G.vx,G.vy,G.vz],bubble:{...WARP},quality:{...renderQuality},visible:shipG.getObjectByName("Alcubierre expansion and exotic-energy guide")?.visible===true, memory:{...renderer.info.memory},programs:renderer.info.programs.length};};';
}}]});await server.listen();
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:mobile?{width:430,height:932}:{width:1280,height:820},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(180000);
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('ERR_'))report.errors.push(m.text());});
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','pilot');});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?quality=low&focus=ship&dist=.14&hidehelp=1&compile=0&tier1=0&field=0&realsky=0&galaxies=0&galaxyvol=0`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__warpFrame);
 const frame=()=>page.evaluate(()=>__warpFrame());
 const frames=async n=>{let s;for(let i=0;i<n;i++)s=await frame();return s;};
 const capture=async name=>{const s=await frames(2);await page.screenshot({path:`${out}/${name}.png`});report.frames.push({name,...s});return s;};
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js'),{shipG}=await import('/src/ship.js');__G.warp=1;__G.heading=0;__G.pitch=0;__G.hold=null;__warpFrame();cam.tgt.copy(shipG.position);cam.dist=.14;cam.yaw=.85;cam.pitch=.36;});
 if(mobile)await page.locator('#mMenuBtn').click();
 const button=page.locator('[data-bubble-drive]:visible').first();check(await button.isVisible(),'warp control accessible');await button.click();
 if(mobile)await page.locator('#mMenuClose').click();await page.evaluate(()=>document.activeElement?.blur());
 let s=await frames(6);check(s.bubble.enabled&&s.bubble.speed===0,'real UI enables ready state');
 await page.keyboard.down('w');s=await frames(35);await page.keyboard.up('w');check(s.bubble.speed>0&&s.visible,'held input ramps and shows metric envelope');
 await capture('01-ramp');
 // A long analytically tested ramp is seeded to avoid thousands of software
 // GPU frames; all subsequent transport, rendering and controls are production.
 await page.evaluate(async()=>{const {WARP,stepWarp}=await import('/src/warpBubble.js');for(let i=0;i<1800;i++)stepWarp(WARP,1,1,false,1/60);});
 s=await capture('02-superluminal-cruise');check(s.bubble.speed>299792.458&&s.visible,'superluminal coordinate travel remains visible');check(Math.hypot(...s.v)<299792.458,'bubble speed is separate from local velocity');
 const before=s;await page.keyboard.down('s');s=await frames(35);await page.keyboard.up('s');check(s.bubble.speed<before.bubble.speed,'actual S input brakes');await capture('03-braking');
 await page.evaluate(()=>{__G.paused=true;});const paused=await frames(2);s=await frames(4);check(s.x===paused.x&&s.y===paused.y&&s.z===paused.z&&s.bubble.speed===paused.bubble.speed,'pause freezes transport and ramp');
 await page.evaluate(()=>{__G.paused=false;});
 if(mobile)await page.locator('#mMenuBtn').click();await page.locator('[data-bubble-stop]:visible').first().click();if(mobile)await page.locator('#mMenuClose').click();
 s=await frames(2);check(s.bubble.speed===0,'visible emergency control collapses bubble');
 const mem=s.memory,programs=s.programs;
 for(let i=0;i<6;i++){await page.evaluate(()=>document.querySelector('[data-bubble-drive]').click());await frames(2);}
 s=await frame();check(JSON.stringify(s.memory)===JSON.stringify(mem)&&s.programs===programs,'repeated toggle does not allocate render resources');
 await page.evaluate(async()=>{const {WARP}=await import('/src/warpBubble.js');WARP.enabled=true;WARP.logSpeed=5;WARP.speed=Math.expm1(5);__G.warp=-1;});s=await frames(2);check(s.bubble.speed===0,'reverse time disconnects bubble');
 await page.evaluate(async()=>{__G.warp=1;const {saveState,loadState}=await import('/src/saves.js');saveState();await loadState();});s=await frame();check(!s.bubble.enabled&&s.bubble.speed===0,'save load resumes without stale warp command');
 await capture('04-local-flight');check(report.errors.length===0,'no browser or shader errors');
}finally{writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
