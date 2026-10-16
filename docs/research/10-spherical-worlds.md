# 10 — Spherical worlds: design for an optional globe

Status: design note, 2026-10-16. Nothing in `src/` was changed for this note. It describes how to add a top-level choice **World shape: Flat | Sphere** while flat stays the default and keeps producing byte-identical worlds.

It builds on PLAN.md §2 (world model), §3 (pipeline and data contracts), §7–§8 (rendering, camera), §9 (config), §14 and §18 (milestones and implementation notes), and on research 01–05 and 09. PLAN.md §1 lists the globe as a non-goal "for now" and §16 question 1 called it a later stretch goal; this note is that stretch goal made implementable.

---

## 0. Recommendation summary

| Decision | Recommendation |
|---|---|
| Sphere grid | **Equal-angle (equiangular) cube-sphere**: 6 faces of n×n square cells. Every raster algorithm we have (D8, Priority-Flood, Braun–Willett, fast sweeping, chamfer/EDT, box blur, bicubic upsample, CDLOD, texelFetch filtering, horizon march) stays a raster algorithm; only neighbours at the 4n face-edge cells change. Icosahedral or Fibonacci Delaunay meshes would mean rewriting all of them as graph algorithms and losing the GPU raster path |
| Abstraction | A **`Grid`** object that both shapes implement. **Flat is a 1-face grid with no seams**; sphere is a 6-face grid with a seam table. Hot loops keep today's shape: an interior fast path with constant offsets plus a border slow path. Flat's border path is today's edge check, so flat does not slow down |
| Metric | Per-cell area and per-neighbour distance tables, one per face position, shared by all 6 faces (4 MB at 512²). Flat returns the constants it uses today, bit for bit |
| Positions | A cell or point is `(face, u, v)` in face-local metres. Flat: face 0, u = x, v = y map metres, so every existing buffer is unchanged. The sphere adds the map `faceToSphere` (equal-angle) used identically in TS and GLSL |
| Noise | Sphere stages evaluate **3D noise on the unit vector × R** (new `Noise3`, hash lattice, no 256 period); flat keeps `Noise2` untouched |
| Default sphere | **"Small planet": circumference 4,096 km (R ≈ 652 km), 6×512² macro at ~2 km, LEM 6×256²**, ~5.3 M km² of surface, about 1.5× today's cell count and build time. An Earth-sized option (6×512² at ~20 km) is a globe overview, not a close-zoom world |
| Config | New L0 `worldShape` (flat default, absent from old URLs). On sphere `worldSize` is replaced by `planetSize` (circumference), `latitudeSpan` by `axialTilt`, and `mapEdge` disappears. AUTO formulas read an equal-area size `S_eff = √(4πR²)` |
| Rendering | 6-root CDLOD in face (u, v), heights in **`TEXTURE_2D_ARRAY` layers with border padding** so `texelFetch` filtering never leaves a layer, Proland-style camera-relative corners for precision, horizon culling, a globe camera that is the orbit camera with "pan = rotate about the planet centre", an atmosphere limb, and a **streamed regional detail map** in place of the world-wide 4096² one |
| Phasing | Phase 1 puts `Grid` behind every stage with the flat implementation only and golden hashes unchanged. Phases 2–4 add the sphere grid and stages, the globe renderer, then the remaining stages and metrics. Flat is unaffected after every phase |

---

## 1. Which grid on the sphere

### 1.1 Options

| | Cube-sphere, equal-angle | Cube-sphere, gnomonic (equidistant) | Icosahedral geodesic (hex/pent) | Fibonacci points + Delaunay (mapgen4 style) | Lat–lon (equirectangular) |
|---|---|---|---|---|---|
| Cells | 6 n×n quads | 6 n×n quads | ~10·4ᵏ hexes + 12 pentagons | N irregular Voronoi cells | 2n × n quads |
| Cell area spread (max/min) | **1.41** (centre vs edge midpoints) | ~5.2 | ~1.2 | ~1.0 (statistical) | ∞ (poles) |
| Cell shape | Squares at face centres; 1 : 0.71 rectangles at edge midpoints; 60°/120° rhombi at the 8 corners | Same topology, worse sizes | Near-regular hexagons | Irregular | Degenerate at poles |
| Neighbours | 4/8 everywhere except corner cells (7) | Same | 6 (5 at pentagons) | 5–7, variable | 8, singular at poles |
| Storage | 6 square row-major rasters | Same | Needs an addressing scheme (e.g. 10 rhombi of 2ᵏ×2ᵏ) | CSR adjacency arrays | 1 raster |
| Reuses our raster code | **Yes**: per face, with halos at seams | Yes | Partly (rhombus charts), 6-neighbour stencils differ everywhere | No: every algorithm becomes a graph algorithm | Yes, but polar cells are useless and blurs blow up |
| GPU | `TEXTURE_2D_ARRAY`, 6 layers, `texelFetch` | Same | Custom packing, hard to filter | No raster at all: vertex mesh only | One texture, pole pinching |
| CDLOD | 6 quadtrees, the existing node mesh | Same | Triangle quadtree (different mesh, morph rules) | Not applicable | Pole degeneracy |
| Used by | Proland, Outerra, many planet renderers, the FV3 climate model | Early cube maps | Climate models (ICON, MPAS) | mapgen4, Azgaar-like | Simple globes |

### 1.2 Recommendation: equal-angle cube-sphere

The reason is reuse. The generator is a stack of raster algorithms tuned over M1–M8 (research 01 §3, 02 §1–§2, 03 §2.3, 04 §1–§3), and the renderer samples rasters with hand-filtered `texelFetch` (PLAN.md §7). On a cube-sphere:

- every face is an ordinary n×n row-major raster, so per-face loops, D8 offset tables, scan-order sweeps, bicubic upsample and `texelFetch` filtering work unchanged inside a face;
- only the `4n − 4` border cells per face (0.8 % of cells at n = 512) see a different neighbour, through a seam table;
- equal-angle spacing keeps the area spread to √2 (gnomonic: ~5×), so one LEM time step, one channel threshold and one blur radius fit the whole sphere;
- grid lines continue as great circles across face edges, so a seam neighbour is a whole cell, not an interpolated value.

The icosahedral grid is more uniform but has 6-neighbour stencils everywhere, and would need new D8 tie-breaking, new Priority-Flood, new sweeps, new CDLOD meshes and a custom texture packing. Fibonacci/Delaunay is how mapgen4 does it and is pleasant for hydrology, but it has no raster for the GPU detail map, horizon pass or texture-based shading. Neither repays its cost here.

### 1.3 Geometry of the equal-angle map

Face-local coordinates `(a, b) ∈ [−π/4, π/4]²` are angles. A cell (x, y) of face f has its centre at `a = (x + 0.5)·Δ − π/4`, `b = (y + 0.5)·Δ − π/4`, `Δ = (π/2)/n`. The cube point is `F = c_f + tan(a)·e_f + tan(b)·n_f` and the unit vector is `F / |F|`, where `(c_f, e_f, n_f)` are the face's centre, right and down axes (a fixed table of 6 orthonormal triples).

With `X = tan a`, `Y = tan b`, `ρ² = 1 + X² + Y²`, the metric is:

| Quantity | Formula | Face centre | Edge midpoint | Corner |
|---|---|---|---|---|
| Area element (per Δ², × R²) | `(1+X²)(1+Y²) / ρ³` | 1 | 0.707 | 0.770 |
| Length along a (per Δ, × R) | `(1+X²)·√(1+Y²) / ρ²` | 1 | 1 (along the edge) / 0.707 (across) | 0.943 |
| Angle between grid lines | `cos θ = −XY / √((1+X²)(1+Y²))` | 90° | 90° | 60° / 120° |

So spacing varies by up to √2, cells are never worse than 1 : 0.71, and only the cells around the 8 cube corners are noticeably skewed (3 faces meet there; the corner cell has 7 neighbours, one diagonal is missing). The sum of all cell areas is exactly 4πR² (closed-form per cell via the solid angle of the four corner vectors, `Ω = 4·atan2(...)` or the spherical-excess formula; use that, not the midpoint rule, so the test in §8 holds to 1e-9).

---

## 2. The `Grid` abstraction

### 2.1 Principles

1. **Flat is a 1-face cube.** `FlatGrid` has `faces = 1`, no seams, a constant metric and map edges as its boundary. `CubeGrid` has `faces = 6`, a seam table and metric tables. There is one code path per algorithm, not two.
2. **Hot loops do not call methods per neighbour.** They read plain data off the grid (`n`, `off8`, `border`, `seam`, metric tables or constants) and keep today's structure: interior cells use constant offsets; border cells take a slow path. Today the slow path is "skip neighbours off the map"; on the sphere it is "look the neighbour up in the seam table". Every hot loop already has that branch (e.g. `edge` in `priorityFlood.ts`), so flat keeps the same instruction stream.
3. **Index layout.** Cell `i = f·n² + y·n + x`, face-major, row-major in a face, row 0 = the face's "north" (for flat: the map's north edge, as today). A `Float32Array` layer for the sphere is `6·n²` long. Flat layers are unchanged.
4. **Flat stays bit-exact.** Flat metric accessors return exactly the float64 constants the code computes today (`cellM`, `cellM²`, `cellM·√2`), and flat iteration orders and tie-breaks (heap ties by cell index, scan order y then x) are unchanged. Nothing new is multiplied in, not even `× 1.0` through a Float32 table, because a Float32 table of `cellM²` would round differently from the float64 product.
5. **Shape-polymorphic code lives outside the inner loops.** Positions, frames, lat/lon, charts and sampling are methods; they are called per stamp, per feature, per label, not per neighbour visit.

