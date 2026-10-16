# 05 — Scale, Density and Landmark Statistics

Scope: how to make a finite procedural world (default 1024 × 1024 km, presets 512–4096 km) feel **neither too compressed nor too empty** at every zoom level from whole-world down to ~10–20 m/px. The note covers real-world reference statistics for each landmark type, how games and generators handle perceived scale, a density framework, a concrete density table for the default world, and automated metrics.

Conventions:
- **Sourced** numbers have a link in §8.
- **(est.)** marks an estimate or a number derived here by arithmetic from sourced figures. Treat these as tuning starting points, not facts.
- "Per 10⁵ km² land" means per 100,000 km² of land, roughly the size of Iceland or South Korea.

---

## 0. Recommendation summary

1. **The default world is small by Earth standards.** 1024² km ≈ 1.05 × 10⁶ km²; at 40% land that is ≈ **4.2 × 10⁵ km² of land**, about Sweden or California. At literal Earth densities many headline features get an expected count below 1: rivers > 1000 km (~0.3), confirmed impact craters (~0.5), atolls (~0.8 in tropical seas), geyser fields (≪1). Realism alone produces a world that feels empty of "wow" features. The fix is **explicit rarity tiers with per-world guarantees**, not raising the base densities.
2. **Specify every density in physical units** (per 10⁵ km² land, per 1000 km coastline, per 1000 km arc, per 10⁵ km² ocean). Counts then scale with world size and density stays constant. Draw counts as `Poisson(λ·A)`, then clamp to `[min, max]`. Tier guarantees apply per world, not per area.
3. **Clustered features need cluster processes.** Volcanoes, lakes, islands, glaciers and geysers are strongly clustered on Earth: a volcanic arc runs ~10–40 volcanoes per 10⁵ km², and the global mean is ~1. Use parent–child processes (arc → volcanoes, glaciated shield → lake district, hotspot → island chain) together with per-class Poisson-disk minimum spacing. This produces busy and quiet zones by construction.
4. **Use an "interest budget" per zoom band.** Use four bands, each 4× apart: World (~1000 km view), Region (~250 km), Area (~60 km) and Local (~16 km, 10 m/px). Each band has a target count of *scale-appropriate* distinct features per viewport and a maximum empty-disk radius. Measure both by sampling random viewports over many seeds.
5. **Climate is compressed by a configurable factor.** 1024 km spans only ~9° of latitude, which yields 1–2 climate zones. Map the world's N–S extent to a virtual latitude span (default ~35°, ≈ 4× compression) so a default world holds 3–5 biome belts. Leave it as a slider.
6. **Use view-dependent vertical exaggeration:** ~1× at local zoom rising to ~4–8× at world zoom. Top-down relief at 1000 km with 5 km of relief has an aspect ratio of 0.005 and reads as flat otherwise.
7. **Self-similar detail:** the world-gen stores structure down to ~100–200 m. Below that, a deterministic on-the-fly detail pass adds creeks, gullies, ravines and micro-relief (seeded by world position) so every zoom step reveals new structure. The test is a radially averaged power-spectrum slope that stays roughly constant (β ≈ 2) across bands.
8. **Hero landmarks:** every world gets 3–5 guaranteed heroes drawn from a menu (great massif, great river and delta, great lake, fjord coast, volcano chain, crater, erg, canyon, archipelago). Each is legible at world zoom (≥ 1.5% of world width) and placed with mutual spacing ≥ world_width/4.
9. **Validate across ≥ 200 seeds per preset** with metrics for counts per tier, viewport feature counts (p5/p50/p95), largest empty disk, Clark–Evans clustering ratio, spectral slope and Horton/Hack fits. A "boring seed" and a "cluttered seed" are both test failures.

---

## 1. Real-world reference statistics

### 1.1 Land, coasts and islands

| Quantity | Value | Source / note |
|---|---|---|
| Land fraction of Earth | ~29% (149 × 10⁶ km² land, ~361 × 10⁶ km² ocean) | standard figure |
| Islands (Global Islands DB, 30 m Landsat) | 340,691 total: **21,818 islands > 1 km²**, 318,868 < 1 km², plus 5 mainlands | Sayre et al. 2019 [S1] |
| Island size distribution | Korčák's law: N(>A) ∝ A^(−b), Mandelbrot's values b ≈ 0.5 (Africa) to 0.75 (Indonesia), mean ≈ 0.65 | [S2] |
| Coastline fractal dimension | Britain D ≈ 1.25 (some 1.31); Norway (fjords) D ≈ 1.52 | Mandelbrot 1967 [S3], [S4] |
| Derived: islands > 100 km² | ≈ 21,818 · 100^(−0.65) ≈ **1,100** (est.) | Korčák with b = 0.65 |
| Derived: islands > 10⁴ km² | ≈ **55** (est.); real lists give roughly 60–80, so the power law holds roughly | |
| Derived: islands > 1 km² per 10⁵ km² land | ≈ **15** (est.); 21,818 / 1,490 | Islands cluster heavily (Canadian Arctic, Indonesia, Philippines, Scandinavia) |
| Atolls | **439** (Goldberg 2016); ~440 commonly cited; 39% mostly subtidal | [S5] |

Implications:
- **Coastline roughness should vary along the coast.** Use D ≈ 1.1–1.2 for depositional/passive coasts, ~1.25 as a general default, and ~1.5 for fjord/skerry coasts. A single global noise octave setting cannot produce both.
- **Island counts follow a power law, so generate them from one.** Each tenfold step in area reduces the count by ~4.5× (10^0.65).

### 1.2 Mountains and relief

