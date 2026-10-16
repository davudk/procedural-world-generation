# 02 — Hydrology: Drainage, Rivers, Creeks, Lakes, Wetlands, Deltas, Waterfalls

Scope: everything that water does on the generated terrain after the landscape-evolution step (note 01) and the climate step. That covers depressions and lakes, flow routing and discharge, river network extraction and ordering, river geometry (width, meanders, carving), sources and mouths, lake types, wetlands, close-zoom creeks, the data handed to the renderer, and a concrete pipeline for this project.

Grid conventions used below:

| Layer | Size | Cell size at the 1024 km default |
|---|---|---|
| LEM grid | 512² | 2 km |
| Hydrology/climate grid `H` | 1024² | 1 km, so 1 cell = 1 km² |
| Detail heightmap `D` | 4096², built on the GPU | 250 m |
| Close zoom | — | 10–20 m/px |

Units: elevation `z` in m, drainage area `A` in km², discharge `Q` in m³/s (mean annual), precipitation `P` and evaporation `E` in mm/yr.

---

## 0. Recommendation summary

1. **Depressions: one Priority-Flood pass (Barnes 2014, pit-queue variant) on the 1024² grid.** It produces the filled surface, the per-cell flow receiver (the flood order is itself a drainage tree toward the outlets), the depression labels and the spill points. Then build a light **depression hierarchy** (Barnes 2020) and walk it leaves-first with a **water balance**. Each basin becomes one of: a through-flowing lake, a terminal (endorheic) lake at its equilibrium level, a playa/salt flat, or a breached artefact. Never ship a bare epsilon-filled DEM.
2. **Routing: D8 receivers on a *jittered-node* grid, with random tie-breaking.** The topology stays a regular 8-neighbour grid, but each node gets a fixed sub-cell offset. That removes the 0/45/90° look while keeping typed arrays. Accumulate precipitation-weighted runoff in O(n) using the Braun–Willett stack order. Use MFD only for wetness and hillslope fields, never for the river graph.
3. **The river graph is vector data, the single source of truth.** Extract polylines for cells with `A ≥ 1 km²`. Store discharge, Strahler order, Shreve magnitude, width (`w = a·Q^0.5`) and depth (`d = c·Q^0.4`) per node. Elevation along every path is **non-increasing by construction**: smoothing and meandering change only (x, y), and z is re-imposed afterwards by running minimum.
4. **LOD by drainage area, not order.** A reach is drawn when `A ≥ A_vis(zoom) = (k · px_spacing · metres_per_pixel)²`. That gives ~1000 km² rivers at whole-world view, 1 km² at ~30 m/px, and sub-cell creeks below that.
5. **Creeks below 1 km² come from deterministic per-macro-cell tributary growth**, keyed by `(seed, cellId)` and not by render tile. They are always consistent with the macro network and identical across tiles.
6. **Carving is a `min()` operation on the GPU detail heightmap.** It applies the river bed, a valley profile and a lake-bed clamp. Detail noise can then never dam a river or make water climb. Waterfalls are flagged where the bed slope over one channel width exceeds a threshold. Canyons come from the LEM, with a terrace profile on plateaus.
7. **Lakes:** the macro grid only resolves lakes of about ≥ 2 km². Kettles, tarns, oxbows and ponds are **placed procedurally** at detail level using a Pareto size law (cumulative exponent ≈ 1). The target is ~1.8 % lake cover on average, with glaciated regions ×3–10 and deserts ×0.1.
8. **Wetlands from TWI = ln(a / tan β)** on the 1 km grid. Use a per-climate percentile threshold and classify marsh, swamp, bog or fen by temperature and wetness.
9. **Deltas, estuaries, rias and inland deltas** are handled as a small *distributary* extension of the graph at the mouth. Style comes from discharge versus wave and tide energy (Galloway 1975). Rias come for free from an optional post-carve sea-level rise.
10. **Budget for the 1024² hydrology pass in a worker: about 0.3–0.6 s.** Invariant tests guard every step (§10.3).

---

## 1. Depression handling

### 1.1 Priority-Flood (Barnes, Lehman & Mulla 2014)

Seed a min-priority queue with all edge cells: ocean cells plus the map border, and the border acts as ocean. Pop the lowest cell and push its unvisited neighbours with `z' = max(z, z_popped)`. A neighbour that is *lower* than the popped cell lies inside a depression. The **pit-queue** improvement (Alg. 4 in the paper) sends such neighbours to a plain FIFO queue instead of the heap. Most interior cells therefore skip the O(log n) heap. The algorithm is O(n) on integer data and O(n log n) on floats.

```ts
// H: Float32Array heights (m), N = W*H. Outputs: fill (lake surface or terrain), rcv (receiver), label
priorityFlood(z, isOcean):
  fill = z.slice(); rcv.fill(-1); closed.fill(0)
  heap = new MinHeap(keys: Float32 fill, tie: Uint32 rnd(seed,i))   // random tie-break, see §2.3
  pit  = new IntFIFO()
  for i in border ∪ ocean: heap.push(i); closed[i]=1; rcv[i]=i      // outlets are their own receiver
  while heap or pit nonempty:
    c = pit.nonempty ? pit.pop() : heap.pop()
    for n in N8(c) where !closed[n]:
      closed[n]=1; rcv[n]=c                       // ← drainage tree toward outlets, for free
      if z[n] <= fill[c]: fill[n]=fill[c]; pit.push(n)   // inside a depression: flat water surface
      else:               heap.push(n)
```

Key points:

- **`rcv[n] = c` records the cell that discovered `n`.** It is a valid receiver tree: every cell drains, and depressions drain toward their spill point. The same trick is used in landscape-evolution codes. Outside depressions this "flood-order receiver" is close to, but not identical to, steepest descent. Recompute steepest-descent D8 on the *filled* surface for non-flooded cells (§2), and keep `rcv` only for flooded cells (`fill > z`).
- **Epsilon variant (Priority-Flood+ε, same paper).** Use `fill[n] = nextafter(fill[c])` so that filled areas get a tiny strict gradient. Do not use it in float32: at z ≈ 3000 m the ulp is ~2.4e-4 m, so a 500-cell lake already gains 0.12 m of fake tilt. It also turns lakes into sloped "ramps". Store the true surface as `fill` (flat) and route through flats with the flood-order `rcv`. If a strictly decreasing surface is ever needed (e.g. GPU flow), use Barnes' flat-resolution method (2014b), which gives convergent rather than parallel flow over flats.
- **Spill point** of a depression: the cell where the flood first *entered* the depression from outside, i.e. the first pit-queue push for that label. Its `fill` is the **lake surface level**.

### 1.2 Lake vs breach

Real DEMs breach artefact pits. Generated terrain has two kinds of pits: real basins (rifts, calderas, glacial overdeepenings, deserts) and **noise pits**, which are a few metres deep. Decide per depression `d`:

