# Observational galaxy catalogs: provenance

These catalogs give the simulator a data-driven large-scale universe: real galaxies at
measured distances out to about 11 Mpc, and 2MRS redshift-space positions beyond that.

| File | Contents | Rows | Size |
|---|---|---|---|
| `public/data/local-volume.json` | Local Volume galaxies with **measured** distances: compact JSON (header, then rows as arrays) | 869 | 170 KiB |
| `public/data/2mrs.bin` | 2MRS galaxies with **redshift-space** distances: columnar Float32 LE, 10 fields | 43,533 | 1.66 MiB |
| `public/data/2mrs-manifest.json` | fields, units, byte offsets, cosmology, caveats, errata, citations, input checksums | - | 18 KiB |

- Build: `npm run catalog:galaxies` (`scripts/build-galaxy-catalogs.mjs`). Raw downloads are
  cached under `cache/galaxy-catalogs/` (gitignored). With a warm cache the build needs no
  network (`--offline` enforces that) and the output is byte-identical on every run.
  `--refresh` re-downloads everything.
- Check: `npm run smoke:galaxy-catalogs` (`scripts/smoke-galaxy-catalogs.mjs`).
- Runtime: `src/universe/galaxyCatalogs.js` (pure, dependency-free):
  `decodeLocalVolume(json)`, `decode2mrs(arrayBuffer, manifest)`,
  `equatorialUnitVector(raDeg, decDeg, out)`, `loadLocalVolume(baseUrl)` and `load2mrs(baseUrl)`.
  All positions and unit vectors are **ICRS/J2000 equatorial**. The app's world frame is
  ecliptic J2000, so rotate with `equatorialToWorldInto()` from `src/universe/coords.js`
  before placing anything in the scene.

## Sources

