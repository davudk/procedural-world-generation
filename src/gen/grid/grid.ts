/**
 * The world grid (research 10 §2). Every stage and raster helper takes a `Grid` instead of a bare
 * side length, so a cube-sphere grid can later stand in for the flat map without touching the
 * algorithms. Flat is a 1-face grid with no seams: its border cells are the map edge and off-map
 * neighbours are skipped, exactly as before.
 *
 * Hot loops read plain fields (`n`, `off8`, `border`, …), never methods per neighbour: interior cells
 * use the constant offsets, and only border cells (`border[i] = 1`) take the slow path through
 * `nbr`. Methods (`point`, `chart`, `sample`, …) are for per-feature code.
 *
 * Index layout: cell i = f·n² + y·n + x, face-major, row-major within a face, row 0 = the face's
 * north (flat: the map's north edge, y grows south).
 */

export type WorldShape = 'flat' | 'sphere';
export type MapEdge = 'ocean' | 'continent';

/** A point on the surface: face and face-local metres (flat: face 0, map x/y metres from the NW corner, y down). */
export interface SurfacePoint {
  face: number;
  u: number;
  v: number;
}

export interface GridTopology {
  readonly shape: WorldShape;
  readonly faces: 1 | 6;
  /** Cells per face edge. */
  readonly n: number;
  /** faces · n². */
  readonly cells: number;
  /**
   * D8 offsets for interior cells in the two orders the code uses (research 10 §4.1). Raster order
   * (NW N NE W E SW S SE: hydro/grid8, the LEM, Priority-Flood) is the canonical k of `nbr` and of
   * the seam table; axial-first order (E W S N SE NE SW NW: distance fields, plates, landforms,
   * coast, registry) maps to it through `axialToRaster`. `off4` = the axial four (E W S N).
   */
  readonly off8: Int32Array;
  readonly off8Axial: Int32Array;
  readonly axialToRaster: Int8Array;
  readonly off4: Int32Array;
  /** 1 where some neighbour is off the map (flat) or on another face (sphere). Flat: the 4n − 4 edge cells. */
  readonly border: Uint8Array;
  /** Sphere only: seam[borderSlot[i]·8 + k] = raster neighbour k of border cell i, or −1. Null on flat. */
  readonly borderSlot: Int32Array | null;
  readonly seam: Int32Array | null;
  /** Raster neighbour k (0–7) of cell i, −1 if none. For border slow paths and non-hot code. */
  nbr(i: number, k: number): number;
}

export interface GridMetric {
  /** Sphere radius in metres; Infinity for flat. */
  readonly radiusM: number;
  /** Nominal cell spacing (flat: exact, = cellKm · 1000). */
  readonly cellM: number;
  /** Nominal cell spacing in km (flat: worldKm / n, the constant the stages always used). */
  readonly cellKm: number;
  /** True for flat: every cell has area cellM² and neighbour distances cellM, cellM·√2. */
  readonly uniform: boolean;
  /** Per face position (n² entries, shared by all faces); null when uniform. */
  readonly areaTable: Float64Array | null;
  /** Per face position × 8 raster neighbours, metres; null when uniform. */
  readonly distTable: Float32Array | null;
  /** Total surface area, m² (flat: (n·cellM)²). */
  readonly totalArea: number;
  area(i: number): number;
  /** Distance to raster neighbour k, metres. */
  dist(i: number, k: number): number;
}

export interface GridGeometry {
  /** Cell centre: (x, y, 0) map metres on flat (a unit vector on the sphere). */
  position(i: number, out: Float64Array): void;
  /** Local frame at cell i: east, north, up. Flat: (+x, −y, +z), since map north is −y. */
  frame(i: number, east: Float64Array, north: Float64Array, up: Float64Array): void;
  /** Distance between two cell centres, metres (flat: Euclidean; sphere: great circle). */
  distance(i: number, j: number): number;
  /** Cell containing a surface point (clamped to the map on flat). */
  locate(p: SurfacePoint): number;
  /** Centre of cell i. */
  point(i: number): SurfacePoint;
  /**
   * Visits every cell whose centre lies within `radiusM` of `c`, with its east/north offset in metres
   * (flat: plain offsets, rows north to south, west to east; sphere: gnomonic about c).
   */
  chart(c: SurfacePoint, radiusM: number, visit: (i: number, eastM: number, northM: number) => void): void;
  /** Bilinear sample of a cell-centred field at a point (edges clamp on flat). */
  sample(field: Float32Array, p: SurfacePoint): number;
}

export interface GridBoundary {
  /** Map edge as configured (flat only). */
  readonly mapEdge: MapEdge;
  /** Flat with mapEdge = continent: the edge cells, where water leaves the map. Null otherwise (and always on the sphere). */
  readonly outlets: Uint8Array | null;
  /** Whether air and water can arrive from outside the map (flat only). */
  readonly hasOutside: boolean;
}

export type Grid = GridTopology & GridMetric & GridGeometry & GridBoundary;

