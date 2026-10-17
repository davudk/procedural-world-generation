/**
 * Spherical worlds (research 10 §8, Phase 2): the erosion model and the climate on the cube-sphere,
 * the sphere pipeline (plates → climate, then a clean stop), and the world-shape config.
 */
import { describe, expect, it } from 'vitest';
import { computeClimate } from '../src/gen/climate/model';
import { cubeGrid, latitudes, unitPositions } from '../src/gen/grid/cube';
import { flatGrid } from '../src/gen/grid/grid';
import { DEFAULT_LEM_PARAMS, runLem, upliftForPeak, type LemInput } from '../src/gen/lem/streamPower';
import { Pipeline } from '../src/gen/pipeline';
import { STAGES } from '../src/gen/stages';
import { resolve } from '../src/shared/config/resolve';
import { PARAMS } from '../src/shared/config/schema';
import { SPHERE_STAGES, type StageId } from '../src/shared/config/types';
import { queryToSpec, specToQuery } from '../src/shared/config/url';
import { hashBytes } from '../src/shared/hash';
import { Noise3 } from '../src/shared/noise3';
import type { FromWorker } from '../src/shared/protocol';
import { Rng } from '../src/shared/rng';

const CELL = 2000;
const K0 = 1e-5;

/** Peak relief after `iterations` on a strip of land between fixed base levels, `halfM` from each. */
async function stripRelief(inp: LemInput, iterations: number): Promise<number> {
  const res = await runLem(inp, { ...DEFAULT_LEM_PARAMS, iterations }, new Rng(4));
  let mx = 0;
  for (let i = 0; i < res.h.length; i++) if (!inp.fixed[i] && res.h[i] > mx) mx = res.h[i];
  return mx;
}

describe('erosion on the sphere', () => {
  it('a strip round the equator reaches the flat strip relief (the metric is local)', async () => {
    const n = 96;
    const halfM = ((n - 1) / 2) * CELL;
    const U0 = upliftForPeak(3000, K0, 0.4, halfM, CELL);
    // Flat: drains to x = 0 and x = n − 1.
    const N = n * n;
    const rng = new Rng(4);
    const flat: LemInput = {
      grid: flatGrid(n, CELL / 1000), h: new Float32Array(N), U: new Float32Array(N).fill(U0), K: new Float32Array(N).fill(K0), fixed: new Uint8Array(N),
    };
    for (let i = 0; i < N; i++) {
      const x = i % n;
      if (x === 0 || x === n - 1) flat.fixed[i] = 1;
      else flat.h[i] = 1 + 10 * rng.float();
    }
    // Sphere with ~2 km cells: an equatorial belt of the same width between fixed bands to the north and south.
    const g = cubeGrid(128, (CELL * 128) / (Math.PI / 2));
    const lat = latitudes(g);
    const belt = ((halfM / g.radiusM) * 180) / Math.PI;
    const S = g.cells;
    const srng = new Rng(4);
    const sph: LemInput = { grid: g, h: new Float32Array(S), U: new Float32Array(S).fill(U0), K: new Float32Array(S).fill(K0), fixed: new Uint8Array(S) };
    for (let i = 0; i < S; i++) {
      if (Math.abs(lat[i]) > belt) {
        sph.fixed[i] = 1;
        sph.h[i] = -100;
      } else sph.h[i] = 1 + 10 * srng.float();
    }
    const rf = await stripRelief(flat, 120);
    const rs = await stripRelief(sph, 120);
    console.log(`[sphere] strip relief: flat ${rf.toFixed(0)} m, sphere ${rs.toFixed(0)} m (ratio ${(rs / rf).toFixed(3)})`);
    expect(Math.abs(rs / rf - 1)).toBeLessThan(0.07);
  }, 60_000);
});

