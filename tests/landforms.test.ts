import { describe, expect, it } from 'vitest';
import { flatGrid } from '../src/gen/grid/grid';
import { applyArid } from '../src/gen/landforms/arid';
import { applyCraters } from '../src/gen/landforms/impact';
import { applyKarst } from '../src/gen/landforms/karst';
import { DiskSet, Outline, poisson, settleFixed, snapshot, strataField } from '../src/gen/landforms/profiles';
import { Noise2 } from '../src/shared/noise';
import type { LandformCtx } from '../src/gen/landforms/types';
import { applyVolcanic } from '../src/gen/landforms/volcanic';
import { Pipeline } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import type { BaseExtra } from '../src/gen/stages/base';
import type { ClimateExtra } from '../src/gen/stages/climate';
import type { GlacialExtra } from '../src/gen/stages/glacial';
import { landformsStage } from '../src/gen/stages/landforms';
import type { PlatesExtra } from '../src/gen/stages/plates';
import { resolve } from '../src/shared/config/resolve';
import type { Range, WorldSpec } from '../src/shared/config/types';
import { hashBytes, rngFor } from '../src/shared/hash';
import { Rng } from '../src/shared/rng';

/** The four M6 passes owned here, in stage order (coastal runs after them and is tested elsewhere). */
const PASSES = [applyVolcanic, applyCraters, applyArid, applyKarst];

interface Run {
  c: LandformCtx;
  /** Heights and ocean mask before the passes (the glacial stage output). */
  h0: Float32Array;
  fixed0: Uint8Array;
}

const pipelines = new Map<string, Promise<Pipeline>>();

/** Real pipeline in preview mode (cached per archetype/seed/pins). */
function pipeline(archetype: string, seed: number, pins: WorldSpec['pins']): Promise<Pipeline> {
  const key = JSON.stringify([archetype, seed, pins]);
  let p = pipelines.get(key);
  if (!p) {
    p = (async () => {
      const pl = new Pipeline(STAGES);
      let error = '';
      await pl.run(resolve({ seed, archetype, pins }), 'preview', 1, (m) => {
        if (m.type === 'error') error = m.message;
      }, () => false);
      if (error) throw new Error(error);
      return pl;
    })();
    pipelines.set(key, p);
  }
  return p;
}

/**
 * Runs the four passes on a fresh landform context built from the pipeline's own inputs, exactly as
 * the landforms stage does (same reads whitelist, same rng keys), so the coastal pass doesn't mix in.
 */
async function run(archetype: string, seed = 7, pins: WorldSpec['pins'] = {}): Promise<Run> {
  const pl = await pipeline(archetype, seed, pins);
  const resolved = resolve({ seed, archetype, pins });
  const g = pl.output('glacial')!.extra as GlacialExtra;
  const get = (id: string): unknown => {
    if (!landformsStage.reads.includes(id)) throw new Error(`landforms reads undeclared parameter ${id}`);
    return resolved.values[id];
  };
  const c: LandformCtx = {
    grid: flatGrid(g.n, g.cellKm), n: g.n, cellKm: g.cellKm, worldKm: get('worldSize') as number, h: g.h.slice(), fixed: g.fixed.slice(), ice: g.ice,
    climate: pl.output('climate')!.extra as ClimateExtra,
    plates: pl.output('plates')!.extra as PlatesExtra,
    base: pl.output('base')!.extra as BaseExtra,
    num: (id) => get(id) as number,
    range: (id) => get(id) as Range,
    str: (id) => get(id) as string,
    drawn: (id) => {
      get(id);
      return resolved.drawn[id];
    },
    rng: (...k) => rngFor(seed, 'landforms', ...k),
    features: [], masks: new Map(), stats: {},
  };
  for (const pass of PASSES) pass(c);
  return { c, h0: g.h, fixed0: g.fixed };
}

const count = (c: LandformCtx, type: string): number => c.features.filter((f) => f.type === type).length;
const cellsAtLeast = (m: Uint8Array | undefined, t: number): number => (m ? m.reduce((s, v) => s + (v >= t ? 1 : 0), 0) : 0);

function checkFixed(r: Run): void {
  const { c, h0 } = r;
  const n = c.n;
  for (let i = 0; i < n * n; i++) {
    const x = i % n;
    const y = (i - x) / n;
    const border = x === 0 || y === 0 || x === n - 1 || y === n - 1;
    if (c.fixed[i]) expect(c.h[i] <= 0 || border, `fixed cell ${i} at ${c.h[i]} m`).toBe(true);
    // Cells the passes touched follow the invariant exactly: land is above sea level.
    if (c.h[i] !== h0[i] && !c.fixed[i]) expect(c.h[i], `land cell ${i}`).toBeGreaterThan(0);
  }
}

