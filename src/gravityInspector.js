import * as THREE from 'three';
import { G } from './state.js';
import { K } from './constants.js';
import { cam, camera } from './scene.js';
import { getLocalGravityInspection } from './gravityInspection.js';
import { getGalaxyGravityInspection } from './gravityGalaxyInspection.js';
import { gravityContext, strongestContributions, accelerationLabel } from './gravityInspectorMath.js';
import './gravityInspector.css';

let panel,summary,scope,leading,title,rows,net,note,modelDetail,pathButton,pathNote,hooks;
let context='local',previous=[],identity='',lastRead=-Infinity,snapshot=null;
let vectorSvg,vectorPath,vectorText;
const origin=new THREE.Vector3(),end=new THREE.Vector3();
const setText=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
function element(tag,cls,text=''){const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;}
export function initGravityInspector(options={}) {
    if(panel)return;
    hooks=options;
    panel=element('details','gravityInspector');panel.id='gravityInspector';
    summary=element('summary','gravitySummary');summary.append(element('span','gravityHeading','Gravity'));
    scope=element('span','gravityScope','Local');leading=element('span','gravityLeading','Inspect attraction');summary.append(scope,leading);
    title=element('p','gravityTarget');rows=element('ol','gravityContributors');
    net=element('p','gravityNet');note=element('p','gravityModel');
    modelDetail=element('details','gravityModelDetail');modelDetail.append(element('summary','','Model limits'),element('p','gravityModel'));
    pathButton=element('button','gravityPrediction','Show short coast path');pathButton.type='button';pathButton.setAttribute('aria-pressed','false');
    pathNote=element('p','gravityPathNote');
    panel.append(summary,title,rows,net,note,pathButton,pathNote,modelDetail);
    const host=document.getElementById('explorePanel');
    (host.querySelector('.compactObjectHeader')||host.firstElementChild).after(panel);
    panel.addEventListener('toggle',()=>{
        if(panel.open){
            for(const id of ['exploreInfo','exploreDestinations']){const d=document.getElementById(id);if(d)d.open=false;}
            document.dispatchEvent(new CustomEvent('gravity-inspector-toggle',{detail:{open:true}}));
        }
        updateGravityInspector(true);
    });
    pathButton.addEventListener('click',()=>{hooks.togglePrediction?.();updateGravityInspector(true);});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&panel.open&&panel.contains(document.activeElement)){panel.open=false;summary.focus();}});
    const ns='http://www.w3.org/2000/svg';
    vectorSvg=document.createElementNS(ns,'svg');vectorSvg.id='gravityNetVector';vectorSvg.setAttribute('aria-hidden','true');
    vectorPath=document.createElementNS(ns,'path');vectorText=document.createElementNS(ns,'text');vectorSvg.append(vectorPath,vectorText);document.body.append(vectorSvg);
    updateGravityInspector(true);
}
function updateRows(result) {
    const weight=snapshot.contributions.reduce((n,r)=>n+Math.hypot(...r.acceleration),0);
    const share=m=>Math.max(0,100*m/Math.max(weight,1e-100)).toFixed(1)+'% estimate';
    const list=[...result.top.map(row=>({label:row.label,value:snapshot.estimated?share(row.magnitude):accelerationLabel(row.magnitude)}))];
    if(result.othersCount)list.push({label:`Others${snapshot.contributions.some(r=>r.kind==='frame'||r.kind==='correction')?' + corrections':''} (${result.othersCount})`,value:snapshot.estimated?share(weight-result.top.reduce((n,r)=>n+r.magnitude,0)):accelerationLabel(Math.hypot(...result.others))});
    while(rows.children.length>list.length)rows.lastChild.remove();
    while(rows.children.length<list.length){const li=element('li','');li.append(element('span',''),element('span','gravityValue'));rows.append(li);}
    list.forEach((row,i)=>{setText(rows.children[i].children[0],row.label);setText(rows.children[i].children[1],row.value);});
}
function drawVector() {
    vectorSvg.style.display='none';
    if(!panel.open||!snapshot?.supported||!snapshot.position||!snapshot.net||G.uiMode!=='observe'||G.cabin)return;
    const a=snapshot.net,m=Math.hypot(...a);if(!(m>0))return;
    const p=snapshot.position;
    origin.set(p[0]*K,p[2]*K,-p[1]*K);
    // The arrow encodes direction only. It is never a travelled distance or
    // a force-scaled length, and it is never reversed with the time control.
    end.copy(origin).addScaledVector(new THREE.Vector3(a[0],a[2],-a[1]),Math.max(.001,cam.dist)*.14/m);
    origin.project(camera);end.project(camera);
    if(origin.z<-1||origin.z>1||end.z<-1||end.z>1||Math.abs(origin.x)>1||Math.abs(origin.y)>1)return;
    const w=innerWidth,h=innerHeight,x=(origin.x+1)*w/2,y=(1-origin.y)*h/2,ex=(end.x+1)*w/2,ey=(1-end.y)*h/2;
    const dx=ex-x,dy=ey-y,len=Math.hypot(dx,dy);
    vectorSvg.setAttribute('viewBox',`0 0 ${w} ${h}`);vectorSvg.style.display='block';
    vectorText.setAttribute('x',String(x+12));vectorText.setAttribute('y',String(y-12));
    vectorText.textContent=len<8?'Net along sightline':snapshot.estimated?'Estimated net direction':'Net direction';
    if(len<8){vectorPath.setAttribute('d',`M ${x-4} ${y} L ${x+4} ${y} M ${x} ${y-4} L ${x} ${y+4}`);return;}
    const ux=dx/len,uy=dy/len,bx=ex-ux*10,by=ey-uy*10;
    vectorPath.setAttribute('d',`M ${x} ${y} L ${ex} ${ey} M ${bx-uy*5} ${by+ux*5} L ${ex} ${ey} L ${bx+uy*5} ${by-ux*5}`);
}
export function updateGravityInspector(force=false) {
    if(!panel)return;
    if(G.uiMode!=='observe'||G.cabin){vectorSvg.style.display='none';return;}
    const nextContext=gravityContext(cam.dist/K,context);
    const key=String(G.focus)+':'+nextContext;
    const now=performance.now();
    if(force||panel.open||key!==identity||now-lastRead>250){
        if(key!==identity){previous=[];identity=key;context=nextContext;panel.dataset.context=context;}
        snapshot=context==='galaxy'?getGalaxyGravityInspection():getLocalGravityInspection(G.focus);
        lastRead=now;
        setText(scope,snapshot.estimated?'Estimated':'Local');
        setText(title,`${snapshot.name||'Select an object'} · ${snapshot.frame||'Model scope'}`);
        setText(modelDetail.lastElementChild,snapshot.note||'No further model information.');
        setText(note,!snapshot.supported?snapshot.note:snapshot.estimated?'Estimated shares of source magnitudes; their directions can cancel. This field is not applied to the simulation. Arrow length is normalized.':snapshot.frame==='Local perturbation only'?'Local kicks only; prescribed Galactic motion is excluded. No coupled forecast.':'Current bounded solver. Others includes frame/relativity terms; the net is their vector sum. Arrow length is normalized.');
        if(snapshot.supported){
            const result=strongestContributions(snapshot.contributions,previous);previous=result.ids;
            // The displayed net is exactly the sum of these same contributions,
            // including the vector remainder and coordinate corrections.
            snapshot={...snapshot,net:result.net};updateRows(result);
            setText(leading,result.top[0]?`${result.top[0].label} leads`:'Balanced field');
            setText(net,snapshot.estimated?'Net: estimated direction only':`${snapshot.frame==='Local perturbation only'?'Net local':'Net'}: ${accelerationLabel(Math.hypot(...result.net))}`);
        }else{rows.textContent='';setText(leading,'View model scope');setText(net,'No complete applied-force vector available');}
        pathButton.hidden=!snapshot.predictionSupported||context==='galaxy';
        const predicting=hooks.predictionActive?.()||false;pathButton.setAttribute('aria-pressed',String(predicting));setText(pathButton,predicting?'Hide short coast path':'Show short coast path');
        setText(pathNote,pathButton.hidden?'':hooks.predictionNote?.()||'Short bounded coast estimate; no thrust. Source motion is extrapolated.');
    }
    drawVector();
}
export function closeGravityInspector(){if(panel)panel.open=false;}
