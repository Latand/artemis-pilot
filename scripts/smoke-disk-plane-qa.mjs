// CPU/source-only tests. Does not import or launch Playwright, Vite, or WebGL.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { installNativeRingProof } from './native-ring-proof.mjs';
import { COARSE_PITCHES, DENSE_PITCHES, DISK_PLANE_CASES, MATRIX, QA_OPERATION_BUDGET, assertCrossingAcceptance,
    compareMaskedPixels, assertPairedControl, assertDiskBehindForeground, assertOccludedEmissionPixels, assertControlCompleteness, transformDiskPlaneSource, validateDiskPlaneHooks } from './disk-plane-qa.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
assert.equal(DISK_PLANE_CASES.length, 34);
assert.equal(DISK_PLANE_CASES.filter(c => c.scenario === 'saturn-near-lens').length, 7);
assert.equal(DISK_PLANE_CASES.filter(c => c.scenario === 'saturn-foreground-lens').length, 3);
assert.equal(DISK_PLANE_CASES.filter(c => c.scenario === 'saturn-overlapping-disk').length, 3);
assert.equal(DISK_PLANE_CASES.filter(c => c.scenario === 'disk-crossing').length, 21);
assert.equal(COARSE_PITCHES.length, 7); assert.equal(DENSE_PITCHES.length, 15);
assert.deepEqual(MATRIX, ['desktop-direct', 'desktop-bloom', 'mobile-direct', 'mobile-bloom']);
assert.equal(QA_OPERATION_BUDGET.savedCapturesPerRoot, 62);
assert.equal(QA_OPERATION_BUDGET.stabilityCapturesPerRoot, 26);
assert.equal(QA_OPERATION_BUDGET.explicitReadbacksPerRoot, 629);
assert.equal(QA_OPERATION_BUDGET.explicitReadbacksAllFourCells, 5032);

// Actual old geometry puts a 3,000-unit radius around a center only1,900
// units behind Saturn. Check both signed endpoints and the plane itself.
const foreground = { holeDepth: 4500, bodyDepth: 600, bodyRadius: 58.232, rsUnits: 50, rout: 20, supportHalfWidthRs: .02 };
for (const pitch of [.48, 0, -.48]) {
    const placed = { ...foreground, holeDepth: 600 + 3900 * Math.cos(pitch) };
    assert(assertDiskBehindForeground(placed).clearance > 400);
    const overlap = { ...foreground, holeDepth: 600 + 1900 * Math.cos(pitch) };
    assert.throws(() => assertDiskBehindForeground(overlap), /Entire disk emission support/);
}
const supportRadius = Math.hypot(60, .02) * 50;
assert.throws(() => assertDiskBehindForeground({ ...foreground, holeDepth: 600 + 58.232 + supportRadius }), /Entire disk emission support/);
for (const key of Object.keys(foreground))
    assert.throws(() => assertDiskBehindForeground({ ...foreground, [key]: NaN }), /Finite/);
assert.throws(() => assertDiskBehindForeground({ ...foreground, rout: 30 }), /Entire disk emission support/);
assert.throws(() => assertDiskBehindForeground({ ...foreground, supportHalfWidthRs: .01 }), /reviewed support clamp/);

// Face-on disk plane in camera coordinates. Extending the off-center body's
// eye ray before its400-unit annulus offset avoids putting the tested mask in
// the inner hole. Every mask ray must land in the emitting radial interval.
for (const [width, height] of [[960, 640], [840, 600], [390, 700], [430, 760]]) {
    const tan = Math.tan(48 * Math.PI / 360), aspect = width / height;
    const bodyX = 75, bodyZ = 600, planeZ = 4500, offset = 400;
    const centerX = (.5 + bodyX / bodyZ / (2 * tan * aspect)) * width;
    const radius = .55 * 58.232 / bodyZ * height / (2 * tan);
    let count = 0, min = Infinity, max = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (Math.hypot(x + .5 - centerX, y + .5 - height / 2) >= radius) continue;
        const px = ((x + .5) / width * 2 - 1) * tan * aspect * planeZ;
        const py = ((y + .5) / height * 2 - 1) * tan * planeZ;
        const r = Math.hypot(px - (bodyX * planeZ / bodyZ + offset), py);
        min = Math.min(min, r); max = Math.max(max, r); count++;
    }
    assert(count > 50 && min > 150 && max < .82 * 3000, 'Whole opaque mask projects into the bright annulus');
}
const nonvacuous = { opaquePixels: 100, occludedEmissionWitnessPixels: 90, opaqueEmissionChanged: 0 };
assertOccludedEmissionPixels(nonvacuous);
for (const count of [0, 50, 101, NaN])
    assert.throws(() => assertOccludedEmissionPixels({ ...nonvacuous, occludedEmissionWitnessPixels: count }), /same foreground mask/);
