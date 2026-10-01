import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile, mkdir } from 'node:fs/promises';
import { transformCelestialSource } from './celestial-detail-fixtures.mjs';
const out=process.argv[2]||'evidence/bh-river-probe'; await mkdir(out,{recursive:true});
const server=await createServer({configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'probe',enforce:'pre',resolveId(id){if(id==='virtual:galaxy-preview') return '\0off';},load(id){if(id==='\0off') return 'export default null;';},transform:transformCelestialSource}]}); await server.listen();
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:process.env.DEVICE==='mobile'?{width:390,height:700}:{width:1000,height:700},isMobile:process.env.DEVICE==='mobile',hasTouch:process.env.DEVICE==='mobile'});page.setDefaultTimeout(120000);page.on('pageerror',e=>console.error(e));
await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/?focus=earth&dist=25&tier1=0&realsky=0&field=0&galaxies=0&galaxyvol=0&galaxy=0&compile=0&bloom=0&np=64`);
await page.waitForFunction(()=>window.__AP_READY && window.__celestialFrame);
await page.evaluate(async()=>{window.s=await import('/src/scene.js');window.st=await import('/src/state.js');window.bh=await import('/src/blackholes.js');window.e=await import('/src/ephemeris.js');window.c=await import('/src/constants.js');window.h=await import('/src/holeOptics.js');window.l=await import('/src/lensing.js');document.getElementById('intro').style.display='none';st.G.paused=true;st.G.gr=true;st.G.predict=false;await window.__celestialEnsureLensing();});
for(const dist of [80,300,1000,10000,100000]) {
 const result=await page.evaluate(async dist=>{bh.clearBlackHoles();bh.addBlackHole(200000,0,10,0,0,true);st.G.focus='bh:0';s.cam.dist=dist;s.cam.distTarget=null;s.cam.pitch=.25;s.cam.yaw=.7;window.__celestialFrame();s.cam.tgt.copy(bh.BH_META[0].g.position);for(let i=0;i<12;i++)window.__celestialFrame();s.renderer.getContext().finish();return {png:s.renderer.domElement.toDataURL(),state:{dist,cam:s.camera.position.toArray(),rs:st.BH.rs[0],uDistance:bh.BH_META[0].optics.shadow.material.uniforms.uDistance.value,river:window.__river,lensing:l.lensingPass.enabled}};},dist);
 await writeFile(`${out}/dist-${dist}.png`,Buffer.from(result.png.split(',')[1],'base64'));delete result.png;await writeFile(`${out}/dist-${dist}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
await page.screenshot({path:`${out}/app.png`});await browser.close();await server.close();
