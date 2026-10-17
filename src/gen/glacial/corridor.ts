import { dirFace } from '../../shared/cube';
import type { CubeGrid } from '../grid/cube';
import { cellFace, cellIndex, cellX, cellY, type Grid } from '../grid/grid';

/**
 * Glacier corridors: a U cross-section evaluated per cell from its distance to a continuous glacier
 * centreline, instead of a union of per-cell circular stamps (whose overlapping rims leave scallops
 * along the walls).
 *
 * The centreline is a polyline: each source is a vertex (sub-cell position, smoothed along the trunk
 * by the caller) linked to its downstream vertex, and every link is a segment along which floor, edge
 * height, half-width and cut limit are interpolated linearly. A cell inside a segment's tube gets
 * profile = floor + (edge − floor)·t², t = distance to the segment / half-width, and the corridor is
 * the lower envelope of all tubes (a smooth swept parabola, joining tributaries without seams).
 *
 * Vertex positions are cell coordinates (column x, row y) on flat maps. On the sphere they are unit
 * vectors (x, y, z), so smoothing never mixes the coordinates of two faces; each segment is carved in
 * the extended chart of its upstream vertex's face.
 */
export class CorridorSources {
  readonly x: number[] = [];
  readonly y: number[] = [];
  /** Sphere only: third component of the unit vector. */
  readonly z: number[] = [];
  readonly floor: number[] = [];
  readonly edge: number[] = [];
  /** Half-width in cells. */
  readonly rc: number[] = [];
  readonly cut: number[] = [];
  /** Downstream vertex (source index), or −1 for an isolated point / the line end. */
  readonly next: number[] = [];

  add(x: number, y: number, floor: number, edge: number, rc: number, cut: number): number {
    this.x.push(x);
    this.y.push(y);
    this.floor.push(floor);
    this.edge.push(edge);
    this.rc.push(rc);
    this.cut.push(cut);
    this.next.push(-1);
    return this.x.length - 1;
  }

  /** Vertex at the centre of cell i: (x, y) on flat maps, the unit vector on the sphere. */
  addCell(g: Grid, i: number, floor: number, edge: number, rc: number, cut: number): number {
    if (g.shape === 'flat') {
      return this.add(cellX(g, i), cellY(g, i), floor, edge, rc, cut);
    }
    const p = new Float64Array(3);
    g.position(i, p);
    return this.addDir(p[0], p[1], p[2], floor, edge, rc, cut);
  }

  /** Sphere vertex at a unit vector. */
  addDir(x: number, y: number, z: number, floor: number, edge: number, rc: number, cut: number): number {
    this.z.push(z);
    return this.add(x, y, floor, edge, rc, cut);
  }

  get size(): number {
    return this.x.length;
  }
}

export interface CorridorField {
  /** Metres removed: max(0, h − profile), never more than the interpolated cut limit. */
  carve: Float32Array;
  /** Half-width (cells) of the widest tube covering the cell; 0 outside every corridor. */
  rc: Float32Array;
}

