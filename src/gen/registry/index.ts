import type { Landmark, WorldTraits } from '../../shared/landmarks';
import type { Rng } from '../../shared/rng';
import { externalWScale } from './budget';
import { fillGlobe, fillSummits, fillWorld } from './fill';
import { detectLand } from './land';
import { Namer } from './names';
import { rankAndName } from './rank';
import { detectRegions } from './regions';
import { detectRelief } from './relief';
import { detectWaters } from './rivers';
import { computeShared } from './shared';
import { worldTraits } from './traits';
import type { Candidate, RegistryInput } from './types';
import { detectWater, type OceanSplit } from './water';

export interface Registry {
  landmarks: Landmark[];
  traits: WorldTraits;
  stats: Record<string, number>;
  /** Hero candidates considered (category:score@x,y km), for diagnostics. */
  heroPool: string[];
  /** Spheres: the world ocean's partition into the ocean landmarks (regional grid), for tests. */
  oceans?: OceanSplit;
  oceanGrid?: RegistryInput['fine'];
}

/**
 * S11 landmark registry (PLAN.md §6, research 05 §3): detect significant features, rank them on one
 * global importance scale with a zoom band each, name them, pick the heroes and summarise the world.
 */
export async function buildRegistry(I: RegistryInput, heroCount: number, rng: Rng, checkpoint: () => Promise<void>): Promise<Registry> {
  const stats: Record<string, number> = {};
  let t = performance.now();
  const lap = (k: string): void => {
    const now = performance.now();
    stats[`ms_${k}`] = Math.round((now - t) * 10) / 10;
    t = now;
  };
  const S = computeShared(I);
  lap('shared');
  const cands: Candidate[] = [];
  detectLand(I, S, cands);
  lap('land');
  detectWater(I, S, cands);
  lap('water');
  await checkpoint();
  t = performance.now();
  const relief = detectRelief(I, S, cands);
  lap('relief');
  detectWaters(I, S, cands, relief.rangeOf);
  lap('rivers');
  detectRegions(I, S, cands);
  lap('regions');
  const worldM = I.worldKm * 1000;
  const namer = new Namer(I.seed, rng, worldM, S.geo);
  // The fills run after the world-band budget, on what it kept: the world fill names the cover of land
  // the budget left far from every world-scale feature, and a summit whose volcano the budget dropped
  // is free again for the region fill.
  const ranked = rankAndName(cands, S, namer, worldM, heroCount, externalWScale(I, S), (kept, dropped) => {
    for (const c of dropped) if (c.summit !== undefined) relief.used[c.summit] = 0;
    const t0 = performance.now();
    stats.fillW = fillWorld(I, S, kept);
    if (S.sphere) stats.fillG = fillGlobe(I, S, kept);
    const filled = fillSummits(I, S, kept, relief);
    stats.fillR = filled.r;
    stats.fillA = filled.a;
    stats.ms_fill = Math.round((performance.now() - t0) * 10) / 10;
  });
  lap('names');
  stats.wDropped = ranked.wDropped;
  stats.wQuota = ranked.wQuota;
  const traits = worldTraits(I, S, ranked.landmarks, ranked.heroes);
  lap('traits');
  for (const l of ranked.landmarks) stats[`n_${l.kind}`] = (stats[`n_${l.kind}`] ?? 0) + 1;
  stats.landmarks = ranked.landmarks.length;
  stats.heroes = ranked.heroes.length;
  stats.heroTarget = heroCount;
  stats.heroCandidates = ranked.heroPool.length;
  stats.cultures = namer.cultures.length;
  if (S.oceans) stats.oceans = S.oceans.peaks.length;
  return { landmarks: ranked.landmarks, traits, stats, heroPool: ranked.heroPool, ...(S.oceans ? { oceans: S.oceans, oceanGrid: S.reg } : {}) };
}
