# 11 — Sphere metrics: the harness on spheres and the Phase 4d tuning

Scope: Phase 4d of the spherical worlds ([research 10](10-spherical-worlds.md) §7, §8 Phase 4). It covers how the M8 metrics harness ([research 09](09-m8-baseline.md)) measures a sphere, a baseline of the sphere pipeline as Phase 4c left it, what was tuned, and the result. The bar is the M8 one (PLAN.md §14): **≥ 90 % of seeds** per target, where it applies. Flat worlds are the reference: every number for flat worlds below comes from the same harness on the current generator, whose flat outputs did not change in this phase.

---

## 1. Running it

```
npm run metrics -- --shape sphere                  # 10 archetypes × 20 small-planet previews, build subset
                                                   # (earth, fjordland, desert × 4), planet sweep
                                                   # 2,048 / 4,096 / 8,192 / 12,000 km × 12 + equal-area flat worlds
npm run metrics -- --shape sphere --seeds 20 --build-seeds 3 --size-seeds 8      # the runs in this note
npm run metrics -- --shape sphere --archetypes earth --seeds 10 --pins peakHeight=2500:5000,glaciation=1
npm run metrics -- --shape sphere --planet-sizes 4096,8192 --equal-area 0 --seeds 0 --build-seeds 0
```

- `--shape sphere` runs the preview and build suites on spheres (default small planet, 4,096 km). `--seeds` defaults to 20 there.
- `--planet-sizes` sets the sweep (compared against 4,096 km). `--equal-area 1` (the default) also runs a flat world of the same area for each planet whose equal-area width √(4πR²) = C/√π fits the flat 4,096 km maximum: 1,155 km for the 2,048 km planet and 2,311 km for the small planet.
- `--pins k=v,k=a:b` pins parameters in every world, for experiments.

The report (`report.html`, `summary.md`) is the flat one with a G column and band section, and planet tags. The run in this note (257 worlds) takes **146 s** on 9 workers: about 2 s of generation per sphere preview, 17 s per build.

## 2. How a sphere is measured

`metrics/world.ts` keeps the flat code path as it was (its outputs are identical) and adds a sphere path. The geometry is in `metrics/lib/sphere.ts`, with unit tests in `tests/metrics.test.ts`.

- **Viewports are spherical caps.** A view is a W × H rectangle of an azimuthal-equidistant projection about its centre (`capView`), so the distance from the centre and lengths along the view's axes are true ground lengths. Features (anchors, path points), label anchors and big lakes are projected into the view as unit vectors. The land share and W contrast sample a lattice of view points at about the cell size. The empty-disk raster is unprojected per pixel.
  - Known bias: the projection stretches tangentially by θ / sin θ, up to 9 % at the corners of a 1,024 km view on the 652 km-radius planet and under 1 % for band R.
- **Centres.** Land views are centred on a land cell drawn ∝ its true area (`pickWeighted`), jittered inside it. Uniform views take an area-uniform random direction (`randomDir`). Views are never clamped. As on flat maps, a land view with under 10 % land is redrawn.
- **Bands.** R, A and L keep 250 / 60 / 16 km. **W is a fixed 1,024 km cap** (the size of the flat default world).
- **Band G** is the whole planet: an orthographic disc 2R across (`globeView`).
  - Features count while their surface faces the eye by ≥ 0.3, the labels' `GLOBE_MIN_FACING`. Points just past that rim (facing 0–0.3) are drawn into the empty-disk raster, so the rim does not create empty disks.
  - "Distinct" means at least 20 px at the registry's whole-planet scale (2.2 R / 700 m/px), about 2R/32 or 41 km on the small planet. On flat maps view/80 is the same 20 px on a 1600 px screen.
  - Target 15–40 (research 10 §7). Empty-disk cap 200 km × 2R / 1024 km ≈ 2R/5, the same fifth of the view as W, R and A.
  - Labels count at the registry's globe scale. G gets a quarter of the views, like W.
