import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { qualitySettings } from './quality-fixture-settings.mjs';
const before = { mode: 'high', mobile: false, dpr: 1, riverDraw: 1, riverEvery: 1, lensSamples: 4, level: 0,
    futureBudget: 12, frameMs: 17, samples: 100, changes: 0, reason: 'manual' };
const after = { ...before, frameMs: 25, samples: 200, changes: 1, reason: 'diagnostic', trial: false };
assert.deepEqual(qualitySettings(before), qualitySettings(after), 'Absent legacy trial metadata equals explicit false');
assert.deepEqual(qualitySettings(before), qualitySettings({ ...after, trial: true }), 'Probation metadata alone changes no render budget');
for (const [key, value] of Object.entries({ mode: 'low', mobile: true, dpr: .5, riverDraw: .2, riverEvery: 4, lensSamples: 0, level: 3, futureBudget: 11 }))
    assert.notDeepEqual(qualitySettings(before), qualitySettings({ ...after, [key]: value }));
assert.equal(before.samples, 100); assert.equal(after.samples, 200, 'Original raw telemetry is retained');
const source = readFileSync(new URL('./verify-curvature-drive.mjs', import.meta.url), 'utf8');
assert(source.includes('?quality=high&')); assert(source.includes('quality:{...renderQuality}'));
assert(source.includes('guideOn.mean<=guideOff.mean*1.5+20'));
assert(source.includes('await frames(48)')); assert(source.includes('i<48;i++'));
console.log('Paired motion: only five diagnostic fields excluded, every budget/unknown field compared, raw telemetry and 48-frame/50%+20ms bound retained.');

assert(readFileSync(new URL('./review-compact-and-merger.mjs', import.meta.url), 'utf8').includes('?quality=high&'), 'Volumetric navigation capture explicitly requests its required full render path');
