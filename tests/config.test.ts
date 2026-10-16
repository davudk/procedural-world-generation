import { describe, expect, it } from 'vitest';
import { ARCHETYPES } from '../src/shared/config/archetypes';
import { dependencyOrder, pinAll, resolve, withPin } from '../src/shared/config/resolve';
import { PARAMS } from '../src/shared/config/schema';
import { isRangeParam, type Range, type WorldSpec } from '../src/shared/config/types';
import { queryToSpec, specToQuery } from '../src/shared/config/url';

const base: WorldSpec = { seed: 42, archetype: 'earth', pins: {} };
const at = (pins: WorldSpec['pins'], archetype = 'earth', seed = 42): ReturnType<typeof resolve> => resolve({ seed, archetype, pins });
const SIZES = [256, 512, 768, 1024, 1536, 2048, 3072, 4096];

describe('schema', () => {
  it('has unique ids and an acyclic dependency graph', () => {
    expect(new Set(PARAMS.map((p) => p.id)).size).toBe(PARAMS.length);
    expect(dependencyOrder().length).toBe(PARAMS.length);
  });

  it('AUTO formulas only read declared deps and stay within bounds for every archetype and size', () => {
    for (const a of ARCHETYPES) {
      for (const worldSize of SIZES) {
        for (const tectonicActivity of [0, 0.5, 1]) {
          for (const geologicAge of [0, 1]) {
            // resolve() throws if an AUTO formula reads an undeclared parent.
            const r = at({ worldSize, tectonicActivity, geologicAge }, a.id);
            for (const p of PARAMS) {
              const auto = r.autos[p.id];
              if (p.kind === 'number') {
                expect(auto as number, `${a.id} ${worldSize} ${p.id}`).toBeGreaterThanOrEqual(p.min - 1e-9);
                expect(auto as number, `${a.id} ${worldSize} ${p.id}`).toBeLessThanOrEqual(p.max + 1e-9);
              } else if (isRangeParam(p)) {
                const [lo, hi] = auto as Range;
                expect(Math.min(lo, hi), `${a.id} ${worldSize} ${p.id}`).toBeGreaterThanOrEqual(p.min);
                expect(Math.max(lo, hi), `${a.id} ${worldSize} ${p.id}`).toBeLessThanOrEqual(p.max);
                if (p.kind !== 'span') expect(lo, `${a.id} ${worldSize} ${p.id}`).toBeLessThanOrEqual(hi);
              } else if (p.kind === 'enum') {
                expect(p.options.map((o) => o.value)).toContain(auto);
              }
            }
          }
        }
      }
    }
  });
});

describe('hierarchy (CONFIG.md §3)', () => {
  it('matches the worked table at the size presets', () => {
    const t = (s: number) => at({ worldSize: s }).values;
    expect(t(1024).plateCount).toEqual([4, 6]);
    expect(t(4096).plateCount).toEqual([12, 18]);
    expect(t(1024).continentCount).toEqual([1, 3]);
    expect(t(1024).peakHeight).toEqual([2500, 5000]);
    expect(t(1024).rangeLength).toEqual([250, 550]);
    expect(t(1024).mountainRangeCount).toEqual([1, 3]);
    expect(t(1024).heroCount).toEqual([3, 5]);
  });

  it('bigger worlds get more and larger structures (monotone in world size)', () => {
    const mono = ['plateCount', 'continentCount', 'rangeLength', 'rangeWidth', 'meanPlateDiameter', 'heroCount', 'hotspotCount', 'craterCount'];
    for (const a of ARCHETYPES) {
      let prev = at({ worldSize: SIZES[0] }, a.id).values;
      for (const s of SIZES.slice(1)) {
        const cur = at({ worldSize: s }, a.id).values;
        for (const id of mono) {
          const p = prev[id];
          const c = cur[id];
          if (Array.isArray(p) && Array.isArray(c)) {
            expect(c[0], `${a.id} ${id} @${s}`).toBeGreaterThanOrEqual(p[0]);
            expect(c[1], `${a.id} ${id} @${s}`).toBeGreaterThanOrEqual(p[1]);
          } else {
            expect(c as number, `${a.id} ${id} @${s}`).toBeGreaterThanOrEqual(p as number);
          }
        }
        prev = cur;
      }
    }
  });

  it('AUTO children derive from a pinned parent', () => {
    const few = at({ plateCount: [3, 3] }).values;
    const many = at({ plateCount: [20, 20] }).values;
    expect(few.meanPlateDiameter as number).toBeGreaterThan(many.meanPlateDiameter as number);
    expect((few.rangeLength as Range)[1]).toBeGreaterThan((many.rangeLength as Range)[1]);
  });
});

