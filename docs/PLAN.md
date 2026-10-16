# Procedural World Generation — Architecture & Implementation Plan

Status: **draft for review**, 2026-10-16. Nothing is implemented yet.

This plan combines five research notes in [`docs/research/`](research/):
- 01: terrain, tectonics and erosion
- 02: hydrology
- 03: climate and biomes
- 04: rendering and camera
- 05: scale, density and landmarks

The full feature checklist, about 179 landforms, water bodies, biomes and visual extras, is in [FEATURES.md](FEATURES.md). Where the notes disagree, the decision taken here is listed under §13 *Resolved conflicts*.

**Stack:** the same as the sibling `pathfinding-demo`:
- TypeScript (strict), Vite, raw WebGL2 (no engine);
- generation in a Web Worker on typed arrays, seeded RNG;
- a custom config panel (lil-gui cannot do AUTO chips or ranges; see [CONFIG.md](CONFIG.md)), Vitest, Firebase Hosting.

---

## 1. Goals and non-goals

**Goals**
- **A rich, believable world.** Mountains, rivers that run from mountains or wet lowlands to lakes and seas, lakes, creeks, ravines, canyons, rare craters, fjords, peninsulas, islands, deltas, deserts, glaciers and biomes.
- **Shape comes from process, not decoration.** Mountains are made by erosion. Rivers follow the terrain because the terrain was carved by them.
- **Configurable as a hierarchy.** High-level parameters (world size, land fraction, tectonic activity, age, climate) drive lower-level ones (plates, continents, range sizes, …) on AUTO. Any parameter can be pinned, and many are min–max ranges ([CONFIG.md](CONFIG.md)). A world is reproducible from `seed + archetype + pins`, which also makes it shareable by URL.
- **Neither too dense nor too empty.** Every density is defined in physical units and checked automatically per zoom band (§4).
- **Top-down 3D.** Perspective terrain with optional tilt and rotation. Trackpad two-finger pan, pinch zoom to the cursor, mouse and touch. Zoom runs from the whole world down to about 10 m/px.
- **Beautiful.** Cartographic hillshade, satellite-like palette, soft shadows, animated water, snow, haze, and labels with procedural names.
- **Fast.** A preview appears in under 1 s, a full world in about 8–10 s with progressive display, and rendering holds 60–120 fps on Apple Silicon.

**Non-goals for now**
- A spherical globe. The world is a finite flat region (§2.1); a globe view is a stretch goal.
- Infinite or streaming worlds.
- Civilisations, roads and politics.
- Editing the terrain by hand.
- Bit-identical GPU detail across GPUs. Only the CPU stages are exact (§11).

---

## 2. World model and scale

### 2.1 Shape: a finite flat region, ocean at the edges

The world is a rectangle of the planet seen from above, a "realm". It is not a sphere. This keeps erosion, hydrology and LOD on regular grids, which is what makes the rest of the plan fast.

- The map border defaults to **ocean**, so nothing is cut off at the edge. The option `outsideWorld = continent` instead lets rivers drain off-map and moisture arrive from inland.
- **Latitude is a parameter, not a consequence of size.** Rows map to a virtual latitude span (default 65°N → 20°N, warped ±3°). A 1024 km world therefore holds 3–5 climate belts instead of the 1–2 that ~9° of true latitude would give. This is about 5× **climate compression**, shown read-only in the UI.

### 2.2 Size presets

| Preset | Size | Land at 40 % | Comparable to |
|---|---|---|---|
| Isle | 512 km | 1.0 × 10⁵ km² | Iceland |
| **Realm (default)** | **1024 km** | **4.2 × 10⁵ km²** | **Sweden / California** |
| Continent | 2048 km | 1.7 × 10⁶ km² | Western Europe |
| Hemisphere-lite | 4096 km | 6.7 × 10⁶ km² | Australia (slow, high quality) |

Densities are per km² (§4), so a bigger preset gives *more* features, not sparser ones.

### 2.3 Resolution layers

| Layer | Grid (default) | Cell size at 1024 km | Lives in | Holds |
|---|---|---|---|---|
| Plates / provinces | 256² | 4 km | worker | plate id, boundary class, distance fields |
| Landscape evolution (LEM) | 512² | 2 km | worker | uplift `U`, erodibility `K`, eroded height |
| Macro (hydrology, climate, biomes) | 1024² | 1 km | worker → GPU | height, filled height, receivers, discharge, lakes, T, P, biome, masks |
| Detail height | 4096² (2048² on "fast") | 250 m | **GPU only** | upsampled + carved + GPU-eroded height, R32F |
| Shader amplification | procedural | down to ~20 m | per frame | slope- and biome-conditioned fBm, creeks, gullies, dunes, canopy |

Vectors:
- the river graph, with a node about every 250 m along each river;
- lake polygons with their surface levels;
- coastlines;
- the landmark registry (§6.10).

The grid sizes scale with the size preset so the cell size stays about the same. 4096 km uses 1024² for the LEM, with longer generation times.

### 2.4 Zoom bands

The bands follow research 05. Feature visibility, label density and tests are all keyed to them.

| Band | View width | m/px (1600 px) | What reads |
|---|---|---|---|
| **W** World | ~1024 km | ~640 | continents, ranges, great rivers, big lakes, deserts, heroes |
| **R** Region | ~250 km | ~160 | sub-ranges, rivers of order ≥ 4, lakes ≥ 10 km², volcanoes, canyons |
| **A** Area | ~60 km | ~40 | peaks, streams, small lakes, gorges, waterfalls, mesas, delta lobes |
| **L** Local | ~16 km | ~10 | creeks, ravines, ponds, cliffs, dunes, canopy clumps |

### 2.5 Vertical scale

- Elevations are true metres, with peaks of 2–8 km chosen by a slider.
- Top-down relief looks flat at world zoom, so **vertical exaggeration depends on the view**: about 1× at band L, rising smoothly to about 6–8× at band W.
- A user slider multiplies it.
- Lighting normals get an extra exaggeration at far zoom so the hillshade stays legible.

---

## 3. Generation pipeline

The pipeline is a **staged graph**. Each stage is a pure function of its inputs, a slice of the config and its own seeded RNG. Outputs are cached by hash (stage id + its config slice + input hashes). Changing a slider re-runs only that stage and the stages after it.

