import * as THREE from "three";
import { R_EARTH, R_MOON, A_MOON, SOI_M, SUN_RADIUS, PL, K } from "./constants.js";
import { mulberry32 } from "./format.js";
import {
    dotTexture, earthTextureProc, cloudTextureProc, moonColorProc, moonBumpProc,
    planetTextureProc, ringTextureProc,
} from "./textures.js";
import { scene } from "./scene.js";

export const sunPos = new THREE.Vector3();
export let sunLight, sunCore, sunGlow, sunCorona, sky, galaxyBackdrop;
export let earthG, earth, clouds, moon, moonOrbitRing, moonSoiRing;
export const plGroups = [], plGlows = [], plOrbitRings = [], plLabels = [];

// shared shader uniforms updated once per frame from main.js
export const sunDirW = new THREE.Vector3(1, 0, 0); // world-space Earth→Sun
export const shaderTick = { earthUniforms: null, atmoUniforms: null, coronaUniforms: null, sunUniforms: null };
// updates every sun-direction / camera-distance dependent uniform
export function updateBodyShaders(camera, t) {
    const u = shaderTick;
    if (u.earthUniforms) u.earthUniforms.sunDir.value.copy(sunDirW);
    if (u.atmoUniforms) {
        u.atmoUniforms.sunDir.value.copy(sunDirW);
        const dCam = camera.position.distanceTo(earthG.position);
        const rAtm = R_EARTH * K * 1.07;
        // inside or skimming the shell: fade the additive glow hard so the
        // cabin view at 300 km reads as space + thin horizon, not white-out
        u.atmoUniforms.uFade.value = Math.min(1, Math.max(.05, (dCam / rAtm - 1) * 1.4 + .08));
    }
    if (u.coronaUniforms) u.coronaUniforms.uT.value = t;
    if (u.sunUniforms) u.sunUniforms.uT.value = t;
}

