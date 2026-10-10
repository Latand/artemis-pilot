import * as THREE from 'three';
import { scene,cam } from './scene.js';
import { G } from './state.js';
import { WARP,WARP_C } from './warpBubble.js';
import { WARP_WAVES, noteWarpTransition, pulseAge } from './warpWaveState.js';
import { K } from './constants.js';
import { eph } from './ephemeris.js';
let pool=null,buttons=[],replays=[],notes=[],lastUIKey=null;
export function initWarpWaves(){
 buttons=[...document.querySelectorAll('[data-wave-guide]')];replays=[...document.querySelectorAll('[data-wave-replay]')];notes=[...document.querySelectorAll('[data-wave-status]')];
 for(const b of buttons)b.addEventListener('click',()=>{WARP_WAVES.enabled=!WARP_WAVES.enabled;WARP_WAVES.replay=null;b.blur();sync();});
 for(const b of replays)b.addEventListener('click',()=>{
  const s=WARP_WAVES,e=s.events.at(-1);if(!e)return;
  s.enabled=true;s.replay={...e};s.replayAge=0;G.paused=true;G.focus='free';
  cam.tgt.set(e.x*K,e.z*K,-e.y*K);cam.dist=.65;cam.distTarget=null;
  b.blur();sync();
 });lastUIKey=null;sync();
}
function sync(){
 const s=WARP_WAVES,key=`${s.enabled}|${!!s.replay}|${!!s.events.length}`;
 if(key===lastUIKey)return;lastUIKey=key;
 for(const b of buttons){b.textContent=`Illustrative pulses · ${s.enabled?'ON':'OFF'}`;b.setAttribute('aria-pressed',String(s.enabled));}
 for(const b of replays)b.disabled=!s.events.length;
 for(const n of notes)n.textContent=s.replay?'REPLAY · world paused · wave time 0.0001×\nUse time controls to resume flight.':'Transition markers only · amplitude uncomputed\nFlat-background fronts at c; steady cruise emits none.';
}
function makePool(){
 const positions=[];
 for(let plane=0;plane<3;plane++)for(let i=0;i<96;i++)for(const k of [i,i+1]){
  const a=k/96*Math.PI*2,c=Math.cos(a),s=Math.sin(a);
  positions.push(...(plane===0?[c,s,0]:plane===1?[c,0,s]:[0,c,s]));
 }
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
 return Array.from({length:4},()=>{const mesh=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color:0xffca78,transparent:true,opacity:.5,depthWrite:false,toneMapped:false}));mesh.name='Illustrative transition pulse front';mesh.frustumCulled=false;mesh.visible=false;scene.add(mesh);return mesh;});
}
export function updateWarpWaves(dtReal){
 const s=WARP_WAVES;
 // Emission origins are world-coordinate events, never attached to the ship.
 noteWarpTransition(WARP.phase,WARP.speed,eph.earthX+G.x,eph.earthY+G.y,G.z,G.t);
 if(!G.paused)s.replay=null;
 if(!s.enabled){if(pool)for(const mesh of pool)mesh.visible=false;sync();return;}
 if(!pool)pool=makePool();
 if(s.replay)s.replayAge=Math.min(.0006,s.replayAge+Math.max(0,Math.min(.1,dtReal))*.0001);
 for(let i=0;i<4;i++){
  const e=s.replay?(i===0?s.replay:null):s.events[i],mesh=pool[i];
  const age=e?(s.replay?s.replayAge:pulseAge(e,G.t)):0;
  const r=WARP_C*age*K;
  mesh.visible=!!e&&r>1e-9&&Number.isFinite(r);
  if(!mesh.visible)continue;
  mesh.position.set(e.x*K,e.z*K,-e.y*K);mesh.scale.setScalar(r);
  mesh.material.opacity=s.replay ? .55 : .3;
 }
 sync();
}
