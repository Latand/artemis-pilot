// Test-only full-layer hooks. No render layer is removed or reduced.
import assert from 'node:assert/strict';

const readHook = `
window.__pairedRadianceRead=()=>{
 const texels=new Float32Array(TEXW*TEXW*4);renderer.readRenderTargetPixels(rtA,0,0,TEXW,TEXW,texels);
 const counts=new Array(uniformsShared.uSinkNB.value).fill(0),drawnCounts=counts.slice();let ambient=0,drawnAmbient=0,invalidOwners=0;
 const drawable=river.style===2?dots:lines,drawRange=drawable.geometry.drawRange;
 const drawnStart=Math.floor(drawRange.start/(river.style===2?1:IPP));
 const drawnCount=Math.min(river.count,Math.floor(drawRange.count/(river.style===2?1:IPP)));
 for(let i=0;i<TEXW*TEXW;i++){const owner=Math.round(texels[i*4+3])-1,drawn=i>=drawnStart&&i<drawnStart+drawnCount;
  if(owner<0){ambient++;if(drawn)drawnAmbient++;}else if(owner<counts.length){counts[owner]++;if(drawn)drawnCounts[owner]++;}else invalidOwners++;}
 const bytes=new Uint8Array(texels.buffer);let raw='';for(let i=0;i<bytes.length;i+=32768)raw+=String.fromCharCode(...bytes.subarray(i,i+32768));
 const sources=bodyVals.slice(0,uniformsShared.uSinkNB.value).map((b,i)=>({index:i,
  name:i>=riverStarUniformOffset?(riverStarPickRefs[i-riverStarUniformOffset]?.id||riverStarPickRefs[i-riverStarUniformOffset]?.name):i>=3+PL.length?'placed-hole:'+String(i-3-PL.length):['Earth','Moon','Sun',...PL.map(p=>p.name)][i],
  position:[b.x+smoothCenter.x,b.y+smoothCenter.y,b.z+smoothCenter.z],residual:[b.x,b.y,b.z],coefficient:b.w,
  sink:sinkVals[i],soi:soiVals[i],hole:holeVals[i],rs:rsVals[i],color:colorVals[i].toArray(),owners:counts[i],drawnOwners:drawnCounts[i],
  halo:uniformsShared.uHalo.value[i].toArray().slice(0,3),inkGain:uniformsShared.uHalo.value[i].w??1,
  cdfShare:uniformsShared.uHalo.value[i].z-(i?uniformsShared.uHalo.value[i-1].z:0)}));
 return {sources,ambient,drawnAmbient,drawnStart,drawnCount,drawVisible:drawable.visible,invalidOwners,finite:texels.every(Number.isFinite),readError:renderer.getContext().getError(),textureBase64:btoa(raw),
  count:river.count,drawCount:river.drawCount,frame:river.frame,computeEvery:river.computeEvery,skippedCompute:river.skippedCompute,
  dispatch:window.__pairedRadianceDispatch??null,dtVis:river.dtVis,center:smoothCenter.toArray(),radius:smoothR,
  textureCenter:textureCenter.toArray(),sourceRelative:river.sourceRelativeHalos,presentationGain:river.presentationGain??1,
  uniforms:{vRef:uniformsShared.uVRef.value,loadShed:uniformsShared.uLoadShed.value,planeBias:uniformsShared.uPlaneBias.value,
    de:uniformsShared.uDE.value,origin:uniformsShared.uOrigin.value.toArray(),centerShift:uniformsShared.uCenterShift.value.toArray(),
    localFocus:uniformsShared.uLocalFocus.value,timeRate:uniformsShared.uTimeRate.value,opacity:uniformsShared.uOpacity.value,
    phase:uniformsShared.uPhase.value,style:uniformsShared.uStyle.value,pixelRatio:uniformsShared.uPixelRatio.value,
    dtSim:uniformsShared.uDtSim.value,respawn:uniformsShared.uRespawn.value,tick:uniformsShared.uTick.value,
    frameVelocity:uniformsShared.uFrameVel.value.toArray(),frameWeight:uniformsShared.uFrameW.value}};
};`;
function once(source, token, replacement) {
  assert.equal(source.split(token).length, 2, `Full radiance hook changed: ${token}`);
  return source.replace(token, replacement);
}
export function transform(source, id) {
  id = id.replaceAll('\\', '/').split('?')[0];
  if (id.endsWith('/src/render/bodySurfaceMaterial.js'))
    return source + '\nexport const pairedSurfaceQueue=()=>({pending:pending.size,inFlight:!!inFlight});\n';
  if (id.endsWith('/src/universe/athygTier1.js')) {
    // Hold only NEW tile requests after a fixed normal-entry history. Motion,
    // residual uploads, already-loaded rows and production draws remain live.
    source = once(source, '    const toRequest = [];', `
    if (window.__pairedTier1Remaining <= 0) return;
    window.__pairedTier1Remaining--; window.__pairedTier1Updates++;
    const toRequest = [];`);
    return source + `
export async function pairedTier1Rows() {
  if (!state || state.pending.size) throw new Error('Catalog row hash requires settled tiles');
  const tiles = Array.from(state.loaded.entries()).filter(([,loaded])=>loaded).map(([id])=>id);
  const chunks=[]; let rows=0, bytes=0;
  for(const id of tiles) {
    const count=state.manifest.tiles[id][1],tile=state.tileData.get(id);
    if(count && !tile) throw new Error('Loaded tile missing from CPU row cache: '+id);
    const identity=new Uint32Array([id,count]);
    for(const value of (count?[identity,tile.positions,tile.mag,tile.ci]:[identity])) {
      const chunk=new Uint8Array(value.buffer,value.byteOffset,value.byteLength);chunks.push(chunk);bytes+=chunk.byteLength;
    }
    rows+=count;
  }
  const all=new Uint8Array(bytes);let offset=0;
  for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}
  const digest=await crypto.subtle.digest('SHA-256',all);
  return {tiles,rows,bytes,hash:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join(''),
    updates:window.__pairedTier1Updates,remaining:window.__pairedTier1Remaining};
}
`;
  }
  if (id.endsWith('/src/river.js')) {
    const entry = 'export function updateRiver(dtSim, fB, earthV, moonV, sunPosV, plPos, dtReal = 0, presentation = null) {';
    source = once(source, entry, entry + `\nif(window.__pairedRadianceFixture){
      ACTIVE_STARS.splice(0,ACTIVE_STARS.length,...window.__pairedRadianceFixture.sources);
      dtSim=window.__pairedRadianceFixture.advance;
    }`);
    const dispatch = 'renderer.setRenderTarget(rtB);\n            renderer.render(computeScene, computeCam);';
    return once(source, dispatch, 'window.__pairedRadianceDispatch={dt:uniformsShared.uDtSim.value,respawn:uniformsShared.uRespawn.value,tick:uniformsShared.uTick.value,frame:river.frame};' + dispatch) + readHook;
  }
  if (!id.endsWith('/src/main.js')) return null;
  source = once(source, 'const firstFrameT0 = perfStart();',
    'window.__pairedTier1Remaining=0;window.__pairedTier1Updates=0;G.t=0;G.paused=true;G.dead=true;G.observerMode=true;G.gr=true;G.warp=1;grB=1;resetEphem();clock.getDelta=()=>1/60;\nconst firstFrameT0 = perfStart();');
  source = once(source, 'renderer.setAnimationLoop(frame);', '// QA: real frames delivered serially on timer tasks.');
  return source + `
const pairedReadbackPixel=new Uint8Array(4);
window.__pairedFrame=(synchronize=true)=>{
  clock.getDelta=()=>1/60;lastMobileFrame=-Infinity;grB=1;window.__pairedRadianceDispatch=null;
  const start=performance.now();frame();const cpuMs=performance.now()-start;const gl=renderer.getContext();
  let finishMs=0,readbackMs=0;
  if(synchronize){
    const finishStart=performance.now();gl.finish();finishMs=performance.now()-finishStart;
    const readbackStart=performance.now();gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pairedReadbackPixel);
    readbackMs=performance.now()-readbackStart;
  }
  const frameAndFinishMs=performance.now()-start;
  // Telemetry is outside frame timing, with identical scalar reads per source.
  return {cpuMs,finishMs,readbackMs,frameAndFinishMs,frameNo,gpuSynchronized:synchronize,
    gpu:{contextLost:gl.isContextLost(),losses:renderContext.losses,restores:renderContext.restores,error:gl.getError(),defaultFramebuffer:gl.getParameter(gl.FRAMEBUFFER_BINDING)===null},
    quality:{...renderQuality},
    river:{enabled:river.enabled,visible:river.visible,count:river.count,drawCount:river.drawCount,
      frame:river.frame,computeEvery:river.computeEvery,computeEveryAdaptive:river.computeEveryAdaptive,
      skippedCompute:river.skippedCompute,renderShed:river.renderShed,sourceCount:river.sourceCount,
      starSources:river.starSources,sinkSources:river.sinkSources,dtVis:river.dtVis,dtAccum:river.dtAccum,
      vRefCadence:river.vRefCadence,vRefRefreshed:river.vRefRefreshed,dispatch:window.__pairedRadianceDispatch}};
};
window.__pairedWorkload=()=>({frameNo,beltCursor,kuiperCursor,nearVisualReady,
  nearFieldCadence:cam.dist>LY_SCENE*.2?'cosmic':'every-frame',
  minor:Object.fromEntries(['belt','kuiper','curated','oort'].map(k=>[k,{capacity:minorRenderers[k].capacity,
    elementCount:minorSwarms[k].length/6,first:Array.from(minorSwarms[k].slice(0,12)),last:Array.from(minorSwarms[k].slice(-12))}]))});
window.__pairedPost=()=>({bloom:!!bloomPass.enabled,composer:!!composer,lensing:!!lensingPass.enabled});
`;
}

