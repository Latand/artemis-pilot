# Universe continuity: one universe across scale, time and observer

This note describes how Artemis Pilot keeps the universe continuous from a
planet's surface to the cosmic web, from today to the degenerate era, and
between observers at different places and speeds. It lists, for every layer,
where its numbers come from (measured, derived, statistical or modelled), what
is approximated, and which test pins it.

## Frames and units

| Frame | Definition | Used by |
| --- | --- | --- |
| world | heliocentric, ecliptic J2000 axes, km (`universe/coords.js`) | physics, catalogs, every layer's source data |
| scene | `(x, y, z)_scene = (x, z, -y)_world * K`, `K = 0.001` | Three.js |
| galactocentric | pc, origin at Sgr A*, +X toward the Sun, +Y along rotation, +Z to the NGP | Milky Way model, procedural stars |
| comoving | Mpc, world axes, normalised to a = 1 today | galaxy population |

Two depth tiers (`render/tierDepth.js`) split the scene at 0.02 ly so planets
and galaxies both keep depth precision.

Precision. Object positions are float64 on the CPU and Three.js forms the
model-view matrix in float64, so every mesh (planets, active stars and their
planets, holes, orbits drawn as scaled unit circles) is exact wherever the
camera is; shaders use only the rotation part of the model matrix. Point
layers that store many positions per buffer: galaxy chunks carry float64
centres with float32 offsets (and normalised clip coordinates, exact at Gpc)
and the merger debris is stored relative to the Galactic centre. The star
buffers (HYG/curated catalog, AT-HYG tier 1, the procedural resolved field)
hold float32 positions relative to the render origin, the Sun by default;
they err by at most one float32 step of their distance from it (~2 AU at
300 ly, ~110 AU at the Galactic centre), which stays below a pixel because
the nearest such star is >= ~1 pc from the camera and a star closer than
that is drawn as an active-star mesh instead. A camera-following
render origin (`universe/renderOrigin.js`, `?rebase=1`) exists for the
catalogs and minor bodies but stays experimental: the tier-1 groups do not
yet move with it.

## One photometric system

Everything that emits light is converted to display values with the same
chain: luminosity -> flux at the camera -> per-pixel radiance -> exposure ->
tone map.

- **Stars** (catalogs, procedural field, the Sun, active stars) share one
  point material, one PSF and one exposure (`render/stellarAppearance.js`).
- **Resolved vs unresolved Milky Way light.** A star is drawn as a point when
  its apparent magnitude is brighter than the shared resolve limit; the
  volumetric Milky Way (`render/galaxyVolume.js`, model in
  `universe/galaxyModel.js`) carries exactly the light of the stars fainter
  than that limit (tables built from the same stellar population,
  `universe/resolvedLF.js`). Near the camera the glow gives way to stars,
  far away it becomes the whole Galaxy: a flux-preserving partition, not a
  cross-fade.
- **Galaxy volume -> galaxy sprite.** Once the Milky Way spans fewer than
  ~16-40 px its entry in the galaxy population takes over with the same
  luminosity (cross-faded by angular size).
- **Galaxies** are extended sources: sums of exponential components in their
  projected ellipse, integrated flux `gain * exposure * L / (4 pi d_A^2) *
  (1+z)^-4`, widened by the same PSF when unresolved. No point/extended switch.
- **Display gain.** Extended light uses the stars' own calibration: a
  one-pixel star of flux F (Lsun/pc^2) shows `STAR_DISPLAY_PER_FLUX * F`
  (`render/galaxyVolume.js`, from `BRIGHTNESS_CURVE`), so a surface of
  radiance I shows `STAR_DISPLAY_PER_FLUX * I / pxScale^2` per pixel. The
  diffuse Milky Way therefore carries exactly the display flux of the stars
  it stands for, and a galaxy the flux of a star of its magnitude.
- **Exposure.** Inside the Milky Way's stellar disk every layer shares the
  stellar exposure, lowered where the Galaxy's own light would clip (from
  above the disk or beside the bulge, where the inner Galaxy shows through
  little dust): each draft of the volume is max-pooled and read back, and
  the exposure is capped so the brightest 1 % of blocks sit at white and,
  once the camera is more than ~0.4-1.2 kpc above the plane (the disk's
  glow filling the view), their median at 0.12 so the disk keeps a
  photographic tonal range. The cap never raises the exposure, so a dark
  sky keeps the stars' calibration. As the camera leaves the disk (0.3 to 3 kpc beyond a
  slab of R < 20 kpc, |z| < 0.6 kpc: `galaxyExposureBlend`) it blends into a
  photographic auto-exposure metered on the galaxies in view (0.6 s time
  constant). With a resolved galaxy in view (>= 30 px) its core is exposed
  1.2x above the metering target, near white with the disk in the
  mid-tones; for the Milky Way the core's surface brightness comes from the
  model itself (face-on central column over a ~1 kpc^2 core, averaged over
  the pixel footprint), which does not change while zooming, so moving from
  the whole Galaxy into one arm keeps the exposure: the same picture with
  more detail. Without a resolved galaxy the brightest 0.2 % of pixels sit
  at 0.9. One exposure scales every galaxy, so relative brightness is exact.