### 2.2 Interface sketch

```ts
// src/gen/grid/grid.ts (shared types could live in src/shared/grid.ts for the renderer)
export type WorldShape = 'flat' | 'sphere';

/** A point on the surface: face and face-local metres (flat: face 0, map x/y metres, y down). */
export interface SurfacePoint { face: number; u: number; v: number }

export interface GridTopology {
  readonly shape: WorldShape;
  readonly faces: 1 | 6;
  /** Cells per face edge. */
  readonly n: number;
  /** faces · n². */
  readonly cells: number;
  /**
   * D8 offsets for interior cells in the two orders the code uses today (§4.1): raster order
   * (hydro/grid8.ts) and axial-first order (grid/distance.ts). Seam tables are stored in raster
   * order; axialToRaster maps k between them. off4 = the 4 axial ones.
   */
  readonly off8: Int32Array;
  readonly off8Axial: Int32Array;
  readonly axialToRaster: Int8Array;
  readonly off4: Int32Array;
  /** 1 where a neighbour is off the map (flat) or on another face (sphere). Flat: the 4n−4 edge cells. */
  readonly border: Uint8Array;
  /**
   * Sphere only: for border cells, slot = borderSlot[i]; seam[slot·8 + k] = neighbour k, or −1
   * (missing diagonal at a cube corner). Null for flat (off-map neighbours are simply skipped).
   */
  readonly borderSlot: Int32Array | null;
  readonly seam: Int32Array | null;
  /** Neighbour k (0–7) of cell i, −1 if none. Convenience for non-hot code. */
  nbr(i: number, k: number): number;
}

export interface GridMetric {
  /** Sphere radius in metres; Infinity for flat. */
  readonly radiusM: number;
  /** Nominal spacing: flat exact; sphere at the face centre, (π/2)·R/n. */
  readonly cellM: number;
  /** True for flat: all cells have area cellM² and neighbour distances cellM / cellM·√2. */
  readonly uniform: boolean;
  /** Per face position (n² entries, identical for all faces); null when uniform. Float64. */
  readonly areaTable: Float64Array | null;
  /** Per face position × 8 neighbours, metres along the great circle; null when uniform. */
  readonly distTable: Float32Array | null;
  /** Total surface area (m²): flat (n·cellM)², sphere 4πR². */
  readonly totalArea: number;
  area(i: number): number;
  dist(i: number, k: number): number;
}

export interface GridGeometry {
  /** Cell centre as a unit vector (sphere) or (x, y, 0) map metres (flat). */
  position(i: number, out: Float64Array): void;
  /** Local frame at cell i: east, north, up (unit vectors). Flat: (+x, −y, +z) — map north is −y. */
  frame(i: number, east: Float64Array, north: Float64Array, up: Float64Array): void;
  /**
   * Latitude/longitude in degrees. Sphere: true, from the unit vector (polar axis +z).
   * Flat: virtual latitude from latitudeSpan by row (today's climate rule), longitude by column.
   */
  latLon(i: number, out: Float64Array): void;
  /** Great-circle distance (sphere) or Euclidean distance (flat) between two cells, metres. */
  distance(i: number, j: number): number;
  locate(p: SurfacePoint): number;
  point(i: number): SurfacePoint;
  /**
   * Local tangent-plane chart around a centre: visits every cell within radiusM and reports its
   * east/north offset in metres (gnomonic projection about the centre on the sphere; plain
   * offsets on flat). Stamps (craters, volcanoes, calderas, plateaus) evaluate their profiles in
   * these coordinates and therefore stay shape-agnostic.
   */
  chart(c: SurfacePoint, radiusM: number, visit: (i: number, eastM: number, northM: number) => void): void;
  /** Bilinear sample of a cell-centred field at a point; crosses seams via halos. */
  sample(field: Float32Array, p: SurfacePoint): number;
}

export interface GridBoundary {
  /**
   * Flat with mapEdge = ocean: none (the edge cells are ocean). Flat with mapEdge = continent:
   * the edge cells are outlets (water leaves the map; moisture arrives from inland).
   * Sphere: none, ever. Drainage ends at the sea or at an endorheic sink.
   */
  readonly outlets: Uint8Array | null;
  /** Value an upwind sweep uses for air arriving from outside the map (flat only). */
  readonly hasOutside: boolean;
}

export type Grid = GridTopology & GridMetric & GridGeometry & GridBoundary;

export function flatGrid(n: number, cellM: number, mapEdge: 'ocean' | 'continent'): Grid;
export function cubeGrid(n: number, radiusM: number): Grid;
/** The same world at another resolution (macro 1024² ↔ LEM 512², sphere 6×512² ↔ 6×256²). */
export function coarser(g: Grid, factor: 2 | 4 | 8): Grid;
```

### 2.3 How the hot loops look

Priority-Flood today (simplified) and with a grid:

```ts
// today: off-map neighbours skipped on edge cells
const edge = cx === 0 || cy === 0 || cx === n - 1 || cy === n - 1;
for (let k = 0; k < 8; k++) {
  if (edge && outside(cx, cy, k, n)) continue;
  const j = c + off[k];
  ...
}

// with Grid: identical for flat (seam === null)
const b = border[c];
for (let k = 0; k < 8; k++) {
  let j: number;
  if (b === 0) j = c + off8[k];
  else if (seam === null) { if (outside(cx, cy, k, n)) continue; j = c + off8[k]; }
  else { j = seam[borderSlot[c] * 8 + k]; if (j < 0) continue; }
  ...
}
```

The flat branch is the same arithmetic as today. For the sphere, only border cells pay a table lookup. Cell coordinates `cx, cy` are within a face: `cx = c % n` becomes `cx = (c % n2) % n` only in code that needs them (most hot loops do not once `border` is a precomputed byte).

Metric reads follow the same pattern: `const d = uniform ? DIST[k] * cellM : distTable[(c % n2) * 8 + k]`, hoisted so flat keeps its constants.

### 2.4 Kernels across seams

| Kernel | Flat today | Sphere |
|---|---|---|
| Neighbour-graph algorithms: Priority-Flood, D8 / stochastic receivers, Braun–Willett stack and implicit solve, accumulation, flood fills, `components`, union-find merge trees, Dijkstra plate/continent growth, `distanceField` (vector propagation) | Neighbour loop with edge checks | **Unchanged algorithm**, neighbours via the seam table, distances and areas from the metric. `distanceField` keys on the great-circle distance between the source's and the cell's unit vectors, so it is exact on the sphere |
| Separable kernels: `boxBlur`, `gaussBlur` (climate), `upsampleBicubic`, `downsampleMean`, re-anchor low-pass | Row then column passes, edges clamp | **Per face on a padded copy**: `padFace(g, a, f, r, buf)` gathers an r-cell halo from the 4 neighbour faces (rotated or flipped per the seam orientation), blurs the (n+2r)² buffer, writes back the interior. The 3 cube corners where 3 faces meet leave an r×r halo corner with no source; fill it with the mean of the two adjacent halo strips. Radii must stay ≤ n/4 (larger blurs run on `coarser(g)`). Equal-angle spacing varies ≤ √2, so a blur of r cells is r·(0.71–1)·cellM; where a physical radius matters (climate mixing in km), scale r by the local spacing or accept the variation (it is smooth) |
| Two-pass chamfer (`chamferDistance`, detail-map chamfer) | Forward and backward raster scans | Scan order is not defined across seams. Use `distanceField` (Dijkstra, O(n log n), ~3–5× slower) for the few fields that need it, or run the chamfer per face with halo exchange and repeat until no halo changes (2–3 rounds) |
| Fast sweeping (climate moisture, marine influence) | 4 diagonal Gauss–Seidel orders | The stencil already stores upwind neighbour indices (`advect.ts` `Stencil.iu/ju`), so it ports by computing them with seam-aware neighbours and converting wind into face axes. The 4 diagonal orders become one order per face per quadrant; a closed planet has circulating loops (westerlies round a latitude), handled as in §5.6 |
| Bicubic or bilinear sampling, upsampling | Clamp to edge | Halo of 2 cells per face (bicubic) |
| Scan-order RNG (`for y for x` placing things with a running RNG) | Order defines output | Face-major scan order; flat unchanged |

### 2.5 Performance argument

- **Flat runs the same instructions.** The border branch exists today; it is now driven by a precomputed byte instead of four comparisons, which is not slower. Metric constants are hoisted. Allocation is unchanged (no per-cell neighbour tables for flat: a full `Int32Array(8·cells)` would be 32 MB at 1024² and cost memory bandwidth, so it is deliberately avoided).
- **Monomorphism.** Hot functions take plain fields (`n`, `off8`, `border`, `seam`, …), not method calls, so V8 sees the same shapes whichever grid it is. Methods (`chart`, `position`, …) are used per feature, not per cell.
- **Gate.** Phase 1 adds a node benchmark (`npm run bench`, seeds 7 and 11, preview and build) that records per-stage times before the refactor; the refactor must stay within +3 % per stage and +2 % in total (median of 5 runs).
- **Sphere cost.** 6×512² is 1.5× the cells of flat 1024². Seams add ~1 % (border cells) and the padded-face copies for blurs ~5–10 % of blur time. Expect a sphere Standard build of about 1.6× a flat Standard build (~10–13 s by the M8 timings).

---

## 3. Scale and the config hierarchy

### 3.1 What "world size" means on a sphere

On flat worlds `worldSize` is the map width. On a sphere the natural size is the **circumference** `C` (radius `R = C/2π`). It is shown with the radius and the surface area read-only next to it. Circumference is preferred to radius because one face edge is `C/4`: a 4,096 km planet has faces 1,024 km across, the flat Realm's width, so users can compare.

