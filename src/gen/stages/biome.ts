import { BIOME, BIOMES } from '../../shared/biomes';
import { Noise2 } from '../../shared/noise';
import type { Layer } from '../../shared/protocol';
import { classifyBiomes } from '../climate/biomes';
import type { StageDef } from '../pipeline';
import type { ClimateExtra } from './climate';
import type { HydroExtra } from './hydro';
import type { ErodedExtra } from './lem';

/** Biome output for later stages (landforms, GPU packing). All rasters n×n, row-major. */
export interface BiomeExtra {
  n: number;
  cellKm: number;
  /** BIOME ids (0 = water). */
  biome: Uint8Array;
  /** Canopy cover 0–1 (table cover × moisture and warmth, with 2–10 km mosaic). */
  canopy: Float32Array;
  /** Aridity index P / PET (clamped to 10). */
  aridity: Float32Array;
  /** Perennial snow and ice cover 0–1 (soft edges around the glacier rule). */
  snow: Float32Array;
}

/** Share of land below which a biome does not count as present. */
const PRESENT_SHARE = 0.001;

/**
 * S9 Biomes (research 03 §3): ordered Köppen-style rules over jittered climate inputs with ice, rock,
 * coast, salt-flat and wetland overrides, then a 3×3 majority filter; canopy, aridity and snow.
 */
export const biomeStage: StageDef = {
  id: 'biome',
  label: 'Biomes',
  inputs: ['landforms', 'climate', 'hydro'],
  reads: ['worldSize', 'glaciation'],
  async run(ctx) {
    const t = ctx.input('landforms').extra as ErodedExtra;
    const cl = ctx.input('climate').extra as ClimateExtra;
    const hy = ctx.input('hydro').extra as HydroExtra;
    const { n, cellKm } = cl;
    if (t.n !== n || hy.n !== n) throw new Error(`biome: grids differ (${t.n}, ${n}, ${hy.n})`);
    const f = classifyBiomes({
      n, cellKm, h: t.h, temp: cl.temp, tAmp: cl.tAmp, precip: cl.precip, pSummer: cl.pSummer, pet: cl.pet, fog: cl.fog, coastKm: cl.coastKm,
      waterClass: hy.waterClass, discharge: hy.discharge,
      // glaciation 1 = the Ohmura relation as is; each unit moves the ELA by 2 °C (~300 m).
      elaShift: 2 * (ctx.num('glaciation') - 1),
      noise: new Noise2(ctx.rng('noise').nextU32()),
    });

    await ctx.checkpoint();

    const counts = new Float64Array(BIOMES.length);
    for (const b of f.biome) counts[b]++;
    const land = n * n - counts[BIOME.WATER];
    const stats: Record<string, number> = {};
    let present = 0;
    let canopySum = 0;
    for (let i = 0; i < n * n; i++) canopySum += f.canopy[i];
    for (const info of BIOMES) {
      if (info.id === BIOME.WATER) continue;
      const share = land > 0 ? counts[info.id] / land : 0;
      stats[info.name] = Math.round(share * 1e4) / 1e4;
      if (share >= PRESENT_SHARE) present++;
    }
    stats.distinctBiomes = present;
    stats.meanCanopy = land > 0 ? Math.round((canopySum / land) * 1000) / 1000 : 0;

    const worldKm = ctx.num('worldSize');
    const base = { stage: 'biome' as const, w: n, h: n, worldKm };
    const layers: Layer[] = [
      { ...base, id: 'biome', label: 'Biome', kind: 'categorical', unit: '', min: 0, max: BIOMES.length - 1, data: f.biome },
      { ...base, id: 'canopy', label: 'Canopy cover', kind: 'scalar', unit: '', min: 0, max: 1, data: f.canopy },
      { ...base, id: 'aridity', label: 'Aridity index (P/PET)', kind: 'scalar', unit: '', min: 0, max: 3, data: f.aridity },
      { ...base, id: 'snow', label: 'Perennial snow & ice', kind: 'scalar', unit: '', min: 0, max: 1, data: f.snow },
    ];
    const extra: BiomeExtra = { n, cellKm, ...f };
    return { layers, stats, outcomes: {}, extra };
  },
};