- **Display stretch outside the Galaxy.** Extended light spans ~10^4 in
  surface brightness from galaxy cores to tidal debris, and the ACES tone
  map clips linear values below ~0.002. Outside the Milky Way (same blend as
  the exposure) extended light is shown through an asinh stretch (Lupton et
  al. 2004), `S(v) = asinh(v/0.03) / asinh(5/0.03)`: linear with gain ~5.7
  for faint light, logarithmic above, white only at 5x the metered disk
  level so bulges stay unclipped; monotonic and applied to luminance. When
  the Milky Way's disk fills much of the view (2-25 % screen coverage and
  up) the stretch is reduced by 70 % so its arms and dust lanes keep their
  contrast instead of being lifted to one level. The faint cull limits scale
  with it so nothing pops.

## The Milky Way model

`universe/galaxyModel.js` is one light-and-dust model (V band) integrated
along view rays by `render/galaxyVolume.js` from the camera's true position:
the band with its dust lanes from the Earth, the barred spiral from outside.

- **Components.** Young, thin and thick disks (exponential, R_d = 2.6 /
  2.0 kpc; young and thin with a central hole), an oblate stellar halo, the
  boxy/peanut bulge and long bar (Wegg et al. 2015 geometry), dust with
  scale height 100 pc and length 3.5 kpc plus lanes on the bar's leading
  edges, HII line emission, and the Central Molecular Zone as a nuclear
  ring (~100 x 60 pc, elongated across the bar; Molinari et al. 2011) of
  dense dust and star formation holding ~5 % of the young light. V-band emissivities come from the procedural
  star population's own luminosity function (`scripts/build-resolved-lf.mjs`,
  j_V = 0.072 Lsun/pc^3 locally); the young share is tied to the star
  formation rate. The model integrates to L_V = 3.9e10 Lsun, M_V = -21.65
  (measured -21.5 +- 0.4, Licquia et al. 2015); the population's MILKY_WAY
  entry carries the same light. Local dust: A_V ~ 1.8 mag/kpc mean in the
  plane, 0.14 mag toward the pole, opaque (~90 mag) toward the centre.
- **Structure maps** (`universe/galaxyMaps.js`, 1024^2 texels over
  +-24 kpc, 47 pc each, built in a worker in ~1-2 s). The measured part is the
  Reid et al. (2019) maser spiral arms; beyond their observed azimuths the
  pitch relaxes to the Galaxy's mean 12.5 deg. Scutum-Centaurus and Perseus
  start at the bar ends and carry the old stellar arms (Benjamin et al.
  2005); the young stars concentrate in all arms; dust lanes run along the
  arms' concave (inner) edge with feathers trailing into the interarm; star
  formation is broken into complexes of 100-300 pc and HII knots. Each map
  is normalised to its mean within 1 kpc of the Sun, so the local
  calibration survives the arms. The small-scale features (knots, feathers,
  arm breaks) are statistical, provenance PROCEDURAL, not real clusters.
- **Detail at every zoom (LOD).** Every ray sample knows its pixel's
  footprint and the ray step. The maps are sampled from a mip chain at that
  footprint; where the texels are resolved the dust lanes are drawn
  analytically from interpolated arm coordinates (sharp at any zoom). Below
  the texels the young light breaks into star-forming complexes (one per
  100 pc cell, 15 pc) that each hold three clusters (3 pc), with the
  cluster luminosity function dN/dL ~ L^-2 (Efremov & Elmegreen 1998;
  Zhang & Fall 1999); the ionized gas into bubble-shaped HII regions around
  the complexes, brighter on one side; the dust into a cascade of lognormal
  clouds from ~90 to ~6 pc with ragged, fractal edges, the small-scale
  structure living inside the large clouds, stretched ~2:1 into trailing
  streaks by the Galaxy's shear (an area-preserving map, so the statistics
  are unchanged; 3-D gradient noise rotated per octave, so no lattice
  direction shows). Every level has unit
  mean (normalised exactly, level by level) and fades in only where the
  footprint resolves it; clusters are widened along the ray by the step and
  across it only by the pixel, so they stay as sharp as the pixels allow.
  A distant view is the same picture with less detail, not a blurred or
  differently bright one. The procedural resolved stars are placed in the
  same complexes and clusters, so what is seen from outside is where the
  stars are drawn from inside.
