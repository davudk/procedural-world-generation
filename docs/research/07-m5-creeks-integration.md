# 07 — M5 creeks: integration notes

Close-zoom creeks per research 02 §8 (option b, per-macro-cell deterministic growth). This note says how to drive them from the frame loop and what they cost.

| File | Role |
|---|---|
| `src/render/water/creeks/creekGen.ts` | Pure generator: `generateCreeks(input, cells, opts?) → RiverGraph`, plus `prepareCreeks`, `mergeGraphs`, `emptyGraph` |
| `src/render/water/creeks/creekManager.ts` | `CreekManager`: picks cells for the view, time-slices generation, keeps an LRU cache, merges the visible cells |
| `tests/creeks.test.ts` | Determinism, termination, monotone water, no crossings, timings, manager behaviour |

## 1. What gets generated

Every land macro cell (1 km at build) contributes two things.

- **Trunk.** A Catmull-Rom curve along the cell's D8 path, from its centre to the receiver's centre, with a small seeded bow. The D8 path is steepest descent on the carved `elevation` layer.
  - It ends on the macro river (at the river node nearest the receiver's centre), in the sea or a lake, or at a sink.
  - It is cut where it first meets the macro river or a larger trunk.
  - Its area is the D8-accumulated area, clamped to just below the macro channel threshold (8 km² at riverDensity 1). The threshold is read from the river graph's smallest `SOURCE` area.
- **Creeks.** About `1 km² / A_c` heads per cell, with `A_c = 0.2 km²` scaled by climate. Heads are placed by Poisson disk, away from channels.
  - Each head walks downhill on `heightAt` in steps of `clamp(cellM/32, 20, 40)` m (31 m at build). It follows momentum and smooth meander noise, and is pulled toward the nearest channel, gently at first, then strongly near the cell edge, on flats and late in the walk.
  - The walk stops at the first trunk, macro river, earlier creek of the same cell, lake or sea it meets.
  - A walk caught in a pit retries on coarser gradients and then connects straight to the nearest channel inside its cell. Loops are erased.
  - **Creeks never leave their own cell.** That is why creeks of different cells can never cross, whatever order cells are generated in.

Output is a `RiverGraph` in **map metres** (x from west, y from the north edge), reach-ordered like the macro graph. It goes straight into `RiverPass.setRivers(graph, worldM)`.

| Field | Content |
|---|---|
| `zWater` | Running minimum of `heightAt − depth`, clamped so that every join meets the receiving channel's level. Trunk start levels come from a global monotone pass over the D8 tree. Non-increasing along `down`. |
| `area` | Creek area grows from 0.35 × the head's share to its share (cell area / heads), plus tributaries. Trunk area is the D8 area. Always below the macro threshold, so the existing shader LOD hides creeks until zoomed in. |
| `q`, `width`, `depth` | `Q = A · runoff`. `w = clamp(4·√Q, 1, 8)` m (×1.5 arid), `d = clamp(0.35·Q^0.4, 0.1, 1.5)` m. |
| `flags` | `SOURCE` at heads and headwater trunks.<br>`CONFLUENCE` at creek-to-creek junction nodes, and on the last node of a creek or trunk that ends on another channel. That channel can be a trunk, a macro river, a creek of another graph, or the next cell's trunk start. Its `down` is −1 because the target is not in this graph.<br>`MOUTH_SEA` / `MOUTH_LAKE` on ends in water. `SINK_DRY` on ends at a D8 sink.<br>`EPHEMERAL` where runoff < 100 mm/yr. The river shader dashes these. |

Runoff defaults to the specific discharge Q/A of the `discharge` layer, smoothed 3×3. Pass `runoff` (mm/yr per cell) for a better climate signal.

## 2. Wiring

### 2.1 Once per generation

```ts
const hydro = /* stage-done layers of 'hydro' */;
const elev = layer('elevation');                       // carved macro elevation
const n = elev.w, size = elev.worldKm * 1000, cellM = size / n;
creeks.setWorld({
  n, cellM, seed: resolved.seed,
  elevation: elev.data as Float32Array,
  waterClass: layer('waterClass').data,                // the RAW layer, not prepareWater's dilated copy
  dischargeLog: layer('discharge').data as Float32Array,
  rivers: vectors.rivers!,
}, (xm, ym) => heightFn.terrainHeight(xm, size - ym, CREEK_FOOT));
```

`heightAt` takes **map** coordinates and returns **raw** elevation in metres: no water lid and no exaggeration. It must not depend on the view, or creeks would change with zoom. Use a fixed footprint:

- `CREEK_FOOT = 30` m keeps the hollows of the detail field and drops its finest octaves (research 02 §8).
- Until the detail CPU copy exists, `hf.elevationAt(xm, size - ym)` is fine.
- Call `setWorld` again when the detail map lands. All creeks then regenerate.

`setWorld` runs the O(n²) precomputation synchronously: D8, accumulation, river buckets and levels. It takes about 20–60 ms at 512² and 80–160 ms at 1024². Call `setWorld(null, …)` to clear.

### 2.2 Every frame (before `draw`)

All `CreekView` positions are map metres. Convert from world coordinates with `y_map = size − y_world`.

```ts
const cam = this.cam, size = hf.size;
let r = 0;
for (const [sx, sy] of [[0, 0], [cam.viewW, 0], [0, cam.viewH], [cam.viewW, cam.viewH]]) {
  const p = cam.planeHit(sx, sy, cam.target.z) ?? cam.pick(sx, sy);
  r = Math.max(r, p ? Math.hypot(p.x - cam.target.x, p.y - cam.target.y) : Infinity);
}
const eye = cam.eye();
const g = creeks.update({
  centerX: cam.target.x, centerY: size - cam.target.y,
  radiusM: Math.min(r, 60_000),
  metresPerPixel: cam.metresPerPixel(),
  eye: { x: eye.x, y: size - eye.y, z: eye.z / this.exaggeration },   // optional: tilted views
});
if (g) this.creekPass.setRivers(g, size);
```

`planeHit` is cheaper than `pick` and is accurate enough for the radius. The manager caps the radius at `maxRadiusPx` (2000 px) × m/px, so horizon-length footprints are harmless.

When the view has not moved, `update` takes about 0.002 ms and returns `null`. It returns a new graph only when the visible set changes. While cells are still generating, it also publishes partial graphs, at most every `mergeIntervalMs` (120 ms).

### 2.3 Rendering

Use a second `RiverPass` and give it the same frame parameters as the rivers:

```ts
this.creekPass = new RiverPass(gl);          // creekPass.lodC must equal creeks.lodC (both 49 by default)
...
this.rivers.draw(frame);
this.creekPass.draw(frame);
```

The shader fade `smoothstep(A_vis, 1.8·A_vis, area)` with `A_vis = (49·m/px/1000)²` already gives the right progression:

- Trunks (1–8 km²) appear below about 57 m/px.
- Large creeks appear below about 14 m/px.
- Heads (about 0.07 km²) appear below about 5 m/px.

If you want creeks to show earlier, lower `lodC` on **both** the pass and the manager, for example to 35.

### 2.4 Which cells the manager generates

For each cell within the radius, the manager estimates the cell's own m/px. With `eye` it scales by distance from the eye; without it, it uses the target's value. It then picks a tier:

- **Full:** trunk and creeks, when `A_vis < 0.5·cellKm²` (≤ 14 m/px at 1 km cells).
- **Trunk:** when `trunkArea > A_vis` (≤ 57 m/px for the largest trunks).
- **Nothing:** otherwise.

Nearest cells are generated first, within `budgetMs` (4 ms) per call. The cache keeps up to 20 000 cells and 600 000 nodes. It evicts in LRU order and never evicts cells that are currently wanted.

## 3. Expected counts and costs

These numbers come from `tests/creeks.test.ts` (Node, M-series): seed 7, a 512 km world on a 512² build grid (1 km cells), `heightAt` = bilinear macro.

| Measure | Value |
|---|---|
| Generation, full cell | 0.08–0.11 ms per land cell |
| Generation, trunk-only cell | 0.004–0.007 ms per cell |
| Output size | ≈ 90–95 nodes per land cell, ≈ 5 creeks per cell |
| `heightAt` calls | ≈ 240–260 per land cell. `HeightFn.terrainHeight` costs about 0.13 µs per call at a 30 m footprint, so detail adds about 0.03 ms per cell. |
| **20 km wide view** at 7.8 m/px (radius 11.5 km) | 471 cells, ≈ 45 k nodes, ≈ 3.7 k reaches. Filled in 11 frames of ≤ 4.6 ms each. Merge ≈ 0.5 ms. `setRivers` then uploads ≈ 100 k vertices. |
| Tilted view (eye 5.7 km away, 3 km up, radius 30 km) | 670 cells, ≈ 55 k nodes |
| 100 km view at 40 m/px | 1 077 cells (trunks only, and only where visible), ≈ 30 k nodes |
| Context precomputation | 20–60 ms (512²), 80–160 ms (1024²) |

Guaranteed by construction and checked by the tests on an inland block and on a coastal block with synthetic detail:

- Per-cell output is byte-identical in any order or batch. A trunk-only cell equals the leading reach of the full cell.
- Every end is a confluence on a channel, in water, or at a sink. There are no dangling ends. Sinks account for ≤ 0.5 % of ends.
- `zWater` and `zBed` are monotone along `down`. Area and Strahler order are non-decreasing.
- There are zero crossings with macro river segments and zero creek–creek crossings.

## 4. Open risks

- **Straight connectors.** 7 % of creeks inland, and 30 % on the flat, noisy coastal test (egg-crate detail with pits everywhere), end with a straight connector to the nearest in-cell channel. With the real detail field this needs a visual check. The levers are the attraction weights and the coarse-gradient retry in `growCreeks`.
- **Cell-edge bending.** Because creeks stay inside their cell, a hillslope that drains across a cell edge joins its own cell's trunk instead. The edge attraction bends creeks before the edge, but the 1 km grid could show faintly at 8–10 m/px.
- **No carve.** Creeks are not carved into the terrain. Where detail adds bumps above the creek's `zWater`, the ribbon hides under the terrain: `RiverPass` lifts it ≥ 2 m. The §4.4 min-carve of creek ribbons into the detail carve target is the fix.
- **Trunks vs macro routing.** Trunks follow D8 on the carved `elevation`, not hydro's jittered routing. At a few cells they may run beside a macro river or drain to a different neighbour than hydro did. Trunks are cut at the river, so nothing crosses it.
- **Precomputation hitch.** `setWorld` blocks for 80–160 ms at 1024². If that matters, move it to idle time or a worker. It is a pure function of the layers.
