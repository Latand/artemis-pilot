// Camera-relative (relative-to-eye) rendering origin for the full-scale universe.
//
// Authoritative body/ship state stays float64 in world-frame kilometres
// (Sol-centred equatorial, same frame as constants.js STARS and coords.js).
// float32 GPU attributes lose precision far from the scene origin (~7 digits,
// ULP ~16 km at 1 AU), so every value handed to the GPU is first expressed as
// a small residual relative to a float64 `origin` that is periodically
// rebased onto the camera (`maybeRebase`). Physics never reads this module —
// it only affects what gets uploaded to render buffers.
//
// Scene axis map mirrors the rest of the renderer (coords.js
// galToSceneUnitsInto, main.js worldToScene/body placement):
//   scene (x, y, z) = (km_x·K, km_z·K, −km_y·K)

const DEFAULT_REBASE_THRESHOLD_KM = 1e4;

// Module-level float64 origin, in world-frame km.
let ox = 0, oy = 0, oz = 0;

// Reused output object for getOrigin(). Zero-allocation: callers must treat
// the returned object as read-only and not retain a reference across a
// setOrigin/maybeRebase call, since its fields are overwritten in place. That
// said, setOrigin/maybeRebase also refresh this same object directly, so
// even a retained reference from an earlier getOrigin() call reflects the
// current origin rather than going stale — don't rely on this, but it means
// staleness is no longer a footgun if a caller does hold on to one.
const _origin = { x: 0, y: 0, z: 0 };

export function getOrigin() {
    _origin.x = ox; _origin.y = oy; _origin.z = oz;
    return _origin;
}

export function setOrigin(x, y, z) {
    ox = x; oy = y; oz = z;
    _origin.x = ox; _origin.y = oy; _origin.z = oz;
}

// Rebase the origin onto the camera when it has drifted more than
// thresholdKm away. Returns true only when a rebase happened, so callers
// know to refresh any residual buffers computed against the old origin.
export function maybeRebase(camX, camY, camZ, thresholdKm = DEFAULT_REBASE_THRESHOLD_KM) {
    const dx = camX - ox, dy = camY - oy, dz = camZ - oz;
    if (dx * dx + dy * dy + dz * dz <= thresholdKm * thresholdKm) return false;
    ox = camX; oy = camY; oz = camZ;
    _origin.x = ox; _origin.y = oy; _origin.z = oz;
    return true;
}

// World-frame km → camera-relative scene-unit residual, written into `out`
// (a THREE.Vector3-like object or a 3-element array-like with [0],[1],[2]).
// No allocations; safe to call every frame for every attribute.
//
// Object-shaped detection uses `'x' in out` (plus THREE's own isVector3 flag)
// rather than `out.x !== undefined`, so a fresh `{ x: undefined, y: ..., z: ... }`
// or a bare `{}` about to be filled in is still recognized as object-shaped
// instead of silently falling through to the array-index branch.
export function worldToResidual(x, y, z, out, K) {
    const rx = x - ox, ry = y - oy, rz = z - oz;
    if (out.isVector3 || "x" in out) { out.x = rx * K; out.y = rz * K; out.z = -ry * K; }
    else { out[0] = rx * K; out[1] = rz * K; out[2] = -ry * K; }
    return out;
}

// Same conversion, writing three consecutive floats into a Float32Array (or
// similar) attribute buffer starting at index i (i.e. arr[i..i+2]).
export function worldToResidualArr(x, y, z, arr, i, K) {
    const rx = x - ox, ry = y - oy, rz = z - oz;
    arr[i] = rx * K;
    arr[i + 1] = rz * K;
    arr[i + 2] = -ry * K;
    return arr;
}
