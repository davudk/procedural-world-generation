/**
 * The cube-sphere grid (research 10 §1–2): six n×n equal-angle faces, face-major and row-major in a
 * face (cell i = f·n² + y·n + x). Inside a face every raster algorithm works as on the flat map; only
 * the 4n − 4 border cells of each face see neighbours on another face, through the seam table. Grid
 * lines meet the face edges at the same points from both sides, so the neighbour across an edge is
 * the mirror cell on the adjacent face; at the 8 cube corners three faces meet and the corner cell has
 * 7 neighbours (the diagonal across the corner does not exist).
 *
 * Metric: per face position (shared by all faces, which are congruent) the exact cell area from the
 * closed-form solid angle and the great-circle distance to each raster neighbour, so the areas sum to
 * 4πR² up to rounding.
 */
import { dirToCell, dirToFaceXY, FACE_C, FACE_E, FACE_S } from '../../shared/cube';
import { AXIAL_DX, AXIAL_DY, RASTER_DX, RASTER_DY, type Grid, type MapEdge, type SurfacePoint } from './grid';

/** Face sides: x = 0, x = n − 1, y = 0, y = n − 1. */
export const SIDE_W = 0;
export const SIDE_E = 1;
export const SIDE_N = 2;
export const SIDE_S = 3;

/** Where a face side leads: the adjacent face, the side of it that is shared, and whether the along index reverses. */
export interface SeamEdge {
  face: number;
  side: number;
  flip: boolean;
}

const QUARTER = Math.PI / 4;

/** Solid angle of the tangent-plane rectangle [0, X] × [0, Y] seen from the cube centre. */
function omega(X: number, Y: number): number {
  return Math.atan((X * Y) / Math.sqrt(1 + X * X + Y * Y));
}

/** Index of the face whose centre is (x, y, z) (an exact axis vector). */
function faceWithCentre(x: number, y: number, z: number): number {
  for (let f = 0; f < 6; f++) if (FACE_C[f * 3] === x && FACE_C[f * 3 + 1] === y && FACE_C[f * 3 + 2] === z) return f;
  throw new Error('cube: no face with that centre');
}

export class CubeGrid implements Grid {
  readonly shape = 'sphere';
  readonly faces = 6;
  readonly cells: number;
  /** Cells per face (n²). */
  readonly n2: number;
  readonly off8: Int32Array;
  readonly off8Axial: Int32Array;
  readonly axialToRaster: Int8Array;
  readonly off4: Int32Array;
  readonly border: Uint8Array;
  readonly borderSlot: Int32Array;
  readonly seam: Int32Array;
  readonly cellM: number;
  readonly cellKm: number;
  readonly uniform = false;
  readonly areaTable: Float64Array;
  readonly distTable: Float32Array;
  readonly totalArea: number;
  readonly mapEdge: MapEdge = 'ocean';
  readonly outlets = null;
  readonly hasOutside = false;
  /** Angular cell size Δ = (π/2)/n. */
  readonly delta: number;
  /** tan of the cell-centre angle per column / row (n) and of the cell edges (n + 1). */
  readonly tanC: Float64Array;
  readonly tanE: Float64Array;
  /** Seam edge per face · 4 + side. */
  readonly edges: readonly SeamEdge[];
  private mark: Int32Array | null = null;
  private markGen = 0;
  private readonly pa = new Float64Array(3);
  private readonly pb = new Float64Array(3);
  private readonly pc = new Float64Array(3);
  private wmark: Int32Array | null = null;
  private wgen = 0;
  private inWindow = false;

