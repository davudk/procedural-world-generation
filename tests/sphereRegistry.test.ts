/**
 * The landmark registry on the sphere (research 10 §5.11, §8 Phase 4): every landmark has a valid
 * (face, u, v) anchor and path, land and sea kinds sit on land and sea, the world ocean is partitioned
 * by the ocean landmarks, names are unique, and the registry is deterministic (in this thread and in
 * fresh isolates, the V8 Maglev pattern of tests/jitDeterminism.test.ts).
 */
import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import { jitStress, prepare, registryHashes, type StressWorld } from '../metrics/jitStress';
import { cubeGrid, type CubeGrid } from '../src/gen/grid/cube';
import { Pipeline } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import { WATER, type HydroExtra } from '../src/gen/stages/hydro';
import type { RegistryExtra } from '../src/gen/stages/registry';
import { resolve } from '../src/shared/config/resolve';
import { SPHERE_STAGES } from '../src/shared/config/types';
import { surfaceDir } from '../src/shared/cube';
import { hashValue } from '../src/shared/hash';
import type { Landmark, LandmarkKind, WorldTraits } from '../src/shared/landmarks';

interface World {
  grid: CubeGrid;
  hydro: HydroExtra;
  landmarks: Landmark[];
  traits: WorldTraits;
  extra: RegistryExtra;
  stats: Record<string, number>;
  stages: string[];
}

const cache = new Map<number, Promise<World>>();

function sphereWorld(seed: number): Promise<World> {
  let w = cache.get(seed);
  if (!w) {
    w = (async () => {
      const p = new Pipeline(STAGES);
      const r = resolve({ seed, archetype: 'earth', pins: { worldShape: 'sphere' } });
      let err = '';
      const stages: string[] = [];
      await p.run(r, 'preview', 1, (m) => {
        if (m.type === 'error') err = m.message;
        if (m.type === 'stage-done') stages.push(m.stage);
      }, () => false);
      if (err) throw new Error(err);
      const hydro = p.output('hydro')!.extra as HydroExtra;
      const reg = p.output('registry')!;
      const radiusM = ((r.values.planetSize as number) * 1000) / (2 * Math.PI);
      return {
        grid: cubeGrid(hydro.n, radiusM), hydro, landmarks: reg.vectors!.landmarks!, traits: reg.vectors!.traits!,
        extra: reg.extra as RegistryExtra, stats: reg.stats, stages,
      };
    })();
    cache.set(seed, w);
  }
  return w;
}

const SEA: LandmarkKind[] = ['ocean', 'sea', 'gulf', 'bay', 'strait'];
const LAND: LandmarkKind[] = ['continent', 'island', 'peninsula', 'cape', 'isthmus', 'peak', 'volcano', 'range', 'plateau', 'desert', 'forest', 'plain', 'hill', 'pass'];
const PATHS: LandmarkKind[] = ['river', 'range', 'fjord', 'canyon', 'gorge', 'rift'];

/** Macro cell of a face-local position. */
function cellAt(g: CubeGrid, face: number, u: number, v: number): number {
  return g.locate({ face, u, v });
}

