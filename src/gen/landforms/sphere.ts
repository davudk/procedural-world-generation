/**
 * Landform positions and helpers on the cube-sphere (research 10 §5.8). Flat maps never reach this
 * module: every caller branches on `grid.shape` and keeps its flat arithmetic untouched.
 *
 * Position scheme ("chart km"): the landform passes keep positions as two numbers (x, y) km, as on
 * flat maps. On the sphere x = f·S + u and y = v, where (u, v) are km along the columns and rows of
 * face f's extended equal-angle chart (cell (cx, cy) of face f has its centre at ((cx + ½)·cellKm,
 * (cy + ½)·cellKm), exactly the SurfacePoint convention in km) and S = 4·W is a face stride (W = the
 * face width, n·cellKm). The chart of a face continues past its edges onto the neighbouring faces,
 * so u and v may lie anywhere in (−W/2, 1.5·W) (the chart ends 90° from the face centre): a cell's
 * coordinates on its own face, or the chart position of a point beyond a seam, are both valid
 * encodings. Every geometric operation decodes to a unit vector first: cells by direction, distances
 * along great circles, offsets in the local east/south frame (the flat dx east, dy south convention),
 * so stamps, spacing tests and lookups are continuous across seams and cube corners.
 */
import { dirSurface, dirToCell, FACE_E, FACE_S, surfaceDir } from '../../shared/cube';
import { angle, asCube, localFrame, unitPositions, type CubeGrid } from '../grid/cube';
import { cellFace, cellX, cellY, type Grid } from '../grid/grid';

/** Position codec and geometry of one cube grid (cached per grid by `spherePos`). */
export class SpherePos {
  /** Face width (km), face stride in x (km), radius (km and m). */
  readonly W: number;
  readonly S: number;
  readonly Rk: number;
  readonly Rm: number;
  private readonly t = new Float64Array(3);
  private readonly e = new Float64Array(3);
  private readonly nn = new Float64Array(3);

  constructor(readonly g: CubeGrid) {
    this.W = g.n * g.cellKm;
    this.S = 4 * this.W;
    this.Rk = g.radiusM / 1000;
    this.Rm = g.radiusM;
  }

  /** Face of an encoded x. */
  face(x: number): number {
    return Math.min(5, Math.max(0, Math.floor((x + this.W) / this.S)));
  }

  /** Unit vector of an encoded position. */
  dir(x: number, y: number, out: Float64Array): void {
    const f = this.face(x);
    surfaceDir(f, (x - f * this.S) * 1000, y * 1000, this.Rm, out);
  }

  /** Canonical encoding (face of the largest component) of a direction (any length). */
  enc(p: ArrayLike<number>): { x: number; y: number } {
    const s = this.t;
    dirSurface(p[0], p[1], p[2], this.Rm, s);
    return { x: s[0] * this.S + s[1] / 1000, y: s[2] / 1000 };
  }

  /** Encoding of chart km (u, v) of face f (may lie beyond the face edges). */
  chart(f: number, u: number, v: number): { x: number; y: number } {
    return { x: f * this.S + u, y: v };
  }

  /** Centre of cell i of grid g (any resolution of this sphere). */
  centre(g: Grid, i: number): { x: number; y: number } {
    return { x: cellFace(g, i) * this.S + (cellX(g, i) + 0.5) * g.cellKm, y: (cellY(g, i) + 0.5) * g.cellKm };
  }

  /** Cell of an n×n-per-face grid containing an encoded position. */
  cell(x: number, y: number, n: number): number {
    const p = this.t;
    this.dir(x, y, p);
    return dirToCell(p[0], p[1], p[2], n);
  }

  /** Great-circle distance (km) between two encoded positions. */
  dist(x0: number, y0: number, x1: number, y1: number): number {
    const p = new Float64Array(3);
    const q = new Float64Array(3);
    this.dir(x0, y0, p);
    this.dir(x1, y1, q);
    return this.Rk * angle(p, q);
  }

  /** The point dx km east and dy km south of (x, y), along the great circle in that direction. */
  offset(x: number, y: number, dx: number, dy: number): { x: number; y: number } {
    const p = new Float64Array(3);
    this.dir(x, y, p);
    this.move(p, dx, dy, p);
    return this.enc(p);
  }