// These functions are serialized into the browser; do not use Node bindings.
export function initializeDocument() {
  window.__pairedTier1Remaining = 0; window.__pairedTier1Updates = 0;
  Date.now = () => Date.UTC(2026, 9, 3, 12);
  if (location.protocol === 'http:') {
    localStorage.clear(); localStorage.setItem('ap_introSeen', '1');
    localStorage.setItem('ap_uiMode', 'observe'); localStorage.setItem('ap_perf', '0');
  }
  window.__pairedLongTasks = [];
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    window.__pairedObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) __pairedLongTasks.push({ startTime: entry.startTime, duration: entry.duration });
    });
    __pairedObserver.observe({ type: 'longtask', buffered: true });
  }
}
export async function initializeQA({ fixture, spec, catalogSetupUpdates }) {
  const [scene, state, constants, holes, bodies, surfaces, galaxy, epoch, catalog, tier1, field, volume, galaxies, tides, sky, fieldMath] = await Promise.all([
    import('/src/scene.js'), import('/src/state.js'), import('/src/constants.js'), import('/src/blackholes.js'),
    import('/src/bodies.js'), import('/src/render/bodySurfaceMaterial.js'), import('/src/universe/galaxy.js'),
    import('/src/epoch.js'), import('/src/render/catalogStars.js'), import('/src/universe/athygTier1.js'),
    import('/src/render/resolvedFieldStars.js'), import('/src/render/galaxyVolume.js'),
    import('/src/render/galaxyPopulationRender.js'), import('/src/render/mergerTidesRender.js'), import('/src/realSky.js'),
    import('/src/universe/resolvedField.js'),
  ]);
  window.pairedQA = { scene, state, G: state.G, constants, holes, bodies, surfaces, galaxy, epoch, catalog, tier1, field, volume, galaxies, tides, sky, fieldMath };
  window.__pairedRadianceFixture = { sources: spec.subject === 'proxima' ? fixture.sources : [], advance: spec.rate / 60 };
  state.setSimTime(spec.subject === 'proxima' ? fixture.time : 0);
  Object.assign(state.G, { paused: true, dead: true, observerMode: true, landed: null, gr: true,
    focus: spec.subject === 'proxima' ? 'star:0' : 'free', warp: spec.rate || 1 });
  holes.clearBlackHoles(); scene.cam.distTarget = null;
  if (spec.subject === 'proxima') {
    for (const record of fixture.curated) {
      const star = constants.STARS.find(star => star.name === record.name);
      if (star) Object.assign(star, { x: record.x, y: record.y, z: record.z });
    }
    const host = fixture.sources.find(star => star.name === 'PROXIMA');
    scene.cam.dist = fixture.distLy * constants.LY_SCENE; scene.cam.yaw = fixture.yaw; scene.cam.pitch = fixture.pitch;
    scene.cam.tgt.set(host.x * constants.K, host.z * constants.K, -host.y * constants.K);
  } else if (spec.subject === 'sun') {
    scene.cam.dist = 40000; scene.cam.yaw = Math.PI / 2; scene.cam.pitch = 0;
    scene.cam.tgt.copy(bodies.sunCore.position).add({ x: 22000, y: 0, z: 180000 });
  } else {
    holes.addBlackHole(200000, 0, 30, 1, 2, true, null, 0, 0, 300000, 3);
    scene.cam.dist = 40; scene.cam.yaw = Math.PI / 2; scene.cam.pitch = 0;
    scene.cam.tgt.set(bodies.earthG.position.x + state.BH.sx[0], state.BH.sy[0], bodies.earthG.position.z + state.BH.sz[0]);
  }
  window.__pairedTier1Remaining = catalogSetupUpdates;
  const gl = scene.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
  return { mobile: scene.renderQuality.mobile, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    contextAttributes: gl.getContextAttributes(), glVersion: gl.getParameter(gl.VERSION),
    longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
}
export function readiness() {
  const q = pairedQA;
  const surfaces = q.surfaces.pairedSurfaceQueue(), catalog = q.catalog.catalogStarsStatus(), tier1 = q.tier1.tier1Stats();
  const field = q.field.resolvedFieldStatus(), volume = q.volume.galaxyVolumeStats(), galaxy = q.galaxies.galaxyPopulationStatus(), sky = q.sky.realSkyStatus();
  const tide=q.tides.mergerTidesStatus();
  const assetReady= !surfaces.pending && !surfaces.inFlight && catalog.loaded && !catalog.error &&
    tier1.initialized && window.__pairedTier1Remaining === 0 && tier1.tilesLoaded > 0 && !tier1.pending && !tier1.tileErrors && !tier1.residualDirtyGroups &&
    volume.mapsReady && !volume.mapError && galaxy.ready && !galaxy.building && !galaxy.error && (!tide.started || tide.ready) && !tide.error && sky.loaded && !sky.error;
  return {ready:assetReady&&field.enabled&&field.idle,assetReady,
    surfaces, catalog, tier1, field, volume, galaxy, sky, tide,
    catalogPrefix:{updates:window.__pairedTier1Updates,remaining:window.__pairedTier1Remaining} };
}
export async function readState() {
  const q = pairedQA, { cam, camera, renderer } = q.scene, gl = renderer.getContext();
  const geometries = new Set(), materials = new Set(); let objects = 0;
  q.scene.scene.traverse(object => { objects++; if (object.geometry) geometries.add(object.geometry.uuid);
    for (const material of (Array.isArray(object.material) ? object.material : [object.material]).filter(Boolean)) materials.add(material.uuid); });
  const field = q.field.resolvedFieldStatus(), galaxy = q.galaxies.galaxyPopulationStatus(), volume = q.volume.galaxyVolumeStats();
  // Exclude elapsed build times/counters and time-based scheduling budgets;
  // compare their concrete output counts, selected quality and readiness.
  const fieldWork = Object.fromEntries(['enabled', 'stars', 'mLim', 'staging', 'budget', 'epochs', 'meshes', 'idle'].map(key => [key, field[key]]));
  const { buildMs: galaxyBuildMs, ...galaxyWork } = galaxy;
  const { renders, mapsMs, budget, invalidations, ...volumeWork } = volume;
  const { ms: tidesMs, ...tidesWork } = q.tides.mergerTidesStatus();
  if (tidesWork.linearPass) { const { renders, ...pass } = tidesWork.linearPass; tidesWork.linearPass = pass; }
  { const { renders, ...frame } = tidesWork.linearFrame; tidesWork.linearFrame = frame; }
  const river = __pairedRadianceRead();
  return { focus: q.G.focus, t: q.G.t, paused: q.G.paused, observerMode: q.G.observerMode, gr: q.G.gr, warp: q.G.warp,
    seed: q.galaxy.getSeed(), epoch: q.epoch.getEpochMs(), workload: __pairedWorkload(),
    quality: { ...q.scene.renderQuality }, dpr: renderer.getPixelRatio(),
    size: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    context: { lost: gl.isContextLost(), losses: q.scene.renderContext.losses, restores: q.scene.renderContext.restores, error: gl.getError() },
    ship: [q.G.x, q.G.y, q.G.z, q.G.vx, q.G.vy, q.G.vz],
    camera: { distance: cam.dist, yaw: cam.yaw, pitch: cam.pitch, target: cam.tgt.toArray(), position: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(), fov: camera.fov },
    sceneObjects: { objects, geometries: geometries.size, materials: materials.size },
    render: { ...renderer.info.memory, programs: renderer.info.programs.length },
    maps: { night: q.bodies.shaderTick.earthUniforms.uHasNight.value, clouds: q.bodies.shaderTick.earthUniforms.uHasClouds.value,
      moon: !!q.bodies.moon.material.map, realSky: !!q.sky.realSkyStatus().loaded, galaxyBackdrop: !!q.bodies.galaxyBackdrop },
    layers: { catalog: q.catalog.catalogStarsStatus(), tier1: q.tier1.tier1Stats(), catalogRows: await q.tier1.pairedTier1Rows(), field: fieldWork, galaxy: galaxyWork, volume: volumeWork,
      tides: tidesWork, surfaceQueue: q.surfaces.pairedSurfaceQueue() },
    post: __pairedPost(), river };
}
