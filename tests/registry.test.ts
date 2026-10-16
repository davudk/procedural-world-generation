import { describe, expect, it } from 'vitest';
import { Pipeline, type StageOutput } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import { WATER, type HydroExtra } from '../src/gen/stages/hydro';
import { resolve } from '../src/shared/config/resolve';
import type { Resolved, WorldSpec } from '../src/shared/config/types';
import type { Landmark, LandmarkKind, WorldTraits } from '../src/shared/landmarks';
import type { GenMode } from '../src/shared/protocol';

interface World {
  resolved: Resolved;
  reg: StageOutput;
  landmarks: Landmark[];
  traits: WorldTraits;
  hydro: HydroExtra;
}

const cache = new Map<string, Promise<World>>();

function world(archetype: string, seed: number, mode: GenMode = 'preview', pins: WorldSpec['pins'] = {}): Promise<World> {
  const key = JSON.stringify([archetype, seed, mode, pins]);
  let w = cache.get(key);
  if (!w) {
    w = (async () => {
      const p = new Pipeline(STAGES);
      const resolved = resolve({ seed, archetype, pins });
      let error = '';
      await p.run(resolved, mode, 1, (m) => {
        if (m.type === 'error') error = m.message;
      }, () => false);
      if (error) throw new Error(error);
      const reg = p.output('registry')!;
      return { resolved, reg, landmarks: reg.vectors!.landmarks!, traits: reg.vectors!.traits!, hydro: p.output('hydro')!.extra as HydroExtra };
    })();
    cache.set(key, w);
  }
  return w;
}

const count = (w: World, k: LandmarkKind): number => w.landmarks.filter((l) => l.kind === k).length;

function cellOf(e: HydroExtra, x: number, y: number): number {
  const m = e.cellKm * 1000;
  return Math.min(e.n - 1, Math.max(0, Math.floor(y / m))) * e.n + Math.min(e.n - 1, Math.max(0, Math.floor(x / m)));
}

function distToPath(p: Float32Array, x: number, y: number): number {
  let best = Infinity;
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2];
    const ay = p[i - 1];
    const dx = p[i] - ax;
    const dy = p[i + 1] - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
  }
  return best;
}

const SEA_KINDS: LandmarkKind[] = ['ocean', 'sea', 'gulf', 'bay', 'strait'];
const LAND_KINDS: LandmarkKind[] = ['peak', 'volcano', 'range', 'continent', 'island', 'peninsula', 'cape', 'isthmus', 'plateau', 'desert', 'forest', 'plain'];

function checkInvariants(w: World): void {
  const { landmarks: lms, hydro, traits } = w;
  const worldM = (w.resolved.values.worldSize as number) * 1000;
  expect(lms.length).toBeGreaterThan(20);
  // Unique, non-empty names; ids are list indices.
  const names = new Set<string>();
  lms.forEach((l, i) => {
    expect(l.id).toBe(i);
    expect(l.name.trim().length, `${l.kind} without a name`).toBeGreaterThan(0);
    expect(names.has(l.name), `duplicate name ${l.name}`).toBe(false);
    names.add(l.name);
    expect(l.importance).toBeGreaterThanOrEqual(0);
    expect(l.importance).toBeLessThanOrEqual(1);
    expect(l.maxMpp).toBeGreaterThan(0);
    expect(l.extentM).toBeGreaterThan(0);
    expect(l.x).toBeGreaterThanOrEqual(0);
    expect(l.y).toBeGreaterThanOrEqual(0);
    expect(l.x).toBeLessThanOrEqual(worldM);
    expect(l.y).toBeLessThanOrEqual(worldM);
    if (!Number.isNaN(l.angle)) {
      expect(l.angle).toBeGreaterThan(-Math.PI / 2 - 1e-9);
      expect(l.angle).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
    }
  });
  // Anchors on the right terrain.
  for (const l of lms) {
    const sea = hydro.waterClass[cellOf(hydro, l.x, l.y)] === WATER.OCEAN;
    if (SEA_KINDS.includes(l.kind)) expect(sea, `${l.kind} ${l.name} anchored on land`).toBe(true);
    if (LAND_KINDS.includes(l.kind)) expect(sea, `${l.kind} ${l.name} anchored at sea`).toBe(false);
    if (l.kind === 'river' || l.kind === 'canyon' || l.kind === 'fjord') {
      expect(l.path, `${l.kind} ${l.name} has a path`).toBeDefined();
      expect(distToPath(l.path!, l.x, l.y), `${l.kind} ${l.name} anchor off its path`).toBeLessThan(hydro.cellKm * 1000 * 1.5);
    }
  }
  // Heroes: flagged, listed, a quarter of the world apart, legible at band W.
  const heroes = lms.filter((l) => l.hero);
  expect(heroes.map((h) => h.id).sort()).toEqual([...traits.heroes].sort());
  expect(heroes.length).toBeLessThanOrEqual(w.resolved.drawn.heroCount);
  for (let i = 0; i < heroes.length; i++) {
    expect(heroes[i].maxMpp).toBeGreaterThanOrEqual(640);
    for (let j = i + 1; j < heroes.length; j++) {
      expect(Math.hypot(heroes[i].x - heroes[j].x, heroes[i].y - heroes[j].y)).toBeGreaterThanOrEqual(worldM / 4 - 1);
    }
  }
  // World traits.
  expect(traits.headline.length).toBeGreaterThan(20);
  expect(traits.traits.length).toBeGreaterThanOrEqual(3);
  expect(traits.traits.length).toBeLessThanOrEqual(8);
}

