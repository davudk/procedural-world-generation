# 01 — Macro Terrain: Tectonics, Base Elevation, Landscape Evolution and Erosion

Scope: how the large-scale shape of the world is built. That covers plates and crust, base elevation and coastlines, the stream-power landscape-evolution model (LEM) at 512²–1024², GPU detail erosion at 2048²–4096², glacial carving, and special landform stamps. Hydrology (lakes, river vectors, creeks), climate and biomes are covered in other notes. This note only produces what they consume: elevation, drainage area, receivers and erodibility.

Units: metres and years everywhere unless stated. `Δx` is the cell size (2000 m on the 512² LEM grid for a 1024 km world).

---

## 0. Recommendation summary

1. **Tectonics decide where; erosion decides how it looks.** A cheap plate stage (jittered, noise-weighted Voronoi of 8–24 plates on a 256²–512² grid) produces three maps: an **uplift map `U`**, an **erodibility map `K`**, and an **initial elevation `h0`** (a crust-type profile plus boundary features). Do not hand-sculpt mountains with noise. Ridges come from the stream-power solver, so they always carry a valid dendritic drainage network. This is the Cordonnier 2016 / Schott 2023 recipe.
2. **LEM: the Braun & Willett (2013) implicit O(n) stream-power solver** on 512² (≈2 km). Use `m = 0.4`, `n = 1`, `K ≈ 1e-5 m^0.2/yr`, `U` up to 1–5 mm/yr and `Δt = 1e5–5e5 yr`, for 50–200 iterations. Each iteration does receivers → depression routing → stack → area → implicit incision → diffusion → talus clamp. Estimated 10–25 ms per iteration in a worker, so **2–5 s at 512²**. Refine with 20–40 more iterations at 1024².
3. **Sea level is a histogram quantile** taken before the LEM: `seaLevel = quantile(h0, 1 − landFraction)`. Ocean cells are then fixed base level. The solver keeps every land cell above its receiver, so the land fraction is preserved.
4. **Coastline character comes from domain-warped noise added to a signed-distance crust field** and from drowned topography near sea level, not from the plate polygons. Peninsulas and archipelagos come out of ridged noise along convergent margins, island arcs, hotspot chains and shelf islands.
5. **Noise is a garnish at every stage.** Use warped fBm for continents, ridged multifractal only as an *uplift modulator*, IQ derivative fBm for shader detail, and Worley for plates, crater fields and basalt-like cells.
6. **Detail on the GPU (WebGL2 fragment passes, RGBA32F ping-pong, `EXT_color_buffer_float`).** Start with a bicubic upsample of the macro field plus slope-scaled noise. Pre-carve the macro rivers, then run the Mei et al. 2007 pipe-model hydraulic erosion (100–300 steps) and thermal erosion (20–50 steps). Finally **re-anchor the low frequencies** to the macro field so the detail never drifts from it.
7. **Glaciers are a cheap rule, not a simulation.** Mark ice where `h > ELA(y)` along high-area flow paths, widen those valleys to a parabolic (U) cross-section, cut cirque bowls at their heads, and over-deepen them below sea level at the coast to make fjords. Cordonnier 2023 is the reference for the physics.
8. **Stamps for rare forms.** Craters (Pike-style profiles, `d/D ≈ 0.2` for simple craters, transition at ~3 km on Earth) and volcanoes/calderas are applied as stamps. Mesas, escarpments and inselbergs are **not** stamps: they are erodibility patterns (caprock layers `K(z)`, hard-rock patches) that the LEM turns into landforms.
9. **Determinism:** every stage gets `rng = sfc32(hash(seed, stageId, subId))`. The LEM is deterministic: integer tie-breaks, no `Math.random`, and a fixed order of float operations.
10. **Biggest pitfalls:** D8 grid-aligned rivers, noise that looks like noise ("everything is fBm"), ridges with no drainage logic, float32 precision in world-space noise at 4096 km, and every world looking the same. Section 8 lists each with its mitigation.

---

## 1. Tectonic plates on a flat, finite region

We are not simulating plate motion over time; Cortial et al. 2019 do that on spheres. We build a **snapshot**: plate geometry, motion vectors and boundary classes, then *derive* uplift and crust maps from them. A flat world has no wrap-around, so plates simply touch the region boundary.

### 1.1 Plate geometry

```
nPlates   = 8..24 (UI), seeds = Poisson-disk (Bridson) in the domain, plus 0..2 "microplates"
grid      = 256² or the 512² LEM grid
plateId   = noise-weighted flood fill (multi-source Dijkstra / priority queue):
            cost(cell) = 1 + a * (fbm(p*f) * 0.5 + 0.5)       a ≈ 2..4
            → irregular, non-convex plates; avoids straight Voronoi edges
plateType = continental with probability pc, else oceanic.
            Choose pc so that Σ area(continental) ≈ landFraction + shelfMargin (~+0.08)
            (greedy: sort plates randomly, mark continental until target reached)
```

Plain Voronoi gives straight boundaries and 120° triple junctions that read as "computer". Priority-queue growth with noisy costs, plus a final domain warp of the lookup (`plateId(p + warp(p))`), fixes both.

Option: give continental plates a separate **continent mask**. A continent can be smaller than its plate, leaving a passive margin and ocean on the same plate, as with the Atlantic margins. Use `crust(p) = smoothstep(-w, w, sdfContinent(p) + 40km·fbm(warp(p)))`.

### 1.2 Motion and boundary classification

Each plate gets rigid motion `v(p) = t + ω × (p − c)` (2D: `ω·perp(p − c)`), with `|t|` from 1 to 10 cm/yr and a small ω. For each boundary cell pair (a in plate A, b in plate B) with unit normal `n̂` pointing from A to B:

```
vr     = vB(p) − vA(p)                 // relative velocity of B seen from A
conv   = −dot(vr, n̂)                   // > 0 converging, < 0 diverging
shear  = |cross(vr, n̂)|
class  = |conv| > 0.5·shear ? (conv > 0 ? CONVERGENT : DIVERGENT) : TRANSFORM
```

