import assert from 'node:assert/strict';
import {gravityContext,GALAXY_INSPECT_ENTER_KM as enter,GALAXY_INSPECT_LEAVE_KM as leave,strongestContributions,sumAcceleration,accelerationLabel} from '../src/gravityInspectorMath.js';
assert.equal(gravityContext(enter*.99),'local');assert.equal(gravityContext(enter*1.01),'galaxy');
for(const d of [enter*.99,enter*1.01,enter*.99,enter*.95])assert.equal(gravityContext(d,'galaxy'),'galaxy');
assert.equal(gravityContext(leave*.99,'galaxy'),'local');
const rows=[{id:'a',label:'A',acceleration:[10,0,0]},{id:'b',label:'B',acceleration:[0,5,0]},{id:'c',label:'C',acceleration:[0,0,2]},{id:'d',label:'D',acceleration:[1.9,0,0]},{id:'frame',kind:'frame',label:'Frame',acceleration:[-11.9,-5,-2]}];
const saved=JSON.stringify(rows),r=strongestContributions(rows);assert.deepEqual(r.ids,['a','b','c']);
assert.deepEqual(sumAcceleration([...r.top,{acceleration:r.others}]),r.net);assert.deepEqual(r.net,[0,0,0]);assert.equal(JSON.stringify(rows),saved);
rows[3].acceleration=[2.1,0,0];assert.deepEqual(strongestContributions(rows,r.ids).ids,r.ids,'near tie holds row slot');
rows[3].acceleration=[3,0,0];assert(strongestContributions(rows,r.ids).ids.includes('d'),'materially stronger source replaces weakest');
const zero=strongestContributions([{id:'bad',acceleration:[NaN,0,0]},{id:'zero',acceleration:[0,0,0]}]);assert.equal(zero.top.length,0);assert.deepEqual(zero.net,[0,0,0]);
assert.equal(accelerationLabel(.001),'1.00 m/s²');assert.equal(accelerationLabel(Infinity),'Unavailable');
console.log('Gravity display: scale/rank hysteresis, frame separation, exact vector remainder and read-only behavior passed');

const {coarsenGalaxyWells}=await import('../src/flowScaleMath.js');
const wells=[{x:1,y:2,z:3,mass:3,core:0,label:'Catalog galaxies'},{x:2,y:2,z:3,mass:7,core:0,label:'Catalog galaxies'}];
const grouped=coarsenGalaxyWells(wells,100,{x:0,y:0,z:0});
assert.equal(grouped.length,1);assert.equal(grouped[0].mass,10);assert.equal(grouped[0].members,2);assert.equal(grouped[0].groupKey,'0,0,0');
console.log('Galaxy aggregates preserve mass, member counts and stable cell identity');
