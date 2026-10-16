import { describe, expect, it } from 'vitest';
import { Pipeline, type StageDef } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import { resolve } from '../src/shared/config/resolve';
import type { WorldSpec } from '../src/shared/config/types';
import { hashBytes } from '../src/shared/hash';
import type { FromWorker } from '../src/shared/protocol';

const spec = (pins: WorldSpec['pins'] = {}, seed = 7): WorldSpec => ({ seed, archetype: 'earth', pins });

async function run(p: Pipeline, s: WorldSpec): Promise<FromWorker[]> {
  const events: FromWorker[] = [];
  await p.run(resolve(s), 'preview', 1, (m) => events.push(m), () => false);
  const err = events.find((e) => e.type === 'error');
  if (err && err.type === 'error') throw new Error(err.message);
  return events;
}

const ran = (events: FromWorker[]): string[] =>
  events.flatMap((e) => (e.type === 'stage-done' && !e.cached ? [e.stage] : []));

describe('pipeline caching', () => {
  it('re-runs only stages whose read parameters or inputs changed', async () => {
    const p = new Pipeline(STAGES);
    const ALL = ['plates', 'base', 'stamps', 'lem', 'refine', 'climate', 'glacial', 'landforms', 'hydro', 'biome', 'registry'];
    expect(ran(await run(p, spec()))).toEqual(ALL);
    expect(ran(await run(p, spec()))).toEqual([]);
    // continentalShare is read by plates, so both stages re-run; coastRoughness only by base.
    expect(ran(await run(p, spec({ continentalShare: 0.6 })))).toEqual(ALL);
    expect(ran(await run(p, spec({ continentalShare: 0.6, coastRoughness: 1.4 })))).toEqual(ALL.slice(1));
    // Sea-level rise starts at refine.
    expect(ran(await run(p, spec({ continentalShare: 0.6, coastRoughness: 1.4, seaLevelRise: 50 })))).toEqual(['refine', 'climate', 'glacial', 'landforms', 'hydro', 'biome', 'registry']);
    // Humidity only reaches climate and what depends on it.
    expect(ran(await run(p, spec({ continentalShare: 0.6, coastRoughness: 1.4, seaLevelRise: 50, humidity: 2 })))).toEqual(['climate', 'glacial', 'landforms', 'hydro', 'biome', 'registry']);
    // Hero count only affects the landmark registry.
    expect(ran(await run(p, spec({ continentalShare: 0.6, coastRoughness: 1.4, seaLevelRise: 50, humidity: 2, heroCount: [4, 4] })))).toEqual(['registry']);
    }, 60_000);

  it('rejects undeclared parameter reads and out-of-order inputs', async () => {
    const bad: StageDef = { id: 'plates', label: 'x', inputs: [], reads: [], run: (c) => ({ layers: [], stats: { v: c.num('humidity') }, outcomes: {} }) };
    const out: FromWorker[] = [];
    await new Pipeline([bad]).run(resolve(spec()), 'preview', 1, (m) => out.push(m), () => false);
    expect(out.some((e) => e.type === 'error' && e.message.includes('undeclared parameter humidity'))).toBe(true);
    expect(() => new Pipeline([{ ...bad, id: 'base', inputs: ['plates'] }])).toThrow();
  });

  it('stops at the next checkpoint when a newer request arrives', async () => {
    const out: FromWorker[] = [];
    await new Pipeline(STAGES).run(resolve(spec()), 'preview', 1, (m) => out.push(m), () => true);
    expect(out.at(-1)?.type).toBe('cancelled');
  });
});

describe('determinism', () => {
  const hashes = async (s: WorldSpec): Promise<Record<string, number>> => {
    const p = new Pipeline(STAGES);
    const events = await run(p, s);
    const h: Record<string, number> = {};
    for (const e of events) if (e.type === 'stage-done') for (const l of e.layers) h[l.id] = hashBytes(l.data);
    return h;
  };

  it('same seed and config give identical layers; another seed differs', async () => {
    const a = await hashes(spec());
    expect(await hashes(spec())).toEqual(a);
    expect((await hashes(spec({}, 8))).elevation).not.toBe(a.elevation);
  });

  it('realises the land fraction within ±2 %', async () => {
    for (const landFraction of [0.15, 0.4, 0.65]) {
      const p = new Pipeline(STAGES);
      const events = await run(p, spec({ landFraction }));
      const base = events.find((e) => e.type === 'stage-done' && e.stage === 'refine');
      if (base?.type !== 'stage-done') throw new Error('no refine stage');
      expect(Math.abs(base.stats.landFraction - landFraction)).toBeLessThan(0.02);
      expect(base.outcomes.continentCount).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('M1 tectonics and erosion', () => {
  it('meets the continent and mountain-range targets in most worlds', async () => {
    let continentsMet = 0;
    let rangesMet = 0;
    const seeds = 8;
    for (let seed = 1; seed <= seeds; seed++) {
      const r = resolve(spec({}, seed));
      const out: Record<string, number> = {};
      await new Pipeline(STAGES).run(r, 'preview', 1, (m) => {
        if (m.type === 'stage-done') Object.assign(out, m.outcomes);
      }, () => false);
      if (out.continentCount === r.drawn.continentCount) continentsMet++;
      if (Math.abs(out.mountainRangeCount - r.drawn.mountainRangeCount) <= 1) rangesMet++;
    }
    expect(continentsMet / seeds).toBeGreaterThanOrEqual(0.75);
    expect(rangesMet / seeds).toBeGreaterThanOrEqual(0.75);
  }, 60_000);

  it('erodes mountains toward the requested peak heights', async () => {
    const events = await run(new Pipeline(STAGES), spec({ peakHeight: [3000, 4000] }, 3));
    const refine = events.find((e) => e.type === 'stage-done' && e.stage === 'refine');
    if (refine?.type !== 'stage-done') throw new Error('no refine stage');
    expect(refine.stats.highestPeakM).toBeGreaterThan(2000);
    expect(refine.stats.highestPeakM).toBeLessThan(7000);
  }, 30_000);
});
