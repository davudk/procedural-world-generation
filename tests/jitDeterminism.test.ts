/**
 * Landmarks must not depend on the JIT (docs/notes/v8-maglev-shared-number-boxes.md). V8's Maglev
 * tier could hand objects rebuilt at the same deopt point shared number boxes, so a gulf candidate
 * took the position and size of the next bay; whether it happened depended on the isolate's tiering
 * history, never on a re-run in the same thread. The stress test re-runs the registry in fresh worker
 * isolates after the warm-up that exposed it (about 1 in 60 isolates diverged before the fix); the lint
 * keeps every registry record built through `candidate()` / `own()`.
 */
import { availableParallelism } from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_WORLDS, jitStress, prepare, registryHashes, type PreparedWorld } from '../metrics/jitStress';

const REGISTRY = resolve(__dirname, '../src/gen/registry');

describe('JIT determinism', () => {
  let earth11: PreparedWorld[];
  beforeAll(async () => {
    earth11 = await prepare([DEFAULT_WORLDS[2]]);
  }, 60_000);

  it('re-runs of the registry over one world in this thread give identical landmarks', async () => {
    const hashes = [];
    for (let k = 0; k < 4; k++) hashes.push((await registryHashes(earth11))[0]);
    expect(new Set(hashes).size).toBe(1);
  }, 60_000);

  it('fresh isolates give the same landmarks as this thread after the golden warm-up', async () => {
    const r = await jitStress({ runs: 32, workers: Math.max(2, Math.min(8, availableParallelism() - 1)) });
    expect(r.mismatches).toEqual([]);
  }, 120_000);

  it('registry records are built through candidate() / own()', () => {
    const bare: string[] = [];
    for (const f of readdirSync(REGISTRY)) {
      if (!f.endsWith('.ts') || f === 'candidate.ts' || f === 'types.ts') continue;
      const src = readFileSync(join(REGISTRY, f), 'utf8');
      // A candidate literal starts with its kind; it must be the argument of candidate().
      for (const m of src.matchAll(/\{\s*kind[:,]/g)) {
        if (!/candidate\($/.test(src.slice(0, m.index))) bare.push(`${f}: ${src.slice(m.index, m.index + 40).replace(/\s+/g, ' ')}`);
      }
      for (const m of src.matchAll(/\.hero = (?!own\()/g)) bare.push(`${f}: ${src.slice(m.index, m.index + 40)}`);
    }
    expect(bare).toEqual([]);
    expect(readFileSync(join(REGISTRY, 'rank.ts'), 'utf8')).toContain('landmarks.push(own(lm))');
  });
});
