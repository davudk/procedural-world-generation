import { Noise2 } from '../../shared/noise';
import { dirToCell, faceDir } from '../../shared/cube';
import { Noise3 } from '../../shared/noise3';
import type { Rng } from '../../shared/rng';
import { coarseFbm } from '../climate/fields';
import { angle, asCube, localFrame } from '../grid/cube';
import { cellFace, cellIndex, cellX, cellY, coarser, type Grid } from '../grid/grid';
import { components } from '../grid/ops';
import { downsample, upsample } from '../grid/smooth';
import { SphereCentroids, SphereDisk, spherePos } from './sphere';
import type { LandformCtx } from './types';

/**
 * Shared helpers for the M6 landform passes: physical-unit counts (Poisson), Poisson-disk spacing,
 * radial stamps with sub-cell supersampling, coarse noise fields, and the `fixed` bookkeeping that
 * every pass runs after editing heights. Positions are in km from the north-west corner on flat maps
 * and in the "chart km" scheme of `sphere.ts` on the sphere (decoded by every helper here, so the
 * passes treat them as opaque (x, y) pairs plus offsets in km east and south).
 */

/** Poisson draw (Knuth for small λ, rounded normal approximation above 30). */
export function poisson(rng: Rng, lambda: number): number {
  if (!(lambda > 0)) return 0;
  if (lambda > 30) {
    const u = Math.max(1e-12, rng.float());
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.float());
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * g));
  }
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  for (;;) {
    p *= rng.float();
    if (p <= L) return k;
    k++;
  }
}