- **Resolution and cost.** While the view moves the integral is drawn as a
  draft: ~0.33 Mpx over the Galaxy's part of the screen from outside, a
  quarter of the screen's pixels from inside the disk, without the finest
  detail levels. Once the view settles it is refined at the full device
  resolution, a band of rows per frame (~0.3 Mpx, half that inside the
  disk) so no frame stalls, and cross-faded in over 0.3 s. Draft size and
  band size follow the frame time (a slow GPU converges to smaller ones
  within a few frames, a fast one grows them). Nothing is re-rendered while
  the camera and the model's time-dependent state stay put.

## Star population continuity (provenance)

- HYG v4.1 tier 0 and AT-HYG tier 1 (2.37 M stars, streamed) are measured.
  HYG marks the 10,225 stars without a valid parallax with a 100 kpc
  placeholder distance; they are given a photometric distance instead
  (main-sequence from colour, no nearer than 500 pc; `universe/catalogData.js`)
  so they no longer form a shell of false hypergiants around the Galaxy.
- Beyond catalog completeness the procedural Milky Way (`universe/galaxy.js`,
  `universe/resolvedField.js`) draws the complementary stars from the same
  densities and luminosity functions the diffuse light uses.

## Galaxies: the real universe first, statistics only where data end

`universe/galaxyPopulation.js` builds one population (239,684 galaxies, ~1.2 s
in a worker), each with a provenance tag shown in the catalog:

| Tag | Source | Count |
| --- | --- | --- |
| MILKY_WAY | the Galaxy model above | 1 |
| LV_MEASURED | Local Volume (UNGC + McConnachie 2012): measured distances, sizes, axis ratios, position angles, to 11 Mpc | 862 |
| REDSHIFT | 2MRS (Huchra et al. 2012), distance from redshift in flat LCDM, to 250 Mpc | 43,367 |
| ZOA_CLONE | 2MRS galaxies next to the Galactic-plane zone of avoidance mirrored into it (Yahil et al. 1991; Lavaux & Hudson 2011) | 3,410 |
| COMPLETION | galaxies fainter than the 2MRS limit (Ks = 11.75), painted around observed galaxies with the K-band luminosity function so they follow the real structure | 98,762 |
| WEB | a Voronoi cosmic web (van de Weygaert & Icke 1989 geometry) beyond the survey, to 700 Mpc | 93,282 |

Every part obeys one flux-limited selection seen from the Sun, so the density
is continuous across the survey / clone / completion / web seams.

- Groups and clusters: friends-of-friends on 2MRS (Huchra & Geller 1982,
  Crook et al. 2007 parameters D0 = 0.56 Mpc, V0 = 350 km/s), 6,625 groups;
  their finger-of-God redshift elongation is compressed. Local Volume groups
  follow UNGC's tidal index; the Local Group is everything within 1 Mpc of
  its barycentre (the zero-velocity radius, Karachentsev et al. 2009). (The Tully group
  catalogs on VizieR could not be fetched from this build environment: the
  host is blocked by the network policy.)
- Luminosity function: Schechter in K, fitted to the 2MRS counts
  (M* = -23.65 + 5 log h, alpha = -1.09, phi* = 0.0081 h^3 Mpc^-3); the
  literature fits over-predicted the bundled catalog's counts by ~2x.
- Morphology from the catalog type where known, else the morphology-density
  relation; sizes from the size-luminosity relation (Lange et al. 2015).

## Expansion and the observer's light cone

`universe/cosmicExpansion.js`: flat LCDM, Planck 2018 (H0 = 67.66, Omega_m =
0.3111, Omega_Lambda = 0.6889, t0 = 13.79 Gyr), carried as ln a so it runs to
10^15 yr without overflow. Bound units (groups, clusters, the Local Group)
keep their proper sizes; only separations between units follow a(t).

Every galaxy is drawn on the camera's past light cone: its comoving distance
gives the emission epoch through the conformal time, it sits at the
angular-diameter distance `a_e * chi`, is dimmed by `(1+z)^-4` and redshifted.
Beyond the particle horizon nothing is drawn. In deep time the event horizon
shrinks around the Local Group: galaxies recede, redden and fade, and the
Local Group ends alone.

Galaxy stellar populations evolve (`universe/galaxyEvolution.js`): delayed-tau
star formation per morphological type, simple-stellar-population light fading
as age^-0.8, colour reddening, the death of the last red dwarfs at ~10^13 yr
and the degenerate era at 1.2e14 yr, all evaluated at the emission epoch.

## Observer time

The simulation advances in coordinate time; what a camera sees left each
source at `t_obs = t - d/c` (`universe/observerTime.js`):

- galaxies: the light cone above;
- Andromeda, its satellites and the merger debris: their orbit at their
  retarded time;
