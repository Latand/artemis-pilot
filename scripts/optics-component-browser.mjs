// Browser-evaluated functions. Loaded only by the diagnostic runner after an
// explicit --run. The --validate path never imports Playwright or starts Vite.
export async function initializePage(label) {
    const [scene,input,state,surfaces,bodies,galaxy,epoch,galaxyRender,volume,tides,field] = await Promise.all([
        import('/src/scene.js'),import('/src/input.js'),import('/src/state.js'),import('/src/render/bodySurfaceMaterial.js'),
        import('/src/bodies.js'),import('/src/universe/galaxy.js'),import('/src/epoch.js'),import('/src/render/galaxyPopulationRender.js'),
        import('/src/render/galaxyVolume.js'),import('/src/render/mergerTidesRender.js'),import('/src/render/resolvedFieldStars.js')]);
    window.componentQA={scene,input,G:state.G,surfaces,bodies,galaxy,epoch,galaxyRender,volume,tides,field,label};
    const gl=scene.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');
    window.__componentIdentity={token:crypto.randomUUID(),generation:0,contextLost:false};
    scene.renderer.domElement.addEventListener('webglcontextlost',()=>{__componentIdentity.contextLost=true;__componentIdentity.generation++;});
    scene.renderer.domElement.addEventListener('webglcontextrestored',()=>{__componentIdentity.generation++;});
    return { mobile:scene.renderQuality.mobile,gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
        longTaskSupported:PerformanceObserver.supportedEntryTypes.includes('longtask'),identity:{...__componentIdentity} };
}
export async function configureFixture(fixture) {
    const q=componentQA;
    const [bh,e,c,lens]=await Promise.all([import('/src/blackholes.js'),import('/src/ephemeris.js'),import('/src/constants.js'),import('/src/lensing.js')]);
    const sat=c.PL.findIndex(p=>p.name==='SATURN');
    q.input.setFocus(sat);
    bh.clearBlackHoles();bh.addBlackHole(e.eph.plX[sat]-150000,e.eph.plY[sat]-100000,50000,0,0,true,null,1,0,e.eph.plZ[sat],0);
    q.optics={bh,e,c,lens,sat};await __componentEnsureLensing();
    q.input.setFocus(fixture.focus);q.G.gr=false;q.scene.cam.tgt.copy(q.bodies.plGroups[sat].position);q.scene.cam.tgt.x-=75;
    q.scene.cam.dist=fixture.distance;q.scene.cam.distTarget=null;q.scene.cam.yaw=fixture.yaw;q.scene.cam.pitch=fixture.pitch;
}
export function readState() {
    const q=componentQA,{cam,camera,renderer}=q.scene,geometries=new Set(),materials=new Set();let objects=0;
    q.scene.scene.traverse(o=>{objects++;if(o.geometry)geometries.add(o.geometry.uuid);for(const m of(Array.isArray(o.material)?o.material:[o.material]).filter(Boolean))materials.add(m.uuid);});
    const u=q.optics?.lens.lensingPass.uniforms;
    const ring=q.optics && q.bodies.plGroups[q.optics.sat].children.find(o=>o.geometry?.type==='RingGeometry');
    const m=ring?.material,t=m?.map;
    const map=t?{width:t.image?.width,height:t.image?.height,minFilter:t.minFilter,magFilter:t.magFilter,generateMipmaps:t.generateMipmaps,
        anisotropy:t.anisotropy,wrapS:t.wrapS,wrapT:t.wrapT,flipY:t.flipY,colorSpace:t.colorSpace,matrix:t.matrix.toArray(),
        source:(t.image?.currentSrc||t.image?.src)?new URL(t.image.currentSrc||t.image.src,location.href).pathname:'procedural-native',version:t.version}:null;
    return {identity:{...__componentIdentity},focus:q.G.focus,t:q.G.t,paused:q.G.paused,seed:q.galaxy.getSeed(),epoch:q.epoch.getEpochMs(),workload:__componentWorkload(),
        sceneObjects:{objects,geometries:geometries.size,materials:materials.size},
        background:{galaxy:q.galaxyRender.galaxyPopulationStatus(),volume:q.volume.galaxyVolumeStats(),tides:q.tides.mergerTidesStatus(),field:q.field.resolvedFieldStatus(),surfaceQueue:q.surfaces.componentSurfaceQueue()},
        ship:[q.G.x,q.G.y,q.G.z,q.G.vx,q.G.vy,q.G.vz],
        camera:{distance:cam.dist,yaw:cam.yaw,pitch:cam.pitch,target:cam.tgt.toArray(),position:camera.position.toArray(),quaternion:camera.quaternion.toArray(),fov:camera.fov,near:camera.near,far:camera.far},
        quality:{...q.scene.renderQuality,dpr:renderer.getPixelRatio(),width:renderer.domElement.width,height:renderer.domElement.height,bloom:!!q.scene.composer},
        optics:u?{lensEnabled:q.optics.lens.lensingPass.enabled,lensCount:u.uN.value,hole:q.optics.bh.BH_META[0].g.position.toArray(),saturn:q.bodies.plGroups[q.optics.sat].position.toArray(),
            saturnMap:q.bodies.plSurfaces[q.optics.sat].material.map?.image?.width||0,
            uniforms:{uN:u.uN.value,uHasDepth:u.uHasDepth.value,uNear:u.uNear.value,uFar:u.uFar.value,uDist:Array.from(u.uDist.value),uC:u.uC.value.map(p=>p.toArray()),uT2:Array.from(u.uT2.value),uAspect:u.uAspect.value}}:null,
        ring:map?{map,geometry: {...ring.geometry.parameters},localMatrix:ring.matrix.toArray(),modelViewMatrix:ring.modelViewMatrix.toArray(),
            material:{opacity:m.opacity,alphaTest:m.alphaTest,transparent:m.transparent,depthWrite:m.depthWrite,blending:m.blending}}:null,
        resources:{...renderer.info.memory,programs:renderer.info.programs.map(p=>p.id)},
        maps:{night:q.bodies.shaderTick.earthUniforms.uHasNight.value,clouds:q.bodies.shaderTick.earthUniforms.uHasClouds.value,moon:!!q.bodies.moon.material.map}};
}
export function inspectNativePrograms() {
    if (__componentState.phase!=='post-timing') throw new Error('Program inspection before both timing orders');
    const gl=componentQA.scene.renderer.getContext();
    const programs=componentQA.scene.renderer.info.programs.map(p=>({id:p.id,cacheKey:p.cacheKey,
        linked:gl.getProgramParameter(p.program,gl.LINK_STATUS),log:gl.getProgramInfoLog(p.program),
        shaders:gl.getAttachedShaders(p.program).map(s=>({type:gl.getShaderParameter(s,gl.SHADER_TYPE),source:gl.getShaderSource(s),compiled:gl.getShaderParameter(s,gl.COMPILE_STATUS),log:gl.getShaderInfoLog(s)}))}));
    return {materialFragment:componentQA.optics.lens.lensingPass.material.fragmentShader,programs,contextLost:gl.isContextLost(),error:gl.getError()};
}
export async function preparePixelFixture() {
    if (__componentState.phase!=='post-timing') throw new Error('Pixel preparation before timing complete');
    window.qa={bloom:false,s:await import('/src/scene.js'),st:await import('/src/state.js'),b:await import('/src/bodies.js'),
        bh:await import('/src/blackholes.js'),c:await import('/src/constants.js'),e:await import('/src/ephemeris.js'),
        tde:await import('/src/tdeVisuals.js'),hole:await import('/src/holeOptics.js'),lens:await import('/src/lensing.js'),
        ring:componentQA.label==='A'?null:await import('/src/render/ringSamplingDepth.js'),enc:await import('/src/bhEncounters.js')};
    qa.sat=qa.c.PL.findIndex(p=>p.name==='SATURN');
    qa.st.G.paused=true;qa.st.G.gr=false;qa.st.G.predict=false;qa.st.G.focus='free';
    qa.bh.clearBlackHoles();qa.bh.addBlackHole(qa.e.eph.plX[qa.sat]-150000,qa.e.eph.plY[qa.sat]-100000,50000,0,0,true,null,1,0,qa.e.eph.plZ[qa.sat],0);
    await window.__componentEnsureLensing();
    if(window.__componentPixelFrame)window.__celestialFrame=window.__componentPixelFrame;
    for(let i=0;i<8;i++)window.__celestialFrame();
    qa.initialHole={x:qa.st.BH.x[0],y:qa.st.BH.y[0]};
    return {epoch:Date.now(),viewport:{width:innerWidth,height:innerHeight},nativeInitializationFrames:8,
        frameSource:'Exact existing pixel fixture helper: lastMobileFrame=-Infinity; frameNo=11; frame()',
        ringSource:qa.ring?'native module':'native absent; no fabricated module'};
}
