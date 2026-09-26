// Same-observer/view/epoch evidence and ablation of output sampling vs ray steps.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(process.argv[2]||'.'), out=resolve(process.argv[3]||'evidence/motion');
const mode=process.env.MOTION_VARIANT||'after';
assert(['before','after','native','integration','reference'].includes(mode));
await mkdir(out,{recursive:true});
const report={mode,completed:false,epoch:0,exposure:.15,frames:[],checks:[],errors:[]};
const check=(name,pass)=>{report.checks.push({name,pass:!!pass});console.log(pass?'PASS':'FAIL',name)};
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
    name:'motion-regression-only',enforce:'pre',configureServer(s){s.middlewares.use((req,res,next)=>{
        if(!req.url.startsWith('/__motion_probe__'))return next();
        res.setHeader('Content-Type','text/html');res.end('<!doctype html><body style="margin:0;background:black"><div id="gl"></div></body>');
    })},transform(code,id){
        if(!id.endsWith('/src/render/galaxyVolume.js'))return;
        if(mode==='native'){
            assert(code.includes('DRAFT_INSIDE_SCALE = 0.5'),'Output ablation seam changed');
            return code.replace('DRAFT_INSIDE_SCALE = 0.5','DRAFT_INSIDE_SCALE = 1.0');
        }
        if(mode==='integration'){
            assert(code.includes('draft ? 0.055 : 0.03'),'Integration ablation seam changed');
            return code.replace('draft ? 0.055 : 0.03','0.03');
        }
    }
}]});
await server.listen();
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM||undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
    const page=await browser.newPage({viewport:{width:480,height:300},deviceScaleFactor:1});page.setDefaultTimeout(120000);
    page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))report.errors.push(m.text())});
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__motion_probe__?dpr=1&galadapt=0&galexposure=.15${mode==='reference'?'&galres=1':''}`);
    await page.evaluate(async()=>{
        const s=await import('/src/scene.js'),v=await import('/src/render/galaxyVolume.js'),c=await import('/src/universe/coords.js'),e=await import('/src/render/stellarAppearance.js');
        const {K}=await import('/src/constants.js');window.probe={s,v,c,e,K};
        s.renderQuality.mobile=false;s.renderer.setSize(480,300,false);s.camera.aspect=1.6;
        e.stellarExposure.value=.15;e.extragalacticExposure.blend=0;e.extragalacticExposure.stretch=0;
        const n=[],z=[];c.galToSceneUnitsInto(0,0,1,n,0,K);c.galToSceneUnitsInto(0,0,0,z,0,K);s.camera.up.set(...n.map((x,i)=>x-z[i])).normalize();
        window.pose=(p=[8178,0,20.8],fov=18,target=[0,0,200])=>{const a=[];c.galToSceneUnitsInto(...p,a,0,K);s.camera.position.set(...a);c.galToSceneUnitsInto(...target,a,0,K);s.camera.lookAt(...a);s.camera.fov=fov;s.camera.updateProjectionMatrix();s.camera.updateMatrixWorld();v.updateGalaxyVolume(s.camera,0)};
        window.draw=(capture=false)=>{
            const r=s.renderer,gl=r.getContext();v.updateGalaxyVolume(s.camera,0);r.setRenderTarget(null);r.autoClear=true;r.clear();const start=performance.now();v.renderGalaxyVolume(r);
            const f={stats:v.galaxyVolumeStats()};
            if(capture){
                const w=gl.drawingBufferWidth,h=gl.drawingBufferHeight,b=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,b);
                f.drawReadbackMs=performance.now()-start;let sum=0;for(let i=0;i<b.length;i+=4)sum+=b[i]+b[i+1]+b[i+2];f.mean=sum/(w*h*3);
                f.settings={width:w,height:h,dpr:r.getPixelRatio(),observer:s.camera.position.toArray(),quaternion:s.camera.quaternion.toArray(),projection:s.camera.projectionMatrix.toArray()};
                f.png=r.domElement.toDataURL('image/png');
            }return f;
        };pose();draw();
    });
    await page.waitForFunction(()=>probe.v.galaxyVolumeStats().mapsReady);await page.waitForTimeout(700);
    report.gpu=await page.evaluate(()=>{const gl=probe.s.renderer.getContext(),x=gl.getExtension('WEBGL_debug_renderer_info');return {renderer:x?gl.getParameter(x.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),browser:navigator.userAgent}});
    async function settle(){for(let i=0;i<100;i++){const f=await page.evaluate(()=>draw());if(!f.stats.draft&&f.stats.mapBlend===1)return;await page.waitForTimeout(60)}throw new Error('No settled image')}
    async function shot(name){const f=await page.evaluate(()=>draw(true));await writeFile(`${out}/${name}.png`,Buffer.from(f.png.split(',')[1],'base64'));delete f.png;report.frames.push({name,...f});check(name+': finite visible image',Number.isFinite(f.mean)&&f.mean>.05);if(mode==='after'&&f.stats.motion?.active)check(name+': bounded native rays',f.stats.motion.rayPixels<=f.stats.motion.rayBudget);await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));return f;}
    for(const [name,fov,target] of [['wide',48,[0,0,200]],['cygnus',30,[8178,3000,100]],['home',18,[0,0,200]]]){
        await page.evaluate(([f,t])=>pose([8178,0,20.8],f,t),[fov,target]);await settle();await shot(name);
    }
    for(let i=1;i<=8;i++){
        await page.evaluate(i=>pose([8178+i*.5,i*.8,20.8]),i);
        const f=await shot(`move-${String(i).padStart(2,'0')}`);check('Fresh translated rays '+i,f.stats.historyUsed===false);
    }
    await shot('stop-immediate');await settle();await shot('stop-settled');
    await page.evaluate(()=>pose());await settle();await shot('return');
    // Tiny stop/start movement and FOV-only changes are separate from translation.
    await page.evaluate(()=>pose([8178.001,.001,20.8]));await shot('small-start');
    for(const fov of [24,12,18]){await page.evaluate(f=>pose([8178.001,.001,20.8],f),fov);await shot(`fov-${fov}`)}
    // Invalid targets must never leave a hole, including changed aspect/DPR.
    for(const [w,h,dpr] of [[600,300,1],[300,500,1],[300,500,1.5],[480,300,1]]){
        await page.evaluate(([w,h,dpr])=>{const {s}=probe;s.renderer.setPixelRatio(dpr);s.renderer.setSize(w,h,false);s.camera.aspect=w/h;s.camera.updateProjectionMatrix()},[w,h,dpr]);
        await shot(`resize-${w}-${h}-${dpr}`);
    }
    check('No browser/shader errors',report.errors.length===0);
    assert(report.checks.every(c=>c.pass),JSON.stringify(report.checks.filter(c=>!c.pass)));
    report.completed=true;
} finally {
    report.timingMethod='Draw plus blocking default-framebuffer readPixels, excluding pixel statistics and PNG encoding. Software renderer wall time, not hardware GPU time or interactive FPS.';
    await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();
}
