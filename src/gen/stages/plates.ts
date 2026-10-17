import type { Rng } from '../../shared/rng';
import { Noise2 } from '../../shared/noise';
import { Noise3 } from '../../shared/noise3';
import type { Layer } from '../../shared/protocol';
import { asCube, cellOfDir, unitPositions, type CubeGrid } from '../grid/cube';
import { distanceField } from '../grid/distance';
import { blockGrid, cellFace, cellIndex, cellX, cellY, forWindow, mapEdgeDistance, onFace, type Grid } from '../grid/grid';
import { MinHeap } from '../grid/heap';
import { cellAt } from '../grid/sample';
import type { StageCtx, StageDef } from '../pipeline';

/** Boundary classes (research 01 §1.3). */
export const B = {
  NONE: 0,
  /** Continent–continent convergence: fold belt (Himalaya). */
  COLLISION: 1,
  /** Ocean–continent convergence: trench + coastal cordillera (Andes). */
  SUBDUCTION: 2,
  /** Ocean–ocean convergence: trench + volcanic island arc (Japan). */
  ARC: 3,
  /** Divergence inside a continent: rift valley (East Africa). */
  RIFT: 4,
  /** Divergence involving oceanic crust: mid-ocean ridge. */
  RIDGE: 5,
  /** Mostly sideways motion: fault valley (San Andreas). */
  TRANSFORM: 6,
} as const;

export interface Segment {
  cls: number;
  plateA: number;
  plateB: number;
  /** Approximate boundary length in km. */
  lengthKm: number;
  /** Plate that overrides (collision plateau side / arc side); −1 if not applicable. */
  overriding: number;
  /** Mean convergence (mm/yr, positive = converging). */
  conv: number;
}

export interface PlatesExtra {
  n: number;
  cellKm: number;
  plate: Int32Array;
  plateCount: number;
  /** Continent id per cell, −1 for oceanic crust. */
  continent: Int32Array;
  continentCount: number;
  /** Boundary class per cell (B.NONE away from boundaries). */
  bClass: Uint8Array;
  /** Segment id per boundary cell, −1 elsewhere. */
  bSeg: Int32Array;
  segments: Segment[];
  /** Nearest boundary cell of every cell, and the distance to it in km. */
  nearest: Int32Array;
  dBKm: Float32Array;
  /** Plate velocities at each plate's centroid, mm/yr (for hotspot tracks; 0 on the sphere). */
  vx: Float64Array;
  vy: Float64Array;
  /**
   * Sphere only: Euler pole of each plate (3 per plate), scaled to the surface speed in mm/yr at 90°
   * from the pole; the velocity at unit vector p is ω × p (research 10 §5.1).
   */
  omega?: Float64Array;
}

/** Layer header fields of a grid: none on flat maps (stages keep their own w, h, worldKm); cube faces on the sphere. */
export function shapeHeader(g: Grid): { worldKm?: number; faces?: 6; radiusKm?: number } {
  return g.shape === 'sphere' ? { worldKm: g.cellKm * g.n, faces: 6, radiusKm: g.radiusM / 1000 } : {};
}

/** Step length per axial-order neighbour (E W S N, then the diagonals), in cells. */
const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
/** Axial-order direction per neighbour (for the continent anisotropy). */
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];

/** Minimum length of a boundary segment that counts as a mountain range or rift. */
const RANGE_MIN_KM = 100;
/** Motion candidates tried per world to steer the 🎯 range and rift targets (CONFIG.md §4). */
const CANDIDATES = 16;
/**
 * Spheres: Euler-pole motions open more continental rifts than the flat motions, and the first 16 rarely
 * met the rift and range targets (research 11 §6); more candidates are cheap next to the rest of the stage.
 */
const SPHERE_CANDIDATES = 64;
/** Minimum ocean gap between continents before coast noise (km). */
const CONTINENT_GAP_KM = 100;

/**
 * S1 Plates: plate geometry, continents, motion, boundary classes and distance fields.
 * Plates grow from spaced seeds by noise-weighted Dijkstra (irregular boundaries, research 01 §1.1).
 * Continents are grown separately to their target areas, so the continent count is exact and a
 * continent can straddle plates (collisions inside it raise fold belts). Plate motions are chosen
 * best-of-N against the mountain-range and rift targets.
 */
