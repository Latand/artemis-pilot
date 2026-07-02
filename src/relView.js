import * as THREE from "three";
import { REL } from "./relState.js";
import { RELATIVISTIC_VIEW_GLSL } from "./render/viewBrightness.js";

let _betaOverride = null;

export function initRelViewOverride(searchParams) {
    const b = searchParams?.get?.("beta");
    if (b != null) {
        const v = +b;
        if (isFinite(v)) _betaOverride = Math.max(0, Math.min(0.999, v));
    }
}

export const relUniforms = {
    uBeta: { value: 0 },
    uBoostDirView: { value: new THREE.Vector3(0, 0, -1) },
};

const _boostWorld = new THREE.Vector3();

export function updateRelView(camera) {
    const beta = _betaOverride != null ? _betaOverride : REL.beta;
    relUniforms.uBeta.value = beta;
    if (beta <= 0) return;
    if (_betaOverride != null && !REL.active) {
        relUniforms.uBoostDirView.value.set(0, 0, -1);
        return;
    }
    _boostWorld.set(REL.boostX, REL.boostZ, -REL.boostY).normalize();
    relUniforms.uBoostDirView.value.copy(_boostWorld)
        .transformDirection(camera.matrixWorldInverse)
        .normalize();
}

export function relViewState() {
    return relUniforms;
}

const TERRELL_MATERIAL_TYPES = new Set([
    "MeshStandardMaterial",
    "MeshBasicMaterial",
    "MeshPhongMaterial",
    "MeshLambertMaterial",
]);

// Patch a mesh material so its vertices aberrate in view space at uBeta>0.
// Mesh colors/lighting stay unchanged; J4 only moves apparent surface points.
export function applyTerrellToMaterial(material) {
    if (!material || !TERRELL_MATERIAL_TYPES.has(material.type)) return material;
    material.userData ||= {};
    if (material.userData._terrell) return material;
    material.userData._terrell = true;
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader) => {
        if (prev) prev(shader);
        shader.uniforms.uBeta = relUniforms.uBeta;
        shader.uniforms.uBoostDirView = relUniforms.uBoostDirView;
        shader.vertexShader = shader.vertexShader
            .replace("void main() {", RELATIVISTIC_VIEW_GLSL + "\nvoid main() {")
            .replace(
                "#include <project_vertex>",
                "#include <project_vertex>\n{ float _dD; mvPosition.xyz = relApplyView(mvPosition.xyz, 5772.0, _dD); gl_Position = projectionMatrix * mvPosition; }"
            );
    };
    material.needsUpdate = true;
    return material;
}