assert.throws(() => assertOccludedEmissionPixels({ ...nonvacuous, opaqueEmissionChanged: 1 }), /cannot change/);
assert.throws(() => assertOccludedEmissionPixels({ ...nonvacuous, opaquePixels: 0 }), /Meaningful/);

const good = DISK_PLANE_CASES.map(test => ({ ...test, metrics: { diskPixels: 100, diskLight: 1000 } }));
assert.equal(assertCrossingAcceptance(good, 'candidate').positiveContinuityAcceptance, true);
const mutate = edit => { const result = structuredClone(good); edit(result); return result; };
const at = (rows, pitch) => rows.find(row => row.scenario === 'disk-crossing' && row.pitch === pitch);
const main = mutate(rows => { at(rows, 0).metrics = { diskPixels: 0, diskLight: 0 }; });
assert.equal(assertCrossingAcceptance(main, 'main').expectedDropoutReproduced, true);
assert.throws(() => assertCrossingAcceptance(good, 'main'), /dropout/);
assert.throws(() => assertCrossingAcceptance(main, 'candidate'), /dropout/);
for (const [name, edit, message] of [
    ['upper bound', rows => { at(rows, .0006).metrics.diskLight = 1251; }, /flash or dropout/],
    ['lower bound', rows => { at(rows, -.0006).metrics.diskLight = 749; }, /flash or dropout/],
    ['adjacency', rows => { at(rows, .0006).metrics.diskLight = 1210; }, /remains continuous/],
    ['zero-plane pixel dropout', rows => { at(rows, 0).metrics.diskPixels = 49; }, /all-dark/],
    ['empty near endpoint', rows => { at(rows, .005).metrics.diskPixels = 0; }, /near-plane/],
    ['empty dense endpoint', rows => { at(rows, -.0008).metrics.diskLight = 0; }, /dense endpoints/],
    ['nonfinite light', rows => { at(rows, 0).metrics.diskLight = NaN; }, /Finite/],
    ['duplicate pitch', rows => { at(rows, .0006).pitch = .0007; }, /exactly once/],
]) assert.throws(() => assertCrossingAcceptance(mutate(edit), 'candidate'), message, name);
assert.throws(() => assertCrossingAcceptance(good.slice(0, -1), 'candidate'), /21 original/);

function pixels(rgba = [20, 30, 40, 255, 70, 80, 90, 255], mask = [1, 0]) {
    return { width: 2, height: 1, rgba: Buffer.from(rgba).toString('base64'), mask: Buffer.from(mask).toString('base64') };
}
const original = pixels();
assert(assertPairedControl(original, pixels(), 'ring').identical);
assert(assertPairedControl(original, pixels([20, 30, 40, 255, 1, 2, 3, 255]), 'masked outside').identical);
assert.equal(compareMaskedPixels(original, pixels([21, 30, 40, 255, 70, 80, 90, 255]), 'one channel').maxChannelDelta, 1);
assert.throws(() => assertPairedControl(original, pixels([21, 30, 40, 255, 70, 80, 90, 255]), 'changed'), /byte-identical/);
assert.throws(() => assertPairedControl(original, pixels(undefined, [1, 1]), 'expanded'), /mask remains identical/);
assert.throws(() => assertPairedControl(pixels(undefined, [0, 0]), pixels(undefined, [0, 0]), 'empty'), /empty-mask/);
assert.equal(assertPairedControl(pixels(undefined, [0, 0]), pixels(undefined, [0, 0]), 'not visible', { allowEmpty: true }).applicable, false);
assert.throws(() => compareMaskedPixels(original, { ...pixels(), width: 1 }, 'wrong dimensions'), /same width/);
assert.throws(() => compareMaskedPixels(original, { ...pixels(), rgba: '' }, 'missing bytes'));

const diagnosticLabels = [.48, 0, -.48].map(pitch => `original/saturn-overlapping-disk/${pitch}/opaque`);
const strictLabels = ['original/saturn-foreground-lens/0/opaque', 'original/saturn-overlapping-disk/0/opaque-disk-off', 'original/saturn-near-lens/0/ring'];
const strictControls = strictLabels.map(label => ({ label })), diagnostics = diagnosticLabels.map(label => ({ label }));
const allLabels = [...strictLabels, ...diagnosticLabels];
assert.deepEqual(assertControlCompleteness(allLabels, strictControls, diagnostics), { expected: 6, strict: 3, diagnostic: 3 });
for (let i = 0; i < strictControls.length; i++)
    assert.throws(() => assertControlCompleteness(allLabels, strictControls.filter((_, j) => i !== j), diagnostics), /exactly one/);
