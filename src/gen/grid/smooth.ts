/**
 * Smoothing and resampling kernels for slowly varying fields (climate, biomes): an approximate
 * Gaussian blur, block-mean / bilinear resampling between grid resolutions and a domain warp. Rows
 * and columns are separable passes with clamped edges on the flat map; on the cube-sphere each face
 * runs the same kernels on a copy padded with a halo from its neighbour faces (`padFace`).
 */
import { asCube, padFace, type CubeGrid } from './cube';
import { coarser, type Grid } from './grid';

/**
 * In-place approximate Gaussian blur of standard deviation `sigmaCells`: three box passes per axis
 * (each pass of radius r adds r(r+1)/3 to the variance), edges clamped. Wide blurs run on a grid
 * downsampled by up to σ/4 and are bilinearly upsampled, which is indistinguishable for these smooth
 * climate fields and an order of magnitude cheaper. No-op below ~0.7 cells.
 */
export function gaussBlur(a: Float32Array, g: Grid, sigmaCells: number): void {
  if (g.faces !== 1) {
    gaussBlurCube(a, asCube(g), sigmaCells);
    return;
  }
  const n = g.n;
  let f = 1;
  while (sigmaCells / (f * 2) >= 4 && n % (f * 2) === 0 && n / (f * 2) >= 16) f *= 2;
  if (f === 1) {
    boxBlur3(a, n, sigmaCells);
    return;
  }
  const m = n / f;
  const c = downsample(a, g, f);
  boxBlur3(c, m, sigmaCells / f);
  upsample(c, coarser(g, f), f, a);
}

function gaussBlurCube(a: Float32Array, g: CubeGrid, sigmaCells: number): void {
  const n = g.n;
  let f = 1;
  while (sigmaCells / (f * 2) >= 4 && n % (f * 2) === 0 && n / (f * 2) >= 16) f *= 2;
  const cg = coarser(g, f) as CubeGrid;
  const c = f === 1 ? a : downsample(a, g, f);
  const s = sigmaCells / f;
  const r = Math.round((-1 + Math.sqrt(1 + 4 * s * s)) / 2);
  if (r >= 1) {
    const pad = 3 * r;
    const m = cg.n + 2 * pad;
    const src = c.slice();
    const buf = new Float32Array(m * m);
    for (let face = 0; face < 6; face++) {
      padFace(cg, src, face, pad, buf);
      boxBlur3(buf, m, s);
      for (let y = 0; y < cg.n; y++) c.set(buf.subarray((y + pad) * m + pad, (y + pad) * m + pad + cg.n), face * cg.n2 + y * cg.n);
    }
  }
  if (f !== 1) upsample(c, cg, f, a);
}

/** Block mean over f×f cells onto coarser(g, f) (n divisible by f; per face on the sphere). */
export function downsample(a: Float32Array, g: Grid, f: number): Float32Array {
  if (g.faces !== 1) {
    const n2 = g.n * g.n;
    const m2 = n2 / (f * f);
    const c = new Float32Array(g.faces * m2);
    for (let face = 0; face < g.faces; face++) c.set(downsampleSquare(a.subarray(face * n2, (face + 1) * n2), g.n, f), face * m2);
    return c;
  }
  return downsampleSquare(a, g.n, f);
}

function downsampleSquare(a: Float32Array, n: number, f: number): Float32Array {
  const m = n / f;
  const c = new Float32Array(m * m);
  for (let y = 0; y < n; y++) {
    const cr = Math.floor(y / f) * m;
    const row = y * n;
    for (let j = 0; j < m; j++) {
      let s = 0;
      const x0 = row + j * f;
      for (let k = 0; k < f; k++) s += a[x0 + k];
      c[cr + j] += s;
    }
  }
  const inv = 1 / (f * f);
  for (let i = 0; i < m * m; i++) c[i] *= inv;
  return c;
}

/** Bilinear upsampling of a block-mean field on `cg` by f into `out` on finer(cg, f) (cell centres aligned). */
export function upsample(c: Float32Array, cg: Grid, f: number, out: Float32Array): void {
  if (cg.faces !== 1) {
    upsampleCube(c, asCube(cg), f, out);
    return;
  }
  const m = cg.n;
  const n = m * f;
  const ix = new Int32Array(n);
  const tx = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    const u = Math.min(m - 1, Math.max(0, (x + 0.5) / f - 0.5));
    ix[x] = Math.min(m - 2, Math.floor(u));
    tx[x] = u - ix[x];
  }
  for (let y = 0; y < n; y++) {
    const j = ix[y];
    const ty = tx[y];
    const r0 = j * m;
    const r1 = r0 + m;
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const i = ix[x];
      const t = tx[x];
      const top = c[r0 + i] + t * (c[r0 + i + 1] - c[r0 + i]);
      const bot = c[r1 + i] + t * (c[r1 + i + 1] - c[r1 + i]);
      out[row + x] = top + ty * (bot - top);
    }
  }
}

