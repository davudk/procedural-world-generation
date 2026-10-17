/**
 * Aggregates per-world metrics into per-(group, archetype) summaries with pass/fail against the
 * research 05 targets, plus the size-invariance comparison (research 05 §5.5).
 */
import { summarize, type Summary } from './lib/math';
import {
  bandsFor, CLARK_EVANS, CONTRAST, contrastFor, COUNT_TARGETS, CV_HI, CV_LO, EMPTY_OK_SHARE, ENTROPY_OK_SHARE, GEOMORPH, P95_SLACK,
  QUIET, type BandId,
} from './targets';
import type { WorldMetrics } from './world';

export interface BandAgg {
  viewKm: number;
  capKm: number;
  lo: number;
  hi: number;
  entropyMin: number;
  /** Counts pooled over every land-weighted viewport of every seed. */
  pooled: Summary;
  uniform: Summary;
  /** Ocean-dominated uniform viewports (land < 10 %); targets halved. */
  ocean: Summary;
  emptyKm: Summary;
  entropy: Summary;
  cv: Summary;
  labels: Summary;
  /** Share of pooled land viewports whose empty disk is within the cap / entropy above the threshold. */
  emptyOk: number;
  entropyOk: number;
  /** Pooled verdicts (research 05 §5.2). */
  pass: { count: boolean; empty: boolean; entropy: boolean; cv: boolean };
  /** Share of seeds whose own viewports pass: count (p5 ≥ lo and p95 ≤ 1.5·hi), empty, entropy, all three. */
  seedPass: { count: number; empty: number; entropy: number; all: number };
  /** Histogram of pooled counts (bin width `histBin`). */
  hist: number[];
  histBin: number;
  classMean: Record<string, number>;
}

export interface RateAgg {
  summary: Summary;
  /** Share of seeds inside the target range (zeroOk rows also pass at 0). */
  passRate: number;
  range?: [number, number];
}

export interface Flag {
  seed: number;
  query: string;
  reasons: string[];
}

export interface ArchAgg {
  group: string;
  archetype: string;
  mode: string;
  shape: 'flat' | 'sphere';
  worldKm: number;
  /** Sphere circumference (km); 0 on flat maps. */
  planetKm: number;
  seeds: number;
  msMean: number;
  landKm2: Summary;
  bands: Record<BandId, BandAgg>;
  targets: Record<string, { rate: number; rateAlt: number; got: Summary; drawnMean: number }>;
  counts: Record<string, RateAgg>;
  features: Record<string, { per: string; count: Summary; rate: Summary }>;
  tiers: Record<string, Summary>;
  rareAtLeastOne: number;
  heroes: { count: Summary; inRange: number; spacingOk: number };
  contrast: { lowShare: Summary; highShare: Summary; kingRatio: Summary; lowOk: number; highOk: number; kingOk: number; wViewOk: number };
  geomorph: Record<string, RateAgg>;
  clarkEvans: Record<string, RateAgg>;
  quiet: RateAgg;
  biomeMax: Summary;
  /** Land share under perennial snow / ice, and the highest summit (m). */
  iceShare: Summary;
  peakMax: Summary;
  boringRate: number;
  clutteredRate: number;
  boring: Flag[];
  cluttered: Flag[];
  /** Most frequent boring / cluttered reasons (reason prefix → seeds). */
  boringReasons: Record<string, number>;
  clutteredReasons: Record<string, number>;
}

const share = (xs: boolean[]): number => (xs.length ? xs.filter(Boolean).length / xs.length : NaN);
const pct = (xs: number[], q: number): number => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return summarize(s)[q === 5 ? 'p5' : q === 95 ? 'p95' : 'p50'];
};

/** As rateAgg, with a range per world (sphere count rows scale with the planet). */
function rateAggPer(values: number[], ranges: [number, number][], zeroOk = false): RateAgg {
  let n = 0;
  let ok = 0;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) return;
    n++;
    if ((zeroOk && v === 0) || (v >= ranges[i][0] && v <= ranges[i][1])) ok++;
  });
  return { summary: summarize(values), range: ranges[0], passRate: n ? ok / n : NaN };
}

function rateAgg(values: number[], range: [number, number], zeroOk = false): RateAgg {
  const fin = values.filter(Number.isFinite);
  return {
    summary: summarize(values), range,
    passRate: fin.length ? fin.filter((v) => (zeroOk && v === 0) || (v >= range[0] && v <= range[1])).length / fin.length : NaN,
  };
}

/** Reason key without the numbers, for grouping. */
const reasonKey = (r: string): string => r.replace(/[\d.]+/g, '#').replace(/\s+/g, ' ').trim();

