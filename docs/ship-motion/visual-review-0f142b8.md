# First actual-app pixel review (0f142b8)

Evidence: [desktop/mobile motion run](https://github.com/Latand/artemis-pilot/actions/runs/37025838604).
All 22 PNGs were opened and individually inspected. These are full-app renders
with a paused world and prescribed presentation-speed inputs; the HUD therefore
retains the initial orbital speed and PAUSED label. They test the production
ring/river presentation path independently of world motion. They are not a
recording of physically accelerating from zero to 120 km/s.

The candidate is **not accepted**: its full-app performance gate failed on both
devices before the physics replay stage. Desktop mean was 908 ms off / 3613 ms
on; mobile 755 / 2360 ms, on the CI software renderer. These are regression
measurements, not consumer-device FPS estimates. No shader/console errors were
reported through that point. Buffer/program identities stayed fixed after
initial shader and scene loading.

## Desktop 1280×820

| Frame | Individual critique |
| --- | --- |
| 00-stopped-off | Entire twin-ring craft is centered and readable; copper index plate is low on the forward rim. The new toggle is obscured by the existing attitude panel. |
| 01-accelerating-off | Index plate and seams advance while the fixed pylons/cabin retain their pose. No missing hull surfaces. Toggle remains obscured. |
| 02-cruise-off | Index plate reaches the upper-right face; motion is unambiguous against fixed supports. The river remains unmodified visually while off. |
| 03-cruise-on | Violet samples visibly bend beside the hull and the craft remains intact. Samples spread too broadly toward the UI; curvature has visible corners. The disclaimer overlaps bottom telemetry. |
| 04-spin-0 | Both copper plates advance coherently to the upper-left sector; supports stay fixed. Violet paths remain continuous, with the same broad reach and coarse corners. |
| 04-spin-1 | Plates advance toward the left midline. Hull and canopy remain readable through the field. Existing UI occlusions and disclaimer overlap remain unacceptable. |
| 04-spin-2 | Plates reach the lower-left sector without disappearing into supports. Curves still look polygonal at their strongest bend. |
| 05-paused | Plate positions match the previous frame exactly; the field shape also remains fixed. This visually confirms the presentation pause, separate from the paused-world fixture. |
| 06-braking | Field intensity decreases substantially and plates continue only a smaller movement. The hull stays readable; weak field is deliberately subtle. |
| 07-stopped-on | Violet samples disappear at zero rate while the enabled-mode disclaimer remains. Both rims and fixed supports are intact. Disclaimer still covers telemetry. |
| 08-warp-off-again | No violet residue remains after toggling off; the plates have resumed rotating. Default gravitational display is retained. Hidden desktop toggle still needs relocation. |

## Mobile 430×932

| Frame | Individual critique |
| --- | --- |
| 00-stopped-off | Full craft is centered without viewport clipping; index plate starts low. Existing touch controls are legible. |
| 01-accelerating-off | Small seam/plate advance is visible against the fixed supports. Some touch controls have faded under the app's existing inactivity behavior; the craft is unchanged. |
| 02-cruise-off | Index plate clearly moves to the upper-right sector; fixed inner cyan channel and pylons remain stationary. No field residue appears while off. |
| 03-cruise-on | Violet field is distinct from the ship and the ordinary river palette. Its extent reaches most of the narrow screen; the kinks are too coarse at 16 segments. Disclaimer is readable above the bottom controls. |
| 04-spin-0 | Upper-left plate movement is clear on both rims. Field bends remain connected; broad screen coverage is excessive. |
| 04-spin-1 | Both plates advance down the left side with no static-support intersection. The overall ship silhouette remains readable. |
| 04-spin-2 | Plates reach the lower-left sector; local illumination and cabin remain stable. Polygonal field bends are still visible. |
| 05-paused | Plates and field shape match the previous frame. Pause causes no disappearing craft or field. |
| 06-braking | Purple intensity becomes much fainter as rate drops; the hull remains prominent. No abrupt cutoff or flash. |
| 07-stopped-on | Field reaches zero without hiding the ship. The retained label correctly indicates the mode is enabled, though inactive at rest. |
| 08-warp-off-again | All purple samples and the label disappear immediately. Copper plates move again, proving ring motion is independent of warp opt-in. |

## Corrective changes for the next candidate

- Remove the deformation branch from ordinary river vertices and sample the
  existing display field once for the local layer. Keep the performance gate;
  the precise driver-level cause of the previous penalty is not established.
- Keep production river field, compute/advection and ordinary vertex shader
  byte-identical to the pre-animation baseline. Compare the CPU local sample
  against the production GLSL in a test-only one-pixel floating-point pass.
- Tighten the local effect radius from five to three visible hull scale units,
  and increase line subdivision to 32 segments for smoother curves.
- Move the desktop toggle below the right-side objectives panel; place its
  disclaimer immediately beneath it, clear of bottom telemetry. Add a DOM
  overlap assertion against the attitude, objectives and time panels.
- Run the real-thrust on/off physics replay before reporting a performance
  failure, so a failed budget does not hide independent correctness evidence.
