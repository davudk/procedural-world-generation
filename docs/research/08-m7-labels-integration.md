# 08 — M7 labels: integration notes

Map labels per research 04 §5.2 and PLAN.md §7: an SDF glyph atlas, instanced screen-space quads, greedy priority placement in a screen grid with hysteresis and fades, and a zoom band per landmark (`maxMpp`). This note says how to call the layer from `WorldView.draw`, how to wire clicks, and what it costs.

| File | Role |
|---|---|
| `src/render/labels/labelLayer.ts` | `LabelLayer`: the GL pass (shader, instance buffer, state) over the engine and the atlas |
| `src/render/labels/labelEngine.ts` | `LabelEngine` (pure): candidates, layout, placement, fades, instance data, hit test |
| `src/render/labels/placement.ts` | `LabelPlacer` + `GridIndex` (pure): greedy placement with hysteresis |
| `src/render/labels/textLayout.ts` | `textRun`, `layoutAlongPath` (pure): pen positions and curved text |
| `src/render/labels/glyphAtlas.ts` | `GlyphAtlas`: Canvas2D rasterising, SDF, shelf packing, incremental R8 uploads |
| `src/render/labels/sdf.ts` | Felzenszwalb EDT → SDF bytes, `ShelfPacker` (pure) |
| `src/render/labels/labelStyle.ts` | Kind → italic or upright, caps, letter spacing, size, layout mode |
| `src/render/labels/projector.ts` | Cached copy of `OrbitCamera.project` for many points per frame |
| `tests/labels.test.ts` | SDF sign and slope, packing, placement rules, curved layout, projector parity, engine timing |

## 1. Wiring into WorldView

```ts
// constructor
this.labels = new LabelLayer(gl);

// setLandmarks(list): worldM must be the ground size (map y → world y = worldM − y)
this.labels.setLandmarks(list, this.hf?.size ?? 1024e3);
// Call it again when the world size changes. Landmarks are kept as given; names are rasterised now.

highlightLandmark(id) { this.labels.highlight(id); }

// draw(): last, after this.rivers.draw(riverFrame), still bound to the MSAA fbo, before the blit
gl.disable(gl.DEPTH_TEST);
this.labels.draw({ cam, ground: this.ground ?? hf, dpr: this.dpr, timeSec, exaggeration: this.exaggeration });
```

- **State.** `draw` turns off depth test, depth writes and culling. It enables premultiplied blending (`ONE, ONE_MINUS_SRC_ALPHA` for colour and alpha, so destination alpha stays 1). It restores depth test and culling if they were on, and leaves blending off. It binds texture unit 0 and its own VAO, then unbinds the VAO. The viewport must already be the full drawing buffer. Clip z is 0, so it works with reversed-Z or standard depth.
- **Ground.** Pass the same `GroundQuery` the camera uses (`DetailGround` once it exists, else the `HeightField`). Anchor heights come from `ground.heightAt`, which already includes the exaggeration. `exaggeration` only clears the height cache when it changes, and so does swapping the `ground` object.
- **DPR.** Positions are CSS px (`cam.viewW/viewH`). `dpr` sets the SDF anti-aliasing width (about 0.6 device px) and snaps upright labels to device pixels. Pass the same capped DPR the canvas uses (`WorldView.dpr`, at most 2).
- **2D mode.** The layer is 3D-only. In 2D mode, don't call it.
- **Redraws.** The frame loop draws every rAF, so nothing more is needed. An on-demand renderer must keep drawing while `labels.animating` is true (fades, plus newcomers waiting their 3 stability frames).

## 2. Clicks and hover

`hitTest(sx, sy)` takes CSS px relative to the canvas top-left, the same space as `cam.pick`. It checks labels placed in the last drawn frame, highest priority first, with 3 px of tolerance. It returns the `Landmark` or null.

```ts
canvas.addEventListener('click', (e) => {
  const r = canvas.getBoundingClientRect();
  const l = world.labels.hitTest(e.clientX - r.left, e.clientY - r.top);
  if (l) { atlas.select(l.id); world.highlightLandmark(l.id); /* optionally fly there */ }
});
```

Test labels before the terrain inspector, and suppress the click after a drag. Hover works the same way, and setting `canvas.style.cursor = 'pointer'` on a hit is cheap enough for every pointermove.

`highlight(id)` places that landmark first. It skips the stability delay and the density rule, ignores its zoom band, and draws it with a warm halo. It still needs its anchor (or, for rivers, part of the path) on screen.

## 3. Behaviour

