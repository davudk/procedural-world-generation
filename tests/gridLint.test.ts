/**
 * Grid lint (research 10 §8, Phase 1): stage and algorithm code must not do its own square-raster
 * index arithmetic. Cells are addressed through the Grid (`off8`, `border`, `nbr`, `cellIndex`,
 * `cellX`/`cellY`, `forWindow`, …) so a cube-sphere grid can replace the flat map later; only
 * `src/gen/grid/` knows the row-major layout. Files that still do it are listed in ALLOW with the
 * number of offending lines; the list may only shrink.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const DIRS = ['stages', 'lem', 'hydro', 'climate', 'glacial', 'landforms', 'registry'].map((d) => join(ROOT, 'src/gen', d));

/** Side-length names used for square grids and lattices. */
const SIDE = String.raw`(?:n|m|w|cm|nb|nbk|M|gn|side|[A-Za-z_]+\.n)`;
const PATTERNS: [string, RegExp][] = [
  // y * n + x, (y + 1) * n + x, Math.floor(y) * n + …
  ['index', new RegExp(String.raw`[A-Za-z_\])]\s*\*\s*${SIDE}\s*\+\s*[\w(]`)],
  // i % n, Math.floor(i / n), (i - x) / n
  ['decode', new RegExp(String.raw`%\s*${SIDE}\b|Math\.floor\(\s*\w+\s*\/\s*${SIDE}\s*\)|\(\s*\w+\s*-\s*\w+\s*\)\s*\/\s*${SIDE}\b`)],
  // i - n, c + n ± 1 style neighbour offsets
  ['offset', new RegExp(String.raw`\b(?:i|c|j|k|p|q|r|s|cell|idx|row)\s*[+-]\s*${SIDE}\b(?!\s*[*/])`)],
  // x === 0 || y === n - 1, x < n - 1, nx >= n
  ['edge', new RegExp(String.raw`\b\w*[xy]\w*\s*(?:===|!==|<|>=|<=|>)\s*${SIDE}\s*-\s*1\b|\b\w*[xy]\s*>=\s*${SIDE}\b`)],
];

/** Allowed offending lines per file (relative to the repo root). May only shrink. */
const ALLOW: Record<string, number> = {
  // stages
  'src/gen/stages/plates.ts': 3,
  'src/gen/stages/stamps.ts': 1,
  // climate
  'src/gen/climate/fields.ts': 2,
  // landforms
  'src/gen/landforms/profiles.ts': 1,
  // registry
  'src/gen/registry/fill.ts': 2,
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Offending code lines of a file (comments stripped). */
export function offending(src: string): string[] {
  const out: string[] = [];
  for (const raw of src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).split('\n')) {
    const line = raw.replace(/\/\/.*$/, '');
    if (PATTERNS.some(([, re]) => re.test(line))) out.push(line.trim());
  }
  return out;
}

describe('grid lint', () => {
  const counts: Record<string, number> = {};
  for (const d of DIRS) for (const f of files(d)) counts[relative(ROOT, f)] = offending(readFileSync(f, 'utf8')).length;

  it('no file does more raster index arithmetic than its allowance', () => {
    const over: string[] = [];
    for (const [f, k] of Object.entries(counts)) if (k > (ALLOW[f] ?? 0)) over.push(`${f}: ${k} > ${ALLOW[f] ?? 0}`);
    expect(over).toEqual([]);
  });

  it('the allow-list is tight (shrink it when a file improves)', () => {
    const slack: string[] = [];
    for (const [f, k] of Object.entries(ALLOW)) if ((counts[f] ?? 0) < k) slack.push(`${f}: ${counts[f] ?? 0} < ${k}`);
    expect(slack).toEqual([]);
  });

  it('catches the patterns it is meant to catch', () => {
    const bad = [
      'const i = y * n + x;', 'const x = i % n;', 'const y = Math.floor(i / n);', 'h[i - n] + h[i + n]', 'if (x < n - 1) v = 1;',
      'if (nx >= n) continue;', 'const r = (y - 1) * n + x;',
    ];
    for (const b of bad) expect(offending(b), b).toHaveLength(1);
    const ok = ['const N = n * n;', 'for (let k = 0; k < n; k++) {}', 'const j = i + off8[k];', 'const m = n / f;', 'p[k - 1]', 'start[i + 1]', 'length: 2 * n + 1'];
    for (const o of ok) expect(offending(o), o).toHaveLength(0);
  });
});
