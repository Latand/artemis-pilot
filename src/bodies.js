import * as THREE from "three";
import { R_EARTH, R_MOON, A_MOON, E_MOON, SOI_M, SUN_RADIUS, PL, K, PC_KM } from "./constants.js";
import { earthSurfaceMaterial, atmosphereMaterial, photosphereMaterial, ringMaterial, EARTH_CLOUD_HEIGHT_KM, EARTH_ATMOSPHERE_HEIGHT_KM } from "./render/planetAppearance.js";
import { stellarExposure, meteredSkyExposure, linearStarColor, stellarPointAppearance } from "./render/stellarAppearance.js";
import { MOONS } from "./moons.js";
import { mulberry32 } from "./format.js";
import {
    dotTexture, earthTextureProc,
    planetTextureProc, ringTextureProc, loadEarthNightMap, loadPlanetMap, loadEarthCloudMap, loadMoonMap,
} from "./textures.js";
import { renderQuality, scene, viewportSize } from "./scene.js";
import { initRealSky, realSkyReady, realSkyStatus, updateRealSkyFade } from "./realSky.js";
import { BRIGHTNESS_CURVE, observedMag, sizePxForMag, hdrIntensityForMag, teffToRGB, SUN_TEFF_K } from "./render/viewBrightness.js";
import { applyTerrellToMaterial } from "./relView.js";
import { G } from "./state.js";
import { sunStateAt, AGB_TIP_R_RSUN } from "./universe/sunEvolution.js";

export const sunPos = new THREE.Vector3();
export let sunLight, sunCore, sunGlow, sunCorona, sunPN, sky, skyStars, galaxyBackdrop;
export let earthG, earth, clouds, earthAtmo, moon, moonOrbitRing, moonSoiRing;
export const plGroups = [], plSurfaces = [], plGlows = [], plOrbitRings = [], plLabels = [];
// planetary moons: small textured-free spheres + always-on glow dot + label
export const moonGroups = [], moonSurfaces = [], moonGlows = [], moonLabels = [];
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
    // Default ON since Wave 6: the real HYG naked-eye sky is a core
    // requirement (readable constellations); ?realsky=0 opts out for
    // low-bandwidth sessions.
    return true;
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