Then, along each boundary, compute **distance fields** (two-pass chamfer or a jump-flood on the CPU grid) `dB` (distance to the nearest boundary) and `side` (which plate the cell is on), and store the boundary class and `conv` at the nearest boundary point. Smooth `conv` along the boundary (a 1D blur over ~5 cells) so a range's height varies smoothly instead of switching between Voronoi segments.

### 1.3 What each boundary produces

Widths and depths are Earth-typical orders of magnitude, used as defaults. Each feature is expressed as a contribution to **uplift `U`** (for things the LEM should erode into ranges) or to **`h0`** (for bathymetry and things the LEM should not touch).

| Boundary | Real example | Contribution (profile across `dB`) |
|---|---|---|
| Continent–continent convergent | Himalaya–Tibet | `U += U0·conv·bump(dB; w=150–400 km)` on both sides; optional plateau `U += 0.3·U0` 300–800 km behind the range on the overriding side |
| Ocean–continent convergent (subduction) | Andes, Cascades | Oceanic side: trench `h0 −= 3–5 km · gauss(dB; σ≈30 km)`, total depth ~−6 to −8 km. Continental side: cordillera `U += U0·bump(dB − 150 km; w=100–300 km)` plus a volcanic arc line of stamps (§6.2) ~150–300 km from the trench |
| Ocean–ocean convergent | Japan, Marianas, Aleutians | Older plate subducts (random tie-break): trench, plus a **chain** of volcanic island stamps 100–200 km behind it on the overriding plate. This is the main archipelago source |
| Divergent oceanic | Mid-Atlantic Ridge | Ridge depth `≈ −2.5 km`; flanks follow plate-cooling bathymetry `depth(t) ≈ 2500 + 350·√t` m (t in Myr; Parsons & Sclater 1977) with `t = dB / v_half`; abyssal plain clamps at −5 to −6 km |
| Divergent continental | East African Rift, Red Sea | Rift graben `h0 −= 1–2 km · box(dB; 30–60 km)` with uplifted shoulders `U += small·bump(dB − 50 km)`; wide/old rifts become narrow seas |
| Transform | San Andreas, Alpine Fault | Little relief: a narrow linear valley (`K ×3` in a 2–5 km strip, which the LEM excavates), offset ridges, small pressure ridges where the fault bends |
| Hotspot (not a boundary) | Hawaii–Emperor, Yellowstone | Point source fixed in the "mantle frame". A chain of N volcano stamps along `−v_plate`, with age `∝` distance. Older stamps are smaller and subsided (`h −= 0.3·√age`), so a seamount chain trails the active island |

`bump(x; w) = max(0, 1 − (x/w)²)²` is smooth and compact. Multiply every profile by `(1 + 0.4·ridged(p·f))` and warp `dB` with fBm, so ranges are segmented, en-echelon and of uneven height. The LEM later turns this blurred uplift into sharp ridges and valleys.

### 1.4 Crust profile, continental shelf and hypsometry

Earth hypsometry is bimodal: mean land ≈ +0.84 km, mean ocean floor ≈ −3.7 to −4 km, land ≈ 29 %. The ocean-side profile as a function of signed distance from the coast `s` (km, negative = seaward):

```
shelf      0 … −W_shelf        h = −130 m · (−s / W_shelf)^0.7        W_shelf = 20–200 km (avg ~80 km; passive wide, active narrow)
slope      next 30–80 km       h from −130 m to −3000 m (≈ 3–5°)
rise       next 100–300 km     −3000 → −4500 m (gentle concave)
abyssal    beyond              −4500 … −5500 m + 100 m·fbm (abyssal hills)
```

Land base: `h0_land = 200 m + 400 m·smoothstep(0, 300 km, s) + 300 m·fbm`. Old cratons are low and flat, with low `U` and low `K`. Active margins have narrow shelves (W_shelf ~ 10–30 km); passive margins have wide ones. Pick W_shelf from the boundary class of the nearest margin.

### 1.5 Target land fraction and sea level

```
h0 = crustProfile + boundaryBathymetry + noise         (before the LEM)
seaLevel = histogramQuantile(h0, 1 − landFraction)     // 4096-bin histogram, O(n), exact to bin width
h0 −= seaLevel                                         // sea level is 0 forever after
```

Re-apply the quantile once after adding stamps that create land (arcs, hotspots). Do not apply it after the LEM: erosion lowers land toward base level but never below 0, because a receiver is always lower and ocean cells are fixed. Erosion therefore cannot shrink the land fraction, except where diffusion or talus pulls coastal cells under. Clamp those to `≥ ε`.

### 1.6 Convincing coastlines, peninsulas and islands

Several sources of coastal character combine:

- **Domain-warped signed distance.** `coastField(p) = sdfCrust(p) + A·fbm(p + B·fbm2(p))`, with A ≈ 20–60 km and B ≈ 50–150 km. Warping (IQ, "domain warping") turns blobs into bays and capes. Adding a second, *ridged* fBm term only where `|sdf| < 100 km` makes long thin peninsulas (Italy, Baja).
- **Drowned topography.** Coastlines are where eroded relief meets sea level. Running the LEM with sea level fixed and then optionally raising sea level by 50–150 m ("post-glacial transgression") converts valleys into rias and estuaries, and isolated hills into islands. This one trick does more for realism than any coastline noise.
- **Archipelagos** come from island arcs, hotspot chains, continental fragments (microplates marked continental), and shelf islands (shelf cells where `h0 + 150 m·ridged > 0`).
- **Fjords** come from the glacial pass (§5) on high-latitude or high-ELA coasts.

---

## 2. Noise toolbox