/** Raster-order D8: NW N NE W E SW S SE. */
export const RASTER_DX = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
export const RASTER_DY = [-1, -1, -1, 0, 0, 1, 1, 1] as const;
/** Axial-first D8: E W S N SE NE SW NW. */
export const AXIAL_DX = [1, -1, 0, 0, 1, 1, -1, -1] as const;
export const AXIAL_DY = [0, 0, 1, -1, 1, -1, 1, -1] as const;

const AXIAL_TO_RASTER = Int8Array.from(AXIAL_DX, (dx, k) => RASTER_DX.findIndex((rx, r) => rx === dx && RASTER_DY[r] === AXIAL_DY[k]));

class FlatGrid implements Grid {
  readonly shape = 'flat';
  readonly faces = 1;
  readonly cells: number;
  readonly off8: Int32Array;
  readonly off8Axial: Int32Array;
  readonly axialToRaster = AXIAL_TO_RASTER;
  readonly off4: Int32Array;
  readonly border: Uint8Array;
  readonly borderSlot = null;
  readonly seam = null;
  readonly radiusM = Infinity;
  readonly cellM: number;
  readonly uniform = true;
  readonly areaTable = null;
  readonly distTable = null;
  readonly totalArea: number;
  readonly outlets: Uint8Array | null;
  readonly hasOutside: boolean;
  private readonly area0: number;
  private readonly dist8: Float64Array;

  constructor(
    readonly n: number,
    readonly cellKm: number,
    readonly mapEdge: MapEdge,
  ) {
    if (!(n >= 2) || !Number.isInteger(n)) throw new Error(`flatGrid: bad size ${n}`);
    this.cells = n * n;
    this.cellM = cellKm * 1000;
    this.area0 = this.cellM * this.cellM;
    this.totalArea = n * n * this.area0;
    this.dist8 = Float64Array.from(RASTER_DX, (dx, k) => (dx !== 0 && RASTER_DY[k] !== 0 ? Math.SQRT2 : 1) * this.cellM);
    this.off8 = Int32Array.from(RASTER_DX, (dx, k) => RASTER_DY[k] * n + dx);
    this.off8Axial = Int32Array.from(AXIAL_DX, (dx, k) => AXIAL_DY[k] * n + dx);
    this.off4 = this.off8Axial.slice(0, 4);
    this.border = new Uint8Array(this.cells);
    for (let x = 0; x < n; x++) {
      this.border[x] = 1;
      this.border[this.cells - n + x] = 1;
      this.border[x * n] = 1;
      this.border[x * n + n - 1] = 1;
    }
    this.outlets = mapEdge === 'continent' ? this.border : null;
    this.hasOutside = true;
  }

  nbr(i: number, k: number): number {
    const n = this.n;
    const x = i % n;
    const y = (i - x) / n;
    const nx = x + RASTER_DX[k];
    const ny = y + RASTER_DY[k];
    return nx < 0 || ny < 0 || nx >= n || ny >= n ? -1 : i + this.off8[k];
  }

  area(): number {
    return this.area0;
  }

  dist(_i: number, k: number): number {
    return this.dist8[k];
  }

  position(i: number, out: Float64Array): void {
    const x = i % this.n;
    out[0] = (x + 0.5) * this.cellM;
    out[1] = ((i - x) / this.n + 0.5) * this.cellM;
    out[2] = 0;
  }

  frame(_i: number, east: Float64Array, north: Float64Array, up: Float64Array): void {
    east.set([1, 0, 0]);
    north.set([0, -1, 0]);
    up.set([0, 0, 1]);
  }

  distance(i: number, j: number): number {
    const n = this.n;
    const xi = i % n;
    const xj = j % n;
    return Math.hypot(xi - xj, (i - xi) / n - (j - xj) / n) * this.cellM;
  }

  locate(p: SurfacePoint): number {
    const n = this.n;
    const x = Math.min(n - 1, Math.max(0, Math.floor(p.u / this.cellM)));
    const y = Math.min(n - 1, Math.max(0, Math.floor(p.v / this.cellM)));
    return y * n + x;
  }

  point(i: number): SurfacePoint {
    const x = i % this.n;
    return { face: 0, u: (x + 0.5) * this.cellM, v: ((i - x) / this.n + 0.5) * this.cellM };
  }

  chart(c: SurfacePoint, radiusM: number, visit: (i: number, eastM: number, northM: number) => void): void {
    const { n, cellM } = this;
    const x0 = Math.max(0, Math.ceil((c.u - radiusM) / cellM - 0.5));
    const x1 = Math.min(n - 1, Math.floor((c.u + radiusM) / cellM - 0.5));
    const y0 = Math.max(0, Math.ceil((c.v - radiusM) / cellM - 0.5));
    const y1 = Math.min(n - 1, Math.floor((c.v + radiusM) / cellM - 0.5));
    const r2 = radiusM * radiusM;
    for (let y = y0; y <= y1; y++) {
      const north = c.v - (y + 0.5) * cellM;
      for (let x = x0; x <= x1; x++) {
        const east = (x + 0.5) * cellM - c.u;
        if (east * east + north * north <= r2) visit(y * n + x, east, north);
      }
    }
  }