export function aggregateArch(ws: WorldMetrics[]): ArchAgg {
  const w0 = ws[0];
  const bands = {} as Record<BandId, BandAgg>;
  for (const b of bandsFor(w0.shape)) {
    const pooledCounts = ws.flatMap((w) => w.bands[b.id].land.counts);
    const capKm = w0.bands[b.id].capKm;
    const empties = ws.flatMap((w) => w.bands[b.id].land.emptyKm).filter(Number.isFinite);
    const ents = ws.flatMap((w) => w.bands[b.id].land.entropy);
    const cvs = ws.map((w) => pct(w.bands[b.id].land.cv, 50));
    const pooled = summarize(pooledCounts);
    const emptyOk = empties.length ? empties.filter((e) => e <= capKm).length / empties.length : NaN;
    const entropyOk = ents.length ? ents.filter((e) => e >= b.entropyMin).length / ents.length : NaN;
    const seedCount = ws.map((w) => pct(w.bands[b.id].land.counts, 5) >= b.lo && pct(w.bands[b.id].land.counts, 95) <= P95_SLACK * b.hi);
    const seedEmpty = ws.map((w) => {
      const e = w.bands[b.id].land.emptyKm.filter(Number.isFinite);
      return e.length > 0 && e.filter((v) => v <= w.bands[b.id].capKm).length / e.length >= EMPTY_OK_SHARE;
    });
    const seedEnt = ws.map((w) => {
      const e = w.bands[b.id].land.entropy;
      return e.length > 0 && e.filter((v) => v >= b.entropyMin).length / e.length >= ENTROPY_OK_SHARE;
    });
    const cvP50 = summarize(cvs).p50;
    const histBin = Math.max(1, Math.ceil((pooled.max || 1) / 30));
    const hist = new Array<number>(Math.floor((pooled.max || 0) / histBin) + 1).fill(0);
    for (const c of pooledCounts) hist[Math.floor(c / histBin)]++;
    const classMean: Record<string, number> = {};
    for (const w of ws) for (const [k, v] of Object.entries(w.bands[b.id].classMean)) classMean[k] = (classMean[k] ?? 0) + v / ws.length;
    bands[b.id] = {
      viewKm: w0.bands[b.id].viewKm, capKm, lo: b.lo, hi: b.hi, entropyMin: b.entropyMin,
      pooled, uniform: summarize(ws.flatMap((w) => w.bands[b.id].uniform.counts)), ocean: summarize(ws.flatMap((w) => w.bands[b.id].ocean)),
      emptyKm: summarize(empties), entropy: summarize(ents), cv: summarize(cvs), labels: summarize(ws.flatMap((w) => w.bands[b.id].land.labels)),
      emptyOk, entropyOk,
      pass: {
        count: pooled.p5 >= b.lo && pooled.p95 <= P95_SLACK * b.hi, empty: emptyOk >= EMPTY_OK_SHARE, entropy: entropyOk >= ENTROPY_OK_SHARE,
        cv: cvP50 >= CV_LO && cvP50 <= CV_HI,
      },
      seedPass: {
        count: share(seedCount), empty: share(seedEmpty), entropy: share(seedEnt),
        all: share(ws.map((_, i) => seedCount[i] && seedEmpty[i] && seedEnt[i])),
      },
      hist, histBin, classMean,
    };
  }

  const targets: ArchAgg['targets'] = {};
  for (const id of Object.keys(w0.targets)) {
    const ts = ws.map((w) => w.targets[id]);
    targets[id] = {
      rate: share(ts.map((t) => t.ok)), rateAlt: share(ts.map((t) => t.okAlt)), got: summarize(ts.map((t) => t.got)),
      drawnMean: summarize(ts.map((t) => t.drawn ?? t.value ?? NaN)).mean,
    };
  }

  const counts: Record<string, RateAgg> = {};
  for (const t of COUNT_TARGETS) counts[t.key] = rateAggPer(ws.map((w) => w.rates[t.key]), ws.map((w) => w.countRanges?.[t.key] ?? t.range), t.zeroOk);

  const features: ArchAgg['features'] = {};
  for (const [k, f] of Object.entries(w0.features)) {
    features[k] = { per: f.per, count: summarize(ws.map((w) => w.features[k].count)), rate: summarize(ws.map((w) => w.features[k].rate)) };
  }
  const tiers: Record<string, Summary> = {};
  for (const t of ['common', 'uncommon', 'rare', 'legendary']) tiers[t] = summarize(ws.map((w) => w.tiers[t] ?? 0));

  const geomorph: Record<string, RateAgg> = {};
  for (const [k, r] of Object.entries(GEOMORPH)) geomorph[k] = rateAgg(ws.map((w) => w.geomorph[k as keyof WorldMetrics['geomorph']]), r);
  const clarkEvans: Record<string, RateAgg> = {};
  for (const [k, r] of Object.entries(CLARK_EVANS)) clarkEvans[k] = rateAgg(ws.map((w) => w.clarkEvans[k] ?? NaN), r);

  const boring = ws.filter((w) => w.boring.length).map((w) => ({ seed: w.seed, query: w.query, reasons: w.boring }));
  const cluttered = ws.filter((w) => w.cluttered.length).map((w) => ({ seed: w.seed, query: w.query, reasons: w.cluttered }));
  const tally = (fs: Flag[]): Record<string, number> => {
    const o: Record<string, number> = {};
    for (const f of fs) for (const r of new Set(f.reasons.map(reasonKey))) o[r] = (o[r] ?? 0) + 1;
    return o;
  };

  return {
    group: w0.group, archetype: w0.archetype, mode: w0.mode, shape: w0.shape, worldKm: w0.worldKm, planetKm: w0.planetKm, seeds: ws.length,
    msMean: summarize(ws.map((w) => w.ms)).mean, landKm2: summarize(ws.map((w) => w.landKm2)),
    bands, targets, counts, features, tiers,
    rareAtLeastOne: share(ws.map((w) => (w.tiers.rare ?? 0) >= 1)),
    heroes: {
      count: summarize(ws.map((w) => w.heroes.count)),
      inRange: share(ws.map((w) => w.heroes.count >= 3 && w.heroes.count <= 5)),
      spacingOk: share(ws.map((w) => w.heroes.count < 2 || w.heroes.minSpacingFrac >= 0.25 - 1e-6)),
    },
    contrast: {
      lowShare: summarize(ws.map((w) => w.contrast.lowShare)), highShare: summarize(ws.map((w) => w.contrast.highShare)),
      kingRatio: summarize(ws.map((w) => w.contrast.kingRatio)),
      lowOk: share(ws.map((w) => w.contrast.lowShare >= CONTRAST.lowShare)),
      highOk: share(ws.map((w) => w.contrast.highShare >= contrastFor(w.archetype).highShare)),
      kingOk: share(ws.map((w) => w.contrast.kingRatio >= CONTRAST.kingRatio)),
      wViewOk: summarize(ws.map((w) => w.contrast.wViewOk)).mean,
    },
    geomorph, clarkEvans,
    quiet: rateAgg(ws.map((w) => w.quietShare), QUIET.share),
    biomeMax: summarize(ws.map((w) => w.biome.maxShare)),
    iceShare: summarize(ws.map((w) => w.iceShare)), peakMax: summarize(ws.map((w) => w.peakMaxM)),
    boringRate: boring.length / ws.length, clutteredRate: cluttered.length / ws.length,
    boring, cluttered, boringReasons: tally(boring), clutteredReasons: tally(cluttered),
  };
}

