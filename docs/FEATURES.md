# Landmark & Feature Catalog

Status: **draft for review**, 2026-10-16. This catalog lists every geological landmark, landform, water body and biome the generator should be able to produce, and how each one comes about. It is the feature checklist for [PLAN.md](PLAN.md). The density targets behind the rarity tiers are in PLAN.md §4 and [research/05](research/05-scale-density-landmarks.md). The parameters that control each family are in [CONFIG.md](CONFIG.md).

**Columns**
- **Forms when** is the generation rule. Features come out of simulated processes (tectonics, erosion, water, ice, climate) wherever possible. A feature is *stamped* in directly only when no process at our resolution would produce it, and stamps are still placed by process rules.
- **Rarity** (default world, 1024 × 1024 km, ~40 % land):
  - **C** common: many per world.
  - **U** uncommon: a handful.
  - **R** rare: 0–2 per world, depending on conditions.
  - **L** legendary: under 1 per world on average.
  - **—** a continuous property of the terrain rather than a counted feature.
- **Phase**:
  - **P1** first complete world.
  - **P2** rich world.
  - **P3** polish and stretch goals.
- **Zoom** is the zoom band where the feature first reads clearly. The bands are those of PLAN.md §2.4:
  - **W** world: about 1000 km across, ~640 m/px.
  - **R** region: about 250 km across, ~160 m/px.
  - **A** area: about 60 km across, ~40 m/px.
  - **L** local: about 16 km across, ~10 m/px, the closest zoom.
---

## A. Tectonic & mountain landforms

| # | Feature | Forms when | Rarity | Zoom | Phase |
|---|---|---|---|---|---|
| A1 | Continents / major landmasses | Continental crust provinces lifted above sea level. Land fraction comes from the target set in the config | U (1–3) | W | P1 |
| A2 | Supercontinent / single landmass | Preset or config: one dominant continental cluster | preset | W | P2 |
| A3 | Fold mountain range | Convergent continent–continent boundary. Uplift band, then fluvial erosion | U (2–4) | W | P1 |
| A4 | Coastal cordillera | Convergent ocean–continent boundary. Range parallel to the coast, with a trench offshore | U | W | P1 |
| A5 | Ridges, spurs, arêtes | Emerge from stream-power erosion of uplifted terrain (dendritic ridge lines) | C | R | P1 |
| A6 | Peaks / summits / massifs | Local maxima above a prominence threshold, named by prominence | C | R | P1 |
| A7 | Mountain passes / saddles | Saddle points between drainage basins on a range crest | C | R | P2 |
| A8 | Foothills / piedmont | Range flanks: uplift decays and diffusion smooths them | C | R | P1 |
| A9 | High plateau | Interior of a collision zone (Tibet-like). High uplift with low incision | R | W | P1 |
| A10 | Tableland / mesa plateau | Flat uplifted sedimentary block in a dry climate. Terraced edges | U | R | P2 |
| A11 | Escarpment / cliff line | Edge of a plateau or fault block. Sharp step that erosion pushes back | U | R | P2 |
| A12 | Rift valley / graben | Divergent boundary on a continent: a long depression with flanking shoulders. Often holds rift lakes | U (0–2) | W | P1 |
| A13 | Horst / block mountains | Uplifted blocks between rift faults (basin-and-range) | R | R | P3 |
| A14 | Fault line / transform scarp | Transform boundary: offset ridges and rivers, a linear valley | U | R | P2 |
| A15 | Intermontane basin | Low enclosed area between ranges. Often endorheic in dry climates | U | W | P1 |
| A16 | Inselberg / monadnock | Isolated resistant hill rising from a plain. Stamp placed on old, eroded shields | U | A | P2 |
| A17 | Hogback / cuesta | Tilted resistant strata: asymmetric ridges | R | A | P3 |
| A18 | Badlands | Soft sediment with sparse vegetation on moderate slopes. Dense high-frequency gullying | U | A | P2 |
| A19 | Hills / rolling uplands | Low-amplitude uplift with weathered, diffusive relief | C | R | P1 |
| A20 | Lowland plains | Low slope, low uplift. Floodplains and grassland. These are the deliberate quiet zones | — | W | P1 |

