# Actual-app visual review: c534340

[Motion and parity run](https://github.com/Latand/artemis-pilot/actions/runs/37031571063) · [Before/after appearance run](https://github.com/Latand/artemis-pilot/actions/runs/37031570863)

# Motion pixel review, c534340

Correction after raw-PNG audit: initial image-preview readings suggested missing
control paint. Exact decoded control-region hashes show the controls remain
painted; those readings were incorrect. The per-frame critiques below are
corrected. For example, the mobile left-control crop is identical across all
off frames, and the desktop ON-button crop is identical in frames 03 through 07.
No app hiding behavior or lost screenshot paint is established by this set.

The full-app images use a paused-world, prescribed-speed presentation fixture.
The separate real-W-thrust replay checks actual physics equivalence. All images
below were opened and individually inspected.

## Mobile (11 images)

- 00-stopped-off: Complete centered twin-ring silhouette; low index plates establish the reference orientation. Touch controls and model are intact
- 01-accelerating-off: Plates/seams advance slightly against stationary pylons; no warp field is present. Decoded control pixels match the initial off frame; the early preview-only missing-control reading was incorrect
- 02-cruise-off: Plate rotation is clearly visible at the upper-right edge. Fixed cyan channels, central hull and supports retain their pose
- 03-cruise-on: Violet curves surround the craft more tightly than the rejected candidate. Curves are visibly smoother, with no disconnected segments; the disclaimer slightly overlaps a left touch-control corner and should move
- 04-spin-0: Plates advance into the upper-left sector together. Craft remains readable among the field lines; disclaimer overlap persists
- 04-spin-1: Plates advance along the left midline, while fixed supports remain stable. Smooth curves remain connected; decoded control pixels match the other enabled frames
- 04-spin-2: Plates reach the lower-left sector without support intersection. Local field remains stable and bounded; disclaimer placement still needs correction
- 05-paused: Plates and field shape match the preceding frame. No flicker, missing surfaces or disappearing field; disclaimer again touches the control corner
- 06-braking: Violet curves fade smoothly with the lower rate, leaving the ship clear. Ring plates continue a smaller movement; no abrupt flash
- 07-stopped-on: Field is fully gone at zero rate, with rings/hull intact and enabled-mode disclaimer retained. Disclaimer placement remains the only new mobile UI issue
- 08-warp-off-again: All purple samples and annotation are gone, while plate rotation has resumed. This cleanly shows independent ring motion and warp opt-in

Mobile runtime: 26/26 assertions passed; no shader/console errors. Real thrust
on/off replay was bit-identical. Maximum CPU/GPU field normalized error was
2.748e-7 across 19 fixtures. Geometry/texture/program resources stayed fixed
through repeated toggles. Full-cycle CI-software-renderer mean was
2170 ms off / 2847 ms on (+31.2%, within the retained 50% + 20 ms bound).
Absolute timings from this renderer are not consumer-device FPS estimates.

## Desktop (all 11 images individually inspected)

- 00-stopped-off: Full ship is centered; index plates establish rest orientation. Relocated control is visible below objectives, clear of time/attitude panels
- 01-accelerating-off: Small plate movement is visible against fixed supports; field remains absent. The decoded button pixels match the other OFF-state frames
- 02-cruise-off: Plate reaches upper-right rim; no field is present. The desktop control remains painted, as verified by its decoded pixel region
- 03-cruise-on: Tighter, smoother violet curves are visible; ship remains clear. Control and disclaimer are fully visible and no longer cover telemetry
- 04-spin-0: Both plates advance coherently to upper-left, with supports fixed. Curve extent is local and UI stays readable
- 04-spin-1: Plates advance along left side; curves remain continuous. The control and disclaimer remain painted; the control region matches the other ON frames
- 04-spin-2: Plates reach lower-left without intersecting supports. The decoded control region is unchanged; model and field are complete
- 05-paused: Plate and curve positions match preceding frame; control remains visible. No ship/field flicker or disappearance
- 06-braking: Field dims smoothly and plate motion slows; control/disclaimer remain clear of other panels
- 07-stopped-on: Field reaches zero while ship and enabled-mode disclaimer stay visible. The ON control is present with the same pixels as the other enabled frames
- 08-warp-off-again: No violet residue or disclaimer remains; ring plates have resumed motion. Desktop control is visibly OFF

Desktop runtime: 27/27 assertions passed; no JS/shader errors. Thrust on/off
state was bit-identical; maximum CPU/GPU field error 2.748e-7. Full-cycle CI
software mean was 2846 ms off / 3701 ms on (+30.1%, within the same guard).
Raw-PNG control-region checks agree with successful interaction checks. The
initial contrary readings came from preview inspection and are withdrawn.
Settled-paint captures and explicit DOM-state diagnostics remain useful test
coverage; they are not evidence of a product hiding defect.


# Actual-app ship appearance review, candidate c534340

## Before / desktop (base c1d2087, all 8 images individually inspected)

- three-quarter: Twin-ring silhouette, fixed spars, cyan channel and canopy all read clearly. Lower ring reaches the time dock edge; pre-existing attitude panel overlaps flight-deck controls
- underside: Entire underside is visible against the bright galactic band. Both rings stay coherent; the time panel lies immediately below the lower rim
- side: Edge-on ring thickness and two straight axial spars are clearly visible. Central hull, command deck and nozzle retain a consistent axis; normal river lines cross the view
- rear: Engine aperture is clearly cyan and unburied; both annuli and radial supports are well lit. Lower rim is close to the time dock
- flight-scale: Craft remains recognizable at its small navigation scale, with a clear heading arrow. The ring design is small by design; no disappearing craft
- close-inspection: Close mesh detail remains readable, but the lower part extends behind the time panel. This is the known baseline nearest-zoom UI occlusion
- fitted-close-clean: Both full rings, hull and supports are unobscured; materials and cyan channel are readable without the normal UI. No detached-looking components
- conventional-thrust: Actual flame and exhaust appear behind the aft ring; ship remains centered, with HUD reporting thrust. No black or missing mesh areas

All later batches are reviewed below.

## After / mobile (c534340, all 8 images individually inspected)

- three-quarter: Full ring/hull silhouette fits the portrait viewport, with copper index plate visible. Inward-set spars remain structurally connected and leave a readable rotating outer rim
- underside: Lower hull and fixed pylons remain readable against the bright band; both annuli and the stationary cyan channels stay intact
- side: Narrow ring depth and separated inboard axial spars are clear. Hull/engine remain aligned; no clipped model edges
- rear: Cyan engine aperture remains exposed. White ring faces and four radial supports are clear, with no anomalous dark holes in the mesh
- flight-scale: Small twin-ring silhouette remains visible at the ship label, and the heading guide remains legible. Interior details appropriately disappear at this zoom
- close-inspection: Model is sharply drawn, but the minimum zoom crops its left/right extremities on portrait; this is the known pre-existing adaptive-size limitation, not a new animation defect
- fitted-close-clean: Complete exterior is visible at the fitted clean zoom. Bearing/rotor clearance and inboard spars read coherently; marker plates are visible without dominating
- conventional-thrust: Warm aft flame and particles appear while the craft remains centered and complete. Touch throttle and navigation UI stay usable; no rendering blackout in this short actual-thrust check

## After / desktop (c534340, all 8 images individually inspected)

- three-quarter: Matches the baseline silhouette while showing the new copper index plate and inset fixed spars. Desktop warp button is now plainly visible below objectives; lower ring still meets the pre-existing time-dock edge
- underside: Both rings, bearings and hull underside remain coherent against the bright galactic band. Fixed spars no longer enter the outer rotating rim; control remains clear
- side: Inboard axial spars are clearly separated from the rotating outer ring edge. Pressure hull and engine axis match baseline; no new cropping
- rear: Engine disk remains exposed and cyan, with no buried aperture. Both rings and four radial supports remain readable in solar light; lower time-dock occlusion is unchanged
- flight-scale: Small twin-ring icon remains visible and centered, with heading guide intact. The warp control is readable away from the ship
- close-inspection: Model detail and copper marker are clear; lower ship is still obscured by the existing time panel at minimum zoom, matching baseline behavior
- fitted-close-clean: Whole model is unobscured, with small radial bearing/rim separation and inset spars looking mechanically coherent. No detached mesh or lost surface
- conventional-thrust: Existing warm exhaust sprite and particles sit aft; model remains fully visible and the HUD reports active thrust. Warp stays off, without violet residue

## Before / mobile (base c1d2087, all 8 images individually inspected)

- three-quarter: Complete rings, supports and nose fit the portrait view. Baseline axial spars attach to the outer annuli; no index plate is present
- underside: Underside is readable with bright background and cyan inner channels; both rings stay complete, providing a useful comparison for the inboard supports
- side: Ring spacing/thickness, long center hull and outer axial spars are clear. No model clipping at the normal inspection distance
- rear: Bright rear rim and engine disk are intact, with all radial supports visible. The fixed outer spar attachments provide the baseline for the corrected clearance
- flight-scale: Small but identifiable twin-ring shape remains visible next to SHIP, with heading/velocity guides intact
- close-inspection: Portrait crop cuts off ring and command-deck edges, confirming the same minimum-zoom issue seen after. No new regression is attributed to the animation slice
- fitted-close-clean: Entire craft fits cleanly without UI. Cyan channel, engine housing and fixed outer spars remain legible
- conventional-thrust: Warm aft flame/particles and BURN HUD are present; exterior remains visible. No short-thrust rendering blackout in this baseline capture

## Summary

All 32 appearance PNGs have now been inspected individually. Both before/after
reports pass 20 runtime assertions on each device, including mode/cockpit,
resource reuse, thrust/release and quicksave/load checks, with no console or
shader errors. The bearing/inboard-spar split retains the silhouette and engine
anchor while providing rotor clearance. Nearest-zoom cropping/Time-panel
occlusion and older Pilot panel collisions remain baseline limitations. The
separate motion review records the remaining mobile annotation overlap. The
preview-only missing-control concern was disproved by decoded pixel checks.
