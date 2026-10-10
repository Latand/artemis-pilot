import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createQualityController, isSoftwareRenderer, qualityBudget, qualityPixelRatio, qualityMode, readRendererName, pacedFrameTime } from '../src/render/adaptiveQuality.js';
import { withinStartupBudget } from '../src/render/startupBudget.js';
for (const name of ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11)', 'ANGLE (Google SwiftShader)', 'llvmpipe', 'softpipe', 'WARP']) assert(isSoftwareRenderer(name), name);
for (const name of ['Intel Iris Xe', 'Apple M3', 'AMD Radeon', 'unknown']) assert(!isSoftwareRenderer(name), name);
assert.equal(readRendererName({ getExtension() { throw Error('not available'); } }), 'unknown');
assert.equal(qualityMode('garbage'), 'auto');
let now = 0;
const run = (controller, dt, duration, active = true) => {
    const end = now + duration;
    while (now < end) { now += dt; controller.sample(now, { active, targetMs: controller.state.mobile || controller.state.level === 3 ? 1000 / 30 : 1000 / 60 }); }
};
for (const mobile of [false, true]) {
    now = 0; const c = createQualityController({ mobile });
    run(c, 16.67, 2000); assert.equal(c.state.level, 1, 'startup does not jump to full detail');
    run(c, 120, 9000); assert.equal(c.state.level, 3, 'sustained slow delivered frames reach minimal');
    run(c, 33.33, 20000);
    if (mobile) assert(c.state.level < 3, 'intentional mobile 30 Hz limit allows gradual recovery');
    else assert.equal(c.state.level, 3, 'desktop recovery trial rolls back if it cannot meet its unthrottled target');
    run(c, 16.67, 120000); assert.equal(c.state.level, 0, 'sustained headroom recovers quality');
    const oldChanges = c.state.changes;
    run(c, 140, 1000); assert.equal(c.state.changes, oldChanges, 'one spike does not shed a tier');
    c.reset(now); run(c, 1000, 100000, false); run(c, 16.67, 2500);
    assert.equal(c.state.level, 0, 'hidden tab and return never count as slow frames');
    c.reset(now); run(c, 100, 900); assert.equal(c.state.level, 0, 'resize/context grace excludes transient cost');
    for (const [mode, level] of [['high', 0], ['balanced', 1], ['low', 2], ['minimal', 3]]) {
        c.setMode(mode, now); run(c, 200, 16000); assert.equal(c.state.level, level, 'manual override is stable');
    }
    c.setMode('auto', now); assert.equal(c.state.level, 1, 'return to auto starts conservatively');
}
// Reproduce the reported controller pattern without pretending these synthetic
// timestamps are a physical-device benchmark.
now = 0; const promotion = createQualityController({ mobile: true });
run(promotion, 1000 / 30, 15000);
assert.equal(promotion.state.level, 0);
assert(promotion.state.trial, 'A capped cadence buys only a provisional upgrade');
run(promotion, 1000 / 24, 5000);
assert.equal(promotion.state.level, 1, '30-to-24 FPS after promotion returns to Balanced');
assert.equal(promotion.state.reason, 'quality trial rolled back');
assert(!promotion.state.trial);
const rolledBackAt = now, rolledBackChanges = promotion.state.changes;
run(promotion, 1000 / 30, 55000);
assert.equal(promotion.state.level, 1, 'Failed higher tier is not retried during cooldown');
assert.equal(promotion.state.changes, rolledBackChanges);
run(promotion, 1000 / 30, 15000);
assert.equal(promotion.state.level, 0, 'A later healthy scene may try the tier again');
assert(!promotion.state.trial, 'Three stable windows validate the upgrade');
assert(now > rolledBackAt + 60000);
run(promotion, 1000 / 24, 3500);
assert.equal(promotion.state.level, 1, 'Sustained loss is caught even after a successful trial');

now = 0; const mobileSlow = createQualityController({ mobile: true });
run(mobileSlow, 1000 / 24, 12000);
assert.equal(mobileSlow.state.level, 3, 'Steady 24 FPS sheds quality toward the mobile target');
now = 0; const desktopSlow = createQualityController();
run(desktopSlow, 1000 / 30, 7000);
assert(desktopSlow.state.level >= 2, '30 FPS desktop no longer remains Balanced indefinitely');