- **Areas and distances.**
  - Land, lake, island and continent areas use true cell areas, and shares are area-weighted (relief contrast, ice, quiet land, precipitation percentiles). Continents and islands are 4-connected components across seams.
  - Clark–Evans and nearest neighbours use great-circle distances over the land area, bucketed on a 3D lattice. Cluster disks are 100 km great-circle disks.
  - Quiet land paints features on the cube grid (polylines along their chords, disks through the grid's chart) and takes the geodesic `distanceField`.
  - Hero spacing is great-circle, as a fraction of the equal-area size.
  - The coast box-count dimension sums boxes per face; boxes do not straddle seams.
  - Stream lengths are 3D chords.
- **Per-world count rows** (research 05 §4 "per world") are for the 1024 km default world, so on a planet they scale with its area k = (S_eff / 1024 km)² (5.1 on the small planet). Fjord coast scales with √k. Major ranges and heroes use the world's resolved 🎯 / AUTO ranges (heroes 5–8 on spheres). Great rivers stay 1–3, because their length threshold already scales with the size (`sphereCountRange`). Per-land and per-coast rows are unchanged, now over true areas and true coast lengths.
- **New per-world fields:** shape, planet size, ice share of land (perennial snow ≥ 0.5), highest summit, land precipitation p99.9 / max, and the traits headline.
- **Size invariance** compares planets with the 4,096 km one. `shapeComparison` compares each planet with its equal-area flat world (R, A and L only; flat W is the whole map).

## 3. Baseline vs tuned (seeds 1–20, preview unless noted)

"Baseline" is the generator as Phase 4c left it (main at e0de384), measured with this harness. "Tuned" is the end of this phase. Flat values in brackets are the same archetypes on flat worlds (1024 km, preview).

### 3.1 Band pass (share of seeds whose own viewports pass count, empty disk and entropy)

| archetype | G | W | R | A | L |
|---|---|---|---|---|---|
| earth | 5 → **0** | 15 → **100** (95) | 0 → **0** (50) | 0 → **0** (0) | 0 → **0** (0) |
| archipelago | 0 → **5** | 0 → **90** (100) | 15 → **0** (65) | 0 → **0** | 0 → **0** |
| pangaea | 5 → **0** | 20 → **100** (95) | 0 → **0** (55) | 0 → **0** | 0 → **0** |
| rift | 5 → **40** | 10 → **100** (100) | 0 → **0** (55) | 0 → **0** | 0 → **0** |
| fjordland | 0 → **0** | 0 → **85** (95) | 0 → **0** (15) | 0 → **0** | 0 → **0** |
| desert | 10 → **20** | 10 → **100** (95) | 0 → **0** (5) | 0 → **0** | 0 → **0** |
| volcanic | 0 → **15** | 0 → **70** (100) | 25 → **0** (40) | 0 → **0** | 0 → **0** |
| iceage | 0 → **10** | 5 → **85** (80) | 0 → **0** (0) | 0 → **0** | 0 → **0** |
| hothouse | 5 → **5** | 55 → **100** (95) | 0 → **0** (75) | 0 → **0** | 0 → **0** |
| craton | 5 → **25** | 20 → **95** (95) | 0 → **0** (60) | 0 → **0** | 0 → **0** |
| earth (build) | 0 → **0** | 67 → **100** (100) | 0 → **0** (0) | 0 → **0** (0) | 0 → **0** (0) |
| fjordland (build) | 0 → **0** | 67 → **100** (100) | 0 → **0** (0) | 0 → **0** (0) | 0 → **0** (0) |
| desert (build) | 33 → **0** | 33 → **100** (100) | 0 → **0** (0) | 0 → **0** (0) | 0 → **0** (0) |

Which criterion fails (tuned, share of seeds passing count / empty disk / entropy):

| archetype | G | W | R |
|---|---|---|---|
| earth | 60 / 10 / 100 | 100 / 100 / 100 | 50 / 0 / 0 |
| archipelago | 90 / 5 / 100 | 90 / 100 / 100 | 50 / 5 / 10 |
| pangaea | 30 / 10 / 100 | 100 / 100 / 100 | 20 / 0 / 0 |
| rift | 60 / 60 / 100 | 100 / 100 / 100 | 25 / 0 / 0 |
| fjordland | 95 / 0 / 100 | 85 / 100 / 100 | 70 / 0 / 0 |
| desert | 80 / 30 / 100 | 100 / 100 / 100 | 5 / 0 / 0 |
| volcanic | 95 / 15 / 100 | 75 / 95 / 100 | 45 / 10 / 10 |
| iceage | 90 / 10 / 100 | 100 / 90 / 95 | 30 / 0 / 0 |
| hothouse | 70 / 15 / 100 | 100 / 100 / 100 | 10 / 0 / 0 |
| craton | 95 / 25 / 100 | 100 / 95 / 100 | 75 / 0 / 0 |

### 3.2 🎯 targets, relief contrast and detectors

| archetype | ranges | rifts | river dens. | > 2 km | king | boring | cluttered |
|---|---|---|---|---|---|---|---|
| earth | 90 → **100** (100) | 55 → **100** (100) | 100 → **100** (100) | 100 → **100** (85) | 0 → **90** (80) | 15 → **0** (15) | 100 → **0** (0) |
| archipelago | 100 → **100** | 95 → **100** | 100 → **100** | 100 → **90** (95) | 0 → **95** (80) | 10 → **10** (5) | 100 → **30** (0) |
| pangaea | 50 → **100** | 30 → **100** | 100 → **100** | 100 → **100** (95) | 0 → **85** (80) | 40 → **5** (5) | 100 → **0** (0) |
| rift | 70 → **100** | 10 → **100** | 100 → **100** | 100 → **100** (95) | 0 → **25** (60) | 5 → **0** (10) | 100 → **0** (0) |
| fjordland | 70 → **100** | 45 → **100** | 100 → **100** | 100 → **100** (95) | 0 → **85** (75) | 5 → **5** (5) | 100 → **20** (0) |
| desert | 65 → **100** | 25 → **100** | 80 → **100** | 100 → **65** (90) | 0 → **100** (90) | 0 → **35** (25) | 100 → **0** (0) |
| volcanic | 95 → **100** | 100 → **100** | 100 → **100** | 100 → **100** (95) | 0 → **40** (60) | 15 → **0** (10) | 100 → **40** (0) |
| iceage | 90 → **100** | 55 → **100** | 100 → **100** | 100 → **95** (85) | 0 → **90** (80) | 0 → **5** (15) | 100 → **0** (0) |
| hothouse | 90 → **100** | 55 → **100** | 100 → **100** | 100 → **100** (95) | 0 → **90** (80) | 20 → **0** (10) | 100 → **0** (0) |
| craton | 45 → **100** | 5 → **100** | 100 → **100** | 100 → **85** (85) | 40 → **100** (100) | 0 → **15** (15) | 100 → **0** (0) |

The other targets pass on 90–100 % of seeds on every archetype: continents, wetland share and heroes in their range (5–8 on spheres), before and after. Land under 300 m went from 60–100 % to 95–100 %. In the build subset every target passes on all 3 seeds of all 3 archetypes, except fjordland continents (2 of 3). Build worlds of earth and fjordland are still flagged cluttered for quiet land under 5 %, as every flat build is (research 09).

### 3.3 Relief, ice, band counts and labels (medians; counts p5 / p50 / p95)

| archetype | top peak (m) | p95 peak (m) | land > 2 km | ice share of land | W count | G count | W labels p95 | G labels p95 |
|---|---|---|---|---|---|---|---|---|
| earth | 8899 → **8622** | 7841 → **5244** | 0.20 → **0.09** | 0.20 → **0.08** | 33/51/73 → **28/40/48** | 16/35/51 → **28/47/63** | 106 → **46** | 69 → **32** |
| archipelago | 8743 → **8610** | 7329 → **5000** | 0.18 → **0.09** | 0.23 → **0.10** | 42/78/106 → **33/46/59** | 47/64/78 → **29/42/58** | 134 → **51** | 96 → **42** |
| pangaea | 8896 → **8596** | 7900 → **5322** | 0.23 → **0.11** | 0.18 → **0.06** | 31/46/65 → **24/37/48** | 22/35/45 → **38/53/67** | 102 → **45** | 62 → **29** |
| rift | 8916 → **8545** | 8098 → **5809** | 0.21 → **0.12** | 0.21 → **0.08** | 34/50/72 → **26/36/46** | 17/30/42 → **32/49/61** | 102 → **45** | 59 → **29** |
| fjordland | 8890 → **8574** | 7895 → **5292** | 0.20 → **0.10** | 0.23 → **0.11** | 33/59/86 → **30/43/56** | 17/36/49 → **22/39/53** | 111 → **47** | 71 → **33** |
| desert | 8798 → **8552** | 7112 → **4909** | 0.14 → **0.06** | 0.07 → **0.02** | 18/31/49 → **23/34/45** | 22/32/42 → **35/48/60** | 82 → **44** | 55 → **28** |
| volcanic | 8849 → **8618** | 8037 → **5964** | 0.20 → **0.11** | 0.29 → **0.17** | 45/73/113 → **34/47/61** | 35/57/71 → **25/42/53** | 128 → **52** | 92 → **41** |
| iceage | 8901 → **8627** | 7898 → **5159** | 0.19 → **0.08** | 0.31 → **0.19** | 37/57/87 → **29/40/51** | 16/32/50 → **25/43/57** | 113 → **46** | 70 → **32** |
| hothouse | 8899 → **8621** | 7759 → **5222** | 0.22 → **0.10** | 0.10 → **0.02** | 24/40/63 → **28/39/47** | 17/37/52 → **25/46/61** | 93 → **46** | 69 → **33** |
| craton | 8017 → **6341** | 5472 → **3225** | 0.06 → **0.01** | 0.08 → **0.03** | 24/40/71 → **24/35/46** | 19/37/51 → **26/45/59** | 102 → **45** | 69 → **31** |

The p95 peak is the highest summit divided by the king ratio. Flat worlds for comparison: p95 peak 4.6–5.3 km (craton 3.2), land > 2 km 0.07–0.13 (craton 0.02), ice 0.00–0.35 (fjordland and ice age 0.32–0.35, earth 0.06). The traits headline called the world "a world of ice" on 70 % of earth seeds, 85 % of pangaea, 95 % of rift, 100 % of fjordland and 25 % of hothouse seeds. It now does so on none, apart from 1 ice-age seed in 20.

Land precipitation (earth, mm/yr, p99.9 / max): small planet 11,100 / 12,500 → **8,200 / 9,600**; 8,192 km 24,000 / 33,000 → **9,200 / 12,400**; 12,000 km 25,000 / 35,000 → **8,700 / 10,100**. Flat earth at 1024 km is 5,200 / 5,700, but it has no tropics; flat hothouse reaches 16,000 / 18,000.

### 3.4 Counts against research 05 §4 (preview; archetypes with ≥ 90 % of seeds in range, of 10)

| row | target (sphere-scaled where per world) | baseline | tuned | flat |
|---|---|---|---|---|
| major ranges | resolved range | 5 | **10** | 7 |
| peaks > 3 km | 5–15 /10⁵ km² | 2 | **9** | 9 |
| ultra peaks | 1–2 /10⁵ km² | 0 | 0 | 0 |
| volcanoes | 41–127 per planet | 1 | 1 | 0 |
| lakes ≥ 1000 km² | 0–10 per planet | 4 | **7** | 10 |
| lakes 100–1000 km² | 1–3 /10⁵ km² | 1 | **3** | 0 |
| canyons | 5–20 per planet | 3 | **6** | 7 |
| waterfalls | 3–8 /10⁵ km² | 10 | 8 | 9 |
| deltas | 5–25 per planet | 6 | 5 | 8 |
| islands 100–10⁴ km² | 2–5 /10⁵ km² | 4 | 3 | 0 |
| rivers ord 5–6, rivers to the sea, lakes < 100 km², islands < 100 km², peninsulas, great rivers | | 0 | 0 | 0–3 |
| calderas, craters, islands > 10⁴ km², fjord coast, ergs, atolls, heroes | | 9–10 | 9–10 | 9–10 |

### 3.5 Size invariance and the equal-area flat world (earth, 8 seeds)

- **Planet sweep:** 4 of 28 rows are within tolerance (baseline 1 of 28; the flat preview sweep in research 09 had 5 of 26). Sphere previews are always 6 × 128², so cells grow from 4 km (2,048 km planet) to 23 km (12,000 km). Lakes under 100 km², order-5–6 rivers, A and L counts, peaks and waterfalls all fall with resolution. The rows that hold are wetland share, land under 300 m, and W count and empty disk (43 / 39 / 40 / 34 features, 135–149 km).
- **Highest summits** are 8.4–8.7 km at every size (baseline 8.4–9.0 km with p95 peaks of 8.9 km at 8,192 km and up). The p95 peak is 5.1 / 5.3 / 4.9 / 4.8 km and the land above 2 km is 0.10 / 0.10 / 0.07 / 0.07.
- **Equal-area flat world:** 9 of 30 rows within tolerance (baseline 13 of 30). This is expected: the tuning matched the spheres to the *default* flat world (1024 km), not to flat worlds of 1,155 or 2,311 km.
  - Flat AUTO formulas were tuned on 512–2048 km. At 2,311 km a flat world shows the same over-relief the baseline spheres had: p95 peak 7.9 km, land above 2 km 0.21, ice 0.17. The tuned planet has 5.3 km, 0.10 and 0.08.
  - At 2,048 km against the 1,155 km flat world:
    - within ±10 %: peaks per area (−9 %), the highest summit (+3 %), land above 2 km (+4 %), the R count (+3 %), and the R and A empty disks (−5 % and −7 %);
    - within ±20 %: the L empty disk (−13 %), lakes (+17 %), glaciers (−19 %) and land under 300 m (−16 %);
    - further apart: ice (+24 %), canyons, and the rates per coast km.

## 4. What was tuned (all sphere-only; flat outputs byte-identical)

1. **Relief** (`stages/base.ts`, `schema.ts`).
   - `upliftForPeak` integrates from the first resolved cell, and the erosion model built far more relief than the calibration predicts on 8 km cells: every range reached the 8.9 km summit ceiling (p95 peak 7.8 km). Flat worlds of the same cell size do the same (flat 2,311 km: 7.9 km).
   - Spheres now cap that first cell at 2.5 km, and shrink it in proportion beyond 8 km cells (s0 · cell = 2.5 km × 8 km), so p95 peaks are 4.8–5.3 km at every planet size.
   - The king massif keeps the true cell size, so it still stands at the ceiling.
   - The peakHeight size bonus (+500 m per doubling) is gone on spheres.
2. **Ice** (`schema.ts` glaciation).
   - The sphere formula read 90° as the poleward reach, which added 1.1 to every archetype: earth 1.7, fjordland 1.8, iceage at the clamp of 2, hothouse 1.05. Each unit moves the ELA by 2 °C, so even hothouse planets had 10 % ice.
   - Spheres now read the Earth-like 65°, because the climate's own poles supply the polar cold. That gives earth 1.0 (as on flat maps), fjordland 1.1, iceage 1.5 and hothouse 0.35.
   - Ice share of land: earth 8 %, fjordland 11 %, iceage 19 %, hothouse 2 % (Earth: ~10 %). No ice-sheet cap was needed. With the lower peaks, non-polar ice no longer makes "a world of ice".
3. **Precipitation** (`climate/model.ts`, `advect.ts`).
   - Coarse planets (16–23 km preview cells) concentrated tropical snow-out and uplift into single cells: 33,000 mm/yr. The flat storm blur (σ 8 km) is under a cell there. Spheres now blur by at least one sweep cell.
   - Upwind weights are area-aware: each face's flux is the wind component times the face length, |gx|·hy : |gy|·hx. This cut the water world's zonal spread from ±17 % to ±15 % (the test now asserts a 5–95 % range < 35 %). The rest is first-order upwind diffusion that depends on the wind's angle to the face axes, which only a higher-order scheme would remove.
4. **Lakes** (`stages/hydro.ts`). A pit is at least one cell, so 8 km previews had 2–3× the lakes ≥ 100 km² per area of the 2 km build. Lake density now scales by max(0.5, min(1, 4 km / cell)). The registry's drainage-density check uses a coefficient measured on spheres (0.57 instead of 0.55). Sphere networks run ~3 % denser at the same channel-head area; the coefficient only scales the reported ratio.
5. **The world band in the registry** (`registry/budget.ts`, `fill.ts`, `rank.ts`).
   - The W budget, the world fill and the W label tier now work at the 1,024 km W cap. The W fill starts 205 km from W-scale features.
   - The W budget has a per-planet quota of 50 per (1,024 km)². A local cap keeps fewer than 40 W-scale features within 512 km, counting the external lakes, rivers and landform places.
   - W-band labels (≥ 640 m/px) keep their band while fewer than 35 others lie within 512 km.
   - The globe label cap is 36 plus heroes, continents and oceans. The old cap was 2 × 45, and on land-centred globes up to 96 labels were in view.
   - A second fill at the globe scale names cover in interiors far from any globe-scale feature.
   - The fills' geodesic distance field is now updated around each new mark instead of being recomputed. Despite the extra work, the sphere registry is slightly faster than in Phase 4c (−3 % preview, −2 % build).
6. **Plates** (`stages/plates.ts`).
   - Euler-pole motions over ~9 plates open more long continental rifts than any of 16 candidates kept in range: rifts were met on only 5–55 % of seeds on 8 of the 10 archetypes.
   - Spheres now try 64 candidates, then turn the weakest excess long rifts and ranges into transforms, down to min(range max, drawn + 1).
7. **True areas and lengths.**
   - Coast lengths sum each sea edge's true length (classify, cliffs, the sandy-coast rates of spits and barriers); the nominal sum was ~8 % long.
   - Merge-tree thresholds in the registry use the mean cell area (seas, straits, isthmuses, range cores, fill footprints); the nominal area was ~18 % high on average.
8. **Preview canyons** (`registry/rivers.ts`). The rim search used the 3 × 3 regional cells, 8–11 km out on 8 km cells. Spheres now count a neighbour's rise in proportion to how much of its distance lies inside 6 km. That is all of it on ≤ 4 km cells, as on flat maps.
9. **Globe labels at the limb** (`render/labels/labelEngine.ts`). A point label whose boxes reach past the planet's disc on screen is not drawn. The limb is the tangent point in the plane of the eye, the centre and the anchor, so this is exact under perspective. Tested with a long name at 55° from the view centre.

## 5. What still fails, and why

- **Band G (0–40 %).** Counts pass on 30–95 % of seeds. Empty disks fail on 40–100 %.
  - A hemisphere holds about 2.4 W views of land, so G sees all the ≥ 41 km features of several W views: p50 39–53, p95 53–67 against 15–40.
  - Interiors keep 250–450 km disks with no globe-scale feature (cap 2R/5 = 261 km). The registry's features are W-sized, and the globe fill only partly closes the gaps without adding too many features.
  - Passing G would need a hierarchy: fewer, larger features at globe scale (merged forest belts, named regions of whole continents) rather than more of the W-scale ones. The G targets are research 10's first cut and are kept as they are.
- **R, A and L in previews (0 %).** Sphere previews have 8 km cells, twice the flat preview's 4 km. Order-≥ 4 rivers, lakes under 64 km² and summits are under-resolved, so R views hold 15 features (flat 21) with empty disks of 46 km (flat 37). A and L are 0 % in previews on flat maps too, by construction.
  - In builds (2 km cells) R empty disks pass on 100 % of seeds, as on flat builds. R counts fail on p95 (> 37.5) on both shapes.
  - A larger sphere preview grid (6 × 192²) would cost about 2.3× the preview time and was not done.
- **W on volcanic (70 %), fjordland and iceage (85 %).** The remaining overflow comes from features the budget cannot drop: lakes on the glaciated land of volcanic and ice-age planets (11–12 per view), and the rias of fjordland (10 per view).
- **King on rift (25 %) and volcanic (40 %).** These have the highest p95 peaks (5.8–6.0 km) and the king stands at the ceiling, so the ratio sits just under 1.5. Flat worlds manage 60 % on both.
- **Desert land > 2 km (65 %, flat 90 %).** The share sits around the 5 % threshold (median 6 %). Boring desert seeds (35 %, flat 25 %) are the same seeds.
- **Count rows** fail as on flat worlds: ultra peaks are 2–17 against 1–2 per 10⁵ km², too few order-5–6 rivers, rivers to the sea and small lakes and islands at preview resolution, and too few peninsulas. Volcanoes are per planet 10–70 against 41–127 (scaled ×5.1). Only the volcanic archetype reaches it; flat worlds miss the 8–25 band the same way.
- **Size invariance.** It is not reachable with a fixed preview grid, as on flat maps (§3.5).

## 6. Performance and flat identity

- Flat golden hashes (`tests/golden.json`) were not re-recorded and pass. Only `tests/golden-sphere.json` was re-recorded (`GOLDEN_UPDATE=1 npx vitest run tests/golden.test.ts -t sphere`).
- Flat `npm run bench` against main (e0de384), two interleaved alternations, seeds 7 + 11: preview total −0.5 %, build total −0.4 %. Every stage is within noise; the registry is −7 % / +0.2 %, helped by the W budget's incremental nearest-feature distances, which give the same minimum as a scan.
- The flat registry's +12 % in builds since Phase 4c (≈ 45 ms, 0.3 % of a build) is still there. Measured against the commit before 4c, it sits in the rivers (+9 ms) and ranking/naming (+6 ms) sub-laps, where per-node loops now go through the shared `Geo` distance. It was left as it is.
- Sphere `npm run bench -- --shape sphere` (seeds 7 + 11, 3 runs) against main:
  - preview 3.59 → 3.65 s: plates +20 ms for 64 motion candidates, hydro +56 ms, registry −19 ms;
  - build 33.8 → 33.5 s.
