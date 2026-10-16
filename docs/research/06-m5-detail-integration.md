# 06 — M5 close-zoom detail: integration notes

How to wire the detail map, the shared height function and its TS port into the renderer. The design follows research 04 §2 (shared height function, footprint fading, damped fBm), 01 §4 (GPU upsample, pre-carve, thermal and pipe-model erosion, re-anchoring) and 02 §4.4 (carving is a `min()`, so water never climbs).

## Files

| File | What it is |
|---|---|
| `src/render/terrain/detail/detailMap.ts` | `DetailMap`: builds the detail elevation texture (R32F, metres, row 0 = north) and the control texture (RGBA8). The CPU helpers (`prepareDetail`, `buildControl`, `riverSegments`, `buildDetailCpu`) are pure and tested. |
| `src/render/glsl/detail.ts` | `NOISE_GLSL` (hash, noise, fBm, samplers), `DETAIL_GLSL` (the height function), `DetailUniforms` (binds it). |
| `src/render/height/heightFn.ts` | The TS port: `DN` constants (the GLSL is generated from them), `HeightFn`, and `DetailGround` (implements `GroundQuery`). |
| `tests/detail.test.ts` | Checks noise parity against a float32/BigInt reference of the GLSL, footprint fading, water and channel invariants, bicubic reproduction and determinism. |

## 1. Build sequence (main thread)

```ts
// WorldView constructor
this.detail = new DetailMap(gl);                    // probes EXT_color_buffer_float (else CPU 2048² fallback)
this.detailU = new DetailUniforms(this.detail);

// When the hydro layers + rivers are in (biome optional; build once biome is there to avoid a rebuild)
this.detail.build({ elevation, waterLevel, waterClass, discharge, biome, rivers, seed, size: 4096 });

// Every frame, in draw(), before the terrain pass
if (this.detail.building) this.detail.step(cam.moving ? 3 : 10);   // ms budget; never stalls on the GPU
if (this.detail.version !== this.detailSeen) {
  this.detailSeen = this.detail.version;
  const src = this.detail.heightSources();
  if (src) {
    this.heightFn = new HeightFn(src);
    this.ground = new DetailGround(this.heightFn, hf, this.detail.boundsPad);
    this.cam.setGround(this.ground);
  }
}
this.ground.pxFoot = Math.max(cam.metresPerPixel(), leafSpacing);   // footprint used by picking and clamps
```

- `build()` frees the old texture at once (`ready = false`, so the shader falls back to the macro). Call it again for every new generation. The input must be the hydro-stage `elevation` (carved), `waterLevel` and `waterClass` on the same grid, as `TerrainPass.setTerrain` gets them.
- `step(budgetMs)` runs CPU slices (measured) and GPU passes (estimated with `opts.gpuMtexPerMs`) until the budget is used. If the previous slice's GPU work has not finished (fence), it returns at once. `ready` flips when the texture is final. `cpuHeights` arrives a few frames later through an async PBO readback (`cpuReady`). `version` increments on both events.
- `finishSync()` runs everything in one go (sync `readPixels`). Use it for tools and tests only.
- Before `cpuHeights` arrives, `HeightFn` stands in with the macro bicubic. Picking is then off by up to the baked noise (≤ ~150 m in the roughest terrain, usually ≪ 10 m). Rebuild `HeightFn` on the next `version` change.
- Context loss: `dispose()` and build again (everything is rebuilt from the layers and the seed).

## 2. Shader integration (`terrainPass.ts`)

Paste `DETAIL_GLSL` right after `HEIGHT_GLSL` in both the VS and the FS:

```ts
import { DETAIL_GLSL, DetailUniforms } from '../glsl/detail';
// VS: ...uniform float u_exag;\n${HEIGHT_GLSL}\n${DETAIL_GLSL}\n
// FS: ${HEIGHT_GLSL}\n${DETAIL_GLSL}\n${COLORMAPS_GLSL}
```

It declares `u_detail`, `u_detailCtl`, `u_detailN`, `u_hasDetail`, `u_detailSeed` (uint), `u_detailAmp`, `u_detailAmpScale`, `u_detailLam0`, `u_detailOct`. It uses `u_height`, `u_hn`, `u_size`, `u_hasWater`, `rawHeight`, `surfaceHeight` and `waterLevelAt` from `HEIGHT_GLSL`. The GLSL functions:

```glsl
float detailWeight(float pxFoot);              // 0..1 share of the detail map (0 at world zoom)
vec3  detailSample(vec2 w, float pxFoot);      // (h, dh/dx, dh/dy): raw elevation + gradient, one evaluation
float terrainHeight(vec2 w, float pxFoot);     // raw elevation (m)
float terrainSurface(vec2 w, float pxFoot);    // water lid: max(h, water level), = surfaceHeight at world zoom
vec2  terrainGradient(vec2 w, float pxFoot);   // world axes, x east, y north
```

`w` is the absolute world xy in metres. `pxFoot` is the size of one pixel in metres at that point.

