import type { Rng } from '../../../shared/rng';

/** 8-neighbourhood offsets: the first four are the 4-neighbours. */
export const DX8 = [1, -1, 0, 0, 1, 1, -1, -1] as const;
export const DY8 = [0, 0, 1, -1, 1, -1, 1, -1] as const;

/**
 * Two-pass chamfer distance (cells, 1 / 1.4 weights) to the nearest source cell, carrying the index
 * of that source. O(n²); approximate nearest (good to about a cell), which is all the coastal bands need.
 */
export function chamferNearest(source: Uint8Array, n: number): { dist: Float32Array; nearest: Int32Array } {
  const N = n * n;
  const d = new Float32Array(N);
  const near = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (source[i]) {
      d[i] = 0;
      near[i] = i;
    } else {
      d[i] = 1e9;
      near[i] = -1;
    }
  }
  // Forward pass (W, NW, N, NE), then backward pass (E, SE, S, SW); relaxations inlined.
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      let best = d[i];
      let src = near[i];
      if (x > 0 && d[i - 1] + 1 < best) {
        best = d[i - 1] + 1;
        src = near[i - 1];
      }
      if (y > 0) {
        if (d[i - n] + 1 < best) {
          best = d[i - n] + 1;
          src = near[i - n];
        }
        if (x > 0 && d[i - n - 1] + 1.4 < best) {
          best = d[i - n - 1] + 1.4;
          src = near[i - n - 1];
        }
        if (x < n - 1 && d[i - n + 1] + 1.4 < best) {
          best = d[i - n + 1] + 1.4;
          src = near[i - n + 1];
        }
      }
      d[i] = best;
      near[i] = src;
    }
  }
  for (let y = n - 1; y >= 0; y--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = y * n + x;
      let best = d[i];
      let src = near[i];
      if (x < n - 1 && d[i + 1] + 1 < best) {
        best = d[i + 1] + 1;
        src = near[i + 1];
      }
      if (y < n - 1) {
        if (d[i + n] + 1 < best) {
          best = d[i + n] + 1;
          src = near[i + n];
        }
        if (x < n - 1 && d[i + n + 1] + 1.4 < best) {
          best = d[i + n + 1] + 1.4;
          src = near[i + n + 1];
        }
        if (x > 0 && d[i + n - 1] + 1.4 < best) {
          best = d[i + n - 1] + 1.4;
          src = near[i + n - 1];
        }
      }
      d[i] = best;
      near[i] = src;
    }
  }
  return { dist: d, nearest: near };
}

/** Labels 8-connected components of non-zero `mask` cells; −1 outside. Returns labels and sizes. */
export function components8(mask: Uint8Array, n: number): { label: Int32Array; sizes: number[] } {
  const N = n * n;
  const label = new Int32Array(N).fill(-1);
  const sizes: number[] = [];
  const stack = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (!mask[s] || label[s] !== -1) continue;
    const id = sizes.length;
    let top = 0;
    let size = 0;
    stack[top++] = s;
    label[s] = id;
    while (top > 0) {
      const c = stack[--top];
      size++;
      const x = c % n;
      const y = (c - x) / n;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX8[k];
        const ny = y + DY8[k];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (mask[j] && label[j] === -1) {
          label[j] = id;
          stack[top++] = j;
        }
      }
    }
    sizes.push(size);
  }
  return { label, sizes };
}

/**
 * Labels the 8-connected components of `mask` that contain the cells in `list` (all of `mask` must be
 * reachable from `list`), writing ids into `label` (which must be −1 on those cells). Touches only
 * the listed components, so it costs O(list) instead of O(n²). Returns the component sizes.
 */
export function labelList(list: readonly number[], mask: Uint8Array, n: number, label: Int32Array): number[] {
  const sizes: number[] = [];
  const stack: number[] = [];
  const dx = DX8;
  const dy = DY8;
  for (const s of list) {
    if (!mask[s] || label[s] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const x = c % n;
      const y = (c - x) / n;
      for (let k = 0; k < 8; k++) {
        const nx = x + dx[k];
        const ny = y + dy[k];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (mask[j] && label[j] === -1) {
          label[j] = id;
          stack.push(j);
        }
      }
    }
    sizes.push(size);
  }
  return sizes;
}

