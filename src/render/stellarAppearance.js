import * as THREE from 'three';

// Shared display exposure for every stellar layer. Physical magnitudes remain
// unchanged. This approximates a camera exposing for a resolved sunlit body.
export const stellarExposure = { value: 1 };

// A finite display cannot distinguish arbitrarily faint point sources. Taper
// the last few magnitudes smoothly before rejecting their rasterization.
// The inverse-square photometry and catalog remain intact upstream.
export const STELLAR_VISIBILITY_GLSL = /* glsl */`
    float stellarDisplayFlux(float flux, float exposure) {
        return flux * smoothstep(0.02, 0.12, flux * exposure);
    }
`;

export function skyExposureForDisc(radius, distance, phaseCosine = 1) {
    const angularRadius = radius / Math.max(radius, distance);
    const litFraction = (1 + Math.max(-1, Math.min(1, phaseCosine))) * 0.5;
    const meteredArea = angularRadius * angularRadius * litFraction;
    return 1 / (1 + 16000 * meteredArea);
}

export function linearStarColor(rgb, target = new THREE.Color()) {
    return target.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace);
}

export function stellarPointMarker(map) {
    const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const point = new THREE.Points(geometry, new THREE.PointsMaterial({
        map, size: 3, sizeAttenuation: false, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    const center = new THREE.Vector3();
    point.frustumCulled = true;
    point.onBeforeRender = (_renderer, _scene, camera) => {
        center.setFromMatrixPosition(point.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
        // Float32 clip coordinates can round a light-year source onto the far
        // plane of the near pass. Fence each depth tier in CPU precision.
        const depth = -center.z;
        geometry.setDrawRange(0, depth >= camera.near && depth <= camera.far ? 1 : 0);
    };
    return point;
}

const offset = new THREE.Vector3();
const screen = new THREE.Vector3();
const light = new THREE.Vector3();
const forward = new THREE.Vector3();

// Meter only the visible portion of a disk, with continuous coverage at the
// viewport edges. Scratch vectors keep this bounded per-body work allocation free.
export function meteredSkyExposure(camera, center, radius, lightPosition = null) {
    offset.copy(center).sub(camera.position);
    const distance = offset.length();
    camera.getWorldDirection(forward);
    if (offset.dot(forward) <= 0) return 1;
    screen.copy(center).project(camera);
    const ry = radius / Math.max(radius, distance) / Math.tan(camera.fov * Math.PI / 360);
    const rx = ry / camera.aspect;
    const edge = Math.max((Math.abs(screen.x) - 1) / rx, (Math.abs(screen.y) - 1) / ry);
    const coverage = 1 - THREE.MathUtils.smoothstep(edge, -1, 1);
    const phase = lightPosition
        ? -offset.dot(light.copy(lightPosition).sub(center).normalize()) / Math.max(radius, distance)
        : 1;
    // Blend in stops: linear area metering recovers almost its entire dynamic
    // range in the final pixel of a disk leaving view.
    return Math.exp(Math.log(skyExposureForDisc(radius, distance, phase)) * coverage);
}

// A finite point-spread function. Flux below the display threshold keeps
// falling with distance; there is no minimum radiance for faint catalog rows.
export const STELLAR_PSF_GLSL = /* glsl */`
    uniform float uStellarExposure;
    float stellarPSF(vec2 coord) {
        vec2 p = coord - 0.5;
        float r2 = dot(p, p);
        return max(0.0, exp(-32.0 * r2) - exp(-8.0));
    }
`;
