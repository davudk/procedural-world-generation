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

### M4 — Climate & biomes (2026-10-16)

**What landed:**
- **S6 Climate** (`src/gen/climate/*`), replacing the M3 placeholder:
  - Warped latitude, zonal temperature, lapse rate.
  - Marine influence advected inland, and a coast-orientation SST anomaly for currents.
  - Wind bands with noise and an optional override.
  - Fast-sweeping upwind moisture advection, run for summer and winter with the bands shifted ±5°.
  - Orographic uplift with a cap, snow-out, recycling, and Holdridge PET.
- **S9 Biomes:**
  - Ordered Köppen-style rules on jittered inputs.
  - Overrides: ice from a P-dependent ELA, rock, beach / salt marsh / mangrove, salt flats from hydrology playas, marsh and bog from hydrology wetlands.
  - A 3×3 majority filter.
  - Canopy, aridity and snow layers. Five new L3 parameters for the climate model.
- **Rendering:**
  - A 64×64 colour table over (temperature, aridity), Gaussian-blurred, plus a dry-summer variant blended by summer rain share.
  - Inputs jittered by noise for lobed ecotones, and colour variation at three scales.
  - Canopy darkening; sand, marsh and rock overlays (rock also from slope); aspect- and noise-broken snow.
  - Satellite, stylised and hypsometric palettes; a biome map mode with the biome palette when the biome layer is draped.

**Measurements (node, seed 7, build):**
- Climate ~0.26 s; biomes ~0.12 s; full build ~5.9 s.
- Earth-like: 18 distinct biomes. Temperate broadleaf 29 %, Mediterranean 19 %, tundra 10 %, boreal 10 %, conifer 8 %.
- Desert world: 74 % desert or xeric.
- Ice age: ice, tundra and polar desert 50 %, against 11 % for Earth-like.
- Rain shadow: about 4× behind ~3 km ranges and 2–2.5× behind 1.5–2 km ranges.

**Notes:**
- While these screenshots were taken, the pane's generation ran about 4× slower than in node because the machine was under load. Node timings were unchanged.
- The moisture sweeps run on a ≥ 2 km grid and are upsampled.

**Known gaps:**
- Snow patches still have fairly hard edges at the 2 km Fast grid.
- The minimap still uses hypsometric colours.
- No sea ice, terrain wind deflection, dunes behind beaches, or coastal sabkha yet.
- The glacial carving stage (S7) is still M6.

### M5 — Detail & light (2026-10-16)

**What landed:**
- **Detail heightmap** (`render/terrain/detail/*`), built on the GPU after generation and time-sliced per frame:
  - Bicubic macro plus baked noise, with river channels and valleys MIN-carved as instanced capsules.
  - Thermal erosion, tiled pipe-model hydraulic erosion, thermal again, then low-frequency re-anchoring.
  - Shore clamps on every pass. A CPU fallback runs where `EXT_color_buffer_float` is missing.
- **Shared height function:**
  - GLSL (`glsl/detail.ts`): integer-hash noise on tile index plus offset, derivative-damped and ridged octaves faded by pixel footprint, amplitude capped below the water level.
  - Its TypeScript port (`height/heightFn.ts`) is generated from the same constants, with a parity test.
  - The camera uses `DetailGround` for picking.
  - The vertex footprint is coupled to the CDLOD morph. CDLOD depth is 11 at 1024 km (16 m leaf spacing).
- **Creeks** (`render/water/creeks/*`):
  - Per-macro-cell deterministic growth (research 02 §8 option b): trunks along D8, Poisson-disk heads walking downhill on the detail terrain, and cells that never cross.
  - An LRU-cached, time-sliced manager feeds a second ribbon pass; creeks fade in by drainage area.
- **Lighting:**
  - A horizon pass for sun visibility (soft penumbra) and 8-direction ambient occlusion, recomputed when the sun direction changes (map lighting follows the camera bearing).
  - A gradient sky, and haze that scales with altitude.
- **Water:** three footprint-faded animated wave layers, Fresnel sky reflection, sun glint, a shore line about 1.5 px wide at any zoom, and surf bands close up.

**Measurements:**
- Frame time p50 8.3 ms and p95 8.4 ms (120 Hz) while tilted at 18 m/px, with 109 CDLOD nodes and ~840k creek ribbon indices.
- In the pane, the 4096² detail build took ~24 s of wall time after generation: 7.9 s of sliced CPU prep, 1,229 GPU passes and a 1 s readback. In node the prep measures ~0.65 s.
- 122 tests pass.

**Known gaps:**
- **Detail build wall time.** The prep should move into the worker, with larger slices while the camera is idle.
- **One-off GL error.** One `INVALID_OPERATION` is raised during the detail build; it does not recur per frame and has not been traced yet.
- **Creek trunks** follow macro D8, so a faint 1 km structure can show.
- **Hydraulic erosion constants** are untuned starting values.
- **Snow** patches still have hard edges.

### M6 — Landforms (2026-10-16)

**Pipeline order:** `refine → climate → glacial → landforms → hydro → biome`. Terrain-changing landforms run before hydrology, so crater and caldera lakes, fjord drainage, lagoons and karst ponds come out of the water balance.

**S7 Glacial** (`src/gen/glacial/*`):
- Ohmura ELA shifted by `glaciation`. Present-day ice is shown as cover; troughs are carved with a colder glacial-maximum ELA, because they are relics of past ice.
- Ice flux accumulated along drainage; U-troughs as the distance to smoothed glacier centrelines; cirques; hanging valleys.
- Fjords over-deepened 300–1200 m below sea level with sills, flooded only when 4-connected to the sea.
- Uplift-free repair erosion; carving only lowers terrain.
- Results: Fjordland has fjords on 8/8 test seeds (~1000–1800 km of fjord coast). Earth-like has small or no fjord coasts.

**S10 Landforms** (`src/gen/landforms/*`, one module per family behind a shared `LandformCtx`):
- **Volcanic:** fresh stratovolcanoes on active arcs, which rejuvenate eroded stamped cones. Young shields at the leading end of hotspot tracks. Calderas with raised-cosine walls, so lakes form. Cinder fields and geothermal halos. Outlines are irregular: angular harmonics, rift-zone elongation, lava lobes, coastline warp.
- **Impact:** fresh craters, Poisson-sized with N(>D) ∝ D⁻² and at least 150 km apart. Pike simple and complex profiles, slightly polygonal rims, lobate ejecta and a ray mask.
- **Arid:** caprock terracing, which gives mesas, buttes and escarpments. Erg (sand-sea) and dune-direction masks. Inselbergs.
- **Karst:** limestone provinces, dolines, tropical tower karst, cenotes.
- **Coastal:**
  - Exposure-based coast classes; rias; cliffs with sea stacks.
  - Barrier islands with tidal inlets and lagoons, spits, tombolos.
  - Fringing and barrier reefs; atolls at the old end of warm hotspot chains.
  - A full rebuild of the ocean mask (`fixed`).
- Placed landmarks are collected as `Feature`s for the M7 registry.

**Biomes:**
- Wetlands are typed as swamp (warm and humid), fen (cold, by lakes or rivers), bog (cold, rain-fed) or marsh.

**Rendering:**
- A landform-mask texture: reef (turquoise shallows with a pale crest), erg (redder sand with dune ridges at region zoom), crater ejecta brightening.

**Fixes found visually:**
- Scalloped trough walls: per-cell stamps were replaced by distance to a smoothed centreline, which halved the added roughness.
- Perfectly circular volcanoes: they now have irregular outlines.
- 1-cell caldera steps: caldera walls are now at least 2.5 cells wide.

**Climate seams:** straight north–south vegetation and snow seams on Fjordland were narrow air-mass fronts carried along nearly uniform wind paths; the upwind sweep spreads almost nothing sideways.

- **Fix:** humidity is mixed sideways (σ 30 km) before rain is drawn, and marine influence and summer-rain share are mixed sideways and meandered (±35 km).
- **Result:** the worst interior gradients fell 2–4×. A regression test checks for axis-aligned steps.

**Test changes:** the hydrology "carving only lowers" invariant now compares against the landforms output, since landforms legitimately raise ground. 152 tests pass.

**Timings at build, seed 7:**

| Stage | Time |
|---|---|
| Glacial | 0.2–0.3 s |
| Landforms | 0.1–0.3 s |

**Known gaps:**
- Coastal dunes (F22) are not done.
- Landform passes can't see the positions of old craters and hotspots, so they re-detect them from the terrain.
- Generation in the browser pane is sometimes several times slower than in node, because of machine load while agents ran.

