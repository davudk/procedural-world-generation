import { angle as arc, localFrame } from '../grid/cube';
import { cellFace, cellIndex, coarser, cellX as colOf, cellY as rowOf, type Grid } from '../grid/grid';
import { chamferDistance } from '../grid/ops';

/**
 * Raster helpers for the landmark registry (S11). Everything runs on world grids: the
 * macro grid (1 km cells on the build, 4 km on the preview at the default size) and a "regional"
 * grid of ~4 km cells used for seas, coasts, ranges and biome regions, so those detectors cost the
 * same on the build and the preview and find the same features in both. Neighbour loops use the
 * grid's axial-first D8 order (E W S N SE NE SW NW: `off8Axial`, `off4`).
 */

/**
 * A registry grid; positions are map metres (x from the west edge, y from the north edge). On spheres
 * positions are encoded face-local metres, x = face · π·R + u, y = v (geo.ts `Geo`).
 */
export type GridSpec = Grid;

/** Cell centre, map metres (spheres: encoded, geo.ts). */
// These run per cell in the detectors: the flat expressions stay small enough to inline, the sphere
// work lives in separate functions.
export const cellX = (g: GridSpec, c: number): number => (g.faces === 1 ? (colOf(g, c) + 0.5) * g.cellM : cellXSphere(g, c));
export const cellY = (g: GridSpec, c: number): number => (rowOf(g, c) + 0.5) * g.cellM;

function cellXSphere(g: GridSpec, c: number): number {
  return cellFace(g, c) * Math.PI * g.radiusM + (colOf(g, c) + 0.5) * g.cellM;
}

/** Cell containing a map position (clamped to the grid; spheres: an encoded position). */
export function cellAtM(g: GridSpec, x: number, y: number): number {
  if (g.faces !== 1) return cellAtMSphere(g, x, y);
  const i = Math.min(g.n - 1, Math.max(0, Math.floor(x / g.cellM)));
  const j = Math.min(g.n - 1, Math.max(0, Math.floor(y / g.cellM)));
  return cellIndex(g, i, j);
}

function cellAtMSphere(g: GridSpec, x: number, y: number): number {
  const stride = Math.PI * g.radiusM;
  const face = Math.min(5, Math.max(0, Math.floor(x / stride)));
  x -= face * stride;
  const i = Math.min(g.n - 1, Math.max(0, Math.floor(x / g.cellM)));
  const j = Math.min(g.n - 1, Math.max(0, Math.floor(y / g.cellM)));
  return cellIndex(g, i, j, face);
}

/** Largest power-of-two factor ≤ n/16 that brings the cell size of `g` to about `targetM`. */
export function coarseFactor(g: GridSpec, targetM: number): number {
  let f = 1;
  while (f * 2 * g.cellM <= targetM * 1.01 && g.n / (f * 2) >= 64) f *= 2;
  return f;
}

