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
    expect(ran(await run(p, spec()))).toEqual(['plates', 'base']);
    expect(ran(await run(p, spec()))).toEqual([]);
    // continentalShare is read by plates, so both stages re-run; coastRoughness only by base.
    expect(ran(await run(p, spec({ continentalShare: 0.6 })))).toEqual(['plates', 'base']);
    expect(ran(await run(p, spec({ continentalShare: 0.6, coastRoughness: 1.4 })))).toEqual(['base']);
    // A parameter no stage reads yet regenerates nothing.
    expect(ran(await run(p, spec({ continentalShare: 0.6, coastRoughness: 1.4, humidity: 2 })))).toEqual([]);
  });

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
      const base = events.find((e) => e.type === 'stage-done' && e.stage === 'base');
      if (base?.type !== 'stage-done') throw new Error('no base stage');
      expect(Math.abs(base.stats.landFraction - landFraction)).toBeLessThan(0.02);
      expect(base.outcomes.continentCount).toBeGreaterThanOrEqual(1);
    }
  });
});
