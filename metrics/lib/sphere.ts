/**
 * Sphere geometry for the metrics harness (research 10 §7): viewports as spherical caps, area-uniform
 * and area-weighted centres, great-circle distances and the sphere versions of the point statistics.
 *
 * A viewport is a `ViewProj`: a W × H rectangle of view metres with (0, 0) at the top-left, x east
 * and y south as on the flat map, plus the projection between unit vectors and that rectangle.
 * - `capView`: azimuthal equidistant about the centre, so distances from the centre and the view's
 *   axes are true ground lengths (a band's nominal width is a ground width). Away from the axes the
 *   projection stretches tangentially by θ / sin θ (≤ 9 % at the corners of a 1024 km view on the
 *   default 652 km planet, ≤ 1 % for band R); this is the known bias of the cap measures.
 * - `globeView`: the orthographic disc of a whole-planet view (band G), 2R across. Only points whose
 *   surface faces the eye by at least `minFacing` (cosine, the labels' GLOBE_MIN_FACING) are in it.
 */
import { localFrame } from '../../src/gen/grid/cube';
import { fitLine } from './math';

export interface ViewProj {
  /** View width and height (m). */
  readonly W: number;
  readonly H: number;
  /** Centre direction (unit vector). */
  readonly c: Float64Array;
  /** Writes the view position of unit vector (x, y, z) to out[0..1]; false when it is not on the view's sheet. */
  project(x: number, y: number, z: number, out: Float64Array): boolean;
  /** Writes the unit vector at view position (px, py) to out[0..2]; false outside the projection's domain. */
  unproject(px: number, py: number, out: Float64Array): boolean;
}

/** Azimuthal-equidistant cap view of W × H ground metres about the unit vector c on a sphere of radius R. */
export function capView(c: ArrayLike<number>, R: number, W: number, H: number): ViewProj {
  const cc = Float64Array.from([c[0], c[1], c[2]]);
  const e = new Float64Array(3);
  const n = new Float64Array(3);
  localFrame(cc, e, n);
  const hx = W / 2;
  const hy = H / 2;
  return {
    W, H, c: cc,
    project(x, y, z, out) {
      const pc = x * cc[0] + y * cc[1] + z * cc[2];
      const pe = x * e[0] + y * e[1] + z * e[2];
      const pn = x * n[0] + y * n[1] + z * n[2];
      const s = Math.hypot(pe, pn);
      const th = Math.atan2(s, pc);
      // Beyond 120° the projection is too stretched to mean anything; no view is that large.
      if (th > (2 * Math.PI) / 3) return false;
      const k = s > 1e-15 ? (th * R) / s : R;
      out[0] = hx + pe * k;
      out[1] = hy - pn * k;
      return true;
    },
    unproject(px, py, out) {
      const ex = px - hx;
      const ny = hy - py;
      const d = Math.hypot(ex, ny);
      const th = d / R;
      if (th > Math.PI) return false;
      const s = d > 1e-9 ? Math.sin(th) / d : 1 / R;
      const co = Math.cos(th);
      for (let k = 0; k < 3; k++) out[k] = cc[k] * co + (e[k] * ex + n[k] * ny) * s;
      return true;
    },
  };
}

/** Orthographic whole-planet view (band G): a 2R × 2R square holding the disc, facing ≥ minFacing only. */
export function globeView(c: ArrayLike<number>, R: number, minFacing: number): ViewProj {
  const cc = Float64Array.from([c[0], c[1], c[2]]);
  const e = new Float64Array(3);
  const n = new Float64Array(3);
  localFrame(cc, e, n);
  return {
    W: 2 * R, H: 2 * R, c: cc,
    project(x, y, z, out) {
      if (x * cc[0] + y * cc[1] + z * cc[2] < minFacing) return false;
      out[0] = R + (x * e[0] + y * e[1] + z * e[2]) * R;
      out[1] = R - (x * n[0] + y * n[1] + z * n[2]) * R;
      return true;
    },
    unproject(px, py, out) {
      const a = (px - R) / R;
      const b = (R - py) / R;
      const q = 1 - a * a - b * b;
      if (q < minFacing * minFacing) return false;
      const f = Math.sqrt(q);
      for (let k = 0; k < 3; k++) out[k] = cc[k] * f + e[k] * a + n[k] * b;
      return true;
    },
  };
}

/** Area-uniform random unit vector (Marsaglia's method on the [−1, 1]² square). */
export function randomDir(rnd: () => number, out: Float64Array): void {
  for (;;) {
    const a = 2 * rnd() - 1;
    const b = 2 * rnd() - 1;
    const s = a * a + b * b;
    if (s >= 1 || s === 0) continue;
    const f = 2 * Math.sqrt(1 - s);
    out[0] = a * f;
    out[1] = b * f;
    out[2] = 1 - 2 * s;
    return;
  }
}

/**
 * Index into `list` drawn with probability ∝ weight(list[k]) by rejection against `maxWeight` (cell
 * areas vary by ≤ 2.6× on the cube sphere, so this takes ≤ ~2 draws on average).
 */
export function pickWeighted(list: ArrayLike<number>, weight: (i: number) => number, maxWeight: number, rnd: () => number): number {
  for (let guard = 0; guard < 1000; guard++) {
    const i = list[Math.floor(rnd() * list.length)];
    if (rnd() * maxWeight <= weight(i)) return i;
  }
  return list[Math.floor(rnd() * list.length)];
}