```
S0 Config+seed ─▶ S1 Plates ─▶ S2 Base elevation & sea level ─▶ S3 Pre-LEM stamps
      ─▶ S4 Landscape evolution (512²) ─▶ S5 Refine to 1024² ─▶ S6 Climate (T, wind, P)
      ─▶ S7 Glacial carving & fjords ─▶ S8 Hydrology ─▶ S9 Biomes & surface masks
      ─▶ S10 Post-stamps & landform passes ─▶ S11 Landmark registry & names ─▶ upload
      ─▶ G1 GPU detail (upsample, carve, pipe+thermal erosion, re-anchor) ─▶ G2 horizon/AO bakes
```

Two modes:
- **Preview** runs S1–S6 at 256² with 60 LEM iterations in under 1 s, on every slider release.
- **Build** runs everything at full resolution in about 8–10 s.

The worker streams each stage's output as it finishes, so the renderer shows the world sharpening. Mountains visibly erode into shape during S4.

| Stage | What it does | Key algorithms | Est. time (default) |
|---|---|---|---|
| **S1 Plates** | AUTO plate count (`[4, 6]` at 1024 km) plus 0–2 microplates, best-of-N against targets; continental or oceanic; rigid motion; boundary classes; distance fields | Poisson-disk seeds, noise-weighted priority-queue flood fill (no straight Voronoi edges), domain-warped lookup, relative-velocity classification, chamfer distance | < 100 ms |
| **S2 Base elevation** | Crust profile (shelf, slope, abyss), boundary features into `h0`, uplift `U`, erodibility `K`, geological provinces. Sea level = histogram quantile for the target land fraction | Warped continent signed distance + fBm. Ridged noise only *modulates* `U`. Ridge depth ≈ 2500 + 350·√t m | < 100 ms |
| **S3 Pre-LEM stamps** | Hotspot chains, plateau blocks, caprock and strata `K(z)`, hard-rock patches (inselbergs), old craters, **hero biases** (§4.5) | Stamps write into `h0/U/K`, so the LEM respects them | < 50 ms |
| **S4 Landscape evolution** | Uplift + stream-power incision + hillslope diffusion + talus, 80 iterations | **Braun & Willett 2013 implicit O(n) solver**; m=0.4, n=1. `U` derived from a "target peak height" slider (relief ≈ 39·U/K). Stochastic receivers early on to break grid bias. Priority-Flood+ε for pits | 2–3 s |
| **S5 Refine** | Bicubic upsample to 1024², 30 more LEM iterations, strata terracing | Same solver | ~2–3 s |
| **S6 Climate** | Warped latitude, zonal temperature, lapse rate, continentality, ocean currents; wind bands; summer and winter moisture; precipitation | **Fast-sweeping upwind moisture advection** (generalised mapgen4); orographic uplift with a cap; recycling; circulation factor S(φ) for ITCZ, subtropical deserts and storm track | ~0.2 s |
| **S7 Glacial** | Equilibrium-line altitude from climate, ice along high flow paths, U-shaped widening, cirques, coastal over-deepening to −300…−1200 m with a sill, then 5–10 LEM repair iterations | Rule-based, not an ice simulation | < 1 s |
| **S8 Hydrology** | Lakes vs breaches, routing, discharge, river graph, meanders, oxbows, waterfalls, deltas and estuaries, lakes by type, wetlands | **Priority-Flood (Barnes 2014, pit-queue)**, depression hierarchy + **water balance** (through-flow lake / terminal salt lake / playa), D8 on jittered nodes, rainfall-weighted accumulation, Strahler/Shreve, hydraulic geometry (w = 4·Q^0.5), Kinoshita meanders, monotone-z re-imposition, Galloway delta classes, wetness index (TWI) for wetlands | 0.35–0.65 s |
| **S9 Biomes** | 25 biomes from Köppen-style variables, then overrides: ice, rock on steep slopes, coast (beach/marsh/mangrove), salt, wetlands. Canopy density | Ordered rule list. The colour comes from a GPU look-up table over (T, aridity); biome IDs drive logic and vegetation | < 50 ms |
| **S10 Landform passes** | Fresh craters, volcanoes and calderas, cinder fields, ergs and dune orientation, mesa fields, karst sinkholes, barrier islands and lagoons, reefs and atolls, spits | Stamps and rules placed by **cluster processes + Poisson-disk spacing** (§4) | < 100 ms |
| **S11 Registry & names** | Detect and rank named features (peaks by prominence, ranges, rivers, lakes, islands, peninsulas, bays, straits, deserts, canyons, craters, heroes); procedural names | Prominence via a union-find sweep, coastline skeleton for peninsulas and bays, Markov name generator per region | < 100 ms |
| **G1 GPU detail** | 4096² detail height: bicubic upsample + slope-scaled derivative fBm, `min()`-carving of river beds, valleys and lake beds, pipe-model hydraulic erosion (Mei 2007, 100–300 steps) + thermal erosion, then low-frequency **re-anchoring** to the macro field (±30–100 m) | WebGL2 fragment passes, RGBA32F ping-pong (`EXT_color_buffer_float`), time-sliced so the UI stays smooth | 0.5–2 s |
| **G2 Bakes** | Horizon-angle soft shadows for the current sun, 8-direction ambient occlusion, distance-to-shore field | GPU passes | 1–3 ms per sun change |

**Data contracts.**
- Every grid has a header `{w, h, cellSize, origin}` and is a row-major typed array, sent to the main thread as a transferable.
- Heights are metres relative to sea level. Drainage area is m², so it keeps its meaning across resolutions.
- The 4096² detail lives only on the GPU and is rebuilt from `seed + config` after a context loss.

**Invariants**, enforced in tests (§11):
- Every river ends at the sea, a lake or a dry sink.
- Water elevation never increases downstream, including after the GPU carve.
- Lakes sit at their spill level.
- No two rivers cross.
- The land fraction stays within ±2 % of the target.

---

## 4. Density strategy: not too dense, not too empty

This is the core design concern. Six mechanisms work together:

1. **Physical units.** Every feature class has a rate per 10⁵ km² of land, per 1000 km of coast, per 1000 km of arc or rift, or per 10⁵ km² of warm ocean.
   - Counts are drawn as `clamp(Poisson(λ·support·densityMul), min_tier, max_class)`.
   - World size changes quantity, not density.
   - Family sliders (water, relief, volcanic, coast, ice) scale `densityMul`.
