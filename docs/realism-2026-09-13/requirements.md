# Visual realism lane

Issue: https://github.com/Latand/artemis-pilot/issues/1

The paginated inventory on 13 September 2026 found no open PRs or issues before this lane was created. This includes no pre-existing open issues authored by Kostiantyn (`Latand`). The issue above was created by the agent through the authenticated account.

Remote main and the pipeline base were `62e80d8e44511aad7fc4150d36d67141d266b16a`. Separate local main was clean at `8bc8fa8bb0806ff8de0b53731b3e3c9da997aee7`, with nine unpublished commits covering identity, modes, time authority/dock, 3-D contacts, events, close approaches, deterministic TDE lifecycle, and science documentation. Its 32 changed files are outside this lane. The older `codex/full-universe-scale` branch ends at `36be406`; `ui-universe-sim` ends at `d3c2f04`. Neither has an open PR. These refs and worktrees were preserved.

Original user turns were recovered through Viewer transcript search and paginated conversation reads, with project-scoped and unscoped queries:

- **14 June 2026, 04:24 UTC:** full scale/detail, realistic physics, fast efficient simulation, travel, real stars with actual mass/information/placement and seeded generation.
- **14 June, 09:23 and 09:51 UTC:** inspect pictures at different scales, reduce position calculations with significant zoom-out, show moving galaxies and other galaxies.
- **14 June, 12:43 UTC:** black background; questioned the blue background.
- **12 July, 22:12 UTC (13 July Kyiv):** “доведи цю гру до максимальної реалістичності” while remaining maximally efficient and scientifically correct; recover prior plans and original goal.
- **12 July, 22:25 UTC:** convenient simulation of gravity, planets, stars, black/white holes, dark energy, nebulae, disruptions/collisions and gravitational waves.

Current scope prioritizes rendered planets and stars. Broad simulation and UX work remains a separate requirement. Historical direct-main/model instructions are superseded by the current PR-only pipeline contract. A June scientific review's claims about coplanar dynamics and only registered stellar gravity are stale against current 3-D ephemerides and active-star integration.

Two exact baseline GPU reproductions establish the rendering defects independently of the app's CPU photometry tests. For stars at magnitudes 8, 10.5 and 13, integrated red-channel output was **3620, 3620, 3620**: faint flux was clamped to a floor. An opaque sphere placed over a real catalog sky point left its output unchanged at **16073**. Both checks used the repository's actual materials, with no browser errors. See `baseline-regression.json` and `scripts/verify-realism.mjs`.

Scientific references used for the implementation:

- [NASA Glenn: atmosphere](https://www.grc.nasa.gov/WWW/K-12/airplane/atmosphere): atmospheric thickness and its thin limb appearance from orbit.
- [NASA Marshall: photosphere](https://solarscience.msfc.nasa.gov/surface.shtml): white-light photosphere, limb darkening, granulation and solar rotation.
- [NASA: the science of sunglint](https://science.nasa.gov/earth/earth-observatory/the-science-of-sunglint-84333/): geometry of reflected sunlight from water.
- [NASA: Blue Marble clouds](https://visibleearth.nasa.gov/images/57747/blue-marble-clouds/77558l): satellite cloud composites, with their temporal limitations.
- [Bruneton: atmospheric scattering](https://ebruneton.github.io/precomputed_atmospheric_scattering/): exponential density, optical depth, spectral treatment and the distinction between single and multiple scattering. Our inexpensive approximation is documented separately; it does not implement the full reference model.
- [Three.js color management](https://threejs.org/manual/en/color-management.html): linear-light shading and explicit output conversion for custom shaders. Shader chunks were also verified against installed `three@0.164.1`.