| ID | Citation | VizieR | Used for |
|---|---|---|---|
| UNGC | Karachentsev, I. D., Makarov, D. I., & Kaisina, E. I. 2013, AJ, 145, 101, "Updated Nearby Galaxy Catalog", doi:10.1088/0004-6256/145/4/101 | [J/AJ/145/101](https://cdsarc.cds.unistra.fr/viz-bin/cat/J/AJ/145/101) (tables 1, 2, 6) | Local Volume base list |
| M12 | McConnachie, A. W. 2012, AJ, 144, 4, "The Observed Properties of Dwarf Galaxies in and around the Local Group", doi:10.1088/0004-6256/144/1/4 | [J/AJ/144/4](https://cdsarc.cds.unistra.fr/viz-bin/cat/J/AJ/144/4) (tables 1-3) | Local Group distances, M_V, velocities, PAs |
| 2MRS | Huchra, J. P., Macri, L. M., Masters, K. L., et al. 2012, ApJS, 199, 26, "The 2MASS Redshift Survey - Description and Data Release", doi:10.1088/0067-0049/199/2/26 | [J/ApJS/199/26](https://cdsarc.cds.unistra.fr/viz-bin/cat/J/ApJS/199/26) (table 3) | redshift survey |
| 2MASX | Skrutskie, M. F., et al. 2006, AJ, 131, 1163; Jarrett, T. H., et al. 2000, AJ, 119, 2498 | [VII/233](https://cdsarc.cds.unistra.fr/viz-bin/cat/VII/233) (`xsc`) | position angles (`sup_phi`) |
| Planck | Planck Collaboration I 2020, A&A, 641, A1 (CMB dipole); Planck Collaboration VI 2020, A&A, 641, A6 (H0) | - | CMB frame, Hubble law |

The CDS FTP files are fixed-width. The build parses each ReadMe's "Byte-by-byte" section
(labels, byte ranges, `?=` null sentinels) and checks every file's row count against the
ReadMe's File Summary. The 2MASX position angles come from 24 small RA-sliced VizieR ASU-TSV
queries, because one all-sky query stays silent long enough for proxies to drop it. They are
joined on the 2MASS designation; all 43,425 joined `b/a` values agree with 2MRS.

## Local Volume (`local-volume.json`)

- **Selection:** all 869 UNGC galaxies except the Milky Way, plus McConnachie galaxies that
  are missing from UNGC (only HIZSS 3B). McConnachie's "The Galaxy" and "Canis Major" are
  excluded; Canis Major is a disputed overdensity about 7 kpc away, inside the Milky Way disc.
  Rows are sorted by distance. The nearest is Segue 3 at 16.6 kpc, so no row lies within
  1 kpc of the Sun.
- **Cross-match:** 99 UNGC galaxies match McConnachie: 93 by normalised name
  (`And XVIII` = `Andromeda XVIII`, `LeoIV` = `Leo IV`, Messier/NGC twins) and 6 by position
  (within 10′, with consistent distances).
  For matched galaxies within 3 Mpc the row adopts McConnachie's distance (from (m-M)_0),
  position, M_V, heliocentric velocity and PA. UNGC's distance-dependent quantities
  (M_B, log L_K, linear diameter) are rescaled to that distance. The row records its
  provenance in `source` (`UNGC` / `UNGC+M12` / `M12`) and `distSource`.
- **Key galaxies:** M31 0.783 Mpc, M33 0.809 Mpc (McConnachie (m-M)_0 = 24.54; UNGC has
  0.85 Mpc), LMC 0.0506 Mpc, SMC 0.0640 Mpc.
- **Measured (catalog) fields:** name, position, distance and its method (TRGB, Cep, SN,
  SBF, TF, mem, h, …), T-type, dwarf morphology class, M_B (UNGC, extinction corrected),
  M_V (McConnachie), log L_K (UNGC, M_K,sun = 3.28), Holmberg diameter (kpc and arcmin),
  b/a, inclination, PA, heliocentric and Local Group velocities, tidal index and main
  disturber.
- **Derived by the build:**
  - `LB = 10^(-0.4 (MB - 5.48))`
  - `lum`: from M_V (M_V,sun = 4.83) when McConnachie gives one, else `LB`; `lumBand` says which
  - `distErrMpc = D ln(10)/5 σ(m-M)`
  - `distQuality`: 1 = stellar-population, geometric, SN, SBF or PNLF; 2 = TF, FP, brightest
    stars, group membership, or flagged uncertain; 3 = Hubble-flow or texture only.
    Counts are 342 / 417 / 110.
  - 142 PAs taken from the 2MASX PA of the galaxy's 2MRS duplicate (`paSource`)
  - the `derived` column lists any other values computed here (for example `logLK` when
    UNGC gives none)

  UNGC table 1 rounds distances to 0.01 Mpc. The build replaces that value with the table 6
  distance modulus whenever the two agree to within the rounding.

## 2MRS (`2mrs.bin` + manifest)

- **Selection:** 2MRS main catalog, Ks ≤ 11.75 mag (isophotal, extinction corrected) and
  |b| ≥ 5° (8° toward the bulge). 1,066 of the 44,599 galaxies have no published redshift
  and are omitted.
- **Fields:**

  | Field | Kind | Contents |
  |---|---|---|
  | `raDeg`, `decDeg` | measured | position, deg J2000 |
  | `cz` | measured | heliocentric c·z, km/s |
  | `KsMag` | measured | Ks total, extinction corrected |
  | `type` | measured | ZCAT T-type code; NaN for blank, 98 "never examined", or the undocumented 99 |
  | `ba` | measured | axis ratio |
  | `pa` | measured | 2MASX `sup_phi`, deg E of N; NaN when missing |
  | `vCmb` | derived | CMB-frame c·z, km/s |
  | `distMpc` | derived | Hubble-flow distance |
  | `lvIndex` | derived | Local Volume duplicate index |

  `decode2mrs` adds equatorial unit vectors and `LK = 10^(-0.4 (KsMag - 5 log10(distMpc·1e5) - 3.28))`
  (no K-correction, which matters by less than about 0.1 mag at these depths).
- **CMB frame:** the Planck 2018 dipole is 369.82 km/s toward (l, b) = (264.021°, 48.253°),
  which the Hipparcos rotation converts to (RA, Dec) = (167.9419°, −6.9443°).
  `1 + z_cmb = (1 + z_hel) / (γ (1 − β cos θ))`, which to first order is `vCmb ≈ cz + 369.82 cos θ`.
- **Distance:** `distMpc = max(vCmb, 100 km/s) / H0` with **H0 = 67.66 km/s/Mpc** (Planck 2018,
  the value of `DARK_ENERGY.H0_KM_S_MPC` in `src/constants.js`; the smoke fails if they drift
  apart). This is a linear Hubble law: it exceeds the ΛCDM comoving distance by about 1.2% at
  z = 0.05 and 2.3% at z = 0.1. Only 25 rows have z > 0.1.
- **Local Volume duplicates:** 161 rows have `lvIndex ≥ 0`. A duplicate needs vCmb < 3000 km/s
  and the nearest LV galaxy within 2′, or a matching name within 15′, and |cz − hrv| ≤ 400 km/s.
  - The name rescue exists for M51a, which UNGC places 2.35′ north of its nucleus.
  - The velocity guard rejected one chance alignment: a galaxy at cz = 2564 km/s next to the
    dwarf MCG +08-25-028.
  - For duplicates, 2MRS photometry at the LV distance reproduces UNGC log L_K to a median
    0.007 dex.
  - Render duplicates from `local-volume.json` instead of from 2MRS.
- **Erratum:** 2MASX J05332175-2156447 is NGC 1964. Its published cz = −248 km/s (6dFGS) is the
  spectrum of a foreground star 0.8″ from the nucleus, so the build uses 1656 km/s instead
  (SIMBAD; Meyer et al. 2004, HIPASS). This is recorded under `errata` in the manifest.
- **Clustering check (smoke):** Virgo has 152 galaxies within 6° at 800 < cz < 2800, 21× the mean
  of random equal-area caps. Coma has 125 galaxies within 2° at 5000 < cz < 9500, 24× the
  random-cap mean.

### Caveats (redshift space)

- **These distances are not measurements.** Each galaxy carries a peculiar-velocity error of
  about 200-600 km/s, which is 3-9 Mpc at this H0.
- **Fingers of God:** clusters are smeared along the line of sight. Virgo galaxies span
  cz = −261..+2800 km/s (σ ≈ 670 km/s, a ±10 Mpc smear) around a true distance of about 16.5 Mpc.
  Coherent infall squashes structures across the line of sight (the Kaiser effect).
- **Velocity floor:** 36 rows have vCmb < 100 km/s and are pinned to 1.478 Mpc. Most of them are
  LV duplicates. The 8 that are not are the blueshifted Virgo members M86, M90 and NGC 4419,
  plus 5 low-latitude sources with unconfirmed negative redshifts. They are listed in the
  manifest's `stats.velocityFloorWithoutLvMatch`.
- **Selection effects:** there are no galaxies at |b| < 5° (the zone of avoidance), and number
  density falls with distance because the sample is flux-limited. Morphological types are
  only about 60% complete, and nearly complete only for Ks ≤ 11.25 and |b| ≥ 10°.

## Licensing and attribution

The data come from CDS/VizieR. Under the
[VizieR terms](https://cds.unistra.fr/vizier-org/licences_vizier.html) they are free to use
in a scientific context provided the original authors and publications (including the
publisher, here the AAS journals AJ and ApJS) are explicitly cited. Commercial reuse is
subject to the originating publisher's policy. None of these catalogs' ReadMe files declares
a separate open licence. That differs from the CC BY-SA 4.0 HYG and AT-HYG star data, so
review it before any commercial distribution.

Suggested README text:

> Galaxy data: Updated Nearby Galaxy Catalog (Karachentsev, Makarov & Kaisina 2013, AJ 145, 101),
> McConnachie (2012, AJ 144, 4), and the 2MASS Redshift Survey (Huchra et al. 2012, ApJS 199, 26),
> with position angles from the 2MASS Extended Source Catalog (Skrutskie et al. 2006, AJ 131, 1163;
> Jarrett et al. 2000, AJ 119, 2498); CMB dipole and H0 from Planck 2018 (A&A 641, A1 and A6).
> This research has made use of the VizieR catalogue access tool, CDS, Strasbourg, France
> (DOI: 10.26093/cds/vizier). This publication makes use of data products from the Two Micron
> All Sky Survey, which is a joint project of the University of Massachusetts and the Infrared
> Processing and Analysis Center/California Institute of Technology, funded by the National
> Aeronautics and Space Administration and the National Science Foundation.
