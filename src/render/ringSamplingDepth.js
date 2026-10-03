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
    uRingBodyConicA: { value: new THREE.Vector3() },
    uRingBodyConicB: { value: new THREE.Vector4() },
    uRingBodyConicCenter: { value: new THREE.Vector3() },
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

// The transformed sphere silhouette is a conic in image space. Form the
// ray/sphere discriminant once per actual ring draw, rather than repeatedly
// per output pixel in the lens solver. Coordinates stay near the body's
// projected centre to avoid cancellation for an off-axis source.
export function bodySilhouetteConic(a, b, center, inverse, matrix, projection, radius, width, height) {
    const m=matrix.elements,v=inverse.elements,p=projection.elements;
    const z=-m[14],rawX=z>0 ? m[12]*p[0]/z*.5+.5 : .5,rawY=z>0 ? m[13]*p[5]/z*.5+.5 : .5;
    // A near-clipped, side-on body can project its centre thousands of
    // viewports away. Keep the polynomial expansion inside the image so
    // float32 uv-centre subtraction cannot erase the visible silhouette.
    const cx=Math.max(0,Math.min(1,rawX)),cy=Math.max(0,Math.min(1,rawY));
    const centered=z>0&&cx===rawX&&cy===rawY;
    const ax=v[0]*2/p[0],ay=v[1]*2/p[0],az=v[2]*2/p[0];
    const bx=v[4]*2/p[5],by=v[5]*2/p[5],bz=v[6]*2/p[5];
    const ox=v[12],oy=v[13],oz=v[14],rr=radius*radius;
    const rx=centered ? -ox/z : ax*(cx-.5)+bx*(cy-.5)-v[8];
    const ry=centered ? -oy/z : ay*(cx-.5)+by*(cy-.5)-v[9];
    const rz=centered ? -oz/z : az*(cx-.5)+bz*(cy-.5)-v[10];
    // D = R²|ray|² - |origin × ray|² avoids subtracting two enormous
    // almost-equal dot products for a distant, small projected body.
    const cax=oy*az-oz*ay,cay=oz*ax-ox*az,caz=ox*ay-oy*ax;
    const cbx=oy*bz-oz*by,cby=oz*bx-ox*bz,cbz=ox*by-oy*bx;
    const crx=centered ? 0 : oy*rz-oz*ry,cry=centered ? 0 : oz*rx-ox*rz,crz=centered ? 0 : ox*ry-oy*rx;
    const xx=rr*(ax*ax+ay*ay+az*az)-(cax*cax+cay*cay+caz*caz);
    const xy=rr*(ax*bx+ay*by+az*bz)-(cax*cbx+cay*cby+caz*cbz);
    const yy=rr*(bx*bx+by*by+bz*bz)-(cbx*cbx+cby*cby+cbz*cbz);
    const lx=rr*(ax*rx+ay*ry+az*rz)-(cax*crx+cay*cry+caz*crz);
    const ly=rr*(bx*rx+by*ry+bz*rz)-(cbx*crx+cby*cry+cbz*crz);
    const cc=rr*(rx*rx+ry*ry+rz*rz)-(crx*crx+cry*cry+crz*crz);
    const scale=Math.max(Math.abs(xx),Math.abs(xy),Math.abs(yy),Math.abs(lx),Math.abs(ly),Math.abs(cc),1e-30);
    a.set(xx/scale,xy/scale,yy/scale);
    // Quadratic remainder bounds every point within two Euclidean pixels.
    // This keeps the band conservative even for a tiny or elongated sphere.
    const remainder=4*Math.max(Math.abs(a.x)/(width*width)+Math.abs(a.y)/(width*height),Math.abs(a.z)/(height*height)+Math.abs(a.y)/(width*height));
    b.set(lx/scale,ly/scale,cc/scale,remainder);
    const depthExtent=radius*Math.hypot(m[2],m[6],m[10]);
    const depthPad=2*Math.max(0,z+depthExtent)*Math.max(2/(width*p[0]),2/(height*p[5]));
    center.set(cx,cy,depthPad);
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
        bodySilhouetteConic(u.uRingBodyConicA.value,u.uRingBodyConicB.value,u.uRingBodyConicCenter.value,
            u.uViewToRing.value,object.modelViewMatrix,camera.projectionMatrix,bodyRadius,drawingBuffer.x,drawingBuffer.y);
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
    uniform vec3 uRingBodyConicA, uRingBodyConicCenter;
    uniform vec4 uRingBodyConicB;
    float bodyCoverageSourceDepth(vec2 uv, float opaqueZ) {
        if (opaqueZ < 1e29 || uRingPresent == 0 || uRingBodyRadius <= 0.0) return opaqueZ;
        if (any(lessThan(uv,uRingBodyBounds.xy)) || any(greaterThan(uv,uRingBodyBounds.zw))) return opaqueZ;
        // Multisampled or linearly filtered colour can cover a planet texel
        // whose resolved opaque depth is clear. Search only the immediate
        // two inward pixels on the DRAWN Saturn ellipsoid's silhouette;
        // never dilate depth across the sky, ring gaps or unrelated bodies.
        vec2 texel = 1.0/vec2(textureSize(tDepth,0));
        vec2 p = uv-uRingBodyConicCenter.xy;
        vec3 a = uRingBodyConicA;
        vec2 halfGradient = vec2(a.x*p.x+a.y*p.y,a.y*p.x+a.z*p.y)+uRingBodyConicB.xy;
        float value = dot(p,halfGradient+uRingBodyConicB.xy)+uRingBodyConicB.z;
        vec2 gradient = halfGradient*texel;
        if (abs(value) > 4.0*length(gradient)+uRingBodyConicB.w) return opaqueZ;
        // Positive discriminant is inside; its gradient points inward.
        vec2 stepUv = texel*gradient/max(length(gradient),1e-20);
        float depth = texture2D(tDepth,clamp(uv+stepUv,0.0,1.0)).x;
        float z = uNear*uFar/max(uFar-depth*(uFar-uNear),1e-20);
        if (depth < 1.0 && abs(z-uRingBodyDepth.x) <= uRingBodyDepth.y+uRingBodyConicCenter.z) return z;
        depth = texture2D(tDepth,clamp(uv+stepUv*2.0,0.0,1.0)).x;
        z = uNear*uFar/max(uFar-depth*(uFar-uNear),1e-20);
        if (depth < 1.0 && abs(z-uRingBodyDepth.x) <= uRingBodyDepth.y+uRingBodyConicCenter.z) return z;
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
