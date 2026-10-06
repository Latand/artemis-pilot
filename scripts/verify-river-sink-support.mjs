// Bounded same-frame comparison of the real production vertex shaders.
// The pinned old shader and candidate share one frozen GPU particle texture,
// camera, source state and uniforms. No mass, flow, clock or pixel boosts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { transformCelestialSource } from './celestial-detail-fixtures.mjs';

const baseRef = '2cde3de63015ea721364471736d82a21726af4e4';
const root = process.cwd(), out = resolve(process.argv[2] || 'evidence/river-sink-support');
const baseSource = execFileSync('git', ['show', `${baseRef}:src/river.js`], { encoding: 'utf8' });
const source = await readFile('src/river.js', 'utf8');
const literal = (text, name) => text.match(new RegExp('const ' + name + ' = /\\* glsl \\*/(`[^]*?`);'))?.[1];
for (const name of ['FLOW_GLSL', 'COMPUTE_FRAG']) assert.equal(literal(source, name), literal(baseSource, name), `${name} must remain byte-identical`);
const oldVertex = literal(baseSource, 'LINE_VERT'); assert(oldVertex);
const mobile = process.env.DEVICE === 'mobile';
const report = { baseRef, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceSha256: createHash('sha256').update(source).digest('hex'), mobile,
    scope: 'Frozen production app; same-frame original/candidate vertex shaders, identical physical state and owned GPU samples. Synthetic matched-distance views, not reconstruction of the user camera.',
    omissions: ['unrelated galaxy, catalog and procedural backgrounds', 'wall-clock performance measurement'],
    resolvedBackdrop: 'A dim test-only plane behind the resolved hole makes black-horizon exclusion distinguishable from an empty black framebuffer; production lens and horizon shaders are unchanged.', cases: [], errors: [] };
