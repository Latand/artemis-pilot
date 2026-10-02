# Mobile thrust blackout investigation

## Observed report

The supplied iPhone screenshot shows the Pilot UI in an in-app Safari sheet,
1 min/s simulation time, a BURN HUD, a spring-returned COAST throttle, a SHIP
HTML label, and no 3D world. It does not expose the browser console or prove
whether its GPU context became unavailable.

## Supported failure path

The shipped Three 0.164.1 WebGLAnimation schedules its next requestAnimationFrame
only after the app callback returns. A thrown callback therefore stops that
loop. The galaxy-volume background and two linear compositors previously fed
raw `gl.getParameter(SCISSOR_BOX)` values into Vector4.fromArray. A lost WebGL
context can return null here and throw while the HTML controls remain usable.

The exact installed scheduler is exercised by smoke-context-recovery.mjs.
verify-mobile-thrust.mjs tests the baseline and candidate in the actual app,
using WEBGL_lose_context to inject a GPU outage while the mobile throttle is
held. That controlled outage is distinct from reproducing an iPhone's original
thermal, memory, or GPU-driver trigger.

## Recovery contract

- Hold simulation updates while the context is unavailable, draining the clock
- Clear held flight inputs, silence the engine, and show a HOLD/recovery status
- Reject null GL query results, including a loss between a check and a query
- Retain animation scheduling through a mid-frame context-loss exception
- Restore projection, visibility, and target bookkeeping with finally cleanup
- Resume on the visible canvas, rebuild galaxy history and cosmetic river data
- Retain existing physical state, the user's paused choice, and quicksave bytes

No renderer is recreated, no page reload is forced, and no save is cleared.
The browser owns context restoration; if it cannot restore the GPU, the flight
remains held with a visible explanation.

## Verification

Local tests:

- node scripts/smoke-context-recovery.mjs
- node scripts/smoke-context-cleanup.mjs
- npm test
- npm run smoke:physics3d
- npm run smoke:xrperf
- node scripts/smoke-ship-model.mjs
- npm run build
- git diff --check

GitHub Actions additionally runs the exact base and candidate through Chromium
with a 430×932 touch/mobile viewport, device DPR3 (application DPR cap retained),
native app animation callbacks and real mobile throttle controls. Recovery and
1,200-frame sustained-thrust suites run independently; the software-rendered
soak has a 60-minute runner budget after the initial 25-minute run reached
600 valid frames without an app error. Coverage and app quality are unchanged.
It captures
before/lost/restored views, then steps 1,200 real application frames at 1/30 s,
checks finite state throughout, and exercises paused/repeated recovery, a
mid-offscreen-render thrown loss, and optional composer rendering.

Screenshots and report.json carry the source SHA. Screenshots require individual
visual inspection. Passing software-renderer CI does not certify a physical
Safari/iPhone GPU; the original device-specific trigger remains unverified.
