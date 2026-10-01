// Deterministic full-app frames, production gravity shaders and true touch
// startup. The frame clock is controlled only in this test server; no renderer,
// model, source selection or shader is replaced. Sky omissions are recorded.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'vite';
const mobile = process.env.DEVICE === 'mobile';
const output = process.env.ARTEMIS_EVIDENCE || `evidence/gravity-${mobile?'mobile':'desktop'}`;
await mkdir(output,{recursive:true});
const report={revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),mobile,errors:[],frames:[],checks:{},
    omissions:['tier-1 catalog streaming','procedural resolved field','HYG background catalog'],
    productionLayers:['local gravity particles','large-scale gravity','volumetric Milky Way','galaxy population','body surfaces']};
const server=await createServer({logLevel:'silent',server:{host:'127.0.0.1',port:0},plugins:[{
    name:'deterministic-gravity-frames',enforce:'pre',transform(source,id){
        if(!id.split('?')[0].endsWith('/src/main.js'))return null;
        for(const token of ['renderer.setAnimationLoop(frame);','const firstFrameT0 = perfStart();'])
            assert.equal(source.split(token).length,2,`QA hook changed: ${token}`);
        return source.replace('renderer.setAnimationLoop(frame);','// QA: deliver deterministic frames manually.')
            .replace('const firstFrameT0 = perfStart();','G.t=0; G.paused=true; G.gr=true; resetEphem(); clock.getDelta=()=>1/60;\nconst firstFrameT0 = perfStart();')
            +'\nwindow.__gravityFrame=()=>{lastMobileFrame=-Infinity;frame();renderer.getContext().finish();};';
    }
}]});
let browser;
try{
    await server.listen();
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const page=await browser.newPage({viewport:mobile?{width:430,height:932}:{width:1200,height:800},hasTouch:mobile,isMobile:mobile,deviceScaleFactor:1});
    page.setDefaultTimeout(120000);
    await page.addInitScript(()=>{localStorage.clear();localStorage.setItem('ap_introSeen','1');localStorage.setItem('ap_riverStyle','particles');Date.now=()=>Date.UTC(2026,9,1,12);});
    page.on('pageerror',e=>report.errors.push(e.stack||e.message));
    page.on('console',m=>{if(m.type()==='error'&&/THREE|Shader|GL_INVALID/.test(m.text()))report.errors.push(m.text());});
    await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=sun&dist=2600000&pitch=.72&yaw=-.4&compile=0&field=0&realsky=0&tier1=0&hidehelp=1&flowstyle=arcs`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__AP_READY&&window.__gravityFrame);
    const frame=async(n=1)=>{for(let i=0;i<n;i++)await page.evaluate(()=>window.__gravityFrame());};
    const check=(key,ok)=>{report.checks[key]=ok;assert(ok,key);};
    check('fixedTimePulses',await page.evaluate(()=>window.__river.style===3));
    check('noStyleSelector',await page.locator('[data-river-style]').count()===0);
    check('actualTouchQuality',await page.evaluate(async expected=>(await import('/src/scene.js')).renderQuality.mobile===expected,mobile));
    await frame(36);
    await page.waitForFunction(async()=> (await import('/src/render/galaxyPopulationRender.js')).galaxyPopulationStatus().ready);
    // Paused camera has settled: both phase and the actual GPU texture freeze.
    const local=await page.evaluate(async()=>{
        const r=await import('/src/river.js');const a=r.riverDebugReadPositions(1);
        for(let i=0;i<6;i++)window.__gravityFrame();
        const b=r.riverDebugReadPositions(1);return {a,b};
    });
    check('pauseFreezesParticleTexture',local.a.hash===local.b.hash);
    check('pauseFreezesLocalPulse',local.a.phase===local.b.phase);
    report.localPause=local;
    // Direct production updates isolate retained-origin correctness from body
    // and camera integration. All geometry and compute shaders are unchanged.
    const origin=await page.evaluate(async()=>{
        const r=await import('/src/river.js'),s=await import('/src/scene.js'),b=await import('/src/bodies.js');
        const {G}=await import('/src/state.js');G.focus='free';
        const wasMobile=s.renderQuality.mobile;s.renderQuality.mobile=true;s.renderQuality.loadShed=2;
        const call=dt=>r.updateRiver(dt,1,b.earthG.position,b.moon.position,b.sunCore.position,b.plGroups.map(p=>p.position),1/60);
        const samples=[];
        for(let i=0;i<3;i++){
            s.cam.tgt.x+=100;s.camera.position.x+=100;r.river.computeEveryAdaptive=4;r.river.frame=0;
            call(1);samples.push({...r.riverDebugReadPositions(1),skipped:r.river.skippedCompute});
        }
        r.river.frame=3;call(-1);const reverse={...r.riverDebugReadPositions(1),dt:r.river.dtVis};
        s.renderQuality.mobile=wasMobile;s.renderQuality.loadShed=0;
        return {samples,reverse};
    });
    check('skippedComputeRetainsTexture',origin.samples.every(x=>x.skipped&&x.hash===origin.samples[0].hash));
    check('drawUsesWholeRetainedShift',origin.samples.every(x=>Math.abs(x.center.x-x.textureCenter[0]-x.drawShift[0])<1e-6));
    check('retainedShiftAccumulates',origin.samples[2].drawShift[0]>origin.samples[0].drawShift[0]);
    check('reverseAdvectsParticles',origin.reverse.dt<0);
    check('computedTextureResetsShift',origin.reverse.drawShift.every(x=>x===0));report.retainedOrigin=origin;
    const cases=[['solar-system',2600000,false],['handover',20000000,false],['interstellar',5,true],['milky-way',30000,true],['local-group',1200000,true],['galaxy-web',30000000,true]];
    for(const [name,distance,parsecs]of cases){
        await page.evaluate(async({distance,parsecs})=>{
            const {G}=await import('/src/state.js'),{cam}=await import('/src/scene.js'),{PC_KM,K}=await import('/src/constants.js');
            const {galacticCenterScene}=await import('/src/universe/starfield.js');
            G.focus='free';G.paused=true;G.gr=true;G.t=0;
            if(parsecs&&distance>100)cam.tgt.fromArray(galacticCenterScene());else cam.tgt.set(0,0,0);
            cam.dist=distance*(parsecs?PC_KM*K:1);cam.distTarget=null;cam.yaw=-.4;cam.pitch=.72;
        },{distance,parsecs});
        await frame(8);
        if(parsecs){
            const a=await page.evaluate(()=>({...window.__largeFlow}));await frame(2);
            const b=await page.evaluate(()=>({...window.__largeFlow}));
            check(`${name}Visible`,b.visible&&b.sources>0&&b.sources<=24);
            check(`${name}Budget`,b.vertices===(mobile?1280:2880));
            check(`${name}Paused`,a.phase===b.phase);
            report.frames.push({name,...b});
        }
        await page.screenshot({path:`${output}/${name}.png`,timeout:180000});
        console.log('Captured',mobile?'touch':'desktop',name);
    }
    // Source selection is independent of the renderer's visibility decisions.
    const selection=await page.evaluate(async()=>{
        const {camera,cam,scene}=await import('/src/scene.js');const {galaxyFlowSources}=await import('/src/render/galaxyPopulationRender.js');
        const all=()=>galaxyFlowSources(camera,cam.dist,18,true,null,cam.tgt);
        const before=all(),changed=[];scene.traverse(o=>{if(o.name.startsWith('galaxies.chunk')){changed.push([o,o.visible]);o.visible=false;}});
        const hidden=all();for(const[o,v]of changed)o.visible=v;return {before,hidden};
    });
    check('offscreenMassesKeepAttracting',JSON.stringify(selection.before)===JSON.stringify(selection.hidden));
    // Andromeda's live position follows abrupt epoch changes even while paused.
    const epoch=await page.evaluate(async()=>{
        const {G}=await import('/src/state.js'),{cam}=await import('/src/scene.js'),{PC_KM,K}=await import('/src/constants.js');
        cam.dist=1200000*PC_KM*K;cam.distTarget=null;G.t=4e9*31557600;window.__gravityFrame();
        const {galaxyFlowSources}=await import('/src/render/galaxyPopulationRender.js'),{camera}=await import('/src/scene.js');
        return {actual:window.__largeFlow.wells.filter(w=>w.label==='Andromeda'),expected:galaxyFlowSources(camera,cam.dist,18,true,true,cam.tgt).filter(w=>w.label==='Andromeda')};
    });
    check('pausedEpochTracksAndromeda',epoch.actual.length===1&&epoch.expected.length===1&&Math.hypot(epoch.actual[0].x-epoch.expected[0].x,epoch.actual[0].y-epoch.expected[0].y,epoch.actual[0].z-epoch.expected[0].z)<1);
    report.epoch=epoch;
    // Runtime direction and pause at cosmic scale using the production update.
    const timing=await page.evaluate(async()=>{
        const {updateLargeScaleFlow,largeFlowStatus}=await import('/src/render/largeScaleFlow.js'),{sunCore}=await import('/src/bodies.js');
        const a=largeFlowStatus.phase;updateLargeScaleFlow(1e16,1/60,1,sunCore.position);const b=largeFlowStatus.phase;
        updateLargeScaleFlow(-1e16,1/60,1,sunCore.position);return {a,b,c:largeFlowStatus.phase};
    });
    check('cosmicReverseRetracesPulse',Math.abs(timing.a-timing.c)<1e-10&&timing.a!==timing.b);
    await page.evaluate(async()=>{(await import('/src/state.js')).G.gr=false;});await frame(100);
    check('gravityToggleHidesFlow',await page.evaluate(()=>!window.__largeFlow.visible));
    check('noRuntimeErrors',report.errors.length===0);
}finally{
    await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));
    await browser?.close();await server.close();
}
