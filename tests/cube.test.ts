import { describe, expect, it } from 'vitest';
import { angle, cubeGrid, padFace, unitPositions, weightedQuantile, type CubeGrid } from '../src/gen/grid/cube';
import { distanceField } from '../src/gen/grid/distance';
import { coarser, finer } from '../src/gen/grid/grid';
import { boxBlur, components } from '../src/gen/grid/ops';
import { priorityFloodEpsilon } from '../src/gen/grid/priorityFlood';
import { downsample, gaussBlur, upsample } from '../src/gen/grid/smooth';
import { downsampleMean, upsampleBicubic } from '../src/gen/grid/upsample';
import { dirToCell, faceDir } from '../src/shared/cube';
import { hashBytes } from '../src/shared/hash';
import { Noise2 } from '../src/shared/noise';
import { Noise3, planarNoise } from '../src/shared/noise3';
import { Rng } from '../src/shared/rng';

const R = 652e3;

function neighbours(g: CubeGrid, i: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < 8; k++) {
    const j = g.nbr(i, k);
    if (j >= 0) out.push(j);
  }
  return out;
}

/** A smooth analytic field on the sphere: a few low-order terms of the unit vector. */
function analytic(g: CubeGrid): Float32Array {
  const p = unitPositions(g);
  return Float32Array.from({ length: g.cells }, (_, i) => {
    const x = p[i * 3];
    const y = p[i * 3 + 1];
    const z = p[i * 3 + 2];
    return 3 * x + 2 * y * z - z + x * y;
  });
}

describe('cubeGrid', () => {
  const g = cubeGrid(16, R);

  it('has six n² faces and nominal spacing (π/2)·R/n', () => {
    expect(g.shape).toBe('sphere');
    expect(g.faces).toBe(6);
    expect(g.cells).toBe(6 * 256);
    expect(g.cellM).toBeCloseTo(((Math.PI / 2) * R) / 16, 6);
    expect(g.uniform).toBe(false);
    expect(g.outlets).toBeNull();
    expect(g.hasOutside).toBe(false);
  });

  it('cell areas sum to 4πR² (closed-form solid angles)', () => {
    for (const n of [4, 16, 64, 256]) {
      const c = cubeGrid(n, R);
      let sum = 0;
      for (let i = 0; i < c.cells; i++) sum += c.area(i);
      expect(Math.abs(sum / (4 * Math.PI * R * R) - 1)).toBeLessThan(1e-9);
    }
    // Area spread of the equal-angle map: centre vs edge midpoint ≈ √2.
    let lo = Infinity;
    let hi = 0;
    for (const a of g.areaTable) {
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
    }
    expect(hi / lo).toBeGreaterThan(1.3);
    expect(hi / lo).toBeLessThan(1.5);
  });

  it('neighbours are symmetric, distinct and adjacent; corner cells have 7, all others 8', () => {
    for (const n of [4, 8, 16]) {
      const c = cubeGrid(n, R);
      let sevens = 0;
      for (let i = 0; i < c.cells; i++) {
        const nb = neighbours(c, i);
        expect(new Set(nb).size).toBe(nb.length);
        expect(nb).not.toContain(i);
        if (nb.length === 7) sevens++;
        else expect(nb.length).toBe(8);
        for (const j of nb) {
          expect(neighbours(c, j), `${i} ↔ ${j}`).toContain(i);
          expect(c.distance(i, j)).toBeLessThan(1.6 * c.cellM);
          expect(c.distance(i, j)).toBeGreaterThan(0.6 * c.cellM);
        }
      }
      expect(sevens).toBe(24);
    }
  });

  it('the seam table agrees with the direction of each neighbour', () => {
    // Moving one cell along a face axis and across a seam, the neighbour is the cell the extended
    // direction falls into.
    const p = new Float64Array(3);
    for (let i = 0; i < g.cells; i++) {
      if (!g.border[i]) continue;
      for (const k of [1, 3, 4, 6]) {
        const j = g.nbr(i, k);
        const f = Math.floor(i / g.n2);
        const r = i % g.n2;
        const x = (r % g.n) + [0, 0, 0, -1, 1, 0, 0, 0][k];
        const y = Math.floor(r / g.n) + [0, -1, 0, 0, 0, 0, 1, 0][k];
        faceDir(f, (x + 0.5) * g.delta - Math.PI / 4, (y + 0.5) * g.delta - Math.PI / 4, p);
        expect(dirToCell(p[0], p[1], p[2], g.n)).toBe(j);
      }
    }
  });

  it('is deterministic', () => {
    const a = cubeGrid(16, R);
    expect(hashBytes(a.seam)).toBe(hashBytes(g.seam));
    expect(hashBytes(a.distTable)).toBe(hashBytes(g.distTable));
  });

  it('dirToCell inverts cell positions', () => {
    const p = new Float64Array(3);
    for (let i = 0; i < g.cells; i++) {
      g.position(i, p);
      expect(dirToCell(p[0], p[1], p[2], g.n)).toBe(i);
      expect(g.locate(g.point(i))).toBe(i);
    }
  });

  it('coarser and finer keep the radius and face layout', () => {
    const c = coarser(g, 4) as CubeGrid;
    expect(c.shape).toBe('sphere');
    expect(c.n).toBe(4);
    expect(c.radiusM).toBe(R);
    expect((finer(c, 4) as CubeGrid).n).toBe(16);
    const a = analytic(g);
    const d = downsampleMean(a, g, 4);
    expect(d.length).toBe(c.cells);
    const e = downsample(a, g, 4);
    for (let i = 0; i < c.cells; i++) expect(e[i]).toBeCloseTo(d[i], 5);
  });
});