### M7 — Atlas (2026-10-16)

**What landed:**
- **S11 Registry** (`src/gen/registry/*`): one deterministic union-find merge tree is reused for four things:
  - peaks by prominence (with a world king);
  - seas split by basin enclosure;
  - straits as the passages between sea basins;
  - isthmuses on the land distance field.
- **Other detections:**
  - Ranges: high-relief regions split at deep cols, with PCA orientation and a crest path.
  - Gulfs and bays: ray-enclosure tests at two scales.
  - Peninsulas and capes: morphological opening of the land mask.
  - Archipelagos: island clusters.
  - Rivers: main stems traced by discharge, with paths.
  - Lakes and playas, deltas, waterfalls, and canyons from valley depth.
  - Biome regions, ice caps, and the M6 landform features.
- **Ranking:** importance and a zoom band per landmark (`maxMpp` = footprint / 23 px, so a 15 km feature reads at world zoom), plus a tier.
- **Names:** 8 phoneme inventories laid out as 3–5 culture regions per world, with kind-specific generic patterns. Names are seeded by world seed + language + kind + quantised identity position, never list order, and are unique within a world.
- **Heroes:** scored against the research 05 menu and spaced at least a quarter of the world width apart.
- **World traits:** a headline sentence plus fact bullets.
- **Labels** (`src/render/labels/*`):
  - A runtime SDF glyph atlas (own distance transform, shelf packing, on-demand glyphs).
  - Upright serif for land and italic for water; spaced capitals for ranges, seas and continents.
  - Greedy priority placement with collision, density cap, 3-frame stability, hysteresis and fades.
  - Curved labels along rivers and fjords, rotated labels along ranges.
  - Occlusion raycasts when tilted, plus hit testing and highlighting.
- **UI:**
  - The Atlas panel: traits, hero cards, grouped and searchable lists.
  - Clicking a row or a label flies there.
  - The inspector shows the nearest named place.

**Measurements:**
- Seed 7 Earth-like: 265 landmarks; 17 labels placed at world zoom.
- Registry 80–150 ms at build; label placement ~0.1 ms per frame on real worlds.
- 175 tests pass.

**Known gaps:**
- Pre-erosion volcanoes and old craters are only named when they still stand out as peaks.
- No deltas are labelled on some seeds, because the fan is under 2 km.
- River labels have no terrain occlusion.

### M8 — Density tuning (2026-10-16)

**What landed:**
- **Metrics harness** (`metrics/*`, `npm run metrics`; see research 09):
  - 10 archetypes × 40 preview seeds, a build subset and a 512/1024/2048 km size sweep on worker threads;
  - per-band interest budgets, empty disks, clustering, relief contrast, counts against research 05 §4 and 🎯 target satisfaction;
  - boring and cluttered detectors with links to the flagged seeds;
  - a self-contained `report.html`.
- **Relief** (`stages/base.ts`, `plates.ts`, `lem.ts`): wider orogenic belts with a target belt share, Altiplano-style plateaus behind subduction, intraplate swells, an uplift cap, and a "king massif" so most worlds have one standout summit.
- **Water** (`stages/hydro.ts`, `hydro/*`): the drainage-density outcome is reported as a ratio of the slider, lake districts, a double breach pass, wetland tiers, a delta discharge floor with a guaranteed delta, and great-river stats.
- **AUTO formulas:** lakeDensity `(0.7+0.2·glaciation)·√humidity`; wetlandShare `clamp(0.07·h^1.5, 0.005, 0.1)`.
- **Registry:** a per-kind label budget with fill-in kinds (hills, open country, passes, gorges).
- **Archetypes:** rift moved into the tropics with more humidity; the craton is exempt from the high-relief contrast rule.
- **Fixes:**
  - PET floor (150 mm) for the aridity index, which removed the aridity seam.
  - NaN uplift on small worlds with no deep-inland land. The swell quantile was infinite and crashed the LEM at 512 km.

**Measurements** (448 worlds in 113 s on 9 workers):
- Band W passes on 88–98 % of seeds.
- Continent, range, rift, river-density and wetland targets pass on 93–100 %.
- King summit: 80–100 %.
- Land below 300 m: ≥ 98 %. Land above 2 km: 83–100 %.
- Cluttered: 0 % in preview.
- 184 tests pass.

**Not met (the ≥ 90 % bar):**
- **Band R passes on only 5–73 % of seeds.**
  - Fjordland and ice-age worlds are too busy (p95 ≈ 42).
  - Deserts are sparse.
- **Bands A and L can only be judged in build mode.** In preview they are 0 % by construction.
  - In build mode, A has a median of 16–35.
  - L is still below 6–20 in deserts.
- **Build mode is always flagged "cluttered".** The quiet-land metric is miscalibrated at 1 km cells.
- **Counts off target:**
  - Too many ultra-prominent peaks.
  - Too few rivers of order 5–6 and rivers reaching the sea.
  - Too few small lakes (1–10 km²) at preview resolution.
  - Too few peninsulas per coast.
  - Great rivers are rare in sea-dominated archetypes.
- **Size invariance:** only 5 of 26 rows are within tolerance.
- **"Boring":** up to 28 % of seeds (deserts dominated by hot desert, worlds with little high relief).

### M9 — Polish & ship (2026-10-16)

**What landed:**
- **Atmosphere and light** (`render/lighting/sun.ts`, `atmosphere.ts`, `clouds.ts`):
  - A sun model with time of day and season. At the defaults (about 15:34, mid-July) it reproduces the pre-M9 light exactly; a unit test checks this.
  - Low sun brings warm light, a wider penumbra and extra sky fill. At night the scene only dims, under faint blue moonlight.
  - Climate-driven clouds drift as a thin, depth-tested sheet at 3.2 km. They cast shadows of up to 60% and fade in at region zoom.
  - Valley fog uses a relief-based potential baked in the AO pass. It is mostly a dawn effect.
- **Vegetation:**
  - Worley-style tree crowns of about 13 m and stand clumps of about 40 m, both in the terrain shader.
  - Conifers and broadleaf trees look different. Crowns are lit on the sun side and cast offset shadows.
  - The layers are faded by pixel footprint and normalised, so the overall tone stays the same during the fade.
- **Seasons** (render-time only):
  - snow that comes and goes with the season;
  - autumn colours, bare deciduous trees, then a spring green-up;
  - dry-season browning of grass;
  - Mediterranean winter green-up;
  - lake and sea ice.
- **View controls:** a time slider with a play button (T), a season slider and a clouds toggle. They are saved per browser, not in the URL.
- **Mobile and robustness:**
  - Quality tiers (`render/quality.ts`) are picked from a device probe:
    - **low:** no MSAA, a 0.75 render scale at DPR ≥ 2.5, a 2048² detail map and coarser CDLOD;
    - **medium:** 2× MSAA and a 2048² detail map;
    - **high:** 4× MSAA and a 4096² detail map.
    - Override with `?quality=`.
  - An idle frame cap of about 30 fps (`render/framePacer.ts`).
  - The world rebuilds after a lost graphics context (`WorldView.initGpu()` / `restore()`).
  - A phone layout with a foldable layer box and 40 px touch targets.
- **Export menu:**
  - screenshot PNG, labels included;
  - 16-bit heightmap PNG, from its own encoder;
  - colour map of the selected layer;
  - world JSON with spec, traits and landmarks;
  - copy share link.
- **UI:**
  - The layer menu lists the finished world first, as "World (final, realistic)".
  - The per-stage timing chips are replaced by a segmented generation timeline with a short status line.
- **Peaks:** full builds reached about 14.6 km. Refine now rescales uplift for its finer cells and may not raise summits, and a smooth ceiling above 7.6 km eases heights toward 9 km. The highest summits are now 6.9–8.9 km in both preview and build.
- **Ship:**
  - Firebase project `procedural-world-gen`, live at https://procedural-world-gen.web.app.
  - Public repository at https://github.com/davudk/procedural-world-generation, under the MIT license.

**Measurements:**
- 199 tests pass.
- New shading work: vegetation about 0.6 ms at the closest zoom, clouds 0.2–0.5 ms, fog about 0.1 ms. These were measured in the browser pane on a loaded machine, so treat them as relative.
- With the peak fix, the king summit passes on 60–100% of preview seeds; rift and volcanic worlds are lowest.

**Known gaps:**
- Valley fog follows the 1 km raster, so it reads as bands rather than pools.
- Phenology is generic rather than per biome.
- Labels are not dimmed at night.
- The sky shows no clouds in tilted views.
- Very low sun leaves large dark areas.
- Clouds freeze when frames stop.
- Nothing has been tested on real phones.
- The config panel's AUTO chips are smaller than 40 px.

