import { buildRegistry } from '../registry';
import type { StageDef } from '../pipeline';
import type { GridSpec } from '../registry/grid';
import type { OceanSplit } from '../registry/water';
import type { BiomeExtra } from './biome';
import type { ClimateExtra } from './climate';
import { WATER, type HydroExtra } from './hydro';
import type { LandformsExtra } from './landforms';
import type { PlatesExtra } from './plates';

/** Sphere worlds only: how the world ocean splits into the ocean landmarks (regional grid). */
export interface RegistryExtra {
  oceans: OceanSplit;
  oceanGrid: GridSpec;
}

/**
 * S11 Registry & names (PLAN.md §6 "Landmark registry", research 05 §3.2–3.4): detects named
 * features (peaks by prominence, ranges, seas, gulfs, straits, islands, peninsulas, rivers, lakes,
 * deserts, …), ranks them with a zoom band, names them per culture, picks the hero landmarks and
 * writes the World traits. On spheres positions are (face, u, v) and the world ocean is split into
 * oceans (research 10 §5.11).
 */
export const registryStage: StageDef = {
  id: 'registry',
  label: 'Landmarks & names',
  inputs: ['plates', 'climate', 'landforms', 'hydro', 'biome'],
  reads: ['worldSize', 'worldShape', 'planetSize', 'heroCount'],
  async run(ctx) {
    const t0 = performance.now();
    const hydroOut = ctx.input('hydro');
    const hydro = hydroOut.extra as HydroExtra;
    const landforms = ctx.input('landforms').extra as LandformsExtra;
    const biome = ctx.input('biome').extra as BiomeExtra;
    const climate = ctx.input('climate').extra as ClimateExtra;
    const plates = ctx.input('plates').extra as PlatesExtra;
    const { n } = hydro;
    if (landforms.n !== n || biome.n !== n || climate.n !== n) throw new Error('registry: grids differ');
    const fine = ctx.grid(n);
    const sea = new Uint8Array(fine.cells);
    for (let c = 0; c < fine.cells; c++) sea[c] = hydro.waterClass[c] === WATER.OCEAN ? 1 : 0;
    // Spheres: positions are (face, u, v) and the world size is the equal-area size √(4πR²) (schema sizeEff).
    const worldKm = fine.faces === 1 ? ctx.num('worldSize') : Math.sqrt(fine.totalArea) / 1000;
    const reg = await buildRegistry(
      {
        seed: ctx.seed, worldKm, fine, platesGrid: ctx.grid(plates.n), h: hydro.elevation, sea, hydro,
        rivers: hydroOut.vectors!.rivers!, lakes: hydroOut.vectors!.lakes ?? [], landforms, plates, biome, climate,
      },
      Math.round(ctx.drawn('heroCount')), ctx.rng('cultures'), ctx.checkpoint,
    );
    const stats = { ...reg.stats, ms: Math.round((performance.now() - t0) * 10) / 10 };
    // Spheres: the ocean partition, for tests (RegistryExtra).
    const extra: RegistryExtra | undefined = reg.oceans && reg.oceanGrid ? { oceans: reg.oceans, oceanGrid: reg.oceanGrid } : undefined;
    return { layers: [], stats, outcomes: {}, vectors: { landmarks: reg.landmarks, traits: reg.traits }, ...(extra ? { extra } : {}) };
  },
};
