/**
 * Runs the generation pipeline for one world and measures it (research 05 §3.2–3.6, §5): counts and
 * rates, 🎯 target satisfaction, the per-band interest budget over random viewports, Clark–Evans,
 * contrast rules, geomorphic realism and the boring / cluttered detectors. The result is plain JSON.
 */
import { Pipeline } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import type { BiomeExtra } from '../src/gen/stages/biome';
import { WATER, type HydroExtra } from '../src/gen/stages/hydro';
import type { LandformsExtra } from '../src/gen/stages/landforms';
import { BIOMES } from '../src/shared/biomes';
import { resolve } from '../src/shared/config/resolve';
import type { Pins, Range } from '../src/shared/config/types';
import { specToQuery } from '../src/shared/config/url';
import type { Landmark, LandmarkKind } from '../src/shared/landmarks';
import { RIVER, type GenMode, type LakeInfo, type RiverGraph } from '../src/shared/protocol';
import {
  boxCountDimension, ccdfExponent, clarkEvans, coefVar, components, edtSquared, entropy, largestEmptyDisk, prng,
  quantileSorted, rasterDisk, rasterLine,
} from './lib/math';
import {
  BANDS, BORING, CLUTTER_W_MAX, COUNT_TARGETS, CONTRAST, contrastFor, CV_GRID, DISK_CLUSTER_CAP, LABEL_CAP, OCEAN_VIEW_LAND, QUIET, SCREEN_PX, VIEW_ASPECT,
  WINDOW_HI, WINDOW_LO, type BandDef, type BandId,
} from './targets';

export interface WorldJob {
  archetype: string;
  seed: number;
  mode: GenMode;
  pins?: Pins;
  /** Group key in the report (e.g. 'main', 'build', 'size-512'). */
  group: string;
  /** Viewports per band: land-weighted and uniform (W uses a quarter). */
  views?: { land: number; uniform: number };
}

export interface BandSample {
  counts: number[];
  entropy: number[];
  cv: number[];
  emptyKm: number[];
  labels: number[];
  landShare: number[];
  /** W only: how many of {high relief, open water, biome boundary} the view holds. */
  contrast: number[];
}

export interface BandResult {
  viewKm: number;
  capKm: number;
  /** Land-weighted viewports with ≥ 10 % land. */
  land: BandSample;
  /** Uniformly placed viewports (land or not; ocean ones are also in `ocean`). */
  uniform: BandSample;
  /** Counts of uniform viewports with < 10 % land (targets halved). */
  ocean: number[];
  /** Mean count per feature class over the land-weighted viewports (what fills the view). */
  classMean: Record<string, number>;
}

export interface TargetOutcome {
  got: number;
  drawn?: number;
  range?: [number, number];
  value?: number;
  ok: boolean;
  /** Secondary rule (count: |got − drawn| ≤ 1, or = drawn for continents; riverDensity: UI rule). */
  okAlt: boolean;
}

export interface WorldMetrics {
  archetype: string;
  seed: number;
  mode: GenMode;
  group: string;
  query: string;
  ms: number;
  worldKm: number;
  cellKm: number;
  landKm2: number;
  coastKm: number;
  warmOceanKm2: number;
  /** Raw counts (per world). */
  counts: Record<string, number>;
  /** Values in the unit of each COUNT_TARGETS row (per 10⁵ km² land, per 1000 km coast, per world …). */
  rates: Record<string, number>;
  /** Normalised feature table: per 10⁵ km² land (`land`) or per 1000 km coast (`coast`). */
  features: Record<string, { count: number; per: 'land' | 'coast' | 'warm'; rate: number }>;
  kinds: Record<string, number>;
  tiers: Record<string, number>;
  heroes: { count: number; target: number; minSpacingFrac: number; kinds: string[] };
  targets: Record<string, TargetOutcome>;
  contrast: { lowShare: number; highShare: number; kingRatio: number; kingM: number; wViewOk: number };
  geomorph: { hortonRb: number; hackExponent: number; lakeParetoB: number; lakeN: number; korcakB: number; islandN: number; coastD: number };
  clarkEvans: Record<string, number>;
  clusterDisk: Record<string, number>;
  quietShare: number;
  biome: { maxShare: number; maxName: string; distinct: number };
  bands: Record<BandId, BandResult>;
  boring: string[];
  cluttered: string[];
}

