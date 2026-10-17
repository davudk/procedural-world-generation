import type { Rng } from '../../../shared/rng';
import { blockGrid, cellFace, cellIndex, cellX, cellY, chartXY, tryCellIndex, type Grid } from '../../grid/grid';
import { boxBlur } from '../../grid/ops';
import { SphereDisk, spherePos } from '../sphere';

/*
 * Coast-module neighbour walks use the grid's axial-first D8 order (`off8Axial`: E W S N SE NE SW NW;
 * the first four are the 4-neighbours), which sets their tie-breaks.
 */

/**
 * Two-pass chamfer distance (cells, 1 / 1.4 weights) to the nearest source cell, carrying the index
 * of that source. O(n²); approximate nearest (good to about a cell), which is all the coastal bands need.
 * On the sphere one forward/backward pair is not enough (the scan order of a face does not continue
 * across its seams), so the pair repeats until nothing changes: every pass is a valid relaxation, so
 * the result is the chamfer distance over the seams (flat maps keep exactly one pair).
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
  const sphere = g.shape !== 'flat';
  for (let round = 0; ; round++) {
    let changed = false;
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
      if (sphere && Math.fround(best) !== d[i]) changed = true;
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
      if (sphere && Math.fround(best) !== d[i]) changed = true;
      d[i] = best;
      near[i] = src;
    }
    // Sphere: repeat until stable (the later rounds only fix up what crossed a seam against the scan order).
    if (!sphere || !changed || round > 64) break;
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
  /** Sphere: great-circle spacing on chart-km positions (landforms/sphere.ts). */
  private readonly sphere: SphereDisk | null;
  constructor(private readonly r: number, grid?: Grid) {
    this.sphere = grid && grid.shape !== 'flat' ? new SphereDisk(spherePos(grid), r) : null;
  }

  private key(gx: number, gy: number): number {
    return gx * 73856093 + gy * 19349663;
  }

  /** True if no stored point lies within the radius (optionally a different one) of (x, y). */
  free(x: number, y: number, r = this.r): boolean {
    if (this.sphere) return this.sphere.free(x, y, r);
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
    if (this.sphere) {
      this.sphere.add(x, y);
      return;
    }
    const k = this.key(Math.floor(x / this.r), Math.floor(y / this.r));
    const list = this.cells.get(k);
    if (list) list.push({ x, y });
    else this.cells.set(k, [{ x, y }]);
  }
}

/** Cells on the 4-connected digital line from a to b (inclusive), so water or land cannot leak diagonally. */
export function line4(g: Grid, a: number, b: number): number[] {
  if (g.shape !== 'flat') return line4Sphere(g, a, b);
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
 * line4 on the sphere: the same digital line in the extended chart of a's face (so it crosses seams
 * straight), mapped to cells; cells repeated by the chart lattice beyond a seam are dropped, and any
 * diagonal step left where the other face's cells do not line up with the lattice is bridged by a
 * common 4-neighbour, so the path stays 4-connected. Ends at b.
 */
function line4Sphere(g: Grid, a: number, b: number): number[] {
  const f = cellFace(g, a);
  const q = new Float64Array(2);
  chartXY(g, f, b, q);
  const raw = [a];
  if (Number.isFinite(q[0]) && Number.isFinite(q[1])) {
    let x = cellX(g, a);
    let y = cellY(g, a);
    const x1 = Math.round(q[0]);
    const y1 = Math.round(q[1]);
    const sx = Math.sign(x1 - x);
    const sy = Math.sign(y1 - y);
    const dx = Math.abs(x1 - x);
    const dy = Math.abs(y1 - y);
    let ex = 0;
    let ey = 0;
    while (x !== x1 || y !== y1) {
      if (x !== x1 && (y === y1 || (ex + 1) * dy <= (ey + 1) * dx)) {
        x += sx;
        ex++;
      } else {
        y += sy;
        ey++;
      }
      const j = tryCellIndex(g, x, y, f);
      if (j >= 0 && j !== raw[raw.length - 1]) raw.push(j);
    }
  }
  if (raw[raw.length - 1] !== b) raw.push(b);
  const out = [raw[0]];
  const at = new Map<number, number>([[raw[0], 0]]);
  for (let t = 1; t < raw.length; t++) {
    const p = out[out.length - 1];
    const c = raw[t];
    if (c === p) continue;
    for (const q of bridge4(g, p, c)) {
      // A cell met again (the lattice zigzags around a cube corner): cut the loop.
      const k = at.get(q);
      if (k !== undefined) {
        for (let r = k + 1; r < out.length; r++) at.delete(out[r]);
        out.length = k + 1;
        continue;
      }
      at.set(q, out.length);
      out.push(q);
    }
  }
  return out;
}

/**
 * Shortest 4-connected steps from cell p to a nearby cell c (excluding p, ending at c), by a small
 * breadth-first search (around a cube corner the lattice can jump by two or three cells); [c] when
 * c is farther than that.
 */
function bridge4(g: Grid, p: number, c: number): number[] {
  const from = new Map<number, number>([[p, -1]]);
  let front = [p];
  for (let depth = 0; depth < 4 && front.length; depth++) {
    const next: number[] = [];
    for (const i of front) {
      for (let k = 0; k < 4; k++) {
        const j = g.nbr(i, g.axialToRaster[k]);
        if (j < 0 || from.has(j)) continue;
        from.set(j, i);
        if (j === c) {
          const path: number[] = [];
          for (let q = c; q !== p; q = from.get(q)!) path.push(q);
          return path.reverse();
        }
        next.push(j);
      }
    }
    front = next;
  }
  return [c];
}

/**
 * Smooths per-cell values given on a list of cells (e.g. the coast) over coarse blocks: the weighted
 * block means, box-blurred over `r` blocks, read back per listed cell. O(list + (n / block)²).
 */
export function blockMeanList(
  cells: Int32Array, val: Float32Array, w: Uint8Array | null, g: Grid, block: number, r: number,
): Float32Array {
  if (g.shape !== 'flat') return blockMeanListSphere(cells, val, w, g, block, r);
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

/**
 * blockMeanList on the sphere: blocks tile every face (`block` must divide n; see sphereBlock), and
 * the block sums are box-blurred across seams (ops.boxBlur normalises, which the ratio cancels).
 */
function blockMeanListSphere(
  cells: Int32Array, val: Float32Array, w: Uint8Array | null, g: Grid, block: number, r: number,
): Float32Array {
  const bg = blockGrid(g, block);
  const sv = new Float32Array(bg.cells);
  const sw = new Float32Array(bg.cells);
  const bOf = new Int32Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const b = cellIndex(bg, Math.floor(cellX(g, i) / block), Math.floor(cellY(g, i) / block), cellFace(g, i));
    bOf[k] = b;
    const wk = w ? w[k] : 1;
    if (wk <= 0) continue;
    sv[b] += val[k] * wk;
    sw[b] += wk;
  }
  boxBlur(sv, bg, r);
  boxBlur(sw, bg, r);
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
