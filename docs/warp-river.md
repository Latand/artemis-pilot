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
* At the bubble centre proper time equals coordinate time, and the hull's local
  velocity stays separate from the coordinate speed v_s.
* Alcubierre's shift is parallel to the travel axis everywhere, so in the ship
  chart the streamlines near the hull are straight lines along the axis. The
  lines change direction and bend where the bubble competes with the
  gravitational terms (at low coordinate speed, or near a mass) and when the
  axis turns; at high speed the bubble's signature is the speed profile and
  θ (stream slowing into the front, calm hull region, stream speeding up
  behind).

## Display conventions

These are presentation choices, stated so they are not mistaken for physics:

* The hull is drawn enlarged so it stays readable. R follows that drawing
  (R = 0.45 × camera distance), so the calm interior always holds the hull.
  R is a free parameter of the metric.
* σR = 1.8: a thick wall, so the field fades over about one radius
  (f(R) ≈ 0.53, f(1.5R) ≈ 0.15, f(2R) ≈ 0.028, f(2.5R) ≈ 0.005).
* Near the ship the river is drawn in the ship chart. Its sampled volume
  shrinks to 2.1 R and follows the bubble rigidly, so no wake is left in old
  coordinates and particles are not re-created every frame.
* The stream is replayed in one uniform slow-motion factor λ ≤ 1 (directions and
  speed ratios unchanged). Displayed stream speed rises from about 0.5 to 2.6
  bubble radii per second with the logarithm of v_s.
* Streak length and ink follow a monotone saturating map of θ: short bright
  cyan dashes where space contracts, long violet strokes where it expands
  (violet is already the river's colour for expanding space). Brightness is
  read against the bubble's own stream speed.
* Sampling: most halo strata go to the bubble's ambient stream while warping;
  samples leaving the rear re-enter upstream on the same streamline; samples
  stalled in the calm interior are recycled sooner. This keeps the walls
  resolved on a 1024-particle (weak graphics) budget.
* Presentation (volume, contrast, line ink) eases with the bubble's presence
  and keeps easing after the speed reaches zero, so braking to rest fades the
  field smoothly. The shift term itself always follows the model speed.
* When the camera focuses on another body, R stays at its last size and that
  view's river carries no shift term. This is a display convention: the far
  bubble's f is negligible there (f(5R) ≈ 1e-6), and if the ship crosses that
  view's sampled volume the crossing is left out.
* R follows the camera's orbit distance and eases in log space, so a return
  of focus to the hull settles within about a second.
* Adding the bubble to the river's mass terms is a visualization; it solves no
  Einstein equations.

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
  simulation per frame; frame rate unmeasured) with real controls only.
* River guards (`smoke-foreign-river`, `smoke-river-radiance`) still require the
  natural-flight field and advection to be byte-identical to their baselines,
  after `scripts/river-warp-normalize.mjs` strictly removes the warp insertions.
