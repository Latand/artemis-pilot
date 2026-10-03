import { G, WORLD, BH, GS, keys, setSimTime, simTimeLo, advanceSimTime } from './state.js';
import { PL, K } from './constants.js';
import { eph, snapshotEphem, loadEphemSnapshot } from './ephemeris.js';
import { cam, camera, viewportSize } from './scene.js';
import { AP, apOff } from './autopilot.js';
import { REL, relResetState } from './relState.js';
import { clearBlackHoles, addBlackHole } from './blackholes.js';
import { serializeEncounterState, restoreEncounterState } from './bhEncounters.js';
import { serializeNebulae, restoreNebulae } from './render/nebulae.js';
import { invalidateGasDynamics } from './universe/gasDynamics.js';
import { clearTrail, pushTrail, computePrediction } from './trails.js';
import { hideBanner } from './hud.js';
import { serializeLog, restoreLog } from './discoveryLog.js';
import { shipVisuals } from './shipVisuals.js';
import { resetDrive } from './curvatureDrive.js';
import { setPaused, setWarp, onTimeControl, jumpActive, cancelTimeJump } from './timeCtl.js';
import { setUiMode } from './uiMode.js';
import { jupiterEncounterSeed, createPlaybackPlan, playbackStep, playbackPhase, playheadAtSimulation, encounterCameraDistance } from './scenarioPlaybackMath.js';
import './scenarioPlayback.css';

let session = null, restartWorld = null, panel = null;
let cameraRevision = 0;
export function scenarioCameraRevision() { return cameraRevision; }
const clone = value => structuredClone(value);
const restoreRecord = (target, source) => {
    for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
    for (const [key,value] of Object.entries(source)) {
        if (ArrayBuffer.isView(target[key]) && ArrayBuffer.isView(value)) target[key].set(value);
        else target[key] = clone(value);
    }
};

// An in-memory excursion. Never overwrite the user's quicksave slot.
export function captureScenarioReturnState() {
    return { g:clone(G), world:clone(WORLD), bh:clone(BH), gs:clone(GS), eph:snapshotEphem(), clockLo:simTimeLo(), warpVisualEnabled:shipVisuals.enabled,
        ap:clone(AP), rel:clone(REL), log:serializeLog(), neb:serializeNebulae(G.t), encounters:serializeEncounterState(),
        camera:{yaw:cam.yaw,pitch:cam.pitch,dist:cam.dist,distTarget:cam.distTarget,tgt:cam.tgt.toArray()} };
}
function releaseInput() {
    resetDrive();
    keys.clear(); G.thrustMain=0; G.thrustLat=0; G.boost=false;
    window.dispatchEvent(new Event('ap:releaseflightinput'));
}
function restoreReturnState(saved) {
    clearBlackHoles();
    for(let i=0;i<saved.bh.n;i++) addBlackHole(saved.bh.x[i],saved.bh.y[i],saved.bh.rs[i],saved.bh.vx[i],saved.bh.vy[i],true,saved.bh.ev[i],saved.bh.kind[i],saved.bh.period[i],saved.bh.z[i],saved.bh.vz[i]);
    restoreRecord(BH,saved.bh);
    restoreNebulae(saved.neb);
    restoreEncounterState(saved.encounters);
    restoreRecord(WORLD,saved.world);
    GS.splice(0,GS.length,...clone(saved.gs));
    restoreRecord(G,saved.g);
    setSimTime(saved.g.t); advanceSimTime(saved.clockLo);
    loadEphemSnapshot(saved.eph);
    restoreRecord(AP,saved.ap); restoreRecord(REL,saved.rel);
    restoreLog(saved.log);
    shipVisuals.enabled=saved.warpVisualEnabled;
    shipVisuals.strength=0;
    invalidateGasDynamics();
    setUiMode(saved.g.uiMode,false);
    Object.assign(cam,{yaw:saved.camera.yaw,pitch:saved.camera.pitch,dist:saved.camera.dist,distTarget:saved.camera.distTarget});
    cam.tgt.fromArray(saved.camera.tgt);
    releaseInput(); hideBanner(); clearTrail(); pushTrail(true); computePrediction();
}
export function exitScenarioPlayback() {
    if(!session) return false;
    const saved=session.returnState;
    session=null;
    cancelTimeJump("guided flight exit");
    cameraRevision++;
    document.body.classList.remove('scenario-playing');
    if(panel) panel.hidden=true;
    restoreReturnState(saved);
    return true;
}
export function scenarioPlaybackActive() { return session !== null; }