export const platesStage: StageDef = {
  id: 'plates',
  label: 'Plates',
  inputs: [],
  reads: [
    'worldSize', 'plateCount', 'microplateCount', 'plateSizeSkew', 'boundaryWarp', 'continentalShare', 'continentCount',
    'continentSizeSkew', 'tectonicActivity', 'mountainRangeCount', 'riftCount', 'mapEdge', 'worldShape', 'planetSize',
  ],
  async run(ctx) {
    const sphere = ctx.str('worldShape') === 'sphere';
    // Sphere: 6 × 64² / 6 × 128² cells (8 km faces at the default 4,096 km circumference).
    const n = sphere ? (ctx.mode === 'preview' ? 64 : 128) : ctx.mode === 'preview' ? 128 : 256;
    const g = ctx.grid(n);
    const worldKm = ctx.num('worldSize');
    const cellKm = g.cellKm;

    const { plate, count, major } = growPlates(ctx, g);
    await ctx.checkpoint();
    const continent = growContinents(ctx, g);
    await ctx.checkpoint();

    // Plate centroids and radii (km) for rigid motion.
    const cx = new Float64Array(count);
    const cy = new Float64Array(count);
    const area = new Float64Array(count);
    for (let c = 0; c < g.cells; c++) {
      const p = plate[c];
      if (!sphere) {
        cx[p] += (cellX(g, c) + 0.5) * cellKm;
        cy[p] += (cellY(g, c) + 0.5) * cellKm;
      }
      area[p]++;
    }
    for (let p = 0; p < count; p++) {
      cx[p] /= Math.max(1, area[p]);
      cy[p] /= Math.max(1, area[p]);
    }

    const frame = boundaryFrame(plate, continent, g);
    const targetRanges = ctx.drawn('mountainRangeCount');
    const targetRifts = ctx.drawn('riftCount');
    const activity = ctx.num('tectonicActivity');
    let best: Classified | null = null;
    const rangeR = ctx.range('mountainRangeCount');
    const riftR = ctx.range('riftCount');
    // Outside the resolved range costs the distance to it; inside, a small pull toward the drawn value.
    const miss = (v: number, r: readonly [number, number], drawn: number): number =>
      Math.max(0, r[0] - v, v - r[1]) + 0.1 * Math.abs(v - drawn);
    for (let k = 0; k < (sphere ? SPHERE_CANDIDATES : CANDIDATES); k++) {
      const motion = sphere
        ? eulerMotion(ctx.rng('motion', k), count, major, activity)
        : randomMotion(ctx.rng('motion', k), count, major, area, cellKm, activity);
      const rates = sphere ? eulerRates(frame, plate, asCube(g), motion) : planarRates(frame, plate, g, cx, cy, motion);
      const cand = classify(frame, plate, continent, g, rates, ctx.rng('override', k));
      const score = miss(cand.ranges, rangeR, targetRanges) + miss(cand.rifts, riftR, targetRifts);
      if (!best || score < best.score) best = { ...cand, score, motion };
      if (score === 0) break;
    }
    const chosen = best!;
    // Spheres: Euler-pole motions over ~9 plates open more long continental rifts (and ranges) than any
    // candidate keeps inside the targets; the weakest excess segments become transforms (research 11 §6).
    if (sphere) {
      chosen.rifts = trimSegments(chosen, [B.RIFT], Math.min(riftR[1], targetRifts + 1));
      chosen.ranges = trimSegments(chosen, [B.COLLISION, B.SUBDUCTION], Math.min(rangeR[1], targetRanges + 1));
    }
    await ctx.checkpoint();

    const N = g.cells;
    const isBoundary = new Uint8Array(N);
    for (let c = 0; c < N; c++) isBoundary[c] = chosen.bClass[c] !== B.NONE ? 1 : 0;
    const { dist, nearest } = distanceField(isBoundary, g);
    const dBKm = new Float32Array(N);
    for (let c = 0; c < N; c++) dBKm[c] = dist[c] * cellKm;

    const crustLayer = new Int32Array(N);
    for (let c = 0; c < N; c++) crustLayer[c] = continent[c] + 1;
    const sh = shapeHeader(g);
    const layers: Layer[] = [
      { id: 'plates', label: 'Plates', stage: 'plates', kind: 'categorical', w: n, h: n, worldKm, ...sh, unit: '', min: 0, max: count - 1, data: plate },
      { id: 'continents', label: 'Continents (0 = ocean)', stage: 'plates', kind: 'categorical', w: n, h: n, worldKm, ...sh, unit: '', min: 0, max: ctx.drawn('continentCount'), data: crustLayer },
      { id: 'boundaries', label: 'Plate boundaries', stage: 'plates', kind: 'categorical', w: n, h: n, worldKm, ...sh, unit: '', min: 0, max: 6, data: chosen.bClass },
    ];
    const extra: PlatesExtra = {
      n, cellKm, plate, plateCount: count, continent, continentCount: ctx.drawn('continentCount'),
      bClass: chosen.bClass, bSeg: chosen.bSeg, segments: chosen.segments, nearest, dBKm,
      vx: chosen.motion.tx, vy: chosen.motion.ty,
    };
    if (chosen.motion.pole) extra.omega = chosen.motion.pole;
    return {
      layers,
      stats: {
        plates: major,
        microplates: count - major,
        segments: chosen.segments.length,
        collisionRanges: chosen.segments.filter((s) => s.cls === B.COLLISION && s.lengthKm >= RANGE_MIN_KM).length,
        cordilleras: chosen.segments.filter((s) => s.cls === B.SUBDUCTION && s.lengthKm >= RANGE_MIN_KM).length,
        islandArcs: chosen.segments.filter((s) => s.cls === B.ARC && s.lengthKm >= RANGE_MIN_KM).length,
      },
      outcomes: { mountainRangeCount: chosen.ranges, riftCount: chosen.rifts },
      extra,
    };
  },
};