## B. Volcanic

| # | Feature | Forms when | Rarity | Zoom | Phase |
|---|---|---|---|---|---|
| B1 | Stratovolcano | Volcanic arc behind ocean–continent or ocean–ocean subduction. Steep cone, crater at the summit, snowcap when high | U (5–20) | R | P1 |
| B2 | Volcanic arc | Chain of stratovolcanoes 100–300 km behind a trench | U | W | P1 |
| B3 | Island arc | Ocean–ocean convergence: a curved chain of volcanic islands | U | W | P1 |
| B4 | Hotspot island chain | Mantle hotspot under a moving plate. Ages along the chain: the youngest island is tall, older ones are eroded, then atolls, then seamounts | U (0–2) | W | P2 |
| B5 | Shield volcano | Hotspot or rift: broad, gentle dome | U | R | P2 |
| B6 | Caldera | Collapsed volcano (some fraction of large volcanoes). Ring rim with a flat floor, often holding a lake | R | R | P2 |
| B7 | Caldera lake | A caldera in a wet climate, filled to its rim spill level | R | R | P2 |
| B8 | Cinder cone field | Clusters of small cones near rifts or volcanic fields | U | A | P2 |
| B9 | Lava plain / flood basalt | Large dark, flat volcanic province (traps). Different color, stepped edges | R | W | P3 |
| B10 | Maar | Small, low-rimmed explosion crater with a lake | R | A | P3 |
| B11 | Geysers / hot springs / fumaroles | Point features in active volcanic areas. Decorative markers and steam at close zoom | U | L | P3 |
| B12 | Mid-ocean ridge | Divergent oceanic boundary. A ridge in the bathymetry | U | W | P1 |
| B13 | Seamounts / guyots | Submerged volcanoes; flat-topped when eroded (guyots) | C | R | P2 |

## C. Fluvial (running water)

