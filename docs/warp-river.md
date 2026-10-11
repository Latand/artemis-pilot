# Warp sandbox through the gravity river

The optional warp sandbox flies a hypothetical Alcubierre bubble. Its geometry
is drawn only through the shared spacetime river: the same GPU particles and
streak lines that show the pull of the Sun, planets, stars and black holes.
There is no separate sphere, grid, shell or ring layer.

## Model

Natário ([gr-qc/0110086](https://arxiv.org/abs/gr-qc/0110086)) writes every
warp-drive spacetime as

    ds² = −c²dt² + Σ (dxⁱ − Xⁱ dt)²

with one shift field X. Eulerian (normal) observers move at X, and their volume
expansion is θ = ∇·X. The river already draws a field of this form: for one mass
it is the Painlevé–Gullstrand infall X = −√(2GM/r) r̂ (the river model of black
holes). Alcubierre's metric ([gr-qc/0009013](https://arxiv.org/abs/gr-qc/0009013),
eqs. 6 and 8) has X = v_s f(r_s) n̂ with

    f(r) = [tanh(σ(r + R)) − tanh(σ(r − R))] / [2 tanh(σR)]

so the river adds that term to its flow field (`bubbleShift` in `src/river.js`,
mirrored by `bubbleComovingFlow` in `src/warpBubble.js`).

What follows from the model:

* Expansion θ = v_s (x_s/r_s) df/dr_s (eq. 12): contraction ahead, expansion
  behind, zero at the centre and on the equatorial plane.
* A Galilean chart moving with the ship keeps the same metric form with
  X' = X − v_s n̂. In that chart the interior is calm, space streams past, slows
  through the front wall and speeds up behind. θ is unchanged by the chart.
* Eulerian energy density is negative in the wall (eq. 19), so the weak and
  dominant energy conditions fail. Natário shows expansion and contraction are a
  property of Alcubierre's choice of f; zero-expansion warp fields exist.
* The bubble centre moves on a timelike geodesic: the hull rides it in free
  fall, with proper time equal to coordinate time, and its local velocity stays
  separate from the coordinate speed v_s. Nothing pushes the hull; v_s(t) is
  prescribed.
* Alcubierre's shift is parallel to the travel axis everywhere, so in the ship
  chart the streamlines near the hull are straight lines along the axis. The
  lines change direction and bend where the bubble competes with the
  gravitational terms (at low coordinate speed, or near a mass) and when the
  axis turns; at high speed the bubble's signature is the speed profile and
  θ (stream slowing into the front, calm hull region, stream speeding up
  behind).

## Display conventions

These are presentation choices, stated so they are not mistaken for physics:

* The hull is drawn enlarged so it stays readable. Close in, its scale keeps
  one screen size (0.042 × camera distance); it stops growing at the same
  2.4-unit bound as ordinary flight (or at the size that stays readable from
  the float64 precision floor of the camera far from home). Zoomed out to a
  system view it shrinks below a few pixels and hands over to the ship marker.
* R follows the drawn hull (R = 0.45 × camera distance, bounded with the hull),
  so the calm interior always holds the hull. R is a free parameter of the
  metric.
* σR = 1.8: a thick wall, so the field fades over about one radius
  (f(R) ≈ 0.53, f(1.5R) ≈ 0.15, f(2R) ≈ 0.028, f(2.5R) ≈ 0.005).
* Chart by zoom: while the bubble fills the view the river is drawn in the
  ship chart. Once the bounded bubble is small against the view (system
  scale), line directions and colours show the rest-frame field, where the
  natural river shows and the bubble term only acts near the ship; the
  samples still ride with the ship as display markers. Intermediate zooms
  blend the two presentations.
* Near the ship the sampled volume shrinks to 2.1 R, never smaller than the
  camera distance (the camera stays inside it, so it never reads as a ball),
  and follows the bubble rigidly, so no wake is left in old coordinates and
  particles are not re-created every frame. When the volume grows during a
  zoom out, the share of samples it gained is refreshed so none stay packed
  around the hull.
* Directions come from the drawn field (the shift X in the chosen chart). The
  whole field replays in one uniform slow-motion factor λ ≤ 1 while the bubble
  flies, at every zoom.
* Marker spacing shows the model's expansion θ = ∇·X (eq. 12). Each river line
  becomes a rigid row of four markers spaced 0.1 R × exp(κ θ̂), where θ̂ is θ
  divided by its peak (0.95 v_s/R at r = R on the axis). Ahead (θ < 0) rows
  are close-set, behind (θ > 0) they are wide, beside the hull, on the sides
  and far away they stay even; the change is largest at the wall, about one
  radius from the hull (×0.29 ahead, ×3.5 behind at full contrast). κ grows
  with the logarithm of v_s (weak at low speed, strong at high speed). Every
  marker keeps one short length and the thread joining a row stays faint, so
  only the gaps change: close-set beads ahead, sparse dots behind.
* Marker transport is part of the same display mapping: markers move along
  the drawn direction at 0.25–0.6 R/s × their spacing factor, so a steady row
  keeps its count while it slows and bunches entering the front and speeds
  up and spreads behind, and the sampled markers are denser ahead than
  behind. The model's own comoving speed profile (1 − f) is not what this
  speed shows; the lines carry no pressure and do not push the hull, whose
  trajectory the metric prescribes.
* Line ink follows the wall strength |R df/dr|, so the far stream and the
  calm hull region recede behind the wall. Hue follows the sign of θ
  through a monotone saturating map: cyan where space contracts (front),
  magenta where it expands (rear, the river's family for expanding space),
  pale blue on the shearing sides. A nearby body's halo tint is suppressed in
  the ship chart so it cannot repaint the stream.
* Lines are weighted towards the plane through the hull facing the camera, so
  streams at other depths do not stack over the walls in projection.
* The rest-frame velocity and flow vectors at the hull are hidden while the
  bubble flies (they change every frame at superluminal speed); the heading
  arrow stays.
* Sampling: most halo strata go to the bubble's ambient stream while warping,
  and samples leaving the rear re-enter upstream on the same streamline. This
  keeps the walls resolved on a 1024-particle (weak graphics) budget without
  adding particles.
* Presentation eases with the bubble's presence and keeps easing after the
  speed reaches zero, so braking to rest fades the field smoothly. The shift
  term itself always follows the model speed.
* When the camera focuses on another body, R stays at its last size and that
  view's river carries no shift term. This is a display convention: the far
  bubble's f is negligible there (f(5R) ≈ 1e-6), and if the ship crosses that
  view's sampled volume the crossing is left out.
* R follows the camera's orbit distance and eases in log space, so a return
  of focus to the hull settles within about a second.
* Marker spacing and transport, depth weighting, wall-strength ink and the
  hue map are artistic readability built on model quantities (θ, f, df/dr);
  the slow motion is a display time scale. Adding the bubble to the river's mass
  terms is a visualization; it solves no Einstein equations.

## Kinematics and limits

* W raises ln(1 + v) smoothly; release cruises; S brakes; A/D turn the bubble
  axis with an eased angular step. Collapse bubble stops transport at once.
* 1 billion c is a numerical guard of the simulation.
* Above c the hull is causally disconnected from part of the wall (Natário).
  Control of the bubble from inside then has no causal path in general
  relativity; the game allows it.
* The prescribed metric changes everywhere at once with v_s(t) and contains no
  propagation law. The river therefore shows no travelling disturbance or
  gravitational waves. Steady idealized cruise emits none. Radiation from
  starting, braking or collapse needs a numerical-relativity matter model; the
  only published waveforms ([2406.02466](https://arxiv.org/abs/2406.02466))
  are for subluminal (0.1–0.2 c) bubble collapse with a stiff fluid, a short
  burst near f ≈ c/R.
* The navigation interlock sweeps loaded physical surfaces with linearized
  motion, one simulated second per frame at most.

## Verification

* `scripts/smoke-warp-bubble.mjs`: eq. 6 shape and decay, eq. 12 θ against the
  numerical ∇·X, ship-chart term, bounded slow motion, smooth axis turns, GLSL
  parity, no separate layers, frame-rate independent ramp.
* `scripts/verify-warp-bubble.mjs` (desktop and mobile, real controls): shared
  lines on, bubble term reaches the river, sampled volume and particle budget
  around the hull, no per-frame respawn, camera holds the hull, pause, stop,
  reverse, save/load, far superluminal flight.
* `scripts/record-warp-bubble.mjs`: frame-rendered 30 fps video (1/30 s of
  simulation per frame; frame rate unmeasured) with real controls only,
  including a wheel zoom to a system view and back.
* `scripts/measure-warp-fps.mjs`: real-time frame rate of the running app
  (frames the render gate submits), warp off vs ramp vs cruise, desktop and
  mobile viewports; on a GPU-less host this measures the software renderer.
* River guards (`smoke-foreign-river`, `smoke-river-radiance`) still require the
  natural-flight field and advection to be byte-identical to their baselines,
  after `scripts/river-warp-normalize.mjs` strictly removes the warp insertions.