// ── Plates ──────────────────────────────────────────────────────────────────────────────────

function growPlates(ctx: StageCtx, g: Grid): { plate: Int32Array; count: number; major: number } {
  const { n, cells: N, cellKm, off8Axial: off, axialToRaster, border } = g;
  const major = ctx.drawn('plateCount');
  const micro = ctx.drawn('microplateCount');
  const count = major + micro;
  const rng = ctx.rng('seeds');
  const sphere = g.shape === 'sphere';
  const seeds = sphere ? spacedCells(rng, count, asCube(g)) : null;
  const { xs, ys } = sphere ? { xs: null, ys: null } : spacedPoints(rng, count, 0.03);
  const skew = ctx.num('plateSizeSkew');
  const weight = new Float64Array(count);
  for (let i = 0; i < count; i++) weight[i] = i < major ? Math.exp(skew * 0.9 * gaussian(rng)) : 0.3;

  const warp = ctx.num('boundaryWarp');
  const cost = new Float32Array(N);
  if (sphere) {
    const noise = new Noise3(ctx.rng('noise').nextU32());
    const p = unitPositions(asCube(g));
    const k = g.radiusM / 1000 / 180;
    for (let c = 0; c < N; c++) cost[c] = 1 + warp * 4 * (0.5 + 0.5 * noise.fbm3(p[c * 3] * k, p[c * 3 + 1] * k, p[c * 3 + 2] * k, 4));
  } else {
    const noise = new Noise2(ctx.rng('noise').nextU32());
    for (let c = 0; c < N; c++) {
      cost[c] = 1 + warp * 4 * (0.5 + 0.5 * noise.fbm((cellX(g, c) * cellKm) / 180, (cellY(g, c) * cellKm) / 180, 4));
    }
  }
  const plate = new Int32Array(N).fill(-1);
  const dist = new Float64Array(N).fill(Infinity);
  const heap = new MinHeap(n * 4);
  for (let i = 0; i < count; i++) {
    const c = seeds ? seeds[i] : cellAt(g, xs![i], ys![i]);
    if (dist[c] === 0) continue;
    dist[c] = 0;
    plate[c] = i;
    heap.push(0, c);
  }
  while (heap.size > 0) {
    const d = heap.peekKey();
    const c = heap.pop();
    if (d > dist[c]) continue;
    const p = plate[c];
    const b = border[c];
    for (let k = 0; k < 8; k++) {
      let nc: number;
      if (b === 0) nc = c + off[k];
      else if ((nc = g.nbr(c, axialToRaster[k])) < 0) continue;
      const dl = sphere ? g.dist(c, axialToRaster[k]) / g.cellM : DL[k];
      const nd = d + (dl * 0.5 * (cost[c] + cost[nc])) / weight[p];
      if (nd < dist[nc]) {
        dist[nc] = nd;
        plate[nc] = p;
        heap.push(nd, nc);
      }
    }
  }
  return { plate, count, major };
}

// ── Continents ──────────────────────────────────────────────────────────────────────────────

/**
 * Grows `continentCount` continents from spaced seeds to their target areas with a noisy,
 * anisotropic Dijkstra (elongated, irregular shapes). Continents never touch: a cell next to another
 * continent stays oceanic, so the realised count matches the target before erosion.
 */
