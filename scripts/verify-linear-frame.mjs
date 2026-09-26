import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root=resolve(process.argv[2]||'.'), out=resolve(process.argv[3]||'evidence/linear-frame');
await mkdir(out,{recursive:true});
const html=`<!doctype html><body><script type="module">
import * as THREE from '/node_modules/three/build/three.module.js';
import {linearFrame,renderLinearFrame} from '/src/render/linearFrame.js';
const renderer=new THREE.WebGLRenderer();renderer.setSize(128,96);renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;document.body.append(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,.1,10);camera.position.z=2;
const geometry=new THREE.PlaneGeometry(2,2), materials=[];
function frame(n,hdr){scene.clear();for(let i=0;i<n;i++){
 const m=new THREE.ShaderMaterial({uniforms:{light:{value:.9/n}},transparent:true,depthTest:true,depthWrite:false,blending:THREE.AdditiveBlending,
 vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:'uniform float light; void main(){gl_FragColor=vec4(vec3(light),1.);\\n#include <tonemapping_fragment>\\n#include <colorspace_fragment>\\n}'});
 scene.add(new THREE.Mesh(geometry,m));materials.push(m);
}renderer.setClearColor(0,1);renderer.clear();linearFrame.requested=hdr;
 const used=renderLinearFrame(renderer,()=>renderer.render(scene,camera));if(!used)renderer.render(scene,camera);
 const gl=renderer.getContext(),b=new Uint8Array(4);gl.readPixels(64,48,1,1,gl.RGBA,gl.UNSIGNED_BYTE,b);return [...b];}
const single=frame(1,false),encodedOverlap=frame(2,false),linearOverlap=frame(2,true);
const foreground=new THREE.Mesh(new THREE.PlaneGeometry(.4,.4),new THREE.MeshBasicMaterial({color:0xff0000}));foreground.position.z=1;foreground.renderOrder=10;scene.add(foreground);
const gl=renderer.getContext(),foregroundOnly=new Uint8Array(4),red=new Uint8Array(4);
for(const m of scene.children)if(m!==foreground)m.visible=false;renderer.render(scene,camera);gl.readPixels(64,48,1,1,gl.RGBA,gl.UNSIGNED_BYTE,foregroundOnly);
for(const m of scene.children)m.visible=true;renderLinearFrame(renderer,()=>renderer.render(scene,camera));
gl.readPixels(64,48,1,1,gl.RGBA,gl.UNSIGNED_BYTE,red);
renderer.setViewport(2,3,90,70);renderer.setScissor(4,5,80,60);renderer.setScissorTest(true);renderer.autoClear=false;
const saved=()=>JSON.stringify({target:renderer.getRenderTarget()===null,v:renderer.getCurrentViewport(new THREE.Vector4()).toArray(),s:[...gl.getParameter(gl.SCISSOR_BOX)],st:gl.isEnabled(gl.SCISSOR_TEST),auto:renderer.autoClear});
const before=saved();let threw=false;try{renderLinearFrame(renderer,()=>{throw new Error('injected');});}catch{threw=true;}
const restored=before===saved();
const rt=new THREE.WebGLRenderTarget(30,20);renderer.setRenderTarget(rt);const noNested=!renderLinearFrame(renderer,()=>{throw new Error('nested');});renderer.setRenderTarget(null);rt.dispose();
window.result={single,encodedOverlap,linearOverlap,foreground:[...red],foregroundOnly:[...foregroundOnly],restored,threw,noNested,stats:{...linearFrame},renderer:gl.getParameter(gl.VERSION)};
</script>`;
const server=await createServer({root,logLevel:'error',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'linear-frame-test',configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/__linear-test')){res.setHeader('Content-Type','text/html');res.end(html);}else next();});}}]});
await server.listen();const browser=await chromium.launch({args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const errors=[];
try{const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__linear-test`);await page.waitForFunction(()=>window.result);
const r=await page.evaluate(()=>window.result);await writeFile(`${out}/report.json`,JSON.stringify({browser:await browser.version(),...r,errors},null,2));
assert.equal(errors.length,0);assert(r.single[0]>20&&r.single[0]<250);assert.equal(r.encodedOverlap[0],255);
assert(Math.abs(r.single[0]-r.linearOverlap[0])<=2,'Combined light must match the same total drawn once');
assert(r.foreground[0]>100&&r.foreground.slice(0,3).every((v,i)=>Math.abs(v-r.foregroundOnly[i])<=2),'Opaque foreground occludes the linear background');
assert(r.threw&&r.restored&&r.noNested,'Failure and existing-target paths preserve the caller state');
console.log('PASS linear-frame overlap, foreground, exception restoration and composer ownership',JSON.stringify(r));
}finally{await browser.close();await server.close();}
