import * as THREE from "three";
import { REL } from "./relState.js";

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
