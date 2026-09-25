import { initCompactExplorer } from "./compactExplorer.js";
import * as THREE from "three";
import { G, keys, WORLD, BH } from "./state.js";
import { K, MU_E, MU_M, R_EARTH, R_MOON, R_SUN, PL, STARS, LY_SCENE } from "./constants.js";
import { MOONS, moonFocusIndex } from "./moons.js";
import { cam, camera } from "./scene.js";
import { onModeChange, setUiMode, isXrPresenting } from "./uiMode.js";
import { sunStateAt } from "./universe/sunEvolution.js";
import { activeStarForFocus, getCachedFocusedSystem } from "./universe/activeStars.js";
import { planetFocusIndex } from "./universe/planetarySystem.js";
import { bodyFactRows, basisDescription } from "./universe/bodyFacts.js";
import { bhMassLabel } from "./blackholes.js";
import { fmtDist } from "./format.js";

let hooks, lastFocus = "earth", movement = null;
const forward = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), delta = new THREE.Vector3();
const $ = id => document.getElementById(id);
const text = (id, value) => { const el=$(id); if(el && el.textContent!==value) el.textContent=value; };
const routes = {earth:"earth",moon:"moon",sun:"sun",jupiter:3,saturn:4,proxima:"star:0"};

function visit(focus) {
    G.cabin = false;
    hooks.flyTo(focus);
    lastFocus = focus;
    updateExplorerUI();
}

export function initExplorerUI(options) {
    hooks=options;
    initCompactExplorer({ stopMovement: () => { movement = null; } });
    document.querySelectorAll('[data-ui-mode]').forEach(btn => btn.addEventListener('click',()=>setUiMode(btn.dataset.uiMode)));
    document.querySelectorAll('[data-destination]').forEach(btn => btn.addEventListener('click',()=>visit(routes[btn.dataset.destination])));
    $('exploreHome').addEventListener('click',()=>visit('earth'));
    if(matchMedia('(max-width:700px)').matches) { $('exploreDestinations').open=false; $('exploreInfo').open=false; }
    $('exploreSearch').addEventListener('click',hooks.openNavigator);
    $('exploreCatalog').addEventListener('click',hooks.openCatalog);
    $('exploreEvents').addEventListener('click',()=>{
        if(G.uiMode!=='observe') setUiMode('observe');
        if(!$('evPanel').classList.contains('open')) $('evBtn').click();
    });
    $('evClose').addEventListener('click',()=>{if(G.uiMode==='observe') $('exploreEvents').focus();});
    window.addEventListener('keydown',e=>{if(e.key==='Escape'&&e.target.closest?.('#evPanel')) $('exploreEvents').focus();});
    $('exploreGravity').addEventListener('click',()=>{G.gr=!G.gr;updateExplorerUI();});
    $('exploreRefocus').addEventListener('click',()=>visit(lastFocus));
    $('exploreScale').addEventListener('click',()=>{visit('sun');cam.distTarget=LY_SCENE*100000;});
    $('exploreHelp').addEventListener('click',hooks.toggleHelp);
    document.querySelectorAll('[data-camera-move]').forEach(btn=>{
        btn.addEventListener('pointerdown',e=>{e.preventDefault();btn.setPointerCapture(e.pointerId);movement=btn.dataset.cameraMove;});
        for(const name of ['pointerup','pointercancel','lostpointercapture']) btn.addEventListener(name,()=>{movement=null;});
    });
    window.addEventListener('blur',()=>{movement=null;});
    onModeChange((mode)=>{
        keys.clear(); movement=null;
        if(mode==='pilot') {
            if(G.focus!=='ship'&&G.focus!=='free') lastFocus=G.focus;
            hooks.flyTo('ship');
        }
        if(mode==='observe') {
            G.cabin=false;
            if(G.focus==='ship') visit(lastFocus);
        }
        updateExplorerUI();
    });
    updateExplorerUI();
}

// Movement follows the camera and scales with its current viewing distance.
// It changes only the view target; simulation time and the ship remain independent.
export function moveExplorerCamera(dt) {
    if(G.uiMode!=='observe'||isXrPresenting()||G.cabin) return;
    const target=document.activeElement;
    if(target?.matches('input,textarea,select,[contenteditable="true"]')) return;
    const pressed=(code,dir)=>keys.has(code)||movement===dir;
    const z=Number(pressed('KeyW','forward'))-Number(pressed('KeyS','back'));
    const x=Number(pressed('KeyD','right'))-Number(pressed('KeyA','left'));
    const y=Number(pressed('KeyE','up'))-Number(pressed('KeyQ','down'));
    if(!(x||y||z))return;
    if(G.focus!=='free')lastFocus=G.focus;
    camera.getWorldDirection(forward);
    right.setFromMatrixColumn(camera.matrixWorld,0);up.setFromMatrixColumn(camera.matrixWorld,1);
    delta.copy(forward).multiplyScalar(z).addScaledVector(right,x).addScaledVector(up,y).normalize();
    const speed=Math.max(.03,cam.dist)*Math.min(dt,.06)*(keys.has('ShiftLeft')||keys.has('ShiftRight')?2.5:.65);
    cam.tgt.addScaledVector(delta,speed);cam.distTarget=null;G.focus='free';
}