function growContinents(ctx: StageCtx, g: Grid): Int32Array {
  const { n, cells: N, cellKm, off8Axial: off, axialToRaster, border } = g;
  const count = ctx.drawn('continentCount');
  const rng = ctx.rng('continents');
  const sphere = g.shape === 'sphere';
  const margin = ctx.str('mapEdge') === 'ocean' ? 0.2 : 0.08;
  const seeds = sphere ? spacedCells(rng, count, asCube(g)) : null;
  const { xs, ys } = sphere ? { xs: null, ys: null } : spacedPoints(rng, count, margin);
  const skew = ctx.num('continentSizeSkew');
  const w = Array.from({ length: count }, (_, i) => (i === 0 ? 1 + 4 * skew : 1 - 0.5 * skew) * rng.range(0.8, 1.2));
  const wSum = w.reduce((a, b) => a + b, 0);
  const total = ctx.num('continentalShare') * N;
  const target = w.map((v) => (total * v) / wSum);
  // Elongation: each continent has an axis; steps across it cost more.
  const ax = new Float64Array(count);
  const ay = new Float64Array(count);
  const stretch = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI);
    ax[i] = Math.cos(a);
    ay[i] = Math.sin(a);
    stretch[i] = rng.range(0.3, 1.6);
  }
  if (sphere) return growContinentsSphere(ctx, asCube(g), seeds!, w, ax, ay, stretch);
  const noise = new Noise2(ctx.rng('continent-noise').nextU32());
  const cost = new Float32Array(N);
  for (let c = 0; c < N; c++) {
    const x = cellX(g, c);
    const y = cellY(g, c);
    // Growing toward an ocean map edge gets expensive, so continents stay off the border.
    const edge = margin > 0.1 ? 1 + 8 * Math.max(0, 0.12 - mapEdgeDistance(g, c)) / 0.12 : 1;
    cost[c] = (1 + 2.5 * (0.5 + 0.5 * noise.fbm((x * cellKm) / 260, (y * cellKm) / 260, 5))) * edge;
  }

  const label = new Int32Array(N).fill(-1);
  // Coarse ownership blocks keep continents ~CONTINENT_GAP_KM apart, so coast noise can't merge them.
  const bs = Math.max(2, Math.round(CONTINENT_GAP_KM / 3 / cellKm));
  const bg = blockGrid(g, bs);
  const blockOwner = new Int32Array(bg.cells).fill(-1);
  const area = new Float64Array(count);
  const heap = new MinHeap(n * 4);
  for (let i = 0; i < count; i++) heap.push(0, cellAt(g, xs![i], ys![i]) * 16 + i);
  while (heap.size > 0) {
    const d = heap.peekKey();
    const v = heap.pop();
    const c = v >> 4;
    const L = v & 15;
    if (label[c] !== -1 || area[L] >= target[L]) continue;
    const x = cellX(g, c);
    const y = cellY(g, c);
    if (nearOtherContinent(blockOwner, bg, Math.floor(x / bs), Math.floor(y / bs), L)) continue;
    label[c] = L;
    const blk = cellIndex(bg, Math.floor(x / bs), Math.floor(y / bs));
    if (blockOwner[blk] === -1) blockOwner[blk] = L;
    area[L]++;
    const b = border[c];
    for (let k = 0; k < 8; k++) {
      let nc: number;
      if (b === 0) nc = c + off[k];
      else if ((nc = g.nbr(c, axialToRaster[k])) < 0) continue;
      if (label[nc] !== -1) continue;
      const across = Math.abs(DX[k] * -ay[L] + DY[k] * ax[L]) / DL[k];
      heap.push(d + DL[k] * 0.5 * (cost[c] + cost[nc]) * (1 + stretch[L] * across), nc * 16 + L);
    }
  }
  return label;
}

/**
 * growContinents on the cube-sphere: the same noisy anisotropic Dijkstra, with the elongation axis a
 * great circle through the seed (pole P; steps toward P are "across") and ownership blocks on the
 * coarse cube grid with their 7×7 neighbourhoods taken across seams.
 */