export function beginJupiterPlayback(returnState, restart) {
    restartWorld=restart;
    cameraRevision++;
    restoreNebulae([]);
    const seed=jupiterEncounterSeed(eph,PL[3]);
    [G.x,G.y,G.z]=seed.position;
    [G.vx,G.vy,G.vz]=seed.velocity;
    G.heading=Math.atan2(G.vy,G.vx); G.pitch=Math.atan2(G.vz,Math.hypot(G.vx,G.vy));
    G.cabin=false; G.focus='ship'; G.gr=true; G.predict=false; G.hold=null;
    apOff(); relResetState(); releaseInput();
    shipVisuals.enabled=false; shipVisuals.strength=0;
    const plan=createPlaybackPlan(seed.periapsisTimeSec);
    session={ returnState, seed, plan, startedAt:G.t, status:'ready', closestKm:seed.radius,
        entrySpeed:Math.hypot(G.vx-eph.sunVx,G.vy-eph.sunVy,G.vz-(eph.sunVz||0)), uiAt:0 };
    setWarp(playbackStep(plan,0,1/60).warp,'scenario-playback');
    setPaused(true,'scenario-playback');
    cam.pitch=1.18;
    cam.yaw=Math.atan2(-seed.tangent[1],seed.tangent[0])+.45;
    cam.distTarget=null;
    document.body.classList.add('scenario-playing');
    panel.hidden=false;
    updateScenarioCamera(); renderPanel(true);
}
function restartPlayback() {
    if(!session) return;
    const saved=session.returnState;
    session=null; // The generic restart must not discard the return snapshot.
    restartWorld(); clearBlackHoles(); restoreNebulae([]);
    beginJupiterPlayback(saved,restartWorld);
    clearTrail(); pushTrail(true); computePrediction();
}
function togglePlayback() {
    if(!session || session.status==='complete') return;
    session.status='playing';
    setPaused(!G.paused,'scenario-playback');
    renderPanel(true);
}
export function initScenarioPlayback() {
    panel=document.createElement('section');
    panel.id='scenarioPlayback'; panel.hidden=true;
    panel.setAttribute('aria-label','Guided Jupiter slingshot');
    panel.innerHTML='<div class="spEyebrow">GUIDED FLIGHT · ABOUT 60 SECONDS</div><div class="spTitle">Jupiter slingshot</div><div id="spPhase" role="status"></div><progress id="spProgress" max="60" value="0" aria-label="Scenario progress"></progress><div id="spTelemetry"></div><p id="spNarration"></p><div class="spLegend">Drive off · ship enlarged · gravity-flow illustration.</div><div class="spActions"><button id="spToggle" type="button">Start flight</button><button id="spRestart" type="button">Restart</button><button id="spExit" type="button">Exit</button></div>';
    document.getElementById('root').appendChild(panel);
    document.getElementById('spToggle').onclick=togglePlayback;
    document.getElementById('spRestart').onclick=restartPlayback;
    document.getElementById('spExit').onclick=exitScenarioPlayback;
    onTimeControl((kind,source)=>{
        if(session && kind==='warp' && source!=='scenario-playback') exitScenarioPlayback();
    });
    window.addEventListener('ap:replace-universe',exitScenarioPlayback);
    document.addEventListener('keydown',event=>{
        if(event.code==='Escape' && session){exitScenarioPlayback();event.preventDefault();}
    });
}
export function tickScenarioPlayback(wallDt, interrupted=false) {
    if(!session) return null;
    if(interrupted || jumpActive() || G.dead || G.landed || G.focus!=='ship' || G.cabin) { exitScenarioPlayback(); return {advanceSec:0}; }
    if(session.status==='complete') { G.paused=true; return {advanceSec:0}; }
    if(G.paused) { renderPanel(); return {advanceSec:0}; }
    session.status='playing';
    const step=playbackStep(session.plan,G.t-session.startedAt,wallDt);
    if(step.warp>0) setWarp(step.warp,'scenario-playback');
    return step;
}
export function settleScenarioPlayback() {
    if(!session) return;
    const r=Math.hypot(G.x-eph.plX[3],G.y-eph.plY[3],G.z-eph.plZ[3]);
    session.closestKm=Math.min(session.closestKm,r);
    const elapsed=G.t-session.startedAt;
    if(elapsed>=session.plan.simDuration-1e-6 && session.status!=='complete') { session.status='complete'; setPaused(true,'scenario-playback'); renderPanel(true); }
    else renderPanel();
}
export function updateScenarioCamera() {
    if(!session) return false;
    const jx=(eph.earthX+eph.plX[3])*K, jy=eph.plZ[3]*K, jz=-(eph.earthY+eph.plY[3])*K;
    const sx=(eph.earthX+G.x)*K, sy=G.z*K, sz=-(eph.earthY+G.y)*K;
    // Follow the ship while keeping the entire encounter in frame. This only
    // changes the observer; ship and planet stay at authoritative positions.
    cam.tgt.set(sx*.6+jx*.4,sy*.6+jy*.4,sz*.6+jz*.4);
    const bounds=panel?.getBoundingClientRect?.();
    const height=viewportSize.h||932, width=viewportSize.w||height*camera.aspect;
    const top=camera.aspect<1 ? Math.min(height-120,(bounds?.bottom||320)+40) : 0;
    const usableHeight=camera.aspect<1 ? Math.max(100,height-top-30) : height;
    const compactLandscape=camera.aspect>=1 && width<1000;
    const usableWidth=compactLandscape ? Math.max(200,(bounds?.x||width-300)-30) : width;
    const framingAspect=Math.min(camera.aspect,usableHeight/height,usableWidth/height);
    cam.dist=encounterCameraDistance(Math.hypot(sx-jx,sy-jy,sz-jz),PL[3].R*K,framingAspect);
    cam.distTarget=null;
    if(camera.aspect<1) {
        // Reserve the actual phone card height; short portrait screens need
        // more offset than tall ones. The subjects remain physical bodies.
        const center=top+usableHeight/2;
        const shift=cam.dist*Math.tan(24*Math.PI/180)*(2*center/height-1);
        cam.tgt.x-=Math.sin(cam.pitch)*Math.cos(cam.yaw)*shift;
        cam.tgt.y+=Math.cos(cam.pitch)*shift;
        cam.tgt.z-=Math.sin(cam.pitch)*Math.sin(cam.yaw)*shift;
    } else if(compactLandscape) {
        const shift=cam.dist*Math.tan(24*Math.PI/180)*(width-usableWidth)/height;
        cam.tgt.x+=Math.sin(cam.yaw)*shift;
        cam.tgt.z-=Math.cos(cam.yaw)*shift;
    }
    return true;
}
function renderPanel(force=false) {
    if(!session||!panel) return;
    const now=performance.now();
    if(!force&&now-session.uiAt<100) return;
    session.uiAt=now;
    const t=playheadAtSimulation(session.plan,G.t-session.startedAt), done=session.status==='complete';
    const speed=Math.hypot(G.vx-eph.sunVx,G.vy-eph.sunVy,G.vz-(eph.sunVz||0));
    const radius=Math.hypot(G.x-eph.plX[3],G.y-eph.plY[3],G.z-eph.plZ[3])/PL[3].R;
    document.getElementById('spPhase').textContent=done?'Encounter complete':session.status==='ready'?'Ready when you are':`${playbackPhase(t)}${G.paused?' · paused':''}`;
    document.getElementById('spProgress').value=t;
    document.getElementById('spTelemetry').textContent=`${Math.round(t)} / 60 s · ${radius.toFixed(1)} Jupiter radii · ${(G.warp/3600).toFixed(2)} hours / second`;
    document.getElementById('spNarration').textContent=done?`Sun-relative speed: ${session.entrySpeed.toFixed(1)} → ${speed.toFixed(1)} km/s. Closest pass: ${(session.closestKm/PL[3].R).toFixed(2)} Jupiter radii. Exit returns to your previous flight.`:
        t<14?'Coast toward Jupiter. The clock will slow smoothly for the close pass.':t<24?'Jupiter accelerates the ship inward. Its gravity is the only steering.':t<36?'The flight direction bends around Jupiter. Watch the curved gravity flow as we follow the ship.':`Coasting away at ${speed.toFixed(1)} km/s relative to the Sun. The moving planet has changed the ship’s heliocentric velocity.`;
    const toggle=document.getElementById('spToggle');
    toggle.disabled=done; toggle.textContent=session.status==='ready'?'Start flight':done?'Finished':G.paused?'Resume':'Pause';
}
