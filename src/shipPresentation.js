// Ship dimensions are an intentionally enlarged navigation aid. A close hull
// hands over continuously to a bounded, non-emissive screen-space marker.
export const SHIP_MARKER_PX = 6;
const smooth = (a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
export function shipPresentation(distance, hullScale, fovDegrees, viewportHeight) {
    const height = Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : 1);
    const fov = Math.max(1,Math.min(179,Number.isFinite(fovDegrees) ? fovDegrees : 50));
    const unit = 2*Math.tan(fov*Math.PI/360)/height;
    const d = Math.max(1e-9, Number.isFinite(distance) ? distance : 1e9);
    const projectedHull = Math.max(0,hullScale)*2.44/(d*unit);
    const hullAlpha = smooth(1,4,projectedHull);
    return { hullAlpha, markerAlpha:(1-hullAlpha)*.9, markerScale:SHIP_MARKER_PX*unit, markerPixels:SHIP_MARKER_PX };
}
