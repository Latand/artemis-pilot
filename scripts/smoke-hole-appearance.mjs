import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shadowAngularRadius, SHADOW_RS, MIN_HOLE_OBSERVER_RS, namedHoleAppearance } from '../src/render/holeAppearance.js';
assert(MIN_HOLE_OBSERVER_RS>1 && MIN_HOLE_OBSERVER_RS<1.1);
assert(Math.abs(shadowAngularRadius(1.5)-Math.PI/2)<1e-7);
assert(Math.abs(shadowAngularRadius(1e6)*1e6-SHADOW_RS)<2e-6);
let prev=Math.PI;
for(let d=1.0001;d<1e5;d*=1.017){let a=shadowAngularRadius(d);assert(Number.isFinite(a)&&a>0&&a<Math.PI);assert(a<=prev+1e-10);prev=a;}
assert(shadowAngularRadius(MIN_HOLE_OBSERVER_RS)>Math.PI/2);
for(const name of ['GAIA BH1','GAIA BH2','GAIA BH3']){const p=namedHoleAppearance({name});assert(!p.diskOn&&!p.jetOn&&p.gain===0);}
assert(namedHoleAppearance({name:'SGR A*'}).gain<namedHoleAppearance({name:'CYGNUS X-1'}).gain);
const shader=readFileSync(new URL('../src/holeOptics.js',import.meta.url),'utf8');
assert(!shader.includes('new THREE.CylinderGeometry'));assert(!shader.includes('new THREE.RingGeometry'));
assert(shader.includes('copy(eye).sub(center).divideScalar(o.rsUnits)'));
assert(shader.includes('gl_Position=vec4(position.xy,0.0,1.0)'));
assert(shader.includes('fwidth('));
assert(shader.includes('if (z < uNear || z > uFar) discard;')); 
console.log('Hole appearance: finite-distance shadow branches, continuous limit, named accretion profiles, normalized analytic geometry passed');