describe('cube-sphere algorithms', () => {
  const g = cubeGrid(32, R);

  it('a band round the equator is one 4-connected component', () => {
    const p = unitPositions(g);
    const mask = Uint8Array.from({ length: g.cells }, (_, i) => (Math.abs(p[i * 3 + 2]) < 0.1 ? 1 : 0));
    const { sizes } = components(mask, g);
    expect(sizes.length).toBe(1);
    // Two polar caps are two components; a cap that covers a cube corner is still one.
    const caps = Uint8Array.from({ length: g.cells }, (_, i) => (Math.abs(p[i * 3 + 2]) > 0.8 ? 1 : 0));
    expect(components(caps, g).sizes.length).toBe(2);
    const corner = Uint8Array.from({ length: g.cells }, (_, i) => (p[i * 3] + p[i * 3 + 1] + p[i * 3 + 2] > 1.6 ? 1 : 0));
    expect(components(corner, g).sizes.length).toBe(1);
  });

  it('Priority-Flood leaves every non-seed cell a strictly lower neighbour, across seams', () => {
    const rng = new Rng(3);
    const h = Float32Array.from({ length: g.cells }, () => rng.range(0, 1000));
    const seed = new Uint8Array(g.cells);
    for (let k = 0; k < 20; k++) seed[rng.int(g.cells)] = 1;
    const out = new Float32Array(g.cells);
    priorityFloodEpsilon(h, g, seed, out);
    for (let i = 0; i < g.cells; i++) {
      if (seed[i]) continue;
      expect(neighbours(g, i).some((j) => out[j] < out[i]), `cell ${i}`).toBe(true);
    }
  });

  it('distanceField matches the great-circle distance to the nearest source within half a cell', () => {
    const src = new Uint8Array(g.cells);
    const sources = [17, 3100, 5000, 6100];
    for (const s of sources) src[s] = 1;
    const { dist, nearest } = distanceField(src, g);
    const p = new Float64Array(3);
    const q = new Float64Array(3);
    for (let i = 0; i < g.cells; i++) {
      g.position(i, p);
      let best = Infinity;
      for (const s of sources) {
        g.position(s, q);
        best = Math.min(best, angle(p, q) / g.delta);
      }
      expect(Math.abs(dist[i] - best)).toBeLessThan(0.5);
      expect(sources).toContain(nearest[i]);
    }
  });

  it('distance fields are continuous across seams and corners', () => {
    const src = new Uint8Array(g.cells);
    src[100] = 1;
    const { dist } = distanceField(src, g);
    for (let i = 0; i < g.cells; i++) for (const j of neighbours(g, i)) expect(Math.abs(dist[i] - dist[j])).toBeLessThan(1.6);
  });

  it('padFace halos continue a smooth field across all edges and corners', () => {
    const a = analytic(g);
    const r = 3;
    const m = g.n + 2 * r;
    const buf = new Float32Array(m * m);
    const p = new Float64Array(3);
    // The halo is the neighbour face's cells; compare against the analytic value at the virtual cell.
    for (let f = 0; f < 6; f++) {
      padFace(g, a, f, r, buf);
      for (let y = 0; y < m; y++) {
        for (let x = 0; x < m; x++) {
          const cornerHalo = (x < r || x >= r + g.n) && (y < r || y >= r + g.n);
          faceDir(f, (x - r + 0.5) * g.delta - Math.PI / 4, (y - r + 0.5) * g.delta - Math.PI / 4, p);
          const want = 3 * p[0] + 2 * p[1] * p[2] - p[2] + p[0] * p[1];
          // Strips: within the field's change over ~a cell (the mirror cell is not at the virtual
          // position); corners are a fill and only need to be plausible.
          expect(Math.abs(buf[y * m + x] - want), `face ${f} (${x}, ${y})`).toBeLessThan(cornerHalo ? 1.2 : 0.5);
        }
      }
    }
  });

  it('blurs and resamplers have no seam artefacts on a smooth field', () => {
    const a = analytic(g);
    const step = (v: Float32Array, c: CubeGrid): number => {
      let s = 0;
      for (let i = 0; i < c.cells; i++) for (const j of neighbours(c, i)) s = Math.max(s, Math.abs(v[i] - v[j]));
      return s;
    };
    const base = step(a, g);
    const b = a.slice();
    boxBlur(b, g, 2, 2);
    expect(step(b, g)).toBeLessThan(1.2 * base);
    const c = a.slice();
    gaussBlur(c, g, 3);
    expect(step(c, g)).toBeLessThan(1.2 * base);
    const up = upsampleBicubic(a, g, 2);
    const fg = finer(g, 2) as CubeGrid;
    expect(step(up, fg)).toBeLessThan(0.75 * base);
    const lin = new Float32Array(fg.cells);
    upsample(a, g, 2, lin);
    expect(step(lin, fg)).toBeLessThan(0.75 * base);
    // Blurring keeps the mean (area-weighted, roughly).
    let m0 = 0;
    let m1 = 0;
    for (let i = 0; i < g.cells; i++) {
      m0 += a[i] * g.area(i);
      m1 += c[i] * g.area(i);
    }
    expect(Math.abs(m1 - m0) / g.totalArea).toBeLessThan(0.02);
  });

  it('the weighted quantile splits the surface by area', () => {
    const p = unitPositions(g);
    const z = Float32Array.from({ length: g.cells }, (_, i) => p[i * 3 + 2]);
    // Area below z = t on a sphere is (1 + t)/2 of the total.
    expect(weightedQuantile(z, g, 0.25)).toBeCloseTo(-0.5, 1);
    expect(weightedQuantile(z, g, 0.5)).toBeCloseTo(0, 1);
  });

  it('chart visits the cells within the radius with azimuthal-equidistant offsets', () => {
    const c = g.point(1000);
    const seen: number[] = [];
    g.chart(c, 5 * g.cellM, (i, e, nn) => {
      seen.push(i);
      expect(Math.abs(Math.hypot(e, nn) - g.distance(1000, i))).toBeLessThan(1e-6 * g.cellM);
    });
    let want = 0;
    for (let i = 0; i < g.cells; i++) if (g.distance(1000, i) <= 5 * g.cellM) want++;
    expect(seen.length).toBe(want);
    // A chart over a cube corner reaches all three faces.
    const corner = new Set<number>();
    g.chart(g.point(g.n - 1), 4 * g.cellM, (i) => corner.add(Math.floor(i / g.n2)));
    expect(corner.size).toBe(3);
  });
});

