// Full application: named labels/sources/point buffers and reversible epochs.
// A supplementary GPU transform-feedback pass executes the production orbit
// GLSL and measures its far-field error against the canonical float64 kernel.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const root=resolve(process.argv[2]||'.'),out=resolve(process.argv[3]||'evidence/catalog-motion');
await mkdir(out,{recursive:true});
const report={revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),passed:false,errors:[],frames:[],checks:[],omissions:['AT-HYG network streaming (production tile renderer and motion shader tested with real decoded records separately)','procedural field and galaxy population; retained full HYG background, named point/mesh, labels, system rendering and galaxy volume']};
const check=(name,pass,details)=>{report.checks.push({name,pass:!!pass,details});assert(pass,name+': '+JSON.stringify(details));};
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'catalog-motion-qa',enforce:'pre',transform(code,id){
 if(!id.endsWith('/src/main.js'))return;
 assert(code.includes('renderer.setAnimationLoop(frame);'));
 return code.replace('renderer.setAnimationLoop(frame);','// QA: frames delivered explicitly')+`\nwindow.__catalogFrame=()=>{clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;frame();renderer.getContext().finish();};`;
}}]});await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:900,height:650},deviceScaleFactor:1});page.setDefaultTimeout(120000);
 page.on('pageerror',e=>report.errors.push(e.stack||e.message));page.on('console',m=>{if(m.type()==='error'&&/Shader|THREE|GL_INVALID|WebGL/.test(m.text()))report.errors.push(m.text());});
 await page.addInitScript(()=>{localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_uiMode','observe');localStorage.removeItem('ap_cam');});
 await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
 await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=sun&dist=1e11&dpr=1&tier1=0&field=0&galaxies=0&river=0&bloom=0&compile=0&hidehelp=1`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__AP_READY&&window.__catalogFrame);
 await page.evaluate(async()=>{
  const [s,c,state,a,m,f,r,e,p,input]=await Promise.all([import('/src/scene.js'),import('/src/constants.js'),import('/src/state.js'),import('/src/universe/activeStars.js'),import('/src/universe/catalogMotion.js'),import('/src/universe/galacticClock.js'),import('/src/render/catalogStars.js'),import('/src/universe/exploredSystem.js'),import('/src/universe/planetarySystem.js'),import('/src/input.js')]);
  window.qa={s,c,state,a,m,f,r,e,p,input};state.G.paused=true;state.G.dead=true;state.G.landed=null;
 });
 await page.waitForFunction(()=>qa.r.catalogStarsStatus().loaded);
 const run=async(name,years,focus='free',distLy=35)=>{
  const row=await page.evaluate(({years,focus,distLy})=>{
   const {s,c,state,a,m,f,e,p}=qa;state.setSimTime(years*c.SEC_YEAR);f.syncGalacticFrame(state.G.t);a.refreshActiveStars(0,0,0,focus,state.G.t,2e6*c.SEC_YEAR);
   state.G.focus=focus;s.cam.distTarget=null;s.cam.dist=distLy*c.LY_SCENE;s.cam.yaw=-.95;s.cam.pitch=.46;
   if(focus==='free')s.cam.tgt.set(0,0,0);else if(focus.startsWith('star:')){const st=c.STARS[Number(focus.slice(5))];s.cam.tgt.set(st.x*c.K,st.z*c.K,-st.y*c.K);}
   for(let i=0;i<4;i++)window.__catalogFrame();
   const st=c.STARS[0],sys=e.getExploredSystem('star:0',null,state.G.t),body=p.planetWorldState(sys,0,st,state.G.t,{});
   const point=s.scene.children.find(x=>x.name==='curated destinations'),slot=c.STARS.filter(x=>!x.bh).indexOf(st),v=point.geometry.attributes.position.array;
   return {years,star:[st.x,st.y,st.z],epoch:st.epochPosition,source:a.ACTIVE_STARS.includes(st),gravitySelected:a.GRAVITY_STARS.includes(st),systemId:sys.starId,planets:JSON.stringify(sys.planets),body:[body.x,body.y,body.z],point:[(v[slot*3]+point.position.x)/c.K,-(v[slot*3+2]+point.position.z)/c.K,(v[slot*3+1]+point.position.y)/c.K],labels:[...document.querySelectorAll('.starLabel')].filter(x=>getComputedStyle(x).display!=='none').map(x=>({text:x.textContent,left:x.style.left,top:x.style.top})),drawCalls:s.renderer.info.render.calls};
  },{years,focus,distLy});
  await page.screenshot({path:resolve(out,name+'.png')});report.frames.push({name,...row});await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));return row;
 };
 const zero=await run('01-epoch-neighbourhood',0);
 await run('02-one-myr-neighbourhood',1e6);
 await run('03-ten-myr-neighbourhood',1e7);
 const far=await run('04-541-myr-selected-host',541101036,'star:0',.00015);
 await run('05-reverse-one-myr',-1e6);
 const restored=await run('06-return-epoch',0);
 check('Epoch replay exact',JSON.stringify(zero.star)===JSON.stringify(restored.star));
 check('Selected system stable over 541 Myr',zero.systemId===far.systemId&&zero.planets===far.planets);
 check('Named stars visibly leave epoch coordinates',report.frames.slice(1,5).every(f=>Math.hypot(...f.star.map((x,i)=>x-zero.star[i]))>3e13));
 check('Point/source coherence',report.frames.every(f=>f.source&&Math.hypot(...f.point.map((x,i)=>x-f.star[i]))<Math.max(...f.star.map(Math.abs))*1e-7));
 const precision=await page.evaluate(async()=>{
  const {m,c}=qa, H=await import('/src/universe/hygActiveCatalog.js');
  const stars=[...c.STARS.filter(x=>!x.bh),H.hygStarByIndex(117953),H.hygStarByIndex(87)].filter(Boolean);
  const canvas=document.createElement('canvas'), gl=canvas.getContext('webgl2');
  const shader=(type,text)=>{const s=gl.createShader(type);gl.shaderSource(s,text);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
  const program=gl.createProgram();
  gl.attachShader(program,shader(gl.VERTEX_SHADER,'#version 300 es\nprecision highp float;\nin vec3 position;out vec3 computed;\n'+m.CATALOG_MOTION_GLSL.replaceAll('attribute ','in ')+'\nvoid main(){computed=catalogMotion(position)/'+(c.PC_KM*c.K).toFixed(6)+';gl_Position=vec4(0,0,0,1);}'));
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1);}'));
  gl.transformFeedbackVaryings(program,['computed'],gl.INTERLEAVED_ATTRIBS);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
  const records=stars.map(s=>m.catalogMotionFor(s));
  for(const [name,values] of [['position',records.flatMap(x=>[x.x*c.K,x.z*c.K,-x.y*c.K])],['catalogOrbit',records.flatMap(x=>[x.xp,x.yp,x.zp])]]){
   gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(values),gl.STATIC_DRAW);const a=gl.getAttribLocation(program,name);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,3,gl.FLOAT,false,0,0);
  }
  const result=gl.createBuffer();gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER,result);gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER,records.length*12,gl.DYNAMIC_READ);gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,result);
  const rows=[];
  for(const years of [0,1e6,541101036,-541101036,1e9]){
   const time=m.catalogEvalTime(years*c.SEC_YEAR);m.setCatalogMotionTime(time);
   gl.uniform1f(gl.getUniformLocation(program,'uCatalogMyr'),m.catalogMotionUniforms.uCatalogMyr.value);gl.uniform3fv(gl.getUniformLocation(program,'uCatalogSunDelta'),m.catalogMotionUniforms.uCatalogSunDelta.value);gl.uniform3fv(gl.getUniformLocation(program,'uCatalogOriginPc'),[0,0,0]);
   gl.enable(gl.RASTERIZER_DISCARD);gl.beginTransformFeedback(gl.POINTS);gl.drawArrays(gl.POINTS,0,records.length);gl.endTransformFeedback();gl.disable(gl.RASTERIZER_DISCARD);
   const data=new Float32Array(records.length*3);gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER,0,data);
   let maxErrorPc=0;records.forEach((r,i)=>{const p=m.catalogPositionAt(r,time);maxErrorPc=Math.max(maxErrorPc,Math.hypot(data[i*3]-p[0]/c.PC_KM,-data[i*3+2]-p[1]/c.PC_KM,data[i*3+1]-p[2]/c.PC_KM));});rows.push({years,maxErrorPc});
  }
  gl.getExtension('WEBGL_lose_context')?.loseContext();return rows;
 });report.gpuPrecision=precision;
 check('Shared GPU kernel agrees within 0.05 pc through a billion years',precision.every(r=>r.maxErrorPc<.05),precision);
 check('No browser/shader errors',report.errors.length===0,report.errors);
 report.passed=true;
} finally {await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));await browser.close();await server.close();}
