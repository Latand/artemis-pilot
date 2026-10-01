# Release gas and form a star

In **Create → Gas → Star**, choose 0.3, 1 or 3 solar masses. Tap/click open
space or choose **Release gas ahead**. The view follows the new cloud. Placement
is one-shot, preserves the current clock/paused state, and stays at least 0.12
light-years from Sol (the existing stellar solver excludes the inner 0.02 ly).

**Watch star form** advances the same universe clock through contraction and
heating. It uses the existing time-jump controller, restores the earlier warp
at arrival, and cancels on manual time controls. It does not run a private
animation clock. Black holes/landed/dead states can limit or prevent the shortcut;
the normal Time controls remain available. A newborn remains a navigable source
under its original cloud entry, with an ordinary point/photosphere, stellar mass,
radius, gravity and contact surface. **View newborn star** moves in for a close
look. It does not instantly acquire planets.

## Model scope

This is a deliberately **illustrative, single-core birth sequence**, not SPH,
MHD, radiative transfer, a Jeans-instability test, or a stellar structure solver.
The initial radius is 0.045 ly. A uniform pressureless sphere's free-fall time,
`t_ff = pi/sqrt(8) sqrt(R^3/GM)`, sets the sequence's approximate duration.
The staged contraction, heating colours and ignition threshold are art-directed.
They do not predict a real cloud's collapse or main-sequence arrival time.

Gravity compresses a star-forming cloud and heats its protostar; eventual hydrogen
fusion powers the star. This qualitative sequence is described by
[NASA's star overview](https://science.nasa.gov/universe/stars/) and
[NASA's star-birth explainer](https://science.nasa.gov/exoplanets/resources/life-and-death/chapter-1/).
The shaders are procedural false-colour illustrations, not telescope data.

- Each source preserves its initial gas mass: gas + core = initial mass. At
  ignition all of it becomes one star. There is no fragmentation, outflow,
  evaporation, feedback, collisions or gas exchange between clouds
- Diffuse-gas/core gravity is omitted during the illustrative collapse. At
  ignition the completed star enters the existing capped stellar gravity and
  contact system. This is an explicit idealized transition, not a continuous
  dynamical mass-accretion model. The star stays fixed in the Sun-centred frame
- Final radius and luminosity use simple `M^0.8` and `M^3.5` scalings; the surface
  temperature follows Stefan–Boltzmann scaling. These are illustrative main-
  sequence estimates, not a precision evolution track. No later stellar aging
- All lifecycle state is derived from exact simulation time and the immutable
  release record. Forward, reverse, pause and arbitrarily large jumps give the
  same phase at the same instant. World stepping splits at birth boundaries
- One cloud uses one volume quad (24 mobile / 40 desktop ray samples) and one
  core sprite. After birth it uses the existing star point/photosphere path.
  The existing shared four-nebula limit also bounds the number of newborn stars.
  No per-frame particle spawning or unbounded buffer growth
- Quicksave preserves formation metadata as an optional seventh nebula tuple
  field. Six-field legacy nebula saves still load. Restart removes created
  clouds/newborns; cosmetic nebulae retain their prior behavior

## Verification

- `node scripts/smoke-gas-formation.mjs`: deterministic stages, mass budget,
  deep-time boundaries, reverse, legacy/malformed saves, stable IDs, cache
  replacement, active/gravity capacity, no auto-planets, unchanged catalogue
- `node scripts/verify-gas-formation.mjs evidence/gas-formation`: actual desktop
  and mobile Create controls, paused placement, all four WebGL stages, quicksave/
  quickload, forward/reverse world steps, cancel/reset and viewport bounds
- Browser screenshot fixture disables the expensive galaxy/catalog background,
  gravity river and lensing to isolate cloud rendering; it retains the real
  application, camera, WebGL, clock and UI. Screenshots are not benchmarks
