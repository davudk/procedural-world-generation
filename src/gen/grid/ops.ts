/** Small raster operations on world grids. */
import type { Grid } from './grid';

/** In-place separable box blur with radius `r` cells (edges clamp). O(n) per pass. */
export function boxBlur(a: Float32Array, g: Grid, r: number, passes = 1): void {
  if (r < 1) return;
  const n = g.n;
  const tmp = new Float32Array(n);
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < n; y++) blurLine(a, y * n, 1, n, r, inv, tmp);
    for (let x = 0; x < n; x++) blurLine(a, x, n, n, r, inv, tmp);
  }
}

function blurLine(a: Float32Array, start: number, stride: number, n: number, r: number, inv: number, tmp: Float32Array): void {
  const at = (i: number): number => a[start + Math.min(n - 1, Math.max(0, i)) * stride];
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += at(i);
  for (let i = 0; i < n; i++) {
    tmp[i] = sum * inv;
    sum += at(i + r + 1) - at(i - r);
  }
  for (let i = 0; i < n; i++) a[start + i * stride] = tmp[i];
}

/** Value below which a fraction `q` of the cells lie. */
export function quantile(a: Float32Array, q: number): number {
  const s = a.slice().sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

/**
 * Labels 4-connected components of cells where `mask` is non-zero. Returns labels (−1 outside the
 * mask) and the size of each component.
 */
export function components(mask: Uint8Array, g: Grid): { label: Int32Array; sizes: number[] } {
  const { cells, off4, border, axialToRaster } = g;
  const label = new Int32Array(cells).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(cells);
  for (let s = 0; s < cells; s++) {
    if (!mask[s] || label[s] !== -1) continue;
    const id = sizes.length;
    let top = 0;
    let size = 0;
    stack[top++] = s;
    label[s] = id;
    while (top > 0) {
      const c = stack[--top];
      size++;
      const b = border[c];
      for (let k = 0; k < 4; k++) {
        const j = b === 0 ? c + off4[k] : g.nbr(c, axialToRaster[k]);
        if (j >= 0 && mask[j] && label[j] === -1) (label[j] = id), (stack[top++] = j);
      }
    }
    sizes.push(size);
  }
  return { label, sizes };
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Two-pass 3-4 chamfer distance (in cells, ≈ Euclidean within ~8 %) to the nearest cell where
 * `source` is non-zero. O(n), for fields where approximate distance is fine (e.g. coast distance).
 */
export function chamferDistance(source: Uint8Array, g: Grid): Float32Array {
  const n = g.n;
  const INF = 1e9;
  const d = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) d[i] = source[i] ? 0 : INF;
  const a = 1;
  const b = 1.4;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - n] + a);
        if (x > 0) v = Math.min(v, d[i - n - 1] + b);
        if (x < n - 1) v = Math.min(v, d[i - n + 1] + b);
      }
      d[i] = v;
    }
  }
  for (let y = n - 1; y >= 0; y--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = y * n + x;
      let v = d[i];
      if (x < n - 1) v = Math.min(v, d[i + 1] + a);
      if (y < n - 1) {
        v = Math.min(v, d[i + n] + a);
        if (x < n - 1) v = Math.min(v, d[i + n + 1] + b);
        if (x > 0) v = Math.min(v, d[i + n - 1] + b);
      }
      d[i] = v;
    }
  }
  return d;
}
