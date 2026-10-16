import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boxCountDimension, ccdfExponent, clarkEvans, coefVar, components, edtSquared, entropy, largestEmptyDisk, prng, quantileSorted, summarize,
} from '../metrics/lib/math';
import { runSuite } from '../metrics/runner';
import { BANDS } from '../metrics/targets';

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
});
