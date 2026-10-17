import type { Landmark, LandmarkKind, Tier } from '../../shared/landmarks';
import { hashMix, hashString } from '../../shared/hash';
import { applyWBudget, SPHERE_W_VIEWS } from './budget';
import { own } from './candidate';
import type { Namer } from './names';
import type { Candidate, HeroCat, Shared } from './types';

/** Cross-kind weight of importance (global label priority, research 05 §3.2 bands). */
const KIND_WEIGHT: Record<LandmarkKind, number> = {
  continent: 1, ocean: 1, sea: 0.85, range: 0.85, river: 0.8, icecap: 0.75, desert: 0.75, gulf: 0.7, archipelago: 0.7, rift: 0.65,
  plateau: 0.6, lake: 0.6, crater: 0.65, volcano: 0.6, erg: 0.6, forest: 0.55, canyon: 0.6, peak: 0.55, caldera: 0.55, island: 0.55,
  peninsula: 0.55, strait: 0.55, delta: 0.5, fjord: 0.5, isthmus: 0.45, wetland: 0.45, plain: 0.45, 'mesa-field': 0.45, karst: 0.45,
  bay: 0.45, atoll: 0.45, glacier: 0.4, cape: 0.4, lagoon: 0.35, reef: 0.35, waterfall: 0.35, hill: 0.3, grassland: 0.5, pass: 0.3, gorge: 0.35,
};

const DEFAULT_TIER: Record<LandmarkKind, Tier> = {
  continent: 'common', ocean: 'common', sea: 'uncommon', range: 'uncommon', river: 'uncommon', icecap: 'uncommon', desert: 'uncommon',
  gulf: 'uncommon', archipelago: 'uncommon', rift: 'uncommon', plateau: 'uncommon', lake: 'common', crater: 'rare', volcano: 'uncommon',
  erg: 'uncommon', forest: 'common', canyon: 'uncommon', peak: 'common', caldera: 'rare', island: 'common', peninsula: 'uncommon',
  strait: 'uncommon', delta: 'uncommon', fjord: 'common', isthmus: 'uncommon', wetland: 'common', plain: 'common', 'mesa-field': 'uncommon',
  karst: 'uncommon', bay: 'common', atoll: 'rare', glacier: 'common', cape: 'common', lagoon: 'common', reef: 'uncommon', waterfall: 'common',
  hill: 'common', grassland: 'common', pass: 'common', gorge: 'common',
};

/** Pixels a feature must span to read at a zoom band: W ≈ 640 m/px shows features ≥ ~15 km (research 05 §3.2). */
const PX_TO_READ = 23;
/** Hero rules (research 05 §3.4): legible at band W and a quarter of the world apart. */
const HERO_MIN_FOOTPRINT_M = 15000;
/** Hero spacing as a share of the world width, and the relaxed spacing used when the pool runs short. */
export const HERO_SPACING = 1 / 4;
export const HERO_SPACING_SHORT = 1 / 5;
/** Last resort for worlds whose land is one small cluster (archipelago seeds with all land in ~300 km). */
export const HERO_SPACING_MIN = 1 / 7;
const W_BAND_MPP = 640;
/**
 * Labels readable at the whole-world view, heroes and the king aside. A land-weighted W view sees
 * ~60–70 % of them: ~45 keeps a world screen near 30 labels (harness cap 60 at p95; M8 baseline 56–100).
 */
const W_LABELS = 45;

/** Menu weights: how strongly each hero category reads as "special". */
const HERO_WEIGHT: Record<HeroCat, number> = {
  massif: 1, 'great-river': 1, 'great-lake': 1, 'fjord-coast': 1.05, volcano: 1, crater: 1.1, 'sand-sea': 1, canyon: 1.05, archipelago: 1,
  'karst-towers': 1.05, 'salt-basin': 0.95, reef: 0.95,
};

export interface Ranked {
  landmarks: Landmark[];
  heroes: number[];
  /** Legible hero candidates scoring ≥ 0.2 (before spacing). */
  heroPool: string[];
  /** Landmark index per candidate. */
  index: Map<Candidate, number>;
  /** W-scale candidates dropped by the world-band budget, and the registry's share of that budget. */
  wDropped: number;
  wQuota: number;
}

/**
 * Importance, zoom band, tier, name and hero status for every candidate, then the output list
 * ordered by importance (ids are list indices).
 */
