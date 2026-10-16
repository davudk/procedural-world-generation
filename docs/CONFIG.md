# Configuration: a Hierarchy of Parameters

Status: **draft for review**, 2026-10-16. Companion to [PLAN.md](PLAN.md) §9.

World customisation is a **tree of parameters, not a flat list**. Higher-level parameters (world size, land fraction, tectonic activity, geological age, climate) drive lower-level ones (plate count, continent count, plate and continent sizes, mountain-range length and height, crater count, …), which in turn drive process constants (erosion rates, river thresholds, …).

**Each parameter can be:**
- **AUTO**, the default. Its value is derived from the resolved values of its parents and shown live, greyed, with an `AUTO` chip.
- **Set** (manual). Its value is pinned by the user or by a preset. Everything below it that is still AUTO now derives from the pinned value.

Example: grow the world from 1024 km to 4096 km with everything on AUTO. You get more plates, bigger plates, more and larger continents, and longer, wider mountain ranges along the collisions between plates. Pin "continents = 1" and the plate count, island abundance and range layout re-derive around that one supercontinent.

---

## 1. Parameter kinds

| Kind | UI | Meaning | Examples |
|---|---|---|---|
| **Scalar** | slider | One number | land fraction, humidity |
| **Draw range** `[min, max]` | dual-thumb slider | **One value per world**, drawn with the seeded RNG from the range. Pinning `min = max` fixes it | plate count `[4, 6]`, continent count `[1, 3]` |
| **Spread range** `[min, max]` | dual-thumb slider | The **distribution** of a quantity *within* one world. Every instance draws its own value | mountain peak height `[2.5, 5.5] km`, crater diameter `[2, 40] km`, mountain-range length `[250, 600] km` |
| **Directional range** `from → to` | dual-thumb slider with an arrow | An ordered span | latitude span `65°N → 20°N` |
| **Enum** / **multi-select** | dropdown / chips | Choice | archetype, map edge, hero picks (include or exclude) |
| **Toggle** | checkbox | On or off | fjords, ocean currents |
| **Target** | any of the above, marked 🎯 | The generator **steers toward** this value but cannot set it directly, because it is emergent (§4). The value that came out is shown next to it | number of mountain ranges, continent count, river density |

**AUTO with ranges.** An AUTO range param derives *both* ends from its parents. For example, AUTO plate count at 1024 km is `[4, 6]`. Pinning one thumb is allowed: you can set `max = 8` and leave `min` on AUTO.

---

## 2. The hierarchy

Levels are evaluated top-down: **L0 → L1 → L2 → L3**. L4 (view) never affects the world.

- An arrow `←` lists the parents an AUTO value derives from.
- 🎯 marks a target (§4); Ⓢ marks a spread range and Ⓓ a draw range.
- Defaults are for the "Earth-like" archetype at 1024 km.

### L0 — World (root drivers; most users only touch these)

| Param | Kind | Default | Notes |
|---|---|---|---|
| `seed` | int | random | |
| `archetype` | enum | Earth-like | Earth-like, Archipelago, Pangaea, Rift & great lakes, Fjordland, Desert world, Volcanic island chain, Ice age, Hothouse tropics, Old craton, **Custom**. Applies a bundle of pins and biases (§5) |
| `worldSize` | scalar, log slider | 1024 km | 256–4096 km; preset stops at 512 / 1024 / 2048 / 4096 |
| `landFraction` | scalar | AUTO ← archetype (0.40) | 0.05–0.80 |
| `tectonicActivity` | scalar 0–1 | AUTO ← archetype (0.5) | From a dead craton (0) to very active (1): more plates, faster motion, higher peaks, more volcanoes and rifts |
| `geologicAge` | scalar 0–1 | AUTO ← archetype (0.5) | From young (0) to old (1). Old worlds are lower and rounder, keep more surviving craters, have wider valleys and plains, and show more inselbergs and mesas |
| `latitudeSpan` | directional range | AUTO ← archetype (65° → 20°) | −90…90. Drives the climate belts |
| `temperatureOffset` | scalar | AUTO ← archetype (0 °C) | −15…+15 °C |
| `humidity` | scalar | AUTO ← archetype (1.0) | 0.2–2.5 |
| `quality` | enum | Standard | Fast / Standard / High. Sets the grid resolutions (§3 table); not part of world identity |

### L1 — Structure

