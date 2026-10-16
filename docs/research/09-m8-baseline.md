# 09 — M8 baseline: density and quality metrics

Scope: the first run of the M8 metrics harness (`npm run metrics`) over the 10 archetypes. It covers how the harness measures, the baseline numbers, which targets pass or fail per archetype, the worst seeds, and a ranked list of tuning changes. Nothing in `src/` was changed for this note; the numbers describe the generator as of 2026-10-16.

Targets come from research 05 (§3.2 bands, §3.3 clustering and quiet zones, §3.6 contrast, §4 counts, §5 validation), PLAN.md §4/§12/§14 and CONFIG.md §4/§8. "Pass" means the M8 bar: **≥ 90 % of seeds** (PLAN.md §14).

---

## 1. Running it

```
npm run metrics                        # default suite: 10 archetypes × 40 preview seeds,
                                       # build subset (earth, fjordland, desert × 4),
                                       # size sweep (earth 512/1024/2048 × 12, preview)
npm run metrics -- --seeds 10 --archetypes earth,desert --build-seeds 0 --size-seeds 0
npm run metrics -- --size-mode build-const --size-seeds 3 --seeds 0 --build-seeds 0   # 1 km-cell size sweep
```

All options are listed at the top of `metrics/cli.ts`. Output goes to `metrics/out/`:
- `report.html`: a self-contained page with no scripts. It has tables per band and archetype, inline SVG histograms, target satisfaction, counts against research 05 §4, and flagged seeds with links.
- `summary.md`: the headline tables.
- `summary.json`: the aggregates.
- `metrics.json`: every world, including the raw viewport samples.

**Runtime:** the default suite (448 worlds) takes **89 s** on 9 worker threads on a 10-core Mac, about 1.6 s per preview world and 12 s per build world. The size sweep in build mode at 1 km cells (9 worlds, up to a 2048² macro grid) takes 43 s. `tests/metrics.test.ts` takes about 9 s (2 archetypes × 3 seeds, in-process).

**How TS runs in node:** `node --experimental-transform-types --import ./metrics/register.mjs`. The register hook resolves this repo's extensionless imports to `.ts`. Node 24 transform-types also handles the parameter properties in `Pipeline`. Worker threads get the same flags through `execArgv`. Type-check the harness with `npx tsc -p metrics/tsconfig.json --noEmit`. It uses a small Node shim, `metrics/node.d.ts`, because the repo has no `@types/node`.

## 2. What is measured

Each world runs `new Pipeline(STAGES).run(resolve(spec), mode, …)` and is measured in `metrics/world.ts`:

- **Counts and rates.** These are counts per landmark kind and tier, plus stage-stat features: volcanoes, calderas, craters, fjords and fjord-coast km, deltas, estuaries, lakes and islands by size class, waterfalls, atolls, reefs, barrier islands, lagoons, rias, sea stacks, mesas, dolines, glaciers and Strahler streams by order. Each is normalised per 10⁵ km² of land, per 1000 km of coast (landforms `coastKm`), or per 10⁵ km² of warm ocean. Islands are the 4-connected non-ocean components below 5 % of the land, the same rule refine uses for continents.
- **🎯 targets.** `continentCount`, `mountainRangeCount` and `riftCount` count as met when the realised value lies in the resolved range, the config panel's ✓ rule. The table also shows a secondary rule: equal to the drawn value, or within ±1 of it. `riverDensity` is met when the hydro outcome (realised / expected drainage density) is within ±10 % of 1. `wetlandShare` is met within ±10 % of the resolved value.
- **Interest budget (research 05 §3.2).** Each band gets 64 land-weighted and 32 uniform viewports per world. W gets a quarter of that, because the view spans the whole world width and only slides vertically. Views are 16:10 and the widths are W = world width, R = 250 km, A = 60 km and L = 16 km. A **distinct feature** is one of the following, provided its characteristic size lies in [view/80, view × 1.5]:
  - a landmark (except rivers and lakes);
  - a Strahler stream (a maximal run of one order) of order ≥ 6 / 4 / 2 / 1 for W / R / A / L;
  - a lake from the lake list, using √area;
  - a landform feature that has no landmark: sea stack, spit, tombolo, barrier island, inselberg, ria, cinder field, cenote, geothermal.

  Sea cliffs and escarpments are excluded because they are shoreline character, about 28 per W view. For each viewport the harness records:
  - the count;
  - the Shannon entropy of the classes;
  - the CV of counts on a 4 × 4 grid;
  - the largest empty disk on land, from an exact EDT of the rasterised feature mask (96 px across the view with a 24 px margin);
  - label candidates (landmarks whose `maxMpp` admits them at 1600 px);
  - for W only, the number of contrast items.

  Viewports with < 10 % land are scored separately as ocean views.
