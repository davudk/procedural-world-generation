import { FACE_C, FACE_E, FACE_S, faceDir } from '../../shared/cube';
import { angle as arc } from '../grid/cube';
import { cellFace, cellX as colOf, cellY as rowOf, type Grid } from '../grid/grid';

const QUARTER = Math.PI / 4;
/** Step (rad) of the finite differences that turn 3D tangents into chart directions. */
const EPS = 1e-5;

/**
 * Registry positions on spheres (research 10 §5.11). Detectors pass positions around as one (x, y)
 * pair of metres, as on flat maps; on a sphere x carries the face: x = face · stride + u, y = v, with
 * (u, v) the face-local metres of the grid's SurfacePoint convention and stride = π·R (twice a face's
 * width, so the face is ⌊x / stride⌋). Every registry grid of a world shares R, so the encoding is the
 * same on the macro, regional and plates grids, and `cellAtM` decodes it on any of them. Positions are
 * only ever compared through `Geo` (great-circle distances) or decoded, never subtracted directly;
 * flat maps have stride 0 and Geo reduces to the planar expressions the detectors always used.
 * Landmarks leave the registry decoded (`Landmark.face`, `pathFace`).
 */
export class Geo {
  readonly sphere: boolean;
  readonly R: number;
  readonly stride: number;
  private readonly p = new Float64Array(3);
  private readonly q = new Float64Array(3);

  constructor(g: Grid) {
    this.sphere = g.faces !== 1;
    this.R = this.sphere ? g.radiusM : Infinity;
    this.stride = this.sphere ? Math.PI * g.radiusM : 0;
  }

  /** Encoded position of face-local metres (flat: u itself). */
  enc(face: number | undefined, u: number): number {
    return this.sphere ? (face ?? 0) * this.stride + u : u;
  }

  faceOf(x: number): number {
    return this.sphere ? Math.min(5, Math.max(0, Math.floor(x / this.stride))) : 0;
  }

  /** Face-local u of an encoded x. */
  u(x: number): number {
    return this.sphere ? x - this.faceOf(x) * this.stride : x;
  }

  /** Unit vector of an encoded position (sphere only). */
  dir(x: number, y: number, out: Float64Array | Float32Array, o = 0): void {
    const f = this.faceOf(x);
    faceDir(f, (x - f * this.stride) / this.R - QUARTER, y / this.R - QUARTER, out, o);
  }

  /** Encoded position of a direction (any length). */
  fromDir(x: number, y: number, z: number): [number, number] {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    const face = ax >= ay && ax >= az ? (x > 0 ? 0 : 2) : ay >= az ? (y > 0 ? 1 : 3) : z > 0 ? 4 : 5;
    const o = face * 3;
    const dc = x * FACE_C[o] + y * FACE_C[o + 1] + z * FACE_C[o + 2];
    const a = Math.atan((x * FACE_E[o] + y * FACE_E[o + 1] + z * FACE_E[o + 2]) / dc) + QUARTER;
    const b = Math.atan((x * FACE_S[o] + y * FACE_S[o + 1] + z * FACE_S[o + 2]) / dc) + QUARTER;
    return [face * this.stride + a * this.R, b * this.R];
  }

  /** Distance between two positions (m): planar on flat maps, great circle on spheres. Small, so it inlines in flat loops. */
  dist(ax: number, ay: number, bx: number, by: number): number {
    return this.sphere ? this.arcDist(ax, ay, bx, by) : Math.hypot(ax - bx, ay - by);
  }

  /** Squared distance (flat: exactly (ax − bx)² + (ay − by)²). */
  d2(ax: number, ay: number, bx: number, by: number): number {
    return this.sphere ? this.arcDist(ax, ay, bx, by) ** 2 : (ax - bx) ** 2 + (ay - by) ** 2;
  }

  private arcDist(ax: number, ay: number, bx: number, by: number): number {
    this.dir(ax, ay, this.p);
    this.dir(bx, by, this.q);
    return this.R * arc(this.p, this.q);
  }

  /**
   * Label angle (labelAngle convention: counter-clockwise from the face's +u axis as seen with +v
   * down, folded to (−π/2, π/2]) at position (x, y) of the 3D tangent direction t.
   */
  angleOf(x: number, y: number, tx: number, ty: number, tz: number): number {
    const p = this.p;
    this.dir(x, y, p);
    const d = tx * p[0] + ty * p[1] + tz * p[2];
    tx -= d * p[0];
    ty -= d * p[1];
    tz -= d * p[2];
    const l = Math.hypot(tx, ty, tz);
    if (!(l > 1e-12)) return 0;
    const f = this.faceOf(x) * 3;
    const ab = (qx: number, qy: number, qz: number): [number, number] => {
      const dc = qx * FACE_C[f] + qy * FACE_C[f + 1] + qz * FACE_C[f + 2];
      return [
        Math.atan((qx * FACE_E[f] + qy * FACE_E[f + 1] + qz * FACE_E[f + 2]) / dc),
        Math.atan((qx * FACE_S[f] + qy * FACE_S[f + 1] + qz * FACE_S[f + 2]) / dc),
      ];
    };
    const [a0, b0] = ab(p[0], p[1], p[2]);
    const s = EPS / l;
    const [a1, b1] = ab(p[0] + tx * s, p[1] + ty * s, p[2] + tz * s);
    return labelAngleOf(a1 - a0, b1 - b0);
  }