function growContinentsSphere(
  ctx: StageCtx, g: CubeGrid, seeds: Int32Array, w: readonly number[], ax: Float64Array, ay: Float64Array, stretch: Float64Array,
): Int32Array {
  const { cells: N, cellKm } = g;
  const count = seeds.length;
  const wSum = w.reduce((a, b) => a + b, 0);
  // Continental share of the surface area: cells differ in area, so targets are in m².
  const total = ctx.num('continentalShare') * g.totalArea;
  const target = w.map((v) => (total * v) / wSum);
  const p = unitPositions(g);
  // Elongation pole per continent: the seed's local frame rotated by the drawn axis angle.
  const pole = new Float64Array(count * 3);
  const up = new Float64Array(3);
  const east = new Float64Array(3);
  const north = new Float64Array(3);
  for (let i = 0; i < count; i++) {
    g.frame(seeds[i], east, north, up);
    // Along-axis direction t = ax·east + ay·north; the pole is up × t.
    const tx = ax[i] * east[0] + ay[i] * north[0];
    const ty = ax[i] * east[1] + ay[i] * north[1];
    const tz = ax[i] * east[2] + ay[i] * north[2];
    pole[i * 3] = up[1] * tz - up[2] * ty;
    pole[i * 3 + 1] = up[2] * tx - up[0] * tz;
    pole[i * 3 + 2] = up[0] * ty - up[1] * tx;
  }
  const noise = new Noise3(ctx.rng('continent-noise').nextU32());
  const kn = g.radiusM / 1000 / 260;
  const cost = new Float32Array(N);
  for (let c = 0; c < N; c++) cost[c] = 1 + 2.5 * (0.5 + 0.5 * noise.fbm3(p[c * 3] * kn, p[c * 3 + 1] * kn, p[c * 3 + 2] * kn, 5));

  const label = new Int32Array(N).fill(-1);
  const bs = Math.max(2, Math.round(CONTINENT_GAP_KM / 3 / cellKm));
  let b = 1;
  while (b * 2 <= bs && g.n % (b * 2) === 0) b *= 2;
  const bg = blockGrid(g, b) as CubeGrid;
  const near = blockWindows(bg, 3);
  const blockOwner = new Int32Array(bg.cells).fill(-1);
  const area = new Float64Array(count);
  const heap = new MinHeap(g.n * 24);
  for (let i = 0; i < count; i++) heap.push(0, seeds[i] * 16 + i);
  const blockOf = (c: number): number => cellIndex(bg, Math.floor(cellX(g, c) / b), Math.floor(cellY(g, c) / b), cellFace(g, c));
  while (heap.size > 0) {
    const d = heap.peekKey();
    const v = heap.pop();
    const c = v >> 4;
    const L = v & 15;
    if (label[c] !== -1 || area[L] >= target[L]) continue;
    const blk = blockOf(c);
    let taken = false;
    for (let t = near.start[blk]; t < near.start[blk + 1] && !taken; t++) {
      const o = blockOwner[near.list[t]];
      taken = o !== -1 && o !== L;
    }
    if (taken) continue;
    label[c] = L;
    if (blockOwner[blk] === -1) blockOwner[blk] = L;
    area[L] += g.area(c);
    for (let k = 0; k < 8; k++) {
      const nc = g.nbr(c, k);
      if (nc < 0 || label[nc] !== -1) continue;
      const dx = p[nc * 3] - p[c * 3];
      const dy = p[nc * 3 + 1] - p[c * 3 + 1];
      const dz = p[nc * 3 + 2] - p[c * 3 + 2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const across = Math.abs(dx * pole[L * 3] + dy * pole[L * 3 + 1] + dz * pole[L * 3 + 2]) / len;
      const dl = g.dist(c, k) / g.cellM;
      heap.push(d + dl * 0.5 * (cost[c] + cost[nc]) * (1 + stretch[L] * across), nc * 16 + L);
    }
  }
  return label;
}

/** Per cell of a cube grid, the cells within `r` steps (Chebyshev rings across seams), as CSR. */
function blockWindows(g: CubeGrid, r: number): { start: Int32Array; list: Int32Array } {
  const start = new Int32Array(g.cells + 1);
  const list: number[] = [];
  const seen = new Map<number, number>();
  for (let c = 0; c < g.cells; c++) {
    seen.clear();
    seen.set(c, 0);
    let ring = [c];
    for (let s = 1; s <= r; s++) {
      const next: number[] = [];
      for (const i of ring) {
        for (let k = 0; k < 8; k++) {
          const j = g.nbr(i, k);
          if (j >= 0 && !seen.has(j)) {
            seen.set(j, s);
            next.push(j);
          }
        }
      }
      ring = next;
    }
    for (const j of seen.keys()) list.push(j);
    start[c + 1] = list.length;
  }
  return { start, list: Int32Array.from(list) };
}

function nearOtherContinent(owner: Int32Array, bg: Grid, bx: number, by: number, L: number): boolean {
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = bx + dx;
      const y = by + dy;
      if (!onFace(bg, x, y)) continue;
      const o = owner[cellIndex(bg, x, y)];
      if (o !== -1 && o !== L) return true;
    }
  }
  return false;
}

// ── Boundaries ──────────────────────────────────────────────────────────────────────────────

/** Geometry of every boundary cell, independent of motion: neighbour plate and outward normal. */
interface Frame {
  cells: Int32Array;
  other: Int32Array;
  nx: Float64Array;
  ny: Float64Array;
  /** 1 if the other side of the boundary at this cell is continental crust. */
  otherCont: Uint8Array;
  /** Boundary index per grid cell (−1 elsewhere). */
  index: Int32Array;
  /**
   * Smoothing neighbourhood of each boundary cell (CSR): the boundary cells of the same plate pair in
   * its 7×7 window, in window order. Independent of plate motion, so built once for all candidates.
   */
  nearStart: Int32Array;
  near: Int32Array;
}

