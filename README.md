# Procedural World Generation

A configurable procedural world generator in the browser. It builds a finite region of a planet, seen top-down in 3D, with:
- plate tectonics;
- mountains formed by erosion;
- rivers, lakes and creeks;
- glaciers and fjords;
- coasts, islands and craters;
- climate and biomes.

The stack is TypeScript, Vite and raw WebGL2. Generation runs in a Web Worker.

**Status: milestone M4 (climate & biomes).** It includes:
- the hierarchical config system and the staged generation pipeline;
- tectonic plates with motion and boundary classes;
- continents grown to a target count;
- uplift and erodibility maps;
- volcanoes, hotspot chains and old craters;
- a stream-power erosion model that carves dendritic mountain ranges;
- a climate model: latitude-band winds, upwind moisture advection (summer and winter), orographic rain and rain shadows, ocean currents, and 25 biomes classified from Köppen-style variables;
- hydrology: lakes decided by water balance (through-flow, salt lakes, playas), a river graph with Strahler orders, meanders, waterfalls and rapids, deltas and estuaries, and wetlands;
- a 3D world view: CDLOD terrain with a water lid for sea and lakes, river ribbons that fade in by drainage area as you zoom, an orbit camera with zoom-to-cursor, tilt and rotate, a minimap and a compass;
- a 2D raster debug viewer.

Shader detail at close zoom, shadows and animated water arrive in M5. See [docs/PLAN.md](docs/PLAN.md) for the full plan.

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
| Home · N | Fit the world · north up | Fit the world (also double-click) |
| Compass | Click: north up; drag: rotate | — |
| Minimap | Click or drag to fly there | — |
| Touch | 1 finger pan; 2 fingers pan, zoom and rotate; 2 fingers moving vertically tilt | Pan, pinch |
| B | Full-quality build | Full-quality build |

Realistic colouring comes from a biome colour table over temperature and aridity, with snow, rock, sand and marsh overlays. Palettes: Satellite, Stylised and Hypsometric. The layer picker drapes any generated layer (plates, boundaries, uplift, drainage…) over the 3D terrain. The relief slider sets vertical exaggeration.

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
