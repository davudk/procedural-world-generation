# 03 — Climate, Biomes, Vegetation and Surface Appearance

Scope: everything between "we have a heightmap plus hydrology" and "the world looks like a satellite photo". That covers temperature, wind and moisture, precipitation, biome classification, ocean appearance zones, top-down terrain shading and colour, and close-zoom vegetation. Elevation, erosion, rivers, lakes and the topographic wetness index (TWI) come from other notes; this note only consumes them.

Conventions:
- The climate grid is `N×N` (default `N = 1024`) over a `S×S` km world, so cell size is `Δ = S/N` km (1 km at default).
- Grid `y` grows southward. Latitude `φ` is in degrees, positive in the northern hemisphere (NH).
- Temperatures are in °C, precipitation in mm/yr, elevation `h` in m above sea level.

---

## 0. Recommendation summary

1. **Latitude is a parameter, not a consequence of size.** Map rows to latitude with `φ(y) = φN + (φS − φN)·y/N` (default 65° → 20°). Domain-warp it by ±3° of low-frequency noise so climate zones do not follow straight rows.
2. **Temperature is a few cheap terms.** Start from a zonal sea-level table, subtract a lapse rate of 6.5 °C/km, add a coastal sea-surface-temperature (SST) anomaly from a heuristic ocean-current model, and set the seasonal amplitude by continentality (an advected "marine influence"). Store the annual mean and the half-range. Monthly values come from a cosine, and everything else is derived from those (warmest month, coldest month, biotemperature, potential evapotranspiration (PET), months above 10 °C).
3. **Moisture is a steady upwind advection solved with fast-sweeping Gauss–Seidel**, a generalisation of mapgen4's wind-sorted sweep to a wind field that changes direction with latitude:
   - It takes 4 sweep orders × 2 iterations. Each sweep is O(n).
   - Run it once for summer and once for winter (circulation bands shifted ±5°). Dry-summer Mediterranean and dry-winter savanna climates then fall out naturally.
4. **Precipitation = humidity × circulation factor S(φ) × (1 + orographic uplift)**:
   - S(φ) encodes the wet ITCZ, the ~25–30° subtropical-high deserts and the mid-latitude storm track.
   - Rain shadows come from depletion. They are bounded by an uplift cap, a smoothed elevation input, and land evapotranspiration recycling.
5. **Classify biomes with an ordered rule list over Köppen-style derived variables** (Tw, Tc, P, Köppen dryness threshold, aridity P/PET, months > 10 °C), followed by local overrides: ice, slope/rock, coast, salt flats, wetlands from TWI.
   - The 25-entry table in §3 has thresholds and two palettes (satellite and stylised).
   - Snowline uses the Ohmura et al. relation between precipitation and summer temperature at the glacier equilibrium line. Treeline is Tw = 10 °C.
6. **Render colour on the GPU from climate textures, not from biome IDs.** A 2D look-up table (LUT) over (temperature, aridity) is sampled with noise-jittered inputs, so ecotones are smooth at every zoom level. Mask overlays (wetland, beach, rock, snow, salt) go on top. The CPU biome IDs are used for logic and vegetation only.
7. **Look**:
   - Patterson/Imhof-style hillshade: 315°/45° light, softened by a second diffuse term.
   - Zoom-dependent vertical exaggeration.
   - Colour variation at 3 scales: geology 100 km, mosaic 2–5 km, detail texture 20–100 m.
   - Aspect-dependent snow, strata banding in bare arid slopes, depth-attenuated water colour with reefs and sea ice.
8. **Vegetation: individual trees are sub-pixel at our maximum zoom (10–20 m/px), so do not instance trees.**
   - Bake canopy density into the ground colour.
   - Instance **stand clumps** (20–80 m crowns plus shadow) only below ~15 m/px. Generate them procedurally in the vertex shader from a jittered grid, hash, and density texture (no CPU instance buffers). The budget is ≤ 100–200k quads.
9. **Budget: the whole climate + biome stage takes ≈ 150–300 ms for 1024² in a worker**, so it can rerun live when a lil-gui climate slider changes. Terrain does not need to be regenerated.

---

## 1. Temperature model

### 1.1 Latitude

Zonal-mean annual sea-level air temperature is roughly as follows (NH observational climatology, rounded; use piecewise-linear interpolation):

| φ | 0° | 10° | 20° | 30° | 40° | 50° | 60° | 70° | 80° | 90° |
|---|---|---|---|---|---|---|---|---|---|---|
| T0(φ) °C | 26 | 26 | 24.5 | 20 | 13.5 | 6 | −1 | −9 | −17 | −22 |
| A_ocean(φ) half-range °C | 1 | 1.5 | 2.5 | 4 | 5 | 5.5 | 6 | 8 | 10 | 12 |
| A_land(φ) half-range °C | 1.5 | 4 | 8 | 11 | 14 | 17 | 20 | 22 | 22 | 22 |

The half-range is (warmest month − coldest month)/2. The A_land row is a deliberately smoothed "very continental" bound. Siberia exceeds it and Western Europe sits nearer the ocean row. Expose a **global offset** `ΔT_global` (ice age −6, hothouse +8) and a **pole–equator gradient scale** `g` that multiplies `T0(φ) − T0(0)`. Hothouse climates have flatter gradients (g ≈ 0.6). Ice ages have steeper ones (g ≈ 1.15).

Latitude warping (essential, see pitfalls):

```
φ_eff(x,y) = φ(y) + 3° · fbm(x/500km, y/500km, 3 octaves)   // ±3°, wavelength ~500 km
```

### 1.2 Elevation

`T = T_sl − Γ·max(h, 0)/1000` with environmental lapse rate Γ = 6.5 °C/km (the ICAO standard atmosphere). Use the **ice/terrain surface height** for land and `h = 0` for water. For the moisture model's *capacity* term, use a Gaussian-blurred height (σ ≈ 5 km). Single 1-km peaks should not create their own rain shadows.

### 1.3 Continentality ("marine influence" m ∈ [0,1])

This is advected in the same sweep as moisture (§2.3):
- Over water, `m = 1`.
- Over land, `m_out = m_in · exp(−ds / L_m)` with `L_m ≈ 400 km` (see "climate compression" in §7.3).
- Then `m = max(m, exp(−d_coast / 60 km))`, which accounts for sea breezes on lee coasts.

