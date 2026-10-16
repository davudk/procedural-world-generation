import type { Layer } from '../../shared/protocol';
import { glaciate } from '../glacial/glaciate';
import { repairDrainage } from '../glacial/repair';
import type { StageDef } from '../pipeline';
import { LEM_M } from './base';
import type { ClimateExtra } from './climate';
import type { ErodedExtra } from './lem';

/** Terrain after glacial carving: ErodedExtra plus glacier ice cover. */
export interface GlacialExtra extends ErodedExtra {
  /** Present-day glacier ice cover 0–1 (soft edges). */
  ice: Float32Array;
  /** Metres of rock removed by glacial carving (troughs, cirques, fjords). */
  carve: Float32Array;
  /** 1 = sea cell of a carved fjord. */
  fjord: Uint8Array;
}

/**
 * Temperature drop of the glacial maximum that carved the troughs, per unit of glaciation (°C).
 * Troughs and fjords are relics of past ice ages (LGM summers ~5–6 °C colder, ELA ~800 m lower),
 * so carving uses that colder ELA while `ice` shows the present-day glaciers.
 */
const PAST_COOLING = 5;
/** Repair: implicit stream-power steps of 20 kyr (~1/12 of an LEM step) on the carved surface. */
const REPAIR_ITERATIONS = 3;
const REPAIR_DT = 2e4;

/**
 * S7 Glacial (research 01 §5): ELA from the Ohmura relation (shifted 2 °C per unit of glaciation, as
 * the biome stage does), ice flux along the drainage, U-troughs with hanging tributaries, cirques and
 * — with `fjords` — over-deepened fjords with a mouth sill on cold coasts. Then a few uplift-free
 * stream-power steps re-integrate the drainage. A cheap pass-through when nothing reaches the ELA.
 */
export const glacialStage: StageDef = {
  id: 'glacial',
  label: 'Glaciers & fjords',
  inputs: ['refine', 'climate'],
  reads: ['glaciation', 'fjords', 'worldSize'],
  async run(ctx) {
    const t0 = performance.now();
    const t = ctx.input('refine').extra as ErodedExtra;
    const cl = ctx.input('climate').extra as ClimateExtra;
    const { n } = t;
    if (cl.n !== n) throw new Error(`glacial: grids differ (${n}, ${cl.n})`);
    const g = ctx.num('glaciation');
    const r = glaciate(
      { n, cellKm: t.cellKm, h: t.h, fixed: t.fixed, rcv: t.rcv, temp: cl.temp, tAmp: cl.tAmp, precip: cl.precip },
      { presentShift: 2 * (g - 1), pastShift: PAST_COOLING * g, fjords: ctx.bool('fjords') },
      ctx.rng('carve'),
    );
    const carveMs = performance.now() - t0;

    let extra: GlacialExtra;
    let repairMs = 0;
    let basinKm2 = 0;
    if (!r.carved) {
      extra = { ...t, h: r.h, fixed: r.fixed, ice: r.ice, carve: r.carve, fjord: r.fjord };
    } else {
      await ctx.checkpoint();
      // Repair: uplift-free stream-power steps on the re-routed carved surface, inside the carved
      // area only (no diffusion or talus, so it only lowers; the clamp makes that exact).
      const t1 = performance.now();
      const h = r.h;
      const active = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) active[i] = r.carve[i] > 0 ? 1 : 0;
      const lem = repairDrainage(h, r.fixed, t.K, n, t.cellKm * 1000, LEM_M, REPAIR_DT, REPAIR_ITERATIONS, active);
      repairMs = performance.now() - t1;
      basinKm2 = Math.round(lem.basinCells * t.cellKm * t.cellKm);
      for (let i = 0; i < n * n; i++) {
        if (r.fixed[i]) continue;
        if (h[i] > t.h[i]) h[i] = t.h[i];
        r.carve[i] = Math.max(0, t.h[i] - h[i]);
      }
      extra = { ...t, h, fixed: r.fixed, area: lem.area, rcv: lem.rcv, ice: r.ice, carve: r.carve, fjord: r.fjord };
    }

    const worldKm = ctx.num('worldSize');
    let carveMax = 0;
    for (const v of extra.carve) carveMax = Math.max(carveMax, v);
    const base = { stage: 'glacial' as const, kind: 'scalar' as const, w: n, h: n, worldKm };
    const layers: Layer[] = [
      { ...base, id: 'ice', label: 'Glacier ice', unit: '', min: 0, max: 1, data: extra.ice },
      { ...base, id: 'glacialCarve', label: 'Glacial carving (m removed)', unit: 'm', min: 0, max: Math.max(1, carveMax), data: extra.carve },
    ];
    const stats = { ...r.stats, glacialBasinKm2: basinKm2, carveMs, repairMs, ms: performance.now() - t0 };
    return { layers, stats, outcomes: {}, extra };
  },
};