describe('climate on the sphere', () => {
  const g = cubeGrid(64, 652e3);
  const params = {
    latNorth: 0, latSouth: 0, tempOffset: 0, gradient: 1, humidity: 1, moistureLength: 1500, seasonality: 1, windOverrideAngle: 0,
    windOverrideStrength: 0, oceanCurrents: true, outsideOcean: true, latitudeWarp: 0, windNoise: 0, orographicStrength: 0.08,
    rainShadowCap: 60, recycling: 0.35,
  };

  it('is zonally symmetric on a featureless water world and its sweeps converge', async () => {
    const h = new Float32Array(g.cells).fill(-1000);
    const fixed = new Uint8Array(g.cells).fill(1);
    const f = await computeClimate(h, fixed, g, params, new Noise3(3), async () => {});
    const lat = latitudes(g);
    // Spread between longitudes inside 0.25° latitude bands (the zonal table changes ≤ 0.2 °C across one).
    const spread = (v: Float32Array): { worst: number } => {
      const B = 720;
      const lo = new Float64Array(B + 1).fill(Infinity);
      const hi = new Float64Array(B + 1).fill(-Infinity);
      const cnt = new Float64Array(B + 1);
      for (let i = 0; i < g.cells; i++) {
        const b = Math.round((lat[i] + 90) * 4);
        lo[b] = Math.min(lo[b], v[i]);
        hi[b] = Math.max(hi[b], v[i]);
        cnt[b]++;
      }
      let worst = 0;
      for (let b = 0; b <= B; b++) if (cnt[b] >= 4) worst = Math.max(worst, hi[b] - lo[b]);
      return { worst };
    };
    const t = spread(f.temp);
    // Precipitation (first-order upwind transport on a non-uniform grid) is zonal to within about ±15 % (area-aware upwind weights; ±17 % before):
    // the 5–95 % range between longitudes in each ½° band, relative to the band mean.
    let pWorst = 0;
    for (let b = -90; b < 90; b += 0.5) {
      const v: number[] = [];
      for (let i = 0; i < g.cells; i++) if (lat[i] >= b && lat[i] < b + 0.5) v.push(f.precip[i]);
      if (v.length < 20) continue;
      v.sort((x, y) => x - y);
      const mean = v.reduce((x, y) => x + y, 0) / v.length;
      pWorst = Math.max(pWorst, (v[Math.floor(0.95 * v.length)] - v[Math.floor(0.05 * v.length)]) / mean);
    }
    console.log(`[sphere] water world: temperature spread ${t.worst.toFixed(3)} °C, precipitation 5–95 % range ${(100 * pWorst).toFixed(1)} % of the band mean; ${JSON.stringify(f.stats)}`);
    expect(t.worst).toBeLessThan(0.5);
    expect(pWorst).toBeLessThan(0.35);
    for (const k of ['roundsMarine0', 'roundsMarine1', 'roundsMoisture0', 'roundsMoisture1']) expect(f.stats[k]).toBeLessThanOrEqual(4);
  });

  it('has trades, westerlies and polar easterlies in the local frame', async () => {
    const h = new Float32Array(g.cells).fill(-1000);
    const fixed = new Uint8Array(g.cells).fill(1);
    const f = await computeClimate(h, fixed, g, params, new Noise3(3), async () => {});
    const lat = latitudes(g);
    // windDeg = direction the wind blows toward (0 = north, clockwise): westerlies blow toward the east.
    const eastward = (a: number, b: number): number => {
      let e = 0;
      let c = 0;
      for (let i = 0; i < g.cells; i++) {
        if (Math.abs(lat[i]) < a || Math.abs(lat[i]) > b) continue;
        e += Math.sin((f.windDeg[i] * Math.PI) / 180);
        c++;
      }
      return e / c;
    };
    expect(eastward(5, 20)).toBeLessThan(-0.5);
    expect(eastward(40, 55)).toBeGreaterThan(0.5);
    expect(eastward(70, 85)).toBeLessThan(-0.5);
  });
});

/** Runs a sphere preview and collects the messages. */
async function runSphere(seed: number, pins: Record<string, string | number> = {}): Promise<{ msgs: FromWorker[]; p: Pipeline }> {
  const msgs: FromWorker[] = [];
  const p = new Pipeline(STAGES);
  await p.run(resolve({ seed, archetype: 'earth', pins: { worldShape: 'sphere', ...pins } }), 'preview', 1, (m) => msgs.push(m), () => false);
  return { msgs, p };
}

