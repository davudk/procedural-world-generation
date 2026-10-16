import type { Layer } from '../../shared/protocol';
import { applyArid } from '../landforms/arid';
import { applyCoastal } from '../landforms/coastal';
import { applyCraters } from '../landforms/impact';
import { applyKarst } from '../landforms/karst';
import type { Feature, LandformCtx } from '../landforms/types';
import { applyVolcanic } from '../landforms/volcanic';
import { FlowRouter } from '../lem/streamPower';
import type { StageDef } from '../pipeline';
import type { BaseExtra } from './base';
import type { ClimateExtra } from './climate';
import type { GlacialExtra } from './glacial';
import type { PlatesExtra } from './plates';

/** Terrain after the landform passes; hydrology and biomes read this. */
export interface LandformsExtra extends GlacialExtra {
  features: Feature[];
  masks: Map<string, Uint8Array>;
}

/**
 * S10 Landforms (run before hydrology so crater/caldera lakes, lagoons and karst drainage fall out of
 * the water balance): fresh volcanoes and calderas, fresh impact craters, the arid set (mesas, buttes,
 * ergs), karst, then the coastal set (barrier islands, lagoons, spits, cliffs, reefs, atolls).
 * Each pass edits the macro heights in place and keeps the ocean mask (`fixed`) consistent.
 */
export const landformsStage: StageDef = {
  id: 'landforms',
  label: 'Landforms',
  inputs: ['plates', 'base', 'climate', 'glacial'],
  reads: [
    'worldSize', 'volcanism', 'calderaShare', 'hotspotCount', 'impactHistory', 'craterCount', 'craterDiameter', 'geologicAge',
    'strataShare', 'karstShare', 'islandAbundance', 'waveEnergy', 'tideRange', 'coastRoughness',
    'density_relief', 'density_water', 'density_volcanic', 'density_coast', 'density_arid', 'density_karst',
  ],
  async run(ctx) {
    const g = ctx.input('glacial').extra as GlacialExtra;
    const h = g.h.slice();
    const fixed = g.fixed.slice();
    const plates = ctx.input('plates').extra as PlatesExtra;
    const base = ctx.input('base').extra as BaseExtra;
    const c: LandformCtx = {
      grid: ctx.grid(g.n), platesGrid: ctx.grid(plates.n), baseGrid: ctx.grid(base.n),
      n: g.n, cellKm: g.cellKm, worldKm: ctx.num('worldSize'), h, fixed, ice: g.ice,
      climate: ctx.input('climate').extra as ClimateExtra,
      plates, base,
      num: ctx.num, range: ctx.range, str: ctx.str, drawn: ctx.drawn,
      rng: (...k) => ctx.rng(...k),
      features: [], masks: new Map(), stats: {},
    };
    const passes: [string, (c: LandformCtx) => void][] = [
      ['volcanic', applyVolcanic], ['impact', applyCraters], ['arid', applyArid], ['karst', applyKarst], ['coastal', applyCoastal],
    ];
    for (const [name, pass] of passes) {
      const t0 = performance.now();
      pass(c);
      c.stats[`${name}Ms`] = performance.now() - t0;
      await ctx.checkpoint();
    }

    // Terrain changed: re-route so hydrology starts from current drainage.
    const router = new FlowRouter(c.grid, fixed);
    router.route(h, null);
    const area = Float32Array.from(router.area);
    const rcv = router.rcv.slice();

    const worldKm = ctx.num('worldSize');
    const layers: Layer[] = [];
    for (const [id, m] of c.masks) {
      layers.push({ id, label: `Landform mask: ${id}`, stage: 'landforms', kind: 'scalar', w: g.n, h: g.n, worldKm, unit: '', min: 0, max: 255, data: m });
    }
    const counts: Record<string, number> = {};
    for (const f of c.features) counts[`n_${f.type}`] = (counts[`n_${f.type}`] ?? 0) + 1;
    const extra: LandformsExtra = { ...g, h, fixed, area, rcv, features: c.features, masks: c.masks };
    return { layers, stats: { ...c.stats, ...counts, features: c.features.length }, outcomes: {}, extra };
  },
};
