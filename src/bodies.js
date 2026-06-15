import * as THREE from "three";
import { R_EARTH, R_MOON, A_MOON, E_MOON, SOI_M, SUN_RADIUS, PL, K } from "./constants.js";
import { mulberry32 } from "./format.js";
import {
    dotTexture, earthTextureProc,
    planetTextureProc, ringTextureProc, loadEarthNightMap, loadPlanetMap,
} from "./textures.js";
import { renderQuality, scene } from "./scene.js";
import { initRealSky, realSkyReady, realSkyStatus } from "./realSky.js";

export const sunPos = new THREE.Vector3();
export let sunLight, sunCore, sunGlow, sunCorona, sky, skyStars, galaxyBackdrop;
export let earthG, earth, clouds, earthAtmo, moon, moonOrbitRing, moonSoiRing;
export const plGroups = [], plSurfaces = [], plGlows = [], plOrbitRings = [], plLabels = [];
let deferredRealSky = false;
let proceduralSkyObjects = [];

function rgbaFromHex(hex, alpha) {
    const c = new THREE.Color(hex);
    return "rgba(" + Math.round(c.r * 255) + "," + Math.round(c.g * 255) + "," + Math.round(c.b * 255) + "," + alpha + ")";
}
const seg = (desktop, mobile) => renderQuality.mobile ? mobile : desktop;
const sphere = (r, desktopW, desktopH, mobileW, mobileH) =>
    new THREE.SphereGeometry(r, seg(desktopW, mobileW), seg(desktopH, mobileH));

function shouldUseRealSky() {
    const flag = new URLSearchParams(location.search).get("realsky");
    if (flag === "1") return true;
    if (flag === "0") return false;
    return false;
}

function shouldLoadRealSkyImmediately() {
    return new URLSearchParams(location.search).get("realsky") === "1";
}

function shouldUseGalaxyBackdrop() {
    return new URLSearchParams(location.search).get("galaxy") === "1";
}

function disposeProceduralSky() {
    for (const obj of proceduralSkyObjects) {
        if (obj.parent) obj.parent.remove(obj);
        obj.geometry?.dispose?.();
        obj.material?.dispose?.();
    }
    proceduralSkyObjects = [];
}

function buildProceduralSky(starSprite, starColor, scratchColor) {
    for (const conf of [[2400, 1.75, .96, null, 1.08], [780, 3.15, 1, starSprite, 1.16], [190, 5.45, 1, starSprite, 1.24]]) {
        const count = conf[0], pos = new Float32Array(count * 3), col = new Float32Array(count * 3), rnd = mulberry32(count * 7 + 13);
        const gain = conf[4];
        for (let i = 0; i < count; i++) {
            const th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1), r = 6.0e6;
            pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
            pos[i * 3 + 1] = r * Math.cos(ph);
            pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
            starColor(rnd, scratchColor);
            const b = (.58 + .50 * Math.pow(rnd(), 1.45)) * gain; // magnitude spread inside each band
            col[i * 3] = Math.min(1.45, scratchColor[0] * b);
            col[i * 3 + 1] = Math.min(1.45, scratchColor[1] * b);
            col[i * 3 + 2] = Math.min(1.45, scratchColor[2] * b);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.BufferAttribute(col, 3));
        const pts = new THREE.Points(g, new THREE.PointsMaterial({
            vertexColors: true, size: conf[1], sizeAttenuation: false, transparent: true,
            opacity: conf[2], depthWrite: false, map: conf[3], blending: THREE.AdditiveBlending,
        }));
        pts.frustumCulled = false;
        pts.renderOrder = -2;
        skyStars.add(pts);
        proceduralSkyObjects.push(pts);
    }
}

export function scheduleDeferredRealSkyLoad(delayMs = 4800) {
    if (!deferredRealSky || !skyStars) return;
    deferredRealSky = false;
    const start = () => {
        initRealSky(skyStars);
        const ready = realSkyReady();
        if (ready?.finally) ready.finally(() => {
            if (realSkyStatus().loaded) disposeProceduralSky();
        });
    };
    const queueIdle = () => {
        if (typeof requestIdleCallback === "function") requestIdleCallback(start, { timeout: 1200 });
        else setTimeout(start, 250);
    };
    if (delayMs > 0) setTimeout(queueIdle, delayMs);
    else queueIdle();
}

export function requestRealSkyLoad(delayMs = 0) {
    if (!skyStars || realSkyStatus().loaded || realSkyReady() || location.search.includes("realsky=0")) return;
    deferredRealSky = true;
    scheduleDeferredRealSkyLoad(delayMs);
}

export function requestPlanetTexture(i) {
    const surface = plSurfaces[i];
    if (!surface || surface.userData.mapRequested) return;
    surface.userData.mapRequested = true;
    loadPlanetMap(i).then(tex => {
        if (!surface.material) return;
        if (!tex) {
            if (!surface.material.map) {
                const p = PL[i];
                tex = planetTextureProc(p.color, p.gas, 1000 + i * 31);
                tex.userData.procedural = true;
            } else return;
        }
        const old = surface.material.map;
        surface.material.map = tex;
        surface.material.color.set(0xffffff);
        surface.material.needsUpdate = true;
        if (old?.userData?.procedural) old.dispose?.();
    }).catch(err => console.warn("planet map:", err?.message || String(err)));
}

