# Gas, a moving stellar system, and a stellar life

The earlier numerical gas patch had two disconnected halves: it integrated the
cloud's internal pressure/self-gravity, then exposed a softened sink as an
external force source. External bodies could not move that patch. The sink
marker was a numerical control region, not a rendered stellar surface.

This change keeps the numerical collapse and makes its result a persistent,
moveable object with a separately labeled stellar track.

## Choosing what is released

Create → Gas → Star now exposes **Initial gas mass** as a numeric field,
0.1–30 solar masses. This is the released inventory, not a promise that all of
it forms a star. Temperature and initial outward motion still determine whether
self-gravity can overcome support. The cloud radius is initially 0.045 ly.
The 96-parcel resolution cannot predict fragmentation or final stellar masses.

A numerical sink can have a protostellar photosphere estimate while still
accreting. Its physical radius is distinct from the SPH accretion/control radius.
The control radius remains non-collidable. Once assembled, its photosphere or
compact-object surface follows the same contact rule as other stellar objects.

## One object across views

The gas and the formed star share their system's moving origin and stable
identity. Inspect star follows the physical object and frames its photosphere;
View gas cloud returns to the gas-scale view. This does not spawn a second star.
The object uses the ordinary stellar point/photosphere rendering and compact
remnants use the existing black-hole/neutron-star presentation. There is no
second giant luminous sink marker covering the stellar disk.

## External gravity and Galactic motion

Each cloud/core system has one finite-sized gravitational monopole. Its source
mass is unaccreted gas plus current stellar mass, never that total plus a second
copy of the core. Diffuse gas supplies a finite softening extent; a fully
assembled star becomes a compact local source.

The ship samples this field. In integrated local dynamics, Solar-System bodies,
placed black holes and the gas/core center share the same pair kernel and KDK
kicks. A nearby placed hole is deflected by the cloud and deflects the cloud in
return. Separate cloud centers also interact. Existing catalog/procedural stars
remain prescribed background objects; this patch does not make the entire
stellar catalog a mutually integrated N-body system.

The Milky Way background is a prescribed circular guiding orbit using the
existing rotation curve, with vertical motion and a bounded harmonic response
to local kicks. It is not a self-consistent Galactic potential solver. The harmonic response
bounds residual motion even after a large kick; it does not predict Galactic
escape or accurate strongly ejected trajectories. This background is supported within cylindrical radius 5–25 kpc and height
±3 kpc. Gas can still be released elsewhere: it receives a free/inertial center
of mass and local gravity, with an explicit no-Galactic-background label. No
Milky Way orbit is invented for an extragalactic spawn.

A material local encounter prevents the large-time analytic bridge and uses the
bounded shared integrator. When its step budget runs out, delivered time is
limited and the UI reports it. Isolated, weakly perturbed systems can use the
analytic Galactic background at deep time. The material-encounter threshold is
1e−12 km/s²; weak local perturbations are omitted on the analytic bridge. This
is an explicit reduced-model boundary, independent of the camera or visibility.
The default Release ahead distance grows with selected mass to avoid beginning
high-mass experiments in a materially coupled Solar-System encounter. Deliberate
close placements retain the integration limit.

Internal SPH coordinates follow the moving center, but external tides are not
resolved into individual parcel forces. There is no tidal cloud deformation,
stripping or cloud–cloud gas exchange. Earth's existing world-z pinning is also
unchanged, so strict three-axis total momentum conservation is demonstrated by
the isolated cloud–hole tests, not claimed for the constrained Earth frame.

## Stellar evolution is a reduced model

A numerical SPH sink must form before any stellar object appears. The subsequent
track is explicitly a parameterized stellar-evolution model, not simulated
fusion, radiative transfer, or a stellar-interior calculation.

- Accreting cores do not age through the entire stellar life while gas remains
- Numerical assembly supplies the track's initial mass and start time
- The pre-main-sequence contraction timescale is the coarse proxy
  30 Myr × (M/M☉)^−2. This is a model choice, not a collapse prediction
- Main-sequence radius, temperature and luminosity reuse the repository's
  [Eker et al. mass relations](https://arxiv.org/abs/1807.02568)
- The existing lifetime proxy is 10 Gyr × (M/M☉)^−2.5. More massive stars are
  hotter, brighter, larger and shorter-lived in this model
- The giant phase reuses the existing population track's temperature, with a
  luminosity floor tied to the progenitor. A massive star does not turn into a
  low-luminosity red-clump star
- Existing initial–final mass relations choose white dwarf, neutron star or
  black-hole outcomes. The remnant never gains mass relative to its progenitor

The broad sequence is consistent with the
[ESA stellar-evolution overview](https://www.cosmos.esa.int/web/cesar/the-hertzsprung-russell-diagram).
The individual numerical ages, giant branch and remnant properties are coarse
model estimates. A supernova explosion, magnetic braking, mass transfer and
feedback onto remaining gas are not modeled.

## Mass and time

The displayed ledger distinguishes unaccreted gas, stellar/remnant mass and
escaped ejecta. Those sum to the original released inventory. Ejecta is an
explicit escaped-mass bookkeeping term, not a rendered or gravitating shell.
The coast preview freezes the current gas/core inventory and transports its
center while massive partners are extrapolated. It is not a reliable mutual
close-encounter forecast. The visible preview caveat states this.

The current local source uses the remaining bound mass; it does not keep the
progenitor's mass after creating a lower-mass remnant.

The shared simulation clock determines stellar age. Pause freezes it. Quicksave
preserves numerical gas checkpoints, assembly time and external motion state.
Returning to an earlier valid numerical checkpoint returns the stellar track to
that age; it cannot create a star before numerical sink formation.

## Validation

- `node scripts/smoke-gas-stellar-evolution.mjs`: continuous mass validation,
  mass–size–temperature–brightness/lifetime ordering, phases/remnant classes,
  no created mass, assembly timing, single identity, save/load and reverse age
- `node scripts/smoke-gas-dynamics.mjs`: mutual cloud/hole force and actual motion,
  momentum balance, timestep refinement, signed KDK replay, joint saved-state
  continuation, no duplicate mass, bounded Galactic transport and close-encounter
  time budgets
- Existing SPH and gas-runtime suites retain collapse, hot/unbound controls,
  checkpoint replay, work budgets and contact-surface checks
- `node scripts/verify-gas-stellar-evolution.mjs`: actual Create controls and
  production stellar materials on desktop and touch viewports; numerical gas
  assembly precedes the stellar-stage captures

- `node scripts/smoke-gas-world.mjs`: the production shared world clock reaches
  numerical assembly and each stellar stage without fabricated phase injection

The screenshot harness disables the large AT-HYG/procedural/HYG point catalogs,
but retains the production Milky Way volume, galaxy layer and stellar materials.
It is not a mobile-hardware performance measurement.