```
depth_d  = spill_d − min z inside d
area_d   = cells with fill > z (km²)
breach  if  depth_d < breachMaxDepth (default 15 m)  and  area_d < breachMaxArea (default 4 km²)
        or  (cost of carving a channel from bottom to spill-out cell, Lindsay-style) < fill volume·k
lake    otherwise → goes to the water balance (§1.4)
```

Breaching is a least-cost path from the pit to the nearest lower cell outside, with `z` lowered monotonically along it. That is cheap here because noise pits are shallow. Lindsay (2016) argues for the same hybrid of "breach the small, fill the big". The practical generator lesson is not to fill everything: filling gives perfectly flat fake lakes, and breaching big basins cuts unnatural trenches.

### 1.3 Nested depressions: depression hierarchy

Depressions nest. Two adjacent pits merge into a parent "meta-depression" once both are filled to their shared saddle. Barnes, Callaghan & Wickert (2020, Part 2) build this **depression hierarchy** in about one Priority-Flood pass. Part 3 (2021), **Fill–Spill–Merge**, routes a water budget through it:

1. Leaves fill first.
2. Overflow spills into the neighbour, or into the parent when the neighbour is also full.
3. Two full siblings merge and fill the parent.

This is exactly the logic needed to decide which basins are lakes and at what level. A minimal version suffices at 1024²:

```
labels: run Priority-Flood with a label per seed pit (Barnes' watershed-labelling variant);
        each time two labels meet at a saddle (first contact), record edge (la, lb, saddleZ)
hierarchy: Kruskal on saddle edges sorted by saddleZ → binary tree (union-find), the ocean is the root
per node: hypsometry  A(h), V(h) tabulated from the cells' z values (sorted once per leaf; ≤ 64 bins)
```

### 1.4 Endorheic basins: the evaporation balance

For every depression node, processed leaves-first:

```
Q_in   = runoff accumulated into the basin (m³/yr) + overflow received from children/neighbours
E_net  = (E_lake − P_lake) (m/yr) from climate; open-water evaporation ≈ 1.0–1.3 × potential ET
A_spill = basin area at the spill level (m²)

if E_net ≤ 0 or Q_in ≥ E_net · A_spill:
    lake fills to spill; outflow = Q_in − max(E_net,0)·A_spill → passed to the spill neighbour   (exorheic)
else:
    solve E_net · A(h) = Q_in for h by bisection on the hypsometry table               (terminal lake)
    r = A(h) / A_spill
    r < rPlaya (0.05)        → playa / salt pan: render dry white, mark ephemeral water
    r < rSalt  (0.4)  or arid → salt lake (Great Salt Lake / Aral type)
    else                      → brackish terminal lake (Caspian / Balkhash style)
    no outflow; rivers inside end at this lake → node flag MOUTH_LAKE_TERMINAL
```

Notes:

- This is the classic closed-lake mass balance (inflow equals net evaporation × area). It makes lake size a direct readout of climate: wetter seeds overflow more basins into chains of lakes, and drier seeds produce Basin-and-Range style playas.
- An overflowing child adds `outflow` to the target basin's `Q_in` *before* the target is evaluated. The hierarchy order guarantees this.
- **Through-flowing lakes** keep the river graph connected: inlet nodes stop at the shoreline, and an outlet node starts at the spill cell (`LAKE_IN`, `LAKE_OUT`). Their surface is exactly the spill level, which is an invariant.
- **Partially filled basins.** The cells between the equilibrium level `h` and the spill become dry land again. Re-route them with the flood `rcv`, which already points down into the basin.

---

## 2. Flow routing

### 2.1 Choice of algorithm

