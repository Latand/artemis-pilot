# Artemis Pilot

Real-time gravity sandbox built with Vite, Bun, and Three.js. Fly a spacecraft from low Earth orbit through the Earth-Moon system and the wider Solar System, place dynamic black holes, inspect spacetime river flow, and watch live trajectory predictions.

## Run

```bash
bun install
bun run dev
```

Open `http://localhost:5173`.

## Build

```bash
bun run build
```

The static site is emitted to `dist/`.

## Controls

- `W` / `S`: main and reverse thrust
- `A` / `D`: rotate ship
- `Q` / `E`: lateral RCS
- `Shift`: boost
- `Z` / `X`: throttle down/up
- `T` / `Y`: hold prograde/retrograde
- `1`-`8`: time warp presets
- `,` / `.`: warp down/up
- `F`: cycle focus between ship, Moon, Earth, and Sun
- `Shift+F`: cycle planets
- `0` or body label click: focus a body and lock its trajectory prediction
- `P`: trajectory prediction
- `G`: spacetime river visualization
- `B`: place a black hole on the cursor plane
- `[` / `]`: black-hole Schwarzschild radius
- `V`: remove last black hole
- `I`: limited-fuel challenge mode
- `M`: mute
- `R`: restart
- `H`: help

## Assets

Planet, Moon, Sun, Saturn ring, and Milky Way texture maps in `public/textures/` are derived from Solar System Scope texture maps based on NASA imagery and are credited under CC BY 4.0.

Code is licensed under MIT; texture assets keep their original attribution requirements.