export function shuffle<T>(rng: Rng, a: T[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

/**
 * Poisson-disk bookkeeping on a hash grid: `free(x, y, r)` is true when no stored point lies within
 * `r` km. Bucket size is the largest radius it will be asked about (smaller radii also work).
 */
export class DiskSet {
  readonly pts: { x: number; y: number }[] = [];
  private readonly buckets = new Map<number, number[]>();
  /** Sphere: great-circle spacing on decoded positions. */
  private readonly sphere: SphereDisk | null;

  /** `grid` (optional): on the sphere, positions are chart km and spacing is along great circles. */
  constructor(private readonly bucketKm: number, grid?: Grid) {
    this.sphere = grid && grid.shape !== 'flat' ? new SphereDisk(spherePos(grid), bucketKm) : null;
  }

  private key(bx: number, by: number): number {
    return (by + 1024) * 4096 + (bx + 1024);
  }

  free(x: number, y: number, r: number): boolean {
    if (this.sphere) return this.sphere.free(x, y, r);
    const b = this.bucketKm;
    const span = Math.ceil(r / b);
    const bx = Math.floor(x / b);
    const by = Math.floor(y / b);
    const r2 = r * r;
    for (let j = by - span; j <= by + span; j++) {
      for (let i = bx - span; i <= bx + span; i++) {
        const list = this.buckets.get(this.key(i, j));
        if (!list) continue;
        for (const k of list) {
          const p = this.pts[k];
          if ((p.x - x) ** 2 + (p.y - y) ** 2 < r2) return false;
        }
      }
    }
    return true;
  }

  add(x: number, y: number): void {
    if (this.sphere) {
      this.pts.push({ x, y });
      this.sphere.add(x, y);
      return;
    }
    const k = this.key(Math.floor(x / this.bucketKm), Math.floor(y / this.bucketKm));
    const list = this.buckets.get(k);
    this.pts.push({ x, y });
    if (list) list.push(this.pts.length - 1);
    else this.buckets.set(k, [this.pts.length - 1]);
  }
}

/** Macro cell containing (x, y) km, clamped. */
export function cellOf(c: LandformCtx, x: number, y: number): number {
  if (c.grid.shape !== 'flat') return spherePos(c.grid).cell(x, y, c.n);
  const n = c.n;
  const cx = Math.min(n - 1, Math.max(0, Math.floor(x / c.cellKm)));
  const cy = Math.min(n - 1, Math.max(0, Math.floor(y / c.cellKm)));
  return cellIndex(c.grid, cx, cy);
}

/** Centre of macro cell `i` in km. */
export function centreOf(c: LandformCtx, i: number): { x: number; y: number } {
  if (c.grid.shape !== 'flat') return spherePos(c.grid).centre(c.grid, i);
  return { x: (cellX(c.grid, i) + 0.5) * c.cellKm, y: (cellY(c.grid, i) + 0.5) * c.cellKm };
}

/** Plates-grid cell containing (x, y) km. */
export function plateCellAt(c: LandformCtx, x: number, y: number): number {
  const P = c.plates;
  if (c.grid.shape !== 'flat') return spherePos(c.grid).cell(x, y, P.n);
  const px = Math.min(P.n - 1, Math.max(0, Math.floor(x / P.cellKm)));
  const py = Math.min(P.n - 1, Math.max(0, Math.floor(y / P.cellKm)));
  return cellIndex(c.platesGrid, px, py);
}

/** Aridity index P / PET (≈ 0 hyper-arid, < 0.2 arid, < 0.5 semi-arid, > 0.65 humid). */
export function aridityAt(c: LandformCtx, i: number): number {
  return c.climate.precip[i] / Math.max(1, c.climate.pet[i]);
}

/** Great-circle (sphere) or straight (flat) distance in km between two positions. */
export function distKm(c: LandformCtx, x0: number, y0: number, x1: number, y1: number): number {
  if (c.grid.shape !== 'flat') return spherePos(c.grid).dist(x0, y0, x1, y1);
  return Math.hypot(x1 - x0, y1 - y0);
}

/** The position dx km east and dy km south of (x, y) (flat: x + dx, y + dy). */
export function offsetKm(c: LandformCtx, x: number, y: number, dx: number, dy: number): { x: number; y: number } {
  if (c.grid.shape !== 'flat') return spherePos(c.grid).offset(x, y, dx, dy);
  return { x: x + dx, y: y + dy };
}

/** Feature position (metres) of (x, y) km: map metres on flat maps, face and face-local metres on the sphere. */
export function featureAt(c: LandformCtx, x: number, y: number): { x: number; y: number; face?: number } {
  if (c.grid.shape !== 'flat') return spherePos(c.grid).feature(x, y);
  return { x: x * 1000, y: y * 1000 };
}

/** Mean height on a circle of radius r km around (x, y). */
export function ringMean(c: LandformCtx, x: number, y: number, r: number, samples = 24): number {
  if (c.grid.shape !== 'flat') {
    const sp = spherePos(c.grid);
    const p = new Float64Array(3);
    const q = new Float64Array(3);
    sp.dir(x, y, p);
    let s = 0;
    for (let k = 0; k < samples; k++) {
      const a = (k / samples) * Math.PI * 2;
      sp.move(p, r * Math.cos(a), r * Math.sin(a), q);
      s += c.h[dirToCell(q[0], q[1], q[2], c.n)];
    }
    return s / samples;
  }
  let s = 0;
  for (let k = 0; k < samples; k++) {
    const a = (k / samples) * Math.PI * 2;
    s += c.h[cellOf(c, x + r * Math.cos(a), y + r * Math.sin(a))];
  }
  return s / samples;
}

/**
 * Cells within r km of (x, y) on the sphere (each once), with their east/south offsets (km) in the
 * azimuthal-equidistant chart about that point. Collected before the caller runs, so callbacks may
 * use other chart helpers.
 */
function sphereDisk(c: LandformCtx, x: number, y: number, r: number): { cells: number[]; dx: number[]; dy: number[] } {
  const sp = spherePos(c.grid);
  const up = new Float64Array(3);
  sp.dir(x, y, up);
  const cells: number[] = [];
  const dx: number[] = [];
  const dy: number[] = [];
  asCube(c.grid).chartDir(up, r * 1000, (i, e, nn) => {
    cells.push(i);
    dx.push(e / 1000);
    dy.push(-nn / 1000);
  });
  return { cells, dx, dy };
}

/** Index of the highest cell within r km of (x, y). */
export function localMax(c: LandformCtx, x: number, y: number, r: number): number {
  if (c.grid.shape !== 'flat') {
    const d = sphereDisk(c, x, y, r);
    let best = cellOf(c, x, y);
    for (const q of d.cells) if (c.h[q] > c.h[best]) best = q;
    return best;
  }
  const n = c.n;
  const ck = c.cellKm;
  const x0 = Math.max(0, Math.floor((x - r) / ck));
  const x1 = Math.min(n - 1, Math.floor((x + r) / ck));
  const y0 = Math.max(0, Math.floor((y - r) / ck));
  const y1 = Math.min(n - 1, Math.floor((y + r) / ck));
  let best = cellOf(c, x, y);
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      if (((i + 0.5) * ck - x) ** 2 + ((j + 0.5) * ck - y) ** 2 > r * r) continue;
      const q = cellIndex(c.grid, i, j);
      if (c.h[q] > c.h[best]) best = q;
    }
  }
  return best;
}

