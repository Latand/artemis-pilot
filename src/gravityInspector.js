import { G } from './state.js';
import { K } from './constants.js';
import { cam, camera } from './scene.js';
import { getLocalGravityInspection } from './gravityInspection.js';
import { getGalaxyGravityInspection } from './gravityGalaxyInspection.js';
import { gravityContext, strongestContributions, accelerationLabel, isPlacedHoleFocus, holeContributionVectors } from './gravityInspectorMath.js';
import {projectGravityVector, screenAccelerationDirection} from './gravityVectorProjection.js';
import './gravityInspector.css';

let panel,summary,scope,leading,title,rows,net,note,modelDetail,pathButton,pathNote,hooks;
let context='local',previous=[],identity='',lastRead=-Infinity,snapshot=null;
let vectorSvg,vectorPath,vectorText,netDirection,contributorLayer,vectorSummary;
const summaryCues=[];
const contributorGlyphs=[];
const setText=(node,value)=>{if(node.textContent!==value)node.textContent=value;};
function element(tag,cls,text=''){const n=document.createElement(tag);n.className=cls;n.textContent=text;return n;}
export function initGravityInspector(options={}) {
    if(panel)return;
    hooks=options;
    panel=element('details','gravityInspector');panel.id='gravityInspector';
    summary=element('summary','gravitySummary');summary.append(element('span','gravityHeading','Gravity'));
    scope=element('span','gravityScope','Local');leading=element('span','gravityLeading','Inspect attraction');summary.append(scope,leading);
    vectorSummary=element('span','gravityVectorSummary');vectorSummary.hidden=true;summary.append(vectorSummary);
    title=element('p','gravityTarget');rows=element('ol','gravityContributors');
    net=element('p','gravityNet');note=element('p','gravityModel');
    netDirection=element('span','gravityDirection','↑');netDirection.setAttribute('role','img');netDirection.hidden=true;
    const netRow=element('div','gravityNetRow');netRow.append(net,netDirection);
    modelDetail=element('details','gravityModelDetail');modelDetail.append(element('summary','','Model limits'),element('p','gravityModel'));
    pathButton=element('button','gravityPrediction','Show short coast path');pathButton.type='button';pathButton.setAttribute('aria-pressed','false');
    pathNote=element('p','gravityPathNote');
    panel.append(summary,title,rows,netRow,note,pathButton,pathNote,modelDetail);
    const host=document.getElementById('explorePanel');
    (host.querySelector('.compactObjectHeader')||host.firstElementChild).after(panel);
    panel.addEventListener('toggle',()=>{
        if(panel.open){
            document.getElementById('explorePanel').scrollTop=0;panel.scrollTop=0;
            for(const id of ['exploreInfo','exploreDestinations']){const d=document.getElementById(id);if(d)d.open=false;}
            document.dispatchEvent(new CustomEvent('gravity-inspector-toggle',{detail:{open:true}}));
        }
        updateGravityInspector(true);
    });
    pathButton.addEventListener('click',()=>{hooks.togglePrediction?.();updateGravityInspector(true);});
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&panel.open&&panel.contains(document.activeElement)){panel.open=false;summary.focus();}});
    const ns='http://www.w3.org/2000/svg';
    vectorSvg=document.createElementNS(ns,'svg');vectorSvg.id='gravityNetVector';vectorSvg.setAttribute('aria-hidden','true');
    contributorLayer=document.createElementNS(ns,'g');contributorLayer.id='gravityContributionVectors';
    vectorPath=document.createElementNS(ns,'path');vectorPath.dataset.sourceId='net';vectorText=document.createElementNS(ns,'text');vectorSvg.append(contributorLayer,vectorPath,vectorText);(document.getElementById('root')||document.body).append(vectorSvg);
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
// Direction-only arrows share the exact live acceleration ledger. The ambient
// river remains a complete qualitative field, including the selected mass.
function selectedHoleExplanation() { return isPlacedHoleFocus(G.focus)&&G.gr; }
function projectVector(a,fraction) {
    return projectGravityVector(snapshot.position,a,camera,cam.dist,fraction,innerWidth,innerHeight);
}
function updateDirectionSummary(vectors) {
    vectorSummary.hidden=!isPlacedHoleFocus(G.focus);
    if(vectorSummary.hidden)return;
    const cues=[...vectors.map(row=>({id:row.id,name:row.label.replace('Black hole ','BH '),label:row.label,a:row.acceleration})),
        {id:'net',name:'Net',label:'Net acceleration in the Earth frame',a:snapshot.net}];
    while(summaryCues.length<cues.length){
        const group=element('span','gravityForceCue'),name=element('span',''),arrow=element('span','gravityMiniDirection');
        group.append(name,arrow);vectorSummary.append(group);summaryCues.push({group,name,arrow});
    }
    summaryCues.forEach((cue,i)=>{
        cue.group.hidden=i>=cues.length;if(cue.group.hidden)return;
        const value=cues[i],d=screenAccelerationDirection(value.a,camera);
        cue.group.dataset.sourceId=value.id;setText(cue.name,value.name);setText(cue.arrow,d.symbol);
        cue.arrow.style.transform=`rotate(${d.rotation}deg)`;
        cue.group.title=`${value.label}: ${accelerationLabel(Math.hypot(...value.a))}. ${d.label}. Direction only.`;
        cue.group.setAttribute('aria-label',cue.group.title);
    });
}
function drawVector() {
    vectorSvg.style.display='none';vectorSummary.hidden=true;netDirection.hidden=true;vectorPath.style.display='none';vectorText.textContent='';
    for(const glyph of contributorGlyphs)glyph.group.style.display='none';
    if((!panel.open&&!selectedHoleExplanation())||!snapshot?.supported||!snapshot.position||!snapshot.net||G.uiMode!=='observe'||G.cabin)return;
    vectorSvg.setAttribute('viewBox',`0 0 ${innerWidth} ${innerHeight}`);
    const vectors=holeContributionVectors(snapshot,G.focus);
    updateDirectionSummary(vectors);
    const labelY=[];
    vectors.forEach((row,i)=>{
        if(!contributorGlyphs[i]){
            const ns='http://www.w3.org/2000/svg',group=document.createElementNS(ns,'g'),path=document.createElementNS(ns,'path'),text=document.createElementNS(ns,'text');
            group.classList.add('gravityContribution');group.append(path,text);contributorLayer.append(group);contributorGlyphs.push({group,path,text});
        }
        const glyph=contributorGlyphs[i],p=projectVector(row.acceleration,.10);
        if(!p)return;
        glyph.group.dataset.sourceId=row.id;glyph.group.dataset.acceleration=JSON.stringify(row.acceleration);
        glyph.group.style.display='';glyph.path.setAttribute('d',p.d);
        let y=p.ey+14;while(labelY.some(v=>Math.abs(v-y)<16))y+=16;labelY.push(y);
        glyph.text.setAttribute('x',String(p.ex+8));glyph.text.setAttribute('y',String(y));
        glyph.text.textContent=`${row.label}${p.sightline?' · along sightline':''}`;
        vectorSvg.style.display='block';
    });
    const a=snapshot.net,m=Math.hypot(...a);
    if(!(m>0))return; // opposing arrows can remain visible at a balanced point
    // Keep the projected net cue reachable even behind the mobile sheet.
    const cue=screenAccelerationDirection(a,camera);
    netDirection.hidden=false;netDirection.textContent=cue.symbol;
    netDirection.style.transform=`rotate(${cue.rotation}deg)`;
    netDirection.setAttribute('aria-label',cue.label);netDirection.title=cue.label;
    const p=projectVector(a,.14);if(!p)return;
    vectorSvg.style.display='block';vectorPath.style.display='';vectorPath.setAttribute('d',p.d);
    vectorPath.dataset.acceleration=JSON.stringify(a);
    vectorText.setAttribute('x',String(p.x+12));vectorText.setAttribute('y',String(p.y-14));
    vectorText.textContent=p.sightline?'Net along sightline':snapshot.estimated?'Estimated net direction':isPlacedHoleFocus(G.focus)?'Net acceleration · Earth frame':'Net direction';
}
export function updateGravityInspector(force=false) {
    if(!panel)return;
    if(G.uiMode!=='observe'||G.cabin){vectorSvg.style.display='none';vectorSummary.hidden=true;return;}
    const nextContext=gravityContext(cam.dist/K,context,G.focus);
    const key=String(G.focus)+':'+nextContext;
    const now=performance.now();
    if(force||panel.open||selectedHoleExplanation()||key!==identity||now-lastRead>250){
        if(key!==identity){
            previous=[];identity=key;context=nextContext;panel.dataset.context=context;
            // A new target/context must not inherit the scroll position of a
            // lower prediction button, hiding its model-scope heading.
            if(panel.open){panel.scrollTop=0;document.getElementById('explorePanel').scrollTop=0;}
        }
        snapshot=context==='galaxy'?getGalaxyGravityInspection():getLocalGravityInspection(G.focus);
        lastRead=now;
        setText(scope,snapshot.estimated?'Estimated':'Local');
        summary.title=isPlacedHoleFocus(G.focus)?'Gold arrows: other holes. Green: net acceleration in the Earth frame. Open for magnitudes and model limits.':'';
        setText(title,`${snapshot.name||'Select an object'} · ${snapshot.frame||'Model scope'}`);
        setText(modelDetail.lastElementChild,snapshot.note||'No further model information.');
        setText(note,!snapshot.supported?snapshot.note:snapshot.estimated?'Estimated shares of source magnitudes; their directions can cancel. This field is not applied to the simulation. Arrow length is normalized.':snapshot.frame==='Local perturbation only'?'Local kicks only; prescribed Galactic motion is excluded. No coupled forecast.':isPlacedHoleFocus(G.focus)?'Gold arrows: pulls from the other placed holes. Green: net acceleration, including other sources and Earth-frame correction. Self-pull is excluded. Arrow lengths are normalized; Time Pulses strokes are a qualitative field, not body trajectories.':'Current bounded solver. Others includes frame/relativity terms; the net is their vector sum. Arrow length is normalized.');
        if(snapshot.supported){
            const result=strongestContributions(snapshot.contributions,previous);previous=result.ids;
            // The displayed net is exactly the sum of these same contributions,
            // including the vector remainder and coordinate corrections.
            snapshot={...snapshot,net:result.net};updateRows(result);
            setText(leading,result.top[0]?`${result.top[0].label} leads${isPlacedHoleFocus(G.focus)?' · arrows show acceleration':''}`:'Balanced field');
            setText(net,snapshot.estimated?'Net: estimated direction only':`${snapshot.frame==='Local perturbation only'?'Net local':'Net'}: ${accelerationLabel(Math.hypot(...result.net))}`);
        }else{rows.textContent='';setText(leading,'View model scope');setText(net,'No complete applied-force vector available');}
        pathButton.hidden=!snapshot.predictionSupported||context==='galaxy';
        const predicting=hooks.predictionActive?.()||false;pathButton.setAttribute('aria-pressed',String(predicting));setText(pathButton,predicting?'Hide short coast path':'Show short coast path');
        setText(pathNote,pathButton.hidden?'':hooks.predictionNote?.()||'Short bounded coast estimate; no thrust. Source motion is extrapolated.');
    }
    drawVector();
}
export function closeGravityInspector(){if(panel)panel.open=false;}