/** Landmark kinds counted from other sources in the interest budget (river graph, lake list). */
const SKIP_KINDS = new Set<LandmarkKind>(['river', 'lake']);
/** Kinds that cover whole regions: counted in views but never painted in the empty-disk mask. */
const SEA_OR_MASS = new Set<string>(['continent', 'ocean', 'sea', 'gulf', 'strait']);
/**
 * Landform-pass features with no landmark of their own (volcanoes, craters, reefs … are landmarks).
 * Sea cliffs and escarpments are left out: they are stretches of shoreline / plateau edge character
 * (one "feature" per coast cell run, ~30 per W view), not distinct places a viewer would count.
 */
const EXTRA_FEATURES = new Set(['sea-stack', 'spit', 'tombolo', 'barrier-island', 'inselberg', 'ria', 'cinder-field', 'cenote', 'geothermal']);
const VOLCANO_TYPES = new Set(['stratovolcano', 'shield-volcano', 'caldera']);

/** A feature for the interest budget (map metres). */
interface Feat {
  cls: string;
  x: number;
  y: number;
  /** Characteristic size (m). */
  ext: number;
  /** Polyline (x,y pairs) for rivers, ranges, canyons, fjords. */
  pts?: Float32Array;
  /** Radius painted in the empty-disk mask (m); −1 = never painted. */
  r: number;
  order: number;
  bx0: number;
  by0: number;
  bx1: number;
  by1: number;
}

interface Stream {
  order: number;
  lengthM: number;
  pts: Float32Array;
}

/** Strahler streams: maximal runs of one order going downstream (distributaries left out). */
export function streams(g: RiverGraph): Stream[] {
  const maxIn = new Uint8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const d = g.down[i];
    if (d >= 0 && !(g.flags[i] & RIVER.DISTRIBUTARY)) maxIn[d] = Math.max(maxIn[d], g.strahler[i]);
  }
  const out: Stream[] = [];
  for (let i = 0; i < g.n; i++) {
    if (g.flags[i] & RIVER.DISTRIBUTARY) continue;
    const s = g.strahler[i];
    if (s === 0 || maxIn[i] >= s) continue;
    const pts: number[] = [g.x[i], g.y[i]];
    let len = 0;
    let c = i;
    for (let guard = 0; guard < g.n; guard++) {
      const d = g.down[c];
      if (d < 0) break;
      len += Math.hypot(g.x[d] - g.x[c], g.y[d] - g.y[c]);
      pts.push(g.x[d], g.y[d]);
      if (g.strahler[d] !== s || g.flags[d] & RIVER.DISTRIBUTARY) break;
      c = d;
    }
    out.push({ order: s, lengthM: len, pts: Float32Array.from(pts) });
  }
  return out;
}

function bbox(f: Omit<Feat, 'bx0' | 'by0' | 'bx1' | 'by1'>): Feat {
  let bx0 = f.x;
  let by0 = f.y;
  let bx1 = f.x;
  let by1 = f.y;
  if (f.pts) {
    for (let i = 0; i < f.pts.length; i += 2) {
      bx0 = Math.min(bx0, f.pts[i]);
      bx1 = Math.max(bx1, f.pts[i]);
      by0 = Math.min(by0, f.pts[i + 1]);
      by1 = Math.max(by1, f.pts[i + 1]);
    }
  }
  return { ...f, bx0, by0, bx1, by1 };
}

const PRESENT_SHARE = 0.1;

