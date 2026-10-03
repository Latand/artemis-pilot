// Bounded renderer-policy diagnostic, not an acceptance/performance gate.
// Identical frozen source records, clock, camera, rate and particle counts;
// production field/shaders are untouched. Six bounded transient cases, 20 delivered frames each; not equilibrium.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const roots=process.argv.slice(2,5).map(x=>resolve(x)),out=resolve(process.argv[5]||'evidence/proxima-policy');
const fixture=JSON.parse(await readFile(new URL('./proxima-fixture.json',import.meta.url),'utf8'));
const report={purpose:'Fixed Proxima source-allocation/ink diagnosis;20-frame transient, not equilibrium; no acceptance or performance claim',fixture,cases:[],checks:[],errors:[]};
await mkdir(out,{recursive:true});
const readHook=`\nwindow.__proximaRead=()=>{
 const texels=new Float32Array(TEXW*TEXW*4);renderer.readRenderTargetPixels(rtA,0,0,TEXW,TEXW,texels);
 const counts=new Array(uniformsShared.uSinkNB.value).fill(0);let ambient=0,invalidOwners=0;const finite=texels.every(Number.isFinite);
 for(let i=0;i<TEXW*TEXW;i++){const owner=Math.round(texels[i*4+3])-1;if(owner<0)ambient++;else if(owner<counts.length)counts[owner]++;else invalidOwners++;}
 const sources=bodyVals.slice(0,uniformsShared.uSinkNB.value).map((b,i)=>({index:i,
  name:i>=riverStarUniformOffset?(riverStarPickRefs[i-riverStarUniformOffset]?.id||riverStarPickRefs[i-riverStarUniformOffset]?.name):['Earth','Moon','Sun',...PL.map(p=>p.name)][i],
  position:[b.x+smoothCenter.x,b.y+smoothCenter.y,b.z+smoothCenter.z],coefficient:b.w,sink:sinkVals[i],soi:soiVals[i],hole:holeVals[i],owners:counts[i],
  halo:uniformsShared.uHalo?.value[i]?.toArray()||null,cdfShare:uniformsShared.uHalo?uniformsShared.uHalo.value[i].z-(i?uniformsShared.uHalo.value[i-1].z:0):null}));
 return {sources,ambient,finite,invalidOwners,readError:renderer.getContext().getError(),particleCount:river.count,drawCount:river.drawCount,frame:river.frame,style:river.style,dtVis:river.dtVis,
  localFocus:uniformsShared.uLocalFocus.value,timeRate:uniformsShared.uTimeRate.value,opacity:uniformsShared.uOpacity.value,phase:uniformsShared.uPhase.value,
  frameVelocity:uniformsShared.uFrameVel.value.toArray(),frameWeight:uniformsShared.uFrameW.value,center:smoothCenter.toArray(),radius:smoothR,
  sourceRelative:!!river.sourceRelativeHalos,hiddenGain:river.presentationGain??1};};`;
