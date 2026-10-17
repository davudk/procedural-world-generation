/**
 * Metrics suite runner: builds the job list (archetypes × seeds in preview, a build-mode subset,
 * and the size-invariance sweep), runs it on worker threads (or in-process), aggregates and writes
 * metrics.json, summary.json, report.html and summary.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHETYPES } from '../src/shared/config/archetypes';
import type { Pins } from '../src/shared/config/types';
import { aggregateArch, shapeComparison, sizeInvariance, type ArchAgg, type ShapeRow, type SizeRow } from './aggregate';
import { renderHtml, renderMarkdown } from './report';
import { measureWorld, type WorldJob, type WorldMetrics } from './world';

export interface SuiteOptions {
  /** Shape of the preview and build suites (spheres: the default small planet unless an archetype biases it). */
  shape: 'flat' | 'sphere';
  archetypes: string[];
  seeds: number;
  seedStart: number;
  buildArchetypes: string[];
  buildSeeds: number;
  sizeArchetype: string;
  sizes: number[];
  /** Sphere sweep: planet circumferences (km), compared with the 4,096 km small planet. */
  planetSizes: number[];
  sizeSeeds: number;
  /** Sphere sweep: also run flat worlds of equal area (width √(4πR²), where that fits the flat 4,096 km maximum). */
  equalArea: boolean;
  /** 'preview' (fixed 256² grid, cell size grows with the world) or 'build-const' (build mode, grids pinned to 1 km cells). */
  sizeMode: 'preview' | 'build-const';
  views: { land: number; uniform: number };
  /** 0 = run in this thread. */
  workers: number;
  outDir: string;
  /** Extra pins for every world of the run (experiments: `--pins peakHeight=3000:6000,glaciation=1`). */
  pins: Pins;
  /** Prefix for seed links in the report (the dev server by default). */
  baseUrl: string;
  quiet: boolean;
}

export const DEFAULT_OPTIONS: SuiteOptions = {
  shape: 'flat',
  archetypes: ARCHETYPES.map((a) => a.id),
  seeds: 40,
  seedStart: 1,
  buildArchetypes: ['earth', 'fjordland', 'desert'],
  buildSeeds: 4,
  sizeArchetype: 'earth',
  sizes: [512, 1024, 2048],
  planetSizes: [2048, 4096, 8192, 12000],
  sizeSeeds: 12,
  equalArea: true,
  sizeMode: 'preview',
  views: { land: 64, uniform: 32 },
  workers: -1,
  outDir: 'metrics/out',
  pins: {},
  baseUrl: 'http://localhost:5174/',
  quiet: false,
};

export interface SuiteResult {
  meta: { startedAt: string; seconds: number; workers: number; worlds: number; failures: string[]; options: SuiteOptions };
  archetypes: ArchAgg[];
  size: SizeRow[];
  /** Sphere sweeps: sphere vs equal-area flat worlds. */
  shape: ShapeRow[];
  worlds: WorldMetrics[];
}

export function buildJobs(o: SuiteOptions): WorldJob[] {
  const jobs: WorldJob[] = [];
  const seeds = (k: number): number[] => Array.from({ length: k }, (_, i) => o.seedStart + i);
  const sphere = o.shape === 'sphere';
  const base = { pins: { ...o.pins, ...(sphere ? { worldShape: 'sphere' } : {}) } };
  for (const a of o.archetypes) for (const seed of seeds(o.seeds)) jobs.push({ archetype: a, seed, mode: 'preview', group: 'preview', views: o.views, ...base });
  for (const a of o.buildArchetypes) for (const seed of seeds(o.buildSeeds)) jobs.push({ archetype: a, seed, mode: 'build', group: 'build', views: o.views, ...base });
  if (sphere) {
    if (o.planetSizes.length > 1 && o.sizeSeeds > 0) {
      for (const c of o.planetSizes) {
        for (const seed of seeds(o.sizeSeeds)) {
          jobs.push({ archetype: o.sizeArchetype, seed, mode: 'preview', group: `size-${c}`, pins: { ...o.pins, worldShape: 'sphere', planetSize: c }, views: o.views });
        }
        // Equal-area flat world: width √(4πR²) = C / √π.
        const km = Math.round(c / Math.sqrt(Math.PI));
        if (o.equalArea && km <= 4096) {
          for (const seed of seeds(o.sizeSeeds)) jobs.push({ archetype: o.sizeArchetype, seed, mode: 'preview', group: `flat-${km}`, pins: { ...o.pins, worldSize: km }, views: o.views });
        }
      }
    }
  } else if (o.sizes.length > 1) {
    for (const s of o.sizes) {
      for (const seed of seeds(o.sizeSeeds)) {
        const build = o.sizeMode === 'build-const';
        const pins = build ? { worldSize: s, lemGrid: String(Math.min(1024, s / 2)), macroGrid: String(s) } : { worldSize: s };
        jobs.push({ archetype: o.sizeArchetype, seed, mode: build ? 'build' : 'preview', group: `size-${s}`, pins, views: o.views });
      }
    }
  }
  return jobs;
}

