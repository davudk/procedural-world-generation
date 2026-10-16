import { chamferDistance } from '../grid/ops';

/**
 * Raster helpers for the landmark registry (S11). Everything runs on square row-major grids: the
 * macro grid (1 km cells on the build, 4 km on the preview at the default size) and a "regional"
 * grid of ~4 km cells used for seas, coasts, ranges and biome regions, so those detectors cost the
 * same on the build and the preview and find the same features in both.
 */

export const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
export const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

/** A grid with its cell size; positions are map metres (x from the west edge, y from the north edge). */
export interface GridSpec {
  n: number;
  /** Cell size in metres. */
  cellM: number;
}

export const cellX = (g: GridSpec, c: number): number => ((c % g.n) + 0.5) * g.cellM;
export const cellY = (g: GridSpec, c: number): number => (Math.floor(c / g.n) + 0.5) * g.cellM;

/** Cell containing a map position (clamped to the grid). */
export function cellAtM(g: GridSpec, x: number, y: number): number {
  const i = Math.min(g.n - 1, Math.max(0, Math.floor(x / g.cellM)));
  const j = Math.min(g.n - 1, Math.max(0, Math.floor(y / g.cellM)));
  return j * g.n + i;
}

/** Largest power-of-two factor ≤ n/16 that brings the cell size to about `targetM`. */
export function coarseFactor(n: number, cellM: number, targetM: number): number {
  let f = 1;
  while (f * 2 * cellM <= targetM * 1.01 && n / (f * 2) >= 64) f *= 2;
  return f;
}

/** Mean of `a` over each coarse block. */
export function blockMean(a: Float32Array, n: number, f: number): Float32Array {
  if (f === 1) return a.slice();
  const m = n / f;
  const out = new Float32Array(m * m);
  const inv = 1 / (f * f);
  for (let y = 0; y < n; y++) {
    const row = Math.floor(y / f) * m;
    for (let x = 0; x < n; x++) out[row + Math.floor(x / f)] += a[y * n + x] * inv;
  }
  return out;
}

/** Labelled connected components of a mask (4- or 8-connected), with per-component size and centroid sums. */
export interface Components {
  label: Int32Array;
  count: number;
  size: Int32Array;
  sx: Float64Array;
  sy: Float64Array;
}

export function label(mask: Uint8Array, n: number, conn8: boolean): Components {
  const N = n * n;
  const lab = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  const sizes: number[] = [];
  const sxs: number[] = [];
  const sys: number[] = [];
  const kmax = conn8 ? 8 : 4;
  for (let s = 0; s < N; s++) {
    if (!mask[s] || lab[s] !== -1) continue;
    const id = sizes.length;
    let top = 0;
    let size = 0;
    let sx = 0;
    let sy = 0;
    stack[top++] = s;
    lab[s] = id;
    while (top > 0) {
      const c = stack[--top];
      const x = c % n;
      const y = (c - x) / n;
      size++;
      sx += x;
      sy += y;
      for (let k = 0; k < kmax; k++) {
        const nx = x + DX8[k];
        const ny = y + DY8[k];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const nc = ny * n + nx;
        if (mask[nc] && lab[nc] === -1) {
          lab[nc] = id;
          stack[top++] = nc;
        }
      }
    }
    sizes.push(size);
    sxs.push(sx);
    sys.push(sy);
  }
  return { label: lab, count: sizes.length, size: Int32Array.from(sizes), sx: Float64Array.from(sxs), sy: Float64Array.from(sys) };
}

/**
 * Cells of `mask` ordered by `v` from high to low (ties by cell index), by a counting sort on `v`
 * quantised to `step`: O(N + range/step), deterministic, no comparator sort on a million cells.
 */
export function orderDesc(v: Float32Array, mask: Uint8Array, step: number): Int32Array {
  let lo = Infinity;
  let hi = -Infinity;
  let count = 0;
  for (let i = 0; i < v.length; i++) {
    if (!mask[i]) continue;
    count++;
    if (v[i] < lo) lo = v[i];
    if (v[i] > hi) hi = v[i];
  }
  const out = new Int32Array(count);
  if (count === 0) return out;
  const B = Math.min(1 << 20, Math.max(1, Math.floor((hi - lo) / step) + 1));
  const s = (B - 1) / Math.max(hi - lo, 1e-9);
  const bucket = new Int32Array(B + 1);
  const key = new Int32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    if (!mask[i]) continue;
    const k = B - 1 - Math.floor((v[i] - lo) * s);
    key[i] = k;
    bucket[k + 1]++;
  }
  for (let k = 0; k < B; k++) bucket[k + 1] += bucket[k];
  for (let i = 0; i < v.length; i++) if (mask[i]) out[bucket[key[i]]++] = i;
  return out;
}

