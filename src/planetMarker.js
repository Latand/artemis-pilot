import * as THREE from 'three';

// A navigation guide, not an enlarged physical body. Its size is in CSS pixels,
// so DPR, camera distance and mobile rendering quality cannot make it disappear.
export const PLANET_MARKER_DIAMETER_PX = 10;
export function planetMarkerOpacity(radiusPx, guideFade = 1) {
    const t = Math.max(0, Math.min(1, (radiusPx - 1.5) / 3.5));
    return .95 * (1 - t * t * (3 - 2 * t)) * Math.max(0, Math.min(1, guideFade));
}
export function planetMarkerScale(depth, pxScale) {
    return PLANET_MARKER_DIAMETER_PX * Math.max(0, depth) / Math.max(1, pxScale);
}
let markerTexture;
export function makePlanetMarker(color) {
    if (!markerTexture) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
        // Crisp 2.8 px coloured core, quiet feathered halo. Shared by all planets.
        gradient.addColorStop(0, 'rgba(255,255,255,1)');
        gradient.addColorStop(.23, 'rgba(255,255,255,1)');
        gradient.addColorStop(.34, 'rgba(255,255,255,.65)');
        gradient.addColorStop(.55, 'rgba(255,255,255,.16)');
        gradient.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 64, 64);
        markerTexture = new THREE.CanvasTexture(canvas);
    }
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({
        map: markerTexture, color, transparent: true, opacity: 0,
        depthWrite: false, depthTest: true, toneMapped: false,
    }));
    marker.name = 'planet.navigationMarker';
    return marker;
}
export function updatePlanetMarker(marker, camera, position, radius, pxScale, guideFade = 1) {
    marker.position.copy(position);
    const e = camera.matrixWorldInverse.elements;
    const depth = -(e[2] * position.x + e[6] * position.y + e[10] * position.z + e[14]);
    const rpx = radius * pxScale / Math.max(radius, depth);
    marker.scale.setScalar(planetMarkerScale(depth, pxScale));
    marker.material.opacity = depth > 0 ? planetMarkerOpacity(rpx, guideFade) : 0;
}