// Alongside the display name this carries the raw records the fact rows are
// derived from — mu, the catalogue entry, the Sun's evolution state — plus the
// epistemic tier those numbers belong to. A body that simply has no record for
// a quantity carries no field for it, and bodyFacts then omits that row.
function selectedBody() {
    if(G.focus==='sun'&&cam.dist>=LY_SCENE*20000)return {name:cam.dist>LY_SCENE*800000?'Local Group':'Milky Way',kind:'Galaxy-scale view',basis:'modeled'};
    const bi=/^bh:(\d+)$/.exec(String(G.focus));
    if(bi&&+bi[1]<BH.n)return {name:(BH.kind[+bi[1]]===1?'Quasar ':BH.kind[+bi[1]]===2?'Pulsar ':'Black hole ')+(+bi[1]+1),kind:'Modeled compact object',rs:BH.rs[+bi[1]],bhMass:bhMassLabel(BH.rs[+bi[1]]),basis:'modeled'};
    if(G.focus==='earth')return {name:'Earth',kind:WORLD.earthDestroyed?'Destroyed planet':'Home planet',R:R_EARTH,mu:MU_E,focusKey:'earth',basis:'measured'};
    if(G.focus==='moon')return {name:'Moon',kind:WORLD.moonDestroyed?'Destroyed moon':"Earth’s moon",R:R_MOON,mu:MU_M,focusKey:'moon',basis:'measured'};
    if(G.focus==='sun'){const s=sunStateAt(G.t);return {name:'Sun',kind:'Stellar evolution · '+s.phase,R:R_SUN*s.R_Rsun,sun:s,basis:'modeled'};}
    if(typeof G.focus==='number'){const p=PL[G.focus];return p?{...p,kind:WORLD.plDestroyed[G.focus]?'Destroyed planet':p.gas?'Gas / ice giant':'Rocky planet',planetIndex:G.focus,basis:'measured'}:null;}
    // MOONS[i].mu is the parent planet's, kept for the analytic orbit, so a
    // planetary moon passes only its own radius and shows no mass or gravity.
    const mi=moonFocusIndex(G.focus);if(mi>=0)return {name:MOONS[mi].name,kind:'Moon',R:MOONS[mi].R,basis:'measured'};
    const si=/^star:(\d+)$/.exec(String(G.focus));if(si&&STARS[+si[1]]){const st=STARS[+si[1]];return {...st,R:st.bh?null:st.R,kind:st.bh?'Black hole':'Catalog star',star:st.bh?null:st,rs:st.rs,bhMass:st.bh?bhMassLabel(st.rs):null,basis:st.bh?'modeled':'measured'};}
    const active=activeStarForFocus(G.focus);if(active)return {...active,kind:'Stellar destination',star:active,basis:active.estimated||active.procedural?'modeled':'measured'};
    const pi=planetFocusIndex(G.focus),p=getCachedFocusedSystem()?.planets?.[pi];
    if(p)return {name:p.name,kind:'Planetary system',R:p.radiusKm,basis:p.catalog?'measured':'modeled'};
    return null;
}

// Rows are reconciled in place so an unchanged panel does no DOM work.
function renderFacts(rows) {
    const host=$('exploreFacts');
    if(!host)return;
    while(host.children.length>rows.length) host.removeChild(host.lastChild);
    while(host.children.length<rows.length) {
        const wrap=document.createElement('div');
        wrap.appendChild(document.createElement('dt'));
        wrap.appendChild(document.createElement('dd'));
        host.appendChild(wrap);
    }
    rows.forEach((row,i)=>{
        const [dt,dd]=host.children[i].children;
        if(dt.textContent!==row.label)dt.textContent=row.label;
        if(dd.textContent!==row.value)dd.textContent=row.value;
    });
}

export function updateExplorerUI() {
    document.querySelectorAll('[data-ui-mode]').forEach(btn=>{const selected=G.uiMode===btn.dataset.uiMode;if(btn.getAttribute('aria-pressed')!==String(selected))btn.setAttribute('aria-pressed',String(selected));});
    if(G.uiMode!=='observe')return;
    const body=selectedBody();
    if(G.focus!=='free'&&G.focus!=='ship')lastFocus=G.focus;
    text('exploreObject',body?.name|| (G.focus==='free'?'Free flight':G.focus==='ship'?'Spacecraft':'Selected destination'));
    text('exploreKind',body?.kind||(G.focus==='free'?'Camera moves independently':'Explore the surrounding space'));
    // Viewing distance spans metres to megaparsecs, so it needs the
    // scale-aware formatter; raw kilometres are unreadable past a light-year.
    renderFacts(bodyFactRows(body).concat({label:'Viewing distance',value:fmtDist(cam.dist/K)}));
    text('exploreBasis',basisDescription(body));
    text('exploreFollow',G.focus==='free'?'Free camera':'Following object');
    text('exploreGravityStatus',G.gr?'Gravity flow visible':'Natural view');
    if($('exploreGravity').getAttribute('aria-pressed')!==String(G.gr)) $('exploreGravity').setAttribute('aria-pressed',String(G.gr));
    $('exploreRefocus').hidden=G.focus!=='free';
}
