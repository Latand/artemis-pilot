import * as THREE from 'three';
import { K, PL, R_EARTH, R_MOON, SUN_RADIUS } from '../constants.js';
import { G, WORLD, BH, GS } from '../state.js';
import { eph, liveBodyMu, liveEarthMu, IDX_SUN, IDX_MOON, IDX_PLANETS } from '../ephemeris.js';
import { MOONS, moonOffset } from '../moons.js';
import { earthG, moon, plGroups, moonGroups, sunPos, sunCore } from '../bodies.js';
import { scene, viewportSize, registerNearTierOnly } from '../scene.js';
import { shipG, dot } from '../ship.js';
import { osculatingOrbit, sampleOrbit } from './orbitalExposureMath.js';
import { selectVisibleTrajectories, trajectoryHorizon, playbackDirection, projectedVelocity, fullyOcculted, VISIBLE_TRAJECTORY_LIMIT, VISIBLE_TRAJECTORY_SEGMENTS } from './visibleTrajectoryMath.js';

const N = VISIBLE_TRAJECTORY_SEGMENTS;
const candidates = [], layers = [], projection = new THREE.Vector3(), next = new THREE.Vector3();
const worldVelocity = new THREE.Vector3(), cameraRight = new THREE.Vector3(), cameraUp = new THREE.Vector3(), cameraForward = new THREE.Vector3();
const point = {}, offset = {}, screenMotion = {}, tangent = new THREE.Vector3(), normal = new THREE.Vector3();
let initialized = false, toggle, note;
export const visibleTrajectories = { enabled: true, ids: [], active: 0, linear: 0, samples: 0, layers, candidates };
function makeCandidate(id, focus, radius, color) {
    const c = { id, focus, radius, color, position: new THREE.Vector3(), host: new THREE.Vector3(), orbit: {}, visible: false, model: 'two-body', x:0,y:0,z:0,vx:0,vy:0,vz:0,mu:0 };
    candidates.push(c); return c;
}
function init() {
    if (initialized) return;
    initialized = true;
    makeCandidate('earth', 'earth', R_EARTH, 0x69afff);
    makeCandidate('moon', 'moon', R_MOON, 0xc8ccdd);
    PL.forEach((p,i)=>makeCandidate(`planet:${i}`, i, p.R, p.color));
    MOONS.forEach((m,i)=>makeCandidate(`moon:${i}`, `moon:${i}`, m.R, m.color));
    makeCandidate('ship', 'ship', 0, 0x84e4f4);
    for(let i=0;i<BH.x.length;i++)makeCandidate(`bh:${i}`, `bh:${i}`, 0, 0xe5b488);
    for(let i=0;i<VISIBLE_TRAJECTORY_LIMIT;i++) {
        const geometry=new THREE.BufferGeometry(), positions=new Float32Array((N+1)*3), distances=new Float32Array(N+1);
        geometry.setAttribute('position',new THREE.BufferAttribute(positions,3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('lineDistance',new THREE.BufferAttribute(distances,1).setUsage(THREE.DynamicDrawUsage));
        const material=new THREE.LineDashedMaterial({color:0x8ed9dd,transparent:true,opacity:.72,dashSize:1,gapSize:1,depthWrite:false});
        const path=new THREE.Line(geometry,material);path.frustumCulled=false;path.visible=false;path.name=`Visible future path ${i}`;scene.add(path);
        const arrowPositions=new Float32Array(18), arrowGeometry=new THREE.BufferGeometry();
        arrowGeometry.setAttribute('position',new THREE.BufferAttribute(arrowPositions,3).setUsage(THREE.DynamicDrawUsage));
        const arrow=new THREE.LineSegments(arrowGeometry,new THREE.LineBasicMaterial({color:0xb6e1df,transparent:true,opacity:.85,depthWrite:false,depthTest:false}));
        arrow.frustumCulled=false;arrow.visible=false;arrow.renderOrder=6;arrow.name=`Current playback velocity ${i}`;scene.add(arrow);registerNearTierOnly(arrow);
        layers.push({path,positions,distances,arrow,arrowPositions,id:null,horizon:0,model:null});
    }
    toggle=document.createElement('button');toggle.id='motionPathsToggle';toggle.type='button';
    toggle.setAttribute('aria-pressed','true');
    toggle.title='Dashed: short parent-relative two-body preview. Solid arrow: current velocity in playback direction. Ship, placed holes, and perturbed paths use a linear estimate of at most 60 seconds. Does not change the ship prediction control.';
    toggle.addEventListener('click',()=>{visibleTrajectories.enabled=!visibleTrajectories.enabled;toggle.setAttribute('aria-pressed',String(visibleTrajectories.enabled));if(!visibleTrajectories.enabled)hideVisibleTrajectories();});
    document.querySelector('#timeDock .tdHeading')?.append(toggle);
    note=document.createElement('div');note.id='motionPathsNote';note.hidden=true;
    Object.assign(note.style,{fontSize:'10px',color:'#a5c4cc',paddingTop:'3px'});
    document.getElementById('timeDock')?.append(note);
}
function state(c,object,host,x,y,z,vx,vy,vz,mu,alive=true,model='two-body') {
    c.position.copy(object);c.host.copy(host);
    Object.assign(c,{x,y,z,vx,vy,vz,mu,alive,model});
}
function refreshStates(oi) {
    let i=0;
    state(candidates[i++],earthG.position,sunPos,-eph.sunX,-eph.sunY,-eph.sunZ,-eph.sunVx,-eph.sunVy,-eph.sunVz,liveBodyMu(IDX_SUN)+liveEarthMu(),!WORLD.earthDestroyed&&!WORLD.sunDestroyed);
    state(candidates[i++],moon.position,earthG.position,eph.moonX,eph.moonY,eph.moonZ,eph.moonVx,eph.moonVy,eph.moonVz,liveEarthMu()+liveBodyMu(IDX_MOON),!WORLD.moonDestroyed&&!WORLD.earthDestroyed);
    for(let p=0;p<PL.length;p++)state(candidates[i++],plGroups[p].position,sunPos,eph.plX[p]-eph.sunX,eph.plY[p]-eph.sunY,eph.plZ[p]-eph.sunZ,eph.plVx[p]-eph.sunVx,eph.plVy[p]-eph.sunVy,eph.plVz[p]-eph.sunVz,liveBodyMu(IDX_SUN)+liveBodyMu(IDX_PLANETS+p),!WORLD.plDestroyed[p]&&!WORLD.sunDestroyed);
    for(let m=0;m<MOONS.length;m++) {
        const data=MOONS[m];moonOffset(data,G.t,offset);
        const b=data.a*Math.sqrt(1-data.e*data.e), cosE=offset.x/data.a+data.e,sinE=offset.y/b;
        const dE=data.n/(1-data.e*cosE);
        state(candidates[i++],moonGroups[m].position,plGroups[data.p].position,offset.x,offset.y,0,-data.a*sinE*dE,b*cosE*dE,0,data.mu,!WORLD.plDestroyed[data.p]&&moonGroups[m].visible,'analytic-moon');
    }
    const ship=candidates[i++];
    ship.position.set((eph.earthX+G.x)*K,G.z*K,-(eph.earthY+G.y)*K);
    // The existing ship inspector already supplies a parent-relative state.
    // This overview never claims to integrate thrust or a close encounter.
    ship.host.copy(ship.position).sub(next.set(oi.rx*K,oi.rz*K,-oi.ry*K));
    Object.assign(ship,{x:oi.rx,y:oi.ry,z:oi.rz,vx:oi.rvx,vy:oi.rvy,vz:oi.rvz,mu:oi.mu,alive:!G.dead&&!G.landed&&(shipG.visible||(dot.visible&&dot.material.opacity>.05)),model:'linear'});
    for(let h=0;h<BH.x.length;h++) {
        const c=candidates[i++];c.position.set((eph.earthX+BH.x[h])*K,BH.z[h]*K,-(eph.earthY+BH.y[h])*K);
        state(c,c.position,sunPos,BH.x[h]-eph.sunX,BH.y[h]-eph.sunY,BH.z[h]-eph.sunZ,BH.vx[h]-eph.sunVx,BH.vy[h]-eph.sunVy,BH.vz[h]-eph.sunVz,0,h<BH.n,'linear');
    }
}
export function hideVisibleTrajectories(hideNote = true) {
    visibleTrajectories.active=visibleTrajectories.linear=visibleTrajectories.samples=0;
    for(const layer of layers){layer.path.visible=layer.arrow.visible=false;}
    if(hideNote&&note&&!note.hidden)note.hidden=true;
}
export function updateVisibleTrajectories(camera,oi,disabled=false) {
    init();hideVisibleTrajectories(false);
    const explore=G.uiMode==='observe';if(toggle.hidden===explore)toggle.hidden=!explore;
    if(disabled||!explore||!visibleTrajectories.enabled){
        const text=visibleTrajectories.enabled?'Motion paths · On':'Motion paths · Off';
        if(toggle.textContent!==text)toggle.textContent=text;
        if(!note.hidden)note.hidden=true;
        return;
    }
    camera.updateMatrixWorld();
    refreshStates(oi);
    for(const c of candidates) {
        projection.copy(c.position).project(camera);
        const distance=Math.max(1e-9,camera.position.distanceTo(c.position));
        c.kmPerPixel=distance/K/viewportSize.pxScale;
        c.radiusPx=c.radius/c.kmPerPixel;
        c.nx=projection.x;c.ny=projection.y;
        c.sx=(projection.x*.5+.5)*viewportSize.w;c.sy=(-projection.y*.5+.5)*viewportSize.h;
        c.selected=G.focus===c.focus;
        c.visible=c.alive&&projection.z>-1&&projection.z<1&&Math.abs(projection.x)<.96&&Math.abs(projection.y)<.94&&Math.hypot(c.vx,c.vy,c.vz)>1e-8;
    }
    for (const c of candidates) {
        if (!c.visible) continue;
        if ((!WORLD.sunDestroyed && fullyOcculted(camera.position,c.position,c.radius*K,sunPos,SUN_RADIUS*sunCore.scale.x)) ||
            candidates.some(other=>other!==c&&other.alive&&other.radius>0&&fullyOcculted(camera.position,c.position,c.radius*K,other.position,other.radius*K))) c.visible=false;
    }
    const selected=selectVisibleTrajectories(candidates,visibleTrajectories.ids);
    visibleTrajectories.ids=selected.map(c=>c.id);
    const direction=playbackDirection(G.warp);
    cameraRight.setFromMatrixColumn(camera.matrixWorld,0);cameraUp.setFromMatrixColumn(camera.matrixWorld,1);cameraForward.setFromMatrixColumn(camera.matrixWorld,2).negate();
    const tanHalfFov = Math.tan(camera.fov * Math.PI / 360);
    const perturbed=BH.n>0||GS.length>0||WORLD.tdeInProgress;
    for(let index=0;index<selected.length;index++) {
        const c=selected[index],layer=layers[index];
        const conic=c.model==='linear'||(perturbed&&c.model!=='analytic-moon')?null:osculatingOrbit(c.x,c.y,c.z,c.vx,c.vy,c.vz,c.mu,c.orbit);
        const speed=Math.hypot(c.vx,c.vy,c.vz),linear=!conic;
        const horizon=trajectoryHorizon({speed,kmPerPixel:c.kmPerPixel,period:conic?.period,linear});
        layer.id=c.id;layer.horizon=horizon;layer.model=linear?'linear':'two-body';
        layer.path.position.copy(c.position);layer.arrow.position.copy(c.position);
        layer.path.material.color.setHex(c.color);layer.arrow.material.color.setHex(c.color);
        const unit=c.kmPerPixel*K;
        layer.path.material.dashSize=4*unit;layer.path.material.gapSize=3*unit;
        let total=0,px=0,py=0,pz=0;
        for(let j=0;j<=N;j++) {
            const dt=direction*horizon*j/N;
            if(conic)sampleOrbit(conic,dt,point);
            else {point.x=c.x+c.vx*dt;point.y=c.y+c.vy*dt;point.z=c.z+c.vz*dt;}
            const x=(point.x-c.x)*K,y=(point.z-c.z)*K,z=-(point.y-c.y)*K;
            layer.positions[j*3]=x;layer.positions[j*3+1]=y;layer.positions[j*3+2]=z;
            if(j)total+=Math.hypot(x-px,y-py,z-pz);
            layer.distances[j]=total;px=x;py=y;pz=z;
        }
        layer.path.geometry.attributes.position.needsUpdate=true;layer.path.geometry.attributes.lineDistance.needsUpdate=true;
        layer.path.visible=total/unit>2;
        // Project the instantaneous tangent, independently of the curved path
        // endpoint. Orthographic screen offsets keep the arrow a small guide.
        worldVelocity.set(c.vx,c.vz,-c.vy).multiplyScalar(direction);
        projectedVelocity(worldVelocity.dot(cameraRight),worldVelocity.dot(cameraUp),worldVelocity.dot(cameraForward),c.nx*tanHalfFov*camera.aspect,c.ny*tanHalfFov,screenMotion);
        const tx=screenMotion.x,ty=screenMotion.y,tlen=Math.hypot(tx,ty);
        if(tlen>speed*1e-5) {
            tangent.copy(cameraRight).multiplyScalar(tx/tlen).addScaledVector(cameraUp,ty/tlen);
            normal.copy(cameraRight).multiplyScalar(-ty/tlen).addScaledVector(cameraUp,tx/tlen);
            const start=Math.min(42,Math.max(6,c.radiusPx+4))*unit,end=start+18*unit;
            for(let j=0;j<6;j++) {
                const along=j===0?start:j===1||j===2||j===4?end:end-5*unit;
                const across=j===3?3*unit:j===5?-3*unit:0;
                const k=j*3;layer.arrowPositions[k]=tangent.x*along+normal.x*across;layer.arrowPositions[k+1]=tangent.y*along+normal.y*across;layer.arrowPositions[k+2]=tangent.z*along+normal.z*across;
            }
            layer.arrow.geometry.attributes.position.needsUpdate=true;layer.arrow.visible=true;
        }
        visibleTrajectories.active++;visibleTrajectories.samples+=N+1;if(linear)visibleTrajectories.linear++;
    }
    const toggleText=`Motion paths · ${visibleTrajectories.active}`;
    if(toggle.textContent!==toggleText)toggle.textContent=toggleText;
    if(note.hidden!==!visibleTrajectories.active)note.hidden=!visibleTrajectories.active;
    const noteText=`Parent-frame previews · ${direction<0?'reverse':'forward'} arrows${visibleTrajectories.linear?' · linear ≤60 s included':''}`;
    if(note.textContent!==noteText)note.textContent=noteText;
}
