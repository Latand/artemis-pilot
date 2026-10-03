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
};
let samplingCamera = null;
let samplingNear = 0;

export function beginRingSamplingDepth(camera = null) {
    samplingCamera = camera;
    samplingNear = camera?.near || 0;
    ringSamplingUniforms.uRingPresent.value = 0;
}

export function trackRingSamplingMaterial(material) {
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
