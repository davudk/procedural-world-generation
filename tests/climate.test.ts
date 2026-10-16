import { describe, expect, it } from 'vitest';
import { Pipeline, type StageOutput } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import type { BiomeExtra } from '../src/gen/stages/biome';
import type { ClimateExtra } from '../src/gen/stages/climate';
import type { ErodedExtra } from '../src/gen/stages/lem';
import { BIOME, BIOMES } from '../src/shared/biomes';
import { resolve } from '../src/shared/config/resolve';
import type { WorldSpec } from '../src/shared/config/types';
import { hashBytes } from '../src/shared/hash';

interface World {
  climate: StageOutput;
  biome: StageOutput;
  c: ClimateExtra;
  b: BiomeExtra;
  t: ErodedExtra;
}

const cache = new Map<string, Promise<World>>();

/** Preview-mode world, memoised per (archetype, seed, pins). */
function world(archetype = 'earth', seed = 7, pins: WorldSpec['pins'] = {}): Promise<World> {
  const key = JSON.stringify([archetype, seed, pins]);
  let w = cache.get(key);
  if (!w) {
    w = (async () => {
      const p = new Pipeline(STAGES);
      let error = '';
      await p.run(resolve({ seed, archetype, pins }), 'preview', 1, (m) => {
        if (m.type === 'error') error = m.message;
      }, () => false);
      if (error) throw new Error(error);
      const climate = p.output('climate')!;
      const biome = p.output('biome')!;
      return { climate, biome, c: climate.extra as ClimateExtra, b: biome.extra as BiomeExtra, t: p.output('refine')!.extra as ErodedExtra };
    })();
    cache.set(key, w);
  }
  return w;
}

const mean = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);

/** Share of land (non-water) cells whose biome is in `ids`. */
function share(b: BiomeExtra, ids: readonly number[]): number {
  let land = 0;
  let hit = 0;
  for (const v of b.biome) {
    if (v === BIOME.WATER) continue;
    land++;
    if (ids.includes(v)) hit++;
  }
  return hit / land;
}

describe('M4 climate', () => {
  it('cools with elevation (lapse rate) and toward the cold latitude', async () => {
    const { c, t } = await world();
    const { n } = c;
    // Same latitude band: high ground is colder than lowland by roughly the lapse rate.
    const low: number[] = [];
    const high: number[] = [];
    const lowH: number[] = [];
    const highH: number[] = [];
    for (let i = 0; i < n * n; i++) {
      if (c.sea[i] || c.lat[i] < 35 || c.lat[i] > 50) continue;
      if (t.h[i] < 300) {
        low.push(c.temp[i]);
        lowH.push(t.h[i]);
      } else if (t.h[i] > 1500) {
        high.push(c.temp[i]);
        highH.push(t.h[i]);
      }
    }
    expect(high.length).toBeGreaterThan(20);
    const dT = mean(low) - mean(high);
    const dH = (mean(highH) - mean(lowH)) / 1000;
    expect(dT / dH).toBeGreaterThan(4);
    expect(dT / dH).toBeLessThan(9);
    // Earth-like spans 65° (north edge) → 20° (south edge): the north is colder.
    const rows = Math.floor(n / 10);
    const north: number[] = [];
    const south: number[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < n; x++) {
        north.push(c.temp[y * n + x]);
        south.push(c.temp[(n - 1 - y) * n + x]);
      }
    }
    expect(mean(south) - mean(north)).toBeGreaterThan(15);
    // Isotherms wiggle (latitude warp): sea-level temperature varies along a row.
    const y0 = Math.floor(n / 2);
    const sea: number[] = [];
    for (let x = 0; x < n; x++) if (c.sea[y0 * n + x]) sea.push(c.temp[y0 * n + x]);
    expect(Math.max(...sea) - Math.min(...sea)).toBeGreaterThan(0.5);
  }, 60_000);

  it('casts a bounded rain shadow behind a high range', async () => {
    const { c, t, climate } = await world();
    const { n, cellKm } = c;
    const wind = climate.layers.find((l) => l.id === 'wind')!.data as Float32Array;
    // Crest = the highest 0.5 % of mid-latitude land; compare P upwind and downwind along the wind.
    const land = t.h.filter((_, i) => !c.sea[i]).sort();
    const thr = Math.max(1500, land[Math.floor(land.length * 0.995)]);
    const windward: number[] = [];
    const lee: number[] = [];
    const sample = (x: number, y: number, dx: number, dy: number, km: number, into: number[]): void => {
      const xx = Math.round(x + (dx * km) / cellKm);
      const yy = Math.round(y + (dy * km) / cellKm);
      if (xx < 0 || yy < 0 || xx >= n || yy >= n || c.sea[yy * n + xx]) return;
      into.push(c.precip[yy * n + xx]);
    };
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (c.sea[i] || t.h[i] < thr || Math.abs(c.lat[i]) < 35 || Math.abs(c.lat[i]) > 60) continue;
        const a = (wind[i] * Math.PI) / 180;
        const dx = Math.sin(a);
        const dy = -Math.cos(a);
        for (let k = 20; k <= 60; k += 10) sample(x, y, -dx, -dy, k, windward);
        for (let k = 40; k <= 100; k += 10) sample(x, y, dx, dy, k, lee);
      }
    }
    expect(windward.length).toBeGreaterThan(50);
    const ratio = mean(windward) / mean(lee);
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(8);
  }, 60_000);

  it('dries the subtropics between the wet tropics and the storm track', async () => {
    const { c } = await world('earth', 7, { latitudeSpan: [55, -5] });
    const band = (lo: number, hi: number): number => {
      const ps: number[] = [];
      for (let i = 0; i < c.n * c.n; i++) {
        const a = Math.abs(c.lat[i]);
        if (!c.sea[i] && a >= lo && a <= hi) ps.push(c.precip[i]);
      }
      expect(ps.length).toBeGreaterThan(500);
      return mean(ps);
    };
    const tropics = band(0, 10);
    const subtropics = band(25, 30);
    const midLat = band(45, 55);
    expect(subtropics).toBeLessThan(0.5 * tropics);
    expect(subtropics).toBeLessThan(0.7 * midLat);
  }, 60_000);

  it('produces consistent climate fields', async () => {
    const { c } = await world();
    for (let i = 0; i < c.n * c.n; i++) {
      expect(c.precip[i]).toBeGreaterThanOrEqual(0);
      expect(c.pSummer[i]).toBeGreaterThanOrEqual(0);
      expect(c.pSummer[i]).toBeLessThanOrEqual(1);
      expect(c.tAmp[i]).toBeGreaterThanOrEqual(0);
      expect(c.pet[i]).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);
});

