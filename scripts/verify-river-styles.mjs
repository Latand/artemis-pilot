import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { coarsenGalaxyWells, flowPulseRate, largeScaleFlowBlend } from '../src/flowScaleMath.js';

assert.equal(flowPulseRate(0, 1), 0);
assert(flowPulseRate(1e9, 1e9) > flowPulseRate(1, 1e9));
assert(flowPulseRate(1e30, 1) <= 1.02);
assert.equal(largeScaleFlowBlend(8e6), 0);
assert.equal(largeScaleFlowBlend(4e7), 1);
const grouped = coarsenGalaxyWells([{x:10,y:10,z:10,mass:2,core:1},{x:11,y:10,z:10,mass:3,core:1}],100,{x:0,y:0,z:0});
assert.equal(grouped.length,1);assert.equal(grouped[0].mass,5);assert.equal(grouped[0].x,10.6);
const output = process.env.ARTEMIS_EVIDENCE || '/tmp/artemis-pulses';
await mkdir(output, { recursive: true });
const server = await createServer({logLevel:'silent',server:{host:'127.0.0.1',port:0}});
await server.listen();
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport:{width:1280,height:800}});
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error' && /THREE|Shader|GL_INVALID/.test(m.text())) errors.push(m.text());});
await page.addInitScript(()=>{
    HTMLElement.prototype.requestFullscreen=async()=>{};
    localStorage.setItem('ap_introSeen','1');
    localStorage.setItem('ap_riverStyle','particles');
});
const frames=n=>page.evaluate(n=>new Promise(resolve=>{let i=0;function f(){if(++i>=n)resolve();else requestAnimationFrame(f);}requestAnimationFrame(f);}),n);
try {
    await page.route('https://fonts.googleapis.com/**',r=>r.fulfill({status:200,body:''}));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=sun&dist=8500000&pitch=.72&yaw=-.4&compile=0&galaxyvol=0&field=0&realsky=0&tier1=0&hidehelp=1&flowstyle=arcs`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__AP_READY,null,{timeout:120000});
    assert.equal(await page.evaluate(()=>window.__river.style),3,'Old URL/storage cannot restore style');
    assert.equal(await page.locator('[data-river-style]').count(),0,'Style picker removed');
    // Bound the software GPU queue in this test, never in production.
    await page.evaluate(()=>{const r=window.__gl.renderer;const draw=r.render.bind(r);r.render=(...args)=>{draw(...args);r.getContext().finish();};});
    await page.evaluate(async()=>{const {G}=await import('/src/state.js');G.paused=false;G.warp=864000;G.gr=true;});
    await frames(6);
    // Live markers must share the current ephemeris position every rendered
    // frame, including mobile/high-warp frames whose surface LOD is throttled.
    const markerChecks=await page.evaluate(async()=>{
        const {plGroups,plGlows}=await import('/src/bodies.js');
        const samples=[];
        for(let i=0;i<8;i++) {await new Promise(requestAnimationFrame);samples.push(plGroups.map((g,k)=>g.position.distanceTo(plGlows[k].position)));}
        return samples;
    });
    assert(markerChecks.flat().every(d=>d===0),'No stale planet markers');
    await page.evaluate(async()=>{const {G}=await import('/src/state.js');G.paused=true;});
    await page.screenshot({timeout:180000,path:`${output}/solar-system.png`});
    const checks=[];
    for(const [name,pc] of [['interstellar',5],['galaxy',30000],['local-group',1200000],['galaxy-web',30000000]]) {
        console.log('Checking',name);
        await page.evaluate(async pc=>{
            const {G}=await import('/src/state.js');const {cam}=await import('/src/scene.js');
            const {PC_KM,K}=await import('/src/constants.js');const {galacticCenterScene}=await import('/src/universe/starfield.js');
            G.focus='free';G.gr=true;G.paused=false;G.warp=1e9;
            if(pc<100)cam.tgt.set(0,0,0);else cam.tgt.fromArray(galacticCenterScene());
            cam.dist=pc*PC_KM*K;cam.distTarget=null;cam.pitch=.65;cam.yaw=-.4;
        },pc);
        await page.waitForFunction(()=>window.__largeFlow.visible,null,{timeout:120000});
        await frames(4);
        assert.deepEqual(errors,[]);
        const a=await page.evaluate(()=>({...window.__largeFlow}));
        await frames(3);
        const b=await page.evaluate(()=>({...window.__largeFlow}));
        assert(a.sources>0 && a.sources<=24 && a.vertices<=2880);
        if(pc>=1200000) assert(b.galaxies>0,'Catalog galaxies contribute at '+name);
        assert(b.phase!==a.phase,'Pulses animate at '+name);
        await page.evaluate(async()=>{const {G}=await import('/src/state.js');G.paused=true;});
        await frames(2);
        const phase=await page.evaluate(()=>window.__largeFlow.phase);
        await frames(3);
        assert.equal(await page.evaluate(()=>window.__largeFlow.phase),phase,'Pause freezes flow');
        if(name==='galaxy') {
            assert.equal(b.haloSources,1);
            await page.evaluate(async()=>{const {G}=await import('/src/state.js');G.darkMatter=false;});
            await frames(2);
            assert.equal(await page.evaluate(()=>window.__largeFlow.haloSources),0);
            await page.evaluate(async()=>{const {G}=await import('/src/state.js');G.darkMatter=true;});
            await frames(2);
        }
        checks.push({name,...b});
        await page.screenshot({timeout:180000,path:`${output}/${name}.png`});
    }
    await page.evaluate(async()=>{const {G}=await import('/src/state.js');G.gr=false;});
    await page.waitForFunction(()=>!window.__largeFlow.visible,null,{timeout:180000});
    assert.equal(await page.evaluate(()=>window.__largeFlow.visible),false,'Gravity toggle hides cosmic flow');
    await page.setViewportSize({width:430,height:932});
    await page.evaluate(async()=>{const {G}=await import('/src/state.js');G.gr=true;});
    await frames(20);
    await page.screenshot({timeout:180000,path:`${output}/mobile-galaxy-web.png`});
    assert.deepEqual(errors,[]);
    await writeFile(`${output}/checks.json`,JSON.stringify({checks,markerChecks,errors},null,2));
    console.log('Fixed Time pulses, scale handover, live markers, cosmic animation/pause/toggle checks passed');
} finally {await browser.close();await server.close();}