The amplitude and the extremes follow from m:

```
A  = lerp(A_land(φ), A_ocean(φ), m)
Tw = T + A        // warmest month
Tc = T − A        // coldest month
T_month(k) = T + A·cos(2π(k − k_peak)/12)   // k_peak = 6.5 NH (mid-July), 0.5 SH
```

### 1.4 Ocean currents (optional, default on)

A finite map has no real ocean basins, so a coastline-orientation heuristic stands in for gyres. For each ocean cell, compute the distance along the row to land on its east (`dE`) and on its west (`dW`). These are two linear row sweeps.

| Coast type (NH) | Latitude band | ΔSST | Real analogues |
|---|---|---|---|
| Land to the east (continent's **west** coast) | 12–35° | −4 °C (upwelling) | California, Canary, Humboldt, Benguela |
| Land to the east | 45–68° | +4 °C (winter +7) | North Atlantic Drift, Alaska Current |
| Land to the west (continent's **east** coast) | 15–40° | +2 °C | Gulf Stream, Kuroshio |
| Land to the west | 42–60° | −4 °C | Labrador, Oyashio |

The anomaly is weighted by `exp(−d/300 km)` and smoothstepped across the band edges over ±4°. It is added to the SST used for evaporation, sea ice and reefs. On land it arrives through advection: `T += m_adv · ΔSST_upwind`, carried in the moisture sweep as a second advected scalar. The SH is mirrored.

**Fog deserts**: coastal land with `d_coast < 60 km`, `ΔSST_upwind < −2 °C` and `φ ∈ [12°, 32°]` gets a precipitation multiplier of 0.3 and `fog = 1`. The fog flag drives sparse "lomas" vegetation and an optional low-cloud overlay.

### 1.5 Snowline and treeline

- **Treeline**: `Tw ≥ 10 °C`. This is the Köppen E/forest boundary. It is consistent with Körner & Paulsen's finding that high-elevation treelines share a growing-season mean of ≈ 6–7 °C worldwide. It works for both the polar treeline (latitude) and the alpine treeline (elevation), because Tw already includes the lapse rate. Expected alpine treeline: ~1000 m at 60° maritime, ~2000 m at 46°, ~3500 m in the tropics.
- **Permanent snow / glaciers**: Ohmura, Kasser & Funk (1992) fitted annual precipitation against summer temperature at the equilibrium-line altitude (ELA). The commonly quoted form is `P ≈ 645 + 296·T_s + 9·T_s²` (mm, °C; verify the coefficients against the paper before relying on them). Invert it:
  ```
  T_ELA(P) = (−296 + sqrt(296² − 36·(645 − P))) / 18     // P=300 → −1.2 °C, 645 → 0, 2000 → +4.1, 3500 → +7
  glacier  if (Tw − 1) < T_ELA(P)                          // Tw − 1 ≈ JJA mean
  ```
  This gives the realistic behaviour that **wet maritime ranges glaciate low** (Norway, Patagonia) and **dry ranges glaciate high** (Atacama: no glaciers below ~6 km). Treat ice as a terrain layer. A plateau ice sheet's thickness should feed back into elevation only if the terrain note supports it, which is optional.

---

## 2. Wind and moisture

### 2.1 Prevailing wind bands (direction *toward which* the wind blows, NH)

| Band | φ | From | Toward (unit vector, x = east, y = north) |
|---|---|---|---|
| Trades (Hadley) | 0–30° | NE/ENE | (−0.90, −0.43) |
| Westerlies (Ferrel) | 30–60° | WSW | (+0.93, +0.36) |
| Polar easterlies | 60–90° | E/NE | (−0.90, −0.43) |

Blend linearly across ±5° at 30° and 60°. The horse latitudes and the subpolar low are where the vector passes through near-zero. Renormalise with a floor, `|w| ≥ 0.3`, so a direction always exists. Add ±20° of direction noise (wavelength ~300 km). In the SH, flip the y-component. Options:
- `windOverride` (angle, strength 0–1): `w = normalize(lerp(w_band, w_override, strength))`.
- `windTerrainDeflection` (0–0.5): rotate `w` toward the contour tangent where the upslope component is large.

Do the deflection on blurred terrain only.

### 2.2 Large-scale circulation factor S(φ)

S(φ) is the rising-air (wet) or sinking-air (dry) multiplier on precipitation efficiency:

| φ_eff | 0 | 5 | 10 | 15 | 20 | 25 | 30 | 35 | 40 | 45 | 50 | 55 | 60 | 70 | 80 | 90 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S | 2.0 | 2.2 | 1.4 | 0.7 | 0.35 | 0.2 | 0.25 | 0.5 | 0.9 | 1.15 | 1.3 | 1.3 | 1.1 | 0.6 | 0.35 | 0.25 |

**Seasons**: run the sweep twice, evaluating S and the wind bands at `φ_eff − 5°` for local summer (the ITCZ and subtropical high move poleward) and at `φ_eff + 4°` for winter. At 38° this gives S_summer ≈ 0.3 and S_winter ≈ 1.0, which is a Mediterranean climate. At 12° it gives a wet summer and a dry winter, which is savanna. Store `P = P_s + P_w` and the summer fraction `ps = P_s / P`.

### 2.3 Moisture advection: fast-sweeping upwind solver

mapgen4 sorts all cells by their projection onto one wind vector and visits them in that order. Each cell takes the mean humidity of its upwind neighbours, rains `raininess·humidity`, rains extra when humidity exceeds a capacity that falls with elevation (`rain_shadow` parameter), and is reset/boosted by `evaporation` over water (mapgen4 `map.ts`). One sort fails here because our wind reverses direction between bands. The equivalent for a variable field is a **steady first-order upwind scheme solved with Gauss–Seidel sweeps in the 4 diagonal orders** (Zhao's fast sweeping method). Each cell depends only on upwind neighbours, so along non-recirculating characteristics it converges in one sweep per quadrant. Two full rounds (8 sweeps) are enough. Check the residual: stop when `max|Δq| < 1e-3`.

The state per cell is:
- `q`: humidity, dimensionless, where 1 = saturated air over a 15 °C sea.
- `m`: marine influence.
- `a`: advected SST anomaly.

```ts
const C = (T: number) => Math.exp(0.0698 * (T - 15));      // Clausius–Clapeyron ≈ 7 %/°C, C(15)=1

// per sweep order (sx, sy) in [(+1,+1), (-1,+1), (+1,-1), (-1,-1)], skipping cells whose
// upwind direction doesn't match the order (they will be visited by a matching sweep):
for (y of rows(sy)) for (x of cols(sx)) {
  const i = y*N + x, wx = windX[i], wy = windY[i];          // grid-oriented (wy>0 = southward)
  const ux = x - Math.sign(wx), uy = y - Math.sign(wy);      // upwind neighbours (edge → boundary value)
  const a = Math.abs(wx), b = Math.abs(wy), s = a + b;
  const qin  = (a*Q(ux,y) + b*Q(x,uy)) / s;                  // same for m, anomaly
  const hin  = (a*Hs(ux,y) + b*Hs(x,uy)) / s;                // blurred elevation upwind
  const ds   = Δ * s / Math.hypot(wx, wy);                   // km travelled across the cell (Δ…√2Δ)
  if (isWater[i]) {
    const target = RH_SEA * C(sst[i]) * waterEvapFactor[i];  // lakes 0.5–0.8, sea 1
    q[i] = target + (qin - target) * Math.exp(-ds / L_EVAP);
  } else {
    const up   = Math.min(Math.max(Hs[i] - hin, 0) / ds, UP_MAX);   // m of rise per km
    const eff  = S_season[i] * fogMul[i] + K_ORO * up;               // dimensionless
    let qq     = qin * Math.exp(-eff * ds / L_RAIN);                 // depletion
    const cap  = C(Tseason_at_Hs[i]) * RH_MAX;
    if (qq > cap) qq = cap + (qq - cap) * (1 - ETA_SAT);             // cold plateau / winter snow-out
    const rained = qin - qq;
    q[i] = qq + R_RECYCLE * vegET[i] * rained;                       // evapotranspiration recycling
  }
}
// final non-mutating pass: P[i] = P0 * (qin - qout_before_recycle) * L_RAIN / ds  (mm/yr)
```

Precipitation per cell is "what the column lost", rescaled to mm/yr: `P = P0·(qin − qq)·L_RAIN/ds`, which reduces to `P ≈ P0·qin·eff` for small steps. Default parameters:

| Param | Default | Meaning / effect |
|---|---|---|
| `P0` | 1200 mm/yr | Rain from saturated 15 °C air with S = 1 on flat land (the **humidity** knob scales it) |
| `L_RAIN` | 1500 km | Depletion length on flat land at S = 1. A coast at 50° gets ≈ 1100 mm; 1000 km inland ≈ 450 mm without recycling and ≈ 600 mm with it |
| `L_EVAP` | 300 km | Distance over sea to recharge to `target` |
| `RH_SEA` | 0.85 | Humidity of marine air relative to capacity |
| `K_ORO` | 0.08 per (m/km) | A 40 m/km windward slope (2 km rise over 50 km) gives ×3–4 rain, which matches western Norway or the Olympics |
| `UP_MAX` | 60 m/km | Caps orographic efficiency and so **bounds the rain shadow**. Lower it if shadows are too harsh |
| `RH_MAX`, `ETA_SAT` | 1.0, 0.5 | Snow-out of supersaturated air on cold plateaus |
| `R_RECYCLE` | 0.35 | Fraction of rain re-evaporated (× `vegET`: forest 1, grass 0.6, desert 0.1). Keeps interiors from going to zero |
| Boundary inflow | "ocean": `q = RH_SEA·C(SST)`, `m = 1` · "continent": `q = 0.35`, `m = 0` | Exposed as `outsideWorld` |

Post-process: Gaussian-blur `P` with σ = 8 km to mimic storm-scale spreading. Blur `ps`, `m` and `a` with σ = 15 km. Then multiply `P` by `exp(0.15·fbm)`, a ±15% mesoscale texture.

**Rain shadows emerge on their own.** Air that rose over the range has lost `1 − exp(−K_ORO·up·ds/L_RAIN)` of its moisture. On the lee side, `up = 0`, so only the S term rains, and on depleted air. Expected ratios with the defaults: windward:lee ≈ 4–6:1 behind a 2–3 km range, which is about Cascades or Southern Alps level. If it is stronger than that, see the pitfalls.

**Aridity and PET**:

```
BT  = mean over 12 months of clamp(T_month, 0, 30)    // Holdridge biotemperature
PET = 58.93 · BT                                      // Holdridge PET, mm/yr
AI  = P / PET                                         // <0.2 arid, 0.2–0.5 semi-arid, 0.5–0.75 dry sub-humid, >0.75 humid
N10 = #months with T_month > 10                       // boreal vs temperate
Pth = 2·T + (ps ≥ 0.7 ? 28 : ps ≤ 0.3 ? 0 : 14)      // Köppen dryness threshold (Peel et al. 2007)
dry = P < 10·Pth;  desert = P < 5·Pth                 // Köppen B / BW
```

---

## 3. Biome classification

### 3.1 Why rules over Köppen-style variables, not a raw Whittaker picture

Whittaker's diagram (mean annual temperature × annual precipitation polygons; digitised in the `plotbiomes` R package) is a good *colour LUT* axis. As a classifier it misses three things we need:
- seasonality: Mediterranean vs. steppe, savanna vs. dry forest;
- the cold-month split: boreal vs. temperate;
- alpine vs. polar.

Holdridge (biotemperature × precipitation × PET ratio) handles aridity well but has 30+ life zones. The approach here is an ordered rule list using Köppen variables plus aridity, then local overrides, then a soft render-time blend.

### 3.2 Rules (first match wins; `T0w` = Tw re-lapsed to sea level, used to tell alpine from polar)

1. **Water** → ocean or lake zones (§4).
2. **Ice**: glacier test from §1.5 → `ICE`.
3. **Slope** (from the full-resolution DEM, aggregated): `s > 38°` → `ROCK`. Between 30° and 38°, blend toward rock: `rockMix = (s − 30)/8`.
4. **Coast**: `d_coast < 2 km ∧ h < 5 m ∧ s < 2°`:
   - sheltered (fetch < 20 km or within 15 km of a river mouth) and `Tc ≥ 16` and `SST_cold ≥ 20` → `MANGROVE`;
   - sheltered, otherwise → `SALT_MARSH`;
   - exposed → `BEACH`.
   - Dunes extend up to 10 km inland when onshore wind meets sandy substrate and `AI < 0.6`.
5. **Salt flat**: floor of an endorheic basin (hydrology terminal lake with evaporation ≥ inflow) with `AI < 0.25` → `SALT_FLAT`.
6. **Wetland**: `TWI > 12 ∧ s < 1° ∧ AI > 0.5` (or a floodplain flag) → `T ≥ 18`: `SWAMP` (forested), `T < 4`: `BOG`, else `MARSH`.
7. **Cold** (`Tw < 10`):
   - `Tw < 3` → `NIVAL` if alpine (`h > 600 ∧ T0w ≥ 10`), else `POLAR_DESERT`;
   - else if alpine → `ALPINE_MEADOW` (`P ≥ 300`) or `NIVAL`;
   - else → `TUNDRA` (`P ≥ 150`) or `POLAR_DESERT`.
8. **Dry** (`dry`):
   - `desert` → `HOT_DESERT` if `T ≥ 18` else `COLD_DESERT`.
   - Otherwise (semi-arid), if `T ≥ 18`: `SAVANNA` when `ps > 0.6` (summer rain), else `XERIC_SHRUB`.
   - Otherwise (`T < 18`): `XERIC_SHRUB` when `ps < 0.35` (winter rain, sagebrush or matorral), else `STEPPE`.
9. **Tropical mountains**: `T0c ≥ 12 ∧ h ≥ 1000 ∧ P ≥ 1500 ∧ 10 ≤ T ≤ 20` → `CLOUD_FOREST`. Upgrade it if `fog` is set or the slope is windward.
10. **Tropical** (`Tc ≥ 18`): `P ≥ 2000 ∧ min(ps, 1−ps) ≥ 0.3` → `TROP_RAINFOREST`; else `P ≥ 1000` → `TROP_DRY_FOREST`; else `SAVANNA`.
11. **Temperate** (`Tc > −3`):
    - `ps < 0.35 ∧ Tw ≥ 17` → `MEDITERRANEAN`. It becomes sclerophyll broadleaf if `P > 900`.
    - Else `P ≥ 2000 ∧ A ≤ 8 ∧ 4 ≤ T ≤ 16` → `TEMP_RAINFOREST`.
    - Else `AI < 0.75` → `STEPPE` (prairie/forest-steppe).
    - Else montane (`h > 800 ∧ Tw < 16`) → `TEMP_CONIFER`; else `TEMP_BROADLEAF`.
12. **Continental** (`Tc ≤ −3`): `AI < 0.6` → `STEPPE`; else `N10 ≤ 3` → `BOREAL`; else `T < 5` or `h > 800` → `TEMP_CONIFER` (hemiboreal or montane); else `TEMP_BROADLEAF`.

### 3.3 Biome table (thresholds summarised; colours are tuned starting points, linear-ish sRGB)

| # | Biome | Typical climate (T °C, P mm, other) | Canopy cover | Satellite RGB | Stylised RGB | Satellite look |
|---|---|---|---|---|---|---|
| 1 | Ice sheet / glacier | glacier rule | 0 | 236 240 245 | 250 252 255 | Blue-white; crevasse texture; blue tint in shadows |
| 2 | Polar desert | Tw < 3, or Tw < 10 ∧ P < 150 | 0 | 170 160 150 | 205 200 190 | Grey-brown gravel, patterned ground |
| 3 | Tundra | 3 ≤ Tw < 10, P ≥ 150 | 0.05 | 124 124 92 | 170 180 130 | Olive-brown, ponds speckled everywhere |
| 4 | Boreal / taiga | Tc ≤ −3, N10 ≤ 3 | 0.6 | 44 62 38 | 70 110 70 | Very dark blue-green, lakes, bogs, burn scars |
| 5 | Temperate coniferous | montane / hemiboreal | 0.7 | 40 66 40 | 60 120 80 | Dark, uniform, sharp clear-cut edges |
| 6 | Temperate broadleaf | AI ≥ 0.75, T 5–18 | 0.75 | 62 94 46 | 110 160 80 | Mid green, field mosaic texture |
| 7 | Temperate rainforest | P ≥ 2000, A ≤ 8 | 0.95 | 30 64 36 | 40 120 70 | Deepest green, cloud-shadowed |
| 8 | Grassland / steppe | dry semi-arid T < 18, or AI 0.5–0.75 | 0.05 | 150 148 96 | 200 200 120 | Khaki; green in spring, gold in late summer |
| 9 | Mediterranean shrub | ps < 0.35, Tw ≥ 17 | 0.35 | 118 118 78 | 165 160 95 | Grey-olive with bright soil showing through |
| 10 | Hot desert | BW, T ≥ 18 | 0 | 214 186 140 | 235 210 160 | Sand seas and rocky hamada; reds and ochres |
| 11 | Cold desert | BW, T < 18 | 0 | 176 162 136 | 205 190 160 | Grey-tan, salt pans, gravel |
| 12 | Xeric shrubland | BS, winter rain or hot | 0.15 | 170 150 108 | 200 180 120 | Tan with dark dot speckle |
| 13 | Savanna | Tc ≥ 18 or BSh, summer rain | 0.2 | 156 146 84 | 200 190 100 | Yellow-tan grass, scattered dark crowns, darker green along rivers |
| 14 | Tropical dry forest | Tc ≥ 18, P 1000–2000 | 0.6 | 98 110 58 | 140 160 70 | Olive; browns in dry season |
| 15 | Tropical rainforest | Tc ≥ 18, P ≥ 2000, no dry season | 0.98 | 26 66 26 | 40 130 50 | Uniform dark green, brown rivers |
| 16 | Montane / cloud forest | tropical h 1000–3000, P ≥ 1500 | 0.9 | 34 72 44 | 60 130 90 | Dark green, often cloud-covered |
| 17 | Alpine meadow | Tw 3–10 (by altitude), P ≥ 300 | 0.02 | 120 130 88 | 160 190 120 | Light olive, streaked with scree |
| 18 | Alpine rock / nival | Tw < 3 alpine | 0 | 128 122 116 | 165 160 155 | Grey rock with snow patches |
| 19 | Mangrove | tidal, Tc ≥ 16 | 0.9 | 36 70 46 | 60 110 80 | Dark band cut by tidal creeks |
| 20 | Salt marsh | tidal, Tc < 16 | 0.1 | 100 110 80 | 140 160 110 | Olive-brown, dendritic creeks |
| 21 | Freshwater marsh / swamp | TWI > 12, T ≥ 4 | 0.3 / 0.8 | 60 80 56 | 90 130 100 | Dark mottled, water glints |
| 22 | Bog / fen | TWI > 12, T < 4 | 0.1 | 110 100 70 | 150 140 100 | Brown-ochre, pools |
| 23 | Beach / dunes | coastal sand | 0 | 226 212 178 | 240 225 180 | Bright band; wet sand darker |
| 24 | Salt flat | endorheic, AI < 0.25 | 0 | 232 230 222 | 245 245 240 | Brightest thing on the map, polygonal crust |
| 25 | Bare rock / cliff / scree | s > 38° | 0 | 120 114 108 | 160 150 140 | Tinted by substrate (see §5.4) |

Substrate modifiers (from the geology mask, if the terrain note provides one):
- **Sand**: desert cells become ergs (`HOT_DESERT` with dune texture). Grass or steppe become sparser (×0.6 canopy).
- **Limestone/karst**: brighter soil (+10% value). Fewer surface streams, so TWI × 0.7.
- **Volcanic**: dark soil (−25% value) in arid zones. Lush and saturated in humid ones.

Salinity: coastal low ground with `h < 2 m` and `AI < 0.5` → sabkha (salt-flat colour, 50% blend).

### 3.4 Smooth ecotones

Hard ID boundaries look like blobs with jagged pixel edges. Use three mechanisms:

1. **Jittered inputs**: classify using `T + 1.5·n1`, `P·exp(0.2·n2)` and `φ_eff`, where n1 and n2 are fbm noises at 20–40 km. This breaks perfect isotherms into lobes and peninsulas, which is how real ecotones look.
2. **Render-time blending**: the fragment shader does not read the biome ID for colour. It reads a **2D colour LUT** (64×64 RGBA8) indexed by `u = (T + 20)/50` and `v = log10(AI·10)/2`. The LUT is painted once from the table: each texel stores its zonal biome's satellite colour, Gaussian-blurred σ = 2 texels. Hardware bilinear filtering then gives continuous ecotones at any zoom. Seasonality variants come from a second LUT for dry-summer climates, mixed by `smoothstep(0.45, 0.30, ps)`. Local overrides (ice, rock, beach, wetland, salt, mangrove) are separate masks stored as Uint8 coverage, blurred σ = 1 cell, and composited in a fixed order.
3. **CPU IDs for logic only** (vegetation types, stats, tooltips). Apply a 3×3 majority filter so single-cell speckle does not seed odd trees.

---

## 4. Ocean appearance zones

Inputs: depth `d = −h`, SST (with anomaly and seasonal amplitude from `A_ocean`), distance to coast, and river-mouth discharge.

| Zone | Rule | Colour (satellite) |
|---|---|---|
| Surf / very shallow | d < 3 m | Sand bottom through water (see the formula below) |
| Shelf / lagoon | d < 200 m | Turquoise → teal as depth increases |
| Reef | 1 < d < 30 m, `SST_cold ≥ 20 °C`, within 0–10 km of coast or on shelf-edge rises, no river with discharge > threshold within 20 km | Bright aqua with a darker mottled crest line and a white surf line on the seaward edge |
| Slope | 200–2000 m | Blue |
| Deep / abyss | > 2000 m | Navy (8 28 62) → (3 12 34) at 5000 m |
| Turbid plume | within `k·√Q` km of river mouth | Brown-green mix, fading out |
| Sea ice (seasonal) | `SST − A_ocean < −1.8 °C` | Shown in the winter tint only; white-grey with leads |
| Sea ice (perennial) | annual air `T < −10 °C` over water | Always white-grey, ridged texture |

Water colour uses Beer–Lambert per channel with clear-water attenuation of roughly `k = (0.35, 0.07, 0.03)` per m. Red goes first, which produces the turquoise.

```
bottom  = sandColor·(1 − 0.4·mudFrac)
shallow = bottom · exp(−2·d·k)                          // down and back up
water   = mix(shallow, deepColor(d), 1 − exp(−d / 25 m))
```

Add a slight coastal brightening for wave-churned sediment within ~300 m of shore. Specular sun glint is optional (one directional term, off by default for a map look).

---

## 5. Visual design: making top-down terrain beautiful

### 5.1 References and palette philosophy

- **Satellite-like**: NASA Blue Marble Next Generation (MODIS composite) is the reference for biome colours. Sahara ochre, boreal near-black green, tropics deep green, steppe khaki. Real satellite imagery is **low-saturation and dark**. Vegetation reflectance in visible light is only a few percent. Push saturation down and let hillshade carry the image.
- **Cartographic**: Tom Patterson's Natural Earth and *World Relief* rasters, and his "cross-blended hypsometric tints" (Patterson & Jenny 2011). Lowland colours vary by environment (arid lowlands brown, humid lowlands green) and cross-blend with elevation tints. This is exactly the climate-LUT approach, plus elevation lightening.
- **Imhof** (*Cartographic Relief Presentation*): colours become lighter, more saturated and more contrasty with elevation (aerial perspective in reverse). The light comes from the upper left. Shadows are cool (blue-violet grey) and lit slopes warm (yellow).

Offer a `palette` enum (`satellite | cartographic | stylised`), each defined as a pair of LUTs plus a hillshade style.

### 5.2 Hillshade

```glsl
float lambert = max(dot(n, L), 0.);                     // L: azimuth 315°, altitude 45°
float soft    = 0.5 + 0.5*dot(n, normalize(vec3(0,0,1) + 0.3*L)); // second, flatter light
float shade   = mix(soft, lambert, 0.65) * mix(1., skyView, 0.4);  // skyView = baked openness/AO
vec3  col     = base * mix(shadowTint, highlightTint, shade);     // (0.55,0.6,0.75) → (1.05,1.02,0.95)
```

- Normals come from the **displayed** heightmap mip, so shading stays consistent with the geometry.
- **Vertical exaggeration** depends on zoom: `ex = clamp(1.5·(mPerPx/20)^0.35, 1, 8)`. That is about 1.5× at 20 m/px and about 6× at whole-world view (~1 km/px). At whole-world zoom, real relief is otherwise invisible.
- **Aerial perspective**: lerp toward a haze colour by `(1 − h/hmax)·0.08` (Imhof), plus a slight saturation boost on peaks.
- Optional *texture shading* (Leland Brown) on a separate layer brings out drainage structure at mid zoom.

### 5.3 Colour variation at multiple scales (avoid "flat biome paint")

| Scale | Source | Amplitude |
|---|---|---|
| 50–200 km | geology/soil fbm, the substrate mask | ±8% value, ±6° hue |
| 2–10 km | "mosaic" noise thresholded against canopy density, giving forest patches, clearings, burn scars (boreal), fields (optional) | canopy ±0.25 |
| 0.3–1 km | ridge/valley: wetter valleys are greener (TWI), dry ridges browner | `colour = mix(c, c_wet, smoothstep(6, 12, TWI)·0.4)` |
| 20–100 m | tiled detail texture per surface class (sand ripples, rock, canopy speckle), blended by weights; at least two octaves of the same texture at non-integer scale ratios to hide tiling | ±10% luminance |

Rivers and riparian strips should be greener and darker than their surroundings in dry biomes: use `riparian = exp(−d_river/(0.3 + 0.1·√Q) km)`. In deserts this gives the "Nile ribbon", the single most satellite-like cue.

### 5.4 Special surfaces

- **Snow** (seasonal and permanent): `T_eff = T_season − 2.0·(1 − dot(n, sunDirNoon)) − Γ·Δh_fine`, then `snow = smoothstep(0.5, −1.5, T_eff)·(1 − smoothstep(40°, 55°, slope))`. In the NH, north-facing slopes hold snow 100–300 m lower. Steep faces shed snow and stay dark rock, which is the classic alpine look. Snow over forest is drawn as `mix(snow, canopyColor, 0.6·canopy)` (grey-green, not white).
- **Arid strata**: where `canopy < 0.2 ∧ slope > 10°`, `col *= strataLUT(fract(h/120 m + 0.3·fbm(x/5km) + tilt·x))`. The LUT is a 1D band strip: cream 220 200 160, red 170 90 60, ochre 200 150 90, grey 140 130 120. Cliff bands and mesas then read like the Colorado Plateau.
- **Sand**: wet sand within 0–30 m above the waterline uses value ×0.7. Dune ripple texture is oriented perpendicular to the wind vector.
- **Salt flats**: near-white with polygon crack detail. Clamp below 0.92 value so they do not blow out.
- **Seasonal tint** (`season ∈ [0,1)` slider): it changes `T_season` (snow), the grassland and savanna gold-vs-green (`ps`-weighted), deciduous autumn colours (orange-brown 150 90 40 in `TEMP_BROADLEAF` when the month's T falls between 5 and 10 °C), and sea-ice extent. This is purely a shader uniform plus the stored T, A and ps.

---

## 6. Vegetation at close zoom

### 6.1 Reality check

At 10 m/px, a 4–8 m tree crown is **0.4–0.8 px**. At 20 m/px it is a quarter of that. Individual trees are invisible at our maximum zoom. A 1920×1080 view at 10 m/px covers 207 km². A forest with 400 trees/ha would mean 8 million instances. So:
- **Default**: no tree instances. Canopy cover is baked into the ground colour (density map, mosaic, riparian strips). This already reads correctly from orbit.
- **Clumps** fade in below 15 m/px: instanced stands of 20–80 m diameter, each a soft-edged crown blob plus a drop shadow offset opposite the sun. At 50 m spacing and 0.6 cover, a 207 km² view holds about 50k instances. Cap at 150–200k.
- **Individual trees** only if max zoom is later extended to ≤ 3 m/px. The same pipeline applies with smaller cells.

### 6.2 Deterministic placement (GPU-procedural, no CPU buffers)

- Split the world into 1×1 km placement tiles. For each visible tile and vegetation layer (trees, shrubs, clumps), issue `drawArraysInstanced(quad, 4, cellsPerTile)`.
- Draw only tiles in the view frustum: about 200 tiles at 10 m/px, chunked into 1–4 draw calls via a tile-ID attribute.
- The vertex shader works from the instance index:

```glsl
uint cell = uint(gl_InstanceID);  ivec2 c = ivec2(cell % CPT, cell / CPT);   // CPT = cells per tile side
uvec3 h  = pcg3d(uvec3(tile.x*CPT + c.x, tile.y*CPT + c.y, seed ^ layer));
vec2 p   = (vec2(tileOrigin + c) + 0.1 + 0.8*vec2(h.xy)/4294967295.) * cellSize;  // jittered grid
float dens = texture(canopyTex, p / worldSize).r * layerShare[biome];
if (float(h.z)/4294967295. > dens) { gl_Position = vec4(2,2,2,1); return; }    // reject → off-clip
```

- A jittered grid with jitter in [0.1, 0.9] guarantees a minimum spacing of `0.2·cellSize`. It looks Poisson-ish, is fully deterministic, and needs no neighbour checks. Tiles are independent and seam-free.
- Use Bridson's Poisson-disk sampling only if a strict minimum distance ever matters, for example for 3D tree meshes.
- Size: `r = r_type·(0.7 + 0.6·hash)`. Rotation comes from the hash. Colour: biome canopy colour × (0.85–1.15 hash jitter) × hillshade sampled at the base.

### 6.3 Types per biome

| Biome(s) | Types (share) | Crown radius (indiv. / clump) | Notes |
|---|---|---|---|
| Boreal, temperate conifer | spruce/fir/pine (0.9), birch (0.1) | 1.5–3 m / 15–30 m | Narrow, dark, blue-green; strong shadows |
| Temperate broadleaf | oak/beech (0.8), conifer (0.2) | 4–8 m / 25–50 m | Rounder, lighter; autumn tint |
| Temperate rainforest | cedar/hemlock (1.0) | 3–6 m / 20–40 m | Densest |
| Mediterranean, xeric | holm oak, olive, shrubs (0.6 shrub) | 1–4 m / 10–20 m | Sparse, soil visible |
| Savanna | acacia (umbrella), baobab rare | 4–10 m / single | Isolated flat crowns; density 0.05–0.3 |
| Tropical rainforest, cloud forest | broadleaf emergent mix, palms near coast | 5–15 m / 40–80 m | Hummocky canopy texture instead of discrete crowns |
| Mangrove | mangrove (1.0) | 2–5 m / 10–30 m | Only on tidal mask |
| Desert, steppe, tundra | shrubs/cushions | 0.3–1.5 m | Never instanced at our zoom; texture only |

### 6.4 LOD and fade (no popping)

- `crownPx = 2·r / mPerPx`. Fade alpha is `smoothstep(1.5, 4.0, crownPx)`. Use dithered (screen-door) alpha or alpha-to-coverage so instances never need sorting.
- **Energy conservation**: draw the ground as `mix(soil, canopyAvg, cover·(1 − fade))`. Instances add `cover·fade` worth of canopy. Mean colour is then preserved across the transition, so nothing pops.
- Draw order: terrain → shadows (multiply blend, one pass) → crowns. In top-down view, crowns need no depth sort beyond a per-instance z from terrain height.
- Budgets on mid-range integrated GPUs:
  - ~200k instanced quads at about 2–3 ms.
  - With overdraw, crown fill rate dominates. Keep sprite textures small (64² atlas) and bias the fade so that < 30% of the screen is covered by instances.

---

## 7. Concrete recommendation for this project

### 7.1 Pipeline (worker, after terrain + hydrology)

| Step | Work | Est. time 1024² |
|---|---|---|
| 1 | Latitude warp, `φ_eff`; zonal T0, A tables; land/water masks; blurred elevation `Hs` (separable Gaussian) | 10 ms |
| 2 | Coast distance (2-pass chamfer or jump flood); row sweeps `dE`/`dW`; SST anomaly | 15 ms |
| 3 | Wind field (bands + noise + override + deflection) | 5 ms |
| 4 | Summer sweep: 8 Gauss–Seidel passes over (q, m, a), final P pass | 40–70 ms |
| 5 | Winter sweep (same) | 40–70 ms |
| 6 | Blurs (P, ps, m, a); T, A finalisation; BT/PET/AI/N10/Pth | 25 ms |
| 7 | Glacier, biome rules, overrides (TWI, slope, coast, salt), majority filter | 15 ms |
| 8 | Canopy density, snow-at-rest, pack GPU textures, transfer | 15 ms |
| **Total** | | **≈ 165–225 ms** (budget 300 ms) |

Climate sliders rerun steps 1–8 only, so lil-gui can apply them on release (`onFinishChange`) at interactive speed. Changing only the colour palette or season is shader-only, with no worker round trip.

### 7.2 Data layout

| Raster | Type | Notes |
|---|---|---|
| `tMean` | Float32 (worker), → R16F texture | °C at surface (lapsed) |
| `tAmp` | Uint8 (0.1 °C) | half annual range |
| `precip` | Uint16 (mm/yr, clamp 65535) | annual |
| `pSummerFrac` | Uint8 (/255) | seasonality |
| `marine`, `sstAnom` | Uint8, Int8 (0.1 °C) | debugging + current tinting |
| `aridity` | derived in shader from T, A, P | saves a channel |
| `biome` | Uint8 (enum, 25 values) | logic, stats, vegetation |
| `masks` | RGBA8: ice, rock, wetland, coastal(beach/marsh/mangrove code), salt | blurred coverage |
| `canopy` | R8 | cover 0–1, includes mosaic noise |
| `fog` | bit in `masks` or R8 | |

GPU packing: `climateTex` RGBA16F (T, A, P/1000, ps) plus `maskTex` RGBA8 plus `canopyTex` R8, all at 1024² with linear filtering. That is ≈ 13 MB of VRAM. The colour LUTs are 64×64 RGBA8 and the strata LUT is 256×1.

### 7.3 Parameters to expose (lil-gui folder "Climate")

| Parameter | Range | Default |
|---|---|---|
| `latitudeNorth`, `latitudeSouth` | −90…90 | 65, 20 |
| `climateCompression` (read-only display: latitude-degrees per 1000 km ÷ 9) | — | ≈ 5× at defaults |
| `latitudeWarp` (°) | 0–8 | 3 |
| `globalTempOffset` (°C) | −15…+15 | 0 |
| `poleEquatorGradient` | 0.4–1.5 | 1 |
| `humidity` (scales P0) | 0.2–2.5 | 1 |
| `moistureLength` (L_RAIN, km) | 300–4000 | 1500 |
| `orographicStrength` (K_ORO), `rainShadowCap` (UP_MAX) | 0–0.2, 10–150 | 0.08, 60 |
| `recycling` | 0–0.7 | 0.35 |
| `windOverrideAngle`, `windOverrideStrength` | 0–360°, 0–1 | 0, 0 |
| `windNoise` (°) | 0–45 | 20 |
| `oceanCurrents` | bool + strength 0–2 | on, 1 |
| `outsideWorld` | ocean / continent | ocean |
| `seasonalityScale` (multiplies A and band shift) | 0–2 | 1 |
| `palette`, `season`, `exaggeration` (render) | enum, 0–1, auto/manual | satellite, 0.55 (July), auto |

**Climate compression and length scales.** A 1024 km world spanning 45° compresses latitude about 5× relative to Earth. Moisture and continentality lengths (`L_RAIN`, `L_m`) are *physical* and should **not** be compressed by default. Interiors therefore dry out realistically over a few hundred kilometres only on large presets. For small worlds (512 km), offer an "Earth-like interiors" toggle that scales `L_RAIN` and `L_m` by `S/4000 km`, so a 512 km continent can still have an arid core.

### 7.4 Presets

| Preset | lat span | ΔT | gradient | humidity | other |
|---|---|---|---|---|---|
| Earth-like | 65 → 20 | 0 | 1.0 | 1.0 | defaults |
| Ice age | 70 → 25 | −6 | 1.15 | 0.75 | sea ice on; glaciers reach low elevations; steppe expands |
| Hothouse | 75 → 15 | +8 | 0.6 | 1.3 | S table flattened (×0.7 contrast) toward 1; no ice; boreal pushed off-map |
| Desert world | 40 → 10 | +3 | 1.0 | 0.35 | `outsideWorld = continent`, `moistureLength 600` |
| Tropical archipelago | 15 → −5 | 0 | 1.0 | 1.2 | crosses the equator; reefs and mangroves |
| Subarctic fjords | 72 → 55 | −1 | 1.0 | 1.3 | westerlies onshore, warm drift on |

### 7.5 Pitfalls

- **Banding along latitude rows.** Every term is a function of `φ`, so straight isotherms and straight desert edges appear. Fixes:
  - latitude warp ±3° (fbm 500 km);
  - wind direction noise;
  - mesoscale P noise;
  - input jitter in classification;
  - band blending over ±5°.
  Verify with a "T only" debug view: isotherms should wiggle and follow terrain.
- **Biomes as blobs or noise-driven patches.** Never drive biome choice directly from noise. Noise only perturbs *climate inputs* and *within-biome* cover. Blob edges also come from rendering hard IDs, so colour from LUTs and blurred masks instead (§3.4).
- **Rain shadow too strong or too long.** Typical symptoms: deserts directly behind 1-km hills, or whole lee halves of the map barren. Fixes:
  - blurred `Hs` (σ 5 km);
  - cap `UP_MAX`;
  - recycling;
  - weak cross-wind diffusion, which the upwind stencil already provides (numerical diffusion ∝ Δ);
  - winter/summer runs with different wind angles averaging out.
  Target windward:lee 3–6×, not 20×.
- **Moisture "streaks"** aligned with grid axes. These come from first-order upwind on axis-aligned winds. Fix with wind noise, plus the σ 8 km P blur.
- **Sweep not converged** where winds recirculate (band boundaries). Cap at 3 rounds. Use a residual check, and fall back to a mean of neighbours.
- **Domain edges.** With `outsideWorld = ocean`, every upwind edge gets wet. On westerly worlds the west edge becomes a rainforest coast even when the edge is land. Feather the boundary with 30 km of virtual sea, or use `continent`.
- **Snowline too uniform.** Use the P-dependent ELA and aspect term, not a constant altitude.
- **Too saturated and too bright.** Satellite colours are dull. Let hillshade and multi-scale variation add the interest. Check against Blue Marble at the same scale.
- **Unit mixups** in Köppen `Pth` (mm vs. cm) and in Holdridge PET. Use the formulas above, all in mm.
- **Determinism.** All noise and hash functions are seeded from the world seed plus a layer ID. Run sweeps in fixed order with no `Math.random`. GPU vegetation uses integer PCG hashing, not float `sin` hashes, so instances stay stable across GPUs.

---

## References

- Amit Patel (Red Blob Games), mapgen4 rainfall/evaporation/wind implementation (`assignRainfall`, wind-sorted sweep, `raininess`, `rain_shadow`, `evaporation`): https://github.com/redblobgames/mapgen4 (see `map.ts`) and https://www.redblobgames.com/maps/mapgen4/
- Amit Patel, "Polygon Map Generation for Games" (elevation × moisture biome table): http://www-cs-students.stanford.edu/~amitp/game-programming/polygon-map-generation/
- Red Blob Games, wind patterns exploration: https://www.redblobgames.com/x/1731-wind-patterns/ ; Mapgen Cylinder (west-to-east wind experiment): https://www.redblobgames.com/x/2505-mapgen-cylinder/ ; planet generation notes: https://www.redblobgames.com/x/1843-planet-generation/
- Peel, Finlayson & McMahon (2007), "Updated world map of the Köppen-Geiger climate classification", HESS 11:1633–1644: https://hess.copernicus.org/articles/11/1633/2007/
- Whittaker biome diagram digitised (plotbiomes R package): https://github.com/valentinitnelav/plotbiomes ; Zenodo release: https://zenodo.org/records/7145245
- Holdridge life zones (biotemperature, PET = 58.93·BT): https://en.wikipedia.org/wiki/Holdridge_life_zones
- Körner & Paulsen (2004), "A world-wide study of high altitude treeline temperatures", J. Biogeography 31:713–732: https://edoc.unibas.ch/8594 ; Körner, "Climatic treelines: conventions, global patterns, causes": https://www.erdkunde.uni-bonn.de/article/view/2594
- Ohmura, Kasser & Funk (1992), "Climate at the equilibrium line of glaciers", J. Glaciology 38(130): https://www.cambridge.org/core/journals/journal-of-glaciology/article/climate-at-the-equilibrium-line-of-glaciers/8DCF1C24E32A6781CC365853535CD16F
- Lapse rate and standard atmosphere: https://en.wikipedia.org/wiki/Lapse_rate ; general circulation (Hadley/Ferrel/polar cells, ITCZ, horse latitudes): https://en.wikipedia.org/wiki/Atmospheric_circulation
- Zhao (2005), "A fast sweeping method for Eikonal equations", Math. Comp. 74:603–627 (sweep-order idea reused for upwind advection): https://www.ams.org/journals/mcom/2005-74-250/S0025-5718-04-01678-3/
- Topographic wetness index (Beven & Kirkby): https://en.wikipedia.org/wiki/Topographic_wetness_index
- NASA Visible Earth, Blue Marble collection: https://visibleearth.nasa.gov/collection/1484/blue-marble
- Tom Patterson, Shaded Relief (world relief, articles): https://shadedrelief.com/world_relief/ , https://www.shadedrelief.com/articles.html ; cross-blended hypsometric tints: https://www.shadedrelief.com/hypso/hypso.html ; Patterson & Jenny (2011), Cartographic Perspectives 69: https://cartographicperspectives.org/index.php/journal/article/view/cp69-patterson-jenny
- Natural Earth data: https://www.naturalearthdata.com/
- Eduard Imhof, *Cartographic Relief Presentation* (1965; English ed. 1982, Esri Press reprint 2007): https://en.wikipedia.org/wiki/Eduard_Imhof
- Leland Brown, Texture Shading: http://www.textureshading.com/
- Robert Bridson (2007), "Fast Poisson Disk Sampling in Arbitrary Dimensions": https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph07-poissondisk.pdf
- Jarzynski & Olano (2020), "Hash Functions for GPU Rendering" (PCG3D): https://jcgt.org/published/0009/03/02/
