import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Isolated local CPU test. It does not start a browser, renderer or server.
// When outside a checkout, pass DISK_TEST_ROOT. Under scripts/, root defaults
// to the parent checkout so the file can be copied there unchanged.
const root = resolve(process.env.DISK_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url)));
const THREE = await import(pathToFileURL(resolve(root, 'node_modules/three/build/three.module.js')));
const { LY_SCENE, CAM_DIST_MAX } = await import(pathToFileURL(resolve(root, 'src/constants.js')));
const source = readFileSync(resolve(root, 'src/holeOptics.js'), 'utf8');
const start = source.indexOf('#if HOLE_LAYER == 1');
const disk = source.slice(start, source.indexOf('#if HOLE_LAYER == 2', start));
const normalizedNames = ['halfSupport', 'planeHit', 'halfWidth', 'depthPerRs', 'entry', 'exitHit', 'coverage', 'hit'];
// Use the actual production assignments, including slow-branch assignments
// after an eventual fast-path initialization of hit/coverage.
const declarations = normalizedNames.map(name => {
    const matches = [...disk.matchAll(new RegExp(`\\b(?:float\\s+)?${name}\\s*=\\s*([^;]+);`, 'g'))];
    assert.ok(matches.length, `actual normalized GLSL assigns ${name}`);
    return { name, expr: matches.at(-1)[1] };
});
const existingSmoke = readFileSync(resolve(root, 'scripts/smoke-disk-plane-support.mjs'), 'utf8');
const helpers = existingSmoke.slice(existingSmoke.indexOf('function parse(expression)'), existingSmoke.indexOf('const evaluate64 = evaluator'));
assert.ok(helpers.includes('function evaluator(round)'), 'reuse the existing expression evaluator rather than recopy GLSL math');
const { evaluate32, evaluate64 } = new Function('assert', 'declarations', `${helpers}\nreturn { evaluate32: evaluator(Math.fround), evaluate64: evaluator(x => x) };`)(assert, declarations);