| Noise | Formula sketch | Good for | Artifacts / cautions |
|---|---|---|---|
| **fBm** (gradient/simplex) | `Σ_i a^i · noise(2^i·p)`, a≈0.5, 6–10 octaves | Continents' mask, base relief, abyssal hills, rainfall perturbation | Isotropic "blobby" sameness; self-similar at every scale, so terrain has no characteristic scale. Value noise shows grid alignment; use gradient/simplex |
| **Ridged multifractal** (Musgrave) | `signal = (offset − |noise|)²; weight = clamp(signal·gain)`; next octave multiplied by weight | Uplift modulation, sharp crests at close zoom | Ridges are all connected in a honeycomb and never form a dendritic river network. They read as "noise mountains" when used as final heights. Use as **input to the LEM** or only at <1 km scale |
| **Domain warping** (IQ) | `f(p + k·fbm2(p + k2·fbm2(p)))` | Coastlines, plate boundaries, strata, breaking straight lines | Over-warp gives swirly "marble" look; keep k such that displacement < ~1/3 feature size |
| **Derivative ("erosion-like") fBm** (IQ, *morenoise*) | `d += ∇noise_i; h += a^i · n_i / (1 + dot(d,d))` | Shader-side detail amplification: steep slopes get less high-frequency detail, flats keep it. Cheap fake "erosion" streaks | Not hydrologically consistent: no rivers, only an aesthetic. Analytical derivatives also give normals for free |
| **Worley / cellular** | F1, F2−F1 distance to jittered points | Plate seeds, crater field placement, columnar basalt, dried-mud cracks, karst dolines | Obvious cells if F2−F1 is used directly at large scale; warp the input |
| **Billow** | `Σ a^i·|noise|` | Dunes, rolling hills | Creases at zero crossings |

Rules for this project:

1. Noise frequencies are given in **world km**, never cells, so presets from 512 to 4096 km look consistent.
2. Noise used before the LEM is low-amplitude. The LEM must own relief above ~2 km wavelengths.
3. In shaders, evaluate noise in tile-local coordinates (§8).

---

## 3. Landscape evolution: stream power, uplift, diffusion

### 3.1 Governing equation

```
∂h/∂t = U(x) − K(x) · A^m · S^n + K_d ∇²h          (h above sea level; ocean cells fixed at base level)
```

`A` is the upstream drainage area (m²), `S` is the slope to the receiver, `U` is uplift (m/yr), and `K` is erodibility in units of `m^(1−2m)/yr`. Concavity `m/n` lies in 0.35–0.6 in nature (Whipple & Tucker 1999; Lague 2014). With m/n = 0.5 exactly and no diffusion, steady state is invariant to horizontal stretching (Kwang & Parker 2017). Use **m = 0.4, n = 1**, the FastScape defaults.

**Steady state (n = 1):** `S = U / (K·A^m)`. This is the calibration formula. Back-of-envelope: take a range of half-width 75 km, Hack-like `A ≈ 0.3·s²` (s = distance from the divide), and integrate from the first resolved cell (s0 = 2 km):

```
z_divide = U/(0.618·K) · [s^0.2/0.2]_{2km}^{75km} ≈ 39·U/K
→ U = 1 mm/yr, K = 1e-5  ⇒  z ≈ 3.9 km relief.     K = 2e-5 ⇒ ~2 km;  U = 3 mm/yr, K = 1e-5 ⇒ ~12 km (too high: clamp U)
response time τ ≈ 39/K yr ≈ 3.9 Myr for K = 1e-5  ⇒ simulate ~3–5 τ ≈ 12–20 Myr
```

The UI therefore exposes **target peak height** and derives `U0 = target·K/39` (re-fit the constant for the actual grid), instead of exposing raw `U`.

### 3.2 Braun & Willett (2013) implicit O(n) solver

Every step is O(n) except depression handling.

```
for iter in 0..N:
  1. h[i] += U[i]·Δt                                    for land cells (ocean cells fixed)
  2. receivers: rcv[i] = argmax_j (h[i]−h[j])/dist(i,j) over 8 neighbours (D8), rcv[i]=i if none lower
  3. depressions: route local minima to an outlet (see 3.3) so every land cell drains to the ocean/boundary
  4. stack: donors = inverse of rcv; DFS from each base-level cell → stack[] ordered so every
            receiver precedes its donors (Braun & Willett "stack" ordering)
  5. area:  A[i] = cellArea·rain[i];  for k = n−1..0: i = stack[k]; if rcv[i]≠i: A[rcv[i]] += A[i]
  6. incision, implicit, in stack order (receivers already updated):
        n = 1:  F = K[i]·Δt·A[i]^m / L_i
                h[i] = (h[i] + F·h[rcv]) / (1 + F)
        n ≠ 1:  Newton on x: x − h_old + F·(x − h_rcv)^n = 0, F = K·Δt·A^m / L^n, 3–5 iterations
  7. hillslope diffusion: h += K_d·Δt·∇²h (explicit, sub-stepped; or ADI)
  8. talus clamp: for each cell, if (h[i]−h[j])/L > tanθmax, move half the excess (thermal, §4.3)
```