// Conic ring in the world (ecliptic J2000) frame, drawn with the same 3-D
// orientation (inclination i, node Om, longitude of perihelion varpi) the
// ephemeris seeds the body with, so the ring passes through the body instead
// of lying flat in the ecliptic. Scene axis map (x, z, -y)·K.
function orbitEllipseGeometry(aKm, e, varpi = 0, segs = seg(720, 240), inc = 0, node = 0) {
    const pos = new Float32Array(segs * 3);
    const p = aKm * (1 - e * e);
    const w = varpi - node;
    const cO = Math.cos(node), sO = Math.sin(node), ci = Math.cos(inc), si = Math.sin(inc);
    for (let i = 0; i < segs; i++) {
        const nu = i / segs * Math.PI * 2;
        const r = p / Math.max(1e-9, 1 + e * Math.cos(nu));
        const u = w + nu;
        const xo = r * Math.cos(u), yo = r * Math.sin(u);
        const x = xo * cO - yo * ci * sO;
        const y = xo * sO + yo * ci * cO;
        const z = yo * si;
        pos[i * 3] = x * K;
        pos[i * 3 + 1] = z * K;
        pos[i * 3 + 2] = -y * K;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
}

// shared shader uniforms updated once per frame from main.js
export const sunDirW = new THREE.Vector3(1, 0, 0); // world-space Earth→Sun
export const shaderTick = { earthUniforms: null, atmoUniforms: null, coronaUniforms: null, pnUniforms: null };
const bodyCamera = new THREE.Vector3();
const inverseRotation = new THREE.Quaternion();
const detailOptions = new URLSearchParams(location.search);
const cloudsEnabled = detailOptions.get("clouds") !== "0";
const moonPhotoEnabled = detailOptions.get("moonmap") !== "0";
let cloudsRequested = false;
let moonRequested = false;
function requestCloudDetails() {
    if (cloudsRequested || !cloudsEnabled) return;
    cloudsRequested = true;
    const load = () => loadEarthCloudMap().then(map => {
        if (!map) return;
        clouds.material.alphaMap = map;
        clouds.material.needsUpdate = true;
        shaderTick.earthUniforms.cloudMap.value = map;
        shaderTick.earthUniforms.uHasClouds.value = 1;
    });
    if (typeof requestIdleCallback === "function") requestIdleCallback(load, {timeout:1200});
    else setTimeout(load, 0);
}

// All clocks below use simulation time. A paused planet and its clouds remain
// registered, including after reversing time or restoring a saved epoch.
export function updateBodyShaders(camera, t) {
    const u = shaderTick;
    const radius = R_EARTH * K;
    inverseRotation.copy(earth.quaternion).invert();
    bodyCamera.copy(camera.position).sub(earthG.position).divideScalar(radius);
    if (u.earthUniforms) {
        u.earthUniforms.sunDir.value.copy(sunDirW).applyQuaternion(inverseRotation);
        u.earthUniforms.uCamera.value.copy(bodyCamera).applyQuaternion(inverseRotation);
        clouds.rotation.y = earth.rotation.y + (t * 2 * Math.PI / (14 * 86400)) % (2 * Math.PI);
        u.earthUniforms.uCloudOffset.value = (earth.rotation.y - clouds.rotation.y) / (2 * Math.PI);
    }
    if (u.atmoUniforms) {
        u.atmoUniforms.sunDir.value.copy(sunDirW);
        u.atmoUniforms.uCamera.value.copy(bodyCamera);
    }
    const pxScale = viewportSize.pxScale;
    const earthPx = radius * pxScale / Math.max(radius, camera.position.distanceTo(earthG.position));
    if (earthG.visible && earthPx > 2) requestCloudDetails();
    clouds.visible = earth.visible && !!clouds.material.alphaMap && earthPx > 1;
    earthAtmo.visible = earth.visible && earthPx > 1;
    let exposure = 1;
    if (earthG.visible) exposure = Math.min(exposure, meteredSkyExposure(camera, earthG.position, radius, sunPos));
    if (sunCore.visible) exposure = Math.min(exposure, meteredSkyExposure(camera, sunPos, SUN_RADIUS * sunCore.scale.x));
    if (moon.visible) {
        exposure = Math.min(exposure, meteredSkyExposure(camera, moon.position, R_MOON * K, sunPos));
        if (!moonRequested && !moon.material.map && R_MOON * K * pxScale / camera.position.distanceTo(moon.position) > 8 && moonPhotoEnabled) {
            moonRequested = true;
            loadMoonMap().then(map => {
                if (!map) return;
                moon.material.map = map; moon.material.color.set(0xffffff); moon.material.needsUpdate = true;
            });
        }
    }
    for (let i = 0; i < PL.length; i++) {
        if (!plGroups[i].visible) continue;
        const p = PL[i], group = plGroups[i];
        const distance = camera.position.distanceTo(group.position);
        const rpx = p.R * K * pxScale / Math.max(p.R * K, distance);
        exposure = Math.min(exposure, meteredSkyExposure(camera, group.position, p.R * K, sunPos));
        if (rpx > 2) requestPlanetTexture(i);
        // A distant marker fades continuously as the physical disk resolves.
        plGlows[i].material.opacity = 0.24 * (1 - THREE.MathUtils.smoothstep(rpx, 1, 4));
        for (const child of group.children) {
            const direction = child.material?.userData.sunDirection;
            if (direction) {
                child.updateWorldMatrix(true, false);
                child.getWorldQuaternion(inverseRotation).invert();
                direction.value.copy(sunPos).sub(group.position).normalize().applyQuaternion(inverseRotation);
            }
        }
    }
    stellarExposure.value = exposure;
    if (u.coronaUniforms) u.coronaUniforms.uT.value = t;
    if (u.pnUniforms) u.pnUniforms.uT.value = t;
}

// The Sun's own Teff (5772 K) run through the same blackbody LUT every other
// star's color comes from — WP16 a2: from outside, the Sun IS an ordinary
// star, so it must share every part of the model, color included.
const SUN_TEFF_COLOR = teffToRGB(SUN_TEFF_K);
const _sunTintScratch = [1, 1, 1];
const _sunEvoTint = new THREE.Vector3(1, 1, 1);
const _sunAppearance = {};

// Physical radius, temperature and luminosity still come from sunStateAt.
// The display maps unresolved flux to a finite PSF and resolves the actual
// photosphere without superimposing an unbounded additive glow on its center.
export function updateSunView(camera, camDistPc) {
    const sun = sunStateAt(G.t);
    const d = Math.max(camDistPc, 1e-9);
    const mag = observedMag(sun.L_Lsun, d);
    const sizePx = sizePxForMag(mag, BRIGHTNESS_CURVE);
    const hdr = hdrIntensityForMag(mag, BRIGHTNESS_CURVE);
    const pxScale = viewportSize.pxScale;
    const distScene = d * PC_KM * K;
    const pointWorldScale = sizePx * distScene / Math.max(1e-6, pxScale);
    const sunRadiusScene = SUN_RADIUS * sun.R_Rsun; // evolving photosphere radius, scene units
    const radiusPx = sunRadiusScene * pxScale / Math.max(sunRadiusScene, distScene);
    const appearance = stellarPointAppearance(hdr, radiusPx, stellarExposure.value, _sunAppearance);
    sunGlow.scale.setScalar(Math.max(sunRadiusScene * 2, pointWorldScale));
    sunGlow.material.opacity = appearance.opacity;
    const teffColor = teffToRGB(sun.Teff, _sunTintScratch);
    linearStarColor(teffColor, sunGlow.material.color).multiplyScalar(appearance.intensity);
    linearStarColor(teffColor, sunCore.material.color);
    sunLight.color.copy(sunCore.material.color);
    sunCore.rotation.y = (G.t * 2 * Math.PI / (25.38 * 86400)) % (2 * Math.PI);
    updateRealSkyFade(d);

    // Both the photosphere radius and corona tint follow the evolving Sun.
    if (sunCore) sunCore.scale.setScalar(sun.R_Rsun);
    _sunEvoTint.set(
        teffColor[0] / Math.max(1e-4, SUN_TEFF_COLOR[0]),
        teffColor[1] / Math.max(1e-4, SUN_TEFF_COLOR[1]),
        teffColor[2] / Math.max(1e-4, SUN_TEFF_COLOR[2]),
    );
    if (sunCorona) sunCorona.scale.setScalar(sun.R_Rsun);
    if (shaderTick.coronaUniforms) {
        shaderTick.coronaUniforms.uTint.value.copy(_sunEvoTint);
        // the WD has no extended chromosphere to speak of; the AGB/PN wind
        // briefly brightens it before the envelope is gone entirely.
        shaderTick.coronaUniforms.uIntensity.value = .002 * (sun.phase === "WD" ? .2 : sun.phase === "AGB" ? 1.6 : 1);
    }

    // Planetary-nebula shell: only rendered during the brief 'PN' phase,
    // expanding independently of the rapidly-shrinking exposed core (so it
    // is scaled off the fixed AGB-tip radius, not sun.R_Rsun).
    if (sunPN) {
        if (sun.phase === "PN") {
            const progress = Number.isFinite(sun.phaseDurationSec) && sun.phaseDurationSec > 0
                ? Math.min(1, Math.max(0, sun.ageIntoPhaseSec / sun.phaseDurationSec)) : 0;
            sunPN.visible = true;
            sunPN.position.copy(sunPos);
            sunPN.scale.setScalar(AGB_TIP_R_RSUN * (1.5 + 25 * progress));
        } else {
            sunPN.visible = false;
        }
    }
}

export function buildBodies(maps) {
    // ---- sun ----
    // point light, no decay: every planet gets lit from the Sun's true
    // direction (a directional light aimed at Earth left the outer planets
    // showing their night side to the camera)
    sunLight = new THREE.PointLight(0xffffff, Math.PI, 0, 0);
    scene.add(sunLight, new THREE.AmbientLight(0xffffff, .004));
    const sunMat = applyTerrellToMaterial(photosphereMaterial(0xffffff, maps.sun));
    sunCore = new THREE.Mesh(sphere(SUN_RADIUS, 96, 72, 48, 32), sunMat);
    scene.add(sunCore);
    // animated corona: fresnel rim shell with streamer noise
    const coronaUniforms = {
        uT: { value: 0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) },  // WP23b: same Teff tint as the photosphere
        uIntensity: { value: 1 },                        // WP23b: dimmed on the WD (no extended chromosphere)
    };
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
            uniform float uT; uniform vec3 uTint; uniform float uIntensity;
            varying float vF; varying vec3 vDir;
            void main(){
                // slow smooth streamers drifting around the limb
                float a = atan(vDir.z, vDir.x);
                float s = .72
                    + .16 * sin(a * 9.0 + uT * .10 + vDir.y * 2.2)
                    + .09 * sin(a * 17.0 - uT * .06)
                    + .08 * sin(vDir.y * 13.0 + uT * .07);
                vec3 col = mix(vec3(1.0, .18, .025), vec3(1.0, .38, .08), vF) * vF * s * .016 * uTint * uIntensity;
                gl_FragColor = vec4(col, clamp(vF * s * .0075, 0.0, .032) * uIntensity);
            }`,
    }));
    scene.add(sunCorona);
    // WP23b: planetary-nebula shell, an expanding translucent gas shroud
    // shown only during the Sun's brief 'PN' phase (envelope ejection right
    // after the AGB tip, before the exposed core cools into a white dwarf).
    // Built once at a nominal unit scale; updateSunView drives its real
    // scale/opacity/color from sunStateAt's phase progress and hides it
    // (scale 0) in every other phase.
    const pnUniforms = { uT: { value: 0 } };
    shaderTick.pnUniforms = pnUniforms;
    sunPN = new THREE.Mesh(sphere(SUN_RADIUS, 64, 40, 32, 20), new THREE.ShaderMaterial({
        uniforms: pnUniforms,
        transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false, depthTest: false,
        vertexShader: /* glsl */`
            varying float vF; varying vec3 vDir;
            void main(){
                vec3 n = normalize(normalMatrix * normal);
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                vF = pow(1.0 + dot(normalize(mv.xyz), n), 2.2);
                vDir = normalize(position);
                gl_Position = projectionMatrix * mv;
            }`,
        fragmentShader: /* glsl */`
            uniform float uT; varying float vF; varying vec3 vDir;
            void main(){
                // wispy teal/magenta shell structure, classic planetary-nebula palette
                float a = atan(vDir.z, vDir.x);
                float wisp = .6 + .4 * sin(a * 6.0 + vDir.y * 4.0 + uT * .04);
                vec3 col = mix(vec3(.15, .95, .85), vec3(.95, .35, .85), wisp * .5 + .5);
                gl_FragColor = vec4(col * vF, vF * .09);
            }`,
    }));
    sunPN.scale.setScalar(0); // hidden until updateSunView enters the 'PN' phase
    sunPN.visible = false;
    scene.add(sunPN);
    // soft glow only — no lens flare, it blocked the view ahead
    // PSF-style soft gaussian dot (no square sprite); the texture itself is
    // neutral white so the Sun's true Teff=5772K hue comes entirely from
    // material.color, set every frame by updateSunView from the same
    // blackbody LUT every other star uses.
    sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTexture("rgba(255,255,255,0.95)", "rgba(255,255,255,0.2)"), transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, opacity: .06 }));
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
    // ---- Earth: linear-light surface, cloud shadows and a thin atmosphere ----
    earthG = new THREE.Group();
    const radius = R_EARTH * K;
    const earthMat = earthSurfaceMaterial(maps.earth || earthTextureProc(), maps.earthNight, maps.clouds, radius);
    shaderTick.earthUniforms = earthMat.uniforms;
    earth = new THREE.Mesh(sphere(radius, 96, 72, 48, 32), earthMat);
    clouds = new THREE.Mesh(
        sphere((R_EARTH + EARTH_CLOUD_HEIGHT_KM) * K, 96, 72, 48, 32),
        applyTerrellToMaterial(new THREE.MeshLambertMaterial({color:0xffffff, alphaMap:maps.clouds, transparent:true, opacity:0.92, depthWrite:false})));
    earthAtmo = new THREE.Mesh(
        sphere((R_EARTH + EARTH_ATMOSPHERE_HEIGHT_KM) * K, 96, 72, 48, 32), atmosphereMaterial(R_EARTH));
    shaderTick.atmoUniforms = earthAtmo.material.uniforms;
    earthAtmo.renderOrder = 2;
    earthG.add(earth, clouds, earthAtmo);
    scene.add(earthG);
    // ---- moon ----
    const moonMap = maps.moon;
    const useMoonBump = !!moonMap && new URLSearchParams(location.search).get("moonbump") === "1";
    moon = new THREE.Mesh(
        sphere(R_MOON * K, 112, 80, 48, 32),
        applyTerrellToMaterial(new THREE.MeshPhongMaterial({ color: moonMap ? 0xffffff : 0xb9bcc2, map: moonMap || null, bumpMap: useMoonBump ? moonMap : null, bumpScale: .045, shininess: 2.2, specular: 0x20242b })));
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
        const materialConfig = { color: maps.planets[i] ? 0xffffff : p.color, roughness: 1, metalness: 0 };
        if (maps.planets[i]) materialConfig.map = maps.planets[i];
        const surface = new THREE.Mesh(sphere(p.R * K, 96, 64, 48, 32), applyTerrellToMaterial(new THREE.MeshStandardMaterial(materialConfig)));
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
            const ring = new THREE.Mesh(rg, ringMaterial(ringMap, p.R * K));
            ring.rotation.x = -Math.PI / 2;
            g.add(ring);
        }
        scene.add(g);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: dotTexture(rgbaFromHex(p.color, .46), rgbaFromHex(p.color, .16)),
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .28,
        }));
        scene.add(glow);
        const og = orbitEllipseGeometry(p.a, p.e, p.varpi, undefined, p.i || 0, p.Om || 0);
        const orbit = new THREE.LineLoop(og, new THREE.LineBasicMaterial({ color: 0x2c3a4a, transparent: true, opacity: .5 }));
        scene.add(orbit);
        const sp = document.createElement("span");
        sp.className = "lbl";
        sp.textContent = p.name;
        rootEl.appendChild(sp);
        plGroups.push(g); plSurfaces.push(surface); plGlows.push(glow); plOrbitRings.push(orbit); plLabels.push(sp);
    }
    // ---- planetary moons ----
    for (let i = 0; i < MOONS.length; i++) {
        const m = MOONS[i];
        const g = new THREE.Group();
        const surface = new THREE.Mesh(
            sphere(Math.max(m.R, 30) * K, 28, 20, 16, 12),
            applyTerrellToMaterial(new THREE.MeshPhongMaterial({ color: m.color, shininess: 3, specular: 0x1a1d22 })));
        g.add(surface);
        scene.add(g);
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
            map: dotTexture(rgbaFromHex(m.color, .95), rgbaFromHex(m.color, .18)),
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .8,
        }));
        scene.add(glow);
        const sp = document.createElement("span");
        sp.className = "lbl moonLbl";
        sp.textContent = m.name;
        rootEl.appendChild(sp);
        moonGroups.push(g); moonSurfaces.push(surface); moonGlows.push(glow); moonLabels.push(sp);
    }
}
