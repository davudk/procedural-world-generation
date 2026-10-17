import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boxCountDimension, ccdfExponent, clarkEvans, coefVar, components, edtSquared, entropy, largestEmptyDisk, prng, quantileSorted, summarize,
} from '../metrics/lib/math';
import {
  boxCountDimensionFaces, capView, clarkEvansSphere, geodesic, globeView, maxInDisk, nearestNeighbours, pickWeighted, randomDir,
} from '../metrics/lib/sphere';
import { runSuite } from '../metrics/runner';
import { BANDS, COUNT_TARGETS, SPHERE_BANDS, sphereCountRange, type CountTarget } from '../metrics/targets';
import { cubeGrid } from '../src/gen/grid/cube';
import { dirToCell } from '../src/shared/cube';

describe('metric functions (metrics/lib/math)', () => {
  it('quantiles, summary, entropy and CV', () => {
    expect(quantileSorted([0, 10], 0.5)).toBe(5);
    expect(Number.isNaN(quantileSorted([], 0.5))).toBe(true);
    const s = summarize([5, 1, 3, NaN, 2, 4]);
    expect(s.n).toBe(5);
    expect(s.p50).toBe(3);
    expect(s.min).toBe(1);
    expect(entropy([5, 5])).toBeCloseTo(Math.log(2), 10);
    expect(entropy([7])).toBe(0);
    expect(coefVar([2, 2, 2])).toBe(0);
    expect(coefVar([0, 2])).toBeCloseTo(1, 10);
  });

  it('exact distance transform and largest empty disk', () => {
    const w = 41;
    const h = 31;
    const f = new Uint8Array(w * h);
    f[15 * w + 20] = 1;
    const d2 = edtSquared(f, w, h);
    expect(d2[15 * w + 20]).toBe(0);
    expect(d2[15 * w + 23]).toBe(9);
    expect(d2[19 * w + 23]).toBe(25);
    // Corner farthest from the centre point: (0,0) → √(20² + 15²) = 25.
    expect(largestEmptyDisk(f, new Uint8Array(w * h).fill(1), w, h)).toBeCloseTo(25, 10);
    // Only the left column is valid: the farthest valid pixel is a left corner, also 25 away.
    const left = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) left[y * w] = 1;
    expect(largestEmptyDisk(f, left, w, h)).toBeCloseTo(25, 10);
    // Three features in a row: the emptiest pixels sit midway between them on the top/bottom edge.
    f[15 * w + 0] = 1;
    f[15 * w + 40] = 1;
    expect(largestEmptyDisk(f, new Uint8Array(w * h).fill(1), w, h)).toBeCloseTo(Math.hypot(10, 15), 10);
    expect(largestEmptyDisk(f, new Uint8Array(w * h), w, h)).toBe(0);
  });

  it('Clark–Evans: random ≈ 1, lattice > 1.8, clusters < 0.5', () => {
    const rnd = prng(42);
    const L = 1000;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 2000; i++) {
      xs.push(rnd() * L);
      ys.push(rnd() * L);
    }
    // No edge correction: a slight upward bias at the border.
    expect(clarkEvans(xs, ys, L * L)).toBeGreaterThan(0.95);
    expect(clarkEvans(xs, ys, L * L)).toBeLessThan(1.1);
    const gx: number[] = [];
    const gy: number[] = [];
    for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) {
      gx.push((i + 0.5) * (L / 30));
      gy.push((j + 0.5) * (L / 30));
    }
    expect(clarkEvans(gx, gy, L * L)).toBeGreaterThan(1.8);
    const cx: number[] = [];
    const cy: number[] = [];
    for (let c = 0; c < 10; c++) {
      const px = rnd() * L;
      const py = rnd() * L;
      for (let k = 0; k < 30; k++) {
        cx.push(px + (rnd() - 0.5) * 20);
        cy.push(py + (rnd() - 0.5) * 20);
      }
    }
    expect(clarkEvans(cx, cy, L * L)).toBeLessThan(0.5);
    expect(Number.isNaN(clarkEvans([0, 1], [0, 1], 1))).toBe(true);
  });

  it('Korčák / Pareto exponent of a synthetic power law', () => {
    // Sizes with N(≥A) = 1000·A^−0.65 exactly: A_k = (1000 / k)^(1/0.65).
    const sizes = Array.from({ length: 1000 }, (_, k) => (1000 / (k + 1)) ** (1 / 0.65));
    expect(ccdfExponent(sizes, 0).b).toBeCloseTo(0.65, 3);
    const lakes = Array.from({ length: 500 }, (_, k) => 500 / (k + 1));
    expect(ccdfExponent(lakes, 1).b).toBeCloseTo(1, 3);
    expect(Number.isNaN(ccdfExponent([1, 2], 0).b)).toBe(true);
  });

  it('box-counting dimension: line ≈ 1, filled square ≈ 2, Koch-like curve in between', () => {
    const n = 256;
    const line = new Uint8Array(n * n);
    for (let x = 0; x < n; x++) line[100 * n + x] = 1;
    expect(boxCountDimension(line, n)).toBeCloseTo(1, 1);
    const sq = new Uint8Array(n * n).fill(1);
    expect(boxCountDimension(sq, n)).toBeCloseTo(2, 1);
    // Boundary of a random-walk "coast" lies between 1 and 2.
    const rnd = prng(3);
    const blob = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) blob[y * n + x] = Math.hypot(x - 128, y - 128) < 80 + 25 * Math.sin(x * 0.3) * Math.cos(y * 0.23) + 8 * rnd() ? 1 : 0;
    const coast = new Uint8Array(n * n);
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      if (blob[i] && (!blob[i - 1] || !blob[i + 1] || !blob[i - n] || !blob[i + n])) coast[i] = 1;
    }
    const d = boxCountDimension(coast, n);
    expect(d).toBeGreaterThan(1.05);
    expect(d).toBeLessThan(1.6);
  });

  it('4-connected components', () => {
    const m = Uint8Array.from([1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1]);
    const { sizes } = components(m, 4, 4);
    expect([...sizes].sort()).toEqual([1, 2, 2, 2]);
  });
});