2. **Processes first.** Most features emerge from simulation (erosion, water, climate), so they appear only where they make sense. Explicit placement only covers what the grids cannot resolve.
3. **Clustering plus inhibition.**
   - Parent–child cluster processes give volcanic arcs, lake districts, archipelagos, geothermal fields and mesa fields.
   - Per-class Poisson-disk minimum spacing prevents clutter. Examples: craters ≥ 150 km apart, calderas ≥ 60 km, lakes over 100 km² ≥ 30 km.
   - Volcanoes are deliberately **bimodal**: none in most of the world, dense along arcs.
4. **Quiet zones.** 10–25 % of land is reserved as low-contrast plains, plateaus and shields, so busy zones read as special. Open ocean may be quiet.
5. **Rarity tiers and heroes.** The default world is only Sweden-sized, so Earth-average rates would give most "wow" features less than one per world (rivers over 1000 km about 0.3, craters about 0.5).
   - Tiers (common / uncommon / rare / legendary) carry per-world guarantees and caps.
   - Every world gets **3–5 hero landmarks** from a menu, weighted by geology and climate: great massif, great river with delta, great lake, fjord coast, volcano chain, impact crater, sand sea, great canyon, archipelago, karst towers, salt basin.
   - Heroes *bias* generation before erosion (S3) rather than being pasted on afterwards. Each must be readable at band W (footprint ≥ 15 km) and placed at least a quarter of the world width from the others.
6. **An interest budget per zoom band**, measured over random viewports:

   | Band | Target distinct features in view | Max empty disk on land |
   |---|---|---|
   | W | 15–40 | ≤ 200 km |
   | R | 10–25 | ≤ 50 km |
   | A | 8–20 | ≤ 12 km |
   | L | 6–20 | ≤ 3 km |

   **Self-similar detail** keeps zooming rewarding. The stored grids hold structure down to about 250 m. Below that, a deterministic per-world-coordinate detail pass adds creeks, gullies, ravines, ponds, dunes and canopy. The test is a power-spectrum slope of β ≈ 2 ± 0.5 in every band, with no band missing its variance (the "blurry bilinear" failure).

**Default-world targets** (excerpt from research 05 §4, which has all 42 rows with sources):

| Feature | Count |
|---|---|
| Major ranges | 1–3 |
| Peaks over 3 km | 20–60 |
| Great rivers (order ≥ 7) | 1–3, at least 1 guaranteed |
| Rivers reaching the sea | 100–300 |
| Lakes over 1000 km² | 0–2 |
| Lakes of 100–1000 km² | 4–12 |
| Lakes of 1–10 km² | 250–600, clustered |
| Islands of 1–100 km² | 60–170 |
| Peninsulas | 10–25 |
| Volcanoes | 0 or 8–25 |
| Visible craters | 0–2 (P ≥ 1 ≈ 0.6) |
| Fjord coast | 0 or 300–2000 km |
| Canyons | 1–4 |
| Waterfalls | 10–30 |
| Deltas | 1–5 |
| Wetlands | 4–10 % of land |
| Atolls | 0–5 |

**Contrast rules:**
- Every band-W view has at least two of: high relief, open water, a clear biome boundary.
- At least 25 % of land lies below 300 m and at least 5 % above 2000 m.
- The highest peak is at least 1.5× the 95th-percentile peak, so there is a "king" summit.

---

## 5. Climate and biomes (summary of research 03)

**Temperature**
- Zonal sea-level table by warped latitude.
- Lapse rate of −6.5 °C/km.
- A coastal sea-surface anomaly from a heuristic ocean-current model: warm western-boundary currents and cold eastern-boundary upwelling, which gives fog deserts.
- Seasonal amplitude from an advected "marine influence".
- Stored as annual mean and half-range. Monthly values, PET and growing-degree measures are derived from those.

**Wind and moisture**
- Wind follows latitude bands (trades, westerlies, polar easterlies) plus noise, with an optional override.
- Moisture is advected upwind with fast-sweeping Gauss–Seidel, run separately for summer and winter with the bands shifted ±5°. Mediterranean and savanna seasonality fall out of this.
- Precipitation = humidity × S(φ) × (1 + orographic uplift).
- The rain shadow is bounded so the windward:lee ratio stays about 3–6×.

**Biomes**
- 25 classes come from an ordered rule list over Köppen-style variables, followed by overrides.
- Snowline is P-dependent (Ohmura). Treeline is a warmest-month temperature of 10 °C.

**Colour on the GPU**
- A look-up table over (temperature, aridity), sampled with noise-jittered inputs, gives smooth ecotones at every zoom.
- Masks for snow, rock, wetland, beach, salt and reef go on top.
- Colour varies at three scales: geology (~100 km), mosaic (2–5 km) and texture (20–100 m).
- There are two palettes, *satellite* (default, muted like Blue Marble) and *stylised*.

**Vegetation**
- At 10 m/px a tree is about 1 px, so canopy is baked into ground colour and shading.
- Below ~15 m/px, **stand clumps** are generated procedurally in the vertex shader from a jittered grid and a density texture, with no CPU buffers and at most ~200k quads.

**Runtime and presets**
- Climate is cheap (~0.2 s), so climate sliders re-run S6→S11 live. Hydrology must follow because discharge depends on rain.
- Presets:
  - Earth-like (default)
  - Ice age
  - Hothouse
  - Desert world
  - Tropical archipelago
  - Subarctic fjords

---

## 6. Feature systems (how the headline features are made)