export function rankAndName(
  all: Candidate[], S: Shared, namer: Namer, worldM: number, heroCount: number, externalW: { count: number; xs: number[]; ys: number[] },
  afterBudget?: (kept: Candidate[], dropped: readonly Candidate[]) => void,
): Ranked {
  const imp = new Map<Candidate, number>();
  const score = (c: Candidate): void => {
    let v = KIND_WEIGHT[c.kind] * (0.3 + 0.7 * Math.min(1, Math.max(0, c.mag)));
    if (c.data.worldKing) v = Math.max(v, 0.8);
    else if (c.data.rangeKing) v += 0.08;
    imp.set(c, Math.min(1, v));
  };
  for (const c of all) score(c);

  // Heroes: best-scoring legible candidates, a quarter of the world apart (a fifth, then a seventh when
  // the pool runs short, research 05 §3.4 / M8 baseline rec. 12), distinct categories first.
  const pool = all.filter((c) => c.hero && Math.max(c.extentM, c.visM ?? 0) >= HERO_MIN_FOOTPRINT_M);
  pool.sort((a, b) => b.hero!.score * HERO_WEIGHT[b.hero!.cat] - a.hero!.score * HERO_WEIGHT[a.hero!.cat] || imp.get(b)! - imp.get(a)!);
  const heroes: Candidate[] = [];
  for (const spacing of [worldM * HERO_SPACING, worldM * HERO_SPACING_SHORT, worldM * HERO_SPACING_MIN]) {
    for (const [distinct, minScore] of [[true, 0.5], [false, 0.5], [true, 0.2], [false, 0.2]] as const) {
      for (const c of pool) {
        if (heroes.length >= heroCount) break;
        if (heroes.includes(c) || c.hero!.score < minScore) continue;
        if (distinct && heroes.some((h) => h.hero!.cat === c.hero!.cat)) continue;
        if (heroes.some((h) => S.geo.dist(h.x, h.y, c.x, c.y) < spacing)) continue;
        heroes.push(c);
      }
    }
  }
  for (const h of heroes) imp.set(h, Math.min(1, Math.max(imp.get(h)!, 0.9) + 0.05 * Math.min(1, h.hero!.score)));

  // World-band interest budget (research 05 §3.2, M8 baseline rec. 4).
  const prot = new Set<Candidate>(heroes);
  for (const c of all) if (c.data.worldKing || c.data.wFill) prot.add(c);
  const budget = applyWBudget(all, imp, prot, worldM, externalW, S.geo);
  const cands = budget.kept;
  // Later passes (the region / area fill) see what the budget left and may add candidates.
  if (afterBudget) {
    afterBudget(cands, budget.dropped);
    for (const c of cands) if (!imp.has(c)) score(c);
  }

  // Kinds tie-break in code-unit order: localeCompare would follow the worker's locale.
  const order = cands.slice().sort((a, b) => imp.get(b)! - imp.get(a)! || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || a.idX - b.idX || a.idY - b.idY);
  // Sources of shared names first (rivers before their deltas and canyons).
  const named = new Map<Candidate, [string, string]>();
  const langOf = (c: Candidate): number => {
    const k = c.landmass ?? -1;
    if (k >= 0 && !S.continents.has(k)) {
      const M = S.masses;
      // Spheres: the island's mean direction.
      if (M.dir) return namer.langAt(...S.geo.fromDir(M.dir[3 * k], M.dir[3 * k + 1], M.dir[3 * k + 2]));
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
  // World-band label budget (M8 baseline rec. 4): at the whole-world view only the W_LABELS most
  // important landmarks keep their label; the rest appear from the next zoom step on.
  const wMpp = worldM / 1600;
  let wLabels = 0;
  const wLabelCap = S.sphere ? W_LABELS * SPHERE_W_VIEWS : W_LABELS;
  for (const c of order) {
    const isHero = heroes.includes(c);
    let maxMpp = Math.min(50000, Math.max(5, (c.visM ?? c.extentM) / PX_TO_READ));
    if (isHero || c.data.worldKing) maxMpp = Math.max(maxMpp, W_BAND_MPP * 1.1, wMpp * 1.1);
    // A globe from space always names its continents and oceans.
    else if (S.sphere && (c.kind === 'continent' || c.kind === 'ocean')) maxMpp = Math.max(maxMpp, wMpp * 1.1);
    else if (maxMpp >= wMpp && ++wLabels > wLabelCap) maxMpp = 0.95 * wMpp;
    const lm: Landmark = {
      id: landmarks.length, kind: c.kind, name: named.get(c)![0], x: c.x, y: c.y, angle: c.angle, extentM: c.extentM,
      importance: Math.round(imp.get(c)! * 1000) / 1000, maxMpp: Math.round(maxMpp), data: c.data,
      tier: isHero && c.tier !== 'legendary' && c.tier !== 'rare' ? 'rare' : (c.tier ?? DEFAULT_TIER[c.kind]), hero: isHero,
    };
    if (S.sphere) {
      // Decoded: face plus face-local metres (shared/landmarks.ts), per point for paths.
      lm.face = S.geo.faceOf(c.x);
      lm.x = S.geo.u(c.x);
      if (c.path && c.path.length >= 4) {
        const n = c.path.length >> 1;
        const path = new Float32Array(2 * n);
        const pathFace = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          pathFace[i] = S.geo.faceOf(c.path[2 * i]);
          path[2 * i] = S.geo.u(c.path[2 * i]);
          path[2 * i + 1] = c.path[2 * i + 1];
        }
        lm.path = path;
        lm.pathFace = pathFace;
      }
    } else if (c.path && c.path.length >= 4) lm.path = c.path as Float32Array;
    if (isHero) lm.data = { ...c.data, heroScore: Math.round(c.hero!.score * 100) / 100 };
    index.set(c, lm.id);
    // Kept as a copy of its own, like candidates (candidate.ts: V8 Maglev workaround).
    landmarks.push(own(lm));
  }
  const heroPool = pool.filter((c) => c.hero!.score >= 0.2).map((c) => `${c.hero!.cat}:${c.hero!.score.toFixed(2)}@${Math.round(c.x / 1000)},${Math.round(c.y / 1000)}`);
  return { landmarks, heroes: heroes.map((h) => index.get(h)!), heroPool, index, wDropped: budget.dropped.length, wQuota: budget.quota };
}