### Sphere phase 1 — Grid behind every stage (2026-10-16)

Spherical worlds are being added as an option, with flat staying the default ([research 10](research/10-spherical-worlds.md)).

**What landed:**
- **Grid** (`src/gen/grid/grid.ts`): every stage and raster helper now takes a `Grid` instead of a bare side length.
  - Only the flat implementation exists: a one-face grid whose border cells are the map edge.
  - `StageCtx.grid(n)` builds each resolution once per world. `coarser`, `finer` and `blockGrid` derive the climate sweep grid, the registry's regional grid and the block lattices.
- **Hot loops** keep their old shape: a fast path for interior cells and a slow path through `nbr` for border cells only. Each module keeps its own D8 neighbour order and tie-breaks.
- **Climate kernels:** the separable blur and resampling kernels moved to `grid/smooth.ts`, where Phase 2 adds face padding.
- **Golden hashes** (`tests/golden.test.ts`):
  - 18 worlds: earth, fjordland and desert × seeds 7, 11 and 42 × preview and a 512 km build.
  - Hashed per stage, layer, vector and private raster.
  - Recorded before the refactor; outputs are byte-identical.
  - Re-record with `GOLDEN_UPDATE=1`.
- **Benchmark:** `npm run bench` (median of 5 runs).
- **Lint test:** `tests/gridLint.test.ts` keeps raster index arithmetic out of stage code. 6 lines in 4 files remain, all planar noise lattices or km geometry that `Noise3` and `chart` replace in Phase 2.

**Measurements:**
- An interleaved A/B against the baseline puts the refactor at +0.9 % on a build and −0.1 % on a preview.
- 230 tests pass.

**Fixed: landmarks were nondeterministic under V8 Maglev.** A V8 bug let a gulf candidate share its number boxes with a later bay, so the gulf moved and shrank in some isolates. Chrome uses Maglev too.
- Write-up: `docs/notes/v8-maglev-shared-number-boxes.md`.
- Registry records are now copied with `own()` / `candidate()` as soon as they are built.
- The golden test runs with Maglev again. `tests/jitDeterminism.test.ts` and `npm run jit-stress` re-run the registry in fresh isolates.

**Phase 2 must revisit `border`:** on a sphere it means seam cells, not the map edge. These places use it:
- biome river mouths and the majority filter;
- `settleFixed`/`reconcileFixed`;
- the world-ocean rule in `water.ts`;
- climate inflow (`hasOutside`).

### Sphere phase 2 — Cube-sphere terrain and climate (2026-10-16)

**What landed:**
- **Cube-sphere grid** (`src/gen/grid/cube.ts`, geometry shared with the renderer in `src/shared/cube.ts`):
  - Six equal-angle n×n faces; faces 0–3 ring the equator, 4 and 5 are the poles.
  - A seam table gives each face-border cell its mirror cells on the next face. The 24 cube-corner cells have 7 neighbours; every other cell has 8.
  - Exact cell areas (closed-form solid angle, summing to 4πR²), great-circle neighbour distances, positions, local frames, tangent-plane charts and padded face halos (`padFace`).
  - The shared helpers take the sphere through halos (box and Gaussian blurs, bicubic and bilinear resampling, warp) or geodesic Dijkstra (distance fields; chamfer falls back to it). Priority-Flood, components and the LEM router already went through `nbr`.
- **Noise3** (`src/shared/noise3.ts`): 3D gradient noise on a hashed lattice, without Noise2's 256 period. Stages call it through `SurfaceNoise`; on flat maps that forwards to Noise2 bit for bit.
- **Stages on the sphere** (plates → base → stamps → LEM → refine → climate; the pipeline then stops and the timeline shows 6 steps):
  - Plates: seeds spaced on the sphere, rotation about random Euler poles, and boundary classes from relative velocity in the local east/north frame. Continents use ownership blocks with 7×7 neighbourhoods taken across seams.
  - Base and stamps: 3D noise at the surface position and an area-weighted sea level. Volcanoes, craters and the king massif are stamped through charts; hotspot trails are small-circle arcs about the plate's pole.
  - LEM: slopes from per-neighbour distances, drainage from cell areas, finite-volume diffusion and per-neighbour talus. There are no edge outlets; every river reaches the sea.
  - Climate: true latitude, and winds turned from the local frame into face axes. Current anomalies use coastline distances along chains of east/west neighbours. The moisture and marine sweeps follow a topological order of the upwind graph, with loop edges reading the previous round.
- **Config:** `worldShape` (Flat | Sphere, L0, never written to URLs when flat), `planetSize` (circumference, with read-only radius and area), `axialTilt` and `faceGrid`. Parameters carry `shapes`, and the panel hides the rows of the other shape. AUTO formulas read the equal-area size `sizeEff`, which is `worldSize` on flat maps; provenance hides parents of the other shape.
- **Viewer:** sphere layers (`Layer.faces = 6`) are projected on the main thread to an equirectangular map or a cube net (toggle with P). The inspector shows latitude and longitude. The 3D button says the globe view comes in phase 3 and stays in 2D; the next flat world restores 3D.

**Grid sizes:**
- Default small planet (4,096 km circumference, R = 652 km):
  - Build: plates 6×128², erosion 6×256² at 4 km, macro 6×512² at 2 km (1.57 M cells).
  - Preview: plates 6×64², erosion = macro 6×128² at 8 km.

**Measurements** (per world, `npm run bench -- --shape sphere`, under load):
- Preview ≈ 1.1 s: plates 75, base 265, stamps 21, LEM 610, refine 5, climate 115 ms.
- Build ≈ 12.7 s: plates 0.15, base 1.0, stamps 0.08, LEM 4.0, refine 5.2, climate 1.7 s. That is 1.15× a flat build up to climate, for 1.5× the cells.
- Flat stays byte-identical: `tests/golden.json` was not re-recorded.
- Flat timings, interleaved A/B against main (6 alternations): build total −0.3 %, preview total +2.3 %. Every stage over 100 ms is within 3 %.

**Tests:**
- `tests/cube.test.ts`: area sum, seam symmetry and directions, corner counts, components, Priority-Flood, distance fields and their continuity, halos, blurs, charts and Noise3.
- `tests/sphere.test.ts`:
  - The LEM strip relief on the sphere is within 5 % of the flat strip.
  - A water world has a zonal temperature spread of 0.19 °C and the right wind bands.
  - The sphere pipeline is deterministic and drains every land cell to the sea.
  - Config and URL rules.
- `tests/sphereView.test.ts`: the projections.
- Sphere goldens (4 previews) are in `tests/golden-sphere.json`; re-record with `GOLDEN_UPDATE=1 npx vitest run tests/golden.test.ts -t sphere`.

**Known gaps:**
- On a water world, precipitation varies by up to ±17 % between longitudes. This is first-order upwind transport on cells that vary by √2, and the moisture sweeps use all 4 rounds.
- Preview cells are 8 km (flat previews: 4 km).
- Climate on the 2 km macro grid takes 1.7 s, mostly the geodesic coast distance.
- AUTO formulas for spheres are first cuts (research 10 §3.3):
  - Peaks reach the summit ceiling on every archetype.
  - Large planets give spiky orographic precipitation maxima.
- Glacial, landforms, hydro, biomes and the registry do not run on spheres (phase 4). Exports save the equirectangular projection.

### Sphere phase 3 — Globe renderer and camera (2026-10-16)

**What landed:**
- **3D globe for sphere worlds.** The 3D view now draws the planet; 2D still shows the equirectangular map or the cube net (P). The phase-2 "globe view arrives in phase 3" fallback is gone. `WorldView.sphere` picks the globe or the flat terrain; flat rendering takes exactly the old code path.
- **Terrain** (`render/terrain/cdlodSphere.ts`, `render/globe/globePass.ts`):
  - CDLOD with six face roots in face angles (a, b), drawn with the flat terrain's 33×33 instanced grid and geomorph. Depth is log2(n/4), so leaf vertices sit every ⅛ cell (250 m on the default build).
  - Node bounds: the 3×3 lattice of the node's directions at R + h_min and, lifted past the arcs' bulge, at R + h_max. Strugar's range test uses the box of that hull, so neighbouring levels differ by at most one across seams too (the equal-angle subdivision of both faces meets a shared edge at the same points).
  - Frustum culling on that box, and horizon culling against the sea-level sphere: a node is skipped when every hull corner is hidden, which is exact because the hidden region (the tangent cone behind the near cap) is convex. At globe zoom about half the nodes go.
  - Precision: one regime instead of research 10 §6.3's two. The CPU computes each node's centre at sea level relative to the eye in float64; the shader adds R × the direction offset from that centre in a form without large cancellations (tan a − tan a₀ = sin(a − a₀)/(cos a cos a₀), and F/|F| − F₀/|F₀| = dF/L − F₀(2F₀·dF + dF·dF)/(L L₀ (L + L₀))), plus h along the direction. Error stays under 5 cm at Earth radius (naive float32 is ~0.7 m); shared seam vertices agree to the same tolerance.
  - The water lid is the sea sphere: the surface is max(h, 0) (spheres have no lakes yet).