| Quantity | Value | Source / note |
|---|---|---|
| Range dimensions | Alps ~1,200 km × ~200 km; Himalaya ~2,400 km × 150–350 km; Andes ~7,000 km × 200–700 km; Caucasus ~1,100 km × ~100–180 km; Pyrenees ~430 km × ~100 km | encyclopedic figures [S6] |
| Length/width ratio of linear orogens | ~5–15 (est. from the above) | |
| Ultra-prominent peaks (prominence ≥ 1,500 m) | ~1,500 worldwide (Asia 654, N. America 357, S. America 209, Europe 119, Africa 84, Oceania 54, Antarctica 39) | [S7] |
| Derived: ultras per 10⁵ km² land | ≈ **1** (est.) and extremely clustered in orogens | |
| Alps 4000-ers | 82 official summits > 4,000 m on ~200,000 km² of range area (UIAA list) | [S8] |
| Transverse valley spacing | Outlets of transverse rivers from linear ranges are regularly spaced; spacing ratio R = half-width / spacing ≈ 2 | Hovius 1996, *Basin Research* 8:29–44 (not URL-verified) |
| Topography power spectrum | P(k) ∝ k^(−β) with β ≈ 2, i.e. a surface fractal dimension ≈ 2.5 at landscape scales | Huang & Turcotte 1989, *JGR* (not URL-verified); widely reproduced |

Implications:
- **A Himalaya fills the world.** A 1024 km world fits *one* Alps-class range or *part of* one Himalaya-class range.
- **Peaks are clustered by orogen, not uniform.** Peaks > 3 km should essentially all sit inside 1–3 orogen polygons.
- **Ridge and valley spacing ≈ half-width/2.** A 100 km-wide range gets major transverse valleys every ~25 km. This is a strong, cheap realism cue.

### 1.3 Rivers and drainage

| Quantity | Value | Source / note |
|---|---|---|
| Horton bifurcation ratio R_b | 3–5 (≈ 4 typical; > 5 under structural control) | [S9] |
| Horton length ratio R_L | 1.5–3.5 | [S9] |
| Hack's law | L = C·A^h with h slightly < 0.6, decreasing for large basins. Hack's original fit L = 1.4·A^0.6 (miles) ≈ **L_km ≈ 1.27·A_km²^0.6** | [S10]; km conversion is ours |
| Drainage density | ~2 to ~100 km⁻¹ at full channel resolution (Melton 1957); 0.5–1.6 km⁻¹ in detailed small-basin studies; modeled global mean ≈ 0.7 km⁻¹ (~30% intermittent); coarse global datasets (HydroSHEDS etc.) < 0.2 km⁻¹ | [S11] |
| Climate effect | Classic view: semi-arid has the highest density, with lower values in both arid and humid. Recent work finds a U-shape across energy- to water-limited regimes | [S11] |
| Rivers > 1,000 km that reached the ocean | **91** (Grill et al. 2019, Nature), only 21 still free-flowing | [S12] |
| Derived: rivers > 1,000 km per 10⁵ km² land | ≈ **0.06–0.07** (est.); 91 / ~1,350 for non-Antarctic land | |
| Coastal deltas | **~11,000** (10,848 surveyed); largest 1% account for 30% of net land gain | Nienhuis et al. 2020 [S13] |
| Derived: deltas per 10⁵ km² land | ≈ 7 (est.), almost all small bayhead deltas; deltas readable at 1000 km scale (> ~500 km²) number only a few dozen worldwide (est.) | |

**Order counts per area (est., derived from Horton).** Counts depend on where order 1 starts. If the world-gen network starts order 1 at a contributing area of A₀ ≈ 25 km², drainage density ≈ 0.15 km⁻¹ (HydroSHEDS-like), and R_b = 4, then 4.2 × 10⁵ km² of land holds roughly:

| Strahler order (A₀ = 25 km²) | count in default world | per 10⁵ km² land | typical length (est.) |
|---|---|---|---|
| 1 | ~8,000 | ~1,900 | 3–8 km |
| 2 | ~2,000 | ~480 | 8–20 km |
| 3 | ~500 | ~120 | 20–50 km |
| 4 | ~125 | ~30 | 50–120 km |
| 5 | ~30 | ~7 | 100–250 km |
| 6 | ~8 | ~2 | 200–500 km |
| 7 | 1–3 | ~0.5 | 400–900 km |

The real number of order-1 channels at 10 m resolution is 10–100× higher. Those belong to the on-the-fly detail pass, not to the stored network (see §3.5).

**Rivers reaching the sea.** With an irregular coast, roughly one basin outlet ≥ order 3 per 20–50 km of coastline is plausible (est., from the Hovius spacing logic applied to coastal ranges).

### 1.4 Lakes

| Quantity | Value | Source / note |
|---|---|---|
| Natural lakes (Downing et al. 2006) | ~304 million, ~4.2 × 10⁶ km², Pareto size distribution, small (< 1 km²) lakes dominate area | [S14]. Later satellite inventories (GLOWABO) found *fewer* lakes and more area, so treat 304 M as an overestimate |
| HydroLAKES (≥ 10 ha) | **1.4 million** lakes and reservoirs, 2.67 × 10⁶ km², shoreline 7.2 × 10⁶ km; near-complete above 35 ha | Messager et al. 2016 [S15] |
| Derived: lakes ≥ 10 ha per 10⁵ km² land | ≈ **1,000** global mean (est.) | |
| Derived size classes (Pareto, c ≈ 1) | ≥ 1 km²: ~140 k; ≥ 10 km²: ~14 k; ≥ 100 km²: ~1.4 k; ≥ 1,000 km²: ~100–150 (est.) | Each decade of area is ~10× rarer |
| Glaciated vs not | Lake density is 10–100× higher on recently glaciated shield terrain (Finland ~188,000 lakes > 5 ares on 338,000 km² ⇒ ~55,000 per 10⁵ km²) than in unglaciated fluvial terrain, where most lakes are oxbows, tectonic or volcanic | Finnish lake inventory figure via encyclopedic sources; ratio (est.) |

