// CPU numerical regressions for the bounded external-galaxy representation.
// Direct quadrature integrates the positive three-dimensional density, rather
// than duplicating the half-ray erf implementation. Browser capture tests must
// additionally exercise the production GLSL and its tier/composer integration.
import assert from 'node:assert/strict';
import {
    GALAXY_GAUSSIANS, GALAXY_SUPPORT, gaussianRayColumn, galaxyScreenBounds,
} from '../src/render/galaxyResolved.js';

const normalize = v => {
    const length = Math.hypot(...v);
    return v.map(x => x / length);
};
const faceProfile = (radius, scale = 1) => GALAXY_GAUSSIANS.reduce((sum, [sigma, weight]) =>
    sum + weight * Math.exp(-.5 * (radius / (sigma * scale)) ** 2), 0);
const near = (actual, expected, tolerance, label) => assert(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${label}: actual=${actual}, expected=${expected}, tolerance=${tolerance}`,
);

function quadratureColumn(origin, direction, q, scale) {
    // Each Gaussian is integrated independently at 1024 midpoints. Truncating
    // twelve widths from its line maximum discards <4e-33 of its full integral.
    // The integrand below is the original 3-D density evaluated along the ray.
    const metricDot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2]/(q*q);
    const directionMetric = metricDot(direction, direction);
    const maximum = -metricDot(origin, direction) / directionMetric;
    let result = 0;
    for (const [sigma, weight] of GALAXY_GAUSSIANS) {
        const width = sigma * scale / Math.sqrt(directionMetric);
        const lo = Math.max(0, maximum - 12 * width), hi = Math.max(0, maximum + 12 * width);
        if (hi <= lo) continue;
        const count = 1024, dt = (hi - lo) / count;
        let sum = 0;
        for (let i = 0; i < count; i++) {
            const t = lo + (i + .5) * dt;
            const p = origin.map((v, axis) => (v + t * direction[axis]) / (scale * sigma));
            sum += Math.exp(-.5 * (p[0]*p[0] + p[1]*p[1] + p[2]*p[2]/(q*q)));
        }
        result += weight * sum * dt / (Math.sqrt(2*Math.PI) * q * scale * sigma);
    }
    return result;
}

assert.equal(GALAXY_GAUSSIANS.length, 6, 'The near-volume cost remains six positive Gaussian terms');
assert(GALAXY_GAUSSIANS.every(([sigma, weight]) => sigma > 0 && weight > 0));
assert(GALAXY_SUPPORT >= 8, 'Bounds encompass the modeled close-view support');
const integratedFlux = GALAXY_GAUSSIANS.reduce((sum, [sigma, weight]) => sum + weight*sigma*sigma, 0);
near(integratedFlux, 1, 4e-5, 'Gaussian mixture preserves the exponential surface integral');
for (let i = 10; i <= 450; i++) {
    const radius = i / 100, expected = Math.exp(-radius);
    near(faceProfile(radius), expected, .013 * expected, `Exponential profile fit at radius ${radius}`);
}
near(faceProfile(0), 1, .027, 'Bounded core has less than 2.7% peak approximation error');

const cases = [
    { o: [0,0,-8], d: [0,0,1], q: 1, scale: 1 },
    { o: [1.7,0,-8], d: [0,0,1], q: .12, scale: 1 },
    { o: [0,-8,.09], d: [0,1,0], q: .12, scale: 1 },
    { o: [0,0,0], d: [0,0,1], q: .025, scale: .1 },
    { o: [0,0,0], d: [1,0,0], q: .025, scale: .1 },
    { o: [.3,-.5,.08], d: [1,.2,-.3], q: .08, scale: .7 },
    { o: [1.2,-2.3,.8], d: [.2,1,-.2], q: .65, scale: .12 },
    { o: [0,0,1], d: [0,0,1], q: .12, scale: 1 },
    { o: [9,3,-1], d: [-1,-.2,.03], q: .2, scale: 2 },
    { o: [-2,1,.03], d: [-1,.2,0], q: .03, scale: .8 },
];
let worstQuadratureRelative = 0;
for (const [index, c] of cases.entries()) {
    const d = normalize(c.d), actual = gaussianRayColumn(c.o, d, c.q, c.scale);
    const reference = quadratureColumn(c.o, d, c.q, c.scale);
    near(actual, reference, 2e-5 * Math.max(reference, 1e-3), `Independent density quadrature case ${index}`);
    assert(actual >= 0, `Half-ray column is nonnegative in case ${index}`);
    worstQuadratureRelative = Math.max(worstQuadratureRelative, Math.abs(actual-reference)/Math.max(reference,1e-3));
}

// An observer at the centre sees one half of every symmetric Gaussian in
// either direction, even in the thinnest permitted disk. There is no r=0 or
// ray/plane-angle singularity.
for (const q of [.025,.12,.65,1]) for (const scale of [.1,.7,1,3]) {
    near(gaussianRayColumn([0,0,0],[0,0,1],q,scale), .5*faceProfile(0), 1e-12, 'Central polar half column');
    near(gaussianRayColumn([0,0,0],[1,0,0],q,scale), .5*faceProfile(0)/q, 1e-12, 'Central equatorial half column');
}
for (const q of [.025,.12,.65,1]) for (const radius of [0,.03,.4,2,4.5]) {
    const o = [radius,0,.17], d = [0,0,1];
    const whole = gaussianRayColumn(o,d,q) + gaussianRayColumn(o,[0,0,-1],q);
    near(whole,faceProfile(radius),1e-12,'Opposite half-rays recover the projected surface profile');
    near(gaussianRayColumn([radius,0,-1e8],d,q),faceProfile(radius),1e-12,'Far-observer cross product remains stable');
}
// Simultaneously rescaling an object and observer preserves surface brightness.
for (const c of cases) {
    const d = normalize(c.d), expected = gaussianRayColumn(c.o,d,c.q,c.scale);
    for (const factor of [.01,100]) near(
        gaussianRayColumn(c.o.map(v => v*factor),d,c.q,c.scale*factor),expected,
        2e-12*Math.max(expected,1),'Scale-invariant radiance',
    );
}

// Numerically projected sphere samples are an independent containment oracle
// for the conservative screen rectangle, including lens offsets and a support
// crossing the observer's eye plane. Only visible sample points must fit.
let containedSamples = 0;
const spheres = [
    [[0,0,-10],1], [[2,-1,-5],1.3], [[6,0,-5],1.5], [[-6,3,-8],2],
    [[0,0,-1.001],1], [[2,0,-.99],1], [[0,0,0],1], [[0,0,.3],1],
    [[3,-4,2],1], [[40,0,-10],1], [[0,0,-100],1e-4],
];
const projections = [[1,1,0,0],[1.5,2.4,.21,-.17],[.7,1.1,-.35,.3]];
for (const [center,radius] of spheres) for (const projection of projections) {
    const bounds = galaxyScreenBounds(center,radius,projection);
    if (bounds) assert(bounds.every(Number.isFinite) && bounds.every(v=>v>=-1&&v<=1)
        && bounds[0]<bounds[2] && bounds[1]<bounds[3], 'Screen bounds are finite and viewport-bounded');
    for (let i=0;i<=72;i++) for (let j=0;j<144;j++) {
        const theta=i*Math.PI/72,phi=j*2*Math.PI/144;
        const p=[center[0]+radius*Math.sin(theta)*Math.cos(phi),
            center[1]+radius*Math.sin(theta)*Math.sin(phi),center[2]+radius*Math.cos(theta)];
        if (p[2]>=0) continue;
        const x=projection[0]*p[0]/(-p[2])-projection[2], y=projection[1]*p[1]/(-p[2])-projection[3];
        if (x < -1 || x > 1 || y < -1 || y > 1) continue;
        assert(bounds,'Visible support must not be rejected because its centre is offscreen');
        assert(x>=bounds[0]-1e-12&&x<=bounds[2]+1e-12&&y>=bounds[1]-1e-12&&y<=bounds[3]+1e-12,
            `Projected support escaped bounds: ${JSON.stringify({center,radius,projection,bounds,x,y})}`);
        containedSamples++;
    }
}
assert.deepEqual(galaxyScreenBounds([0,0,0],1),[-1,-1,1,1],'Inside support uses finite fullscreen coverage');
assert.deepEqual(galaxyScreenBounds([0,0,.2],1),[-1,-1,1,1],'A behind-eye centre retains its visible support');
assert.equal(galaxyScreenBounds([0,0,2],1),null,'Fully behind-eye support is culled');
assert.equal(galaxyScreenBounds([30,0,-10],1),null,'Fully offscreen support is culled');
assert(containedSamples>10000);
console.log(`PASS external galaxy Gaussian flux/profile, independent ray quadrature (max relative ${worstQuadratureRelative.toExponential(2)}), inside/edge-on/far/scale invariance, and ${containedSamples} conservative projected sphere samples`);

// The shared deterministic noise is bounded to one small texture, not one
// image per galaxy or per zoom level.
const { galaxyNoisePixels } = await import('../src/render/galaxyMorphology.js');
const noise=galaxyNoisePixels();
assert.equal(noise.byteLength,65536);assert.deepEqual(noise,galaxyNoisePixels());
const mean=noise.reduce((a,b)=>a+b,0)/noise.length;assert(mean>126&&mean<129);
console.log('PASS shared deterministic 64 KiB morphology noise budget');

const { needsGalaxyQuads } = await import('../src/render/galaxyMorphology.js');
assert(needsGalaxyQuads(1,0,24,200,256),'Volume handoff must already use quads before .025 rad');
assert(needsGalaxyQuads(1,0,20,200,256,true),'Angular LOD hysteresis retains close quads');
console.log('PASS quad promotion precedes all near-volume blends');

// Eye-plane-crossing is common for distant galaxies at 90 degrees from the
// camera, but almost all such tiny supports miss the viewport completely.
for(const z of [-.002,0,.002]) for(const axis of [0,1]) for(const sign of [-1,1]){
 const c=[0,0,z];c[axis]=sign;assert.equal(galaxyScreenBounds(c,.006,[1.4,2.2,.12,.03]),null);
}
assert.deepEqual(galaxyScreenBounds([0,0,0],1,[1.4,2.2,.12,.03]),[-1,-1,1,1]);
console.log('PASS horizon sources are culled before fullscreen fallback; inside sources remain covered');
