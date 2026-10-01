# Close black-hole views

The named and placed black holes now share one analytic ray-based visual. A named Sgr A* previously used a 48×32 (mobile 24×16) horizon mesh, a vertex-interpolated Fresnel shell, a 96/48-segment annulus, and stretched additive jet sprites. A placed quasar instead used an enormous two-triangle disk plane and separate cone jets. Extreme approach exposed the angular primitives, their clipping boundaries and billboard behavior. The screen-space lens also clamped offscreen samples onto the framebuffer edge, stretching edge pixels into wedge-like regions.

## Rendering fix

- Camera position relative to the hole is subtracted in CPU doubles before division by the Schwarzschild radius. GPU work stays in horizon-sized coordinates.
- A screen-covering primitive computes disk intersections analytically per ray. Its geometric support cannot be cut into a diamond or hexagon by the near plane.
- The shadow uses a continuous angular boundary. Jets use smooth analytic axial emissivity instead of cones or stretched sprites.
- Orbit target and offset are kept separate before world-coordinate addition. Camera orientation uses the small offset. This is important for Gaia stellar-mass holes, whose horizons approach the precision of double coordinates thousands of light-years from the origin. Resolved surface materials likewise recompose their view translation from the residual.
- The screen-space background lens blends back to the unbent sample when the requested source lies outside the framebuffer; no clamped edge streaks. Its weak-field approximation fades near the hole instead of being extrapolated to the horizon.
- Beacons fade out when a hole resolves. Dormant Gaia BH1/BH2/BH3 have no invented accretion disk or jets. Sgr A* has a dim illustrative emission structure, clearly described in Object details. The placed quasar remains the existing explicitly jetted AGN preset.

## Scientific scope and closest supported view

The horizon is a boundary at r_s, not a material surface. The photon sphere at 1.5 r_s and distant shadow impact radius sqrt(27)/2 r_s are distinct. The angular shadow for a static Schwarzschild observer uses sin(alpha) = sqrt(27)/2 × r_s/r × sqrt(1-r_s/r), with the complementary branch below 1.5 r_s. It tends smoothly toward covering the inward sky near the horizon.

The orbit camera reaches 1.06 r_s. This is a visualization boundary outside the horizon; it is not a stable physical orbit or a safe hover location. At that distance an inward-facing view is predominantly black. Rim/outward views show the remaining escaping-sky region. No artificially luminous interior is fabricated to avoid that darkness.

Only the shadow angular law is the stated static Schwarzschild result. The straight disk intersections, emission profile, color/exposure, critical-curve glow, jet emissivity and screen-space background distortion are illustrative. The renderer does not solve null geodesics, Kerr spin, self-lensing disk images, scattering, or moving-observer near-horizon GR. Sgr A* is not directly visible as an optical orange ring; the displayed emitting structure is an explanatory visualization inspired by radio imaging. Dormant holes remain dark.

Physical dynamics, encounter contact conventions, TDE rates and existing radii are unchanged. In particular, legacy 1.5 r_s contact radii in physical catalog records are not silently altered by this rendering change.

Sources:
- Perlick & Tsupko, black-hole shadow review: https://arxiv.org/abs/2105.07101
- ESO, Sgr A* / M87* shadow distinction: https://www.eso.org/public/blog/spot-the-difference-sagittarius-a-m87/
- NASA, black holes: https://science.nasa.gov/universe/black-holes/
- ESA, dormant Gaia black holes: https://www.esa.int/Science_Exploration/Space_Science/Gaia/Sleeping_giant_surprises_Gaia_scientists

## Verification

See `scripts/smoke-hole-appearance.mjs` for numerical branch/limit checks and `scripts/capture-celestial-detail.mjs` for production-app screenshots at multiple distances, orientations, and viewport sizes. The gallery differentiates production captures from neutral-background silhouette diagnostics. Screenshot GPU timings collected under SwiftShader are software-renderer measurements, not physical-phone FPS claims.