Implications:
- **Lakes are a district phenomenon.** A "lake district" generator, keyed to glacial history and low-relief crystalline bedrock, beats uniform scattering.
- **Lakes need no area cap, but they do need a count cap per viewport.** Without one, the Local band can saturate on glaciated terrain.

### 1.5 Volcanoes, craters, geothermal

| Quantity | Value | Source / note |
|---|---|---|
| Holocene volcanoes (GVP) | ~1,400–1,430 (2019 snapshot), growing; ~560 with confirmed historical eruptions | [S16] |
| Derived global mean | ≈ 1 per 10⁵ km² land (est.), meaningless on its own because the distribution is bimodal | |
| Arc density example | Japan: 111 active volcanoes (JMA) on ~378,000 km² ⇒ **~29 per 10⁵ km²** along an arc | encyclopedic |
| Arc spacing | Arcs are ribbon-shaped, following the trench. The literature disagrees on spacing: no characteristic spacing (de Bremond d'Ars 1995, 479 systems / 16 margins) vs fairly regular per arc but differing between arcs (ten Brink 1991; Tatsumi 2020). Tens of km is typical (est. ~30–70 km) | [S17] |
| Confirmed impact structures | **~190–200** (Earth Impact Database 190; reviews up to 198) | [S18] |
| Impact rate | ~1 crater > 20 km per ~1 Myr for the whole Earth (Dence: one per 1.1 Myr) | [S19] |
| Why craters are rare on Earth | > 70% ocean, plus erosion, burial, glaciation and plate recycling; only a handful are pristine bowls > 1 km (e.g. Meteor Crater ~1.2 km, Pingualuit ~3.4 km, Lonar ~1.8 km) | [S19] |
| Derived: craters per 10⁵ km² land | ≈ 0.13 confirmed (est.) ⇒ **~0.5 expected in the default world, mostly eroded and invisible** | |
| Geysers | ~1,000 worldwide, ~half in Yellowstone; rest mainly in Iceland, Kamchatka, NZ, Chile | [S20] |

### 1.6 Ice, karst, deserts, wetlands, coasts

| Quantity | Value | Source / note |
|---|---|---|
| Glaciers (excluding ice sheets) | RGI 5.0: ~211,000 glaciers, ~705,000 km² | [S21] |
| Karst | 15.2% of ice-free land is karstifiable carbonate (Europe 21.8%) | Goldscheider et al. 2020 [S22] |
| Ergs (sand seas) | ~85% of mobile sand sits in ergs > 32,000 km²; Rub' al Khali is the largest (~650,000 km², larger than the whole default world's land) | [S23] |
| Sand cover of deserts | ~20% of desert area (commonly cited, est.) | |
| Linear dune spacing | **1.5–2.5 km**, regular (Great Sand Sea, Egypt) | NASA EO [S24] |
| Wetlands | 12.1 × 10⁶ km² (high-res estimate), class-sum 15–16 × 10⁶ km² ⇒ **~8–11% of land** (our arithmetic) | Davidson & Finlayson 2018 [S25] |
| Fjord coasts | Restricted to formerly glaciated high-relief coasts (≈ 45–70° latitude: Norway, Greenland, Chile, BC/Alaska, NZ, Scotland). Norway's mainland coastline with fjords is ~29,000 km vs ~2,500 km straight-line | Norway figure from Kartverket via encyclopedic sources (est. for fraction of global coast: < 10%) |
| Canyons / gorges | No reliable global count. Large canyons (> 100 km long, > 500 m deep) number in the dozens worldwide (est.). Ravines and gullies are ubiquitous at sub-km scale wherever relief and erodible rock or soil occur | (est.) |

---

## 2. How games and generators handle perceived scale

| Product | Scale choice | Lesson |
|---|---|---|
| **Skyrim** | ~37 km² playable area depicting a whole province | Heavy compression of *distance*, with landmark density kept high: a point of interest roughly every few hundred metres (est.) [S26] |
| **Witcher 3** | ~127–142 km² (≈ 3.5× Skyrim); Novigrad region ~8.5 × 8.5 km | A larger map tolerates more empty land because the player rides through it and roads/quests give direction [S26] |
| **Dwarf Fortress** | Worlds of 17² to 257² region tiles; each region tile ≈ 768 × 768 local tiles (~1.9 km at ~2.4 m/tile); a world is ~32–481 km across | Mixed scale: world-scale history and geography with ~km cells, local scale simulated only where you embark (lazy detail) [S27] |
| **Minecraft** | 1 block = 1 m, practically infinite; biomes span hundreds of m to a few km (approximate) | *Climate compression* in the extreme: desert beside snow within a few km. It reads as "gamey" but keeps walking interesting |
| **Azgaar's FMG** | User-settable distance scale and units; a whole continent-scale map on one screen | Scale is a label more than a simulation. Readability comes from labels, borders and icons, not geometry |
| **Red Blob mapgen4** | ~25k Voronoi cells by default (supports > 1 M); real-time; rivers via drainage-basin growth; `raininess` and `lg_min_flow` control river density | River-density threshold is *the* knob for "busy vs empty" [S28] |
| **Google Earth / MSFS** | True scale with real data | Real Earth at true scale feels rich because data detail is unbounded at every zoom (fields, roads, towns). A procedural true-scale world lacks that detail, which is why pure-realism procedural worlds feel empty |