for (let i = 0; i < diagnostics.length; i++)
    assert.throws(() => assertControlCompleteness(allLabels, strictControls, diagnostics.filter((_, j) => i !== j)), /exactly one/);
assert.throws(() => assertControlCompleteness(allLabels, [...strictControls, strictControls[0]], diagnostics), /exactly once/);
assert.throws(() => assertControlCompleteness(allLabels, [...strictControls, diagnostics[0]], diagnostics), /exactly once/);
assert.throws(() => assertControlCompleteness(allLabels, [...strictControls.slice(1), diagnostics[0]], [...diagnostics.slice(1), strictControls[0]]), /declared overlapping/);
assert.throws(() => assertControlCompleteness([...allLabels, allLabels[0]], strictControls, diagnostics), /Baseline control labels/);
assert.throws(() => assertControlCompleteness(allLabels, [...strictControls, { label: 'unexpected' }], diagnostics), /exactly one/);

validateDiskPlaneHooks(root);
const mainSource = readFileSync(resolve(root, 'src/main.js'), 'utf8');
assert.throws(() => transformDiskPlaneSource(mainSource.replace('    sampleMemory();', ''), resolve(root, 'src/main.js')), /successful rendered frame/);
assert.throws(() => transformDiskPlaneSource(mainSource.replace('    sampleMemory();', '    sampleMemory();\n    sampleMemory();'), resolve(root, 'src/main.js')), /successful rendered frame/);
const transformed = transformDiskPlaneSource(mainSource, resolve(root, 'src/main.js'));
assert(transformed.includes('window.__diskPlaneFrameSuccess'));
assert(transformed.includes('window.__celestialFrame'));
assert(!transformed.includes('renderer.setAnimationLoop(frame);'), 'No ambient loop in the controlled fixture');

