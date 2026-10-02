# Speed-linked rings and optional speculative river visual

Both exterior annuli rotate about the hull's local +Y axis; the hull, radial
supports and longitudinal spars stay fixed. Panel seams and one asymmetric
copper index plate per rim make the movement readable. Rate rises with the
HUD's Earth-relative speed (an artistic convention, not thrust or an inertial
frame claim), saturates at 1.4 rad/s (13.4 rpm) at 120 km/s, and eases down
when the speed falls. Exact exponential integration keeps constant-speed
motion equal at 30, 60 and 144 fps. Real elapsed time drives the cosmetic
motor, not accelerated simulation time. Pause freezes it; reverse time does
not reverse the motor. A long suspended frame is capped at 0.25 s. Landed or
dead craft settle toward rest.

“Warp visual” is a separate default-off, session-only opt-in in Pilot's
panel and the mobile flight systems menu. A persistent violet label and Help
copy identify it as speculative. It requires the gravity river to be enabled
and the exterior craft to be visible. This is a bounded local deformation of
a fixed set of extra local samples of the river source field so the effect remains visible at craft-inspection scale. Violet
separates these samples from the ordinary gravitational flow. The artistic
bow compression, aft extension and side twist are not a metric solution,
propulsion model or claimed physically realizable warp drive.

Turning it off immediately sets its drawing strength to zero. The ordinary
river draw shader remains unchanged; only the violet local samples deform.
A single CPU sample uses the same prepared source table, softening, dark-energy
blend and rest-frame subtraction. Source field,
GPU particle advection, ship forces, trajectory predictions, time control,
relTravel and observer relView are untouched. The extra samples have one
optional draw call, 792 vertices desktop / 528 mobile, no textures or render
targets. The fixed inner bearing carries the cyan channel; it and the inward-set
spars stay radially clear of the rims for their full 360° sweep. The craft has 13 opaque material batches, seven shared materials,
9,020 triangles and 273,544 bytes of geometry (versus 7 batches, 8,996
triangles and 271,864 bytes before animation). All buffers are created once.
Positions use the river's existing CPU-float64-relative frame before GPU
upload. The effect switches off outside its bounded near-ship range.

## Verification

- `node scripts/smoke-ship-model.mjs`: orientation, silhouette/engine anchors,
  normal directions, ray visibility, deterministic geometry and resource cap
- `node scripts/smoke-ship-motion.mjs`: 30/60/144 fps, acceleration/brake/stop,
  pause, sign/nonfinite/huge inputs, static hull transforms, bounded resources,
  and draw-only shader isolation
- `node scripts/verify-ship-motion.mjs`: actual full-app matched time series
  on desktop/mobile, explicit paused-world speed fixtures, on/off controls,
  shader errors, stable resources, and a separate real unpaused W-thrust
  replay whose physics state must be bit-identical on and off, plus forced GPU
  loss/restore with warp active, retained CPU resource identities, finite
  recovered buffers, and exact paused-flight/rotation-phase preservation
- Timing uses one reused four-byte typed-array `readPixels` on the normal
  production canvas, after rendering, to synchronously complete GPU work.
  Chromium's `finish()` alone only flushes; the older flush-only percentages
  are retained as historical observations and do not establish performance
  acceptance. Submission, flush and readback time are recorded separately;
  live/error-free context, visible-canvas target and executed frame counters
  are checked. The same 48-frame cadence cycle and 50% + 20 ms optional-field
  overhead bound remain in force
- `node scripts/benchmark-mobile-thrust.mjs`: separate serial base/head/head/base
  OFF-path comparison with 48 actual-thrust warmup frames and 48 measured
  frames per run. It verifies exact physical/camera state and records adaptive
  workload differences before interpreting the whole-app ratio
- The full mobile recovery soak retains every one of its 1,200 thrust frames
  and assertions. Its CI wall-clock allowance is 90 minutes; the previous
  60-minute timeout at frame 960 was incomplete, not a full-soak pass
- Existing appearance/cockpit/mode/thrust/save tests and physics, relativity,
  river, prediction regression workflows remain required

Local Chromium cannot launch in the cloud executor's socket sandbox.
Actual-app rendering runs in the repository's GitHub Actions workflow.