  /** Label angle at (x, y) of the direction from unit vector a to unit vector b. */
  angleAlong(x: number, y: number, a: ArrayLike<number>, b: ArrayLike<number>): number {
    return this.angleOf(x, y, b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }

  /** Label angle at (x, y) of a direction (vx, vy) in cells (y down) in the face chart of cell c of g. */
  angleFromCell(g: Grid, c: number, vx: number, vy: number, x: number, y: number): number {
    const f = cellFace(g, c);
    const delta = Math.PI / 2 / g.n;
    const a = (colOf(g, c) + 0.5) * delta - QUARTER;
    const b = (rowOf(g, c) + 0.5) * delta - QUARTER;
    const l = Math.hypot(vx, vy) || 1;
    faceDir(f, a, b, this.p);
    faceDir(f, a + (EPS * vx) / l, b + (EPS * vy) / l, this.q);
    const p = this.p, q = this.q;
    return this.angleOf(x, y, q[0] - p[0], q[1] - p[1], q[2] - p[2]);
  }

  /** Normalised mean of unit vectors (3 per point), as a position. */
  meanOf(v: ArrayLike<number>, count: number, w?: ArrayLike<number>): [number, number] {
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < count; i++) {
      const k = w ? w[i] : 1;
      sx += k * v[3 * i];
      sy += k * v[3 * i + 1];
      sz += k * v[3 * i + 2];
    }
    return this.fromDir(sx, sy, sz);
  }
}

function labelAngleOf(dx: number, dy: number): number {
  let a = Math.atan2(-dy, dx);
  if (a > Math.PI / 2) a -= Math.PI;
  else if (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

/** Sphere polyline (encoded x, y pairs, Float64) through the points, at least `minStep` apart, ends kept. */
export function decimateS(geo: Geo, xs: ArrayLike<number>, ys: ArrayLike<number>, minStep: number): Float64Array {
  const out: number[] = [];
  const n = xs.length;
  if (n === 0) return new Float64Array(0);
  out.push(xs[0], ys[0]);
  let lx = xs[0];
  let ly = ys[0];
  for (let i = 1; i < n - 1; i++) {
    if (geo.dist(xs[i], ys[i], lx, ly) >= minStep) {
      out.push(xs[i], ys[i]);
      lx = xs[i];
      ly = ys[i];
    }
  }
  if (n > 1) out.push(xs[n - 1], ys[n - 1]);
  return Float64Array.from(out);
}

/** Great-circle length of a sphere polyline (m). */
export function polylineLengthS(geo: Geo, p: ArrayLike<number>): number {
  let L = 0;
  for (let i = 2; i < p.length; i += 2) L += geo.dist(p[i - 2], p[i - 1], p[i], p[i + 1]);
  return L;
}

/**
 * Point at fraction t of a sphere polyline's length and the local direction over ±span, as a chart
 * direction (dx, dy; y down) in the face of that point, so labelAngle(dx, dy) is its label angle.
 */
export function alongS(geo: Geo, p: ArrayLike<number>, t: number, span = 0.1): { x: number; y: number; dx: number; dy: number } {
  const L = polylineLengthS(geo, p);
  const a = new Float64Array(3);
  const b = new Float64Array(3);
  const at = (s: number, out: Float64Array): void => {
    s = Math.min(L, Math.max(0, s));
    let acc = 0;
    for (let i = 2; i < p.length; i += 2) {
      const d = geo.dist(p[i - 2], p[i - 1], p[i], p[i + 1]);
      if (acc + d >= s && d > 0) {
        const f = (s - acc) / d;
        geo.dir(p[i - 2], p[i - 1], a);
        geo.dir(p[i], p[i + 1], b);
        for (let k = 0; k < 3; k++) out[k] = a[k] + f * (b[k] - a[k]);
        return;
      }
      acc += d;
    }
    geo.dir(p[p.length - 2], p[p.length - 1], out);
  };
  const m = new Float64Array(3);
  const lo = new Float64Array(3);
  const hi = new Float64Array(3);
  at(t * L, m);
  at((t - span) * L, lo);
  at((t + span) * L, hi);
  const [x, y] = geo.fromDir(m[0], m[1], m[2]);
  // Chart direction in the point's face: the label angle's own convention.
  const f = geo.faceOf(x) * 3;
  const ab = (q: Float64Array): [number, number] => {
    const dc = q[0] * FACE_C[f] + q[1] * FACE_C[f + 1] + q[2] * FACE_C[f + 2];
    return [
      Math.atan((q[0] * FACE_E[f] + q[1] * FACE_E[f + 1] + q[2] * FACE_E[f + 2]) / dc),
      Math.atan((q[0] * FACE_S[f] + q[1] * FACE_S[f + 1] + q[2] * FACE_S[f + 2]) / dc),
    ];
  };
  const [a0, b0] = ab(lo);
  const [a1, b1] = ab(hi);
  return { x, y, dx: (a1 - a0) * geo.R, dy: (b1 - b0) * geo.R };
}