function boundaryFrame(plate: Int32Array, continent: Int32Array, g: Grid): Frame {
  const { cells: N, off4, axialToRaster, border } = g;
  const cells: number[] = [];
  const other: number[] = [];
  const nxs: number[] = [];
  const nys: number[] = [];
  const oc: number[] = [];
  for (let c = 0; c < N; c++) {
    const p = plate[c];
    const b = border[c];
    let q = -1;
    for (let k = 0; k < 4 && q === -1; k++) {
      const j = b === 0 ? c + off4[k] : g.nbr(c, axialToRaster[k]);
      if (j >= 0 && plate[j] !== p) q = plate[j];
    }
    if (q === -1) continue;
    // Normal from this plate toward q: mean offset of q's cells in a 5×5 window (sphere: a disk of
    // 2.5 cells, offsets east / north in cells).
    let sx = 0;
    let sy = 0;
    let cont = 0;
    let cnt = 0;
    const add = (j: number, dx: number, dy: number): void => {
      if (plate[j] !== q) return;
      sx += dx;
      sy += dy;
      cnt++;
      if (continent[j] !== -1) cont++;
    };
    if (g.shape === 'sphere') g.chart(g.point(c), 2.5 * g.cellM, (j, e, nn) => add(j, e / g.cellM, nn / g.cellM));
    else forWindow(g, c, 2, add);
    const len = Math.hypot(sx, sy) || 1;
    cells.push(c);
    other.push(q);
    nxs.push(sx / len);
    nys.push(sy / len);
    oc.push(cont * 2 > cnt ? 1 : 0);
  }
  const nb = cells.length;
  const index = new Int32Array(N).fill(-1);
  for (let i = 0; i < nb; i++) index[cells[i]] = i;
  const nearStart = new Int32Array(nb + 1);
  const near: number[] = [];
  for (let i = 0; i < nb; i++) {
    const c = cells[i];
    const lo = Math.min(plate[c], other[i]);
    const hi = Math.max(plate[c], other[i]);
    const visit = (cj: number): void => {
      const j = index[cj];
      if (j < 0) return;
      const a = plate[cells[j]];
      const b = other[j];
      if (Math.min(a, b) !== lo || Math.max(a, b) !== hi) return;
      near.push(j);
    };
    if (g.shape === 'sphere') g.chart(g.point(c), 3.5 * g.cellM, visit);
    else forWindow(g, c, 3, visit);
    nearStart[i + 1] = near.length;
  }
  return {
    cells: Int32Array.from(cells),
    other: Int32Array.from(other),
    nx: Float64Array.from(nxs),
    ny: Float64Array.from(nys),
    otherCont: Uint8Array.from(oc),
    index,
    nearStart,
    near: Int32Array.from(near),
  };
}

interface Motion {
  tx: Float64Array;
  ty: Float64Array;
  omega: Float64Array;
  /** Sphere: Euler pole per plate (3 per plate), |ω| = surface speed at 90° in mm/yr. */
  pole?: Float64Array;
}

/** Rigid plate motion: translation of 1–8 cm/yr scaled by activity, plus a small rotation. */
function randomMotion(rng: Rng, count: number, major: number, area: Float64Array, cellKm: number, activity: number): Motion {
  const tx = new Float64Array(count);
  const ty = new Float64Array(count);
  const omega = new Float64Array(count);
  for (let p = 0; p < count; p++) {
    const speed = (10 + 70 * activity) * rng.range(0.4, 1.0) * (p < major ? 1 : 1.3);
    const a = rng.range(0, 2 * Math.PI);
    tx[p] = speed * Math.cos(a);
    ty[p] = speed * Math.sin(a);
    const radiusKm = Math.sqrt(area[p] / Math.PI) * cellKm;
    omega[p] = (rng.range(-0.3, 0.3) * speed) / Math.max(50, radiusKm);
  }
  return { tx, ty, omega };
}

/**
 * Rigid motion on the sphere (research 10 §5.1): every plate rotates about its own Euler pole, uniform
 * on the sphere, at 1–8 cm/yr at 90° from the pole (scaled by activity, microplates a little faster).
 */
function eulerMotion(rng: Rng, count: number, major: number, activity: number): Motion {
  const pole = new Float64Array(count * 3);
  for (let p = 0; p < count; p++) {
    const speed = (10 + 70 * activity) * rng.range(0.4, 1.0) * (p < major ? 1 : 1.3);
    let x = gaussian(rng);
    let y = gaussian(rng);
    let z = gaussian(rng);
    const len = Math.hypot(x, y, z) || 1;
    x /= len;
    y /= len;
    z /= len;
    pole[p * 3] = x * speed;
    pole[p * 3 + 1] = y * speed;
    pole[p * 3 + 2] = z * speed;
  }
  return { tx: new Float64Array(count), ty: new Float64Array(count), omega: new Float64Array(count), pole };
}

