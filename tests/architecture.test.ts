import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

function imports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const statics = [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const dynamics = [...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  return [...statics, ...dynamics];
}

/** Top-level src/ area a resolved import lands in. */
function area(file: string, spec: string): string {
  if (!spec.startsWith('.')) return `pkg:${spec}`;
  return relative(SRC, resolve(dirname(file), spec)).split(/[\\/]/)[0];
}

describe('module boundaries (PLAN.md §11)', () => {
  it('gen/ imports only gen/, shared/ and packages', () => {
    for (const f of files(join(SRC, 'gen'))) {
      for (const spec of imports(f)) {
        const a = area(f, spec);
        if (a.startsWith('pkg:')) continue;
        expect(['gen', 'shared'], `${relative(SRC, f)} imports ${spec}`).toContain(a);
      }
    }
  });

  it('shared/ imports only shared/', () => {
    for (const f of files(join(SRC, 'shared'))) {
      for (const spec of imports(f)) expect(area(f, spec), `${relative(SRC, f)} imports ${spec}`).toBe('shared');
    }
  });

  it('render/, input/, ui/ never import gen/', () => {
    for (const dir of ['render', 'input', 'ui']) {
      for (const f of files(join(SRC, dir))) {
        for (const spec of imports(f)) expect(area(f, spec), `${relative(SRC, f)} imports ${spec}`).not.toBe('gen');
      }
    }
  });
});
