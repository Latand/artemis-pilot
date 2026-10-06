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
    run(c, 33.33, 16000); assert(c.state.level < 3, 'intentional 30 Hz limit allows gradual recovery');
    run(c, 16.67, 36000); assert.equal(c.state.level, 0, 'sustained headroom recovers quality');
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
