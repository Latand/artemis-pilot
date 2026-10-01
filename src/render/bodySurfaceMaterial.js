import * as THREE from 'three';
import { generateBodySurfaceMaps } from './bodySurfaceMaps.js';
import { getBodyAppearance } from './bodyAppearanceProfiles.js';
import { stabilizeBodyMaterial } from './relativeBodyFrame.js';

// A single low-priority queue avoids synthesizing an entire moon system in a
// frame. Only resolved bodies request maps; each live material owns its maps.
const pending = new Map();
let scheduled = false, surfaceWorker = null, workerFailed = false, inFlight = null;
function runNext() {
    scheduled = false;
    if (inFlight) return;
    const entry = pending.entries().next().value;
    if (!entry) return;
    const [material, request] = entry;
    pending.delete(material);
    if (material.userData.surfaceDisposed) { scheduleNext(); return; }
    if (!workerFailed && typeof Worker !== 'undefined') {
        try {
            if (!surfaceWorker) {
                surfaceWorker = new Worker(new URL('./bodySurfaceWorker.js', import.meta.url), { type: 'module' });
                surfaceWorker.onmessage = ({ data }) => {
                    const job = inFlight;
                    inFlight = null;
                    if (job && !job.material.userData.surfaceDisposed)
                        applyBodySurfaceDetail(job.material, job.request.profile, job.request.width, data);
                    scheduleNext();
                };
                surfaceWorker.onerror = () => {
                    workerFailed = true;
                    surfaceWorker?.terminate(); surfaceWorker = null;
                    if (inFlight && !inFlight.material.userData.surfaceDisposed) pending.set(inFlight.material, inFlight.request);
                    inFlight = null;
                    scheduleNext();
                };
            }
            inFlight = { material, request };
            surfaceWorker.postMessage(request);
            return;
        } catch {
            inFlight = null;
            workerFailed = true;
            surfaceWorker?.terminate(); surfaceWorker = null;
        }
    }
    // Bounded compatibility fallback for engines without module workers.
    applyBodySurfaceDetail(material, request.profile, Math.min(request.width, 512));
    scheduleNext();
}
function scheduleNext() {
    if (scheduled || inFlight || !pending.size) return;
    scheduled = true;
    if (typeof requestIdleCallback === 'function') requestIdleCallback(runNext, { timeout: 700 });
    else setTimeout(runNext, 0);
}
function dataTexture(bytes, width, height, srgb, name) {
    const texture = new THREE.DataTexture(bytes, width, height, THREE.RGBAFormat);
    texture.name = name;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    // Generated arrays run north to south like image maps; DataTexture defaults
    // to no flip, whereas THREE's image loader flips the image vertically.
    texture.flipY = true;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.userData.procedural = true;
    texture.needsUpdate = true;
    return texture;
}

function surfaceProvenance(profile, observational) {
    if (!observational && profile?.provenance?.startsWith('Solar System Scope'))
        return 'Deterministic terrain illustration used as fallback; not an observed color map';
    return profile?.provenance || 'Deterministic illustrative surface';
}

export function setBodyColorMap(material, map, observational = true) {
    const old = material.map;
    material.map = map;
    material.color.setHex(0xffffff);
    material.userData.surfacePhotographic = observational;
    material.userData.appearanceProvenance = observational && map?.userData?.provenance
        ? map.userData.provenance : surfaceProvenance(material.userData.bodyAppearance, observational);
    const u = material.userData.surfaceUniforms;
    if (u) u.uSurfacePhoto.value = observational ? 1 : 0;
    material.needsUpdate = true;
    if (old && old !== map && old.userData?.procedural) old.dispose();
}

export function applyBodySurfaceDetail(material, profile = material.userData.bodyAppearance, width = 512, generated = null) {
    if (!profile || material.userData.surfaceDisposed || (material.userData.surfaceDetailWidth || 0) >= width) return;
    const maps = generated || generateBodySurfaceMaps(profile, width);
    if (!material.userData.surfacePhotographic) {
        const map = dataTexture(maps.color, maps.width, maps.height, true, profile.id + ':illustrative-color');
        map.userData.provenance = surfaceProvenance(profile, false);
        setBodyColorMap(material, map, false);
    }
    if (profile.relief > 0) {
        const normal = dataTexture(maps.normal, maps.width, maps.height, false, profile.id + ':illustrative-relief');
        normal.userData.provenance = 'Synthetic normal relief; not observed elevation';
        material.normalMap?.dispose();
        material.normalMap = normal;
        material.normalScale.set(1, 1);
    }
    material.userData.surfaceDetailWidth = width;
    material.needsUpdate = true;
}

export function requestBodySurfaceDetail(material, profile = material?.userData.bodyAppearance, radiusPx = 8, mobile = false) {
    if (!material || !profile || radiusPx < 3 || material.userData.surfaceDisposed) return;
    const width = !mobile && !workerFailed && radiusPx >= 100 ? 1024 : 512;
    if ((material.userData.surfaceDetailWidth || 0) >= width) return;
    if (inFlight?.material === material && inFlight.request.width >= width) return;
    const current = pending.get(material);
    if (!current || current.width < width) pending.set(material, { profile, width });
    scheduleNext();
}