/**
 * Merge tree of the super-level sets of `v` over `mask` (the union-find sweep behind topographic
 * prominence): cells are added from high to low; a cell with no processed neighbour starts a new
 * component at its peak, a cell touching several components joins the one with the highest peak and
 * absorbs the others there (the key col). Used for peak prominence (elevation over land), sea basins
 * and straits (distance from land over the sea) and isthmuses (distance from the sea over land).
 */
export interface MergeTree {
  count: number;
  /** Per component: peak cell and value. */
  peak: Int32Array;
  peakV: Float32Array;
  /** Per component: col cell / value where it was absorbed (−1 / NaN for components never absorbed). */
  col: Int32Array;
  colV: Float32Array;
  /** Per component: the component that absorbed it (−1 for roots). */
  parent: Int32Array;
  /** Per component: cells it held when absorbed (final size for roots). */
  area: Int32Array;
  /** Per cell: the component it joined when added (−1 outside the mask). */
  owner: Int32Array;
}

export function mergeTree(v: Float32Array, mask: Uint8Array, n: number, conn8: boolean, step: number): MergeTree {
  const N = n * n;
  const order = orderDesc(v, mask, step);
  const uf = new Int32Array(N).fill(-1);
  const compOfRoot = new Int32Array(N).fill(-1);
  const owner = new Int32Array(N).fill(-1);
  const peak: number[] = [];
  const peakV: number[] = [];
  const col: number[] = [];
  const colV: number[] = [];
  const parent: number[] = [];
  const area: number[] = [];
  const find = (c: number): number => {
    while (uf[c] !== c) {
      uf[c] = uf[uf[c]];
      c = uf[c];
    }
    return c;
  };
  const kmax = conn8 ? 8 : 4;
  const roots = new Int32Array(8);
  for (let oi = 0; oi < order.length; oi++) {
    const c = order[oi];
    const x = c % n;
    const y = (c - x) / n;
    let nr = 0;
    for (let k = 0; k < kmax; k++) {
      const nx = x + DX8[k];
      const ny = y + DY8[k];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const nc = ny * n + nx;
      if (uf[nc] < 0) continue;
      const r = find(nc);
      let dup = false;
      for (let j = 0; j < nr; j++) if (roots[j] === r) dup = true;
      if (!dup) roots[nr++] = r;
    }
    if (nr === 0) {
      const id = peak.length;
      peak.push(c);
      peakV.push(v[c]);
      col.push(-1);
      colV.push(NaN);
      parent.push(-1);
      area.push(1);
      uf[c] = c;
      compOfRoot[c] = id;
      owner[c] = id;
      continue;
    }
    // Main = highest peak (ties: the earlier component).
    let main = roots[0];
    for (let j = 1; j < nr; j++) {
      const a = compOfRoot[roots[j]];
      const b = compOfRoot[main];
      if (peakV[a] > peakV[b] || (peakV[a] === peakV[b] && a < b)) main = roots[j];
    }
    const mc = compOfRoot[main];
    uf[c] = main;
    owner[c] = mc;
    area[mc]++;
    for (let j = 0; j < nr; j++) {
      const r = roots[j];
      if (r === main) continue;
      const rc = compOfRoot[r];
      parent[rc] = mc;
      col[rc] = c;
      colV[rc] = v[c];
      area[mc] += area[rc];
      uf[r] = main;
    }
  }
  return {
    count: peak.length, peak: Int32Array.from(peak), peakV: Float32Array.from(peakV), col: Int32Array.from(col), colV: Float32Array.from(colV),
    parent: Int32Array.from(parent), area: Int32Array.from(area), owner,
  };
}

/** Maps every component to its first ancestor (itself included) for which `keep` is set, or −1. */
export function resolveOwners(t: MergeTree, keep: Uint8Array): Int32Array {
  const res = new Int32Array(t.count).fill(-2);
  const walk = (k: number): number => {
    const path: number[] = [];
    let c = k;
    while (c >= 0 && res[c] === -2 && !keep[c]) {
      path.push(c);
      c = t.parent[c];
    }
    const r = c < 0 ? -1 : keep[c] ? c : res[c];
    for (const p of path) res[p] = r;
    if (c >= 0 && keep[c]) res[c] = c;
    return r;
  };
  for (let k = 0; k < t.count; k++) if (res[k] === -2) walk(k);
  return res;
}

