import { describe, expect, it } from 'vitest';
import { Pipeline } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import type { GlacialExtra } from '../src/gen/stages/glacial';
import type { LandformsExtra } from '../src/gen/stages/landforms';
import { resolve } from '../src/shared/config/resolve';
import type { WorldSpec } from '../src/shared/config/types';
import { hashBytes } from '../src/shared/hash';
import type { GenMode } from '../src/shared/protocol';

interface World {
  before: GlacialExtra;
  after: LandformsExtra;
  stats: Record<string, number>;
}

const cache = new Map<string, Promise<World>>();

/** Runs the real pipeline up to landforms (the coastal pass runs last there). */
function world(archetype: string, seed: number, mode: GenMode = 'preview', pins: WorldSpec['pins'] = {}): Promise<World> {
  const key = JSON.stringify([archetype, seed, mode, pins]);
  let w = cache.get(key);
  if (!w) {
    w = (async () => {
      const stages = STAGES.slice(0, STAGES.findIndex((s) => s.id === 'landforms') + 1);
      const p = new Pipeline(stages);
      let error = '';
      await p.run(resolve({ seed, archetype, pins }), mode, 1, (m) => {
        if (m.type === 'error') error = m.message;
      }, () => false);
      if (error) throw new Error(error);
      const lf = p.output('landforms')!;
      return { before: p.output('glacial')!.extra as GlacialExtra, after: lf.extra as LandformsExtra, stats: lf.stats };
    })();
    cache.set(key, w);
  }
  return w;
}

const count = (w: World, type: string): number => w.after.features.filter((f) => f.type === type).length;

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * fixed ⇔ base level: fixed cells are water (h ≤ 0) or already-fixed open-edge land; fixed water is
 * closed under 8-adjacency within the water (no unfixed water touches fixed water); and every
 * 8-connected body of fixed water contains water that was fixed before the landform passes (no new
 * isolated "seas").
 */
