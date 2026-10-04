import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { K, STARS, LY_SCENE, CAM_DIST_MAX } from '../src/constants.js';
import { namedHoleAppearance } from '../src/render/holeAppearance.js';

// CPU regression for raster support of the existing razor-thin disk. This is
// not a thickness/optical-depth model, a shader compilation test, GPU pixel
// evidence, or a performance benchmark. Issue 49 / ring rendering is untested.
// Optional, snapshot-specific audit:
//   node scripts/smoke-disk-plane-support.mjs --verify-main-scope
const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(new URL('../src/holeOptics.js', import.meta.url), 'utf8');
const mainCommit = '6179f23661591bb4dee89a0bf8e686233e1ba280';
const reviewedCommit = '48a9da40';
const diskStart = '        #if HOLE_LAYER == 1\n';
function diskBlock(text) {
    const start = text.indexOf(diskStart);
    assert.ok(start >= 0, 'disk layer exists');
    const end = text.indexOf('        #endif', start);
    assert.ok(end > start, 'disk layer ends');
    return text.slice(start, end);
}
const disk = diskBlock(source);
assert.match(disk, /if \(uDiskOn > 0\.5 && abs\(rd\.z\) > 1e-7\)/, 'existing disk/parallel-ray gate remains');
assert.match(disk, /if \(exitHit > entry && hit > 0\.0\)/, 'zero-length or backward support emits nothing');
assert.match(disk, /float mask = smoothstep\(1\.0,1\.0\+dx,x\) \* \(1\.0-smoothstep\(uRout\*\.82,uRout,x\)\) \* coverage;/,
    'normalized coverage weights the existing radial emission mask');
assert.match(source, /if \(z < uNear \|\| z > uFar\) discard;/, 'the final view-depth tier fence remains');

// Evaluate scalar expressions extracted from the actual GLSL. A deliberately
// small expression parser rounds every scalar operation in float32 mode; it
// does not substitute a second hand-copied implementation of the shader.
const scalarText = disk.slice(disk.indexOf('            float halfSupport'), disk.indexOf('            if (exitHit'));
const declarations = [...scalarText.matchAll(/float (\w+) = ([^;]+);/g)].map(([, name, expr]) => ({ name, expr }));
assert.deepEqual(declarations.map(({ name }) => name), ['halfSupport', 'planeHit', 'halfWidth', 'depthPerRs', 'entry', 'exitHit', 'coverage', 'hit']);