describe('Noise3', () => {
  it('is deterministic per seed and has no 256 period', () => {
    const a = new Noise3(7);
    const b = new Noise3(7);
    const c = new Noise3(8);
    let same = 0;
    let diff = 0;
    let periodic = 0;
    for (let k = 0; k < 500; k++) {
      const x = k * 0.731;
      const y = k * 1.37 - 40;
      const z = k * 0.291 + 3;
      expect(a.noise(x, y, z)).toBe(b.noise(x, y, z));
      if (a.noise(x, y, z) === c.noise(x, y, z)) same++;
      if (Math.abs(a.noise(x, y, z) - a.noise(x + 256, y, z)) < 1e-12) periodic++;
      diff++;
    }
    expect(same).toBeLessThan(diff / 10);
    expect(periodic).toBeLessThan(diff / 10);
  });

  it('has a spread comparable to Noise2 and stays in about [−1, 1]', () => {
    const n2 = new Noise2(5);
    const n3 = new Noise3(5);
    const rng = new Rng(1);
    let s2 = 0;
    let s3 = 0;
    let max = 0;
    for (let k = 0; k < 20000; k++) {
      const x = rng.range(0, 300);
      const y = rng.range(0, 300);
      const z = rng.range(0, 300);
      s2 += n2.fbm(x, y, 4) ** 2;
      const v = n3.fbm3(x, y, z, 4);
      s3 += v * v;
      max = Math.max(max, Math.abs(n3.noise(x, y, z)));
    }
    expect(Math.sqrt(s3 / s2)).toBeGreaterThan(0.85);
    expect(Math.sqrt(s3 / s2)).toBeLessThan(1.15);
    expect(max).toBeLessThan(1.25);
  });

  it('planarNoise forwards to Noise2 bit for bit', () => {
    const n = new Noise2(9);
    const p = planarNoise(n);
    expect(p.fbm3(1.3, 2.7, 99, 4)).toBe(n.fbm(1.3, 2.7, 4));
    expect(p.fbm3(1.3, 2.7, 99, 6, 2, 0.6)).toBe(n.fbm(1.3, 2.7, 6, 2, 0.6));
    expect(p.ridged3(-4.1, 0.2, 5, 3)).toBe(n.ridged(-4.1, 0.2, 3));
  });
});