- **Candidates.** The anchor projects in front of the eye and on screen. Rivers also qualify when any of 9 path samples is on screen. The metres per pixel at the anchor (view depth × 2·tan(fov/2)/viewH) must be at most `maxMpp`; a label already shown stays until 1.2 × `maxMpp`. Area features are skipped when their extent exceeds 3 screen diagonals, so a continent name doesn't show while you are zoomed far into it.
- **Placement.** Order: highlighted, heroes, importance, previously placed, then id. A label is rejected if a padded box (4 px) overlaps a placed box in a 64 px grid, or if its anchor falls within 60 × 20 px of a placed anchor (about 1 label per 120 × 40 px). The total is capped at ⌈area / 4800⌉. A label shown last frame is kept unless a strictly higher-priority label now claims its space. A new label must be placeable for 3 consecutive frames, and must lie fully inside the viewport (a kept label only needs its anchor on screen). Removed labels fade out over 250 ms and new ones fade in, both smoothstepped.
- **Layout modes.**
  - **Point labels** are centred on the anchor. Peaks, volcanoes, waterfalls, capes and craters sit above it.
  - **`angle` labels** (ranges) project the map direction and rotate the text to it, flipped to read left to right, with 0.32 em letter spacing.
  - **Path labels** (rivers, fjords, straits, canyons, rifts) project the path. They split it into on-screen runs, drop vertices closer than 2 px, and rank 17 start offsets by the polyline's own turning. Glyph-by-glyph layout runs for the best 4, rejecting any turn over 25° between neighbouring glyphs and any glyph that would read upside down. The text is flipped when the stretch runs right to left. A path too short or too curvy shows no label.
- **Tilt.** Labels are screen-aligned billboards. Their size scales by (centre m/px ÷ anchor m/px)^0.35, clamped to [0.72, 1.08].
- **Occlusion.** The layer casts a ray from the eye to the anchor. The label is hidden when the terrain is hit before 98.5% of the distance, minus 20 m. This runs only when pitch > 0.03 rad and only for candidates that reach the collision stage. It is capped at 48 raycasts a frame, and each result is reused for 8 frames. Path labels skip it. With pitch ≤ 60° and a 32° fov the horizon is never in view, so behind-the-eye culling covers the horizon case.
- **Style.** Water kinds (river, lake, ocean, sea, bay, gulf, strait, fjord, lagoon, reef) use italic light blue (0.80, 0.91, 1.0) on a dark navy halo. Land kinds use near-black on a warm off-white halo (alpha 0.82). Continents, ranges, oceans and seas are in caps with letter spacing. Sizes are 11–26 CSS px by kind and √importance. Heroes are 10% larger, about 0.3 px bolder, and get a slightly wider halo. All colours are in `labelLayer.colors` for tuning.

## 4. Glyph atlas

The atlas uses Canvas2D at 40 px, in `Georgia, 'Times New Roman', 'Noto Serif', …, serif`, upright and italic. The SDF spread is 10 px and the buffer 11 px. Glyphs are rasterised on demand for every character in the names (both styles as needed, and caps) when `setLandmarks` runs, and later if new characters appear. Each glyph should cost roughly 0.1–0.3 ms (estimate, not measured in a browser yet) (measureText, getImageData, 2 EDTs over ~45 × 60 px), so a typical world with ~100–130 glyphs takes roughly 15–40 ms once. The atlas starts at 1024 × 512 R8 (512 KB) and holds ~170 glyphs. It doubles in height up to 1024 × 4096 when full, and glyphs never move. Uploads are incremental (`texSubImage2D` of the dirty rows).

## 5. Cost

Measured in node (Vitest, on this Mac), engine only (candidates, layout, placement, fades, instance build). Worst case: 3000 landmarks, all in view and in their zoom band, 375 of them rivers with 40-vertex paths, at 1600 × 900.

| Case | Median per frame |
|---|---|
| Static camera (layouts reused while the view is unchanged) | ~0.65 ms |
| Panning every frame (all layouts recomputed) | ~1.1–1.2 ms |

With real `maxMpp` bands most landmarks drop out in the cheap first loop (one cached projection each), so expect well under 1 ms. The GPU cost is one instanced draw of ~1–2k glyph quads, which is negligible. Instance upload is 64 B per glyph each frame.

## 6. Open points

- **`angle` convention.** I read it as 0 = east, counter-clockwise on the north-up map, i.e. world direction (cos a, sin a). If the registry measures it in map axes with y down, change the sign of `sin` in `LabelEngine.layoutAnchor`. Text is flipped to be upright either way, so only the slope's sign would be wrong.
- **River labels sit centred on the river line.** If the halo hides the ribbon too much, offset them to one side (normal offset in `layoutPath`).
- **No occlusion for path labels.** Rivers behind a ridge at strong tilt can still be labelled.
- **Fonts.** These are system serif fonts, so glyph shapes vary by OS. If a web font is added later, rasterise after `document.fonts.ready`, or the atlas captures the fallback font.
