/**
 * Aggregates per-world metrics into per-(group, archetype) summaries with pass/fail against the
 * research 05 targets, plus the size-invariance comparison (research 05 §5.5).
 */
import { summarize, type Summary } from './lib/math';
import {
  BANDS, CLARK_EVANS, CONTRAST, contrastFor, COUNT_TARGETS, CV_HI, CV_LO, EMPTY_OK_SHARE, ENTROPY_OK_SHARE, GEOMORPH, P95_SLACK,
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
  worldKm: number;
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
  for (const b of BANDS) {
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
  for (const t of COUNT_TARGETS) counts[t.key] = rateAgg(ws.map((w) => w.rates[t.key]), t.range, t.zeroOk);

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
    group: w0.group, archetype: w0.archetype, mode: w0.mode, worldKm: w0.worldKm, seeds: ws.length,
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

/** Size invariance (research 05 §5.5): per-10⁵ km² rates within ±20 %, same-band viewport metrics within ±15 %. */
export function sizeInvariance(ws: WorldMetrics[]): SizeRow[] {
  const sizes = [...new Set(ws.map((w) => w.worldKm))].sort((a, b) => a - b);
  if (sizes.length < 2) return [];
  const ref = sizes.includes(1024) ? 1024 : sizes[Math.floor(sizes.length / 2)];
  const rows: SizeRow[] = [];
  const add = (key: string, kind: SizeRow['kind'], tol: number, f: (w: WorldMetrics) => number): void => {
    const values: Record<number, number> = {};
    for (const s of sizes) values[s] = summarize(ws.filter((w) => w.worldKm === s).map(f)).mean;
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
  for (const b of ['R', 'A', 'L'] as BandId[]) {
    add(`${b} view count p50`, 'band', 0.15, (w) => pct(w.bands[b].land.counts, 50));
    add(`${b} empty disk p50 (km)`, 'band', 0.15, (w) => pct(w.bands[b].land.emptyKm, 50));
  }
  return rows;
}
