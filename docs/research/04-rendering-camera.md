# 04 — Rendering & camera for a huge-zoom-range top-down 3D terrain (WebGL2)

Status: research recommendation, 2026-10-16. Scope: terrain LOD, shading, detail amplification, lighting, water, overlays and labels, vegetation, camera and input, frame and memory budgets, and the `src/render/` layout. World generation is covered by sibling notes. Rendering builds on `../pathfinding-demo` (raw WebGL2 helpers in `src/render/gl/util.ts`; wheel and gesture code in `src/input/cameraController.ts` and `src/input/touchController.ts`; architecture in its `docs/research/04-engine-rendering-architecture.md`).

## TL;DR

| Decision | Recommendation |
|---|---|
| Terrain LOD | **CDLOD** (Strugar): quadtree over the whole world, one shared N×N grid mesh drawn **instanced** per selected node, heights fetched in the VS, geomorphing, no cracks, no skirts |
| Height texture | **R32F**, bilinear **filtered manually with `texelFetch`** (do not rely on `OES_texture_float_linear`). R16F is too coarse for heights (4 m steps above 4096 m) |
| Detail beyond the raster | Shared GLSL `terrainHeight(p)` = bicubic raster + **procedural fBm with analytic derivatives**, conditioned on slope, biome and roughness, faded per octave by pixel footprint. Same function (ported to TS) for picking, rivers, labels |
| Precision | **Camera-relative** positions everywhere (float64 on the CPU, float32 offsets on the GPU); per-octave noise offsets computed in float64 |
| Depth | **Reversed-Z** (`EXT_clip_control` + `DEPTH_COMPONENT32F`, infinite far) where available. Fallback: near plane tied to ground clearance. No logarithmic depth through `gl_FragDepth` |
| Lighting | Sun Lambert + cartographic hillshade blend + baked **horizon-angle soft shadows** and horizon AO from a GPU pass (no shadow maps), haze proportional to view distance |
| Water | **Single terrain pass with a "water lid"**: VS lifts vertices to `max(h, waterLevel)`, FS shades depth, foam and animated normals. Narrow rivers as **ribbons** with a 1 px minimum width and flow-scrolled UVs |
| Overlays | Instanced screen-space thick lines draped with the shared height function. Labels in an SDF glyph atlas with greedy priority placement in a screen grid, `minZoom` per feature |
| Camera | Orbit camera (target, distance, pitch, bearing) in float64. Zoom-to-cursor = scaling the eye about the cursor's terrain hit point. Auto-tilt with zoom. Reuse `classifyWheel` and the Safari gesture code |
| Budget | ≤ 1 M terrain triangles, 1 instanced draw for terrain, ~10–25 draws per frame, ~250–350 MB of GPU memory at 4096², 4–6 ms GPU at 1440p on Apple Silicon |

## 0. Scale facts that drive everything

- World 1024 km on a 2560 px canvas ≈ **400 m/px**; 4096 km ≈ 1.6 km/px. Close zoom at 10–20 m/px is a ratio of **20–160×** in screen scale. The eye altitude spans about 5 orders of magnitude, from ~2,000 km down to ~50 m at a 60° tilt.
- Heightmap texel: 1024 km / 4096 = **250 m**; 4096 km / 4096 = **1 km**. At 10 m/px one texel covers **25–100 px**. The raster alone looks like smooth blobs at close zoom, so **detail amplification is mandatory** (§2).
- At 10–20 m/px a tree is about 1 px. Instanced 3D trees are mostly invisible, so vegetation is a shading problem first (§6).
- float32 has a 24-bit significand: positions up to 4.19e6 m have a 0.25 m ULP. That is fine for storage but not for matrix products with large translations or for noise arguments (§1.6).

## 1. Terrain LOD

### 1.1 Options

| | CDLOD (Strugar 2009) | Geometry clipmaps (Losasso & Hoppe 2004; GPU Gems 2 ch. 2) | Simple quadtree chunks |
|---|---|---|---|
| Structure | Quadtree; each selected node draws the same grid, scaled | Nested rings of regular grids centred on the viewer, toroidally updated textures | Per-chunk meshes at discrete LODs |
| LOD metric | 3D distance from the eye to the node AABB (handles tilt naturally) | Ring index = distance from the viewer's xy (2D) | Screen-space error or distance |
| Transitions | Per-vertex geomorph in the VS, continuous | Blend zone at the outer part of each ring, with degenerate triangles to fill T-junctions | Popping; skirts or stitching strips |
| Cracks | None: morph target = parent grid, and range rules keep neighbours within 1 level | Handled with "degenerate" triangle strips | Skirts (cheap, ugly at grazing tilt) |
| Culling | Per node, with a min/max height pyramid | Coarse (rings are large) | Per chunk |
| Strength | Simple, one draw, works with any camera pitch | Designed for **streaming** huge terrains (the GPU version flies over a 20-billion-sample US grid) | Easiest MVP |
| Fit here | **Best**: our whole raster is resident, so clipmap streaming buys nothing | Overkill; rings centred under a top-down eye waste rings | MVP only |

Clipmaps assume the eye is low and travelling. With a top-down eye at 500 km altitude, every visible point is at a similar distance, which is CDLOD's sweet spot. Its distance-to-AABB metric gives finer LOD at the near edge when tilted without special cases. Both CDLOD and the GPU clipmap use vertex texture fetch, so the shader code is similar.

### 1.2 CDLOD setup for this project