function parse(expression) {
    const tokens = expression.match(/(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|[()+\-*/,]/gi) ?? [];
    assert.equal(tokens.join(''), expression.replace(/\s/g, ''), `unsupported expression: ${expression}`);
    let at = 0;
    function primary() {
        const token = tokens[at++];
        if (token === '-' || token === '+') return { op: token === '-' ? 'neg' : 'pos', children: [primary()] };
        if (token === '(') {
            const result = binary(0);
            assert.equal(tokens[at++], ')');
            return result;
        }
        if (/^[\d.]/.test(token)) return { number: Number(token) };
        assert.match(token ?? '', /^[A-Za-z_]/);
        if (tokens[at] !== '(') return { variable: token };
        at++;
        const children = [];
        if (tokens[at] !== ')') {
            do { children.push(binary(0)); } while (tokens[at] === ',' && ++at);
        }
        assert.equal(tokens[at++], ')');
        return { op: token, children };
    }
    function binary(minPrecedence) {
        let left = primary();
        while (at < tokens.length) {
            const op = tokens[at], precedence = ({ '+': 1, '-': 1, '*': 2, '/': 2 })[op];
            if (precedence === undefined || precedence < minPrecedence) break;
            at++;
            left = { op, children: [left, binary(precedence + 1)] };
        }
        return left;
    }
    const result = binary(0);
    assert.equal(at, tokens.length);
    return result;
}
for (const declaration of declarations) declaration.ast = parse(declaration.expr);

function evaluator(round) {
    const add = (a, b) => round(a + b), mul = (a, b) => round(a * b);
    const dot = (a, b) => a.map((value, index) => mul(value, b[index])).reduce(add, round(0));
    function evaluate(ast, env) {
        if ('number' in ast) return round(ast.number);
        if ('variable' in ast) {
            assert.ok(ast.variable in env, `unknown GLSL input ${ast.variable}`);
            return env[ast.variable];
        }
        const args = ast.children.map(child => evaluate(child, env));
        const [a, b, c] = args;
        switch (ast.op) {
            case '+': return add(a, b);
            case '-': return round(a - b);
            case '*': return mul(a, b);
            case '/': return round(a / b);
            case 'neg': return round(-a);
            case 'pos': return a;
            case 'abs': return round(Math.abs(a));
            case 'max': return round(Math.max(a, b));
            case 'min': return round(Math.min(a, b));
            case 'clamp': return round(Math.min(c, Math.max(b, a)));
            case 'dot': return dot(a, b);
            case 'length': return round(Math.sqrt(dot(a, a)));
            case 'dFdx': return env.derivativeX;
            case 'dFdy': return env.derivativeY;
            default: assert.fail(`unsupported GLSL operation ${ast.op}`);
        }
    }
    return input => {
        const env = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, Array.isArray(value) ? value.map(round) : round(value)]));
        const enabled = env.uDiskOn > round(.5) && Math.abs(env['rd.z']) > round(1e-7);
        if (!enabled) return { enabled, active: false, coverage: 0 };
        for (const { name, ast } of declarations) env[name] = evaluate(ast, env);
        const values = Object.fromEntries(declarations.map(({ name }) => [name, env[name]]));
        return { ...values, enabled, active: values.exitHit > values.entry && values.hit > 0 };
    };
}
const evaluate64 = evaluator(value => value), evaluate32 = evaluator(Math.fround);
const half = 1 / 128;
function fixture({ z = 0, slope = .5, h = half, near = 0, far = 1, depthScale = 1, distance = 16, on = 1, derivativeY = 0 } = {}) {
    return {
        'ro.z': z, 'rd.z': slope, uDiskOn: on, uDistance: distance,
        derivativeX: [2 * h / distance, 0, 0], derivativeY: [0, derivativeY, 0],
        ray: [0, 0, 1], uViewDepth: [0, 0, 1], uRsUnits: depthScale,
        uNear: near * depthScale, uFar: far * depthScale,
    };
}
const close = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: got ${actual}, expected ${expected} (tolerance ${tolerance})`);

// Independent oracle: integrate a uniform normalized support density in
// signed plane coordinates between the camera's near/far depth boundaries.
// It never computes the shader's planeHit/halfWidth or normalized endpoints.
function oracle(input) {
    const z = input['ro.z'], slope = input['rd.z'];
    if (!(input.uDiskOn > .5 && Math.abs(slope) > 1e-7)) return { active: false, coverage: 0 };
    const h = Math.min(.02, Math.max(.001, input.uDistance * Math.max(Math.hypot(...input.derivativeX), Math.hypot(...input.derivativeY)) / 2));
    const scale = Math.max(1e-12, input.uRsUnits * input.uViewDepth.reduce((sum, value, index) => sum + value * input.ray[index], 0));
    const t0 = Math.max(0, input.uNear / scale), t1 = input.uFar / scale;
    if (t1 <= t0) return { active: false, coverage: 0 };
    const signedClip = value => Math.max(-h, Math.min(h, value));
    const start = signedClip(z + slope * t0), end = signedClip(z + slope * t1);
    const coverage = Math.abs(end - start) / (2 * h);
    return { active: coverage > 0, coverage, hit: ((start + end) / 2 - z) / slope };
}

let comparisons = 0;
function check(input, label, tolerance32 = 3e-6) {
    const expected = oracle(input);
    for (const [name, evaluate, tolerance] of [['float64', evaluate64, 2e-12], ['float32', evaluate32, tolerance32]]) {
        const actual = evaluate(input);
        assert.equal(actual.active, expected.active, `${label}: ${name} support classification`);
        close(actual.coverage, expected.coverage, tolerance, `${label}: ${name} normalized integral`);
        assert.ok(actual.coverage >= 0 && actual.coverage <= 1, `${label}: ${name} coverage is bounded`);
        if (actual.enabled) {
            for (const [key, value] of Object.entries(actual)) assert.ok(typeof value === 'boolean' || Number.isFinite(value), `${label}: ${name} ${key} is finite`);
        }
        if (actual.active) {
            close(actual.hit, expected.hit, tolerance * Math.max(1, Math.abs(expected.hit)), `${label}: ${name} clipped midpoint`);
            assert.ok(actual.entry >= -1 && actual.exitHit <= 1, `${label}: ${name} active offsets stay bounded`);
            const lower = actual.planeHit + actual.halfWidth * actual.entry;
            const upper = actual.planeHit + actual.halfWidth * actual.exitHit;
            const rounding = tolerance * Math.max(1, Math.abs(actual.hit));
            assert.ok(actual.hit >= lower - rounding && actual.hit <= upper + rounding, `${label}: ${name} hit stays inside support`);
        }
        comparisons++;
    }
}

// Explicit binary-exact cases make endpoint-touch rejection unambiguous in
// float32. The full interval is [3/64, 5/64], its plane hit is 1/16.
const cases = [
    ['full traversal', { z: 1 / 32, slope: -.5 }, 1, 1 / 16],
    ['near clips half', { z: 1 / 32, slope: -.5, near: 1 / 16 }, .5, 9 / 128],
    ['far clips half', { z: 1 / 32, slope: -.5, far: 1 / 16 }, .5, 7 / 128],
    ['both clip central half', { z: 1 / 32, slope: -.5, near: 7 / 128, far: 9 / 128 }, .5, 1 / 16],
    ['near touches exit', { z: 1 / 32, slope: -.5, near: 5 / 64 }, 0],
    ['far touches entry', { z: 1 / 32, slope: -.5, far: 3 / 64 }, 0],
    ['fully before near', { z: 1 / 32, slope: -.5, near: .125 }, 0],
    ['fully beyond far', { z: 1 / 32, slope: -.5, far: 1 / 32 }, 0],
    ['camera in plane', {}, .5, 1 / 128],
    ['camera inside support', { z: half / 2 }, .25, 1 / 256],
    ['inside facing other side', { z: half / 2, slope: -.5 }, .75, 3 / 256],
    ['outside facing away', { z: 2 * half }, 0],
    ['empty depth tier', { near: .1, far: .1 }, 0],
    ['inverted depth tier', { near: .2, far: .1 }, 0],
    ['disk off', { on: 0 }, 0],
    ['parallel ray', { slope: 0 }, 0],
    ['parallel threshold', { slope: 1e-7 }, 0],
    ['negative parallel threshold', { slope: -1e-7 }, 0],
];
for (const [label, params, coverage, hit] of cases) {
    const input = fixture(params);
    check(input, label);
    close(evaluate64(input).coverage, coverage, 1e-12, `${label}: explicit expected coverage`);
    if (hit !== undefined) close(evaluate64(input).hit, hit, 1e-12, `${label}: explicit expected hit`);
}
assert.equal(-0 / .5 > 0, false, 'old point-plane test reproduces the missing camera-in-plane frame');
assert.ok(evaluate32(fixture()).active, 'float32 support survives at the plane itself');

// Clamp endpoints and larger y derivative; the width follows a raster
// footprint within fixed bounds, with no unnormalized path-length gain.
for (const [params, expected] of [
    [{ h: .000001 }, .001], [{ h: half }, half], [{ h: 1 }, .02],
    [{ h: .001, derivativeY: .002 }, .016],
]) {
    const input = fixture(params);
    check(input, 'raster footprint clamp');
    close(evaluate64(input).halfSupport, expected, 1e-14, 'raster footprint chooses expected support');
}

let reflected = 0, unchanged = 0, partitions = 0;
for (const h of [.001, half, .02]) for (const slope of [-.9, -.125, -.001, .001, .125, .9]) {
    // Ordinary hits outside support have a full integral and the original
    // point-plane midpoint when the complete interval fits the depth tier.
    const outside = fixture({ h, z: -Math.sign(slope) * h * 4, slope, far: 1000 });
    check(outside, 'unclipped outside-support plane hit', 1e-5);
    for (const evaluate of [evaluate64, evaluate32]) {
        const result = evaluate(outside);
        close(result.coverage, 1, 1e-5, 'full support is normalized independent of incidence/width');
        close(result.hit, -outside['ro.z'] / slope, 1e-5 * Math.max(1, result.hit), 'old plane hit remains the midpoint');
    }
    unchanged++;
    // Sweep both faces, both support boundaries and the signed plane itself.
    for (const fraction of [-2, -1.0001, -1, -.9999, -.5, -1e-4, 0, 1e-4, .5, .9999, 1, 1.0001, 2]) {
        const input = fixture({ h, z: fraction * h, slope, near: h / 8, far: 1000 });
        check(input, `signed height ${fraction}, slope ${slope}`, 2e-5);
        const reflection = { ...input, 'ro.z': -input['ro.z'], 'rd.z': -input['rd.z'] };
        for (const evaluate of [evaluate64, evaluate32]) {
            const a = evaluate(input), b = evaluate(reflection);
            assert.equal(a.active, b.active, 'reflection preserves support classification');
            close(a.coverage, b.coverage, 1e-12, 'reflection preserves normalized coverage');
            if (a.active) close(a.hit, b.hit, 1e-12, 'reflection preserves sampled radial position/depth');
        }
        reflected++;
    }
    // Independent clipped tiers partition the same normalized ray integral.
    const end = 6 * h / Math.abs(slope);
    for (const evaluate of [evaluate64, evaluate32]) {
        let sum = 0;
        for (let k = 0; k < 16; k++) {
            sum += evaluate(fixture({ h, z: outside['ro.z'], slope, near: k * end / 16, far: (k + 1) * end / 16 })).coverage;
        }
        close(sum, 1, 2e-5, 'clipped tier coverage sums to the full traversal');
    }
    partitions++;
}

// The one-sided near-clipped integral approaches the same value at z=0.
for (const slope of [-.5, .5]) for (const evaluate of [evaluate64, evaluate32]) {
    const centre = evaluate(fixture({ slope, near: half / 4 }));
    const epsilon = half / 65536;
    const before = evaluate(fixture({ z: -epsilon, slope, near: half / 4 }));
    const after = evaluate(fixture({ z: epsilon, slope, near: half / 4 }));
    assert.ok(before.active && centre.active && after.active, 'no missing signed-plane crossing sample');
    close(before.coverage, centre.coverage, 1e-5, 'negative side approaches camera-in-plane coverage');
    close(after.coverage, centre.coverage, 1e-5, 'positive side approaches camera-in-plane coverage');
}

// View-depth units change with an XR rig/rs scale; clipping must operate in
// ray-distance units rather than using view depth directly as a ray hit.
for (const depthScale of [.004, 1, 250, 1e15]) for (const slope of [-.5, .5]) {
    check(fixture({ z: -Math.sign(slope) / 32, slope, near: 7 / 128, far: 9 / 128, depthScale }), 'scaled near/far clipping');
    const oblique = fixture({ z: -Math.sign(slope) / 32, slope, near: .8 * 7 / 128, far: .8 * 9 / 128, depthScale });
    oblique.ray = [.6, 0, .8];
    check(oblique, 'oblique view-depth clipping');
}
check(fixture({ slope: 1.01e-7, far: 1e6 }), 'just above parallel threshold');
check(fixture({ slope: -1.01e-7, far: 1e6 }), 'negative just above parallel threshold');

// Large normalized camera heights must preserve the original plane hit and
// unit coverage; differencing absolute float32 support endpoints lost both.
for (const height of [1, 1e3, 1e6, 1e9]) for (const slope of [-.5, .5]) {
    const input = fixture({ z: -Math.sign(slope) * height, slope, h: .02, distance: 2 * height, far: 5 * height });
    check(input, 'large-height full support');
    const result = evaluate32(input);
    assert.equal(result.coverage, 1, 'unclipped distant support has exactly unit float32 coverage');
    assert.equal(result.hit, Math.fround(-Math.fround(input['ro.z']) / Math.fround(slope)), 'unclipped distant hit is exactly the original float32 plane hit');
}

// Reachable negative fixture for the former absolute-endpoint calculation:
// an emitting-annulus hit, a plausible 2160px perspective quad and the actual
// Cygnus profile/tier dimensions. This emulates scalar float32 operations,
// not GPU derivatives or compiler contraction/reordering. The named disk is
// subpixel here; this does not establish a resolved appearance regression.
function distantRegression() {
    const f = Math.fround, add = (a, b) => f(a + b), mul = (a, b) => f(a * b), div = (a, b) => f(a / b);
    const dot = (a, b) => add(add(mul(a[0], b[0]), mul(a[1], b[1])), mul(a[2], b[2]));
    const norm = a => { const length = f(Math.sqrt(dot(a, a))); return a.map(value => div(value, length)); };
    const smooth = (a, b, x) => {
        const t = f(Math.max(0, Math.min(1, div(f(x - a), f(b - a)))));
        return mul(mul(t, t), f(3 - mul(2, t)));
    };
    const star = STARS.find(s => s.name === 'CYGNUS X-1'), profile = namedHoleAppearance(star);
    const forward = norm([-Math.sqrt(3) / 2, 0, -.5].map(f)), right = norm([.5, 0, -Math.sqrt(3) / 2].map(f));
    const ro = [f(-mul(forward[0], 2e6) + 48), 0, 1e6], distance = f(Math.hypot(...ro));
    const height = 2160, tanFov = Math.tan(24 * Math.PI / 180), delta = f(2 * tanFov / height);
    const samples = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => {
        const ray = norm(forward.map((value, i) => add(add(value, mul(x * delta, right[i])), i === 1 ? y * delta : 0)));
        const hit = div(-ro[2], ray[2]), point = ro.map((value, i) => add(value, mul(hit, ray[i])));
        return { ray, hit, point, x: div(f(Math.hypot(point[0], point[1])), 3) };
    });
    const x = samples[0].x, dx = f(Math.abs(f(samples[1].x - x)) + Math.abs(f(samples[2].x - x)));
    const oldMask = mul(smooth(1, add(1, dx), x), f(1 - smooth(mul(profile.routOverRin, .82), profile.routOverRin, x)));
    const cosAngle = dot(forward, ro.map(value => div(-value, distance)));
    const behind = samples[0].hit >= mul(distance, cosAngle);
    const scale = star.rs * K, near = .02, far = LY_SCENE * .02;
    const input = {
        ...fixture({ z: ro[2], slope: forward[2], distance }),
        ray: forward, uViewDepth: forward, uRsUnits: scale, uNear: near, uFar: far,
        derivativeX: samples[1].ray.map((value, i) => f(value - forward[i])),
        derivativeY: samples[2].ray.map((value, i) => f(value - forward[i])),
    };
    const support = evaluate32(input), oldDepth = mul(samples[0].hit, f(scale));
    const drawRatio = 3 * profile.routOverRin / distance / tanFov;
    const centreViewDepth = -dot(ro, forward);
    const oldReachable = profile.diskOn && x > 1 && x < profile.routOverRin && !behind
        && oldMask > .0005 && oldDepth >= near && oldDepth <= far && oldDepth < CAM_DIST_MAX
        && centreViewDepth > 0 && drawRatio > 1e-5;
    const formerA = div(f(-support.halfSupport - ro[2]), forward[2]);
    const formerB = div(f(support.halfSupport - ro[2]), forward[2]);
    return { oldReachable, supportActive: support.active, ro, rd: forward, oldPoint: samples[0].point,
        oldMask, oldDepth, near, far, drawRatio, outerRadiusPixels: drawRatio * height / 2,
        formerA, formerB, originalHit: samples[0].hit, hit: support.hit,
        supportEntry: support.entry, supportExit: support.exitHit, coverage: support.coverage };
}
const distant = distantRegression();
assert.ok(distant.oldReachable, 'distant Cygnus fixture passes annulus, radial mask, shadow, draw, near/far and final alpha gates');
assert.equal(distant.formerA, distant.formerB, 'negative fixture reproduces former absolute-endpoint float32 collapse');
assert.ok(distant.supportActive, 'normalized support retains the reachable distant sample');
assert.equal(distant.coverage, 1, 'reachable distant sample preserves full normalized coverage');
assert.equal(distant.hit, distant.originalHit, 'reachable distant sample preserves exact main float32 hit');
assert.ok(distant.outerRadiusPixels < 1, 'fixture concerns subpixel emission, not a resolved disk claim');

if (process.argv.includes('--verify-main-scope')) {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    const main = git('show', `${mainCommit}:src/holeOptics.js`);
    const reviewed = git('show', `${reviewedCommit}:src/holeOptics.js`);
    const halfSupportLine = text => text.match(/float halfSupport = [^;]+;/)?.[0];
    assert.equal(halfSupportLine(disk), halfSupportLine(diskBlock(reviewed)), 'raster footprint bounds match the previously reviewed blob');
    const shadingTail = text => text.slice(text.indexOf('                vec3 p = ro+hit*rd;'));
    assert.equal(shadingTail(disk).replace(' * coverage;', ';'), shadingTail(diskBlock(main)), 'disk shading after hit selection differs from exact main only by coverage');
    assert.equal(source.replace(disk, diskBlock(main)), main, 'all hole optics outside disk support are exact main');
    const baselineFiles = git('ls-tree', '-r', '--name-only', mainCommit, '--', 'src').trim().split('\n').filter(Boolean);
    for (const path of baselineFiles) {
        if (path === 'src/holeOptics.js') continue;
        assert.deepEqual(readFileSync(new URL(`../${path}`, import.meta.url)), execFileSync('git', ['show', `${mainCommit}:${path}`], { cwd: root }), `${path} is byte-identical to exact main`);
    }
    function walk(directory) {
        return readdirSync(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })
            .flatMap(entry => entry.isDirectory() ? walk(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
    }
    assert.deepEqual(walk('src').sort(), baselineFiles.sort(), 'no unrelated source files were added or removed');
    assert.ok(!existsSync(new URL('../src/render/ringSamplingDepth.js', import.meta.url)), 'ringSamplingDepth remains absent, as on main');
    console.log(`Disk-only source scope: normalized support/coverage only; ${baselineFiles.length - 1} unchanged source blobs and all other holeOptics content match ${mainCommit}`);
}

console.log(`Disk plane support: ${comparisons} float64/float32 oracle comparisons; ${reflected} reflection cases; ${unchanged} ordinary outside-support hits; ${partitions} clipped-integral partitions passed`);
console.log(`Distant float32 regression: retained reachable Cygnus sample (mask=${distant.oldMask}, outer radius=${distant.outerRadiusPixels.toFixed(6)}px at2160px height); former absolute endpoints collapse, normalized coverage=${distant.coverage}.`);
console.log('Limits: CPU scalar math only; no GPU derivatives, rendered pixels, shader compilation, performance, physical thickness, or ring/issue49 acceptance tested.');
