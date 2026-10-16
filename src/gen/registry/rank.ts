import type { Landmark, LandmarkKind, Tier } from '../../shared/landmarks';
import { hashMix, hashString } from '../../shared/hash';
import type { Namer } from './names';
import type { Candidate, HeroCat, Shared } from './types';

/** Cross-kind weight of importance (global label priority, research 05 §3.2 bands). */
const KIND_WEIGHT: Record<LandmarkKind, number> = {
  continent: 1, ocean: 1, sea: 0.85, range: 0.85, river: 0.8, icecap: 0.75, desert: 0.75, gulf: 0.7, archipelago: 0.7, rift: 0.65,
  plateau: 0.6, lake: 0.6, crater: 0.65, volcano: 0.6, erg: 0.6, forest: 0.55, canyon: 0.6, peak: 0.55, caldera: 0.55, island: 0.55,
  peninsula: 0.55, strait: 0.55, delta: 0.5, fjord: 0.5, isthmus: 0.45, wetland: 0.45, plain: 0.45, 'mesa-field': 0.45, karst: 0.45,
  bay: 0.45, atoll: 0.45, glacier: 0.4, cape: 0.4, lagoon: 0.35, reef: 0.35, waterfall: 0.35,
};

const DEFAULT_TIER: Record<LandmarkKind, Tier> = {
  continent: 'common', ocean: 'common', sea: 'uncommon', range: 'uncommon', river: 'uncommon', icecap: 'uncommon', desert: 'uncommon',
  gulf: 'uncommon', archipelago: 'uncommon', rift: 'uncommon', plateau: 'uncommon', lake: 'common', crater: 'rare', volcano: 'uncommon',
  erg: 'uncommon', forest: 'common', canyon: 'uncommon', peak: 'common', caldera: 'rare', island: 'common', peninsula: 'uncommon',
  strait: 'uncommon', delta: 'uncommon', fjord: 'common', isthmus: 'uncommon', wetland: 'common', plain: 'common', 'mesa-field': 'uncommon',
  karst: 'uncommon', bay: 'common', atoll: 'rare', glacier: 'common', cape: 'common', lagoon: 'common', reef: 'uncommon', waterfall: 'common',
};

/** Pixels a feature must span to read at a zoom band: W ≈ 640 m/px shows features ≥ ~15 km (research 05 §3.2). */
const PX_TO_READ = 23;
/** Hero rules (research 05 §3.4): legible at band W and a quarter of the world apart. */
const HERO_MIN_FOOTPRINT_M = 15000;
const W_BAND_MPP = 640;

/** Menu weights: how strongly each hero category reads as "special". */
const HERO_WEIGHT: Record<HeroCat, number> = {
  massif: 1, 'great-river': 1, 'great-lake': 1, 'fjord-coast': 1.05, volcano: 1, crater: 1.1, 'sand-sea': 1, canyon: 1.05, archipelago: 1,
  'karst-towers': 1.05, 'salt-basin': 0.95,
};

export interface Ranked {
  landmarks: Landmark[];
  heroes: number[];
  /** Legible hero candidates scoring ≥ 0.2 (before spacing). */
  heroPool: string[];
  /** Landmark index per candidate. */
  index: Map<Candidate, number>;
}

/**
 * Importance, zoom band, tier, name and hero status for every candidate, then the output list
 * ordered by importance (ids are list indices).
 */