export interface SizeRow {
  key: string;
  kind: 'rate' | 'band';
  values: Record<number, number>;
  /** max |value / value@1024 − 1| over the other sizes. */
  maxDev: number;
  tol: number;
  ok: boolean;
}

/**
 * Size invariance (research 05 §5.5): per-10⁵ km² rates within ±20 %, same-band viewport metrics within
 * ±15 %. Flat sweeps compare world widths against 1024 km; sphere sweeps compare circumferences against
 * the 4,096 km small planet.
 */
export function sizeInvariance(ws: WorldMetrics[]): SizeRow[] {
  const sphere = ws.length > 0 && ws[0].shape === 'sphere';
  const sizeOf = (w: WorldMetrics): number => (sphere ? w.planetKm : w.worldKm);
  const sizes = [...new Set(ws.map(sizeOf))].sort((a, b) => a - b);
  if (sizes.length < 2) return [];
  const pref = sphere ? 4096 : 1024;
  const ref = sizes.includes(pref) ? pref : sizes[Math.floor(sizes.length / 2)];
  const rows: SizeRow[] = [];
  const add = (key: string, kind: SizeRow['kind'], tol: number, f: (w: WorldMetrics) => number): void => {
    const values: Record<number, number> = {};
    for (const s of sizes) values[s] = summarize(ws.filter((w) => sizeOf(w) === s).map(f)).mean;
    let maxDev = 0;
    for (const s of sizes) if (s !== ref) maxDev = Math.max(maxDev, Math.abs(values[s] / values[ref] - 1));
    if (!Number.isFinite(maxDev)) maxDev = NaN;
    rows.push({ key, kind, values, maxDev, tol, ok: maxDev <= tol });
  };
  for (const k of ['peaks', 'peaks3k', 'volcanoes', 'lakes', 'lakes10', 'lakes100', 'islands', 'islands100', 'waterfalls', 'canyons', 'rivers56', 'glaciers', 'dolines']) {
    add(`${k} /10⁵ km²`, 'rate', 0.2, (w) => w.features[k]?.rate ?? NaN);
  }
  for (const k of ['riversToSea', 'deltas', 'peninsulas', 'seaStacks', 'barrierIslands']) add(`${k} /1000 km coast`, 'rate', 0.2, (w) => w.features[k]?.rate ?? NaN);
  add('wetland share', 'rate', 0.2, (w) => w.counts.wetland);
  add('land share < 300 m', 'rate', 0.2, (w) => w.contrast.lowShare);
  for (const b of (sphere ? ['W', 'R', 'A', 'L'] : ['R', 'A', 'L']) as BandId[]) {
    add(`${b} view count p50`, 'band', 0.15, (w) => pct(w.bands[b].land.counts, 50));
    add(`${b} empty disk p50 (km)`, 'band', 0.15, (w) => pct(w.bands[b].land.emptyKm, 50));
  }
  return rows;
}

