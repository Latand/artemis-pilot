# Planet and moon surface rendering

## Coverage

The actual flight renderer uses this path; it is not a screenshot-only gallery.

- Earth retains its existing mapped ocean/land, water glint, clouds, night lights and atmosphere shader
- Luna and all seven other planets use their existing local 2k color mosaics, with asynchronous load and deterministic fallback
- All 21 named planetary moons have individual procedural appearance profiles
- Ceres now resolves into a physical-size surface in the existing curated minor-body renderer
- All 6,298 unique named exoplanets in the bundled catalog, generated planets, and their generated moons use stable host-and-body identities and class-specific appearances
- Solar-system orbit elements, radii, masses, evolution, light luminosities and catalog photometry are unchanged

The former 30 km minimum for the Phobos and Deimos meshes is removed. Generated-system planet and moon meshes also use their physical radii rather than an enlarged minimum screen radius. Separate guide points fade between 1 and 4 pixel radii. Ceres's Dawn final coordinate-system mean radius is 469.73 km (rendered as 469.7 km), used only for its render-only disk.

## What is sourced and what is inferred

The existing image files in `public/textures/` are **Solar System Scope artistic mosaics**, based on varied imagery and reconstruction. They are not raw NASA products or elevation models. Their vendor explicitly describes saturation changes and fictional gap filling. Attribution: [Solar System Scope textures](https://www.solarsystemscope.com/textures/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). This implementation changes their display shading; the Neptune map additionally receives reference-palette luminance normalization. No new third-party image files were added.

All newly generated color fields are deterministic illustrations informed by observed terrain classes. The location, distribution, number and shape of procedural craters, fractures, basins, volcanoes, weather cells and continents are **not measured cartography**. All new normal maps are synthetic relief, generated separately from albedo. Bright salt, dark maria and sulfur patches are never treated as measured elevation. Mesh silhouettes and collision surfaces remain spherical at their existing mean radii. Phobos/Deimos/Proteus irregular shapes are therefore still an explicit limitation.

Unknown or poorly resolved objects, especially Nereid and all exoplanets, are labeled `Illustrative appearance only; no resolved global surface map is known` in profile/material provenance. A real exoplanet catalog entry does not imply its visual surface is observed. The catalog's inferred class also does not establish an ocean, ice sheet, or atmosphere. The scene shows one plausible illustration of that class.

The material's `userData.appearanceProvenance`, `reliefProvenance`, profile ID and every loaded/generated texture's provenance remain inspectable for UI/tooling. Profiles live in `src/render/bodyAppearanceProfiles.js`.

## Body-specific treatment

| Bodies | Appearance cues | Limits |
| --- | --- | --- |
| Mercury, Luna | Cratered regolith, independent shallow relief | Procedural normal field is not a DEM; Luna's existing mare map stays intact |
| Venus | Cream opaque clouds, subtle broad weather | No rocky surface bump through visible clouds |
| Mars | Rust/desert terrain, polar caps in fallback | Existing photo mosaic supplies actual large-scale color geography |
| Jupiter, Saturn | Distinct band spacing/contrast; Jupiter-like storm in fallback | Cloud relief disabled; storm placement is illustrative |
| Uranus, Neptune | Muted blue-green bands, Neptune somewhat bluer | Display correction is qualitative, not a spectrally calibrated map |
| Phobos, Deimos | Dark regolith; Phobos basin and grooves; smoother Deimos | No arbitrary shared 30 km size; spherical silhouette remains |
| Io | Yellow/white sulfur fields, red-brown deposits and dark calderas | No impact-crater recipe; no invented emission from lava |
| Europa | Pale ice with branching brown fractures | Fracture placement is inferred |
| Ganymede | Mixed darker terrain and lighter grooved regions | No claim of accurately positioned terrain boundaries |
| Callisto | Dark terrain with dense bright impact scars | Crater distribution is illustrative |
| Mimas | Cratered ice with one large basin | Herschel-like basin rather than a surveyed reconstruction |
| Enceladus | Bright ice, subtle south-polar parallel fractures | No unsupported global dark ocean or rocky terrain |
| Tethys | Pale cratered ice, large basin, fractures | Odysseus/chasm-inspired, not cartographic |
| Dione, Rhea | Cratered ice; bright fracture texture for Dione | Independent deterministic seeds |
| Titan | Opaque golden atmospheric haze with subdued polar variation | Surface relief disabled; no visible-light ground detail |
| Iapetus | Strong light/dark hemispheric contrast and an equatorial ridge | Boundary and crater geography approximated |
| Miranda | Tectonic patchwork with banded corona-like domains | Incomplete Voyager coverage is not silently extrapolated as fact |
| Ariel, Titania | Canyon/fracture families over cratered terrain | Illustrative fault locations |
| Umbriel, Oberon | Darker cratered terrain and brighter ejecta | Independent seed, contrast and relief |
| Triton | Pale frost cap and low-relief cellular terrain | Nitrogen-frost distribution is approximate |
| Proteus | Dark cratered surface with a large basin | Spherical mean-radius rendering |
| Nereid | Restrained generic dark icy cratered illustration | Its surface is not globally resolved |
| Ceres | Neutral/dark cratered surface with a few reflective salt-like albedo spots | Inferred normal/albedo field; existing orbital propagation unchanged |
| Exoplanets/exomoons | Stable-ID rocky, desert, ice, ocean, haze or banded recipes | All are appearance hypotheses, even when orbit/radius are measured |

## Neptune color correction

The first production GPU captures showed that merely reducing saturation did not fix the dark Neptune mosaic. Its area-weighted, decoded-linear Rec.709 mean luminance is 0.1228906993, versus 0.5639871162 for the bundled Uranus map. Tint multiplication further reduced Neptune's brightness. The revised shared-material grading uses the source map's **relative** luminance structure with exponent 0.42, bounded to 0.65–1.35, around a restrained blue-green sRGB reference palette `#9ec3ce`. This preserves subdued band/storm geography without carrying over the artistic asset's strongly stretched blue color and low brightness. It affects albedo only; illumination, phase and night-side darkness are unchanged.

The palette is a qualitative display calibration consistent with [Oxford's 2024 result and reconstructed images](https://www.ox.ac.uk/news/2024-01-05-new-images-reveal-what-neptune-and-uranus-really-look-0), not a spectroradiometric reconstruction or absolute albedo measurement. The smoke test locks the source image hash so changing the asset cannot silently reuse stale normalization. Procedural fallback uses the same reference palette directly.

Europa's procedural ridges now use texture-footprint-aware line widths, paired shallow normal ridges and a finer disruption network in limited chaotic terrain. Io's volcanic pits/deposits use deterministic noncircular lobes and incomplete anisotropic halos rather than repeated perfect circles. Both remain clearly labeled geographic illustrations.

## Lighting and scale

Solar-system surfaces remain non-emissive PBR materials under the existing Sun light. New color/normal maps do not paint a bright limb or fixed highlight into a texture. Body-local 3-D micro-albedo detail is derivative-filtered so it disappears instead of sparkling when unresolved. Synthetic relief uses equirectangular tangent-space derivatives with latitude compensation and a flat normal at the exact poles.

Generated and catalog systems now derive light direction and stellar color from **their own host**, rather than the Solar System light. The unlit side receives no invented emission. The existing resolved-body display exposure convention is retained: host illumination is normalized for viewing, not an absolute bolometric radiance calculation. Host luminosity, flux photometry and physics are unchanged. Ring scattering is a simple two-sided PBR approximation, not radiative transfer; planet eclipses on system rings are not yet modeled.

All clocks use simulation time; pause and reverse preserve texture registration. Solar-system moon spin is approximately synchronous with its existing coplanar analytic orbit; this is not an IAU pole/libration solution. Earth and Luna keep their established rotation paths.

## Detail loading and resource bounds

`requestBodySurfaceDetail` only queues bodies whose radius is at least 3 display pixels. A single module worker generates maps in the background, one request at a time. Color and normal byte buffers transfer back without copying; the temporary float elevation field stays in the worker. The normal path starts at 512×256 and upgrades to 1024×512 at radius ≥100 pixels on desktop. Mobile remains at 512×256. The compatibility fallback for engines without module workers runs one 512×256 request per idle callback.

Photographic albedo is retained when relief upgrades. Replaced procedural textures are disposed, system switches dispose old materials, and disposed materials cancel pending requests. Each body's seed is based on its identity, not array slot or camera/visit order. `applyBodySurfaceDetail` is the synchronous public equivalent used by focused screenshot tests.

## Scientific references

- [Dawn final Ceres coordinate and shape system, Table 1 (2018)](https://sbnarchive.psi.edu/pds3/dawn/grav/DWNCGRS_2_v3_181005/DOCUMENT/CERES_COORD_SYS_180628.PDF): mean radius 469.73±0.15 km, equatorial 482.10 km and polar 445.94 km; renderer uses mean-radius sphere rather than claiming a triaxial shape
- [NASA Dawn: Ceres](https://science.nasa.gov/mission/dawn/science/ceres/): dark cratered terrain and reflective salt deposits

- [NASA: Europa, Ganymede and Callisto surface comparison](https://science.nasa.gov/science-research/europa-ganymede-and-callisto-surface-comparison-at-high-spatial-resolution/)
- [NASA: Iapetus](https://science.nasa.gov/saturn/moons/iapetus/)
- [NASA: Deimos](https://science.nasa.gov/mars/moons/deimos/)
- [NASA: Uranus moon facts](https://science.nasa.gov/uranus/moons/facts/)
- [NASA: Nereid](https://science.nasa.gov/resource/nereid/)
- [NASA: Triton approach color sequence](https://science.nasa.gov/resource/color-sequence-of-triton-approach-images/)
- [NASA: Titan's hazes](https://science.nasa.gov/resource/highlighting-titans-hazes/)
- [Irwin et al. 2024, MNRAS: Uranus/Neptune color reassessment](https://academic.oup.com/mnras/article/527/4/11521/7511973)
- [NASA Moon CGI Kit](https://svs.gsfc.nasa.gov/4720), reference demonstrating separate albedo and measured LOLA elevation; **not bundled or used here**
- [NASA image/media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/); NASA hosting alone does not establish rights to every third-party asset

## Validation

`node scripts/smoke-body-surfaces.mjs` checks all 31 named Solar System profiles and all 6,298 unique catalog planet identities; deterministic color/normal output; all map poles and longitude seams; cloud-only flat normals; separate albedo and relief; preserved source color maps on upgrade; disposal/cancellation flags; correct host-light shader injection; pause stability; actual system mesh radii and marker fade; and Ceres following the existing minor-body orbit buffer.

`npm run smoke:planetary-systems`, `npm run smoke:exoplanets`, `npm run smoke:planet-phases`, and `npm run smoke:minor` protect existing dynamics/catalog behavior. Browser/CI screenshots are also required to verify real WebGL shader compilation, phase, terminators and close-up appearance. Pure Node checks do not claim to replace that visual stage.
