import * as THREE from 'three';

// Display-only projection of the commanded local field envelope.
// The physical centre gradient lives in curvatureDrive.js; this is not a metric.
// Used ONLY by the local-sample draw vertex shader. No texture feedback receives this result.
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
    // Cyan-facing bow compression / aft expansion follows the delivered
    // acceleration axis, including reverse and lateral commands.
    vec3 bend = radial * (-1.5 * axial) + cross(uWarpAxis, radial) * .25
              - uWarpAxis * (.3 + axial * .18);
    return p + bend * (uWarpRadius * uWarpStrength * envelope);
}
`;

// The normal river volume can span millions of visible hull radii. These
// bounded extra samples expose its local direction at craft-inspection scale
// without changing the particles, their source field, or its compute pass.
export function createWarpRiverLayer(uniforms, mobile) {
    const streams = mobile ? 16 : 24, segments = 32;
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
            ${WARP_DRAW_GLSL}
            uniform vec3 uWarpFlow;
            varying float vInk;
            void main() {
                // Same source field and moving frame as the surrounding river.
                vec3 flow = uWarpFlow;
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
    layer.name = 'Commanded curvature field river guide';
    layer.frustumCulled = false;
    layer.renderOrder = 1;
    layer.visible = false;
    return layer;
}

// One display-only sample of river.js FLOW_GLSL, using its already prepared
// center-relative source table. This avoids repeating an identical source loop
// at every local vertex. Keep softening, attraction direction, DE blend and
// rest-frame subtraction synchronized with that existing shader.
export function sampleWarpRiverFlow(uniforms, out) {
    const u = uniforms, p = u.uWarpShip.value, origin = u.uOrigin.value;
    const visualBH = Math.min(Math.max(u.uRadius.value * .0008, .45), 64);
    let vx=0, vy=0, vz=0, px=0, py=0, pz=0;
    for (let i=0; i<u.uNB.value; i++) {
        const body=u.uBody.value[i], sink=u.uSink.value[i], hole=u.uHole.value[i];
        if (!(body.w > 0)) continue;
        const core=sink+(Math.max(sink,visualBH)-sink)*hole;
        const soft=sink*.5+(Math.max(sink*.5,core*.35)-sink*.5)*hole;
        const dx=p.x-body.x, dy=p.y-body.y, dz=p.z-body.z;
        const r=Math.max(soft,Math.hypot(dx,dy,dz),1e-12);
        const speed=body.w/Math.sqrt(r)/r, pull=body.w*body.w/r/r/r;
        vx-=dx*speed; vy-=dy*speed; vz-=dz*speed;
        px-=dx*pull; py-=dy*pull; pz-=dz*pull;
    }
    const de=u.uDE.value;
    const ex=(p.x-origin.x)*de, ey=(p.y-origin.y)*de, ez=(p.z-origin.z)*de;
    vx+=ex; vy+=ey; vz+=ez;
    const raw=Math.hypot(vx,vy,vz), pull=Math.hypot(px,py,pz);
    if (raw>=1e-12 && pull>=1e-18) {
        const t=Math.max(0,Math.min(1,(Math.hypot(ex,ey,ez)/raw-.45)/(.92-.45)));
        const blend=t*t*(3-2*t), k=raw/pull;
        vx=px*k+(vx-px*k)*blend; vy=py*k+(vy-py*k)*blend; vz=pz*k+(vz-pz*k)*blend;
    }
    const frame=u.uFrameVel.value, w=u.uFrameW.value;
    vx-=frame.x*w; vy-=frame.y*w; vz-=frame.z*w;
    if (!Number.isFinite(vx+vy+vz)) return out.set(0,0,0);
    return out.set(vx,vy,vz);
}