Patterns to copy:
1. **Distance compression vs proportion.** Hand-made games compress distance by ~10–100× (est.) but keep *feature sizes* recognisable (a mountain still looks like a mountain). This project keeps true distances (the km scale is a feature), so it must instead **raise the density of mid-scale features** (hills, lakes, gorges, islands) toward the upper end of the real range and **guarantee rare ones**.
2. **Climate compression.** Real climate belts are ~1,000–3,000 km wide. Map world-y to a virtual latitude span `φ_span` (slider: 9° = realistic for 1024 km, 35° default, 90° = "whole hemisphere"). Temperature lapse with elevation stays physical (~6.5 °C/km) so mountains remain the strongest local climate driver.
3. **Vertical exaggeration.** Esri notes that unscaled hillshade "will produce a fairly flat relief at small scales" and recommends a nonlinear, scale-adjusted z-factor for multi-scale maps [S29]. Physical raised-relief maps conventionally use ~2–5× (est.). Recommendation: `vx(z) = clamp(1 + k·log2(viewKm / 16), 1, 8)` with k ≈ 1.2, giving ~1× at 16 km views and ~7–8× at 1000 km. Apply it to normals and shading too, and show it in the UI ("relief ×6").
4. **Lazy detail (DF, mapgen):** generate macro structure once and synthesize micro detail deterministically on demand.

---

## 3. Design framework for this project

### 3.1 Densities in physical units

Every feature class gets a rate `λ` with an explicit **support measure**:

| Support | Used for |
|---|---|
| per 10⁵ km² of land (optionally restricted by mask: mountain, arid, glaciated…) | lakes, peaks, craters, mesas, karst, waterfalls |
| per 1,000 km of coastline (optionally by coast type) | deltas, peninsulas, sea stacks, fjords |
| per 1,000 km of tectonic line (arc, rift, hotspot track) | volcanoes, calderas, hot springs |
| per 10⁵ km² of ocean (masked by temperature/depth) | atolls, seamount islands |
| per world (tier guarantee) | hero landmarks, legendary features |

`count = clamp(Poisson(λ · support · densityMul[class]), min[tier], max[class])`

Global user sliders scale `densityMul` by family (water, relief, volcanic, coast). World size changes **quantity, not density**. The exception is tier guarantees, which are per world. On the 512 km preset, guarantees for rare/legendary tiers are relaxed (P instead of min) unless "always include heroes" is on.

### 3.2 Zoom bands and the interest budget

Assume a ~1600 px wide viewport; bands are 4× apart:

| Band | View width | m/px | "Scale-appropriate" feature size | Target distinct features in view | Max empty-disk radius (land) |
|---|---|---|---|---|---|
| **W** World | 1024 km | ~640 | ≥ 15 km (ranges, big lakes, large islands, major rivers ord ≥ 6, ergs, heroes) | **15–40** | ≤ 200 km |
| **R** Region | ~250 km | ~160 | 4–60 km (sub-ranges, ord ≥ 4 rivers, lakes ≥ 10 km², islands ≥ 20 km², volcanoes, canyons) | **10–25** | ≤ 50 km |
| **A** Area | ~60 km | ~40 | 1–15 km (peaks, ord ≥ 2, lakes ≥ 0.5 km², gorges, waterfalls, mesas, deltas' lobes) | **8–20** | ≤ 12 km |
| **L** Local | ~16 km | ~10 | 0.1–4 km (creeks, ravines, ponds, cliffs, dunes, terraces) | **6–20** | ≤ 3 km |

The prompt's "close ~2 km" band would be ~1.25 m/px, which is beyond the stated 10–20 m/px floor. If a 2 km band is added later, it needs a further detail octave.

A "distinct feature" is an instance of a labelled class (river segment between confluences counts once, lake, peak with prominence ≥ view/40, island, crater, etc.) whose characteristic size lies in `[view/80, view×1.5]`. **Ocean-dominated viewports** (land < 10%) are scored separately: count islands, reefs, seamounts and coastline bends, with targets halved. Open ocean is allowed to be quiet.

Measurement: for each band, sample 64 random viewports per seed (land-weighted and uniform, both reported), then compute:
- **count stats:** p5, p50, p95 of the count;
- **diversity:** Shannon entropy of class labels in view; target ≥ 1.2 nats at W/R and ≥ 0.8 at A/L (est.);
- **largest empty disk:** the largest circle on land containing no scale-appropriate feature (distance transform of the rasterized feature mask, then max);
- **spatial unevenness:** coefficient of variation of feature counts on a k×k grid inside the view. Busy and quiet contrast is wanted, so target CV in 0.4–1.2 (est.). CV < 0.3 is wallpaper-uniform; CV > 1.5 is everything piled in one spot.

### 3.3 Clustering vs uniformity

Earth is clustered. Uniform scattering is the main giveaway of a procedural world. Use three placement processes:

1. **Inhibition (Poisson-disk) per class.** This prevents clutter. Minimum spacing `r_min`:

| Class | r_min (est.) | Class | r_min (est.) |
|---|---|---|---|
| Major range axis | 250 km | Volcano (same arc) | 25 km |
| Peak > 3 km (prominence ≥ 300 m) | 6 km | Caldera | 60 km |
| Crater (any) | 150 km | Lake ≥ 100 km² | 30 km |
| Delta (visible, > 50 km²) | 100 km along coast | Waterfall (named) | 8 km |
| Geyser field | 300 km | Mesa | 3 km |
| Hero landmarks | world_width / 4 | Atoll | 20 km |

2. **Cluster (Neyman–Scott / Thomas) processes.** Parents are placed by geology, and children are scattered around each parent:
   - *Volcanic arc:* parent = arc polyline 300–1,500 km. Children are spaced along the line at 30–70 km (est.) with ±15% jitter and a 10–40 km lateral offset band.
   - *Hotspot chain:* parent = track. Children have age-progressive size (young end tallest/active, old end eroded to atolls/seamounts).
   - *Lake district:* parent = glaciated low-relief polygon. Children follow a Pareto size distribution; local density can be 50× the background.
   - *Archipelago:* parent = drowned-range or shelf polygon. Children follow Korčák sizes (b ≈ 0.6); 20–200 islets per cluster.
   - *Geothermal field:* parent = active volcanic center. Children = 5–50 springs/geysers within 5–15 km.
3. **Quiet zones.** Explicitly reserve 10–25% of land (est.) as low-contrast plains/plateaus/shields where only Local-band detail and a few rivers occur. Quiet zones make busy zones read as special. Measure them via the CV metric and by checking that W-band empty disks exist but stay under the cap.

The Clark–Evans ratio R = observed mean NN distance / (0.5/√density) per class gives a check: R ≈ 1 is random, < 1 clustered, > 1 regular. Targets (est.): volcanoes 0.4–0.8 world-wide (clustered) but 1.2–1.6 within an arc (regular); lakes 0.3–0.7; peaks 0.5–0.9; craters ≥ 1.2.

### 3.4 Rarity tiers

| Tier | Meaning | Expected per default world | Guarantee / cap |
|---|---|---|---|
| **Common** | Fabric of the world | ≥ 20 | no min; cap via viewport budget |
| **Uncommon** | Noticed per region | 3–20 | min 1 if the required geology exists |
| **Rare** | 0–2 per world, memorable | 0.5–2 | P(≥1) ≈ 0.6–0.9 by config; cap 3 |
| **Legendary** | Most worlds have none | 0.05–0.25 | cap 1; never forced unless chosen as hero |

**Hero landmarks.** Pick 3–5 per world from the menu below, weighted by world config (climate, tectonics):

> great massif (> 5 km peak), great river (ord ≥ 7, with delta), great lake (> 2,000 km²), fjord coast (> 150 km), volcano chain or stratovolcano > 4 km, impact crater (> 20 km), sand sea (> 20,000 km²), great canyon (> 150 km long, > 1 km deep), archipelago (> 50 islands), karst tower country, inland salt flat or endorheic basin.

- Each hero is enlarged until it is legible at W band (≥ ~15 km footprint) and must sit on suitable geology. A hero *biases* generation rather than being stamped afterwards: e.g. the crater is placed before erosion so rivers respect it.
- Heroes appear in the seed summary panel so users can say "seed 1234 has the canyon".

### 3.5 Self-similar detail ("zooming always reveals new structure")

- **Stored world grid:** ~2048²–4096² cells (250–500 m at 1024 km), which holds macro relief, basins, rivers down to A₀ ≈ 25 km², lakes ≥ ~0.5 km² and coast.
- **Tile detail synthesis (GPU or worker, deterministic by world coordinates):**
  - Octaves continue the stored spectrum at β ≈ 2, modulated by terrain class: rough in orogens, smooth on plains, dunes in ergs at 1.5–2.5 km wavelength, polygonal karst.
  - **Sub-grid channels:** carve creeks and ravines down from stored rivers to A₀ ≈ 0.5–1 km² using a local flow solve on the tile, with a 1-cell overlap rule so flows match tile borders.
  - **Micro-features:** ponds, boulder fields, cliff bands, gullies and alluvial fans, placed by local slope/curvature rules.
- **Acceptance test:** the radially averaged power spectrum of rendered elevation, per band, has slope within β = 2 ± 0.5 and **no band with < 10% of the expected variance** (est.). The failure mode to catch is the "smooth bilinear blur" when zooming past stored resolution.

### 3.6 Contrast rules

- Every W-band view must contain at least **two** of: high relief, open water, a distinctive biome boundary.
- Relief contrast: ≥ 25% of land below 300 m and ≥ 5% above 2,000 m (est., tunable). This avoids both all-plains and all-mountains worlds.
- The highest peak should be ≥ 1.5× the 95th-percentile peak height so a "king" summit exists.

---

## 4. Density table — default world

World: 1024 × 1024 km = 1.05 × 10⁶ km². Land ≈ **4.2 × 10⁵ km²** (40%), ocean ≈ 6.3 × 10⁵ km². Coastline at ~1 km measurement scale ≈ 6,000–12,000 km including islands (est., D ≈ 1.25). "Earth anchor" is per 10⁵ km² of land unless noted. "Game rate" is what we generate. "Default count" = game rate × 4.2 (or the stated support). Everything in the Game columns is a **design estimate**.

| # | Feature | Earth anchor (per 10⁵ km² land) | Game rate | Default world count | Tier | Deviation from reality / notes |
|---|---|---|---|---|---|---|
| 1 | Tectonic plates touching the world | ~7 major plates over Earth (≈ 0 per 10⁵) | — | 2–5 plates | — | World-level: pick 2–5 plates so ≥ 1 convergent boundary exists in ~80% of worlds |
| 2 | Geological provinces (craton, orogen, rift, basin, arc, shelf) | — | ~1.5 | 5–10 | common | Provinces drive every other density; diversity of provinces is the main anti-boredom lever |
| 3 | Major ranges (> 400 km long) | ~0.03 (est.) | 0.3–0.6 | **1–3** | uncommon | ~5–10× denser than Earth's average; guarantee ≥ 1 unless "flat world" preset |
| 4 | Minor ranges / hill belts (80–400 km) | ~0.2 (est.) | 1–2 | 4–8 | common | |
| 5 | Peaks > 3 km (prominence ≥ 300 m) | highly clustered; ~1 ultra | 5–15 | **20–60**, ≥ 90% inside orogens | uncommon (each) | Prominence filter avoids counting every bump on a ridge |
| 6 | Ultra peaks (prominence ≥ 1.5 km) | ~1 [S7] | 1–2 | 3–8 | uncommon | slightly above Earth so each range has a "king" |
| 7 | Peaks > 5 km | ~0.1 (est., Asia/Andes-dominated) | 0–0.5 | 0–2 | rare | only on "high orogen" config or hero massif |
| 8 | Volcanoes (stratovolcanoes, cones ≥ 300 m) | ~1 mean; ~29 on an arc | 0 off-arc; 20–40 on-arc per 10⁵ | **0 or 8–25** (bimodal) | uncommon | Bimodal by design: arcs or hotspots, else none (plus 0–3 isolated cones) |
| 9 | Calderas (> 5 km) | ~0.05 (est.) | 0.1–0.3 | 0–2 | rare | Only in arc/hotspot provinces; may host crater lakes |
| 10 | Impact craters, visible (> 2 km) | ~0.13 confirmed, mostly eroded [S18] | 0.1–0.3 | **0–2** (P(≥1) ≈ 0.6) | rare | Roughly 2× Earth so a crater shows up sometimes; cap 3. Most should be partly eroded |
| 11 | Impact crater > 50 km | ≪ 0.01 | — | 0–1, P ≈ 0.1 | legendary | Only as a chosen hero or a ~10% roll; must interact with drainage (ring lakes) |
| 12 | Rivers ord ≥ 7 (A₀ = 25 km²; ~400–900 km) | rivers > 1000 km: ~0.07 [S12] | — | **1–3** | uncommon | Guarantee ≥ 1 great river per world (Earth average gives ~0.3) |
| 13 | Rivers ord 5–6 (100–500 km) | — (est. from Horton) | 7–10 | 30–45 | common | |
| 14 | Rivers ord 3–4 | — | 150 | 500–650 | common | Visible from R band |
| 15 | Rivers reaching the sea (ord ≥ 3) | ~1 per 20–50 km coast (est.) | — | 100–300 | common | |
| 16 | Lakes ≥ 1,000 km² | ~0.1 (est., Pareto) | 0.2–0.5 | **0–2** | rare | Great-lake hero adds 1 |
| 17 | Lakes 100–1,000 km² | ~1 (est.) | 1–3 | 4–12 | uncommon | Endorheic/salt lakes in arid basins count here |
| 18 | Lakes 10–100 km² | ~9 (est.) | 8–20 | 30–80 | common | ×5–20 inside lake districts |
| 19 | Lakes 1–10 km² | ~90 (est.) | 60–150 | 250–600 | common | Mostly clustered (glacial, oxbow, volcanic) |
| 20 | Ponds 0.05–1 km² | ~900 (est.) | on-the-fly | thousands; ~0–20 per L-band view | common | Synthesized in the detail pass, not stored |
| 21 | Islands > 10,000 km² | ~0.04 (est., Korčák) | — | 0–1 | rare | Usually means "second landmass" |
| 22 | Islands 100–10,000 km² | ~0.7 (est.) | 2–5 | 8–20 | uncommon | Above Earth's average because the world is mostly coast-adjacent |
| 23 | Islands 1–100 km² | ~14 (est.) | 15–40 | 60–170 | common | Korčák b ≈ 0.6; clustered in archipelagos |
| 24 | Islets < 1 km² | ~200 (est.) | stored ≥ 0.25 km²; rest on-the-fly | hundreds | common | |
| 25 | Peninsulas (length > 2× neck width, > 30 km long) | no global stat | ~2 per 1000 km coast | 10–25 | common | Measured by coastline-skeleton analysis |
| 26 | Major peninsulas (> 150 km) | — | — | 1–4 | uncommon | Guarantee ≥ 1 on worlds with land fraction 25–60% |
| 27 | Fjord coastline length | < 10% of Earth's coast (est.) | 0 unless cold+glaciated+steep coast | **0 or 300–2,000 km** of coast, D ≈ 1.5 | rare (as a region) | Only on cold-climate configs; hero option forces one 150–400 km fjord region |
| 28 | Deserts (arid biome) | drylands ~40% of land (UNCCD-style figure, est.) | climate-driven | 0–35% of land | — | Climate compression ensures ≥ 3 biome belts |
| 29 | Ergs > 5,000 km² | ~0.2 (est.) | only in arid | 0–2 | uncommon (arid worlds) | Dune wavelength 1.5–2.5 km [S24] visible at A band; Earth-size ergs exceed the world |
| 30 | Canyons (> 50 km long, > 500 m deep) | dozens worldwide (est.) | 0.5–1 | 1–4 | uncommon | Where rivers cross uplifted plateaus; hero option > 150 km |
| 31 | Ravines / gorges (1–20 km) | ubiquitous in relief | 50–150 | 200–600 | common | Mostly on-the-fly at A/L bands |
| 32 | Waterfalls (named, > 20 m drop) | no reliable global count (est.) | 3–8 | 10–30 | uncommon | At knickpoints: lithology steps, hanging valleys, fjord walls, plateau edges |
| 33 | Deltas (visible > 50 km²) | ~7 any size; large few dozen worldwide (est.) [S13] | ~1 per 1000 km coast for ord ≥ 6 mouths | **1–5** | uncommon | Guarantee one at the great river mouth; wave-dominated coasts get cuspate, not bird-foot |
| 34 | Wetlands (area fraction of land) | ~8–11% [S25] | 4–10% | 15,000–40,000 km² | common | Flat lowlands, deltas, floodplains, peat in cold-wet |
| 35 | Glaciers (individual) | ~140 (est., [S21], clustered) | only above snowline | 0–300 | uncommon (as region) | Snowline from climate; ice caps only on cold configs |
| 36 | Karst areas (> 500 km²) | 15% of land is carbonate [S22] | 3–8% of land as karst province | 1–4 regions | uncommon | Karst under-represented on purpose: it visually reads only at A/L bands (sinkholes, towers) |
| 37 | Mesas / buttes | arid plateaus only (est.) | 20–60 per 10⁵ km² arid plateau | 0–80 | uncommon (as a field) | Clustered fields on layered sedimentary plateaus |
| 38 | Atolls | 439 globally [S5] ⇒ ~0.12 per 10⁵ km² ocean | 0.3–1 per 10⁵ km² warm ocean | 0–5 | rare | Only warm-water + subsiding volcanic islands (hotspot chain end) |
| 39 | Hot springs | clustered at volcanic/rift zones (est.) | 5–30 per volcanic cluster | 0–60 | uncommon | |
| 40 | Geyser fields | ~5 significant fields worldwide (est. from [S20]) | — | 0–1, P ≈ 0.15 | legendary | Only next to an active caldera/hotspot |
| 41 | Endorheic basins / salt flats | — | arid only | 0–3 | uncommon | Good contrast feature; pairs with salt lakes |
| 42 | Hero landmarks | — | — | **3–5** | — | §3.4 |

**Scaling to presets** (land at 40%): 512 km ≈ 1.05 × 10⁵ km² (÷4), 2048 km ≈ 1.7 × 10⁶ (×4), 4096 km ≈ 6.7 × 10⁶ (×16, Australia-scale). Common/uncommon counts scale linearly. Rare/legendary per-world guarantees stay the same while rates keep scaling, so a 4096 world naturally holds several rare features. Hero count rises to 5–8 at 2048 and above.

---

## 5. Validation metrics and automated tests

Run headless in Node (same worker code) on a **reduced-resolution profile**: macro grid only, plus detail synthesis for sampled L-band tiles. Use ≥ 200 seeds per preset in a nightly job and 20 seeds in CI.

### 5.1 Count and tier tests
- Per class: the observed count distribution over seeds has its mean within ±25% of the target, and min/max clamps are never violated.
- Rare tier: the fraction of seeds with ≥ 1 is within ±0.1 of the configured P. Legendary ≤ configured P + 0.05.
- Heroes: 3–5 present in 100% of seeds; pairwise spacing ≥ world/4; each visible at W band (footprint ≥ 15 km).

### 5.2 Viewport interest tests (per band, §3.2)
- p5 of the land-viewport feature count ≥ lower target; p95 ≤ upper target × 1.5.
- Largest empty disk ≤ the cap in ≥ 95% of sampled land viewports.
- Class entropy ≥ threshold in ≥ 90% of viewports.
- The grid-CV contrast metric lies in 0.4–1.2 for p50. Flag seeds with p50 < 0.3 ("wallpaper") or > 1.5 ("clump").

### 5.3 World-level "boring / cluttered" detectors
- **Boring seed:** fewer than 2 provinces, or relief contrast rule failed (§3.6), or no water body ≥ 100 km² and no river ord ≥ 6, or > 40% of land in a single biome (excluding a deliberate "desert world" preset).
- **Cluttered seed:** any W-band viewport with > 60 distinct features, or the volcano/peak/lake count in any 100 km disk > 3× the class's cluster target.
- Each detector reports the offending seed and a thumbnail so tuning is visual.

### 5.4 Geomorphic realism checks
- Horton fits on the stored network: R_b ∈ [3, 5], R_L ∈ [1.5, 3.5] [S9].
- Hack fit: exponent h ∈ [0.5, 0.62] over basins ≥ 100 km² [S10].
- Lake size-frequency: log-log slope of N(>A) ∈ [−1.2, −0.7] (Pareto; [S14]).
- Island size-frequency: Korčák b ∈ [0.45, 0.8] [S2].
- Coastline box-counting dimension: global ∈ [1.1, 1.35]; fjord segments ∈ [1.4, 1.6] [S3].
- Elevation spectrum slope per zoom band: β ∈ [1.5, 2.5] with no band missing variance (§3.5).
- Clark–Evans R per class within the §3.3 targets.

### 5.5 Size-invariance test
Generate the same config at 512, 1024 and 2048 km. Per-10⁵ km² rates of common/uncommon classes must agree within ±20%, and viewport metrics at the *same band* must agree within ±15%. This proves density, not quantity, is size-independent.

### 5.6 Human-in-the-loop
A "seed contact sheet" page renders 64 seeds × W band plus random R/A crops, with the metric badges overlaid. Tune by eye, then lock the numbers back into tests.

---

## 6. Where the game deliberately deviates from Earth

| Deviation | Why |
|---|---|
| Guarantee ≥ 1 major range, ≥ 1 great river, ≥ 3 heroes | Earth-average rates give < 1 per 4 × 10⁵ km² |
| Volcano/crater/atoll/geyser rates ~2× Earth where geology permits | So rare features appear in a meaningful fraction of seeds |
| Climate compression (~4× default) | 1024 km is too short for multiple climate belts |
| Vertical exaggeration up to ~8× at world zoom | Top-down relief is otherwise invisible |
| Mid-scale features (lakes, islands, gorges) at upper end of the real range | True-scale procedural worlds lack the cultural detail that makes Google Earth interesting |
| Quiet zones kept (10–25% of land) | Contrast; mimics real shields and plains |
| Ponds, creeks, ravines synthesized on the fly at real-world-ish densities | Self-similar detail without storing it |

---

## 7. Open questions

- Should rarity guarantees be visible to users (a "world traits" panel) or kept as surprise?
- Is a seeded "world archetype" (archipelago, pangaea-fragment, desert, glacial) better than independent sliders for avoiding incoherent combinations?
- Can the L-band detail pass place waterfalls and ravines consistently enough that a user at 10 m/px always finds the same waterfall again? It must be fully deterministic per world coordinate.

---

## 8. Sources

- [S1] Sayre et al. 2019, global shoreline vector and Global Islands: https://www.usgs.gov/publications/a-new-30-meter-resolution-global-shoreline-vector-and-associated-global-islands ; island counts: https://www.usgs.gov/tools/global-island-explorer
- [S2] Korčák's law and exponents: https://arxiv.org/pdf/1303.1610 ; critique: https://epjh.epj.org/articles/epjh/abs/2016/01/h150039/h150039.html
- [S3] Mandelbrot 1967, "How Long Is the Coast of Britain?": https://gis.humboldt.edu/olm/courses/gsp_510/Articles/Mandelbrot1967.pdf
- [S4] Coastline dimensions Britain/Norway: https://www.math.uci.edu/~ndonalds/math161/fractals.html ; https://arxiv.org/pdf/astro-ph/9803218
- [S5] Goldberg 2016, Atolls of the World (Atoll Res. Bull. 610): https://smithsonian.figshare.com/articles/Atolls_of_the_World_Revisiting_the_Original_Checklist/9761855 ; https://en.wikipedia.org/wiki/Atoll
- [S6] Range dimensions: https://en.wikipedia.org/wiki/Alps ; https://en.wikipedia.org/wiki/Himalayas ; https://en.wikipedia.org/wiki/Andes ; https://en.wikipedia.org/wiki/Caucasus_Mountains
- [S7] Ultra-prominent peaks: https://en.wikipedia.org/wiki/Ultra-prominent_peak
- [S8] Alpine 4000-ers (UIAA): https://en.wikipedia.org/wiki/List_of_mountains_of_the_Alps_over_4000_metres
- [S9] Horton ratios: https://ebooks.inflibnet.ac.in/geop11/chapter/morphometric-analysis ; https://en.wikipedia.org/wiki/Strahler_number ; https://hydrology.usu.edu/dtarb/TarbotonFractalRiverNetworksJH96.pdf
- [S10] Hack's law: https://en.wikipedia.org/wiki/Hack%27s_law
- [S11] Drainage density ranges and climate: https://web.mit.edu/eltahir/www/Publications_files/1998%20Moglen%20Eltahir%20Bras%20WRR%2034%284%29.pdf ; https://hal.sorbonne-universite.fr/hal-01496152v1/document ; https://reachhydro.org/home/params/global-drainage-density
- [S12] Grill et al. 2019, free-flowing rivers (91 rivers > 1000 km): https://wp.geog.mcgill.ca/hydrolab/free-flowing-rivers/
- [S13] Nienhuis et al. 2020, Nature, ~11,000 deltas: https://par.nsf.gov/servlets/purl/10166405 ; https://eesm.science.energy.gov/research-highlights/global-scale-human-impact-delta-morphology-has-led-net-land-area-gain
- [S14] Downing et al. 2006, Limnol. Oceanogr. 51:2388: https://www.caryinstitute.org/sites/default/files/public/reprints/Downing_et_al_2006_Limnol_Ocean.pdf ; overestimate note: https://www.geographyrealm.com/many-lakes-world/
- [S15] HydroLAKES (Messager et al. 2016): https://www.hydrosheds.org/hydrolakes
- [S16] GVP Holocene volcano counts: https://www.un-spider.org/links-and-resources/data-sources/global-volcanism-program-database-gvp-smithsonian-institution ; https://en.wikipedia.org/wiki/Active_volcano ; Japan: https://en.wikipedia.org/wiki/List_of_volcanoes_in_Japan
- [S17] Arc volcano spacing: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7490715/ ; https://pubs.usgs.gov/publication/70190668 ; https://earthref.org/ERR/40672/
- [S18] Earth Impact Database counts: https://en.wikipedia.org/wiki/Earth_Impact_Database ; https://en.wikipedia.org/wiki/List_of_impact_structures_on_Earth
- [S19] Impact rate: https://sci.esa.int/documents/33321/35974/1567255403508-ESLAB40-Proc_291326-Dence.pdf ; https://pubs.usgs.gov/publication/70020209
- [S20] Geysers: https://home.nps.gov/features/yell/ofvec/exhibits/treasures/global/index.htm ; https://www.earthdate.org/episodes/under-pressure-geysers
- [S21] Randolph Glacier Inventory 5.0: https://nsidc.org/pipermail/glims/2015/000645.html
- [S22] Goldscheider et al. 2020, karst: https://link.springer.com/article/10.1007/s10040-020-02139-5
- [S23] Ergs: https://en.wikipedia.org/wiki/Erg_(landform)
- [S24] Linear dune spacing, Great Sand Sea: https://science.nasa.gov/earth/earth-observatory/linear-dunes-great-sand-sea-egypt-78151/
- [S25] Wetland extent: https://www.publish.csiro.au/MF/MF17019 ; https://www.ramsar.org/sites/default/files/documents/library/gwo_technical_note_status_e.pdf
- [S26] Skyrim / Witcher 3 map sizes (fan/press measurements): https://www.dualshockers.com/the-witcher-3-two-of-the-areas-are-over-52-square-miles-by-themselves-3-5-times-larger-than-skyrim/ ; https://expertbeacon.com/which-map-is-bigger-skyrim-or-witcher-3/
- [S27] Dwarf Fortress world/region/embark scale: https://dwarffortresswiki.org/index.php/World ; https://www.dwarffortresswiki.org/index.php/Embark
- [S28] Red Blob Games mapgen4: https://www.redblobgames.com/maps/mapgen4/ ; drainage basins: https://redblobgames.com/x/1723-procedural-river-growing
- [S29] Esri hillshade/z-factor guidance for multi-scale maps: https://desktop.arcgis.com/en/arcmap/10.5/manage-data/raster-and-images/hillshade-function.htm
