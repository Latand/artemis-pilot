import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync,writeFileSync,existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const mobile=false,out=process.env.ARTEMIS_EVIDENCE||'evidence/warp';mkdirSync(out,{recursive:true});
const report={device:mobile?'mobile':'desktop',checks:[],errors:[],frames:[]};
const check=(ok,name)=>{report.checks.push({name,pass:!!ok});assert(ok,name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'warp-qa',enforce:'pre',transform(s,id){
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 return s.replace('const firstFrameT0 = perfStart();','clock.getDelta=()=>1/30;const firstFrameT0 = perfStart();').replace('renderer.setAnimationLoop(frame);','')+
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
 await page.locator('[data-bubble-drive]:visible').first().click();
 await page.evaluate(()=>document.activeElement?.blur());
 // Keep the real renderer and ship camera; remove crowded navigation chrome
 // from this recording only. The badge is populated from actual simulation state.
 await page.addStyleTag({content:`#hudTL,#hudTR,#hudBot,#timeDock,#flowPanel,#navBall,#hint,#navBtn,#simsBtn,.lbl,.modeSwitcher,#uiModeControls {display:none!important} #warpCaptureBadge{position:fixed;left:24px;top:24px;z-index:999;color:#cceaf8;background:#09141ce8;border:1px solid #2e6478;border-radius:10px;padding:14px 18px;font:15px/1.6 monospace;white-space:pre-line;pointer-events:none}`});
 await page.evaluate(()=>{const b=document.createElement('div');b.id='warpCaptureBadge';document.body.appendChild(b);});
 // Five real X presses raise the existing throttle, then hold W+Shift.
 for(let i=0;i<5;i++)await page.keyboard.press('x');
 const video=spawn('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-vcodec','mjpeg','-framerate','30','-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','22','-pix_fmt','yuv420p','-movflags','+faststart',`${out}/warp-acceleration.mp4`]);
 let fferr='';video.stderr.on('data',d=>fferr+=d);const finished=once(video,'close');
 let final;
 try {
  for(let i=0;i<900;i++){
   if(i===30){await page.keyboard.down('Shift');await page.keyboard.down('w');}
   if(i===450){await page.keyboard.up('w');await page.keyboard.up('Shift');}
   if(i===540)await page.keyboard.down('s');
   if(i===870)await page.keyboard.up('s');
   final=await frame();
   await page.evaluate(async index=>{const {WARP,warpSpeedLabel}=await import('/src/warpBubble.js');document.getElementById('warpCaptureBadge').textContent='ARTEMIS · HYPOTHETICAL ALCUBIERRE MODEL\n'+warpSpeedLabel(WARP.speed)+' · '+WARP.phase+'\nCyan: contraction · pink: expansion\nAnalytic guide · prescribed trajectory\nFrame-rendered demonstration / 30 fps';},i);
   const jpg=await page.screenshot({type:'jpeg',quality:82});
   if(!video.stdin.write(jpg))await once(video.stdin,'drain');
   if([29,210,420,539,720,899].includes(i)){await page.screenshot({path:`${out}/video-${i}.png`});report.frames.push({frame:i,...final});}
  }
 }finally{video.stdin.end();}
 const [code]=await finished;check(code===0,`video encoding: ${fferr}`);
 check(report.frames.some(f=>f.bubble.speed>299792.458),'recording crosses light speed through held production input');
 check(final.bubble.speed<1,'recording ends after braking');
 check(report.errors.length===0,'recording has no browser or shader errors');
}finally{writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