| Feature | Mechanism |
|---|---|
| **Mountains** | Plate convergence → uplift map → stream-power erosion carves dendritic ridges and V-valleys. Peaks are picked by prominence. Never "ridged noise mountains". |
| **Rivers from mountains** | High uplift plus orographic rain → large discharge → main stems falling through gorges. Snow- and glacier-fed headwaters are flagged. |
| **Rivers from lowlands** | Any cell whose rainfall-weighted drainage area crosses the source threshold starts a channel, in wet uplands, bogs or lake outlets. They end in lakes, the sea, or (in deserts) dry sinks or inland deltas. |
| **Lakes** | Depressions that the water balance keeps: through-flow, terminal salt, or playa. Small kettle lakes, tarns, oxbows and ponds come from Pareto-sized placement by lake type, giving about 1.8 % lake cover, ×3–10 in glaciated terrain and ×0.1 in deserts. |
| **Creeks and ravines** | Grown per 1 km macro cell from `(seed, cellId)` and joined to the trunk network, so they are deterministic and independent of which tiles are visible. Ravines are their incision on steep slopes. Gullies are shader-only. |
| **Canyons and gorges** | Rivers crossing uplifted plateaus or antecedent ranges, from the LEM uplift ramp, with a terrace profile in layered rock. |
| **Waterfalls and rapids** | Drop per channel width along the graph: fault scarps, caprock edges, hanging valleys, fjord walls. |
| **Fjords** | Only on cold, mountainous, high-latitude coasts. Glacial troughs are over-deepened below sea level with a sill, then flooded. Hanging valleys and waterfalls along their walls. |
| **Peninsulas, islands, archipelagos** | Warped crust signed-distance coastlines, ranges running into the sea, island arcs, hotspot chains, shelf islands, and an optional post-LEM sea-level rise (drowned valleys become rias, hills become islands). Coastline fractal dimension is about 1.2–1.3. |
| **Craters** | Rare. Stamped *before* the LEM for old and degraded ones (rivers respect the rim; ring lakes), *after* it for fresh ones. Pike profiles: d/D ≈ 0.2 for simple craters; complex above ~3 km with a central peak, terraces and ejecta falling off as (r/R)^−3. |
| **Volcanoes** | Arc and hotspot cluster processes. Strato, shield and caldera profiles. Calderas may hold lakes. Hotspot chains age from active, to eroded, to atoll, to seamount. |
| **Mesas, escarpments, inselbergs** | Erodibility patterns (caprock `K(z)`, hard patches) that the LEM turns into landforms with consistent drainage. Not stamps. |
| **Deltas and estuaries** | Distributary extension at river mouths. Style from discharge vs wave and tide energy (Galloway): bird's-foot, arcuate, cuspate or estuary. |
| **Deserts and dunes** | From climate. Ergs in low-relief arid basins. Dune type and orientation from wind regime, 1.5–2.5 km wavelength, made in the shader at bands A and L. |
| **Coastal details** | Barrier islands and lagoons on low sandy coasts; reefs and atolls in warm shallow water; cliffs where relief meets the sea; beaches by slope and sediment; salt marsh and mangrove on sheltered coasts. |

**Landmark registry (S11).** One table lists every named or notable feature with:
- type and position;
- footprint (polygon or polyline);
- importance and the band from which it is visible;
- name and tier.

It feeds labels, the Atlas panel, the inspector, hero summaries and the density tests.

---

## 7. Rendering (summary of research 04)

- **Terrain LOD: CDLOD.** A quadtree over the whole world; one shared 33×33 grid drawn instanced for up to ~600 nodes in **one draw call**. Heights are fetched in the vertex shader, with geomorphing and no cracks. Node bounding boxes come from a min/max height pyramid built in the worker.
- **Heights are R32F, filtered by hand** with texelFetch (bilinear, bicubic at close zoom). R16F steps at high altitude, and float-linear filtering is missing on many iOS devices.
- **Precision.**
  - Positions are camera-relative everywhere: float64 on the CPU, float32 offsets on the GPU.
  - Per-octave noise offsets are computed in float64.
  - Depth is reversed-Z (`EXT_clip_control` + 32F depth, infinite far plane) where available. Otherwise the near plane follows ground clearance (Firefox).
- **One shared height function**, `terrainHeight(p)`, in GLSL and ported 1:1 to TypeScript. It is base bicubic plus derivative-damped fBm conditioned on slope, biome and flow, with each octave faded by pixel footprint (no shimmer). Detail never flips land and water and never buries channels. Terrain, water, river ribbons, lines, labels and picking all use it. A golden test compares GPU and TS.
- **Lighting.**
  - North-west cartographic hillshade blended with sun Lambert. The multi-directional hillshade is stronger when zoomed out.
  - Soft shadows and AO come from a baked **horizon-angle field**, not shadow maps.
  - Hemisphere ambient, plus atmospheric haze when tilted.
  - Optional time of day.
- **Water** is drawn in the terrain pass as a "water lid": vertices are lifted to `max(h, waterLevel)`. Shading uses depth colour (shelf turquoise, deep blue), animated normals, depth- or shore-distance foam, sea ice and reefs.
- **Rivers.**
  - Wide rivers appear through the water-level raster.
  - Narrow rivers and creeks are **ribbon meshes** with flow-scrolled UVs, at least 1 px wide, filtered by drainage area per zoom: `A_vis = (s·mpp/k)²`.
  - Waterfalls get a spray sprite.
- **Overlays.** Instanced screen-space thick lines, draped on the terrain. **Labels** use an SDF glyph atlas with greedy priority placement and hysteresis, ranked by registry importance and band.
- **Map modes:**
  - Realistic
  - Elevation (hypsometric)
  - Biome
  - Temperature
  - Precipitation
  - Plates and boundaries
  - Drainage (log area)
  - Uplift / erodibility (debug)
- **Budgets (Apple Silicon, 1440p).**
  - GPU ≤ 6 ms per frame; 10–25 draws per frame.
  - Up to ~1.2 M terrain triangles.
  - ≤ 350 MB GPU memory desktop, ≤ 150 MB mobile (2048² detail).
  - ≤ 4 MB uploaded per frame.

---

## 8. Camera and input

- **Orbit camera.** Target, distance, pitch 0–60° and bearing, all float64.
  - FOV is about 30–35°, so straight down looks almost like a map and tilting shows parallax.
  - **Auto-tilt** as you zoom in: 0° above ~200 km altitude, ~40° at ~3 km. Turned off by any manual tilt.
- **Zoom to cursor in perspective.** The cursor ray is marched over the min/max pyramid, then refined with the TS height function. Zoom is a homothety of the eye about the hit point, eased exponentially the way the sibling project does it.
- **Input mapping:**

  | Input | Action |
  |---|---|
  | Trackpad two-finger scroll | Pan, scaled by metres per pixel |
  | Pinch (ctrl-wheel; Safari gesture events) | Zoom to cursor |
  | Safari gesture rotation | Rotate |
  | Mouse wheel | Smooth zoom |
  | Left drag | Grab pan |
  | Right drag or ⌃-drag | Rotate and tilt |
  | Arrows | Pan |
  | `+`/`-` | Zoom |
  | Q/E | Rotate |
  | R/F | Tilt |
  | Home | Fit the world |
  | Compass widget | Click: north up; drag: rotate |
  | Touch: one finger | Pan |
  | Touch: two fingers | Pan, zoom and rotate |
  | Touch: two fingers moving in parallel | Tilt |