/** Rounds numbers for a compact JSON dump. */
function compact(_k: string, v: unknown): unknown {
  return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
}

async function runPool(jobs: WorldJob[], workers: number, onDone: (m: WorldMetrics | null, job: WorldJob, err?: string) => void): Promise<void> {
  if (workers <= 0) {
    for (const j of jobs) {
      try {
        onDone(await measureWorld(j), j);
      } catch (e) {
        onDone(null, j, String(e));
      }
    }
    return;
  }
  const { Worker } = await import('node:worker_threads');
  const execArgv = ['--experimental-transform-types', '--no-warnings', '--import', new URL('./register.mjs', import.meta.url).href];
  // Build-mode jobs are ~8× slower: start them first so they don't trail at the end.
  const queue = [...jobs].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'build' ? -1 : 1));
  await new Promise<void>((resolveAll, reject) => {
    let active = 0;
    const start = (): void => {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { execArgv });
      active++;
      let current: WorldJob | undefined;
      const next = (): void => {
        current = queue.shift();
        if (current) w.postMessage(current);
        else {
          void w.terminate();
        }
      };
      w.on('message', (msg) => {
        const r = msg as { ok: true; m: WorldMetrics } | { ok: false; err: string };
        if (r.ok) onDone(r.m, current!);
        else onDone(null, current!, r.err);
        next();
      });
      w.on('error', (e) => reject(e));
      w.on('exit', () => {
        active--;
        if (active === 0) resolveAll();
      });
      next();
    };
    for (let k = 0; k < Math.min(workers, queue.length); k++) start();
    if (queue.length === 0) resolveAll();
  });
}

export async function runSuite(partial: Partial<SuiteOptions> = {}): Promise<SuiteResult> {
  const o: SuiteOptions = { ...DEFAULT_OPTIONS, ...partial };
  const t0 = performance.now();
  const jobs = buildJobs(o);
  let workers = o.workers;
  if (workers < 0) {
    const { availableParallelism } = await import('node:os');
    workers = Math.max(1, availableParallelism() - 1);
  }
  const worlds: WorldMetrics[] = [];
  const failures: string[] = [];
  let done = 0;
  await runPool(jobs, workers, (m, job, err) => {
    done++;
    if (m) worlds.push(m);
    else failures.push(`${job.group} ${job.archetype} seed ${job.seed}: ${err}`);
    if (!o.quiet) {
      const el = (performance.now() - t0) / 1000;
      process.stdout.write(`\r  ${done}/${jobs.length} worlds  ${el.toFixed(0)} s  (${job.group} ${job.archetype} #${job.seed})        `);
    }
  });
  if (!o.quiet) process.stdout.write('\n');

  const key = (w: WorldMetrics): string => `${w.group}|${w.archetype}`;
  const groups = new Map<string, WorldMetrics[]>();
  for (const w of worlds.sort((a, b) => a.seed - b.seed)) {
    const k = key(w);
    const g = groups.get(k);
    if (g) g.push(w);
    else groups.set(k, [w]);
  }
  const archetypes = [...groups.values()].map(aggregateArch);
  const groupRank = (g: string): number => (g === 'preview' ? 0 : g === 'build' ? 1 : g.startsWith('size-') ? 2 : 3);
  const archRank = (a: string): number => o.archetypes.indexOf(a);
  archetypes.sort((a, b) => groupRank(a.group) - groupRank(b.group) || archRank(a.archetype) - archRank(b.archetype) || a.worldKm - b.worldKm);
  const sized = worlds.filter((w) => w.group.startsWith('size-'));
  const size = sizeInvariance(sized);
  const shape = shapeComparison(sized.filter((w) => w.shape === 'sphere'), worlds.filter((w) => w.group.startsWith('flat-')));
  const result: SuiteResult = {
    meta: { startedAt: new Date().toISOString(), seconds: (performance.now() - t0) / 1000, workers, worlds: worlds.length, failures, options: o },
    archetypes, size, shape, worlds,
  };

  mkdirSync(o.outDir, { recursive: true });
  writeFileSync(join(o.outDir, 'metrics.json'), JSON.stringify(result, compact));
  writeFileSync(join(o.outDir, 'summary.json'), JSON.stringify({ meta: result.meta, archetypes, size, shape }, compact, 1));
  writeFileSync(join(o.outDir, 'report.html'), renderHtml(result));
  writeFileSync(join(o.outDir, 'summary.md'), renderMarkdown(result));
  return result;
}