describe('registry on the sphere', () => {
  it('runs as the last of 11 sphere stages', async () => {
    const w = await sphereWorld(7);
    expect(SPHERE_STAGES).toHaveLength(11);
    expect(w.stages).toEqual([...SPHERE_STAGES]);
    expect(w.landmarks.length).toBeGreaterThan(100);
  }, 60_000);

  for (const seed of [7, 11, 42]) {
    it(`gives every landmark a valid face position on seed ${seed}`, async () => {
      const w = await sphereWorld(seed);
      const g = w.grid;
      const W = g.n * g.cellM;
      const R = g.radiusM;
      const a = new Float64Array(3);
      const b = new Float64Array(3);
      const kinds = new Set<LandmarkKind>();
      for (const l of w.landmarks) {
        kinds.add(l.kind);
        expect(Number.isInteger(l.face), `${l.kind} ${l.name} has no face`).toBe(true);
        expect(l.face!).toBeGreaterThanOrEqual(0);
        expect(l.face!).toBeLessThan(6);
        for (const v of [l.x, l.y]) {
          expect(v, `${l.kind} ${l.name}`).toBeGreaterThanOrEqual(0);
          expect(v, `${l.kind} ${l.name}`).toBeLessThanOrEqual(W);
        }
        expect(Number.isFinite(l.angle) || Number.isNaN(l.angle)).toBe(true);
        if (Number.isFinite(l.angle)) expect(Math.abs(l.angle)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
        // Kinds that describe land or sea sit on it.
        const c = cellAt(g, l.face!, l.x, l.y);
        const sea = w.hydro.waterClass[c] === WATER.OCEAN;
        if (SEA.includes(l.kind)) expect(sea, `${l.kind} ${l.name} on land`).toBe(true);
        if (LAND.includes(l.kind)) expect(sea, `${l.kind} ${l.name} at sea`).toBe(false);
        if (!l.path) {
          expect(l.pathFace).toBeUndefined();
          continue;
        }
        expect(PATHS).toContain(l.kind);
        expect(l.pathFace, `${l.kind} ${l.name} path without faces`).toBeDefined();
        expect(l.pathFace!.length * 2).toBe(l.path.length);
        // Consecutive points are close on the sphere (no jumps from a wrong face).
        for (let i = 0; i < l.pathFace!.length; i++) {
          expect(l.pathFace![i]).toBeLessThan(6);
          expect(l.path[2 * i]).toBeGreaterThanOrEqual(-1);
          expect(l.path[2 * i]).toBeLessThanOrEqual(W + 1);
          expect(l.path[2 * i + 1]).toBeGreaterThanOrEqual(-1);
          expect(l.path[2 * i + 1]).toBeLessThanOrEqual(W + 1);
          if (i === 0) continue;
          surfaceDir(l.pathFace![i - 1], l.path[2 * i - 2], l.path[2 * i - 1], R, a);
          surfaceDir(l.pathFace![i], l.path[2 * i], l.path[2 * i + 1], R, b);
          const d = R * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          expect(d, `${l.kind} ${l.name} step ${i}`).toBeLessThan(Math.max(250e3, 0.25 * l.extentM));
        }
      }
      for (const k of ['ocean', 'continent', 'island', 'peak', 'range', 'river', 'lake'] as LandmarkKind[]) expect(kinds.has(k), k).toBe(true);
    }, 60_000);

    it(`partitions the world ocean into the ocean landmarks on seed ${seed}`, async () => {
      const w = await sphereWorld(seed);
      const { oceans, oceanGrid: R } = w.extra;
      const lms = w.landmarks.filter((l) => l.kind === 'ocean');
      expect(lms.length).toBe(oceans.peaks.length);
      expect(lms.length).toBeGreaterThanOrEqual(1);
      expect(w.stats.oceans).toBe(lms.length);
      const n = oceans.peaks.length;
      // Every world-ocean cell belongs to exactly one ocean; areas add up.
      const area = new Float64Array(n);
      for (let i = 0; i < R.cells; i++) {
        const o = oceans.of[i];
        expect(o).toBeGreaterThanOrEqual(-1);
        expect(o).toBeLessThan(n);
        if (o >= 0) area[o] += R.area(i) / 1e6;
      }
      let sum = 0;
      for (let o = 0; o < n; o++) {
        expect(area[o]).toBeGreaterThan(0);
        expect(area[o]).toBeCloseTo(oceans.areaKm2[o], 3);
        sum += area[o];
      }
      expect(sum / oceans.worldKm2).toBeCloseTo(1, 9);
      // The world ocean is one connected body (4-neighbours across seams), each ocean's anchor lies in it,
      // and the anchors fall in distinct oceans.
      const seen = new Uint8Array(R.cells);
      const start = oceans.of.findIndex((o) => o >= 0);
      const queue = [start];
      seen[start] = 1;
      for (let h = 0; h < queue.length; h++) {
        for (const k of [1, 3, 4, 6]) {
          const j = R.nbr(queue[h], k);
          if (j >= 0 && !seen[j] && oceans.of[j] >= 0) {
            seen[j] = 1;
            queue.push(j);
          }
        }
      }
      let cells = 0;
      for (let i = 0; i < R.cells; i++) if (oceans.of[i] >= 0) cells++;
      expect(queue.length).toBe(cells);
      const hit = new Set<number>();
      for (const l of lms) {
        const o = oceans.of[R.locate({ face: l.face!, u: l.x, v: l.y })];
        expect(o, l.name).toBeGreaterThanOrEqual(0);
        hit.add(o);
      }
      expect(hit.size).toBe(n);
      expect(w.traits.traits.some((t) => t.startsWith('Planet:'))).toBe(true);
    }, 60_000);

    it(`names every landmark uniquely on seed ${seed}`, async () => {
      const w = await sphereWorld(seed);
      const names = new Set<string>();
      w.landmarks.forEach((l, i) => {
        expect(l.id).toBe(i);
        expect(l.name.trim().length).toBeGreaterThan(0);
        expect(names.has(l.name), `duplicate ${l.name}`).toBe(false);
        names.add(l.name);
      });
      // Heroes are spaced a quarter of the equal-area size apart along the surface (or a fifth / seventh when short).
      const heroes = w.landmarks.filter((l) => l.hero);
      expect(heroes.length).toBeGreaterThan(0);
      const S = Math.sqrt(w.grid.totalArea);
      const a = new Float64Array(3);
      const b = new Float64Array(3);
      for (let i = 0; i < heroes.length; i++) {
        for (let j = i + 1; j < heroes.length; j++) {
          surfaceDir(heroes[i].face!, heroes[i].x, heroes[i].y, w.grid.radiusM, a);
          surfaceDir(heroes[j].face!, heroes[j].x, heroes[j].y, w.grid.radiusM, b);
          const d = w.grid.radiusM * Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
          expect(d).toBeGreaterThanOrEqual(S / 7 - 1);
        }
      }
    }, 60_000);
  }

  it('is deterministic, in this thread and in fresh isolates', async () => {
    const world: StressWorld = { archetype: 'earth', seed: 11, mode: 'preview', pins: { worldShape: 'sphere' } };
    const prepared = await prepare([world]);
    const h = [];
    for (let k = 0; k < 3; k++) h.push((await registryHashes(prepared))[0]);
    expect(new Set(h).size).toBe(1);
    expect(h[0]).toBe(hashValue((await sphereWorld(11)).landmarks));
    const r = await jitStress({ runs: 6, workers: Math.max(2, Math.min(6, availableParallelism() - 1)), worlds: [world] });
    expect(r.mismatches).toEqual([]);
  }, 180_000);
});
