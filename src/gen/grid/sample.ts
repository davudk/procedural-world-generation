/** Sampling of world grids at positions given as fractions of the world [0, 1) (flat). */
import type { Grid } from './grid';

/** Index of the cell containing (u, v), clamped to the grid. */
export function cellAt(g: Grid, u: number, v: number): number {
  const n = g.n;
  const x = Math.min(n - 1, Math.max(0, Math.floor(u * n)));
  const y = Math.min(n - 1, Math.max(0, Math.floor(v * n)));
  return y * n + x;
}

/** Bilinear sample with cell-centred values and clamped edges. */
export function bilinear(a: Float32Array, g: Grid, u: number, v: number): number {
  const n = g.n;
  const fx = Math.min(n - 1, Math.max(0, u * n - 0.5));
  const fy = Math.min(n - 1, Math.max(0, v * n - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a0 = a[y0 * n + x0] + (a[y0 * n + x1] - a[y0 * n + x0]) * tx;
  const a1 = a[y1 * n + x0] + (a[y1 * n + x1] - a[y1 * n + x0]) * tx;
  return a0 + (a1 - a0) * ty;
}
