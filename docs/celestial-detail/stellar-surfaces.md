# Stellar visible-light surfaces

## Scope and inventory

The initial destination list has 81 entries: 37 nearby/famous destinations, 36 HYG physical destinations and eight special objects. Five entries are black holes and use the separate black-hole appearance pipeline. All 76 other destinations share the new photosphere shader, including the four pulsars and Van Maanen's white dwarf. The Sun uses the same material and updates its rendering profile from its retarded-time evolution state.

Named non-hole surfaces are built by `addStarVisual` in `src/stars.js`. The same function promotes active HYG catalog neighbors and procedural stars to resolved meshes (up to 48 nearby active surfaces), and disposes them when they leave the active set. Stable `id`, `hygIndex`, or name seeds survive recreation. The full far-field catalog remains point-rendered by `catalogStars.js`, `starPointMaterial.js`, and the tiered catalog pipelines; this patch does not allocate photosphere textures or meshes for millions of unresolved rows.

## What is observed, modeled, and unchanged

- Temperature and display color use the existing `teffToRGB` path and sRGB-to-linear conversion. This inexpensive Planckian-locus approximation is a display model, not spectroscopy; it does not include line absorption, reddening, extinction or observer color adaptation. Existing catalog/curated temperatures and visual magnitudes are not re-fitted by this change
- Fine convection, mesoscale mottling and sparse spot coordinates are deterministic scientific illustrations, not observed maps of any named star. No claim is made that a particular modeled spot exists on the real object
- Cool dwarfs have fine convection and modest darker modeled activity. Solar-type stars have finer granules, low-contrast broader structure, sparse umbra/penumbra and limb darkening. Cool supergiants have much larger low-gravity structures. Hot radiative stars have much weaker surface contrast and no solar-like spots. White dwarfs and neutron stars do not receive solar spot maps; neutron stars have no invented granulation
- Surface structure is predominantly luminance modulation. The legacy Sun map contributes only a six-percent luminance range and cannot impose its orange/false-color hue on the visible-light Sun
- The surface display has headroom under the existing ACES tone mapping. Lower-temperature objects remain warmer and hotter stars remain blue-white instead of all clipping to flat white
- The three spatial bands taper with screen-space derivatives. Subpixel structure disappears before it can flicker. Noise is evaluated in normalized, body-local 3-D coordinates, avoiding UV seams, polar pinching, and world-position-dependent seeds
- No physical radius, mass, position, catalog record, orbit, evolution track, V-band magnitude, luminosity or point-source flux law is changed. In particular the existing 0.75–3 px point-to-disk handoff is retained. Resolved surface exposure was already a camera display interpretation; it is not a new bolometric flux calibration
- Rotation is not invented for named stars whose rotation period is absent. The Sun retains its existing simulation-time rotation. The static seeded pattern is intentionally stable across paused frames

Below 1500 K an additional rendering-only Wien-tail optical suppression prevents a cold substellar body from being shown as a luminous orange ball merely because the common color lookup clamps at 1000 K. This is a bounded visible-light display approximation, not an atmospheric spectrum. A cold object can still have a location label even when its visible photosphere emits essentially no light.

## Explicit missing-temperature fallbacks

Three curated destinations had no temperature or B−V data. Rendering-only metadata now supplies:

- Teegarden: 3034 K from Dreizler et al. (2024), table 2; its existing radius/mass and older photometric data are not re-fit
- Luhman 16: approximately 1300 K, representative of the unresolved brown-dwarf binary. Faherty et al. (2014) reports 1310±30 K and 1280±75 K for the components. This is not a measured single-object temperature or a resolved component rendering
- WISE 0855-0714: approximately 250 K within NASA's reported 225–260 K range. Its modeled visible surface is essentially dark

These fallback temperatures do not create missing far-field visual magnitudes: existing unknown magnitudes retain the existing dim point-source behavior. Brown-dwarf profiles have restrained atmospheric mottling and no solar-style umbra/penumbra map.

## Source rationale

- [Dreizler et al. 2024, section 4.1/table 2](https://arxiv.org/html/2402.00923v1#S4.SS1) gives Teegarden’s effective temperature
- [Faherty et al. 2014](https://arxiv.org/abs/1406.1518) gives the Luhman 16 component temperature estimates
- [NASA: The Sun and its missing colors](https://science.nasa.gov/image-article/apod-2023-june-11-the-sun-and-its-missing-colors/) explains the Sun's combined visible-light appearance
- [NASA: From hot to hottest](https://science.nasa.gov/resource/from-hot-to-hottest/) distinguishes wavelength-selected solar imagery from visible-light color
- [ESO: Resolved Betelgeuse surface structure](https://www.hq.eso.org/public/images/potw2634a/) supports the qualitative distinction between large cool-supergiant convection structures and much finer solar convection. It is not used as a map of the simulated star
- [NASA: Close cold neighbor of the Sun](https://www.nasa.gov/news-release/nasas-spitzer-and-wise-telescopes-find-close-cold-neighbor-of-sun/) describes WISE 0855-0714 as a very cold brown dwarf detected in the infrared
- [NASA: Water clouds in a cold Jupiter-like object](https://science.nasa.gov/universe/exoplanets/astronomers-find-water-clouds-in-cold-jupiter-like-object/) describes spectral evidence for clouds, not a directly photographed cloud map

The profile amplitudes, cell scales, spot counts and limb coefficients are illustrative rendering priors, not individual measurements copied from those sources.

## Verification

`node scripts/smoke-stellar-surfaces.mjs` exercises all 76 non-hole destination profiles, stable distinct seeds, dwarf/giant/compact class behavior, cold-object optical darkness, linear-RGB temperature ordering, smooth detail filtering, live Sun-like profile evolution, shared uniforms, and composition with the relativistic vertex patch. It also verifies that the source physical records remain byte-for-byte unchanged. A pure Three.js fixture reproduces sub-ULP world-coordinate loss for a distant 12 km pulsar and verifies the shared precise-orbit material hook restores its camera-relative center without changing rotation/scale or overriding stale camera state.

`node scripts/verify-stellar-surfaces.mjs <optional-output-directory>` runs the actual shader in Chromium with an isolated renderer and produces a six-class image gallery plus JSON metrics. It checks repeat-frame identity, star-specific differences, absence of clipping, temperature-color ordering, unresolved-detail suppression, optical darkness for 250 K, and one shared compiled program. For a system Chromium set `PLAYWRIGHT_CHROMIUM`; otherwise it uses Playwright's installed browser. The same fixture can be opened manually at `/scripts/stellar-surface-fixture.html` while Vite is running.

The focused CPU smoke and 52 brightness checks passed locally, and the production build passed. Local GPU execution is blocked by the execution sandbox's browser IPC/socket restriction; the supported cloud browser also blocks loopback URLs. GPU/image checks are prepared for CI but must not be described as passed until that run is available. Existing Sun-evolution tests passed their 31 CPU checks, while their browser phase and the live-star browser smoke could not run here.