/** One row of the sphere-vs-flat comparison at equal area: mean per planet size for both shapes. */
export interface ShapeRow {
  key: string;
  /** Planet circumference → [sphere mean, flat mean at the equal-area width]. */
  values: Record<number, [number, number]>;
  /** max |sphere / flat − 1| over the sizes. */
  maxDev: number;
  tol: number;
  ok: boolean;
}

/**
 * Sphere vs an equal-area flat world (research 10 §7): the question is "does the sphere generate the
 * same densities as a flat world of the same area". Worlds pair by worldKm (the sphere's equal-area
 * size √(4πR²) = the flat width). Same tolerances as the size sweep.
 */
export function shapeComparison(spheres: WorldMetrics[], flats: WorldMetrics[]): ShapeRow[] {
  const sizes = [...new Set(spheres.map((w) => w.planetKm))].sort((a, b) => a - b);
  const pairs = sizes
    .map((c) => {
      const s = spheres.filter((w) => w.planetKm === c);
      const km = Math.round(s[0].worldKm);
      return { c, s, f: flats.filter((w) => Math.abs(w.worldKm - km) <= 1) };
    })
    .filter((p) => p.f.length > 0);
  if (!pairs.length) return [];
  const rows: ShapeRow[] = [];
  const add = (key: string, tol: number, f: (w: WorldMetrics) => number): void => {
    const values: Record<number, [number, number]> = {};
    let maxDev = 0;
    for (const p of pairs) {
      const a = summarize(p.s.map(f)).mean;
      const b = summarize(p.f.map(f)).mean;
      values[p.c] = [a, b];
      maxDev = Math.max(maxDev, Math.abs(a / b - 1));
    }
    if (!Number.isFinite(maxDev)) maxDev = NaN;
    rows.push({ key, values, maxDev, tol, ok: maxDev <= tol });
  };
  for (const k of ['peaks', 'peaks3k', 'volcanoes', 'lakes', 'lakes10', 'lakes100', 'islands', 'islands100', 'waterfalls', 'canyons', 'rivers56', 'glaciers', 'dolines']) {
    add(`${k} /10⁵ km²`, 0.2, (w) => w.features[k]?.rate ?? NaN);
  }
  for (const k of ['riversToSea', 'deltas', 'peninsulas', 'seaStacks', 'barrierIslands']) add(`${k} /1000 km coast`, 0.2, (w) => w.features[k]?.rate ?? NaN);
  add('land km²', 0.2, (w) => w.landKm2);
  add('wetland share', 0.2, (w) => w.counts.wetland);
  add('ice share of land', 0.2, (w) => w.iceShare);
  add('land share < 300 m', 0.2, (w) => w.contrast.lowShare);
  add('land share > 2000 m', 0.2, (w) => w.contrast.highShare);
  add('highest summit (m)', 0.2, (w) => w.peakMaxM);
  // W is left out: it is a fixed 1,024 km cap on spheres but the whole map on flat worlds.
  for (const b of ['R', 'A', 'L'] as BandId[]) {
    add(`${b} view count p50`, 0.15, (w) => pct(w.bands[b].land.counts, 50));
    add(`${b} empty disk p50 (km)`, 0.15, (w) => pct(w.bands[b].land.emptyKm, 50));
  }
  return rows;
}
