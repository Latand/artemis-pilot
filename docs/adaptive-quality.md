# Responsive startup and visual quality

Artemis starts conservatively and adapts visual work to the interval between
**delivered frames**, including delayed GPU work. This is not GPU timer-query
profiling or a claim to isolate CPU/GPU bottlenecks.

## Startup

- The default path does not precompile the whole scene or render beneath the
  welcome screen. Controls are wired before the first animation-loop frame.
- Recognized software renderer strings (Microsoft Basic Render Driver/WARP,
  SwiftShader, llvmpipe/softpipe) start Auto in Minimal. Unknown renderer strings
  start Balanced; an Intel/AMD/Apple name alone does not imply slow hardware.
- Whole-scene warmup is a diagnostic opt-in (`?compile=1` or `?warmcompile=1`)
  on non-mobile hardware. Its asynchronous promise has a 1.2-second deadline,
  including late-rejection handling, and no synchronous compile fallback.
- Startup texture requests have five-second deadlines. Missing/late maps use
  existing material fallbacks rather than leaving initialization pending.
- JavaScript cannot interrupt a synchronously blocked driver call. The default
  skips global compilation to avoid exposing the whole scene to that risk.

## GPU queue backpressure

Live WebGL2 callbacks keep at most one submitted frame in flight. A fence is
placed after all river/world/lens/bloom/cockpit rendering, including cosmic
frames. Later RAF callbacks poll it with a zero timeout and return immediately
while it is busy, leaving browser input and other tasks available. A single
flush dispatches the fence; production never calls finish or readPixels.
The quality controller sees intervals between GPU-ready delivered frames.

A never-signaling fence publishes a one-shot stall notice after four seconds.
It continues holding submission rather than feeding more work into a stuck GPU.
The user can request a graphics-only context restart; restore is requested only
after a real loss event. Five-second restart failure is reported, with an
explicit reload choice warning about unsaved changes. Nothing reloads or retries
automatically, and a successful graphics restart preserves simulation state.

Fences are deleted when complete or reset, dropped after context loss, and
released on pagehide; restoration/pageshow starts cleanly. WebGL1, unsupported
sync APIs or failed/null fences use the existing phase-preserving 30 Hz pacer
without claiming GPU completion; no second completion-relative delay is added. XR retains its own pacing. Explicit deterministic QA frame()
callers remain responsible for serializing their own GPU readbacks. Discarded
fences are accounted separately from completed frames; BFCache preserves a
pending user-requested restart.

The first two hosted attempts retained screenshots of the visible Minimal scene
but screenshot capture later stalled under a live multi-hole software workload.
This motivated actual production backpressure, rather than increasing screenshot
timeouts or claiming the previous code was responsive. Final hosted checks must
validate the new scheduling path.

## Graphics control

The Graphics control works on the welcome screen and in the scene. Auto, High,
Balanced, Low and Minimal are available; the choice is stored separately from
simulation saves. `?quality=high|balanced|low|minimal|auto` overrides the saved
choice on load. Escape closes the control.

Auto starts at Balanced, drops one tier after two slow one-second windows (or
two repeated 250 ms stalls), and requires twelve comfortable windows to recover
one tier. Each change has a 1.5-second settling period. Hidden/welcome/context-loss
frames, resize transients and XR timing are excluded. Mobile and Minimal render
at at most 30 Hz; the controller accounts for this intentional pacing when
considering recovery. Recognized software renderers stay Minimal in Auto;
manual quality remains available without promising smooth performance.

Quality changes adjust framebuffer DPR/pixel budgets, river draw fraction and
compute cadence, volumetric galaxy target resolution, and lens-target MSAA.
Low and Minimal can reduce DPR below 1 even on a device-DPR-1 screen. Default
framebuffer MSAA is off; an explicit High load enables it, and High uses the
existing four-sample lens target on desktop. Explicit `dpr`/`pixelRatio` remains an absolute diagnostic override.

Minimal omits the screen-space lens distortion, bloom and volumetric galaxy
raymarcher. It retains bodies, stars, black-hole optics and gravity-flow sources,
and provides a bounded 12,000-point galaxy fallback at galactic viewing scales.
The fallback is a simplified display, not the full volumetric photometric model.
River allocation starts at 32² software / 64² mobile / 96² desktop; an explicit
High load preserves the former 96² mobile / 124² desktop capacities. Runtime
mode changes reuse the framebuffer and existing allocation without reallocating
or changing source counts; reload with High for its full allocation and MSAA. `np` remains an explicit
allocation override.

No force law, integrator, saved simulation schema, source-selection cap or
physical object count changes. Visual detail and particle sampling can change.
No ring-deformation or ring-depth repair is included.

## Verification

- `npm run smoke:adaptive-quality`: deterministic desktop/mobile slowdown and
  recovery, severe stalls, manual overrides, software classification, DPR=1 and
  pixel budgets, inactive/resize/context grace, never-settling/rejected/late
  compile promises. `smoke-gpu-frame-gate.mjs` also checks one outstanding
  frame, zero-time polling, completion, reset/disposal/context loss, WebGL1 and
  failed-fence fallback, plus the actual live/manual/XR scheduler wrapper.
- `npm run verify:adaptive-quality`: actual app in Chromium/SwiftShader,
  desktop/mobile entry, no GPU submissions under the welcome screen, injected
  non-settling desktop compile, visible scene captures, three placed black holes,
  manual changes without physical-state changes, hidden-document suspension,
  resize and controlled WebGL context restore. The hardware classification is
  injected only for the explicit compile-timeout case. Manual Low three-lens
  frames are serialized through the real frame with the unrelated volumetric
  galaxy disabled to bound the software GPU queue; this is not an FPS result.
  Default entry and Minimal lifecycle continue on the real animation loop.
- Existing full-detail pixel regression URLs explicitly request High. This
  prevents automatic software fallback or elapsed-time adaptation from silently
  changing the fixture under test; it does not alter their optical thresholds.

Local build, `npm test`, scenario playback, river-visual and the new controller
suite passed. The broader local smoke sweep passed 109 suites before final
cleanup; TDE passed after removing an unnecessary UI import from the scene's
Node dependency graph. Existing realism-data, deep-time reverse, deep-clock
virtual-module and catalog DOM failures reproduce on pristine `fd41a0c`.
Historical exact-source disk attestation is not a general-purpose runtime test.

Local Chromium cannot launch in the current executor (`socket(): Operation not
permitted`), including the reviewed escalation. The cloud browser also blocks
localhost, so this environment does not provide local pixel evidence. The
focused hosted workflow records browser reports/screenshots for the exact PR
commit. Do not call browser checks passed until those results exist.

This work is not a measured reproduction on the reported WARP PC, Intel Iris Xe
hardware or a physical phone. Software rendering may remain slow, and a browser
using hardware acceleration can still have other bottlenecks.

The paired ship-motion comparison pins High and compares all render settings,
excluding only frame-time/sample/change/reason diagnostics that necessarily
differ between runs. Complete raw quality snapshots remain in its reports;
48-frame sampling and the 50% + 20 ms completed-frame bound are unchanged.

Navigation's existing volumetric-map fixture requests High explicitly rather than
waiting for maps intentionally omitted by Minimal. River coverage's render-only
resource preparation restores the exact saved native camera pose, including the
unapplied deferred-start pose. Its bitwise field/control invariance assertion,
all 1200 soak frames and resource limits remain unchanged; negative tests now
exercise both initialized and unapplied cameras with dynamic state snapshots.