/** h[i] minus the mean of its 8 neighbours (negative in valleys/channels). Border cells: 0. */
export function concavity(c: LandformCtx, i: number): number {
  const { border, off8: o } = c.grid;
  if (border[i]) {
    if (c.grid.shape === 'flat') return 0;
    // Sphere: seam cells read their neighbours from the seam table (7 at a cube corner).
    let s = 0;
    let k8 = 0;
    for (let k = 0; k < 8; k++) {
      const j = c.grid.nbr(i, k);
      if (j < 0) continue;
      s += c.h[j];
      k8++;
    }
    return c.h[i] - s / k8;
  }
  const h = c.h;
  // Raster offsets, summed W E N S NW NE SW SE.
  const m = (h[i + o[3]] + h[i + o[4]] + h[i + o[1]] + h[i + o[6]] + h[i + o[0]] + h[i + o[2]] + h[i + o[5]] + h[i + o[7]]) / 8;
  return h[i] - m;
}

/**
 * True if cell i drains somewhere: it is base level, on the map border (flat: an open edge), or has a
 * strictly lower 8-neighbour (on the sphere seam cells check theirs across the seam).
 */
export function drains(c: LandformCtx, i: number): boolean {
  if (c.fixed[i]) return true;
  const { border, off8Axial } = c.grid;
  const z = c.h[i];
  if (border[i]) {
    if (c.grid.shape === 'flat') return true;
    for (let k = 0; k < 8; k++) {
      const j = c.grid.nbr(i, k);
      if (j >= 0 && c.h[j] < z) return true;
    }
    return false;
  }
  for (let k = 0; k < 8; k++) if (c.h[i + off8Axial[k]] < z) return true;
  return false;
}

export type StampOp = 'add' | 'max' | 'min';

/**
 * Applies a radial profile around (x, y) km within `reachKm`. `f(rKm, dxKm, dyKm)` returns a height
 * delta ('add') or a target height ('max' raises to it, 'min' lowers to it); NaN skips the sample.
 * Small stamps are supersampled (up to 4×4 per cell) so sub-cell features leave their mean imprint
 * instead of vanishing between cell centres. Returns the number of cells touched.
 */
export function stampRadial(
  c: LandformCtx, x: number, y: number, reachKm: number, op: StampOp,
  f: (r: number, dx: number, dy: number) => number,
): number {
  if (c.grid.shape !== 'flat') return stampRadialSphere(c, x, y, reachKm, op, f);
  const n = c.n;
  const ck = c.cellKm;
  const h = c.h;
  const ss = Math.min(4, Math.max(1, Math.ceil((3 * ck) / Math.max(1e-6, reachKm))));
  const x0 = Math.max(0, Math.floor((x - reachKm) / ck));
  const x1 = Math.min(n - 1, Math.floor((x + reachKm) / ck));
  const y0 = Math.max(0, Math.floor((y - reachKm) / ck));
  const y1 = Math.min(n - 1, Math.floor((y + reachKm) / ck));
  let touched = 0;
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const cell = cellIndex(c.grid, i, j);
      let sum = 0;
      let cnt = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const dx = (i + (sx + 0.5) / ss) * ck - x;
          const dy = (j + (sy + 0.5) / ss) * ck - y;
          const r = Math.hypot(dx, dy);
          if (r > reachKm) {
            if (op !== 'add') { sum += h[cell]; cnt++; }
            continue;
          }
          const v = f(r, dx, dy);
          if (Number.isNaN(v)) {
            if (op !== 'add') { sum += h[cell]; cnt++; }
            continue;
          }
          if (op === 'add') sum += v;
          else if (op === 'max') sum += Math.max(h[cell], v);
          else sum += Math.min(h[cell], v);
          cnt++;
        }
      }
      if (op === 'add') {
        if (sum === 0) continue;
        h[cell] += sum / (ss * ss);
      } else {
        if (cnt === 0) continue;
        const v = sum / cnt;
        if (v === h[cell]) continue;
        h[cell] = v;
      }
      touched++;
    }
  }
  return touched;
}

/**
 * stampRadial on the sphere: the cells near the centre come from a geodesic chart (each once, so
 * 'add' stamps cannot double up across seams), and every sub-sample is placed in its own cell's face
 * chart and measured in the azimuthal-equidistant east/south frame about the centre, so the profile
 * is continuous across seams and cube corners.
 */
