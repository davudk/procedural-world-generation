import { describe, expect, it } from 'vitest';
import { breachShallow } from '../src/gen/hydro/breach';
import { bifurcationRatio, hackExponent } from '../src/gen/hydro/metrics';
import { Pipeline, type StageOutput } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import { DRY_LEVEL, WATER, type HydroExtra } from '../src/gen/stages/hydro';
import type { ErodedExtra } from '../src/gen/stages/lem';
import { resolve } from '../src/shared/config/resolve';
import type { WorldSpec } from '../src/shared/config/types';
import { hashBytes } from '../src/shared/hash';
import { RIVER, type GenMode, type LakeInfo, type RiverGraph } from '../src/shared/protocol';

interface World {
  hydro: StageOutput;
  refine: ErodedExtra;
  extra: HydroExtra;
  rivers: RiverGraph;
  lakes: LakeInfo[];
}

async function world(seed: number, mode: GenMode = 'preview', pins: WorldSpec['pins'] = {}): Promise<World> {
  const p = new Pipeline(STAGES);
  let error = '';
  await p.run(resolve({ seed, archetype: 'earth', pins }), mode, 1, (m) => {
    if (m.type === 'error') error = m.message;
  }, () => false);
  if (error) throw new Error(error);
  const hydro = p.output('hydro')!;
  const { rivers, lakes } = hydro.vectors!;
  return { hydro, refine: p.output('landforms')!.extra as ErodedExtra, extra: hydro.extra as HydroExtra, rivers: rivers!, lakes: lakes! };
}

const TERMINAL = RIVER.MOUTH_SEA | RIVER.MOUTH_LAKE | RIVER.LAKE_TERMINAL | RIVER.SINK_DRY;
const cellOf = (e: HydroExtra, x: number, y: number): number => {
  const m = e.cellKm * 1000;
  return Math.min(e.n - 1, Math.max(0, Math.floor(y / m))) * e.n + Math.min(e.n - 1, Math.max(0, Math.floor(x / m)));
};

function checkInvariants(w: World): void {
  const { rivers: g, lakes, extra: e, refine } = w;
  const N = e.n * e.n;
  expect(g.n).toBeGreaterThan(100);

  // Termination: every down-chain ends (no cycles) at a node flagged as a legal terminal.
  const state = new Uint8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    let c = i;
    let steps = 0;
    while (g.down[c] >= 0 && state[c] === 0) {
      state[c] = 1;
      c = g.down[c];
      expect(++steps).toBeLessThanOrEqual(g.n);
    }
    if (g.down[c] < 0) expect(g.flags[c] & TERMINAL, `node ${c} ends without a terminal flag`).not.toBe(0);
    for (let k = i; k !== c && state[k] === 1; k = g.down[k]) state[k] = 2;
  }

  // Monotone water and bed along every edge; reaches are contiguous and link to reach heads.
  for (let i = 0; i < g.n; i++) {
    const d = g.down[i];
    if (d < 0) continue;
    expect(g.zWater[d]).toBeLessThanOrEqual(g.zWater[i]);
    expect(g.zBed[d]).toBeLessThanOrEqual(g.zBed[i]);
    expect(g.zBed[i]).toBeLessThanOrEqual(g.zWater[i]);
  }
  for (let r = 0; r < g.reachStart.length; r++) {
    const last = g.reachStart[r] + g.reachLen[r] - 1;
    const rd = g.reachDown[r];
    expect(g.down[last]).toBe(rd < 0 ? -1 : g.reachStart[rd]);
  }

  // Reach polylines do not cross (a handful of meander contacts at most).
  expect(w.hydro.stats.crossings).toBeLessThanOrEqual(Math.ceil(g.n * 1e-3));

  // No river node on the sea except mouths and delta distributaries.
  for (let i = 0; i < g.n; i++) {
    const c = cellOf(e, g.x[i], g.y[i]);
    if (e.waterClass[c] === WATER.OCEAN) expect(g.flags[i] & (RIVER.MOUTH_SEA | RIVER.DISTRIBUTARY), `node ${i} on the sea`).not.toBe(0);
  }

  // Lakes: flat surface at their level, never below the terrain; outlets drain to a terminal.
  const counted = new Int32Array(lakes.length);
  for (let c = 0; c < N; c++) {
    const l = e.lakeId[c];
    if (l < 0) continue;
    counted[l]++;
    if (lakes[l].type === 'playa') {
      expect(e.waterClass[c]).toBe(WATER.PLAYA);
      continue;
    }
    expect(e.waterLevel[c]).toBe(Math.fround(lakes[l].level));
    expect(e.elevation[c]).toBeLessThan(e.waterLevel[c]);
    expect([WATER.LAKE, WATER.SALT_LAKE]).toContain(e.waterClass[c]);
  }
  for (const lake of lakes) {
    expect(counted[lake.id] * e.cellKm * e.cellKm).toBeCloseTo(lake.areaKm2, 6);
    if (lake.salinity === 0) {
      expect(lake.outletNode, `through-flow lake ${lake.id} has no outlet`).toBeGreaterThanOrEqual(0);
      let c = lake.outletNode;
      for (let k = 0; g.down[c] >= 0 && k <= g.n; k++) c = g.down[c];
      expect(g.flags[c] & TERMINAL).not.toBe(0);
    } else {
      expect(lake.outletNode).toBe(-1);
    }
  }

  // Carving only lowers; dry land is exactly DRY_LEVEL; sea is level 0.
  for (let c = 0; c < N; c++) {
    expect(e.elevation[c]).toBeLessThanOrEqual(refine.h[c]);
    const cls = e.waterClass[c];
    if (cls === WATER.LAND || cls === WATER.WETLAND || cls === WATER.PLAYA) expect(e.waterLevel[c]).toBe(DRY_LEVEL);
    if (cls === WATER.OCEAN) expect(e.waterLevel[c]).toBe(0);
  }
}

