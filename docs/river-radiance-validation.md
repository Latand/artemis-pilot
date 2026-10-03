# Source sampling and displayed radiance

This isolated candidate changes the ink of owned river samples. It preserves
the source field, allocation CDF, particle count and advection. The reference is
the exact PR55 head `09863eedda25eef36d79e9cf88daa4ff3e377875`.

The completed desktop diagnostic on `2c9b5bc` passed 298 guards and its 24 PNGs
were individually reviewed. In that fixed scene the Proxima core had 1,869 → 0
saturated pixels when paused, and 1,941 → 162 at high visual advection, with
10,452 source-owned particles in both revisions. Sun and black-hole flow stayed
visible. These are bounded transient observations, not a guarantee across all
cameras. The inherited high-rate ambient streak glare remains outside this
owner-only correction.

## Pending extension

The new fixtures below are assertions awaiting hosted execution. Local checks
validate the hooks and negative controls; they do not establish browser success.

- Mobile transient: the same six Proxima, off-center Sun and moving 3D hole
  views, 20 frames each, on the actual mobile quality tier at 430×932, DPR 1.
- Desktop and mobile lifecycle: 64 frames each for Proxima and the moving hole,
  on each actual source revision. Physical time is paused at catalog epoch 0.
  Visual advection has predefined paused, positive and negative phases.
- Actual HYG normalization/index loading precedes lifecycle frames. Production
  `refreshActiveStars` publishes the neighborhoods at 8 and 8.1 pc. The fixture
  requires a genuine same-count middle replacement, structural revision
  increase and current retained object references. Proxima/Barnard camera
  changes must also reorder the selected source slots. The actual-data local
  preflight has 261 active stars at both positions and replaces selected HYG
  source 50493 with GL 194B; the browser must independently observe a selected
  HYG identity leaving the source pool.
- Camera eligibility changes must change the allocation CDF. Mobile must
  actually skip a compute draw under its native adaptive policy. The test does
  not replace that policy to make comparisons match.
- At frame 48, `WEBGL_lose_context` causes real native loss and restoration.
  Synchronous polling observes both native and application lifecycle state.
  A frame delivered during loss must not advance the completed-frame count or
  paused clock. The application recovery listener must call `resetRiverContext`;
  its first restored visible frame must perform a fresh compute with respawn 1.

Every healthy delivered frame records the raw float texture SHA-256, actual
indexed draw-range ownership, source positions and colors, all relevant field
and ink uniforms, camera, and the actual compute dt/respawn/cadence. Those inputs
and texture bytes must match the baseline exactly. Only owner display gain and
resulting pixels may differ. Detailed states and mismatches remain in the report.

Candidate-only assertions validate gain snapshots against the CDF and reference
weights after each compute, retain them over skipped draws, and use the actual
drawn count in the denominator. The 128-sample floor applies to expected CDF
allocation; it is not a strict bound on the randomized count of actual owners.
Explicit sparse-budget identity controls and negative state/recovery tests are
kept separate from rendered visibility evidence.

Capture guards require a live, nonblank framebuffer and a finite on-screen
selected source. Coverage and saturation are reported for visual review; the
fixture does not invent a brightness threshold to label a blank halo successful.
The production shader and source files are unchanged by this QA extension.
