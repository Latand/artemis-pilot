# Recent black-hole motion

Every placed black hole (including a quasar) has a warm, fading trace of its
recent measured path in Explore and Pilot. It does not require selecting the
hole, enabling Gravity, or asking for a prediction. Pulsars keep their existing
presentation. `?trails=0` disables both these traces and the flight trails.

## What the line means

Samples come from the live hole's inertial world coordinates after physics
advances. The display never uses camera motion, a velocity extrapolation, a
predicted future orbit, or an invented stationary tail. A newly placed or truly
stationary object therefore has no line. Extremely slow motion still needs time
to accumulate a visible displacement; radial motion can project to a point.

The adaptive window targets approximately 24 screen pixels of motion, keeping
between 3 and 18 active display seconds. Slow motion gets the longer window.
Samples are retained at subpixel distances, with a bounded 12 Hz age threshold
for slow movement. A 256-point ring bounds each hole's history. Fast movement
uses the shorter window and distance-based sampling. Opacity fades with age and
along the oldest samples. The ribbon is 2.5 CSS pixels wide with a soft edge, so
it stays readable on desktop and phone without changing the physical path.

Pause freezes history and fading. Camera orbit/zoom only reprojects it. Reverse,
epoch changes, reset, quickload, same-time relocations and under-sampled time
jumps clear paths. Removal disposes the matching object. A merger starts a fresh
survivor path instead of joining two histories. Histories are transient and do
not enlarge saves. The local dynamical-timescale guard drops long chords rather
than claiming a resolved close-encounter trajectory.

## Cost and scope

At most six fixed buffers exist: 256 samples and 256 instanced ribbon segments
per hole, with less than 256 KiB of total typed-array storage across all six.
Each visible history adds one draw per render pass. There are no new render
targets, textures, postprocessing passes, integration calls, or force-law changes.
Trails use the unbent hole-optics pass, so lensing cannot split a tail from its
own hole; opaque world depth still determines occlusion. The startup-quality controls,
Time Pulses and force arrows are unchanged.

## Verification

- `npm run smoke:black-hole-trails`: slow, fast/240 Hz, zero, bounded history,
  fade, pause, scale, relocation, reverse, epoch, gap, independent bodies and
  large-world precision.
- `npm run verify:black-hole-trails`: actual app, live physics samples, all three
  selected/unselected holes, pause/camera, save/load, removal, merger, reverse,
  cleanup, direct/composer lens-enabled pass ownership and shader/runtime errors. Captures desktop/mobile app screenshots.
- Existing gravity-inspector tests, `npm test` and production build.

The browser fixture pins High for lens-enabled coverage, checks Low/Minimal
without losing history, and verifies completed GPU readback for each explicit
application frame. It uses a deterministic display clock and omits AT-HYG,
procedural/HYG backgrounds and bloom. It retains production black-hole optics,
trail shaders and integration. Software Chromium verifies behavior and appearance;
it is not evidence of hardware frame rate.
