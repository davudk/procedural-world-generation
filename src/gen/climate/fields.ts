import type { Noise2 } from '../../shared/noise';

/**
 * In-place approximate Gaussian blur of standard deviation `sigmaCells`: three box passes per axis
 * (each pass of radius r adds r(r+1)/3 to the variance), edges clamped. Wide blurs run on a grid
 * downsampled by up to σ/4 and are bilinearly upsampled, which is indistinguishable for these smooth
 * climate fields and an order of magnitude cheaper. No-op below ~0.7 cells.
 */
export function gaussBlur(a: Float32Array, n: number, sigmaCells: number): void {
  let f = 1;
  while (sigmaCells / (f * 2) >= 4 && n % (f * 2) === 0 && n / (f * 2) >= 16) f *= 2;
  if (f === 1) {
    boxBlur3(a, n, sigmaCells);
    return;
  }
  const m = n / f;
  const c = downsample(a, n, f);
  boxBlur3(c, m, sigmaCells / f);
  upsample(c, m, f, a);
}

/** Block mean over f×f cells (n divisible by f). */
export function downsample(a: Float32Array, n: number, f: number): Float32Array {
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

/** Bilinear upsampling of an m×m block-mean grid by f into `out` (cell centres aligned). */
export function upsample(c: Float32Array, m: number, f: number, out: Float32Array): void {
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
 * fBm sampled on a coarse lattice (step = wavelength / perWave) and bilinearly interpolated onto the
 * n×n grid. The climate noises are all ≥ 20 km features, so this costs a few thousand noise calls
 * instead of n² per field.
 */
export function coarseFbm(
  noise: Noise2,
  n: number,
  cellKm: number,
  wavelengthKm: number,
  octaves: number,
  offset: number,
  perWave = 8,
): Float32Array {
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
    for (let x = 0; x < n; x++) {
      const fx = (x + 0.5) * k;
      const i = Math.floor(fx);
      const tx = fx - i;
      const r0 = j * m + i;
      const r1 = r0 + m;
      const a = lat[r0] + tx * (lat[r0 + 1] - lat[r0]);
      const b = lat[r1] + tx * (lat[r1 + 1] - lat[r1]);
      out[y * n + x] = a + ty * (b - a);
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

/**
 * Domain warp: out(x, y) = a(x + dx, y + dy), bilinear, edges clamped; dx, dy in cells. Used to
 * bend the straight isolines that uniform winds leave in advected fields.
 */
export function warp(a: Float32Array, n: number, dx: Float32Array, dy: Float32Array): Float32Array {
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