/** Runs one world and measures it. */
export async function measureWorld(job: WorldJob): Promise<WorldMetrics> {
  const t0 = performance.now();
  const spec = { seed: job.seed, archetype: job.archetype, pins: job.pins ?? {} };
  const resolved = resolve(spec);
  const p = new Pipeline(STAGES);
  const outcomes: Record<string, number> = {};
  let error = '';
  await p.run(resolved, job.mode, 1, (m) => {
    if (m.type === 'error') error = m.message;
    if (m.type === 'stage-done') Object.assign(outcomes, m.outcomes);
  }, () => false);
  if (error) throw new Error(`${job.archetype}/${job.seed}: ${error}`);

  const hydroOut = p.output('hydro')!;
  const hy = hydroOut.extra as HydroExtra;
  const rivers = hydroOut.vectors!.rivers!;
  const lakesAll: LakeInfo[] = hydroOut.vectors!.lakes ?? [];
  const lakes = lakesAll.filter((l) => l.type !== 'playa');
  const lf = p.output('landforms')!;
  const lfx = lf.extra as LandformsExtra;
  const glacial = p.output('glacial')!.stats;
  const biomeOut = p.output('biome')!;
  const bio = biomeOut.extra as BiomeExtra;
  const reg = p.output('registry')!;
  const landmarks: Landmark[] = reg.vectors!.landmarks!;
  const traits = reg.vectors!.traits!;
  const hs = hydroOut.stats;
  const ls = lf.stats;

  const worldKm = resolved.values.worldSize as number;
  const worldM = worldKm * 1000;
  const { n, cellKm } = hy;
  const cellM = cellKm * 1000;
  const N = n * n;
  const isLand = new Uint8Array(N);
  let landCells = 0;
  for (let i = 0; i < N; i++) {
    if (hy.waterClass[i] !== WATER.OCEAN) {
      isLand[i] = 1;
      landCells++;
    }
  }
  const landKm2 = landCells * cellKm * cellKm;
  const coastKm = ls.coastKm ?? 0;
  const warmOceanKm2 = ls.warmOceanKm2 ?? 0;

  // ── Counts ────────────────────────────────────────────────────────────────────────────────
  const kinds: Record<string, number> = {};
  const tiers: Record<string, number> = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
  for (const l of landmarks) {
    kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
    tiers[l.tier] = (tiers[l.tier] ?? 0) + 1;
  }
  const featCount = (t: string): number => lfx.features.filter((f) => f.type === t).length;
  const strs = streams(rivers);
  let maxOrder = 0;
  for (const s of strs) maxOrder = Math.max(maxOrder, s.order);
  let riversToSea = 0;
  for (let i = 0; i < rivers.n; i++) {
    const f = rivers.flags[i];
    if (f & RIVER.MOUTH_SEA && !(f & RIVER.DISTRIBUTARY) && rivers.strahler[i] >= 3) riversToSea++;
  }
  const lakeArea = lakes.map((l) => l.areaKm2);
  const between = (a: readonly number[], lo: number, hi: number): number => a.filter((v) => v >= lo && v < hi).length;

  // Land masses: continents are ≥ 5 % of land (as in the refine stage); the rest are islands.
  const comp = components(isLand, n, n);
  const massKm2 = comp.sizes.map((s) => s * cellKm * cellKm);
  const isContinent = comp.sizes.map((s) => s >= 0.05 * landCells);
  const islandKm2 = massKm2.filter((_, k) => !isContinent[k]);

  const peaks = landmarks.filter((l) => l.kind === 'peak');
  const summits = landmarks.filter((l) => l.kind === 'peak' || l.kind === 'volcano');
  const volcanoFeats = lfx.features.filter((f) => VOLCANO_TYPES.has(f.type));
  const craterFeats = lfx.features.filter((f) => f.type === 'crater');
  const deltas = (hs.deltasBirdsFoot ?? 0) + (hs.deltasArcuate ?? 0) + (hs.deltasCuspate ?? 0);

  const counts: Record<string, number> = {
    majorRanges: outcomes.mountainRangeCount ?? NaN,
    rangeLandmarks: kinds.range ?? 0,
    peaks: peaks.length,
    peaks3k: peaks.filter((l) => (l.data.heightM ?? 0) >= 3000).length,
    peaks5k: summits.filter((l) => (l.data.heightM ?? 0) >= 5000).length,
    ultras: summits.filter((l) => (l.data.prominenceM ?? 0) >= 1500).length,
    volcanoes: volcanoFeats.length,
    calderas: featCount('caldera'),
    craters: craterFeats.length,
    maxOrder,
    greatRivers: hs.greatRivers ?? NaN,
    rivers56: strs.filter((s) => s.order === 5 || s.order === 6).length,
    order6plus: strs.filter((s) => s.order >= 6).length,
    riversToSea,
    lakes: lakes.length,
    lakes1: between(lakeArea, 1, 10),
    lakes10: between(lakeArea, 10, 100),
    lakes100: between(lakeArea, 100, 1000),
    lakes1000: between(lakeArea, 1000, Infinity),
    playas: lakesAll.length - lakes.length,
    islands: islandKm2.length,
    islands1: between(islandKm2, 1, 100),
    islands100: between(islandKm2, 100, 10000),
    islands10k: islandKm2.filter((a) => a >= 10000).length,
    continents: isContinent.filter(Boolean).length,
    peninsulas: kinds.peninsula ?? 0,
    fjords: glacial.fjords ?? 0,
    fjordCoastKm: glacial.fjordCoastKm ?? 0,
    glaciers: glacial.glaciers ?? 0,
    ergs: ls.ergs ?? 0,
    canyons: kinds.canyon ?? 0,
    waterfalls: kinds.waterfall ?? 0,
    waterfallNodes: hs.waterfalls ?? 0,
    deltas,
    estuaries: hs.estuaries ?? 0,
    wetland: outcomes.wetlandShare ?? NaN,
    atolls: ls.atolls ?? 0,
    reefs: ls.reefTracts ?? 0,
    barrierIslands: ls.barrierIslands ?? 0,
    lagoons: ls.lagoons ?? 0,
    seaStacks: ls.seaStacks ?? 0,
    rias: ls.rias ?? 0,
    spits: ls.spits ?? 0,
    mesas: (ls.mesas ?? 0) + (ls.buttes ?? 0),
    mesaFields: ls.mesaFields ?? 0,
    inselbergs: ls.inselbergs ?? 0,
    dolines: ls.dolines ?? 0,
    cinderCones: ls.cinderCones ?? 0,
    geothermal: featCount('geothermal'),
    heroes: traits.heroes.length,
    landmarks: landmarks.length,
  };

  const per100k = (c: number): number => (landKm2 > 0 ? (c / landKm2) * 1e5 : NaN);
  const per1000Coast = (c: number): number => (coastKm > 0 ? (c / coastKm) * 1000 : NaN);
  const rates: Record<string, number> = {};
  for (const t of COUNT_TARGETS) {
    const c = counts[t.key];
    rates[t.key] = t.per === 'land' ? per100k(c) : t.per === 'coast' ? per1000Coast(c) : t.per === 'warm' ? (warmOceanKm2 > 0 ? (c / warmOceanKm2) * 1e5 : NaN) : c;
  }
  const features: WorldMetrics['features'] = {};
  const landKeys = ['peaks', 'peaks3k', 'ultras', 'volcanoes', 'calderas', 'craters', 'lakes', 'lakes1', 'lakes10', 'lakes100', 'lakes1000', 'islands', 'islands1', 'islands100', 'waterfalls', 'waterfallNodes', 'canyons', 'glaciers', 'mesas', 'inselbergs', 'dolines', 'geothermal', 'rivers56', 'order6plus'];
  const coastKeys = ['deltas', 'estuaries', 'fjords', 'fjordCoastKm', 'peninsulas', 'riversToSea', 'barrierIslands', 'lagoons', 'seaStacks', 'rias', 'spits', 'reefs'];
  for (const k of landKeys) features[k] = { count: counts[k], per: 'land', rate: per100k(counts[k]) };
  for (const k of coastKeys) features[k] = { count: counts[k], per: 'coast', rate: per1000Coast(counts[k]) };
  features.atolls = { count: counts.atolls, per: 'warm', rate: warmOceanKm2 > 0 ? (counts.atolls / warmOceanKm2) * 1e5 : NaN };

  // ── Heroes ────────────────────────────────────────────────────────────────────────────────
  const heroLms = landmarks.filter((l) => l.hero);
  let minSp = Infinity;
  for (let i = 0; i < heroLms.length; i++) {
    for (let j = i + 1; j < heroLms.length; j++) minSp = Math.min(minSp, Math.hypot(heroLms[i].x - heroLms[j].x, heroLms[i].y - heroLms[j].y));
  }
  const heroes = {
    count: heroLms.length, target: resolved.drawn.heroCount ?? NaN,
    minSpacingFrac: Number.isFinite(minSp) ? minSp / worldM : NaN, kinds: heroLms.map((h) => h.kind),
  };

  // ── 🎯 targets ────────────────────────────────────────────────────────────────────────────
  const rng = (id: string): [number, number] => {
    const v = resolved.values[id] as Range;
    return [Math.min(v[0], v[1]), Math.max(v[0], v[1])];
  };
  const countTarget = (id: string, alt: (got: number, drawn: number) => boolean): TargetOutcome => {
    const got = outcomes[id];
    const drawn = resolved.drawn[id];
    const range = rng(id);
    return { got, drawn, range, ok: got >= range[0] && got <= range[1], okAlt: alt(got, drawn) };
  };
  const rdValue = resolved.values.riverDensity as number;
  const wsValue = resolved.values.wetlandShare as number;
  const targets: Record<string, TargetOutcome> = {
    continentCount: countTarget('continentCount', (g, d) => g === d),
    mountainRangeCount: countTarget('mountainRangeCount', (g, d) => Math.abs(g - d) <= 1),
    riftCount: countTarget('riftCount', (g, d) => Math.abs(g - d) <= 1),
    // The hydro outcome is realised / expected drainage density (1 = on target); the config panel
    // compares it with the riverDensity value itself (±10 %), reported as okAlt.
    riverDensity: { got: outcomes.riverDensity, value: rdValue, ok: Math.abs(outcomes.riverDensity - rdValue) <= 0.1 * rdValue, okAlt: Math.abs((hs.riverDensityRatio ?? NaN) - 1) <= 0.1 },
    wetlandShare: { got: outcomes.wetlandShare, value: wsValue, ok: Math.abs(outcomes.wetlandShare - wsValue) <= 0.1 * wsValue, okAlt: outcomes.wetlandShare >= 0.04 && outcomes.wetlandShare <= 0.1 },
  };

  // ── Contrast (research 05 §3.6) ───────────────────────────────────────────────────────────
  let low = 0;
  let high = 0;
  for (let i = 0; i < N; i++) {
    if (!isLand[i]) continue;
    if (hy.elevation[i] < CONTRAST.lowM) low++;
    if (hy.elevation[i] > CONTRAST.highM) high++;
  }
  const heights = peaks.map((l) => l.data.heightM ?? 0).sort((a, b) => a - b);
  const kingM = Math.max(0, ...summits.map((l) => l.data.heightM ?? 0));
  const p95Peak = quantileSorted(heights, 0.95);
  const contrast = {
    lowShare: low / Math.max(1, landCells), highShare: high / Math.max(1, landCells),
    kingRatio: p95Peak > 0 ? kingM / p95Peak : NaN, kingM, wViewOk: NaN,
  };

  // ── Geomorphic realism ────────────────────────────────────────────────────────────────────
  const coast = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!isLand[i]) continue;
    const x = i % n;
    const y = (i - x) / n;
    if ((x > 0 && !isLand[i - 1]) || (x < n - 1 && !isLand[i + 1]) || (y > 0 && !isLand[i - n]) || (y < n - 1 && !isLand[i + n])) coast[i] = 1;
  }
  const lakeFit = ccdfExponent(lakeArea, 2 * cellKm * cellKm);
  const islandFit = ccdfExponent(islandKm2, 2 * cellKm * cellKm);
  const geomorph = {
    hortonRb: hs.hortonRb ?? NaN, hackExponent: hs.hackExponent ?? NaN, lakeParetoB: lakeFit.b, lakeN: lakeFit.n,
    korcakB: islandFit.b, islandN: islandFit.n, coastD: boxCountDimension(coast, n, 8),
  };

  // ── Clark–Evans and cluster disks (research 05 §3.3, §5.3) ────────────────────────────────
  const landM2 = landKm2 * 1e6;
  const ce = (pts: { x: number; y: number }[]): number => clarkEvans(pts.map((q) => q.x), pts.map((q) => q.y), landM2);
  const lakePts = lakes.map((l) => ({ x: l.cx, y: l.cy }));
  const clarkEvansR: Record<string, number> = {
    volcano: ce(volcanoFeats), lake: ce(lakePts), peak: ce(peaks), crater: ce(craterFeats),
  };
  const diskMax = (pts: { x: number; y: number }[]): number => {
    let best = 0;
    for (const a of pts) {
      let k = 0;
      for (const b of pts) if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= 1e10) k++;
      best = Math.max(best, k);
    }
    return best;
  };
  const clusterDisk = { volcano: diskMax(volcanoFeats), peak: diskMax(peaks), lake: diskMax(lakePts) };

  // ── Biomes ────────────────────────────────────────────────────────────────────────────────
  let maxShare = 0;
  let maxName = '';
  for (const b of BIOMES) {
    const s = biomeOut.stats[b.name];
    if (s !== undefined && s > maxShare) {
      maxShare = s;
      maxName = b.name;
    }
  }
  const biome = { maxShare, maxName, distinct: biomeOut.stats.distinctBiomes ?? 0 };

  // ── Features for the interest budget ──────────────────────────────────────────────────────
  const all: Feat[] = [];
  for (const l of landmarks) {
    if (SKIP_KINDS.has(l.kind)) continue;
    const base = { cls: l.kind, x: l.x, y: l.y, ext: l.extentM, r: SEA_OR_MASS.has(l.kind) ? -1 : 0.25 * l.extentM, order: 0 };
    all.push(bbox(l.path ? { ...base, pts: l.path } : base));
  }
  for (const s of strs) {
    const mid = Math.floor(s.pts.length / 4) * 2;
    all.push(bbox({ cls: 'river', x: s.pts[mid], y: s.pts[mid + 1], ext: s.lengthM, pts: s.pts, r: 0, order: s.order }));
  }
  for (const l of lakes) {
    const ext = Math.sqrt(l.areaKm2) * 1000;
    all.push(bbox({ cls: 'lake', x: l.cx, y: l.cy, ext, r: Math.sqrt(l.areaKm2 / Math.PI) * 1000, order: 0 }));
  }
  for (const f of lfx.features) {
    if (!EXTRA_FEATURES.has(f.type)) continue;
    all.push(bbox({ cls: f.type, x: f.x, y: f.y, ext: f.size, r: 0.25 * f.size, order: 0 }));
  }

  // Quiet land: farther than QUIET.radiusKm from any feature of band R or A size (research 05 §3.3).
  const quietMask = new Uint8Array(N);
  for (const f of all) {
    if (f.r < 0 || (f.cls === 'river' && f.order < QUIET.minOrder)) continue;
    paint(quietMask, n, n, f, 0, 0, cellM);
  }
  const quietD2 = edtSquared(quietMask, n, n);
  let quiet = 0;
  for (let i = 0; i < N; i++) if (isLand[i] && quietD2[i] > (QUIET.radiusKm / cellKm) ** 2) quiet++;
  const quietShare = quiet / Math.max(1, landCells);

  // ── Viewports per band ────────────────────────────────────────────────────────────────────
  const views = job.views ?? { land: 64, uniform: 32 };
  const landList: number[] = [];
  for (let i = 0; i < N; i++) if (isLand[i]) landList.push(i);
  const bands = {} as Record<BandId, BandResult>;
  for (const band of BANDS) {
    bands[band.id] = sampleBand(band, {
      worldM, n, cellM, isLand, landList, all, landmarks, lakes, hy, bio, seed: job.seed, views,
    });
  }
  const wv = bands.W.land.contrast;
  contrast.wViewOk = wv.length ? wv.filter((c) => c >= 2).length / wv.length : NaN;

  // ── Detectors (research 05 §5.3) ──────────────────────────────────────────────────────────
  const W = BANDS[0];
  const wCounts = [...bands.W.land.counts].sort((a, b) => a - b);
  const boring: string[] = [];
  if (quantileSorted(wCounts, 0.5) < W.lo) boring.push(`W view p50 ${quantileSorted(wCounts, 0.5).toFixed(0)} < ${W.lo}`);
  if (heroes.count === 0) boring.push('no hero');
  if (contrast.lowShare < CONTRAST.lowShare) boring.push(`only ${(contrast.lowShare * 100).toFixed(0)} % of land < 300 m`);
  if (contrast.highShare < contrastFor(job.archetype).highShare) boring.push(`only ${(contrast.highShare * 100).toFixed(1)} % of land > 2000 m`);
  if (biome.maxShare > BORING.biomeDominance) boring.push(`${biome.maxName} ${(biome.maxShare * 100).toFixed(0)} % of land`);
  if (counts.lakes100 + counts.lakes1000 === 0 && maxOrder < 6) boring.push('no lake ≥ 100 km² and no river ord ≥ 6');
  const cluttered: string[] = [];
  const wMax = wCounts.length ? wCounts[wCounts.length - 1] : 0;
  if (wMax > CLUTTER_W_MAX) cluttered.push(`W view with ${wMax} features > ${CLUTTER_W_MAX}`);
  for (const band of BANDS) {
    const lab = [...bands[band.id].land.labels].sort((a, b) => a - b);
    const p95 = quantileSorted(lab, 0.95);
    if (p95 > LABEL_CAP) cluttered.push(`${band.id} labels/screen p95 ${p95.toFixed(0)} > ${LABEL_CAP}`);
  }
  if (quietShare < 0.05) cluttered.push(`quiet land ${(quietShare * 100).toFixed(1)} % < 5 %`);
  for (const [k, cap] of Object.entries(DISK_CLUSTER_CAP)) {
    const v = clusterDisk[k as keyof typeof clusterDisk];
    if (v > cap) cluttered.push(`${v} ${k}s in one 100 km disk > ${cap}`);
  }

  return {
    archetype: job.archetype, seed: job.seed, mode: job.mode, group: job.group, query: specToQuery(spec),
    ms: Math.round(performance.now() - t0), worldKm, cellKm, landKm2, coastKm, warmOceanKm2,
    counts, rates, features, kinds, tiers, heroes, targets, contrast, geomorph, clarkEvans: clarkEvansR, clusterDisk,
    quietShare, biome, bands, boring, cluttered,
  };
}