  constructor(
    readonly n: number,
    readonly radiusM: number,
  ) {
    if (!(n >= 2) || !Number.isInteger(n) || n % 2 !== 0) throw new Error(`cubeGrid: bad face size ${n}`);
    const n2 = n * n;
    this.n2 = n2;
    this.cells = 6 * n2;
    this.delta = Math.PI / 2 / n;
    this.cellM = this.delta * radiusM;
    this.cellKm = this.cellM / 1000;
    this.totalArea = 4 * Math.PI * radiusM * radiusM;
    this.tanC = Float64Array.from({ length: n }, (_, x) => Math.tan((x + 0.5) * this.delta - QUARTER));
    this.tanE = Float64Array.from({ length: n + 1 }, (_, x) => Math.tan(x * this.delta - QUARTER));
    this.off8 = Int32Array.from(RASTER_DX, (dx, k) => RASTER_DY[k] * n + dx);
    this.off8Axial = Int32Array.from(AXIAL_DX, (dx, k) => AXIAL_DY[k] * n + dx);
    this.axialToRaster = Int8Array.from(AXIAL_DX, (dx, k) => RASTER_DX.findIndex((rx, r) => rx === dx && RASTER_DY[r] === AXIAL_DY[k]));
    this.off4 = this.off8Axial.slice(0, 4);
    this.edges = this.buildEdges();

    // Seam table: every face-border cell's 8 raster neighbours.
    this.border = new Uint8Array(this.cells);
    this.borderSlot = new Int32Array(this.cells).fill(-1);
    const perFace = 4 * n - 4;
    this.seam = new Int32Array(6 * perFace * 8);
    let slot = 0;
    for (let f = 0; f < 6; f++) {
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if (x !== 0 && y !== 0 && x !== n - 1 && y !== n - 1) continue;
          const i = f * n2 + y * n + x;
          this.border[i] = 1;
          this.borderSlot[i] = slot;
          for (let k = 0; k < 8; k++) this.seam[slot * 8 + k] = this.step(f, x + RASTER_DX[k], y + RASTER_DY[k]);
          slot++;
        }
      }
    }

    // Metric tables per face position.
    const R2 = radiusM * radiusM;
    this.areaTable = new Float64Array(n2);
    this.distTable = new Float32Array(n2 * 8);
    const p = this.pa;
    const q = this.pb;
    for (let y = 0; y < n; y++) {
      const Y0 = this.tanE[y];
      const Y1 = this.tanE[y + 1];
      for (let x = 0; x < n; x++) {
        const X0 = this.tanE[x];
        const X1 = this.tanE[x + 1];
        const i = y * n + x;
        this.areaTable[i] = R2 * (omega(X1, Y1) - omega(X0, Y1) - omega(X1, Y0) + omega(X0, Y0));
        this.position(i, p);
        for (let k = 0; k < 8; k++) {
          const j = this.nbr(i, k);
          if (j < 0) continue;
          this.position(j, q);
          this.distTable[i * 8 + k] = radiusM * angle(p, q);
        }
      }
    }
  }

  /** Neighbour across each face side, from the shared edge's points (exact, so it needs no tolerance). */
  private buildEdges(): SeamEdge[] {
    const n = this.n;
    const edges: SeamEdge[] = [];
    const F = new Float64Array(3);
    for (let f = 0; f < 6; f++) {
      const o = f * 3;
      for (let side = 0; side < 4; side++) {
        // The neighbour face's centre is the face axis that points out through this side.
        const sign = side === SIDE_W || side === SIDE_N ? -1 : 1;
        const ax = side === SIDE_W || side === SIDE_E ? FACE_E : FACE_S;
        const g = faceWithCentre(sign * ax[o] || 0, sign * ax[o + 1] || 0, sign * ax[o + 2] || 0);
        const go = g * 3;
        const dotC = (v: Float64Array): number => v[go] * FACE_C[o] + v[go + 1] * FACE_C[o + 1] + v[go + 2] * FACE_C[o + 2];
        const se = dotC(FACE_E);
        const ss = dotC(FACE_S);
        const gside = se > 0.5 ? SIDE_E : se < -0.5 ? SIDE_W : ss > 0.5 ? SIDE_S : SIDE_N;
        // Along index on g of this side's first cell decides the orientation.
        const t0 = this.edgeAlong(f, side, 0, g, gside, F);
        edges.push({ face: g, side: gside, flip: t0 !== 0 });
        if (t0 !== 0 && t0 !== n - 1) throw new Error('cube: seam edges do not line up');
      }
    }
    return edges;
  }

  /** Along index on face g (side gside) of the edge point next to along index t of face f's side. */
  private edgeAlong(f: number, side: number, t: number, g: number, gside: number, F: Float64Array): number {
    const b = (t + 0.5) * this.delta - QUARTER;
    const A = side === SIDE_W ? -1 : side === SIDE_E ? 1 : Math.tan(b);
    const B = side === SIDE_N ? -1 : side === SIDE_S ? 1 : Math.tan(b);
    const o = f * 3;
    for (let c = 0; c < 3; c++) F[c] = FACE_C[o + c] + A * FACE_E[o + c] + B * FACE_S[o + c];
    const go = g * 3;
    const ax = gside === SIDE_W || gside === SIDE_E ? FACE_S : FACE_E;
    const dc = F[0] * FACE_C[go] + F[1] * FACE_C[go + 1] + F[2] * FACE_C[go + 2];
    const v = (F[0] * ax[go] + F[1] * ax[go + 1] + F[2] * ax[go + 2]) / dc;
    return Math.round((Math.atan(v) + QUARTER) / this.delta - 0.5);
  }

  /**
   * Cell at face-local (x, y) of face f, where (x, y) may be one step off the face: then the mirror
   * cell across that side; −1 off two sides at once (the missing diagonal at a cube corner).
   */
  private step(f: number, x: number, y: number): number {
    const n = this.n;
    const offX = x < 0 ? SIDE_W : x >= n ? SIDE_E : -1;
    const offY = y < 0 ? SIDE_N : y >= n ? SIDE_S : -1;
    if (offX >= 0 && offY >= 0) return -1;
    if (offX < 0 && offY < 0) return f * this.n2 + y * n + x;
    const side = offX >= 0 ? offX : offY;
    return this.across(f, side, offX >= 0 ? y : x, 0);
  }

  /**
   * Cell on the face beyond side `side` of face f, at along index t (this face's row for W/E sides,
   * column for N/S) and `depth` cells in from the shared edge (0 = the mirror cell; clamped to the face).
   */
  across(f: number, side: number, t: number, depth: number): number {
    const n = this.n;
    const e = this.edges[f * 4 + side];
    const a = e.flip ? n - 1 - t : t;
    const d = Math.min(depth, n - 1);
    let x: number;
    let y: number;
    switch (e.side) {
      case SIDE_W: x = d; y = a; break;
      case SIDE_E: x = n - 1 - d; y = a; break;
      case SIDE_N: x = a; y = d; break;
      default: x = a; y = n - 1 - d; break;
    }
    return e.face * this.n2 + y * n + x;
  }

  nbr(i: number, k: number): number {
    const s = this.borderSlot[i];
    return s < 0 ? i + this.off8[k] : this.seam[s * 8 + k];
  }

  area(i: number): number {
    return this.areaTable[i % this.n2];
  }

  dist(i: number, k: number): number {
    return this.distTable[(i % this.n2) * 8 + k];
  }

  /** Unit vector of the cell centre. */
  position(i: number, out: Float64Array): void {
    const n = this.n;
    const f = Math.floor(i / this.n2);
    const r = i - f * this.n2;
    const y = Math.floor(r / n);
    const X = this.tanC[r - y * n];
    const Y = this.tanC[y];
    const o = f * 3;
    const inv = 1 / Math.sqrt(1 + X * X + Y * Y);
    out[0] = (FACE_C[o] + X * FACE_E[o] + Y * FACE_S[o]) * inv;
    out[1] = (FACE_C[o + 1] + X * FACE_E[o + 1] + Y * FACE_S[o + 1]) * inv;
    out[2] = (FACE_C[o + 2] + X * FACE_E[o + 2] + Y * FACE_S[o + 2]) * inv;
  }

  /** East (along the parallel), north and up at cell i; polar axis +z. */
  frame(i: number, east: Float64Array, north: Float64Array, up: Float64Array): void {
    this.position(i, up);
    localFrame(up, east, north);
  }

  distance(i: number, j: number): number {
    this.position(i, this.pa);
    this.position(j, this.pb);
    return this.radiusM * angle(this.pa, this.pb);
  }

  locate(p: SurfacePoint): number {
    const n = this.n;
    const x = Math.min(n - 1, Math.max(0, Math.floor(p.u / this.cellM)));
    const y = Math.min(n - 1, Math.max(0, Math.floor(p.v / this.cellM)));
    return p.face * this.n2 + y * n + x;
  }

  point(i: number): SurfacePoint {
    const n = this.n;
    const f = Math.floor(i / this.n2);
    const r = i - f * this.n2;
    const y = Math.floor(r / n);
    return { face: f, u: (r - y * n + 0.5) * this.cellM, v: (y + 0.5) * this.cellM };
  }

  /** Unit vector of a surface point. */
  pointDir(p: SurfacePoint, out: Float64Array): void {
    const X = Math.tan(p.u / this.radiusM - QUARTER);
    const Y = Math.tan(p.v / this.radiusM - QUARTER);
    const o = p.face * 3;
    const inv = 1 / Math.sqrt(1 + X * X + Y * Y);
    for (let c = 0; c < 3; c++) out[c] = (FACE_C[o + c] + X * FACE_E[o + c] + Y * FACE_S[o + c]) * inv;
  }

  /** Surface point of a direction. */
  dirPoint(x: number, y: number, z: number): SurfacePoint {
    const t = new Float64Array(3);
    dirToFaceXY(x, y, z, this.n, t);
    return { face: t[0], u: t[1] * this.cellM, v: t[2] * this.cellM };
  }

  /**
   * Cells whose centre is within `radiusM` (great circle) of c, found by a flood from c's cell, with
   * azimuthal-equidistant east / north offsets in metres (exact distances, local directions).
   */
  chart(c: SurfacePoint, radiusM: number, visit: (i: number, eastM: number, northM: number) => void): void {
    const up = new Float64Array(3);
    this.pointDir(c, up);
    this.chartDir(up, radiusM, visit);
  }

  chartDir(up: Float64Array, radiusM: number, visit: (i: number, eastM: number, northM: number) => void): void {
    const east = new Float64Array(3);
    const north = new Float64Array(3);
    localFrame(up, east, north);
    const R = this.radiusM;
    const mark = this.marks();
    const gen = this.markGen;
    const start = dirToCell(up[0], up[1], up[2], this.n);
    const queue = [start];
    mark[start] = gen;
    const p = this.pa;
    const lim = radiusM / R;
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      this.position(i, p);
      const dot = p[0] * up[0] + p[1] * up[1] + p[2] * up[2];
      const cx = p[1] * up[2] - p[2] * up[1];
      const cy = p[2] * up[0] - p[0] * up[2];
      const cz = p[0] * up[1] - p[1] * up[0];
      const th = Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), dot);
      if (th > lim && i !== start) continue;
      if (th <= lim) {
        const pe = p[0] * east[0] + p[1] * east[1] + p[2] * east[2];
        const pn = p[0] * north[0] + p[1] * north[1] + p[2] * north[2];
        const len = Math.hypot(pe, pn);
        const s = len > 0 ? (th * R) / len : 0;
        visit(i, pe * s, pn * s);
      }
      for (let k = 0; k < 8; k++) {
        const j = this.nbr(i, k);
        if (j < 0 || mark[j] === gen) continue;
        mark[j] = gen;
        queue.push(j);
      }
    }
  }

  /**
   * Continuous cell coordinates of the unit vector p in face f's extended equal-angle chart: column
   * and row with cell centres at integers (so in-face cells give exactly their x, y), continuing past
   * the face edges onto the neighbouring faces. False (out unchanged) when p is 90° or more from the
   * face's plane normal, where the chart ends.
   */
  chartXYDir(f: number, p: ArrayLike<number>, out: Float64Array): boolean {
    const o = f * 3;
    const dc = p[0] * FACE_C[o] + p[1] * FACE_C[o + 1] + p[2] * FACE_C[o + 2];
    if (!(dc > 1e-9)) return false;
    const X = (p[0] * FACE_E[o] + p[1] * FACE_E[o + 1] + p[2] * FACE_E[o + 2]) / dc;
    const Y = (p[0] * FACE_S[o] + p[1] * FACE_S[o + 1] + p[2] * FACE_S[o + 2]) / dc;
    out[0] = (Math.atan(X) + QUARTER) / this.delta - 0.5;
    out[1] = (Math.atan(Y) + QUARTER) / this.delta - 0.5;
    return true;
  }

  /** Extended chart coordinates of cell i's centre in face f's chart (exact integers when i is on f). */
  chartXY(f: number, i: number, out: Float64Array): boolean {
    const n = this.n;
    const fi = Math.floor(i / this.n2);
    if (fi === f) {
      const r = i - f * this.n2;
      const y = Math.floor(r / n);
      out[0] = r - y * n;
      out[1] = y;
      return true;
    }
    this.position(i, this.pc);
    return this.chartXYDir(f, this.pc, out);
  }

  /**
   * Cell at integer column x, row y of face f's extended chart: the cell itself on the face, else the
   * cell of the neighbouring face containing that chart point; −1 where the chart ends (≥ 90° away).
   */
  chartCell(f: number, x: number, y: number): number {
    const n = this.n;
    if (x >= 0 && y >= 0 && x < n && y < n) return f * this.n2 + y * n + x;
    const a = (x + 0.5) * this.delta - QUARTER;
    const b = (y + 0.5) * this.delta - QUARTER;
    if (Math.abs(a) >= Math.PI / 2 - 1e-6 || Math.abs(b) >= Math.PI / 2 - 1e-6) return -1;
    const X = Math.tan(a);
    const Y = Math.tan(b);
    const o = f * 3;
    return dirToCell(FACE_C[o] + X * FACE_E[o] + Y * FACE_S[o], FACE_C[o + 1] + X * FACE_E[o + 1] + Y * FACE_S[o + 1], FACE_C[o + 2] + X * FACE_E[o + 2] + Y * FACE_S[o + 2], n);
  }

  /** Cell at continuous chart coordinates (centres at integers) of face f; −1 where the chart ends. */
  chartCellAt(f: number, fx: number, fy: number): number {
    return this.chartCell(f, Math.round(fx), Math.round(fy));
  }

  /**
   * Visits each cell once whose centre, in the extended chart of c's face, lies in the (2r + 1)² box
   * around c (|round(dx)|, |round(dy)| ≤ r), with its chart offsets dx (east along the face's
   * columns) and dy (along its rows), in cells. Off c's face the offsets are not integers. Cells are
   * found by a flood from c, so the order is breadth-first. `visit` may return false to stop early.
   */
  window(c: number, r: number, visit: (j: number, dx: number, dy: number) => boolean | void): void {
    if (this.inWindow) throw new Error('cube: window() is not re-entrant');
    this.inWindow = true;
    try {
      const f = Math.floor(c / this.n2);
      const q = new Float64Array(2);
      this.chartXY(f, c, q);
      const cx = q[0];
      const cy = q[1];
      const mark = (this.wmark ??= new Int32Array(this.cells));
      if (++this.wgen > 0x7fffffff) {
        mark.fill(0);
        this.wgen = 1;
      }
      const gen = this.wgen;
      const queue = [c];
      mark[c] = gen;
      for (let h = 0; h < queue.length; h++) {
        const i = queue[h];
        if (!this.chartXY(f, i, q)) continue;
        const dx = q[0] - cx;
        const dy = q[1] - cy;
        if (Math.abs(Math.round(dx)) > r || Math.abs(Math.round(dy)) > r) continue;
        if (visit(i, dx, dy) === false) return;
        for (let k = 0; k < 8; k++) {
          const j = this.nbr(i, k);
          if (j < 0 || mark[j] === gen) continue;
          mark[j] = gen;
          queue.push(j);
        }
      }
    } finally {
      this.inWindow = false;
    }
  }

  /** The chart flood's mark array with a fresh generation. */
  private marks(): Int32Array {
    const mark = (this.mark ??= new Int32Array(this.cells));
    if (++this.markGen > 0x7fffffff) {
      mark.fill(0);
      this.markGen = 1;
    }
    return mark;
  }

  /** Raster slot k (0–7) with nbr(i, k) = j, or −1 when j is not a neighbour of i. */
  slotOf(i: number, j: number): number {
    for (let k = 0; k < 8; k++) if (this.nbr(i, k) === j) return k;
    return -1;
  }

  /** Bilinear sample within the face; taps beyond a face edge read the seam neighbour. */
  sample(field: Float32Array, p: SurfacePoint): number {
    const n = this.n;
    const fx = p.u / this.cellM - 0.5;
    const fy = p.v / this.cellM - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const tap = (x: number, y: number): number => {
      const cx = Math.min(n - 1, Math.max(0, x));
      const cy = Math.min(n - 1, Math.max(0, y));
      let i = p.face * this.n2 + cy * n + cx;
      if (cx !== x || cy !== y) {
        const k = (Math.sign(y - cy) + 1) * 3 + Math.sign(x - cx) + 1;
        const j = this.nbr(i, k > 4 ? k - 1 : k);
        if (k !== 4 && j >= 0) i = j;
      }
      return field[i];
    };
    const a0 = tap(x0, y0) + (tap(x0 + 1, y0) - tap(x0, y0)) * tx;
    const a1 = tap(x0, y0 + 1) + (tap(x0 + 1, y0 + 1) - tap(x0, y0 + 1)) * tx;
    return a0 + (a1 - a0) * ty;
  }
}

