import * as THREE from "three";
import { mulberry32 } from "./format.js";
import { dotTexture } from "./textures.js";
import { scene } from "./scene.js";
import { createShipModel } from "./shipModel.js";

// Exterior and navigation aids; physical state lives outside the renderer.
export const shipG = new THREE.Group();
export const craft = createShipModel();
shipG.add(craft);
// A compact hollow navigation diamond, not a luminous astronomical object.
const markerCanvas = document.createElement('canvas');
markerCanvas.width = markerCanvas.height = 64;
const markerCtx = markerCanvas.getContext('2d');
markerCtx.strokeStyle = '#81c7d4'; markerCtx.lineWidth = 7;
markerCtx.beginPath(); markerCtx.moveTo(32,6); markerCtx.lineTo(58,32);
markerCtx.lineTo(32,58); markerCtx.lineTo(6,32); markerCtx.closePath(); markerCtx.stroke();
export const dot = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(markerCanvas), transparent:true, depthWrite:false,
    depthTest:false, sizeAttenuation:false, toneMapped:false,
}));
shipG.add(dot);
export const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(255,190,120,1)", "rgba(255,90,40,0.8)"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
flame.visible = false;
shipG.add(flame);
export const plasma = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(255,210,150,1)", "rgba(255,110,40,0.7)"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
plasma.visible = false;
shipG.add(plasma);
scene.add(shipG);

// ---- heading (nose) indicator: yellow shaft + cone for flight-scale views ----
export const headArrow = new THREE.Group();
const headLineGeom = new THREE.BufferGeometry();
const headLinePos = new Float32Array(6);
const headLineAttr = new THREE.BufferAttribute(headLinePos, 3);
headLineAttr.setUsage(THREE.DynamicDrawUsage);
headLineGeom.setAttribute("position", headLineAttr);
const headLine = new THREE.Line(headLineGeom, new THREE.LineBasicMaterial({ color: 0xffd34d, transparent: true, opacity: .85, depthTest: false }));
headLine.frustumCulled = false;
const headTip = new THREE.Mesh(
    new THREE.ConeGeometry(1, 2.6, 10),
    new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: .92, depthTest: false }));
headTip.frustumCulled = false;
headLine.renderOrder = 6; headTip.renderOrder = 6;
headArrow.add(headLine, headTip);
scene.add(headArrow);
const upY = new THREE.Vector3(0, 1, 0);
export function updateHeadingArrow(oriX, oriY, oriZ, dirV, cd, visible, alpha = 1) {
    headArrow.visible = visible && alpha > .03;
    if (!visible) return;
    headLine.material.opacity = .85 * alpha;
    headTip.material.opacity = .92 * alpha;
    const len = cd * .21, tipS = cd * .0075;
    headLinePos[0] = oriX; headLinePos[1] = oriY; headLinePos[2] = oriZ;
    headLinePos[3] = oriX + dirV.x * len; headLinePos[4] = oriY + dirV.y * len; headLinePos[5] = oriZ + dirV.z * len;
    headLineAttr.needsUpdate = true;
    headTip.position.set(oriX + dirV.x * len, oriY + dirV.y * len, oriZ + dirV.z * len);
    headTip.scale.setScalar(tipS);
    headTip.quaternion.setFromUnitVectors(upY, dirV);
}