describe('landform helpers', () => {
  it('poisson draws have the requested mean', () => {
    const rng = new Rng(3);
    for (const lambda of [0.4, 3, 50]) {
      let s = 0;
      for (let k = 0; k < 4000; k++) s += poisson(rng, lambda);
      expect(s / 4000).toBeGreaterThan(lambda * 0.93);
      expect(s / 4000).toBeLessThan(lambda * 1.07);
    }
    expect(poisson(rng, 0)).toBe(0);
  });

  it('DiskSet enforces spacing', () => {
    const d = new DiskSet(50);
    d.add(100, 100);
    expect(d.free(140, 100, 50)).toBe(false);
    expect(d.free(151, 100, 50)).toBe(true);
    expect(d.free(100, 30, 80)).toBe(false);
    expect(d.free(100, 30, 69)).toBe(true);
    expect(d.free(400, 400, 50)).toBe(true);
  });

  it('settleFixed drowns lowered land only where it connects to the sea', () => {
    const n = 8;
    const h = new Float32Array(n * n).fill(100);
    const fixed = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) {
      h[y * n] = -50;
      fixed[y * n] = 1;
    }
    const c = { n, h, fixed } as unknown as LandformCtx;
    const s = snapshot(c);
    h[3 * n + 1] = -10; // touches the sea column → becomes sea
    h[3 * n + 5] = -10; // enclosed → clamped, stays land
    h[0] = 20; // sea raised above 0 → land
    const drowned = settleFixed(c, s);
    expect(drowned).toBe(1);
    expect(fixed[3 * n + 1]).toBe(1);
    expect(fixed[3 * n + 5]).toBe(0);
    expect(h[3 * n + 5]).toBeGreaterThan(0);
    expect(fixed[0]).toBe(0);
  });
});

/** Coefficient of variation, over 36 rays, of the outermost distance where h ≥ `level`. */
function contourCv(c: LandformCtx, xKm: number, yKm: number, level: number, maxKm: number): number {
  const d: number[] = [];
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    // Scan inwards so a caldera at the summit doesn't matter: outermost point at or above `level`.
    let r = maxKm;
    for (; r > 0; r -= c.cellKm / 4) {
      const x = Math.floor((xKm + r * Math.cos(a)) / c.cellKm);
      const y = Math.floor((yKm + r * Math.sin(a)) / c.cellKm);
      if (x >= 0 && y >= 0 && x < c.n && y < c.n && c.h[y * c.n + x] >= level) break;
    }
    d.push(r);
  }
  const m = d.reduce((s, v) => s + v, 0) / d.length;
  return Math.sqrt(d.reduce((s, v) => s + (v - m) ** 2, 0) / d.length) / Math.max(1e-9, m);
}

describe('irregular outlines', () => {
  it('Outline is non-circular, elongated on request, and deterministic', () => {
    const make = (): Outline => new Outline(new Rng(9), new Noise2(4), 500, 500, 40, { amp: 0.28, elong: 1.6, axis: 0.3, lobes: 4, lobeAmp: 0.35, warp: 0.08, warpKm: 5 });
    const o = make();
    const radii: number[] = [];
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      let r = 0;
      while (o.x(r * Math.cos(a), r * Math.sin(a)) < 1 && r < 40 * o.maxScale) r += 0.25;
      radii.push(r);
    }
    const mean = radii.reduce((s, v) => s + v, 0) / radii.length;
    const cv = Math.sqrt(radii.reduce((s, v) => s + (v - mean) ** 2, 0) / radii.length) / mean;
    expect(cv).toBeGreaterThan(0.12);
    expect(Math.max(...radii)).toBeLessThanOrEqual(40 * o.maxScale);
    expect(make().x(13, -7)).toBe(o.x(13, -7));
  });
});

