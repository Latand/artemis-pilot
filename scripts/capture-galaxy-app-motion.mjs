// Full application's frame path, not an isolated background or edited image.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root=resolve(process.argv[2]||'.'),out=resolve(process.argv[3]||'evidence/app-motion');
await mkdir(out,{recursive:true});
const report={completed:false,source:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),frames:[],errors:[]};
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
    name:'test-only-app-motion',enforce:'pre',transform(source,id){
        if(!id.endsWith('/src/main.js'))return;
        const marker='const firstFrameT0 = perfStart();';assert.equal(source.split(marker).length,2,'Initial frame seam changed');
        return source.replace(marker,'G.t=0; G.paused=true; resetEphem();\n'+marker)+'\nwindow.__captureAppFrame=frame; window.__captureRiverBlend=v=>{grB=v;};\n';
    }
}]});
await server.listen();
const browser=await chromium.launch({args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
    const page=await browser.newPage({viewport:{width:640,height:400},deviceScaleFactor:1});page.setDefaultTimeout(120000);
    page.on('pageerror',e=>report.errors.push(e.message));
    await page.addInitScript(()=>{Date.now=()=>Date.UTC(2026,8,13,12);localStorage.setItem('ap_introSeen','1')});
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?hidehelp=1&dpr=1&tier1=0&galadapt=0&focus=earth&dist=25&realsky=0&river=0&lens=0`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__AP_READY&&window.__captureAppFrame);
    await page.evaluate(async()=>{
        const s=await import('/src/scene.js'),b=await import('/src/bodies.js'),e=await import('/src/render/stellarAppearance.js'),c=await import('/src/universe/coords.js'),v=await import('/src/render/galaxyVolume.js');
        const {setPaused}=await import('/src/timeCtl.js');setPaused(true,'capture');s.renderer.setAnimationLoop(null);
        __G.predict=false;__G.gr=false;__G.uiMode='observe';__captureRiverBlend(0);
        Object.defineProperty(e.stellarExposure,'value',{configurable:true,get:()=>.15,set(){}});
        const p=[];c.galToSceneUnitsInto(0,0,0,p);const len=Math.hypot(...p);
        s.cam.yaw=Math.atan2(-p[2],-p[0]);s.cam.pitch=Math.asin(-p[1]/len);s.camera.fov=18;s.camera.updateProjectionMatrix();
        __G.focus='sun';s.cam.dist=1e7;s.cam.distTarget=null;s.cam.tgt.copy(b.sunCore.position);
        window.appTest={s,v,ship:[__G.x,__G.y,__G.z,__G.vx,__G.vy,__G.vz]};
    });
    await page.waitForFunction(()=>appTest.v.galaxyVolumeStats().mapsReady);
    async function settle(){for(let i=0;i<80;i++){const ok=await page.evaluate(()=>{__captureAppFrame();return !appTest.v.galaxyVolumeStats().draft});if(ok)return;await page.waitForTimeout(60)}throw new Error('Application view did not settle')}
    async function capture(name){
        const f=await page.evaluate(()=>{
            __captureAppFrame();const {s,v,ship}=appTest,gl=s.renderer.getContext();
            if(__G.t!==0||JSON.stringify(ship)!==JSON.stringify([__G.x,__G.y,__G.z,__G.vx,__G.vy,__G.vz]))throw new Error('Ship or epoch changed');
            return {png:s.renderer.domElement.toDataURL('image/png'),camera:{position:s.camera.position.toArray(),quaternion:s.camera.quaternion.toArray(),projection:s.camera.projectionMatrix.toArray()},time:__G.t,ship,dpr:s.renderer.getPixelRatio(),size:[gl.drawingBufferWidth,gl.drawingBufferHeight],volume:v.galaxyVolumeStats()};
        });
        await writeFile(`${out}/${name}.png`,Buffer.from(f.png.split(',')[1],'base64'));delete f.png;report.frames.push({name,...f});
        await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));return f;
    }
    await settle();await capture('app-start');
    for(let i=1;i<=8;i++){
        await page.evaluate(i=>{appTest.s.cam.dist=1e7*(1+i*.02);appTest.s.cam.distTarget=null},i);
        const f=await capture(`app-move-${String(i).padStart(2,'0')}`);
        assert(f.volume.draft&&!f.volume.historyUsed,'Moving application must show fresh draft, not settled history');
    }
    await settle();await capture('app-stop');
    await page.evaluate(()=>{appTest.s.cam.dist=1e7;appTest.s.cam.distTarget=null});await settle();await capture('app-return');
    assert(report.errors.length===0,JSON.stringify(report.errors));report.completed=true;
} finally {await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close()}