describe('sphere metric geometry (metrics/lib/sphere)', () => {
  const R = 652e3;
  const unit = (x: number, y: number, z: number): Float64Array => {
    const l = Math.hypot(x, y, z);
    return Float64Array.from([x / l, y / l, z / l]);
  };
  /** The point `d` metres from c along the great circle toward the unit tangent t. */
  const along = (c: ArrayLike<number>, t: readonly number[], d: number): Float64Array => {
    const a = d / R;
    return unit(c[0] * Math.cos(a) + t[0] * Math.sin(a), c[1] * Math.cos(a) + t[1] * Math.sin(a), c[2] * Math.cos(a) + t[2] * Math.sin(a));
  };

  it('cap views: ground distances from the centre and along the axes, round trips, poles included', () => {
    const W = 250e3;
    const H = W * 0.625;
    const q = new Float64Array(2);
    const d = new Float64Array(3);
    for (const c of [unit(1, 0.2, 0.3), unit(0, 0, 1), unit(-0.3, -1, -0.8)]) {
      const v = capView(c, R, W, H);
      expect(v.project(c[0], c[1], c[2], q)).toBe(true);
      expect(q[0]).toBeCloseTo(W / 2, 6);
      expect(q[1]).toBeCloseTo(H / 2, 6);
      for (const [px, py] of [[0, 0], [W, H], [W * 0.3, H * 0.9], [W / 2, 0]]) {
        expect(v.unproject(px, py, d)).toBe(true);
        expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
        v.project(d[0], d[1], d[2], q);
        expect(q[0]).toBeCloseTo(px, 4);
        expect(q[1]).toBeCloseTo(py, 4);
        // Azimuthal equidistant: the view distance from the centre is the great-circle distance.
        expect(geodesic(c, 0, d, 0, R)).toBeCloseTo(Math.hypot(px - W / 2, py - H / 2), 3);
      }
    }
    // At the equator 100 km of ground east is 100 km of view to the right, and north is up.
    const c = unit(1, 0, 0);
    const v = capView(c, R, W, H);
    const pe = along(c, [0, 1, 0], 100e3);
    v.project(pe[0], pe[1], pe[2], q);
    expect(q[0] - W / 2).toBeCloseTo(100e3, 3);
    expect(q[1]).toBeCloseTo(H / 2, 3);
    const pn = along(c, [0, 0, 1], 50e3);
    v.project(pn[0], pn[1], pn[2], q);
    expect(H / 2 - q[1]).toBeCloseTo(50e3, 3);
  });

  it('globe views: the orthographic disc, with limb points below the facing cosine left out', () => {
    const c = unit(0.2, -0.4, 0.9);
    const v = globeView(c, R, 0.3);
    expect(v.W).toBe(2 * R);
    const q = new Float64Array(2);
    expect(v.project(c[0], c[1], c[2], q)).toBe(true);
    expect(q[0]).toBeCloseTo(R, 6);
    expect(q[1]).toBeCloseTo(R, 6);
    const tl = Math.hypot(c[1], c[0]);
    const t = [c[1] / tl, -c[0] / tl, 0];
    const inside = along(c, t, R * Math.acos(0.31));
    const outside = along(c, t, R * Math.acos(0.29));
    expect(v.project(inside[0], inside[1], inside[2], q)).toBe(true);
    expect(v.project(outside[0], outside[1], outside[2], q)).toBe(false);
    const d = new Float64Array(3);
    expect(v.unproject(R, R, d)).toBe(true);
    expect(geodesic(c, 0, d, 0, R)).toBeLessThan(1e-3);
    expect(v.unproject(0, 0, d)).toBe(false);
  });

  it('area-uniform directions and area-weighted cells', () => {
    const rnd = prng(9);
    const d = new Float64Array(3);
    let north = 0;
    let band = 0;
    const k = 20000;
    for (let i = 0; i < k; i++) {
      randomDir(rnd, d);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
      if (d[2] > 0) north++;
      if (Math.abs(d[2]) < 0.5) band++;
    }
    // Archimedes: z is uniform on [−1, 1].
    expect(north / k).toBeCloseTo(0.5, 1);
    expect(band / k).toBeCloseTo(0.5, 1);
    // Cells drawn ∝ area: the share of draws on the face-centre cells matches their share of the area.
    const g = cubeGrid(16, R);
    const cells = Array.from({ length: g.cells }, (_, i) => i);
    let maxA = 0;
    for (const i of cells) maxA = Math.max(maxA, g.area(i));
    const inner = (i: number): boolean => {
      const x = i % 16;
      const y = Math.floor(i / 16) % 16;
      return x >= 4 && x < 12 && y >= 4 && y < 12;
    };
    let innerArea = 0;
    for (const i of cells) if (inner(i)) innerArea += g.area(i);
    let hits = 0;
    const m = 40000;
    for (let i = 0; i < m; i++) if (inner(pickWeighted(cells, (j) => g.area(j), maxA, rnd))) hits++;
    expect(hits / m).toBeCloseTo(innerArea / g.totalArea, 2);
    // The inner quarter of the cells holds more than a quarter of the area, so the weighting matters.
    expect(innerArea / g.totalArea).toBeGreaterThan(0.27);
  });

  it('great-circle distances, nearest neighbours, Clark–Evans and cluster disks on the sphere', () => {
    expect(geodesic([1, 0, 0], 0, [0, 1, 0], 0, R)).toBeCloseTo((Math.PI / 2) * R, 6);
    const a = unit(1, 0, 0);
    expect(geodesic(a, 0, along(a, [0, 0, 1], 10), 0, R)).toBeCloseTo(10, 6);
    const rnd = prng(5);
    const n = 3000;
    const pts = new Float64Array(3 * n);
    const d = new Float64Array(3);
    for (let i = 0; i < n; i++) {
      randomDir(rnd, d);
      pts.set(d, 3 * i);
    }
    const area = 4 * Math.PI * R * R;
    // Random points over the whole sphere: R ≈ 1 (a sphere has no edges to correct for).
    const ce = clarkEvansSphere(pts, area, R);
    expect(ce).toBeGreaterThan(0.95);
    expect(ce).toBeLessThan(1.05);
    const sub = pts.subarray(0, 3 * 400);
    const near = nearestNeighbours(sub, R);
    for (let i = 0; i < 400; i += 37) {
      let best = Infinity;
      for (let j = 0; j < 400; j++) if (j !== i) best = Math.min(best, geodesic(sub, 3 * i, sub, 3 * j, R));
      expect(near[i]).toBeCloseTo(best, 3);
    }
    // A Fibonacci lattice is regular; tight clusters are clustered.
    const fib = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      const z = 1 - (2 * i + 1) / n;
      const r = Math.sqrt(1 - z * z);
      const t = i * Math.PI * (3 - Math.sqrt(5));
      fib.set([r * Math.cos(t), r * Math.sin(t), z], 3 * i);
    }
    expect(clarkEvansSphere(fib, area, R)).toBeGreaterThan(1.8);
    const cl = new Float64Array(3 * 300);
    for (let c = 0; c < 10; c++) {
      randomDir(rnd, d);
      const ctr = Float64Array.from(d);
      for (let k = 0; k < 30; k++) cl.set(unit(ctr[0] + (rnd() - 0.5) * 0.01, ctr[1] + (rnd() - 0.5) * 0.01, ctr[2] + (rnd() - 0.5) * 0.01), 3 * (c * 30 + k));
    }
    expect(clarkEvansSphere(cl, area, R)).toBeLessThan(0.5);
    expect(maxInDisk(cl, 20e3, R)).toBeGreaterThanOrEqual(30);
    expect(Number.isNaN(clarkEvansSphere(new Float64Array(6), area, R))).toBe(true);
  });

  it('box counting over cube faces: a great circle ≈ 1, a filled cap ≈ 2', () => {
    const n = 128;
    const g = cubeGrid(n, R);
    const line = new Uint8Array(g.cells);
    for (let k = 0; k < 20000; k++) {
      const t = (2 * Math.PI * k) / 20000;
      line[dirToCell(Math.cos(t), Math.sin(t) * 0.8, Math.sin(t) * 0.6, n)] = 1;
    }
    expect(boxCountDimensionFaces(line, n)).toBeCloseTo(1, 1);
    const cap = new Uint8Array(g.cells);
    const p = new Float64Array(3);
    for (let i = 0; i < g.cells; i++) {
      g.position(i, p);
      if (p[2] > 0.2) cap[i] = 1;
    }
    expect(boxCountDimensionFaces(cap, n)).toBeCloseTo(2, 1);
  });

  it('sphere bands and per-world count ranges', () => {
    expect(SPHERE_BANDS.map((b) => b.id)).toEqual(['G', 'W', 'R', 'A', 'L']);
    expect(SPHERE_BANDS[1].scalesWithWorld).toBe(false);
    expect(BANDS.map((b) => b.id)).toEqual(['W', 'R', 'A', 'L']);
    const row = (k: string): CountTarget => COUNT_TARGETS.find((t) => t.key === k)!;
    const res = (id: string): [number, number] => (id === 'heroCount' ? [5, 8] : [3, 6]);
    // Per-land rows are unchanged; per-world counts scale with the planet's area.
    expect(sphereCountRange(row('peaks3k'), 2311, res)).toEqual(row('peaks3k').range);
    const v = sphereCountRange(row('volcanoes'), 2048, res);
    expect(v[0]).toBeCloseTo(32, 6);
    expect(v[1]).toBeCloseTo(100, 6);
    expect(sphereCountRange(row('heroes'), 2311, res)).toEqual([5, 8]);
    expect(sphereCountRange(row('majorRanges'), 2311, res)).toEqual([3, 6]);
    expect(sphereCountRange(row('greatRivers'), 2311, res)).toEqual(row('greatRivers').range);
  });
});