/** Angle between unit vectors (accurate for small angles). */
export function angle(p: ArrayLike<number>, q: ArrayLike<number>): number {
  const cx = p[1] * q[2] - p[2] * q[1];
  const cy = p[2] * q[0] - p[0] * q[2];
  const cz = p[0] * q[1] - p[1] * q[0];
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), p[0] * q[0] + p[1] * q[1] + p[2] * q[2]);
}

/** East and north unit vectors at the unit vector `up` (polar axis +z; at the exact poles east = +y). */
export function localFrame(up: ArrayLike<number>, east: Float64Array, north: Float64Array): void {
  let ex = -up[1];
  let ey = up[0];
  const len = Math.hypot(ex, ey);
  if (len < 1e-12) {
    ex = 0;
    ey = 1;
  } else {
    ex /= len;
    ey /= len;
  }
  east[0] = ex;
  east[1] = ey;
  east[2] = 0;
  north[0] = up[1] * 0 - up[2] * ey;
  north[1] = up[2] * ex - up[0] * 0;
  north[2] = up[0] * ey - up[1] * ex;
}

/** Cube-sphere grid with n×n cells per face on a sphere of `radiusM`. */
export function cubeGrid(n: number, radiusM: number): CubeGrid {
  return new CubeGrid(n, radiusM);
}

