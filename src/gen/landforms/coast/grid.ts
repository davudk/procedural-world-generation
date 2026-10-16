import type { Rng } from '../../../shared/rng';
import { blockGrid, cellIndex, cellX, cellY, type Grid } from '../../grid/grid';

/*
 * Coast-module neighbour walks use the grid's axial-first D8 order (`off8Axial`: E W S N SE NE SW NW;
 * the first four are the 4-neighbours), which sets their tie-breaks.
 */

/**
 * Two-pass chamfer distance (cells, 1 / 1.4 weights) to the nearest source cell, carrying the index
 * of that source. O(n²); approximate nearest (good to about a cell), which is all the coastal bands need.
 */
export function chamferNearest(source: Uint8Array, g: Grid): { dist: Float32Array; nearest: Int32Array } {
  const { cells: N, border, off8 } = g;
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
  // Raster offsets (NW N NE W E SW S SE); border cells read theirs from nbr (−1 off the map).
  const oNW = off8[0];
  const oN = off8[1];
  const oNE = off8[2];
  const oW = off8[3];
  const oE = off8[4];
  const oSW = off8[5];
  const oS = off8[6];
  const oSE = off8[7];
  // Forward pass in scan order (W, N, NW, NE), then backward (E, S, SE, SW); relaxations inlined.
  for (let i = 0; i < N; i++) {
    let best = d[i];
    let src = near[i];
    const b = border[i] === 0;
    const jW = b ? i + oW : g.nbr(i, 3);
    const jN = b ? i + oN : g.nbr(i, 1);
    const jNW = b ? i + oNW : g.nbr(i, 0);
    const jNE = b ? i + oNE : g.nbr(i, 2);
    if (jW >= 0 && d[jW] + 1 < best) {
      best = d[jW] + 1;
      src = near[jW];
    }
    if (jN >= 0 && d[jN] + 1 < best) {
      best = d[jN] + 1;
      src = near[jN];
    }
    if (jNW >= 0 && d[jNW] + 1.4 < best) {
      best = d[jNW] + 1.4;
      src = near[jNW];
    }
    if (jNE >= 0 && d[jNE] + 1.4 < best) {
      best = d[jNE] + 1.4;
      src = near[jNE];
    }
    d[i] = best;
    near[i] = src;
  }
  for (let i = N - 1; i >= 0; i--) {
    let best = d[i];
    let src = near[i];
    const b = border[i] === 0;
    const jE = b ? i + oE : g.nbr(i, 4);
    const jS = b ? i + oS : g.nbr(i, 6);
    const jSE = b ? i + oSE : g.nbr(i, 7);
    const jSW = b ? i + oSW : g.nbr(i, 5);
    if (jE >= 0 && d[jE] + 1 < best) {
      best = d[jE] + 1;
      src = near[jE];
    }
    if (jS >= 0 && d[jS] + 1 < best) {
      best = d[jS] + 1;
      src = near[jS];
    }
    if (jSE >= 0 && d[jSE] + 1.4 < best) {
      best = d[jSE] + 1.4;
      src = near[jSE];
    }
    if (jSW >= 0 && d[jSW] + 1.4 < best) {
      best = d[jSW] + 1.4;
      src = near[jSW];
    }
    d[i] = best;
    near[i] = src;
  }
  return { dist: d, nearest: near };
}

/** Labels 8-connected components of non-zero `mask` cells; −1 outside. Returns labels and sizes. */
export function components8(mask: Uint8Array, g: Grid): { label: Int32Array; sizes: number[] } {
  const { cells: N, border, off8Axial, axialToRaster } = g;
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
      const b = border[c];
      for (let k = 0; k < 8; k++) {
        const j = b === 0 ? c + off8Axial[k] : g.nbr(c, axialToRaster[k]);
        if (j >= 0 && mask[j] && label[j] === -1) {
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
export function labelList(list: readonly number[], mask: Uint8Array, g: Grid, label: Int32Array): number[] {
  const { border, off8Axial, axialToRaster } = g;
  const sizes: number[] = [];
  const stack: number[] = [];
  for (const s of list) {
    if (!mask[s] || label[s] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      const b = border[c];
      for (let k = 0; k < 8; k++) {
        const j = b === 0 ? c + off8Axial[k] : g.nbr(c, axialToRaster[k]);
        if (j >= 0 && mask[j] && label[j] === -1) {
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
export function line4(g: Grid, a: number, b: number): number[] {
  let x = cellX(g, a);
  let y = cellY(g, a);
  const x1 = cellX(g, b);
  const y1 = cellY(g, b);
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
    out.push(cellIndex(g, x, y));
  }
  return out;
}

/**
 * Smooths per-cell values given on a list of cells (e.g. the coast) over coarse blocks: the weighted
 * block means, box-blurred over `r` blocks, read back per listed cell. O(list + (n / block)²).
 */
export function blockMeanList(
  cells: Int32Array, val: Float32Array, w: Uint8Array | null, g: Grid, block: number, r: number,
): Float32Array {
  const bg = blockGrid(g, block);
  const m = bg.n;
  const sv = new Float32Array(m * m);
  const sw = new Float32Array(m * m);
  const bOf = new Int32Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const b = cellIndex(bg, Math.floor(cellX(g, i) / block), Math.floor(cellY(g, i) / block));
    bOf[k] = b;
    const wk = w ? w[k] : 1;
    if (wk <= 0) continue;
    sv[b] += val[k] * wk;
    sw[b] += wk;
  }
  boxBlurSmall(sv, bg, r);
  boxBlurSmall(sw, bg, r);
  const out = new Float32Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    const b = bOf[k];
    out[k] = sw[b] > 1e-6 ? sv[b] / sw[b] : val[k];
  }
  return out;
}

/** Separable box blur (radius r, zero outside) on a small grid: rows, then columns. */
function boxBlurSmall(a: Float32Array, g: Grid, r: number): void {
  if (r < 1) return;
  const m = g.n;
  const tmp = new Float32Array(m);
  // Cell k along row (pass 0) or column (pass 1) `line`.
  const cellAt = (pass: number, line: number, k: number): number => (pass === 0 ? cellIndex(g, k, line) : cellIndex(g, line, k));
  for (let pass = 0; pass < 2; pass++) {
    for (let line = 0; line < m; line++) {
      const at = (k: number): number => a[cellAt(pass, line, k)];
      let s = 0;
      for (let k = 0; k <= Math.min(m - 1, r); k++) s += at(k);
      for (let k = 0; k < m; k++) {
        tmp[k] = s;
        if (k + r + 1 < m) s += at(k + r + 1);
        if (k - r >= 0) s -= at(k - r);
      }
      for (let k = 0; k < m; k++) a[cellAt(pass, line, k)] = tmp[k];
    }
  }
}