- the Sun's appearance (point, photosphere, corona, planetary nebula): the Sun
  of `t - d/c`, so from the Local Group the planetary-nebula phase is seen
  2.5 Myr late (planet illumination keeps the Sun of the sim time);
- black holes, tidal disruptions: debris, disk and flare at retarded time.

A moving camera sees relativistic aberration and Doppler shifts
(`relView.js`); extended sources scale with D^4.

## Milky Way - Andromeda

`universe/localGroupOrbit.js` integrates the MW-M31 separation from van der
Marel et al. (2012) initial conditions (785 kpc, -110 km/s radial, 30 km/s
transverse; 1.3e12 and 1.5e12 Msun). Each galaxy is a Hernquist sphere (a =
21 / 22 kpc, from the observed circular speeds) and each centre falls in the
other's potential, with a dynamical-friction drag once the halos overlap:
first pericentre at 4.05 Gyr (~34 kpc), second apocentre ~190 kpc, captured
under 50 kpc at 7.1 Gyr, sloshing below ~11 kpc after 12 Gyr.

`universe/mergerTides.js` adds the stellar disks as a restricted N-body model
(Toomre & Toomre 1972): 2 x 3072 test particles on circular orbits in disks
that follow the Galaxy model's light (young + thin + thick disk) and M31's
exponential disk (i = 77 deg, PA = 38 deg, near side north-west, south-west
half approaching), integrated in the two moving Hernquist potentials from
2.5 Gyr (KDK, 2.5 Myr steps, keyframes every 25-50 Myr, ~2 s in a worker).
The host orbit uses the same force law as the particles, so a galaxy's stars
follow its centre. First passage strips the disks outside-in into bridges and
tails; by ~9-12 Gyr both disks are debris around the merged centre (median
radius ~35 kpc: restricted N-body lacks the self-gravity that would make the
remnant more compact).

Light bookkeeping: a particle is drawn as debris once the tide has moved it
off its initial orbit, and the smooth models lose exactly its light: the
Milky Way volume through keep factors per initial-radius bin, the sprites of
both galaxies through their disk components. Bulges and the stellar halo stay
with the smooth models.

## Known approximations and discrepancies

- The Milky Way's V surface brightness at the solar circle is ~40 Lsun/pc^2,
  above the ~25-30 derived from local star counts (e.g. Flynn et al. 2006),
  while its total (M_V -21.65) matches: the population's local emissivity
  (0.072 Lsun/pc^3) is ~30 % above measured values and the disk is
  correspondingly compact. It is kept because the procedural stars and the
  diffuse light share that population.
- The Milky Way's knots, clusters, HII bubbles, feathers and dust clouds
  are statistical; only the arms (Reid et al. 2019), the bar, the Central
  Molecular Zone's size and the smooth components are measured. The
  structure maps co-rotate with the spiral pattern; the stars' own orbits
  do not shear them. The dust clouds below the maps' texel dim the diffuse
  light only: a resolved star behind one is extinguished by the smooth
  model.
- Tidal debris: no disk self-gravity, no gas or star formation, prescribed
  host orbit; the Magellanic Clouds and M33 are not perturbed. Seen from
  inside the debris (e.g. from the Sun after the merger) its diffuse
  near-field glow is not drawn: kernels wider than ~24-48 px fade out, since
  that view would need a volumetric treatment like the Milky Way's.
- Seen from far outside (~0.5 Gpc and beyond) the flux-limited galaxy
  population shows its Sun-centred selection: the survey sphere, which
  holds fainter galaxies than the statistical web beyond it, looks denser
  than its surroundings. An observer-centred selection or a diffuse
  unresolved-light component would remove it.
- The cosmic web beyond 250 Mpc is statistical (provenance WEB); its galaxies
  are not real individual objects.
- The camera-following render origin is experimental (see Frames); precision
  is carried by float64 transforms and relative-to-centre buffers instead.

## Tests

- `smoke:galaxy-population` - catalog decode, provenance counts, groups,
  light-cone geometry, evolution tables, packing.
- `smoke:merger`, `smoke:merger-tides` - orbit timeline, disk orientations,
  equilibrium before the encounter, outside-in stripping, bound remnant,
  light bookkeeping, determinism.
- `smoke:galaxy-model`, `smoke:brightness`, `smoke:cosmic-era`,
  `smoke:deep-time` - the Milky Way model (its M_V, local dust columns, the
  arms' and lanes' geometry in the structure maps), photometry and deep
  time.
- `node scripts/capture-scale-ladder.mjs <dir>` - a 40-rung zoom from the
  Earth to 1.5 Gly with per-frame luminance statistics (no black gaps).
- `node scripts/capture-views.mjs <dir> <views.json>` - photographs named
  camera views (focus, distance, orientation, epoch) with per-frame
  statistics, for before/after comparisons of a rendering change.