- Grid mesh: **33×33 vertices (32×32 quads, 2,048 triangles)**, one static VBO + IBO (`Uint16`). One `drawElementsInstanced`. Per-instance attributes: `nodeOrigin` (vec2, camera-relative, f32), `nodeSize` (f32), `lodLevel` (f32).
- Root node = world bounding square; leaf node size ≈ 800 m (25 m vertex spacing). That is 11 levels for 1024 km and 13 for 4096 km.
- LOD ranges: `range[i] = range[0] · 2^i`, with `range[0]` chosen so the grid spacing projects to **~4–6 px** at the morph end. Make this a quality knob (`lodPxPerQuad`).
- Selection (CPU, about 0.1–0.3 ms): Strugar's recursive select. A node is drawn at level *i* if its AABB intersects the sphere of `range[i]` but not of `range[i-1]`. Otherwise recurse; children that are not in range are drawn as parent-size quarter nodes (Strugar splits the draw into 4 sub-quads; with instancing we emit those quarters as instances with `nodeSize/2` at the parent LOD).
- AABB z-bounds come from a **min/max height pyramid** built in the worker (one Float32 pair per node). Pad it by the detail-noise amplitude `±A(level)`.
- Frustum culling: extract the 6 planes from the camera-relative view-projection (Gribb/Hartmann) and test AABBs (p-vertex test). With tilt ≤ 60° and a finite world, add a 7th test "node inside the world rect".

```glsl
// terrain.vert (outline). Positions are camera-relative metres; z up.
in vec2 aGrid;                 // 0..1 grid coordinate of the shared mesh
in vec3 iNode;                 // xy = node origin (camera-relative), z = node size
in float iLod;
uniform vec3 uEyeRel;          // eye position relative to the render origin (≈ (0,0,alt))
uniform vec2 uMorph[16];       // per LOD: (end/(end-start), 1/(end-start))
uniform float uGridN;          // 32
vec2 morph(vec2 g, vec2 pos, float k, float size) {
  vec2 f = fract(g * uGridN * 0.5) * 2.0 / uGridN;  // odd vertices snap to the parent grid
  return pos - f * size * k;
}
void main() {
  vec2 p = iNode.xy + aGrid * iNode.z;
  float h0 = terrainHeight(p, iLod);                  // first estimate for the 3D distance
  float d  = distance(vec3(p, h0), uEyeRel);
  vec2 m = uMorph[int(iLod)];
  float k = clamp(d * m.y - (m.x - 1.0), 0.0, 1.0);   // 0 = own LOD, 1 = parent's grid
  p = morph(aGrid, p, k, iNode.z);
  float h = terrainHeight(p, iLod + k);                // detail octaves also fade with k
  vPos = vec3(p, h);
  gl_Position = uViewProj * vec4(vPos, 1.0);
}
```

### 1.3 Height texture formats in WebGL2

| Format | Bytes per texel (4096²) | Filterable | Precision | Verdict |
|---|---|---|---|---|
| `R16F` | 2 (32 MB) | yes, in core WebGL2 | 11-bit significand: **4 m steps in 4096–8192 m**, 0.5 m around 600 m. Visible terracing in hillshade on gentle high plateaus | Use for derived rasters (normals, shadows), **not heights** |
| `R32F` | 4 (64 MB, 85 MB with mips) | Only with `OES_texture_float_linear`. Web3D Survey reports only ~46% on iOS and ~65% on Safari for WebGL2; a WebKit bug notes iOS does not expose it | Exact | **Use, with manual bilinear via `texelFetch`** (4 fetches; on Apple GPUs the VS cost is negligible) |
| `R16UI` (normalised in shader, e.g. −11 km…+9 km → 0.3 m steps) | 2 (32 MB) | No (integer); needs manual filtering anyway | 0.3 m | Good fallback for mobile or 8192² |
| `RG8` packed | 2 | Filtering breaks packing | 16-bit | No |

- `generateMipmap` needs a filterable, colour-renderable format. R32F is neither without extensions, so **build the mips in the worker** (box filter for display, plus the separate min/max pyramid). Upload all levels with `texStorage2D(levels)` + `texSubImage2D`.
- Use a smooth reconstruction for the base raster in the FS. Bilinear on a 250 m grid shows diamond artifacts in hillshade, so at close zoom use **bicubic (Catmull-Rom, 16 fetches, or 4 bilinear fetches done manually)**, and bilinear when a texel is under ~2 px.

### 1.4 Depth precision and near/far

- Standard depth stores roughly `1/z`; precision clusters at the near plane (see Reed, "Depth Precision Visualized"). Ratios of far/near of 10⁴–10⁵ are typical here.
- **Reversed-Z**: needs `EXT_clip_control` (`clipControlEXT(LOWER_LEFT_EXT, ZERO_TO_ONE_EXT)`; Community Approved 2023). Web3D Survey reports ~95% on Chrome, ~98% on Safari and iOS, but **~2% on Firefox**. Recipe: `DEPTH_COMPONENT32F` depth attachment (render to an FBO; the default framebuffer depth is usually 24-bit), `clearDepth(0)`, `depthFunc(GEQUAL)`, and an infinite-far projection:

```ts
// Reversed-Z infinite perspective, column-major, clip z in [0,1] (ZERO_TO_ONE)
const f = 1 / Math.tan(fovy / 2);
m.set([f / aspect, 0, 0, 0,  0, f, 0, 0,  0, 0, 0, -1,  0, 0, near, 0]);
```

