import * as THREE from "three";
import { R_EARTH, R_MOON, A_MOON, SOI_M, SUN_RADIUS, PL, K } from "./constants.js";
import { mulberry32 } from "./format.js";
import {
    dotTexture, earthTextureProc, cloudTextureProc, moonColorProc, moonBumpProc,
    planetTextureProc, ringTextureProc,
} from "./textures.js";
import { scene } from "./scene.js";

export const sunPos = new THREE.Vector3();
export let sunLight, sunCore, sunGlow, sky;
export let earthG, earth, clouds, moon, moonOrbitRing, moonSoiRing;
export const plGroups = [], plGlows = [], plOrbitRings = [], plLabels = [];

export function buildBodies(maps) {
    // ---- sun ----
    // point light, no decay: every planet gets lit from the Sun's true
    // direction (a directional light aimed at Earth left the outer planets
    // showing their night side to the camera)
    sunLight = new THREE.PointLight(0xfff3e0, 1.85, 0, 0);
    scene.add(sunLight, new THREE.AmbientLight(0x32425c, .72));
    const sunMat = maps.sun
        ? new THREE.MeshBasicMaterial({ map: maps.sun, color: 0xffe9b8 })
        : new THREE.MeshBasicMaterial({ color: 0xffd98a });
    sunCore = new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 64, 48), sunMat);
    scene.add(sunCore);
    sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(255,240,180,1)", "rgba(255,170,60,0.65)"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    sunGlow.scale.setScalar(SUN_RADIUS * 18);
    scene.add(sunGlow);
    // ---- stars + milky way ----
    for (const conf of [[1700, 1, .9], [600, 2, .55]]) {
        const count = conf[0], pos = new Float32Array(count * 3), rnd = mulberry32(count);
        for (let i = 0; i < count; i++) {
            const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1), r = 6.0e6;
            pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
            pos[i * 3 + 1] = r * Math.cos(ph);
            pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfd6e4, size: conf[1], sizeAttenuation: false, transparent: true, opacity: conf[2], depthWrite: false })));
    }
    if (maps.milky && !location.search.includes("sky=0")) {
        // the sky sphere rides with the camera: keeps its geometry identical at
        // any camera position (a 5.85e6-unit sphere at a far-away camera fed
        // degenerate values into the bloom pass and blacked out the frame)
        sky = new THREE.Mesh(
            new THREE.SphereGeometry(4.0e6, 48, 32),
            new THREE.MeshBasicMaterial({ map: maps.milky, side: THREE.BackSide, depthWrite: false, depthTest: false, color: 0x55596a }));
        sky.rotation.z = .5;
        sky.renderOrder = -2;
        sky.frustumCulled = false;
        scene.add(sky);
    }
    // ---- earth ----
    earthG = new THREE.Group();
    earth = new THREE.Mesh(
        new THREE.SphereGeometry(R_EARTH * K, 96, 72),
        new THREE.MeshPhongMaterial({ map: maps.earth || earthTextureProc(), shininess: 20, specular: 0x2b4660 }));
    clouds = new THREE.Mesh(
        new THREE.SphereGeometry(R_EARTH * K * 1.014, 80, 56),
        new THREE.MeshLambertMaterial({ color: 0xffffff, alphaMap: maps.clouds || cloudTextureProc(), transparent: true, opacity: .92, depthWrite: false }));
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH * K * 1.07, 80, 56), new THREE.ShaderMaterial({
        transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
        uniforms: { c: { value: new THREE.Color(0x4d9fff) } },
        vertexShader: "varying float vF; void main(){ vec3 n=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vF=pow(1.0+dot(normalize(mv.xyz),n),2.6); gl_Position=projectionMatrix*mv; }",
        fragmentShader: "uniform vec3 c; varying float vF; void main(){ gl_FragColor=vec4(c, vF*0.5); }"
    }));
    earthG.add(earth, clouds, atmo);
    scene.add(earthG);
    // ---- moon ----
    moon = new THREE.Mesh(
        new THREE.SphereGeometry(R_MOON * K, 112, 80),
        new THREE.MeshPhongMaterial({ map: maps.moon || moonColorProc(), bumpMap: moonBumpProc(), bumpScale: .065, shininess: 2.2, specular: 0x20242b }));
    scene.add(moon);
    // moon orbit ring
    {
        const segs = 240, pos = new Float32Array(segs * 3);
        for (let i = 0; i < segs; i++) {
            const a = i / segs * Math.PI * 2;
            pos[i * 3] = A_MOON * K * Math.cos(a);
            pos[i * 3 + 2] = -A_MOON * K * Math.sin(a);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        moonOrbitRing = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x2a3442, transparent: true, opacity: .55 }));
        scene.add(moonOrbitRing);
    }
    // SOI ring around the Moon
    {
        const segs = 320, pos = new Float32Array(segs * 3);
        for (let i = 0; i < segs; i++) {
            const a = i / segs * Math.PI * 2;
            pos[i * 3] = SOI_M * K * Math.cos(a);
            pos[i * 3 + 2] = SOI_M * K * Math.sin(a);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        moonSoiRing = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x8ec9ff, transparent: true, opacity: .15, blending: THREE.AdditiveBlending, depthWrite: false }));
        moonSoiRing.renderOrder = 1;
        scene.add(moonSoiRing);
    }
    // ---- planets ----
    const rootEl = document.getElementById("root");
    for (let i = 0; i < PL.length; i++) {
        const p = PL[i];
        const g = new THREE.Group();
        const map = maps.planets[i] || planetTextureProc(p.color, p.gas, 1000 + i * 31);
        g.add(new THREE.Mesh(new THREE.SphereGeometry(p.R * K, 48, 32), new THREE.MeshPhongMaterial({ map, shininess: p.gas ? 8 : 4 })));
        if (p.ring) {
            const ringMap = maps.ring || ringTextureProc();
            const rg = new THREE.RingGeometry(p.ring[0] * K, p.ring[1] * K, 128, 1);
            // remap UVs radially so the ring strip texture reads inner→outer
            const posA = rg.attributes.position, uvA = rg.attributes.uv;
            for (let vi = 0; vi < posA.count; vi++) {
                const r = Math.hypot(posA.getX(vi), posA.getY(vi));
                uvA.setXY(vi, (r - p.ring[0] * K) / ((p.ring[1] - p.ring[0]) * K), .5);
            }
            const ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ map: ringMap, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
            ring.rotation.x = -Math.PI / 2;
            g.add(ring);
            g.rotation.z = .45;
        }
        scene.add(g);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(220,228,240,.9)", "rgba(140,170,220,.35)"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .75 }));
        scene.add(glow);
        const segs = 720, pos = new Float32Array(segs * 3);
        for (let k = 0; k < segs; k++) {
            const a2 = k / segs * Math.PI * 2;
            pos[k * 3] = p.a * K * Math.cos(a2);
            pos[k * 3 + 2] = -p.a * K * Math.sin(a2);
        }
        const og = new THREE.BufferGeometry();
        og.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        const orbit = new THREE.LineLoop(og, new THREE.LineBasicMaterial({ color: 0x2c3a4a, transparent: true, opacity: .5 }));
        scene.add(orbit);
        const sp = document.createElement("span");
        sp.className = "lbl";
        sp.textContent = p.name;
        rootEl.appendChild(sp);
        plGroups.push(g); plGlows.push(glow); plOrbitRings.push(orbit); plLabels.push(sp);
    }
}
