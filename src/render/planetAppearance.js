import * as THREE from 'three';
import {relUniforms} from '../relView.js';
import {RELATIVISTIC_VIEW_GLSL} from './viewBrightness.js';

export const EARTH_CLOUD_HEIGHT_KM = 6;
export const EARTH_ATMOSPHERE_HEIGHT_KM = 100;
export const EARTH_SCALE_HEIGHT_KM = 8;

// Unit-radius, body-local coordinates keep the thin atmosphere well conditioned
// when its parent is translated to astronomical distances.
const vertex = /* glsl */`
    ${RELATIVISTIC_VIEW_GLSL}
    varying vec2 vUv;
    varying vec3 vLocal;
    void main() {
        vUv = uv;
        vLocal = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float doppler;
        mv.xyz = relApplyView(mv.xyz, 5772.0, doppler);
        gl_Position = projectionMatrix * mv;
    }
`;

export function earthSurfaceMaterial(dayMap, nightMap, cloudMap, radius) {
    return new THREE.ShaderMaterial({
        uniforms: {
            ...relUniforms,
            dayMap: { value: dayMap }, nightMap: { value: nightMap }, cloudMap: { value: cloudMap },
            uHasNight: { value: nightMap ? 1 : 0 }, uHasClouds: { value: cloudMap ? 1 : 0 },
            sunDir: { value: new THREE.Vector3(1, 0, 0) },
            uCamera: { value: new THREE.Vector3() },
            uCloudOffset: { value: 0 }, uRadius: { value: radius },
        },
        vertexShader: vertex,
        fragmentShader: /* glsl */`
            uniform sampler2D dayMap, nightMap, cloudMap;
            uniform float uHasNight, uHasClouds, uCloudOffset, uRadius;
            uniform vec3 sunDir, uCamera;
            varying vec2 vUv;
            varying vec3 vLocal;
            const float PI = 3.14159265359;
            vec2 sphereUv(vec3 p) {
                p = normalize(p);
                return vec2(fract(atan(p.z, -p.x) / (2.0 * PI)), acos(clamp(p.y, -1.0, 1.0)) / PI);
            }
            float cloudAt(vec3 p) {
                vec2 uv = sphereUv(p);
                uv.x = fract(uv.x + uCloudOffset);
                // SphereGeometry's texture v increases from south to north.
                uv.y = 1.0 - uv.y;
                return texture2D(cloudMap, uv).g * uHasClouds;
            }
            void main() {
                vec3 n = normalize(vLocal);
                vec3 v = normalize(uCamera - vLocal / uRadius);
                float nl = dot(n, sunDir), nv = max(dot(n, v), 0.001);
                vec3 albedo = texture2D(dayMap, vUv).rgb;
                // The existing color mosaic supplies an approximate water mask;
                // terrain brightness is never interpreted as elevation.
                float ocean = smoothstep(0.015, 0.10, albedo.b - max(albedo.r, albedo.g));
                float cloudRadius = 1.0 + ${EARTH_CLOUD_HEIGHT_KM / 6371};
                float ray = -nl + sqrt(max(0.0, nl * nl + cloudRadius * cloudRadius - 1.0));
                float shadow = cloudAt(n + sunDir * ray) * smoothstep(0.0, 0.04, nl);
                vec3 transmission = exp(-vec3(0.045, 0.105, 0.24) / max(0.08, nl + 0.08));
                vec3 diffuse = albedo * max(nl, 0.0) * transmission * (1.0 - 0.78 * shadow) * 1.8;
                // GGX microfacet water, Fresnel F0=0.02. Roughness approximates
                // unresolved wind waves; it creates a continuous glint footprint.
                vec3 h = normalize(v + sunDir);
                float nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
                float a2 = 0.0064;
                float denom = nh * nh * (a2 - 1.0) + 1.0;
                float D = a2 / (PI * denom * denom);
                float F = 0.02 + 0.98 * pow(1.0 - vh, 5.0);
                float k = 0.12;
                float gv = nv / (nv * (1.0 - k) + k);
                float gl = max(nl, 0.0) / (max(nl, 0.0) * (1.0 - k) + k);
                float spec = D * F * gv * gl / max(4.0 * nv, 0.01);
                vec3 col = diffuse + transmission * spec * ocean * (1.0 - shadow);
                float night = 1.0 - smoothstep(-0.18, 0.02, nl);
                col += texture2D(nightMap, vUv).rgb * uHasNight * night * 0.35 * (1.0 - 0.85 * cloudAt(n));
                gl_FragColor = vec4(col, 1.0);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }
        `,
    });
}