function checkFixed(w: World): void {
  const { n, h, fixed } = w.after;
  const b = w.before;
  const N = n * n;
  const water = (i: number): boolean => h[i] <= 0;
  for (let i = 0; i < N; i++) {
    const x = i % n;
    const y = (i - x) / n;
    const edge = x === 0 || y === 0 || x === n - 1 || y === n - 1;
    if (fixed[i] && !water(i)) {
      expect(edge && b.fixed[i] === 1, `fixed land cell ${i} (h ${h[i]}) off the open edge`).toBe(true);
    }
    if (!fixed[i] && water(i)) {
      for (let k = 0; k < 8; k++) {
        const xx = x + DX[k];
        const yy = y + DY[k];
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const j = yy * n + xx;
        expect(fixed[j] && water(j), `unfixed water ${i} touches fixed water ${j}`).toBe(false);
      }
    }
  }
  const seen = new Uint8Array(N);
  const stack: number[] = [];
  for (let s = 0; s < N; s++) {
    if (seen[s] || !fixed[s] || !water(s)) continue;
    let anchored = false;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      if (b.fixed[c] && b.h[c] <= 0) anchored = true;
      const x = c % n;
      const y = (c - x) / n;
      for (let k = 0; k < 8; k++) {
        const xx = x + DX[k];
        const yy = y + DY[k];
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const j = yy * n + xx;
        if (!seen[j] && fixed[j] && water(j)) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    expect(anchored, `fixed water body at ${s} is not connected to the old sea`).toBe(true);
  }
}

/** Masks stay consistent with the terrain and with each other. */
function checkMasks(w: World): void {
  const { n, h, masks } = w.after;
  for (const id of ['cliff', 'reef', 'beach', 'marsh']) expect(masks.get(id)?.length, id).toBe(n * n);
  const beach = masks.get('beach')!;
  const marsh = masks.get('marsh')!;
  const cliff = masks.get('cliff')!;
  for (let i = 0; i < n * n; i++) {
    if (h[i] <= 0) {
      expect(beach[i] | marsh[i] | cliff[i], `shore mask on water at ${i}`).toBe(0);
    }
    expect(beach[i] > 0 && marsh[i] > 0, `beach and marsh at ${i}`).toBe(false);
  }
}

describe('coastal landforms (M6, FEATURES F10–F21)', () => {
  it('keeps the fixed invariant and consistent masks on Earth-like previews', async () => {
    for (const seed of [3, 7, 11]) {
      const w = await world('earth', seed);
      checkFixed(w);
      checkMasks(w);
      expect(Math.abs(w.stats.coastalLandDelta), `seed ${seed} land change`).toBeLessThan(0.015);
      expect(w.stats.coastKm).toBeGreaterThan(1000);
      expect(w.stats.coastKm_sandy + w.stats.coastKm_rocky + w.stats.coastKm_sheltered + w.stats.coastKm_ice).toBeCloseTo(w.stats.coastKm, -1);
    }
  }, 60_000);

  it('puts barrier islands and lagoons on low sandy Earth-like coasts on most seeds', async () => {
    let withBarriers = 0;
    for (const seed of [3, 7, 11]) {
      const w = await world('earth', seed);
      if (count(w, 'barrier-island') > 0 && count(w, 'lagoon') > 0) withBarriers++;
      // Barrier islands are new sand a few km offshore: beach on cells that were sea before the pass.
      const beach = w.after.masks.get('beach')!;
      let sandOnOldSea = 0;
      for (let i = 0; i < beach.length; i++) if (beach[i] && w.before.h[i] <= 0 && w.after.h[i] > 0) sandOnOldSea++;
      if (count(w, 'barrier-island') > 0) expect(sandOnOldSea).toBeGreaterThan(0);
    }
    expect(withBarriers).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('grows reefs and atolls in the warm seas of the volcanic island chain', async () => {
    let withAtoll = 0;
    for (const seed of [3, 7, 11]) {
      const w = await world('volcanic', seed);
      checkFixed(w);
      checkMasks(w);
      const reef = w.after.masks.get('reef')!;
      let reefCells = 0;
      for (const v of reef) if (v > 0) reefCells++;
      expect(reefCells, `seed ${seed} reef cells`).toBeGreaterThan(10);
      expect(count(w, 'reef') + count(w, 'atoll')).toBeGreaterThan(0);
      if (count(w, 'atoll') >= 1) withAtoll++;
      expect(count(w, 'atoll')).toBeLessThanOrEqual(6);
      expect(Math.abs(w.stats.coastalLandDelta)).toBeLessThan(0.015);
    }
    expect(withAtoll).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('atolls are a ring at sea level around a lagoon', async () => {
    const w = await world('volcanic', 3);
    const { n, h, cellKm } = w.after;
    const atolls = w.after.features.filter((f) => f.type === 'atoll');
    expect(atolls.length).toBeGreaterThan(0);
    for (const a of atolls) {
      const cx = a.x / 1000 / cellKm;
      const cy = a.y / 1000 / cellKm;
      const c = Math.floor(cy) * n + Math.floor(cx);
      expect(h[c]).toBeLessThan(-5); // lagoon
      expect(w.after.fixed[c]).toBe(1); // connected to the sea through the passes
      const R = a.size / 2 / 1000 / cellKm;
      let ringMin = Infinity;
      let ringMax = -Infinity;
      for (let k = 0; k < 32; k++) {
        const t = (k / 32) * 2 * Math.PI;
        const j = Math.floor(cy + R * Math.sin(t)) * n + Math.floor(cx + R * Math.cos(t));
        ringMin = Math.min(ringMin, h[j]);
        ringMax = Math.max(ringMax, h[j]);
      }
      expect(ringMin).toBeGreaterThan(-60);
      expect(ringMax).toBeLessThan(10);
    }
  }, 60_000);

  it('grows no reefs on cold worlds (Fjordland, Ice age)', async () => {
    for (const arch of ['fjordland', 'iceage']) {
      const w = await world(arch, 7);
      checkFixed(w);
      checkMasks(w);
      const reef = w.after.masks.get('reef')!;
      expect(reef.some((v) => v > 0), `${arch} has reef cells`).toBe(false);
      expect(count(w, 'reef') + count(w, 'atoll')).toBe(0);
      expect(Math.abs(w.stats.coastalLandDelta)).toBeLessThan(0.015);
    }
  }, 60_000);

  it('reports coast length by class and feature counts', async () => {
    const w = await world('earth', 7);
    for (const k of ['coastKm', 'coastKm_sandy', 'coastKm_rocky', 'coastKm_sheltered', 'coastKm_cliff', 'barrierIslands', 'lagoons', 'spits', 'tombolos', 'rias', 'seaStacks', 'atolls', 'coastal_ms']) {
      expect(w.stats[k], k).toBeTypeOf('number');
    }
    expect(w.stats.coastKm_sandy).toBeGreaterThan(0);
    expect(w.stats.coastKm_rocky).toBeGreaterThan(0);
    expect(w.stats.coastKm_cliff).toBeGreaterThan(0);
    expect(count(w, 'sea-cliff')).toBeGreaterThan(0);
    // Uncommon/rare tiers stay within their caps.
    expect(count(w, 'ria')).toBeLessThanOrEqual(12);
    expect(count(w, 'spit')).toBeLessThanOrEqual(25);
    expect(count(w, 'tombolo')).toBeLessThanOrEqual(3);
    expect(count(w, 'sea-stack')).toBeLessThanOrEqual(60);
  }, 60_000);

  it('is deterministic per seed', async () => {
    const hashes = async (): Promise<number[]> => {
      cache.clear();
      const w = await world('earth', 5);
      const m = w.after.masks;
      return [
        hashBytes(w.after.h), hashBytes(w.after.fixed), hashBytes(m.get('reef')!), hashBytes(m.get('beach')!),
        hashBytes(m.get('marsh')!), hashBytes(m.get('cliff')!), hashBytes(new Float64Array(w.after.features.flatMap((f) => [f.x, f.y, f.size]))),
      ];
    };
    expect(await hashes()).toEqual(await hashes());
  }, 60_000);

  it('holds on a finer build grid', async () => {
    const w = await world('earth', 7, 'build', { lemGrid: '256', macroGrid: '512' });
    checkFixed(w);
    checkMasks(w);
    expect(Math.abs(w.stats.coastalLandDelta)).toBeLessThan(0.015);
    expect(count(w, 'barrier-island')).toBeGreaterThan(0);
    expect(w.stats.coastal_ms).toBeLessThan(400);
  }, 60_000);
});