export function isCube(g: Grid): g is CubeGrid {
  return g.shape === 'sphere';
}

/** The cube grid of a sphere-shaped Grid (throws on flat). */
export function asCube(g: Grid): CubeGrid {
  if (!(g instanceof CubeGrid)) throw new Error('expected a cube-sphere grid');
  return g;
}

/** Cell of a direction (any length). */
export function cellOfDir(g: CubeGrid, x: number, y: number, z: number): number {
  return dirToCell(x, y, z, g.n);
}

const positionCache = new WeakMap<CubeGrid, Float32Array>();

/** Unit vectors of every cell centre (3 per cell, float32), cached per grid. For per-cell noise and fields. */
export function unitPositions(g: CubeGrid): Float32Array {
  let p = positionCache.get(g);
  if (!p) {
    p = new Float32Array(g.cells * 3);
    const v = new Float64Array(3);
    for (let i = 0; i < g.cells; i++) {
      g.position(i, v);
      p[i * 3] = v[0];
      p[i * 3 + 1] = v[1];
      p[i * 3 + 2] = v[2];
    }
    positionCache.set(g, p);
  }
  return p;
}

/** Latitude (degrees) of every cell. */
export function latitudes(g: CubeGrid): Float32Array {
  const p = unitPositions(g);
  return Float32Array.from({ length: g.cells }, (_, i) => (Math.asin(Math.max(-1, Math.min(1, p[i * 3 + 2]))) * 180) / Math.PI);
}

