# Numerical gas collapse and protostellar sinks

**Create → Gas → Star** now runs a numerical gas experiment. The earlier
prescribed collapse animation has been replaced; neither age nor a progress
curve creates a star or shrinks the cloud.

Enter 0.1–30 M☉ in the visible gas-mass field, a gas temperature (10, 30 or 200 K), and nearly-at-rest
or outward-moving initial conditions. Release a cloud with the button or a
mouse/touch tap. **Run physics** selects 1,000 simulated years per second on the
shared Time controls. It does not promise formation or jump to a scheduled
birth. Cold, sufficiently bound gas can collapse; hot or unbound gas can expand.
The same clock can be paused. Reverse restores/replays checkpoints, rather than
integrating dissipative gas equations backwards. Quicksave stores the numerical
state, including gas parcels and any sink.

## Numerical model

- 96 equal-mass parcels per cloud, at most four clouds/nebulae. A seeded,
  separated 3D sphere has no imposed inward velocity. Small seeded perturbations
  and rotation avoid a perfectly symmetric initial condition
- Cubic-spline SPH density and pressure gradients; pressure forces are symmetric
  pair interactions. There is no outward radial-force substitute
- Pairwise Newtonian self-gravity with a fixed Plummer softening radius; the
  same softened potential is used in binding-energy tests
- Isothermal molecular gas, `P = rho k_B T / (2.33 m_H)`. The selected temperature
  is a heat bath representing rapid cooling. Compressional/shock work removed
  to the bath and energy supplied during expansion are tracked separately.
  This does not solve radiative transfer or temperature-dependent chemistry
- Monaghan-style viscosity acts on approaching pairs. There is no global
  velocity damping, forced radius contraction or prescribed gas-to-core transfer
- Kick-drift-kick integration with state-dependent Courant/acceleration bounds,
  quantized to a power-of-two timestep ladder. Render-frame boundaries never
  shorten the canonical numerical step. The density kernels shown on screen
  follow the computed particle positions; substep drawing is interpolated

The numerical equations follow [Price's SPH review](https://arxiv.org/abs/1012.1885).
The limitations of an isothermal cloud approximation are discussed by
[Whitehouse & Bate](https://arxiv.org/abs/astro-ph/0511671).

## What the bright core means

The solver creates a **protostellar sink**, representing unresolved collapsing
material. Creation requires a sufficiently dense neighborhood at a potential
minimum, at least 16 parcels, negative COM-frame total energy, inadequate
thermal support, and converging motion. Additional parcels accrete only when
nearby, inward-moving, bound, and with sufficiently low angular momentum.
Thresholds are numerical resolution choices; elapsed time is not a criterion.

Mass, linear momentum, center of mass and angular momentum are carried into the
sink. Unresolved binding energy is booked separately. The sink uses softened
gravity in the existing local stellar field, without treating its control
radius as a lethal photosphere or instantly inventing a planetary system.
**Inspect star** now frames a separate physical photosphere estimate. The numerical
control radius is still not a stellar surface. After assembly, a reduced,
mass-dependent track supplies luminosity, temperature, radius and a remnant; see
[stellar integration](gas-stellar-integration.md). It is not a fusion solver.

The sink criteria are adapted from
[Bate, Bonnell & Price](https://arxiv.org/abs/astro-ph/9510149) and the checks
reviewed by [Federrath et al.](https://arxiv.org/abs/1001.4456).

## Resolution and scope

This is real, coarse numerical gas dynamics. It is not a predictive
star-formation calculation. With 96 parcels, the usual Jeans-resolution
requirements are not met during collapse; fragmentation, final stellar masses
and birth times are not converged astrophysical predictions. See
[Bate & Burkert's resolution study](https://www.astro.ex.ac.uk/people/mbate/Preprints/SPHresolution/SPHresolution.html).

The patch omits magnetic fields, opacity-dependent cooling, radiation feedback,
external tidal deformation of individual parcels, nuclear fusion and stellar
interiors. Internal gas patches do not exchange parcels. Their centers of mass
are finite-sized gravitating systems with mutual local interactions and smooth
galactic transport; see [the scope and validation](gas-stellar-integration.md).

The initial radius is 0.045 ly. At 10 K, initial uniform-sphere free-fall
estimates are about 49,000 / 26,838 / 15,495 years for 0.3 / 1 / 3 M☉. These are
characteristic scales, **not scheduled birth times**. In particular, the 0.3 M☉
cloud can remain pressure-supported instead of forming a core.

## Clock, replay and performance bounds

- At most four SPH steps total per world frame, shared fairly among active
  clouds. The ephemeris retains one shared frame budget across birth boundaries
- If the requested warp exceeds numerical work capacity, the entire universe's
  delivered time is limited. The Time Dock reports the limitation. Gas never
  silently fast-forwards or substitutes an inferred completed state
- Canonical state snapshots plus a bounded rolling checkpoint history support
  replay. A long reverse seek can hold the clock while earlier gas history is
  reconstructed. Cooling is not physically reversed
- Once every parcel belongs to a force-free sink, its free motion can be
  advanced analytically. Remaining supported or dispersing gas is not skipped
- Four fixed particle buffers, no per-frame particle emission. Each cloud uses
  one instanced density-kernel draw and one core marker. No hydrodynamic field
  or particle buffer grows without a cap
- Six-field cosmetic-nebula saves remain supported. Timed-prototype metadata
  becomes a seeded numerical source; its formerly inferred star is not imported

These bounds are not a hardware frame-rate guarantee. CI uses software WebGL;
mobile hardware performance remains unmeasured.

## Reproduction and tests

- `npm run smoke:gas-sph`: cold collapse versus same-seed hot/outward controls,
  marginally supported 0.3 M☉, binding/convergence criteria, mass/momentum/COM and
  angular momentum, bath/sink energy accounting, timestep sensitivity,
  deterministic partition/replay, work caps and malformed checkpoints
- `npm run smoke:gas-formation`: runtime source/state integration, bounded
  shared-clock delivery, multiple clouds, checkpoint persistence and replay
- `node scripts/verify-gas-formation.mjs evidence/gas-formation`: real desktop
  and mobile release controls, actual numerical world stepping, cold contraction
  and sink formation, hot dispersal, pause, rewind, quicksave/load and reset

Screenshots are raw frames from the running app. The dedicated fixture disables
expensive galaxy/catalog background layers, river and lensing to isolate gas
rendering and interaction. It is not a performance benchmark.