| Param | Kind | AUTO ← parents | Notes |
|---|---|---|---|
| `plateCount` | Ⓓ range | ← worldSize, tectonicActivity, archetype | §3 formula: [4, 6] at 1024 km, [12, 18] at 4096 km |
| `plateSizeSkew` | scalar 0–1 | ← archetype (0.4) | 0 gives similar-sized plates; 1 gives one or two giants plus fragments |
| `microplateCount` | Ⓓ range | ← plateCount, tectonicActivity | [0, 2] |
| `meanPlateArea` | *derived, read-only* | ← worldSize, plateCount | Shown for orientation, e.g. "≈ 210 000 km², ~460 km across". Change it via plateCount |
| `continentalShare` | scalar | ← landFraction | Fraction of plates that are continental (land plus shelf margin) |
| `continentCount` 🎯 | Ⓓ range | ← worldSize, landFraction, archetype | [1, 3] at 1024 km |
| `continentSizeSkew` | scalar 0–1 | ← archetype, continentCount | From equal continents to one dominant continent plus small ones |
| `islandAbundance` | scalar 0–2 | ← archetype, landFraction | Scales arcs, shelf islands, archipelagos and drowned ranges |
| `coastRoughness` | scalar (target fractal dimension D) | ← archetype, geologicAge | 1.15–1.40. Fjord and ria coasts sit at the high end |
| `hotspotCount` | Ⓓ range | ← worldSize, tectonicActivity | [0, 2] at 1024 km |
| `seaLevelRise` | scalar m | ← archetype | 0–200 m post-erosion. Drowns valleys into rias and turns hills into islands |
| `mapEdge` | enum | ← archetype | Ocean (default) / continent |
| `boundaryWarp` | scalar | ← geologicAge | How irregular plate boundaries are |

### L2 — Landforms, climate, water and heroes

**Mountains & tectonic features**

| Param | Kind | AUTO ← parents | Notes |
|---|---|---|---|
| `mountainRangeCount` 🎯 | Ⓓ range | ← plateCount, tectonicActivity | Steers how many convergent boundaries occur (§4) |
| `rangeLength` | Ⓢ range km | ← meanPlateArea (boundary length ∝ plate diameter) | [250, 550] km at 1024; [580, 1260] km at 4096 |
| `rangeWidth` | Ⓢ range km | ← rangeLength, tectonicActivity | ~0.15–0.3 × length |
| `peakHeight` | Ⓢ range m | ← tectonicActivity, geologicAge, worldSize | [2500, 5000] m at defaults. The top end gains ~+500 m per doubling of size (bigger collisions), capped at 9000. Drives LEM uplift |
| `plateauChance` | scalar | ← tectonicActivity, worldSize, peakHeight | Plateaus behind continent–continent collisions (Tibet-like) |
| `riftCount` 🎯 | Ⓓ range | ← tectonicActivity, plateCount | [0, 2] |
| `volcanism` | scalar 0–2 | ← tectonicActivity | Scales arc volcano density and hotspot output |
| `caldera share` | scalar | ← volcanism, geologicAge | Fraction of large volcanoes that are collapsed |
| `craterCount` | Ⓓ range | ← worldSize, geologicAge, `impactHistory` | [0, 2] at defaults. Old worlds keep more, mostly degraded |
| `impactHistory` | scalar 0–2 | ← archetype (1) | Only "Old craton" raises it |
| `craterDiameter` | Ⓢ range km | ← worldSize | [3, 40] km at 1024 km |
| `strataShare` / `karstShare` | scalar | ← archetype, geologicAge | Layered sedimentary plateaus (mesas, canyons) / limestone (karst) |

**Climate**

| Param | Kind | AUTO ← parents | Notes |
|---|---|---|---|
| `poleEquatorGradient` | scalar | ← archetype | |
| `windOverride` | angle + strength | off | |
| `oceanCurrents` | toggle + strength | ← mapEdge | |
| `moistureLength` | scalar km | ← worldSize (Earth-like interiors scale with size) | |
| `seasonality` | scalar | ← latitudeSpan | |
| `glaciation` | scalar 0–2 | ← temperatureOffset, latitudeSpan, peakHeight | Snowline and ice extent |
| `fjords` | toggle | AUTO = on if glaciation is high enough and the coasts are mountainous | |

**Water**

| Param | Kind | AUTO ← parents | Notes |
|---|---|---|---|
| `riverDensity` 🎯 | scalar | ← humidity | Sets the channel source area A₀ |
| `lakeDensity` | scalar | ← glaciation, humidity | |
| `meanderStrength` | scalar | 1.0 | Global multiplier; per-reach meandering still comes from slope |
| `wetlandShare` 🎯 | scalar | ← humidity, flatness | 4–10 % of land |
| `waveEnergy` / `tideRange` | scalar | ← ocean fetch (computed) | Delta and estuary style |

