/**
 * JIT determinism stress (docs/notes/v8-maglev-shared-number-boxes.md): generates a few worlds once
 * in this thread, then re-runs only the landmark registry over them in many fresh worker threads.
 * Each worker is a fresh V8 isolate (fresh maps, feedback and tiering decisions), so JIT-dependent
 * outputs show up as landmark hashes that differ from this thread's. The default sequence is the one
 * that exposed the Maglev bug: earth 7 preview and 512 km build warm the registry up, earth 11 preview
 * then lost a gulf to a bay in about 1 in 60 isolates (with 8 workers at once; fewer under less load).
 *
 *   npm run jit-stress                          # 400 isolates, 8 at a time
 *   npm run jit-stress -- --runs 1000 --workers 8
 */
import { fileURLToPath } from 'node:url';
import { isMainThread, Worker } from 'node:worker_threads';
import { Pipeline, type CacheEntry } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import { resolve } from '../src/shared/config/resolve';
import type { Pins, StageId } from '../src/shared/config/types';
import { hashValue } from '../src/shared/hash';
import type { GenMode } from '../src/shared/protocol';

export interface StressWorld {
  archetype: string;
  seed: number;
  mode: GenMode;
  pins: Pins;
}

const BUILD512: Pins = { worldSize: 512, lemGrid: '256', macroGrid: '512' };
export const DEFAULT_WORLDS: StressWorld[] = [
  { archetype: 'earth', seed: 7, mode: 'preview', pins: {} },
  { archetype: 'earth', seed: 7, mode: 'build', pins: BUILD512 },
  { archetype: 'earth', seed: 11, mode: 'preview', pins: {} },
];

/** A world with every stage but the registry cached, ready to post to a worker. */
export interface PreparedWorld {
  world: StressWorld;
  entries: [StageId, CacheEntry][];
}

export interface StressResult {
  runs: number;
  /** Registry landmark hash per world in this thread. */
  expected: number[];
  /** Isolates whose hash for some world differed, with the world names. */
  mismatches: string[][];
  ms: number;
}

export const worldName = (w: StressWorld): string => `${w.archetype}-${w.seed}-${w.mode}${w.pins.worldSize ? w.pins.worldSize : ''}`;

/** Runs the registry for each world in order on fresh pipelines; returns the landmark hash per world. */
export async function registryHashes(worlds: PreparedWorld[]): Promise<number[]> {
  const out: number[] = [];
  for (const { world, entries } of worlds) {
    const p = new Pipeline(STAGES);
    p.restore(entries);
    let err = '';
    await p.run(resolve({ seed: world.seed, archetype: world.archetype, pins: world.pins }), world.mode, 1, (m) => {
      if (m.type === 'error') err = m.message;
    }, () => false);
    if (err) throw new Error(err);
    out.push(hashValue(p.output('registry')!.vectors!.landmarks!));
  }
  return out;
}

export async function prepare(worlds: StressWorld[]): Promise<PreparedWorld[]> {
  const out: PreparedWorld[] = [];
  for (const world of worlds) {
    const p = new Pipeline(STAGES.filter((s) => s.id !== 'registry'));
    let err = '';
    await p.run(resolve({ seed: world.seed, archetype: world.archetype, pins: world.pins }), world.mode, 1, (m) => {
      if (m.type === 'error') err = m.message;
    }, () => false);
    if (err) throw new Error(err);
    out.push({ world, entries: p.snapshot() });
  }
  return out;
}

export async function jitStress(o: { runs: number; workers: number; worlds?: StressWorld[] }): Promise<StressResult> {
  const t0 = performance.now();
  const prepared = await prepare(o.worlds ?? DEFAULT_WORLDS);
  const expected = await registryHashes(prepared);
  const execArgv = ['--experimental-transform-types', '--no-warnings', '--import', new URL('./register.mjs', import.meta.url).href];
  const mismatches: string[][] = [];
  let started = 0;
  const one = (): Promise<void> =>
    new Promise((res, rej) => {
      const w = new Worker(new URL('./jitStressWorker.ts', import.meta.url), { execArgv, workerData: prepared });
      w.on('message', (m) => {
        const msg = m as { ok: true; hashes: number[] } | { ok: false; err: string };
        void w.terminate();
        if (!msg.ok) return rej(new Error(msg.err));
        const bad = prepared.filter((_, i) => msg.hashes[i] !== expected[i]).map((p) => worldName(p.world));
        if (bad.length > 0) mismatches.push(bad);
        res();
      });
      w.on('error', rej);
    });
  await Promise.all(
    Array.from({ length: Math.min(o.workers, o.runs) }, async () => {
      while (started < o.runs) {
        started++;
        await one();
      }
    }),
  );
  return { runs: o.runs, expected, mismatches, ms: Math.round(performance.now() - t0) };
}

if (isMainThread && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (k: string, d: number): number => {
    const i = process.argv.indexOf(k);
    return i >= 0 ? Number(process.argv[i + 1]) : d;
  };
  const r = await jitStress({ runs: arg('--runs', 400), workers: arg('--workers', 8) });
  for (const m of r.mismatches) console.log(`mismatch: ${m.join(', ')}`);
  console.log(`${r.runs} isolates, ${r.mismatches.length} with different landmarks, ${(r.ms / 1000).toFixed(1)} s`);
  if (r.mismatches.length > 0) process.exit(1);
}