For AUTO formulas, the size that matters is area. Define the **equal-area size** `S_eff = √A`, with `A = (worldSize)²` for flat (so `S_eff = worldSize`, formulas unchanged) and `A = 4πR²` for the sphere.

### 3.2 Size options

Face cell size is `(π/2)·R/n` at face centres (the largest cells; edge midpoints are 0.71× across the edge).

| Preset | Circumference | Radius | Surface | Land at 40 % | Face grid → cell (km) | Cells | Comparable to |
|---|---|---|---|---|---|---|---|
| Moonlet | 2,048 km | 326 km | 1.34 M km² | 0.53 M km² | 6×512² → 1.0 | 1.57 M | flat Realm (1.3× its area, same cell size) |
| **Small planet (default)** | **4,096 km** | **652 km** | **5.3 M km²** | **2.1 M km²** | **6×512² → 2.0**; High 6×1024² → 1.0 | 1.57 M / 6.3 M | flat Continent preset × 1.3 |
| Mid planet | 8,192 km | 1,304 km | 21 M km² | 8.5 M km² | 6×512² → 4.0; High 6×1024² → 2.0 | 1.57 M / 6.3 M | Africa-plus |
| Mars-like | 21,344 km | 3,397 km | 145 M km² | 58 M km² | 6×512² → 10.4; High 6×1024² → 5.2 | 1.57 M / 6.3 M | Mars |
| Earth-sized | 40,030 km | 6,371 km | 510 M km² | 204 M km² | 6×512² → **19.5**; High 6×1024² → 9.8 | 1.57 M / 6.3 M | Earth |

**Memory.** One Float32 layer is 6.3 MB at 6×512² (flat 1024²: 4.2 MB) and 25 MB at 6×1024². The worker's stage caches therefore grow 1.5× at Standard and 6× at High compared with flat Standard; the main-thread CPU copies (height, pyramids, water) grow the same way. GPU macro textures grow likewise (~1.5×: about 45 MB instead of 30 MB for the set listed in research 04 §8.2). The world-wide 4096² detail map does not carry over (6×4096² R32F would be 384 MB); see §6.7.

**What each scale is good for.**
- At ≤ 2 km cells the generator works as on flat: the LEM resolves dendritic ranges, hydrology finds lakes of ~10 km², and detail amplification bridges 250 m → 10 m as today.
- At 10–20 km cells (Mars, Earth) the macro grid only resolves continents, major ranges and continental rivers. Detail amplification cannot invent believable 1 km structure from 20 km cells (1000× to the 10 m band L). Those sizes are **globe overviews**: closest zoom about 200 m/px, bands A and L off, densities reported per band W and R only. Close zoom at Earth size would need on-demand regional re-generation (LEM + hydrology on a 1 km sub-grid around the camera), which is out of scope (open question 3).

**Recommended default: Small planet, 4,096 km circumference, 6×512² at 2 km.** It costs about 1.5× today's build, has five times the Realm's area (so more features, densities unchanged), keeps band R/A/L quality close to today's (2 km is the flat LEM's resolution), and looks unmistakably like a planet when zoomed out. Quality High (6×1024², 1 km) is the "same fidelity as flat" option at ~6× the build time. The Moonlet is the cheap same-fidelity preset, but at R = 326 km curvature is extreme (the horizon from 3 km altitude is 44 km away) and 8 km peaks are 2.5 % of the radius.

### 3.3 AUTO formulas

All formulas switch from `worldSize` to `S_eff` (identical for flat). Most then work as they are, because they were written in densities per km² (PLAN.md §4). A few grow too fast with area because flat worlds were never Earth-sized; on the sphere they saturate:

| Param | Flat rule (CONFIG.md §3, schema) | Sphere rule | Small planet | Earth-sized |
|---|---|---|---|---|
| `plateCount` centre | `5·(S/1024)^0.8·(0.7+0.6a)` | `min(flat rule, (8 + 4·log2(S_eff/2048))·(0.7+0.6a))` | [8, 11] | [17, 26] (Earth: ~15 major and minor) |
| `meanPlateDiameter` | `√(S²/plates)` | `√(4πR²/plates)` | ~760 km | ~4,800 km |
| `continentCount` centre | `1.6 + log2(S/1024) + 3(L−0.4)` | same with `S_eff`, max 12 | [2, 4] | [5, 7] |
| `rangeLength` | `[0.55, 1.2]·meanPlateDiameter` | same | [420, 910] km | [2,600, 5,800] km |
| `peakHeight` top | `+500 m per doubling of S`, cap 9,000 | same with `S_eff` | +600 m | capped at 9,000 |
| `hotspotCount` | `[0, 1 + 2a·(S/1024)^1.5]` | `[0, 1 + 2a·min((S_eff/1024)^1.5, 25)]` | [0, 4] | [0, 26] |
| `craterCount` | λ ∝ land area | same (area-weighted) | ×5 Realm | per land area (but invisible below ~20 km at Earth scale) |
| `craterDiameter` top | `40·√(S/1024)` | same with `S_eff`, cap 300 km | 60 km | 300 km |
| `moistureLength` | `1500·(S/1024)^0.4` | same with `S_eff`, cap 3,000 km | 2,000 km | 3,000 km |
| `heroCount` | [2,4] / [3,5] / [5,8] by size | `[5, 8]`, `[8, 12]` above S_eff 8,000 km | [5, 8] | [8, 12] |
| `lemGrid`, `macroGrid` | single square grid | **`faceGrid`** per face: Fast 256 / Standard 512 / High 1024; LEM face grid = half | 512 / 256 | 512 / 256 |
| `detailGrid` | world-wide 2048² / 4096² | **`detailTile`**: tile size of the streamed regional detail (§6.7) | 1024² tiles | off (overview only) |
| `seasonality` | `0.6 + 0.4·|mean latitude|/45` | `axialTilt / 23.4` | 1.0 | 1.0 |
| `glaciation` | uses the span's max latitude | uses 90° (real poles always exist), shifted by `temperatureOffset` and tilt | archetype-dependent | |
| `oceanCurrents` | on if `mapEdge = ocean` | on | | |

The sphere rules are first cuts; Phase 4 re-tunes them with the metrics harness (§7) the same way M8 tuned the flat ones.

### 3.4 Shape-specific parameters

| Param | Flat | Sphere | Notes |
|---|---|---|---|
| `worldShape` (new, L0 enum) | flat | sphere | `stage: 'plates'`. Default flat; omitted from URLs when flat, so every old link resolves unchanged |
| `worldSize` (km) | shown | hidden | |
| `planetSize` (new, L0, circumference km, log slider 2,048–40,030, stops at the presets) | hidden | shown, with radius and area read-only | AUTO ← archetype bias (4,096) |
| `latitudeSpan` | shown | hidden | The full globe has every latitude |
| `axialTilt` (new, L0, 0–45°, default 23.4°) | hidden | shown | Sets seasonality and the seasonal band shift (`±5°·tilt/23.4`, research 03 §2.2) |
| `mapEdge` | shown | hidden | No edge |
| `latitudeWarp`, `windNoise` | shown | shown | Unchanged meaning |
| `windOverrideAngle` | angle from map north | angle from **local** north (rotates every wind vector) | Same param, help text differs |
| `oceanCurrents` | AUTO ← mapEdge | AUTO on | |
| `lemGrid`, `macroGrid`, `detailGrid` | shown | hidden | |
| `faceGrid`, `detailTile` (new, L3) | hidden | shown | |
| Everything else | shown | shown | AUTO formulas read `S_eff` |

Implementation: `ParamDef` gains `shapes?: readonly WorldShape[]` (absent = both). The panel hides rows whose `shapes` excludes the current shape; the resolver still resolves them (with flat values) so `deps` stay a DAG, and the URL codec drops pins on hidden params only when writing a sphere URL. Archetypes gain optional sphere biases (e.g. Fjordland: `axialTilt` 28°, larger polar land share via a continent-latitude bias).

Byte-identity check: the RNG for stages is `rngFor(seed, stageId, …)` and draw ranges use `rngFor(seed, 'config', paramId)` (`pipeline.ts`, `resolve.ts`), so adding params does not move any flat draw. The stage cache key includes the params a stage reads; adding `worldShape` to the reads changes cache keys, not outputs.

---

## 4. Inventory: where the code assumes a square raster

Counts come from a grep pass over `src/` and `metrics/`, with the hot files opened and checked (2026-10-16). They are approximate **code-line counts**, not exact occurrences. Columns:

- **nbr**: neighbour index arithmetic (`i±1`, `i±n`, `x±1/y±1` loops, D8 tables, `x = i % n` decoding);
- **edge**: map-edge handling (`x === 0`, `n − 1`, clamps, "off-map is ocean / outlet");
- **sep**: separable kernels and row/column passes (blurs, resamplers);
- **dist**: distance transforms (chamfer, EDT, BFS distance);
- **fill**: flood fills, components, BFS labelling, union-find, Dijkstra growth;
- **sweep**: directional sweeps (fast sweeping, row sweeps, scan-order chamfer);
- **other**: km-per-cell constants, constant cell area, latitude from y, planar noise, planar (x, y) outputs, RNG tied to scan order.

### 4.1 Conventions found everywhere

