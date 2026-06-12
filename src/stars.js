import * as THREE from "three";
import { STARS, K } from "./constants.js";
import { dotTexture } from "./textures.js";
import { scene } from "./scene.js";

// Physical renderings for the named stellar destinations. Until now a star
// was only a point in the cosmic layer: flying 4 ly to Proxima showed a dot.
// Each star gets a photosphere mesh + fresnel shell + distance-scaled glow;
// SGR A* gets an event horizon, an accretion disk, and polar jets.
// Known limit: float32 world coordinates wobble at light-year distances —
// close approaches render, but sub-1000 km precision out there is not exact.

const entries = [];
const hexRgba = (hex, a) => "rgba(" + ((hex >> 16) & 255) + "," + ((hex >> 8) & 255) + "," + (hex & 255) + "," + a + ")";

function fresnelShell(radius, color, power, gain) {
    return new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), new THREE.ShaderMaterial({
        transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
        uniforms: { c: { value: new THREE.Color(color) }, uP: { value: power }, uG: { value: gain } },
        vertexShader: /* glsl */`
            varying float vF; uniform float uP;
            void main(){
                vec3 n = normalize(normalMatrix * normal);
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vF = pow(1.0 + dot(normalize(mv.xyz), n), uP);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            uniform vec3 c; uniform float uG; varying float vF;
            void main(){ gl_FragColor = vec4(c, clamp(vF * uG, 0.0, 1.0)); }`,
    }));
}

function accretionTexture(hex) {
    const cv = document.createElement("canvas");
    cv.width = 512; cv.height = 16;
    const ctx = cv.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 512, 0);
    // inner edge white-hot, cooling outward through the star's tint
    g.addColorStop(0, "rgba(255,255,255,0.95)");
    g.addColorStop(.12, "rgba(255,236,200,0.9)");
    g.addColorStop(.34, hexRgba(hex, .62));
    g.addColorStop(.62, hexRgba(hex, .3));
    g.addColorStop(1, hexRgba(hex, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 16);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function radialRing(rIn, rOut, map) {
    const rg = new THREE.RingGeometry(rIn, rOut, 96, 1);
    const posA = rg.attributes.position, uvA = rg.attributes.uv;
    for (let vi = 0; vi < posA.count; vi++) {
        const r = Math.hypot(posA.getX(vi), posA.getY(vi));
        uvA.setXY(vi, (r - rIn) / (rOut - rIn), .5);
    }
    return new THREE.Mesh(rg, new THREE.MeshBasicMaterial({
        map, transparent: true, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
}

export function buildStars() {
    for (const star of STARS) {
        const g = new THREE.Group();
        let disk = null;
        if (star.bh) {
            const rsU = star.rs * K;
            g.add(new THREE.Mesh(new THREE.SphereGeometry(rsU, 48, 32), new THREE.MeshBasicMaterial({ color: 0x000000 })));
            // thin photon-ring halo hugging the horizon
            g.add(fresnelShell(rsU * 1.06, 0xfff2d8, 5.0, .9));
            disk = radialRing(rsU * 1.9, rsU * 7.5, accretionTexture(0xffb46a));
            disk.rotation.x = -Math.PI / 2 + .3;
            g.add(disk);
            // polar jets: stretched additive sprites
            const jetMap = dotTexture("rgba(190,220,255,0.9)", "rgba(120,160,255,0.25)");
            for (const dir of [1, -1]) {
                const jet = new THREE.Sprite(new THREE.SpriteMaterial({ map: jetMap, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .55 }));
                jet.scale.set(rsU * 1.6, rsU * 14, 1);
                jet.position.y = dir * rsU * 7.5;
                g.add(jet);
            }
        } else {
            const col = new THREE.Color(star.color);
            g.add(new THREE.Mesh(new THREE.SphereGeometry(star.R * K, 48, 32), new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(1.15) })));
            g.add(fresnelShell(star.R * K * 1.3, star.color, 2.2, .5));
        }
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: dotTexture(hexRgba(star.color, 1), hexRgba(star.color, .4)),
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .9,
        }));
        g.add(glow);
        g.position.set(star.x * K, 0, -star.y * K);
        scene.add(g);
        entries.push({ g, glow, disk, star });
    }
}

export function updateStars(camera, dtR) {
    for (const e of entries) {
        const d = camera.position.distanceTo(e.g.position);
        // spark visible at any range; physical size takes over up close
        e.glow.scale.setScalar(e.star.bh
            ? Math.max(e.star.rs * K * 2.2, d * .006)
            : Math.max(e.star.R * K * 5, d * .012));
        if (e.disk) e.disk.rotation.z += dtR * .05;
    }
}