const probe = readFileSync(new URL('./probe-disk-plane.mjs', import.meta.url), 'utf8');
const validationExit = probe.indexOf('if (validateOnly)');
assert(probe.indexOf("await import('playwright')") > validationExit);
assert(probe.indexOf("await import('vite')") > validationExit);
assert(!/^import .*from ['"](?:playwright|vite)['"]/m.test(probe), 'Validation must not import browser packages');
assert(!/import\([^)]*ringSamplingDepth/.test(probe), 'No invented ring-depth module');
assert(probe.includes('const sourceBindingBefore = bindSources();'));
assert(probe.includes('report.sourceBindingAfter = bindSources()'));
assert(probe.includes('page.waitForFunction(contextLossSettled)'));
assert(probe.includes('page.waitForFunction(contextRestoreSettled)'));
assert(!probe.includes('waitForFunction(async'), 'Context/asset predicates must not pass on Promise truthiness');
assert(probe.includes('pausedRecoveryPassed(held, restored, preLossTime)'));
assert(probe.includes("getExtension('WEBGL_lose_context')"));
assert(probe.includes('if (identity) lens.lensingPass.uniforms.uN.value = 0;'));
assert(probe.includes('if (opacityControl) s.bloomPass.enabled = false;'));
assert(probe.includes('result.state.foregroundSupportProof = assertDiskBehindForeground(result.state.emissionSupport)'));
assert(probe.includes('assertOccludedEmissionPixels(result.metrics)'));
assert(probe.includes('luminance(opaqueDiskOff.bytes, i) > 8'), 'Opaque masks must be independent of new disk emission');
assert(probe.includes('assertControlCompleteness(mainControls.keys(), report.pairedControls, report.overlappingDiskDiagnostics)'));
assert(probe.includes('st.BH.z[0] = qa.initialHole.z;'), 'Face-on placement cannot leak into old overlapping/crossing fixtures');
assert(probe.includes('witnessDepthTest = gl.isEnabled(gl.DEPTH_TEST);'));
assert(probe.includes('disk.onAfterRender = diskAfterRender;'));
assert(probe.includes('material.map === qa.expectedSaturnMap'));
assert(probe.includes("assert.deepEqual(a.controls, b.controls, 'Settled frozen controls are stable across repeated draws')"));
assert(probe.includes('window.__diskPlaneNativeRingProof(s.renderer, rings, () => draw())'));
assert(probe.includes('await page.evaluate(installNativeRingProof)'));

// Execute the exact serialized browser helper against a stateful GL mock.
// The current program/map unit become valid only after the material callback,
// reproducing the upload order that made callback-time inspection unreliable.
const sandbox = { window: {} };
vm.runInNewContext(`(${installNativeRingProof.toString()})()`, sandbox);
const observe = sandbox.window.__diskPlaneNativeRingProof;
function nativeMock(options = {}) {
    const texture = {}, otherTexture = {}, program = {}, location = {};
    const vertex = { type: 35633, source: 'native vertex vRingPosition' };
    const fragment = { type: 35632, source: options.wrongProgram ? 'unrelated fragment' : 'native fragment uRingSun vRingPosition' };
    const state = { active: 33990, uploaded: false, actualDraws: 0, uniformReads: 0, oldBefore: 0, oldAfter: 0 };
    const gl = { CURRENT_PROGRAM: 35725, ACTIVE_TEXTURE: 34016, TEXTURE0: 33984, TEXTURE_BINDING_2D: 32873,
        TEXTURE_2D: 3553, TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240, TEXTURE_WRAP_S: 10242,
        TEXTURE_WRAP_T: 10243, SAMPLER_BINDING: 35097, MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661,
        LINK_STATUS: 35714, ACTIVE_UNIFORMS: 35718, SAMPLER_2D: 35678, COMPILE_STATUS: 35713,
        SHADER_TYPE: 35663, VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, TRIANGLES: 4, UNSIGNED_INT: 5125,
        LINEAR: 9729, NEAREST: 9728, NEAREST_MIPMAP_NEAREST: 9984, NEAREST_MIPMAP_LINEAR: 9986,
        LINEAR_MIPMAP_NEAREST: 9985, LINEAR_MIPMAP_LINEAR: 9987, REPEAT: 10497,
        CLAMP_TO_EDGE: 33071, MIRRORED_REPEAT: 33648,
        isContextLost: () => !!options.contextLost,
        getParameter(p) {
            if (p === this.CURRENT_PROGRAM) { assert(state.uploaded, 'program must be inspected after uniform upload'); return options.missingProgram ? null : program; }
            if (p === this.ACTIVE_TEXTURE) return state.active;
            if (p === this.MAX_COMBINED_TEXTURE_IMAGE_UNITS) return 16;
            if (p === this.TEXTURE_BINDING_2D) return state.active === this.TEXTURE0 + 3 && !options.wrongTexture ? texture : otherTexture;
            if (p === this.SAMPLER_BINDING) return options.samplerOverride ? {} : null;
            if (p === 34047) return 16;
            throw Error(`Unexpected query ${p}`);
        },
        activeTexture(unit) { state.active = unit; },
        getProgramParameter(p, name) { assert.equal(p, program); return name === this.LINK_STATUS ? !options.unlinked : 1; },
        getAttachedShaders: () => options.missingStage ? [vertex] : [fragment, vertex],
        getShaderParameter(shader, name) { return name === this.SHADER_TYPE ? shader.type : !(options.uncompiled && shader === fragment); },
        getShaderSource: shader => shader.source,
        getShaderInfoLog: () => '', getProgramInfoLog: () => '',
        getActiveUniform() { return { name: 'map', type: options.wrongSamplerType ? 5126 : this.SAMPLER_2D, size: 1 }; },
        getUniformLocation: () => options.missingMap ? null : location,
        getUniform(p, l) { assert.equal(p, program); assert.equal(l, location); state.uniformReads++; return options.invalidUnit ? -1 : 3; },
        getTexParameter(target, name) {
            assert.equal(target, this.TEXTURE_2D); assert.equal(state.active, this.TEXTURE0 + 3);
            if (options.queryThrows) throw Error('injected texture query failure');
            if (name === this.TEXTURE_MIN_FILTER) return options.badMin ? this.NEAREST : this.LINEAR_MIPMAP_LINEAR;
            if (name === this.TEXTURE_MAG_FILTER) return options.badMag ? this.NEAREST : this.LINEAR;
            if (name === this.TEXTURE_WRAP_S) return options.badWrap ? this.CLAMP_TO_EDGE : this.REPEAT;
            if (name === this.TEXTURE_WRAP_T) return this.CLAMP_TO_EDGE;
            if (name === 34046) return options.badAnisotropy ? 1 : 4;
            throw Error(`Unexpected texture query ${name}`);
        },
        getExtension: () => options.noAnisotropyExtension ? null : { TEXTURE_MAX_ANISOTROPY_EXT: 34046, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 34047 },
        drawArrays() { assert.equal(state.active, 33990, 'observer must restore active texture before real draw'); state.actualDraws++; if (options.drawThrows) throw Error('original draw failure'); },
        drawElements() { assert.equal(state.active, 33990, 'observer must restore active texture before real draw'); state.actualDraws++; if (options.drawThrows) throw Error('original draw failure'); },
    };
    const material = { map: { minFilter: 1008, magFilter: 1006, wrapS: 1000, wrapT: 1001, anisotropy: 4 },
        onBeforeRender(...args) { assert.equal(this, material); assert.equal(args[4], ring); state.oldBefore++; if (options.callbackThrows) throw Error('original callback failure'); } };
    const ring = { material, onAfterRender() { assert.equal(this, ring); state.oldAfter++; } };
    const renderer = { getContext: () => gl, properties: { get(map) { assert.equal(map, material.map); return { __webglTexture: texture }; } } };
    const original = { drawArrays: gl.drawArrays, drawElements: gl.drawElements, before: material.onBeforeRender, after: ring.onAfterRender };
    const render = () => {
        if (!options.noCallback) material.onBeforeRender(renderer, {}, {}, {}, ring, null);
        state.uploaded = true;
        if (!options.noNativeDraw) {
            if (options.arrayDraw) gl.drawArrays(gl.TRIANGLES, 0, options.emptyDraw ? 0 : 6);
            else gl.drawElements(gl.TRIANGLES, options.emptyDraw ? 0 : 6, gl.UNSIGNED_INT, 0);
        }
        ring.onAfterRender(renderer, {}, {}, {}, material, null);
        if (options.unrelatedAfter) gl.drawArrays(gl.TRIANGLES, 0, 3);
        return 'production-value';
    };
    const restored = () => {
        assert.equal(gl.drawArrays, original.drawArrays); assert.equal(gl.drawElements, original.drawElements);
        assert.equal(material.onBeforeRender, original.before); assert.equal(ring.onAfterRender, original.after);
        assert.equal(state.active, 33990);
    };
    return { gl, state, renderer, ring, render, restored };
}
for (const options of [{}, { arrayDraw: true }, { noAnisotropyExtension: true }]) {
    const m = nativeMock(options), result = observe(m.renderer, [m.ring], m.render);
    assert.equal(result.value, 'production-value'); assert.equal(result.proof.samples.length, 1);
    assert(result.proof.stateEvidenceOnly && !result.proof.alphaGapGuarantee && result.proof.hooksRestored);
    assert.equal(result.proof.samples[0].sampler.textureUnit, 3);
    assert.equal(result.proof.samples[0].sampler.anisotropy, options.noAnisotropyExtension ? null : 4);
    assert.equal(m.state.actualDraws, 1); assert.equal(m.state.uniformReads, 1);
    assert.equal(m.state.oldBefore, 1); assert.equal(m.state.oldAfter, 1); m.restored();
}
for (const [option, expected] of [
    ['contextLost', /GPU context is lost/], ['missingProgram', /CURRENT_PROGRAM is missing/],
    ['unlinked', /did not link/], ['uncompiled', /did not compile/], ['missingStage', /both compiled shader/],
    ['wrongProgram', /not the native ring shader/], ['wrongSamplerType', /one sampler2D/],
    ['missingMap', /location is missing/], ['invalidUnit', /valid uploaded texture unit/],
    ['wrongTexture', /not bound to this native ring texture/], ['samplerOverride', /sampler object overrides/],
    ['badMin', /minification/], ['badMag', /magnification/], ['badWrap', /wrapping/],
    ['badAnisotropy', /anisotropy/], ['queryThrows', /injected texture query failure/], ['emptyDraw', /empty draw/],
]) {
    const m = nativeMock({ [option]: true });
    assert.throws(() => observe(m.renderer, [m.ring], m.render), expected, option);
    assert.equal(m.state.actualDraws, 1, 'failing proof must still call the unchanged native draw'); m.restored();
}
for (const options of [{ noCallback: true }, { noNativeDraw: true, unrelatedAfter: true }]) {
    const m = nativeMock(options);
    assert.throws(() => observe(m.renderer, [m.ring], m.render), /no actual draw/);
    assert.equal(m.state.uniformReads, 0, 'unrelated draw must never satisfy ring proof'); m.restored();
}
for (const option of ['drawThrows', 'callbackThrows']) {
    const m = nativeMock({ [option]: true });
    assert.throws(() => observe(m.renderer, [m.ring], m.render), /original .* failure/); m.restored();
}
console.log('Disk-plane QA source-only smoke passed: 34 cases; whole-support occlusion and retained overlapping emission; crossing/pixel negative controls; real native-ring program/sampler mocks and cleanup failures; settled assets; synchronous context recovery; browser-free validation. Runtime acceptance has not run.');
