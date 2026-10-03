import * as THREE from 'three';
import { isBodyBoundsHookSafe, registerBodyBoundsHook } from './bodyBoundsHooks.js';
// WebGLRenderer invokes material.onBeforeRender after composing modelView.
// Recompose ONLY its translation from small CPU-double residuals. Physics,
// world transforms and surface normal transforms remain unchanged.
export function stabilizeBodyMaterial(material) {
    const previous=material.onBeforeRender;
    const boundsSafe=isBodyBoundsHookSafe(material,'onBeforeRender');
    const relative=new THREE.Vector3();
    material.onBeforeRender=function(renderer,scene,camera,geometry,object,group) {
        previous?.call(this,renderer,scene,camera,geometry,object,group);
        const orbit=camera.userData.preciseOrbit;
        if (!orbit || !orbit.worldPosition.equals(camera.position)) return;
        const world=object.matrixWorld.elements, view=camera.matrixWorldInverse.elements;
        relative.set(world[12]-orbit.target.x,world[13]-orbit.target.y,world[14]-orbit.target.z).sub(orbit.offset);
        const x=relative.x,y=relative.y,z=relative.z,m=object.modelViewMatrix.elements;
        m[12]=view[0]*x+view[4]*y+view[8]*z;
        m[13]=view[1]*x+view[5]*y+view[9]*z;
        m[14]=view[2]*x+view[6]*y+view[10]*z;
    };
    if (boundsSafe) registerBodyBoundsHook(material,'onBeforeRender');
    return material;
}