// ---- exhaust particles ----
export const EXN = 420;
export const exPos = new Float32Array(EXN * 3), exVel = new Float32Array(EXN * 3), exLife = new Float32Array(EXN), exMax = new Float32Array(EXN), exCol = new Float32Array(EXN * 3);
const exGeom = new THREE.BufferGeometry();
export const exPosAttr = new THREE.BufferAttribute(exPos, 3); exPosAttr.setUsage(THREE.DynamicDrawUsage);
export const exColAttr = new THREE.BufferAttribute(exCol, 3); exColAttr.setUsage(THREE.DynamicDrawUsage);
exGeom.setAttribute("position", exPosAttr);
exGeom.setAttribute("color", exColAttr);
export const exMat = new THREE.PointsMaterial({ size: .03, vertexColors: true, sizeAttenuation: true, map: dotTexture("rgba(255,220,170,1)", "rgba(255,120,50,0.6)"), transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false });
export const exhaust = new THREE.Points(exGeom, exMat);
exhaust.visible = false;
exhaust.frustumCulled = false;
scene.add(exhaust);
let exHead = 0;
const exRnd = mulberry32(777111);
export function spawnExhaust(px, py, pz, dx, dy, dz, cs, hot) {
    exhaust.visible = true;
    const i = exHead; exHead = (exHead + 1) % EXN;
    const sp = cs * (1.8 + exRnd() * 1.4);
    exPos[i * 3] = px + (exRnd() - .5) * cs * .14;
    exPos[i * 3 + 1] = py + (exRnd() - .5) * cs * .14;
    exPos[i * 3 + 2] = pz + (exRnd() - .5) * cs * .14;
    exVel[i * 3] = dx * sp + (exRnd() - .5) * cs * .8;
    exVel[i * 3 + 1] = dy * sp + (exRnd() - .5) * cs * .8;
    exVel[i * 3 + 2] = dz * sp + (exRnd() - .5) * cs * .8;
    exMax[i] = exLife[i] = .5 + exRnd() * .9;
    exCol[i * 3] = 1; exCol[i * 3 + 1] = hot ? .85 : .6; exCol[i * 3 + 2] = hot ? .55 : .25;
}

// ---- explosion ----
export const XPN = 520;
export const xpPos = new Float32Array(XPN * 3), xpVel = new Float32Array(XPN * 3), xpLife = new Float32Array(XPN), xpCol = new Float32Array(XPN * 3);
const xpGeom = new THREE.BufferGeometry();
export const xpPosAttr = new THREE.BufferAttribute(xpPos, 3); xpPosAttr.setUsage(THREE.DynamicDrawUsage);
export const xpColAttr = new THREE.BufferAttribute(xpCol, 3); xpColAttr.setUsage(THREE.DynamicDrawUsage);
xpGeom.setAttribute("position", xpPosAttr);
xpGeom.setAttribute("color", xpColAttr);
export const xpMat = new THREE.PointsMaterial({ size: .05, vertexColors: true, sizeAttenuation: true, map: dotTexture("rgba(255,230,190,1)", "rgba(255,120,40,0.7)"), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
export const explosion = new THREE.Points(xpGeom, xpMat);
explosion.visible = false;
explosion.frustumCulled = false;
scene.add(explosion);
export const xpFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(255,255,240,1)", "rgba(255,150,50,0.8)"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
xpFlash.visible = false;
scene.add(xpFlash);
export const xp = { t: -1 };
export function triggerExplosion(px, py, pz, cs) {
    const rnd = mulberry32((performance.now() | 0) ^ 0x5bd1);
    for (let i = 0; i < XPN; i++) {
        xpPos[i * 3] = px; xpPos[i * 3 + 1] = py; xpPos[i * 3 + 2] = pz;
        const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
        const sp = cs * (1.5 + rnd() * rnd() * 9);
        xpVel[i * 3] = sp * Math.sin(ph) * Math.cos(th);
        xpVel[i * 3 + 1] = sp * Math.cos(ph);
        xpVel[i * 3 + 2] = sp * Math.sin(ph) * Math.sin(th);
        xpLife[i] = .8 + rnd() * 1.6;
        xpCol[i * 3] = 1; xpCol[i * 3 + 1] = .7 + rnd() * .3; xpCol[i * 3 + 2] = .3 + rnd() * .3;
    }
    xpMat.size = cs * .25;
    explosion.visible = true;
    xpFlash.position.set(px, py, pz);
    xpFlash.visible = true;
    xp.t = 0;
}
