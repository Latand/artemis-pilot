# Mobile navigation and graphics stability

Continuation of merged PR #13. Baseline: `5820f8c852bfa68a05d2b09b6d0abf7e4f2080ad`.

## Report and diagnosis

The reported iPhone freeze during scale changes has not been reproduced on a physical iPhone. The current source nevertheless has concrete hazards to address: synchronous per-frame galaxy metering readback; no application-level invalidation of cached render-target contents after WebGL context restoration; resize paths that can apply dimensions and DPR separately; and pointer-event-by-pointer-event pinch/pan handling. The simulation Restart action resets physics, not graphics. Canvas touch-action already prevents ordinary browser-page gestures, and the existing mobile renderer already caps DPR. Repeated pinch-triggered DOM resize and unrestricted native iPhone DPR are therefore not established causes.

## Scope

- One compact top navigation bar and one compact time/pause strip; details, search, settings and system controls are on-demand sheets. Preserve the live controls, not duplicate clocks or physics state.
- Coalesced one-finger camera orbit, symmetric pinch without accidental focus changes, two-finger centroid pan, and a separate optional thumb pad. Pilot steering and spring-return throttle have independent pointer ownership.
- Bounded mobile canvas, moving-volume and refinement budgets; stable resize transactions, non-blocking metering readback and no unbounded queue of frames.
- Cancel held input and pause time on page suspension or graphics loss. Restore cached graphics correctly without resetting the simulation. Provide explicit Safe mode, graphics recovery and local diagnostic export.

## Acceptance

Test portrait/landscape including 320x568 and a DPR-3 430x932 browser viewport. Capture default and expanded interfaces, exercise native multi-contact input where the browser test API supports it, and label injected events separately. Check finite camera state, unchanged ship state in Explore, independent throttle ownership, bounded allocations under repeated zoom/resize, delayed GPU-fence handling, actual context-loss/restoration and Safe-mode persistence. Retain desktop, galaxy, trail and merger regression checks.

Automated WebKit on Linux is not physical iOS Safari. Software-renderer timing is not an iPhone FPS measurement. Final results, image evidence and remaining limitations will be recorded before this PR is made ready for review.
