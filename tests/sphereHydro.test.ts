/**
 * Hydrology and biomes on the sphere (research 10 §8 Phase 4): the flat invariants of research 02
 * §10.3 on cube-sphere worlds (every river ends at the sea, a lake or a sink; monotone water; no
 * crossing receivers, seams and cube corners included; lakes at or below their spill level), a river
 * graph that stays continuous across seams, and deterministic biomes.
 */
import { describe, expect, it } from 'vitest';
import { cubeGrid, type CubeGrid } from '../src/gen/grid/cube';
import { cellFace } from '../src/gen/grid/grid';
import { MinHeap } from '../src/gen/grid/heap';
import { riverPoints } from '../src/gen/hydro/metrics';
import { Pipeline } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import type { BiomeExtra } from '../src/gen/stages/biome';
import { DRY_LEVEL, WATER, type HydroExtra } from '../src/gen/stages/hydro';
import type { ErodedExtra } from '../src/gen/stages/lem';
import { resolve } from '../src/shared/config/resolve';
import { SPHERE_STAGES } from '../src/shared/config/types';
import { hashBytes } from '../src/shared/hash';
import { RIVER, type FromWorker, type LakeInfo, type RiverGraph } from '../src/shared/protocol';

interface SphereWorld {
  msgs: FromWorker[];
  p: Pipeline;
  grid: CubeGrid;
  hydro: HydroExtra;
  terrain: ErodedExtra;
  rivers: RiverGraph;
  lakes: LakeInfo[];
  stats: Record<string, number>;
}

const cache = new Map<string, Promise<SphereWorld>>();

/** A default-size sphere preview (cached per seed and archetype). */
function sphereWorld(seed: number, archetype = 'earth'): Promise<SphereWorld> {
  const key = `${seed}:${archetype}`;
  let w = cache.get(key);
  if (!w) {
    w = (async () => {
      const msgs: FromWorker[] = [];
      const p = new Pipeline(STAGES);
      const r = resolve({ seed, archetype, pins: { worldShape: 'sphere' } });
      await p.run(r, 'preview', 1, (m) => msgs.push(m), () => false);
      const err = msgs.find((m) => m.type === 'error');
      if (err && err.type === 'error') throw new Error(err.message);
      const out = p.output('hydro')!;
      const hydro = out.extra as HydroExtra;
      const radiusM = ((r.values.planetSize as number) * 1000) / (2 * Math.PI);
      return {
        msgs, p, grid: cubeGrid(hydro.n, radiusM), hydro, terrain: p.output('landforms')!.extra as ErodedExtra,
        rivers: out.vectors!.rivers!, lakes: out.vectors!.lakes!, stats: out.stats,
      };
    })();
    cache.set(key, w);
  }
  return w;
}

const TERMINAL = RIVER.MOUTH_SEA | RIVER.MOUTH_LAKE | RIVER.LAKE_TERMINAL | RIVER.SINK_DRY;

/** Cell under river node i. */
function nodeCell(w: SphereWorld, i: number): number {
  const g = w.grid;
  return g.locate({ face: w.rivers.face![i], u: w.rivers.x[i], v: w.rivers.y[i] });
}

/** Plain Priority-Flood fill of `h` from the fixed (sea) cells: the lowest level water could stand at. */
function fill(h: Float32Array, fixed: Uint8Array, g: CubeGrid): Float64Array {
  const F = new Float64Array(g.cells).fill(Infinity);
  const heap = new MinHeap(1024);
  for (let i = 0; i < g.cells; i++) {
    if (!fixed[i]) continue;
    F[i] = h[i];
    heap.push(h[i], i);
  }
  while (heap.size > 0) {
    const c = heap.pop();
    for (let k = 0; k < 8; k++) {
      const j = g.nbr(c, k);
      if (j < 0 || F[j] !== Infinity) continue;
      F[j] = Math.max(h[j], F[c]);
      heap.push(F[j], j);
    }
  }
  return F;
}

