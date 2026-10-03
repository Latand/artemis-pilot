import { LY_KM } from '../constants.js';
// Annotation reach is independent of the orbit controller's target distance.
// These limits affect UI guides only, never physical sources or galaxy light.
export const LABEL_REACH_KM = Object.freeze({ local: .2 * LY_KM, stellar: 100000 * LY_KM });
export function observerLabelAllowed(distanceKm, kind = 'local', selected = false) {
    return selected || Number.isFinite(distanceKm) && distanceKm <= (LABEL_REACH_KM[kind] || LABEL_REACH_KM.local);
}
