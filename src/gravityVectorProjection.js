import {Vector3} from 'three';
import {K} from './constants.js';
import {preciseViewPosition} from './render/preciseViewPosition.js';
const origin=new Vector3(),end=new Vector3(),direction=new Vector3();

// Direction-only UI geometry. Preserve the camera's orbit residual and add
// the arrow delta in view space, never to an intergalactic absolute position.
export function projectGravityVector(positionKm,acceleration,camera,distance,fraction,width,height) {
    const m=Math.hypot(...acceleration);
    if(!(m>0)||!Number.isFinite(m)||!(distance>0)||!Number.isFinite(distance))return null;
    preciseViewPosition(origin.set(positionKm[0]*K,positionKm[2]*K,-positionKm[1]*K),camera);
    direction.set(acceleration[0]/m,acceleration[2]/m,-acceleration[1]/m)
        .transformDirection(camera.matrixWorldInverse).multiplyScalar(distance*fraction);
    end.copy(origin).add(direction);
    if(origin.z>=0||end.z>=0)return null;
    // The UI cue is not a depth-buffer object. Tiny holes use their own near
    // rendering policy; don't erase their arrows at the ordinary near plane.
    origin.applyMatrix4(camera.projectionMatrix);end.applyMatrix4(camera.projectionMatrix);
    if(![origin.x,origin.y,end.x,end.y].every(Number.isFinite)||Math.abs(origin.x)>1||Math.abs(origin.y)>1)return null;
    const x=(origin.x+1)*width/2,y=(1-origin.y)*height/2,ex=(end.x+1)*width/2,ey=(1-end.y)*height/2;
    const dx=ex-x,dy=ey-y,len=Math.hypot(dx,dy);
    if(len<8)return {x,y,ex:x,ey:y,sightline:true,d:`M ${x-4} ${y} L ${x+4} ${y} M ${x} ${y-4} L ${x} ${y+4}`};
    const ux=dx/len,uy=dy/len,bx=ex-ux*10,by=ey-uy*10;
    return {x,y,ex,ey,sightline:false,d:`M ${x} ${y} L ${ex} ${ey} M ${bx-uy*5} ${by+ux*5} L ${ex} ${ey} L ${bx+uy*5} ${by-ux*5}`};
}

// A panel cue remains readable when fixed controls cover the scene origin.
export function screenAccelerationDirection(acceleration,camera) {
    const m=Math.hypot(...acceleration);
    if(!(m>0)||!Number.isFinite(m))return {symbol:'·',rotation:0,label:'Balanced acceleration'};
    direction.set(acceleration[0]/m,acceleration[2]/m,-acceleration[1]/m).transformDirection(camera.matrixWorldInverse);
    if(Math.hypot(direction.x,direction.y)<.05)return {symbol:direction.z<0?'⊗':'⊙',rotation:0,label:direction.z<0?'Into the screen':'Out of the screen'};
    return {symbol:'↑',rotation:Math.atan2(direction.x,direction.y)*180/Math.PI,label:'Direction projected onto the screen'};
}
