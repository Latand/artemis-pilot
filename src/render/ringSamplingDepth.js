import * as THREE from 'three';

// Saturn is the one textured ring mesh in the current scene. Its blended
// colour intentionally does not write opaque depth. Supply its actual drawn
// annulus separately for lens SOURCE selection; never change occlusion depth
// or material blending. This is still a single-layer screen-space lookup,
// not a separate ray solution for background light transmitted by the ring.
export const ringSamplingUniforms = {
    uRingPresent: { value: 0 },
    uViewToRing: { value: new THREE.Matrix4() },
    uRingRadii: { value: new THREE.Vector2() },
    uRingMap: { value: null },
    uRingMapTransform: { value: new THREE.Matrix3() },
    uRingOpacity: { value: 0 },
    uRingAlphaTest: { value: 0 },
    uRingProjection: { value: new THREE.Vector2() },
    uRingBodyRadius: { value: 0 },
    uRingBodyDepth: { value: new THREE.Vector2() },
    uRingBodyBounds: { value: new THREE.Vector4() },
};
let samplingCamera = null;
let samplingNear = 0;
const drawingBuffer = new THREE.Vector2();

// Project the post-affine sphere's view-space AABB. This deliberately loose
// rectangle cheaply rejects unrelated sky before any silhouette work/fetches.
export function bodyUvBounds(out, matrix, projection, radius, width, height, near) {
    const m=matrix.elements,p=projection.elements;
    const x=m[12],y=m[13],z=-m[14];
    const rx=radius*Math.hypot(m[0],m[4],m[8]),ry=radius*Math.hypot(m[1],m[5],m[9]);
    const rz=radius*Math.hypot(m[2],m[6],m[10]),a=z-rz,b=z+rz;
    if (!(radius>0) || b<=near) return out.set(2,2,2,2);
    if (a<=near) return out.set(0,0,1,1);
    const l=Math.min((x-rx)/a,(x-rx)/b),r=Math.max((x+rx)/a,(x+rx)/b);
    const bottom=Math.min((y-ry)/a,(y-ry)/b),top=Math.max((y+ry)/a,(y+ry)/b);
    return out.set(l*p[0]*.5+.5-3/width,bottom*p[5]*.5+.5-3/height,
                   r*p[0]*.5+.5+3/width,top*p[5]*.5+.5+3/height);
}

export function beginRingSamplingDepth(camera = null) {
    samplingCamera = camera;
    samplingNear = camera?.near || 0;
    ringSamplingUniforms.uRingPresent.value = 0;
}

export function trackRingSamplingMaterial(material, bodyRadius = 0) {
    const previous = material.onBeforeRender;
    material.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
        previous?.call(this, renderer, scene, camera, geometry, object, group);
        // Capture the near-tier draw only, after object.onBeforeRender has
        // applied any tidal affine transform and the renderer built modelView.
        if (camera !== samplingCamera || camera.near !== samplingNear || !this.map) return;
        const { innerRadius, outerRadius } = geometry.parameters || {};
        if (!(innerRadius > 0 && outerRadius > innerRadius) || this.opacity <= 0) return;
        if (Math.abs(object.modelViewMatrix.determinant()) < 1e-20) return;
        const u = ringSamplingUniforms;
        u.uViewToRing.value.copy(object.modelViewMatrix).invert();
        u.uRingRadii.value.set(innerRadius, outerRadius);
        if (this.map.matrixAutoUpdate) this.map.updateMatrix();
        u.uRingMapTransform.value.copy(this.map.matrix);
        u.uRingMap.value = this.map;
        u.uRingOpacity.value = this.opacity;
        u.uRingAlphaTest.value = this.alphaTest;
        const p = camera.projectionMatrix.elements;
        u.uRingProjection.value.set(p[0], p[5]);
        u.uRingBodyRadius.value = bodyRadius;
        const m = object.modelViewMatrix.elements;
        u.uRingBodyDepth.value.set(-m[14], bodyRadius*Math.hypot(m[2],m[6],m[10]));
        renderer.getDrawingBufferSize(drawingBuffer);
        bodyUvBounds(u.uRingBodyBounds.value,object.modelViewMatrix,camera.projectionMatrix,
            bodyRadius,drawingBuffer.x,drawingBuffer.y,camera.near);
        u.uRingPresent.value = 1;
    };
    return material;
}

