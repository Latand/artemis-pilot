import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const output = process.env.ARTEMIS_EVIDENCE || '/tmp/artemis-evidence';
await mkdir(output, { recursive: true });
const server = await createServer({logLevel:'silent',server:{host:'127.0.0.1',port:0}});
await server.listen();
const url = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
const errors=[];
console.log('Starting browser verification');
const page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',e=>{errors.push(e.message);console.error(e.message);});
page.on('console',m=>{if(m.type()==='error' && /THREE|Shader|GL_INVALID/.test(m.text())) errors.push(m.text());});
await page.addInitScript(()=>{HTMLElement.prototype.requestFullscreen=async()=>{};});
const frames = async(n=12)=>page.evaluate(n=>new Promise(resolve=>{let i=0; const f=()=>++i>=n?resolve():requestAnimationFrame(f);requestAnimationFrame(f);}),n);
try {
    await page.route('https://fonts.googleapis.com/**',r=>r.abort());
    await page.goto(url+'/?focus=sun&dist=8500000&pitch=.72&yaw=-.4&hidehelp=1&perf=1&bloom=0&galaxyvol=0&compile=0&realsky=0&tier1=0&field=0&galaxies=0',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__AP_READY,null,{timeout:120000});
    await page.click('#introEnter');
    await page.evaluate(()=>document.fullscreenElement ? document.exitFullscreen() : null);
    await page.evaluate(()=>{document.getElementById('exploreInfo').open=false;document.getElementById('exploreDestinations').open=false;});
    await page.evaluate(async()=>{const {G}=await import('/src/state.js');G.gr=true;G.paused=false;G.warp=864000;});
    console.log('App ready');
    await page.evaluate(()=>{const r=window.__gl.renderer;const draw=r.render.bind(r);r.render=(...args)=>{draw(...args);r.getContext().finish();};});
    await frames(3);
    const styles=['lines','arcs','particles','pulses','currents'];
    const snapshots=[];
    for (const [index,style] of styles.entries()) {
        await page.selectOption('#exploreFlowStyle',style);
        await frames(3);
        assert.equal(await page.evaluate(()=>window.__river.style),index);
        assert.equal(await page.inputValue('#pilotFlowStyle'),style);
        snapshots.push(await page.evaluate(async()=>{
            const {plGroups,plGlows}=await import('/src/bodies.js');
            const {viewportSize,camera}=await import('/src/scene.js');
            return plGlows.map((g,i)=>({visible:g.visible,opacity:g.material.opacity,px:g.scale.x*viewportSize.pxScale/camera.position.distanceTo(plGroups[i].position)}));
        }));
        console.log('Capturing',style);
        await page.screenshot({timeout:180000,path:`${output}/${style}.png`});
    }
    for (const marker of snapshots[0]) {
        if(marker.visible) { assert(Math.abs(marker.px-10)<.1);assert(marker.opacity>.01); }
    }
    assert(snapshots[0].some(marker=>marker.visible && marker.opacity>.5));
    // A resolved planet replaces its beacon; destroyed planets have no guide.
    await page.evaluate(async()=>{
        const {G}=await import('/src/state.js'); const {cam}=await import('/src/scene.js');
        G.paused=true;G.focus=3;cam.dist=350;cam.distTarget=null;
    });
    await frames(20);
    assert((await page.evaluate(async()=>{const {plGlows}=await import('/src/bodies.js');return plGlows[3].material.opacity;}))<.01);
    await page.screenshot({timeout:180000,path:`${output}/jupiter-close.png`});
    await page.evaluate(async()=>{const {WORLD}=await import('/src/state.js');WORLD.plDestroyed[3]=true;});
    await frames(4);
    assert.equal(await page.evaluate(async()=>{const {plGlows}=await import('/src/bodies.js');return plGlows[3].visible;}),false);
    await page.evaluate(async()=>{const {WORLD}=await import('/src/state.js');WORLD.plDestroyed[3]=false;});
    await page.setViewportSize({width:430,height:932});
    await page.evaluate(async()=>{const {G}=await import('/src/state.js');const {cam}=await import('/src/scene.js');G.focus='sun';cam.dist=8500000;cam.distTarget=null;});
    await frames(15);
    await page.click('#explorePanelToggle');
    await page.selectOption('#exploreFlowStyle','particles');
    await frames(8);
    const box=await page.locator('#exploreFlowStyle').boundingBox();
    assert(box && box.width>100 && box.x>=0 && box.x+box.width<=430);
    await page.screenshot({timeout:180000,path:`${output}/mobile-selector.png`});
    await page.click('#explorePanelToggle');
    await page.screenshot({timeout:180000,path:`${output}/mobile.png`});
    await page.reload(); await page.waitForFunction(()=>window.__AP_READY,null,{timeout:120000});
    assert.equal(await page.inputValue('#exploreFlowStyle'),'particles');
    assert.equal(await page.evaluate(()=>window.__river.style),2);
    assert.equal(await page.evaluate(()=>window.__river.texW),96);
    assert.deepEqual(errors,[]);
    await writeFile(`${output}/checks.json`,JSON.stringify({snapshots,errors,checks:['five styles switch without reload','controls synchronized','10 CSS px distant markers','resolved disk hides marker','destroyed planet hides marker','mobile selector fits','style persists across reload']},null,2));
    console.log('River style browser checks passed; screenshots: '+output);
} catch(e) { console.error('Browser errors:', errors);await page.screenshot({timeout:180000,path:output+'/failure.png'});throw e;} finally {await browser.close();await server.close();}