  sample(field: Float32Array, p: SurfacePoint): number {
    const n = this.n;
    const fx = Math.min(n - 1, Math.max(0, p.u / this.cellM - 0.5));
    const fy = Math.min(n - 1, Math.max(0, p.v / this.cellM - 0.5));
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(n - 1, x0 + 1);
    const y1 = Math.min(n - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const a0 = field[y0 * n + x0] + (field[y0 * n + x1] - field[y0 * n + x0]) * tx;
    const a1 = field[y1 * n + x0] + (field[y1 * n + x1] - field[y1 * n + x0]) * tx;
    return a0 + (a1 - a0) * ty;
  }
}

/**
 * Flat map of n×n square cells of `cellKm` (= worldKm / n, the value every stage computed before
 * the Grid existed, so cellM = cellKm · 1000 is bit-identical to the old local constants).
 */
export function flatGrid(n: number, cellKm: number, mapEdge: MapEdge = 'ocean'): Grid {
  return new FlatGrid(n, cellKm, mapEdge);
}

/** Derived grids per parent and factor, so repeated coarsening allocates nothing. */
const derived = new WeakMap<Grid, Map<number, Grid>>();

function derive(g: Grid, key: number, make: () => Grid): Grid {
  let m = derived.get(g);
  if (!m) derived.set(g, (m = new Map()));
  let d = m.get(key);
  if (!d) m.set(key, (d = make()));
  return d;
}

/** The same world at a coarser resolution (n / factor cells per face edge). */
export function coarser(g: Grid, factor: number): Grid {
  if (factor === 1) return g;
  if (g.shape !== 'flat') throw new Error('coarser: only flat grids exist yet');
  if (g.n % factor !== 0) throw new Error(`coarser: ${factor} does not divide ${g.n}`);
  return derive(g, factor, () => flatGrid(g.n / factor, g.cellKm * factor, g.mapEdge));
}

/** The same world at a finer resolution (n · factor cells per face edge). */
export function finer(g: Grid, factor: number): Grid {
  if (factor === 1) return g;
  if (g.shape !== 'flat') throw new Error('finer: only flat grids exist yet');
  return derive(g, 1 / factor, () => flatGrid(g.n * factor, g.cellKm / factor, g.mapEdge));
}

/** Cells between cell i and the nearest map edge (0 on the edge row); Infinity on a closed surface. */
export function edgeCells(g: Grid, i: number): number {
  if (g.shape !== 'flat') return Infinity;
  const n = g.n;
  const x = i % n;
  const y = (i - x) / n;
  return Math.min(x, y, n - 1 - x, n - 1 - y);
}

/** Distance from cell i to the nearest map edge in map widths (edgeCells / n); Infinity on a closed surface. */
export function mapEdgeDistance(g: Grid, i: number): number {
  return edgeCells(g, i) / g.n;
}

/**
 * Visits the (2r + 1)² window of cells around c with their offsets in cells (dx east, dy south),
 * rows north to south, west to east; cells off the map are skipped. `visit` may return false to
 * stop early. For per-feature stamps and small-window statistics, not for per-cell hot loops.
 */
export function forWindow(g: Grid, c: number, r: number, visit: (j: number, dx: number, dy: number) => boolean | void): void {
  if (g.shape !== 'flat') throw new Error('forWindow: only flat grids exist yet');
  const n = g.n;
  const x = c % n;
  const y = (c - x) / n;
  for (let dy = -r; dy <= r; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= n) continue;
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= n) continue;
      if (visit(ny * n + nx, dx, dy) === false) return;
    }
  }
}

/** Whether neighbouring cells i and j are diagonal neighbours (false for i === j). */
export function isDiagonalStep(g: Grid, i: number, j: number): boolean {
  if (g.shape !== 'flat') throw new Error('isDiagonalStep: only flat grids exist yet');
  const d = Math.abs(j - i);
  return d !== 0 && d !== 1 && d !== g.n;
}

/** Face-local column of cell i. */
export function cellX(g: Grid, i: number): number {
  return (i % (g.n * g.n)) % g.n;
}

/** Face-local row of cell i (0 = the face's north edge). */
export function cellY(g: Grid, i: number): number {
  const f = i % (g.n * g.n);
  return (f - (f % g.n)) / g.n;
}

/** Cell at face-local column x, row y of face `face` (no bounds check). */
export function cellIndex(g: Grid, x: number, y: number, face = 0): number {
  return face * g.n * g.n + y * g.n + x;
}

// ── registry helpers ──

/** Whether face-local column x, row y lie on the face (flat: on the map). */
export function onFace(g: Grid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < g.n && y < g.n;
}

// ── hydro helpers ──

/**
 * Cell at face-local column x, row y, or −1 when (x, y) lies off the map. For planar per-feature
 * walks in cell coordinates (flat only: on the sphere such walks cross seams).
 */
export function cellIfOnMap(g: Grid, x: number, y: number): number {
  if (g.shape !== 'flat') throw new Error('cellIfOnMap: only flat grids exist yet');
  const n = g.n;
  return x < 0 || y < 0 || x >= n || y >= n ? -1 : y * n + x;
}