function stampRadialSphere(
  c: LandformCtx, x: number, y: number, reachKm: number, op: StampOp,
  f: (r: number, dx: number, dy: number) => number,
): number {
  const g = asCube(c.grid);
  const sp = spherePos(g);
  const ck = c.cellKm;
  const h = c.h;
  const ss = Math.min(4, Math.max(1, Math.ceil((3 * ck) / Math.max(1e-6, reachKm))));
  const up = new Float64Array(3);
  sp.dir(x, y, up);
  const east = new Float64Array(3);
  const north = new Float64Array(3);
  localFrame(up, east, north);
  const cells: number[] = [];
  // Every cell that a sub-sample within reach can fall in (cells are at most cellKm across).
  g.chartDir(up, (reachKm + ck) * 1000, (i) => cells.push(i));
  const q = new Float64Array(3);
  const Rk = sp.Rk;
  const d = g.delta;
  const Q = Math.PI / 4;
  let touched = 0;
  for (const cell of cells) {
    const face = cellFace(g, cell);
    const cx = cellX(g, cell);
    const cy = cellY(g, cell);
    let sum = 0;
    let cnt = 0;
    for (let sy = 0; sy < ss; sy++) {
      const b = (cy + (sy + 0.5) / ss) * d - Q;
      for (let sx = 0; sx < ss; sx++) {
        faceDir(face, (cx + (sx + 0.5) / ss) * d - Q, b, q);
        const th = angle(up, q);
        const r = th * Rk;
        if (r > reachKm) {
          if (op !== 'add') { sum += h[cell]; cnt++; }
          continue;
        }
        const pe = q[0] * east[0] + q[1] * east[1] + q[2] * east[2];
        const pn = q[0] * north[0] + q[1] * north[1] + q[2] * north[2];
        const len = Math.hypot(pe, pn);
        const k = len > 0 ? r / len : 0;
        const v = f(r, pe * k, -pn * k);
        if (Number.isNaN(v)) {
          if (op !== 'add') { sum += h[cell]; cnt++; }
          continue;
        }
        if (op === 'add') sum += v;
        else if (op === 'max') sum += Math.max(h[cell], v);
        else sum += Math.min(h[cell], v);
        cnt++;
      }
    }
    if (op === 'add') {
      if (sum === 0) continue;
      h[cell] += sum / (ss * ss);
    } else {
      if (cnt === 0) continue;
      const v = sum / cnt;
      if (v === h[cell]) continue;
      h[cell] = v;
    }
    touched++;
  }
  return touched;
}

/** Visits every cell whose centre lies within `r` km of (x, y) (offsets dx east, dy south, km). */
export function forDisk(c: LandformCtx, x: number, y: number, r: number, cb: (cell: number, rKm: number, dx: number, dy: number) => void): void {
  if (c.grid.shape !== 'flat') {
    const d = sphereDisk(c, x, y, r);
    for (let k = 0; k < d.cells.length; k++) cb(d.cells[k], Math.hypot(d.dx[k], d.dy[k]), d.dx[k], d.dy[k]);
    return;
  }
  const n = c.n;
  const ck = c.cellKm;
  const x0 = Math.max(0, Math.floor((x - r) / ck));
  const x1 = Math.min(n - 1, Math.floor((x + r) / ck));
  const y0 = Math.max(0, Math.floor((y - r) / ck));
  const y1 = Math.min(n - 1, Math.floor((y + r) / ck));
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const dx = (i + 0.5) * ck - x;
      const dy = (j + 0.5) * ck - y;
      const d = Math.hypot(dx, dy);
      if (d <= r) cb(cellIndex(c.grid, i, j), d, dx, dy);
    }
  }
}

/** One fBm layer of a coarse noise field: wavelength (km), octaves, weight. */
export interface NoiseLayer {
  km: number;
  octaves: number;
  weight: number;
}

/**
 * Weighted sum of fBm layers sampled on a coarse lattice (spacing = shortest wavelength / 4, at
 * most ~257²) and bilinearly interpolated to the macro grid: one cheap pass over the grid, and the
 * same field at every macro resolution.
 */