- Fields are `n·n` typed arrays, row-major, `i = y·n + x`, y grows **south**, cell centres at `(x + 0.5)·cellKm`. Index decoding (`x = i % n`) is in ~25 files (heaviest: `coast/barriers.ts` 19, `glacial/glaciate.ts` 14, `coast/reefs.ts` 13).
- `cellKm = worldKm / n` is one constant per grid; cell area is `cellKm²` everywhere.
- **Seven copies of the D8 table in two orders**: "raster" `DX = [−1,0,1,−1,1,−1,0,1]` (`hydro/grid8.ts`, `lem/streamPower.ts`, `grid/priorityFlood.ts`) and "axial first" `[1,−1,0,0,1,1,−1,−1]` (`grid/distance.ts`, `stages/plates.ts`, `landforms/profiles.ts`, `landforms/coast/grid.ts`, `registry/grid.ts`). The order sets tie-breaks, so Phase 1 must keep each module's order (the `Grid` exposes both, as `off8Raster` and `off8Axial`).
- `Noise2.fbm(x, y)` on planar km at ~20+ call sites; nothing is toroidal.
- Positions in outputs are map metres from the west and north edges: `Layer {w, h, worldKm}`, `RiverGraph.x/y`, `LakeInfo.cx/cy`, `Landmark.x/y/angle/path`.
- `mapEdge` is read in plates (continent margin and edge cost), stamps (edge cells become fixed outlets, `stamps.ts:145`) and climate (boundary inflow). Priority-Flood seeds only from `fixed`, so the open edge works through `fixed`, not through explicit border seeding.
- RNG tied to index or scan order: refine jitter, LEM stochastic receivers, `placeLakes` `rng.int(N)`, routing `jitter` (`hashMix(seed, i)`), and karst, coast and volcanic candidates collected in scan order. These are reproducible on the sphere with a fixed index scheme; flat must keep its order.
- Resolutions that coexist: plates 256², LEM 512², macro 1024², the climate sweep grid (macro / f, ≥ 2 km), the climate wind lattice (≤ 8 km), landform and registry coarse grids (~4 km block means), and coast block means. Every resampler assumes a power-of-two factor on one square with clamped edges.

### 4.2 Generation (`src/gen/**`)

| Group | Files (functions) | nbr | edge | sep | dist | fill | sweep | other | Effort |
|---|---|---|---|---|---|---|---|---|---|
| **Shared helpers** | `grid/ops.ts` (`boxBlur`, `blurLine`, `components`, `chamferDistance`), `grid/priorityFlood.ts` (`priorityFloodEpsilon`), `grid/distance.ts` (`distanceField`, `signedDistance`), `grid/upsample.ts` (`upsampleBicubic`, `downsampleMean`), `grid/sample.ts` (`cellAt`, `bilinear`), `hydro/grid8.ts` (`DX/DY/DIST/offsets/outside`) | 34 | 34 | 6 | 5 | 12 | 3 | 6 | **M, 3–5 d** |
| **Plates** | `stages/plates.ts` (`growPlates`, `growContinents`, `nearOtherContinent`, `boundaryFrame`, `randomMotion`, `classify`, `spacedPoints`) | 17 | 12 | 0 | 2 | 3 | 0 | 39 | **L, 4–6 d** (Euler poles, spherical seeding) |
| **Base** | `stages/base.ts` (`landBase`, `oceanProfile`, `placeKing`, `belt`, `plateau`, `segProps`, `quantileOfNoise`) | 2 | 6 | 5 | 2 | 0 | 1 | 35 | **M, 2–4 d** (~15 planar `fbm` calls) |
| **Stamps** | `stages/stamps.ts` (`stamp`, `pickPoint`) | 1 | 5 | 0 | 0 | 0 | 0 | 34 | **S, 1–2 d** |
| **LEM + refine** | `lem/streamPower.ts` (`FlowRouter`, `runLem`, `incise`, `diffuse`, `talusClamp`, `rimMask`, own `offsets`/`outside`), `stages/lem.ts` (`lemStage`, `refineStage`, `erode`) | 23 | 18 | 0 | 0 | 10 | 0 | 29 | **M, 2–4 d** |
| **Climate** | `climate/model.ts` (`computeClimate`, `sweepGrid`, `sweeps`, `coarseWind`; latitude from y), `climate/advect.ts` (`buildStencil`, `advectMarine`, `advectMoisture`), `climate/currents.ts` (`sstAnomaly`: **east/west row sweeps**), `climate/fields.ts` (`gaussBlur`, `downsample`, `upsample`, `boxH/boxV`, `coarseFbm`, `warp`), `climate/wind.ts`, `stages/climate.ts` | 11 | 29 | 16 | 3 | 0 | 14 | 87 | **L, 5–8 d** (sweep order, east–west marching, wind frame) |
| **Glacial** | `glacial/glaciate.ts` (`troughSources`, `fjordSources`, `smoothLine`, `floodSea`, `iceCover`), `glacial/corridor.ts` (`corridorCarve`, `softenCarve`), `glacial/flux.ts` (already graph-only), `glacial/repair.ts`, `stages/glacial.ts` | 24 | 31 | 2 | 0 | 3 | 1 | 33 | **M, 2–4 d** (capsule carving across seams) |
| **Landforms** | `landforms/profiles.ts` (the landform grid library: `cellOf`, `forDisk`, `stampRadial`, `DiskSet`, `coarseNoise`, `coarsen`, `settleFixed`, `regions`, `poisson`, …), `arid.ts`, `volcanic.ts`, `karst.ts`, `impact.ts`, `coastal.ts`, `stages/landforms.ts` | 20 | 38 | 3 | 2 | 2 | 3 | 130 | **M–L, 3–5 d** (`chart` makes most of it shape-agnostic) |
| **Landforms: coast** | `coast/grid.ts` (`chamferNearest`, `components8`, `line4`, `DiskSet`, `blockMeanList`, `boxBlurSmall`), `coast/classify.ts` (fetch rays, summed-area table, "off-map is open sea"), `coast/barriers.ts`, `coast/reefs.ts`, `coast/cliffs.ts`, `coast/rias.ts`, `coast/fixed.ts` | 92 | 55 | 3 | 1 | 16 | 6 | 126 | **L, 4–6 d** (densest neighbour arithmetic; fetch rays and `line4` must cross seams) |
| **Hydro** | `hydro/depressions.ts` (`buildHierarchy`; spill pairs `i+1`, `i+n±1`), `placeLakes.ts`, `geometry.ts` (`channelCells`, `buildRivers`, `chaikin`: polylines in map metres), `routing.ts` (`jitter`, `route`, **`uncross` over 2×2 blocks**, `accumulate`), `wetness.ts`, `breach.ts`, `deltas.ts`, `graph.ts`/`network.ts`/`metrics.ts`/`meander.ts`/`budget.ts` (mostly graph-only), `stages/hydro.ts` | 80 | 53 | 0 | 2 | 28 | 6 | 113 | **L, 5–7 d** |
| **Biome** | `climate/biomes.ts` (`classifyBiomes`, `majority` 3×3, river-mouth `i±1`/`i±n`), `stages/biome.ts` | 12 | 11 | 3 | 0 | 0 | 0 | 16 | **S, ~1 d** |
| **Registry** | `registry/grid.ts` (`label`, `mergeTree`, `cellAtM`, `blockMean`, `pca`, `labelAngle`, `insideDistance`, `nearestWhere`, `alongPolyline`), `water.ts` (**ocean = largest water body touching the map edge**, `embayments`, `detectFjords`), `relief.ts`, `land.ts`, `rivers.ts`, `fill.ts`, `regions.ts`, `shared.ts`; rank, budget, names and traits are grid-free | 48 | 27 | 3 | 19 | 32 | 37* | 137 | **L, 5–8 d** (*mostly rank sorts) |
| **Pipeline + protocol** | `pipeline.ts`, `gen.worker.ts`, `inThread.ts`; contracts in `shared/protocol.ts`, `shared/landmarks.ts` | 0 | 0 | 0 | 0 | 0 | 0 | ~9 | **M, 2–3 d** |
| **Total `src/gen`** | ~60 files | **~364** | **~349** | **~41** | **~36** | **~106** | **~71** | **~734** | **≈ 40–60 days** |

Choke points (non-test importer counts): `grid/ops.ts` 18 (`chamferDistance` 7, `boxBlur` 4, `components` 3), `registry/grid.ts` 8, `landforms/coast/grid.ts` 7, `grid/heap.ts` 6 (not grid-bound), `hydro/grid8.ts` 5, `climate/fields.ts` 5, `landforms/profiles.ts` 4, `grid/distance.ts` 2, `grid/priorityFlood.ts` 1 (+2 through `FlowRouter`). Putting these nine modules on `Grid` first covers Priority-Flood, the LEM, routing and most fills. Climate advection, the coast set and the registry's planar geometry are the long poles.

### 4.3 Rendering, input, UI and metrics

Column key here: **tex** texel or neighbour arithmetic, **edge** map-edge handling, **plan** planar world coordinates (`size − y` flips, `uv = w/size`, z up), **cam** camera assumptions, **lod** CDLOD, **pos** features placed in map xy.