/** Great-circle distance between unit vectors a[ia..] and b[ib..] on a sphere of radius R (accurate at small angles). */
export function geodesic(a: ArrayLike<number>, ia: number, b: ArrayLike<number>, ib: number, R: number): number {
  const ax = a[ia], ay = a[ia + 1], az = a[ia + 2];
  const bx = b[ib], by = b[ib + 1], bz = b[ib + 2];
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return R * Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), ax * bx + ay * by + az * bz);
}

/**
 * Clark–Evans ratio on the sphere: mean great-circle nearest-neighbour distance over 0.5 / √(n / area),
 * for unit vectors `dirs` (3 per point) and the area (m²) the points are spread over. Points are bucketed
 * on a coarse cube so it stays near O(n). NaN for n < 3.
 */
export function clarkEvansSphere(dirs: ArrayLike<number>, area: number, R: number): number {
  const n = Math.floor(dirs.length / 3);
  if (n < 3 || !(area > 0)) return NaN;
  let sum = 0;
  const near = nearestNeighbours(dirs, R);
  for (let k = 0; k < n; k++) sum += near[k];
  return sum / n / (0.5 / Math.sqrt(n / area));
}

/** Great-circle distance from each point to its nearest other point (m). */
export function nearestNeighbours(dirs: ArrayLike<number>, R: number): Float64Array {
  const n = Math.floor(dirs.length / 3);
  const out = new Float64Array(n).fill(Infinity);
  // Buckets: a 3D lattice over [−1, 1]³ with ~√n cells per axis-ish; a point's neighbours are found by
  // expanding shells until the shell is farther (as a chord) than the best distance.
  const m = Math.max(1, Math.min(64, Math.round(Math.cbrt(n) * 1.5)));
  const cell = 2 / m;
  const key = (i: number, j: number, k: number): number => (i * m + j) * m + k;
  const buckets = new Map<number, number[]>();
  const ci = (v: number): number => Math.min(m - 1, Math.max(0, Math.floor((v + 1) / cell)));
  for (let p = 0; p < n; p++) {
    const kk = key(ci(dirs[3 * p]), ci(dirs[3 * p + 1]), ci(dirs[3 * p + 2]));
    const b = buckets.get(kk);
    if (b) b.push(p);
    else buckets.set(kk, [p]);
  }
  for (let p = 0; p < n; p++) {
    const x = ci(dirs[3 * p]);
    const y = ci(dirs[3 * p + 1]);
    const z = ci(dirs[3 * p + 2]);
    let bestChord = Infinity;
    for (let r = 0; r <= m; r++) {
      for (let i = x - r; i <= x + r; i++) {
        if (i < 0 || i >= m) continue;
        for (let j = y - r; j <= y + r; j++) {
          if (j < 0 || j >= m) continue;
          for (let k = z - r; k <= z + r; k++) {
            if (k < 0 || k >= m) continue;
            if (Math.max(Math.abs(i - x), Math.abs(j - y), Math.abs(k - z)) !== r) continue;
            const b = buckets.get(key(i, j, k));
            if (!b) continue;
            for (const q of b) {
              if (q === p) continue;
              const d = Math.hypot(dirs[3 * q] - dirs[3 * p], dirs[3 * q + 1] - dirs[3 * p + 1], dirs[3 * q + 2] - dirs[3 * p + 2]);
              if (d < bestChord) bestChord = d;
            }
          }
        }
      }
      // Anything outside the searched shell is at least r cells (as a chord) away.
      if (bestChord <= r * cell) break;
    }
    out[p] = Number.isFinite(bestChord) ? 2 * R * Math.asin(Math.min(1, bestChord / 2)) : Infinity;
  }
  return out;
}

/** Largest number of points within `radiusM` (great circle) of any one point. */
export function maxInDisk(dirs: ArrayLike<number>, radiusM: number, R: number): number {
  const n = Math.floor(dirs.length / 3);
  const cosR = Math.cos(radiusM / R);
  let best = 0;
  for (let a = 0; a < n; a++) {
    let k = 0;
    for (let b = 0; b < n; b++) {
      if (dirs[3 * a] * dirs[3 * b] + dirs[3 * a + 1] * dirs[3 * b + 1] + dirs[3 * a + 2] * dirs[3 * b + 2] >= cosR) k++;
    }
    best = Math.max(best, k);
  }
  return best;
}

/**
 * Box-counting dimension of the set cells of a 6-face cube mask (n × n per face): boxes of s cells are
 * counted per face and summed (boxes do not straddle seams, a small bias at the 12 edges).
 */
export function boxCountDimensionFaces(mask: Uint8Array, n: number, maxDiv = 8): number {
  const xs: number[] = [];
  const ys: number[] = [];
  const n2 = n * n;
  for (let s = 1; s <= n / maxDiv; s *= 2) {
    const m = Math.ceil(n / s);
    let count = 0;
    for (let f = 0; f < 6; f++) {
      const hit = new Uint8Array(m * m);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (!mask[f * n2 + y * n + x]) continue;
          const k = Math.floor(y / s) * m + Math.floor(x / s);
          if (!hit[k]) {
            hit[k] = 1;
            count++;
          }
        }
      }
    }
    if (count === 0) return NaN;
    xs.push(Math.log(1 / s));
    ys.push(Math.log(count));
  }
  return fitLine(xs, ys).slope;
}