export function coarseNoise(c: LandformCtx, seed: number, layers: readonly NoiseLayer[]): Float32Array {
  if (c.grid.shape !== 'flat') {
    // Sphere: 3D noise at the surface position (continuous across seams), on a coarse cube lattice.
    const out = new Float32Array(c.grid.cells);
    for (let k = 0; k < layers.length; k++) {
      const f = coarseFbm(new Noise3((seed + k * 0x9e3779b1) >>> 0), c.grid, layers[k].km, layers[k].octaves, 0, 4);
      for (let i = 0; i < out.length; i++) out[i] += layers[k].weight * f[i];
    }
    return out;
  }
  const noises = layers.map((_, k) => new Noise2((seed + k * 0x9e3779b1) >>> 0));
  const W = c.n * c.cellKm;
  const step = Math.max(Math.min(...layers.map((l) => l.km)) / 4, W / 256);
  const m = Math.ceil(W / step) + 2;
  const lat = new Float32Array(m * m);
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      let v = 0;
      for (let k = 0; k < layers.length; k++) v += layers[k].weight * noises[k].fbm((i * step) / layers[k].km, (j * step) / layers[k].km, layers[k].octaves);
      lat[j * m + i] = v;
    }
  }
  return sampleLattice(c, lat, m, step);
}

