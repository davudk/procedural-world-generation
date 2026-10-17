/**
 * Runs the generation pipeline for one world and measures it (research 05 §3.2–3.6, §5): counts and
 * rates, 🎯 target satisfaction, the per-band interest budget over random viewports, Clark–Evans,
 * contrast rules, geomorphic realism and the boring / cluttered detectors. The result is plain JSON.
 */
import { cubeGrid, type CubeGrid } from '../src/gen/grid/cube';
import { distanceField } from '../src/gen/grid/distance';
import { components as gridComponents } from '../src/gen/grid/ops';
import { Pipeline } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import type { BiomeExtra } from '../src/gen/stages/biome';
import type { ClimateExtra } from '../src/gen/stages/climate';
import { WATER, type HydroExtra } from '../src/gen/stages/hydro';
import type { LandformsExtra } from '../src/gen/stages/landforms';
import { BIOMES } from '../src/shared/biomes';
import { dirSurface, dirToCell, surfaceDir } from '../src/shared/cube';
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
  boxCountDimensionFaces, capView, clarkEvansSphere, geodesic, globeView, maxInDisk, pickWeighted, randomDir, type ViewProj,
} from './lib/sphere';
import {
  bandsFor, BORING, sphereCountRange, CLUTTER_W_MAX, COUNT_TARGETS, CONTRAST, contrastFor, CV_GRID, DISK_CLUSTER_CAP, GLOBE_MIN_FACING, globeLandMinKm2, globeMpp, LABEL_CAP,
  OCEAN_VIEW_LAND, QUIET, SCREEN_PX, VIEW_ASPECT, WINDOW_HI, WINDOW_LO, type BandDef, type BandId,
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
  shape: 'flat' | 'sphere';
  /** Flat: map width. Sphere: the equal-area size √(4πR²) (research 10 §3.1), so per-world rows compare with flat. */
  worldKm: number;
  /** Sphere only: circumference (km); 0 on flat maps. */
  planetKm: number;
  /** Nominal cell size (km); spheres: (π/2)·R/n at face centres. */
  cellKm: number;
  landKm2: number;
  coastKm: number;
  warmOceanKm2: number;
  /** Raw counts (per world). */
  counts: Record<string, number>;
  /** Values in the unit of each COUNT_TARGETS row (per 10⁵ km² land, per 1000 km coast, per world …). */
  rates: Record<string, number>;
  /** Target range of each COUNT_TARGETS row for this world (flat: the row's range; spheres: `sphereCountRange`). */
  countRanges: Record<string, [number, number]>;
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
  /** Share of land under perennial snow or ice (biome snow ≥ 0.5; area-weighted on spheres). */
  iceShare: number;
  /** Highest summit (m). */
  peakMaxM: number;
  /** Annual precipitation on land (mm/yr): 99.9th percentile (area-weighted on spheres) and maximum. */
  precipLand: { p999: number; max: number };
  /** The World traits headline. */
  traitsLead: string;
  biome: { maxShare: number; maxName: string; distinct: number };
  /** Bands of the world's shape: W, R, A, L on flat maps; G, W, R, A, L on spheres. */
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

/**
 * Strahler streams on a sphere: as `streams`, with lengths as 3D chords between consecutive nodes and
 * the polyline as unit vectors (`p3`, 3 per point). `pts` is left empty.
 */
export function streamsSphere(g: RiverGraph, R: number): (Stream & { p3: Float64Array })[] {
  const face = g.face!;
  const dir = new Float64Array(3 * g.n);
  for (let i = 0; i < g.n; i++) surfaceDir(face[i], g.x[i], g.y[i], R, dir, 3 * i);
  const maxIn = new Uint8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const d = g.down[i];
    if (d >= 0 && !(g.flags[i] & RIVER.DISTRIBUTARY)) maxIn[d] = Math.max(maxIn[d], g.strahler[i]);
  }
  const out: (Stream & { p3: Float64Array })[] = [];
  const empty = new Float32Array(0);
  for (let i = 0; i < g.n; i++) {
    if (g.flags[i] & RIVER.DISTRIBUTARY) continue;
    const s = g.strahler[i];
    if (s === 0 || maxIn[i] >= s) continue;
    const pts: number[] = [dir[3 * i], dir[3 * i + 1], dir[3 * i + 2]];
    let len = 0;
    let c = i;
    for (let guard = 0; guard < g.n; guard++) {
      const d = g.down[c];
      if (d < 0) break;
      len += R * Math.hypot(dir[3 * d] - dir[3 * c], dir[3 * d + 1] - dir[3 * c + 1], dir[3 * d + 2] - dir[3 * c + 2]);
      pts.push(dir[3 * d], dir[3 * d + 1], dir[3 * d + 2]);
      if (g.strahler[d] !== s || g.flags[d] & RIVER.DISTRIBUTARY) break;
      c = d;
    }
    out.push({ order: s, lengthM: len, pts: empty, p3: Float64Array.from(pts) });
  }
  return out;
}