describe('sphere pipeline through biomes', () => {
  it('runs every stage but the registry, with sphere layers and sphere river positions', async () => {
    const w = await sphereWorld(7);
    const done = w.msgs.filter((m) => m.type === 'stage-done').map((m) => (m.type === 'stage-done' ? m.stage : ''));
    expect(done).toEqual([...SPHERE_STAGES]);
    expect(SPHERE_STAGES).toContain('biome');
    expect(SPHERE_STAGES).not.toContain('registry');
    for (const m of w.msgs) {
      if (m.type !== 'stage-done') continue;
      for (const l of m.layers) {
        expect(l.faces, l.id).toBe(6);
        expect(l.data.length, l.id).toBe(6 * l.w * l.w);
      }
    }
    const g = w.rivers;
    expect(g.face).toBeDefined();
    const W = w.grid.n * w.grid.cellM;
    for (let i = 0; i < g.n; i++) {
      expect(g.face![i]).toBeLessThan(6);
      expect(g.x[i]).toBeGreaterThanOrEqual(0);
      expect(g.x[i]).toBeLessThanOrEqual(W);
      expect(g.y[i]).toBeGreaterThanOrEqual(0);
      expect(g.y[i]).toBeLessThanOrEqual(W);
    }
    for (const l of w.lakes) expect(l.face).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

describe('hydrology invariants on the sphere', () => {
  for (const seed of [7, 42]) {
    it(`hold on sphere preview seed ${seed}`, async () => {
      const w = await sphereWorld(seed);
      const { rivers: g, hydro: e, grid, lakes, terrain } = w;
      const N = grid.cells;
      expect(g.n).toBeGreaterThan(1000);

      // Termination: every down-chain ends (no cycles) at a node flagged as a legal terminal, and a sea
      // mouth sits next to the ocean, a lake mouth next to a lake.
      for (let i = 0; i < g.n; i++) {
        let c = i;
        for (let k = 0; g.down[c] >= 0; k++) {
          c = g.down[c];
          expect(k).toBeLessThanOrEqual(g.n);
        }
        expect(g.flags[c] & TERMINAL, `node ${c} ends without a terminal flag`).not.toBe(0);
      }
      for (let i = 0; i < g.n; i++) {
        if (g.down[i] >= 0) continue;
        const c = nodeCell(w, i);
        const near = (pred: (j: number) => boolean): boolean => {
          if (pred(c)) return true;
          for (let k = 0; k < 8; k++) {
            const j = grid.nbr(c, k);
            if (j >= 0 && pred(j)) return true;
          }
          return false;
        };
        if (g.flags[i] & RIVER.MOUTH_SEA) expect(near((j) => e.waterClass[j] === WATER.OCEAN), `sea mouth ${i}`).toBe(true);
        else if (g.flags[i] & RIVER.MOUTH_LAKE) expect(near((j) => e.lakeId[j] >= 0), `lake mouth ${i}`).toBe(true);
      }

      // Monotone water and bed along every edge.
      for (let i = 0; i < g.n; i++) {
        const d = g.down[i];
        if (d < 0) continue;
        expect(g.zWater[d]).toBeLessThanOrEqual(g.zWater[i]);
        expect(g.zBed[d]).toBeLessThanOrEqual(g.zBed[i]);
      }

      // No two diagonal receivers cross in any 2×2 block, across seams too (uncross; at the cube
      // corners the block across the corner has three cells, so it cannot hold two diagonals).
      const QUADS = [[4, 6, 7], [6, 3, 5], [3, 1, 0], [1, 4, 2]];
      let crossing = 0;
      let seamBlocks = 0;
      for (let a = 0; a < N; a++) {
        for (const [kb, kc, kd] of QUADS) {
          const b = grid.nbr(a, kb);
          const c = grid.nbr(a, kc);
          const d = grid.nbr(a, kd);
          if (b < 0 || c < 0 || d < 0) continue;
          if (grid.border[a]) seamBlocks++;
          const diagA = e.rcv[a] === d || e.rcv[d] === a;
          const diagB = e.rcv[b] === c || e.rcv[c] === b;
          if (diagA && diagB) crossing++;
        }
      }
      expect(seamBlocks).toBeGreaterThan(0);
      expect(crossing).toBe(0);
      // Graph polylines: no more contacts than flat graphs show (meander bends), none over the sea.
      expect(w.stats.crossings).toBeLessThanOrEqual(Math.ceil(g.n * 1e-3));
      for (let i = 0; i < g.n; i++) {
        const c = nodeCell(w, i);
        if (e.waterClass[c] === WATER.OCEAN) expect(g.flags[i] & (RIVER.MOUTH_SEA | RIVER.DISTRIBUTARY), `node ${i} on the sea`).not.toBe(0);
      }

      // Lakes: flat at their level above the bed; through-flow lakes at their spill (no Priority-Flood
      // fill above the level: the water would leave lower), closed lakes at or below it, with a
      // monotone outlet that leaves at the lake level.
      const F = fill(e.elevation, terrain.fixed, grid);
      let area = new Float64Array(lakes.length);
      for (let c = 0; c < N; c++) {
        const l = e.lakeId[c];
        if (l < 0) continue;
        area[l] += grid.area(c) / 1e6;
        if (lakes[l].type === 'playa') {
          expect(e.waterClass[c]).toBe(WATER.PLAYA);
          continue;
        }
        expect(e.waterLevel[c]).toBe(Math.fround(lakes[l].level));
        expect(e.elevation[c]).toBeLessThan(e.waterLevel[c]);
        if (lakes[l].outletNode >= 0) expect(F[c], `lake ${l} cell ${c} above its spill`).toBeLessThanOrEqual(lakes[l].level + 1e-3);
        else expect(F[c]).toBeGreaterThanOrEqual(lakes[l].level - 1e-3);
      }
      for (const lake of lakes) {
        expect(area[lake.id]).toBeCloseTo(lake.areaKm2, 3);
        if (lake.outletNode < 0) continue;
        expect(g.zWater[lake.outletNode]).toBeLessThanOrEqual(lake.level + 1e-3);
        expect(g.zWater[lake.outletNode]).toBeGreaterThanOrEqual(lake.level - 1);
      }
      area = new Float64Array(0);

      // Carving only lowers; dry land is exactly DRY_LEVEL; the sea is level 0.
      for (let c = 0; c < N; c++) {
        expect(e.elevation[c]).toBeLessThanOrEqual(terrain.h[c]);
        const cls = e.waterClass[c];
        if (cls === WATER.LAND || cls === WATER.WETLAND || cls === WATER.PLAYA) expect(e.waterLevel[c]).toBe(DRY_LEVEL);
        if (cls === WATER.OCEAN) expect(e.waterLevel[c]).toBe(0);
      }
    }, 60_000);
  }

  it('keeps the river graph continuous across seams (no gap over one cell in 3D)', async () => {
    const w = await sphereWorld(11);
    const g = w.rivers;
    const pts = riverPoints(g, w.grid.radiusM);
    const cell = w.grid.cellM;
    let seamLinks = 0;
    let worst = 0;
    let worstSeam = 0;
    let worstLakeOut = 0;
    for (let i = 0; i < g.n; i++) {
      const d = g.down[i];
      if (d < 0) continue;
      // Lake-to-lake and lake-to-sea straits join two neighbouring cells' nodes (up to ~1.4 cells + jitter).
      if (g.flags[i] & RIVER.LAKE_OUT && g.flags[d] & (RIVER.MOUTH_SEA | RIVER.MOUTH_LAKE) && d === i + 1) continue;
      const gap = Math.hypot(pts[3 * d] - pts[3 * i], pts[3 * d + 1] - pts[3 * i + 1], pts[3 * d + 2] - pts[3 * i + 2]) / cell;
      // A tributary joining a lake outlet's first node (half-way between the lake cell and the first
      // channel cell, as on flat maps) may reach a little further.
      if (g.flags[d] & RIVER.LAKE_OUT) worstLakeOut = Math.max(worstLakeOut, gap);
      else worst = Math.max(worst, gap);
      if (g.face![i] !== g.face![d]) {
        seamLinks++;
        worstSeam = Math.max(worstSeam, gap);
      }
    }
    console.log(
      `[sphere] river graph: ${g.n} nodes, ${seamLinks} links across seams, largest gap ${worst.toFixed(2)} cells (seams ${worstSeam.toFixed(2)}, into lake outlets ${worstLakeOut.toFixed(2)})`,
    );
    expect(seamLinks).toBeGreaterThan(10);
    expect(worst).toBeLessThanOrEqual(1);
    expect(worstLakeOut).toBeLessThanOrEqual(1.5);
    expect(worstSeam).toBeLessThanOrEqual(1);
  }, 60_000);

  it('drains the land to the world ocean, the largest water body (no map edge)', async () => {
    const w = await sphereWorld(42);
    const e = w.hydro;
    // Following receivers from land ends at the sea, a terminal lake or a dry sink, never at a seam.
    let toSea = 0;
    let land = 0;
    for (let s = 0; s < w.grid.cells; s += 7) {
      if (w.terrain.fixed[s]) continue;
      land++;
      let c = s;
      for (let k = 0; k < w.grid.cells && e.rcv[c] !== c; k++) c = e.rcv[c];
      if (w.terrain.fixed[c]) toSea++;
      else expect(e.lakeId[c] >= 0 || e.waterClass[c] !== WATER.OCEAN, `sink at ${c}`).toBe(true);
      expect(cellFace(w.grid, c)).toBeLessThan(6);
    }
    expect(toSea / land).toBeGreaterThan(0.8);
  }, 60_000);
});

describe('biomes on the sphere', () => {
  it('are deterministic and cover the land with many biomes', async () => {
    const run = async (): Promise<{ hash: number; extra: BiomeExtra; stats: Record<string, number> }> => {
      const p = new Pipeline(STAGES);
      await p.run(resolve({ seed: 11, archetype: 'earth', pins: { worldShape: 'sphere' } }), 'preview', 1, () => {}, () => false);
      const out = p.output('biome')!;
      const extra = out.extra as BiomeExtra;
      return { hash: hashBytes(extra.biome) ^ hashBytes(extra.canopy) ^ hashBytes(extra.snow), extra, stats: out.stats };
    };
    const a = await run();
    const b = await run();
    expect(a.hash).toBe(b.hash);
    expect(a.stats.distinctBiomes).toBeGreaterThanOrEqual(15);
    expect(a.extra.biome.length).toBe(6 * a.extra.n * a.extra.n);
  }, 60_000);
});