export function atmosphereMaterial(radiusKm = 6371) {
    const top = 1 + EARTH_ATMOSPHERE_HEIGHT_KM / radiusKm;
    return new THREE.ShaderMaterial({
        uniforms: {
            ...relUniforms,
            sunDir: { value: new THREE.Vector3(1, 0, 0) },
            uCamera: { value: new THREE.Vector3() },
            uRadius: { value: radiusKm * 0.001 },
        },
        transparent: true, depthWrite: false, side: THREE.BackSide,
        vertexShader: vertex,
        fragmentShader: /* glsl */`
            uniform vec3 sunDir, uCamera;
            uniform float uRadius;
            varying vec3 vLocal;
            const float TOP = ${top};
            const float H = ${EARTH_SCALE_HEIGHT_KM / radiusKm};
            const vec3 BETA = vec3(0.0058, 0.0135, 0.0331) * ${radiusKm.toFixed(1)};
            vec2 hitSphere(vec3 o, vec3 d, float radius) {
                float b = dot(o, d), q = b * b - dot(o, o) + radius * radius;
                if (q < 0.0) return vec2(1e6, -1e6);
                return vec2(-b - sqrt(q), -b + sqrt(q));
            }
            void main() {
                vec3 ray = normalize(vLocal / uRadius - uCamera);
                vec2 shell = hitSphere(uCamera, ray, TOP);
                float start = max(0.0, shell.x), end = shell.y;
                vec2 ground = hitSphere(uCamera, ray, 1.0);
                if (ground.x > 0.0) end = min(end, ground.x);
                if (end <= start || length(uCamera) < 1.0) discard;
                float stepSize = (end - start) / 12.0;
                float depth = 0.0;
                vec3 scatter = vec3(0.0);
                float mu = dot(ray, sunDir);
                float phase = 3.0 * (1.0 + mu * mu) / (16.0 * 3.14159265);
                for (int i = 0; i < 12; i++) {
                    vec3 p = uCamera + ray * (start + (float(i) + 0.5) * stepSize);
                    float r = length(p), density = exp(-max(0.0, r - 1.0) / H);
                    float ds = density * stepSize;
                    vec2 shadow = hitSphere(p, sunDir, 1.0);
                    float lit = shadow.x > 0.0 && shadow.y > 0.0 ? 0.0 : 1.0;
                    float cosine = dot(p / r, sunDir);
                    // Bounded Chapman-style slant depth; single scattering only.
                    float lightDepth = density * H / max(0.025, cosine + sqrt(cosine * cosine + 2.0 * H)) * 2.0;
                    vec3 transmittance = exp(-BETA * (depth + ds * 0.5 + lightDepth));
                    scatter += transmittance * ds * lit;
                    depth += ds;
                }
                vec3 transmittance = exp(-BETA * depth);
                float alpha = clamp(1.0 - dot(transmittance, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
                // Normal-alpha compositing also attenuates the surface below.
                vec3 radiance = scatter * BETA * phase * 8.0;
                gl_FragColor = vec4(radiance / max(alpha, 0.001), alpha);
                #include <tonemapping_fragment>
                #include <colorspace_fragment>
            }
        `,
    });
}

export function photosphereMaterial(color, map = null) {
    const material = new THREE.MeshBasicMaterial({ color, map });
    material.onBeforeCompile = shader => {
        shader.vertexShader = 'varying vec3 vSurface; varying vec3 vNormalView; varying vec3 vPositionView;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurface = normalize(position); vNormalView = normalize(normalMatrix * normal); vPositionView = (modelViewMatrix * vec4(position, 1.0)).xyz;');
        shader.fragmentShader = /* glsl */`
            varying vec3 vSurface, vNormalView, vPositionView;
            float grain(vec3 p) {
                return sin(p.x) * sin(p.y * 1.13) * sin(p.z * 0.91);
            }
        ` + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', /* glsl */`
            #include <color_fragment>
            float mu = clamp(dot(normalize(vNormalView), normalize(-vPositionView)), 0.0, 1.0);
            float limb = 0.4 + 0.6 * mu;
            vec3 p = normalize(vSurface) * 1800.0;
            float resolved = 1.0 - smoothstep(0.7, 2.0, length(fwidth(p)));
            float granulation = 1.0 + 0.12 * grain(p) * resolved;
            diffuseColor.rgb *= limb * granulation * 1.4;
        `);
        if (map) shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', /* glsl */`
            #ifdef USE_MAP
                float detail = dot(texture2D(map, vMapUv).rgb, vec3(0.2126, 0.7152, 0.0722));
                diffuseColor.rgb *= mix(0.85, 1.05, detail);
            #endif
        `);
    };
    material.customProgramCacheKey = () => 'photosphere-visible-v1';
    return material;
}

export function ringMaterial(map, radius) {
    const material = new THREE.MeshLambertMaterial({map, transparent:true, side:THREE.DoubleSide, depthWrite:false});
    const direction = {value:new THREE.Vector3(1,0,0)};
    material.userData.sunDirection = direction;
    material.onBeforeCompile = shader => {
        shader.uniforms.uRingSun = direction;
        shader.vertexShader = 'varying vec3 vRingPosition;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvRingPosition = position;');
        shader.fragmentShader = 'varying vec3 vRingPosition; uniform vec3 uRingSun;\n' + shader.fragmentShader;
        // A particulate ring also transmits scattered light through its plane.
        // This bounded two-sided approximation keeps the rear face observable;
        // the texture supplies opacity, without claiming calibrated optical depth.
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_lambert_pars_fragment>',
            THREE.ShaderChunk.lights_lambert_pars_fragment.replace(
                'saturate( dot( geometryNormal, directLight.direction ) )',
                '(max(dot(geometryNormal, directLight.direction), 0.0) + 0.55 * max(-dot(geometryNormal, directLight.direction), 0.0))'));
        shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', /* glsl */`
            #include <color_fragment>
            float behind = step(dot(vRingPosition, uRingSun), 0.0);
            float separation = length(cross(vRingPosition, uRingSun));
            float shadow = behind * (1.0 - smoothstep(${(radius * .998).toFixed(6)}, ${(radius * 1.002).toFixed(6)}, separation));
            diffuseColor.rgb *= 1.0 - shadow;
        `);
    };
    material.customProgramCacheKey = () => 'ring-shadow-' + radius;
    return material;
}