- **Textures** (`render/globe/cubeTex.ts`): 6-layer `TEXTURE_2D_ARRAY`s of (n + 4)² texels. The 2-texel border holds the neighbouring face's cells in the generator's halo convention (mirror cells, same as `padFace`), so the hand-filtered `texelFetch` bilinear never leaves its layer. The innermost corner texel holds the mean of the three corner cells, which makes a bilinear sample at a cube corner identical from all three faces (no crack at the 8 corners); outer corner texels are the mean of the two strips. Heights (R32F), climate (RGBA16F, linear) and draped layers are padded; normals come from a mipmapped RGBA16F array of 3D surface-gradient vectors, which are the same quantity on both sides of a seam and so need no padding.
- **CPU height field** (`render/globe/globeGround.ts`): the same padded faces and bilinear as the GPU, per-face min/max pyramids whose base spans each cell's 3×3 neighbourhood across seams (so bounds cover the bilinear reach), and a ray march through the shell between R and R + h_max with bisection.
- **Shading:** spheres have no biome stage yet, so realistic colours are the biome colour table over temperature and an aridity proxy (P / PET with the climate model's Holdridge PET), with 3D value-noise variation (continuous across seams), rock on steep slopes and snow from the seasonal temperature. Without climate, and with the Hypsometric palette, the tints are hypsometric. Oceans use the flat water's depth colours, Fresnel and glint, plus sea ice from temperature. Data layers (plates, boundaries, uplift, temperature, precipitation…) drape as on flat maps. Close up, the fragment height is a cubic B-spline of the 2 km cells, which rounds stair-step coastlines.
- **Atmosphere** (`render/globe/atmosphere.ts`): single Rayleigh scattering through a shell of 2.5 % R (scale height a quarter of it, Earth's vertical optical depth), 12 samples per pixel for the background pass (space, stars, sun disc, limb glow) and 8 per terrain vertex for aerial perspective. Inside the shell it becomes the sky and the haze of low tilted views.
- **Light:** the view's time is the solar time at longitude 0, so the sub-solar point is fixed on the planet and the night side shows. Near the surface the light is the cartographic sun (top-left of the screen) in every pixel's own tangent frame, with the sun model's colours for the target's local time and latitude (`sunLight` takes an optional latitude); it blends to the real sun, with per-pixel day/dusk/night colours and the terminator, between 3 % and 40 % of R altitude. Data-layer modes keep the cartographic light everywhere.
- **Globe camera** (`render/camera/globeCamera.ts`), behind a `ViewCamera` interface that `OrbitCamera` also satisfies, so `OrbitController` and the compass drive whichever camera is active:
  - State in float64: target unit vector and height, distance, pitch, bearing in the local east/north/up frame. Near the surface it is the flat orbit camera in the tangent plane; far out it frames the planet. Auto-tilt follows the flat curve (0 above 200 km).
  - Grab pan rotates the rig about the planet centre: the rotation that takes the cursor ray's hit on the sphere through the grabbed point to that point, then a few damped Newton steps absorb the north-up re-alignment. Trackpad and key pans rotate by metres / radius. Drags past the limb take the nearest limb point.
  - Zoom to cursor: change the distance about the target, then grab-pan the anchor back under the cursor; the target is re-seated on the terrain along the view ray each frame (skipping sub-millimetre moves so a still camera stays idle).
  - Bearing is relative to local north outside |latitude| 85°; inside the polar caps the frame is parallel-transported (no spin), and leaving a cap converts the bearing so the view does not jump. The compass shows the true heading.
  - Fit (Home) shows the whole planet around the current target, north up. Flights follow the great circle with van Wijk–Nuij altitude. The pitch is limited so the top of the view is at most 10° above the horizon. Closest zoom is 40 m/px (2 km cells, no detail map yet).
- **App:** spheres get an equirectangular minimap with the footprint traced along the screen border (`render/globeMinimap.ts`; click or drag to fly), a lat/lon inspector on the globe, and the screenshot export. `WorldView.restore()` re-uploads the globe after a lost context. Quality tiers apply (CDLOD vertex density, MSAA, pixel ratio).
- **Flat-only for now:** the close-zoom detail map, creeks, river ribbons, labels, clouds, valley fog and the horizon shadow/AO pass. Spheres have no rivers or landmarks yet, so only the detail map, clouds and shadows are actually missing; a notice says so once.

**Measurements** (built-in browser pane, Apple Silicon, 1440 × 900 CSS at DPR 2 = 2880 × 1800, 4× MSAA; each frame timed with a synchronous 1-pixel readback, so the numbers include a pipeline stall and overstate real frame times):
- Flat, seed 7, before → after: fitted view p50 7.9 → 7.9 ms (p95 8.6 → 8.8); tilted at 16 m/px p50 22.4 → 22.4 ms (p95 33.1 → 32.4). Identical within noise.
- Globe, default small planet build: whole planet p50 3.9 ms (121 nodes); region view at 300 km p50 8.1 ms (90 nodes); tilted at 30 km p50 10.1 ms (278 nodes). Per-pixel atmosphere in the terrain shader cost ~3.5 ms more at that size; it moved to the vertices.
- Uploading a 6 × 512² elevation (CPU height field, padding, gradients) takes ~250 ms on the main thread, once per elevation layer.
- In the narrow pane (1008 × 1436), with the per-pixel atmosphere: whole planet p50 2.9 ms, region 3.8 ms, low tilted 4.1 ms.

**Tests** (`tests/globe.test.ts`):
- Padding: the seam table matches the generator's, border strips equal `padFace`, and a bilinear sample at each cube corner is the same from its three faces.
- Gradients match the analytic gradient of a smooth field to 5 %, border cells included.
- Vertex precision: a float32 emulation of the shader's position at Earth radius is within 5 cm of float64, and a seam vertex computed from both faces agrees.
- Camera: ray–sphere pick projects back to the pixel; grab pan keeps the point under the cursor (0.01 px), including at 84°–90° latitude near the surface; zoom to cursor keeps the point within 0.5 px from globe view to 10 m/px, pinch and eased wheel; fit shows the whole planet north up; panning 2,000 km across a pole has no NaN and one clean north/south flip of the heading.
- CDLOD: no level jump > 1 between neighbours across seams over 24 camera poses biased toward seams and corners; every horizon-culled node's surface is hidden; every visible surface point is covered by a selected node.
- Flat goldens untouched (generation code did not change).

**Verified in the browser:** the default sphere from space (limb glow, stars, terminator with a faintly moonlit night side, snow on northern ranges, deserts, continental shelves); zooming in to 40 m/px; tilted low views with haze; data drapes (plates) across a cube corner; a search of the framebuffer (sky pass off) for holes in tilted views at four seams, two cube corners and a pole found none; flat → sphere → flat switching; the inspector; screenshot capture; a simulated context loss and restore.

**Known gaps:**
- With 2 km cells and no detail, close views are smooth and featureless; Phase 4's streamed detail tiles fill that in.
- From space, a north-up grab drag over a pole cannot always put the grabbed point exactly under the cursor; it does the best it can.
- The minimap footprint is traced as a polyline in longitude and latitude, so views that contain a pole draw it awkwardly.
- No horizon shadows or AO on the globe (the directional bake of research 10 §6.5 is not built).
- Atmosphere colours are tuned by eye; there is no multiple scattering, and the cartographic and real sun can disagree slightly in sky brightness at mid zoom.
- Elevation uploads are not sliced (~250 ms per layer at build size).
- When the built-in browser pane is hidden, `requestAnimationFrame` stops, so the first fit can run with a 1 × 1 view. Flat worlds also showed a NaN `DetailGround` height in a hidden pane (a pre-existing issue, not looked into here).

### Sphere phase 4a — Glaciers, landforms, hydrology and biomes on the sphere (2026-10-16)

**What landed:**
- **The sphere pipeline runs through biomes** (`SPHERE_STAGES`: plates → … → climate → glacial → landforms → hydro → biome; the timeline shows 10 steps). Only the registry is skipped; the status line says landmarks are not available on spheres yet.
- **Grid helpers** (`grid/grid.ts`, `grid/cube.ts`): `tryCellIndex(g, x, y, face)` continues a planar walk past a seam in the *extended equal-angle chart* of the walk's face (`CubeGrid.chartCell`), `chartXY` gives any cell's position in that chart, `forWindow` works on spheres (each cell of the chart box once, breadth-first), plus `isDiagonalStep` and `stepLength` from the seam table. Lattice walks in an extended chart may hit a cell beyond a seam twice but never skip one, which min/max stamps absorb.
- **Glacial:** ice accumulates by cell area; corridor centrelines are unit vectors on spheres (smoothed in 3D) and each segment is carved in the extended chart of its upstream face; the softening blur and cirque stamps cross seams; fjord spacing is great-circle and the fjord budget scales with √A.
- **Landforms** (`landforms/sphere.ts`): positions are "chart km", `x = f·4W + u`, `y = v` in face f's extended chart, decoded to unit vectors by every helper. Stamps take their cells from geodesic charts (each cell once, so additive stamps are exact across seams and cube corners); Poisson spacing is great-circle; coarse noise is Noise3; fetch rays and relief walks continue across seams; the coast chamfer repeats its pass pair until stable; `settleFixed`/`reconcileFixed` drop the map-edge rule; hotspot heads and atoll chains follow ω × p. Caps of rare coastal features scale with the planet's area. Features carry `face` plus face-local metres.
- **Hydrology:** water balance, discharge and TWI by cell area; the depression hierarchy visits all 8 seam neighbours (a turned face's forward set may miss a pair); `uncross` also tests the three other 2×2 blocks of seam cells (at a cube corner the block has three cells and cannot hold two diagonals), and on spheres the flats walk defers diagonal steps that would cross a block's other diagonal, then a second `uncross` pass may move either cell. River geometry (Chaikin axis, Kinoshita meanders, monotone surface) runs in 3D with the side vector up × tangent; deltas are laid out in the tangent plane at the apex; lake centroids are mean directions. Graph metrics (length, Hack, longest river, crossings) use 3D chords.
- **Biomes:** Noise3 jitter, the river-mouth and 3×3 majority rules through seam neighbours (7 at cube corners), metric slopes, area-weighted shares.
- **River and lake position convention (for the registry in 4c):** `RiverGraph.face` (Uint8Array) and `LakeInfo.face`; x/y are face-local metres (u, v) in the grid's SurfacePoint convention, u = (a + π/4)·R, so cell (cx, cy) has its centre at ((cx + ½)·cellM, (cy + ½)·cellM). `shared/cube.ts` converts: `surfaceDir(face, u, v, R)`, `dirSurface`, `surfaceLatLon`. Flat graphs have no `face` and are unchanged. Inside the generator `GraphBuilder` holds 3D points (m from the planet centre) on spheres and converts in `finish`.
- **Globe rendering:** realistic colours from the biome stage (its P/PET in the LUT, cover masks for sand/erg, marsh, rock and perennial snow, seasonal snow as on flat maps); the climate proxy stays as the fallback until the biome layers arrive. Lakes are in the water lid: the hydrology water level is spread two rings past the shore across seams (`prepareWaterSphere`), and the CPU height field's padded surface is also the GPU's surface texture. River ribbons (`render/water/globeRivers.ts`) are built per node along its direction at R + water surface, with the globe's per-vertex light and aerial perspective. Flat rendering is unchanged.

**Measurements** (default small planet, earth; `metrics/out-scratch` drivers):

| | Seed 7 | Seed 11 | Seed 42 |
|---|---|---|---|
| Preview: lakes / glaciers / fjords | 280 / 368 / 16 | 255 / 369 / 11 | 441 / 431 / 11 |
| Preview: reaches by Strahler order 1–5 | 3167 1249 452 179 1 | 3080 1312 442 155 17 | 3146 1148 361 41 – |
| Preview: deltas (bird's-foot / cuspate) + estuaries | 12 / 5 + 7 | 17 / 5 (+1 arcuate) + 10 | 20 / 5 + 17 |
| Build: lakes (> 10 km²) / salt / playas | 888 (342) / 25 / 54 | 777 (334) / 9 / 29 | 1265 (610) / 4 / 9 |
| Build: glaciers, land ice share | 1269, 0.16 | 1041, 0.22 | 1385, 0.24 |
| Build: river nodes, reaches by order 1–7 | 540 k; 59920 23442 12622 4970 1479 595 | 551 k; 60184 23527 12757 5918 1622 879 75 | 520 k; 60017 23019 11943 4794 1141 208 |
| Build: deltas + estuaries, longest river | 17 + 7, 932 km | 22 + 10, 1146 km | 25 + 11, 570 km |

- Stage times, preview ≈ 1.8 s total: glacial 70–80, landforms 125–145, hydro 215–245, biome 42–46 ms. Build ≈ 16.5 s total: glacial 0.45, landforms 0.65, hydro 2.5–2.7, biome 0.5 s.
- Flat goldens are byte-identical (`tests/golden.json` untouched); only the sphere fixture was re-recorded (its stages up to climate kept their hashes).
- Flat `npm run bench`, interleaved A/B against main: build total −0.0 %, preview total +1.4 % (the preview landforms stage +7 ms, inside noise elsewhere).

**Tests:** `tests/sphereHydro.test.ts` (stages and layers, termination, mouths next to the sea or a lake, monotone water, no crossing receivers in any 2×2 block including seams, lakes flat and at or below spill by a Priority-Flood fill, outlets at the lake level, seam continuity of the river graph, drainage, biome determinism, ribbon geometry); `tests/sphereLandforms.test.ts` (stamps across seams and cube corners, great-circle spacing, the chamfer against Bellman–Ford, `line4` over a seam and a corner, fetch exposure of a sea on a seam, landforms determinism and valid feature positions).

**Verified in the browser:** the default sphere (seed 7) from space and at regional zoom: biome colours, lakes with smooth shores, river ribbons and dashed ephemeral channels, volcanoes, coastal barriers and lagoons; no console errors.

**Known gaps:**
- Polar ice: 16–24 % of the land on builds and ~30 % on previews; no ice-sheet cap yet.
- Links from a tributary into a lake outlet's first node can be up to ~1.2 cells long (as on flat maps); every other link is ≤ 1 cell, across seams too. Graph polylines still have a few meander contacts (11–17 per 540 k nodes, the flat rate).
- Coast lengths and per-coast-km rates use the nominal cell size (~8 % high on spheres); atolls can be slightly elliptical near face edges; the dune azimuth mask is in face axes and not drawn on the globe.
- Close views of the globe still have 2 km cells (detail tiles are phase 4b). Reefs, craters and cliffs are not drawn on the globe; canopy does not darken the globe colours.
- The registry (landmarks, names, labels) is phase 4c; landform features and lakes already carry (face, u, v).

### Sphere phase 4b — Close-zoom detail on the globe (2026-10-16)

**What landed:**
- **Streamed detail tiles** (`render/globe/detailTiles.ts` pure parts, `render/globe/globeDetail.ts` GPU), research 10 §6.7:
  - Lattice: k detail texels per macro cell (the power of two nearest cell / 250 m), each face n·k texels, split into T × T tiles of N texels. Default small planet: 250 m texels, 4 × 4 tiles of 1024² per face (256 km). Each tile is stored with a 12-texel margin and built with a 48-texel apron, both in the face's gnomonic chart extended past the face edge.
  - A tile is a pure function of (seed, world, face, tile). Per world (sliced, ≈ 0.2 s CPU): padded macro, water level (the sea at 0 until the sphere hydrology lands), a coastal band (cells whose 3×3 neighbourhood across seams holds sea and land) and an RGBA8 control cube (roughness, rock, water proximity). Per tile (≈ 2–3 ms CPU): local rasters, exact inside the face and sampled by direction across seams.
  - GPU build: the flat detail map's passes over a tile-local head (`detailBuildSources(head)`; the flat shader sources stay byte-identical, tested by hash). Cap and river carve by depth-MIN, base = Catmull-Rom macro + baked 3D noise + coastal noise, 12 thermal, 24 pipe-model hydraulic, 12 thermal, re-anchoring (±60 m). The core and margin are then copied into a slot of an R32F `TEXTURE_2D_ARRAY` and read back through a PBO for picking. Without float render targets tiles are built on the CPU (no hydraulic erosion or re-anchoring), sliced.
  - Streaming (`TileCache`): a tile is wanted while its nearest point is drawn at under 2.5 texels per pixel and may be above the horizon; in-frustum tiles come first, each group by distance. One build at a time, LRU eviction of tiles no longer wanted, and a new tile fades in over 0.4 s.
  - Time slicing: `update()` runs ≈ 3 ms (2 ms while moving) of CPU plus estimated GPU work per frame and never waits on the GPU (fences). Shaders compile with `KHR_parallel_shader_compile` when present. With `EXT_disjoint_timer_query_webgl2` the per-pass GPU estimates are calibrated against measured time (they were ≈ 3× low on Apple silicon).
  - Quality tiers: high 12 slots of 1024², medium 8 of 1024², low 8 of 512² (same 250 m texels, 16 hydraulic and thermal steps).
- **Globe height function** (`render/glsl/globeDetail.ts` ↔ `render/height/globeHeightFn.ts`; the GLSL is generated from the TS constants):
  - Far out it is exactly the phase-3 bilinear macro. Below two texels per pixel the base is the resident tiles, blended by a partition of unity: each tile's weight ramps over ±8 texels at its edges, computed in its own face chart, then normalised. The Catmull-Rom macro takes the share of missing or fading tiles. Near a face edge the faces across it are visited too, so seams and the 8 cube corners need no special cases.
  - Octaves: footprint-faded, derivative-damped, ridged 3D value noise at the sea-level point dir·R. It uses an integer hash on a 3D lattice, evaluated from the eye's 65 536 m lattice tile plus a camera-relative offset, so it is seamless and precise at Earth radius. The amplitude comes from the control cube and is capped so the octaves never cross the sea level.
  - Two deliberate departures from the flat function, both for continuity:
    - The Catmull-Rom is not clamped to the four nearest texels; that clamp jumps where the set changes at texel edges.
    - The slope damping accumulates the unridged octave gradient. The ridged one flips sign at the crease, which made the damping, and so the height, jump by up to ~1 m.
  - The VS uses the morph-coupled footprint as on flat maps; the FS evaluates the height and its 3D tangent gradient per pixel. With detail, the phase-3 B-spline rounding is no longer used.
  - `GlobeDetailGround` (camera clamps, picking, zoom to cursor) is the TS port with a Lipschitz ray march; beyond two texels per pixel it is the macro height field and its fast march. The closest globe zoom is 8 m/px once the detail exists (40 without). CDLOD depth then gives ~16 m leaves, and node bounds are padded by the detail's reach.
- **Coastlines:** the shoreline is the zero contour of the detailed height (the sea lid uses the same h), no longer the bilinear contour of the 2 km cells.
  - Inside the coastal band the tiles' water bounds relax, and a slope-scaled coastal noise moves the coast by up to ~0.35 cells (2–60 m of height).
  - Outside it, land stays ≥ 0.5 m and sea ≤ −0.5 m as on flat maps, so detail never makes inland seas or open-ocean islands. The shader octaves never flip land and sea.
- **River-carving hook:** `GlobeDetailWorld.rivers` takes a `SphereRivers`: the river graph's n, zWater, zBed, width and down, plus each node's unit direction. Tiles project the nodes into their chart and reuse the flat `riverSegments` and carve pass; without it nothing is carved. `waterLevel`, `waterClass`, `discharge` and `biome` (6-face rasters on the elevation grid) feed the bounds and the control when present. `main.ts` passes them when layers of the same stage exist and leaves `rivers: null` with a comment.
- **Fixed: NaN camera in a hidden pane (flat and globe).** A hidden or collapsed page reports a 0 × 0 canvas. `WorldView.resize` handed that to the cameras, whose fit distance, target and metres per pixel became NaN (aspect 0/0, division by viewH). A NaN footprint passes every fade test in the height function, so `DetailGround.heightAt` returned NaN too. Zero sizes are now skipped (`applyViewSize`), and `DetailGround` sanitises its footprint.
- **Also fixed:** `GlobeHeightField` now lids the padded raw elevation, as the shader does, instead of padding the lidded one; the two differed at the cube-corner texels.

**Measurements** (built-in browser pane, Apple Silicon, 504 × 718 CSS at DPR 2 = 1008 × 1436, 4× MSAA; each frame timed with a 1-pixel readback; the pane was hidden, so frames were driven by script):
- Frame time with detail: whole planet p50 1.8 ms (no tiles wanted); region at 300 m/px 4.4 ms; 10–12 m/px top-down 5.7–5.9 ms, against 3.1–3.3 ms with detail off; tilted 60° at 30 m/px 8.1 ms (185 nodes).
- Tile builds (high tier, 1120² rasters):
  - ≈ 47 ms of GPU per tile, spread over ≈ 10–17 frames, so ≈ 170–300 ms wall per tile at frame rate; 12 tiles around a new view take ≈ 2–4 s.
  - GPU per build slice: p50 3.5 ms, p95 4.2–6.6 ms. CPU per slice ≤ 3–4 ms (the per-tile preparation is the largest). Readback ≈ 15 ms wall.
  - The first tile after a page load also compiles the 15 build programs (≈ 270 ms wall); one ≈ 80 ms frame was seen once.
- World preparation: ≈ 0.2 s CPU (node), ≈ 1.3 s wall at frame rate.
- Memory:
  - High: on the GPU, 52.7 MB of tiles, 6.4 MB of control and 120 MB of build scratch (freed 5 s after the last build); on the CPU, 53 MB of tile copies and 25 MB of padded rasters.
  - Medium: 35 MB of tiles, the same scratch.
  - Low: 9.2 MB of tiles and 35 MB of scratch; 9 MB of tile copies.
- `GlobeHeightFn.sample` ≈ 0.15 µs without tiles. A CPU fallback tile takes ≈ 0.7 s, sliced.
- Flat maps: the flat code path is unchanged. The build shaders and `DETAIL_GLSL` hash identical; only the resize guard and the footprint sanitising are new. Fitted view p50 3.3 ms, tilted at 18 m/px 6.6 ms in the same pane.

**Tests** (`tests/globeDetail.test.ts`, `tests/hiddenView.test.ts`):
- Lattice sizes per tier; partition of unity of the tile weights; chart gradients against finite differences.
- Noise: the 3D hash is bit-exact against BigInt, and `noise3` matches a float32 port of the GLSL camera-relative path at 652 km and at Earth radius. Also noise gradients, GLSL generated from the constants, and the flat shader sources unchanged (hash).
- Tiles (CPU reference build on a tiny 6 × 16² planet):
  - Deterministic per tile and seed.
  - Within the bake + coast amplitude of the macro; water and land are kept outside the coastal band.
  - Continuous across a tile edge, a face seam and a cube corner (max step < 0.5 m); the two tiles at a seam agree within tens of metres.
  - A river given through the hook is carved.
- Height function:
  - Equals the phase-3 globe far out.
  - On steep terrain, refined around the largest step, no jump exceeds 5 cm. This test caught the clamp and ridge-damping jumps.
  - Octaves never cross the sea level; the gradient matches finite differences; detailed picking agrees with its own heights.
- Streaming: nothing is wanted at globe zoom, the tile under a low camera comes first, wanted tiles are never evicted, LRU recycling works, and so do the fade-in and the index texture.
- Hidden view: a 0 × 0 view made the camera NaN; `applyViewSize` keeps both cameras finite; `DetailGround` stays finite for NaN, 0, negative and infinite footprints.

**Verified in the browser:**
- Zooming from space to 10 m/px on a coast: the 2 km cells' polygonal coast becomes a natural curve.
- A snow-capped range at 25 m/px top-down and tilted 60°. Detail on vs off raises the image's high-frequency energy ≈ 13× at 25 m/px.
- Across the face 0 | face 4 seam and the corner of faces 1, 2 and 4: on the GPU-built tiles, the height across those seams, the corner and a tile edge shows no step. Refined to 0.6 mm spacing, the largest step is ≈ 2 mm.
- Switching to the low tier rebuilds with 512² tiles. A flat world with the canvas hidden (0 × 0) keeps a finite camera.

**Known gaps:**
- There is one tile LOD (250 m) plus the macro, with no coarser tile level, so far parts of tilted views use the macro and octaves only. The two are blended by footprint, plus the 0.4 s fade-in when a tile arrives.
- Tile texels are equal-angle, so their metric size varies by up to ~1.4× across a face; erosion constants use the nominal texel.
- In a tile's apron across a seam the macro is resampled bilinearly, so the two tiles at a seam differ by up to tens of metres before the blend.
- No dunes, lakes or rivers on spheres yet: the sea at 0 is the only water, and nothing is carved until the hydrology passes `rivers` and `waterLevel`.
- The coastal noise can make small lagoons and skerries within ~2 cells of the coast.
- The control cube is at macro resolution (2 km), so amplification fades within about a cell of water.
- Tiles are rebuilt only when the elevation layer changes, so a biome layer that arrives later does not reach the roughness (it falls back to the default biome).
- With the browser pane hidden, `requestAnimationFrame` runs at ~1 Hz, so world preparation and streaming take tens of seconds there (they advance per drawn frame).

**After merging Sphere phase 4a** (lakes, biome colours and river ribbons on the globe):
- The tiles now get 4a's data: the prepared water levels and classes, discharge and biome, and the sphere river graph as `SphereRivers` (node directions from `surfaceDir`). They rebuild when the elevation, the water, the river graph or the discharge/biome rasters change (`WorldView.setGlobeDetail`, called from `showSphere` as the layers arrive). With 540 k river nodes, nodes are bucketed by tile once per world (≈ 0.3 s sliced), so a tile's preparation stays ≈ 4–6 ms.
- The detail uses its own water level (`u_wlevelD`): 4a's prepared levels with river cells left out and spread again, so river levels don't flood the detailed valley floors. A dry cell that is lower than a nearby lake's spread level is not water either: the effective level (`wetLevel`) sinks by 1 km where the real-water mask (cells with their own level, not rivers) reaches 0. This removed ponds strung along valleys next to lakes. Tile bounds, the lid, the octaves' room and the FS water test (which fades from 4a's level to this one with the detail weight) all use it.
- Channel floors: a depth-MIN pass writes each channel's bed (−1 m) as a lower bound, so erosion can no longer dig gorges under the ribbons (it had, by tens of metres on steep reaches).
- The Catmull-Rom clamp is back, as a continuous envelope: the 2×2-texel cell extremes of the 3×3 cells around the point, interpolated on the dual grid (= the flat clamp at a cell centre, no jumps at texel edges). Without it the cubic overshot over narrow channels.
- At river nodes inside resident tiles (40 k samples, default world), the detailed surface minus the ribbon's zWater is p50 −1.3 m, p5 −7.5 m, p95 +2.1 m, p99 +6.8 m; 8.6 % of nodes are buried by > 1 m. On 4a's macro surface 85 % were buried by > 1 m (p50 +20 m). The remaining error is mostly the 250 m texels on steep reaches (≈ 5 m of drop per texel) and bends.
- GlobePass binds the detail at units 9–11 and the detail water at 12–13; 4a's units 0–8 are unchanged. The globe notice now says only labels and clouds are missing.

### Sphere phase 4c — Landmarks, names, labels and the Atlas on spheres (2026-10-16)

**What landed:**
- **The registry runs on spheres** (`SPHERE_STAGES` ends with `registry`; the timeline shows 11 steps, and the "landmarks are not available on spheres yet" status is gone).
- **Positions** (`registry/geo.ts`): detectors keep passing one (x, y) pair around, as on flat maps. On a sphere x carries the face, x = face · π·R + u, y = v (face-local metres in the 4a convention), so `cellX`/`cellAtM` work on every registry grid of the world. Positions are only compared through `Geo` (great-circle `dist`/`d2`, `angleOf`/`angleAlong`/`angleFromCell` for label angles in the anchor face's axes) or decoded. On flat maps the stride is 0 and every helper is the planar expression the detectors used, so flat outputs are byte-identical.
- **Sphere-aware detectors:**
  - Exact cell areas for areas and shares (`compKm2`, `cellsKm2`, area-weighted sea basins); the world area is 4πR² and `worldKm` is the equal-area size √(4πR²).
  - Components carry mean unit vectors (`Components.dir`) for centroids (islands, archipelagos, ice caps, wood patches, island languages); `nearestWhereM` searches a geodesic disc through `chart`.
  - Ranges and rifts: PCA in the azimuthal-equidistant tangent plane at the weighted mean direction (`pca` → `Axes.plane`, `axesXY`, `axesDir`); crest smoothing and bin means on unit vectors.
  - Gulfs and bays: rays straight in the extended equal-angle chart of the cell's face (`tryCellIndex`), crossing seams.
  - Volcano summits, gorge depth and the world fill's cover disc use charts / `forWindow`; peak, pass, strait, waterfall, canyon, gorge and hero spacing are great-circle; the fill's spacing set hashes 3D positions (`NearSet`).
  - River polylines: `decimateS`, `alongS` (3D interpolation; the label direction comes back in the anchor face's chart).
- **Oceans** (`water.ts` `splitOceans`): the world ocean (the largest sea body, ≥ 10 % of the planet) is split by the same distance-from-land merge tree as seas: basins holding ≥ 3.5 % of it, whose centre is ≥ 5 % of the equal-area size from land and whose passage to a deeper basin is ≤ 0.7 × that distance, are nuclei (the root always; at most 5). Every world-ocean cell belongs to the nucleus it resolves to, so the oceans partition it; the other kept basins are seas. Seed 7 has 2 oceans, seeds 11 and 42 have 3.
- **Ranking and budgets:** a globe view shows a hemisphere, so the world-band budgets and the W label cap count 2 W views on spheres (`SPHERE_W_VIEWS`). The world band's metres per pixel is the whole planet fitted into a 700 px view (2.2 R / 700), and continents and oceans always read there. Hero spacing is a quarter of the equal-area size along the surface.
- **Names:** culture centres are uniform on the planet and a landmark speaks the language of the nearest one along the surface; name identities hash the encoded position, so they include the face.
- **Traits:** "A temperate world of …" ("ocean world" below 20 % land), a planet bullet ("Planet: 4,096 km around (radius 652 km), 3 oceans, ice caps at both poles (… km² north, … km² south)."), land share of the surface. Fjord coasts are judged per land area, and polar caps (beyond ±60°) do not make an icy world.
- **Landmark contract** (`shared/landmarks.ts`): sphere landmarks add `face` (x, y are face-local metres) and paths add `pathFace` (one face per point); `angle` is in the anchor face's axes (+u east, −v north). Flat landmarks are unchanged. The registry stage returns the ocean partition as `extra` (`RegistryExtra`) on spheres, for tests.
- **Labels on the globe** (`render/labels/*`):
  - `LabelEngine.setLandmarks(list, worldM, radiusM)` places sphere landmarks with `surfaceDir`; anchors are R + the rendered height (the detailed `GlobeDetailGround` where tiles are resident, else the macro height field), path vertices are unit vectors, rotated labels use the tangent of the face-axes angle.
  - `Projector` takes the camera's own frame (`LabelCamera.axes`, the globe camera's right/up/forward).
  - Far-side and horizon culling: a point (anchor or path vertex) is drawn only while the eye is above its tangent plane by `GLOBE_MIN_FACING` = 0.3 (cosine). The sea-level sphere lies below every tangent plane above it, so this one test also covers the horizon; 0.3 keeps names from hanging off the limb. A label that turns away goes at once instead of fading at its old screen position.
  - Zoom bands use the metres per pixel at the anchor (view depth); tilted views keep the terrain occlusion raycast against the globe.
- **App:** Atlas rows and label taps fly along great circles (`GlobeCamera.flyToDir`) framing the feature; Atlas rows show latitude / longitude on hover; the globe and 2D-map inspectors name the nearest place along the surface (`app/landmarkNav.ts`); the globe notice now only mentions clouds.

**Measurements** (default small planet, earth):

| | Seed 7 | Seed 11 | Seed 42 |
|---|---|---|---|
| Preview landmarks / oceans | 1586 / 2 | 1576 / 3 | 1624 / 3 |
| Preview: seas, gulfs, bays, straits | 2, 5, 20, 3 | 5, 1, 20, 2 | 4, 5, 20, 2 |
| Preview: continents, islands, peninsulas, capes | 2, 39, 13, 12 | 2, 32, 9, 12 | 4, 40, 10, 12 |
| Preview: ranges, peaks, hills, passes, volcanoes | 7, 458, 117, 290, 30 | 6, 449, 119, 291, 32 | 6, 433, 128, 286, 30 |
| Preview: rivers, lakes, waterfalls, deltas, canyons, gorges, fjords | 129, 141, 152, 2, 7, 42, 6 | 142, 125, 152, 6, 7, 43, 6 | 142, 177, 152, 6, 5, 43, 5 |
| Preview: deserts, forests, grasslands, wetlands, ice caps, glaciers | 3, 11, 3, 53, 3, 8 | 3, 19, 5, 47, 3, 6 | 2, 11, 5, 58, 3, 8 |

- Counts scale with the land area (2.1 M km², about 6× a default flat world), as the caps were tuned to (M8 rec. 9).
- Registry time: preview 345–375 ms (flat preview ~80–150); build (seed 7) 1.6 s, 4271 landmarks (2616 of them area-band hills). The largest parts are the fills and regions, whose distance fields run as geodesic Dijkstra on spheres.
- Label engine (node, `tests/labels.test.ts`): 1200 globe landmarks under a camera that spins and zooms every frame, median 0.11 ms per frame; flat worst case unchanged (3000 landmarks, 0.46 ms static, 0.82 ms panning).
- Flat `npm run bench` against main (2 interleaved alternations, seeds 7 + 11 summed): preview total +1.7 %, build total +0.8 %. The registry stage is +12 % (+15 ms preview, +44 ms build) although its flat code paths compute the same values (goldens byte-identical); the sub-laps point to V8 tiering of the longer detector functions (more Maglev OSR exits). Moving sphere-only closures into helpers brought it down from +17–24 %. Stages the change does not touch move by up to ±15 % between runs at this size.

**Tests:** `tests/sphereRegistry.test.ts` (11 sphere stages; every landmark has an integer face and a position on it, land kinds on land and sea kinds at sea, paths with per-point faces and no jumps; the oceans partition the connected world ocean with areas that add up and one anchor in each; unique names; hero spacing along the surface; determinism in this thread and in 6 fresh isolates, the Maglev pattern of `tests/jitDeterminism.test.ts`). `tests/labels.test.ts` adds a globe suite: no point label is ever drawn on the far side over 240 frames of a turning, zooming globe; projector parity with `GlobeCamera.project`; rotated and path labels on the near side, flat landmarks skipped on a globe, both gone when the globe turns. Flat goldens are byte-identical (`tests/golden.json` untouched); only the sphere fixture was re-recorded (its stages up to biome kept their hashes).

**Verified in the browser:** the default sphere (seed 7, build) from space with its continent and two ocean names; rotating the globe moves the names with it and drops those that reach the limb; an Atlas fly-to (Poho Mountains) along a great circle to a regional view with rotated range names, a river named along its course, bays and a gulf; no console errors.

**Known gaps:**
- Long names of anchors near the limb can still reach a little past the disc (labels are screen-aligned billboards).
- The world-band numbers (2 W views, 2.2 R / 700 px) are first cuts; the metrics harness has no globe band (G) yet.
- Ice and peak counts mirror 4a's gaps: up to ~25 % of land is ice and the highest peaks reach ~8.9 km, so the traits often say "a world of ice".
- Preview canyons use the 8 km regional cells' 3 × 3 relief, so some are long (hundreds of km).
- Registry grids use nominal cell areas for merge-tree thresholds (≈ 15 % high on average); reported areas are exact.
- Labels on the 2D sphere map (equirectangular / cube net) are not drawn; the 2D inspector names the nearest place.

### Sphere phase 4d — Metrics on spheres and tuning (2026-10-17)

Full write-up, with baseline and tuned tables per archetype and band: [research 11](research/11-sphere-metrics.md).

**What landed:**
- **The metrics harness runs on spheres** (`metrics/world.ts`, `metrics/lib/sphere.ts`, `npm run metrics -- --shape sphere`):
  - Viewports are spherical caps: azimuthal equidistant about centres drawn ∝ true cell area on land, or area-uniform; no clamping.
  - W is a fixed 1,024 km cap. A new band **G** is the whole planet: an orthographic disc, features facing the eye by ≥ 0.3, "distinct" = 20 px at the registry's globe scale, target 15–40, empty cap 2R/5.
  - True cell areas, great-circle Clark–Evans, cluster disks, hero spacing and quiet land, components across seams, coast box counts per face.
  - Per-world count rows scale with the planet's area (fjord coast with its square root; ranges and heroes use their resolved ranges).
  - New options: `--planet-sizes` (sweep against 4,096 km), `--equal-area` (each planet against a flat world of the same area) and `--pins`.
  - Flat output is unchanged (checked field by field against the old harness).
- **Tuning, all sphere-only:**
  - Relief: uplift calibrated with its first cell capped at 2.5 km (less beyond 8 km cells), and no peakHeight size bonus.
  - Glaciation reads the Earth-like 65° reach.
  - Precipitation: a one-cell storm blur minimum and area-aware upwind weights.
  - Lake density scales with max(0.5, min(1, 4 km / cell)).
  - Plates: 64 motion candidates, then excess long rifts and ranges become transforms.
  - Registry: the world budget, fill and a local label tier at the 1,024 km W cap, with a local cap of 40 W-scale features within 512 km; a globe-scale fill and a globe label cap of 36.
  - Preview canyons search their rims within 6 km.
  - Also true coast edge lengths, mean cell areas for merge-tree thresholds, and a sphere drainage-density coefficient.
- **Globe labels near the limb:** a point label whose boxes would reach past the planet's disc on screen is not drawn (`LabelEngine.insideDisc`).

**Measurements** (seeds 1–20, small-planet previews; baseline = Phase 4c on this harness):
- **Band W:** 0–55 % → **70–100 %** of seeds (flat 80–100 %). Build subset 33–67 % → **100 %**.
- **🎯 targets:**
  - Ranges 45–100 % → **100 %**, rifts 5–100 % → **100 %**, everywhere.
  - King summit 0–40 % → 85–100 % on 8 archetypes (rift 25 %, volcanic 40 %; flat 60 %).
  - Land above 2 km 85–100 %, except desert at 65 % (flat 90 %).
- **Relief:**
  - p95 peak 7.1–8.1 km → **4.9–6.0 km** (flat 4.6–5.3). The highest summit is 8.5–8.6 km (craton 6.3).
  - Land above 2 km 0.14–0.23 → 0.06–0.12 (flat 0.07–0.13).
- **Ice share of land:** earth 0.20 → **0.08**, fjordland 0.11, iceage 0.19, hothouse 0.02. "A world of ice" headlines 25–100 % → 0 % (1 ice-age seed in 20).
- **Labels:** W labels per screen p95 82–134 → **44–52**, G 55–96 → **28–42**. Cluttered seeds 100 % → 0 % on 7 archetypes (20–40 % on archipelago, fjordland and volcanic, from W views over 60 features).
- **Precipitation on land, earth, max:** 12,500 → **9,600 mm/yr** on the small planet; 33,000 → 12,400 at 8,192 km; 35,000 → 10,100 at 12,000 km. The water world's zonal spread is ±15 % (was ±17 %).
- **Timing:**
  - Flat `npm run bench` against main, interleaved: preview −0.5 %, build −0.4 %.
  - Sphere bench: preview 3.59 → 3.65 s (seeds 7 + 11), build 33.8 → 33.5 s. The sphere registry is a little faster: its fill now updates the distance field around each mark.
- **Flat goldens** (`tests/golden.json`) are byte-identical. Only `tests/golden-sphere.json` was re-recorded.

**Tests:**
- `tests/metrics.test.ts`:
  - cap views keep ground distances and round-trip, poles included;
  - the globe view's facing cut;
  - area-uniform directions and area-weighted cell picks;
  - great-circle nearest neighbours against brute force, and Clark–Evans for random (≈ 1), lattice and clustered points;
  - box counting over faces;
  - band lists and sphere count ranges;
  - a sphere run with bands G–L and true areas.
- `tests/labels.test.ts`: a long name near the limb is hidden while it still faces the eye, and a short one shows.
- `tests/sphere.test.ts`: the water world's precipitation bound tightened to 35 %.

**Known gaps:**
- **Band G passes on 0–40 % of seeds.**
  - A hemisphere holds ~2.4 W views of land, so G sees too many W-scale features: p50 39–53, p95 53–67.
  - Interiors keep 250–450 km disks with no globe-scale feature.
  - Passing it needs fewer, larger features at globe scale, not more W-scale ones.
- **R, A and L in previews are 0 %.** The 8 km preview cells under-resolve rivers, lakes and summits. Builds behave like flat builds (R empty disks pass; R counts fail on p95 on both shapes).
- **W on volcanic (70 %)** is limited by unbudgeted lakes on glaciated land.
- **Size invariance** fails by construction with the fixed 6 × 128² preview grid (4–23 km cells over the sweep).
- **Equal-area flat comparison:** spheres now match the default flat world, not flat worlds of 1,155–2,311 km, whose untuned AUTO formulas over-build relief at 9 km cells.
- **Remaining zonal spread:** precipitation on a water world still varies by ±15 % between longitudes. This is first-order upwind transport.
- **Flat registry:** the +12 % on builds since 4c (≈ 45 ms) is unchanged. It is spread over the rivers and naming sub-laps.