  /** out = the direction dx km east and dy km south of the unit vector p (out may be p). */
  move(p: ArrayLike<number>, dx: number, dy: number, out: Float64Array): void {
    const e = this.e;
    const nn = this.nn;
    localFrame(p, e, nn);
    const d = Math.hypot(dx, dy);
    if (d === 0) {
      out[0] = p[0];
      out[1] = p[1];
      out[2] = p[2];
      return;
    }
    const th = d / this.Rk;
    const c = Math.cos(th);
    const s = Math.sin(th) / d;
    const t0 = dx * e[0] - dy * nn[0];
    const t1 = dx * e[1] - dy * nn[1];
    const t2 = dx * e[2] - dy * nn[2];
    const x = c * p[0] + s * t0;
    const y = c * p[1] + s * t1;
    const z = c * p[2] + s * t2;
    out[0] = x;
    out[1] = y;
    out[2] = z;
  }

  /**
   * Azimuthal-equidistant offset (km, east and south) of encoded position (x1, y1) as seen from
   * (x0, y0): out = [dx, dy, distance].
   */
  local(x0: number, y0: number, x1: number, y1: number, out: Float64Array): void {
    const p = new Float64Array(3);
    const q = new Float64Array(3);
    this.dir(x0, y0, p);
    this.dir(x1, y1, q);
    localOffset(p, q, this.Rk, out);
  }

  /** Feature position: face and face-local metres (SurfacePoint convention), canonical face. */
  feature(x: number, y: number): { face: number; x: number; y: number } {
    const p = new Float64Array(3);
    this.dir(x, y, p);
    const s = this.t;
    dirSurface(p[0], p[1], p[2], this.Rm, s);
    return { face: s[0], x: s[1], y: s[2] };
  }

  /** Feature position of a direction. */
  featureDir(p: ArrayLike<number>): { face: number; x: number; y: number } {
    const s = this.t;
    dirSurface(p[0], p[1], p[2], this.Rm, s);
    return { face: s[0], x: s[1], y: s[2] };
  }
}

const cache = new WeakMap<Grid, SpherePos>();

/** The position codec of a sphere grid. */
export function spherePos(g: Grid): SpherePos {
  let s = cache.get(g);
  if (!s) cache.set(g, (s = new SpherePos(asCube(g))));
  return s;
}

/** Azimuthal-equidistant east/south offset (km) of unit vector q seen from unit vector p: out = [dx, dy, d]. */
export function localOffset(p: ArrayLike<number>, q: ArrayLike<number>, Rk: number, out: Float64Array): void {
  const e = new Float64Array(3);
  const nn = new Float64Array(3);
  localFrame(p, e, nn);
  const th = angle(p, q);
  const pe = q[0] * e[0] + q[1] * e[1] + q[2] * e[2];
  const pn = q[0] * nn[0] + q[1] * nn[1] + q[2] * nn[2];
  const len = Math.hypot(pe, pn);
  const s = len > 0 ? (th * Rk) / len : 0;
  out[0] = pe * s;
  out[1] = -pn * s;
  out[2] = th * Rk;
}

/**
 * Block size for block lattices on the sphere: the divisor of the face size n nearest to `b` (in
 * ratio; ties to the smaller), since a block lattice on the cube must tile every face exactly.
 */
export function sphereBlock(n: number, b: number): number {
  let best = 1;
  let bestErr = Infinity;
  for (let d = 1; d <= n; d++) {
    if (n % d !== 0) continue;
    const err = Math.abs(Math.log(d / Math.max(1, b)));
    if (err < bestErr - 1e-12) {
      best = d;
      bestErr = err;
    }
  }
  return best;
}

/**
 * Face-axis components of a tangent vector v (3D) at cell i: out = [along the face's columns, along
 * its rows] (projections; the face axes are orthogonal except near the cube corners).
 */
export function tangentToFace(g: CubeGrid, i: number, v: ArrayLike<number>, out: Float64Array): void {
  const up = new Float64Array(3);
  g.position(i, up);
  const f = cellFace(g, i) * 3;
  out[0] = projAxis(FACE_E, f, up, v);
  out[1] = projAxis(FACE_S, f, up, v);
}