/** Bilinear upsampling per face from a copy padded by one cell, so the seams interpolate across faces. */
function upsampleCube(c: Float32Array, cg: CubeGrid, f: number, out: Float32Array): void {
  const m = cg.n;
  const n = m * f;
  const p = m + 2;
  const buf = new Float32Array(p * p);
  const ix = new Int32Array(n);
  const tx = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    const u = (x + 0.5) / f - 0.5 + 1;
    ix[x] = Math.floor(u);
    tx[x] = u - ix[x];
  }
  for (let face = 0; face < 6; face++) {
    padFace(cg, c, face, 1, buf);
    const o = face * n * n;
    for (let y = 0; y < n; y++) {
      const r0 = ix[y] * p;
      const r1 = r0 + p;
      const ty = tx[y];
      const row = o + y * n;
      for (let x = 0; x < n; x++) {
        const i = ix[x];
        const t = tx[x];
        const top = buf[r0 + i] + t * (buf[r0 + i + 1] - buf[r0 + i]);
        const bot = buf[r1 + i] + t * (buf[r1 + i + 1] - buf[r1 + i]);
        out[row + x] = top + ty * (bot - top);
      }
    }
  }
}

function boxBlur3(a: Float32Array, n: number, sigma: number): void {
  const r = Math.round((-1 + Math.sqrt(1 + 4 * sigma * sigma)) / 2);
  if (r < 1) return;
  const t = new Float32Array(n * n);
  boxH(a, t, n, r);
  boxH(t, a, n, r);
  boxH(a, t, n, r);
  boxV(t, a, n, r);
  boxV(a, t, n, r);
  boxV(t, a, n, r);
}

function boxH(src: Float32Array, dst: Float32Array, n: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  const last = n - 1;
  for (let y = 0; y < n; y++) {
    const row = y * n;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(last, Math.max(0, k))];
    for (let x = 0; x < n; x++) {
      dst[row + x] = sum * inv;
      sum += src[row + Math.min(last, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, n: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  const last = n - 1;
  const sums = new Float64Array(n);
  for (let k = -r; k <= r; k++) {
    const row = Math.min(last, Math.max(0, k)) * n;
    for (let x = 0; x < n; x++) sums[x] += src[row + x];
  }
  for (let y = 0; y < n; y++) {
    const row = y * n;
    const add = Math.min(last, y + r + 1) * n;
    const rem = Math.max(0, y - r) * n;
    for (let x = 0; x < n; x++) {
      dst[row + x] = sums[x] * inv;
      sums[x] += src[add + x] - src[rem + x];
    }
  }
}

/**
 * Domain warp: out(x, y) = a(x + dx, y + dy), bilinear, edges clamped; dx, dy in cells. Used to
 * bend the straight isolines that uniform winds leave in advected fields.
 */
export function warp(a: Float32Array, g: Grid, dx: Float32Array, dy: Float32Array): Float32Array {
  if (g.faces !== 1) return warpCube(a, asCube(g), dx, dy);
  const n = g.n;
  const out = new Float32Array(n * n);
  const last = n - 1;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const u = Math.min(last, Math.max(0, x + dx[i]));
      const v = Math.min(last, Math.max(0, y + dy[i]));
      const x0 = Math.min(last - 1, Math.floor(u));
      const y0 = Math.min(last - 1, Math.floor(v));
      const tx = u - x0;
      const ty = v - y0;
      const r = y0 * n + x0;
      const top = a[r] + tx * (a[r + 1] - a[r]);
      const bot = a[r + n] + tx * (a[r + n + 1] - a[r + n]);
      out[i] = top + ty * (bot - top);
    }
  }
  return out;
}

/** Domain warp per face from a copy padded by the largest displacement (displacements in face axes). */
function warpCube(a: Float32Array, g: CubeGrid, dx: Float32Array, dy: Float32Array): Float32Array {
  const n = g.n;
  let dmax = 0;
  for (let i = 0; i < g.cells; i++) dmax = Math.max(dmax, Math.abs(dx[i]), Math.abs(dy[i]));
  const r = Math.min(n, Math.ceil(dmax) + 1);
  const m = n + 2 * r;
  const buf = new Float32Array(m * m);
  const out = new Float32Array(g.cells);
  const last = m - 1;
  for (let f = 0; f < 6; f++) {
    padFace(g, a, f, r, buf);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = f * g.n2 + y * n + x;
        const u = Math.min(last, Math.max(0, x + r + dx[i]));
        const v = Math.min(last, Math.max(0, y + r + dy[i]));
        const x0 = Math.min(last - 1, Math.floor(u));
        const y0 = Math.min(last - 1, Math.floor(v));
        const tx = u - x0;
        const ty = v - y0;
        const q = y0 * m + x0;
        const top = buf[q] + tx * (buf[q + 1] - buf[q]);
        const bot = buf[q + m] + tx * (buf[q + m + 1] - buf[q + m]);
        out[i] = top + ty * (bot - top);
      }
    }
  }
  return out;
}