describe('hydrology invariants (research 02 §10.3)', () => {
  for (const seed of [3, 7, 11]) {
    it(`holds on preview seed ${seed}`, async () => {
      const w = await world(seed);
      checkInvariants(w);
      expect(w.hydro.stats.riverDensityRatio).toBeGreaterThan(0.8);
      expect(w.hydro.stats.riverDensityRatio).toBeLessThan(1.2);
      // The outcome is in slider units, so the config panel compares it with riverDensity itself.
      expect(w.hydro.outcomes.riverDensity).toBeCloseTo(w.hydro.stats.riverDensityRatio * (resolve({ seed, archetype: 'earth', pins: {} }).values.riverDensity as number), 6);
    }, 20_000);
  }

  it('meets wetlandShare on a desert world via arid wetlands', async () => {
    const p = new Pipeline(STAGES);
    const r = resolve({ seed: 2, archetype: 'desert', pins: {} });
    await p.run(r, 'preview', 1, () => {}, () => false);
    const got = p.output('hydro')!.outcomes.wetlandShare;
    expect(Math.abs(got - (r.values.wetlandShare as number))).toBeLessThanOrEqual(0.1 * (r.values.wetlandShare as number));
  }, 20_000);

  it('is deterministic per seed', async () => {
    const hashes = async (seed: number): Promise<number[]> => {
      const { extra, rivers, lakes } = await world(seed);
      return [hashBytes(extra.elevation), hashBytes(extra.waterClass), hashBytes(rivers.x), hashBytes(rivers.zWater), hashBytes(rivers.down), hashBytes(rivers.flags), lakes.length];
    };
    expect(await hashes(5)).toEqual(await hashes(5));
  }, 20_000);
});

describe('breachShallow', () => {
  it('drains a pit whose outlet lies below the spill but above the pit floor', () => {
    // A trough at 1 m between 50 m walls; the rim at 3 m, then terrain falling from 2.5 m to the sea.
    const n = 7;
    const h = new Float32Array(n * n);
    const fixed = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) h[y * n + x] = 50 + x + 10 * Math.abs(y - 3);
    const row = [1, 3, 2.5, 2, 1.5, 0.5, -10];
    for (let x = 0; x < n; x++) h[3 * n + x] = row[x];
    fixed[3 * n + 6] = 1;
    const r = breachShallow(h, n, fixed, 15, 10);
    expect(r.breached).toBe(1);
    for (let x = 1; x < 6; x++) expect(h[3 * n + x]).toBeLessThan(h[3 * n + x - 1]);
  });
});

describe('network scaling (research 02 §3.3)', () => {
  it('has a natural bifurcation ratio or Hack exponent on a finer grid', async () => {
    const w = await world(7, 'build', { lemGrid: '256', macroGrid: '512' });
    checkInvariants(w);
    const rb = bifurcationRatio(w.rivers).rb;
    const h = hackExponent(w.rivers).h;
    expect((rb >= 3 && rb <= 5.5) || (h >= 0.45 && h <= 0.7), `R_b ${rb}, Hack ${h}`).toBe(true);
  }, 30_000);
});
