# Artemis Pilot

An interactive Three.js gravity sandbox where you pilot a spacecraft from low Earth orbit into a live Solar System model. Fly, warp time, inspect predicted paths, place black holes, and watch the spacetime river field respond around planets and singularities.

![Artemis Pilot: Earth orbit with spacetime river flow](docs/screenshots/01-earth-orbit-river.png)

## Highlights

- **Live orbital flight** with thrust, RCS, throttle control, prograde/retrograde hold, time warp, atmospheric drag, landing, and mission objectives.
- **Solar System scale** with Earth, Moon, Sun, all seven other planets, true radii, gravitational parameters, orbit rings, textures, and focus controls.
- **Trajectory tools** for ship prediction, full-journey traces, hover velocity readouts, body trajectory prediction, and locked body tracking.
- **Spacetime river view** with GPU particle flow around Earth, Moon, Sun, planets, and black holes.
- **Dynamic black holes** with configurable Schwarzschild radius, Paczynski-Wiita capture behavior, mergers, Hawking readouts, accretion visuals, and dark event-horizon cores.
- **Readable cockpit HUD** with escape-speed tracking, propellant, apoapsis/periapsis, Moon/Sun distance, gravity pull, and mission status.

## Screenshots

### Earth Orbit River Field

![Earth orbit river field](docs/screenshots/01-earth-orbit-river.png)

### Solar System Overview

![Solar System overview](docs/screenshots/02-solar-system-overview.png)

### Locked Body Prediction

![Locked body prediction](docs/screenshots/03-locked-body-prediction.png)

### Black Hole And Hawking Readout

![Black hole and Hawking readout](docs/screenshots/04-black-hole-hawking.png)

## Run Locally

Install dependencies with Bun:

```bash
bun install
```

Start the Vite dev server:

```bash
bun run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`.

## Build

```bash
bun run build
```

The static build is written to `dist/`.

## Controls

| Key | Action |
| --- | --- |
| `W` / `S` | Main and reverse thrust |
| `A` / `D` | Rotate ship |
| `Q` / `E` | Lateral RCS |
| `Shift` | Boost |
| `Z` / `X` | Throttle down/up |
| `T` / `Y` | Hold prograde/retrograde |
| `1`-`8` | Time warp presets |
| `,` / `.` | Warp down/up |
| `F` | Cycle ship, Moon, Earth, and Sun focus |
| `Shift+F` | Cycle planets |
| `0` or body label click | Focus a body and lock its trajectory prediction |
| `P` | Toggle trajectory prediction |
| `G` | Toggle spacetime river visualization |
| `B` | Place a black hole on the cursor plane |
| `[` / `]` | Change black-hole Schwarzschild radius |
| `V` | Remove last black hole |
| `I` | Toggle limited-fuel challenge mode |
| `M` | Mute |
| `R` | Restart |
| `H` | Help |

## Project Structure

```text
src/
  blackholes.js   black-hole physics hooks and visuals
  bodies.js       Sun, planets, Moon, rings, labels, lights
  ephemeris.js    Solar System state propagation
  physics.js      ship dynamics, landing, loss conditions
  river.js        GPU particle river field
  trails.js       ship and body prediction traces
public/textures/  planet, Moon, Sun, ring, and Milky Way maps
```

## Assets And License

Planet, Moon, Sun, Saturn ring, and Milky Way texture maps in `public/textures/` are derived from Solar System Scope texture maps based on NASA imagery and are credited under CC BY 4.0.

Code is licensed under MIT. Texture assets keep their original attribution requirements.