describe('pins', () => {
  it('a pin wins over AUTO and is reported as SET; archetype pins are PRESET', () => {
    const r = at({ landFraction: 0.2 });
    expect(r.values.landFraction).toBe(0.2);
    expect(r.sources.landFraction).toBe('set');
    expect(r.sources.worldSize).toBe('auto');
    const p = at({}, 'pangaea');
    expect(p.values.continentCount).toEqual([1, 1]);
    expect(p.sources.continentCount).toEqual(['preset', 'preset']);
  });

  it('pinning one thumb keeps the other on AUTO, and the AUTO thumb yields to the pin', () => {
    const r = at({ plateCount: [null, 8] });
    expect(r.values.plateCount).toEqual([4, 8]);
    expect(r.sources.plateCount).toEqual(['auto', 'set']);
    const crossed = at({ plateCount: [9, null] });
    expect(crossed.values.plateCount).toEqual([9, 9]);
  });

  it('pins are clamped to bounds', () => {
    expect(at({ worldSize: 99999 }).values.worldSize).toBe(4096);
    expect(at({ plateCount: [0, 1000] }).values.plateCount).toEqual([2, 40]);
  });

  it('readonly parameters ignore pins', () => {
    const r = at({ meanPlateDiameter: 5 });
    expect(r.values.meanPlateDiameter).not.toBe(5);
  });

  it('withPin(undefined) returns to AUTO, pinAll freezes every value', () => {
    const s = withPin(withPin(base, 'humidity', 2), 'humidity', undefined);
    expect(s.pins).toEqual({});
    const frozen = pinAll(base);
    expect(resolve(frozen).values).toEqual(resolve(base).values);
  });
});

describe('draws', () => {
  it('are deterministic per seed, inside the range, and independent of other params', () => {
    const a = at({});
    const b = at({});
    expect(a.drawn).toEqual(b.drawn);
    for (const [id, v] of Object.entries(a.drawn)) {
      const [lo, hi] = a.values[id] as Range;
      expect(v).toBeGreaterThanOrEqual(lo);
      expect(v).toBeLessThanOrEqual(hi);
    }
    // Changing an unrelated parameter must not re-roll the plate count.
    expect(at({ humidity: 2 }).drawn.plateCount).toBe(a.drawn.plateCount);
    const seen = new Set(Array.from({ length: 40 }, (_, s) => at({}, 'earth', s).drawn.plateCount));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('warnings', () => {
  it('explains implausible pins instead of rejecting them', () => {
    const r = at({ worldSize: 512, landFraction: 0.05, continentCount: [8, 8] });
    expect(r.values.continentCount).toEqual([8, 8]);
    expect(r.warnings.some((w) => w.ids.includes('continentCount'))).toBe(true);
    expect(at({}).warnings).toEqual([]);
  });
});

describe('URL codec', () => {
  it('round-trips seed, archetype and pins (including half-pinned ranges)', () => {
    const spec: WorldSpec = {
      seed: 1234,
      archetype: 'fjordland',
      pins: { worldSize: 2048, plateCount: [null, 9], latitudeSpan: [70, 30], fjords: false, quality: 'high' },
    };
    expect(queryToSpec(specToQuery(spec), 0)).toEqual(spec);
  });

  it('ignores unknown or malformed keys and readonly params', () => {
    const s = queryToSpec('seed=7&bogus=1&plateCount=abc&meanPlateDiameter=4&humidity=1.5', 0);
    expect(s).toEqual({ seed: 7, archetype: 'earth', pins: { humidity: 1.5 } });
  });
});

describe('archetype presets and AUTO overrides', () => {
  it('merges a user range pin with an archetype range pin per thumb', () => {
    const r = at({ continentCount: [null, 3] }, 'pangaea');
    expect(r.values.continentCount).toEqual([1, 3]);
    expect(r.sources.continentCount).toEqual(['preset', 'set']);
  });

  it('AUTO_PIN returns a preset parameter to AUTO and round-trips through the URL', () => {
    const r = at({ continentCount: '@auto', fjords: '@auto' }, 'pangaea');
    expect(r.sources.continentCount).toEqual(['auto', 'auto']);
    expect(r.values.continentCount).toEqual(r.autos.continentCount);
    const spec: WorldSpec = { seed: 3, archetype: 'fjordland', pins: { fjords: '@auto' } };
    expect(queryToSpec(specToQuery(spec), 0)).toEqual(spec);
  });

  it('snaps values to the step grid', () => {
    expect(at({ humidity: 1.2345 }).values.humidity).toBe(1.25);
    expect(at({ landFraction: 0.333333 }).values.landFraction).toBe(0.33);
  });
});
