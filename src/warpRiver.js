import * as THREE from 'three';

// A compact-support art deformation, not a metric, force or advection term.
// Used ONLY by draw vertex shaders. No texture feedback receives this result.
export const WARP_DRAW_GLSL = /* glsl */`
uniform vec3 uWarpShip, uWarpAxis;
uniform float uWarpRadius, uWarpStrength, uWarpPhase;
vec3 warpDrawPosition(vec3 p) {
    if (uWarpStrength <= 0.0) return p;
    vec3 q = (p - uWarpShip) / uWarpRadius;
    float r2 = dot(q, q);
    if (r2 >= 1.0) return p;
    float envelope = pow(1.0 - r2, 3.0);
    float axial = dot(q, uWarpAxis);
    vec3 radial = q - uWarpAxis * axial;
    // Bow compression, aft extension, a restrained twist beside the rings.
    vec3 bend = radial * 1.5 + cross(uWarpAxis, radial) * .7
              - uWarpAxis * (.52 + axial * .3);
    return p + bend * (uWarpRadius * uWarpStrength * envelope);
}
`;

// The normal river volume can span millions of visible hull radii. These
// bounded extra samples expose its local direction at craft-inspection scale
// without changing the particles, their source field, or its compute pass.
export function createWarpRiverLayer(uniforms, flowGLSL, mobile) {
    const streams = mobile ? 16 : 24, segments = mobile ? 16 : 24;
    const positions = new Float32Array(streams * (segments + 1) * 3);
    const indices = new Uint16Array(streams * segments * 2);
    for (let i = 0; i < streams; i++) {
        const a = i * Math.PI * 2 / streams;
        const r = i % 2 ? .48 : .26;
        for (let j = 0; j <= segments; j++) {
            const k = (i * (segments + 1) + j) * 3;
            positions[k] = Math.cos(a) * r;
            positions[k + 1] = j / segments * 2.4 - 1.2;
            positions[k + 2] = Math.sin(a) * r;
            if (j < segments) {
                const e = (i * segments + j) * 2;
                indices[e] = i * (segments + 1) + j;
                indices[e + 1] = i * (segments + 1) + j + 1;
            }
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: /* glsl */`
            ${flowGLSL}
            ${WARP_DRAW_GLSL}
            varying float vInk;
            void main() {
                // Same source field and moving frame as the surrounding river.
                vec3 flow = flowField(uWarpShip);
                float speed = length(flow);
                vec3 axis = speed > 1e-10 ? flow / speed : uWarpAxis;
                vec3 reference = abs(axis.y) < .9 ? vec3(0,1,0) : vec3(1,0,0);
                vec3 side = normalize(cross(axis, reference));
                vec3 up = cross(side, axis);
                vec3 p = uWarpShip + uWarpRadius * (side * position.x + axis * position.y + up * position.z);
                vec3 drawn = warpDrawPosition(p);
                float pulse = .64 + .36 * pow(.5 + .5 * cos(position.y * 8.0 - uWarpPhase * 3.0), 2.0);
                vInk = uWarpStrength * (1.0 - smoothstep(.72, 1.2, abs(position.y))) * pulse;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(drawn, 1.0);
            }`,
        fragmentShader: /* glsl */`
            varying float vInk;
            void main() { gl_FragColor = vec4(vec3(.69, .32, .95) * vInk, vInk * .65); }`,
        transparent: true, depthTest: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    const layer = new THREE.LineSegments(geometry, material);
    layer.name = 'Speculative local river samples';
    layer.frustumCulled = false;
    layer.renderOrder = 1;
    layer.visible = false;
    return layer;
}