| Group | Files (functions) | tex | edge | plan | cam | lod | pos | Effort |
|---|---|---|---|---|---|---|---|---|
| **Terrain / CDLOD** | `terrain/cdlod.ts` (one root `(0, 0, size)`, `visit`, `boxInFrustum`), `terrain/terrainPass.ts` (`HEIGHT_GLSL`, VS/FS, `gradients`, `coverMasks`, uploads; the uv formula ×9, z-up lighting), `worldView.ts` (`maxDepth`, `FlatGround`, screen-relative sun) | ~30 | 5 | ~21 | 4 | ~8 | — | **L, 6–9 d** |
| **Height sampling** | `heightField.ts` (min/max pyramid, `raycast` in the slab [0, size]²), `height/heightFn.ts` (TS port: `HeightFn`, `DetailGround`, a planar 2D noise lattice with 65,536 m tiles), `glsl/detail.ts` (`NOISE_GLSL`, `DETAIL_GLSL`) | ~40 | 7 | ~19 | 2 | — | — | **M–L, 4–6 d** |
| **Detail map** | `terrain/detail/detailMap.ts` (1,531 lines: `prepareDetail`, `riverSegments`, `chamfer`, `buildControl`, GPU passes carve/base/thermal/hydro/low-pass/anchor/pack, CPU fallback; one world-wide D² texture) | ~60 | ~10 | ~12 | — | — | segments | **L, 7–10 d** |
| **Camera + input** | `camera/orbitCamera.ts` (~35 functions: plane picks, planar pan, `fitWorld`, clamps to [−m, s+m], near/far from the 4 world corners), `camera/ground.ts`, `input/orbitController.ts` (planar `panBy`), `camera2d.ts`, `input/cameraController.ts` | — | 7 | ~15 | ~35 | — | — | **L, 5–8 d** |
| **Lighting** | `lighting/horizon.ts` (horizon and 8-direction AO march, stops at the raster edge, rebaked per 1.5° of sun azimuth), `lighting/sky.ts` (`up = d.z`, "beyond the world edge") | 6 | 1 | 4 | — | — | — | **M, 3–5 d** |
| **Water** | `water/rivers.ts` (vertices `(x, worldM − y, z)`, planar side vector), `water/creeks/creekGen.ts` (D8 tables, 3×3 loops, "outside the map = ocean"), `water/creeks/creekManager.ts` | ~29 | 2 | ~4 | 3 | — | many | **M, 3–5 d** |
| **Labels** | `labels/labelEngine.ts` (`worldM − y` ×3, map-plane angles, clamps), `labels/projector.ts` (duplicates the z-up basis); the other label files are screen-space | — | 2 | 5 | 3 | — | 5 | **S–M, 2–3 d** |
| **Minimap, 2D viewer, inspector** | `minimap.ts` (square thumbnail, footprint from `planeHit`), `rasterView.ts` (unit square × worldKm), `main.ts` (`flyTo(x, size − y)`, `nearestLandmark` by `hypot`, `fitView`) | ~10 | 1 | 5 | 1 | — | 3 | **M, 2–4 d** |
| **Config / URL** | `shared/config/schema.ts` (11 flat-only params, 11 that scale with `worldSize`), `resolve.ts` (`checkWarnings` uses `worldSize²`), `archetypes.ts` (biases `latNorth`, `latSouth`, `mapEdgeContinent`, `worldSize`); `url.ts`, the panel and the slider are generic | — | — | — | — | — | — | **S–M, 1–3 d** |
| **Protocol** | `shared/protocol.ts`, `shared/landmarks.ts` (§5.12) | — | — | — | — | — | 4 | **S–M, 1–2 d** |
| **Metrics** | `metrics/world.ts` (`sampleBand`: axis-aligned rectangles clamped to the map, land area = cells × cellKm², planar `hypot`), `metrics/lib/math.ts` (square `components`, separable `edtSquared`, `boxCountDimension`), `metrics/targets.ts` (bands), `runner.ts`, `aggregate.ts` (size sweep by `worldKm`) | ~14 | 2 | ~8 | — | — | — | **M, 2–4 d** |
| **Total** | | **~200** | **~40** | **~90** | **~45** | **~10** | **~25** | **≈ 36–59 days** |

Already shape-agnostic: `gl/util.ts`, `math/mat4.ts`, `colormaps.ts`, `biomeLut.ts`, the label atlas, SDF, layout and placement, `OrbitController` (it only calls camera methods), the compass, the Atlas UI, the config panel, the range slider, the URL codec, and the metrics statistics functions.

### 4.4 What the counts mean for the plan

There are about 2,000 flagged lines across ~85 files. Most of the **nbr**, **edge** and **fill** lines collapse into the ~9 shared modules once those take a `Grid` (Phase 1). The **other** column is mostly per-feature geometry (km positions, planar noise, latitude), which `chart`, `Noise3` and `latLon` absorb in Phases 2 and 4. The genuinely new algorithms are few: the climate sweep order, east–west current marching, coast fetch rays, `uncross` at cube corners, and the registry's "world ocean" rule. The total for everything is roughly **75–120 working days** (gen 40–60, render/UI/metrics 36–59), which matches the phase estimates in §8 (about four milestones of M1–M3 size).

---

## 5. Per-stage changes in sphere mode

Common tools used below: `Grid` (§2), `Noise3` (3D gradient noise on a hashed integer lattice, evaluated at `unit·R/λ`; no 256-cell period, which a 40,000 km circumference at 14 km wavelength would hit 11 times over), `grid.chart` for stamps, area-weighted statistics (`weightedQuantile`, area sums), and Poisson-disk sampling on the sphere (rejection with great-circle distance, candidates from area-uniform random unit vectors).

### 5.1 S1 Plates

- **Seeds**: Poisson-disk on the sphere with the plate count from §3.3.
- **Growth**: the noise-weighted priority-queue flood fill is graph code, so it runs on `CubeGrid` neighbours unchanged; costs use `dist(i, k)`. Continents grow the same way. The "coarse ownership blocks" that keep a ~100 km gap become the cells of `coarser(g, 8)` (6×64² at Standard), with block adjacency from the coarse grid's seam table.
- **Motion: Euler poles.** Each plate gets an angular velocity vector `ω_p` (a random pole, uniform on the sphere, and a rate giving 1–8 cm/yr at 90° from the pole, scaled by activity). Surface velocity at unit vector `p` is `v = ω_p × p·R`. This replaces today's translation + small rotation about the plate centroid (`randomMotion`, `classify`), which is a planar approximation of the same thing.
- **Boundary classification**: relative velocity `v_p − v_q` projected onto the boundary normal and tangent in the local frame (`frame(i)`); the convergent / divergent / transform classes and their thresholds are unchanged.
- **Best-of-N** scoring is unchanged (it counts ranges and rifts).
- **Distance fields**: `distanceField` with great-circle keys.
- There is no "plates touch the region boundary" case: every plate is closed.

### 5.2 S2 Base elevation and sea level

- Warped continent signed distance: `signedDistance` on the grid, domain warp with `Noise3`.
- Shelf, slope and abyss profiles, trenches, ridges, rifts: they are functions of distance, unchanged.
- Uplift `U` per boundary segment, erodibility `K`, provinces: unchanged apart from noise and distance calls.
- **Sea level**: the histogram quantile for the land fraction must be **area-weighted** (`weightedQuantile(h, areaTable, 1 − L)`), because cells differ by up to √2 in area. Flat keeps the unweighted `quantile` (its weights are all equal, and the unweighted code path keeps it byte-identical).
- The ~10 km and ~18 km blurs use `padFace` blurs.
- No map-edge ocean ramp.

### 5.3 S3 Pre-LEM stamps

Hotspot chains follow the plate's Euler motion (track = small-circle arc about `ω_p`, ages increasing backwards). Arc volcanoes and old craters are placed by Poisson-disk on the sphere. Every stamp is evaluated in `grid.chart(centre, radius)` east/north metres, so the stamp profiles (`profiles.ts`) are untouched. `mapEdge`-dependent rules (`openEdge` in `stamps.ts`) are skipped.

### 5.4 S4 LEM and S5 Refine

- **Priority-Flood** seeds are the ocean cells only. If a world has no ocean, the lowest cell seeds an endorheic basin (which then becomes a sea or salt lake in hydrology). There are no edge outlets.
- **Receivers and stochastic receivers**: slope = Δh / `dist(i, k)`.
- **Drainage area** = Σ upstream `area(j)` (today: count × cellM²). Rain-weighted as today.
- **Implicit stream-power solve**: `h_i = (h_i + F·h_r) / (1 + F)`, `F = K·Δt·A^m / dist(i, r)`. Same algorithm, per-cell `L`.
- **Hillslope diffusion**: a finite-volume Laplacian `Σ_k (h_k − h_i)·w_ik / area_i` with face-edge lengths over centre distances (`w_ik`), precomputed per face position. The stability rule c ≤ 1/8 (PLAN.md §18 M2) uses the smallest spacing (0.71·cellM), so diffusion takes ~2× the sub-steps of a flat grid of the same nominal spacing.
- **Talus clamp**: per-neighbour distance.
- **Refine**: `upsampleBicubic` per face with a 2-cell halo; 27 more iterations as today; strata terracing unchanged.
- **Sea-level rise**: unchanged.
- Calibration (`RELIEF_CALIBRATION`) is re-measured on a sphere strip test (it should not change, as the metric is local).

### 5.5 S5b Continents and islands (inside refine)

Continent detection uses `components` on the grid. On a sphere the "world ocean" is not "water touching the map edge" but the **largest connected water body**. Islands are components below 5 % of land area, as today, measured in area, not cells.

### 5.6 S6 Climate