/**
 * Copies face f of `a` into `buf` ((n + 2r)² cells, row-major) with an r-cell halo gathered from the
 * four neighbour faces (rotated to this face's axes). The r×r halo corners, where three faces meet,
 * have no source and take the mean of the two adjacent halo strips. Depths beyond the neighbour face
 * clamp to its far edge.
 */
export function padFace(g: CubeGrid, a: ArrayLike<number>, f: number, r: number, buf: Float32Array | Float64Array): void {
  const n = g.n;
  const m = n + 2 * r;
  const base = f * g.n2;
  for (let y = 0; y < n; y++) {
    const src = base + y * n;
    const dst = (y + r) * m + r;
    for (let x = 0; x < n; x++) buf[dst + x] = a[src + x];
  }
  for (let d = 1; d <= r; d++) {
    for (let t = 0; t < n; t++) {
      buf[(r + t) * m + (r - d)] = a[g.across(f, SIDE_W, t, d - 1)];
      buf[(r + t) * m + (r + n - 1 + d)] = a[g.across(f, SIDE_E, t, d - 1)];
      buf[(r - d) * m + (r + t)] = a[g.across(f, SIDE_N, t, d - 1)];
      buf[(r + n - 1 + d) * m + (r + t)] = a[g.across(f, SIDE_S, t, d - 1)];
    }
  }
  for (let dy = 1; dy <= r; dy++) {
    for (let dx = 1; dx <= r; dx++) {
      const yN = r - dy;
      const yS = r + n - 1 + dy;
      const xW = r - dx;
      const xE = r + n - 1 + dx;
      buf[yN * m + xW] = 0.5 * (buf[r * m + xW] + buf[yN * m + r]);
      buf[yN * m + xE] = 0.5 * (buf[r * m + xE] + buf[yN * m + r + n - 1]);
      buf[yS * m + xW] = 0.5 * (buf[(r + n - 1) * m + xW] + buf[yS * m + r]);
      buf[yS * m + xE] = 0.5 * (buf[(r + n - 1) * m + xE] + buf[yS * m + r + n - 1]);
    }
  }
}

/**
 * Area-weighted value below which a fraction `q` of the surface lies (the sea level for a land share
 * 1 − q). Cells differ in area by up to √2 on the cube-sphere.
 */
export function weightedQuantile(a: Float32Array, g: CubeGrid, q: number): number {
  const N = a.length;
  const idx = new Uint32Array(N);
  for (let i = 0; i < N; i++) idx[i] = i;
  idx.sort((x, y) => a[x] - a[y] || x - y);
  if (N !== g.cells) throw new Error('weightedQuantile: field does not match the grid');
  const target = q * g.totalArea;
  let acc = 0;
  for (let k = 0; k < N; k++) {
    acc += g.areaTable[idx[k] % g.n2];
    if (acc > target) return a[idx[k]];
  }
  return a[idx[N - 1]];
}
