/**
 * Metrics suite runner: builds the job list (archetypes × seeds in preview, a build-mode subset,
 * and the size-invariance sweep), runs it on worker threads (or in-process), aggregates and writes
 * metrics.json, summary.json, report.html and summary.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHETYPES } from '../src/shared/config/archetypes';
import { aggregateArch, sizeInvariance, type ArchAgg, type SizeRow } from './aggregate';
import { renderHtml, renderMarkdown } from './report';
import { measureWorld, type WorldJob, type WorldMetrics } from './world';

export interface SuiteOptions {
  archetypes: string[];
  seeds: number;
  seedStart: number;
  buildArchetypes: string[];
  buildSeeds: number;
  sizeArchetype: string;
  sizes: number[];
  sizeSeeds: number;
  /** 'preview' (fixed 256² grid, cell size grows with the world) or 'build-const' (build mode, grids pinned to 1 km cells). */
  sizeMode: 'preview' | 'build-const';
  views: { land: number; uniform: number };
  /** 0 = run in this thread. */
  workers: number;
  outDir: string;
  /** Prefix for seed links in the report (the dev server by default). */
  baseUrl: string;
  quiet: boolean;
}

export const DEFAULT_OPTIONS: SuiteOptions = {
  archetypes: ARCHETYPES.map((a) => a.id),
  seeds: 40,
  seedStart: 1,
  buildArchetypes: ['earth', 'fjordland', 'desert'],
  buildSeeds: 4,
  sizeArchetype: 'earth',
  sizes: [512, 1024, 2048],
  sizeSeeds: 12,
  sizeMode: 'preview',
  views: { land: 64, uniform: 32 },
  workers: -1,
  outDir: 'metrics/out',
  baseUrl: 'http://localhost:5174/',
  quiet: false,
};

export interface SuiteResult {
  meta: { startedAt: string; seconds: number; workers: number; worlds: number; failures: string[]; options: SuiteOptions };
  archetypes: ArchAgg[];
  size: SizeRow[];
  worlds: WorldMetrics[];
}

export function buildJobs(o: SuiteOptions): WorldJob[] {
  const jobs: WorldJob[] = [];
  const seeds = (k: number): number[] => Array.from({ length: k }, (_, i) => o.seedStart + i);
  for (const a of o.archetypes) for (const seed of seeds(o.seeds)) jobs.push({ archetype: a, seed, mode: 'preview', group: 'preview', views: o.views });
  for (const a of o.buildArchetypes) for (const seed of seeds(o.buildSeeds)) jobs.push({ archetype: a, seed, mode: 'build', group: 'build', views: o.views });
  if (o.sizes.length > 1) {
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
  const groupRank = (g: string): number => (g === 'preview' ? 0 : g === 'build' ? 1 : 2);
  const archRank = (a: string): number => o.archetypes.indexOf(a);
  archetypes.sort((a, b) => groupRank(a.group) - groupRank(b.group) || archRank(a.archetype) - archRank(b.archetype) || a.worldKm - b.worldKm);
  const size = sizeInvariance(worlds.filter((w) => w.group.startsWith('size-')));
  const result: SuiteResult = {
    meta: { startedAt: new Date().toISOString(), seconds: (performance.now() - t0) / 1000, workers, worlds: worlds.length, failures, options: o },
    archetypes, size, worlds,
  };

  mkdirSync(o.outDir, { recursive: true });
  writeFileSync(join(o.outDir, 'metrics.json'), JSON.stringify(result, compact));
  writeFileSync(join(o.outDir, 'summary.json'), JSON.stringify({ meta: result.meta, archetypes, size }, compact, 1));
  writeFileSync(join(o.outDir, 'report.html'), renderHtml(result));
  writeFileSync(join(o.outDir, 'summary.md'), renderMarkdown(result));
  return result;
}
