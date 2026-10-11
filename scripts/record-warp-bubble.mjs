// Frame-rendered demonstration of the warp sandbox seen only through the
// shared gravity river. Every speed change comes from real controls (the
// Warp button, X throttle, held Shift+W, A, S). Each frame advances exactly
// 1/30 s of simulation and is encoded at 30 fps. Playback is real time; it
// measures no frame rate. Optional sky layers are off to keep the software
// renderer tractable; the river, ship, stars and HUD readout are production.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync,writeFileSync,existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const out=process.env.ARTEMIS_EVIDENCE||'evidence/warp-video';mkdirSync(out,{recursive:true});
const np=process.env.ARTEMIS_NP?`&np=${process.env.ARTEMIS_NP}`:'';
const report={checks:[],errors:[],frames:[],note:'frame-rendered at 30 fps, 1/30 s simulation per frame; frame rate unmeasured'};
const check=(ok,name)=>{report.checks.push({name,pass:!!ok});assert(ok,name);};
const server=await createServer({logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'warp-qa',enforce:'pre',transform(s,id){
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 return s.replace('const firstFrameT0 = perfStart();','clock.getDelta=()=>1/30;const firstFrameT0 = perfStart();').replace('renderer.setAnimationLoop(frame);','')+
 '\nwindow.__warpFrame=()=>{lastMobileFrame=-Infinity;frame();renderer.getContext().finish();const r=window.__river;return {t:G.t,gr:G.gr,local:Math.hypot(G.vx,G.vy,G.vz),bubble:{speed:WARP.speed,phase:WARP.phase,dx:WARP.dx,dy:WARP.dy},'+
 'river:{visible:r.visible,presence:r.warpPresence,bubbleSpeed:r.bubbleSpeed,respawn:r.respawn,radius:r.radius,draw:r.drawCount},toShip:camera.position.distanceTo(shipG.position),craft:craft.visible,hullScale:craft.scale.x,'+
 'layers:["Alcubierre expansion and exotic-energy guide","Illustrative transition pulse front"].map(n=>scene.getObjectByName(n)).filter(Boolean).length};};';
}}]});await server.listen();
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1280,height:720}});page.setDefaultTimeout(300000);
 page.on('pageerror',e=>report.errors.push(e.message));
 page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('ERR_'))report.errors.push(m.text());});
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','pilot');});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?quality=balanced&dpr=1&focus=ship&dist=6&hidehelp=1&compile=0&tier1=0&realsky=0&galaxies=0&galaxyvol=0${np}`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__warpFrame);
 const frame=()=>page.evaluate(()=>__warpFrame());
 await page.evaluate(async()=>{const {cam}=await import('/src/scene.js'),{shipG}=await import('/src/ship.js');__G.warp=1;__G.heading=0;__G.pitch=0;__G.hold=null;__warpFrame();cam.tgt.copy(shipG.position);cam.dist=6;cam.yaw=2.3;cam.pitch=.4;});
 // Keep the real velocity readout; hide the rest of the navigation chrome.
 await page.addStyleTag({content:`#hudTL,#hudTR,#timeDock,#flowPanel,#navBall,#hint,#hintCard,#navBtn,#simsBtn,.lbl,.modeSwitcher,#uiModeControls,#renderQualityControls,#topBar,#modeBar,#toasts,#modeSwitch{display:none!important}
  #hudBot .cell:not(:has(#cVel)){display:none!important} #hudBot .cell:has(#cVel){min-width:300px} #cVel{font-size:26px!important}
  #rec{position:fixed;left:22px;top:20px;z-index:999;color:#cfe7f4;background:#08121ad9;border:1px solid #2e6478;border-radius:9px;padding:11px 15px;font:13px/1.55 monospace;white-space:pre-line;pointer-events:none;max-width:540px}
  #rec b{color:#fff;font-size:15px}`});
 await page.evaluate(()=>{const b=document.createElement('div');b.id='rec';document.body.appendChild(b);});
 const caption=()=>page.evaluate(async()=>{const {WARP}=await import('/src/warpBubble.js');const k=[...window.__keys].filter(c=>/Key[WASDX]|Shift/.test(c)).map(c=>c.replace('Key','').replace('Left','')).join('+')||'—';
  document.getElementById('rec').innerHTML='<b>ARTEMIS · warp sandbox through the gravity river</b>\nHypothetical Alcubierre shift field · no engine demonstrated\nCyan: space contracts ahead · magenta: expands behind · calm hull\nKeys held: '+k+' · mode: '+(WARP.enabled?WARP.phase:'local flight')+'\nFrame-rendered 30 fps (1/30 s per frame) · FPS unmeasured';});
 const video=spawn('ffmpeg',['-y','-loglevel','error','-f','image2pipe','-vcodec','mjpeg','-framerate','30','-i','pipe:0','-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',`${out}/warp-river.mp4`]);
 let fferr='';video.stderr.on('data',d=>fferr+=d);const finished=once(video,'close');
 const stills={0:'00-local-lines',70:'01-local-lines-before-warp',165:'02-ramp-subluminal',320:'04-high-superluminal',375:'05-turn',455:'06-system-view',535:'07-close-again',620:'08-braking',700:'09-braking-late',850:'10-after-stop'};
 let crossed=false;
 const states=[];
 try{
  await page.mouse.move(640,360);
  for(let i=0;i<=860;i++){
   if(i===75){await page.evaluate(()=>document.querySelector('[data-bubble-drive]').click());}
   if(i>=80&&i<85)await page.keyboard.press('x');
   if(i===90){await page.keyboard.down('Shift');await page.keyboard.down('w');}
   if(i===330){await page.keyboard.up('w');await page.keyboard.up('Shift');}
   if(i===360)await page.keyboard.down('a');
   if(i===390)await page.keyboard.up('a');
   // Real mouse-wheel zoom out to a system view and back in, during cruise.
   if(i>=390&&i<430)await page.mouse.wheel(0,250);
   if(i>=470&&i<510)await page.mouse.wheel(0,-250);
   if(i===540)await page.keyboard.down('s');
   if(i===820)await page.keyboard.up('s');
   const s=await frame();states.push(s);
   if(i%30===0)s.samples=await page.evaluate(async()=>{const g=(await import('/src/river.js')).riverDebugBubbleSamples();return g&&{near:g.near,ahead:g.ahead,behind:g.behind,ambient:g.ambient,owned:g.owned,finite:g.finite};});
   await caption();
   const jpg=await page.screenshot({type:'jpeg',quality:88});
   if(!video.stdin.write(jpg))await once(video.stdin,'drain');
   const name=stills[i]||(!crossed&&s.bubble.speed>299792.458?'03-through-c':null);if(name==='03-through-c')crossed=true;
   if(name){await page.screenshot({path:`${out}/${name}.png`});report.frames.push({frame:i,name,...s});}
  }
 }finally{video.stdin.end();}
 const [code]=await finished;check(code===0,`video encoding: ${fferr}`);
 const cruise=[...states.slice(200,390),...states.slice(525,540)];
 const system=states.slice(440,470);
 check(states.every(s=>s.layers===0),'no separate warp sphere or ring objects at any frame');
 check(states.every(s=>s.gr),'shared field lines stay on through the whole recording');
 check(states.some(s=>s.bubble.speed>299792.458*1e4),'held real input reaches over 10,000 c');
 check(cruise.every(s=>s.river.visible&&s.river.bubbleSpeed>0),'superluminal flight is drawn through the shared river');
 check(cruise.every(s=>s.river.respawn<.1),'no per-frame particle respawn while the camera moves superluminally');
 check(cruise.every(s=>s.craft&&Math.abs(s.toShip-6)<.3),'camera holds the visible hull');
 check(system.every(s=>s.toShip>1e4&&s.hullScale<=2.4+1e-9),'zoomed out, the hull stays bounded (marker view)');
 check(states.slice(385,520).every(s=>!(s.river.presence>0)||s.river.radius>=s.toShip),'the camera stays inside the sampled volume through the zoom');
 check(states.at(-1).bubble.speed<1,'real S input brakes the bubble to rest');
 check(states.every(s=>s.local<299792.458),'local velocity stays separate from bubble speed');
 check(report.errors.length===0,'recording has no browser or shader errors');
 report.samples=states.map((s,i)=>s.samples&&{frame:i,speedC:s.bubble.speed/299792.458,...s.samples}).filter(Boolean);
 check(report.samples.every(s=>s.finite),'GPU particle state stays finite');
 report.summary={frames:states.length,maxSpeedC:Math.max(...states.map(s=>s.bubble.speed))/299792.458,endSpeedKmS:states.at(-1).bubble.speed};
}finally{writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();}
