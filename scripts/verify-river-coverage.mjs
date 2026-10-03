// Same production app/shaders on base and head. Test-only hooks control the
// clock/camera and read the existing GPU texture; no field/render replacement.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
const mobile=process.env.DEVICE==='mobile';
const root=resolve(process.env.BASE_ROOT||process.cwd());
const baseline=!!process.env.BASE_ROOT;
const out=resolve(process.env.ARTEMIS_EVIDENCE||'evidence/river-coverage');
await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),baseline,mobile,frames:[],checks:[],errors:[],omissions:['HYG background','resolved procedural field','tier-1 streaming'],reference:'Synthetic off-center Sun boundary crossing based on supplied photos; exact photographed camera pose is unknown.'};
const check=(ok,name)=>{report.checks.push({name,pass:!!ok});assert(ok,name);};
const save=()=>writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
const hook=`
export function coverageRead(){
 const px=new Float32Array(TEXW*4);
 renderer.readRenderTargetPixels(rtA,0,0,TEXW,1,px);
 const haloRadius=uniformsShared.uHalo?.value[2].x??smoothR;
 const sink=sinkVals[2],reach=Math.min(Math.max(sink*30,haloRadius*.02),Math.max(haloRadius*.22,sink*2));
 let owned=0,visible=0,finite=true,edgeSum=0,ambient=0,local=0;
 for(let i=0;i<TEXW;i++){
  const owner=Math.round(px[i*4+3])-1;
  const anchor=river.sourceRelativeHalos&&owner>=0?bodyVals[owner]:null;
  const x=px[i*4]+(anchor?anchor.x:-(smoothCenter.x-textureCenter.x)),y=px[i*4+1]+(anchor?anchor.y:-(smoothCenter.y-textureCenter.y)),z=px[i*4+2]+(anchor?anchor.z:-(smoothCenter.z-textureCenter.z));
  finite&&=Number.isFinite(x+y+z);
  if(owner<0)ambient++;if(Math.hypot(x,y,z)<smoothR*1.1)local++;
  if(Math.round(px[i*4+3])!==3)continue;
  owned++;
  let fade=Math.max(0,Math.min(1,1-(Math.hypot(x,y,z)-smoothR*.52)/(smoothR*.48)));
  if(uniformsShared.uHalo){const t=Math.min(1,Math.max(0,(Math.hypot(x-bodyVals[2].x,y-bodyVals[2].y,z-bodyVals[2].z)/reach-.8)/.45));fade=1-t*t*(3-2*t);}
  edgeSum+=fade;if(fade>.25)visible++;
 }
 return {finite,owned,visible,edgeSum,ambient,local,ratio:Math.hypot(bodyVals[2].x,bodyVals[2].y,bodyVals[2].z)/smoothR,haloRadius,reach,radius:smoothR,count:river.count,drawCount:river.drawCount,dt:river.dtVis,skipped:river.skippedCompute,phase:uniformsShared.uPhase.value};
}
export function coverageSourceRead(index){
 const px=new Float32Array(TEXW*TEXW*4);renderer.readRenderTargetPixels(rtA,0,0,TEXW,TEXW,px);
 let count=0,maxOffset=0;const sum=[0,0,0];
 for(let i=0;i<TEXW*TEXW;i++)if(Math.round(px[i*4+3])-1===index){
  count++;const q=[px[i*4],px[i*4+1],px[i*4+2]];
  if(!river.sourceRelativeHalos){q[0]-=bodyVals[index].x;q[1]-=bodyVals[index].y;q[2]-=bodyVals[index].z;}
  for(let j=0;j<3;j++)sum[j]+=q[j];maxOffset=Math.max(maxOffset,Math.hypot(...q));
 }
 return {count,maxOffset,centroid:sum.map(x=>x/Math.max(1,count)),source:[bodyVals[index].x+smoothCenter.x,bodyVals[index].y+smoothCenter.y,bodyVals[index].z+smoothCenter.z],frameVelocity:uniformsShared.uFrameVel.value.toArray(),skipped:river.skippedCompute};
}
`;
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'solar-coverage-qa',enforce:'pre',transform(source,id){
 if(id.split('?')[0].endsWith('/src/river.js'))return source+hook;
 if(!id.split('?')[0].endsWith('/src/main.js'))return;
 const token='const firstFrameT0 = perfStart();';assert.equal(source.split(token).length,2);
 return source.replace('renderer.setAnimationLoop(frame);','')
 .replace(token,'G.t=0;G.paused=true;G.gr=true;grB=1;resetEphem();clock.getDelta=()=>1/60;'+token)
 +'\nwindow.__coverageFrame=()=>{lastMobileFrame=-Infinity;frame();const gl=renderer.getContext();const px=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);};';
}}]});
let browser;
try{
 await server.listen();
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:mobile?{width:430,height:932}:{width:960,height:640},hasTouch:mobile,isMobile:mobile,deviceScaleFactor:1});page.setDefaultTimeout(180000);
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|Shader|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
 await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');Date.now=()=>Date.UTC(2026,9,4,12);});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=sun&dist=40000&pitch=0&yaw=1.5707963267948966&compile=0&field=0&realsky=0&tier1=0&hidehelp=1`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__coverageFrame);
 check(await page.evaluate(async mobile=>(await import('/src/scene.js')).renderQuality.mobile===mobile,mobile),'actual touch/desktop quality');
 const modes=baseline?[0]:[0,3852,-3852];
 const length=baseline?120:400;
 for(const warp of modes){
  await page.evaluate(async warp=>{const{G}=await import('/src/state.js');G.focus='free';G.paused=warp===0;G.warp=warp||1;},warp);
  for(let i=0;i<length;i++){
   const sample=await page.evaluate(async({i,length,warp})=>{
    const {cam,renderer,camera}=await import('/src/scene.js');const{sunCore}=await import('/src/bodies.js');const{G}=await import('/src/state.js');
    const p=i/(length-1),cycle=(1+Math.cos(p*Math.PI*2))/2;
    const dist=40000*(1+.25*Math.sin(p*Math.PI*2));
    const behind=180000*cycle;
    cam.tgt.copy(sunCore.position).add({x:.10*(dist+behind),y:0,z:behind});cam.dist=dist;cam.distTarget=null;cam.yaw=Math.PI/2;cam.pitch=0;
    window.__coverageFrame();
    const r=await import('/src/river.js');const sampled=r.coverageRead();
    return {...sampled,i,warp,simTime:G.t,screen:sunCore.position.clone().project(camera).toArray(),memory:{...renderer.info.memory,programs:renderer.info.programs.length},contextLost:renderer.getContext().isContextLost(),error:renderer.getContext().getError()};
   },{i,length,warp});
   report.frames.push(sample);
   if(i===0||i===Math.floor(length/2)||i===length-1){await page.screenshot({path:`${out}/${warp}-${i}.png`,timeout:180000});await save();}
   if(i%100===0)console.log('coverage',warp,i,sample.visible,sample.owned,sample.ratio);
  }
 }
 const frames=report.frames;
 check(frames.every(f=>f.finite&&!f.contextLost&&f.error===0),'finite live GPU samples on all frames');
 check(frames.every(f=>Math.abs(f.screen[0])<.8&&Math.abs(f.screen[1])<.1),'Sun remains visible off-center during all crossings');
 check(frames.every(f=>f.count===(mobile?9216:15376)),'fixed production particle budget');
 const outside=frames.filter(f=>f.ratio>1.4),inside=frames.filter(f=>f.ratio<.2);
 check(outside.length>10&&inside.length>10,'trajectory crosses both sides of old ambient boundary');
 const mean=arr=>arr.reduce((a,f)=>a+f.visible,0)/arr.length;
 report.visibility={outside:mean(outside),inside:mean(inside)};
 if(baseline)check(mean(outside)<mean(inside)*.15,'base reproduces missing off-center halo');
 else{
  check(frames.length===1200,'complete 1200-frame paused/forward/reverse sequence');
  check(mean(outside)>mean(inside)*.65,'halo support stays populated beyond old volume edge');
  check(frames.every(f=>f.visible>=12),'no blank halo frame throughout zoom/pan');
  for(const warp of modes){const group=frames.filter(f=>f.warp===warp);check(group.every(f=>warp===0||f.dt===0||Math.sign(f.dt)===Math.sign(warp)),`${warp}: advection follows requested time direction`);}
  const resources=frames.slice(50).map(f=>f.memory);
  check(resources.every(r=>r.textures===resources[0].textures&&r.geometries===resources[0].geometries),'no resource growth while crossing');
 }
 if(!baseline){
  // A displaced camera must not reserve most of its slots for invisible,
  // float32-quantized solar sources. Inspect actual local/ambient texels.
  report.far=await page.evaluate(async()=>{const{G}=await import('/src/state.js');const{cam}=await import('/src/scene.js');G.focus='free';G.paused=true;cam.tgt.set(1e16,1e16,1e16);cam.dist=1e4;cam.distTarget=null;window.__coverageFrame();return(await import('/src/river.js')).coverageRead();});
  check(report.far.finite&&report.far.ambient>=(mobile?96:124)*.95&&report.far.local>=(mobile?96:124)*.95,'far invisible sources release local sampling slots');
  for(const [focus,dist]of [['earth',15],['moon',8]]){
   await page.evaluate(async({focus,dist})=>{const{G}=await import('/src/state.js');const{cam}=await import('/src/scene.js');G.focus=focus;G.paused=true;cam.dist=dist;cam.distTarget=null;cam.yaw=-.4;cam.pitch=.5;}, {focus,dist});
   for(let j=0;j<24;j++)await page.evaluate(()=>window.__coverageFrame());
   await page.screenshot({path:`${out}/near-${focus}.png`,timeout:180000});
  }
  // Move a real rendered BH through 3D positions while the display compute
  // skips frames. Stored halo offsets must follow the mesh on every draw.
  report.blackHole=await page.evaluate(async()=>{
   const st=await import('/src/state.js'),bh=await import('/src/blackholes.js'),s=await import('/src/scene.js'),r=await import('/src/river.js'),b=await import('/src/bodies.js'),{PL,K}=await import('/src/constants.js');
   bh.clearBlackHoles();bh.addBlackHole(200000,0,30,1,2,true,null,0,0,300000,3);st.G.focus='free';st.G.paused=true;
   const earth=b.earthG.position.clone();const expected=s.cam.tgt.clone();
   const update=()=>{expected.set(earth.x+st.BH.sx[0],st.BH.sy[0],earth.z+st.BH.sz[0]);s.cam.tgt.copy(expected);s.cam.dist=40;s.cam.yaw=Math.PI/2;s.cam.pitch=0;s.applyCamera();bh.updateBHVisuals(1/60,earth.x,earth.z);r.updateRiver(1,1,earth,b.moon.position,b.sunCore.position,b.plGroups.map(p=>p.position),1/60);};
   update();for(let i=0;i<20;i++)update();
   const wasMobile=s.renderQuality.mobile;s.renderQuality.mobile=true;s.renderQuality.loadShed=2;
   const samples=[];
   for(let i=0;i<8;i++){
    st.BH.z[0]+=2000;st.BH.sy[0]=st.BH.z[0]*K;st.BH.x[0]+=1000;st.BH.sx[0]=st.BH.x[0]*K;
    r.river.computeEveryAdaptive=4;r.river.frame=0;update();s.renderSceneTiered(s.renderer,s.scene,s.camera);
    samples.push({...r.coverageSourceRead(3+PL.length),expected:expected.toArray(),mesh:bh.BH_META[0].g.position.toArray()});
   }
   s.renderQuality.mobile=wasMobile;s.renderQuality.loadShed=0;return samples;
  });
  check(report.blackHole.every(f=>f.count>20&&f.source.every((x,i)=>Math.abs(x-f.mesh[i])<1e-6)&&f.mesh.every((x,i)=>Math.abs(x-f.expected[i])<1e-6)),'moving 3D BH field, halo source and mesh stay co-located');
  check(report.blackHole.some(f=>f.skipped),'BH alignment covers retained/skipped compute frames');
  check(report.blackHole.every(f=>f.maxOffset<100),'owned BH samples remain local instead of leaving a stale displaced well');
  await page.screenshot({path:`${out}/moving-black-hole.png`,timeout:180000});
 }
 check(report.errors.length===0,'no shader/runtime errors');
}finally{await save();await browser?.close();await server.close();}
