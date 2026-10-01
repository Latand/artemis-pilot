# Time pulses across scales

Time pulses is the single gravity-flow presentation. The old style selectors,
URL choice and saved preference no longer select another appearance. The gravity
on/off control remains available in Explore and Pilot.

The local GPU river hands over continuously between 8e6 and 4e7 scene units
(roughly 53–267 AU) to a bounded camera-normalized streamline layer. The latter
runs before the cosmic-view early return, so it remains active in interstellar,
galactic, Local Group and galaxy-web views. It draws 360 glyphs on desktop and
160 on mobile, with four line segments each and at most 24 gravitational wells.
Camera normalization and depth-tier gating preserve position precision and avoid
double brightness at the near/far rendering boundary.

The large-scale layer traces a softened gravitational gradient. Local stars use
their existing masses. The Milky Way uses an approximate 6e10 solar-mass stellar
component and, when the existing dark matter toggle is enabled, the existing
NFW halo constants and enclosed-mass profile. Catalog galaxy stellar masses are
estimated using stellar M/L=2; these are visualization estimates, not measured
halo masses. M31 uses the existing merger-model total mass and scale radius
when dark matter is enabled (a softened well in this qualitative overlay). Galaxy sources follow their displayed light-cone positions and the
live Local Group merger offsets. Unresolved populations are represented by a
bounded sample (4096 non-local candidates, grouped in view-scaled cells before
selecting the strongest wells). Grouping preserves sampled mass and its weighted
centroid, preventing unresolved galaxies from piling into duplicate sinks. It is not
an all-galaxy N-body force calculation. No new forces are applied to world state.

Pulse speed and glyph length respond to delivered simulation time relative to
an estimated crossing time at the current view scale. A perceptual speed floor
makes the metaphor legible at ordinary clock rates; saturation prevents flashing
at extreme acceleration. Pause freezes pulses and reverse time reverses their
propagation. These glyphs illustrate attraction, not measured time dilation or
stellar orbital velocities. Galaxy rotation and structural evolution remain
world/galaxy-model concerns.

Planet and moon marker positions now update with their rendered body positions
on every local frame. Surface orientation/LOD work can retain its existing
cadence. This removes the stale-marker jumps at high warp without adding
interpolation lag or changing physics. At time rates that skip much of an orbit
per rendered frame, ordinary temporal undersampling can still occur.

Follow-ups: #18 (transient arms and phase mixing), #19 (dark matter maps and other
halo models), #20 (distinct resolved galaxies and encounter/merger evolution).

## Continuity review after the galaxy / surface / gas updates

This branch includes the current galaxy dynamics, close-up surface and numerical
SPH work from main. The follow-up fixes the display contract rather than adding
another simulation model:

- Camera culling no longer removes gravity sources. A galaxy behind the camera
  still contributes to the illustrated net attraction. Selection is bounded and
  centred on the view target, independently of which galaxy chunks render.
- Moving Local Group wells are sampled every frame. The distant catalog remains
  throttled, with invalidation in both time directions and after epoch jumps.
  Player-placed compact objects now survive the local-to-large-scale handover.
- A skipped mobile compute pass retains the position texture's original frame.
  Both the line draw and the next compute subtract the whole accumulated camera
  shift. A hard camera jump reseeds the volume rather than moving old particles
  into the new region.
- A settled paused view stops respawning particles and preserves pulse length.
  Reverse time changes the sign of particle advection as well as pulse phase.
  Display particles can respawn and are not a reversible physical trajectory
  record; the underlying simulation's deterministic history is unchanged.
- Every well receives seeded glyphs, including odd-indexed wells. Previously the
  even-glyph condition and modulo index could exclude half the wells.
- The Explore control identifies the dominant displayed mass sources and says
  explicitly that these are qualitative attraction cues, not orbital paths or
  measured clock rates. Large-scale sampling still omits most individual stars
  and some catalog mass; it is not a force solver for galaxy dynamics.

`node scripts/verify-gravity-continuity.mjs` captures the real application at six
scales on desktop and touch/mobile, including the volumetric Milky Way and galaxy
population. It records exact revision, budgets, pause/reverse behaviour, retained
texture origins, camera-culling invariance and a paused Andromeda epoch jump.
The test omits tier-1 streaming, HYG background and the procedural resolved star
field to keep software-GPU evidence bounded. This is visual/functional QA, not a
physical iPhone frame-rate claim.