- **Reused from pathfinding-demo:** `classifyWheel` (trackpad vs mouse), the Safari gesture handler with its `touching` guard, the touch controller structure, and the `zoomAt` / `panScreen` / `pinchAt` method names.
- **Minimap** with the camera footprint drawn as a trapezoid. Click or drag to fly there, using van Wijk–Nuij zoom-out-then-in for long jumps.
- **Clamp** the camera to the world with a margin. Beyond the edge, show ocean with fog instead of a void.

---

## 9. Configuration: a hierarchy of parameters

The full design is in **[CONFIG.md](CONFIG.md)**. In short:

- **Parameters form a tree.** Higher levels drive lower levels:

  | Level | Parameters |
  |---|---|
  | **L0 World** | seed, archetype, world size, land fraction, tectonic activity, geological age, latitude span, temperature, humidity, quality |
  | **L1 Structure** | plate count and size skew, continent count and size skew, island abundance, coast roughness, hotspots, sea-level rise, map edge |
  | **L2 Landforms / Climate / Water / Heroes** | mountain-range count, length, width and peak height; rifts, volcanism, craters, glaciation and fjords, river, lake and wetland density, density families, hero picks |
  | **L3 Process constants** | Expert-only: LEM, hydrology, climate internals, GPU detail |
  | **L4 View** | Never changes the world |

- **Every parameter is AUTO by default.** It derives from its parents and the value is shown live. A parameter can also be **SET**, pinned by the user, or **PRESET**, pinned by an archetype; anything still AUTO below a pinned value derives from it. Example: increasing world size with everything on AUTO gives more and larger plates, more and larger continents, and longer, wider collision ranges. The formulas and a worked table are in CONFIG.md §3.
- **Ranges are first-class:**
  - *Draw ranges*: one value per world, sampled with a seed, e.g. continent count `[1, 3]`.
  - *Spread ranges*: the distribution within a world, e.g. peak height `[2.5, 5] km`, crater diameter, range length.
  - *Directional ranges*: e.g. latitude span `65° → 20°`.
- **🎯 Targets.** Emergent outcomes (number of mountain ranges, continents, river density) are steered by deterministic best-of-N candidate selection. After generation, the panel shows the value that came out next to the target.
- **Resolution and caching.**
  - The resolver runs on the main thread in under 1 ms, so AUTO children update live while a parent slider is dragged.
  - A pin always wins. Implausible combinations get a ⚠ explanation.
  - Each stage caches on the hash of the resolved values it reads, so only the affected stages re-run.
- **Archetypes are bundles of pins and biases:**
  - Earth-like
  - Archipelago
  - Pangaea
  - Rift & great lakes
  - Fjordland
  - Desert world
  - Volcanic island chain
  - Ice age
  - Hothouse tropics
  - Old craton
  - Custom
- **URLs** store only `seed + archetype + user pins`, so links stay short and keep working when AUTO formulas are retuned.
- **Panel.** A custom vanilla-TS config panel, not lil-gui. It has dual-thumb range sliders, AUTO/PRESET/SET chips, provenance tooltips, target feedback, search and an "Advanced" fold.

---

## 10. UI

- **Top bar:** seed field with 🎲 randomise, preset picker, Build button, and a progress strip with per-stage timings.
- **Right:** the hierarchical config panel (CONFIG.md §7), collapsible, with a ☰ drawer on small screens.
- **Inspector:** hover or click shows elevation, temperature, rainfall, biome, discharge and the nearest named feature, using CPU picking.
- **Atlas panel:** heroes first, then features by type, all from the registry. Click to fly there. A "World traits" summary reads like: *"Seed 1234: a fjord coast, a 5.6 km massif, a great river with a bird's-foot delta."*
- **Legend** for the current map mode, a **minimap**, the **compass**, and **F1** for help.
- **Export:** PNG screenshot, heightmap (16-bit PNG), and the config as JSON.

---

## 11. Architecture and layout

```
src/
  gen/                     pure, worker-safe, seeded (no DOM; imports only shared/)
    pipeline.ts            stage graph, hashing/caching, progress events
    plates/  base/  lem/  glacial/  climate/  hydro/  biome/  landforms/  registry/  names/
    grid/                  Grid header, chamfer/jump-flood distance, blur, upsample, heap/bucket queue
    gen.worker.ts          message loop; transferable outputs
  gpu/                     GPU generation passes (detail upsample, carve, pipe + thermal erosion, re-anchor, bakes)
  render/                  per research 04 §9.1: gl/ camera/ terrain/ height/ lighting/ water/ overlays/ labels/ vegetation/
  input/                   cameraController (ported), touchController (ported), wheel.ts (classifyWheel)
  ui/                      configPanel (custom: ranges, AUTO chips, provenance), atlas, inspector, legend, progress, minimap, help
  shared/                  config/ (schema, resolver, AUTO formulas, archetypes, URL codec), rng (sfc32 from the sibling), hash, protocol, units
  app/                     orchestration: generation host, upload queue, URL state
tests/                     unit, invariants, determinism, density metrics, architecture boundaries
docs/                      PLAN.md, FEATURES.md, research/
```

- **Dependency rule:** `gen/` imports only `shared/`. Render, UI and input never import `gen/`. An architecture test enforces this, as in the sibling project.
- **Determinism:**
  - `rngFor(stage, sub) = sfc32(hash(seed, stageId, sub))`, so changing the crater count never moves the plates.
  - Integer tie-breaks everywhere.
  - No iteration order taken from `Map` or `Set` that feeds randomness.
  - The CPU stages are hashed in tests. The GPU detail stage is a cache, never saved as world data.
- **Copied from the sibling:**
  - `render/gl/util.ts`
  - `shared/rng.ts`
  - the wheel and gesture code
  - the profiler
  - Vite config (COOP/COEP headers), TS configs (a separate worker tsconfig without DOM), Firebase hosting config
- **Dependencies:**
  - no UI library: the config panel is our own
  - optionally `simplex-noise`, though we will mostly write our own seeded noise so it matches the GLSL bit for bit
  - nothing heavy

---

## 12. Testing and validation