describe('landmark registry (S11)', () => {
  it('Earth-like preview: sane counts per kind, invariants, all heroes', async () => {
    const w = await world('earth', 7);
    checkInvariants(w);
    expect(count(w, 'continent')).toBeGreaterThanOrEqual(1);
    expect(count(w, 'continent')).toBeLessThanOrEqual(4);
    expect(count(w, 'ocean') + count(w, 'sea')).toBeGreaterThanOrEqual(1);
    expect(count(w, 'range')).toBeGreaterThanOrEqual(1);
    expect(count(w, 'range')).toBeLessThanOrEqual(8);
    expect(count(w, 'river')).toBeGreaterThanOrEqual(1);
    expect(count(w, 'peak')).toBeGreaterThanOrEqual(5);
    expect(count(w, 'peak')).toBeLessThanOrEqual(80);
    expect(count(w, 'lake')).toBeGreaterThanOrEqual(1);
    expect(count(w, 'island')).toBeGreaterThanOrEqual(1);
    expect(count(w, 'waterfall')).toBeLessThanOrEqual(30);
    expect(count(w, 'canyon')).toBeLessThanOrEqual(4);
    // Exactly one world king, on the highest labelled summit.
    const kings = w.landmarks.filter((l) => l.data.worldKing);
    expect(kings.length).toBe(1);
    const maxPeak = Math.max(...w.landmarks.filter((l) => l.kind === 'peak' || l.kind === 'volcano').map((l) => l.data.heightM));
    expect(kings[0].data.heightM).toBe(maxPeak);
    // This world has enough candidates for every drawn hero.
    expect(w.landmarks.filter((l) => l.hero).length).toBe(w.resolved.drawn.heroCount);
    expect(w.reg.stats.ms).toBeGreaterThan(0);
  }, 120_000);

  it('Fjordland, Archipelago and Desert previews hold the invariants and their signature kinds', async () => {
    const fj = await world('fjordland', 7);
    checkInvariants(fj);
    expect(count(fj, 'fjord')).toBeGreaterThanOrEqual(3);
    const ar = await world('archipelago', 7);
    checkInvariants(ar);
    expect(count(ar, 'island')).toBeGreaterThanOrEqual(5);
    const de = await world('desert', 7);
    checkInvariants(de);
    expect(count(de, 'desert') + count(de, 'erg')).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('is deterministic', async () => {
    const a = await world('earth', 7);
    const p = new Pipeline(STAGES);
    await p.run(resolve({ seed: 7, archetype: 'earth', pins: {} }), 'preview', 1, () => {}, () => false);
    const b = p.output('registry')!.vectors!;
    expect(b.landmarks!.map((l) => `${l.kind}:${l.name}:${Math.round(l.x)}:${Math.round(l.y)}`)).toEqual(
      a.landmarks.map((l) => `${l.kind}:${l.name}:${Math.round(l.x)}:${Math.round(l.y)}`),
    );
    expect(b.traits).toEqual(a.traits);
  }, 120_000);

  it('keeps peak and range names when only humidity changes slightly', async () => {
    const a = await world('earth', 7);
    const b = await world('earth', 7, 'preview', { humidity: 1.05 });
    const key = (l: Landmark): string => `${l.kind}:${Math.round(l.x / 1000)}:${Math.round(l.y / 1000)}`;
    const nb = new Map(b.landmarks.filter((l) => l.kind === 'peak' || l.kind === 'range').map((l) => [key(l), l.name]));
    let same = 0;
    let matched = 0;
    for (const l of a.landmarks) {
      if (l.kind !== 'peak' && l.kind !== 'range') continue;
      const nm = nb.get(key(l));
      if (nm === undefined) continue;
      matched++;
      if (nm === l.name) same++;
    }
    expect(matched).toBeGreaterThan(20);
    expect(same / matched).toBeGreaterThanOrEqual(0.9);
  }, 120_000);

  it('runs on a 512² build', async () => {
    const w = await world('earth', 7, 'build', { worldSize: 512, lemGrid: '256', macroGrid: '512' });
    checkInvariants(w);
    expect(count(w, 'continent') + count(w, 'island')).toBeGreaterThanOrEqual(1);
    expect(count(w, 'peak')).toBeLessThanOrEqual(80);
  }, 300_000);
});
