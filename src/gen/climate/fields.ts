import type { Noise2 } from '../../shared/noise';
import type { Noise3 } from '../../shared/noise3';
import { asCube, unitPositions, type CubeGrid } from '../grid/cube';
import { cellIndex, coarser, type Grid } from '../grid/grid';
import { upsample } from '../grid/smooth';

/**
 * fBm sampled on a coarse lattice (step = wavelength / perWave) and bilinearly interpolated onto the
 * grid. The climate noises are all ≥ 20 km features, so this costs a few thousand noise calls
 * instead of n² per field. On the sphere (Noise3) the lattice is the coarsest cube grid whose cells
 * are no larger than the step, sampled at unit·R.
 */
export function coarseFbm(
  noise: Noise2 | Noise3,
  g: Grid,
  wavelengthKm: number,
  octaves: number,
  offset: number,
  perWave = 8,
): Float32Array {
  if (g.shape === 'sphere') return coarseFbmCube(noise as Noise3, asCube(g), wavelengthKm, octaves, offset, perWave);
  return coarseFbmFlat(noise as Noise2, g, wavelengthKm, octaves, offset, perWave);
}

function coarseFbmCube(noise: Noise3, g: CubeGrid, wavelengthKm: number, octaves: number, offset: number, perWave: number): Float32Array {
  const stepKm = Math.max(g.cellKm, wavelengthKm / perWave);
  let f = 1;
  while (f * 2 * g.cellKm <= stepKm && g.n % (f * 2) === 0 && g.n / (f * 2) >= 4) f *= 2;
  const cg = coarser(g, f) as CubeGrid;
  const p = unitPositions(cg);
  const k = cg.radiusM / 1000 / wavelengthKm;
  const c = new Float32Array(cg.cells);
  for (let i = 0; i < cg.cells; i++) c[i] = noise.fbm3(p[i * 3] * k + offset, p[i * 3 + 1] * k - offset, p[i * 3 + 2] * k + offset, octaves);
  if (f === 1) return c;
  const out = new Float32Array(g.cells);
  upsample(c, cg, f, out);
  return out;
}

function coarseFbmFlat(noise: Noise2, g: Grid, wavelengthKm: number, octaves: number, offset: number, perWave: number): Float32Array {
  const { n, cellKm } = g;
  const stepKm = Math.max(cellKm, wavelengthKm / perWave);
  const m = Math.ceil((n * cellKm) / stepKm) + 2;
  const lat = new Float32Array(m * m);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) lat[j * m + i] = noise.fbm((i * stepKm) / wavelengthKm + offset, (j * stepKm) / wavelengthKm - offset, octaves);
  }
  const out = new Float32Array(n * n);
  const k = cellKm / stepKm;
  for (let y = 0; y < n; y++) {
    const fy = (y + 0.5) * k;
    const j = Math.floor(fy);
    const ty = fy - j;
    const row = cellIndex(g, 0, y);
    for (let x = 0; x < n; x++) {
      const fx = (x + 0.5) * k;
      const i = Math.floor(fx);
      const tx = fx - i;
      const r0 = j * m + i;
      const r1 = r0 + m;
      const a = lat[r0] + tx * (lat[r0 + 1] - lat[r0]);
      const b = lat[r1] + tx * (lat[r1 + 1] - lat[r1]);
      out[row + x] = a + ty * (b - a);
    }
  }
  return out;
}

/** exp(−x) for x ≥ 0, with a cubic Taylor shortcut for the tiny per-cell decay exponents. */
export function expNeg(x: number): number {
  return x < 0.02 ? 1 - x * (1 - x * (0.5 - x / 6)) : Math.exp(-x);
}

export function minMax(a: Float32Array, skip?: Uint8Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < a.length; i++) {
    if (skip?.[i]) continue;
    const v = a[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Number.isFinite(lo) ? [lo, hi] : [0, 0];
}
