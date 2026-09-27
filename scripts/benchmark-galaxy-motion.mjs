// Paired common-context timing of the actual production ray shader. The step
// setter exists only in this test server, never in the shipped application.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root=resolve(process.argv[2]||'.'),out=resolve(process.argv[3]||'evidence/cost');
await mkdir(out,{recursive:true});
const report={completed:false,source:execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),pairs:[],errors:[],checks:[]};
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{
    name:'test-only-paired-ray-cost',enforce:'pre',configureServer(s){s.middlewares.use((req,res,next)=>{
        if(!req.url.startsWith('/__cost_probe__'))return next();
        res.setHeader('Content-Type','text/html');res.end('<!doctype html><body style="margin:0"><div id="gl"></div></body>');
    })},transform(code,id){
        if(!id.endsWith('/src/render/galaxyVolume.js'))return;
        const marker='const DRAFT_STEP_K = 0.04, SETTLED_STEP_K = 0.03;';
        assert.equal(code.split(marker).length,2,'Benchmark setter seam changed');
        return code.replace(marker,'let DRAFT_STEP_K = 0.04; const SETTLED_STEP_K = 0.03;')+`
export function __benchmarkMotionStep(step) {
    if (step !== 0.04 && step !== 0.055) throw new Error('Unexpected benchmark step');
    DRAFT_STEP_K = step; state.dirty = true; state.history = null;
}`;
    }
}]});
await server.listen();
const browser=await chromium.launch({args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
    const page=await browser.newPage({viewport:{width:480,height:300},deviceScaleFactor:1});page.setDefaultTimeout(120000);
    page.on('pageerror',e=>report.errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon'))report.errors.push(m.text())});
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__cost_probe__?dpr=1&galadapt=0&galexposure=.15`);
    await page.evaluate(async()=>{
        const s=await import('/src/scene.js'),v=await import('/src/render/galaxyVolume.js'),c=await import('/src/universe/coords.js'),e=await import('/src/render/stellarAppearance.js');
        const {K}=await import('/src/constants.js');window.probe={s,v,c,e,K};
        s.renderQuality.mobile=false;s.renderer.setSize(480,300,false);s.camera.aspect=1.6;s.camera.fov=18;
        e.stellarExposure.value=.15;e.extragalacticExposure.blend=0;e.extragalacticExposure.stretch=0;
        const n=[],z=[];c.galToSceneUnitsInto(0,0,1,n,0,K);c.galToSceneUnitsInto(0,0,0,z,0,K);s.camera.up.set(...n.map((x,i)=>x-z[i])).normalize();
        const gl=s.renderer.getContext(),bytes=new Uint8Array(480*300*4);
        window.drawCost=(step,index)=>{
            const a=[],p=[8178+index*.5,index*.8,20.8];c.galToSceneUnitsInto(...p,a,0,K);s.camera.position.set(...a);
            c.galToSceneUnitsInto(0,0,200,a,0,K);s.camera.lookAt(...a);s.camera.updateProjectionMatrix();s.camera.updateMatrixWorld();
            v.__benchmarkMotionStep(step);v.updateGalaxyVolume(s.camera,0);
            s.renderer.setRenderTarget(null);s.renderer.autoClear=true;s.renderer.clear();
            const start=performance.now();v.renderGalaxyVolume(s.renderer);gl.readPixels(0,0,480,300,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
            const ms=performance.now()-start;
            let checksum=0;for(let i=0;i<bytes.length;i++)checksum=(Math.imul(checksum,31)+bytes[i])>>>0;
            return {step,index,ms,checksum,stats:v.galaxyVolumeStats()};
        };drawCost(.055,0);
    });
    await page.waitForFunction(()=>probe.v.galaxyVolumeStats().mapsReady);await page.waitForTimeout(800);
    report.gpu=await page.evaluate(()=>{const gl=probe.s.renderer.getContext(),x=gl.getExtension('WEBGL_debug_renderer_info');return {renderer:x?gl.getParameter(x.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),browser:navigator.userAgent}});
    // Warm both step values, drain each frame with readback; none enters timings.
    for(const step of [.055,.04,.04,.055])await page.evaluate(step=>drawCost(step,0),step);
    for(let index=1;index<=8;index++){
        const pair={index,order:index%2?[.055,.04]:[.04,.055],samples:[]};
        for(const step of pair.order)pair.samples.push(await page.evaluate(([s,i])=>drawCost(s,i),[step,index]));
        const [a,b]=pair.samples;
        assert(a.stats.draft&&b.stats.draft&&!a.stats.historyUsed&&!b.stats.historyUsed);
        assert(a.stats.integrationStep===a.step&&b.stats.integrationStep===b.step);
        assert(a.stats.targetBytes===b.stats.targetBytes&&JSON.stringify(a.stats.res)===JSON.stringify(b.stats.res));
        report.pairs.push(pair);console.log('PAIRED COST',JSON.stringify(pair.samples.map(x=>({step:x.step,ms:x.ms}))));
    }
    function summarize(step){const a=report.pairs.flatMap(p=>p.samples).filter(s=>s.step===step).map(s=>s.ms).sort((x,y)=>x-y);return {n:a.length,p50:(a[3]+a[4])/2,p95:a[6]+.65*(a[7]-a[6]),min:a[0],max:a[7]}}
    report.before=summarize(.055);report.after=summarize(.04);report.medianRatio=report.after.p50/report.before.p50;
    report.checks.push({name:'No JS/shader errors',pass:report.errors.length===0});
    assert(report.checks.every(c=>c.pass));report.completed=true;
} finally {
    report.method='Same browser/context, same compiled production shader/maps/targets. Test-only uniform step selector forces fresh rays; .055 and .04 alternate order at eight identical pairs of poses. Warmups excluded. Draw plus blocking readPixels; checksum/statistics/PNG excluded. This is software-renderer wall time, not hardware GPU time or interactive FPS. No timing threshold gates heterogeneous CI.';
    await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await browser.close();await server.close();
}