export const RING_SAMPLING_DEPTH_GLSL = /* glsl */`
    uniform int uRingPresent;
    uniform mat4 uViewToRing;
    uniform vec2 uRingRadii, uRingProjection;
    uniform sampler2D uRingMap;
    uniform mat3 uRingMapTransform;
    uniform float uRingOpacity, uRingAlphaTest;
    uniform float uRingBodyRadius;
    uniform vec2 uRingBodyDepth;
    uniform vec4 uRingBodyBounds;
    float bodyCoverageSourceDepth(vec2 uv, float opaqueZ) {
        if (opaqueZ < 1e29 || uRingPresent == 0 || uRingBodyRadius <= 0.0) return opaqueZ;
        if (any(lessThan(uv,uRingBodyBounds.xy)) || any(greaterThan(uv,uRingBodyBounds.zw))) return opaqueZ;
        // Multisampled or linearly filtered colour can cover a planet texel
        // whose resolved opaque depth is clear. Search only the immediate
        // two inward pixels on the DRAWN Saturn ellipsoid's silhouette;
        // never dilate depth across the sky, ring gaps or unrelated bodies.
        vec3 origin = uViewToRing[3].xyz;
        mat3 inverseBasis = mat3(uViewToRing);
        vec3 ray = inverseBasis * vec3((uv*2.0-1.0)/uRingProjection,-1.0);
        float t = -dot(origin,ray)/max(dot(ray,ray),1e-20);
        if (t <= uNear || t >= uFar) return opaqueZ;
        vec2 texel = 1.0/vec2(textureSize(tDepth,0));
        float footprint = t*max(length(inverseBasis[0])*2.0*texel.x/uRingProjection.x,
                                length(inverseBasis[1])*2.0*texel.y/uRingProjection.y);
        if (abs(length(origin+ray*t)-uRingBodyRadius) > footprint*2.0) return opaqueZ;
        float viewFootprint = t*max(2.0*texel.x/uRingProjection.x,2.0*texel.y/uRingProjection.y);
        // Gradient of squared local distance at the closest ray point:
        // its derivative through t vanishes because closest is normal to ray.
        // Step inward in PIXEL coordinates, preserving nonuniform/TDE axes.
        vec3 closest = origin+ray*t;
        vec2 gradient = vec2(dot(closest,inverseBasis[0])*texel.x/uRingProjection.x,
                             dot(closest,inverseBasis[1])*texel.y/uRingProjection.y);
        vec2 stepUv = texel*gradient/max(length(gradient),1e-20);
        float depth = texture2D(tDepth,clamp(uv-stepUv,0.0,1.0)).x;
        float z = uNear*uFar/max(uFar-depth*(uFar-uNear),1e-20);
        if (depth < 1.0 && abs(z-uRingBodyDepth.x) <= uRingBodyDepth.y+viewFootprint*2.0) return z;
        depth = texture2D(tDepth,clamp(uv-stepUv*2.0,0.0,1.0)).x;
        z = uNear*uFar/max(uFar-depth*(uFar-uNear),1e-20);
        if (depth < 1.0 && abs(z-uRingBodyDepth.x) <= uRingBodyDepth.y+viewFootprint*2.0) return z;
        return opaqueZ;
    }
    float ringSourceDepth(vec2 uv, float opaqueZ) {
        if (uRingPresent == 0) return opaqueZ;
        vec3 origin = uViewToRing[3].xyz;
        vec3 ray = mat3(uViewToRing) * vec3((uv*2.0-1.0)/uRingProjection, -1.0);
        if (abs(ray.z) < 1e-10) return opaqueZ;
        float t = -origin.z/ray.z; // ray's view z is -t, even under affine TDE
        if (t < uNear || t > uFar || t >= opaqueZ) return opaqueZ;
        float radius = length((origin+ray*t).xy);
        if (radius < uRingRadii.x || radius > uRingRadii.y) return opaqueZ;
        vec2 strip = vec2((radius-uRingRadii.x)/(uRingRadii.y-uRingRadii.x), .5);
        vec2 mapUv = (uRingMapTransform*vec3(strip,1.0)).xy;
        float alpha = texture2D(uRingMap,mapUv).a*uRingOpacity;
        // Match texture holes and material alpha testing. Contributions below
        // one byte are unresolved in the existing LDR world colour target.
        if (alpha <= 1.0/255.0 || alpha < uRingAlphaTest) return opaqueZ;
        return t;
    }
`;