const f = Math.fround;
const add = (a, b) => f(a + b), mul = (a, b) => f(a * b);
const dot = (a, b) => add(add(mul(a[0], b[0]), mul(a[1], b[1])), mul(a[2], b[2]));
const norm = a => { const length = f(Math.sqrt(dot(a, a))); return a.map(x => f(x / length)); };
const mat3 = (a, v) => [0, 1, 2].map(row => add(add(mul(a[row], v[0]), mul(a[row + 3], v[1])), mul(a[row + 6], v[2])));
const mat4 = (a, v) => [0, 1, 2, 3].map(row => add(add(add(mul(a[row], v[0]), mul(a[row + 4], v[1])), mul(a[row + 8], v[2])), mul(a[row + 12], v[3])));
const close = (a, b, tolerance, label) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} versus ${b}`);

function scalar({ z, slope, h = .02, near = .01, far = 1e9, distance = Math.max(1, Math.abs(z) * 2), depth = 1 }) {
    return { 'ro.z': z, 'rd.z': slope, uDiskOn: 1, uDistance: distance,
        derivativeX: [2 * h / distance, 0, 0], derivativeY: [0, 0, 0],
        ray: [0, 0, 1], uViewDepth: [0, 0, 1], uRsUnits: depth,
        uNear: near * depth, uFar: far * depth };
}
let scalarCases = 0;
for (const z of [-1e9, -1e6, -100, -1, 1, 100, 1e6, 1e9]) {
    for (const speed of [.0001, .125, .5, 1]) for (const h of [.001, .0078125, .02]) {
        const slope = -Math.sign(z) * speed, input = scalar({ z, slope, h, far: Math.abs(z / slope) * 2 });
        const actual = evaluate32(input), planeHit = f(-f(z) / f(slope));
        assert.ok(actual.active);
        assert.equal(actual.coverage, 1, 'complete support has exact unit coverage');
        assert.equal(actual.hit, planeHit, 'complete support preserves the exact original float32 plane hit');
        scalarCases++;
    }
}
// Dyadic values keep endpoint-touch classification unambiguous in float32.
for (const [near, far, expected] of [[0, 1, 1], [.0625, 1, .5], [0, .0625, .5], [.0546875, .0703125, .5], [.078125, 1, 0], [0, .046875, 0]]) {
    const input = scalar({ z: .03125, slope: -.5, h: .0078125, near, far });
    for (const evaluate of [evaluate32, evaluate64]) close(evaluate(input).coverage, expected, 1e-12, 'near/far-truncated normalized interval');
    scalarCases++;
}
for (const z of [-.03, -.02, -.01, -1e-8, 0, 1e-8, .01, .02, .03]) {
    for (const slope of [-.5, .5]) {
        const input = scalar({ z, slope, near: 0 }), reflected = { ...input, 'ro.z': -z, 'rd.z': -slope };
        const actual = evaluate32(input), reflection = evaluate32(reflected);
        const expected = Math.max(0, Math.min(1, (Math.sign(slope) * .02 - z) / (2 * Math.sign(slope) * .02)));
        close(actual.coverage, expected, 2e-6, 'signed-plane coverage integral');
        assert.equal(actual.active, reflection.active);assert.equal(actual.coverage, reflection.coverage);
        if (actual.active) assert.equal(actual.hit, reflection.hit);
        scalarCases++;
    }
}
for (const slope of [0, 1e-8, -1e-8, 1e-7, -1e-7]) {
    assert.equal(evaluate32(scalar({ z: 0, slope })).active, false, 'tangent/parallel guard remains inactive');scalarCases++;
}
const farInput = scalar({ z: 1e6, slope: -.5 });
const formerA = f(f(-f(.02) - f(1e6)) / f(-.5)), formerB = f(f(f(.02) - f(1e6)) / f(-.5));
assert.equal(formerA, formerB, 'negative fixture reproduces absolute-endpoint cancellation');
assert.equal(evaluate32(farInput).coverage, 1, 'normalized path retains the distant interval');

function cameraFixture({ aspect = 1.5, rotationY = 0, normal = [0, 0, 1], origin = [6, 0, 10], near = .1, far = 100, scale = 1, rsUnits = 1, asymmetric = false, viewportWidth = 960, viewportHeight = 640 } = {}) {
    const camera = new THREE.PerspectiveCamera(48, aspect, near, far);
    camera.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
    camera.scale.setScalar(scale);camera.updateMatrixWorld(true);
    if (asymmetric) {
        camera.projectionMatrix.makePerspective(-near * .3, near * .7, near * .6, -near * .2, near, far);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }
    const rotation = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().extractRotation(camera.matrixWorld));
    const view = camera.matrixWorldInverse.elements;
    return { camera, origin: new THREE.Vector3(...origin), normal: new THREE.Vector3(...normal).normalize(), rotation,
        inverseProjection: camera.projectionMatrixInverse, viewDepth: new THREE.Vector3(-view[2], -view[6], -view[10]), rsUnits, viewportWidth, viewportHeight };
}
function rayInput(view, x, y, h) {
    const projected = mat4(view.inverseProjection.elements.map(f), [f(x), f(y), 0, 1]);
    const viewRay = norm(projected.slice(0, 3).map(value => f(value / projected[3])));
    const ray = norm(mat3(view.rotation.elements.map(f), viewRay));
    const origin = view.origin.toArray().map(f), normal = view.normal.toArray().map(f), distance = f(view.origin.length());
    return { 'ro.z': dot(origin, normal), 'rd.z': dot(ray, normal), uDiskOn: 1, uDistance: distance,
        ray, uViewDepth: view.viewDepth.toArray().map(f), uRsUnits: view.rsUnits, uNear: view.camera.near, uFar: view.camera.far,
        derivativeX: [2 * h / distance, 0, 0], derivativeY: [0, 0, 0] };
}

// The eligibility adapter is intentionally isolated. Wire it to the actual
// implementation API, never to a test-only replacement eligibility formula.
const policySource = source.slice(source.indexOf('export function diskSupportUnclipped('), source.indexOf('\nexport function makeHoleOptics'));
assert.ok(policySource.startsWith('export function diskSupportUnclipped('));
const policy = new Function(`${policySource.replace('export function', 'function')}\nreturn diskSupportUnclipped;`)();
const policyInput = view => ({ origin: view.origin, normal: view.normal, viewDepth: view.viewDepth,
    rotation: view.rotation.elements, inverseProjection: view.inverseProjection.elements,
    near: view.camera.near, far: view.camera.far, rsUnits: view.rsUnits,
    viewportWidth: view.viewportWidth, viewportHeight: view.viewportHeight });
const eligible = view => policy(policyInput(view));
assert.match(disk, /float hit = -ro\.z\/rd\.z, coverage = 1\.0;/, 'fast GLSL retains original plane hit and unit coverage');
assert.match(disk, /float entry = -1\.0, exitHit = 1\.0;/, 'fast GLSL keeps a complete interval');
assert.match(disk, /#if !defined\(DISK_UNCLIPPED\) \|\| DISK_UNCLIPPED == 0 \|\| !defined\(HIGH_PRECISION\)/, 'only a proven highp static variant omits normalized support');

const positives = [
    ['face-on', cameraFixture()],
    ['mobile aspect', cameraFixture({ aspect: 390 / 700, viewportWidth: 390, viewportHeight: 700 })],
    ['tilted complete frustum', cameraFixture({ normal: [.2, .1, 1] })],
    ['reflected plane', cameraFixture({ normal: [0, 0, -1] })],
    ['distant cancellation', cameraFixture({ aspect: 1, rotationY: Math.PI / 3, origin: [1732098.75, 0, 1e6], far: 1e9 })],
    ['typical positive .48 pitch', cameraFixture({ normal: [0, Math.cos(.48), Math.sin(.48)], origin: [0, 0, 8], far: 1e18 })],
    ['typical negative .48 pitch', cameraFixture({ normal: [0, -Math.cos(.48), Math.sin(.48)], origin: [0, 0, 8], far: 1e18 })],
    ['large inverse-projection w', cameraFixture({ near: 2 ** -33 })],
    ['small inverse-projection w', cameraFixture({ origin: [0, 0, 1e12], near: 2 ** 31, far: 1e15 })],
    ['exact production full far at .48 pitch', cameraFixture({ normal: [0, Math.cos(.48), Math.sin(.48)], origin: [0, 0, 8], near: .02, far: CAM_DIST_MAX * 1.35 })],
    ['full far 1e20', cameraFixture({ far: 1e20 })],
    ['production near tier', cameraFixture({ near: .02, far: LY_SCENE * .02 })],
    ['production far tier', cameraFixture({ origin: [0, 0, 1e12], near: LY_SCENE * .02, far: CAM_DIST_MAX * 1.35 })],
];
const tangentTilt = Math.atan(1 / (Math.tan(24 * Math.PI / 180) * 1.5));
const negatives = [
    ['camera in plane', cameraFixture({ origin: [6, 0, 0], near: .001 })],
    ['camera inside maximum support', cameraFixture({ origin: [6, 0, .01], near: .001 })],
    ['near clips support', cameraFixture({ near: 9.995 })],
    ['far clips support', cameraFixture({ far: 10.005 })],
    ['near touches support', cameraFixture({ near: 9.98 })],
    ['far touches support', cameraFixture({ far: 10.02 })],
    ['plane behind eye', cameraFixture({ origin: [6, 0, -10] })],
    ['frustum crosses tangent', cameraFixture({ normal: [1, 0, 0] })],
    ['frustum edge is tangent', cameraFixture({ normal: [Math.sin(tangentTilt), 0, Math.cos(tangentTilt)] })],
    ['invalid near', cameraFixture({ near: -1 })],
    ['reversed clipping', cameraFixture({ near: 20, far: 10 })],
    ['invalid origin', cameraFixture({ origin: [NaN, 0, 10] })],
    ['invalid rs units', cameraFixture({ rsUnits: 0 })],
    ['asymmetric perspective', cameraFixture({ asymmetric: true })],
    ['near safety margin', cameraFixture({ near: 5 })],
    ['far safety margin', cameraFixture({ far: 20 })],
    ['scaled XR view', cameraFixture({ scale: .004 })],
    ['large scaled XR view', cameraFixture({ scale: 250 })],
    ['catastrophic signed-height cancellation', cameraFixture({ origin: [1e19, -1e19, 1], normal: [1, 1, 0] })],
    ['near object cannot use far-tier shortcut', cameraFixture({ near: LY_SCENE * .02, far: CAM_DIST_MAX * 1.35 })],
    ['far object cannot use near-tier shortcut', cameraFixture({ origin: [0, 0, 1e12], near: .02, far: LY_SCENE * .02 })],
    ['viewport below helper-halo minimum', cameraFixture({ viewportWidth: 3 })],
    ['fractional viewport', cameraFixture({ viewportWidth: 960.5 })],
    ['unbounded viewport', cameraFixture({ viewportHeight: 32769 })],
];
const invalidNormal = cameraFixture();invalidNormal.normal.set(0, 0, 0);negatives.push(['invalid normal', invalidNormal]);
const nonfiniteProjection = cameraFixture();nonfiniteProjection.inverseProjection.elements[0] = NaN;negatives.push(['nonfinite projection', nonfiniteProjection]);
const orthographic = cameraFixture();orthographic.inverseProjection = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 100).projectionMatrixInverse;negatives.push(['orthographic projection', orthographic]);
const sheared = cameraFixture();sheared.rotation.elements[3] = .001;negatives.push(['nonorthonormal rotation', sheared]);
const badView = cameraFixture();badView.viewDepth.multiplyScalar(.99);negatives.push(['nonunit view-depth axis', badView]);
const wide = cameraFixture();wide.inverseProjection.elements[0] = 2.01;negatives.push(['projection beyond proved range', wide]);
const haloTooWide = cameraFixture({ viewportWidth: 4 });haloTooWide.inverseProjection.elements[0] = 1.01;negatives.push(['helper halo expands beyond proved range', haloTooWide]);
const haloCrossing = cameraFixture({ normal: [Math.sin(53 * Math.PI / 180), 0, Math.cos(53 * Math.PI / 180)],
    near: .01, far: 1e4, viewportWidth: 16, viewportHeight: 16 });
for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) {
    const result = evaluate32(rayInput(haloCrossing, x, y, .02));
    assert.ok(result.active && result.coverage === 1, 'halo counterexample has complete visible-frustum sample support');
}
assert.equal(evaluate32(rayInput(haloCrossing, 1.25, 0, .02)).active, false, 'helper lane outside the viewport points behind the plane');
negatives.push(['visible frustum is safe but derivative halo crosses the plane', haloCrossing]);
const badW = cameraFixture();badW.inverseProjection.elements[15] = 2 ** 33;negatives.push(['projection w beyond proved range', badW]);
const depthClamp = cameraFixture({ near: 1e-15, far: 1e-12, rsUnits: 2 ** -32 });
depthClamp.inverseProjection.elements = [1e-8, 0, 0, 0, 0, 1e-8, 0, 0, 0, 0, 0, -1, 0, 0, -1, 1];
depthClamp.viewDepth.set(Math.sqrt(1 - 1e-8), 0, -1e-4);negatives.push(['shader depthPerRs clamp would change clipping', depthClamp]);
const cancelledHeight = cameraFixture({ origin: [1e8, 1, -1e8], normal: [1, 1, 1], near: .001 });
cancelledHeight.camera.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cancelledHeight.normal);
cancelledHeight.camera.updateMatrixWorld(true);
cancelledHeight.rotation.setFromMatrix4(new THREE.Matrix4().extractRotation(cancelledHeight.camera.matrixWorld));
cancelledHeight.viewDepth.set(-cancelledHeight.camera.matrixWorldInverse.elements[2], -cancelledHeight.camera.matrixWorldInverse.elements[6], -cancelledHeight.camera.matrixWorldInverse.elements[10]);
assert.ok(cancelledHeight.origin.dot(cancelledHeight.normal) > .5, 'CPU dot looks outside the support');
assert.equal(rayInput(cancelledHeight, 0, 0, .02)['ro.z'], 0, 'float32 dot cancels the apparent signed height');
negatives.push(['CPU origin dot disagrees with uploaded float32 dot', cancelledHeight]);

let rayCases = 0;
for (const [label, view] of positives) {
    assert.equal(eligible(view), true, `${label}: useful complete-support view qualifies`);
    const input = policyInput(view), arrays = { ...input, origin: view.origin.toArray(), normal: view.normal.toArray(), viewDepth: view.viewDepth.toArray() };
    assert.equal(policy(arrays), true, `${label}: array API agrees with Vector3 API`);
    assert.equal(policy({ ...arrays, origin: new Float32Array(arrays.origin), normal: new Float32Array(arrays.normal), viewDepth: new Float32Array(arrays.viewDepth), rotation: new Float32Array(arrays.rotation), inverseProjection: new Float32Array(arrays.inverseProjection) }), true, `${label}: uploaded float32 inputs qualify`);
    for (let ix = 0; ix <= 16; ix++) for (let iy = 0; iy <= 16; iy++) for (const h of [.001, .02]) {
        const input = rayInput(view, (-1 + ix / 8) * (1 + 4 / view.viewportWidth), (-1 + iy / 8) * (1 + 4 / view.viewportHeight), h), result = evaluate32(input);
        assert.ok(result.active, `${label}: active full-frustum ray`);
        assert.equal(result.coverage, 1, `${label}: all sampled rays have full coverage`);
        assert.equal(result.hit, f(-f(input['ro.z']) / f(input['rd.z'])), `${label}: all sampled hits match main exactly`);
        rayCases++;
    }
}
for (const [label, view] of negatives) assert.equal(eligible(view), false, `${label}: uncertain or incomplete support rejects fast path`);
for (const bad of [undefined, null, {}, { origin: null }, { ...policyInput(positives[0][1]), normal: [1, 2] },
    { ...policyInput(positives[0][1]), rotation: [1, 2, 3] }, { ...policyInput(positives[0][1]), far: Infinity },
    { ...policyInput(positives[0][1]), viewportWidth: undefined }, { ...policyInput(positives[0][1]), viewportHeight: NaN }]) {
    assert.equal(policy(bad), false, 'malformed/missing eligibility inputs fail closed');
}
for (const [label, view] of negatives.filter(([label]) => ['near clips support', 'far clips support', 'camera in plane', 'camera inside maximum support'].includes(label))) {
    const result = evaluate32(rayInput(view, 0, 0, .02));
    assert.ok(result.active && result.coverage > 0 && result.coverage < 1, `${label}: fallback preserves an actual partially covered ray`);
}

// Deterministic in-memory mutation controls. These deliberately weaken one
// production proof guard at a time and must reverse the result on a fixture
// that already checks the corresponding shader behavior. No source is edited.
const mutations = [
    ['remove derivative halo',
        'const extentX=projection[0]*(1+4/width), extentY=projection[5]*(1+4/height);',
        'const extentX=projection[0], extentY=projection[5];', haloCrossing, false],
    ['restore insufficient far magnitude cap', 'Math.abs(x)>2**70', 'Math.abs(x)>2**64',
        positives.find(([label]) => label === 'exact production full far at .48 pitch')[1], true],
    ['remove shader depth-clamp guard', ' && rs*depth[0]>2e-12', '', depthClamp, false],
    ['remove origin-dot error bounds',
        'const heightLo=Math.abs(originZ)-originError, heightHi=Math.abs(originZ)+originError;',
        'const heightLo=Math.abs(originZ), heightHi=Math.abs(originZ);', cancelledHeight, false],
    ['remove near eligibility guard', 'first>2*near', 'true',
        negatives.find(([label]) => label === 'near clips support')[1], false],
    ['remove far eligibility guard', 'last<far/2', 'true',
        negatives.find(([label]) => label === 'far clips support')[1], false],
];
for (const [label, from, to, view, original] of mutations) {
    assert.equal(policySource.split(from).length, 2, `${label}: mutation has one exact production target`);
    const mutatedSource = policySource.replace(from, to).replace('export function', 'function');
    const mutatedPolicy = new Function(`${mutatedSource}\nreturn diskSupportUnclipped;`)();
    assert.equal(eligible(view), original, `${label}: unmodified proof preserves expected result`);
    assert.equal(mutatedPolicy(policyInput(view)), !original, `${label}: fixture detects the weakened proof`);
}

// Seeded adversarial sweeps challenge accepted views, including uploads near
// float32 limits and camera-height cancellation. Rejection is permitted for
// these generated cameras; acceptance must imply exact full-support parity.
let seed = 0x51c0ffee;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
let generatedAccepted = 0, generatedRejected = 0, generatedRays = 0;
for (let i = 0; i < 400; i++) {
    const height = 10 ** (-1.5 + 10 * random()), rsUnits = 2 ** (-28 + 56 * random());
    const near = height * rsUnits * 10 ** (-4 + 4 * random()), far = height * rsUnits * 10 ** (.1 + 5 * random());
    const view = cameraFixture({ aspect: .3 + 2.2 * random(), near, far, rsUnits, viewportWidth: 4 + Math.floor(random() * 2048), viewportHeight: 4 + Math.floor(random() * 2048) });
    view.camera.fov = 1 + 99 * random();view.camera.updateProjectionMatrix();
    view.camera.quaternion.setFromEuler(new THREE.Euler(random() * 6, random() * 6, random() * 6));view.camera.updateMatrixWorld(true);
    view.rotation.setFromMatrix4(new THREE.Matrix4().extractRotation(view.camera.matrixWorld));
    view.viewDepth.set(-view.camera.matrixWorldInverse.elements[2], -view.camera.matrixWorldInverse.elements[6], -view.camera.matrixWorldInverse.elements[10]);
    const tilt = random() * 1.4, azimuth = random() * Math.PI * 2;
    view.normal.set(Math.sin(tilt) * Math.cos(azimuth), Math.sin(tilt) * Math.sin(azimuth), Math.cos(tilt)).applyMatrix3(view.rotation).normalize();
    const tangent = new THREE.Vector3().crossVectors(view.normal, new THREE.Vector3(.3, .4, .5)).normalize();
    view.origin.copy(view.normal).multiplyScalar(height).addScaledVector(tangent, height * 10 ** (-2 + 8 * random()));
    if (i % 3 === 0) view.normal.negate();
    if (!eligible(view)) { generatedRejected++;continue; }
    generatedAccepted++;
    const points = [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, 0], [-1, 0], [1, 0], [0, -1], [0, 1],
        ...Array.from({ length: 12 }, () => [random() * 2 - 1, random() * 2 - 1])];
    for (const [x, y] of points) for (const h of [.001, .02]) {
        const input = rayInput(view, x * (1 + 4 / view.viewportWidth), y * (1 + 4 / view.viewportHeight), h), actual = evaluate32(input);
        assert.ok(actual.active, `generated view ${i}: eligible ray is active`);
        assert.equal(actual.coverage, 1, `generated view ${i}: eligible ray has unit coverage`);
        assert.equal(actual.hit, f(-f(input['ro.z']) / f(input['rd.z'])), `generated view ${i}: original plane hit is bit-identical`);
        generatedRays++;
    }
}
assert.ok(generatedAccepted > 10 && generatedRejected > 10, 'generated sweep exercises acceptance and fallback');

// Required pinned physical inputs from the completed v3 cohort. Matrices are
// reconstructed from fixture camera settings, never called captured matrices.
const capturePath = resolve(root, 'scripts/fixtures/disk-fast-path-captured.json');
let capturedCases = 0, capturedEligible = 0, capturedRays = 0;
assert.ok(existsSync(capturePath), 'required pinned v3 physical-input fixture exists');
{
    const captured = JSON.parse(readFileSync(capturePath, 'utf8'));
    assert.equal(captured.run, 37232097341);
    assert.equal(captured.head, 'c933da57dd26eba35deadb77f09783ca94ec042f');
    for (const test of captured.cases) {
        assert.match(test.reportSha256, /^[0-9a-f]{64}$/);assert.match(test.productionPngSha256, /^[0-9a-f]{64}$/);
        const params = test.captured, camera = test.reconstructedCamera;
        const view = cameraFixture({ ...params, aspect: params.viewportWidth / params.viewportHeight });
        view.camera.fov = camera.fov;view.camera.updateProjectionMatrix();
        const cp = Math.cos(camera.pitch), offset = new THREE.Vector3(camera.distance * cp * Math.cos(camera.yaw), camera.distance * Math.sin(camera.pitch), camera.distance * cp * Math.sin(camera.yaw));
        view.camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(offset, new THREE.Vector3(), view.camera.up));
        view.camera.updateMatrixWorld(true);view.rotation.setFromMatrix4(new THREE.Matrix4().extractRotation(view.camera.matrixWorld));
        view.viewDepth.set(-view.camera.matrixWorldInverse.elements[2], -view.camera.matrixWorldInverse.elements[6], -view.camera.matrixWorldInverse.elements[10]);
        assert.equal(eligible(view), test.expectedEligible, `${test.label}: captured physical inputs with reconstructed matrices`);
        capturedCases++;
        if (!test.expectedEligible) continue;
        capturedEligible++;
        for (let ix = 0; ix <= 8; ix++) for (let iy = 0; iy <= 8; iy++) for (const h of [.001, .02]) {
            const input = rayInput(view, (-1 + ix / 4) * (1 + 4 / view.viewportWidth), (-1 + iy / 4) * (1 + 4 / view.viewportHeight), h), actual = evaluate32(input);
            assert.ok(actual.active && actual.coverage === 1, `${test.label}: eligible captured view retains complete helper-halo support`);
            assert.equal(actual.hit, f(-f(input['ro.z']) / f(input['rd.z'])), `${test.label}: captured view preserves original plane hit`);
            capturedRays++;
        }
    }
    assert.equal(capturedCases, 20);assert.equal(capturedEligible, 8);
}
console.log(`Local disk reference: ${scalarCases} scalar cases and ${rayCases} reconstructed float32 frustum rays passed.`);
console.log(`Eligibility: ${positives.length} positive and ${negatives.length} negative fixtures passed.`);
console.log(`Adversarial sweep: ${generatedAccepted} eligible, ${generatedRejected} rejected views; ${generatedRays} accepted float32 rays matched the normalized path exactly.`);
console.log(`Proof mutation controls: ${mutations.length} deterministic guard changes detected.`);
console.log(`Required pinned v3 inputs: ${capturedCases} cases, ${capturedEligible} eligible, ${capturedRays} halo rays; matrices reconstructed from pinned camera settings.`);
console.log('Limits: CPU float32 operations and sampled rays are not GPU/compiler or performance evidence; eligibility needs its analytic full-frustum proof independently reviewed.');
// New static specialization also preserves the exact native inputs from the
// completed selection diagnostic, rather than only reconstructed older views.
const nativeCase=JSON.parse(readFileSync(resolve(root,'scripts/fixtures/disk-static-native.json'),'utf8'));
assert.equal(nativeCase.reportSha256,'299549f8614478dfd9b20e9faa8d816fe6d0d04792fe2b95951c1039637b5ee0');
assert.deepEqual(nativeCase.frames,[122,123,124,125]);assert.equal(nativeCase.effectivePrecision,'highp');
const nu=nativeCase.uniforms,nativeView=cameraFixture({near:nu.uNear,far:nu.uFar,rsUnits:nu.uRsUnits,origin:nu.uOrigin,normal:nu.uNormal,viewportWidth:nativeCase.viewport[2],viewportHeight:nativeCase.viewport[3]});
nativeView.inverseProjection.fromArray(nu.uInverseProjection);nativeView.rotation.fromArray(nu.uCameraRotation);nativeView.viewDepth.fromArray(nu.uViewDepth);
assert.equal(eligible(nativeView),nativeCase.expectedEligible);let nativeRays=0;
for(let ix=0;ix<=16;ix++)for(let iy=0;iy<=16;iy++)for(const h of [.001,.02]){
 const input=rayInput(nativeView,(-1+ix/8)*(1+4/nativeView.viewportWidth),(-1+iy/8)*(1+4/nativeView.viewportHeight),h),result=evaluate32(input);
 assert(result.active);assert.equal(result.coverage,1);assert.equal(result.hit,f(-f(input['ro.z'])/f(input['rd.z'])));nativeRays++;
}
console.log(`Actual native selection inputs: four matching draws, ${nativeRays} float32 helper-halo rays preserve exact normalized hit/coverage.`);