let earthNightRequested = false;
export function requestEarthNightTexture(delayMs = 2200) {
    if (earthNightRequested || !shaderTick.earthUniforms || location.search.includes("earthnight=0")) return;
    if (shaderTick.earthUniforms.uHasNight.value > .5) {
        earthNightRequested = true;
        return;
    }
    earthNightRequested = true;
    const start = () => {
        loadEarthNightMap().then(tex => {
            if (!tex || !shaderTick.earthUniforms) return;
            shaderTick.earthUniforms.nightMap.value = tex;
            shaderTick.earthUniforms.uHasNight.value = 1;
        }).catch(err => console.warn("earth night map:", err?.message || String(err)));
    };
    const queueIdle = () => {
        if (typeof requestIdleCallback === "function") requestIdleCallback(start, { timeout: 1600 });
        else setTimeout(start, 250);
    };
    if (delayMs > 0) setTimeout(queueIdle, delayMs);
    else queueIdle();
}

function orbitEllipseGeometry(aKm, e, varpi = 0, segs = seg(720, 240)) {
    const pos = new Float32Array(segs * 3);
    const p = aKm * (1 - e * e);
    for (let i = 0; i < segs; i++) {
        const nu = i / segs * Math.PI * 2;
        const r = p / Math.max(1e-9, 1 + e * Math.cos(nu));
        const th = varpi + nu;
        pos[i * 3] = r * K * Math.cos(th);
        pos[i * 3 + 2] = -r * K * Math.sin(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
}

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
        // cabin view at 300 km reads as space plus a thin horizon.
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
    sunLight = new THREE.PointLight(0xfff0d2, 1.65, 0, 0);
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
            float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float noise(vec2 p){
                vec2 i = floor(p), f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                float a = hash(i), b = hash(i + vec2(1.0, 0.0));
                float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
                return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
            }
            void main(){
                vec3 tex = uHasMap > .5 ? texture2D(map, vUv).rgb : vec3(.95, .72, .42);
                float texLum = dot(tex, vec3(.299, .587, .114));
                float mu = clamp(dot(normalize(vNv), normalize(-vPv)), 0.0, 1.0);
                float limb = 1.0 - 0.64 * (1.0 - mu);
                float gran = noise(vUv * 28.0 + vec2(uT * .012, -uT * .009));
                gran += .55 * noise(vUv * 74.0 + vec2(-uT * .018, uT * .014));
                gran = gran / 1.55;
                float cell = .82 + .18 * smoothstep(.16, .88, gran);
                float plage = smoothstep(.72, 1.0, texLum) * .06;
                float hot = clamp(cell + plage - .78, 0.0, 1.0);
                vec3 core = mix(vec3(1.0, .36, .055), vec3(1.0, .68, .24), hot);
                vec3 rim = vec3(.92, .22, .035);
                vec3 col = mix(rim, core, smoothstep(.06, .94, mu)) * limb;
                float texDetail = clamp((texLum - .45) * 1.75 + .78, .46, 1.18);
                float activeBand = smoothstep(.18, .48, texLum) * (1.0 - smoothstep(.82, .98, texLum));
                vec3 plasma = mix(vec3(.58, .12, .025), vec3(1.0, .62, .16), activeBand);
                col = mix(col * texDetail, plasma * limb, .38);
                col += vec3(1.0, .46, .10) * pow(mu, 3.1) * .025;
                gl_FragColor = vec4(col, 1.0);
            }`,
    });
    sunCore = new THREE.Mesh(sphere(SUN_RADIUS, 96, 72, 48, 32), sunMat);
    scene.add(sunCore);
    // animated corona: fresnel rim shell with streamer noise
    const coronaUniforms = { uT: { value: 0 } };
    shaderTick.coronaUniforms = coronaUniforms;
    sunCorona = new THREE.Mesh(sphere(SUN_RADIUS * 1.28, 96, 64, 48, 32), new THREE.ShaderMaterial({
        uniforms: coronaUniforms,
        transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
        vertexShader: /* glsl */`
            varying float vF; varying vec3 vDir;
            void main(){
                vec3 n = normalize(normalMatrix * normal);
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vF = pow(1.0 + dot(normalize(mv.xyz), n), 3.8);
                vDir = normalize(position);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            uniform float uT; varying float vF; varying vec3 vDir;
            void main(){
                // slow smooth streamers drifting around the limb
                float a = atan(vDir.z, vDir.x);
                float s = .72
                    + .16 * sin(a * 9.0 + uT * .10 + vDir.y * 2.2)
                    + .09 * sin(a * 17.0 - uT * .06)
                    + .08 * sin(vDir.y * 13.0 + uT * .07);
                vec3 col = mix(vec3(1.0, .18, .025), vec3(1.0, .38, .08), vF) * vF * s * .016;
                gl_FragColor = vec4(col, clamp(vF * s * .0075, 0.0, .032));
            }`,
    }));
    scene.add(sunCorona);
    // soft glow only — no lens flare, it blocked the view ahead
    sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(255,196,82,0.75)", "rgba(255,104,24,0.15)"), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, opacity: .06 }));
    sunGlow.scale.setScalar(SUN_RADIUS * 2.2);
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
    const starSprite = dotTexture("rgba(255,255,255,1)", "rgba(200,215,255,0.48)");
    const _sc = [0, 0, 0];
    skyStars = new THREE.Group();
    skyStars.frustumCulled = false;
    scene.add(skyStars);
    const useRealSky = shouldUseRealSky();
    const immediateRealSky = useRealSky && shouldLoadRealSkyImmediately();
    if (!immediateRealSky) buildProceduralSky(starSprite, starColor, _sc);
    if (immediateRealSky) initRealSky(skyStars);
    else if (useRealSky) deferredRealSky = true;
    if (maps.milky && !location.search.includes("sky=0")) {
        // the sky sphere rides with the camera: keeps its geometry identical at
        // any camera position (a 5.85e6-unit sphere at a far-away camera fed
        // degenerate values into the bloom pass and blacked out the frame)
        sky = new THREE.Mesh(
            sphere(4.0e6, 48, 32, 32, 20),
            new THREE.MeshBasicMaterial({ map: maps.milky, side: THREE.BackSide, depthWrite: false, depthTest: false, color: 0x55596a }));
        sky.rotation.z = .5;
        sky.renderOrder = -2;
        sky.frustumCulled = false;
        scene.add(sky);
    }
    if (shouldUseGalaxyBackdrop()) {
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
        sphere(R_EARTH * K, 96, 72, 48, 32),
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
    clouds = maps.clouds
        ? new THREE.Mesh(
            sphere(R_EARTH * K * 1.014, 80, 56, 40, 28),
            new THREE.MeshLambertMaterial({ color: 0xffffff, alphaMap: maps.clouds, transparent: true, opacity: .92, depthWrite: false }))
        : new THREE.Group();
    const atmoUniforms = {
        c: { value: new THREE.Color(0x4d9fff) },
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        uFade: { value: 1 },
    };
    shaderTick.atmoUniforms = atmoUniforms;
    earthAtmo = new THREE.Mesh(sphere(R_EARTH * K * 1.07, 80, 56, 40, 28), new THREE.ShaderMaterial({
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
    earthG.add(earth, clouds, earthAtmo);
    scene.add(earthG);
    // ---- moon ----
    const moonMap = maps.moon;
    const useMoonBump = !!moonMap && new URLSearchParams(location.search).get("moonbump") === "1";
    moon = new THREE.Mesh(
        sphere(R_MOON * K, 112, 80, 48, 32),
        new THREE.MeshPhongMaterial({ color: moonMap ? 0xffffff : 0xb9bcc2, map: moonMap || null, bumpMap: useMoonBump ? moonMap : null, bumpScale: .045, shininess: 2.2, specular: 0x20242b }));
    scene.add(moon);
    // moon orbit ring
    {
        const g = orbitEllipseGeometry(A_MOON, E_MOON, 0, 240);
        moonOrbitRing = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0x2a3442, transparent: true, opacity: .55 }));
        scene.add(moonOrbitRing);
    }
    // SOI ring around the Moon
    {
        const segs = seg(320, 160), pos = new Float32Array(segs * 3);
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
        const materialConfig = { color: p.color, shininess: p.gas ? 8 : 4 };
        if (maps.planets[i]) materialConfig.map = maps.planets[i];
        const surface = new THREE.Mesh(sphere(p.R * K, 48, 32, 32, 20), new THREE.MeshPhongMaterial(materialConfig));
        g.rotation.z = p.visualTilt || 0;
        g.add(surface);
        if (p.ring) {
            const ringMap = maps.ring || ringTextureProc();
            const rg = new THREE.RingGeometry(p.ring[0] * K, p.ring[1] * K, seg(128, 64), 1);
            // remap UVs radially so the ring strip texture reads inner→outer
            const posA = rg.attributes.position, uvA = rg.attributes.uv;
            for (let vi = 0; vi < posA.count; vi++) {
                const r = Math.hypot(posA.getX(vi), posA.getY(vi));
                uvA.setXY(vi, (r - p.ring[0] * K) / ((p.ring[1] - p.ring[0]) * K), .5);
            }
            const ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ map: ringMap, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
            ring.rotation.x = -Math.PI / 2;
            g.add(ring);
        }
        scene.add(g);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: dotTexture(rgbaFromHex(p.color, .46), rgbaFromHex(p.color, .16)),
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .28,
        }));
        scene.add(glow);
        const og = orbitEllipseGeometry(p.a, p.e, p.varpi);
        const orbit = new THREE.LineLoop(og, new THREE.LineBasicMaterial({ color: 0x2c3a4a, transparent: true, opacity: .5 }));
        scene.add(orbit);
        const sp = document.createElement("span");
        sp.className = "lbl";
        sp.textContent = p.name;
        rootEl.appendChild(sp);
        plGroups.push(g); plSurfaces.push(surface); plGlows.push(glow); plOrbitRings.push(orbit); plLabels.push(sp);
    }
}