- **Latitude is true**: `lat = asin(p.z)` from the cell's unit vector, then the ±3° warp (`latitudeWarp`, 3D noise). `latitudeSpan` and "climate compression" do not apply.
- **Seasons** shift bands by `±5°·axialTilt/23.4`.
- **Wind bands** (research 03 §2.1) are given as (east, north) components and turned into face axes through the cell frame: `g = (w_e·east + w_n·north)` projected onto the face's grid directions. Wind noise uses `Noise3`.
- **Advection stencil**: `buildStencil` already stores upwind neighbour indices `iu, ju` and weights; build them with seam-aware neighbours. The divergence-line cut (`isSrc`) is unchanged. There are no map-boundary sources; `sources` only contains divergence-line cells, which take a "from aloft" value (e.g. `q = 0.35·C(T)`).
- **Sweep order on a closed surface**: the four diagonal orders per face are no longer a global order, and the westerlies form closed loops round each hemisphere. Replace the 4-quadrant order with a **topological order of the upwind graph** (each cell has ≤ 2 upwind parents), computed once per wind field by DFS; back edges that close a loop are cut and those cells read the previous round's value. Then sweep that order for rounds until `max|Δq| < 1e-3`, as today (`MAX_ROUNDS = 4`). Convergence is fast: over the sea humidity relaxes to its target within `L_EVAP` = 300 km, and over land it depletes with `L_RAIN` = 1,500 km, so a loop round a 4,096 km planet loses all memory within one or two rounds. Flat keeps its current order (the topological order would also be valid there, but would change the bits).
- **Ocean currents**: warm western-boundary and cold eastern-boundary anomalies use the local east vector instead of map +x. A sphere has western boundaries on every ocean, which is closer to Earth than the flat map.
- **Mixing blurs** (σ 8–35 km) are `padFace` Gaussian blurs; on the Small planet (2 km cells) the radii are 4–18 cells, well inside the n/4 limit.
- **Sweep grid**: the climate runs on a ≥ 2 km grid today (`SWEEP_KM`); on the sphere it runs on `coarser(g)` when the face grid is finer than that.
- **Lapse rate, PET, aridity, Köppen variables**: unchanged.

### 5.7 S7 Glacial

ELA from climate (unchanged). Ice flux along drainage uses the receivers. U-trough distances to smoothed centrelines use `distanceField` (geodesic). Fjord flooding is "4-connected to the sea" via `components` with seams. Repair erosion is the LEM. Polar caps now exist on every sphere at moderate glaciation: worth a cap on ice-sheet area so default worlds are not half ice (tune in Phase 4).

### 5.8 S10 Landforms

All families (volcanic, impact, arid, karst, coastal) place by Poisson-disk on the sphere and stamp in `chart` coordinates. Coastal classification uses exposure (fetch) rays: march great circles from the coast point via `grid.sample`/neighbour steps instead of straight lines in x/y. The coast grid (`landforms/coast/grid.ts`) is its own raster helper and needs the seam-aware neighbour iteration. Dune orientation reads wind in local east/north. Snapshot/`settleFixed` (full ocean-mask rebuild) uses `components`.

### 5.9 S8 Hydrology

- Pit breaching, depression hierarchy, water balance: graph code over grid neighbours; areas from the metric.
- **No outlets**: every river ends at the sea, a lake or a dry sink (the PLAN.md §3 invariant becomes simpler: there is no "drains off-map").
- Jittered D8 with uncrossing: the uncrossing test looks at the 2×2 block of a diagonal; at seams the block may span two faces (handled through the seam table) and at the 8 corners the missing diagonal is simply not a candidate.
- Accumulation: area weights.
- River graph geometry, meanders, monotone re-imposition, deltas, wetlands (TWI with area and slope from the metric): river node positions become `(face, u, v)` (§5.11).
- Channel threshold `A₀ = 8 km² / riverDensity²` is an area, so unchanged; at 2 km cells the smallest channels start at 2 cells.

### 5.10 S9 Biomes

Ordered rules and overrides are per cell: unchanged. The 3×3 majority filter uses grid neighbours (corner cells: 7 neighbours).

### 5.11 S11 Registry and names

- **Union-find merge tree** (peaks, seas, straits, isthmuses): neighbour iteration over the grid; unchanged otherwise. Prominence works the same; on a sphere the king summit's prominence is its height above the global ocean (no edge col).
- **Seas on a closed surface**: on flat, "the ocean" is water connected to the map edge and seas are enclosed parts of it. On a sphere, the largest water body is the **world ocean**. It is split into named **oceans** by the same basin-enclosure merge at a planetary scale (merge threshold ~0.3·`S_eff`): the narrowest passages between continents become ocean boundaries. Seas, gulfs and bays then nest inside oceans as today.
- **Continents**: the same rule as refine; on a sphere every continent is complete (no edge-cut continents).
- **Ray-enclosure tests** (gulfs, bays) march great circles.
- **Peninsulas and capes**: morphological opening = blur/erode with `padFace`.
- **Ranking**: `maxMpp = footprint / 23 px` unchanged.
- **Names**: seeded by "quantised identity position". Use the quantised unit vector (or `(face, u, v)` quantised) for the sphere; flat keeps map x/y.
- **Hero spacing** "at least a quarter of the world width apart" becomes "at least 0.25·`S_eff` great-circle distance".
- **Label positions**: `Landmark.x/y` stay map metres on flat. On the sphere they carry `face` plus face-local metres, and the shared helper converts to lat/lon (for the inspector and Atlas: "62.4° N 14.1° E") and to 3D. Paths (rivers, ranges, fjords) become per-node `(face, u, v)`; a path that crosses a seam is split at the seam for curved-label layout.

### 5.12 Protocol and data contracts

| Item | Flat today | Addition for the sphere (absent for flat, so flat buffers are unchanged) |
|---|---|---|
| `Layer` | `w, h, worldKm`, row-major | `faces?: 6` (data is `6·w·w`, face-major), `radiusKm?` |
| `RiverGraph.x/y` | map metres | `face?: Uint8Array`; x/y become face-local metres |
| `LakeInfo.cx/cy`, `Landmark.x/y/angle/path` | map metres, angle in map axes | `face?`; angle in the face's axes (converted to local north for display) |
| Header | — | `shape: WorldShape` in the `stage-done` message for plates |

---

## 6. Rendering and camera in sphere mode

### 6.1 Terrain: 6-root CDLOD on the sphere

- **Six quadtrees**, one per face, in face (u, v). The node mesh (33×33, instanced, one draw) and the geomorph code are reused; only the vertex placement changes: `p = faceToSphere(face, uv)·(R + h·exag)`.
- **Seams are crack-free** because the equal-angle subdivision of neighbouring faces lines up along the shared edge (both faces' nodes at level ℓ split the edge at the same points), so the CDLOD rule "neighbouring LODs differ by ≤ 1, odd vertices morph onto the parent grid" holds across seams exactly as within a face. Heights at edge vertices come from padded textures (§6.2), so both faces read the same texels.
- **Bounds**: per-node min/max height pyramids per face. The node's bounding volume is the box spanned by its 4 corner directions × (R + min h) and × (R + max h) (an OBB in the node's tangent frame), used for both frustum and LOD distance.
- **Selection**: Strugar's range test with the 3D distance from the eye to that box, as today.
- **Horizon culling**: a node is hidden when all of its box is below the horizon of the sphere of radius `R + h_min(world)`: for a point P, occluded if `dot(P − E, E) > 0` fails the cone test `|E|² − R_o² < dot(E, P) ...` (Cesium's "horizon culling point" against an occluding sphere; one test per node with a precomputed culling point). This removes the far side of the planet, roughly half of all nodes at globe zoom.
- **Root node ranges**: at globe zoom the whole planet is ~6–24 nodes; at band L the leaf spacing is ~16 m as today (CDLOD depth = log2(face size / (32·16 m)) = 11 for a 1,024 km face).

### 6.2 Textures: arrays with border padding

- Every macro raster is a **`TEXTURE_2D_ARRAY`** with 6 layers of `(n + 2p)²` texels, `p = 2` (bicubic needs 2). The border texels hold the neighbour face's cells (rotated to this face's axes), filled on the CPU when uploading. Corner padding (where 3 faces meet) holds the mean of the two adjacent strips, as for blurs.
- Hand-filtered `texelFetch(tex, ivec3(xy + p, face), 0)` then never leaves the layer, so the existing bilinear and Catmull-Rom code works with one added `+p` and the face index.
- Formats are those of research 04 §8.2 (R32F heights and water, RGBA8 masks, RGBA16F climate, RG16F gradients with CPU-built mips — mips per layer, each padded).
- The CPU `HeightField` becomes 6 padded faces with per-face pyramids; `bilinear`, `rangeOver` and `raycast` take a face.

### 6.3 Precision at planet radius

Positions of ~6.4e6 m (Earth) or 6.5e5 m (Small planet) are too large for float32 vertex maths at 10 m/px (f32 ulp at 6.4e6 m is 0.5 m, and `dir(uv)·R` amplifies direction rounding of ~6e-8 into ~0.4 m). Two regimes, as in Proland:

- **Large nodes** (node size > R/64, i.e. at globe and region zoom): compute `dir(uv)` in the shader in float32 and subtract the eye (planet-centred, uploaded as hi/lo float pairs). Errors of ~0.4 m are far below a pixel at these zooms.
- **Small nodes**: the CPU computes the node's 4 corner positions **relative to the eye in float64** and uploads them as float32 (plus the 4 corner normals). The shader interpolates the corners bilinearly and adds the sagitta correction (the exact sphere-minus-plane offset over the node, a small, well-conditioned number) and `h` along the interpolated normal. Shared corners of neighbouring nodes are identical numbers, so no cracks.

Noise for detail amplification uses `Noise3` at `unit·R`; per-octave offsets are computed in float64 on the CPU for the camera position, exactly like research 04 §1.6's 2D trick, so arguments stay small. A 3D lattice costs 8 corners instead of 4 per octave; footprint fading already drops most octaves at far zoom, so the FS cost rises ~1.3–1.6× only near the surface. Alternative if that is too slow: 2D noise in the node's local tangent coordinates with a 64 km tile and a blend across tile and face boundaries.