**Binding.** `TerrainPass.draw` uses texture units 0–10, so call `this.detailU.bind(gl, this.prog, 11)` after `useProgram`. It binds units 11 and 12 and returns 13. Without a ready map it binds 1×1 placeholders and sets `u_hasDetail = 0`, which renders exactly as before.

**VS.** Add `uniform float u_pxScale;` (= `2·tan(fovY/2) / viewH`, the value `RiverFrame.pxScale` already uses) and replace the height calls:

```glsl
float spacing = a_node.z / ${GRID}.0;                    // this node's vertex spacing (m)
float d0 = length(vec3(rel0, surfaceHeight(w0) * u_exag - u_origin.z));   // unchanged (morph distance)
float k = ...;                                            // unchanged
vec2 w = rel + u_origin.xy;
// Geometry can't hold wavelengths under ~2 vertex spacings: the footprint is at least the spacing,
// and it grows with the morph factor so octaves fade together with vertex snapping (research 04 §1.5).
float foot = max(d0 * u_pxScale, spacing * (1.0 + k));
float z = terrainSurface(w, foot) * u_exag;
v_world = vec3(w, 0.0);                                   // the FS recomputes the height per pixel
```

**FS.**

```glsl
float pxFoot = length(fwidth(w));
vec3 ds = detailSample(w, pxFoot);       // evaluate once; don't call terrainHeight + terrainGradient separately
float h = ds.x;                          // replaces rawHeight(w)
vec2 gr = mix(gradAt(w), ds.yz, detailWeight(pxFoot));   // replaces gradAt(w): mipmapped macro gradient far, detail near
```

Use `gr` for the normal and pass it into `landColor` instead of the internal `gradAt(w)` call (rock and snow slope). The water test (`wl > h`), depth colour and shoreline (`fwidth(h)`) stay as they are and use the new `h`. Water normals are separate. `gradAt` is the gradient of the water-lid surface, and `ds.yz` is the gradient of the raw terrain. They differ only under water, where the water branch does not use `gr`.

## 3. CDLOD changes (`worldView.ts` / `cdlod.ts`)

- `maxDepth = Math.ceil(Math.log2(size / (GRID * 16)))` gives a leaf spacing of about 16 m: 11 for 1024 km and 13 for 4096 km (today it is 7, a 250 m leaf). The ranges in `CdlodSelector.select` already scale from the leaf spacing. At 8 m/px with `vertexPx: 3` the leaves are about 24 m apart.
- `boundsPad: this.detail.ready ? this.detail.boundsPad * this.exaggeration : 50`. `boundsPad` ≈ 340 m at 1024 km and covers anchor, baked noise, shader octaves and dunes. `rangeOver` returns exaggerated heights, so the pad must be exaggerated too.
- `MAX_NODES = 2048` is still ample: each extra level adds about 12–20 nodes near the eye.
- Optional: `DetailGround.pad` (the raycast top) is `boundsPad`.

## 4. Other users of heights

- River ribbons (`rivers.ts`) keep `z = zWater`. The carve gives a flat floor at the water surface ≥ 1.05 detail texels to each side of every channel, so the interpolated terrain under the centreline stays at or below `zWater`. On a build-mode world (seed 7, 1024², 213 k river nodes), only 0.3% of centreline samples had terrain more than 1 m above `zWater` (worst 25 m). With today's bilinear macro it is 68% (worst 352 m).
- Labels, picking and creek placement: use `DetailGround.heightAt(x, y, pxFoot)` (rendered: lid × exaggeration) or `detailHeightAt` / `HeightFn.sample` (raw m + gradient). With the same `pxFoot` they agree with the shader to float32 rounding (≪ 1 m). The geometry uses the VS footprint `max(d·pxScale, spacing·(1+k))`, which the CPU can't know exactly, so pass `max(metresPerPixel, leafSpacing)`. The residual is the faded part of one octave (< ~1 m at 8–40 m/px).
- The horizon/shadow pass, minimap and `HeightField` (CDLOD bounds, `maxHeight`) stay on the macro.

## 5. What the map contains

- **Detail texture** (`size`² R32F): `min(max(h, lo), cap)` with
  - `h` = Catmull-Rom of the macro + baked damped/ridged fBm (λ from 2 macro cells down to 2 texels, amplitude `(8 + 150·roughness)·(1 − proximity)` m), then thermal erosion (talus 0.75), pipe-model hydraulic erosion in 1024² tiles (48-texel overlap), thermal again, and low-frequency re-anchoring (±`anchorMetres` = 60 m against the macro bicubic, σ = 2 macro cells).
  - `lo`, `hi`: where the bilinear macro is under the bilinear prepared water level, `hi = level − 0.5`. Where it is above, `lo = level + 0.5`. Far from water, land above 0.5 m stays above 0.5 m.
  - `cap` = `min(hi, river profiles)`. The profiles are a parabolic channel (bed `zBed` up to `zWater` at the bank), a flat floor (half-width `max(1.05 texel, width·(6…1.5))`), a valley wall of slope `clamp(1.2·macro slope, 0.01, 0.8)`, and a steep ramp out at `0.5·w + floor + 2 macro cells`. They are rasterised as instanced capsules into a depth-tested MIN target, because float blending (`EXT_float_blend`) is not needed that way. The channel part may go below `lo`, and the valley walls may not. Every step re-applies the clamp (Dirichlet), so erosion cannot fill channels or cross shores.
