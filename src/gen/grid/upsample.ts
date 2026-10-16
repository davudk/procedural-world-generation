/** Resampling between grid resolutions (cell-centred: cell i covers [i, i+1) and samples at i + ½). */
import type { Grid } from './grid';

/** Catmull-Rom weights for the four taps at offsets −1, 0, 1, 2 from floor(x), fraction t. */
function catmullRom(t: number, w: Float64Array, o: number): void {
  const t2 = t * t;
  const t3 = t2 * t;
  w[o] = 0.5 * (-t3 + 2 * t2 - t);
  w[o + 1] = 0.5 * (3 * t3 - 5 * t2 + 2);
  w[o + 2] = 0.5 * (-3 * t3 + 4 * t2 + t);
  w[o + 3] = 0.5 * (t3 - t2);
}

/**
 * Bicubic (Catmull-Rom) upsample of a field on `g` to `finer(g, factor)`, cell-centred, edges
 * clamped. The kernel interpolates, so it can overshoot slightly near sharp steps.
 */
export function upsampleBicubic(src: Float32Array, g: Grid, factor: 2): Float32Array {
  const n = g.n;
  const m = n * factor;
  // Destination cell X samples source coordinate (X + ½)/factor − ½; precompute taps and weights per axis.
  const base = new Int32Array(m * 4);
  const w = new Float64Array(m * 4);
  for (let X = 0; X < m; X++) {
    const s = (X + 0.5) / factor - 0.5;
    const f = Math.floor(s);
    catmullRom(s - f, w, X * 4);
    for (let k = 0; k < 4; k++) base[X * 4 + k] = Math.min(n - 1, Math.max(0, f - 1 + k));
  }
  // Separable: rows first into a n×m buffer, then columns.
  const rows = new Float64Array(n * m);
  for (let y = 0; y < n; y++) {
    const r = y * n;
    for (let X = 0; X < m; X++) {
      const o = X * 4;
      rows[y * m + X] =
        w[o] * src[r + base[o]] + w[o + 1] * src[r + base[o + 1]] + w[o + 2] * src[r + base[o + 2]] + w[o + 3] * src[r + base[o + 3]];
    }
  }
  const dst = new Float32Array(m * m);
  for (let Y = 0; Y < m; Y++) {
    const o = Y * 4;
    const r0 = base[o] * m;
    const r1 = base[o + 1] * m;
    const r2 = base[o + 2] * m;
    const r3 = base[o + 3] * m;
    const w0 = w[o];
    const w1 = w[o + 1];
    const w2 = w[o + 2];
    const w3 = w[o + 3];
    for (let X = 0; X < m; X++) dst[Y * m + X] = w0 * rows[r0 + X] + w1 * rows[r1 + X] + w2 * rows[r2 + X] + w3 * rows[r3 + X];
  }
  return dst;
}

/** Box-filter downsample of a field on `g` to `coarser(g, factor)` (factor must divide n). */
export function downsampleMean(src: Float32Array, g: Grid, factor: number): Float32Array {
  const n = g.n;
  if (n % factor !== 0) throw new Error(`downsampleMean: ${factor} does not divide ${n}`);
  const m = n / factor;
  const dst = new Float32Array(m * m);
  const inv = 1 / (factor * factor);
  for (let Y = 0; Y < m; Y++) {
    for (let X = 0; X < m; X++) {
      let s = 0;
      for (let dy = 0; dy < factor; dy++) {
        const r = (Y * factor + dy) * n + X * factor;
        for (let dx = 0; dx < factor; dx++) s += src[r + dx];
      }
      dst[Y * m + X] = s * inv;
    }
  }
  return dst;
}
