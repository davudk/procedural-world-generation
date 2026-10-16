/**
 * Pure numeric helpers for the density metrics (research 05 §3.2, §3.3, §5): quantiles, entropy,
 * coefficient of variation, exact Euclidean distance transform, largest empty disk, Clark–Evans,
 * power-law (Pareto / Korčák) exponents, box-counting dimension, connected components.
 * No pipeline imports: these are unit-tested on synthetic inputs in tests/metrics.test.ts.
 */

/** Linear-interpolated quantile of an ascending-sorted array (NaN when empty). */
export function quantileSorted(s: ArrayLike<number>, q: number): number {
  const n = s.length;
  if (n === 0) return NaN;
  const p = Math.min(1, Math.max(0, q)) * (n - 1);
  const i = Math.floor(p);
  const f = p - i;
  return i + 1 < n ? s[i] * (1 - f) + s[i + 1] * f : s[i];
}

export interface Summary {
  n: number;
  mean: number;
  min: number;
  p5: number;
  p50: number;
  p95: number;
  max: number;
}

/** Summary of the finite values in `xs`. */
export function summarize(xs: readonly number[]): Summary {
  const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN;
  return {
    n: s.length, mean, min: s.length ? s[0] : NaN, p5: quantileSorted(s, 0.05), p50: quantileSorted(s, 0.5),
    p95: quantileSorted(s, 0.95), max: s.length ? s[s.length - 1] : NaN,
  };
}

/** Shannon entropy (nats) of a histogram. */
export function entropy(counts: Iterable<number>): number {
  let tot = 0;
  const cs: number[] = [];
  for (const c of counts) {
    if (c > 0) {
      cs.push(c);
      tot += c;
    }
  }
  if (tot === 0) return 0;
  let h = 0;
  for (const c of cs) h -= (c / tot) * Math.log(c / tot);
  return h;
}

/** Coefficient of variation (population sd / mean); NaN when the mean is 0. */
export function coefVar(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (m === 0) return NaN;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(v) / m;
}

const INF = 1e20;

/** 1-D squared distance transform of a sampled function (Felzenszwalb & Huttenlocher 2012). */
function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

/**
 * Exact squared Euclidean distance (pixels²) from every pixel to the nearest non-zero pixel of
 * `feature` (w×h, row-major). Pixels are ≥ 1e20 when there is no feature at all.
 */
export function edtSquared(feature: Uint8Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = feature[i] ? 0 : INF;
  const m = Math.max(w, h);
  const f = new Float64Array(m);
  const d = new Float64Array(m);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    dt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    dt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}

/**
 * Radius (pixels) of the largest disk centred on a `valid` pixel that contains no feature pixel:
 * max over valid pixels of the distance to the nearest feature. With no features at all the
 * result is the raster diagonal (an upper bound). 0 when no pixel is valid.
 */
export function largestEmptyDisk(feature: Uint8Array, valid: Uint8Array, w: number, h: number): number {
  const d2 = edtSquared(feature, w, h);
  let best = -1;
  for (let i = 0; i < w * h; i++) if (valid[i] && d2[i] > best) best = d2[i];
  if (best < 0) return 0;
  return Math.min(Math.sqrt(best), Math.hypot(w, h));
}

/**
 * Clark–Evans aggregation ratio R = mean nearest-neighbour distance / (0.5 / √density), with
 * density = n / area (no edge correction). R ≈ 1 random, < 1 clustered, > 1 regular. NaN for n < 3.
 */
export function clarkEvans(xs: ArrayLike<number>, ys: ArrayLike<number>, area: number): number {
  const n = xs.length;
  if (n < 3 || !(area > 0)) return NaN;
  // Grid bucketing keeps this ~O(n) for the few thousand points we see.
  const cell = Math.sqrt(area / n) * 2;
  const buckets = new Map<string, number[]>();
  const key = (i: number, j: number): string => `${i},${j}`;
  for (let k = 0; k < n; k++) {
    const kk = key(Math.floor(xs[k] / cell), Math.floor(ys[k] / cell));
    const b = buckets.get(kk);
    if (b) b.push(k);
    else buckets.set(kk, [k]);
  }
  let sum = 0;
  for (let k = 0; k < n; k++) {
    const ci = Math.floor(xs[k] / cell);
    const cj = Math.floor(ys[k] / cell);
    let best = Infinity;
    for (let r = 1; r < 1e6; r++) {
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          const b = buckets.get(key(i, j));
          if (!b) continue;
          for (const o of b) {
            if (o === k) continue;
            const d = Math.hypot(xs[o] - xs[k], ys[o] - ys[k]);
            if (d < best) best = d;
          }
        }
      }
      // Any point outside the searched square is at least r·cell away.
      if (best <= r * cell) break;
    }
    sum += best;
  }
  const expected = 0.5 / Math.sqrt(n / area);
  return sum / n / expected;
}