const browser=process.argv.includes('--validate')?null:await chromium.launch({args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 for(let ri=0;ri<roots.length;ri++){
  const root=roots[ri],revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const transform=(code,id)=>{
   id=id.split('?')[0];
   if(id.endsWith('/src/render/catalogStars.js'))return code.replace('const start = () => loadTier0();','const start = () => {};');
   if(id.endsWith('/src/river.js')){
    const re=/export function updateRiver\([^\n]+\) \{/;assert(re.test(code),'Known updateRiver hook');
    return code.replace(re,m=>m+'\nif(window.__proximaFixture){ACTIVE_STARS.splice(0,ACTIVE_STARS.length,...window.__proximaFixture.sources);dtSim=window.__proximaFixture.advance;}')+readHook;
   }
   if(!id.endsWith('/src/main.js'))return;
   assert(code.includes('renderer.setAnimationLoop(frame);'));
   const first='const firstFrameT0 = perfStart();';assert.equal(code.split(first).length,2);
   code=code.replace(first,'G.t=0;G.paused=true;G.dead=true;G.observerMode=true;G.gr=true;G.warp=1;grB=1;clock.getDelta=()=>1/60;'+first);
   return code.replace('renderer.setAnimationLoop(frame);','// Diagnostic frames delivered explicitly')+'\nwindow.__proximaFrame=()=>{clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;grB=1;frame();renderer.getContext().finish();};';
  };
  for(const p of ['src/main.js','src/river.js','src/render/catalogStars.js'])execFileSync(process.execPath,['--input-type=module','--check'],{input:transform(await readFile(resolve(root,p),'utf8'),'/'+p)});
  const source=await readFile(resolve(root,'src/river.js'),'utf8');
  const ink=source.slice(source.indexOf('// Halo ink recedes'),source.indexOf('const LINE_FRAG'));
  const inkHash=createHash('sha256').update(ink).digest('hex');
  if(!browser){console.log({root,revision,hooks:'valid',inkHash});continue;}
  const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'fixed-proxima-policy',enforce:'pre',transform}]});await server.listen();
  try{for(const rate of [0,1e6]){
   const name=['48','54','55'][ri]+'-'+(rate?'high-rate':'paused'),page=await browser.newPage({viewport:{width:900,height:650},deviceScaleFactor:1});page.setDefaultTimeout(120000);
   page.on('pageerror',e=>report.errors.push({name,error:e.stack||e.message}));
   page.on('console',m=>{if(m.type()==='error'&&/shader|THREE|GL_INVALID|WebGL/i.test(m.text()))report.errors.push({name,error:m.text()});});
   await page.addInitScript(()=>{Date.now=()=>Date.UTC(2026,9,3,12);localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','observe');localStorage.removeItem('ap_cam');});
   await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
   await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/?focus=sun&dist=1e11&dpr=1&tier1=0&field=0&galaxy=0&galaxyvol=0&galaxies=0&river=1&bloom=0&compile=0&hidehelp=1',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.__AP_READY&&window.__proximaFrame&&window.__proximaRead);
   await page.evaluate(async({fixture,rate})=>{
    const [s,c,state,a]=await Promise.all([import('/src/scene.js'),import('/src/constants.js'),import('/src/state.js'),import('/src/universe/activeStars.js')]);
    window.proximaQA={s,c,state,a};window.__proximaFixture={...fixture,advance:rate*c.SEC_YEAR/60};
    state.setSimTime(fixture.time);Object.assign(state.G,{paused:true,dead:true,observerMode:true,landed:null,gr:true,focus:'star:0',warp:rate?rate*c.SEC_YEAR:1});
    for(const r of fixture.curated){const star=c.STARS.find(s=>s.name===r.name);if(star)Object.assign(star,{x:r.x,y:r.y,z:r.z});}
    const host=fixture.sources.find(s=>s.name==='PROXIMA');s.cam.distTarget=null;s.cam.dist=fixture.distLy*c.LY_SCENE;s.cam.yaw=fixture.yaw;s.cam.pitch=fixture.pitch;s.cam.tgt.set(host.x*c.K,host.z*c.K,-host.y*c.K);
   },{fixture,rate});
   for(let i=0;i<19;i++)await page.evaluate(()=>window.__proximaFrame());
   const capture=await page.evaluate(()=>{
    const q=proximaQA;window.__proximaFrame();const state=window.__proximaRead(),gl=q.s.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight,px=new Uint8Array(w*h*4);
    gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px);
    const rect=element=>{if(!element)return null;const r=element.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};};
    const label=[...document.querySelectorAll('.starLbl')].find(x=>x.textContent==='PROXIMA'&&getComputedStyle(x).display!=='none');
    const hint=[...document.querySelectorAll('span')].find(x=>x.textContent.startsWith('Drag to look'));
    const saturated=(x,y)=>{const i=((h-1-y)*w+x)*4;return px[i]>=245&&px[i+1]>=245&&px[i+2]>=245;};
    const overlap=r=>{if(!r)return null;let count=0,total=0;for(let y=Math.max(0,Math.floor(r.y));y<Math.min(h,Math.ceil(r.y+r.h));y++)for(let x=Math.max(0,Math.floor(r.x));x<Math.min(w,Math.ceil(r.x+r.w));x++){total++;if(saturated(x,y))count++;}return{rect:r,saturatedPixels:count,pixels:total,fraction:count/Math.max(1,total)};};
    let count=0,minX=w,minY=h,maxX=-1,maxY=-1;for(let y=125;y<525;y++)for(let x=250;x<650;x++)if(saturated(x,y)){count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    return {time:q.state.G.t,camera:q.s.camera.position.toArray(),cameraQuaternion:q.s.camera.quaternion.toArray(),target:q.s.cam.tgt.toArray(),width:w,height:h,state,contextLost:gl.isContextLost(),glError:gl.getError(),
     saturated:{pixels:count,bounds:[minX,minY,maxX,maxY]},label:overlap(rect(label)),hint:overlap(rect(hint)),png:q.s.renderer.domElement.toDataURL('image/png')};
   });
   const {png,...row}=capture;await writeFile(resolve(out,name+'-canvas.png'),Buffer.from(png.split(',')[1],'base64'));await page.screenshot({path:resolve(out,name+'-ui.png')});
   report.cases.push({name,revision,rate,inkHash,...row});
   report.checks.push({name:name+' valid GPU readback and owner accounting',pass:!row.contextLost&&row.glError===0&&row.state.readError===0&&row.state.finite&&row.state.invalidOwners===0&&row.state.ambient+row.state.sources.reduce((n,s)=>n+s.owners,0)===row.state.particleCount&&row.state.sources.some(s=>s.name==='PROXIMA'&&s.owners>0)});await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));await page.close();
  }}finally{await server.close();}
 }
 if(browser){
  for(const rate of [0,1e6]){
   const rows=report.cases.filter(c=>c.rate===rate),base=rows[0];
   for(const row of rows.slice(1)){
    const physical=c=>({time:c.time,camera:c.camera,cameraQuaternion:c.cameraQuaternion,target:c.target,count:c.state.particleCount,drawCount:c.state.drawCount,frame:c.state.frame,center:c.state.center,radius:c.state.radius,hiddenGain:c.state.hiddenGain,style:c.state.style,dtVis:c.state.dtVis,localFocus:c.state.localFocus,timeRate:c.state.timeRate,opacity:c.state.opacity,phase:c.state.phase,frameVelocity:c.state.frameVelocity,frameWeight:c.state.frameWeight,sources:c.state.sources.map(({name,position,coefficient,sink,soi,hole})=>({name,position,coefficient,sink,soi,hole}))});
    const matched=JSON.stringify(physical(base))===JSON.stringify(physical(row));report.checks.push({name:'Identical field/camera/count/rate '+base.name+' vs '+row.name,pass:matched,mismatches:Object.keys(physical(base)).filter(k=>JSON.stringify(physical(base)[k])!==JSON.stringify(physical(row)[k])).map(k=>({field:k,baseline:physical(base)[k],candidate:physical(row)[k]}))});
   }
  }
  report.checks.push({name:'Inherited focus/high-warp ink code identical',pass:new Set(report.cases.map(c=>c.inkHash)).size===1});
  report.checks.push({name:'No browser errors',pass:report.errors.length===0});
  await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));assert(report.checks.every(c=>c.pass),JSON.stringify(report.checks));
 }
}catch(error){report.errors.push({error:error.stack||String(error)});await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));throw error;}finally{await browser?.close();}
