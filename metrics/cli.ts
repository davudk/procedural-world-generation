/**
 * `npm run metrics [-- options]` — density / quality metrics over many seeds (PLAN.md §12, research 05 §5).
 *
 *   --shape S              flat (default) | sphere: the preview and build suites run on that shape
 *   --seeds N              preview seeds per archetype (default 40; 20 with --shape sphere)
 *   --seed-start N         first seed (default 1)
 *   --archetypes a,b       archetypes (default: all 10)
 *   --build-seeds N        build-mode seeds per build archetype (default 4; 0 = none)
 *   --build-archetypes a,b archetypes for the build subset (default earth,fjordland,desert)
 *   --size-seeds N         seeds per size in the size-invariance sweep (default 12; 0 = none)
 *   --sizes 512,1024,2048  world sizes for the sweep
 *   --planet-sizes 2048,…  sphere sweep circumferences (default 2048,4096,8192,12000; vs 4,096 km)
 *   --equal-area 0|1       sphere sweep: also run equal-area flat worlds (default 1)
 *   --size-mode M          preview (default) | build-const (build mode, grids pinned to 1 km cells; slow)
 *   --views L,U            land-weighted and uniform viewports per band (default 64,32)
 *   --workers N            worker threads (default: cores − 1; 0 = in-process)
 *   --out DIR              output directory (default metrics/out)
 *   --pins k=v,k=a:b       pin parameters in every world (numbers, ranges a:b, true/false, strings)
 *   --base URL             link prefix for seeds in the report (default http://localhost:5174/)
 */
import type { Pin } from '../src/shared/config/types';
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
      case '--shape': o.shape = take() === 'sphere' ? 'sphere' : 'flat'; break;
      case '--seeds': o.seeds = Number(take()); break;
      case '--planet-sizes': o.planetSizes = list(take()).map(Number); break;
      case '--equal-area': o.equalArea = take() !== '0'; break;
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
      case '--pins': {
        const pins: Record<string, Pin> = {};
        for (const kv of list(take())) {
          const [k, v] = kv.split('=');
          const num = (x: string): number | null => (x === '' ? null : Number(x));
          pins[k] = v.includes(':') ? [num(v.split(':')[0]), num(v.split(':')[1])] : v === 'true' || v === 'false' ? v === 'true' : Number.isFinite(Number(v)) ? Number(v) : v;
        }
        o.pins = pins;
        break;
      }
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
if (opts.shape === 'sphere' && opts.seeds === undefined) opts.seeds = 20;
const merged = { ...DEFAULT_OPTIONS, ...opts };
const sweep = merged.shape === 'sphere' ? `planets ${merged.planetSizes.join('/')}${merged.equalArea ? ' + equal-area flat' : ''}` : `sizes ${merged.sizes.join('/')}`;
console.log(`metrics (${merged.shape}): ${merged.archetypes.length} archetypes × ${merged.seeds} preview seeds, build ${merged.buildArchetypes.join('/')} × ${merged.buildSeeds}, ${sweep} × ${merged.sizeSeeds}`);
const r = await runSuite(opts);
console.log(`done: ${r.meta.worlds} worlds in ${r.meta.seconds.toFixed(0)} s on ${r.meta.workers} workers → ${merged.outDir}/report.html`);
if (r.meta.failures.length) {
  console.error(`${r.meta.failures.length} failures:\n${r.meta.failures.join('\n')}`);
  process.exit(1);
}