- **Control texture** (`min(2048, 2·macro)`² RGBA8, linear): r roughness (macro slope + 3×3 relief × biome factor), g rock (ridged octaves: ROCK/NIVAL or slope > 0.25–0.6), b water/channel proximity (water ≤ 150–900 m, river floors, discharge > 10–300 m³/s; amplification × (1 − b)), a dunes (hot/cold desert, beach, xeric shrub on flat ground).
- **Shader octaves**: λ0 = the largest power of two ≤ 3 texels (512 m at 250 m texels), down to 16 m (6 octaves at 4096² over 1024 km). Amplitude `(2 + 60·r)·(λ0/512)^0.7·(1 − b)` m, plus N–S dunes (λ 256 × 1024 m, ±10 m·a). The amplitude is capped so `|amplification| ≤ |h − waterLevel| − 1 m`, which means amplification can never flip land and water. Each octave is faded by `1 − smoothstep(0.25, 0.5, pxFoot/λ)`. Damping uses the ungated derivatives, so fading one octave never changes another. At world zoom (`pxFoot ≥ 2 texels`), `terrainSurface` is exactly the old `surfaceHeight` (4 fetches, no noise).
- Precision: noise is evaluated on a 65 536 m tile index plus a local offset (integer lattice, `lowbias32` integer hash, no `sin`), so lattice fractions keep full precision anywhere in a 4096 km world (tested against a float32 reference at 4.09e6 m). The only remaining limit is `w` itself in float32 (0.25–0.5 m ULP at 4096 km), which is fine down to ~2 m/px.

## 6. Memory and timing

| | 4096² (desktop default) | 2048² (GPU) | CPU fallback 2048² |
|---|---|---|---|
| Final GPU memory | 64 MB detail + 16 MB control | 16 + 16 MB | 16 + 16 MB |
| Peak GPU during build | ≈ 280 MB (2 height + cap + 64 MB depth, then ≈ 90 MB erosion tiles) | ≈ 90 MB | — |
| CPU memory kept | 64 MB `cpuHeights` + 16 MB control + 4 MB/raster prepared water | 16 + 16 MB | 16 + 16 MB |
| CPU prep (measured, 1024² macro, 213 k river nodes) | 650 ms, sliced (max slice 13.6 ms, the existing `prepareWater`) | 720 ms | 720 ms + 1.44 s build (max slice 9.5 ms) |
| GPU (estimate, Apple-silicon class) | base 3–6 ms, carve 20–50 ms, thermal 24 × 1–2 ms, hydraulic 16 tiles × 24 it × 3 passes ≈ 0.35–0.7 s, anchor ≈ 5 ms, readback 64 MB ≈ 20–40 ms | ≈ 0.15–0.3 s | — |
| Wall clock | ≈ 2.5 s at `step(10)`, ≈ 6 s at `step(4)` | ≈ 1.5–2 s | ≈ 2.5 s at `step(10)` |

TS height function (measured): `HeightFn.sample` takes 0.20 µs at 8 m/px, 0.15 µs at 40 m/px and 0.06 µs at 400 m/px. `noised` takes 14 ns. `DetailGround.raycast` takes 3 µs (top-down from 2000 km) to 23 µs (tilted, 3 km up). Per pixel at close zoom the shader does 4 + 16 detail fetches (bicubic only when a texel spans ≥ 2–4 px), 1 control fetch, 4 water-level fetches and ≤ 6 octaves × 4 hashes. In the VS the same work happens per vertex.

## 7. Tuning knobs

- `DetailUniforms.amp` (and the same value in `HeightFn.amp`): global shader amplitude.
- `new DetailMap(gl, { thermalSteps, hydraulicSteps /* 0 = off */, anchorMetres, talus, hydro: {...}, readback, gpuMtexPerMs })`.
- `DN` in `heightFn.ts`: amplitudes (`AMP_*`, `BAKE_*`), dunes, damping and fade bands. The GLSL is regenerated from these, so edit them only there.

## 8. Visual checklist (not verified here: no GL in node)

1. The build shaders compile. `compileProgram` throws with numbered source on error; they were reviewed but never compiled.
2. At 8–40 m/px: ridges and gullies on mountains, gentle undulation on plains, flat valley floors along rivers, dunes in deserts. There should be no shimmer while zooming, and no cracks or sparkle at CDLOD level borders (the footprint is coupled to the morph).
3. Lakes and the sea stay flat. Shorelines follow the macro (within a detail texel). Ribbons sit in their valleys.
4. The hydraulic pass shows no checkerboard or tile seams. If it does, set `hydraulicSteps: 0` and report it; the constants are untuned starting values.
5. Toggling `DetailUniforms.enabled` at world zoom makes no visible difference.