Depth: reversed-Z with infinite far as today. Without `EXT_clip_control`, the far plane is the horizon distance `√((R+alt)² − R²)` plus the max height margin.

### 6.4 Globe camera

The globe camera keeps `OrbitCamera`'s public API (`zoomAt`, `pinchAt`, `panScreen`, `dragTo`, `rotateBy`, `flyTo`, `pick`, `metresPerPixel`, …) so `OrbitController`, the compass, labels and the minimap work unchanged.

- **State** (float64): target as a unit vector plus height, distance, pitch, bearing relative to local north.
- **Frame**: east/north/up at the target. Near the surface this is exactly the flat orbit camera in the tangent plane.
- **Pan = rotation about the planet centre.** Grab pan: at pointer-down hit the terrain (or the sphere of radius R + target height) at G; on move intersect the new ray with the same sphere and rotate the target about `G × hit` by the angle between them. At low altitude this is indistinguishable from today's plane pan; at globe zoom it spins the planet under the cursor. Trackpad pan: rotate by `(dx, dy)·metresPerPixel / R` about the camera's right and up axes.
- **Zoom to cursor**: ray–sphere against `R + h_max`, then march the terrain (per-face pyramids, stepping across faces) and bisect with the TS height function, as research 04 §7.2. The homothety about the hit point works in 3D unchanged; afterwards the target is re-seated on the surface along the view ray and the frame re-derived. Missing the planet: zoom about the point of closest approach.
- **Bearing near the poles**: bearing is relative to local north, which is undefined at the poles. Keep north-up only while |lat| < 85°; inside that cap, transport the frame (parallel transport of the previous east vector) so the view does not spin.
- **Limits**: `maxDistance` fits the globe (`R / sin(fov/2) · 1.15`). Auto-tilt is 0 above ~0.5·R altitude and follows today's curve below 200 km. Pitch is limited so the view never looks above the horizon by more than ~10°.
- **Flights**: `flyTo` interpolates along the great circle with van Wijk–Nuij altitude.
- **Blend**: there is no mode switch. The same camera is a globe camera far out and the old orbit camera close in, because the tangent-frame orbit is what "close in on a sphere" means.

### 6.5 Lighting, horizon shadows and AO

- **Sun**: today the cartographic sun is screen-relative (azimuth = bearing − 45°). Keep that as the default on the globe at close zoom (it is what makes the hillshade read), but blend to a world-space sun with a day/night terminator at globe zoom (where hillshade is invisible anyway).
- **Horizon bake per face**: the horizon march (40 geometric steps, up to ~1,000 texels) is too long for halos. March on the sphere in the shader instead: step in face (u, v), and when a step leaves the face, map it through a `wrapFace(face, ivec2) → (face', ivec2')` GLSL function (a 6×4 table of rotations), reading the texture array. Add the curvature drop `d²/(2R)` to each sample's horizon angle (at R = 652 km, 20 km away the ground is 307 m lower).
- **Bake once, not per sun change**: on the globe the local sun direction differs per texel and changes as you pan, so per-sun bakes would re-run constantly. Bake **directional horizon angles for 16 azimuths** once per world (16 × R8 per texel, ~25 MB at 6×512² padded) and evaluate `smoothstep(sunElevation − horizon(azimuth))` per pixel. AO comes from the same angles. This also works on flat and could replace the per-sun bake there later (shared code).

### 6.6 Atmosphere, water, rivers, creeks, labels

- **Atmosphere limb**: a screen-space pass for pixels whose ray misses or grazes the planet, with an analytic single-scattering approximation (ray–sphere against an atmosphere shell of ~1.5–2.5 % of R, Rayleigh colour, optical depth by chord length). The existing sky gradient and haze are what it converges to close in; `sky.ts`'s `up = d.z` becomes the local radial.
- **Water lid**: `max(h, waterLevel)` per vertex as today; the FS uses the local up vector for Fresnel and normals.
- **Rivers and creeks**: ribbons are built in face (u, v) and placed with the same `faceToSphere` and node-relative precision scheme as the terrain; the side vector is the local tangent, the lift is radial. Creeks are per macro cell (deterministic), so `creekGen` needs seam-aware neighbours; the manager's visible set comes from the 4 corner rays hitting the sphere.
- **Far-side culling**: rivers, creeks and labels are culled when `dot(up(p), eye − p) < 0` (back-facing) or when below the horizon of the occluding sphere (§6.1); labels keep their terrain-occlusion raycasts.
- **Labels**: anchors are (face, u, v) → 3D; rotated labels use the angle in the local tangent frame; `projector.ts` should take the camera's matrices instead of re-deriving the z-up basis.

### 6.7 Close-zoom detail map: streamed per region

The flat world builds one world-wide 4096² detail map (250 m, 64 MB plus 3× scratch). On the Small planet that would be 6×4096² at 250 m; at 2 km macro cells it would need 8192² per face for the same 250 m. Neither fits. Instead:

- **Detail tiles**: 1024² R32F tiles at 250 m (256 km square) in face coordinates, aligned to a fixed per-face tile lattice, built around the camera when the view is at band R or closer, kept in an LRU of ~8 tiles (~32 MB plus control maps).
- **Each tile is a pure function of `(seed, config, face, tile)`** and the macro rasters: bicubic macro + baked noise, MIN-carved river capsules (segments clipped to the tile plus an apron), thermal, pipe-model hydraulic erosion, re-anchoring. The current pipeline already runs the hydraulic step in 1024² tiles with a 48-texel overlap; that tiling becomes the streaming unit.
- **Seams between tiles**: build each tile with a 48-texel apron (from the neighbouring tiles' macro input, across faces through the padded macro textures) and cross-fade the last 16 texels; re-anchoring to the macro field keeps tiles within ±30–100 m of each other anyway.
- **Sampling**: a small indirection texture per face (tile → slot in a `TEXTURE_2D_ARRAY` of tiles); outside resident tiles the shader falls back to macro + procedural amplification (what band W already uses).
- **Creeks** read heights from the resident tile.
- **Shared with flat**: the same streaming could later replace the world-wide map for flat 4096 km worlds, but flat keeps the world-wide map in this plan.

### 6.8 Minimap and the 2D viewer

- **2D viewer**: two projections, chosen in the viewer: **equirectangular** (default; a full-screen shader maps each pixel's lat/lon to (face, u, v) and samples the texture array, so it needs no CPU reprojection) and **cube net** (a cross of 6 faces; shows the raw data and seams, for debugging). The inspector uses the inverse map.
- **Minimap**: an orthographic globe disc centred on the camera target, with the footprint from the 4 corner rays (clipped to the limb), rendered from a 6×128² colour cube-map. Click → `flyTo` along the great circle. A second mode can show the equirectangular map.

### 6.9 What stays shared with flat mode

`gl/util.ts`, `math/mat4.ts`, the MSAA / reversed-Z / FBO plumbing, the instanced node mesh and geomorph code, the colour pipeline (biome LUTs, palettes, water shading, foam, haze) once fed a local up vector, the noise hash and footprint fading, carve profiles, the label system (atlas, SDF, layout, greedy placement), `OrbitController` and the compass, the config panel, URL codec and Atlas UI. Flat-only: the single-root CDLOD, planar `HeightField`, the world-wide detail map and the per-sun horizon bake (until the directional bake is adopted for both).

---

## 7. Metrics harness on a sphere

- **Viewports** are spherical caps (a gnomonic square of the band width around a centre). Centres are area-uniform random unit vectors (uniform views) or random land cells weighted by `area(i)` (land views). There is no clamping to the map.
- **Bands**: R, A and L keep their nominal widths (250 / 60 / 16 km). W keeps a **fixed** 1,024 km view on the sphere (it scales with world size on flat). A new band **G (globe)** is the full disc when the planet fills the screen: targets are "continents, oceans, ranges, great rivers, deserts, ice caps visible" with 15–40 distinct features. On overview sizes (Mars, Earth) only G, W and R are scored.
- **Measures**: all counts per 10⁵ km² of land use area sums. Empty-disk radius uses `distanceField` (geodesic). The 4×4 CV grid and box-count coastline dimension run in the cap's gnomonic projection (a cap of ≤ 1,024 km on a 652 km-radius planet has ≤ 12 % scale distortion; flag it as a known bias). Clark–Evans uses geodesic nearest-neighbour distances and land area.
- **Size invariance**: compare flat and sphere at equal area, e.g. the Small planet (`S_eff` = 2,311 km) against a flat world 2,311 km wide at the same cell size. The question becomes "does the sphere generate the same densities as an equal-area flat world".
- **Suite**: add `--shape sphere` with the Small planet at preview (6×256²) for 10 archetypes × 20 seeds, and a build subset.

---

## 8. Phased plan

Effort is given relative to past milestones (PLAN.md §14, §18). For scale: M1 (macro terrain) and M3 (water) were each a large milestone; M2 (3D world) about the same; M7 (atlas) a medium one; M8 (tuning) medium-large.

### Phase 1 — `Grid` behind every stage, flat only

Goal: every stage and helper takes a `Grid`; only `flatGrid` exists; outputs are byte-identical and timings unchanged.

- **First commit, before any refactor: golden hashes.** Today's determinism tests compare two runs of the current code (`tests/*.test.ts` with `hashBytes`), which would not catch a refactor that changes outputs consistently. Add `tests/golden.test.ts` with per-stage, per-layer and per-vector hashes for seeds {7, 11, 42} × {preview, build at 512 km} × {earth, fjordland, desert}, recorded from the current commit and checked in.
- Add `npm run bench` (node, per-stage medians of 5 runs).
- Files: new `src/gen/grid/grid.ts` (types, `flatGrid`), and Grid-taking versions of `grid/ops.ts`, `distance.ts`, `priorityFlood.ts`, `sample.ts`, `upsample.ts`, `hydro/grid8.ts`; then every consumer listed in §4. `pipeline.ts` builds the grid once per resolution and passes it through `StageCtx` (`ctx.grid('macro' | 'lem' | 'sweep')`). Protocol: no change.
- Tests to add: golden hashes (above); `flatGrid` unit tests (neighbours, border, outlets); a lint-style test that no file under `src/gen/stages` or `src/gen/{lem,hydro,climate,glacial,landforms,registry}` contains `y * n + x`-style index arithmetic outside `src/gen/grid` (grep-based, with an allow-list that shrinks to zero).
- Effort: **≈ M7** (mechanical but wide: ~60 gen files per §4.2, starting with the 9 choke-point modules; most of the time goes into keeping bits identical). Keep each module's D8 order (§4.1).
- Risks: (1) silent float-order changes (e.g. `cellM * cellM` vs a stored area) — caught by golden hashes; (2) JIT de-optimisation from passing an object instead of `n` — caught by the bench gate; keep hot kernels on plain fields; (3) merge conflicts with the M9 polish work — do it in one stage group per PR.

### Phase 2 — Cube-sphere grid; plates, base, LEM and climate on it; 2D viewer

Goal: `worldShape = sphere` generates plates → base → stamps → LEM → refine → climate on 6×n² and shows them in the 2D viewer as equirectangular and cube net. Later stages are skipped on the sphere (the pipeline stops after climate and says so).

- Files: `grid/cube.ts` (`cubeGrid`, seam table, metric tables, `padFace`, `chart`), `shared/noise3.ts`, sphere branches in `stages/plates.ts` (Poisson on sphere, Euler poles), `base.ts` (weighted quantile), `stamps.ts`, `lem/streamPower.ts` (per-cell distances and areas, finite-volume diffusion), `stages/lem.ts`, `climate/model.ts`, `advect.ts` (topological sweep order), `wind.ts`, `currents.ts`; config: `worldShape`, `planetSize`, `axialTilt`, `faceGrid`, `shapes` on `ParamDef`, panel hiding, URL; protocol `faces` on `Layer`; `render/rasterView.ts` (equirectangular + cube net), the inspector.
- Tests: seam continuity (a smooth analytic field sampled through `padFace` and `sample` is continuous across all 12 edges and 8 corners to 1e-6); **Σ area = 4πR²** to 1e-9 relative; neighbour symmetry (j is a neighbour of i ⇔ i of j) for all cells; corner cells have 7 neighbours, all others 8; `components` of a band crossing all 4 equatorial faces is one component; Priority-Flood on a random sphere field leaves every non-seed cell with a strictly lower neighbour across seams; `distanceField` matches analytic great-circle distance within half a cell; LEM steady-state relief on a sphere strip matches the flat calibration within 5 %; climate: zonal symmetry of temperature on a featureless water world (max deviation between longitudes < 0.5 °C), sweeps converge in ≤ 4 rounds; determinism (same seed → same hashes, two runs); flat golden hashes still pass.
- Effort: **≈ M1** (the cube grid itself is small; plates and climate need real redesign).
- Risks: climate sweep convergence on all-land latitude rings (Pangaea), seam artefacts in blurs at the 8 corners, LEM bias along face edges where spacing is 0.71 (watch for rivers following seams), build time (target ≤ 1.7× flat).

### Phase 3 — Globe renderer and camera

Goal: the 3D view renders the sphere with terrain, water lid, basic colouring (biome LUT once biomes exist; hypsometric before that) and the globe camera; flat rendering untouched.

- Files: `render/terrain/cdlod.ts` (6 roots, OBB bounds, horizon culling; or a sibling `cdlodSphere.ts`), `terrainPass.ts` (array textures, `faceToSphere`, two precision regimes), `heightField.ts` (per-face, sphere raycast), `height/heightFn.ts` and `glsl/detail.ts` (`Noise3`, face addressing; GLSL/TS parity tests extended), new `render/camera/globeCamera.ts`, `lighting/horizon.ts` (directional bake with `wrapFace`), `lighting/sky.ts` + new atmosphere pass, `minimap.ts`, `worldView.ts` wiring, `main.ts`.
- Tests: GLSL ↔ TS parity of `faceToSphere`, `wrapFace` and `Noise3` (as the M5 noise parity test); CDLOD selection has no level jumps > 1 across seams over random camera poses; camera: zoom-to-cursor keeps the hit point under the cursor to < 1 px at all distances from globe to 10 m/px, grab pan returns the grabbed point under the cursor, no NaN at the poles; precision: a corner-of-face test at 10 m/px shows no vertex jitter > 0.05 px between frames; the in-app `?selftest` golden height covers sphere mode; flat frame-time percentiles unchanged.
- Effort: **≈ M2 plus half of M5** (camera and CDLOD are M2-sized; the precision and horizon work is M5-like).
- Risks: precision cracks at node boundaries (mitigated by shared CPU corners); 3D noise cost in the FS; the pole behaviour of the camera; Safari/iOS memory with texture arrays.

### Phase 4 — Remaining stages, registry, detail, metrics re-tune

Goal: full sphere worlds (glacial, landforms, hydrology, biomes, registry and names, rivers, creeks, labels, Atlas, streamed detail tiles), with the metrics harness passing the same bars as flat.

- Files: `stages/glacial.ts` and `glacial/*`, `stages/landforms.ts` and `landforms/**` (incl. `coast/grid.ts`), `stages/hydro.ts` and `hydro/*`, `stages/biome.ts`, `climate/biomes.ts`, `stages/registry.ts` and `registry/*` (oceans, lat/lon, sphere names), `shared/landmarks.ts` and protocol positions, `render/water/rivers.ts`, `water/creeks/*`, `render/labels/labelEngine.ts`, `projector.ts`, `render/terrain/detail/*` (tiles, streaming), `metrics/*` (caps, area weights, band G), AUTO formula tuning in `schema.ts`, archetype sphere biases.
- Tests: hydrology invariants on the sphere (every river ends at sea, lake or sink; monotone water; no crossing rivers across seams; lakes at spill level), river graph continuity across seams (no gaps > 1 cell between consecutive nodes in 3D), registry: every landmark has a valid (face, u, v), oceans partition the world ocean, names unique; detail tiles: determinism per tile, continuity across tile and face boundaries (max step < 0.5 m after cross-fade), re-anchoring tolerance; labels never shown on the far side; metrics suite for spheres; all flat suites unchanged.
- Effort: **≈ M3 + M8** (hydrology and registry ports are mostly mechanical after Phase 1; detail streaming is the largest new piece; tuning is M8-like).
- Risks: polar ice dominating cold archetypes; densities and the "boring" detector on large planets; detail-tile build time while the camera moves (time-slicing as today); scope creep towards Earth-sized close zoom.

### Effort overview

| Phase | Roughly like | Flat affected? | Main deliverable |
|---|---|---|---|
| 1 | M7 | No (golden hashes, bench gate) | `Grid` everywhere |
| 2 | M1 | No | Sphere terrain and climate in the 2D viewer |
| 3 | M2 + ½ M5 | No (frame-time check) | Globe you can fly round |
| 4 | M3 + M8 | No | Full sphere worlds, tuned |

---

## 9. Open questions

1. **Default sphere size.** Recommended: **Small planet, 4,096 km circumference, 6×512² at 2 km** (≈ 1.5× today's build). Alternatives: the Moonlet (2,048 km, same 1 km cells as flat, extreme curvature) or a Mid planet (8,192 km at 4 km cells, coarser rivers).
2. **Should `worldShape` be an archetype-level choice or independent?** Recommended: **independent L0 choice** (every archetype works on both shapes; archetypes only add sphere biases such as axial tilt).
3. **Earth-sized planets: overview only, or close zoom too?** Recommended: **overview only** (closest zoom ~200 m/px, bands W/R). Close zoom at Earth scale needs on-demand regional re-generation (LEM + hydrology on 1 km sub-grids), a separate project.
4. **Lighting on the globe.** Recommended: **keep the cartographic screen-relative sun close in, blend to a real sun with a terminator at globe zoom**; real time of day becomes an option in M9-style polish.
5. **Do the sphere's AUTO formulas aim for Earth-like counts or for "flat densities on more area"?** Recommended: **flat densities per km² with saturating plate, hotspot and hero counts** (§3.3), re-tuned by metrics in Phase 4.

---

## 10. References

- Ronchi, Iacono & Paolucci 1996, "The cubed sphere: a new method for the solution of partial differential equations in spherical geometry" (equal-angle cube-sphere metric).
- Putman & Lin 2007, finite-volume transport on cubed-sphere grids (FV3; halo exchange at face edges).
- Bruneton & Neyret 2008, Proland, "Real-time rendering and editing of vector-based terrains" (planet deformation, camera-relative node corners).
- Cozzi & Ring 2011, *3D Engine Design for Virtual Globes* (precision, horizon culling).
- Cesium, "Horizon culling" blog post, 2013.
- Strugar 2009, CDLOD (as in research 04).
- Zhao 2005, fast sweeping method (as in research 03).
- Barnes, Lehman & Mulla 2014, Priority-Flood (as in research 02).
- Max 1988, "Horizon mapping: shadows for bump-mapped surfaces" (directional horizon bake).
- Red Blob Games, mapgen4 and "Polygonal map generation" (sphere variant), for the Delaunay alternative.