/** Carve field of a centreline polyline over `h`. Sea (fixed) cells are skipped unless `sea`. */
export function corridorCarve(src: CorridorSources, h: Float32Array, fixed: Uint8Array, g: Grid, sea: boolean): CorridorField {
  if (g.shape !== 'flat') return corridorCarveCube(src, h, fixed, g as CubeGrid, sea);
  const { n, cells: N } = g;
  const target = new Float32Array(N).fill(Infinity);
  const rcOut = new Float32Array(N);
  const { x: X, y: Y, floor: F, edge: E, rc: R, cut: C, next } = src;
  for (let s = 0; s < src.size; s++) {
    const e = next[s] >= 0 ? next[s] : s;
    const ax = X[s];
    const ay = Y[s];
    const bx = X[e] - ax;
    const by = Y[e] - ay;
    const len2 = bx * bx + by * by;
    const rMax = Math.max(R[s], R[e]);
    const x0 = Math.max(0, Math.floor(Math.min(ax, ax + bx) - rMax));
    const x1 = Math.min(n - 1, Math.ceil(Math.max(ax, ax + bx) + rMax));
    const y0 = Math.max(0, Math.floor(Math.min(ay, ay + by) - rMax));
    const y1 = Math.min(n - 1, Math.ceil(Math.max(ay, ay + by) + rMax));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = cellIndex(g, x, y);
        if (fixed[i] && !sea) continue;
        const px = x - ax;
        const py = y - ay;
        let u = len2 > 0 ? (px * bx + py * by) / len2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = px - u * bx;
        const dy = py - u * by;
        const rc = R[s] + u * (R[e] - R[s]);
        const t2 = (dx * dx + dy * dy) / (rc * rc);
        if (t2 > 1) continue;
        const fl = F[s] + u * (F[e] - F[s]);
        const ed = E[s] + u * (E[e] - E[s]);
        const cut = C[s] + u * (C[e] - C[s]);
        let v = fl + (ed - fl) * t2;
        if (v < h[i] - cut) v = h[i] - cut;
        if (v < target[i]) target[i] = v;
        if (rc > rcOut[i]) rcOut[i] = rc;
      }
    }
  }
  const carve = new Float32Array(N);
  for (let i = 0; i < N; i++) if (target[i] < h[i]) carve[i] = h[i] - target[i];
  return { carve, rc: rcOut };
}

/** corridorCarve on the cube-sphere: each segment in the extended chart of its upstream vertex's face. */
function corridorCarveCube(src: CorridorSources, h: Float32Array, fixed: Uint8Array, g: CubeGrid, sea: boolean): CorridorField {
  const N = g.cells;
  const target = new Float32Array(N).fill(Infinity);
  const rcOut = new Float32Array(N);
  const { x: X, y: Y, z: Z, floor: F, edge: E, rc: R, cut: C, next } = src;
  const pa = new Float64Array(3);
  const pb = new Float64Array(3);
  const ca = new Float64Array(2);
  const cb = new Float64Array(2);
  const q = new Float64Array(2);
  for (let s = 0; s < src.size; s++) {
    const e = next[s] >= 0 ? next[s] : s;
    pa[0] = X[s];
    pa[1] = Y[s];
    pa[2] = Z[s];
    pb[0] = X[e];
    pb[1] = Y[e];
    pb[2] = Z[e];
    const f = dirFace(pa[0], pa[1], pa[2]);
    if (!g.chartXYDir(f, pa, ca) || !g.chartXYDir(f, pb, cb)) continue;
    const ax = ca[0];
    const ay = ca[1];
    const bx = cb[0] - ax;
    const by = cb[1] - ay;
    const len2 = bx * bx + by * by;
    const rMax = Math.max(R[s], R[e]);
    const x0 = Math.floor(Math.min(ax, ax + bx) - rMax);
    const x1 = Math.ceil(Math.max(ax, ax + bx) + rMax);
    const y0 = Math.floor(Math.min(ay, ay + by) - rMax);
    const y1 = Math.ceil(Math.max(ay, ay + by) + rMax);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // Chart lattice point → cell; distances from the cell's own chart position (cells beyond the
        // face edge may be hit twice, which the min / max envelopes absorb).
        const i = g.chartCell(f, x, y);
        if (i < 0 || (fixed[i] && !sea) || !g.chartXY(f, i, q)) continue;
        const px = q[0] - ax;
        const py = q[1] - ay;
        let u = len2 > 0 ? (px * bx + py * by) / len2 : 0;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = px - u * bx;
        const dy = py - u * by;
        const rc = R[s] + u * (R[e] - R[s]);
        const t2 = (dx * dx + dy * dy) / (rc * rc);
        if (t2 > 1) continue;
        const fl = F[s] + u * (F[e] - F[s]);
        const ed = E[s] + u * (E[e] - E[s]);
        const cut = C[s] + u * (C[e] - C[s]);
        let v = fl + (ed - fl) * t2;
        if (v < h[i] - cut) v = h[i] - cut;
        if (v < target[i]) target[i] = v;
        if (rc > rcOut[i]) rcOut[i] = rc;
      }
    }
  }
  const carve = new Float32Array(N);
  for (let i = 0; i < N; i++) if (target[i] < h[i]) carve[i] = h[i] - target[i];
  return { carve, rc: rcOut };
}

