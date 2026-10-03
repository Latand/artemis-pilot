// Run the unchanged production revision and existing route/assertions once.
// The only additions are bounded texture-census hooks around the same-host
// warm route and all twenty rapid roundtrips, then one diagnostic JSON file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { installTextureUploadTracker } from './texture-upload-tracker.mjs';

const target = new URL('./verify-explored-systems.mjs', import.meta.url).href;
const source = readFileSync(new URL(target), 'utf8');
const inject = (text, from, to) => {
    assert.equal(text.split(from).length, 2, 'Exact diagnostic anchor must occur once: ' + from);
    return text.replace(from, to);
};
let traced = inject(source, '    return source + `\\nwindow.__exploredFrame=',
    '    source += ' + JSON.stringify('\n(' + installTextureUploadTracker.toString() + ')(renderer, scene, camera);\n') + ';\n    return source + `\\nwindow.__exploredFrame=');
traced = inject(traced, 'const t=performance.now();frame();const cpu=', 'window.__textureUploadTracker.beforeFrame();const t=performance.now();frame();const cpu=');
traced = inject(traced, 'return {cpuMs:cpu,frameAndFinishMs:performance.now()-t};',
    'const timing={cpuMs:cpu,frameAndFinishMs:performance.now()-t};window.__textureUploadTracker.afterFrame(timing);return timing;');
traced = inject(traced, "    await phase('same-host-repeated-routes');",
    "    await phase('same-host-repeated-routes');\n    await page.evaluate(() => __textureUploadTracker.start());");
traced = inject(traced, '    const repeatedStart = await snapshot(first);',
    "    await page.evaluate(() => { __textureUploadTracker.mark('warmed-baseline'); __textureUploadTracker.checkpoint('warmed-baseline'); });\n    const repeatedStart = await snapshot(first);");
traced = inject(traced, '    for (let index = 0; index < 20; index++) {',
    "    for (let index = 0; index < 20; index++) {\n        await page.evaluate(index => __textureUploadTracker.mark('rapid-roundtrip-' + (index + 1)), index);");
traced = inject(traced, "    await phase('warmed-switch-handler-cpu');",
    "    await page.evaluate(() => __textureUploadTracker.checkpoint('after-twenty-roundtrips'));\n    const textureTrace = await page.evaluate(() => __textureUploadTracker.stop());\n    await writeFile(resolve(out, 'texture-first-upload.json'), JSON.stringify(textureTrace, null, 2));\n    assert(!textureTrace.truncated, 'Texture diagnostic must retain every observed allocation');\n    await phase('warmed-switch-handler-cpu');");
execFileSync(process.execPath, ['--input-type=module', '--check'], { input: traced });
const hook = registerHooks({ load(url, context, next) {
    return url === target ? { format: 'module', source: traced, shortCircuit: true } : next(url, context);
} });
try { await import(target); } finally { hook.deregister(); }