`L_i` is `Δx` or `√2·Δx`. The scheme reaches the correct **steady state for any Δt**, but transients depend on Δt (Landlab notes this, citing the paper's Appendix B). We only care about a plausible steady-ish state, so large steps (`Δt = 2e5–5e5 yr`) are fine. Very large `Δt` can still oscillate with n ≠ 1.

Data layout (all in the worker, allocated once):

```ts
h: Float32Array(N)    // elevation (Float64 not needed at 2 km cells; keep F32 for transfer)
U, K: Float32Array(N) // uplift (m/yr), erodibility
rcv: Int32Array(N)    // receiver index (self = base level / sink)
ndon: Uint8Array(N); donors: Int32Array(8N)   // or CSR: donorStart + donorList
stack: Int32Array(N); A: Float32Array(N); dist: Float32Array(N) (or Uint8 dir code + LUT)
flags: Uint8Array(N)  // OCEAN, BOUNDARY, LAKE, ICE
```

### 3.3 Depressions (local minima)

Noise and uplift create thousands of pits. The options, from simplest to best:

1. **Priority-Flood + ε** (Barnes et al. 2014) on a copy of `h`, used only to compute receivers: flood from ocean and boundary cells with a binary heap, raising each popped neighbour to `max(h, h_parent + ε)`. Cost is O(n log n), roughly 15–30 ms at 512² in JS with a typed-array heap. Simple and robust. Lakes become routed-through flats; the hydrology note re-detects them as lakes.
2. **Cordonnier, Bovy & Braun 2019** basin graph: label basins, find the minimum spanning tree of passes between them, and reroute each pit's outflow through the pass. This is linear time, avoids modifying `h`, and is the method of choice for LEMs (fastscapelib uses it).

Start with (1) for simplicity. Move to (2) if profiling shows the heap dominating.

### 3.4 Hillslope diffusion and its scale problem

Physical `K_d ≈ 1e-3 – 1e-2 m²/yr` has **no visible effect** at Δx = 2 km: the diffusive timescale `Δx²/K_d ≈ 4e8–4e9 yr`. At this resolution, hillslopes are sub-grid. Use an **effective** `K_d_eff ≈ 0.5–5 m²/yr` purely to suppress single-cell spikes and to round divides slightly. The explicit stability limit `Δt ≤ Δx²/(4K_d)` is ≥ 2e5 yr at `K_d = 5`, so one or two substeps suffice. Too much diffusion makes ranges look melted.

### 3.5 Recommended parameters and budgets

| Parameter | Default | Range (UI) |
|---|---|---|
| m, n | 0.4, 1.0 | m 0.3–0.6, n 0.7–1.5 (n ≠ 1 costs ~2–3× for Newton) |
| K (bedrock) | 1e-5 | 2e-6 – 5e-5, multiplied by the lithology map 0.1–5× |
| U max | derived from target peak height (3–7 km) | 0.1–5 mm/yr |
| Δt | 2.5e5 yr | 1e5–1e6 |
| iterations | 80 at 512² (~20 Myr) + 30 at 1024² | 20–300 |
| K_d_eff | 1 m²/yr | 0–10 |
| tan θ max (talus, 2 km grid) | 0.5 | 0.3–0.8 |
| rain weighting of A | from coarse climate pre-pass or 1 | — |

**Timing estimate** (JS, typed arrays, one worker, M-series class CPU; to be benchmarked). Per iteration at 512² (262k cells): receivers ~2 ms, Priority-Flood ~15–25 ms, stack+area ~3 ms, incision ~1 ms, diffusion ~1 ms. That is **~20–30 ms per iteration, so 80 iterations ≈ 2–2.5 s**. At 1024² everything costs ×4–4.5, giving ~100 ms per iteration and 30 iterations ≈ 3 s. A 256² preview takes about 0.15 s for 80 iterations and can drive live slider feedback.

Coarse-to-fine: run to near steady state at 256²/512², upsample (bicubic + small warped noise), and run 20–40 iterations at 1024². Most of the convergence time is spent on the long wavelengths, and the coarse grid gets those for a fraction of the cost.

Faster alternatives to know about:
- **Schott et al. 2023** compute drainage area and stream power *approximately on the GPU*, using local fixed-point iterations instead of a global stack. They reach interactive rates on large grids, and their code is public. The method is worth porting to WebGL2 fragment passes later if the worker LEM becomes the bottleneck. It needs many iterations (hundreds to thousands), but each one is a cheap full-screen pass.
- **Tzathas et al. 2024** derive analytical stream-power solutions where time is a parameter. This enables a "time slider" without re-simulating.

### 3.6 Erodibility map: lithology does the landform work

```
K(x,y,z) = K0 · lith(x,y) · strata(z)
lith:   craton 0.5, fold belt 1.0, volcanic arc 0.7, sedimentary basin 2.0, fault strip 3.0, hard intrusions 0.1–0.3
strata: for tabular regions, K multiplier alternating per layer of thickness T(x,y) ≈ 50–300 m:
        strata(z) = hard if fract((z + warp)/T) < capFraction else soft (ratio 1:5–1:10)
```

Erodibility patterns produce mesas, buttes, escarpments, cuestas (tilted strata), hogbacks and inselbergs naturally, with consistent drainage (§6). Note that at 2 km cells this mainly gives plateau edges and escarpments; buttes and mesas appear at the 1024² stage and in the GPU detail stage, which uses the same `strata(z)` function.

---

## 4. High-resolution detail on the GPU

Input: the 1024² macro `h`, `A`, river vectors (from hydrology), `K` and strata. Output: a 2048²–4096² detail heightmap (RGBA32F, ~64–256 MB at 4096² × 4 channels × 4 B per buffer; R32F where possible).

### 4.1 Upsample and seed

```
h_up   = bicubic(h_macro)                                    // C1, no bilinear creases
detail = amp(slope, A) · fbmDeriv(p)                          // amplitude ∝ local relief, ≈ 0 on floodplains
h0_det = h_up + detail
carve rivers: for each river polyline (width w(A), depth d(A) ~ A^0.3–0.4):
         h = min(h, h_bed(s) + bankProfile(dist/w))           // guarantees river cells are downhill
```

Pre-carving prevents the detail erosion from inventing a river network that disagrees with the macro rivers, which hydrology, biomes and labels depend on.

### 4.2 Pipe-model hydraulic erosion (Mei, Decaudin & Hu 2007; Šťava et al. 2008)

State per cell: `b` (terrain), `d` (water), `s` (suspended sediment), flux `f = (fL, fR, fT, fB)`, velocity `v`. Steps per iteration, each one full-screen fragment pass:

```
1 rain:      d += Δt · r(x)               (r biased by macro A / rainfall map; or sources at river heads)
2 flux:      Δh_L = (b+d) − (b_L+d_L);  fL' = max(0, fL + Δt·A_pipe·g·Δh_L / l)    (×4)
             scale = min(1, d·lx·ly / ((fL'+fR'+fT'+fB')·Δt));  f' *= scale
3 water:     ΔV = Δt·(Σ f_in − Σ f_out);  d' = d + ΔV/(lx·ly)
             v.x = (fR_in(L) − fL + fR − fL_in(R)) / (2·lx·d̄)   (analogously v.y), d̄ = (d+d')/2
4 erode/dep: C = Kc · max(sinα, αmin) · |v| · limit(d)          (capacity)
             if C > s:  b −= Ks·(C − s)·Δt; s += Ks·(C − s)·Δt   else: b += Kd·(s − C)·Δt; s −= ...
             Ks multiplied by the same K(x,y,z) lithology/strata map → caprock benches at detail scale
5 advect:    s'(x) = s(x − v·Δt)            (semi-Lagrangian, bilinear fetch)
6 evaporate: d *= (1 − Ke·Δt)
```

Textures: `T0 = RGBA32F(b, d, s, hardness)` and `T1 = RGBA32F(fL, fR, fT, fB)`, both ping-ponged, plus `T2 = RG32F(v)`. Rendering to float targets needs `EXT_color_buffer_float`, which is ubiquitous on desktop WebGL2. Linear filtering of float textures needs `OES_texture_float_linear` (missing on some mobile GPUs), so do manual bilinear in the shader. Cost at 4096²: about 4 passes × 16.7 M fragments per step. Roughly 2–5 ms per step on an M-series iGPU, so 200 steps take about 0.5–1 s. **Run in tiles of 1024²** with overlap for memory and responsiveness, or erode only the visible high-zoom region on demand.

Starting constants, tuned in grid units with `lx = ly = 1`: `Δt = 0.02`, `A_pipe·g/l = 20`, `Kc = 0.05–0.1`, `Ks = 0.3`, `Kd = 0.1`, `Ke = 0.015`, `αmin = 0.05`. Šťava 2008 extends the model with multiple material layers (soil over rock), which fits the strata map.

### 4.3 Thermal (talus) erosion

```
T = tan(θ_repose)·l        θ ≈ 30–35° for scree;   at 250 m cells → T ≈ 150 m
pass 1 (scatter as outflow): for 8 neighbours: Δ_j = h − h_j; out_j = Δ_j > T ? c·(Δ_j − T) : 0
                             normalise so Σ out ≤ (max Δ − T)/2; store 8 outflows in 2 RGBA textures
pass 2 (gather):             h' = h − Σ out_j + Σ in_j  (in_j = neighbour's outflow toward me)
```

The two-pass gather form is required because fragment shaders cannot scatter. Use `c ≈ 0.5` and 20–50 iterations interleaved with hydraulic steps. Jákó & Tóth 2011 integrate both erosions on the GPU.

### 4.4 Particle (droplet) erosion

Droplets follow the bilinear gradient with inertia, erode under capacity and deposit over it (Beyer 2015 thesis; Sebastian Lague's widely ported implementation). Typical constants are inertia 0.05, capacity 4, minSlope 0.01, erode/deposit 0.3, evaporate 0.01, lifetime 30, brush radius 3. They give the best-looking **gullies and creek detail**, but the work is inherently serial and scatter-writes. WebGL2 has no compute shaders or atomics, so on the GPU it needs transform-feedback tricks. Use droplets **on the CPU in a worker for single 512²–1024² close-zoom tiles** (≈200k droplets × 30 steps ≈ 6M steps, ~0.3–0.6 s per tile). Use the pipe model for the full detail map.

### 4.5 Conforming the detail to the macro result

Detail erosion drifts: valleys deepen and sediment fans spill. After every K steps, and at the end, apply **low-frequency re-anchoring**:

```
Δ    = h_det − h_up
h_det = h_up + (Δ − blur(Δ, σ ≈ 2 macro cells)) + clamp(blur(Δ, σ), −a, +a)    a ≈ 30–100 m
```

High frequencies (gullies, benches) survive, and the macro shape is preserved within ±a. Two further rules: keep **ocean cells and pre-carved river beds** as Dirichlet constraints (`b = min(b, b_carved)`), and add water sources at macro river heads so the pipe model reinforces the macro channels instead of competing with them.

### 4.6 Amplification for close zoom (10–20 m/px)

At 4096² over 1024 km, cells are 250 m. Below that, the shader adds detail:

- **IQ derivative fBm** in the vertex/fragment shader, with amplitude `∝ macro roughness map` (local std-dev of h) and multiplied by `smoothstep` of the distance to rivers, lakes and the coast, so beds and beaches stay flat. Also scale with a slope term: steep slopes get ridged, flats get billow or nothing.
- **Literature:** Guérin et al. 2016 (*Sparse representation of terrains*, a dictionary of landform atoms used for amplification). Guérin et al. 2017 (conditional GAN terrain authoring). Schott et al. 2024 (*Terrain amplification using multi-scale erosion*) is the most relevant: it amplifies a coarse terrain with erosion applied across scales. Learned dictionaries and GANs are out of scope; the *principle* "amplify consistently with drainage" is what we copy, by keeping noise out of channels.

---

## 5. Glacial carving (cheap approximation)

The reference physics is Cordonnier et al. 2023, *Forming Terrains by Glacial Erosion*: ice flow uses a learned approximation of shallow-ice dynamics, erosion rate is `E = K_g·|u_b|^l` (sliding speed), and the method produces U-valleys, hanging valleys, cirques and fjords. That is too heavy for us. Approximate it after the LEM at 1024²:

```
ELA(y)        = ELA0 − lapse·latitudeFactor(y)              // equilibrium-line altitude, e.g. 2500 m → 300 m poleward
iceSource     = cells with h > ELA and A_ice > A_min
iceFlux Q     = accumulate (h − ELA)+ · cellArea along the LEM receivers (reuse stack), stop where h < ELA − meltDepth
valley width  W = c_w · Q^0.4   (2–10 km);  depth gain D = c_d · Q^0.3 (100–800 m)
for each glaciated channel cell c: for cells within W (distance transform from the glaciated channel):
    target = h_channel(c) − D + (D + extra) · (dist/W)²       // parabolic U cross-section
    h = min(h, target)                                       // only remove material
cirques:      at each glaciated channel head: bowl stamp radius 1–3 km, flat floor + steep headwall (pow 3 profile), optional tarn
hanging valleys: tributary glaciers get smaller D, so they end above the trunk floor (falls in hydrology)
fjords:       glaciated channel reaching the coast keeps D ≥ 300–1200 m below sea level for 20–200 km inland;
              add a shallow sill (−50 to −150 m) at the mouth. Re-flag those cells OCEAN.
```

Real-world anchor: Sognefjord reaches ~1300 m depth. Glaciated mountain ranges get sharper arêtes "for free", because the U-valleys widen into the ridges. Afterwards, re-run 5–10 LEM iterations with small Δt to re-establish drainage (fluvial V-notches in U-valley floors are realistic).

---

## 6. Special landforms

### 6.1 Impact craters

Morphology: **simple** bowl-shaped craters below the transition diameter `D_t`, **complex** craters (flat floor, central peak, terraced walls) above it, and peak-ring basins at much larger sizes. On Earth, `D_t` is classically 2 km in sedimentary and 4 km in crystalline targets (Dence 1972). A 2022 Impact Earth database review puts it at ≈3 km for both. On the Moon it is ≈10–20 km.

Fresh-crater geometry: simple craters have rim-to-floor depth `d ≈ 0.2·D` (Pike 1977) and rim height `h_r ≈ 0.036·D` (lunar fit). Complex craters are proportionally much shallower: lunar fit `d ≈ 1.044·D^0.301` km (D in km), so a 50 km crater is ~3.3 km deep, `d/D ≈ 0.07`. Earth craters erode and fill quickly. Meteor Crater has D ≈ 1.2 km and is ~170 m deep today.

Radial profile (r normalised `x = r/R`, `R = D/2`), added to the existing terrain as a delta:

```
simple:   x ≤ 1:  Δh = −d + (d + h_r)·x²                           (parabolic bowl)
complex:  x ≤ xf (xf ≈ 0.4–0.6):  Δh = −d                         (flat floor)
          central peak x ≤ xp (xp ≈ 0.15):  Δh += hp·(1 − (x/xp)²)², hp ≈ 0.3–0.5·d  (artistic; peak below rim)
          xf < x ≤ 1: wall from −d to h_r with 3–5 terraces: stepped smoothstep
ejecta:   x > 1:      Δh = h_r · x^(−3)  (cut off at x ≈ 3–5)       // thickness ∝ (r/R)^−3 (McGetchin et al. 1973)
noise:    multiply rim and ejecta by (1 + 0.3·fbm(angle·k, x)) to break circular symmetry
```

Degradation by age `a ∈ [0,1]`: scale Δh by `(1 − 0.7a)`, blur by `σ = a·0.2R`, and then let the LEM/diffusion/hydrology act on it. Old craters show up as circular lakes (Manicouagan ring lake, D ≈ 85 km) or arcs of hills. Rarity: Earth has ~200 confirmed structures on its whole surface. For a 1024² km world, expose `craterCount 0–5` (default 1) with a power-law size distribution `N(>D) ∝ D^−2`, D from 1 to 100 km. Place craters before the final LEM refinement if they should be eroded, and after it if they should be fresh.

### 6.2 Volcanoes and calderas

```
stratovolcano: H 1.5–3 km above base, base radius R 8–20 km; profile h = H·(1 − x)^1.5 · (1 + 0.1·ridged(angle))  (concave, ~30° near summit)
shield:        H 1–4 km (oceanic up to ~9 km from sea floor), R 30–100 km; h = H·(1 − x²)^1.5 (slopes 2–10°)
caldera:       at summit: subtract flat-floored disk, radius 1–10 km (supervolcanoes up to ~30 km), walls 200–1000 m, pow-4 wall profile
cinder cones:  scatter 0.1–0.3 km cones on volcanic fields (Worley points)
seamount/guyot: hotspot stamps below sea level; old ones flat-topped (truncate at −50 m then subside)
```

Volcanoes go into `h` before the final LEM iterations, flagged with low `K` (0.3–0.7) so they keep their shape but get radial gullies. Caldera floors are closed basins; hydrology will make crater lakes.

### 6.3 Rift valleys, plateaus, escarpments, mesas, inselbergs

| Landform | Mechanism (preferred) | Notes |
|---|---|---|
| Rift valley | Tectonic `h0` graben + shoulder uplift (§1.3) | Floor below surroundings by 1–2 km, chained lakes along the axis (Great Rift lakes). Hydrology finds them |
| Plateau | Uniform `U` block with sharp edge, low `K` interior, no internal drainage outlet initially | Escarpment retreats from the edge as the LEM runs; the fastscapelib escarpment example shows this |
| Escarpment | Plateau edge, or a strata contrast (hard cap over soft) | Retreat rate ∝ K_soft; parallel retreat looks right only with a strata cap |
| Mesas / buttes | `strata(z)` hard caps (§3.6) at 1024² and in the GPU detail stage | Optional terracing in the detail shader: `h' = T·(floor(h/T) + smoothstep(0, s, fract(h/T)))` applied only where the strata mask is set. Pure terracing everywhere looks like rice paddies |
| Inselbergs | Hard-rock patches (`K ×0.1–0.2`, Worley/warped blobs 2–10 km) in a low-relief, high-K plain | The plain erodes down; the patches stay as isolated domes. Add exfoliation-dome profile at detail |
| Ravines / gorges | Emerge from high U plus low K, or strata, at the river carve; detail droplets deepen them | Gorge width is clamped by the detail river carve function |

---

## 7. Recommended pipeline for this project

### 7.1 Ordered stages (worker unless marked GPU)

| # | Stage | Grid | Output | Budget |
|---|---|---|---|---|
| S0 | Params, seeds, world scale | — | `cfg`, per-stage RNG | — |
| S1 | Plates: growth, types, motion, boundaries, distance fields | 256² | `plateId`, `boundaryClass`, `dB`, `conv` | <100 ms |
| S2 | Crust + bathymetry + boundary features + noise → `h0`; `U`, `K` maps; sea level by histogram | 512² | `h0`, `U`, `K` | <100 ms |
| S3 | Pre-LEM stamps: hotspot chains, arcs, plateau blocks, inselberg patches, optional old craters | 512² | updated `h0/U/K` | <50 ms |
| S4 | LEM: 80 iterations (uplift + SPL + diffusion + talus) | 512² | `h`, `A`, `rcv` | 2–3 s |
| S5 | Upsample + 30 LEM refinement iterations (+ strata) | 1024² | macro `h`, `A`, `rcv` → hydrology/climate notes | ~3 s |
| S6 | Glacial pass + fjords + 5–10 LEM repair iterations | 1024² | `h`, `ICE` flags | <1 s |
| S7 | Post stamps: fresh craters, calderas, cinder fields | 1024² | `h` | <50 ms |
| S8 | GPU detail: upsample, amplify, carve rivers, pipe + thermal erosion, re-anchor (tiled) | 2048²–4096² | detail height texture | 0.5–2 s |
| S9 | Shader amplification at close zoom | per-frame | — | <2 ms/frame |

Total: **≈ 7–10 s** for the default world. A **"preview" mode** runs S1–S4 at 256² with 60 iterations (<0.5 s) on every slider change, and a **"build" mode** runs everything. Stream progress from the worker after each stage so the renderer can show S4's intermediate heights. Watching the mountains erode is also good UX.

### 7.2 Data contracts

All grids are row-major `Float32Array`/`Int32Array`/`Uint8Array` posted as Transferables. Each stage keeps a `{width, height, cellSize, originKm}` header. Heights are in metres relative to sea level. `A` is in m², so it stays meaningful across grid resolutions. Receivers are stored as a `Uint8` direction code (0–7, 255 = sink) for transfer and expanded to `Int32` internally.

### 7.3 Config UI (lil-gui folders)

- **World:** size preset (512/1024/2048/4096 km), seed, land fraction (0.1–0.7, default 0.32), sea-level rise post-LEM (0–200 m).
- **Tectonics:** plate count, continental share bias, plate speed scale, boundary noise/warp, mountain width, plateau toggle, hotspot count, island-arc density, rift strength.
- **Erosion (macro):** target peak height (2–8 km), K, m, n (advanced), iterations, Δt, diffusion, talus angle, lithology contrast, strata (thickness, hard/soft ratio, region share).
- **Glaciers:** ELA at equator/pole edge, glacier strength, fjords on/off.
- **Features:** crater count/size/age, volcano count, inselberg density, mesa regions.
- **Detail (GPU):** resolution (2048/4096), hydraulic steps, thermal steps, rain, sediment capacity, re-anchor tolerance, amplification amount.
- **Debug views:** plate id, boundary class, U, K, drainage area (log), slope, receivers, ice.

### 7.4 Determinism

- `rngFor(stage, sub) = sfc32(murmur3(seed ⊕ stageId·0x9E3779B9 ⊕ sub))`. Changing the crater count must not move the plates.
- Never iterate over `Map`/`Set` for anything that consumes randomness. Use fixed array orders.
- D8 ties: compare `(slope, then lower index)` explicitly. Float32 vs Float64 matters too: do the LEM math in Float64 locals and store Float32, identically on every machine. JS numbers are IEEE doubles, so this is bit-identical across browsers. Avoid `Math.pow` differences by using `Math.exp(m·Math.log(A))`. Both functions are implementation-defined in the last ulp, so for strict cross-browser identity precompute `A^m` via a lookup table or accept ulp-level differences.
- GPU stages are *not* bit-reproducible across GPUs. Treat S8 output as a cache that is never saved as world truth, and save `seed + cfg` instead.

---

## 8. Pitfalls and mitigations

| Pitfall | Symptom | Mitigation |
|---|---|---|
| **D8 grid bias** | Rivers run at 0°/45°/90°; parallel straight valleys | Jitter the uplift with low-amplitude noise (10–50 m) each iteration. Use **stochastic receivers** in early iterations (pick among downslope neighbours with p ∝ slope^4), then deterministic D8 for the final 20. Upsample with warped bicubic. For hydrology use MFD for area display. Alternatively run the LEM on a jittered Delaunay/Voronoi mesh as mapgen4 and Cordonnier 2016 do (more complex; keep as fallback) |
| **Ridges look like noise** | Honeycomb ridged-multifractal crests without drainage logic | Ridged noise only modulates `U`; the LEM makes the ridges. Check by viewing the drainage-area map: it must be dendritic |
| **Everything looks the same** | Every seed is "blobby continent + fBm mountains" | Variety comes from *structure*: plate count, crust share, boundary classes, lithology/strata regions, glaciation, sea-level rise, crater ages. Add **world archetype presets** (Pangaea, archipelago, rift continent, glaciated north, old eroded craton) that move many sliders at once |
| **Melted look** | Over-diffused ranges, round ridges | K_d_eff ≤ 1–2; diffusion off in the last 10 iterations; detail stage adds sharpness |
| **Over-tall or spiky peaks** | Uplift too high relative to K; single-cell spikes on divides | Derive U from target height (§3.1); talus clamp; cap U |
| **Flat, featureless lowlands** | Sedimentary plains with no texture | Floodplain noise at low amplitude, meander-belt texture from hydrology, inselbergs, dunes in arid biomes |
| **Coastline from plate polygons** | Straight coast segments following Voronoi edges | Warped crust SDF (§1.6), drowned topography, post-LEM sea-level rise |
| **Square world edges** | Mountains or rivers obviously truncated at the boundary | Treat the boundary as ocean (fade crust to abyssal within ~5–10 % of the size) by default. Option "continental edge" makes the boundary base level at 0 m, so rivers drain off-map |
| **Float32 in shaders at 4096 km** | Shimmering, blocky high-frequency noise at close zoom (world coords ~4e6 m → ulp 0.25–0.5 m; hashes of large coords break) | Evaluate noise on `(tileIndex, localFrac)` or camera-relative coordinates; split coordinates into integer cell + fraction before hashing |
| **Detail drifts from macro** | Detail rivers disagree with macro rivers/labels | Pre-carve rivers, Dirichlet constraints, low-frequency re-anchoring (§4.5) |
| **Pipe-model artefacts** | Checkerboard water, oscillations, "sand dune" ripples | Smaller Δt, min-tilt `αmin`, clamp the capacity with a depth limiter, add a little thermal erosion |
| **Lakes eaten by the LEM** | Pits filled → no lakes | Expected; lakes are a hydrology product computed from the filled vs unfilled difference on the final surface (see the hydrology note) |
| **Worker memory** | 4096² × several Float32 ≈ 64 MB each | Keep the 4096² data on the GPU only; worker grids ≤ 1024² |

---

## 9. Sources

- Braun, J. & Willett, S. D. (2013). *A very efficient O(n), implicit and parallel method to solve the stream power equation governing fluvial incision and landscape evolution.* Geomorphology 180–181, 170–179. doi:10.1016/j.geomorph.2012.10.008. Implementation notes: https://landlab.readthedocs.io/en/latest/reference/components/stream_power.html
- Cordonnier, G. et al. (2016). *Large Scale Terrain Generation from Tectonic Uplift and Fluvial Erosion.* CGF 35(2), Eurographics. https://diglib.eg.org/handle/10.1111/cgf12820 · https://hal.archives-ouvertes.fr/hal-01262376
- Cordonnier, G., Bovy, B. & Braun, J. (2019). *A versatile, linear complexity algorithm for flow routing in topographies with depressions.* Earth Surf. Dynam. 7, 549–562. https://esurf.copernicus.org/articles/7/549/2019/
- Schott, H., Paris, A., Fournier, L., Guérin, E. & Galin, E. (2023). *Large-scale Terrain Authoring through Interactive Erosion Simulation.* ACM TOG. doi:10.1145/3592787. Code: https://github.com/H-Schott/StreamPowerErosion
- Schott, H. et al. (2024). *Terrain Amplification using Multi-scale Erosion.* ACM TOG (SIGGRAPH 2024). https://research.adobe.com/publication/terrain-amplification-using-multi-scale-erosion
- Tzathas, P., Gailleton, B., Steer, P. & Cordonnier, G. (2024). *Physically-based Analytical Erosion for fast Terrain Generation.* CGF 43(2). https://diglib.eg.org/handle/10.1111/cgf15033
- Cordonnier, G. et al. (2023). *Forming Terrains by Glacial Erosion.* ACM TOG 42(4), art. 61. doi:10.1145/3592422. https://people.cs.uct.ac.za/~jgain/wp-content/papercite-data/pdf/cordonnier2023.pdf
- Cortial, Y., Peytavie, A., Galin, E. & Guérin, E. (2019). *Procedural Tectonic Planets.* CGF 38(2), 1–11. https://diglib.eg.org/handle/10.1111/cgf13614
- Guérin, E., Digne, J., Galin, E. & Peytavie, A. (2016). *Sparse Representation of Terrains for Procedural Modeling.* CGF 35(2). https://diglib.eg.org/handle/10.1111/cgf12821
- Mei, X., Decaudin, P. & Hu, B.-G. (2007). *Fast Hydraulic Erosion Simulation and Visualization on GPU.* Pacific Graphics, 47–56. https://hgpu.org/?p=2256
- Šťava, O., Beneš, B., Brisbin, M. & Křivánek, J. (2008). *Interactive Terrain Modeling Using Hydraulic Erosion.* SCA. https://www.cs.purdue.edu/cgvlab/www/resources/papers/Stava-2008-Interactive_Terrain_Modeling_Using_Hydraulic_Erosion.pdf
- Jákó, B. & Tóth, B. (2011). *Fast Hydraulic and Thermal Erosion on GPU.* Eurographics short papers. https://diglib.eg.org/handle/10.2312/EG2011.short.057-060
- Barnes, R., Lehman, C. & Mulla, D. (2014). *Priority-Flood: An Optimal Depression-Filling and Watershed-Labeling Algorithm for DEMs.* Computers & Geosciences 62, 117–127. https://arxiv.org/abs/1511.04463
- Kwang, J. S. & Parker, G. (2017). *Landscape evolution models using the stream power incision model show unrealistic behavior when m/n equals 0.5.* Earth Surf. Dynam. 5, 807–820. https://esurf.copernicus.org/articles/5/807/2017/
- Fastscape / fastscapelib docs (default `area_exp = 0.4`, `slope_exp = 1`, example `k_coef 1e-4–2e-4`, diffusion 0.01): https://fastscape.readthedocs.io/en/latest/models.html · https://fastscapelib.readthedocs.io/en/latest/examples/escarpment_py.html
- Inigo Quilez: *Value noise derivatives* https://iquilezles.org/articles/morenoise · *Domain warping* https://iquilezles.org/articles/warp · *fBm* https://iquilezles.org/articles/fbm
- Red Blob Games, *mapgen4* (Voronoi mesh, painted elevation, rivers): https://www.redblobgames.com/maps/mapgen4/ · *Elevation from rivers* experiment: https://www.redblobgames.com/x/1724-elevation-from-rivers
- Sebastian Lague, *Hydraulic-Erosion* (droplet model, MIT): https://github.com/SebLague/Hydraulic-Erosion
- Parsons, B. & Sclater, J. G. (1977). *An analysis of the variation of ocean floor bathymetry and heat flow with age.* JGR 82(5), 803–827.
- Pike, R. J. (1977). *Size-dependence in the shape of fresh impact craters on the Moon.* In Impact and Explosion Cratering. Simple/complex values as summarised in Melosh & Ivanov (1999): https://sseh.uchicago.edu/doc/Melosh_Ivanov_1999.pdf and the IMPACTS program paper: https://arxiv.org/pdf/2203.07476
- Earth simple–complex transition (2 km / 4 km, Dence 1972; ≈3 km revised): https://craterexplorer.ca/crater-classification/ · https://impact.uwo.ca/wp-content/uploads/uwo_earth_science_reviews_232_2022_104112.pdf
- McGetchin, T. R., Settle, M. & Head, J. W. (1973). *Radial thickness variation in impact crater ejecta.* EPSL 20, 226–236. (Ejecta thickness ∝ (r/R)^−3.)
