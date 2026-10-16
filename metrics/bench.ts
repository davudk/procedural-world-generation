/**
 * Generation benchmark (research 10 §2.5): runs the pipeline for fixed worlds several times in this
 * thread and prints per-stage median wall times, so refactors can be checked against a recorded
 * baseline (+3 % per stage, +2 % in total).
 *
 *   npm run bench                                   # earth, seeds 7 + 11, preview and build, 5 runs
 *   npm run bench -- --runs 3 --seeds 7 --modes preview --json
 *   npm run bench -- --shape sphere                 # the default small planet (stages up to climate)
 */
import { Pipeline } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import { resolve } from '../src/shared/config/resolve';
import { SPHERE_STAGES } from '../src/shared/config/types';
import type { GenMode } from '../src/shared/protocol';

interface Args {
  runs: number;
  seeds: number[];
  modes: GenMode[];
  archetype: string;
  shape: 'flat' | 'sphere';
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { runs: 5, seeds: [7, 11], modes: ['preview', 'build'], archetype: 'earth', shape: 'flat', json: false };
  for (let k = 0; k < argv.length; k++) {
    const v = argv[k + 1] ?? '';
    switch (argv[k]) {
      case '--runs': a.runs = Number(v); k++; break;
      case '--seeds': a.seeds = v.split(',').map(Number); k++; break;
      case '--modes': a.modes = v.split(',') as GenMode[]; k++; break;
      case '--archetype': a.archetype = v; k++; break;
      case '--shape': a.shape = v === 'sphere' ? 'sphere' : 'flat'; k++; break;
      case '--json': a.json = true; break;
      default: throw new Error(`unknown argument ${argv[k]}`);
    }
  }
  return a;
}

function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Per-stage milliseconds of one uncached run. */
async function timeRun(seed: number, archetype: string, mode: GenMode, shape: Args['shape']): Promise<Map<string, number>> {
  const ms = new Map<string, number>();
  let err = '';
  await new Pipeline(STAGES).run(resolve({ seed, archetype, pins: shape === 'sphere' ? { worldShape: 'sphere' } : {} }), mode, 1, (m) => {
    if (m.type === 'stage-done') ms.set(m.stage, m.ms);
    else if (m.type === 'error') err = m.message;
  }, () => false);
  if (err) throw new Error(err);
  return ms;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const ids = [...STAGES.filter((s) => a.shape === 'flat' || SPHERE_STAGES.includes(s.id)).map((s) => s.id), 'total'];
  const result: Record<string, Record<string, number>> = {};
  for (const mode of a.modes) {
    // One untimed warm-up per mode so the kernels are compiled before timing.
    await timeRun(a.seeds[0], a.archetype, mode, a.shape);
    // perRun[id][r] = sum over seeds of stage id's time in run r.
    const perRun = new Map<string, number[]>(ids.map((id) => [id, []]));
    for (let r = 0; r < a.runs; r++) {
      const sum = new Map<string, number>(ids.map((id) => [id, 0]));
      for (const seed of a.seeds) {
        for (const [id, t] of await timeRun(seed, a.archetype, mode, a.shape)) {
          sum.set(id, sum.get(id)! + t);
          sum.set('total', sum.get('total')! + t);
        }
      }
      for (const id of ids) perRun.get(id)!.push(sum.get(id)!);
    }
    result[mode] = Object.fromEntries(ids.map((id) => [id, median(perRun.get(id)!)]));
  }
  if (a.json) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`bench: ${a.archetype}${a.shape === 'sphere' ? ' (sphere)' : ''}, seeds ${a.seeds.join(' + ')} summed, median of ${a.runs} runs (ms)`);
  console.log(['stage'.padEnd(10), ...a.modes.map((m) => m.padStart(9))].join(' '));
  for (const id of ids) console.log([id.padEnd(10), ...a.modes.map((m) => result[m][id].toFixed(1).padStart(9))].join(' '));
}

await main();