describe('metrics runner', () => {
  it('measures a tiny run (2 archetypes × 3 seeds, preview) and writes the report', async () => {
    const outDir = join(tmpdir(), `pwg-metrics-${process.pid}`);
    const r = await runSuite({
      archetypes: ['earth', 'archipelago'], seeds: 3, buildSeeds: 0, sizes: [], workers: 0, outDir, quiet: true, views: { land: 12, uniform: 6 },
    });
    expect(r.meta.failures).toEqual([]);
    expect(r.worlds).toHaveLength(6);
    expect(r.archetypes.map((a) => a.archetype)).toEqual(['earth', 'archipelago']);
    for (const w of r.worlds) {
      expect(w.landKm2).toBeGreaterThan(0);
      for (const b of BANDS) {
        const band = w.bands[b.id];
        expect(band.land.counts.length).toBeGreaterThan(0);
        expect(band.land.emptyKm.every((e) => Number.isNaN(e) || e >= 0)).toBe(true);
      }
      expect(w.bands.W.viewKm).toBe(1024);
      expect(w.targets.continentCount.got).toBeGreaterThanOrEqual(1);
      expect(w.geomorph.hortonRb).toBeGreaterThan(1);
      expect(w.query).toContain(`seed=${w.seed}`);
    }
    const html = readFileSync(join(outDir, 'report.html'), 'utf8');
    expect(html).toContain('<title>Density Metrics</title>');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('archipelago');
    expect(html).toContain('Band L');
    expect(existsSync(join(outDir, 'summary.md'))).toBe(true);
    expect(JSON.parse(readFileSync(join(outDir, 'metrics.json'), 'utf8')).worlds).toHaveLength(6);
  }, 120_000);

  it('measures a sphere (preview small planet) with bands G–L and true areas', async () => {
    const outDir = join(tmpdir(), `pwg-metrics-sphere-${process.pid}`);
    const r = await runSuite({
      shape: 'sphere', archetypes: ['earth'], seeds: 1, buildSeeds: 0, sizeSeeds: 0, workers: 0, outDir, quiet: true, views: { land: 8, uniform: 4 },
    });
    expect(r.meta.failures).toEqual([]);
    const w = r.worlds[0];
    expect(w.shape).toBe('sphere');
    expect(w.planetKm).toBe(4096);
    // The equal-area size √(4πR²) of the 4,096 km planet.
    expect(w.worldKm).toBeCloseTo(4096 / Math.sqrt(Math.PI), 6);
    expect(Object.keys(w.bands)).toEqual(['G', 'W', 'R', 'A', 'L']);
    expect(w.bands.W.viewKm).toBe(1024);
    expect(w.bands.G.viewKm).toBeCloseTo(4096 / Math.PI, 6);
    for (const id of ['G', 'W', 'R'] as const) {
      expect(w.bands[id].land.counts.length).toBeGreaterThan(0);
      expect(w.bands[id].land.counts.some((c) => c > 0)).toBe(true);
      expect(w.bands[id].land.landShare.every((s) => s >= 0.1)).toBe(true);
    }
    // Land area from true cell areas: a plausible share of the 5.3 M km² surface.
    const share = w.landKm2 / (4096 ** 2 / Math.PI);
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.6);
    expect(w.heroes.minSpacingFrac).toBeGreaterThan(0.2);
    expect(w.geomorph.coastD).toBeGreaterThan(0.9);
    expect(w.iceShare).toBeGreaterThanOrEqual(0);
    const html = readFileSync(join(outDir, 'report.html'), 'utf8');
    expect(html).toContain('Band G');
    expect(html).toContain('4096 km planet');
  }, 120_000);
});
