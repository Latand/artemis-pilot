import * as THREE from 'three';
import { viewportSize } from '../scene.js';
import { holeRoot } from '../holeOptics.js';
import { BlackHolePath, HOLE_PATH_CAPACITY, registerBlackHoleTrail, unregisterBlackHoleTrail } from './blackHolePath.js';

const enabled = new URLSearchParams(location.search).get('trails') !== '0';
let clock = 0, lastWall = NaN, wasPaused = true;
export function tickBlackHoleTrails(paused, now = performance.now() / 1000) {
    if (!paused && !wasPaused && Number.isFinite(lastWall)) clock += Math.max(0, now - lastWall);
    lastWall = now; wasPaused = paused;
}

// One instanced, antialiased 2.5-CSS-pixel ribbon per hole, with a fixed
// allocation. No postprocessing, render target, texture or per-frame buffer allocation.
export function makeBlackHoleTrail() {
    const path = new BlackHolePath(), count = HOLE_PATH_CAPACITY;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0,-1,0, 1,-1,0, 1,1,0, 0,-1,0, 1,1,0, 0,1,0], 3));
    for (const [name, size] of [['segmentStart',3], ['segmentEnd',3], ['segmentFade',2]]) {
        geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(count * size), size).setUsage(THREE.DynamicDrawUsage));
    }
    geometry.instanceCount = 0;
    const material = new THREE.ShaderMaterial({
        uniforms: { viewport: { value: new THREE.Vector2(1,1) } },
        vertexShader: `attribute vec3 segmentStart, segmentEnd; attribute vec2 segmentFade;
            uniform vec2 viewport; varying float vFade, vSide;
            void main() {
                vec4 a = projectionMatrix * modelViewMatrix * vec4(segmentStart, 1.0);
                vec4 b = projectionMatrix * modelViewMatrix * vec4(segmentEnd, 1.0);
                vec4 p = mix(a, b, position.x);
                vec2 delta = (b.xy / max(b.w, 1e-20) - a.xy / max(a.w, 1e-20)) * viewport;
                float len = length(delta);
                vec2 normal = vec2(-delta.y, delta.x) / max(len, 1e-20);
                p.xy += normal * position.y * 2.5 / viewport * p.w;
                gl_Position = p;
                vFade = mix(segmentFade.x, segmentFade.y, position.x);
                if (a.w <= 0.0 || b.w <= 0.0 || len < 0.01) vFade = 0.0;
                vSide = position.y;
            }`,
        fragmentShader: `varying float vFade, vSide;
            void main() { gl_FragColor = vec4(1.0, .72, .42, .72 * vFade * (1.0 - smoothstep(.25, 1.0, abs(vSide))));
                #include <colorspace_fragment>
            }`,
        transparent: true, depthWrite: false, toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'blackHole.recentMotion'; mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 3;
    // A measured-path annotation belongs to the same unbent pass as the
    // hole. Otherwise the depthWrite=false ribbon is mistaken for distant
    // sky by the lens pass and bends away from its own physical endpoint.
    holeRoot.add(mesh);
    const positions = new Float32Array(count * 2 * 3), colors = new Float32Array(count * 2 * 3), fade = new Float32Array(count * 2);
    const origin = [0,0,0];
    const trail = {
        path, mesh,
        update(x, y, z, time, options) {
            path.sample(x, y, z, time, clock, { ...options, enabled: enabled && options.enabled });
            origin[0] = x; origin[1] = y; origin[2] = z;
            mesh.position.set(x,y,z);
            const n = path.write(positions, colors, fade, origin, time, clock) / 2;
            const a = geometry.attributes;
            for (let i = 0; i < n; i++) {
                const j = i * 6, k = i * 3;
                for (let c = 0; c < 3; c++) { a.segmentStart.array[k+c] = positions[j+c]; a.segmentEnd.array[k+c] = positions[j+3+c]; }
                a.segmentFade.array[i*2] = fade[i*2]; a.segmentFade.array[i*2+1] = fade[i*2+1];
            }
            for (const attr of Object.values(a)) if (attr.isInstancedBufferAttribute) {
                attr.clearUpdateRanges(); attr.addUpdateRange(0, n * attr.itemSize); if (n) attr.needsUpdate = true;
            }
            material.uniforms.viewport.value.set(viewportSize.w, viewportSize.h);
            geometry.instanceCount = n; mesh.visible = n > 0;
        },
        clear() { path.clear(); geometry.instanceCount = 0; mesh.visible = false; },
        dispose() { unregisterBlackHoleTrail(trail); holeRoot.remove(mesh); geometry.dispose(); material.dispose(); },
    };
    registerBlackHoleTrail(trail);
    return trail;
}
