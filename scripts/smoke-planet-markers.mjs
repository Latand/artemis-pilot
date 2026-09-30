import assert from 'node:assert/strict';
import { PLANET_MARKER_DIAMETER_PX, planetMarkerOpacity, planetMarkerScale } from '../src/planetMarker.js';
for (const depth of [10, 1e3, 1e5, 1e7]) for (const pxScale of [350, 700, 1400]) {
 assert.ok(Math.abs(planetMarkerScale(depth, pxScale) * pxScale / depth - PLANET_MARKER_DIAMETER_PX) < 1e-10);
}
assert.equal(planetMarkerOpacity(0), .95);
assert.equal(planetMarkerOpacity(5), 0);
assert.equal(planetMarkerOpacity(10), 0);
assert.equal(planetMarkerOpacity(0, 0), 0);
assert.ok(planetMarkerOpacity(2) > .89, 'mobile surface LOD must be covered');
let previous = .95;
for (let px = 0; px < 6; px += .001) {
 const opacity = planetMarkerOpacity(px);
 assert.ok(opacity <= previous && previous - opacity < .002, 'continuous monotonic handoff');
 previous = opacity;
}
assert.equal(planetMarkerScale(-10, 700), 0);
console.log('Planet markers: fixed CSS-pixel size, smooth LOD handoff, guide fade passed');