| Kind | What |
|---|---|
| Unit | Priority-Flood, the stream-power solver against analytic steady state, distance transforms, meander generator, crater profiles, biome rules, wheel classification |
| **Invariants** (property tests, ~50 seeds at 256², 3 at 1024²) | River termination, monotone water (including sampled along the GPU-carved bed), lakes at spill level, mass conservation, no crossing rivers, tree-shaped graphs, land fraction ±2 %, no land/water flip from detail |
| **Determinism** | Same seed + config gives the same per-stage hashes. Changing one stage's slider leaves upstream hashes unchanged |
| **Geomorphic realism** | Horton bifurcation ratio 3–5, Hack exponent 0.5–0.65, lake-size Pareto slope, Korčák island sizes, coastline dimension 1.15–1.35, confluence angles |
| **Density metrics** (`npm run metrics`, 200 seeds per preset; nightly or on demand) | Per-tier count frequencies; per-band viewport counts (p5/p50/p95), empty-disk radius, class entropy, spatial CV, Clark–Evans per class, spectral slope; "boring seed" and "cluttered seed" detectors; size invariance across presets. Writes an HTML report |
| Golden height | GPU `terrainHeight` rendered to an R32F FBO against the TS port, within 0.05 m (in-app `?selftest`) |
| Performance | Stage timings with `?bench`; frame percentiles as in the sibling project |
| Visual | A fixed set of seeds × presets screenshotted in the browser pane at bands W, R, A and L for review |

---

## 13. Resolved conflicts between the research notes

| Conflict | Decision |
|---|---|
| **Plate count.** 01 says 8–24; 05 says 2–5 for a 1024 km world | **AUTO `[4, 6]` + 0–2 microplates at 1024 km**, scaling with world size (`[12, 18]` at 4096 km; CONFIG.md §3). Variety within plates comes from **geological provinces** (5–10: craton, orogen, rift, basin, arc, shelf) via `K` and uplift. |
| **Default land fraction.** 01 says 0.32; 05's tables assume 0.40 | **0.40**, so the density table applies directly. |
| **Order of climate and hydrology.** 03 says "after hydrology" | Climate (T, P) runs **before** hydrology, because discharge needs rain. Biome classification runs **after** it, because wetlands need the wetness index and lakes. Climate sliders re-run S6→S11 (~1 s). |
| **Close-zoom band.** The brief said 2 km views (~1.25 m/px) | The minimum is **~10 m/px** (band L, 16 km view). A closer "ground" band would need another detail octave plus instanced trees: P3 stretch. |
| **Vegetation.** Instanced trees vs shading | Canopy is baked into colour. Shader-generated stand clumps appear below 15 m/px. Real tree meshes only with the stretch ground band. |
| **Detail height resolution.** 2048² vs 4096² | **4096²** by default on desktop (64 MB R32F), 2048² on mobile or "fast". |
| **Climate coupling into erosion** | v1 erodes with uniform rain. **P2:** a coarse climate pre-pass at 256² feeds the LEM, giving wetter, more eroded windward flanks. |

---

## 14. Milestones

Each milestone ends with a demo-able build, tests green, and stage timings recorded in this file under *Implementation notes*.

| # | Milestone | Content | Done when |
|---|---|---|---|
| **M0** | Scaffold | Vite + TS + WebGL2 skeleton (copied pieces from the sibling), worker host and protocol, stage graph with caching and progress, **config schema + resolver (AUTO, pins, ranges) + custom panel + URL state**, **2D raster debug viewer** for any layer, Vitest + architecture test | A dummy stage's output shows in the debug viewer. Dragging world size updates AUTO children live; the build runs |
| **M1** | Macro terrain | S1 plates, S2 base and sea level, S3 basic stamps, S4 LEM at 512², S5 refine. Preview mode | Dendritic ranges in the 2D viewer. Land fraction ±2 %. LEM ≤ 3 s. Determinism test |
| **M2** | 3D world v1 | CDLOD terrain, orbit camera, pan / pinch / zoom-to-cursor / tilt / rotate, hillshade, hypsometric colours, ocean water lid, minimap, inspector | You can fly from band W to band L smoothly at 120 fps |
| **M3** | Water | S8 hydrology: lakes by water balance, river graph, meanders, oxbows, waterfalls, deltas. River ribbons with LOD, lake rendering, macro carve | Hydrology invariants green. Rivers read correctly at every band |
| **M4** | Climate & biomes | S6 climate, S9 biomes, GPU colour look-up tables, snow and treelines, palettes, climate presets, map modes | **P1 complete:** a full, believable world from any seed |
| **M5** | Detail & light | G1 GPU detail erosion + shader amplification with footprint fading, horizon shadows + AO, haze, animated water + foam, creeks per macro cell | Bands A and L show new structure (spectral test). No shimmer |
| **M6** | Landforms | S7 glacial + fjords; volcanoes, arcs, hotspots, calderas; craters; coastal set (barrier islands, lagoons, rias, reefs, atolls, cliffs); arid set (ergs, dunes, mesas); karst; wetlands typing | The P2 rows of FEATURES.md are generated and visible |
| **M7** | Atlas | S11 registry + prominence + coastline skeleton, procedural names, SDF labels, Atlas panel, hero landmarks, World traits | Every world reports 3–5 heroes; labels never collide |
| **M8** | Density tuning | Metrics harness over 200 seeds, tuning of all rates **and AUTO formulas**, archetype presets, target steering (best-of-N), boring/cluttered detectors | Every band target and 🎯 target passes for ≥ 90 % of seeds on every preset and size |
| **M9** | Polish & ship | Vegetation clumps, clouds and cloud shadows, valley fog, time of day, seasons, mobile pass, export, README, Firebase deploy | Live demo URL |

P1 ≈ M0–M4. P2 ≈ M5–M8. P3 items (FEATURES.md) are spread across M6–M9 as time allows.

---

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Full build too slow (LEM 5 s or more) | The preview path is always fast. Integer bucket queue for Priority-Flood. A Float64 LEM inner loop with zero allocations. Fewer iterations with a larger Δt. Fallback: run the LEM on the GPU or at 384². |
| Grid artifacts (rivers at 0°/45°/90°) | Stochastic receivers, jittered nodes, routing micro-noise, Chaikin smoothing on vector rivers. Fallback: an irregular mesh as in mapgen4. |
| GPU detail drifts from the macro rivers and lakes | `min()`-carving along descending paths, low-frequency re-anchoring, and the monotone-bed invariant test on the GPU result. |
| Everything looks the same | Variety comes from structure (plates, provinces, lithology, climate presets, heroes), not noise. Visual review of seed grids each milestone. |
| Scope: about 179 features | Phase tags. P1 must be beautiful before P2 starts, and P3 is optional. |
| Precision at 4096 km | Camera-relative coordinates, split integer+fraction noise coordinates, a corner-of-world test at 10 m/px. |
| Browser differences | Feature detection (clip_control, float render targets) with tested fallbacks. Safari is the only browser with trackpad rotate, so there are key and drag fallbacks. |
| Memory on mobile | 2048² detail, smaller label atlas, a lower GPU memory budget. |

