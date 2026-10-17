# Procedural World Generation

**Live demo:** https://procedural-world-gen.web.app

A configurable procedural world generator in the browser. It builds a finite region of a planet, seen top-down in 3D, with:
- plate tectonics;
- mountains formed by erosion;
- rivers, lakes and creeks;
- glaciers and fjords;
- coasts, islands and craters;
- climate and biomes.

The stack is TypeScript, Vite and raw WebGL2. Generation runs in a Web Worker.

**Status: milestone M9 (polish & ship), plus spherical worlds in progress** ([research 10](docs/research/10-spherical-worlds.md)): set the world shape to Sphere for a cube-sphere planet with plates, erosion and climate, shown as a 3D globe or a 2D map (phases 1–3 of 4). It includes:
- the hierarchical config system and the staged generation pipeline;
- tectonic plates with motion and boundary classes;
- continents grown to a target count;
- uplift and erodibility maps;
- volcanoes, hotspot chains and old craters;
- a stream-power erosion model that carves dendritic mountain ranges;
- a climate model: latitude-band winds, upwind moisture advection (summer and winter), orographic rain and rain shadows, ocean currents, and 25 biomes classified from Köppen-style variables;
- landforms: glacial troughs, cirques and fjords; fresh stratovolcanoes, shields, calderas and cinder fields; impact craters; mesas, escarpments, ergs and inselbergs; karst with dolines, towers and cenotes; barrier islands, lagoons, spits, tombolos, sea cliffs, rias, coral reefs and atolls; swamp, marsh, bog and fen wetlands;
- hydrology: lakes decided by water balance (through-flow, salt lakes, playas), a river graph with Strahler orders, meanders, waterfalls and rapids, deltas and estuaries, and wetlands;
- a 3D world view: CDLOD terrain with a water lid for sea and lakes, river ribbons that fade in by drainage area as you zoom, an orbit camera with zoom-to-cursor, tilt and rotate, a minimap and a compass;
- a landmark registry: about 250 named places per world (peaks ranked by prominence, ranges, rivers, lakes, seas, gulfs, bays, straits, peninsulas, capes, islands, archipelagos, fjords, canyons, deserts, forests, volcanoes, craters…), named in procedural regional languages, with 3–5 hero landmarks and a World-traits summary;
- SDF map labels with cartographic styles, priority placement and labels along rivers and ranges; an Atlas panel (A) that flies to any place;
- a 2D raster debug viewer;
- a metrics harness (`npm run metrics`) that scores density, targets and boring/cluttered worlds over many seeds, archetypes and sizes;
- time of day, seasons, drifting clouds with shadows, valley fog and shader tree crowns;
- quality tiers for phones, recovery after a lost graphics context, and export (screenshot, 16-bit heightmap, colour map, world JSON, share link).
- a 3D globe for sphere worlds: six-root CDLOD terrain without seams, an atmosphere with a limb glow and a day/night terminator, and a globe camera that grab-pans the planet under the cursor and zooms from the whole planet down to the surface.

Close zoom (down to 8 m/px) shows a GPU-built 4096² detail heightmap (carved river valleys, thermal and hydraulic erosion) plus footprint-faded shader octaves, deterministic creeks generated for the visible area, soft horizon shadows and ambient occlusion, a gradient sky with aerial haze, and animated water with shoreline foam. See [docs/PLAN.md](docs/PLAN.md) for the full plan.

## Run

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5174.

## Controls

The world opens in **3D**. Press **V**, or the 2D/3D button, to switch to the 2D raster view.

| Input | 3D world | 2D raster view |
|---|---|---|
| Two-finger scroll | Pan | Pan |
| Pinch / mouse wheel | Zoom to cursor | Zoom to cursor |
| Drag | Grab pan | Grab pan |
| Right-drag, ⌃-drag or middle-drag | Rotate (x) and tilt (y) | — |
| Safari trackpad rotate | Rotate | — |
| Arrows · + / − | Pan · zoom | Pan |
| Q / E · R / F | Rotate · tilt | — |
| Home · N | Fit the world (the whole planet on spheres) · north up | Fit the world (also double-click) |
| Compass | Click: north up; drag: rotate | — |
| Minimap | Click or drag to fly there (spheres: an equirectangular map) | — |
| P | — | Spheres: equirectangular map or cube net |
| Touch | 1 finger pan; 2 fingers pan, zoom and rotate; 2 fingers moving vertically tilt | Pan, pinch |
| B | Full-quality build | Full-quality build |
| A | Atlas of named places (click a row or a label to fly there) | — |
| T | Play or pause the time of day | — |
| Export button | Screenshot, heightmap, colour map, world JSON, share link | Same |

Realistic colouring comes from a biome colour table over temperature and aridity, with snow, rock, sand and marsh overlays. Palettes: Satellite, Stylised and Hypsometric. Pick **World (final, realistic)** with the Satellite palette for the finished world; the time, season and clouds controls sit below it. The layer picker also drapes any generated layer (plates, boundaries, uplift, drainage…) over the 3D terrain. The relief slider sets vertical exaggeration.

On a sphere the controls are the same: dragging turns the planet so the point you grabbed stays under the cursor, and zooming in blends from a whole-planet view into the tilted orbit view near the surface. Spheres have no biome, hydrology or landmark stages yet, so the globe is coloured from temperature and precipitation, and close-zoom detail, rivers, labels and clouds are flat-only for now.

## Configuration

Settings are a hierarchy ([docs/CONFIG.md](docs/CONFIG.md)):
- High-level parameters (world size, land fraction, tectonic activity, age, climate) drive lower-level ones (plate count, continents, mountain-range sizes, …).
- Every parameter is **AUTO** until you pin it.
- Many parameters are min–max ranges.
- 🎯 marks targets that the generator steers toward. The panel shows the realised value next to each one.

The URL holds the seed, archetype and your pins, so a link reproduces the world.

| URL parameter | Meaning |
|---|---|
| `seed` | World seed |
| `a` | Archetype (`earth`, `archipelago`, `pangaea`, `rift`, `fjordland`, `desert`, `volcanic`, `iceage`, `hothouse`, `craton`) |
| any parameter id | A pin, e.g. `worldSize=2048`, `plateCount=4~6`, `continentCount=~3` (one thumb pinned) |
| `gen=main` | Run generation on the main thread (for debugging) |

## Scripts

| Script | |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run typecheck` | Type-checks the app and the worker (the generator can't touch DOM APIs) |
| `npm test` | Config hierarchy, pipeline caching, determinism and module-boundary tests |
| `npm run build` | Type-check, then production build |

## Layout

| Directory | Contents |
|---|---|
| `src/shared/` | Config schema, resolver, archetypes, URL codec; hashing, RNG and noise; worker protocol |
| `src/gen/` | Pure, seeded generation stages and the cached stage pipeline. Runs in the worker |
| `src/app/` | Generation host |
| `src/render/` | WebGL2 views |
| `src/input/` | Camera gestures |
| `src/ui/` | Config panel |
| `docs/` | Plan, feature catalog, config design, research notes |

## License

[MIT](LICENSE)