function projAxis(ax: Float64Array, f: number, up: Float64Array, v: ArrayLike<number>): number {
  const d = ax[f] * up[0] + ax[f + 1] * up[1] + ax[f + 2] * up[2];
  const t0 = ax[f] - d * up[0];
  const t1 = ax[f + 1] - d * up[1];
  const t2 = ax[f + 2] - d * up[2];
  const len = Math.hypot(t0, t1, t2) || 1;
  return (v[0] * t0 + v[1] * t1 + v[2] * t2) / len;
}

/** Face-axis components of a local (east, south) vector at cell i (out = [columns, rows]). */
export function eastSouthToFace(g: CubeGrid, i: number, ve: number, vs: number, out: Float64Array): void {
  const up = new Float64Array(3);
  const e = new Float64Array(3);
  const nn = new Float64Array(3);
  g.position(i, up);
  localFrame(up, e, nn);
  const v = [ve * e[0] - vs * nn[0], ve * e[1] - vs * nn[1], ve * e[2] - vs * nn[2]];
  tangentToFace(g, i, v, out);
}

/**
 * Per-label centroid on the sphere: label sums of the cell unit vectors and areas. `centre(l)` is the
 * encoded position of the normalised mean direction (km scheme above); `km2(l)` the region's area.
 */
export class SphereCentroids {
  private readonly s: Float64Array;
  private readonly a: Float64Array;
  private readonly p: Float32Array;

  constructor(private readonly g: CubeGrid, labels: number) {
    this.s = new Float64Array(labels * 3);
    this.a = new Float64Array(labels);
    this.p = unitPositions(g);
  }

  add(l: number, i: number): void {
    const p = this.p;
    this.s[l * 3] += p[i * 3];
    this.s[l * 3 + 1] += p[i * 3 + 1];
    this.s[l * 3 + 2] += p[i * 3 + 2];
    this.a[l] += this.g.area(i);
  }

  /** Mean direction of label l (unit vector). */
  dir(l: number): Float64Array {
    const s = this.s;
    const len = Math.hypot(s[l * 3], s[l * 3 + 1], s[l * 3 + 2]) || 1;
    return Float64Array.of(s[l * 3] / len, s[l * 3 + 1] / len, s[l * 3 + 2] / len);
  }

  centre(l: number): { x: number; y: number } {
    return spherePos(this.g).enc(this.dir(l));
  }

  km2(l: number): number {
    return this.a[l] / 1e6;
  }
}

/**
 * Poisson-disk spacing on the sphere for encoded positions: points are bucketed by their 3D position
 * (km) and compared along great circles, so spacing holds across seams and around cube corners.
 */
export class SphereDisk {
  private readonly buckets = new Map<number, Float64Array[]>();
  private readonly b: number;
  private readonly p = new Float64Array(3);

  constructor(private readonly sp: SpherePos, bucketKm: number) {
    // Keys hold ±2048 buckets per axis.
    this.b = Math.max(bucketKm, sp.Rk / 2000);
  }

  private key(bx: number, by: number, bz: number): number {
    return ((bx + 2048) * 4096 + (by + 2048)) * 4096 + (bz + 2048);
  }

  free(x: number, y: number, r: number): boolean {
    const p = this.p;
    this.sp.dir(x, y, p);
    const Rk = this.sp.Rk;
    const b = this.b;
    const bx = Math.floor((p[0] * Rk) / b);
    const by = Math.floor((p[1] * Rk) / b);
    const bz = Math.floor((p[2] * Rk) / b);
    // A chord is never longer than its arc, so the buckets within r (3D) hold every candidate.
    const span = Math.ceil(r / b);
    const lim = r / Rk;
    for (let i = bx - span; i <= bx + span; i++) {
      for (let j = by - span; j <= by + span; j++) {
        for (let k = bz - span; k <= bz + span; k++) {
          const list = this.buckets.get(this.key(i, j, k));
          if (!list) continue;
          for (const q of list) if (angle(p, q) < lim) return false;
        }
      }
    }
    return true;
  }

  add(x: number, y: number): void {
    const p = new Float64Array(3);
    this.sp.dir(x, y, p);
    const Rk = this.sp.Rk;
    const k = this.key(Math.floor((p[0] * Rk) / this.b), Math.floor((p[1] * Rk) / this.b), Math.floor((p[2] * Rk) / this.b));
    const list = this.buckets.get(k);
    if (list) list.push(p);
    else this.buckets.set(k, [p]);
  }
}