| Method | Divergent? | Grid bias | Use here |
|---|---|---|---|
| **D8** (O'Callaghan & Mark 1984) | No, single receiver | Strong: 45° multiples, parallel straight channels on planes | River graph (must be a tree), with the jitter fix below |
| **D∞** (Tarboton 1997) | Splits flow to 2 neighbours by facet angle | Low | Optional for drainage area on hillslopes |
| **MFD** (Freeman 1991; Quinn et al. 1991) | Splits to all lower neighbours ∝ `tanβ^p` (p ≈ 1.1; ESRI uses adaptive `p`) | Lowest, but dispersive | TWI/wetness (§7), soil moisture, never rivers |

A river network must be a **tree** with confluences only. Splits happen only in deltas and braids, and those are added explicitly (§5). So the graph uses single-receiver routing.

### 2.2 Killing grid-aligned rivers

Without these fixes, plains get dead-straight 45° rivers and parallel "comb" drainage. Apply them in this order:

1. **Jittered nodes.** Each cell `i` has a fixed position `p_i = center_i + J·(hash2(seed,i) − 0.5)` with `J = 0.7` cell. Slopes use the true distance: `s(i→n) = (z_i − z_n) / |p_i − p_n|`. This keeps the 8-neighbour topology and typed arrays, but receiver directions take many angles. mapgen4 avoids the same problem by routing on a jittered Delaunay/Voronoi mesh.
2. **Elevation micro-noise before routing.** Add `±0.5 m` of value noise with a wavelength of 3–8 cells to `z` *for routing only*. This breaks ties on the flat plains the LEM produces.
3. **Random tie-break** in the Priority-Flood heap (hash key) and in flats. Equal heights pick a random lower neighbour, not the first scanned.
4. **No crossing diagonals.** If `i→i+W+1` and `i+1→i+W` both exist, the two segments cross. Re-route the lower-discharge one to its best orthogonal receiver.
5. **Curved polylines** (§4.1). The final geometry goes through jittered node positions with Catmull-Rom smoothing, so the remaining bias is invisible.

### 2.3 Accumulation in O(n): Braun–Willett stack

Braun & Willett (2013, the FastScape algorithm) order the nodes so that every node appears before its receiver in reverse, using a DFS from each outlet over the donor lists. Accumulation is then one reverse sweep:

```ts
// donors as CSR: donorStart[N+1], donorList[N]   (counting sort by rcv, O(n))
stack = []; for each outlet o: dfs-push(o)          // iterative: s.push(o); while s: c=s.pop(); stack.push(c); push donors(c)
runoff[i] = max(P_i − ET_i, 0) [m/yr] · cellArea [m²]           // from climate note; ET from Budyko-type curve
Q = runoff.slice()                                               // m³/yr
for k = N−1 .. 0: i = stack[k]; r = rcv[i]; if r != i: Q[r] += Q[i] − loss_i
Q_m3s = Q / 3.156e7
A_km2 = same sweep with weight 1 km² per cell
```

- `loss_i` is the transmission loss for arid channels (§5.4). It is 0 elsewhere. Clamp `Q ≥ 0`.
- Sanity value: 1000 km² with 300 mm/yr runoff gives 1e9·0.3/3.156e7 ≈ **9.5 m³/s**.
- Lakes: within a flooded basin, all cells route to the spill via `rcv`. The lake balance (§1.4) then *replaces* the outflow at the spill node with `Q_in − E_net·A`.

---

## 3. River extraction, ordering and scaling laws

### 3.1 Thresholds and drainage density

Channel heads form where the drainage area exceeds a critical source area `A_c`. Drainage density is `Dd = ΣL_channels / area`, and mean hillslope length is ≈ `1/(2·Dd)`.

| Setting | Dd (km/km²) | Implied A_c |
|---|---|---|
| Permeable humid (chalk, sandstone, glacial till) | 0.3–1 | 1–5 km² |
| Humid temperate, crystalline | 1–3 | 0.05–0.5 km² |
| Semi-arid, sparse vegetation | 3–10 | ~0.01–0.05 km² |
| Badlands, unvegetated clays | 20–400 | ≤ 0.001 km² |

These are textbook orders of magnitude. Note that Dd peaks in semi-arid climates, not in humid ones. The consequence for us: **a 1 km grid can only hold the trunk network.** Real creeks start at 0.05–0.5 km², below one hydrology cell. The 1 km² network is the "channel skeleton" (order ≥ 3–4 in nature). Everything finer is sub-cell detail (§8).

Use `A_c(climate)` to modulate sub-cell creek density:

```
A_c = A_c0 · f(aridity)           // A_c0 = 0.2 km², exposed as "creek density"
```

### 3.2 Ordering

```
Strahler: leaves = 1; at confluence ω = max(ω_a, ω_b) + (ω_a == ω_b ? 1 : 0)      // one reverse-stack sweep
Shreve magnitude: leaves = 1; at confluence m = Σ m_donors                           // ≈ number of sources
```

Both orders depend on the threshold: raise `A_c` and every order drops. **Use `A` or `Q` for LOD and styling.** Use Strahler only for labels, tests and stylistic rules ("order ≥ 6 gets a name").

### 3.3 Horton and Hack: use them as tests, not inputs

| Law | Natural range | How to test on the generated network |
|---|---|---|
| Bifurcation ratio `R_b = N_ω / N_{ω+1}` | 3–5 | Regress log N_ω vs ω, all basins ≥ order 4 |
| Length ratio `R_L = L̄_{ω+1} / L̄_ω` | 1.5–3.5 | Same, mean reach length |
| Area ratio `R_A` | 3–6 | Same |
| Hack's law, main-stem length vs area | `L = 1.4·A^0.6` (Hack 1957, miles and mi²) ≈ `L_km ≈ 1.27·A_km²^0.6` | Fit exponent h ∈ [0.5, 0.65] over all outlets with A ≥ 100 km² |
| Confluence angle | ≈ 45° arid, ≈ 72° humid (Seybold, Rothman & Kirchner 2017) | Mean angle of smoothed tangents at junctions |

A D8 network on noise-plus-stream-power terrain satisfies Horton almost automatically, since Horton ratios are notoriously insensitive. Hack's exponent and the junction angles are the discriminating checks. Straight rivers give `h → 0.5`, and the target is ~0.55–0.6.

### 3.4 LOD by zoom

Choose `A_vis` so that drawn channels are spaced about `s` screen pixels apart (default `s = 24`). For a channel network, typical spacing between channels of area ≥ A is about `k·√A` with k ≈ 1–2:

```
A_vis(mpp) = (s · mpp / k)²       (mpp = metres per pixel, convert to km²)
```

| View | m/px | A_vis | What is visible |
|---|---|---|---|
| World, 1024 km on 1000 px | 1000 | ~150–600 km² | Trunk rivers, order ≥ 5–6 |
| Region | 100 | ~2–6 km² | Most of the 1 km grid network |
| Local | 20 | ~0.06–0.2 km² | Sub-cell creeks (§8) |
| Close | 10 | ~0.02 km² | Gullies and ravines (procedural only) |

Fade alpha by `smoothstep(A_vis, 2·A_vis, A)` so rivers don't pop in. Also enforce a minimum screen width of 1 px: render width is `max(w_world/mpp, 1 px·fade)`.

### 3.5 Hydraulic geometry (Leopold & Maddock 1953)

Downstream relations at mean annual or bankfull discharge are `w = a·Q^b`, `d = c·Q^f`, `v = k·Q^m`, with `b + f + m = 1`. Typical values are b ≈ 0.5, f ≈ 0.4, m ≈ 0.1. Defaults, as tunable fits:

```
w [m] = 4.0 · Q^0.5        // Q=1 → 4 m; Q=100 → 40 m; Q=10 000 → 400 m; Q=200 000 → 1.8 km
d [m] = 0.35 · Q^0.4       // Q=1 → 0.35 m; Q=100 → 2.2 m; Q=10 000 → 14 m
v     = Q / (w·d)          // sanity: 0.3–3 m/s
```

The coefficients vary severalfold between rivers. Expose `a` (2–8) and `c` (0.2–0.6). Arid rivers are wider and shallower (`a` ×1.5), and bedrock gorges are narrower (`w` ×0.3–0.5 where `slope > 0.02`).

---

## 4. Making rivers look right

### 4.1 Polyline extraction and smoothing without uphill flow

```
reaches: start at every source (A ≥ A_min, no donor with A ≥ A_min) and every confluence-downstream,
         walk rcv until next confluence/mouth/lake → node list
xy: jittered node positions p_i;  z: bed elevation zb_i = fill_i − d_i (water surface − depth); in lakes stop at shore
smooth xy: centripetal Catmull-Rom through p_i (no overshoot loops), or 2 Chaikin passes (stays in hull)
          keep the endpoint of each reach fixed so confluences stay welded
resample at Δs = min(w/2, 250 m) for the renderer
z on resampled points: interpolate zb by arclength, then enforce monotone:
    for j in 1..n: z_j = min(z_j, z_{j−1})                     // water never climbs
    at confluence: tributary end z = main-stem z at junction (tributary may be ≥, never <)
```

- Chaikin stays inside the convex hull of the control polygon, which is the safer choice near other rivers. Catmull-Rom (centripetal) looks better. Validate either with the no-crossing test (§10.3).
- **Confluence angles.** D8 gives 45/90/135°. Over the last `3·w_main` of a tributary, rotate its control points so the entry tangent meets the main stem at `α_target` (45° arid → 72° humid, interpolated by aridity). It should enter on the side it came from and point downstream.

### 4.2 Meanders (low slope, alluvial)

Meandering versus straight versus braided depends on slope and discharge. Leopold & Wolman (1957) found that at a given discharge braids occur at steeper slopes than meanders. Use a threshold slope `S_t(Q) = κ·Q^−0.44` with κ tuned so that typical lowland rivers (S < 3e-4) meander. Treat the exponent as the classic L&W form, and verify the constant against PP 282-B before quoting it.

- Meander wavelength `λ ≈ 10–14·w`, with radius of curvature ≈ 2–3·w.
- **Generate meanders with the Kinoshita / sine-generated curve.** Direction relative to the valley axis as a function of arclength:
  `θ(s) = θ0·sin(2πs/λ) + θ0³·(J_s·cos(6πs/λ) − J_f·sin(6πs/λ))`
  with skewness `J_s ≈ 0.03` and flatness `J_f ≈ 0.005`. For the pure sine-generated curve (Langbein & Leopold 1966) sinuosity is `σ = 1/J0(θ0)`. So pick a target σ from slope (`σ = 1 + (σ_max−1)·smoothstep(S_t, S_t/10, S)`, σ_max ≈ 2.5) and invert for θ0 (σ = 1.5 ↔ θ0 ≈ 1.20 rad ≈ 69°).
- **Constrain to the floodplain.** Compute the floodplain half-width as the distance from the centreline at which terrain rises more than `2·d` above the water. Clamp the lateral amplitude to it, so meanders never climb valley walls. Valleys in mountains therefore stay straight-ish, which is correct.
- **Elevation:** a meandering channel is longer, so its slope is `S_valley/σ`. z is still interpolated by *valley-axis* distance, then the monotone pass runs. That keeps it consistent with the macro grid.
- **Oxbow lakes:** where θ0 > ~125° the curve self-intersects. Cut the loop, keep the shorter path, and emit the loop as an `OXBOW` lake polygon of width ≈ w at floodplain level − 0.5·d. Also scatter 0–3 abandoned loops per 10 λ on high-σ reaches inside the meander belt.

### 4.3 Braided rivers

Braiding is used where `S > S_t(Q)` *and* the reach is a glacial outwash or alpine valley floor, an arid flash-flood channel, or just below a mountain front (large slope drop).

- Render width multiplier ×3–10.
- The bed is a flat gravel plain.
- Water = `domainWarpedNoise(s, n) > τ` inside the belt, with noise stretched ×4 along the flow direction. That gives the bars and threads.
- The graph stays a single edge with a `BRAIDED` flag, because splitting is a render effect.

### 4.4 Carving into the heightmap, consistently across resolutions

The constraint: macro grid (1 km) → GPU detail (250 m and finer, noise added) must never create a dam or make water flow uphill.

1. **Before macro routing (stream burning).** Upsample the LEM (2 km) heights to 1024². Then burn the LEM's channels with `A ≥ 50 km²` into it by lowering them 2–5 m along the LEM receiver paths. The 1 km routing then keeps the big rivers in the valleys the LEM eroded, rather than jumping across upsampling ridges.
2. **Macro carve.** After routing, set `z_H(i) = min(z_H(i), zb_i)` on river cells. The 1 km terrain now holds the channel.
3. **Detail carve on the GPU (min-composite).** Rasterize river reaches as ribbons into an R32F "carve target" with `MIN` blending. For each fragment at distance `r` from the centreline, with bed z `zb(s)` interpolated along the polyline:

```glsl
float u = r / (0.5*w);                                   // 0 at centre, 1 at bank
float channel = zb + d * (u < 1.0 ? u*u : 1.0);          // parabolic bed up to water surface level
float valley  = zb + d + valleyProfile(r - 0.5*w);       // banks rising into the valley
// valleyProfile: floodplain  → 0 out to fpHalfWidth, then slope Sv
//                V (mountain)→ Sv_steep * x           (Sv from LEM local relief)
//                U (glacial) → a*x^2 capped
//                canyon      → terrace(x) (see 4.6)
carve = min(channel, valley);    // written with MIN blend; detail pass then does h = min(h_detail, carve)
```

The ribbon is extended `valleyHalfWidth` beyond the banks. Detail noise amplitude is multiplied by `smoothstep(0, valleyHalfWidth, r)`, so noise fades into the valley floor and cannot reintroduce bumps.

4. **Lakes on detail.** Inside a lake's (dilated) label mask, clamp `h ≤ level − bedDepth(distToShore)`. The water plane is drawn at `level` where `h < level` *and* the lake mask is set. The mask prevents spurious flooding of detail-noise pits outside lakes.

Why this is consistent: every operation is `min()` against a surface that is monotone along the flow. Each river polyline's `zb` is non-increasing downstream, and a min of monotone-along-path terms cannot exceed `zb` on the centreline. So the path is a descending path on every LOD.

### 4.5 Waterfalls, rapids, knickpoints

Along each resampled reach compute the drop over one channel width, `Δz_w = z(s) − z(s + max(w, 50 m))`.

| Condition | Flag |
|---|---|
| `Δz_w > 1.5·d` and `Δz_w > 5 m` | `WATERFALL`: render vertical sheet plus mist, carve plunge pool depth 0.5·Δz_w, radius 2·w |
| `0.01 < S_local < waterfall` and `order ≥ 2` | `RAPIDS`: white-water shader |
| Lake outlet over hard rock (lithology note) | Keep a knickpoint, so don't smooth slope there |

Knickpoints come from the LEM with stream power: uplift pulses and hard rock bands migrate as steps. Do not smooth them away. The monotone pass keeps them as steps, which is correct, while the Catmull-Rom smoothing only moves xy.

### 4.6 Canyons, gorges, ravines, antecedent rivers

- **Antecedent rivers** cross a rising range because they were there first. In the LEM (stream power `∂z/∂t = U − K·A^m·S^n`), a river incises as fast as uplift when `K·A^m·S^n ≥ U`. Large-A rivers therefore cut through rising blocks automatically if the uplift is ramped in over time rather than imposed at t = 0. Cordonnier et al. (2016) generate whole terrains this way, starting from an uplift map. Expose "uplift ramp time" in the LEM. That is where gorges come from, so do not fake them in hydrology.
- **Canyon profile on plateaus.** Where the reach is incised more than `I_canyon` (default 300 m) below the 10 km-smoothed surrounding surface and the valley is narrow, use a terraced valley profile in the carve shader. `x → step + smoothstep` per rock layer of 30–150 m thickness, then a near-vertical cliff (slope 2–4) per layer. That gives Colorado-plateau stairs.
- **Ravines and gullies** live at detail level. Low-order flow paths on steep slopes (§8) get a V carve of depth `∝ √A_local · S`, capped at 30 m. In semi-arid climates use `A_c` ×0.2, which gives dense badland gullies.

---

## 5. Sources and mouths

### 5.1 Sources (node flag `SOURCE` + subtype)

| Subtype | Rule |
|---|---|
| Mountain headwater | Source cell elevation in the top 20 % of its basin and slope > 0.05 |
| Glacier-fed | Source cell above the ELA/snowline, or under the climate note's glacier mask. Q gets a meltwater bonus `+M·A_glacier`. Also enables braided style downstream |
| Spring | Source on a slope break (concave), or at the toe of a permeable layer. At creek LOD, Poisson-disk springs with density ∝ recharge |
| Lake outlet | `LAKE_OUT` at the spill cell, carrying Q = lake outflow |

Every source reported is just a cell where `A` first exceeds the current LOD threshold. The subtype only drives rendering and naming.

### 5.2 Mouths and the sea

At a `MOUTH_SEA` node compute the river sediment and discharge index `R = Q` (or `Q·S_upstream` as a sediment proxy), wave energy `W` from fetch and prevailing wind at the coast cell, and tidal range `T`. A global "tide" parameter can be modulated by shelf width. Then use the Galloway (1975) ternary diagram as a softmax over `(R/R0, W/W0, T/T0)`.

| Dominant | Shape | Generation |
|---|---|---|
| River | **Bird's-foot** (Mississippi) | Grow 3–6 distributaries seaward, each splitting with probability 0.3 per km. Raise the seabed along them to sea level + 1 m with levee width 3·w |
| Wave | **Arcuate** (Nile) / **cuspate** (Tiber, São Francisco) | Deposit a smooth fan lobe of radius ∝ Q^0.4. Shoreline is a convex arc (arcuate), or a single cusp for small Q. Use 2–3 distributaries or 1 |
| Tide | **Estuary / tide-dominated delta** (Fly) | Funnel-shaped mouth with width growing exponentially seaward (e-folding 10–30 km). Add linear sand bars parallel to flow and no lobe |

Only rivers with `Q > Q_delta` (default 300 m³/s) and a shallow shelf (< 50 m within 20 km) get a delta. All others get a simple mouth or an estuary.

- **Rias:** after carving, apply `seaLevelRise` (default 0, range 0–150 m). Low coastal valleys flood and become dendritic drowned valleys. In glacial U-valleys (glacier mask) the same rise gives **fjords**.
- **Distributaries break the tree.** Store them as edges flagged `DISTRIBUTARY`, with a discharge fraction `φ`. The invariant "every node has ≤ 1 downstream" applies only to non-distributary nodes.

### 5.3 Lakes as endpoints

`MOUTH_LAKE` (through-flow) and `MOUTH_LAKE_TERMINAL` (endorheic) are both legal ends. A terminal lake with a large inflow gets a small arcuate inland delta (same code, W ≈ 0, T = 0). The Volga into the Caspian is the archetype.

### 5.4 Deserts: losing rivers, inland deltas, wadis

- **Transmission loss.** In cells with `aridity = PET/P > 2`, `loss_i = λ_loss · (PET_i − P_i) · w_i · cellLen` (m³/yr). The channel loses water to evaporation and infiltration. When accumulated `Q` reaches 0, the river ends with a `SINK_DRY` flag, which is a legal terminal.
- **Inland delta** (Niger, Okavango). On a low-slope arid plain where Q drops below 50 % of its peak, spread it into a distributary fan plus a wetland polygon. This is the same code as §5.2 with water instead of sea, plus a seasonal wetland.
- **Wadis / ephemeral streams.** Mean annual Q is small, but the channel exists, carved by rare floods. Flag `EPHEMERAL` when `Q < Q_eph` (default 0.5 m³/s) and aridity > 2. Carve using a *design-flood* Q (×20), then render as a dry sandy bed with no water ribbon. Creek density in arid zones uses the high-Dd row of §3.1.

---

## 6. Lake taxonomy and generation

The 1 km grid can only resolve lakes of ≥ ~2–4 cells. Natural lake counts are dominated by small lakes, so most lakes have to be **placed by type-specific rules at detail level**. They must also be consistent with drainage: a placed lake either sits on an existing flow path (inline) or in a closed pit with a small outlet creek to the nearest channel.

| Type | Where | Shape and size | Generation rule |
|---|---|---|---|
| **Basin / tectonic** (generic) | From §1 | Any | Priority-Flood + balance |
| **Rift lake** (Tanganyika, Baikal) | Rift zones from tectonics | Elongated, aspect 5–15, very deep (300–1600 m) | LEM graben, then natural fill. Ensure the graben floor is below the spill by subtracting a rift profile |
| **Glacial: cirque tarn** | Valley heads above the paleo-ELA in the glacier mask | Round, 0.05–1 km², deep | Carve a bowl (radius 300–800 m, depth 20–80 m) at the head of order-1 valleys with a lip 5–15 m above the floor |
| **Glacial: finger lake** | Overdeepened U-valleys, ice flowing from the range | Long, narrow (2–5 km × 20–60 km) | Overdeepen the U-valley floor by 50–300 m along its length, plus a terminal moraine ridge at the valley mouth |
| **Glacial: kettle** | Outwash and moraine plains at the former ice margin | Round, 0.001–1 km², clustered | Poisson-disk pits (r = 30–400 m, depth 2–20 m), density up to 20/km² |
| **Crater / caldera** | Volcano summits (volcanism layer) | Circular, r = 0.5–10 km | Fill if `Q_in ≥ E_net·A`. Calderas get a deep flat floor |
| **Oxbow** | Meander belts | Crescent, width ≈ w | §4.2 |
| **Endorheic salt lake / playa** | From §1.4 | Lobate, shallow | Balance |
| **Floodplain / thermokarst ponds** | Wetland zones and permafrost | Many tiny | Same as kettle with lower depth (1–3 m) and higher density in permafrost |

**Size distribution and counts.**

- Downing et al. (2006) fit a Pareto model and estimate ~304 million natural lakes covering 4.2 M km², most of the area in lakes < 1 km².
- HydroLAKES (Messager et al. 2016) maps 1.43 M lakes ≥ 10 ha, totalling 2.67 M km². That is ≈ 1.8 % of land and ≈ 1 lake ≥ 0.1 km² per 100 km² on average.
- With a cumulative Pareto `N(A > a) ∝ a^−1` (exponent ≈ 1), a 1024 × 1024 km world (~1.05 M km² of land if all land) should hold roughly:

| Lake area | Expected count, average climate |
|---|---|
| ≥ 100 km² | ~10 |
| ≥ 10 km² | ~100 |
| ≥ 1 km² | ~1 000 |
| ≥ 0.1 km² | ~10 000 |

These are derived estimates. Expect ×3–10 in glaciated and permafrost lowlands and ×0.1 in deserts. Test the generator against `log N vs log a` with slope in −0.8 … −1.2 and lake cover 0.5–5 % depending on climate. Basin lakes from §1 cover the large end. Placed lakes fill the small end, drawn from the same Pareto with `a_min = 0.001 km²` until the per-region density target is met.

---

## 7. Wetlands

Topographic Wetness Index (Beven & Kirkby 1979):

```
TWI_i = ln( a_i / tan β_i )      a = specific catchment area = A_MFD,i [m²] / cellWidth [m];  β = local slope
```

- Compute `a` with **MFD** (p = 1.1) on the filled hydrology grid. D8 gives stripy TWI. Clamp `tan β ≥ 1e-4`.
- TWI is resolution-dependent, so threshold by percentile, not absolute value. A cell is a wetland candidate if `TWI > percentile(TWI, 100 − p_wet)` and `slope < 0.005`, where `p_wet = 2–15 %` scales with `P/PET` (0 % when P/PET < 0.5).
- Also wetland: lake shallows (depth < 2 m), deltas, inland deltas, and floodplains of order ≥ 4 rivers within the floodplain half-width.

| Class | Condition |
|---|---|
| **Bog** (rain-fed, raised, acidic) | Cold (MAT < 8 °C), P > PET, not on a river floodplain |
| **Fen** (groundwater-fed peat) | Cold, at the toe of slopes or springs, or near lakes |
| **Swamp** (forested) | Warm (MAT > 15 °C) and humid. Mangroves where also coastal and tidal |
| **Marsh** (herbaceous, mineral soil) | Default for temperate floodplains, lake margins, deltas. Salt marsh on low-energy coasts |

Output: a `wetland` class raster (Uint8) for the biome and texturing note. At detail level, add scattered open-water pools inside wetlands (pond Pareto, `a_min` = 100 m²).

---

## 8. Creeks at close zoom

Requirements: creeks appear below ~50 m/px; they connect to the macro network; and they are deterministic, independent of which tiles are loaded or in what order. Two options were considered:

- **(a) Per-tile Priority-Flood on the detail heightmap.** This needs tile aprons, and tile boundaries change receivers unless the apron is huge. A full 4096² run takes ~3–6 s in JS. **Rejected** as the main mechanism.
- **(b) Per-macro-cell deterministic growth.** **Chosen.** Each 1 km cell `c` is a sub-catchment with known inputs: inflow points on its edges where upstream macro paths enter, its outlet point where its own D8 path exits, its slope, aspect and `A_c`.

```
generateCreeks(c):                            // pure function of (seed, c, macro data) → identical everywhere
  rng = pcg(seed ^ hash(c))
  trunk = macro path through c (polyline from §4.1, also sub-threshold paths with A ≥ 1 cell)
  n_heads = round( cellArea / A_c(climate_c) )            // e.g. 1 km² / 0.2 km² = 5
  heads = poissonDisk(cell, r = 0.5·√A_c, n_heads, rng), excluding a 2w strip around trunk
  for h in heads sorted by elevation (desc):
     walk downhill on the analytic surface (macro bicubic + the *same* low-freq detail noise the GPU uses)
     with step 20 m, until hitting the trunk or an existing creek → join (record junction angle; rotate to α)
     if exits cell before joining: continue into neighbour's trunk only (never into neighbour's creeks)
  emit creek polylines with A from contributing Voronoi area of heads, Q = A·runoff_c, w,d from §3.5
```

Determinism and consistency:

- Creeks only ever join **trunk paths**, which are global, or creeks of the *same* cell. Each cell's output therefore depends only on `(seed, c, macro)`.
- Creeks are computed when a tile requests the cells it overlaps, plus a 1-cell ring for creeks that cross the boundary, and are cached in an LRU.
- The walk uses the same analytic noise as the GPU detail shader, minus the high-frequency octaves. Creeks follow real hollows, and the subsequent `min()` carve (§4.4) makes the detail terrain obey them.
- Cost: ~5 creeks × ~50 steps per km². A 20 m/px view spans ~40 km², which is ~10 k steps, well under 1 ms.
- Ravines and gullies (A < 0.05 km²) are a **pure shader effect**: flow-aligned ridged noise oriented by the local flow direction (`rcv` vector field), with amplitude ∝ slope. No graph is involved.

LOD summary:

| Zoom (m/px) | Network source | Carve |
|---|---|---|
| > 300 | Macro graph, `A ≥ A_vis` | Macro carve already in `H` |
| 30–300 | Macro graph, all 1 km² reaches | Detail ribbons, GPU min-carve |
| 8–30 | + per-cell creeks | Creek ribbons into detail carve target (per tile) |
| < 8 | + shader gullies | Shader only |

---

## 9. Data structures for the renderer

```ts
// River graph (SoA, nodes in downstream-sorted reach order). ~200k nodes at 1 km² threshold on 1024².
interface RiverGraph {
  n: number;
  x: Float32Array; y: Float32Array;       // world metres (jittered/smoothed, resampled)
  zBed: Float32Array; zWater: Float32Array; // monotone non-increasing along down[]
  q: Float32Array;  area: Float32Array;   // m³/s mean annual, km²
  width: Float32Array; depth: Float32Array;
  strahler: Uint8Array; shreve: Uint32Array;
  down: Int32Array;                        // downstream node, −1 at terminal
  flags: Uint16Array;  // SOURCE|CONFLUENCE|MOUTH_SEA|MOUTH_LAKE|LAKE_TERMINAL|SINK_DRY|LAKE_IN|LAKE_OUT|
                       // WATERFALL|RAPIDS|EPHEMERAL|BRAIDED|DISTRIBUTARY|DELTA|OXBOW_CUT
  // reaches = maximal chains between confluences: offsets into the node arrays
  reachStart: Uint32Array; reachLen: Uint32Array; reachDown: Int32Array;
  reachMinArea: Float32Array;              // LOD key: draw if area ≥ A_vis
  distribFrac: Float32Array;               // φ for DISTRIBUTARY reaches, else 1
}
interface Lake {
  id: number; parent: number;              // depression hierarchy
  type: 'basin'|'rift'|'tarn'|'finger'|'kettle'|'crater'|'oxbow'|'salt'|'playa'|'pond';
  level: number;                           // m, == spill z for through-flow lakes
  area: number; volume: number; maxDepth: number;
  rings: Float32Array[];                   // shoreline polygon(s) at `level`, marching squares on H, smoothed
  outletNode: number;                      // −1 if terminal
  inflowQ: number; outflowQ: number; salinity: 0|1|2;
}
// Rasters on the 1024² hydrology grid (transferable to main thread):
rcv: Int32Array; stack: Int32Array; area: Float32Array; q: Float32Array;
fill: Float32Array;          // water surface (lakes) or terrain
waterLevel: Float32Array;    // NaN = dry; ocean = seaLevel; lake = level; river cells = zWater
waterClass: Uint8Array;      // 0 land, 1 ocean, 2 lake, 3 river, 4 wetland, 5 playa
lakeId: Int32Array;          // dilated by 1 cell for detail clipping
twi: Float32Array; wetland: Uint8Array;
```

Rendering hooks:

- Rivers are triangle-strip ribbons (width from `width`, z from `zWater`) drawn after terrain with depth test on.
- Lakes are a flat polygon per lake at `level`, plus a shoreline depth-fade from the detail heightmap.
- The carve target (§4.4) is rasterized from the same ribbons with the valley extension.
- Upload `waterLevel` as an R32F texture so the terrain shader can tint wet ground and the ocean shader can use it.

---

## 10. Recommendation for this project

### 10.1 Ordered steps (worker, after LEM and climate)

| # | Step | Complexity | Est. 1024² JS |
|---|---|---|---|
| 1 | Upsample the LEM to 1024² (bicubic), burn LEM channels (A ≥ 50 km²), add routing micro-noise | O(n) | 15 ms |
| 2 | Priority-Flood with pit queue, random tie-break, labels, saddles → `fill`, flood `rcv` | O(n log n), heap only on non-pit cells | 120–250 ms |
| 3 | Breach small noise pits (§1.2) and re-run step 2 on the touched region, or just once more | O(k) | 10–40 ms |
| 4 | D8 steepest descent on jittered nodes for non-flooded cells. Fix crossing diagonals | O(n) | 20 ms |
| 5 | Donor CSR + Braun–Willett stack | O(n) | 15 ms |
| 6 | Accumulate A and runoff-weighted Q (with arid losses) | O(n) | 5 ms |
| 7 | Depression hierarchy + water balance (§1.4), leaves-first. Apply lake outflows, then re-accumulate Q downstream of changed spills (one more sweep) | O(n + D log D) | 20–40 ms |
| 8 | Extract reaches (A ≥ 1 km²), Strahler/Shreve, hydraulic geometry | O(n) | 15 ms |
| 9 | Smooth, meander (Kinoshita), oxbows, braid flags, confluence angles, resample, monotone z | O(nodes) | 30–80 ms |
| 10 | Waterfalls/rapids, sources/mouth classification, deltas/estuaries, inland deltas | O(nodes) | 10 ms |
| 11 | Lake polygons (marching squares per lake), placed lakes (Pareto per type) | O(n) | 20–40 ms |
| 12 | MFD area → TWI → wetlands | O(8n) | 40–70 ms |
| 13 | Macro carve into `H`, build `waterLevel`/`waterClass` | O(n) | 10 ms |
| **Σ** | | | **≈ 0.35–0.65 s** |

GPU detail carve and on-demand creeks run per tile on the main thread or GPU (§4.4, §8).

These are estimates for TypeScript on typed arrays with no allocation in loops, on an M-series laptop, scaled from 1M-cell experience. Benchmark step 2 first, since it is the dominant cost. If needed, use an integer heap on quantized `z` (cm, Uint32), which makes Priority-Flood O(n) with a bucket queue.

### 10.2 Parameters to expose (lil-gui "Hydrology")

| Param | Default | Range |
|---|---|---|
| `rainScale` (× climate P) | 1.0 | 0.2–3 |
| `evapScale` (× lake E) | 1.0 | 0.3–2 |
| `routingJitter` (cells) | 0.7 | 0–0.9 |
| `breachMaxDepth` (m) | 15 | 0–100 |
| `breachMaxArea` (km²) | 4 | 0–50 |
| `riverMinArea` (km², graph) | 1 | 1–50 |
| `labelSpacingPx` (LOD `s`) | 24 | 8–64 |
| `creekSourceArea` `A_c0` (km²) | 0.2 | 0.02–2 |
| `widthCoef a` | 4 | 2–8 |
| `depthCoef c` | 0.35 | 0.2–0.6 |
| `meanderStrength` (σ_max) | 2.5 | 1–3.5 |
| `meanderSlopeThreshold` κ | tuned | — |
| `oxbowRate` | 1 | 0–3 |
| `confluenceAngleHumid` / `confluenceAngleArid` (°) | 72 / 45 | — |
| `waterfallMinDrop` (m) | 5 | — |
| `canyonIncision` (m) | 300 | — |
| `terraceLayer` (m) | 80 | — |
| `deltaMinQ` (m³/s) | 300 | — |
| `waveEnergy`, `tideRange` | 0.5, 0.3 | 0–1 |
| `seaLevelRise` (m) | 0 | 0–150 |
| `lakeDensity` (× Pareto target) | 1 | 0–5 |
| `glacialLakes` | on | on/off |
| `wetlandPercentile` | auto from P/PET | 0–20 % |
| `aridLoss` λ | 1 | 0–3 |
| `seed` | — | — |

Debug overlays: `A` (log), `Q`, Strahler, flood `rcv` arrows, lake ids, TWI, depression hierarchy level.

### 10.3 Invariants (vitest, property tests over ~50 seeds at 256² and 3 seeds at 1024²)

1. **Termination.** Following `down` from every node reaches exactly one terminal, which is one of `MOUTH_SEA | MOUTH_LAKE_TERMINAL | SINK_DRY | map-edge outlet`, in ≤ n steps (no cycles). Every `LAKE_IN` lake has an `outletNode` or is terminal.
2. **Monotone water.** `zWater[down[i]] ≤ zWater[i]` and `zBed[down[i]] ≤ zBed[i]` for every non-distributary edge. Also, after the GPU carve, sample the detail heightmap along each polyline at Δs = 10 m: `h(s_{k+1}) ≤ h(s_k) + 1e-3`.
3. **Lakes at spill level.** For every through-flow lake, `level == fill[spillCell]` and `level ≤ min z on the lake boundary except at the spill`. For terminal lakes, `|E_net·A(level) − Q_in| / Q_in < 1 %`. No lake cell has `z > level`.
4. **Mass conservation.** `Σ Q at terminals + Σ evaporation from lakes + Σ arid losses = Σ runoff`, with relative error < 1e-4 (float64 accumulators).
5. **Tree shape.** Each non-distributary node has ≤ 1 downstream. `Q` and `A` are non-decreasing downstream except across lakes and arid-loss reaches. Strahler is non-decreasing downstream.
6. **No crossings.** No two reach polylines intersect except at shared confluence nodes. Test with a segment grid hash on the resampled geometry, both after smoothing and after meandering. No river polyline enters a non-lake ocean or land cell with `z < zWater − d` (no tunnels).
7. **Scaling sanity** (soft, logged as warnings). Hack exponent 0.5–0.65; `R_b` 3–5; lake Pareto slope −0.8…−1.2; mean junction angle within ±10° of target; fraction of reaches with 45°-multiple heading over a 5 km window < 30 %.
8. **Determinism.** Same seed gives byte-identical `RiverGraph` and lakes. `generateCreeks(c)` is identical regardless of the order tiles are requested in.

### 10.4 Pitfalls

- Float32 heights plus ε-filling leads to ties and lake ramps. Use flat `fill` plus flood `rcv`, with float64 only for accumulators.
- Re-running Priority-Flood after carving can move spill points. Carve *after* the final routing, and only with `min()` along already-monotone paths.
- Upsampling the LEM with bicubic overshoot creates new pits on every ridge saddle. Stream burning (step 1) plus breaching (step 3) handle it. Without them you get thousands of tiny lakes on mountain flanks.
- Meander amplitude not clamped to the floodplain makes rivers climb valley walls. Always clamp.
- Lake polygons drawn from the 1 km grid look blocky. Run marching squares on `fill − z`, apply Chaikin ×2, then clip against detail heights at render time (§4.4).
- Ocean-edge outlets: the map border is treated as ocean for routing. If the user wants land at the border, rivers still need an exit, so mark border-exit mouths `MOUTH_EDGE` and render them running off the map.

---

## 11. References

- R. Barnes, C. Lehman, D. Mulla, "Priority-Flood: An optimal depression-filling and watershed-labeling algorithm for digital elevation models", *Computers & Geosciences* 62:117–127, 2014. https://arxiv.org/abs/1511.04463 · code https://github.com/r-barnes/Barnes2013-Depressions
- R. Barnes, C. Lehman, D. Mulla, "An efficient assignment of drainage direction over flat surfaces in raster DEMs", *Computers & Geosciences* 62:128–135, 2014. https://arxiv.org/abs/1511.04433
- R. Barnes, K. L. Callaghan, A. D. Wickert, "Computing water flow through complex landscapes – Part 2: Finding hierarchies in depressions and morphological segmentations", *Earth Surf. Dynam.* 8:431–445, 2020. https://esurf.copernicus.org/articles/8/431/2020/
- R. Barnes, K. L. Callaghan, A. D. Wickert, "… Part 3: Fill–Spill–Merge: flow routing in depression hierarchies", *Earth Surf. Dynam.* 9:105–121, 2021. https://esurf.copernicus.org/articles/9/105/2021/
- J. B. Lindsay, "Efficient hybrid breaching-filling sink removal methods for flow path enforcement in digital elevation models", *Hydrological Processes* 30(6), 2016 (summarized via Hariri et al., EGU21-7849: https://meetingorganizer.copernicus.org/EGU21/EGU21-7849.html)
- J. Braun, S. D. Willett, "A very efficient O(n), implicit and parallel method to solve the stream power equation governing fluvial incision and landscape evolution", *Geomorphology* 180–181:170–179, 2013.
- D. G. Tarboton, "A new method for the determination of flow directions and upslope areas in grid digital elevation models", *Water Resources Research* 33(2):309–319, 1997. https://hydrology.usu.edu/dtarb/96wr03137.pdf
- MFD (Freeman 1991; Quinn et al. 1991) and the adaptive-exponent variant as documented by ESRI: https://pro.arcgis.com/en/pro-app/3.6/help/analysis/raster-functions/flow-direction-raster-function.htm
- J.-D. Génevaux, É. Galin, É. Guérin, A. Peytavie, B. Beneš, "Terrain generation using procedural models based on hydrology", *ACM TOG* 32(4):143, SIGGRAPH 2013. https://www.cs.purdue.edu/homes/bbenes/papers/Genevaux13ToG.pdf. River graph first, terrain from the graph. Its river-type classification and carving primitives inspired §4.4.
- G. Cordonnier, J. Braun, M.-P. Cani, B. Beneš, É. Galin, A. Peytavie, É. Guérin, "Large scale terrain generation from tectonic uplift and fluvial erosion", *CGF* 35(2), Eurographics 2016. https://hal.archives-ouvertes.fr/hal-01262376
- A. Patel (Red Blob Games), mapgen4: https://www.redblobgames.com/maps/mapgen4/ and "Mapgen4: river representation" (rivers as binary trees in BFS-ordered arrays; reverse sweep accumulates rainfall): https://simblob.blogspot.com/2018/10/mapgen4-river-representation.html
- L. B. Leopold, T. Maddock, "The hydraulic geometry of stream channels and some physiographic implications", USGS PP 252, 1953. https://pubs.usgs.gov/publication/pp252
- L. B. Leopold, M. G. Wolman, "River channel patterns: braided, meandering, and straight", USGS PP 282-B, 1957. https://pubs.usgs.gov/publication/pp282B
- S. A. Schumm, "Sinuosity of alluvial rivers on the Great Plains", *GSA Bulletin* 74(9), 1963. https://pubs.usgs.gov/publication/70221081
- W. B. Langbein, L. B. Leopold, "River meanders – theory of minimum variance", USGS PP 422-H, 1966 (sine-generated curve, σ = 1/J0(θ0)); Kinoshita (1961) skewed form as used by Parker and others.
- J. T. Hack, "Studies of longitudinal stream profiles in Virginia and Maryland", USGS PP 294-B, 1957 (Hack's law). Coefficient discussion: https://www.jstage.jst.go.jp/browse/grj1925/48/2/_contents/-char/en
- R. E. Horton (1945) and A. N. Strahler (1957) for ordering and ratios. R. L. Shreve (1966) for magnitude.
- H. Seybold, D. H. Rothman, J. W. Kirchner, "Climate's watermark in the geometry of stream networks", *GRL* 44(5), 2017. https://dspace.mit.edu/handle/1721.1/119825
- K. J. Beven, M. J. Kirkby, "A physically based, variable contributing area model of basin hydrology", *Hydrol. Sci. Bull.* 24(1), 1979 (TWI).
- J. A. Downing et al., "The global abundance and size distribution of lakes, ponds, and impoundments", *Limnol. Oceanogr.* 51(5):2388–2397, 2006. https://www.caryinstitute.org/sites/default/files/public/reprints/Downing_et_al_2006_Limnol_Ocean.pdf
- M. L. Messager, B. Lehner, G. Grill, I. Nedeva, O. Schmitt, "Estimating the volume and age of water stored in global lakes using a geo-statistical approach" (HydroLAKES), *Nature Communications* 7:13603, 2016. https://www.hydrosheds.org/hydrolakes
- W. E. Galloway, "Process framework for describing the morphologic and stratigraphic evolution of deltaic depositional systems", in *Deltas, Models for Exploration*, Houston Geol. Soc., 1975, pp. 87–98. Overview: https://geo.libretexts.org/Bookshelves/Oceanography/Coastal_Dynamics_(Bosboom_and_Stive)/02%3A_Large-scale_geographical_variation_of_coasts/2.07%3A_Process-based_classification/2.7.3%3A_Classification_of_deltas
- Landlab implementations of Barnes filling, useful as a test oracle: https://landlab.readthedocs.io/en/latest/reference/components/lake_fill.html
