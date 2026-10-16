import { describe, expect, it } from 'vitest';
import { Pipeline, type StageOutput } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import type { GlacialExtra } from '../src/gen/stages/glacial';
import type { ErodedExtra } from '../src/gen/stages/lem';
import { resolve } from '../src/shared/config/resolve';
import { hashBytes } from '../src/shared/hash';
import type { GenMode } from '../src/shared/protocol';

interface Run {
  glacial: StageOutput;
  g: GlacialExtra;
  input: ErodedExtra;
}

/** Runs the pipeline up to the glacial stage (or all stages with `full`). */
async function run(seed: number, archetype: string, opts: { mode?: GenMode; full?: boolean } = {}): Promise<Run> {
  const p = new Pipeline(opts.full ? STAGES : STAGES.slice(0, STAGES.findIndex((s) => s.id === 'glacial') + 1));
  let error = '';
  await p.run(resolve({ seed, archetype, pins: {} }), opts.mode ?? 'preview', 1, (m) => {
    if (m.type === 'error') error = m.message;
  }, () => false);
  if (error) throw new Error(error);
  const glacial = p.output('glacial')!;
  return { glacial, g: glacial.extra as GlacialExtra, input: p.output('refine')!.extra as ErodedExtra };
}

/**
 * Ocean mask stays consistent: sea never turns to land, cells only join the sea at h ≤ 0, land stays
 * above 0 m, and new sea is 4-connected to the old sea. (Fixed cells above 0 m are open map edges.)
 */
function checkSea({ g, input }: Run): void {
  const { n, h, fixed } = g;
  const N = n * n;
  let bad = 0;
  for (let i = 0; i < N; i++) {
    if (input.fixed[i] && !fixed[i]) bad++;
    if (!input.fixed[i] && fixed[i] && h[i] > 0) bad++;
    if (!fixed[i] && h[i] <= 0) bad++;
  }
  expect(bad, 'cells with an inconsistent ocean mask').toBe(0);

  const seen = new Uint8Array(N);
  const stack: number[] = [];
  for (let i = 0; i < N; i++) {
    if (input.fixed[i]) {
      seen[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length) {
    const c = stack.pop()!;
    const x = c % n;
    for (const j of [x > 0 ? c - 1 : -1, x < n - 1 ? c + 1 : -1, c - n, c + n]) {
      if (j < 0 || j >= N || seen[j] || !fixed[j]) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  let orphans = 0;
  for (let i = 0; i < N; i++) if (fixed[i] && !seen[i]) orphans++;
  expect(orphans, 'new sea cells not connected to the old sea').toBe(0);
}

/** Largest rise of the terrain over the input (carving and repair only lower). */
function maxRise({ g, input }: Run): number {
  let rise = 0;
  for (let i = 0; i < g.h.length; i++) rise = Math.max(rise, g.h[i] - input.h[i]);
  return rise;
}

describe('glacial stage', () => {
  it('Fjordland carves fjords below −200 m inside former valleys on most seeds', async () => {
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    let withFjords = 0;
    const rows: string[] = [];
    for (const seed of seeds) {
      const r = await run(seed, 'fjordland');
      checkSea(r);
      expect(maxRise(r)).toBeLessThanOrEqual(1e-3);
      const s = r.glacial.stats;
      let deepFormerLand = 0;
      for (let i = 0; i < r.g.h.length; i++) if (!r.input.fixed[i] && r.g.fixed[i] && r.g.h[i] < -200) deepFormerLand++;
      if (s.fjords > 0) {
        withFjords++;
        expect(deepFormerLand, `seed ${seed}: deep sea cells in former valleys`).toBeGreaterThan(0);
        expect(s.maxFjordDepthM).toBeGreaterThanOrEqual(200);
        expect(s.maxFjordDepthM).toBeLessThanOrEqual(1300);
      }
      rows.push(`seed ${seed}: fjords ${s.fjords}, coast ${s.fjordCoastKm} km, deep cells ${deepFormerLand}, ice ${s.iceShare.toFixed(3)}`);
    }
    console.log(`Fjordland fjord rate ${withFjords}/${seeds.length}\n${rows.join('\n')}`);
    expect(withFjords).toBeGreaterThanOrEqual(6);
  }, 120_000);

  it('Ice age has more ice than Earth-like', async () => {
    for (const seed of [7, 11]) {
      const earth = await run(seed, 'earth');
      const ice = await run(seed, 'iceage');
      expect(ice.glacial.stats.iceShare).toBeGreaterThan(earth.glacial.stats.iceShare);
      expect(ice.glacial.stats.iceShare).toBeGreaterThan(0.05);
      for (const r of [earth, ice]) {
        checkSea(r);
        expect(maxRise(r)).toBeLessThanOrEqual(1e-3);
        for (const v of r.g.ice) expect(v >= 0 && v <= 1).toBe(true);
      }
    }
  }, 60_000);

  it('Desert world has ~no ice and leaves the terrain nearly unchanged', async () => {
    const r = await run(7, 'desert');
    expect(r.glacial.stats.iceShare).toBeLessThan(0.001);
    let maxDiff = 0;
    for (let i = 0; i < r.g.h.length; i++) maxDiff = Math.max(maxDiff, Math.abs(r.g.h[i] - r.input.h[i]));
    expect(maxDiff).toBeLessThan(1);
    checkSea(r);
  }, 30_000);

  it('is deterministic', async () => {
    const hashes = async (): Promise<number[]> => {
      const { g } = await run(7, 'fjordland');
      return [hashBytes(g.h), hashBytes(g.fixed), hashBytes(g.ice), hashBytes(g.area), hashBytes(g.rcv), hashBytes(g.fjord)];
    };
    expect(await hashes()).toEqual(await hashes());
  }, 30_000);

  it('runs the downstream stages on a fjord world', async () => {
    const r = await run(7, 'fjordland', { full: true });
    expect(r.glacial.layers.map((l) => l.id)).toEqual(['ice', 'glacialCarve']);
    expect(r.glacial.stats.fjords).toBeGreaterThan(0);
  }, 30_000);
});