/** Paints a feature into a raster whose pixel (0,0) starts at map (ox, oy) with pixel size `px` (m). */
function paint(mask: Uint8Array, w: number, h: number, f: Feat, ox: number, oy: number, px: number): void {
  if (f.pts) {
    for (let i = 2; i < f.pts.length; i += 2) {
      rasterLine(mask, w, h, (f.pts[i - 2] - ox) / px, (f.pts[i - 1] - oy) / px, (f.pts[i] - ox) / px, (f.pts[i + 1] - oy) / px);
    }
    if (f.pts.length === 2) rasterDisk(mask, w, h, (f.pts[0] - ox) / px, (f.pts[1] - oy) / px, 0);
  } else {
    rasterDisk(mask, w, h, (f.x - ox) / px, (f.y - oy) / px, f.r / px);
  }
}

interface BandCtx {
  worldM: number;
  n: number;
  cellM: number;
  isLand: Uint8Array;
  landList: number[];
  all: Feat[];
  landmarks: Landmark[];
  lakes: LakeInfo[];
  hy: HydroExtra;
  bio: BiomeExtra;
  seed: number;
  views: { land: number; uniform: number };
}

const EMPTY_PX = 96;
const EMPTY_MARGIN = 24;

function emptySample(): BandSample {
  return { counts: [], entropy: [], cv: [], emptyKm: [], labels: [], landShare: [], contrast: [] };
}