/** A feature on the sphere: as Feat, with an anchor unit vector, an optional unit-vector polyline and its angular reach. */
interface SFeat {
  cls: string;
  ext: number;
  r: number;
  order: number;
  d: Float64Array;
  p3?: Float64Array;
  /** Largest angle (rad) from the anchor to a path point. */
  reach: number;
}

function sfeat(f: Omit<SFeat, 'reach'>): SFeat {
  let reach = 0;
  if (f.p3) {
    for (let k = 0; k < f.p3.length; k += 3) {
      const c = f.d[0] * f.p3[k] + f.d[1] * f.p3[k + 1] + f.d[2] * f.p3[k + 2];
      reach = Math.max(reach, Math.acos(Math.max(-1, Math.min(1, c))));
    }
  }
  return { ...f, reach };
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

  const sphere = resolved.values.worldShape === 'sphere';
  const { n, cellKm } = hy;
  const cellM = cellKm * 1000;
  const planetKm = sphere ? (resolved.values.planetSize as number) : 0;
  const R = sphere ? (planetKm * 1000) / (2 * Math.PI) : Infinity;
  const grid: CubeGrid | null = sphere ? cubeGrid(n, R) : null;
  // Spheres report the equal-area size (research 10 §3.1), so per-world rows and spacing fractions compare with flat.
  const worldKm = sphere ? (Math.sqrt(4 * Math.PI) * R) / 1000 : (resolved.values.worldSize as number);
  const worldM = worldKm * 1000;
  const N = sphere ? 6 * n * n : n * n;
  /** True cell area (km²). */
  const areaKm2 = (i: number): number => (grid ? grid.area(i) / 1e6 : cellKm * cellKm);
  const isLand = new Uint8Array(N);
  let landCells = 0;
  let landAreaSum = 0;
  for (let i = 0; i < N; i++) {
    if (hy.waterClass[i] !== WATER.OCEAN) {
      isLand[i] = 1;
      landCells++;
      if (grid) landAreaSum += areaKm2(i);
    }
  }
  const landKm2 = grid ? landAreaSum : landCells * cellKm * cellKm;
  const coastKm = ls.coastKm ?? 0;
  const warmOceanKm2 = ls.warmOceanKm2 ?? 0;
  /** Unit vector of a sphere position (face, face-local metres). */
  const dirOf = (face: number | undefined, x: number, y: number): Float64Array => {
    const d = new Float64Array(3);
    surfaceDir(face ?? 0, x, y, R, d);
    return d;
  };
  const dirsOf = (pts: readonly { face?: number; x: number; y: number }[]): Float64Array => {
    const out = new Float64Array(3 * pts.length);
    pts.forEach((q, k) => surfaceDir(q.face ?? 0, q.x, q.y, R, out, 3 * k));
    return out;
  };

  // ── Counts ────────────────────────────────────────────────────────────────────────────────
  const kinds: Record<string, number> = {};
  const tiers: Record<string, number> = { common: 0, uncommon: 0, rare: 0, legendary: 0 };
  for (const l of landmarks) {
    kinds[l.kind] = (kinds[l.kind] ?? 0) + 1;
    tiers[l.tier] = (tiers[l.tier] ?? 0) + 1;
  }
  const featCount = (t: string): number => lfx.features.filter((f) => f.type === t).length;
  const sStrs = sphere ? streamsSphere(rivers, R) : [];
  const strs: Stream[] = sphere ? sStrs : streams(rivers);
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
  let massKm2: number[];
  let isContinent: boolean[];
  if (grid) {
    const comp = gridComponents(isLand, grid);
    massKm2 = new Array<number>(comp.sizes.length).fill(0);
    for (let i = 0; i < N; i++) if (comp.label[i] >= 0) massKm2[comp.label[i]] += areaKm2(i);
    isContinent = massKm2.map((a) => a >= 0.05 * landKm2);
  } else {
    const comp = components(isLand, n, n);
    massKm2 = comp.sizes.map((s) => s * cellKm * cellKm);
    isContinent = comp.sizes.map((s) => s >= 0.05 * landCells);
  }
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
  const countRanges: Record<string, [number, number]> = {};
  const resolvedRange = (id: string): [number, number] => {
    const v = resolved.values[id] as Range;
    return [Math.min(v[0], v[1]), Math.max(v[0], v[1])];
  };
  for (const t of COUNT_TARGETS) {
    countRanges[t.key] = sphere ? sphereCountRange(t, worldKm, resolvedRange) : t.range;
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
  const heroDirs = sphere ? dirsOf(heroLms) : null;
  let minSp = Infinity;
  for (let i = 0; i < heroLms.length; i++) {
    for (let j = i + 1; j < heroLms.length; j++) {
      const d = heroDirs ? geodesic(heroDirs, 3 * i, heroDirs, 3 * j, R) : Math.hypot(heroLms[i].x - heroLms[j].x, heroLms[i].y - heroLms[j].y);
      minSp = Math.min(minSp, d);
    }
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

  // ── Contrast (research 05 §3.6), area-weighted on spheres ─────────────────────────────────
  let low = 0;
  let high = 0;
  let ice = 0;
  for (let i = 0; i < N; i++) {
    if (!isLand[i]) continue;
    const a = grid ? areaKm2(i) : 1;
    if (hy.elevation[i] < CONTRAST.lowM) low += a;
    if (hy.elevation[i] > CONTRAST.highM) high += a;
    if (bio.snow[i] >= 0.5) ice += a;
  }
  const landW = grid ? landKm2 : Math.max(1, landCells);
  const heights = peaks.map((l) => l.data.heightM ?? 0).sort((a, b) => a - b);
  const kingM = Math.max(0, ...summits.map((l) => l.data.heightM ?? 0));
  const p95Peak = quantileSorted(heights, 0.95);
  const contrast = {
    lowShare: low / landW, highShare: high / landW,
    kingRatio: p95Peak > 0 ? kingM / p95Peak : NaN, kingM, wViewOk: NaN,
  };
  const iceShare = ice / landW;
  const clim = p.output('climate')!.extra as ClimateExtra;
  const precipLand = { p999: NaN, max: 0 };
  if (clim.n === n) {
    const pv: number[] = [];
    const pw: number[] = [];
    for (let i = 0; i < N; i++) {
      if (!isLand[i]) continue;
      pv.push(clim.precip[i]);
      pw.push(grid ? areaKm2(i) : 1);
      precipLand.max = Math.max(precipLand.max, clim.precip[i]);
    }
    const ord = pv.map((_, k) => k).sort((a, b) => pv[a] - pv[b]);
    const total = pw.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (const k of ord) {
      acc += pw[k];
      if (acc >= 0.999 * total) {
        precipLand.p999 = pv[k];
        break;
      }
    }
  }

  // ── Geomorphic realism ────────────────────────────────────────────────────────────────────
  const coast = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!isLand[i]) continue;
    if (grid) {
      for (let k = 0; k < 4; k++) {
        const j = grid.border[i] ? grid.nbr(i, grid.axialToRaster[k]) : i + grid.off4[k];
        if (j >= 0 && !isLand[j]) {
          coast[i] = 1;
          break;
        }
      }
      continue;
    }
    const x = i % n;
    const y = (i - x) / n;
    if ((x > 0 && !isLand[i - 1]) || (x < n - 1 && !isLand[i + 1]) || (y > 0 && !isLand[i - n]) || (y < n - 1 && !isLand[i + n])) coast[i] = 1;
  }
  const lakeFit = ccdfExponent(lakeArea, 2 * cellKm * cellKm);
  const islandFit = ccdfExponent(islandKm2, 2 * cellKm * cellKm);
  const geomorph = {
    hortonRb: hs.hortonRb ?? NaN, hackExponent: hs.hackExponent ?? NaN, lakeParetoB: lakeFit.b, lakeN: lakeFit.n,
    korcakB: islandFit.b, islandN: islandFit.n, coastD: grid ? boxCountDimensionFaces(coast, n, 8) : boxCountDimension(coast, n, 8),
  };

  // ── Clark–Evans and cluster disks (research 05 §3.3, §5.3), great-circle on spheres ────────
  const landM2 = landKm2 * 1e6;
  const lakePts = lakes.map((l) => ({ x: l.cx, y: l.cy, ...(l.face !== undefined ? { face: l.face } : {}) }));
  const ce = (pts: { face?: number; x: number; y: number }[]): number =>
    sphere ? clarkEvansSphere(dirsOf(pts), landM2, R) : clarkEvans(pts.map((q) => q.x), pts.map((q) => q.y), landM2);
  const clarkEvansR: Record<string, number> = {
    volcano: ce(volcanoFeats), lake: ce(lakePts), peak: ce(peaks), crater: ce(craterFeats),
  };
  const diskMax = (pts: { face?: number; x: number; y: number }[]): number => {
    if (sphere) return maxInDisk(dirsOf(pts), 1e5, R);
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
  const views = job.views ?? { land: 64, uniform: 32 };
  const bandDefs = bandsFor(sphere ? 'sphere' : 'flat');
  const bands = {} as Record<BandId, BandResult>;
  let quietShare: number;
  if (grid) {
    const all: SFeat[] = [];
    const pathDirs = (l: Landmark): Float64Array | undefined => {
      if (!l.path) return undefined;
      const k = l.path.length / 2;
      const out = new Float64Array(3 * k);
      for (let q = 0; q < k; q++) surfaceDir(l.pathFace ? l.pathFace[q] : (l.face ?? 0), l.path[2 * q], l.path[2 * q + 1], R, out, 3 * q);
      return out;
    };
    for (const l of landmarks) {
      if (SKIP_KINDS.has(l.kind)) continue;
      const p3 = pathDirs(l);
      all.push(sfeat({ cls: l.kind, d: dirOf(l.face, l.x, l.y), ext: l.extentM, r: SEA_OR_MASS.has(l.kind) ? -1 : 0.25 * l.extentM, order: 0, ...(p3 ? { p3 } : {}) }));
    }
    for (const s of sStrs) {
      const mid = Math.floor(s.p3.length / 6) * 3;
      all.push(sfeat({ cls: 'river', d: s.p3.slice(mid, mid + 3), ext: s.lengthM, p3: s.p3, r: 0, order: s.order }));
    }
    for (const l of lakes) {
      all.push(sfeat({ cls: 'lake', d: dirOf(l.face, l.cx, l.cy), ext: Math.sqrt(l.areaKm2) * 1000, r: Math.sqrt(l.areaKm2 / Math.PI) * 1000, order: 0 }));
    }
    for (const f of lfx.features) {
      if (!EXTRA_FEATURES.has(f.type)) continue;
      all.push(sfeat({ cls: f.type, d: dirOf(f.face, f.x, f.y), ext: f.size, r: 0.25 * f.size, order: 0 }));
    }
    // Quiet land: farther than QUIET.radiusKm (geodesic) from any feature of band R or A size.
    const quietMask = new Uint8Array(N);
    for (const f of all) {
      if (f.r < 0 || (f.cls === 'river' && f.order < QUIET.minOrder)) continue;
      paintSphere(quietMask, grid, f);
    }
    const qd = distanceField(quietMask, grid).dist;
    let quiet = 0;
    for (let i = 0; i < N; i++) if (isLand[i] && qd[i] * cellKm > QUIET.radiusKm) quiet += areaKm2(i);
    quietShare = quiet / Math.max(1e-9, landKm2);

    const landList: number[] = [];
    let maxArea = 0;
    for (let i = 0; i < N; i++) {
      if (!isLand[i]) continue;
      landList.push(i);
      maxArea = Math.max(maxArea, grid.area(i));
    }
    // Band G reads land only on landmasses that are themselves distinct at the globe scale (≥ 20 px
    // across, `globeLandMinKm2`): islets of a few cells far out at sea were the 300–500 km empty disks
    // of band G, and no feature of globe size can stand on them (research 11 §5, Sphere polish).
    const masses = gridComponents(isLand, grid);
    const massArea = new Float64Array(masses.sizes.length);
    for (let i = 0; i < N; i++) if (masses.label[i] >= 0) massArea[masses.label[i]] += areaKm2(i);
    const minKm2 = globeLandMinKm2(R);
    const isLandG = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (isLand[i] && massArea[masses.label[i]] >= minKm2) isLandG[i] = 1;
    const ctx: SphereBandCtx = {
      R, grid, isLand, isLandG, landList, maxArea, all, hy, bio, seed: job.seed, views,
      labelled: landmarks.map((l) => ({ maxMpp: l.maxMpp, d: dirOf(l.face, l.x, l.y) })),
      bigLakes: lakes.filter((l) => l.areaKm2 >= 100).map((l) => dirOf(l.face, l.cx, l.cy)),
    };
    for (const band of bandDefs) bands[band.id] = sampleBandSphere(band, ctx);
  } else {
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
    quietShare = quiet / Math.max(1, landCells);

    // ── Viewports per band ──────────────────────────────────────────────────────────────────
    const landList: number[] = [];
    for (let i = 0; i < N; i++) if (isLand[i]) landList.push(i);
    for (const band of bandDefs) {
      bands[band.id] = sampleBand(band, {
        worldM, n, cellM, isLand, landList, all, landmarks, lakes, hy, bio, seed: job.seed, views,
      });
    }
  }
  const wv = bands.W.land.contrast;
  contrast.wViewOk = wv.length ? wv.filter((c) => c >= 2).length / wv.length : NaN;

  // ── Detectors (research 05 §5.3) ──────────────────────────────────────────────────────────
  const W = bandDefs.find((b) => b.id === 'W')!;
  const wCounts = [...bands.W.land.counts].sort((a, b) => a - b);
  const boring: string[] = [];
  if (quantileSorted(wCounts, 0.5) < W.lo) boring.push(`W view p50 ${quantileSorted(wCounts, 0.5).toFixed(0)} < ${W.lo}`);
  if (sphere) {
    const gCounts = [...bands.G.land.counts].sort((a, b) => a - b);
    const G = bandDefs[0];
    if (quantileSorted(gCounts, 0.5) < G.lo) boring.push(`G view p50 ${quantileSorted(gCounts, 0.5).toFixed(0)} < ${G.lo}`);
  }
  if (heroes.count === 0) boring.push('no hero');
  if (contrast.lowShare < CONTRAST.lowShare) boring.push(`only ${(contrast.lowShare * 100).toFixed(0)} % of land < 300 m`);
  if (contrast.highShare < contrastFor(job.archetype).highShare) boring.push(`only ${(contrast.highShare * 100).toFixed(1)} % of land > 2000 m`);
  if (biome.maxShare > BORING.biomeDominance) boring.push(`${biome.maxName} ${(biome.maxShare * 100).toFixed(0)} % of land`);
  if (counts.lakes100 + counts.lakes1000 === 0 && maxOrder < 6) boring.push('no lake ≥ 100 km² and no river ord ≥ 6');
  const cluttered: string[] = [];
  const wMax = wCounts.length ? wCounts[wCounts.length - 1] : 0;
  if (wMax > CLUTTER_W_MAX) cluttered.push(`W view with ${wMax} features > ${CLUTTER_W_MAX}`);
  for (const band of bandDefs) {
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
    ms: Math.round(performance.now() - t0), shape: sphere ? 'sphere' : 'flat', worldKm, planetKm, cellKm, landKm2, coastKm, warmOceanKm2,
    counts, rates, countRanges, features, kinds, tiers, heroes, targets, contrast, geomorph, clarkEvans: clarkEvansR, clusterDisk,
    quietShare, iceShare, peakMaxM: kingM, precipLand, traitsLead: traits.headline, biome, bands, boring, cluttered,
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

/** Paints a sphere feature into a cube-grid mask: polylines along their great-circle chords, disks through the grid's chart. */
function paintSphere(mask: Uint8Array, g: CubeGrid, f: SFeat): void {
  const n = g.n;
  if (f.p3) {
    const p = f.p3;
    const half = g.cellM / 2 / g.radiusM;
    for (let k = 3; k < p.length; k += 3) {
      const ch = Math.hypot(p[k] - p[k - 3], p[k + 1] - p[k - 2], p[k + 2] - p[k - 1]);
      const steps = Math.max(1, Math.ceil(ch / half));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        mask[dirToCell(p[k - 3] + (p[k] - p[k - 3]) * t, p[k - 2] + (p[k + 1] - p[k - 2]) * t, p[k - 1] + (p[k + 2] - p[k - 1]) * t, n)] = 1;
      }
    }
    if (p.length === 3) mask[dirToCell(p[0], p[1], p[2], n)] = 1;
    return;
  }
  mask[dirToCell(f.d[0], f.d[1], f.d[2], n)] = 1;
  if (f.r > 0) {
    const sp = new Float64Array(3);
    dirSurface(f.d[0], f.d[1], f.d[2], g.radiusM, sp);
    g.chart({ face: sp[0], u: sp[1], v: sp[2] }, f.r, (i) => {
      mask[i] = 1;
    });
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

/**
 * One viewport, shape-independent: features, label anchors and big lakes are given in view metres
 * (the view is the rectangle [x0, x0 + viewW) × [y0, y0 + viewH)); `cells` visits the grid cells of the
 * view (land share, W contrast) and `landAt` says whether a view point is land (−1 off the map).
 */
interface ViewInput {
  band: BandDef;
  viewW: number;
  viewH: number;
  x0: number;
  y0: number;
  feats: readonly Feat[];
  labelInView: () => number;
  bigLakeInView: () => boolean;
  cells: (visit: (i: number) => void) => void;
  landAt: (mx: number, my: number) => number;
  /** Band G: the scored part of the view (the disc facing ≥ GLOBE_MIN_FACING); features outside it are drawn, not counted. */
  inside?: (x: number, y: number) => boolean;
  isLand: Uint8Array;
  hy: HydroExtra;
  bio: BiomeExtra;
}

function measureView(v: ViewInput, into: BandSample, uniform: boolean, ocean: number[] | null, classes?: Map<string, number>): void {
  const { band, viewW, viewH, x0, y0, isLand } = v;
  const x1 = x0 + viewW;
  const y1 = y0 + viewH;
  const inside = v.inside;
  const inView = (x: number, y: number): boolean => x >= x0 && x < x1 && y >= y0 && y < y1 && (!inside || inside(x, y));
  let tot = 0;
  let land = 0;
  let maxH = -Infinity;
  const biomeCount = new Map<number, number>();
  v.cells((i) => {
    tot++;
    if (!isLand[i]) return;
    land++;
    maxH = Math.max(maxH, v.hy.elevation[i]);
    const b = v.bio.biome[i];
    if (b) biomeCount.set(b, (biomeCount.get(b) ?? 0) + 1);
  });
  const landShare = tot ? land / tot : 0;
  // Features in view: anchor (or first in-view path point) inside the rectangle.
  const cls = new Map<string, number>();
  const grid = new Array<number>(CV_GRID * CV_GRID).fill(0);
  let count = 0;
  for (const f of v.feats) {
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
  if (uniform && ocean && landShare < OCEAN_VIEW_LAND) ocean.push(count);
  // Largest empty disk on land (research 05 §3.2): EDT of the rasterised feature mask.
  const px = viewW / EMPTY_PX;
  const w = EMPTY_PX + 2 * EMPTY_MARGIN;
  const h = Math.round(viewH / px) + 2 * EMPTY_MARGIN;
  const ox = x0 - EMPTY_MARGIN * px;
  const oy = y0 - EMPTY_MARGIN * px;
  const mask = new Uint8Array(w * h);
  const valid = new Uint8Array(w * h);
  for (const f of v.feats) {
    if (f.r < 0 || f.bx1 < ox || f.bx0 >= ox + w * px || f.by1 < oy || f.by0 >= oy + h * px) continue;
    paint(mask, w, h, f, ox, oy, px);
  }
  for (let j = EMPTY_MARGIN; j < h - EMPTY_MARGIN; j++) {
    const my = oy + (j + 0.5) * px;
    for (let i = EMPTY_MARGIN; i < w - EMPTY_MARGIN; i++) {
      const c = v.landAt(ox + (i + 0.5) * px, my);
      if (c >= 0 && isLand[c]) valid[j * w + i] = 1;
    }
  }
  const emptyKm = (largestEmptyDisk(mask, valid, w, h) * px) / 1000;
  const labels = v.labelInView();
  let contrastItems = 0;
  if (band.id === 'W' || band.id === 'G') {
    const highRelief = maxH >= CONTRAST.highM;
    const openWater = 1 - landShare >= 0.05 || v.bigLakeInView();
    let present = 0;
    for (const n of biomeCount.values()) if (n >= PRESENT_SHARE * land) present++;
    contrastItems = (highRelief ? 1 : 0) + (openWater ? 1 : 0) + (present >= 2 ? 1 : 0);
  }
  if (classes) for (const [k, n] of cls) classes.set(k, (classes.get(k) ?? 0) + n);
  into.counts.push(count);
  into.entropy.push(entropy(cls.values()));
  into.cv.push(count >= 4 ? coefVar(grid) : NaN);
  into.emptyKm.push(land > 0 ? emptyKm : NaN);
  into.labels.push(labels);
  into.landShare.push(landShare);
  into.contrast.push(contrastItems);
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

  const view = (x0: number, y0: number): ViewInput => {
    const x1 = x0 + viewW;
    const y1 = y0 + viewH;
    const inView = (x: number, y: number): boolean => x >= x0 && x < x1 && y >= y0 && y < y1;
    return {
      band, viewW, viewH, x0, y0, feats, isLand, hy: c.hy, bio: c.bio,
      labelInView: () => {
        let k = 0;
        for (const l of labelled) if (inView(l.x, l.y)) k++;
        return k;
      },
      bigLakeInView: () => c.lakes.some((l) => l.areaKm2 >= 100 && inView(l.cx, l.cy)),
      cells: (visit) => {
        // Land share and (W) contrast from the hydro grid.
        const cx0 = Math.floor(x0 / cellM);
        const cy0 = Math.floor(y0 / cellM);
        const cx1 = Math.min(n - 1, Math.ceil(x1 / cellM) - 1);
        const cy1 = Math.min(n - 1, Math.ceil(y1 / cellM) - 1);
        const step = Math.max(1, Math.floor((cx1 - cx0 + 1) / 128));
        for (let y = cy0; y <= cy1; y += step) for (let x = cx0; x <= cx1; x += step) visit(y * n + x);
      },
      landAt: (mx, my) => (my < 0 || my >= worldM || mx < 0 || mx >= worldM ? -1 : Math.min(n - 1, Math.floor(my / cellM)) * n + Math.min(n - 1, Math.floor(mx / cellM))),
    };
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
    measureView(view(clampX(cx - viewW / 2), clampY(cy - viewH / 2)), tmp, false, null, tmpCls);
    if (tmp.landShare[0] < OCEAN_VIEW_LAND) continue;
    for (const [k, v] of tmpCls) classSum.set(k, (classSum.get(k) ?? 0) + v);
    for (const k of Object.keys(tmp) as (keyof BandSample)[]) res.land[k].push(tmp[k][0]);
  }
  for (let k = 0; k < nUni; k++) measureView(view(clampX(rnd() * worldM - viewW / 2), clampY(rnd() * worldM - viewH / 2)), res.uniform, true, res.ocean);
  const nl = Math.max(1, res.land.counts.length);
  for (const [k, v] of classSum) res.classMean[k] = Math.round((v / nl) * 100) / 100;
  return res;
}

interface SphereBandCtx {
  R: number;
  grid: CubeGrid;
  isLand: Uint8Array;
  /** Land on landmasses distinct at the globe scale (band G's land). */
  isLandG: Uint8Array;
  landList: number[];
  /** Largest land cell area (m²), for area-weighted centres. */
  maxArea: number;
  all: SFeat[];
  labelled: { maxMpp: number; d: Float64Array }[];
  bigLakes: Float64Array[];
  hy: HydroExtra;
  bio: BiomeExtra;
  seed: number;
  views: { land: number; uniform: number };
}

/**
 * Band viewports on a sphere (research 10 §7): spherical caps (azimuthal equidistant, `capView`) for
 * W, R, A, L and the orthographic disc for G (`globeView`), centred on area-weighted land cells or
 * area-uniform directions; no clamping. Features are projected into the view and measured as on flat maps.
 */
function sampleBandSphere(band: BandDef, c: SphereBandCtx): BandResult {
  const { R, grid } = c;
  const n = grid.n;
  const globe = band.globe === true;
  const isLand = globe ? c.isLandG : c.isLand;
  const viewW = globe ? 2 * R : band.nominalKm * 1000;
  const viewH = globe ? 2 * R : viewW * VIEW_ASPECT;
  const capKm = globe ? (band.emptyCapKm * (2 * R)) / 1024000 : band.emptyCapKm;
  const mpp = globe ? globeMpp(R) : viewW / SCREEN_PX;
  // "Distinct" = at least view/80, i.e. 20 px on the 1600 px screen (research 05 §3.2). The globe's disc
  // is only ~640 px tall at the registry's whole-planet scale, so G keeps the 20 px (≈ 2R/32), not 2R/80.
  const lo = globe ? mpp * SCREEN_PX * WINDOW_LO : viewW * WINDOW_LO;
  const hi = viewW * WINDOW_HI;
  const feats = c.all.filter((f) => f.ext >= lo && f.ext <= hi && (f.cls !== 'river' || f.order >= band.minOrder));
  const labelled = c.labelled.filter((l) => l.maxMpp >= mpp);
  const rnd = prng((c.seed * 2654435761) ^ band.id.charCodeAt(0));
  const res: BandResult = { viewKm: viewW / 1000, capKm, land: emptySample(), uniform: emptySample(), ocean: [], classMean: {} };
  const classSum = new Map<string, number>();
  const scale = globe || band.id === 'W' ? 0.25 : 1;
  const nLand = Math.max(4, Math.round(c.views.land * scale));
  const nUni = Math.max(2, Math.round(c.views.uniform * scale));
  // Angular reach of the view from its centre, including the empty-disk raster's margin.
  const marginM = (EMPTY_MARGIN * viewW) / EMPTY_PX;
  // Band G draws the whole facing hemisphere (scored inside the GLOBE_MIN_FACING disc, `inside`).
  const reach = globe ? Math.PI / 2 : Math.min(Math.PI / 2, Math.hypot(viewW / 2 + marginM, viewH / 2 + marginM) / R);
  const tmp = new Float64Array(3);
  const q = new Float64Array(2);
  const rimR2 = R * R * (1 - GLOBE_MIN_FACING * GLOBE_MIN_FACING);
  const inside = globe ? (x: number, y: number): boolean => (x - R) ** 2 + (y - R) ** 2 <= rimR2 : null;

  const view = (proj: ViewProj): ViewInput => {
    const cc = proj.c;
    const near = (d: ArrayLike<number>, extra: number): boolean => {
      const co = d[0] * cc[0] + d[1] * cc[1] + d[2] * cc[2];
      return co >= Math.cos(Math.min(Math.PI, reach + extra));
    };
    const local: Feat[] = [];
    for (const f of feats) {
      if (!near(f.d, f.reach)) continue;
      const ok = proj.project(f.d[0], f.d[1], f.d[2], q);
      const x = ok ? q[0] : NaN;
      const y = ok ? q[1] : NaN;
      let pts: Float32Array | undefined;
      if (f.p3) {
        pts = new Float32Array((f.p3.length / 3) * 2);
        for (let k = 0, o = 0; k < f.p3.length; k += 3, o += 2) {
          if (proj.project(f.p3[k], f.p3[k + 1], f.p3[k + 2], q)) {
            pts[o] = q[0];
            pts[o + 1] = q[1];
          } else {
            pts[o] = NaN;
            pts[o + 1] = NaN;
          }
        }
      }
      if (!ok && !pts) continue;
      local.push(bboxFinite({ cls: f.cls, x, y, ext: f.ext, r: f.r, order: f.order, ...(pts ? { pts } : {}) }));
    }
    const inView = (d: ArrayLike<number>): boolean =>
      near(d, 0) && proj.project(d[0], d[1], d[2], q) && q[0] >= 0 && q[0] < viewW && q[1] >= 0 && q[1] < viewH && (!inside || inside(q[0], q[1]));
    return {
      band, viewW, viewH, x0: 0, y0: 0, feats: local, isLand, hy: c.hy, bio: c.bio, ...(inside ? { inside } : {}),
      labelInView: () => {
        let k = 0;
        for (const l of labelled) if (inView(l.d)) k++;
        return k;
      },
      bigLakeInView: () => c.bigLakes.some(inView),
      cells: (visit) => {
        // A lattice of view points at about the cell size (≤ 128 per row), each looked up in the grid.
        const s = Math.max(viewW / 128, grid.cellM * 0.7);
        for (let y = s / 2; y < viewH; y += s) {
          for (let x = s / 2; x < viewW; x += s) if (proj.unproject(x, y, tmp)) visit(dirToCell(tmp[0], tmp[1], tmp[2], n));
        }
      },
      landAt: (mx, my) => (proj.unproject(mx, my, tmp) ? dirToCell(tmp[0], tmp[1], tmp[2], n) : -1),
    };
  };
  const make = (d: ArrayLike<number>): ViewProj => (globe ? globeView(d, R, GLOBE_MIN_FACING, 0) : capView(d, R, viewW, viewH));

  // Land-weighted: centred on a land cell drawn ∝ its area, jittered inside it; resampled if < 10 % land.
  const centre = new Float64Array(3);
  const east = new Float64Array(3);
  const north = new Float64Array(3);
  const up = new Float64Array(3);
  let tries = 0;
  while (res.land.counts.length < nLand && tries < nLand * 4 && c.landList.length) {
    tries++;
    const cell = pickWeighted(c.landList, (i) => grid.area(i), c.maxArea, rnd);
    grid.frame(cell, east, north, up);
    const s = grid.cellM / R;
    const a = (rnd() - 0.5) * s;
    const b = (rnd() - 0.5) * s;
    for (let k = 0; k < 3; k++) centre[k] = up[k] + a * east[k] + b * north[k];
    const len = Math.hypot(centre[0], centre[1], centre[2]);
    for (let k = 0; k < 3; k++) centre[k] /= len;
    const one = emptySample();
    const oneCls = new Map<string, number>();
    measureView(view(make(centre)), one, false, null, oneCls);
    if (one.landShare[0] < OCEAN_VIEW_LAND) continue;
    for (const [k, v] of oneCls) classSum.set(k, (classSum.get(k) ?? 0) + v);
    for (const k of Object.keys(one) as (keyof BandSample)[]) res.land[k].push(one[k][0]);
  }
  for (let k = 0; k < nUni; k++) {
    randomDir(rnd, centre);
    measureView(view(make(centre)), res.uniform, true, res.ocean);
  }
  const nl = Math.max(1, res.land.counts.length);
  for (const [k, v] of classSum) res.classMean[k] = Math.round((v / nl) * 100) / 100;
  return res;
}

/** bbox over the finite coordinates (projected polylines carry NaN where a point is off the view's sheet). */
function bboxFinite(f: Omit<Feat, 'bx0' | 'by0' | 'bx1' | 'by1'>): Feat {
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  const add = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    bx0 = Math.min(bx0, x);
    bx1 = Math.max(bx1, x);
    by0 = Math.min(by0, y);
    by1 = Math.max(by1, y);
  };
  add(f.x, f.y);
  if (f.pts) for (let i = 0; i < f.pts.length; i += 2) add(f.pts[i], f.pts[i + 1]);
  return { ...f, bx0, by0, bx1, by1 };
}