- **Per-seed band pass.** A seed passes a band when count p5 ≥ lo, count p95 ≤ 1.5 · hi, ≥ 95 % of its land views have an empty disk ≤ cap, and ≥ 90 % of its views reach the entropy threshold.
- **Clark–Evans** (no edge correction) is computed on land area for volcano edifices, lakes, labelled peaks and craters.
- **Contrast (§3.6).** The rules are: land < 300 m ≥ 25 %, land > 2000 m ≥ 5 %, king summit / p95 peak ≥ 1.5, and W views with ≥ 2 of {max land height ≥ 2000 m, ≥ 5 % open water or a lake ≥ 100 km², ≥ 2 biomes each ≥ 10 % of the view's land}.
- **Geomorphic realism.**
  - Horton R_b and the Hack exponent come from the hydro stats.
  - The lake Pareto b and island Korčák b are CCDF log-log fits over sizes ≥ 2 cells.
  - The coastline D is a box count of coast cells, with box sizes 1 to n/8.
- **Quiet land** is land farther than 20 km from any feature (rivers of order ≥ 4 only).
- **Boring seed** (any one rule): W p50 < 15, no hero, < 25 % of land under 300 m, < 5 % over 2000 m, one biome > 70 % of land, or no lake ≥ 100 km² and no river of order ≥ 6.
- **Cluttered seed** (any one rule): a W view with > 60 features, label candidates p95 > 60 in any band, quiet land < 5 %, or more than 36 volcanoes / 90 peaks / 150 lakes in one 100 km disk.
- **Size invariance (§5.5).** Rates are compared at 512 / 1024 / 2048 km. The tolerance is ±20 % for rates and ±15 % for same-band viewport metrics.

**Resolution caveat.** Preview runs on a 256² grid, which is 4 km cells at 1024 km. That is too coarse for the L band (a 16 km view is 4 cells), for lakes and islands under 16 km², and for Strahler orders, Hack and "rivers to sea", all of which shift with cell size. The build subset (1 km cells) is the reference for the A and L bands and for those counts. L also lacks everything that only the detail pass makes (creeks, ponds, ravines), which the pipeline does not output. **L-band failures are therefore partly by construction** until the harness samples the detail pass; see §5.

## 3. Baseline (2026-10-16, seeds 1–40)

### 3.1 Seed pass rates

| archetype | W | R | A | L | continents | ranges | rifts | river dens. | wetland | < 300 m | > 2 km | king | boring | cluttered |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| earth | 15% | 0% | 0% | 0% | 95% | 95% | 75% | 75% | 100% | 100% | **0%** | 8% | 100% | 98% |
| archipelago | 48% | 0% | 0% | 0% | **68%** | 95% | 98% | **0%** | 100% | 100% | 3% | 5% | 100% | 55% |
| pangaea | 38% | 0% | 0% | 0% | 90% | 85% | 57% | 100% | 100% | 100% | 3% | 3% | 98% | 98% |
| rift | 10% | 0% | 0% | 0% | 95% | 100% | 75% | 100% | 100% | 100% | 0% | 3% | 100% | 100% |
| fjordland | 3% | 0% | 0% | 0% | **75%** | 100% | 68% | **0%** | 100% | 100% | 0% | 3% | 100% | 100% |
| desert | 33% | 0% | 0% | 0% | 98% | 85% | 68% | 100% | **23%** | 100% | 0% | 3% | 100% | 68% |
| volcanic | 10% | 0% | 0% | 0% | 85% | 78% | 100% | **10%** | 100% | 100% | 5% | 0% | 95% | 90% |
| iceage | 0% | 0% | 0% | 0% | 95% | 95% | 75% | **5%** | 100% | 100% | 0% | 8% | 100% | 100% |
| hothouse | 15% | 0% | 0% | 0% | 95% | 95% | 75% | 95% | 100% | 100% | 0% | 5% | 100% | 100% |
| craton | 53% | 0% | 0% | 0% | 88% | 83% | 63% | 95% | 100% | 100% | 0% | 35% | 100% | 88% |
| earth (build) | 0% | 0% | 0% | 0% | 100% | 100% | 75% | 75% | 100% | 100% | 0% | 0% | 100% | 100% |
| fjordland (build) | 25% | 0% | 0% | 0% | 100% | 100% | 75% | 0% | 0% | 100% | 0% | 0% | 100% | 100% |
| desert (build) | 25% | 0% | 0% | 0% | 100% | 100% | 75% | 100% | 0% | 100% | 0% | 25% | 100% | 75% |

Only two rules pass everywhere: the < 300 m share (it passes far too easily, at 69–95 % of land) and W views having ≥ 2 contrasts (≥ 98 %). None of the 🎯 targets reach 90 % in every archetype.

### 3.2 Pooled land-viewport counts (p5 / p50 / p95)

| archetype | W (15–40) | R (10–25) | A (8–20) | L (6–20) | empty ≤ cap: W / R / A / L |
|---|---|---|---|---|---|
| earth | 42 / 63 / 89 | 4 / 13 / 38 | 2 / 5 / 10 | 0 / 2 / 4 | 95 / 23 / 2 / 0 % |
| archipelago | 44 / 58 / 81 | 5 / 15 / 40 | 1 / 4 / 9 | 0 / 1 / 4 | 100 / 33 / 4 / 0 % |
| pangaea | 39 / 56 / 75 | 4 / 12 / 36 | 2 / 5 / 10 | 0 / 2 / 4 | 97 / 13 / 2 / 0 % |
| rift | 49 / 70 / 92 | 4 / 12 / 34 | 2 / 5 / 10 | 0 / 2 / 4 | 91 / 14 / 2 / 0 % |
| fjordland | 56 / 78 / 99 | 17 / 43 / 68 | 1 / 7 / 13 | 0 / 2 / 4 | 94 / 78 / 6 / 0 % |
| desert | 33 / 49 / 79 | 3 / 8 / 23 | 2 / 5 / 9 | 0 / 2 / 4 | 70 / 7 / 2 / 0 % |
| volcanic | 49 / 74 / 98 | 7 / 17 / 35 | 1 / 5 / 10 | 0 / 2 / 4 | 100 / 48 / 5 / 0 % |
| iceage | 68 / 91 / 122 | 7 / 40 / 80 | 2 / 7 / 13 | 0 / 2 / 4 | 97 / 68 / 11 / 0 % |
| hothouse | 45 / 65 / 94 | 5 / 13 / 29 | 2 / 5 / 10 | 0 / 2 / 4 | 99 / 20 / 2 / 0 % |
| craton | 33 / 49 / 74 | 4 / 13 / 35 | 2 / 5 / 10 | 0 / 2 / 4 | 96 / 16 / 2 / 0 % |
| earth (build) | 38 / 62 / 86 | 11 / 23 / 45 | 13 / 23 / 33 | 4 / 9 / 13 | 100 / 89 / 93 / 0 % |
| fjordland (build) | 37 / 72 / 100 | 10 / 29 / 45 | 4 / 28 / 49 | 3 / 10 / 15 | 100 / 76 / 64 / 0 % |
| desert (build) | 35 / 48 / 62 | 5 / 10 / 24 | 4 / 9 / 13 | 1 / 3 / 6 | 55 / 9 / 10 / 0 % |

The table reads as follows:
- **W is 1.5–2.5× too busy.** The earth W view holds on average 12 bays, 6.6 peninsulas, 4.6 islands, 4.4 volcanoes, 4.1 barrier islands, 3.6 wetlands, 2.2 karst regions, 2.1 lakes, 2.1 ranges and 1.9 peaks. Label candidates per W screen run at p50 56–100.
- **R has the right median but a far too wide spread.** p5 is 4 and p95 is 38, and the empty disk p50 is 57–72 km against a 50 km cap. Peaks, lakes and rivers fill R; the gaps between orogens and lake districts are empty. Iceage and fjordland are the exception: lake districts push R to p50 40–43 (29–30 lakes per view).
- **A and L are resolution-limited in preview** (only ~5 features, nearly all rivers). In build, A is close to target (13 / 23 / 33, empty disk 93 % ok on earth) but has almost zero entropy: rivers are 21.5 of 23 features. L in build is 4 / 9 / 13 with an empty disk p50 of 4.1 km against a 3 km cap. Nothing but creeks exists at L.
- **Spatial CV** at W is p50 0.65–1.1 (in range). R runs 0.85–1.44 and A/L 1.3–1.9: too clumped, because the views are mostly empty with a few rivers.

### 3.3 Counts against research 05 §4 (preview median per 10⁵ km² land, share of seeds in range)

| row | target | earth | archip. | pangaea | rift | fjordl. | desert | volcanic | iceage | hothouse | craton |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Peaks > 3 km | 5–15 | 1.4 (10%) | 2.7 | 2.2 | 4.7 (43%) | 3.1 | 1.3 | 5.1 (50%) | 1.6 | 1.9 | 0 |
| Volcanoes / world | 0 or 8–25 | 7 (45%) | 10.5 | 5 | 8 | 9 | 5.5 | 18.5 (68%) | 7 | 7 | 2.5 |
| Rivers ord ≥ 7 / world | 1–3 | 0 (0%) everywhere | | | | | | | | | |
| Rivers ord 5–6 | 7–10 | 0.6 | 0 | 1.0 | 0.8 | 0 | 1.1 | 0 | 0.2 | 0.5 | 0.6 |
| Rivers ord ≥ 3 to sea / 1000 km coast | 20–50 | 5.8 | 1.4 | 7.7 | 6.8 | 0.5 | 7.8 | 3.1 | 4.3 | 6.0 | 6.8 |
| Lakes 10–100 km² | 8–20 | 11.6 (68%) | 14.4 | 10.7 | 11.0 | **146** | **0.35** | 11.0 | **90** | 6.8 | 13.5 |
| Lakes 100–1000 km² | 1–3 | 0.95 (40%) | 0.74 | 1.1 | 1.1 | **8.9** | 0 | 1.8 | **13.7** | 0.7 | 0.5 |
| Islands 1–100 km² | 15–40 | 8.4 | 74 | 4.2 | 5.8 | 74 | 4.3 | 21 (85%) | 8.7 | 8.5 | 9.5 |
| Peninsulas / 1000 km coast | 1–3 | 1.0 (55%) | 0.76 | 0.9 | 1.0 | 0.74 | 1.0 | 1.2 | 1.0 | 0.9 | 1.2 |
| Canyons / world | 1–4 | 0 (43%) | 0 | 2 | 3 (93%) | 0 | 1 | 1 | 0 | 1 | 0 |
| Waterfalls (labelled) | 3–8 | 3.8 (68%) | 4.9 | 3.7 | 4.7 | 4.9 | **0** | 4.9 | 2.4 | 4.9 | **0.5** |
| Deltas / world | 1–5 | 0 (43%) | 0 | 1 | **9** | 0 | 0 | 2 | 0 | 3 | 0 |
| Heroes 3–5 | 3–5 | 100% | **33%** (p50 2) | 100% | 100% | 80% | 100% | 75% | 97% | 100% | 88% |

The build subset changes the resolution-limited rows. Earth (build) has rivers ord 5–6 at 8.1 / 10⁵ (in range), 20 rivers to the sea per 1000 km of coast (in range), lakes 1–10 km² at 46 / 10⁵ (target 60–150), islands 1–100 km² at 12.9 / 10⁵, Hack 0.54 (in range) and Korčák 0.56 (in range). Max Strahler order is still 6, so **no world has an order-7 river at either resolution**.

### 3.4 Geomorphic realism and clustering (preview p50; pass share)

| | target | earth | archip. | fjordland | iceage | volcanic | craton | earth (build) |
|---|---|---|---|---|---|---|---|---|
| Horton R_b | 3–5 | 5.0 (50%) | 6.8 (0%) | 9.7 (0%) | 5.6 | 5.6 | 5.0 | 4.9 (75%) |
| Hack h | 0.5–0.62 | 0.68 (7%) | 0.72 | 0.20 | 0.44 | 0.66 | 0.68 | 0.54 (100%) |
| Lake Pareto b | 0.7–1.2 | 1.15 (53%) | 1.70 | 2.07 | 1.52 | 0.91 | 0.99 | 0.86 (75%) |
| Korčák b | 0.45–0.8 | 0.82 (42%) | 0.87 | 0.72 | 0.79 | 0.71 | 0.88 | 0.56 (100%) |
| Coast D | 1.1–1.35 | 1.11 (53%) | 1.19 | 1.24 | 1.13 | 1.09 | 1.11 | 1.10 (50%) |
| Clark–Evans volcano | 0.4–0.8 | 1.02 (28%) | 1.96 | 1.33 | 1.02 | 1.51 (5%) | 1.63 | 0.72 |
| Clark–Evans lake | 0.3–0.7 | 0.74 (33%) | 0.98 | 1.09 (0%) | 0.97 (0%) | 1.06 | 0.64 | 0.96 |
| Clark–Evans peak | 0.5–0.9 | 0.69 (97%) | 1.13 | 0.81 | 0.71 | 1.10 | 0.85 | 0.83 |
| Quiet land | 0.10–0.25 | 0.32 | 0.27 | 0.05 | 0.13 | 0.19 | 0.36 | 0.09 |

Coast D is measured at cell scale (4 km in preview, 1 km in build), so it sits at the bottom of the range; only fjordland reaches 1.24–1.31. Crater Clark–Evans passes, but n ≤ 3 per world except on craton (n 22 over the run, 95 %).

### 3.5 Relief contrast (the dominant failure)

The median share of land above 2000 m is **0.4–2.5 %** (target ≥ 5 %), and the share below 300 m is **69–95 %**. The king summit is a median 4.0–4.4 km in most archetypes (rift 5.3, craton 2.2), but the king / p95 ratio is 1.1–1.35 (target ≥ 1.5). The relief rule alone flags **every** seed as boring, which hides the other boring reasons, so it is worth reading them separately:
- Rift: one biome over 70 % (tropical rainforest) in **34/40**.
- Desert: hot desert over 70 % in 13/40.
- Desert, archipelago and craton: no lake ≥ 100 km² and no river of order ≥ 6 in 10, 15 and 5 of 40.

### 3.6 Size invariance

- **Preview (fixed 256² grid, cells of 2 / 4 / 8 km):** only 4/26 rows are within tolerance. This sweep mostly measures resolution, so do not tune against it.
- **Build at constant 1 km cells** (`--size-mode build-const`, 3 seeds): 12/26 rows are within tolerance.
  - Every viewport metric is within ±13 %. The R / A / L counts and empty disks are size-invariant.
  - So are rivers to the sea, peninsulas, wetland share and lakes 10–100 km².
  - The failures are mostly **per-world caps in the registry**. Peaks fall from 13.6 to 3.6 per 10⁵ km² at 2048 km (`cap = min(60, …)`). Waterfalls and canyons fall by 60–70 %, and volcanoes change by 58 %.

### 3.7 Worst offenders (preview; links are `?seed=…&a=…`)

| what | seeds |
|---|---|
| Busiest W view (p50 count) | iceage 5 (150), iceage 22 (126), iceage 4 (115), iceage 34 (114), volcanic 20 (113) |
| Most labels per W screen (p95) | iceage 5 (138), iceage 22 (130), iceage 20 (127) |
| Busiest R view (p50 count) | iceage 22 (63), iceage 15 (60), iceage 40 (59) |
| Lake cluster (lakes in one 100 km disk) | iceage 5 / 20 (82), craton 23 (80), iceage 14 / 34 (79) |
| Emptiest W view (empty disk) | desert 4 (331 km), desert 36 (307), desert 40 (302), desert 37 (290) |
| Emptiest R views (p50 empty disk) | archipelago 30 (93 km), archipelago 3 (87), desert 25 (84), archipelago 37 (83) |
| Sparsest W view (p50 count) | desert 8 and 26 (30), archipelago 26 (31), craton 40 (31) |
| Single-biome worlds | desert 8 (95 % hot desert), desert 29 (89 %), rift 39 / 19 / 29 (88 % rainforest) |
| Continents over range | fjordland 39 (+3), fjordland 6 / 11, volcanic 16, archipelago 23 (+2) |
| Rifts over range | rift 11, pangaea 26 / 36 / 39, desert 26 (+3) |
| River-density outcome | fjordland 39 (0.36), 11 (0.37), 5 (0.38) |
| No quiet land | fjordland 30 / 25 / 27 / 10 / 21 (3 %) |
| Heroes | archipelago 1 / 3 / 5 / 21 / 23 / 26 (1 hero) |
| Flattest | craton 1–4 (0.0 % > 2000 m), earth 5 |

## 4. Tuning recommendations (ranked by how many failing seeds each fixes)

The numbers below are first guesses meant to move each metric to its target. Re-run `npm run metrics` after each one; the harness was built for this loop.

1. **Raise orogen relief.** This fails in 100 % of seeds in every archetype and causes every "boring" flag.
   - In `src/gen/stages/base.ts` (`baseStage.run`, the `B.COLLISION` / `B.SUBDUCTION` branch), multiply `U0` by **≈ 1.6**.
   - Lift the `along` floor from `0.55 + 0.45·ridged` to `0.7 + 0.3·ridged`.
   - Start the `gap` smoothstep at `-0.75` instead of `-0.55`, so fewer stretches of the range belt are switched off.
   - Widen the `rangeWidth` AUTO in `src/shared/config/schema.ts` (`id: 'rangeWidth'`) from ~0.15–0.3× to **0.22–0.4× `rangeLength`**.
   - Goal: land > 2000 m from ~0.7 % to ≥ 5 %, and peaks > 3 km from 1.4 to ≥ 5 per 10⁵ km² (about 20 per default world).
   - Check that `lem.ts` (`refineStage`) does not erode the gain away; the preview LEM runs `0.6 × lemIterations`.

2. **Give each world a king summit.** king / p95 is 1.1–1.35 against a target of 1.5.
   - In `base.ts`, pick the highest-`sp.peak` collision or subduction segment (or the hero massif when one is drawn) and scale its `sp.peak` by **1.35** before `upliftForPeak`. Leave the other segments as they are.
   - This also feeds the "great massif" hero in `src/gen/registry/relief.ts`.

3. **Cut background lowland.** 69–95 % of land is below 300 m.
   - In `base.ts`, raise `uBg = upliftForPeak(250 + 700·(1 − age), …)` to **`400 + 900·(1 − age)`**.
   - Raise the `hilly` floor from `0.12` to `0.25`, so quiet plains become ~40–55 % of land instead of ~80 %. Research 05 §3.3 wants quiet zones at 10–25 % of land, and the preview quiet share is 27–36 % on continental archetypes.

4. **Put a W-band label and feature budget into the registry.** W p50 is 49–91 against 15–40, and label candidates are 56–100 per screen.
   - In `src/gen/registry/rank.ts`, after ranking, keep `maxMpp ≥ W_BAND_MPP` only for the top **~35** landmarks by importance (plus heroes and the king). Clamp the rest to `W_BAND_MPP / 2`. Apply the same rule at R (top ~25 inside any 250 km window if this is cheap; otherwise raise `PX_TO_READ` from **23 to 35**).
   - Bays are the largest W class (~10–12 per view). In `src/gen/registry/water.ts` (the bay/gulf pass), raise the minimum bay area `minKm2` so that only bays with `extentM ≥ 1.5 %` of world width survive. That is ≈ 15 km, ≈ 160 km² at 1024 km.
   - Peninsulas (6–9 per W view) need the same treatment.
   - Note: the harness counts by extent window, not by `maxMpp`. To also cut the *feature* count, extents must stay honest. Peak `extentM = min(prom·6, 30 km)` in `relief.ts` puts 15–30 km "peaks" into W. Use **`min(prom·3, 12 km)`** so single summits read at R/A and ranges carry W.

5. **Thin lake districts on glaciated archetypes.** In iceage and fjordland, lakes 10–100 km² run 90–146 per 10⁵ km² (target 8–20, ×5–20 inside districts only). R views hold 29–30 lakes, the lake Pareto b is 1.5–2.1 (too steep), Clark–Evans for lakes is ~1.0 (not clustered), and 19/40 fjordland seeds have < 5 % quiet land.
   - The lakes are depression lakes in carved terrain. In `src/gen/stages/hydro.ts`, scale `BREACH_AREA` (4 km²) and `BREACH_DEPTH` (15 m) with glacial carve. Simplest: divide by `min(lakeDensity, 1)` instead of `lakeDensity`, so a high `lakeDensity` stops *protecting* small pits. Then cap the per-world count of lakes under 100 km² at ~3× the background rate outside `glacial` masks.
   - Also flatten the `lakeDensity` AUTO in `schema.ts` from `(0.6 + 0.4·glaciation)·√humidity` to **`(0.7 + 0.2·glaciation)·√humidity`**.

6. **riverDensity 🎯.** It fails in archipelago (0%), fjordland (0%), volcanic (10%) and iceage (5%); the realised ratio is 0.48–0.83.
   - The expected drainage density in `hydro.ts` (`ddExpected = DD_COEF / √ath`) uses all land, including lake surface and islands too small to grow a channel. Compute `landKm2` for this outcome over land cells whose catchment can reach `ath` (cells in components ≥ `ath` km², excluding `WATER.LAKE`).
   - Separately, the config panel (`src/ui/configPanel.ts` `outcomeOk`) compares the ratio with the riverDensity *value* (√humidity: 0.59 for desert, 1.14 for fjordland). Its ✓ is wrong for every non-default humidity: desert shows ✗ in 100 % of seeds at a realised ratio of 0.98. Fix: in `hydro.ts`, report `outcomes.riverDensity = ratio × riverDensity`.

7. **continentCount and riftCount 🎯.**
   - Continents fail in archipelago (68 %) and fjordland (75 %). The realised p50 is 2.5 against a drawn ~1.35–1.75, because `seaLevelRise` (60 / 120 m) splits continents after plates steered them.
     - Account for the rise in `growContinents` (`src/gen/stages/plates.ts`), for example by merging continental seeds while `seaLevelRise > 0`.
     - Or raise `CONTINENT_MIN_SHARE` in `src/gen/stages/lem.ts` from **0.05 to 0.10**, so drowned fragments count as islands.
   - Rifts pass in 57–75 % of seeds and overshoot (up to +3).
     - In `plates.ts`, raise the preview candidate count (`ctx.mode === 'preview' ? 3 : CANDIDATES`) to **8**.
     - Score both targets against the resolved *range*: 0 inside the range, the distance outside it. Today the score is the distance to the drawn value with rifts weighted 0.6; raise that weight to **1.0**.
     - Build mode is also only 75 %, so the scoring change matters more than N.

8. **wetlandShare 🎯 in dry and steep worlds.** Desert passes in 23 % of seeds (realised ≈ 0 against 2.5 %), and fjordland build in 0 % (4 % against 9 %).
   - In `hydro.ts`, let `selectWetlands` also accept arid cells next to playas and terminal lakes (saline marsh). Relax `WETLAND_MAX_SLOPE` from **0.02 to 0.035** when the flat-land supply falls short.
   - Alternatively, make the AUTO in `schema.ts` (`id: 'wetlandShare'`) `clamp(0.07·humidity^1.5, 0.005, 0.2)`, so desert asks for ~1.4 % instead of 2.5 %.

9. **Make registry caps scale with area.** This is the size-invariance failure (peaks −74 % at 2048 km, waterfalls −62 %, canyons −70 %, at constant cell size). Drop the absolute upper caps:
   - in `src/gen/registry/relief.ts`, `cap = min(60, landKm2/7000)` for peaks;
   - in `src/gen/registry/rivers.ts`, `min(30, …/15000)` for rivers, `min(30, …/12000)` for lakes, `min(25, …/20000)` for waterfalls and `min(4, …/100000)` for canyons.

   Keep the per-area divisors only and let recommendation 4's per-band budget control clutter. World size should change quantity, not density (research 05 §3.1).

10. **Add non-river features at the A band.** In build, A has the right count (p50 23) but entropy p50 is 0.19 against ≥ 0.8; rivers are 93 % of what is in view. Two changes in `src/gen/registry/relief.ts`:
    - Add an A-band peak tier: summits with `PEAK_MIN_PROM` **150 m** (currently 300) and `PEAK_SPACING_KM` 6 → **4** in orogens, still under the W/R budget.
    - Emit gorge, knickpoint and waterfall candidates for every `RIVER.WATERFALL` node above ~30 m drop (only 18 of 299 waterfall nodes are labelled on earth build).

    In parallel, the harness counts every order ≥ 2 stream at A. If the A target is meant as "named rivers", raise `BANDS[A].minOrder` in `metrics/targets.ts` to 3.

11. **Fix rift archetype biome dominance.** Tropical rainforest covers > 70 % of land in 34/40 seeds. In `src/shared/config/archetypes.ts` (`rift`), set `latNorth: 22, latSouth: -8, humidity: 0.95`. The East African rift reads as savanna and dry forest, not rainforest. Desert has 13/40 seeds over 70 % hot desert; that is acceptable for a desert preset, but consider `humidity: 0.45` there.

12. **Give the archipelago its heroes.** The heroes p50 is 2 (in range in 33 % of seeds) and 6 seeds have 1. In `src/gen/registry/rank.ts`, when the hero pool runs short, relax hero spacing from `worldM / 4` to `worldM / 5`. Make island arcs, reef tracts and atolls eligible hero candidates (`HeroCat` 'archipelago' / 'volcano'), as research 05 §3.4 lists.

13. **Cluster volcanoes.** Clark–Evans for volcanoes is 1.0–1.96 (target 0.4–0.8); they are regular, not clustered. In `src/gen/landforms/volcanic.ts`:
    - Lower the arc `spacing = max(25, 80/√vol)` to **`max(20, 45/√vol)`**.
    - Only accept candidates within ~60 km of the first few seeded arc segments (Neyman–Scott parents, research 05 §3.3).
    - Stratovolcano counts (earth p50 7, 45 % in range) should then reach the 8–25 band on arc worlds.

14. **Deltas.** Earth, fjordland, iceage and archipelago have a median of 0; rift has 9.
    - Lower `DELTA_MIN_Q` in `src/gen/hydro/deltas.ts` from **300 to 150 m³/s**. The earth max mouth Q is ~800 m³/s.
    - Cap visible deltas at ~1 per 1000 km of coast in `rivers.ts` (currently `deltas.slice(0, 6)`).

15. **Great rivers.** Max Strahler order is 5 (preview) and 6 (build), so "ord ≥ 7: 1–3 per world" fails in 100 %. R_b ≈ 5 compresses orders: 4.2 × 10⁵ km² with A₀ = 8–40 km² gives 6 orders. Do not chase the order. In research 05 §4 row 12 and `metrics/targets.ts` (`greatRivers`), restate the target as **"≥ 1 river ≥ 400 km reaching the sea"** (the registry already has 250–500 km rivers). Check the guarantee in `src/gen/registry/rivers.ts` / hero `great-river`.

Lower priority:
- Islands 1–100 km² on continental archetypes run 4–10 per 10⁵ km² in preview and 13 in build (target 15–40). Raise the `islands` ridged term in `base.ts` (`55 * near * islands * …`) by ~1.5×. Archipelago and fjordland already over-shoot at 74.
- Canyons: earth and iceage have a median of 0. Canyons need plateaus. `strataShare` 0.15 on earth is low; see `landforms/arid.ts`.

## 5. Harness limits and next steps

- **The L band is not measurable from the pipeline.** Creeks, ponds and ravines exist only in the detail pass. To score L, sample the creek and detail generators that `tests/creeks.test.ts` and `tests/detail.test.ts` exercise for a few 16 km tiles per world.
- **The spectral-slope test** (research 05 §3.5) is not implemented. It also belongs to the detail pass.
- **The 200 seeds per preset** that PLAN asks for run as `npm run metrics -- --seeds 200`, which takes about 7 minutes.
- **Counting rules are knobs**, so a target that "passes" can be a counting artefact. The band minimum Strahler order, the excluded classes (sea cliffs, escarpments) and the extent window are all in `metrics/targets.ts` and `metrics/world.ts`. Change them deliberately and record the change here.
- **Thresholds marked (est.)** in `metrics/targets.ts` are this harness's choices, not research numbers: the label cap of 60 per screen, the per-disk cluster caps and the quiet radius of 20 km.