/**
 * Softens a carve field (binomial 1-2-1 twice per axis, σ ≈ 1 cell), blended in by corridor width:
 * none for corridors ≤ 1 cell wide (it would fill single-cell channels), full from 3 cells. Values
 * stay ≥ 0, so applying the result still only lowers terrain.
 */
export function softenCarve(carve: Float32Array, rc: Float32Array, g: Grid): Float32Array {
  const { n, cells: N, off8, border } = g;
  // Neighbour in raster slot k with offset o, or the cell itself where the map ends (clamped edges).
  const side = (i: number, k: number, o: number): number => {
    if (border[i] === 0) return i + o;
    const j = g.nbr(i, k);
    return j < 0 ? i : j;
  };
  const oW = off8[3];
  const oE = off8[4];
  const oN = off8[1];
  const oS = off8[6];
  const a = carve.slice();
  const tmp = new Float32Array(N);
  // Rows within 3 of any carving; everything else stays 0 and is skipped (rows per face: f·n + y).
  const F = g.faces;
  const has = Array.from({ length: F }, () => new Uint8Array(n));
  for (let i = 0; i < N; i++) if (carve[i] > 0) has[cellFace(g, i)][cellY(g, i)] = 1;
  const active = Array.from({ length: F }, () => new Uint8Array(n));
  for (let f = 0; f < F; f++) {
    for (let y = 0; y < n; y++) if (has[f][y]) for (let k = Math.max(0, y - 3); k <= Math.min(n - 1, y + 3); k++) active[f][k] = 1;
  }
  // On the sphere carving anywhere activates every row (a carved row near a face edge reaches the
  // neighbouring faces through the seams; one full pass over 6 faces is cheap).
  if (F > 1 && has.some((rows) => rows.includes(1))) for (const rows of active) rows.fill(1);
  for (let pass = 0; pass < 2; pass++) {
    for (let f = 0; f < F; f++) {
      for (let y = 0; y < n; y++) {
        if (!active[f][y]) continue;
        for (let x = 0; x < n; x++) {
          const i = cellIndex(g, x, y, f);
          tmp[i] = 0.25 * a[side(i, 3, oW)] + 0.5 * a[i] + 0.25 * a[side(i, 4, oE)];
        }
      }
    }
    for (let f = 0; f < F; f++) {
      for (let y = 0; y < n; y++) {
        if (!active[f][y]) continue;
        for (let x = 0; x < n; x++) {
          const i = cellIndex(g, x, y, f);
          a[i] = 0.25 * tmp[side(i, 1, oN)] + 0.5 * tmp[i] + 0.25 * tmp[side(i, 6, oS)];
        }
      }
    }
  }
  // Blend weight from the widest corridor in the 3×3 neighbourhood (separable max), so rims next to
  // wide troughs soften too.
  const wRow = new Float32Array(N);
  for (let f = 0; f < F; f++) {
    for (let y = 0; y < n; y++) {
      if (!active[f][y]) continue;
      for (let x = 0; x < n; x++) {
        const i = cellIndex(g, x, y, f);
        let w = rc[i];
        const l = side(i, 3, oW);
        const r = side(i, 4, oE);
        if (rc[l] > w) w = rc[l];
        if (rc[r] > w) w = rc[r];
        wRow[i] = w;
      }
    }
  }
  for (let i = 0; i < N; i++) {
    if (a[i] === 0 && carve[i] === 0) continue;
    let w = wRow[i];
    const u = side(i, 1, oN);
    const d = side(i, 6, oS);
    if (wRow[u] > w) w = wRow[u];
    if (wRow[d] > w) w = wRow[d];
    const t = Math.min(1, Math.max(0, (w - 1) / 2));
    const al = t * t * (3 - 2 * t);
    a[i] = carve[i] + al * (a[i] - carve[i]);
  }
  return a;
}