function sampleBand(band: BandDef, c: BandCtx): BandResult {
  const { worldM, n, cellM, isLand } = c;
  const viewW = Math.min(worldM, (band.scalesWithWorld ? band.nominalKm * (worldM / 1024000) : band.nominalKm) * 1000);
  const viewH = Math.min(worldM, viewW * VIEW_ASPECT);
  const capKm = band.emptyCapKm * (band.scalesWithWorld ? viewW / (band.nominalKm * 1000) : 1);
  const lo = viewW * WINDOW_LO;
  const hi = viewW * WINDOW_HI;
  const feats = c.all.filter((f) => f.ext >= lo && f.ext <= hi && (f.cls !== 'river' || f.order >= band.minOrder));
  const mpp = viewW / SCREEN_PX;
  const labelled = c.landmarks.filter((l) => l.maxMpp >= mpp);
  const rnd = prng((c.seed * 2654435761) ^ band.id.charCodeAt(0));
  const res: BandResult = { viewKm: viewW / 1000, capKm, land: emptySample(), uniform: emptySample(), ocean: [], classMean: {} };
  const classSum = new Map<string, number>();
  const scale = band.scalesWithWorld ? 0.25 : 1;
  const nLand = Math.max(4, Math.round(c.views.land * scale));
  const nUni = Math.max(2, Math.round(c.views.uniform * scale));

  const measure = (x0: number, y0: number, into: BandSample, uniform: boolean, classes?: Map<string, number>): void => {
    const x1 = x0 + viewW;
    const y1 = y0 + viewH;
    const inView = (x: number, y: number): boolean => x >= x0 && x < x1 && y >= y0 && y < y1;
    // Land share and (W) contrast from the hydro grid.
    const cx0 = Math.floor(x0 / cellM);
    const cy0 = Math.floor(y0 / cellM);
    const cx1 = Math.min(n - 1, Math.ceil(x1 / cellM) - 1);
    const cy1 = Math.min(n - 1, Math.ceil(y1 / cellM) - 1);
    const step = Math.max(1, Math.floor((cx1 - cx0 + 1) / 128));
    let tot = 0;
    let land = 0;
    let maxH = -Infinity;
    const biomeCount = new Map<number, number>();
    for (let y = cy0; y <= cy1; y += step) {
      for (let x = cx0; x <= cx1; x += step) {
        const i = y * n + x;
        tot++;
        if (!isLand[i]) continue;
        land++;
        maxH = Math.max(maxH, c.hy.elevation[i]);
        const b = c.bio.biome[i];
        if (b) biomeCount.set(b, (biomeCount.get(b) ?? 0) + 1);
      }
    }
    const landShare = tot ? land / tot : 0;
    // Features in view: anchor (or first in-view path point) inside the rectangle.
    const cls = new Map<string, number>();
    const grid = new Array<number>(CV_GRID * CV_GRID).fill(0);
    let count = 0;
    for (const f of feats) {
      if (f.bx1 < x0 || f.bx0 >= x1 || f.by1 < y0 || f.by0 >= y1) continue;
      let px = NaN;
      let py = NaN;
      if (inView(f.x, f.y)) {
        px = f.x;
        py = f.y;
      } else if (f.pts) {
        for (let i = 0; i < f.pts.length; i += 2) {
          if (inView(f.pts[i], f.pts[i + 1])) {
            px = f.pts[i];
            py = f.pts[i + 1];
            break;
          }
        }
      }
      if (Number.isNaN(px)) continue;
      count++;
      cls.set(f.cls, (cls.get(f.cls) ?? 0) + 1);
      const gx = Math.min(CV_GRID - 1, Math.floor(((px - x0) / viewW) * CV_GRID));
      const gy = Math.min(CV_GRID - 1, Math.floor(((py - y0) / viewH) * CV_GRID));
      grid[gy * CV_GRID + gx]++;
    }
    if (uniform && landShare < OCEAN_VIEW_LAND) res.ocean.push(count);
    // Largest empty disk on land (research 05 §3.2): EDT of the rasterised feature mask.
    const px = viewW / EMPTY_PX;
    const w = EMPTY_PX + 2 * EMPTY_MARGIN;
    const h = Math.round(viewH / px) + 2 * EMPTY_MARGIN;
    const ox = x0 - EMPTY_MARGIN * px;
    const oy = y0 - EMPTY_MARGIN * px;
    const mask = new Uint8Array(w * h);
    const valid = new Uint8Array(w * h);
    for (const f of feats) {
      if (f.r < 0 || f.bx1 < ox || f.bx0 >= ox + w * px || f.by1 < oy || f.by0 >= oy + h * px) continue;
      paint(mask, w, h, f, ox, oy, px);
    }
    for (let j = EMPTY_MARGIN; j < h - EMPTY_MARGIN; j++) {
      const my = oy + (j + 0.5) * px;
      if (my < 0 || my >= worldM) continue;
      for (let i = EMPTY_MARGIN; i < w - EMPTY_MARGIN; i++) {
        const mx = ox + (i + 0.5) * px;
        if (mx < 0 || mx >= worldM) continue;
        if (isLand[Math.min(n - 1, Math.floor(my / cellM)) * n + Math.min(n - 1, Math.floor(mx / cellM))]) valid[j * w + i] = 1;
      }
    }
    const emptyKm = (largestEmptyDisk(mask, valid, w, h) * px) / 1000;
    let labels = 0;
    for (const l of labelled) if (inView(l.x, l.y)) labels++;
    let contrastItems = 0;
    if (band.id === 'W') {
      const highRelief = maxH >= CONTRAST.highM;
      const bigLake = c.lakes.some((l) => l.areaKm2 >= 100 && inView(l.cx, l.cy));
      const openWater = 1 - landShare >= 0.05 || bigLake;
      let present = 0;
      for (const v of biomeCount.values()) if (v >= PRESENT_SHARE * land) present++;
      contrastItems = (highRelief ? 1 : 0) + (openWater ? 1 : 0) + (present >= 2 ? 1 : 0);
    }
    if (classes) for (const [k, v] of cls) classes.set(k, (classes.get(k) ?? 0) + v);
    into.counts.push(count);
    into.entropy.push(entropy(cls.values()));
    into.cv.push(count >= 4 ? coefVar(grid) : NaN);
    into.emptyKm.push(land > 0 ? emptyKm : NaN);
    into.labels.push(labels);
    into.landShare.push(landShare);
    into.contrast.push(contrastItems);
  };

  const clampX = (x: number): number => Math.min(Math.max(0, x), worldM - viewW);
  const clampY = (y: number): number => Math.min(Math.max(0, y), worldM - viewH);
  // Land-weighted: centred on a random land cell; rejected (resampled) if the clamped view has < 10 % land.
  let tries = 0;
  while (res.land.counts.length < nLand && tries < nLand * 4 && c.landList.length) {
    tries++;
    const cell = c.landList[Math.floor(rnd() * c.landList.length)];
    const cx = ((cell % n) + rnd()) * cellM;
    const cy = (Math.floor(cell / n) + rnd()) * cellM;
    const tmp = emptySample();
    const tmpCls = new Map<string, number>();
    measure(clampX(cx - viewW / 2), clampY(cy - viewH / 2), tmp, false, tmpCls);
    if (tmp.landShare[0] < OCEAN_VIEW_LAND) continue;
    for (const [k, v] of tmpCls) classSum.set(k, (classSum.get(k) ?? 0) + v);
    for (const k of Object.keys(tmp) as (keyof BandSample)[]) res.land[k].push(tmp[k][0]);
  }
  for (let k = 0; k < nUni; k++) measure(clampX(rnd() * worldM - viewW / 2), clampY(rnd() * worldM - viewH / 2), res.uniform, true);
  const nl = Math.max(1, res.land.counts.length);
  for (const [k, v] of classSum) res.classMean[k] = Math.round((v / nl) * 100) / 100;
  return res;
}