/** Convergence (mm/yr, + = converging) and shear speed at every boundary cell, before smoothing. */
interface Rates {
  conv: Float64Array;
  shear: Float64Array;
}

function planarRates(f: Frame, plate: Int32Array, g: Grid, cx: Float64Array, cy: Float64Array, m: Motion): Rates {
  const { cellKm } = g;
  const nb = f.cells.length;
  const conv = new Float64Array(nb);
  const shear = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    const c = f.cells[i];
    const px = (cellX(g, c) + 0.5) * cellKm;
    const py = (cellY(g, c) + 0.5) * cellKm;
    const p = plate[c];
    const q = f.other[i];
    const vpx = m.tx[p] - m.omega[p] * (py - cy[p]);
    const vpy = m.ty[p] + m.omega[p] * (px - cx[p]);
    const vqx = m.tx[q] - m.omega[q] * (py - cy[q]);
    const vqy = m.ty[q] + m.omega[q] * (px - cx[q]);
    const rx = vqx - vpx;
    const ry = vqy - vpy;
    conv[i] = -(rx * f.nx[i] + ry * f.ny[i]);
    shear[i] = Math.abs(rx * f.ny[i] - ry * f.nx[i]);
  }
  return { conv, shear };
}

/** Sphere: relative surface velocity (ω_q − ω_p) × p in the local east / north frame of the boundary normal. */
function eulerRates(f: Frame, plate: Int32Array, g: CubeGrid, m: Motion): Rates {
  const w = m.pole!;
  const nb = f.cells.length;
  const conv = new Float64Array(nb);
  const shear = new Float64Array(nb);
  const up = new Float64Array(3);
  const east = new Float64Array(3);
  const north = new Float64Array(3);
  for (let i = 0; i < nb; i++) {
    const c = f.cells[i];
    g.frame(c, east, north, up);
    const p = plate[c] * 3;
    const q = f.other[i] * 3;
    const ox = w[q] - w[p];
    const oy = w[q + 1] - w[p + 1];
    const oz = w[q + 2] - w[p + 2];
    const vx = oy * up[2] - oz * up[1];
    const vy = oz * up[0] - ox * up[2];
    const vz = ox * up[1] - oy * up[0];
    const rx = vx * east[0] + vy * east[1] + vz * east[2];
    const ry = vx * north[0] + vy * north[1] + vz * north[2];
    conv[i] = -(rx * f.nx[i] + ry * f.ny[i]);
    shear[i] = Math.abs(rx * f.ny[i] - ry * f.nx[i]);
  }
  return { conv, shear };
}

interface Classified {
  bClass: Uint8Array;
  bSeg: Int32Array;
  segments: Segment[];
  ranges: number;
  rifts: number;
  score: number;
  motion: Motion;
}

