import { REL } from "./relTravel.js";

let betaOverride = null;

export function initRelViewOverride(searchParams) {
    const b = searchParams?.get?.("beta");
    if (b == null) return;
    const v = +b;
    if (Number.isFinite(v)) betaOverride = Math.max(0, Math.min(0.999, v));
}

export function relViewState() {
    const beta = betaOverride != null ? betaOverride : REL.beta;
    if (betaOverride != null) {
        return {
            beta,
            gamma: 1 / Math.sqrt(1 - beta * beta),
            boostX: 1,
            boostY: 0,
            boostZ: 0,
            override: true,
        };
    }
    return {
        beta,
        gamma: REL.gamma,
        boostX: REL.boostX,
        boostY: REL.boostY,
        boostZ: REL.boostZ,
        override: false,
    };
}