describe('sphere pipeline', () => {
  it('runs plates → climate on 6 cube faces and stops cleanly', async () => {
    const { msgs } = await runSphere(7);
    const err = msgs.find((m) => m.type === 'error');
    expect(err && err.type === 'error' ? err.message : '').toBe('');
    const done = msgs.filter((m) => m.type === 'stage-done').map((m) => (m.type === 'stage-done' ? m.stage : ''));
    expect(done).toEqual([...SPHERE_STAGES]);
    expect(msgs.at(-1)?.type).toBe('done');
    for (const m of msgs) {
      if (m.type !== 'stage-done') continue;
      for (const l of m.layers) {
        expect(l.faces, l.id).toBe(6);
        expect(l.data.length, l.id).toBe(6 * l.w * l.w);
        expect(l.worldKm).toBeCloseTo(4096 / 4, 6);
        for (const v of l.data) expect(Number.isFinite(v), l.id).toBe(true);
      }
    }
    const refine = msgs.find((m) => m.type === 'stage-done' && m.stage === 'refine');
    if (refine?.type !== 'stage-done') throw new Error('no refine stage');
    // Area-weighted sea level hits the land fraction; continents are complete (no map edge).
    expect(refine.stats.landFraction).toBeCloseTo(0.4, 2);
    expect(refine.stats.continents).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('is deterministic', async () => {
    const a = await runSphere(11);
    const b = await runSphere(11);
    const hashes = (msgs: FromWorker[]): number[] => msgs.flatMap((m) => (m.type === 'stage-done' ? m.layers.map((l) => hashBytes(l.data)) : []));
    expect(hashes(a.msgs)).toEqual(hashes(b.msgs));
  }, 60_000);

  it('drains every land cell to the sea (no edge outlets)', async () => {
    const { p } = await runSphere(42);
    const e = p.output('refine')!.extra as { h: Float32Array; fixed: Uint8Array; rcv: Int32Array };
    // Following receivers from any land cell reaches a fixed (sea) cell.
    for (let s = 0; s < e.h.length; s += 97) {
      let c = s;
      for (let k = 0; k < e.h.length && !e.fixed[c]; k++) c = e.rcv[c];
      expect(e.fixed[c], `cell ${s}`).toBe(1);
    }
  }, 60_000);

  it('switching the shape changes every stage key, and flat keys ignore the sphere parameters', () => {
    const p = new Pipeline(STAGES);
    const flat = p.keys(resolve({ seed: 1, archetype: 'earth', pins: {} }), 'preview');
    const sph = p.keys(resolve({ seed: 1, archetype: 'earth', pins: { worldShape: 'sphere' } }), 'preview');
    for (const id of flat.keys()) expect(sph.get(id), id).not.toBe(flat.get(id));
    const tilted = p.keys(resolve({ seed: 1, archetype: 'earth', pins: { axialTilt: 40 } }), 'preview');
    for (const id of ['plates', 'base', 'lem', 'refine'] as StageId[]) expect(tilted.get(id)).toBe(flat.get(id));
  });
});

describe('world shape config', () => {
  it('flat is the default, and flat URLs never mention the shape', () => {
    expect(resolve({ seed: 1, archetype: 'earth', pins: {} }).values.worldShape).toBe('flat');
    expect(specToQuery({ seed: 1, archetype: 'earth', pins: { worldShape: 'flat', worldSize: 2048 } })).toBe('seed=1&worldSize=2048');
    const sph = { seed: 1, archetype: 'earth', pins: { worldShape: 'sphere', planetSize: 8192 } };
    expect(queryToSpec(specToQuery(sph), 0)).toEqual(sph);
    // A sphere URL drops pins of flat-only parameters.
    expect(specToQuery({ seed: 1, archetype: 'earth', pins: { worldShape: 'sphere', worldSize: 2048, latitudeSpan: [60, 10] } })).toBe('seed=1&worldShape=sphere');
  });

  it('flat AUTO values and provenance are unaffected by the sphere parameters', () => {
    const a = resolve({ seed: 5, archetype: 'fjordland', pins: {} });
    const b = resolve({ seed: 5, archetype: 'fjordland', pins: { planetSize: 20000, axialTilt: 5 } });
    for (const d of PARAMS) {
      if (d.shapes?.includes('flat') === false) continue;
      expect(b.values[d.id], d.id).toEqual(a.values[d.id]);
      expect(b.provenance[d.id], d.id).toBe(a.provenance[d.id]);
      expect(a.provenance[d.id], d.id).not.toMatch(/planet size|world shape|axial tilt/);
    }
  });

  it('sphere AUTO formulas use the equal-area size and saturate on big planets', () => {
    const small = resolve({ seed: 5, archetype: 'earth', pins: { worldShape: 'sphere' } }).values;
    const earth = resolve({ seed: 5, archetype: 'earth', pins: { worldShape: 'sphere', planetSize: 40030 } }).values;
    // S_eff = C/√π = 2311 km for the small planet.
    expect(small.meanPlateDiameter as number).toBeGreaterThan(600);
    expect(small.seasonality).toBeCloseTo(1, 6);
    expect(small.oceanCurrents).toBe(true);
    const plates = earth.plateCount as readonly [number, number];
    expect(plates[1]).toBeLessThanOrEqual(30);
    expect(earth.moistureLength).toBe(3000);
    expect(earth.planetRadius).toBe(6371);
  });
});

it('unit positions are unit vectors', () => {
  const p = unitPositions(cubeGrid(8, 1));
  for (let i = 0; i < p.length; i += 3) expect(Math.hypot(p[i], p[i + 1], p[i + 2])).toBeCloseTo(1, 6);
});
