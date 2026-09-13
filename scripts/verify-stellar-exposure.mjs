import {createServer} from 'vite';
import {chromium} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const output = resolve(process.argv[2] || 'docs/realism-2026-09-13/revision-1/final');
await mkdir(output, {recursive:true});
const server = await createServer({server:{host:'127.0.0.1',port:0,hmr:false}});
await server.listen();
const browser = await chromium.launch({headless:true});
const errors = [], findings = [], labels = [];
try {
    const page = await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => {if(m.type()==='error') errors.push(m.text());});
    await page.addInitScript(() => {Date.now = () => Date.UTC(2026,8,13,12);});
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?warp=0&tier1=0&realsky=1&focus=star:0&dist=461.7152&hidehelp=1&dpr=1`);
    await page.waitForFunction(() => window.__AP_READY, null, {timeout:60000});
    const enter=page.getByRole('button',{name:'ENTER SIMULATION',exact:true});
    if(await enter.isVisible()) await enter.click();
    await page.evaluate(() => {__G.paused=true; __G.gr=false; __G.constellations=false;});
    await page.waitForFunction(() => window.__REAL_SKY?.loaded, null, {timeout:60000});
    for(const scenario of [
        {name:'proxima-close',focus:'star:0',radii:4.3},
        {name:'proxima-middle',focus:'star:0',radii:8},
        {name:'proxima-wide',focus:'star:0',radii:20},
        {name:'cosmic-onset',focus:'sun',distance:3e9},
        {name:'one-light-year',focus:'sun',distance:1e10},
        {name:'ninety-nine-light-years',focus:'sun',distance:9.366e11},
        {name:'focused-faint-star',focus:'star:0',distance:9.366e11},
        {name:'fade-ceiling',focus:'sun',distance:1.42e12},
        {name:'return-proxima',focus:'star:0',radii:4.3},
    ]) {
        await page.evaluate(async s => {
            const {STARS,K}=await import('/src/constants.js');
            const THREE=await import('/node_modules/three/build/three.module.js');
            __G.focus=s.focus; __cam.distTarget=null;
            if(s.radii) {
                const proxima=STARS[0], other=STARS.find(s=>s.name==='GUNIIBUU');
                const outward=new THREE.Vector3(proxima.x-other.x,proxima.z-other.z,-proxima.y+other.y).normalize();
                outward.applyAxisAngle(new THREE.Vector3(0,1,0),0.5);
                __cam.yaw=Math.atan2(outward.z,outward.x); __cam.pitch=Math.asin(outward.y);
                __cam.dist=proxima.R*K*s.radii;
            } else {
                __cam.yaw=-.95; __cam.pitch=.22; __cam.dist=s.distance;
            }
        }, scenario);
        if(scenario.distance>3e8) await page.waitForFunction(async () => (await import('/src/cosmic.js')).isCosmicLayerBuilt(), null, {timeout:120000});
        await page.waitForTimeout(900);
        const state = await page.evaluate(async () => {
            const {STARS}=await import('/src/constants.js');
            const {addStarVisual}=await import('/src/stars.js');
            const {stellarExposure}=await import('/src/render/stellarAppearance.js');
            const focused=typeof __G.focus==='string' && __G.focus.startsWith('star:') ? Number(__G.focus.slice(5)) : -1;
            const rows=[...document.querySelectorAll('.starLbl')].map(el=>{
                const index=STARS.findIndex(s=>s.name===el.textContent), entry=addStarVisual(STARS[index]);
                const rect=el.getBoundingClientRect();
                return {name:el.textContent,focused:index===focused,label:+el.style.opacity,computed:+getComputedStyle(el).opacity,
                    point:entry.g.visible?entry.glow.material.opacity:0,disc:!!entry.photosphere?.visible,
                    x:rect.x,y:rect.y,width:rect.width,height:rect.height};
            });
            const visible=rows.filter(r=>r.label>=.02); let overlaps=0;
            for(let i=0;i<visible.length;i++) for(let j=i+1;j<visible.length;j++) {
                const a=visible[i],b=visible[j];
                if(a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height) overlaps++;
            }
            return {exposure:stellarExposure.value,focus:__G.focus,dist:__cam.dist,visible,rows,overlaps};
        });
        labels.push({scenario:scenario.name,...state});
        for(const r of state.visible) if(!r.focused&&!r.disc&&Math.max(r.label,r.computed)>r.point+1e-6) findings.push(`${scenario.name}: ${r.name} label ${r.label} exceeds point ${r.point}`);
        if(state.overlaps) findings.push(`${scenario.name}: overlapping labels`);
        if(scenario.distance>9.460730472e9&&state.visible.length>14) findings.push(`${scenario.name}: label cap exceeded`);
        if(scenario.name==='fade-ceiling'&&state.visible.length) findings.push('Labels survive the 140 ly ceiling');
        if(scenario.focus==='star:0'&&!state.visible.some(r=>r.focused)) findings.push(`${scenario.name}: focused label missing`);
        if(['cosmic-onset','one-light-year','ninety-nine-light-years'].includes(scenario.name)&&!state.visible.length) findings.push(`${scenario.name}: label cliff`);
        if(scenario.name==='proxima-close') {
            const g=state.visible.find(r=>r.name==='GUNIIBUU');
            if(!g) findings.push('Proxima reproduction must include GUNIIBUU');
        }
        if(['proxima-close','ninety-nine-light-years','focused-faint-star'].includes(scenario.name)) {
            const screenshot = await page.screenshot({path:resolve(output,scenario.name+'.png')});
            if(scenario.name==='proxima-close') {
                // Assert actual screenshot pixels independently of object.visible.
                // This crop lies inside the resolved photosphere, clear of UI.
                const brightPixels = await page.evaluate(async encoded => {
                    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
                    const bitmap = await createImageBitmap(new Blob([bytes], {type:'image/png'}));
                    const canvas = new OffscreenCanvas(420,430), ctx = canvas.getContext('2d');
                    ctx.drawImage(bitmap,500,240,420,430,0,0,420,430); bitmap.close();
                    const pixels = ctx.getImageData(0,0,420,430).data;
                    let count=0;
                    for(let i=0;i<pixels.length;i+=4) if(pixels[i]>150&&pixels[i+1]>100&&pixels[i+2]>60) count++;
                    return count;
                }, screenshot.toString('base64'));
                labels[labels.length-1].photosphereBrightPixels = brightPixels;
                if(brightPixels<150000) findings.push('Resolved Proxima photosphere is missing from the screenshot');
            }
        }
    }
    const solar = await page.evaluate(async () => {
        const THREE=await import('/node_modules/three/build/three.module.js');
        const bodies=await import('/src/bodies.js');
        const stars=await import('/src/stars.js');
        const {stellarExposure}=await import('/src/render/stellarAppearance.js');
        const {PC_KM,K,R_SUN}=await import('/src/constants.js');
        const {sunStateAt}=await import('/src/universe/sunEvolution.js');
        __gl.renderer.setAnimationLoop(null); __G.t=0;
        const equivalent={id:'exposure-test-solar-twin',name:'SOLAR TWIN TEST',x:0,y:0,z:0,R:R_SUN,lumSolar:1,tempK:5772};
        const entry=stars.addStarVisual(equivalent);
        const physicalCamera=new THREE.PerspectiveCamera(48,1,.02,1e15);
        physicalCamera.position.set(0,0,10*PC_KM*K); physicalCamera.lookAt(0,0,0);physicalCamera.updateMatrixWorld();
        const camera=new THREE.PerspectiveCamera(48,1,.1,100);camera.position.z=10;camera.updateMatrixWorld();
        const scene=new THREE.Scene(), renderer=__gl.renderer;
        const target=new THREE.WebGLRenderTarget(64,64,{type:THREE.FloatType});
        const pixels=new Float32Array(64*64*4);
        function sample(material,point) {
            scene.clear();
            const obj=point ? new THREE.Points(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([0,0,0],3)),material) : new THREE.Sprite(material);
            if(point) material.size=8;
            else obj.scale.setScalar(8*10*2*Math.tan(48*Math.PI/360)/64);
            scene.add(obj);renderer.setRenderTarget(target);renderer.clear();renderer.render(scene,camera);
            renderer.readRenderTargetPixels(target,0,0,64,64,pixels);
            let signal=0;for(let i=0;i<pixels.length;i+=4)signal+=pixels[i]+pixels[i+1]+pixels[i+2];
            obj.geometry?.dispose();return signal;
        }
        const rows=[];
        for(const exposure of [1,.1,.001]) {
            stellarExposure.value=exposure;stars.updateStars(physicalCamera,0);bodies.updateSunView(physicalCamera,10);
            rows.push({exposure,sun:sample(bodies.sunGlow.material,false),twin:sample(entry.glow.material,true),
                sunOpacity:bodies.sunGlow.material.opacity,twinOpacity:entry.glow.material.opacity,
                sunColor:bodies.sunGlow.material.color.toArray(),twinColor:entry.glow.material.color.toArray()});
        }
        const evolution=[];
        for(const t of [0,7.5e9*31557600,9e9*31557600]) {
            __G.t=t;stellarExposure.value=.001;bodies.updateSunView(physicalCamera,10);
            const state=sunStateAt(t);
            evolution.push({t,expectedRadius:state.R_Rsun,radius:bodies.sunCore.scale.x,phase:state.phase});
        }
        __G.t=0;stellarExposure.value=1;
        bodies.updateSunView(camera,4*R_SUN/PC_KM);
        const resolvedGlow=bodies.sunGlow.material.opacity;
        renderer.setRenderTarget(null);target.dispose();
        return {rows,evolution,resolvedGlow};
    });
    for(let i=1;i<solar.rows.length;i++) if(!(solar.rows[i].sun<solar.rows[i-1].sun)) findings.push('Solar rendered signal does not decrease with exposure');
    for(const r of solar.rows) {
        if(Math.abs(r.sunOpacity-r.twinOpacity)>1e-8||r.sunColor.some((v,i)=>Math.abs(v-r.twinColor[i])>1e-8)) findings.push(`Solar material differs from equivalent star at exposure ${r.exposure}`);
        if(Math.abs(r.sun/solar.rows[0].sun-r.twin/solar.rows[0].twin)>0.015) findings.push('Solar exposure response differs from equivalent rendered star');
    }
    if(solar.resolvedGlow!==0) findings.push('Resolved Sun glow transition changed');
    for(const r of solar.evolution) if(r.radius!==r.expectedRadius) findings.push('Evolving solar radius changed');
    const result={labels,solar,errors,findings};
    await writeFile(resolve(output,'results.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({solar,errors,findings},null,2));
    if(errors.length||findings.length) process.exitCode=1;
} finally {await browser.close();await server.close();}