export function rankAndName(cands: Candidate[], S: Shared, namer: Namer, worldM: number, heroCount: number): Ranked {
  const imp = new Map<Candidate, number>();
  for (const c of cands) {
    let v = KIND_WEIGHT[c.kind] * (0.3 + 0.7 * Math.min(1, Math.max(0, c.mag)));
    if (c.data.worldKing) v = Math.max(v, 0.8);
    else if (c.data.rangeKing) v += 0.08;
    imp.set(c, Math.min(1, v));
  }

  // Heroes: best-scoring legible candidates, a quarter of the world apart, distinct categories first.
  const pool = cands.filter((c) => c.hero && Math.max(c.extentM, c.visM ?? 0) >= HERO_MIN_FOOTPRINT_M);
  pool.sort((a, b) => b.hero!.score * HERO_WEIGHT[b.hero!.cat] - a.hero!.score * HERO_WEIGHT[a.hero!.cat] || imp.get(b)! - imp.get(a)!);
  const heroes: Candidate[] = [];
  const spacing = worldM / 4;
  for (const [distinct, minScore] of [[true, 0.5], [false, 0.5], [true, 0.2], [false, 0.2]] as const) {
    for (const c of pool) {
      if (heroes.length >= heroCount) break;
      if (heroes.includes(c) || c.hero!.score < minScore) continue;
      if (distinct && heroes.some((h) => h.hero!.cat === c.hero!.cat)) continue;
      if (heroes.some((h) => Math.hypot(h.x - c.x, h.y - c.y) < spacing)) continue;
      heroes.push(c);
    }
  }
  for (const h of heroes) imp.set(h, Math.min(1, Math.max(imp.get(h)!, 0.9) + 0.05 * Math.min(1, h.hero!.score)));

  const order = cands.slice().sort((a, b) => imp.get(b)! - imp.get(a)! || a.kind.localeCompare(b.kind) || a.idX - b.idX || a.idY - b.idY);
  // Sources of shared names first (rivers before their deltas and canyons).
  const named = new Map<Candidate, [string, string]>();
  const langOf = (c: Candidate): number => {
    const k = c.landmass ?? -1;
    if (k >= 0 && !S.continents.has(k)) {
      const M = S.masses;
      const cell = S.masses.label.length ** 0.5;
      const m = worldM / cell;
      return namer.langAt((M.sx[k] / M.size[k] + 0.5) * m, (M.sy[k] / M.size[k] + 0.5) * m);
    }
    return namer.langAt(c.idX, c.idY);
  };
  const ident = (c: Candidate): number => hashMix(hashMix(hashString(c.kind), Math.floor(c.idX / 8000)), Math.floor(c.idY / 8000));
  for (const pass of [0, 1]) {
    for (const c of order) {
      if (named.has(c) || (pass === 0) !== !c.nameFrom) continue;
      const src = c.nameFrom ? named.get(c.nameFrom) : undefined;
      named.set(c, namer.name(c.kind, c.variant, src ? namer.langAt(c.nameFrom!.idX, c.nameFrom!.idY) : langOf(c), ident(c), src?.[1]));
    }
  }

  const landmarks: Landmark[] = [];
  const index = new Map<Candidate, number>();
  for (const c of order) {
    const isHero = heroes.includes(c);
    let maxMpp = Math.min(50000, Math.max(5, (c.visM ?? c.extentM) / PX_TO_READ));
    if (isHero || c.data.worldKing) maxMpp = Math.max(maxMpp, W_BAND_MPP * 1.1);
    const lm: Landmark = {
      id: landmarks.length, kind: c.kind, name: named.get(c)![0], x: c.x, y: c.y, angle: c.angle, extentM: c.extentM,
      importance: Math.round(imp.get(c)! * 1000) / 1000, maxMpp: Math.round(maxMpp), data: c.data,
      tier: isHero && c.tier !== 'legendary' && c.tier !== 'rare' ? 'rare' : (c.tier ?? DEFAULT_TIER[c.kind]), hero: isHero,
    };
    if (c.path && c.path.length >= 4) lm.path = c.path;
    if (isHero) lm.data = { ...c.data, heroScore: Math.round(c.hero!.score * 100) / 100 };
    index.set(c, lm.id);
    landmarks.push(lm);
  }
  const heroPool = pool.filter((c) => c.hero!.score >= 0.2).map((c) => `${c.hero!.cat}:${c.hero!.score.toFixed(2)}@${Math.round(c.x / 1000)},${Math.round(c.y / 1000)}`);
  return { landmarks, heroes: heroes.map((h) => index.get(h)!), heroPool, index };
}