await mkdir(out, { recursive: true });
const hook = `
const supportOldVertex = ${oldVertex};
export function supportUseLegacy(legacy) { lineMat.vertexShader = legacy ? supportOldVertex : LINE_VERT; lineMat.needsUpdate = true; }
export function supportRead() {
 const pixels=new Float32Array(TEXW*TEXW*4);renderer.readRenderTargetPixels(rtA,0,0,TEXW,TEXW,pixels);
 let hash=2166136261;const bits=new Uint32Array(pixels.buffer);for(const n of bits)hash=Math.imul(hash^n,16777619)>>>0;
 const sources=bodyVals.slice(0,uniformsShared.uNB.value).map((b,i)=>({index:i,position:[b.x+smoothCenter.x,b.y+smoothCenter.y,b.z+smoothCenter.z],coefficient:b.w,sink:sinkVals[i],hole:holeVals[i],halo:haloVals[i].toArray(),owners:0,drawnOwners:0}));
 for(let i=0;i<TEXW*TEXW;i++){const own=Math.round(pixels[i*4+3])-1;if(own>=0&&sources[own]){sources[own].owners++;if(i<river.drawCount)sources[own].drawnOwners++;}}
 return {textureHash:hash,finite:pixels.every(Number.isFinite),sources,radius:smoothR,count:river.count,drawCount:river.drawCount,computeEvery:river.computeEvery,skipped:river.skippedCompute,phase:uniformsShared.uPhase.value,timeRate:uniformsShared.uTimeRate.value,dt:river.dtVis,frameVelocity:uniformsShared.uFrameVel.value.toArray(),frameWeight:uniformsShared.uFrameW.value};
}
`;
execFileSync(process.execPath, ['--input-type=module', '--check'], { input: source + hook });
let server, browser;
try {
    server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
        plugins: [{ name: 'sink-support-qa', enforce: 'pre',
            resolveId(id) { if (id === 'virtual:galaxy-preview') return '\0off'; },
            load(id) { if (id === '\0off') return 'export default null;'; },
            transform(code, id) { if (id.split('?')[0].endsWith('/src/river.js')) return code + hook; return transformCelestialSource(code, id); },
        }] });
    await server.listen();
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true,
        args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: mobile ? { width: 430, height: 932 } : { width: 1000, height: 700 }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => report.errors.push(e.stack || String(e)));
    page.on('console', m => { if (m.type() === 'error' && /THREE|Shader|GL_INVALID/.test(m.text())) report.errors.push(m.text()); });
    await page.addInitScript(() => { Date.now = () => Date.UTC(2026, 9, 6, 12); localStorage.clear(); localStorage.setItem('ap_introSeen', '1'); });
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?quality=high&focus=sun&dist=50000&tier1=0&realsky=0&field=0&galaxies=0&galaxyvol=0&galaxy=0&compile=0&bloom=0&dpr=1&hidehelp=1`);
    await page.waitForFunction(() => window.__AP_READY && window.__celestialFrame);
    await page.evaluate(async () => {
        window.qa = { s: await import('/src/scene.js'), st: await import('/src/state.js'), bh: await import('/src/blackholes.js'),
            c: await import('/src/constants.js'), river: await import('/src/river.js'), bodies: await import('/src/bodies.js'), lens: await import('/src/lensing.js'), THREE: await import('/node_modules/three/build/three.module.js') };
        Object.assign(qa.st.G, { paused: true, gr: true, predict: false, focus: 'free' });
        document.getElementById('intro').style.display = 'none';
    });
    const cases = [
        { name: 'sun-only-control', count: 0, distance: 50000 },
        { name: 'sun-one-hole', count: 1, distance: 50000 },
        { name: 'sun-three-holes', count: 3, distance: 50000 },
        { name: 'sun-three-holes-wide', count: 3, distance: 150000 },
        { name: 'resolved-horizon-exclusion', count: 1, distance: .08, resolved: true },
    ].map(spec => ({ ...spec, distance: spec.distance * (mobile && !spec.resolved ? 2 : 1) }));
    for (const spec of cases) {
        console.log('render', spec.name);
        const result = await page.evaluate(spec => {
            const { s, st, bh, c, river, bodies, lens, THREE } = qa;
            bh.clearBlackHoles();
            const sun = bodies.sunCore.position.clone(), earth = bodies.earthG.position;
            for (let i = 0; i < spec.count; i++) {
                const p = sun.clone().add(new THREE.Vector3(20000 + (i === 1 ? 3000 : 0), i === 2 ? 3000 : i === 1 ? -3000 : 0, 0));
                bh.addBlackHole((p.x-earth.x)/c.K, -(p.z-earth.z)/c.K, 10, 0, 0, true, null, 0, 0, p.y/c.K);
            }
            s.cam.tgt.copy(sun).add(new THREE.Vector3(10000, 0, 0));s.cam.dist=spec.distance;s.cam.distTarget=null;s.cam.yaw=Math.PI/2;s.cam.pitch=0;
            if(spec.resolved)s.cam.tgt.set(earth.x+st.BH.sx[0],st.BH.sy[0],earth.z+st.BH.sz[0]);
            // Complete the real camera-dependent scene update before freezing
            // the pair: direct camera mutation leaves old marker sizes/LOD.
            window.__celestialFrame();s.renderer.getContext().finish();
            s.camera.updateMatrixWorld(true);
            bh.updateBHVisuals(0, earth.x, earth.z);
            lens.updateLensing(s.camera,s.camera.aspect);
            let backdrop=null;
            if(spec.resolved){
                const h=4*spec.distance*Math.tan(s.camera.fov*Math.PI/360);
                backdrop=new THREE.Mesh(new THREE.PlaneGeometry(h*s.camera.aspect*1.2,h*1.2),new THREE.MeshBasicMaterial({color:0x203040}));
                backdrop.position.copy(s.cam.tgt).add(new THREE.Vector3(0,0,-spec.distance));backdrop.quaternion.copy(s.camera.quaternion);s.scene.add(backdrop);
            }
            river.resetRiverContext();
            for(let i=0;i<8;i++)river.updateRiver(0,1,earth,bodies.moon.position,bodies.sunPos,bodies.plGroups.map(p=>p.position),1/60);
            river.updateShells(0,0);
            const state=river.supportRead(), gl=s.renderer.getContext(), width=gl.drawingBufferWidth, height=gl.drawingBufferHeight;
            const targets=state.sources.filter(source=>source.index===2||source.hole).map(source=>{
                const ndc=new THREE.Vector3(...source.position).project(s.camera);
                return {index:source.index,hole:source.hole,x:(ndc.x*.5+.5)*width,y:(ndc.y*.5+.5)*height,ndc:ndc.toArray()};
            });
            const capture=legacy=>{
                river.supportUseLegacy(legacy);
                if(lens.lensingPass.enabled)lens.renderLensed(s.renderer,s.scene,s.camera);
                else s.renderSceneTiered(s.renderer,s.scene,s.camera);
                gl.finish();
                const bytes=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
                let pixelHash=2166136261;for(const n of bytes)pixelHash=Math.imul(pixelHash^n,16777619)>>>0;
                let canvasLit=0;for(let k=0;k<bytes.length;k+=4)if(.2126*bytes[k]+.7152*bytes[k+1]+.0722*bytes[k+2]>12)canvasLit++;
                const metrics=targets.map(target=>{
                    let total=0,lum=0,lit=0,saturated=0;
                    for(let y=Math.max(0,Math.floor(target.y-48));y<Math.min(height,target.y+48);y++)for(let x=Math.max(0,Math.floor(target.x-48));x<Math.min(width,target.x+48);x++){
                        const d=Math.hypot(x-target.x,y-target.y);if(d<8||d>48)continue;
                        const k=(y*width+x)*4,l=.2126*bytes[k]+.7152*bytes[k+1]+.0722*bytes[k+2];total++;lum+=l;if(l>12)lit++;if(Math.max(bytes[k],bytes[k+1],bytes[k+2])>=250)saturated++;
                    }
                    let excludedPixels=0,excludedMaxLum=0;
                    const exclusionRadius=spec.resolved&&target.hole?Math.min(32,.4*.01/spec.distance*height/(2*Math.tan(s.camera.fov*Math.PI/360))):0;
                    for(let y=Math.max(0,Math.floor(target.y-exclusionRadius));y<Math.min(height,target.y+exclusionRadius);y++)for(let x=Math.max(0,Math.floor(target.x-exclusionRadius));x<Math.min(width,target.x+exclusionRadius);x++){
                        if(Math.hypot(x-target.x,y-target.y)>exclusionRadius)continue;
                        const k=(y*width+x)*4;excludedPixels++;excludedMaxLum=Math.max(excludedMaxLum,.2126*bytes[k]+.7152*bytes[k+1]+.0722*bytes[k+2]);
                    }
                    return {...target,total,meanLum:lum/Math.max(1,total),lit,saturated,excludedPixels,excludedMaxLum};
                });
                return {png:s.renderer.domElement.toDataURL('image/png'),pixelHash,canvasLit,lensing:lens.lensingPass.enabled,metrics,state:river.supportRead(),error:gl.getError()};
            };
            const before=capture(true),after=capture(false);
            if(backdrop){s.scene.remove(backdrop);backdrop.geometry.dispose();backdrop.material.dispose();}
            return {width,height,before,after};
        }, spec);
        // Keep all completed pixels and diagnostics even when a guard fails.
        for(const key of ['before','after']){
            await writeFile(resolve(out,`${spec.name}-${key}.png`),Buffer.from(result[key].png.split(',')[1],'base64'));delete result[key].png;
        }
        report.cases.push({...spec,...result,passed:false});
        await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
        assert.deepEqual(result.after.state, result.before.state, 'same-frame draw cannot change texture, sources, allocation, frame, clock or uniforms');
        assert(result.after.state.finite);assert.equal(result.before.error,0);assert.equal(result.after.error,0);
        assert(result.before.canvasLit>100&&result.after.canvasLit>100,'completed captures contain actual scene light');
        assert.equal(result.after.state.count,mobile?9216:15376,'real high-quality particle allocation');
        const beforeHoles=result.before.metrics.filter(x=>x.hole),afterHoles=result.after.metrics.filter(x=>x.hole);
        assert.equal(afterHoles.length,spec.count);
        if(spec.count===0)assert.equal(result.before.pixelHash,result.after.pixelHash,'Sun-only control stays pixel-identical');
        for(let i=0;i<afterHoles.length;i++){
            assert(afterHoles[i].ndc.every(Number.isFinite)&&Math.abs(afterHoles[i].ndc[0])<1&&Math.abs(afterHoles[i].ndc[1])<1,'BH in actual viewport');
            assert(result.after.state.sources[afterHoles[i].index].drawnOwners>0,'visible hole receives real owned samples');
            // A broad guard against replacing missing strokes with a clipped
            // white patch. This is not a perceptual-quality score; inspect PNGs.
            assert(afterHoles[i].saturated<afterHoles[i].total*.5,'BH-region majority must not clip to saturation');
            if(spec.resolved){
                assert(result.after.lensing,'resolved horizon uses the production lens/optics path');
                assert(afterHoles[i].excludedPixels>100,'resolved physical-horizon interior has a meaningful pixel sample');
                assert(afterHoles[i].excludedMaxLum<=3&&beforeHoles[i].excludedMaxLum<=3,'sink correction cannot paint through the black horizon');
            }else assert(afterHoles[i].lit>beforeHoles[i].lit,'production sink fix restores missing BH-region strokes');
        }
        report.cases.at(-1).passed=true;
        console.log(JSON.stringify({name:spec.name,before:beforeHoles.map(x=>({lit:x.lit,meanLum:x.meanLum})),after:afterHoles.map(x=>({lit:x.lit,meanLum:x.meanLum,saturated:x.saturated}))}));
        await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));
    }
    assert.deepEqual(report.errors,[]);report.passed=true;
} catch(error) { report.errors.push(error.stack||String(error));report.passed=false;process.exitCode=1;console.error(error); }
finally { await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));await browser?.close();await server?.close(); }
