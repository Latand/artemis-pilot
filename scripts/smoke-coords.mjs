// Headless verification of the floating-origin / camera-relative coordinate
// layer (src/universe/coords.js + src/universe/renderOrigin.js):
//   - the dead integer-sector scaffold is gone
//   - worldToResidual/worldToResidualArr match a direct ×K conversion
//     (within float32 ULP) both at the scene origin and 1 AU out
//   - maybeRebase rebases onto the camera past the threshold and the
//     resulting residual of a nearby point matches a direct float64 subtract
//   - the residual axis map agrees with the existing scene mapping
//     (coords.js galToSceneUnitsInto / main.js worldToScene)
//
// Run: node scripts/smoke-coords.mjs   (or: bun scripts/smoke-coords.mjs)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { AU_KM, PC_KM, galToSceneUnitsInto } = await import("../src/universe/coords.js");
const {
    getOrigin, setOrigin, maybeRebase, worldToResidual, worldToResidualArr,
} = await import("../src/universe/renderOrigin.js");

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
    if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "   " + detail : ""}`); }
    else { fail++; console.log(`  FAIL  ${label}${detail ? "   " + detail : ""}`); }
};
const hr = (t) => console.log("\n" + "─".repeat(60) + "\n  " + t + "\n" + "─".repeat(60));

const K = .001; // constants.js K

// ── 1. Dead sector scaffold is gone ───────────────────────────────────────
hr("Sector scaffold removal");
{
    const src = readFileSync(fileURLToPath(new URL("../src/universe/coords.js", import.meta.url)), "utf8");
    ok(!src.includes("SECTOR_KM"), "coords.js no longer contains SECTOR_KM");
    ok(!src.includes("sectorOf"), "coords.js no longer contains sectorOf");
    ok(!src.includes("localOf"), "coords.js no longer contains localOf");
    ok(!src.includes("sectorSep"), "coords.js no longer contains sectorSep");
}

// ── 2. Round-trip at 1 AU, origin at (0,0,0) ──────────────────────────────
hr("worldToResidual round-trip at 1 AU (origin at 0)");
{
    setOrigin(0, 0, 0);
    const x = AU_KM * 0.37, y = -AU_KM * 0.82, z = AU_KM * 0.11;
    const out = new Float32Array(3);
    worldToResidual(x, y, z, out, K);
    const expX = Math.fround(x * K), expY = Math.fround(z * K), expZ = Math.fround(-y * K);
    const ulp = (v) => Math.max(Math.abs(v) * 1.2e-7, 1e-12); // ~1 float32 ULP, floor for zero
    ok(Math.abs(out[0] - expX) <= ulp(expX), "residual.x matches direct ×K", `got ${out[0]} exp ${expX}`);
    ok(Math.abs(out[1] - expY) <= ulp(expY), "residual.y matches direct ×K", `got ${out[1]} exp ${expY}`);
    ok(Math.abs(out[2] - expZ) <= ulp(expZ), "residual.z matches direct ×K", `got ${out[2]} exp ${expZ}`);

    // worldToResidualArr into a shared attribute-style buffer at an offset.
    const arr = new Float32Array(9);
    worldToResidualArr(x, y, z, arr, 3, K);
    ok(arr[3] === out[0] && arr[4] === out[1] && arr[5] === out[2],
        "worldToResidualArr agrees with worldToResidual", `[${arr[3]},${arr[4]},${arr[5]}]`);

    // Vector3-like object form (duck-typed on `.x`). The object form keeps
    // full float64 precision; compare against the float32-rounded array form.
    const vec = { x: 0, y: 0, z: 0 };
    worldToResidual(x, y, z, vec, K);
    ok(Math.fround(vec.x) === out[0] && Math.fround(vec.y) === out[1] && Math.fround(vec.z) === out[2],
        "object-form output matches array-form output (float32-rounded)");
}

// ── 3. Rebase at 1 kpc + residual of a nearby point ───────────────────────
hr("maybeRebase at 1 kpc");
{
    setOrigin(0, 0, 0);
    const kpc = PC_KM * 1000;
    const camX = kpc, camY = kpc * 0.5, camZ = -kpc * 0.25;
    const rebased = maybeRebase(camX, camY, camZ, 1e4);
    ok(rebased === true, "camera 1 kpc from origin triggers a rebase");
    const o = getOrigin();
    ok(o.x === camX && o.y === camY && o.z === camZ, "origin snaps exactly onto the camera");

    // A point 1e6 km from the (now far-from-zero) camera: the residual must
    // match a plain float64 subtraction, not a large-number cancellation.
    const px = camX + 1e6, py = camY - 4e5, pz = camZ + 2.5e5;
    const out = { x: 0, y: 0, z: 0 };
    worldToResidual(px, py, pz, out, K);
    const dx = px - o.x, dy = py - o.y, dz = pz - o.z;
    const direct = { x: dx * K, y: dz * K, z: -dy * K };
    const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
    ok(rel(out.x, direct.x) < 1e-6, "residual.x matches float64 direct subtract", `got ${out.x} exp ${direct.x}`);
    ok(rel(out.y, direct.y) < 1e-6, "residual.y matches float64 direct subtract", `got ${out.y} exp ${direct.y}`);
    ok(rel(out.z, direct.z) < 1e-6, "residual.z matches float64 direct subtract", `got ${out.z} exp ${direct.z}`);
    // Without rebasing, a point at ~1 kpc would produce a residual of
    // ~kpc·K ≈ 3e10 scene units (unusable in float32); rebased onto the
    // camera, the same point collapses to a residual on the order of its
    // ~1e6 km offset from the camera, ×K — many orders of magnitude smaller.
    const rMag = Math.hypot(out.x, out.y, out.z);
    ok(rMag < 2000, "residual near the rebased camera is orders of magnitude smaller than the un-rebased distance", `|r|=${rMag}`);

    // Below threshold: no rebase, origin unchanged.
    const noRebase = maybeRebase(camX + 1, camY, camZ, 1e4);
    ok(noRebase === false, "small camera drift does not trigger a rebase");
    const o2 = getOrigin();
    ok(o2.x === camX && o2.y === camY && o2.z === camZ, "origin unchanged when below threshold");
}

// ── 4. Axis map agrees with the existing scene mapping ────────────────────
hr("Axis map matches galToSceneUnitsInto / main.js worldToScene");
{
    setOrigin(0, 0, 0);
    // A known galactocentric point converted through the existing pipeline.
    const sceneA = [0, 0, 0];
    galToSceneUnitsInto(8100, 15, 30, sceneA, 0, K);

    // Recover the equivalent Sol-centred equatorial km the same way
    // galToSceneUnitsInto internally does, then run it through worldToResidual.
    const { galToEquatorialKm } = await import("../src/universe/coords.js");
    const [ex, ey, ez] = galToEquatorialKm(8100, 15, 30);
    const sceneB = { x: 0, y: 0, z: 0 };
    worldToResidual(ex, ey, ez, sceneB, K);

    const close = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(b), 1) * 1e-6;
    ok(close(sceneA[0], sceneB.x), "scene.x: worldToResidual == galToSceneUnitsInto", `${sceneB.x} vs ${sceneA[0]}`);
    ok(close(sceneA[1], sceneB.y), "scene.y: worldToResidual == galToSceneUnitsInto", `${sceneB.y} vs ${sceneA[1]}`);
    ok(close(sceneA[2], sceneB.z), "scene.z: worldToResidual == galToSceneUnitsInto", `${sceneB.z} vs ${sceneA[2]}`);

    // And the well-known main.js body mapping: scene = (x·K, z·K, -y·K).
    const bx = 12345.678, by = -987.65, bz = 4321.0;
    const bodyScene = { x: bx * K, y: bz * K, z: -by * K };
    const viaResidual = { x: 0, y: 0, z: 0 };
    worldToResidual(bx, by, bz, viaResidual, K);
    ok(close(bodyScene.x, viaResidual.x) && close(bodyScene.y, viaResidual.y) && close(bodyScene.z, viaResidual.z),
        "worldToResidual matches main.js body scene mapping (x·K, z·K, -y·K) at origin 0");
}

setOrigin(0, 0, 0); // leave module state clean

console.log("\n" + "=".repeat(60));
console.log(`  ${pass} PASSED   ${fail} FAILED   (${pass + fail} checks)`);
console.log("=".repeat(60));
process.exit(fail ? 1 : 0);
