// Paired render-only comparison. Use BASELINE_ROOT for an unmodified checkout.
// CPU submission timings are diagnostic only: not GPU times or device FPS.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[];
try {
    for (const root of [process.env.BASELINE_ROOT,process.cwd()]) {
        if(!root) continue;
        const server=await createServer({root,logLevel:'silent',server:{host:'127.0.0.1',port:0}});await server.listen();
        const page=await browser.newPage({viewport:{width:960,height:640}});
        await page.addInitScript(()=>{HTMLElement.prototype.requestFullscreen=async()=>{};});
        await page.route('https://fonts.googleapis.com/**',r=>r.abort());
        try {
            await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=sun&dist=8500000&pitch=.72&yaw=-.4&bloom=0&galaxyvol=0&field=0&galaxies=0&tier1=0&realsky=0&compile=0`,{waitUntil:'domcontentloaded'});
            await page.waitForFunction(()=>window.__AP_READY,null,{timeout:120000});
            await page.click('#introEnter');await page.evaluate(()=>document.fullscreenElement?document.exitFullscreen():null);
            await page.evaluate(async()=>{
                const {G}=await import('/src/state.js');G.gr=true;G.paused=true;
                const r=window.__gl.renderer;const draw=r.render.bind(r);r.render=(...args)=>{draw(...args);r.getContext().finish();};
                await new Promise(resolve=>{let n=0;const f=()=>++n>=4?resolve():requestAnimationFrame(f);requestAnimationFrame(f);});
                r.setAnimationLoop(null);
            });
            const sample=await page.evaluate(async()=>{
                
                const {renderer,scene,camera}=window.__gl;
                const line=scene.children.find(o=>o.isLineSegments&&o.material?.vertexShader?.includes('uVRef'));
                const isolated=new scene.constructor();isolated.add(line);line.visible=true;
                const timings=[];
                for(let i=0;i<10;i++) {
                    const t=performance.now();renderer.render(isolated,camera);renderer.getContext().finish();
                    if(i>1)timings.push(performance.now()-t);
                }
                const sorted=[...timings].sort((a,b)=>a-b);
                return {timings,medianCpuSubmissionMs:sorted[Math.floor(sorted.length/2)],vertices:line.geometry.attributes.ref.count,calls:renderer.info.render.calls,opacity:line.material.uniforms.uOpacity.value,indexed:!!line.geometry.index,drawCount:window.__river.drawCount};
            });
            results.push({root,...sample});console.log(JSON.stringify(results.at(-1)));
        } finally {await page.close();await server.close();}
    }
    if(process.env.ARTEMIS_BENCHMARK)await writeFile(process.env.ARTEMIS_BENCHMARK,JSON.stringify(results,null,2));
} finally {await browser.close();}
