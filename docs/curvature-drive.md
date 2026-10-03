# Fictional curvature-drive model

This is a playable, local effective-field model, not a general-relativistic metric or a claim about buildable reactionless propulsion. There is no FTL rule. Existing Newtonian / weak-field gravity, atmosphere, contact, relativistic-travel scenarios and world clocks keep their prior scope.

## One command, physics and presentation

The held W/S/Q/E or autopilot acceleration request sets a compact-support potential, Phi(r) = −(a·r)(1−|r/R|²)³ inside R and zero outside. Its negative gradient at the ship centre equals a. The simulator applies that centre gradient only to the controlled ship, through the existing RK4 integrator. This kinematic actuation assumption is fictional: the simulator does not compute stress-energy, energy supply, reaction forces or an Einstein-field-equation solution. The display-normalized R is an artistic envelope scale, not an engineering radius.

A bounded first-order controller engages over 0.18 operator seconds, separately from simulation time. The exact mean field across each operator frame supplies acceleration; splitting the same command into 30, 60 or 144 Hz frames preserves integrated commanded delta-v. Acceleration is capped at 2.5 km/s², covering the pre-existing throttle/boost range. Releasing translation controls disconnects the field immediately; no residual command enters ballistic coast, analytic high-warp handoffs, pause, reverse time, death or empty-budget states.

The live delivered acceleration magnitude and axis drive the visible compact envelope, not ship speed. Cyan on the acceleration-facing side compresses; violet aft expands. Reverse/braking turns the field axis; lateral commands displace it sideways. The rings respond to field engagement, then spin down on coast. Transparent field lines leave the hull readable and work with the universe river disabled. The river's optional local guide follows the same command but is a display-only deformation; natural river computation and planetary forces are not modified.

The field guide starts on. Hiding it affects only presentation. Its setting is session-only, matching the old cosmetic warp toggle, so old camera settings need no rewrite. Existing quicksave v1–v11 load semantics and delta-v budgets remain; the active actuator is reset on load/restart. Jupiter gravity-assist playback is unpowered and therefore shows natural gravitational flow without a drive bubble.

## Sound and cues

Two low-level sine tones sonify field load as cabin/interface feedback. They are not sound in vacuum. There is no engine-noise loop, orange thrust flame, exhaust stream, boost camera rumble or thrust haptic rumble. The mute control still silences feedback. Real atmospheric-entry plasma, buffeting and collision effects remain.

## Verification

- `node scripts/smoke-curvature-drive.mjs`: potential/gradient, compact support, acceleration cap, 30/60/144 Hz command integration, reverse/lateral commands, exact coast, invalid inputs, pause/reverse/death gate and reset.
- `node scripts/smoke-ship-motion.mjs`: ring integration and local river shader isolation / analytic field sample parity.
- `node scripts/verify-curvature-drive.mjs`: full-app actual pilot input, integration response, command-linked envelope, reverse/lateral axes, no combustion presentation/audio, ballistic release, guide toggles, mute, reset/legacy save and screenshot evidence.
- Existing ship, physics, saves, reverse and build checks remain applicable.