**Density families and heroes**

| Param | Kind | AUTO ← parents | Notes |
|---|---|---|---|
| `density.{relief, water, volcanic, coast, ice, arid, karst}` | scalar 0–3 | 1.0 | Scale the rates in research 05 §4 |
| `heroCount` | Ⓓ range | ← worldSize | [3, 5] at 1024 km, [5, 8] at 2048 km and above |
| `heroPicks` | multi-select include/exclude | ← archetype weights | e.g. "always include a canyon", "never a crater" |

### L3 — Process constants (expert; hidden behind "Advanced", almost always AUTO)

| Group | Params (AUTO ← parents) |
|---|---|
| LEM | uplift `U` (← peakHeight via relief ≈ 39·U/K), erodibility `K` (← geologicAge, strata), `m`, `n`, iterations (← geologicAge, quality), Δt, diffusion, talus angle |
| Hydrology | breach depth and area, width and depth coefficients, waterfall minimum drop, delta minimum discharge, routing jitter |
| Climate internals | orographic strength, rain-shadow cap, recycling, latitude warp, wind noise |
| GPU detail | resolution (← quality), hydraulic and thermal steps, re-anchor tolerance, amplification amount |

### L4 — View (never changes the world; shader-only or UI-only)

- map mode, palette, vertical exaggeration (AUTO ← zoom), sun / time of day, season
- labels, rivers, haze, minimap, water animation

---

## 3. AUTO formulas (first cut, tuned in M8)

Notation:
- `S` = world size in km.
- `a` = tectonicActivity, `g` = geologicAge, `L` = landFraction.
- `s2 = log2(S / 1024)`: the number of doublings from the default size.

| Param | AUTO rule |
|---|---|
| `plateCount` centre | `n = 5 · (S/1024)^0.8 · (0.7 + 0.6a)`; range `[round(0.8n), round(1.2n)]`, min 2 |
| `meanPlateArea` | `S² / n` |
| `rangeLength` | `[0.55, 1.2] · √(meanPlateArea)` |
| `continentCount` centre | `c = clamp(1.6 + 1.0·s2 + 3(L − 0.4), 1, 12)`; range `[round(c − 0.8), round(c + 1.0)]`; archetype overrides (Pangaea → [1, 1]) |
| `peakHeight` | `[1500 + 2000a, 3000 + 4000a + 500·max(0, s2)] · (1 − 0.45(g − 0.5))`, capped at 9000 m |
| `hotspotCount` | `[0, round(1 + 2a·(S/1024)^1.5)]` |
| `craterCount` | `round(λ · land area · (0.5 + g) · impactHistory)`, with `λ` from research 05; a P(≥1) guarantee only if a crater is chosen as a hero |
| `heroCount` | `[3, 5]` for S ≤ 1024, else `[5, 8]` |
| LEM iterations | `round(60 + 60g)` × quality factor |
| grids (Fast / Standard / High) | LEM 256²/512²/512², macro 512²/1024²/1024², detail 2048²/4096²/4096². Doubled per size doubling above 2048 km at High |

What these formulas give at the size presets, with everything else on AUTO (activity and age at 0.5, land fraction 0.40):

| worldSize | plateCount | meanPlate ⌀ | rangeLength | continents | peakHeight |
|---|---|---|---|---|---|
| 512 km | [2, 3] | ~300 km | [170, 360] km | [1, 2] | [2.5, 5.0] km |
| **1024 km** | **[4, 6]** | **~460 km** | **[250, 550] km** | **[1, 3]** | **[2.5, 5.0] km** |
| 2048 km | [7, 10] | ~690 km | [380, 830] km | [2, 4] | [2.5, 5.5] km |
| 4096 km | [12, 18] | ~1050 km | [580, 1260] km | [3, 5] | [2.5, 6.0] km |

**Earth is not the scale model.** Earth's mean plate is far larger than our default world. Plate counts are deliberately non-physical for small worlds, so that every world gets plate collisions. This follows research 05's rule that world size changes quantity, not density.

---

## 4. Targets: steering emergent outcomes

Some outcomes are emergent: the number of mountain ranges depends on which plate boundaries converge, and the number of continents depends on crust shape and sea level. For those, the parameter is a 🎯 **target**:

1. **Best-of-N.** The stage generates N candidates (e.g. 8 plate-motion assignments) from sub-seeds `hash(seed, stage, k)`, scores each against all targets, and keeps the best. This is deterministic: the same seed always picks the same candidate.
2. **Direct steering where possible.** Sea level is the histogram quantile for `landFraction`. Continent count is shaped by merging or splitting continental seeds before the crust distance field is built.
3. **Report outcomes.** Each target shows the realised value after generation, e.g. `Continents 🎯 [1, 3] → got 2 ✓`, or `got 4 ⚠` when the generator could not satisfy it. Unmet targets are listed in the progress strip.

