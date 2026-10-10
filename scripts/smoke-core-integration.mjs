// Exercise the actual shared main-loop blocks after integrating guided flight,
// curvature drive and orbital exposure. No WebGL/browser code is substituted
// into production. GPU appearance/recovery remains a separate hosted gate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDriveState, stepDrive, sampleDriveGradient } from '../src/curvatureDrive.js';
import { createWarpState, stepWarp, stopWarp, resetWarp } from '../src/warpBubble.js';
import { shipPresentation } from '../src/shipPresentation.js';
import { MAIN_A, RCS_A, BOOST } from '../src/constants.js';
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const slice = (from, to) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert(start >= 0 && end > start, `Production block anchors exist: ${from}`);
    return source.slice(start, end);
};
const driveBlock = slice('    let atx = 0, aty = 0, atz = 0, aMag = 0;', '    // ---- physics ----');
const runDrive = ({ guided = false, main = 1, lateral = 0, paused = false, warp = 1, bubble = false } = {}) => {
    const DRIVE = createDriveState();
    const WARP = createWarpState(); WARP.enabled=bubble;
    stepDrive(DRIVE, .02, .03, .01, 1/60); // Old held command must not survive a gate.
    const context = vm.createContext({ G: { dead:false, paused, warp, infinite:true, fuel:1, heading:0, pitch:0, throttle:1, boost:false, landed:null, muted:false },
        WARP, stepWarp, stopWarp, resetWarp:()=>resetWarp(WARP), REL:{active:false}, cinematic:{isPlaying:()=>false}, frameNo:0, updateWarpControls(){},
        DRIVE, stepDrive, sampleDriveGradient, driveAcceleration:new Float64Array(3), scenarioPlaybackActive:()=>guided,
        AP:{mode:'off'}, mainIn:main, latIn:lateral, dtR:1/60, MAIN_A, RCS_A, BOOST, updateDriveAudio() {} });
    vm.runInContext(driveBlock + '\nglobalThis.result = { atx, aty, atz, aMag, canThrust };', context);
    return { ...context.result, drive:DRIVE, bubble:WARP };
};
for (const main of [-1, 0, 1]) for (const lateral of [-1, 0, 1]) {
    const result = runDrive({ guided:true, main, lateral });
    assert.equal(result.canThrust, false, 'Guided flight owns the unpowered frame before an input interruption restores state');
    assert.equal(result.aMag, 0); assert.deepEqual([result.atx, result.aty, result.atz], [0, 0, 0]);
    assert.equal(result.drive.engaged, false);
}
assert.equal(runDrive({bubble:true}).aMag,0,'Bubble transport does not add local thrust');
assert(runDrive({bubble:true}).bubble.speed>0,'Pilot input ramps the separate bubble controller');
assert(!runDrive({bubble:true,guided:true}).bubble.enabled,'Guided playback disconnects warp');
assert(runDrive().aMag > 0, 'Ordinary pilot drive remains active');
for (const options of [{paused:true}, {warp:-60}, {warp:0}, {main:0}]) {
    assert.equal(runDrive(options).aMag, 0, 'Pause/reverse/zero rate/release remains ballistic');
}
const viewBlock = slice('    const shipView = shipPresentation(', '    updateHeadingArrow(oriX, oriY, oriZ, dirV, cd,');
for (const guided of [false, true]) {
    const craft = { visible:true, userData:{fadeMaterials:[{opacity:1}]} };
    const dot = { material:{opacity:1}, scale:{value:0,setScalar(value){this.value=value;}} };
    const context = vm.createContext({ shipPresentation, craft, dot, cd:1e8, cs:guided?1e8*.035:2.4,
        camera:{fov:48}, viewportSize:{h:900}, G:{dead:false}, scenarioPlaybackActive:()=>guided });
    vm.runInContext(viewBlock, context);
    assert.equal(dot.material.opacity, guided?0:.9, 'Guided hull replaces marker; normal far marker stays bounded');
    assert.equal(craft.visible, guided, 'Enlarged guided hull survives curvature-drive handoff');
    assert.equal(craft.userData.fadeMaterials[0].opacity, guided?1:0);
}
assert(source.includes('let hudLastFocus, hudLastMode, hudLastWarp, hudLastPaused;'));
assert(source.includes('hudInputChanged || frameNo % hudEvery === 0'), 'Focus/mode/rate/pause invalidate HUD cadence');
assert(source.includes('G.paused ? 0 : presentationExposureSeconds(advanced, rawDtR)'), 'Discovered surfaces retain exact exposure clock');
const labels = slice('    if (nearLabelsDue) {', '    perfEnd("labels.near"');
assert(labels.indexOf('putUnlessCrowded(lblE') < labels.indexOf('putUnlessCrowded(lblO'), 'Earth retains priority over the compact ship label');
console.log('Core integration: guided drive/input gate, exact coast/pause/reverse, hull/marker ownership, HUD invalidation and Earth-label priority passed');