describe('M4 biomes', () => {
  it('gives the Earth-like world a varied set of land biomes', async () => {
    const { b, biome } = await world();
    expect(biome.stats.distinctBiomes).toBeGreaterThanOrEqual(4);
    const ids = new Set<number>(b.biome);
    ids.delete(BIOME.WATER);
    expect(ids.size).toBeGreaterThanOrEqual(4);
    for (const v of b.biome) expect(v).toBeLessThan(BIOMES.length);
    let sum = 0;
    for (const info of BIOMES) if (info.id !== BIOME.WATER) sum += biome.stats[info.name];
    expect(sum).toBeCloseTo(1, 2);
    for (let i = 0; i < b.n * b.n; i++) {
      expect(b.canopy[i]).toBeGreaterThanOrEqual(0);
      expect(b.canopy[i]).toBeLessThanOrEqual(1);
      expect(b.snow[i]).toBeGreaterThanOrEqual(0);
      expect(b.snow[i]).toBeLessThanOrEqual(1);
    }
  }, 60_000);

  it('makes the Desert world mostly desert and xeric shrubland', async () => {
    const { b } = await world('desert');
    expect(share(b, [BIOME.HOT_DESERT, BIOME.COLD_DESERT, BIOME.XERIC_SHRUB, BIOME.SALT_FLAT])).toBeGreaterThan(0.5);
  }, 60_000);

  it('spreads ice and tundra in the Ice age world', async () => {
    const cold = [BIOME.ICE, BIOME.TUNDRA, BIOME.POLAR_DESERT];
    const earth = share((await world()).b, cold);
    const ice = share((await world('iceage')).b, cold);
    expect(ice).toBeGreaterThan(earth + 0.1);
    expect(share((await world('iceage')).b, [BIOME.ICE])).toBeGreaterThan(share((await world()).b, [BIOME.ICE]));
  }, 60_000);

  it('is deterministic per seed', async () => {
    const hashes = async (): Promise<Record<string, number>> => {
      const p = new Pipeline(STAGES);
      const out: Record<string, number> = {};
      await p.run(resolve({ seed: 11, archetype: 'earth', pins: {} }), 'preview', 1, (m) => {
        if (m.type === 'stage-done' && (m.stage === 'climate' || m.stage === 'biome')) for (const l of m.layers) out[l.id] = hashBytes(l.data);
      }, () => false);
      return out;
    };
    const a = await hashes();
    expect(Object.keys(a).sort()).toEqual(['aridity', 'biome', 'canopy', 'precip', 'snow', 'summerRain', 'tempRange', 'temperature', 'wind']);
    expect(await hashes()).toEqual(a);
  }, 60_000);
});