export function buildBodies(maps) {
    // ---- sun ----
    // point light, no decay: every planet gets lit from the Sun's true
    // direction (a directional light aimed at Earth left the outer planets
    // showing their night side to the camera)
    sunLight = new THREE.PointLight(0xfff3e0, 1.85, 0, 0);
    scene.add(sunLight, new THREE.AmbientLight(0x32425c, .72));
    // limb-darkened photosphere with slow granulation shimmer
    const sunUniforms = {
        map: { value: maps.sun },
        uHasMap: { value: maps.sun ? 1 : 0 },
        uT: { value: 0 },
    };
    shaderTick.sunUniforms = sunUniforms;
    const sunMat = new THREE.ShaderMaterial({
        uniforms: sunUniforms,
        vertexShader: /* glsl */`
            varying vec2 vUv; varying vec3 vNv; varying vec3 vPv;
            void main(){
                vUv = uv;
                vNv = normalize(normalMatrix * normal);
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vPv = mv.xyz;
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            uniform sampler2D map; uniform float uHasMap; uniform float uT;
            varying vec2 vUv; varying vec3 vNv; varying vec3 vPv;
            float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            void main(){
                vec3 base = uHasMap > .5 ? texture2D(map, vUv).rgb : vec3(1.0, .76, .42);
                // limb darkening: I(mu)/I(1) ≈ 1 - u(1 - mu), u ~ 0.6 (solar visible band)
                float mu = clamp(dot(normalize(vNv), normalize(-vPv)), 0.0, 1.0);
                float limb = 1.0 - 0.62 * (1.0 - mu);
                float gr = .94 + .12 * h2(floor(vUv * 240.0) + floor(uT * 2.0));
                vec3 col = base * vec3(1.08, 1.0, .88) * limb * gr;
                gl_FragColor = vec4(col, 1.0);
            }`,
    });
    sunCore = new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS, 64, 48), sunMat);
    scene.add(sunCore);
    // animated corona: fresnel rim shell with streamer noise
    const coronaUniforms = { uT: { value: 0 } };
    shaderTick.coronaUniforms = coronaUniforms;
    sunCorona = new THREE.Mesh(new THREE.SphereGeometry(SUN_RADIUS * 1.6, 64, 48), new THREE.ShaderMaterial({
        uniforms: coronaUniforms,
        transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
        vertexShader: /* glsl */`
            varying float vF; varying vec3 vDir;
            void main(){
                vec3 n = normalize(normalMatrix * normal);
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vF = pow(1.0 + dot(normalize(mv.xyz), n), 2.0);
                vDir = normalize(position);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            uniform float uT; varying float vF; varying vec3 vDir;
            void main(){
                // slow smooth streamers drifting around the limb
                float a = atan(vDir.z, vDir.x);
                float s = .62
                    + .2 * sin(a * 7.0 + uT * .12 + vDir.y * 3.0)
                    + .14 * sin(a * 13.0 - uT * .07)
                    + .12 * sin(vDir.y * 11.0 + uT * .09);
                vec3 col = vec3(1.0, .82, .5) * vF * s * .2;
                gl_FragColor = vec4(col, clamp(vF * s * .16, 0.0, 1.0));
            }`,
    }));
    scene.add(sunCorona);
    // soft glow only — no lens flare, it blocked the view ahead
    sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(255,240,180,0.85)", "rgba(255,170,60,0.4)"), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .5 }));
    sunGlow.scale.setScalar(SUN_RADIUS * 10);
    scene.add(sunGlow);
    // ---- stars: three magnitude bands, blackbody-ish colors ----
    // B-V style temperature → RGB, biased toward the real bright-sky mix
    const starColor = (rnd, out) => {
        const t = rnd();
        if (t < .12) { out[0] = .62 + rnd() * .18; out[1] = .72 + rnd() * .16; out[2] = 1; }          // O/B blue
        else if (t < .3) { out[0] = .9 + rnd() * .1; out[1] = .92 + rnd() * .08; out[2] = 1; }        // A white
        else if (t < .62) { out[0] = 1; out[1] = .9 + rnd() * .08; out[2] = .72 + rnd() * .2; }       // F/G yellow-white
        else if (t < .86) { out[0] = 1; out[1] = .74 + rnd() * .12; out[2] = .5 + rnd() * .16; }      // K orange
        else { out[0] = 1; out[1] = .55 + rnd() * .14; out[2] = .38 + rnd() * .12; }                  // M red
        return out;
    };
    const starSprite = dotTexture("rgba(255,255,255,1)", "rgba(200,215,255,0.35)");
    const _sc = [0, 0, 0];
    for (const conf of [[2400, 1.3, .8, null], [780, 2.4, .9, starSprite], [190, 4.2, 1, starSprite]]) {
        const count = conf[0], pos = new Float32Array(count * 3), col = new Float32Array(count * 3), rnd = mulberry32(count * 7 + 13);
        for (let i = 0; i < count; i++) {
            const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1), r = 6.0e6;
            pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
            pos[i * 3 + 1] = r * Math.cos(ph);
            pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
            starColor(rnd, _sc);
            const b = .45 + .55 * Math.pow(rnd(), 1.6); // magnitude spread inside each band
            col[i * 3] = _sc[0] * b; col[i * 3 + 1] = _sc[1] * b; col[i * 3 + 2] = _sc[2] * b;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.BufferAttribute(col, 3));
        scene.add(new THREE.Points(g, new THREE.PointsMaterial({
            vertexColors: true, size: conf[1], sizeAttenuation: false, transparent: true,
            opacity: conf[2], depthWrite: false, map: conf[3], blending: THREE.AdditiveBlending,
        })));
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
    if (!location.search.includes("galaxy=0")) {
        const count = 9000;
        const pos = new Float32Array(count * 3);
        const col = new Float32Array(count * 3);
        const rnd = mulberry32(860612);
        const armPitch = 0.62;
        for (let i = 0; i < count; i++) {
            const arm = Math.floor(rnd() * 4);
            const rr = Math.pow(rnd(), 0.42) * 3.3e6;
            const spin = rr / 3.3e6 * 5.9;
            const th = arm / 4 * Math.PI * 2 + spin + (rnd() - .5) * armPitch;
            const haze = rnd() < .42;
            const r = haze ? rr * (0.55 + rnd() * .55) : rr;
            pos[i * 3] = Math.cos(th) * r;
            pos[i * 3 + 1] = (rnd() - .5) * (haze ? 220000 : 62000);
            pos[i * 3 + 2] = Math.sin(th) * r * .72;
            const warm = Math.max(0, 1 - r / 3.3e6);
            col[i * 3] = .42 + .5 * warm + rnd() * .08;
            col[i * 3 + 1] = .44 + .24 * warm + rnd() * .08;
            col[i * 3 + 2] = .58 + .28 * (1 - warm) + rnd() * .1;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.BufferAttribute(col, 3));
        galaxyBackdrop = new THREE.Points(g, new THREE.PointsMaterial({
            vertexColors: true,
            size: 1.25,
            sizeAttenuation: false,
            // opaque-pass backdrop: transparent:true would defer it to the
            // transparent pass, after the planets, and its depthTest:false
            // dots would paint over them (stars "through" the night side)
            transparent: false,
            opacity: .34,
            depthWrite: false,
            depthTest: false,
            blending: THREE.AdditiveBlending,
        }));
        galaxyBackdrop.rotation.set(.42, -.28, .18);
        galaxyBackdrop.renderOrder = -1; // after the sky dome (-2), before the planets (0)
        galaxyBackdrop.frustumCulled = false;
        scene.add(galaxyBackdrop);
    }
    // ---- earth: day/night terminator, city lights, ocean specular ----
    earthG = new THREE.Group();
    const earthUniforms = {
        dayMap: { value: maps.earth || earthTextureProc() },
        nightMap: { value: maps.earthNight },
        uHasNight: { value: maps.earthNight ? 1 : 0 },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
    };
    shaderTick.earthUniforms = earthUniforms;
    earth = new THREE.Mesh(
        new THREE.SphereGeometry(R_EARTH * K, 96, 72),
        new THREE.ShaderMaterial({
            uniforms: earthUniforms,
            vertexShader: /* glsl */`
                varying vec2 vUv; varying vec3 vNw; varying vec3 vPw;
                void main(){
                    vUv = uv;
                    vNw = normalize(mat3(modelMatrix) * normal);
                    vec4 wp = modelMatrix * vec4(position, 1.0);
                    vPw = wp.xyz;
                    gl_Position = projectionMatrix * viewMatrix * wp;
                }`,
            fragmentShader: /* glsl */`
                uniform sampler2D dayMap; uniform sampler2D nightMap;
                uniform float uHasNight; uniform vec3 sunDir;
                varying vec2 vUv; varying vec3 vNw; varying vec3 vPw;
                void main(){
                    vec3 n = normalize(vNw);
                    vec3 day = texture2D(dayMap, vUv).rgb;
                    float sd = dot(n, sunDir);
                    float dayF = smoothstep(-0.06, 0.22, sd);
                    vec3 v = normalize(cameraPosition - vPw);
                    // ocean: blue-dominant pixels get sun glint
                    float ocean = clamp((day.b - max(day.r, day.g)) * 5.0, 0.0, 1.0);
                    vec3 h = normalize(sunDir + v);
                    float spec = pow(max(dot(n, h), 0.0), 80.0) * ocean;
                    vec3 lit = day * (0.05 + 1.1 * max(sd, 0.0)) + vec3(1.0, .92, .75) * spec * .6 * dayF;
                    // gain kept below the bloom threshold: at close range the
                    // texels are huge and anything brighter blooms into blobs
                    vec3 night = uHasNight > .5
                        ? min(texture2D(nightMap, vUv).rgb * vec3(1.12, .92, .62), vec3(.72))
                        : vec3(0.0);
                    // terminator band warms slightly (sunset ring)
                    float band = smoothstep(0.0, .14, sd) * (1.0 - smoothstep(.14, .42, sd));
                    vec3 col = lit * dayF + night * (1.0 - dayF) + vec3(.55, .26, .08) * band * .16;
                    float rim = pow(1.0 - max(dot(n, v), 0.0), 3.4);
                    col += vec3(.25, .5, 1.0) * rim * .2 * (0.12 + 0.88 * dayF);
                    gl_FragColor = vec4(col, 1.0);
                }`,
        }));
    clouds = new THREE.Mesh(
        new THREE.SphereGeometry(R_EARTH * K * 1.014, 80, 56),
        new THREE.MeshLambertMaterial({ color: 0xffffff, alphaMap: maps.clouds || cloudTextureProc(), transparent: true, opacity: .92, depthWrite: false }));
    const atmoUniforms = {
        c: { value: new THREE.Color(0x4d9fff) },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        uFade: { value: 1 },
    };
    shaderTick.atmoUniforms = atmoUniforms;
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH * K * 1.07, 80, 56), new THREE.ShaderMaterial({
        transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
        uniforms: atmoUniforms,
        vertexShader: /* glsl */`
            varying float vF; varying vec3 vNw;
            void main(){
                vec3 n = normalize(normalMatrix * normal);
                vNw = normalize(mat3(modelMatrix) * normal);
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vF = pow(1.0 + dot(normalize(mv.xyz), n), 2.6);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            uniform vec3 c; uniform vec3 sunDir; uniform float uFade;
            varying float vF; varying vec3 vNw;
            void main(){
                // glow follows the lit hemisphere; night limb stays a faint trace
                float lit = clamp(dot(normalize(vNw), sunDir) * .9 + .42, 0.04, 1.0);
                gl_FragColor = vec4(c, vF * 0.5 * lit * uFade);
            }`,
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
