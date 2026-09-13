import { chromium } from 'playwright';
import { createServer } from 'vite';
import { writeFile } from 'node:fs/promises';

const server = await createServer({server:{host:'127.0.0.1',port:5180,strictPort:true}});
await server.listen();
const browser = await chromium.launch({headless:true});
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.route('**/__render_test', route => route.fulfill({contentType:'text/html',body:'<!doctype html><title>Rendering regression</title>'}));
    await page.goto('http://127.0.0.1:5180/__render_test');
    const result = await page.evaluate(async () => {
        const THREE = await import('/node_modules/three/build/three.module.js');
        const {createTileGroups} = await import('/src/render/athygStars.js');
        const {PC_KM, K} = await import('/src/constants.js');
        const renderer = new THREE.WebGLRenderer();
        renderer.setSize(64,64); renderer.setClearColor(0);
        const target = new THREE.WebGLRenderTarget(64,64);
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(48,1,0.1,1e13);
        const [group] = createTileGroups(scene,{tiles:[[0,1]]});
        const g = group.geometry, m = group.mesh.material;
        g.attributes.position.setXYZ(0,0,0,-10 * PC_KM * K);
        g.attributes.color.setXYZ(0,1,1,1);
        g.attributes.teffK.setX(0,5772); g.setDrawRange(0,1);
        m.uniforms.uMinPx.value = 8; m.uniforms.uMaxPx.value = 8;
        const pixels = new Uint8Array(64*64*4);
        function sample() {
            renderer.setRenderTarget(target); renderer.render(scene,camera);
            renderer.readRenderTargetPixels(target,0,0,64,64,pixels);
            let sum = 0; for(let i=0;i<pixels.length;i+=4) sum += pixels[i];
            return sum;
        }
        const flux = [];
        for(const mag of [8,10.5,13]) {
            g.attributes.absMag.setX(0,mag); g.attributes.absMag.needsUpdate=true;
            flux.push(sample());
        }
        g.attributes.absMag.setX(0,8); g.attributes.absMag.needsUpdate=true;
        g.attributes.hidden.setX(0,1); g.attributes.hidden.needsUpdate=true;
        const hiddenFlux = sample();
        scene.remove(group.mesh);
        const {initRealSky,realSkyReady} = await import('/src/realSky.js');
        const sky = new THREE.Group(); scene.add(sky); initRealSky(sky); await realSkyReady();
        let point;
        sky.traverse(o => { if(o.isPoints && !point) point=o; else if(o.isPoints || o.isSprite || o.isLine) o.visible=false; });
        if(!point) throw new Error('Catalog sky missing');
        const magnitudes=point.geometry.attributes.magnitude;
        let bright=0;
        if(magnitudes) for(let i=1;i<magnitudes.count;i++) if(magnitudes.getX(i)<magnitudes.getX(bright)) bright=i;
        point.geometry.setDrawRange(bright,1);
        const dir = new THREE.Vector3().fromBufferAttribute(point.geometry.attributes.position,bright).normalize();
        camera.position.set(0,0,0); camera.lookAt(dir);
        const clearSkyFlux = sample();
        const blocker = new THREE.Mesh(new THREE.SphereGeometry(1,32,24),new THREE.MeshBasicMaterial({color:0}));
        blocker.position.copy(dir).multiplyScalar(3); scene.add(blocker);
        const occludedFlux = sample();
        const findings=[];
        if(!(flux[0] > 5*flux[1] && flux[1] > 5*flux[2] && flux[2] >= 0)) findings.push('Faint stellar flux has a floor or loses magnitude ordering');
        if(hiddenFlux!==0) findings.push('Hidden catalog row emits light');
        if(!(clearSkyFlux>0 && occludedFlux===0)) findings.push('Catalog sky shines through opaque body');
        // Compile and exercise the Earth shaders in an isolated, translated scene.
        const {earthSurfaceMaterial, atmosphereMaterial, photosphereMaterial} = await import('/src/render/planetAppearance.js');
        const map = new THREE.DataTexture(new Uint8Array([30,90,160,255]),1,1);
        map.colorSpace=THREE.SRGBColorSpace; map.needsUpdate=true;
        scene.clear(); camera.position.set(0,0,4); camera.lookAt(0,0,0); camera.far=100; camera.updateProjectionMatrix();
        const planetMat=earthSurfaceMaterial(map,map,map,1);
        planetMat.uniforms.sunDir.value.set(1,0,1).normalize();
        planetMat.uniforms.uCamera.value.copy(camera.position);
        const globe=new THREE.Mesh(new THREE.SphereGeometry(1,48,32),planetMat); scene.add(globe);
        const planetFlux=sample();
        const airMat=atmosphereMaterial(); airMat.uniforms.uRadius.value=1;
        airMat.uniforms.sunDir.value.copy(planetMat.uniforms.sunDir.value); airMat.uniforms.uCamera.value.copy(camera.position);
        scene.add(new THREE.Mesh(new THREE.SphereGeometry(1+100/6371,48,32),airMat));
        const atmosphereFlux=sample();
        if(!(planetFlux>0 && atmosphereFlux>0)) findings.push('Earth shaders produce an empty frame');
        scene.clear(); const solarMat=photosphereMaterial(0xffffff);
        scene.add(new THREE.Mesh(new THREE.SphereGeometry(1,48,32),solarMat)); sample();
        const center=pixels[(32*64+32)*4], limb=pixels[(32*64+49)*4];
        if(!(center>limb && limb>0)) findings.push('Photosphere limb darkening missing');
        const {stellarPointMarker} = await import('/src/render/stellarAppearance.js');
        scene.clear(); camera.position.set(0,0,0); camera.lookAt(0,0,-1);
        camera.near=0.02; camera.far=1e8; camera.updateProjectionMatrix();
        const marker=stellarPointMarker(null); marker.position.z=-1e12; marker.material.size=8; scene.add(marker);
        const nearTierLeak=sample();
        camera.near=1e8; camera.far=1e14; camera.updateProjectionMatrix();
        const farTierFlux=sample();
        if(!(nearTierLeak===0 && farTierFlux>0)) findings.push('Stellar point must render only in its correct depth tier');
        target.dispose(); renderer.dispose();
        return {flux,hiddenFlux,clearSkyFlux,occludedFlux,planetFlux,atmosphereFlux,solarCenter:center,solarLimb:limb,nearTierLeak,farTierFlux,findings};
    });
    result.errors=errors;
    console.log(JSON.stringify(result,null,2));
    if(process.argv[2]) await writeFile(process.argv[2],JSON.stringify(result,null,2)+'\n');
    if(result.findings.length || errors.length) process.exitCode=1;
} finally {
    await browser.close(); await server.close();
}
