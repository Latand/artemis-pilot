# Earth cloud-shell containment

The mobile capture at `28db592` passed 513 numeric checks, but its individual
images still showed dark cloud stripes/speckles. At a frozen epoch, camera and
shutter, `08-earth-cloud-layer-off.png` removes them and
`08-earth-cloud-layer-restored.png` restores them. The retained GitHub artifact
is `11275510896` from run `37121686257`; passing checks alone did not establish
visual acceptance.

The independently rotating mobile cloud mesh previously used 48x32 segments.
Its triangle planes reach 15.286 km inside the ideal Earth sphere even though
its vertices retain the physical six-kilometre cloud altitude. At some relative
rotations those facets intersect the ground mesh. The fix changes **only the
mobile cloud mesh** to 96x64 segments. Ground and atmosphere meshes, shaders,
physical cloud height, clock and cloud spin are unchanged.

`node scripts/smoke-earth-cloud-shell.mjs` evaluates the exact production
geometry expression. It checks every triangle plane across forward, reverse
and boundary rotations, proves containment of the entire ideal Earth sphere,
and verifies the old incursion as a negative regression fixture. The minimum
new cloud-face clearance is 0.668 km on mobile; unchanged desktop 96x72 clears
1.070 km. Vertex radii stay at the physical cloud altitude. Mobile cloud
triangles rise from 2,976 to 12,096; this is a single-mesh change, not a device
quality-tier increase.

## Guarded cloud-only raster precision

The preserved desktop artifact `11275307637` also removes/restores speckles
with the cloud visibility ablation, despite its enclosing geometry. With
near=0.02 scene units and 24-bit depth, one depth step at distance 60 is about
10.7 km. The mesh proof alone does not fix that depth quantization.

An offline production-shader sweep, including four-sample MSAA and solid-cloud
controls, found nominal polygon offset factor 0 / units -2 to be the smallest
tested integer that removed cloud/Earth errors in all 1,008 frames. This is
not a two-depth-code or fixed-world-distance guarantee: that Mesa driver
mapped -2 units to four D24 codes. An unconditional offset introduced genuine
foreground and limb leaks, including 178/1,600 probe pixels only 25 km ahead of
the cloud surface at distance 60. Those negative controls are retained.

The production aid therefore defaults **off**. Before the cloud draw it reuses
Three r164's already-built render lists, with a strict total cap of 256 items.
Existing world-space spheres conservatively bound ordinary opaque/depth-writing
objects, using a Frobenius norm for possible world-matrix shear. Bias is enabled
only when the cloud footprint can be established clear. Any potentially
foreground bound intersecting its angular footprint disables the aid regardless
of physical separation, avoiding driver-dependent depth-distance assumptions.
Ground itself, objects wholly inside the enclosing ground sphere, and objects
proved behind the entire cloud sphere cannot be foreground occluders.

Missing bounds/lists, unsupported expanded primitives or custom draw-time
transforms, shader-displaced geometry, skinned/instanced/batched meshes,
non-spherical ground/cloud transforms and excess list size fail closed. The
callback never recomputes missing geometry bounds or scans the entire scene.
It changes only raster polygon offset; ordinary depth testing, depth writes,
shader programs, physical altitude and simulation time stay unchanged.

Built-in material hooks are not assumed safe just because they are not a
ShaderMaterial. The audited surface/photosphere varying-and-colour hooks,
precise translation wrapper and beta-zero Terrell wrapper register their exact
function identities in a WeakMap. Unknown compiler or draw hooks, including
custom fragment depth, fail closed. Wrapping an unknown previous hook does not
bless it, and later replacement invalidates registration. The guard reuses its
vectors, spheres and result state without hot-path arrays or closures.

An ordinary built-in zero-count draw cannot emit fragments. The guard skips
only an exact zero draw range with trusted material callbacks and the default
object callback; it does not require or recompute bounds for those empty
vertices. Nonempty lines, unknown callbacks and batched/instanced draws still
fail closed. This covers the legacy ship-prediction line, which remains in
Three's draw list when prediction is disabled. Hosted diagnostics record its
exact object identity, source vertex count, material and draw range.

Relativistic projection and any placed-black-hole context also disable the
aid. The latter avoids stale bounds after TDE temporarily stretches a mesh at
draw time and restores its matrix. Creation/removal and mode transitions are
tested. No TDE code or global near plane is changed.

Conservative fallback deliberately preserves ordinary foreground occlusion
even if the pre-existing cloud depth speckles remain during an overlap or
unsupported/deformation context. This is not an exact-contact or universal
artifact-free claim. Final acceptance requires the isolated actual-material
WebGL contact/limb matrix, frozen full-app before/after images, and unchanged
paired p95 and long-task gates. Offline Mesa diagnostics are additional
evidence, not browser or hardware-performance acceptance.

## First-use surface readiness

The bounded worker preserves exact current source sampling until its integral
map is ready. A newly loaded Moon map can therefore show one detailed frame at
high time rate before switching to its prepared averaged surface. This is an
explicit first-use transition, not a seamless-entry claim. Prepared frames
retain stable exposure; pause restores exact detail. No hidden time cap, stale
orientation or blocking image-readback fallback is introduced.

## Retained hosted failures at a93b1b7

The full desktop/mobile capture reports both fail their required activation
check: a depth-writing Line prevents the guard from enabling. The original
40-frame sequences on each tier are preserved, along with the blocked object
ID and reason. The source fix for empty draws requires a new exact-head run;
the prior numeric checks are not accepted as a cloud-visibility fix.

The isolated WebGL matrix stops at its 78th case (desktop, distance15, phase0,
paused): 253 limb pixels differ from the depth-disabled ordering oracle.
The guard repairs12 baseline pixels without introducing a new difference,
but this still fails the strict zero-difference gate. A bounded failure-only
replay saves the original verdict and images first, then compares enabled
AlwaysDepth and disabled-depth oracles within the original MSAA context, a
larger-near diagnostic and a separate non-MSAA context. Those12 diagnostic
draws cannot replace a failed result or relax its assertions. No production
near-plane change is proposed.

The same head's desktop paired performance passes. Mobile Earth fails all
five paired trials (median p95 ratio1.08315 against the unchanged1.05 limit),
and total long-task blocking fails56,306ms against52,311.65ms. The mobile
triangle increase is therefore not performance-accepted. Lower-cost geometry
is being investigated separately; all original trials and CPU profiles stay
retained.