now = 0; const interrupted = createQualityController({ mobile: true });
run(interrupted, 1000 / 30, 15000); assert(interrupted.state.trial);
interrupted.reset(now); run(interrupted, 1000, 30000, false);
assert(interrupted.state.trial, 'Hidden time cannot validate a promotion');
run(interrupted, 1000 / 24, 5000);
assert.equal(interrupted.state.level, 1, 'Interrupted trial must still meet the target');
interrupted.setMode('auto', now); run(interrupted, 1000 / 30, 15000);
assert(interrupted.state.trial);
interrupted.setMode('high', now); run(interrupted, 1000 / 24, 10000);
assert.equal(interrupted.state.level, 0); assert(!interrupted.state.trial, 'Manual selection cancels probation');
console.log('PASS: provisional upgrades, 30→24 FPS rollback, cooldown, later recovery, post-trial degradation, desktop target and interrupted/manual trials.');

now = 0; const stalled = createQualityController();
run(stalled, 16.67, 2000); run(stalled, 500, 2000);
assert.equal(stalled.state.level, 2, 'repeated severe stalls shed quickly without waiting for twelve slow frames');
now = 0; const software = createQualityController({ software: true });
assert.equal(software.state.level, 3);
run(software, 16.67, 60000); assert.equal(software.state.level, 3, 'software renderer does not repeatedly retry expensive effects');
software.setMode('high', now); assert.equal(software.state.level, 0, 'explicit quality choice can override guard');
for (const mobile of [false, true]) {
    let previous = Infinity;
    for (let level = 0; level < 4; level++) {
        const dpr = qualityPixelRatio({ level, mobile, device: 1, width: 1920, height: 1080 });
        assert(dpr <= previous); previous = dpr;
        if (level >= 2) assert(dpr < 1, 'DPR=1 display actually reduces resolution');
        const b = qualityBudget(level, mobile); assert(b.riverDraw > 0); assert(b.riverEvery <= 4);
        if (level) assert.equal(b.lensSamples, 0, 'multiple-hole path has no mandatory MSAA');
    }
}
assert.equal(qualityPixelRatio({ level: 3, device: 1, override: .75 }), .75, 'explicit DPR remains absolute');
assert(qualityPixelRatio({ level: 1, device: 2, width: 7680, height: 4320 }) < 1, 'framebuffer pixel budget covers large displays');
assert.equal((await withinStartupBudget(() => Promise.resolve('ok'), 20)).status, 'ready');
assert.equal((await withinStartupBudget(() => new Promise(() => {}), 10)).status, 'timeout');
assert.equal((await withinStartupBudget(() => { throw Error('driver lost'); }, 10)).status, 'error');
const late = await withinStartupBudget(() => new Promise((_, reject) => setTimeout(() => reject(Error('late loss')), 20)), 5);
assert.equal(late.status, 'timeout'); await new Promise(resolve => setTimeout(resolve, 30));
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
assert(main.includes('if (!skipSceneCompile) await warmRendererStartup();'));
assert(main.includes('sampleRenderPerformance(now, !VR.active)'));
assert(!main.includes('await renderer.compileAsync(scene, camera)'));
console.log('Adaptive quality: desktop/mobile slowdown, recovery, manual control, software guard, DPR=1, lifecycle grace and never-settling/failed/late compilation pass.');

// Replay the actual RAF limiter plus controller, including refresh rates that
// do not divide 30 Hz. Idealized 33.33 ms samples miss pacing lock-in bugs.
for (const refreshHz of [50, 60, 75, 80, 90, 120, 144]) {
    for (const mobile of [false, true]) {
        now = 0; const controller = createQualityController({ mobile });
        run(controller, 120, 14000); assert.equal(controller.state.level, 3);
        let phase = -Infinity, delivered = 0, first = 0, last = 0;
        const end = now + 90000;
        while (now < end) {
            now += 1000 / refreshHz;
            const hz = mobile || controller.state.level === 3 ? 30 : 0;
            const next = pacedFrameTime(now, phase, hz);
            if (next === null) continue;
            phase = next; delivered++; if (!first) first = now; last = now;
            controller.sample(now, { mobile, targetMs: hz ? 1000 / hz : 1000 / 60 });
        }
        assert.equal(controller.state.level, 0, `${refreshHz} Hz ${mobile ? 'mobile' : 'desktop'} recovers from Minimal`);
        if (mobile) assert(Math.abs((last - first) / (delivered - 1) - 1000 / 30) < .2);
    }
}
assert.equal(pacedFrameTime(1, -Infinity, 30), 1);
assert.equal(pacedFrameTime(10, 1, 30), null);
assert.equal(pacedFrameTime(10, 1, 0), 10, 'XR/unthrottled frames bypass pacing');
console.log('Integrated RAF pacing recovers at 50/60/75/80/90/120/144 Hz on desktop and mobile.');