/** Principal axes of a set of cells (positions in cells). */
export interface Axes {
  cx: number;
  cy: number;
  /** Unit major axis (cells; y down). */
  ux: number;
  uy: number;
  /** Lengths along the major and minor axis (cells), √12 σ (exact for a uniform bar). */
  length: number;
  width: number;
}

export function pca(cells: ArrayLike<number>, n: number, weight?: (c: number) => number): Axes {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const w = weight ? weight(c) : 1;
    sw += w;
    sx += w * (c % n);
    sy += w * Math.floor(c / n);
  }
  const cx = sx / Math.max(sw, 1e-9);
  const cy = sy / Math.max(sw, 1e-9);
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const w = weight ? weight(c) : 1;
    const dx = (c % n) - cx;
    const dy = Math.floor(c / n) - cy;
    xx += w * dx * dx;
    yy += w * dy * dy;
    xy += w * dx * dy;
  }
  xx /= Math.max(sw, 1e-9);
  yy /= Math.max(sw, 1e-9);
  xy /= Math.max(sw, 1e-9);
  const tr = xx + yy;
  const det = xx * yy - xy * xy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  const a = 0.5 * Math.atan2(2 * xy, xx - yy);
  return { cx, cy, ux: Math.cos(a), uy: Math.sin(a), length: Math.sqrt(12 * l1) + 1, width: Math.sqrt(12 * l2) + 1 };
}

/**
 * Label angle for a direction in map axes (x east, y south): radians counter-clockwise from east as
 * seen on a north-up map, folded into (−π/2, π/2] so text never reads upside down.
 */
export function labelAngle(dx: number, dy: number): number {
  let a = Math.atan2(-dy, dx);
  if (a > Math.PI / 2) a -= Math.PI;
  else if (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

/** Approximate distance (cells, 3-4 chamfer) from every cell of `mask` to the nearest cell outside it. */
export function insideDistance(mask: Uint8Array, n: number): Float32Array {
  const inv = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) inv[i] = mask[i] ? 0 : 1;
  return chamferDistance(inv, n);
}

/** Nearest cell to (cx, cy) (cells) within `radius` cells for which `ok` holds, or −1. */
export function nearestWhere(n: number, cx: number, cy: number, radius: number, ok: (c: number) => boolean): number {
  const x0 = Math.round(cx - 0.5);
  const y0 = Math.round(cy - 0.5);
  let best = -1;
  let bd = Infinity;
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) {
    const y = y0 + dy;
    if (y < 0 || y >= n) continue;
    for (let dx = -r; dx <= r; dx++) {
      const x = x0 + dx;
      if (x < 0 || x >= n) continue;
      const d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
      if (d >= bd || d > radius * radius) continue;
      const c = y * n + x;
      if (ok(c)) {
        bd = d;
        best = c;
      }
    }
  }
  return best;
}

/** Decimates a polyline (x,y pairs) to points at least `minStep` apart, always keeping the ends. */
export function decimate(xs: number[], ys: number[], minStep: number): Float32Array {
  const out: number[] = [];
  if (xs.length === 0) return new Float32Array(0);
  out.push(xs[0], ys[0]);
  let lx = xs[0];
  let ly = ys[0];
  for (let i = 1; i < xs.length - 1; i++) {
    if (Math.hypot(xs[i] - lx, ys[i] - ly) >= minStep) {
      out.push(xs[i], ys[i]);
      lx = xs[i];
      ly = ys[i];
    }
  }
  if (xs.length > 1) out.push(xs[xs.length - 1], ys[ys.length - 1]);
  return Float32Array.from(out);
}

/** Length of a polyline in its units. */
export function polylineLength(p: Float32Array): number {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return L;
}

/** Point at fraction `t` of a polyline's length, with the local direction (over ±`span` of the length). */
export function alongPolyline(p: Float32Array, t: number, span = 0.1): { x: number; y: number; dx: number; dy: number } {
  const L = polylineLength(p);
  const at = (s: number): [number, number] => {
    s = Math.min(L, Math.max(0, s));
    let acc = 0;
    for (let i = 2; i < p.length; i += 2) {
      const d = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
      if (acc + d >= s && d > 0) {
        const f = (s - acc) / d;
        return [p[i - 2] + f * (p[i] - p[i - 2]), p[i - 1] + f * (p[i + 1] - p[i - 1])];
      }
      acc += d;
    }
    return [p[p.length - 2], p[p.length - 1]];
  };
  const [x, y] = at(t * L);
  const [ax, ay] = at((t - span) * L);
  const [bx, by] = at((t + span) * L);
  return { x, y, dx: bx - ax, dy: by - ay };
}