/** Mean of `a` (on `g`) over each block of f × f cells: a field on `coarser(g, f)`. */
export function blockMean(a: Float32Array, g: GridSpec, f: number): Float32Array {
  if (f === 1) return a.slice();
  const cg = coarser(g, f);
  const out = new Float32Array(cg.cells);
  const inv = 1 / (f * f);
  for (let face = 0; face < g.faces; face++) {
    for (let y = 0; y < g.n; y++) {
      const row = cellIndex(cg, 0, Math.floor(y / f), face);
      const i0 = cellIndex(g, 0, y, face);
      for (let x = 0; x < g.n; x++) out[row + Math.floor(x / f)] += a[i0 + x] * inv;
    }
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
  /** Spheres only: per component the sum of its cells' unit vectors (3 each) and its area (m²). */
  dir?: Float64Array;
  areaM2?: Float64Array;
}

/** Area of component k (km²): exact cell areas on spheres, size · cellKm2 on flat maps. */
export function compKm2(m: Components, k: number, cellKm2: number): number {
  return m.areaM2 ? m.areaM2[k] / 1e6 : m.size[k] * cellKm2;
}

/** Area (km²) of a list of cells: exact on spheres, count · cellKm2 on flat maps. */
export function cellsKm2(g: GridSpec, cells: ArrayLike<number>, cellKm2: number): number {
  if (g.uniform) return cells.length * cellKm2;
  let a = 0;
  for (let i = 0; i < cells.length; i++) a += g.area(cells[i]);
  return a / 1e6;
}

export function label(mask: Uint8Array, g: GridSpec, conn8: boolean): Components {
  const { cells: N, off8Axial: off, border, axialToRaster } = g;
  const lab = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  const sizes: number[] = [];
  const kmax = conn8 ? 8 : 4;
  for (let s = 0; s < N; s++) {
    if (!mask[s] || lab[s] !== -1) continue;
    const id = sizes.length;
    let top = 0;
    let size = 0;
    stack[top++] = s;
    lab[s] = id;
    while (top > 0) {
      const c = stack[--top];
      size++;
      const b = border[c];
      for (let k = 0; k < kmax; k++) {
        const nc = b === 0 ? c + off[k] : g.nbr(c, axialToRaster[k]);
        if (nc >= 0 && mask[nc] && lab[nc] === -1) {
          lab[nc] = id;
          stack[top++] = nc;
        }
      }
    }
    sizes.push(size);
  }
  // Centroid sums in a raster pass: sums of integer cell coordinates are exact in any order.
  const count = sizes.length;
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  for (let face = 0; face < g.faces; face++) {
    for (let y = 0; y < g.n; y++) {
      const i0 = cellIndex(g, 0, y, face);
      for (let x = 0; x < g.n; x++) {
        const k = lab[i0 + x];
        if (k < 0) continue;
        sx[k] += x;
        sy[k] += y;
      }
    }
  }
  const out: Components = { label: lab, count, size: Int32Array.from(sizes), sx, sy };
  if (g.faces !== 1) {
    // Face-local centroids mean nothing across seams: mean directions and exact areas instead.
    const dir = new Float64Array(count * 3);
    const areaM2 = new Float64Array(count);
    const p = new Float64Array(3);
    for (let i = 0; i < N; i++) {
      const k = lab[i];
      if (k < 0) continue;
      g.position(i, p);
      dir[3 * k] += p[0];
      dir[3 * k + 1] += p[1];
      dir[3 * k + 2] += p[2];
      areaM2[k] += g.area(i);
    }
    out.dir = dir;
    out.areaM2 = areaM2;
  }
  return out;
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

export function mergeTree(v: Float32Array, mask: Uint8Array, g: GridSpec, conn8: boolean, step: number): MergeTree {
  const { cells: N, off8Axial: off, border, axialToRaster } = g;
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
    const b = border[c];
    let nr = 0;
    for (let k = 0; k < kmax; k++) {
      const nc = b === 0 ? c + off[k] : g.nbr(c, axialToRaster[k]);
      if (nc < 0 || uf[nc] < 0) continue;
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
  /**
   * Spheres: the tangent plane the axes live in (azimuthal equidistant about the weighted mean
   * direction, x east and y south in nominal cells); `axesXY` places other cells in it.
   */
  plane?: { up: Float64Array; east: Float64Array; north: Float64Array; R: number; cellM: number };
}

/** Position of cell c in the axes' chart (cells; flat: its column and row). */
export function axesXY(ax: Axes, g: GridSpec, c: number, out: Float64Array): void {
  if (!ax.plane) {
    out[0] = colOf(g, c);
    out[1] = rowOf(g, c);
    return;
  }
  const P = ax.plane;
  const p = out.length >= 3 ? out : new Float64Array(3);
  g.position(c, p);
  planeXY(P, p, out);
}

function planeXY(P: NonNullable<Axes['plane']>, p: ArrayLike<number>, out: Float64Array): void {
  const th = arc(P.up, p);
  const e = p[0] * P.east[0] + p[1] * P.east[1] + p[2] * P.east[2];
  const nn = p[0] * P.north[0] + p[1] * P.north[1] + p[2] * P.north[2];
  const l = Math.hypot(e, nn);
  const s = l > 0 ? (th * P.R) / (l * P.cellM) : 0;
  out[0] = e * s;
  out[1] = -nn * s;
}

/** 3D direction of a chart direction (dx, dy) of the axes' plane (spheres). */
export function axesDir(ax: Axes, dx: number, dy: number): [number, number, number] {
  const P = ax.plane!;
  return [dx * P.east[0] - dy * P.north[0], dx * P.east[1] - dy * P.north[1], dx * P.east[2] - dy * P.north[2]];
}

export function pca(cells: ArrayLike<number>, g: GridSpec, weight?: (c: number) => number): Axes {
  if (g.faces !== 1) return pcaSphere(cells, g, weight);
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const w = weight ? weight(c) : 1;
    sw += w;
    sx += w * colOf(g, c);
    sy += w * rowOf(g, c);
  }
  const cx = sx / Math.max(sw, 1e-9);
  const cy = sy / Math.max(sw, 1e-9);
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const w = weight ? weight(c) : 1;
    const dx = colOf(g, c) - cx;
    const dy = rowOf(g, c) - cy;
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

function pcaSphere(cells: ArrayLike<number>, g: GridSpec, weight?: (c: number) => number): Axes {
  const n = cells.length;
  const P = new Float64Array(n * 3);
  const W = new Float64Array(n);
  const up = new Float64Array(3);
  const p = new Float64Array(3);
  let sw = 0;
  for (let i = 0; i < n; i++) {
    g.position(cells[i], p);
    const w = weight ? weight(cells[i]) : 1;
    W[i] = w;
    sw += w;
    P.set(p, 3 * i);
    for (let k = 0; k < 3; k++) up[k] += w * p[k];
  }
  const l = Math.hypot(up[0], up[1], up[2]) || 1;
  for (let k = 0; k < 3; k++) up[k] /= l;
  const east = new Float64Array(3);
  const north = new Float64Array(3);
  localFrame(up, east, north);
  const plane = { up, east, north, R: g.radiusM, cellM: g.cellM };
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const q = new Float64Array(2);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    planeXY(plane, P.subarray(3 * i, 3 * i + 3), q);
    xs[i] = q[0];
    ys[i] = q[1];
    cx += W[i] * q[0];
    cy += W[i] * q[1];
  }
  cx /= Math.max(sw, 1e-9);
  cy /= Math.max(sw, 1e-9);
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - cx;
    const dy = ys[i] - cy;
    xx += W[i] * dx * dx;
    yy += W[i] * dy * dy;
    xy += W[i] * dx * dy;
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
  return { cx, cy, ux: Math.cos(a), uy: Math.sin(a), length: Math.sqrt(12 * l1) + 1, width: Math.sqrt(12 * l2) + 1, plane };
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
export function insideDistance(mask: Uint8Array, g: Grid): Float32Array {
  const inv = new Uint8Array(g.cells);
  for (let i = 0; i < g.cells; i++) inv[i] = mask[i] ? 0 : 1;
  return chamferDistance(inv, g);
}

/**
 * Nearest cell to (cx, cy) (face-local cells) within `radius` cells for which `ok` holds, or −1.
 * Scans the clipped window rows north to south, west to east; ties go to the first cell.
 */
export function nearestWhere(g: GridSpec, cx: number, cy: number, radius: number, ok: (c: number) => boolean): number {
  const x0 = Math.round(cx - 0.5);
  const y0 = Math.round(cy - 0.5);
  let best = -1;
  let bd = Infinity;
  const r = Math.ceil(radius);
  const xa = Math.max(0, x0 - r);
  const xb = Math.min(g.n - 1, x0 + r);
  const yb = Math.min(g.n - 1, y0 + r);
  for (let y = Math.max(0, y0 - r); y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
      if (d >= bd || d > radius * radius) continue;
      const c = cellIndex(g, x, y);
      if (ok(c)) {
        bd = d;
        best = c;
      }
    }
  }
  return best;
}

/**
 * nearestWhere about a registry position (metres; encoded on spheres). Flat maps run nearestWhere on
 * x / cellM, y / cellM (the expression every caller used); spheres search the geodesic disc of
 * `radius` cells around the point, nearest first by great-circle distance (ties: the first visited).
 */
export function nearestWhereM(g: GridSpec, x: number, y: number, radius: number, ok: (c: number) => boolean): number {
  return g.faces === 1 ? nearestWhere(g, x / g.cellM, y / g.cellM, radius, ok) : nearestOnSphere(g, x, y, radius, ok);
}

/** nearestWhereM on a sphere (its own function: the closure would otherwise cost the flat path a context). */
function nearestOnSphere(g: GridSpec, x: number, y: number, radius: number, ok: (c: number) => boolean): number {
  const stride = Math.PI * g.radiusM;
  const face = Math.min(5, Math.max(0, Math.floor(x / stride)));
  let best = -1;
  let bd = Infinity;
  g.chart({ face, u: x - face * stride, v: y }, Math.max(radius, 0.75) * g.cellM, (c, e, nn) => {
    const d = e * e + nn * nn;
    if (d < bd && ok(c)) {
      bd = d;
      best = c;
    }
  });
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
export function polylineLength(p: ArrayLike<number>): number {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return L;
}

/** Point at fraction `t` of a polyline's length, with the local direction (over ±`span` of the length). */
export function alongPolyline(p: ArrayLike<number>, t: number, span = 0.1): { x: number; y: number; dx: number; dy: number } {
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
