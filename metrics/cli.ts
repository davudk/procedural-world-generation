/**
 * `npm run metrics [-- options]` — density / quality metrics over many seeds (PLAN.md §12, research 05 §5).
 *
 *   --seeds N              preview seeds per archetype (default 40)
 *   --seed-start N         first seed (default 1)
 *   --archetypes a,b       archetypes (default: all 10)
 *   --build-seeds N        build-mode seeds per build archetype (default 4; 0 = none)
 *   --build-archetypes a,b archetypes for the build subset (default earth,fjordland,desert)
 *   --size-seeds N         seeds per size in the size-invariance sweep (default 12; 0 = none)
 *   --sizes 512,1024,2048  world sizes for the sweep
 *   --size-mode M          preview (default) | build-const (build mode, grids pinned to 1 km cells; slow)
 *   --views L,U            land-weighted and uniform viewports per band (default 64,32)
 *   --workers N            worker threads (default: cores − 1; 0 = in-process)
 *   --out DIR              output directory (default metrics/out)
 *   --base URL             link prefix for seeds in the report (default http://localhost:5174/)
 */
import { DEFAULT_OPTIONS, runSuite, type SuiteOptions } from './runner';

function parse(argv: string[]): Partial<SuiteOptions> {
  const o: Partial<SuiteOptions> = {};
  const list = (v: string): string[] => v.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1] ?? '';
    const take = (): string => {
      i++;
      return v;
    };
    switch (a) {
      case '--seeds': o.seeds = Number(take()); break;
      case '--seed-start': o.seedStart = Number(take()); break;
      case '--archetypes': o.archetypes = list(take()); break;
      case '--build-seeds': o.buildSeeds = Number(take()); break;
      case '--build-archetypes': o.buildArchetypes = list(take()); break;
      case '--size-seeds': {
        const k = Number(take());
        o.sizeSeeds = k;
        if (k === 0) o.sizes = [];
        break;
      }
      case '--sizes': o.sizes = list(take()).map(Number); break;
      case '--size-mode': o.sizeMode = take() === 'build-const' ? 'build-const' : 'preview'; break;
      case '--views': {
        const [l, u] = list(take()).map(Number);
        o.views = { land: l, uniform: u ?? Math.round(l / 2) };
        break;
      }
      case '--workers': o.workers = Number(take()); break;
      case '--out': o.outDir = take(); break;
      case '--base': o.baseUrl = take(); break;
      case '--quiet': o.quiet = true; break;
      default:
        console.error(`unknown option ${a}`);
        process.exit(2);
    }
  }
  return o;
}

const opts = parse(process.argv.slice(2));
const merged = { ...DEFAULT_OPTIONS, ...opts };
console.log(`metrics: ${merged.archetypes.length} archetypes × ${merged.seeds} preview seeds, build ${merged.buildArchetypes.join('/')} × ${merged.buildSeeds}, sizes ${merged.sizes.join('/')} × ${merged.sizeSeeds}`);
const r = await runSuite(opts);
console.log(`done: ${r.meta.worlds} worlds in ${r.meta.seconds.toFixed(0)} s on ${r.meta.workers} workers → ${merged.outDir}/report.html`);
if (r.meta.failures.length) {
  console.error(`${r.meta.failures.length} failures:\n${r.meta.failures.join('\n')}`);
  process.exit(1);
}
