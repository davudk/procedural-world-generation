# Procedural World Generation

A configurable procedural world generator in the browser. It builds a finite region of a planet, seen top-down in 3D, with:
- plate tectonics;
- mountains formed by erosion;
- rivers, lakes and creeks;
- glaciers and fjords;
- coasts, islands and craters;
- climate and biomes.

The stack is TypeScript, Vite and raw WebGL2. Generation runs in a Web Worker.

**Status: milestone M1 (macro terrain).** It includes:
- the hierarchical config system and the staged generation pipeline;
- tectonic plates with motion and boundary classes;
- continents grown to a target count;
- uplift and erodibility maps;
- volcanoes, hotspot chains and old craters;
- a stream-power erosion model that carves dendritic mountain ranges;
- a 2D raster debug viewer.

The 3D renderer arrives in M2. See [docs/PLAN.md](docs/PLAN.md) for the full plan.

## Run

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5174.

## Controls (debug viewer)

| Input | Action |
|---|---|
| Two-finger scroll / drag | Pan |
| Pinch / mouse wheel | Zoom to cursor |
| Arrow keys | Pan |
| Double-click / Home | Fit the world |
| B | Full-quality build |

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