---

## 16. Decisions on the open questions

On 2026-10-16 you accepted the recommended defaults: a flat region with ocean edges, the 1024 km Realm as default size, the satellite palette, an ~8–10 s full build with preview and progressive display, World traits visible, Firebase deploy, and the L0–L3 hierarchy as designed. The original questions follow for reference.

### Original questions

1. **Flat region vs globe.** I recommend a finite flat region with ocean edges (§2.1); a globe would be a later stretch goal. Is that the experience you want, or do you want to zoom out to a whole spinning planet?
2. **Default size.** Should the default be the 1024 km "Realm", or the larger 2048 km "Continent", which takes about 4× longer to build and has more of everything?
3. **Look.** Should the default palette be satellite-realistic, with a stylised palette as an option, or the other way round?
4. **Build time.** Is about 8–10 s for a full build acceptable, given a preview in under 1 s and progressive display?
5. **Hero landmarks.** Should they be visible as "World traits", or kept as surprises to discover?
6. **Deploy.** Should it go to Firebase Hosting like the sibling project?
7. **Config hierarchy.** Does the L0 → L3 split in [CONFIG.md](CONFIG.md) match your mental model? Are there top-level drivers you want added, such as a planet-wide "wetness" or "ruggedness"?

---

## 17. References

Each research note lists its sources with URLs. The core references are:
- Braun & Willett 2013, implicit stream-power solver.
- Cordonnier et al. 2016, terrain from tectonic uplift and fluvial erosion.
- Schott et al. 2023, interactive erosion.
- Mei, Decaudin & Hu 2007, GPU hydraulic erosion.
- Barnes et al. 2014, Priority-Flood; Barnes 2020, depression hierarchy.
- Génevaux et al. 2013, hydrology-based terrain.
- Red Blob Games, mapgen4.
- Strugar, CDLOD.
- Inigo Quilez, noise derivatives and band-limiting.
- Pike, crater morphometry.
- Galloway 1975, delta classification.
- Leopold & Maddock, hydraulic geometry.
- Downing et al. 2006 and HydroLAKES, lake statistics.
- Tom Patterson / Eduard Imhof, cartographic relief.

---

## 18. Implementation notes

### M0 — Scaffold (2026-10-16)

**What landed:**
- The Vite + TS + WebGL2 skeleton, with separate app and worker tsconfigs.
- The config hierarchy in `src/shared/config/`: schema with about 55 parameters and AUTO formulas, the resolver, 10 archetypes, and the URL codec.
- A custom panel with dual-thumb ranges and AUTO, PRESET and SET chips.
- The cached stage pipeline and the worker host (`?gen=main` for an in-thread run).
- Placeholder S1 (plates) and S2 (base elevation) stages.
- A 2D raster debug viewer, using the trackpad pan and pinch code ported from pathfinding-demo.
- 34 tests: config, pipeline caching and determinism, and module boundaries.

**Decisions made while building:**
- **Range pins merge per thumb** between user and archetype pins.
- **The `@auto` pin** explicitly returns a preset parameter to AUTO. The PRESET chip click sets it, and ↺ removes it.
- **All values snap to their slider step**, AUTO values included. For example, range length at 1024 km resolves to 250–550 km.
- **AUTO formulas read range *midpoints*, never seeded draws**, so AUTO values don't change with the seed.
- **The worker sends copies of each layer.** The originals stay in its stage cache, and only the copies are transferred.

**Timings (dev build, Apple Silicon):**

| Stage | Time |
|---|---|
| Plates, 256² | ~16–32 ms |
| Base elevation, 1024² | ~340 ms |

**Known gap:** the 🎯 continent target is reported but not yet steered. The placeholder base stage can realise 1 continent where 3–5 were requested. M1 adds best-of-N steering.

### M1 — Macro terrain (2026-10-16)

**What landed:**
- **S1 Plates:** noise-weighted plate growth, rigid motion, boundary classification (collision, subduction, island arc, rift, ridge, transform), boundary segments, and a distance field with nearest-boundary propagation.
- **S2 Base:** the warped continental signed distance gives the coastline. Shelf, slope, rise and abyss profiles; trenches, ridges and rifts; uplift `U` per segment calibrated from the peak-height spread; erodibility `K` with provinces, cratons, hard intrusions and strata.
- **S3 Stamps:** hotspot chains, arc volcanoes and old craters.
- **S4 Erosion:** the Braun & Willett solver at 512².
- **S5 Refine:** bicubic upsample to 1024², 30 more erosion iterations, then the post-erosion sea-level rise.

**Decisions made while building:**
- **Continents are grown independently of plates.** Each continent is a separate noisy, anisotropic Dijkstra region with a ~100 km gap enforced by coarse ownership blocks, so the 🎯 continent count is met directly (11 of 12 test seeds). A continent can straddle plates, so collisions inside it raise fold belts.
- **Best-of-N plate motions:** 8 candidates per world in build mode, 3 in preview, scored against the mountain-range and rift targets.
- **Erosion calibration:** `RELIEF_CALIBRATION = 1.2`. A steady-state strip measures 1.25× the analytic relief with the default diffusion and talus.
- **Quiet zones:** background hill uplift is patchy, so about a third of the land stays as low plains (PLAN §4).
- **Smoothing:** the uplift map is blurred about 10 km so ranges taper at segment ends. The deep ocean is blurred about 18 km so per-segment ridge profiles don't leave facets.
- **Bug found:** `distanceField` must keep its distances in float64. Comparing them against float32-rounded stored values re-queued cells forever.

**Timings (dev build, Apple Silicon):**

| Mode | Plates | Base | Volcanoes & craters | Erosion | Refine | Total |
|---|---|---|---|---|---|---|
| Build, default world | ~50 ms | ~280 ms | ~30 ms | ~2.4 s (512², 90 iterations) | ~2.6 s (1024², 27 iterations) | ~5.4 s |
| Preview | | | | | | ~0.55 s |