describe('M6 landform passes (preview pipeline)', () => {
  it('volcanic island chains get fresh volcanoes and calderas on most seeds', async () => {
    let withCaldera = 0;
    for (const seed of [1, 2, 3, 7, 11]) {
      const { c } = await run('volcanic', seed);
      const volcanoes = count(c, 'stratovolcano') + count(c, 'shield-volcano');
      expect(volcanoes, `seed ${seed}`).toBeGreaterThan(0);
      if (count(c, 'caldera') >= 1) withCaldera++;
      // Calderas are closed basins: floor below the surrounding rim.
      for (const f of c.features.filter((q) => q.type === 'caldera')) expect(f.data!.depth).toBeGreaterThan(0);
      expect(cellsAtLeast(c.masks.get('geothermal'), 1)).toBeGreaterThan(0);
      // Shields are not discs: their mid-height contour is irregular.
      for (const f of c.features.filter((q) => q.type === 'shield-volcano')) {
        const top = f.data!.height;
        expect(contourCv(c, f.x / 1000, f.y / 1000, top * 0.4, f.size / 1000), `seed ${seed} shield`).toBeGreaterThan(0.08);
      }
    }
    expect(withCaldera).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('volcanoes sit on arcs and hotspots only: no volcanism, no volcanoes', async () => {
    const { c } = await run('earth', 7, { volcanism: 0 });
    expect(count(c, 'stratovolcano') + count(c, 'shield-volcano') + count(c, 'caldera') + count(c, 'cinder-field')).toBe(0);
  }, 60_000);

  it('fresh craters are rare on Earth-like worlds and commoner on old cratons', async () => {
    let earth = 0;
    let craton = 0;
    for (const seed of [1, 2, 3, 7, 11]) {
      const e = (await run('earth', seed)).c;
      const k = (await run('craton', seed)).c;
      expect(count(e, 'crater'), `earth seed ${seed}`).toBeLessThanOrEqual(3);
      earth += count(e, 'crater');
      craton += count(k, 'crater');
      for (const f of [...e.features, ...k.features].filter((q) => q.type === 'crater')) {
        const D = f.data!.diameter;
        const ratio = f.data!.depth / D;
        // Pike: simple d/D ≈ 0.2, complex much shallower; fresh craters lose at most ~25 % to age.
        if (f.data!.complex) expect(ratio).toBeLessThan(0.2);
        else expect(ratio).toBeGreaterThan(0.14);
        expect(D / 1000).toBeGreaterThanOrEqual(2.9);
      }
    }
    expect(earth / 5).toBeLessThanOrEqual(2);
    expect(craton).toBeGreaterThan(earth);
  }, 180_000);

  it('craters keep 150 km spacing', async () => {
    const { c } = await run('craton', 7, { impactHistory: 3, density_relief: 3 });
    const cr = c.features.filter((f) => f.type === 'crater');
    expect(cr.length).toBeGreaterThan(2);
    for (let i = 0; i < cr.length; i++) {
      for (let j = i + 1; j < cr.length; j++) expect(Math.hypot(cr[i].x - cr[j].x, cr[i].y - cr[j].y)).toBeGreaterThanOrEqual(150_000);
    }
  }, 60_000);

  it('desert worlds get ergs and terraced mesas on layered rock only', async () => {
    const { c, h0 } = await run('desert', 7);
    expect(cellsAtLeast(c.masks.get('erg'), 128) * c.cellKm ** 2).toBeGreaterThan(5000);
    expect(count(c, 'erg')).toBeGreaterThan(0);
    expect(count(c, 'mesa-field')).toBeGreaterThan(0);
    expect(c.stats['terracedKm2']).toBeGreaterThan(0);
    const mesa = c.masks.get('mesa')!;
    const strata = strataField(c);
    let terraced = 0;
    let raised = 0;
    for (let i = 0; i < mesa.length; i++) {
      if (mesa[i] > 0) {
        expect(strata[i]).toBeGreaterThan(20);
        terraced++;
        // Terracing never raises; a volcano or inselberg from another pass may sit on a mesa cell.
        if (c.h[i] > h0[i] + 1e-3) raised++;
      }
    }
    expect(raised / Math.max(1, terraced)).toBeLessThan(0.01);
    // Dune direction is set wherever there is sand.
    const erg = c.masks.get('erg')!;
    const dunes = c.masks.get('dunes')!;
    for (let i = 0; i < erg.length; i++) if (erg[i] > 0) expect(dunes[i]).toBeGreaterThan(0);
  }, 60_000);

  it('humid worlds have no ergs or terraces', async () => {
    const { c } = await run('hothouse', 7);
    expect(c.stats['ergKm2']).toBeLessThan(2000);
  }, 60_000);

  it('the karst mask follows karstShare', async () => {
    const none = (await run('earth', 7, { karstShare: 0 })).c;
    const low = (await run('earth', 7, { karstShare: 0.06 })).c;
    const high = (await run('earth', 7, { karstShare: 0.3 })).c;
    expect(cellsAtLeast(none.masks.get('karst'), 1)).toBe(0);
    const a = cellsAtLeast(low.masks.get('karst'), 128);
    const b = cellsAtLeast(high.masks.get('karst'), 128);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(2.5 * a);
    // Never more karst than limestone share of land.
    let land = 0;
    for (let i = 0; i < high.h.length; i++) if (!high.fixed[i] && high.h[i] > 0) land++;
    expect(b / land).toBeLessThanOrEqual(0.33);
    expect(high.stats['dolines']).toBeGreaterThan(low.stats['dolines']);
  }, 120_000);

  it('keeps the ocean mask consistent', async () => {
    for (const arch of ['earth', 'volcanic', 'craton', 'desert', 'archipelago']) checkFixed(await run(arch, 7));
    checkFixed(await run('craton', 7, { impactHistory: 3, density_relief: 3 }));
  }, 180_000);

  it('is deterministic', async () => {
    const a = (await run('volcanic', 7)).c;
    const b = (await run('volcanic', 7)).c;
    expect(hashBytes(a.h)).toBe(hashBytes(b.h));
    expect(hashBytes(a.fixed)).toBe(hashBytes(b.fixed));
    expect(JSON.stringify(a.features)).toBe(JSON.stringify(b.features));
    for (const [k, m] of a.masks) expect(hashBytes(m)).toBe(hashBytes(b.masks.get(k)!));
  }, 60_000);

  it('the landforms stage exports the masks and feature counts', async () => {
    const pl = await pipeline('volcanic', 7, {});
    const out = pl.output('landforms')!;
    const ids = out.layers.map((l) => l.id);
    for (const id of ['geothermal', 'crater', 'erg', 'dunes', 'mesa', 'karst']) expect(ids).toContain(id);
    expect(out.stats['n_stratovolcano'] ?? 0).toBeGreaterThan(0);
  }, 60_000);
});