/** Bilinear sample of an m×m lattice with spacing `step` km (lattice point 0 at the map corner). */
function sampleLattice(c: LandformCtx, lat: Float32Array, m: number, step: number): Float32Array {
  const n = c.n;
  const out = new Float32Array(n * n);
  const xi = new Int32Array(n);
  const xt = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    const fx = Math.min(m - 1.001, ((x + 0.5) * c.cellKm) / step);
    xi[x] = Math.floor(fx);
    xt[x] = fx - xi[x];
  }
  for (let y = 0; y < n; y++) {
    const fy = Math.min(m - 1.001, ((y + 0.5) * c.cellKm) / step);
    const j0 = Math.floor(fy);
    const ty = fy - j0;
    const r0 = j0 * m;
    const r1 = r0 + m;
    const row = cellIndex(c.grid, 0, y);
    for (let x = 0; x < n; x++) {
      const i0 = xi[x];
      const tx = xt[x];
      const a = lat[r0 + i0] + (lat[r0 + i0 + 1] - lat[r0 + i0]) * tx;
      const b = lat[r1 + i0] + (lat[r1 + i0 + 1] - lat[r1 + i0]) * tx;
      out[row + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/**
 * Caprock thickness on the macro grid (nearest base cell; the base grid may be coarser).
 */
export function strataField(c: LandformCtx): Float32Array {
  const b = c.base;
  const n = c.n;
  if (b.n === n) return b.strata;
  if (c.grid.shape !== 'flat') {
    // Sphere: the same nearest-cell rule on every face (the base and macro faces coincide).
    const out = new Float32Array(c.grid.cells);
    for (let face = 0; face < 6; face++) {
      for (let y = 0; y < n; y++) {
        const by = Math.min(b.n - 1, Math.floor(((y + 0.5) * b.n) / n));
        for (let x = 0; x < n; x++) {
          out[cellIndex(c.grid, x, y, face)] = b.strata[cellIndex(c.baseGrid, Math.min(b.n - 1, Math.floor(((x + 0.5) * b.n) / n)), by, face)];
        }
      }
    }
    return out;
  }
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const by = Math.min(b.n - 1, Math.floor(((y + 0.5) * b.n) / n));
    const row = cellIndex(c.grid, 0, y);
    for (let x = 0; x < n; x++) out[row + x] = b.strata[cellIndex(c.baseGrid, Math.min(b.n - 1, Math.floor(((x + 0.5) * b.n) / n)), by)];
  }
  return out;
}

/**
 * Box-filtered copy of a macro field on a ~4 km lattice (for regional statistics whose scale is
 * tens of km): downsample by mean, apply `fn` there, and return the coarse grid with its factor.
 */
export function coarsen(c: LandformCtx, a: Float32Array): { g: Float32Array; m: number; f: number } {
  const n = c.n;
  let f = Math.max(1, Math.round(4 / c.cellKm));
  while (f > 1 && n % f !== 0) f--;
  if (f === 1) return { g: a.slice(), m: n, f };
  const m = n / f;
  // Sphere: block means per face (coarser(grid, f) tiles every face).
  if (c.grid.shape !== 'flat') return { g: downsample(a, c.grid, f), m, f };
  const cg = coarser(c.grid, f);
  const g = new Float32Array(m * m);
  const inv = 1 / (f * f);
  for (let y = 0; y < n; y++) {
    const r = cellIndex(cg, 0, Math.floor(y / f));
    const row = cellIndex(c.grid, 0, y);
    for (let x = 0; x < n; x++) g[r + Math.floor(x / f)] += a[row + x];
  }
  for (let i = 0; i < m * m; i++) g[i] *= inv;
  return { g, m, f };
}

/** Bilinear upsample of a coarse field produced by `coarsen` back to the macro grid. */
export function refineCoarse(c: LandformCtx, g: Float32Array, m: number, f: number): Float32Array {
  if (f === 1) return g;
  if (c.grid.shape !== 'flat') {
    // Sphere: bilinear with taps across the seams (padded faces).
    const out = new Float32Array(c.grid.cells);
    upsample(g, coarser(c.grid, f), f, out);
    return out;
  }
  // Coarse cell centres sit at (k + 0.5)·f macro cells; shift so lattice point 0 is at the corner.
  const step = f * c.cellKm;
  const cg = coarser(c.grid, f);
  const lat = new Float32Array((m + 2) * (m + 2));
  for (let j = 0; j < m + 2; j++) {
    const sj = Math.min(m - 1, Math.max(0, j - 1));
    for (let i = 0; i < m + 2; i++) lat[j * (m + 2) + i] = g[cellIndex(cg, Math.min(m - 1, Math.max(0, i - 1)), sj)];
  }
  // Lattice point (i, j) ↔ coarse centre (i − 1 + 0.5)·step = (i − 0.5)·step; sample at x + 0.5·step.
  const n = c.n;
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const fy = ((y + 0.5) * c.cellKm) / step + 0.5;
    const j0 = Math.min(m, Math.floor(fy));
    const ty = fy - j0;
    const row = cellIndex(c.grid, 0, y);
    for (let x = 0; x < n; x++) {
      const fx = ((x + 0.5) * c.cellKm) / step + 0.5;
      const i0 = Math.min(m, Math.floor(fx));
      const tx = fx - i0;
      const r0 = j0 * (m + 2);
      const r1 = r0 + m + 2;
      const a = lat[r0 + i0] + (lat[r0 + i0 + 1] - lat[r0 + i0]) * tx;
      const b = lat[r1 + i0] + (lat[r1 + i0 + 1] - lat[r1 + i0]) * tx;
      out[row + x] = a + (b - a) * ty;
    }
  }
  return out;
}

/** Copy of heights and ocean mask before a pass edits them (input to `settleFixed`). */
export interface Snapshot {
  h: Float32Array;
  fixed: Uint8Array;
}

export function snapshot(c: LandformCtx): Snapshot {
  return { h: c.h.slice(), fixed: c.fixed.slice() };
}

/**
 * Restores the `fixed` invariant for cells whose height changed in a pass:
 * - open map-edge base cells (fixed with h > 0 before) stay fixed (flat maps only: on the sphere
 *   border cells are seams and fixed is exactly the sea);
 * - cells at or below 0 that were sea stay sea; sea raised above 0 becomes land (not fixed);
 * - land lowered to ≤ 0 becomes sea only if it connects (4-neighbours) to base level; enclosed
 *   ones are clamped to +0.5 m so they stay land (closed basins for hydrology, not new oceans).
 * Unchanged cells are left exactly as the earlier stages set them. Returns cells newly drowned.
 */
export function settleFixed(c: LandformCtx, s: Snapshot): number {
  const { grid: g, h, fixed } = c;
  const { cells: N, border, off4, axialToRaster } = g;
  // 4-neighbour k (axial order) of cell i, −1 off the map.
  const nb4 = (i: number, k: number): number => (border[i] === 0 ? i + off4[k] : g.nbr(i, axialToRaster[k]));
  const pending: number[] = [];
  const mapEdge = g.shape === 'flat';
  for (let i = 0; i < N; i++) {
    if (h[i] === s.h[i]) continue;
    if (mapEdge && s.fixed[i] && border[i] && s.h[i] > 0) {
      fixed[i] = 1;
      continue;
    }
    if (h[i] > 0) fixed[i] = 0;
    else if (s.fixed[i]) fixed[i] = 1;
    else {
      fixed[i] = 0;
      pending.push(i);
    }
  }
  if (pending.length === 0) return 0;
  const isPending = new Uint8Array(N);
  for (const i of pending) isPending[i] = 1;
  const stack: number[] = [];
  for (const i of pending) {
    for (let k = 0; k < 4; k++) {
      const j = nb4(i, k);
      if (j >= 0 && fixed[j]) {
        isPending[i] = 2;
        stack.push(i);
        break;
      }
    }
  }
  let drowned = 0;
  while (stack.length) {
    const i = stack.pop()!;
    fixed[i] = 1;
    drowned++;
    // Order-free: the flood marks every pending cell connected to the sea, whatever the visit order.
    for (let k = 0; k < 4; k++) {
      const j = nb4(i, k);
      if (j >= 0 && isPending[j] === 1) {
        isPending[j] = 2;
        stack.push(j);
      }
    }
  }
  for (const i of pending) if (isPending[i] === 1) h[i] = 0.5;
  return drowned;
}

/** Connected regions (4-neighbour) of `mask`, with cell count and centroid (km) per region. */
export function regions(c: LandformCtx, mask: Uint8Array): { label: Int32Array; size: number[]; cx: number[]; cy: number[]; km2?: number[] } {
  const { label, sizes } = components(mask, c.grid);
  if (c.grid.shape !== 'flat') {
    // Sphere: mean direction of the cells (a region may span seams) and true area.
    const sc = new SphereCentroids(asCube(c.grid), sizes.length);
    for (let i = 0; i < label.length; i++) if (label[i] >= 0) sc.add(label[i], i);
    const cx: number[] = [];
    const cy: number[] = [];
    const km2: number[] = [];
    for (let l = 0; l < sizes.length; l++) {
      const p = sc.centre(l);
      cx.push(p.x);
      cy.push(p.y);
      km2.push(sc.km2(l));
    }
    return { label, size: sizes, cx, cy, km2 };
  }
  const cx = new Array<number>(sizes.length).fill(0);
  const cy = new Array<number>(sizes.length).fill(0);
  for (let y = 0; y < c.n; y++) {
    const row = cellIndex(c.grid, 0, y);
    for (let x = 0; x < c.n; x++) {
      const l = label[row + x];
      if (l < 0) continue;
      cx[l] += (x + 0.5) * c.cellKm;
      cy[l] += (y + 0.5) * c.cellKm;
    }
  }
  for (let l = 0; l < sizes.length; l++) {
    cx[l] /= sizes[l];
    cy[l] /= sizes[l];
  }
  return { label, size: sizes, cx, cy };
}

/** Largest regions first, keeping those of at least `minKm2`, at most `cap`; plus the label raster. */
export function bigRegions(c: LandformCtx, mask: Uint8Array, minKm2: number, cap: number): { list: { x: number; y: number; km2: number; label: number }[]; label: Int32Array } {
  const r = regions(c, mask);
  const a = c.cellKm * c.cellKm;
  const out: { x: number; y: number; km2: number; label: number }[] = [];
  for (let l = 0; l < r.size.length; l++) {
    const km2 = r.km2 ? r.km2[l] : r.size[l] * a;
    if (km2 >= minKm2) out.push({ x: r.cx[l], y: r.cy[l], km2, label: l });
  }
  out.sort((p, q) => q.km2 - p.km2 || p.label - q.label);
  return { list: out.slice(0, cap), label: r.label };
}

/** World area relative to the 1024 km default (counts' caps scale with it; the sphere's whole surface). */
export function areaFactor(c: LandformCtx): number {
  if (c.grid.shape !== 'flat') return c.grid.totalArea / 1e6 / (1024 * 1024);
  return ((c.n * c.cellKm) / 1024) ** 2;
}

/** Mean cell area (km²): the sphere's cells average 0.85·cellKm² (flat: exactly cellKm²; flat code keeps cellKm·cellKm). */
export function meanCellKm2(c: LandformCtx): number {
  return c.grid.totalArea / c.grid.cells / 1e6;
}

/**
 * Multiplier for the absolute per-world caps of rare coastal features (rias, stacks, spits, tombolos,
 * atolls): 1 on flat maps (unchanged), the surface area in 1024² km maps on the sphere.
 */
export function capScale(c: LandformCtx): number {
  return c.grid.shape === 'flat' ? 1 : Math.max(1, areaFactor(c));
}

/** Cubic smoothstep. */
export function sstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Shape options for an irregular radial outline (see `Outline`). */
export interface OutlineOpts {
  /** Amplitude of the low-order harmonics + angular noise (share of the radius, e.g. 0.25). */
  amp: number;
  /** Highest harmonic (default 5; craters use ~8 for a slightly polygonal rim). */
  maxK?: number;
  /** Elongation (≥ 1) along `axis` (radians), area-preserving: a rift-zone direction for shields. */
  elong?: number;
  axis?: number;
  /** Number and extra reach (share of the radius) of narrow flank lobes / lava-flow tongues. */
  lobes?: number;
  lobeAmp?: number;
  /** Amplitude (share of x) and wavelength (km) of a 2D noise warp that roughens contours, coasts included. */
  warp?: number;
  warpKm?: number;
}

/**
 * Irregular outline for radial landforms, so no cone, caldera or crater is a perfect circle at any
 * zoom: low-order angular harmonics (k = 2…maxK, decaying as 1/k^0.8) plus angular noise, optional
 * area-preserving elongation, narrow radial lobes, and a 2D fBm warp in world space that roughens
 * every contour (and so the coastline where a cone meets the sea). `x(dx, dy)` maps an offset (km)
 * from the centre to a normalised radius (1 = the nominal edge), `theta(dx, dy)` to the angle in the
 * elongated frame (for radial gullies). Deterministic from the rng it is built with.
 */
export class Outline {
  private readonly ks: number[] = [];
  private readonly ak: number[] = [];
  private readonly pk: number[] = [];
  private readonly lobeA: number[] = [];
  private readonly lobeW: number[] = [];
  private readonly lobeH: number[] = [];
  private readonly ca: number;
  private readonly sa: number;
  private readonly se: number;
  private readonly np: number;
  /** Largest outline radius as a share of R (for stamp reach). */
  readonly maxScale: number;

  constructor(
    rng: Rng, private readonly noise: Noise2, private readonly cx: number, private readonly cy: number,
    private readonly R: number, private readonly o: OutlineOpts,
  ) {
    const maxK = o.maxK ?? 5;
    let norm = 0;
    for (let k = 2; k <= maxK; k++) {
      const a = rng.range(0.3, 1) / k ** 0.8;
      this.ks.push(k);
      this.ak.push(a);
      this.pk.push(rng.range(0, Math.PI * 2));
      norm += a;
    }
    for (let i = 0; i < this.ak.length; i++) this.ak[i] *= (0.75 * o.amp) / Math.max(1e-9, norm);
    const lobes = o.lobes ?? 0;
    for (let j = 0; j < lobes; j++) {
      this.lobeA.push(rng.range(0, Math.PI * 2));
      this.lobeW.push(rng.range(0.12, 0.3));
      this.lobeH.push((o.lobeAmp ?? 0) * rng.range(0.5, 1));
    }
    const axis = o.axis ?? 0;
    this.ca = Math.cos(axis);
    this.sa = Math.sin(axis);
    this.se = Math.sqrt(Math.max(1, o.elong ?? 1));
    this.np = rng.range(0, 1000);
    this.maxScale = (1 + 1.3 * o.amp + (lobes ? (o.lobeAmp ?? 0) : 0)) * this.se * (1 + 1.2 * (o.warp ?? 0));
  }

  /** Radius multiplier at angle θ (elongated frame). */
  scale(th: number): number {
    let m = 1 + 0.25 * this.o.amp * this.noise.noise(Math.cos(th) * 2.2 + this.np, Math.sin(th) * 2.2 - this.np);
    for (let i = 0; i < this.ks.length; i++) m += this.ak[i] * Math.cos(this.ks[i] * th + this.pk[i]);
    for (let j = 0; j < this.lobeA.length; j++) {
      let d = Math.abs(th - this.lobeA[j]) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      m += this.lobeH[j] * Math.exp(-((d / this.lobeW[j]) ** 2));
    }
    return Math.max(0.45, m);
  }

  theta(dx: number, dy: number): number {
    const u = (dx * this.ca + dy * this.sa) / this.se;
    const v = (-dx * this.sa + dy * this.ca) * this.se;
    return Math.atan2(v, u);
  }

  /** Normalised radius of offset (dx, dy) km: 0 at the centre, ≈ 1 on the irregular edge. */
  x(dx: number, dy: number): number {
    const u = (dx * this.ca + dy * this.sa) / this.se;
    const v = (-dx * this.sa + dy * this.ca) * this.se;
    const r = Math.hypot(u, v);
    let x = r / (this.R * this.scale(Math.atan2(v, u)));
    const w = this.o.warp ?? 0;
    if (w > 0) {
      const l = this.o.warpKm ?? 5;
      // Warp grows away from the centre: summits stay clean, edges and coasts get rough.
      x += w * Math.min(1, x) * this.noise.fbm((this.cx + dx) / l + this.np, (this.cy + dy) / l - this.np, 3);
    }
    return Math.max(0, x);
  }
}