**Known gaps:**
- Faint straight edges remain on continental shelves near some plate boundaries (trench profiles inside the unblurred shelf band).
- Fresh volcanoes, calderas and fjords arrive in M6.
- Rainfall-weighted erosion arrives with the climate pre-pass (P2).

### M2 — 3D world (2026-10-16)

**What landed:**
- **`WorldView`:**
  - CDLOD terrain: one shared 33×33 grid drawn instanced, up to 2048 nodes in one draw call, 8 levels down to 250 m vertex spacing.
  - Heights are R32F with manual bilinear filtering, plus a CPU-built RG32F gradient texture for smooth normals.
  - The water lid puts the sea surface at 0.
  - Reversed-Z through `EXT_clip_control`, rendering into a 4× MSAA framebuffer with 32-bit float depth that is blitted to the canvas.
  - Camera-relative positions.
- **`HeightField`:** a CPU min/max pyramid and a ray march with bisection, used for picking and camera clamps.
- **`OrbitCamera` and `OrbitController`:**
  - Zoom-to-cursor as a homothety about the ground hit point, eased for the wheel and immediate for pinch.
  - Grab pan, rotate and tilt, auto-tilt, a flight path for minimap jumps, and clamps.
  - Trackpad, mouse, Safari gestures, touch and keys.
- **Minimap** with the camera footprint, and a **compass**.
- **Layer draping** in 3D.
- A **2D/3D toggle** sharing one WebGL2 context.

**Decisions and fixes made while building:**
- **Diffusion stability bug** (found through the 3D view). Hillslope diffusion sub-stepped to the classic limit c = kd·Δt/cell² = 1/4. At 1 km cells, c was exactly 1/4, so the checkerboard mode never decayed and the refined terrain had ±300 m per-cell checkerboards. The cap is now c ≤ 1/8, and a regression test fails on the old rule.
- **Default framebuffer format.** The context uses `alpha: true`, so the default framebuffer is RGBA8. A multisample resolve blit needs matching formats.
- **Shader precision.** The terrain shaders declare `precision highp int`, because integer uniforms have different default precisions in the vertex and fragment shaders.
- **Per-pixel water height.** The fragment shader recomputes height per pixel; colouring water by the vertex-interpolated height showed coarse LOD triangles.
- **Closest zoom** is limited to 8 m/px (`OrbitCamera.minMetresPerPixel`) until M5 adds shader detail.
- **Lighting.** The sun comes from the top-left of the screen (cartographic convention, azimuth = bearing − 45°). Lighting normals are exaggerated by 1.5–6.5× depending on altitude.

**Performance (Apple Silicon, built-in browser pane, 1278×1540 drawing buffer):**
- Frame time p50 8.3 ms and p95 9.3 ms, which is the 120 Hz vsync.
- 4–60 CDLOD nodes selected per view.

**Known gaps:**
- Featureless plains and smooth blobs at band L (detail amplification, M5).
- No shadows or AO yet (M5).
- Haze only when tilted.
- No labels (M7).

### M3 — Water (2026-10-16)

**What landed:**
- **S6 Climate (placeholder):**
  - Zonal temperature with a lapse rate.
  - Precipitation from a latitude circulation factor, distance inland and elevation.
  - PET from temperature.
  - It gives hydrology rain and evaporation; M4 replaces it.
- **S8 Hydrology** (`src/gen/hydro/*`):
  - Pit breaching and grid-scale lake basins.
  - Depression hierarchy with a Fu–Budyko water balance: through-flow, terminal or salt lake, or playa.
  - Jittered D8 routing with uncrossing, and accumulation with arid losses.
  - A river graph (struct of arrays, reach-ordered) with Strahler orders and hydraulic geometry.
  - Kinoshita meanders, monotone water and bed elevation, knickpoint waterfalls and rapids.
  - Galloway-style deltas and estuaries, and inland deltas.
  - Wetlands from TWI selected to the 🎯 share, and a min-only bed carve.
- **Protocol:** a `vectors` channel carries the river graph and lakes alongside raster layers.
- **Rendering:**
  - The water lid now uses the water-level raster, so lakes sit at their own level.
  - Water levels are pre-extended two cells, so shorelines follow the terrain contour.
  - Lake, salt-lake and playa colours; soft wetland and salt-flat masks.
  - River ribbons stay at least 1.3 px wide, fade by drainage area per zoom (A_vis = (49·m/px / 1000)² km²), and show flowing streaks, waterfall foam and dashed ephemeral wadis.
  - The minimap shows lakes.

**Decisions and fixes made while building:**
- **Lakes are placed, not found.** The eroded terrain has almost no depressions, so hydrology carves grid-scale basins behind sills on drainage lines (Pareto sizes, ~1 per 1000 km² × lakeDensity). The water balance then decides their fate. Sub-grid kettles, tarns and ponds are deferred.
- **Channel threshold** is 8 km² / riverDensity², which keeps the build graph at ~220k nodes.
- **Gradient texture mips.** The shading gradient is a mipmapped RG16F texture sampled by pixel footprint. Without it, 1 km cells only ~3 px wide shade as blocky stairs. The mips are built on the CPU, because `generateMipmap` needs a colour-renderable format; RG16F is not one without an extension, and the incomplete texture had flattened all shading.
- **Plains roughness.** Base land gets ~35 m of 14 km-wavelength roughness, and refine adds 4 m of jitter, so plains drainage doesn't lock onto the grid axes.

**Measurements, seed 7, build (node):**

| Measure | Value |
|---|---|
| Hydrology stage time | ~0.5 s |
| River graph | 218k nodes, 23.6k reaches |
| Rivers reaching the sea | 1,236 |
| Lakes | 131 (2 ≥ 100 km², 1 ≥ 1000 km²) |
| Playas | 14 |
| Waterfall nodes | 255 |
| Lake cover | 0.95 % |
| Horton bifurcation ratio | 4.9 |
| Hack exponent | 0.55 |
| Full build | ~6.6 s |
| Frame time | p50 8.3 ms (120 Hz) |

**Known gaps:**
- Some long rivers still run straight across very flat plains (flat routing).
- No oxbow lakes or braided rendering yet.
- Small placed lakes and creeks arrive with detail (M5).
- The climate model is a placeholder until M4.