function classify(
  f: Frame, plate: Int32Array, continent: Int32Array, g: Grid, rates: Rates, rng: Rng,
): Omit<Classified, 'score' | 'motion'> {
  const { cells: N, cellKm, off8Axial: off, axialToRaster, border } = g;
  const nb = f.cells.length;
  const { conv, shear } = rates;
  const { index, nearStart, near } = f;
  // Smooth along the boundary so classes don't flicker between neighbouring cells.
  const sConv = new Float64Array(nb);
  const sShear = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    let sc = 0;
    let ss = 0;
    for (let t = nearStart[i]; t < nearStart[i + 1]; t++) {
      const j = near[t];
      sc += conv[j];
      ss += shear[j];
    }
    const k = nearStart[i + 1] - nearStart[i];
    sConv[i] = sc / k;
    sShear[i] = ss / k;
  }

  const bClass = new Uint8Array(N);
  for (let i = 0; i < nb; i++) {
    const c = f.cells[i];
    const own = continent[c] !== -1;
    const oth = f.otherCont[i] === 1;
    const cv = sConv[i];
    let cls: number;
    if (Math.abs(cv) < 0.5 * sShear[i]) cls = B.TRANSFORM;
    else if (cv > 0) cls = own && oth ? B.COLLISION : own || oth ? B.SUBDUCTION : B.ARC;
    else cls = own && oth ? B.RIFT : B.RIDGE;
    bClass[c] = cls;
  }

  // Segments: 8-connected boundary cells with the same plate pair and class.
  const bSeg = new Int32Array(N).fill(-1);
  const segments: Segment[] = [];
  const overridePair = new Map<number, number>();
  const stack: number[] = [];
  for (let i = 0; i < nb; i++) {
    const c0 = f.cells[i];
    if (bSeg[c0] !== -1) continue;
    const cls = bClass[c0];
    const a0 = Math.min(plate[c0], f.other[i]);
    const b0 = Math.max(plate[c0], f.other[i]);
    const id = segments.length;
    let cells = 0;
    let convSum = 0;
    stack.push(c0);
    bSeg[c0] = id;
    while (stack.length) {
      const c = stack.pop()!;
      cells++;
      convSum += sConv[index[c]];
      const b = border[c];
      for (let k = 0; k < 8; k++) {
        let nc: number;
        if (b === 0) nc = c + off[k];
        else if ((nc = g.nbr(c, axialToRaster[k])) < 0) continue;
        const j = index[nc];
        if (j < 0 || bSeg[nc] !== -1 || bClass[nc] !== cls) continue;
        if (Math.min(plate[nc], f.other[j]) !== a0 || Math.max(plate[nc], f.other[j]) !== b0) continue;
        bSeg[nc] = id;
        stack.push(nc);
      }
    }
    const pairKey = a0 * 4096 + b0;
    let over = overridePair.get(pairKey);
    if (over === undefined) {
      over = rng.float() < 0.5 ? a0 : b0;
      overridePair.set(pairKey, over);
    }
    // Both sides of a boundary are boundary cells, so the boundary length is about half the cells.
    segments.push({ cls, plateA: a0, plateB: b0, lengthKm: (cells * cellKm) / 2, overriding: over, conv: convSum / cells });
  }
  const long = (cls: number): number => segments.filter((s) => s.cls === cls && s.lengthKm >= RANGE_MIN_KM).length;
  return { bClass, bSeg, segments, ranges: long(B.COLLISION) + long(B.SUBDUCTION), rifts: long(B.RIFT) };
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

/** Best-candidate sampling of `count` well-spaced cells on the sphere (area-uniform candidates). */
function spacedCells(rng: Rng, count: number, g: CubeGrid): Int32Array {
  const pts = new Float64Array(count * 3);
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    let best = -1;
    for (let k = 0; k < 12; k++) {
      let x = gaussian(rng);
      let y = gaussian(rng);
      let z = gaussian(rng);
      const len = Math.hypot(x, y, z) || 1;
      x /= len;
      y /= len;
      z /= len;
      let dmin = Infinity;
      for (let j = 0; j < i; j++) dmin = Math.min(dmin, (x - pts[j * 3]) ** 2 + (y - pts[j * 3 + 1]) ** 2 + (z - pts[j * 3 + 2]) ** 2);
      if (dmin > best) {
        best = dmin;
        pts[i * 3] = x;
        pts[i * 3 + 1] = y;
        pts[i * 3 + 2] = z;
      }
    }
    out[i] = cellOfDir(g, pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
  }
  return out;
}

/** Best-candidate sampling of `count` well-spaced points in [margin, 1 − margin]². */
function spacedPoints(rng: Rng, count: number, margin: number): { xs: Float64Array; ys: Float64Array } {
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let best = -1;
    for (let k = 0; k < 12; k++) {
      const x = rng.range(margin, 1 - margin);
      const y = rng.range(margin, 1 - margin);
      let dmin = Infinity;
      for (let j = 0; j < i; j++) dmin = Math.min(dmin, (x - xs[j]) ** 2 + (y - ys[j]) ** 2);
      if (dmin > best) {
        best = dmin;
        xs[i] = x;
        ys[i] = y;
      }
    }
  }
  return { xs, ys };
}

export function gaussian(rng: Rng): number {
  const u = Math.max(1e-12, rng.float());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.float());
}

/**
 * Spheres: turns the weakest (smallest |convergence|) long segments of the given classes into
 * transforms until at most `max` remain; returns how many remain. Segment classes and the boundary
 * raster change together, so the uplift of the base stage follows.
 */
function trimSegments(c: Classified, classes: readonly number[], max: number): number {
  const long = c.segments.map((s, id) => ({ s, id })).filter(({ s }) => classes.includes(s.cls) && s.lengthKm >= RANGE_MIN_KM);
  if (long.length <= max) return long.length;
  long.sort((a, b) => Math.abs(a.s.conv) - Math.abs(b.s.conv) || a.id - b.id);
  const drop = new Set<number>();
  for (const { s, id } of long.slice(0, long.length - Math.max(0, max))) {
    s.cls = B.TRANSFORM;
    drop.add(id);
  }
  for (let i = 0; i < c.bSeg.length; i++) if (c.bSeg[i] >= 0 && drop.has(c.bSeg[i])) c.bClass[i] = B.TRANSFORM;
  return long.length - drop.size;
}