const microDetail = /* glsl */`
    varying vec3 vBodySurface;
    uniform float uSurfacePhoto, uSurfaceTime, uSurfaceGas;
    uniform float uSurfaceMapSaturation;
    uniform vec3 uSurfacePhotoTint;
    float bodyHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
    float bodyNoise(vec3 p) {
        vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(bodyHash(i),bodyHash(i+vec3(1,0,0)),f.x),mix(bodyHash(i+vec3(0,1,0)),bodyHash(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(bodyHash(i+vec3(0,0,1)),bodyHash(i+vec3(1,0,1)),f.x),mix(bodyHash(i+vec3(0,1,1)),bodyHash(i+vec3(1,1,1)),f.x),f.y),f.z);
    }
`;

export function createBodySurfaceMaterial(bodyOrProfile, { map = null, hostLit = false } = {}) {
    const profile = bodyOrProfile?.kind && bodyOrProfile?.provenance ? bodyOrProfile : getBodyAppearance(bodyOrProfile);
    const material = new THREE.MeshStandardMaterial({
        color: map ? 0xffffff : profile.color, map, metalness: 0,
        roughness: profile.roughness, name: profile.name + ' surface',
    });
    const uniforms = {
        uSurfacePhoto: { value: map ? 1 : 0 }, uSurfaceTime: { value: 0 },
        uSurfaceGas: { value: profile.relief === 0 ? 1 : 0 },
        uSurfaceMapSaturation: { value: profile.mapSaturation ?? 1 },
        uSurfacePhotoTint: { value: new THREE.Color(profile.photoTint ?? 0xffffff) },
        uBodyHostDirection: { value: new THREE.Vector3(1, 0, 0) },
        uBodyHostColor: { value: new THREE.Color(1, 1, 1) },
    };
    material.userData.bodyAppearance = profile;
    material.userData.appearanceProvenance = surfaceProvenance(profile, !!map);
    material.userData.reliefProvenance = 'Deterministic synthetic relief; unchanged mean radius and collision surface';
    material.userData.surfaceUniforms = uniforms;
    material.userData.surfacePhotographic = !!map;
    material.addEventListener('dispose', () => {
        material.userData.surfaceDisposed = true;
        pending.delete(material);
        if (material.map?.userData?.procedural) material.map.dispose();
        material.normalMap?.dispose();
    });
    material.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = 'varying vec3 vBodySurface;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvBodySurface = normalize(position);');
        shader.fragmentShader = microDetail + (hostLit ? 'uniform vec3 uBodyHostDirection, uBodyHostColor;\n' : '') + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', /* glsl */`
            #include <color_fragment>
            vec3 bodyP = normalize(vBodySurface);
            vec3 grainP = bodyP * 240.0;
            grainP.x += sin(bodyP.y * 13.0 + uSurfaceTime) * uSurfaceGas * 1.5;
            float grainFootprint = max(length(dFdx(grainP)), length(dFdy(grainP)));
            float grainVisible = 1.0 - smoothstep(0.35, 1.5, grainFootprint);
            float grain = (bodyNoise(grainP) - 0.5) * 0.055 * grainVisible;
            // No painted-in highlights: microtexture modulates albedo only.
            diffuseColor.rgb *= 1.0 + grain;
            if (uSurfacePhoto > 0.5) {
                float luma = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
                diffuseColor.rgb = mix(vec3(luma), diffuseColor.rgb, uSurfaceMapSaturation) * uSurfacePhotoTint;
            }
        `);
        if (hostLit) {
            // A local system must be illuminated by its own host, never by the
            // distant Solar-System PointLight. Display exposure matches the
            // existing resolved-body convention (pi irradiance). This does not
            // touch host luminosity, flux, radius, or the stellar photometry.
            shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', /* glsl */`
                vec3 geometryPosition = -vViewPosition;
                vec3 geometryNormal = normal;
                vec3 geometryViewDir = normalize(vViewPosition);
                vec3 geometryClearcoatNormal = vec3(0.0);
                IncidentLight directLight;
                directLight.color = uBodyHostColor * 3.14159265359;
                directLight.direction = normalize((viewMatrix * vec4(uBodyHostDirection, 0.0)).xyz);
                directLight.visible = true;
                RE_Direct(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
                vec3 irradiance = vec3(0.0), iblIrradiance = vec3(0.0), radiance = vec3(0.0), clearcoatRadiance = vec3(0.0);
            `);
        }
    };
    material.customProgramCacheKey = () => 'body-surface-v1-' + (hostLit ? 'host' : 'solar');
    return stabilizeBodyMaterial(material);
}

export function updateBodySurface(material, time, lightDirection = null, lightColor = null) {
    const u = material?.userData.surfaceUniforms;
    if (!u) return;
    u.uSurfaceTime.value = (time / 86400) % (Math.PI * 2);
    if (lightDirection) u.uBodyHostDirection.value.copy(lightDirection);
    if (lightColor) u.uBodyHostColor.value.copy(lightColor);
}