/** Least-squares slope and intercept of y on x (NaN when underdetermined). */
export function fitLine(xs: readonly number[], ys: readonly number[]): { slope: number; intercept: number } {
  const k = xs.length;
  if (k < 2) return { slope: NaN, intercept: NaN };
  const mx = xs.reduce((a, b) => a + b, 0) / k;
  const my = ys.reduce((a, b) => a + b, 0) / k;
  let num = 0;
  let den = 0;
  for (let i = 0; i < k; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den > 0 ? num / den : NaN;
  return { slope, intercept: my - slope * mx };
}

/**
 * Power-law exponent b of a size–frequency distribution N(≥A) ∝ A^−b (Korčák for islands, Pareto
 * for lakes): least squares of log rank on log size over sizes ≥ `minSize`. NaN for fewer than
 * `minCount` sizes or when all sizes are equal.
 */
export function ccdfExponent(sizes: readonly number[], minSize: number, minCount = 6): { b: number; n: number } {
  const s = sizes.filter((a) => a >= minSize).sort((a, b) => b - a);
  if (s.length < minCount) return { b: NaN, n: s.length };
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < s.length; i++) {
    // Ties share the largest rank so a quantised size counts all its members.
    if (i + 1 < s.length && s[i + 1] === s[i]) continue;
    xs.push(Math.log(s[i]));
    ys.push(Math.log(i + 1));
  }
  if (xs.length < 3) return { b: NaN, n: s.length };
  return { b: -fitLine(xs, ys).slope, n: s.length };
}

/**
 * Box-counting dimension of the set pixels of an n×n mask: slope of log N(s) on log(1/s) for box
 * sizes s = 1, 2, 4, … up to n / `maxDiv`.
 */
export function boxCountDimension(mask: Uint8Array, n: number, maxDiv = 8): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let s = 1; s <= n / maxDiv; s *= 2) {
    const m = Math.ceil(n / s);
    const hit = new Uint8Array(m * m);
    let count = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!mask[y * n + x]) continue;
        const k = Math.floor(y / s) * m + Math.floor(x / s);
        if (!hit[k]) {
          hit[k] = 1;
          count++;
        }
      }
    }
    if (count === 0) return NaN;
    xs.push(Math.log(1 / s));
    ys.push(Math.log(count));
  }
  return fitLine(xs, ys).slope;
}

/** 4-connected components of the set pixels; label −1 for unset pixels. */
export function components(mask: Uint8Array, w: number, h: number): { label: Int32Array; sizes: number[] } {
  const label = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = sizes.length;
    let size = 0;
    label[s] = id;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const x = c % w;
      const y = (c - x) / w;
      const nb = [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, y > 0 ? c - w : -1, y < h - 1 ? c + w : -1];
      for (const o of nb) {
        if (o >= 0 && mask[o] && label[o] < 0) {
          label[o] = id;
          stack.push(o);
        }
      }
    }
    sizes.push(size);
  }
  return { label, sizes };
}

/** Sets the pixels of a line segment (pixel coordinates, DDA). */
export function rasterLine(mask: Uint8Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.floor(x0 + (x1 - x0) * t);
    const y = Math.floor(y0 + (y1 - y0) * t);
    if (x >= 0 && y >= 0 && x < w && y < h) mask[y * w + x] = 1;
  }
}

/** Sets the pixels of a filled disk (pixel coordinates); always at least the centre pixel. */
export function rasterDisk(mask: Uint8Array, w: number, h: number, cx: number, cy: number, r: number): void {
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(w - 1, Math.floor(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(h - 1, Math.floor(cy + r));
  const ix = Math.floor(cx);
  const iy = Math.floor(cy);
  if (ix >= 0 && iy >= 0 && ix < w && iy < h) mask[iy * w + ix] = 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) mask[y * w + x] = 1;
  }
}

/** Small deterministic PRNG (mulberry32) for viewport sampling. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