- **Fallback** (Firefox): standard depth with **near = clamp(0.3·clearance, 1 m, 5 km)** where `clearance = eyeZ − terrainHeight(below the eye)`, and **far = distance to the farthest world-rect corner inside the frustum** (computed in float64; cap at `20·altitude` when tilted, because haze hides the rest). For a top-down view far/near stays ≈ 4–10, so precision is trivial. Only high tilt at low altitude needs care.
- **Logarithmic depth through `gl_FragDepth`** (Outerra, three.js, Cesium's hybrid multi-frustum + log depth) disables early-Z. three.js users report roughly halved frame rates on overdraw-heavy terrain. Use it only if neither of the above works, and only in the terrain FS.

### 1.5 Crack handling and T-junctions

CDLOD needs nothing extra as long as (a) the morph uses the parent grid and (b) neighbouring LODs differ by ≤ 1. Strugar's range constraint (`range[i] ≥ 2·range[i−1]` plus a morph region ≤ the node size) guarantees this. Detail noise must morph in step: pass `lod + k` into `terrainHeight` so octaves dropped at the parent level fade out together with the vertex snapping. If not, cracks reappear as 1-px sparkles.

### 1.6 Precision at 4096 km: camera-relative everywhere

- The CPU keeps the camera and node origins in **float64**. Each frame, `renderOrigin = (eye.x, eye.y, 0)` (snapped to 1 m). Node origins are uploaded as `nodeOriginWorld − renderOrigin` in f32, and the view matrix has **no translation in xy** (Cesium calls this "relative to center/eye").
- World coordinates are needed for texture lookups: `uv = (pRel + uOriginInTexels) / texSize`, where `uOriginInTexels` is computed in float64 and split into integer + fraction (`ivec2` + `vec2`) for `texelFetch` indexing.
- **Noise arguments**: `noise(worldPos · f)` with `worldPos ≈ 4e6 m` and `f = 1/20 m⁻¹` gives arguments ~2e5, where the f32 ULP ≈ 0.016. The lattice fraction degrades and detail turns blocky. Fix: per octave *k* the CPU computes `uOctOffset[k] = fmod(renderOrigin.xy · f_k, P)` in float64 (P = noise period, e.g. 289 for permutation noise or 1024 for a hash lattice), and the shader evaluates `noise(pRel · f_k + uOctOffset[k])`. Arguments stay below ~1e4.

## 2. Detail beyond the heightmap

### 2.1 The shared height function

One GLSL include `height.glsl`, used by the terrain VS and FS, the water lid, river ribbons, line overlays, label anchors and the GPU picking pass. It is also **ported 1:1 to TypeScript** (same integer hash, same octave table) for CPU picking and label placement.

```glsl
// h = base(p) + detail(p): metres. lod lets the VS drop fine octaves.
float terrainHeight(vec2 pRel, float lod) {
  vec2 uv = worldTexel(pRel);                       // camera-relative → texel space
  float base = bicubicR32F(uHeight, uv);
  vec4 ctl  = texture(uDetailCtl, uv / uDetailScale);  // RGBA8 at 1024²: roughness, rockiness, biome class, water mask
  float amp = mix(2.0, 60.0, ctl.r);                 // m; mountains rough, plains/deltas calm
  amp *= smoothstep(0.0, 25.0, abs(base - waterLevelAt(uv)));  // never flip land/water (§4 pitfall)
  float pxFoot = footprintMeters(pRel);              // metres per pixel at this point
  return base + amp * fbmFaded(pRel, pxFoot, lod, ctl);
}
```

- **Octaves**: start at the raster's Nyquist (wavelength ≈ 2 texels = 500 m) and go down to ~20 m (~5 octaves for 1024 km worlds, 7 for 4096 km). Use **ridged / derivative-damped fBm** (IQ "more noise": divide each octave by `1 + dot(d, d)` of the accumulated derivatives) so detail erodes like the macro terrain instead of looking like uniform bumps.
- Condition on the **slope of the base raster** (steep → ridged, rock; flat → gentle), on biome (desert dunes = anisotropic, oriented by wind; glacial = smooth), and on **flow accumulation** (suppress detail along channels so valleys stay valleys).
- The VS displaces geometry with only the octaves whose wavelength ≥ ~4 grid quads. The FS adds the remaining octaves **to the normal only** (bump), which is cheap and alias-free.

### 2.2 Anti-shimmering: fade octaves by pixel footprint

```glsl
float fbmFaded(vec2 pRel, float pxFoot, float lod, vec4 ctl) {
  float sum = 0.0, a = 1.0, f = uBaseFreq; vec2 dsum = vec2(0);
  for (int k = 0; k < MAX_OCT; k++) {
    float w = 1.0 - smoothstep(0.25, 0.5, f * pxFoot);   // fade when the wavelength < 2–4 px
    w *= 1.0 - smoothstep(float(k) - 1.0, float(k), lod - uLodOctaveBias); // VS morph coupling
    if (w <= 0.0) break;
    vec3 n = noised(pRel * f + uOctOffset[k]);           // value + analytic gradient
    dsum += n.yz;
    sum += w * a * n.x / (1.0 + dot(dsum, dsum));
    a *= 0.5; f *= 2.0;
  }
  return sum;
}
```

- `pxFoot` in the FS = `length(fwidth(vPos.xy))`. In the VS = `distance · 2·tan(fovy/2)/viewportH` (no derivatives there). This is IQ's band-limiting approach: drop frequencies the pixel cannot represent rather than supersample.
- Albedo and colour noise (rock strata, grass patches) use the same fade. Albedo textures, if any, use real mipmaps + anisotropic filtering (`EXT_texture_filter_anisotropic`).
- Specular is the worst shimmer source. Use **Toksvig-style roughness widening** (`roughness² += variance of the faded octaves`) or just keep terrain spec at zero and give spec only to water.

### 2.3 Colour: per-pixel biome colour, not classic splatting

- **Splatting** (N material textures blended by weights) is designed for close-up ground scenes. At 10–400 m/px textures would be invisible or tile visibly.
- Recommended: **per-pixel procedural biome colour**. A biome-ID raster (R8UI, 1024²) and continuous climate rasters feed a palette/LUT. Biome borders are blurred by sampling the 4 nearest IDs and weighting by distance plus noise-warped UVs (no hard texel stairs). Then modulate by slope (rock where slope > θ(biome)), altitude (snow line from the temperature raster with noise), aspect (snow on shaded slopes) and wetness (darker near rivers from the flow raster).
- **Triplanar on cliffs**: not needed for colour, since nothing is texture-mapped. For the *bump octaves* on slopes > 45°, evaluate the noise on the two dominant planes (xz, yz) instead of xy so cliffs show vertical strata instead of stretched blobs. See Golus on triplanar normal blending.

## 3. Lighting

- **Sun**: Lambert with a wrap term; `sunDir` from azimuth and elevation. Default cartographic hillshade lighting comes from the **north-west (azimuth 315°, elevation 45°)** so relief reads correctly top-down (south-east light causes relief inversion). With the camera rotated, keep the "light from top-left of the screen" option: `sunAzimuth = 315° + cameraBearing` in "map" lighting, and the true sun in "realistic/time-of-day" lighting.
- **Hillshade blend** for map modes: `shade = mix(lambert, multiDirHillshade, uHillshadeMix)`, where the multi-directional hillshade averages 4 azimuths weighted by aspect (the USGS/Esri multidirectional style). It stays legible at world zoom where single-light shading goes flat.
- **Exaggeration at far zoom**: real relief at 400 m/px is nearly invisible. Scale *lighting normals* (not geometry) by `exag = mix(1, 3, smoothstep(5e3, 5e5, altitude))`. Optionally use a small geometric exaggeration slider (MapLibre exposes terrain `exaggeration` the same way).
- **Shadows: precomputed horizon field, not shadow maps.** A shadow map covering 1000 km with a top-down camera wastes resolution; cascades fight with the zoom range. Instead, a GPU pass (FBO, `R16F`, 2048²) stores for the current sun azimuth the **horizon elevation angle** per texel: march along `−sunDir.xy` in ~64 steps with doubling step length over the base raster (+ low octaves). Then `shadow = smoothstep(-ε, +ε, sunElev − horizonAngle)`, where ε ≈ the sun's angular radius plus a softness term. This gives soft penumbrae for free (see the horizon-map approach of Snyder & Nowrouzezahrai). Re-run only when the sun moves or generation updates (≈1–3 ms GPU). For time-of-day animation, amortise over 8 frames.
- **Baked AO**: same pass family, 8 azimuths, cosine-weighted average of horizon angles → `R8`, 1024², recomputed after generation. Detail octaves add cheap curvature AO in the FS (`ao *= 1 − k·max(0, laplacianOfDetail)`).
- **Sky/ambient**: hemisphere ambient (sky colour up, ground bounce down) × AO.
- **Atmospheric perspective** (matters only when tilted): `fog = 1 − exp(−dist · σ(altitude))` towards a sky colour that depends on view elevation and sun direction. σ is scaled so the far edge of the world fades at max tilt. It also hides the far plane. Use a cheap analytic gradient sky above the horizon; no Bruneton-style LUTs for v1.
- **Time of day (optional)**: sun elevation drives the colour temperature (warm when low), ambient strength and the horizon-pass trigger. The night side only dims.

## 4. Water

### 4.1 One pass: the "water lid"

The terrain VS samples both `h = terrainHeight(p)` and `wl = waterLevel(p)` (R32F 1024², bilinear-manual: sea level for the ocean, per-lake level, river surface for wide rivers, −∞ elsewhere). It emits `z = max(h, wl)` and passes `vDepth = wl − h` to the FS. The FS re-evaluates both per pixel (crisp coastline: the shoreline is the per-pixel zero crossing of `wl − h_detailed`, not of the mesh).

```glsl
float depth = wl - h;                         // per pixel
if (depth > 0.0) {
  vec3 absorb = exp(-depth * uExtinction);     // Beer–Lambert, uExtinction ≈ (0.45, 0.09, 0.05)/m scaled for readability
  vec3 col = mix(uDeepColor, terrainColor * absorb + uShallowTint, transparency(depth));
  vec3 n = waterNormal(pRel, uTime, pxFoot);   // 2–3 scrolling normal octaves, faded by pxFoot like §2.2
  col += fresnelSpec(n, viewDir, sunDir);     // sun glint visible when tilted
  float foam = foamMask(depth, shoreDist, pRel, uTime);
  col = mix(col, uFoamColor, foam);
}
```

- Lakes at different levels "just work", because every lake has its own `wl`. A lake rendered at a single level next to a river cascade is consistent if the worker writes the river surface into `wl` for wide reaches.
- **Foam**: two regimes. At close zoom use per-pixel depth (`foam = bands(depth/foamDepth − time)` × noise), which follows the detailed coastline automatically. At far zoom use a **distance-to-shore field** (signed, R16F 1024², built in the worker with a Felzenszwalb EDT or on the GPU with jump flooding) for a 1–2 px coastline halo, plus a "coastal shelf" colour band from depth. Blend by `pxFoot`.
- **Pitfall: detail noise must not create puddles or islands.** Scale the detail amplitude by `smoothstep(0, 25 m, |base − wl|)` (in §2.1) and clamp the sign near shores. Otherwise a lake's outline will not match its vector polygon and label.

### 4.2 Rivers

- **Wide rivers** (width > ~2 raster texels ≈ 500 m): already in `wl` and carved into the heightmap by generation. Rendered by the lid.
- **Narrow rivers/creeks**: **ribbon meshes** from the river graph, built in the worker: a polyline per segment chain with per-vertex `width`, `flowDist` (cumulative length) and `surfaceZ`. Drawn after terrain with `depthFunc(LEQUAL)` and `polygonOffset(-1, -1)` (or a small depth bias in the reversed-Z case). The VS:

```glsl
// Expand perpendicular to the segment; never thinner than 1 px, alpha-fade when the true width < 1 px.
float wTrue = aWidth;                              // metres
float wPx   = wTrue / pxFoot;
float wDraw = max(wTrue, uMinPx * pxFoot);         // uMinPx = 1.0 (world) … 1.5 (hi-dpi)
vAlpha = clamp(wPx / uMinPx, uMinAlpha(order), 1.0);
vec2 p = aCenter + aNormal * aSide * 0.5 * wDraw;
float z = min(terrainHeight(p, lod), aSurfaceZ) + 0.2;   // sit on the carved terrain
vUV = vec2(aSide, aFlowDist / max(wDraw, 1.0));    // flow-scrolled: v -= uTime * speed(slope)
```

- **Visibility by zoom**: each segment carries Strahler order and discharge. Show order ≥ `minOrder(zoom)` (e.g. order 7+ at world zoom, all at ≤ 30 m/px), with `uMinAlpha` fading in over a zoom octave to avoid popping. At world zoom major rivers stay ≥ 1 px. This is cartographic generalisation, not geometry LOD. For very long rivers, pre-simplify the polylines per level (Douglas–Peucker with tolerance = 0.5 px at that level's scale) and store 3–4 versions.
- **Matching the terrain**: the river must lie in a valley of the *detailed* terrain. Suppress detail near channels using flow accumulation (§2.1) **and** clamp ribbon z to `min(terrain, surface)`. Without both the ribbon will float or tunnel.
- **Waterfalls**: when a river segment drops more than `Δz > max(10 m, 3·width)` over less than 2 widths, the worker emits a waterfall record. Render it as a near-vertical ribbon quad (top edge at the upper surface, bottom at the plunge pool), with a fast-scrolling streak texture plus a foam/mist sprite at the base. These are visible only at close zoom; at world zoom they are an icon and a label.

## 5. Vector overlays, labels, map modes

### 5.1 Lines (rivers in map modes, borders, plate boundaries, graticule)

- WebGL `lineWidth > 1` is unsupported almost everywhere. Use **instanced segment quads with round joins** (Rye Terrell, "Instanced line rendering"; Matt DesLauriers, "Drawing Lines is Hard"). The pathfinding demo's `passes/lines.ts` is the starting point.
- Drape: the VS evaluates `terrainHeight` at both endpoints. Pre-subdivide segments so each covers ≤ 1 CDLOD leaf quad, otherwise lines cut through hills when tilted. Width in **screen pixels** (`expand in clip space by width·2/viewport · w`), with an anti-aliased edge from a `vDist` varying.
- Depth: test against terrain with a depth bias proportional to `pxFoot`. Lines hidden behind ridges at high tilt are then correctly occluded; at top-down views the bias keeps them from z-fighting with the terrain.
- **Raster alternative for borders**: rasterise borders to an SDF texture at 2048² and draw them inside the terrain FS. Draping is perfect and the lines are free, but they blur at close zoom. Good for plate boundaries and the temperature isolines of the analysis modes.

### 5.2 Labels

- Feature records from generation: `{kind, name, anchor | polyline | polygon, importance, minZoom, maxZoom}`. Importance comes from size and prominence: peak prominence, lake area, river discharge, range length. Assign `minZoom` per kind via thresholds, so at world zoom only continents, oceans, major ranges and the top ~5 rivers are labelled (cartographic generalisation).
- Placement each time the camera settles, plus continuous updates of positions every frame: sort candidates by `importance·zoomBoost`, project anchors (using the TS port of `terrainHeight`), then place greedily into a **screen-space grid index** (cells ~64 px), rejecting overlaps with already-placed boxes and with a 4–8 px padding. This is Mapbox GL's approach (grid index for collision; earlier an R-tree). Keep previously placed labels sticky (hysteresis: an existing label gets +X priority) and fade them in/out over 200 ms to avoid flicker. Mapbox's CrossTileSymbolIndex exists for the same reason.
- Curved labels along rivers and ranges: place glyphs along the projected polyline. Reject if the curvature per glyph is > ~25°.
- Rendering: an **SDF glyph atlas** (generated with Canvas2D at startup, e.g. TinySDF-style) drawn as instanced quads with halo. DOM labels are acceptable up to ~150 labels, but they lag the camera during fast pinch on Safari. Use WebGL text.

### 5.3 Map modes

Same terrain geometry and pass. A `uMode` uniform switches the FS colour function. Shading (hillshade) stays on in all modes for legibility.

| Mode | Source | Colour |
|---|---|---|
| Realistic | biome ID + climate + slope + snow + water lid | §2.3 |
| Elevation | height | hypsometric tint LUT (separate bathymetric ramp below 0), optional contour lines from `fract(h/Δ)` with `fwidth` AA (Δ chosen per zoom) |
| Biome | R8UI biome raster | categorical palette, borders with a 4-neighbour `!=` edge test |
| Temperature / precipitation | R16F 1024² | sequential/diverging LUT (`R8G8B8A8` 256×1 texture), isolines optional |
| Plates | R8UI plate ID + boundary type | categorical + boundary lines (SDF texture) coloured by convergent/divergent/transform |
| Flow | log(flow accumulation) | sequential blue LUT. Ribbons always on |

## 6. Vegetation & props

- At 10–20 m/px individual trees are 0.5–2 px. **v1 = shader canopy**: in forest biomes, a jittered-grid (Worley-style) cell lookup per pixel at a 10–15 m "tree spacing", drawing a darker crown disc with a self-shadow offset towards `−sunDir`. Density comes from biome and moisture, and it fades to a flat canopy colour when `pxFoot > spacing/2`. The cost is ~10 ALU ops per pixel, no geometry, no shimmer (faded).
- **Instanced props (P3)** only if the close zoom goes below ~3 m/px. Per visible CDLOD leaf with `pxFoot < 3 m`, the worker (or a GPU transform-feedback pass) generates deterministic instances from `hash(nodeId)` and density. Budget: ≤ 64 leaves × 2,000 instances = 128k instances, 2–3 LOD meshes (≤ 60 triangles), drawn as one `drawElementsInstanced` per mesh type. Rocks are scattered on slopes > 30° in the same way.

## 7. Camera & input

### 7.1 Model

State (float64, in the worker-independent `OrbitCamera`): `target` (x, y, z on the terrain), `distance` (eye to target), `pitch` (0 = straight down … 60°), `bearing`. Derived:

```ts
eye = target + distance * [ sin(pitch)*sin(bearing), -sin(pitch)*cos(bearing), cos(pitch) ];
// view: lookAt(eye - renderOrigin, target - renderOrigin, up = bearing-rotated north)
// zoom level for UI and LOD tables: z = log2(maxDistance / distance)
metresPerPixelAtTarget = 2 * distance * Math.tan(fovy / 2) / viewportHcss;
```

- fovy ≈ 30–35°. A narrow FOV keeps a top-down view almost map-like (low perspective distortion) while still giving parallax when tilted.
- `maxDistance` fits the world: `(worldSize/2) / tan(fovy/2) · 1.1`, adjusted for aspect.
- **Auto-tilt** (like Google Maps and Mapbox): `pitch = userPitchOffset + autoPitch(z)`, with `autoPitch = 0` above ~200 km altitude, rising smoothly to ~40° at ~3 km. Turn it off when the user changes the tilt explicitly; reset on a double-click with ⌥ held.

### 7.2 Zoom to cursor in perspective

1. Cast a ray from the cursor and find the **terrain hit** `A`: march the ray over the min/max pyramid on the CPU (hierarchical: skip nodes whose max < ray z), then refine with the TS `terrainHeight` (base + the octaves visible at this zoom) via bisection. This takes ~20–50 µs. If there is no hit (sky at high tilt), intersect the plane `z = target.z`.
2. Zooming by factor `s` is a **homothety of the eye about `A`**: `eye' = A + (eye − A)·s`, `target' = A + (target − A)·s`. With orientation unchanged, `A` stays exactly under the cursor in perspective.
3. Re-seat the target on the terrain: intersect the central ray with the terrain (or keep `target.z` and lerp it to the new ground height over ~150 ms, to avoid jumps over cliffs).
4. Smooth easing: as in the pathfinding demo, `distance` moves exponentially towards `distanceTarget` (`k = 1 − exp(−18·dt)`), with each step applied as the homothety about the stored anchor `A` (not about the cursor pixel, which may move). Pinch is applied immediately (it tracks the fingers).
5. Clamp `distance` to `[minDist, maxDist]`. `minDist` keeps eye clearance ≥ `max(30 m, 0.5·distance·sin(pitch))` above `terrainHeight(eye.xy)`. When the camera is tilted and low, push the eye up rather than the target.

### 7.3 Pan, rotate, clamp

- **Grab pan** (mouse drag, one-finger touch): at pointer-down store the hit point `G` on the plane `z = G.z`. On move, intersect the new cursor ray with that plane and translate `target` by `G − hit`. The speed is automatically proportional to altitude and tilt.
- **Trackpad two-finger scroll** (wheel without ctrl, classified "trackpad"): `target += rotate(bearing) · (dx, dy) · metresPerPixelAtTarget`. For a tilted view, use metres per pixel at the screen-centre hit.
- **Pinch**: `ctrlKey` wheel on Chrome/Firefox/Edge for macOS trackpads, `gesturestart/change` (with `scale`, `rotation`) on Safari. Reuse `classifyWheel()` and `installSafariGestures()` from the pathfinding demo unchanged, including the gesture-stream stickiness (`GESTURE_GAP_MS`) and the `touching` guard. Safari's `gesturechange.rotation` gives **two-finger rotate on the trackpad**. Chrome and Firefox do not expose trackpad rotation, so offer right-drag/⌃-drag (x = bearing, y = pitch), `Q/E` and `R/F` keys, and a compass widget (click = north-up, drag = rotate).
- **Touch** (reuse `touchController.ts`): 1 finger pan. 2 fingers: centroid pan + distance ratio → zoom about the centroid's terrain hit + angle delta → bearing. Vertical movement of both fingers in parallel → pitch (Google Maps convention; detect with a 10° parallel-motion threshold).
- **Clamp**: keep `target` inside the world rect (with a margin of ~10% of the visible width so edges can be centred). Reject pitch values whose frustum would see > 2× the world size past the edge. Outside the world render an "ocean floor + fog" void colour, not black.
- Keyboard: arrows pan at `0.8·viewWidthMetres/s`, `+/-` zoom, `Home` = fit the world.

### 7.4 Minimap

256–320 px DOM canvas with its own small WebGL2 context, or a corner viewport in the main context with a scissor. Render it once per generation update from an FBO: biome colour × hillshade at 512². Each frame draw the **camera footprint**: intersect the 4 corner rays with the plane `z = 0` (clipped to the horizon or far distance when tilted) → a trapezoid. Click/drag recentres `target` with eased flight (animate log-distance out-then-in, van Wijk & Nuij "smooth and efficient zooming", for long jumps).

## 8. Frame budget & architecture

### 8.1 Passes (per frame)

| # | Pass | When | GPU estimate (M-series, 1440p) |
|---|---|---|---|
| 0 | Upload staging: `texSubImage2D` strips from the worker | while generating | ≤ 1 ms (budget 4–8 MB/frame) |
| 1 | CPU: camera, CDLOD select + cull, label placement | every frame (labels on settle + 10 Hz) | CPU 0.3–1 ms |
| 2 | Horizon/shadow/AO pass (FBO, R16F/R8) | on sun change or regen | 1–3 ms, amortised |
| 3 | Terrain + water lid (1 instanced draw, depth-tested opaque) | every frame | 2–4 ms (FS dominated) |
| 4 | River ribbons, waterfalls | every frame | 0.2–0.5 ms |
| 5 | Vector overlays (borders, plates, selection) | every frame | 0.1–0.3 ms |
| 6 | Sky/haze composited in pass 3; labels (SDF) | every frame | 0.1–0.3 ms |
| 7 | Resolve: render at 1× DPR × `renderScale` into the FBO, then FXAA + upscale to the canvas | every frame | 0.3–0.5 ms |

- Render into an FBO (needed for `DEPTH_COMPONENT32F` with reversed-Z anyway), then blit or post-process. MSAA FBOs (`renderbufferStorageMultisample`, 4×) are affordable on Apple Silicon and fix the geometry edges at tilt better than FXAA. Make it a setting.
- Use a dynamic `renderScale` (0.6–1.0) driven by `EXT_disjoint_timer_query_webgl2` where exposed (Chrome desktop), otherwise by the frame-time trend. Note that Safari does not expose GPU timer queries.

### 8.2 GPU memory (4096² detail, 1024² coarse)

| Resource | Format | Size |
|---|---|---|
| Height + mips | R32F | 85 MB (R16UI fallback: 43 MB) |
| Min/max pyramid | CPU only | 2 × 22 MB on the CPU (Float32), 0 GPU |
| Water level | R32F 1024² | 4 MB |
| Detail control (roughness, rock, biome class, mask) | RGBA8 1024² | 4 MB |
| Biome ID, plate ID | R8UI 1024² ×2 | 2 MB |
| Temperature, precipitation, flow (log), shore distance | R16F 1024² ×4 | 8 MB |
| Horizon/shadow 2048² + AO 1024² | R16F + R8 | 9 MB |
| Framebuffers 2560×1440: colour RGBA8 (MSAA 4×), depth 32F (MSAA 4×), resolve | | ~120 MB with 4× MSAA, ~30 MB without |
| Ribbons, lines, glyphs, grid mesh | VBOs | < 30 MB |
| **Total** | | **~250–350 MB** (8192² heights would add ~256 MB: keep 4096² as the max on the GPU and use detail amplification beyond that) |

### 8.3 Worker → GPU data flow

- The generator worker posts `{kind, level, x0, y0, w, h, buffer}` with `postMessage(msg, [buffer])` (transferable, zero-copy). The main thread queues uploads and spends ≤ 1 ms per frame on `texSubImage2D` strips (e.g. 4096 × 256 R32F = 4 MB). It never uploads a full 64 MB texture in one frame, because that causes a 30–80 ms hitch on Safari.
- Use `UNPACK_ALIGNMENT 1`, `texStorage2D` allocated once per world size (immutable), and a re-allocation only when the preset changes.
- **Progressive refinement**: the worker first sends a 512² preview of each field, then 1024² and the final 4096². The renderer always samples "the best available level". Implementation: upload the preview into the coarse mip levels of the same texture and clamp `TEXTURE_BASE_LEVEL` until the fine levels arrive. The camera and LOD keep working the whole time. During generation, a "generation epoch" uniform cross-fades between old and new heights over 300 ms.
- The CPU copies (heights for picking, min/max pyramid, river graph, features) stay in the main thread for picking/labels. Use a SharedArrayBuffer when `crossOriginIsolated` (avoids duplication), otherwise a transferred copy.

### 8.4 GPU erosion in the same context (optional)

- Fragment-shader ping-pong (RGBA32F state textures; needs `EXT_color_buffer_float`, which is broadly available on WebGL2 desktop and recent iOS) in the **render context**, so results are immediately the height texture with no readback. Time-slice it to ≤ 4 ms of GPU per frame (N iterations per frame) and show progress live.
- When the CPU needs the result (rivers, lakes, labels), read back asynchronously with a `PIXEL_PACK_BUFFER` + `fenceSync` + poll `clientWaitSync(…, 0)`, then `getBufferSubData` the following frames. Never use a sync `readPixels` on the hot path.
- Alternative: `OffscreenCanvas` + WebGL2 **inside the worker** (supported in Chrome, Firefox and Safari 17+). This keeps the main thread clean, but textures cannot be shared across contexts, so the result still travels as a transfer + upload (~64 MB). Prefer the same-context option when the user is watching erosion live, and the worker option for batch generation.

### 8.5 Mobile limits

iPhone/iPad (Apple GPU): `MAX_TEXTURE_SIZE` 16384, but per-tab memory pressure kills the context around a few hundred MB. Use R16UI heights, 2048² detail, no MSAA, `renderScale` 0.75 at DPR 3, a 17×17 CDLOD grid, the shader canopy off, and a 30 fps cap when idle. Handle `webglcontextlost`/`restored`: all GPU state must be rebuildable from the CPU copies.

## 9. Recommendation for this project

### 9.1 Module layout (`src/render/`)

```
src/render/
  gl/           util.ts (copied from pathfinding-demo), caps.ts (extension detection: clip_control,
                color_buffer_float, float_linear, timer_query, anisotropic), fbo.ts, texturePool.ts
  camera/       orbitCamera.ts (f64 state, view/proj, reversed-Z or fallback), frustum.ts,
                picking.ts (ray vs min/max pyramid + TS height), flyTo.ts
  terrain/      cdlod.ts (select + cull → instance buffer), minMaxPyramid.ts (worker side too),
                terrainPass.ts, shaders/{terrain.vert, terrain.frag, height.glsl, noise.glsl,
                biomeColor.glsl, water.glsl, modes.glsl}
  height/       heightFn.ts (TS port of height.glsl + noise; golden tests vs GPU readback)
  lighting/     horizonPass.ts (shadow + AO), sun.ts (time of day), sky.glsl
  water/        riverRibbons.ts (mesh build from graph, per-zoom simplification), riverPass.ts, waterfall.ts
  overlays/     lines.ts (instanced screen-space lines, draped), sdfBorders.ts
  labels/       glyphAtlas.ts, placement.ts (grid index, hysteresis, fades), labelPass.ts
  vegetation/   (P3) instances.ts
  uploads.ts    worker → texture staging queue with a per-frame byte budget
  minimap.ts
  renderer.ts   frame orchestration, render scale, pass timing
src/input/      cameraController.ts (adapted: orbit camera, homothety zoom, grab pan),
                touchController.ts (adapted: + rotate/pitch), wheel.ts (classifyWheel, unchanged)
```

Keep the pathfinding demo's `zoomAt(sx, sy, …)`, `panScreen(dx, dy)` and `pinchAt(…)` method names on `OrbitCamera`, so the ported controllers change only in their internals.

### 9.2 Terrain fragment shader outline

```
p        = vPos (camera-relative)           pxFoot = length(fwidth(p.xy))
h, dhdxy = base bicubic + VS-octaves + FS-only octaves (analytic gradient), all faded by pxFoot
wl       = waterLevel(p)                     depth = wl - h
n        = normalize(vec3(-dhdxy * exag(alt), 1))
albedo   = modeColor(uMode, rasters, h, slope, n)   // realistic: biome + rock + snow + wetness + canopy
light    = sun(n) * horizonShadow(p) + skyAmbient(n) * ao(p) * curvatureAO
col      = albedo * light ; if (depth > 0) col = water(col, depth, shoreDist, n_water, view, sun)
col      = mix(col, hazeColor(view), fog(dist, alt)) ; outColor = col (linear → sRGB in resolve)
```

### 9.3 Budgets (Apple Silicon, 1440p, 60–120 fps)

- Frame ≤ 8.3 ms at 120 Hz: GPU ≤ 6 ms, main-thread CPU ≤ 3 ms (select 0.3, labels 0.5 amortised, uploads ≤ 1).
- Terrain: ≤ 600 selected nodes × 2,048 triangles ≈ 1.2 M triangles max (typically 250–400 nodes). One instanced draw.
- FS: ≤ 7 noise octaves total (VS + FS), ≤ 24 texture fetches per pixel in the realistic mode. Bicubic only when `pxFoot < 0.5 texel`.
- Draw calls per frame: ~10–25. State changes are dominated by passes, not objects.
- Uploads ≤ 4 MB/frame. Horizon pass ≤ 3 ms, amortised when animated.
- GPU memory ≤ 350 MB desktop, ≤ 150 MB mobile.

### 9.4 Pitfalls checklist

1. **One height function**: terrain, water, ribbons, lines, labels and picking all call `terrainHeight` (GLSL) or `heightFn.ts` (TS). Any divergence shows as floating rivers or labels inside hills. Write a golden test that renders heights to an R32F FBO and compares them with the TS port (tolerance 0.05 m).
2. **Noise precision**: camera-relative positions plus per-octave float64 offsets (§1.6). Test at the far corner of a 4096 km world at 10 m/px.
3. **R16F heights terrace** above ~2,000 m; use R32F/R16UI.
4. **Detail must not change topology**: keep the land/water sign, valley floors and the lake outlines of the vector data.
5. **Morph-coupled octaves** or the result is 1-px cracks and sparkle at LOD boundaries.
6. **AABB pad** with the detail amplitude, or nodes on mountain silhouettes get culled at tilt.
7. **No sync readbacks** (`readPixels`, `getError`) in the frame. Picking is CPU-side.
8. **Upload budget** per frame. Never `texImage2D` 64 MB in one frame.
9. **Reversed-Z is not available on Firefox**: keep the clearance-based near plane path tested.
10. **Safari pinch** arrives as gesture events and as ctrl-wheel on other browsers, and touch also fires gesture events on iOS. Keep the `touching` guard from the pathfinding demo.
11. **Shimmer**: every procedural signal (height bumps, albedo noise, canopy, water normals, contour lines) is faded by `pxFoot`.
12. **Context loss**: everything rebuildable from CPU copies and the generation seed.

## Sources

- F. Strugar, "Continuous Distance-Dependent Level of Detail for Rendering Heightmaps" (2009/2010), paper + code: https://github.com/fstrugar/CDLOD (paper: `cdlod_paper_latest.pdf` in the repo)
- F. Losasso, H. Hoppe, "Geometry clipmaps" (SIGGRAPH 2004), and A. Asirvatham, H. Hoppe, "Terrain Rendering Using GPU-Based Geometry Clipmaps", GPU Gems 2 ch. 2: https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry ; project page: https://hhoppe.com/proj/gpugcm/
- Khronos, `EXT_clip_control` WebGL extension: https://registry.khronos.org/webgl/extensions/EXT_clip_control/ ; support data: https://web3dsurvey.com/webgl2/extensions/EXT_clip_control
- `OES_texture_float_linear` support: https://web3dsurvey.com/webgl2/extensions/OES_texture_float_linear ; WebKit bug 212005: https://bugs.webkit.org/show_bug.cgi?id=212005
- N. Reed, "Depth Precision Visualized" (NVIDIA): https://developer.nvidia.com/content/depth-precision-visualized
- Cesium, "Hybrid Multi-Frustum Logarithmic Depth Buffer" (2018): https://cesium.com/blog/2018/05/24/logarithmic-depth/
- Outerra, "Logarithmic Depth Buffer": https://gamedev.net/blogs/entry/2001520-logarithmic-depth-buffer
- three.js forum, log-depth performance cost: https://discourse.threejs.org/t/beware-of-logarithmic-depth-buffer-it-can-degrade-scene-performance/88495
- I. Quilez, "Filtering procedurals": https://iquilezles.org/articles/filtering ; "Bandlimiting": https://iquilezles.org/articles/bandlimiting/ ; "Filterable procedurals": https://iquilezles.org/articles/filterableprocedurals ; "Terrain raymarching": https://iquilezles.org/articles/terrainmarching ; "More noise" (derivative-damped fBm): https://iquilezles.org/articles/morenoise/
- D. Nowrouzezahrai, J. Snyder, "Fast Soft Self-Shadowing on Dynamic Height Fields" (EGSR 2008): https://diglib.eg.org/handle/10.2312/CGF.v27i4pp1275-1283
- B. Golus, "Normal Mapping for a Triplanar Shader": https://bgolus.medium.com/normal-mapping-for-a-triplanar-shader-10bf39dca05a
- MapLibre GL JS 3D terrain (raster-dem, exaggeration): https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain/ ; MapTiler on MapLibre v2 terrain: https://www.maptiler.com/news/2022/05/maplibre-2/
- Mapbox, "Map Label Placement in Mapbox GL": https://blog.mapbox.com/map-label-placement-in-mapbox-gl-c6f843a7caaa ; mapbox-gl-native "Collision Detection" wiki: https://github.com/mapbox/mapbox-gl-native/wiki/Collision-Detection ; "Optimize map label placement": https://docs.mapbox.com/help/troubleshooting/optimize-map-label-placement/
- R. Terrell, "Instanced Line Rendering": https://wwwtyro.net/2019/11/18/instanced-lines.html ; M. DesLauriers, "Drawing Lines is Hard": https://mattdesl.svbtle.com/drawing-lines-is-hard
- S. Lague, Hydraulic Erosion (droplet erosion, Unity compute): https://github.com/SebLague/Hydraulic-Erosion
- J. van Wijk, W. Nuij, "Smooth and efficient zooming and panning" (InfoVis 2003): https://vanwijk.win.tue.nl/zoompan.pdf
- Sibling project: `../pathfinding-demo/src/input/cameraController.ts` (`classifyWheel`, Safari gestures), `../pathfinding-demo/src/input/touchController.ts`, `../pathfinding-demo/docs/research/04-engine-rendering-architecture.md`