| # | Feature | Forms when | Rarity | Zoom | Phase |
|---|---|---|---|---|---|
| C1 | Springs / sources | Channel heads where flow accumulation crosses the stream threshold. Also lake outlets and glacier snouts | C | A | P1 |
| C2 | Creeks / brooks | Low-order streams (Strahler 1–2) on the detail grid. Shown only at bands A and L | C | A | P2 |
| C3 | Streams | Strahler 3–4 | C | R | P1 |
| C4 | Rivers | Strahler 5+. Width from discharge (w ∝ Q^0.5) | C | W | P1 |
| C5 | Major rivers | Largest basins, Strahler 7+ at macro scale. Named, with a label at world zoom | U (3–8) | W | P1 |
| C6 | Mountain-born rivers | Headwaters in ranges, snow- or glacier-fed. Fall through gorges to the lowlands | C | W | P1 |
| C7 | Lowland-born rivers | Headwaters in wet uplands or bogs. Drain to lakes or the sea | C | R | P1 |
| C8 | Confluences | Tributary junctions. The angle depends on slope: acute on steep ground, near-perpendicular on flat ground | C | R | P1 |
| C9 | Meanders | Low-slope, high-discharge reaches. Sinuosity grows as slope falls | C | R | P2 |
| C10 | Oxbow lakes | Abandoned meander loops beside meandering reaches | U | A | P2 |
| C11 | Braided rivers | Steep, sediment-rich reaches: glacial outwash plains and alluvial fans | U | A | P3 |
| C12 | Floodplain | Flat valley floor along large lowland rivers. Wetlands, light-green color | C | R | P2 |
| C13 | Alluvial fan | Where a mountain stream exits onto a plain, especially in dry climates | U | A | P2 |
| C14 | River delta (arcuate / bird's-foot / cuspate) | River mouth on a low-energy coast with high discharge. Shape depends on wave energy | U (2–6) | R | P2 |
| C15 | Estuary | River mouth in a drowned valley, or on a high-energy coast. A widening funnel | U | R | P2 |
| C16 | Waterfalls | Steep elevation step along a river (knickpoint): fault scarps, hanging valleys, plateau edges | U (10–40) | A | P2 |
| C17 | Rapids / cascades | Steep reaches below the waterfall threshold | C | L | P3 |
| C18 | V-shaped valley | Fluvial incision in uplifting terrain. Emerges from erosion | C | R | P1 |
| C19 | Gorge / canyon | A river incising through a plateau or range: deep, narrow, steep walls. Antecedent rivers cut across ranges | U (2–8) | R | P2 |
| C20 | Ravine | Small, steep-sided valley cut by a creek. Detail-scale incision on steep terrain | C | A | P2 |
| C21 | Slot canyon | Very narrow, deep incision in arid sandstone plateaus | R | L | P3 |
| C22 | River terraces | Stepped benches along incising rivers | U | A | P3 |
| C23 | River islands (aits) | Mid-channel islands in wide rivers | U | A | P3 |
| C24 | Wadi / ephemeral stream | Channel in a dry climate. Dashed or dry rendering; may end in a playa | C | R | P2 |
| C25 | Inland delta / disappearing river | Endorheic river fanning out and evaporating in a desert basin (Okavango-like) | R | R | P3 |
| C26 | Hanging valley | Tributary valley left high above a glacially deepened main valley. Waterfall at its lip | U | A | P3 |

## D. Lakes (lacustrine)

| # | Feature | Forms when | Rarity | Zoom | Phase |
|---|---|---|---|---|---|
| D1 | Lakes (general) | Depressions kept, rather than breached, by priority-flood. Filled to the spill level | C | R | P1 |
| D2 | Large lakes (> 1000 km²) | Big tectonic or glacial basins | U (1–4) | W | P1 |
| D3 | Rift lake | Long, deep, narrow lake in a rift valley | R | W | P2 |
| D4 | Glacial / finger lakes | Long lakes in overdeepened glacial troughs | U | R | P2 |
| D5 | Tarn / cirque lake | Small lake in a cirque high in glaciated mountains | C | A | P2 |
| D6 | Kettle lakes / lake district | Many small lakes on glacial plains (cold, low relief). This is a cluster process | U | A | P2 |
| D7 | Crater lake | Impact or volcanic crater in a wet climate | R | R | P2 |
| D8 | Endorheic salt lake | Closed basin where evaporation ≈ inflow: brackish, saline color | U | R | P2 |
| D9 | Salt flat / playa | Closed basin where evaporation > inflow: dry white pan | U | R | P2 |
| D10 | Ponds | Very small depressions, at the detail scale only | C | L | P3 |
| D11 | Lake islands | Land above the lake level inside a lake | C | A | P1 |
| D12 | Lake outlet / inlet | The outlet is the spill point, which continues the river downstream. Inlets are where rivers enter | C | R | P1 |

## E. Glacial & periglacial

| # | Feature | Forms when | Rarity | Zoom | Phase |
|---|---|---|---|---|---|
| E1 | Ice cap / ice sheet | Very cold, high or polar land. White, smooth dome | U | W | P2 |
| E2 | Valley glaciers | Above the equilibrium line along high valleys. Flowing ice tongues | U | R | P2 |
| E3 | Snowfields / permanent snow | Above the snowline, which depends on temperature and slope aspect | C | R | P1 |
| E4 | Cirques / corries | Bowl-shaped heads of glaciated valleys | C | A | P2 |
| E5 | U-shaped valleys / glacial troughs | Glacial carving of existing river valleys: cold, with past or present ice | U | R | P2 |
| E6 | **Fjords** | U-shaped troughs carved below sea level on high-latitude mountainous coasts. Long, narrow, steep-walled inlets | R (0–1 fjord coast) | W | P2 |
| E7 | Moraines | Ridges of debris at the margins and terminus of glaciers | U | A | P3 |
| E8 | Drumlins / eskers | Streamlined hills or sinuous ridges on formerly glaciated plains | R | A | P3 |
| E9 | Outwash plain (sandur) | Braided, gravelly plain in front of glaciers | U | R | P3 |
| E10 | Tundra / permafrost patterning | Polygonal ground texture in tundra at close zoom | — | L | P3 |
| E11 | Sea ice / pack ice | Ocean surface in cold zones. Seasonal extent | U | W | P2 |
| E12 | Icebergs | Calving fronts of glaciers that end in the sea | R | A | P3 |

## F. Coastal

| # | Feature | Forms when | Rarity | Zoom | Phase |
|---|---|---|---|---|---|
| F1 | Coastlines (fractal) | Sea level against the terrain, domain-warped to a natural fractal dimension (~1.2–1.3) | — | W | P1 |
| F2 | Peninsulas | Land protruding into the sea: warped noise and ranges running out into the ocean | C | W | P1 |
| F3 | Isthmus | Narrow neck joining two landmasses | U | W | P1 |
| F4 | Capes / headlands | Resistant rock points on rugged coasts | C | R | P1 |
| F5 | Bays / gulfs / bights | Coastal concavities at every scale | C | W | P1 |
| F6 | Coves | Small, rounded bays on rocky coasts | C | A | P3 |
| F7 | Islands | Land not connected to a continent. Size distribution follows a power law | C | W | P1 |
| F8 | Archipelagos | Clusters of islands: drowned ranges, arcs, continental fragments | U | W | P1 |
| F9 | Straits / sounds / channels | Narrow water between landmasses | U | R | P1 |
| F10 | Beaches | Low-slope, sediment-rich coasts. Sand color | C | A | P1 |
| F11 | Sea cliffs | Steep, high coasts where mountains or plateaus meet the sea | C | A | P2 |
| F12 | Sea stacks / sea arches | Offshore rock pillars beside eroding cliffs | U | L | P3 |
| F13 | Barrier islands | Long thin sand islands parallel to low, sandy coasts | U | R | P2 |
| F14 | Lagoons | Sheltered water behind barrier islands or reefs | U | R | P2 |
| F15 | Spits | Sand hooks growing from a headland in the direction of longshore drift | U | A | P3 |
| F16 | Tombolos | Sand bar joining an island to the mainland | R | A | P3 |
| F17 | Rias | Drowned river valleys on a non-glaciated, submerging coast | U | R | P2 |
| F18 | Salt marsh / tidal flats | Low, sheltered temperate coasts, estuaries and lagoon margins | U | A | P2 |
| F19 | Mangrove coasts | Tropical sheltered, low coasts and deltas | U | A | P2 |
| F20 | Coral reefs (fringing / barrier) | Warm, shallow, clear water on tropical coasts and around volcanic islands | U | R | P2 |
| F21 | Atolls | Ring reef around a lagoon at the old end of a hotspot chain in warm water | R | R | P2 |
| F22 | Coastal dunes | Sandy, windward coasts | U | A | P3 |

## G. Marine (bathymetry)

| # | Feature | Forms when | Rarity | Zoom | Phase |
|---|---|---|---|---|---|
| G1 | Continental shelf | Shallow (< 200 m) margin around continents. Light, turquoise-teal water | — | W | P1 |
| G2 | Continental slope / rise | Steep drop to the abyss | — | W | P1 |
| G3 | Abyssal plain | Deep, flat ocean floor | — | W | P1 |
| G4 | Ocean trench | In front of subduction zones: the deepest, darkest water | U | W | P1 |
| G5 | Mid-ocean ridge | See B12 | U | W | P1 |
| G6 | Inland / marginal sea | Sea mostly enclosed by land | U | W | P1 |
| G7 | Submarine canyons | Continuations of large rivers across the shelf | R | R | P3 |

## H. Arid & aeolian

| # | Feature | Forms when | Rarity | Zoom | Phase |
|---|---|---|---|---|---|
| H1 | Hot desert | Subtropical high belt, rain shadow or continental interior; low precipitation | U (0–2) | W | P1 |
| H2 | Cold desert | Dry and cold: high plateaus, rain shadows at higher latitude | U | W | P1 |
| H3 | Sand sea (erg) | Low-relief basins inside deserts with sand supply | U | R | P2 |
| H4 | Dunes (barchan, linear/seif, star) | Inside ergs. Shape comes from wind regime and sand supply, orientation from the prevailing wind | C (inside ergs) | A | P2 |
| H5 | Rocky desert (hamada / reg) | Desert uplands without sand supply | C | R | P2 |
| H6 | Mesas | Flat-topped, cliff-edged remnants of eroded tablelands. Terrace stamp on arid uplifted plateaus | U | A | P2 |
| H7 | Buttes | Smaller, more isolated mesas | U | A | P2 |
| H8 | Hoodoos / rock pinnacles | Close-zoom decoration in badlands and canyon country | U | L | P3 |
| H9 | Oasis | Spring or shallow water table in a desert: vegetation patch | R | A | P2 |
| H10 | Desert varnish / strata banding | Coloured horizontal banding on arid slopes (a shader effect) | — | A | P2 |

## I. Karst

| # | Feature | Forms when | Rarity | Zoom | Phase |
|---|---|---|---|---|---|
| I1 | Karst plateau | Limestone substrate province with humid climate. Few surface streams | U (0–2) | R | P2 |
| I2 | Sinkholes / dolines | Pitted depressions in karst | C (in karst) | A | P2 |
| I3 | Cenotes | Water-filled sinkholes in flat tropical karst | R | A | P3 |
| I4 | Tower karst / karst pinnacles | Steep isolated towers in tropical karst (Guilin / Ha Long-like). Partly drowned on coasts | R | A | P3 |
| I5 | Disappearing / sinking rivers | Rivers that end in a sinkhole and re-emerge at a spring downstream | R | R | P3 |
| I6 | Caves (markers) | Point landmarks in karst. No interiors | U | L | P3 |

## J. Impact

| # | Feature | Forms when | Rarity | Zoom | Phase |
|---|---|---|---|---|---|
| J1 | Simple impact crater | Bowl with a raised rim and ejecta blanket (depth/diameter ≈ 1/5). Diameter ≲ 4 km | R | A | P2 |
| J2 | Complex impact crater | Central peak, terraced walls, flat floor. Diameter > ~4 km | R | R | P2 |
| J3 | Degraded / ancient crater (astrobleme) | Old impact eroded to a faint ring of hills or a ring-shaped river course | R | R | P2 |
| J4 | Crater lake (impact) | Crater in a wet climate | R | R | P2 |
| J5 | Ejecta rays | Very young craters on arid ground: radial bright streaks | L | R | P3 |
| J6 | Crater chain | Several aligned impacts of similar age | L | R | P3 |

## K. Wetlands

| # | Feature | Forms when | Rarity | Zoom | Phase |
|---|---|---|---|---|---|
| K1 | Marsh | Low slope, high topographic wetness, temperate. Grasses | U | A | P2 |
| K2 | Swamp | Same as a marsh, but forested and warmer | U | A | P2 |
| K3 | Bog / peatland / fen | Cool, wet, flat ground: boreal and oceanic climates | U | A | P2 |
| K4 | Floodplain wetland | Along large lowland rivers | C | R | P2 |
| K5 | Delta wetlands | On delta lobes | U | R | P2 |

## L. Biomes (terrestrial)

Classification is Whittaker-style (temperature × precipitation). Elevation, slope, wetness, substrate and salinity then modify it, and boundaries are blended with noise. The research behind this is [research/03](research/03-climate-biomes.md).

| # | Biome | Typical conditions | Phase |
|---|---|---|---|
| L1 | Ice sheet / glacier | Mean temperature well below 0 °C, with snow accumulation | P1 |
| L2 | Polar desert | Very cold and very dry | P2 |
| L3 | Tundra | Cold. Beyond the treeline in latitude or altitude | P1 |
| L4 | Boreal forest (taiga) | Cold-temperate, moderate precipitation | P1 |
| L5 | Temperate coniferous forest | Cool, wet, often montane | P1 |
| L6 | Temperate broadleaf forest | Mild, moist | P1 |
| L7 | Temperate rainforest | Mild, very wet, on windward coasts | P2 |
| L8 | Temperate grassland / steppe / prairie | Mild-to-cold, semi-arid continental | P1 |
| L9 | Mediterranean shrubland (chaparral) | Mild, with summer drought on western coasts around 30–40° | P2 |
| L10 | Xeric shrubland | Warm, semi-arid | P1 |
| L11 | Hot desert | Hot, arid | P1 |
| L12 | Cold desert | Cool or cold, arid | P1 |
| L13 | Savanna | Hot, seasonal precipitation | P1 |
| L14 | Tropical dry forest | Hot, moderate precipitation | P2 |
| L15 | Tropical rainforest | Hot, very wet | P1 |
| L16 | Montane / cloud forest | Tropical-to-temperate mountain flanks in the cloud belt | P2 |
| L17 | Alpine meadow | Above the treeline, below the snowline | P1 |
| L18 | Alpine rock / scree / nival | Steep or very high ground: bare rock | P1 |
| L19 | Mangrove | See F19 | P2 |
| L20 | Salt marsh / tidal flat | See F18 | P2 |
| L21 | Freshwater wetland | See K1–K5 | P2 |
| L22 | Beach / coastal dunes | See F10 and F22 | P1 |
| L23 | Salt flat | See D9 | P2 |
| L24 | Volcanic barren / lava field | Young volcanic ground | P3 |

**Ocean surface zones:**
- **Shallow shelf**, coloured by depth.
- **Reef**.
- **Open ocean**.
- **Deep trench**.
- **Sea ice**.
- **Polar sea**.

## M. Atmosphere, light & "beautiful extras"

| # | Feature | Notes | Phase |
|---|---|---|---|
| M1 | Sun lighting with soft terrain shadows | Movable sun / time of day | P1 |
| M2 | Atmospheric haze when tilted | Aerial perspective | P2 |
| M3 | Animated water | Ocean normals, coastline foam, flowing rivers | P1–P2 |
| M4 | Cloud layer with shadows | Optional. Fades out when zoomed in | P3 |
| M5 | Valley fog / low cloud | Morning fog in valleys and on cold coasts | P3 |
| M6 | Snow on shaded slopes | Snowline depends on aspect: lower on poleward slopes | P2 |
| M7 | Seasons | Snow extent, foliage colour, sea ice | P3 |
| M8 | Vegetation | Canopy baked into ground colour; shader-generated stand clumps below ~15 m/px; real tree meshes only with a stretch "ground" zoom band | P2 |
| M9 | Procedural names & atlas | Names for ranges, peaks, rivers, lakes, seas, bays, islands, deserts and craters. Labels ranked by importance | P2 |
| M10 | Night lighting / stars | Night view with moonlight (fun, optional) | P3 |

---

### Counts

There are about **179** distinct feature, landform and biome types in total:

| Sections | Count |
|---|---|
| A–K: landforms and water bodies | 139 |
| L: biomes | 24 |
| Ocean surface zones | 6 |
| M: atmosphere and visual extras | 10 |

**Landforms by phase (A–K):**

| Phase | Landforms |
|---|---|
| P1 | 45 |
| P2 | 63 |
| P3 | 31 |