const compactSource = readFileSync(new URL('../src/compactExplorer.js', import.meta.url), 'utf8');
const qualityCss = readFileSync(new URL('../src/render/qualityControls.css', import.meta.url), 'utf8');
assert(compactSource.includes("setCss('--explore-panel-bottom'") && compactSource.includes('observer.observe(panel)'));
assert(qualityCss.includes('top:calc(var(--explore-panel-bottom,238px) + 10px)'));
assert(qualityCss.includes(':has(#explorePanel.expanded)') && qualityCss.includes(':has(#gravityInspector[open])'));

assert(compactSource.includes("setCss('--time-dock-top'"));
assert(qualityCss.includes('box-sizing:border-box') && qualityCss.includes('var(--time-dock-top,calc(100dvh - 140px))'));
assert(qualityCss.includes('#renderQualityControls[open] { overflow:auto; }'));
assert(qualityCss.includes('summary:focus-visible { outline:2px solid #8ecdf6;outline-offset:-4px; }'));
assert(qualityCss.includes(':has(#tdOptions:not([hidden]))'));
assert(compactSource.includes("setCss('--explore-panel-right'"));
assert(qualityCss.includes('top:calc(var(--explore-toolbar-bottom,60px) + 10px)'));
assert(qualityCss.includes('100vw - var(--explore-panel-right,260px) - 20px'));
assert(qualityCss.includes('body.compact-explorer.compact-moving.mode-observe #renderQualityControls'));
const {landscapeQualityLayout}=await import('./quality-layout-qa.mjs');
const savedGlobals={document:globalThis.document,innerWidth:globalThis.innerWidth,innerHeight:globalThis.innerHeight};
function layoutFixture({open=false,oldOverlap=false,blocked=null}={}) {
    const box=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});
    const node=r=>({getBoundingClientRect:()=>r,contains(el){return el===this;}});
    const elements={renderQualityControls:node(box(oldOverlap?426:270,oldOverlap?143:68,oldOverlap?132:288,open?70:46)),
        explorePanel:node(box(10,68,250,179)),timeDock:node(box(275,150,283,160)),exploreBar:node(box(10,8,548,50)),
        renderQualityMode:node(box(280,82,150,44)),tdMore:node(box(367,160,64,44)),motionPathsToggle:node(box(437,160,110,44))};
    elements.summary=node(box(oldOverlap?426:270,oldOverlap?143:68,oldOverlap?132:288,46));
    elements.renderQualityControls.open=open;elements.renderQualityControls.querySelector=()=>elements.summary;
    globalThis.innerWidth=568;globalThis.innerHeight=320;
    globalThis.document={getElementById:id=>elements[id],elementFromPoint(x,y){
        const order=[open?'renderQualityMode':'summary','tdMore','motionPathsToggle'];
        for(const id of order){const e=elements[id],r=e.getBoundingClientRect();if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom)return id===blocked&&x===r.right-4&&y===r.bottom-4?{}:e;}
        return null;
    }};
    return landscapeQualityLayout();
}
try {
    for(const open of [false,true]){
        assert(layoutFixture({open}).clear);
        assert(!layoutFixture({open,oldOverlap:true}).clear,'The captured overlapping landscape layout is rejected');
        for(const blocked of [open?'renderQualityMode':'summary','tdMore','motionPathsToggle'])assert(!layoutFixture({open,blocked}).clear,'An obscured corner is rejected for each interactive control');
    }
}finally{for(const [key,value] of Object.entries(savedGlobals)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
console.log('Compact quality layout: measured landscape slot and five-point Graphics/Settings/Motion paths hit tests reject the captured overlap and obstructed corners.');