/**
 * Straight-seam regression (research 03 §7.5). Upwind sweeps under a near-uniform wind used to carry
 * the edge of a coastal air mass as a narrow front along a straight streamline: on fjordland seed 31
 * (build) the temperature range changed ~6 °C per 100 km across a N–S line, which the renderer showed
 * as a straight vegetation/snow seam. Before the fix these preview worlds reached 6.7–8 °C/100 km
 * (tAmp) and 0.6–0.9 /100 km (summerRain) in the interior; now ≤ 4.3 and ≤ 0.35.
 */
describe('M4 climate has no straight seams', () => {
  const WORLDS: [string, number][] = [['fjordland', 31], ['earth', 7], ['pangaea', 2]];

  /** Largest gradient (per 100 km) of `f` over land at least 80 km from the sea. */
  function interiorGradient(c: ClimateExtra, f: Float32Array): number {
    const { n, cellKm } = c;
    let max = 0;
    for (let y = 1; y < n - 1; y++) {
      for (let x = 1; x < n - 1; x++) {
        const i = y * n + x;
        if (c.sea[i] || c.coastKm[i] < 80) continue;
        max = Math.max(max, (Math.hypot(f[i + 1] - f[i - 1], f[i + n] - f[i - n]) / (2 * cellKm)) * 100);
      }
    }
    return max;
  }

  /**
   * Axis-aligned seam score: over 32-cell runs along one axis, the mean central difference across
   * a single column (row) relative to the columns 4–6 cells either side. A straight step or kink
   * stands out against its neighbourhood; smooth or curved fronts do not.
   */
  function seamScore(c: ClimateExtra, f: Float32Array): number {
    const { n } = c;
    const RUN = 32;
    let global = 0;
    let cnt = 0;
    for (let i = n + 1; i < n * n - n - 1; i++) {
      if (c.sea[i]) continue;
      global += Math.abs(f[i + 1] - f[i - 1]) + Math.abs(f[i + n] - f[i - n]);
      cnt += 2;
    }
    const floor = (0.25 * global) / Math.max(1, cnt);
    let worst = 0;
    for (const horiz of [true, false]) {
      const step = horiz ? 1 : n;
      const col = new Float64Array(n);
      for (let r0 = 0; r0 + RUN <= n; r0 += RUN / 2) {
        for (let u = 1; u < n - 1; u++) {
          let s = 0;
          let k = 0;
          for (let r = r0; r < r0 + RUN; r++) {
            const i = horiz ? r * n + u : u * n + r;
            if (c.sea[i - step] || c.sea[i] || c.sea[i + step]) continue;
            s += Math.abs(f[i + step] - f[i - step]);
            k++;
          }
          col[u] = k >= RUN * 0.9 ? s / k : NaN;
        }
        for (let u = 7; u < n - 7; u++) {
          const ref = [col[u - 6], col[u - 4], col[u + 4], col[u + 6]];
          if (!(col[u] >= 0) || ref.some((v) => !(v >= 0))) continue;
          worst = Math.max(worst, col[u] / (Math.max(...ref) + floor));
        }
      }
    }
    return worst;
  }

  for (const [archetype, seed] of WORLDS) {
    it(`${archetype} ${seed}: smooth air-mass fronts and no axis-aligned steps`, async () => {
      const { c, b } = await world(archetype, seed);
      const lnP = Float32Array.from(c.precip, (v) => Math.log(Math.max(1, v)));
      const lutV = Float32Array.from(b.aridity, (v) => Math.log10(Math.max(0.01, v) * 10) / 2);
      const gA = interiorGradient(c, c.tAmp);
      const gS = interiorGradient(c, c.pSummer);
      const seams = [c.temp, c.tAmp, c.pSummer, lnP, lutV].map((f) => seamScore(c, f));
      // High ranges legitimately sharpen continentality and seasonality fronts behind them; the
      // axis-aligned step score below is the seam detector.
      expect(gA).toBeLessThan(8);
      expect(gS).toBeLessThan(0.65);
      seams.forEach((s, k) => expect(s, `seam field ${["temp", "tAmp", "pSummer", "lnP", "aridity"][k]}`).toBeLessThan(3));
    }, 60_000);
  }
});
