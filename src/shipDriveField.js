import * as THREE from 'three';

// A ship-local schematic of the commanded curvature envelope. It stays
// visible without the universe river, and never displaces planets or stars.
// The cyan bow contracts; the violet aft expands along the acceleration axis.
export function createDriveField() {
    const positions = [], ring = [];
    const strands = 20, segments = 48;
    for (let i=0; i<strands; i++) for (let j=0; j<segments; j++) {
        const theta = i/strands*Math.PI*2;
        for (const k of [j,j+1]) {
            const t = k/segments * 2 - 1;
            positions.push(Math.cos(theta), t, Math.sin(theta));
            ring.push(i/strands);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('strand', new THREE.Float32BufferAttribute(ring, 1));
    const uniforms = { level:{value:0}, phase:{value:0} };
    const material = new THREE.ShaderMaterial({
        uniforms, transparent:true, depthWrite:false, depthTest:true,
        blending:THREE.AdditiveBlending, toneMapped:false,
        vertexShader: /* glsl */`
            uniform float level, phase;
            attribute float strand;
            varying float alpha;
            varying float front;
            void main() {
                float t = position.y;
                float support = pow(max(0.0, 1.0-t*t), 1.5);
                // Same compact-support cubic envelope as the effective field.
                float envelope = pow(max(0.0, 1.0-t*t), 3.0);
                float radius = (.48 + .20 * support) * (1.0 - .48 * t * level * envelope);
                vec3 p = vec3(position.x*radius, t*1.2, position.z*radius);
                // Animated phase flows toward the compressed bow, without jets.
                float pulse = .48+.52*pow(.5+.5*cos(t*15.0-phase*3.0+strand*4.0), 4.0);
                alpha = level * support * (.16 + .37*pulse);
                front = smoothstep(-.45,.45,t);
                gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
            }`,
        fragmentShader: /* glsl */`
            varying float alpha, front;
            void main(){gl_FragColor=vec4(mix(vec3(.64,.30,.95),vec3(.28,.92,1.0),front),alpha);}`,
    });
    const mesh = new THREE.LineSegments(geometry, material);
    mesh.name = 'Fictional curvature drive envelope';
    mesh.visible = false;
    mesh.frustumCulled = false;
    return mesh;
}