---

## 5. Archetypes and pins

- An **archetype** is a named bundle of pins and auto-biases. Choosing it marks values as `PRESET`, a third visual state: a set value whose source is the archetype, not the user.
  - Example: *Fjordland* pins `latitudeSpan 72→55`, `seaLevelRise 120 m` and `fjords on`, and biases `glaciation` up.
  - Example: *Pangaea* pins `continentCount [1, 1]`.
- Any edit turns the archetype into "Custom (based on Fjordland)".
- **Per-param reset:**
  - ↺ returns a value to AUTO.
  - Alt-↺ returns it to the archetype value.
  - "Reset all" returns everything to the archetype.

---

## 6. Resolution, conflicts and caching

- **Schema.** Every param is declared once in `shared/config/schema.ts`:

  ```
  { id, level, kind, bounds, default: 'auto', deps, auto(resolved) => value, stage, ui }
  ```

  `deps` must form a DAG, which a unit test checks. `stage` is the earliest generation stage that reads the param.
- **Resolver.** It runs on the main thread in under 1 ms:
  1. Sort by dependency order.
  2. For each param, use its pin if it has one; otherwise compute `auto(resolved)`.
  3. Clamp to bounds.

  Because it is that cheap, dragging `worldSize` shows every AUTO child update live, before anything regenerates.
- **Conflicts.** A pin always wins. When pins are mutually implausible (e.g. `landFraction 0.08` with `continentCount [6, 8]` at 512 km):
  - the resolver keeps the pins;
  - it moves the AUTO siblings into the feasible region;
  - it shows a ⚠ chip naming the tension: "Continents will be very small (≈ 900 km²)".

  Hard infeasibility, such as more continents than plates, is clamped with an explanation.
- **Provenance.** Hovering an AUTO value shows how it was derived, e.g. `plateCount [4, 6] ← worldSize 1024 km, tectonicActivity 0.5 (Earth-like)`.
- **Caching.** The worker receives the *resolved* config. Each stage caches on the hash of the resolved params it reads plus its input hashes. Changing `worldSize` changes many resolved values and re-runs from S1. Changing `humidity` re-runs climate onward; `meanderStrength` re-runs hydrology onward; `palette` regenerates nothing.
- **URL and JSON.** Only `seed`, `archetype` and the user pins are serialised. AUTO values are re-derived, so shared links stay short, and old links keep working when an AUTO formula changes. To freeze a world exactly, "Pin all" writes every value.
- **Determinism.** Draw ranges are sampled with `rngFor('config', paramId)`. Changing one range never re-rolls another.

---

## 7. Config panel (custom, replacing lil-gui)

lil-gui has no dual-thumb ranges, AUTO chips, provenance tooltips or target feedback, so we build a small vanilla-TS panel (~600 lines) in the sibling project's DOM style.

- **Layout.** Collapsible sections per level and topic: World ▸ Structure ▸ Mountains ▸ Climate ▸ Water ▸ Features ▸ Advanced ▸ View. L3 is hidden until "Advanced" is opened.
- **Each row shows:**
  - the label;
  - the control: slider, dual slider, dropdown or chips;
  - the value;
  - a state chip: `AUTO` (grey), `PRESET` (blue) or `SET` (accent);
  - ↺;
  - for targets, the realised value after generation.
- **Interaction.**
  - Dragging an AUTO control pins it.
  - Clicking the chip toggles between AUTO and pinned. Pinning starts from the current AUTO value.
  - Search box: type "crater" to jump to its params.
  - On small screens the panel becomes a drawer. Keyboard accessible.
- **Live feedback.** AUTO children animate to their new values while a parent is dragged. Regeneration starts on release: a preview immediately, a full build when idle.

---

## 8. Tests

- The schema is a DAG; every `auto()` returns values within bounds over a grid of parent values.
- Monotonicity where intended: e.g. `plateCount`, `rangeLength`, `continentCount` and `heroCount` are non-decreasing in `worldSize`. Swept in tests.
- Snapshot of all resolved values per archetype × size preset, so formula changes are reviewed deliberately.
- Round trip: URL → resolve → URL gives identical pins. An old URL still resolves after a formula change.
- Target satisfaction: over 200 seeds per preset, targets are met in ≥ 90 % of worlds (part of `npm run metrics`).
