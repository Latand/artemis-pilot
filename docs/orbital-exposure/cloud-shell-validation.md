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

## Lower-cost mobile geometry candidate

The 96×64 cloud fix failed the unchanged hosted mobile performance gate. The
next candidate uses a fixed indexed detail18 geodesic belt, clipped at 5° from
each pole and completed with narrow equirectangular caps. A convex hull of
the spherical point set is generated offline; direct clipped-polygon fans
were rejected because their sliver planes can cut inside Earth. Runtime
loads a fixed packed payload and copies/scales its attributes once. No hull,
subdivision or geometry traversal runs during playback.

This candidate has 8,120 triangles and 4,351 UV-indexed vertices. Every face
plane remains at least 0.851763 km above the ideal ground sphere after actual
Float32 payload decoding. Vertices remain at the same physical 6 km altitude.
The desktop cloud, ground, shaders and cloud rotation are unchanged. Periodic
longitude repeat wrapping is retained even when the optional no-mipmap mode
is used. Earth cloud shadows keep their exact existing longitude offset.

Native detail18 and detail19 controls were rejected after individual pole
images revealed Y/zig-zag and bow-tie artifacts. Vertex phase checks alone
missed the shared-edge UV interpolation error. The capped mesh is closed
(two faces per welded edge, Euler characteristic 2), has no ordinary UV seam
or cap-transition jump, and has the same narrow pole-fan UV bound as 96×64.
The one 3° control saved only 72 triangles and had less faithful transition
interpolation, so it was not selected.

The reviewed packed payload has 135,740 bytes, SHA256
`0bde50f5dcaf3441f48dc5fba36d7dfe9a6a3f547315029659e7892bb0e27115`.
Generated JavaScript is about 181 KB raw / 95 KB gzip. One geometry uses 187,952
typed-array bytes on each CPU/GPU copy; the persistent CPU template adds
135,740 bytes. Thus template plus one geometry is 323,692 bytes, excluding
JavaScript/base64 strings and transient decode storage. This is 49,356 bytes
more than the 96×64 geometry alone, while GPU geometry drops 86,384 bytes.
It is not an overall-memory-reduction claim.

`node scripts/generate-earth-cloud-geometry.mjs --check` reproduces the exact
payload from native Three primitives and fixed constants without prior data
or fixture input. Geometry smokes check actual decoded containment, radius,
radial normals, outward winding, welded topology, edge-interior UV continuity,
map/shadow phase, instance ownership, disposal and the unchanged desktop mesh.

Offline production-shader images using the actual 2K sources cover both poles,
cap transitions, seams, paused/active exposure and Earth composites. Actual
packed-decode images show none of the rejected artifacts. Native Mesa timing
improves many mid/far cases against 96×64 but does not uniformly recover the
old 48×32 cost. Fresh Node decode/scale/geometry timing measured 4.72 ms median,
8.54 ms p95; this is not browser/mobile startup acceptance. Final hosted polar
frames, the strict depth/contact matrix, full production sequences and the
unchanged five-trial 1.05 p95/long-task gates remain required.

## Retained hosted failures at a93b1b7

The full desktop/mobile capture reports both fail their required activation
check: a depth-writing Line prevents the guard from enabling. The original
40-frame sequences on each tier are preserved, along with the blocked object
ID and reason. The source fix for empty draws requires a new exact-head run;
the prior numeric checks are not accepted as a cloud-visibility fix.

The isolated WebGL matrix stops at its 78th case (desktop, distance 15, phase 0,
paused): 253 limb pixels differ from the depth-disabled ordering oracle.
The guard repairs 12 baseline pixels without introducing a new difference,
but this still fails the strict zero-difference gate. A bounded failure-only
replay saves the original verdict and images first, then compares enabled
AlwaysDepth and disabled-depth oracles within the original MSAA context, a
larger-near diagnostic and a separate non-MSAA context. Those 12 diagnostic
draws cannot replace a failed result or relax its assertions. No production
near-plane change is proposed.

The same head's desktop paired performance passes. Mobile Earth fails all
five paired trials (median p95 ratio 1.08315 against the unchanged 1.05 limit),
and total long-task blocking fails 56,306 ms against 52,311.65 ms. The mobile
triangle increase is therefore not performance-accepted. Lower-cost geometry
is being investigated separately; all original trials and CPU profiles stay
retained.

## Index-order-only cost follow-up

The capped candidate's isolated hosted run 37137983367 passed Earth median
p95 ratio 1.04385, but failed total long-task blocking 19,369 ms against 18,453.35 ms.
All five trials and the full report remain retained. Its desktop/mobile
cloud-ready capture jobs passed 51 checks each; all 16 PNGs were individually
inspected, with no apparent old stripes or rejected polar creases in those
views. The strict MSAA fixture remains failed and is not waived.

One deterministic offline adjacency/LRU reorder now changes only the order
of existing oriented triangle triples. Positions, normals, UVs, triangle
multiset/winding, topology, counts and decoded storage are byte-identical.
The fixed 32-entry cache model drops 10,444→5,529 misses; that model is not a
measured GPU or frame-time improvement. New payload SHA256:
`1b75dbf30d586d18b740f985607e26c012d3f2d89b44e5b297b2bd0e83a36ef2`.
Generation remains offline; runtime decoding is unchanged. The original
0bde50f5 payload is retained as the comparison control.

Native actual-shader validation found 6,087 byte-identical original/reordered
image pairs (12,174 frames), including signed exposure, pole/cap/limb views,
opaque/translucent foreground probes and 886 identical production guard
states. All 30 paired timing rounds are retained. Timing is mixed: cloud-only
medians often improve 0–6.5%, while full Earth+cloud effects are small and one
full-turn case worsens. The unchanged hosted five-trial p95 and mandatory
long-task gates remain required; no performance pass is inferred here.