/** Poisson-distributed integer with mean `lambda` (Knuth below 30, rounded normal above). */
export function poisson(rng: Rng, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) {
    const u = Math.max(1e-12, rng.float());
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.float());
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
  }
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.float();
  } while (p > L);
  return k - 1;
}

/** In-place Fisher–Yates shuffle. */
export function shuffle<T>(rng: Rng, a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

/** Spatial hash for Poisson-disk rejection of point sets (positions in km). */
export class DiskSet {
  private readonly cells = new Map<number, { x: number; y: number }[]>();
  constructor(private readonly r: number) {}

  private key(gx: number, gy: number): number {
    return gx * 73856093 + gy * 19349663;
  }

  /** True if no stored point lies within the radius (optionally a different one) of (x, y). */
  free(x: number, y: number, r = this.r): boolean {
    const gx = Math.floor(x / this.r);
    const gy = Math.floor(y / this.r);
    const reach = Math.ceil(r / this.r);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const list = this.cells.get(this.key(gx + dx, gy + dy));
        if (!list) continue;
        for (const p of list) if ((p.x - x) ** 2 + (p.y - y) ** 2 < r * r) return false;
      }
    }
    return true;
  }

  add(x: number, y: number): void {
    const k = this.key(Math.floor(x / this.r), Math.floor(y / this.r));
    const list = this.cells.get(k);
    if (list) list.push({ x, y });
    else this.cells.set(k, [{ x, y }]);
  }
}

/** Cells on the 4-connected digital line from a to b (inclusive), so water or land cannot leak diagonally. */
export function line4(n: number, a: number, b: number): number[] {
  let x = a % n;
  let y = (a - x) / n;
  const x1 = b % n;
  const y1 = (b - x1) / n;
  const out = [a];
  const sx = Math.sign(x1 - x);
  const sy = Math.sign(y1 - y);
  const dx = Math.abs(x1 - x);
  const dy = Math.abs(y1 - y);
  let ex = 0;
  let ey = 0;
  // Step along whichever axis lags its share of the line most.
  while (x !== x1 || y !== y1) {
    if (x !== x1 && (y === y1 || (ex + 1) * dy <= (ey + 1) * dx)) {
      x += sx;
      ex++;
    } else {
      y += sy;
      ey++;
    }
    out.push(y * n + x);
  }
  return out;
}

/**
 * Smooths per-cell values given on a list of cells (e.g. the coast) over coarse blocks: the weighted
 * block means, box-blurred over `r` blocks, read back per listed cell. O(list + (n / block)²).
 */
export function blockMeanList(
  cells: Int32Array, val: Float32Array, w: Uint8Array | null, n: number, block: number, r: number,
): Float32Array {
  const m = Math.ceil(n / block);
  const sv = new Float32Array(m * m);
  const sw = new Float32Array(m * m);
  const bOf = new Int32Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const x = i % n;
    const y = (i - x) / n;
    const b = Math.floor(y / block) * m + Math.floor(x / block);
    bOf[k] = b;
    const wk = w ? w[k] : 1;
    if (wk <= 0) continue;
    sv[b] += val[k] * wk;
    sw[b] += wk;
  }
  boxBlurSmall(sv, m, r);
  boxBlurSmall(sw, m, r);
  const out = new Float32Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    const b = bOf[k];
    out[k] = sw[b] > 1e-6 ? sv[b] / sw[b] : val[k];
  }
  return out;
}

/** Separable box blur (radius r, zero outside) on a small square grid. */
function boxBlurSmall(a: Float32Array, m: number, r: number): void {
  if (r < 1) return;
  const tmp = new Float32Array(m);
  for (let pass = 0; pass < 2; pass++) {
    for (let line = 0; line < m; line++) {
      const at = (k: number): number => (pass === 0 ? a[line * m + k] : a[k * m + line]);
      let s = 0;
      for (let k = 0; k <= Math.min(m - 1, r); k++) s += at(k);
      for (let k = 0; k < m; k++) {
        tmp[k] = s;
        if (k + r + 1 < m) s += at(k + r + 1);
        if (k - r >= 0) s -= at(k - r);
      }
      for (let k = 0; k < m; k++) {
        if (pass === 0) a[line * m + k] = tmp[k];
        else a[k * m + line] = tmp[k];
      }
    }
  }
}
