import type { Rng } from '../../shared/rng';
import { Noise2 } from '../../shared/noise';
import type { Layer } from '../../shared/protocol';
import { distanceField } from '../grid/distance';
import { MinHeap } from '../grid/heap';
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
  /** Plate velocities at each plate's centroid, mm/yr (for hotspot tracks). */
  vx: Float64Array;
  vy: Float64Array;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DY = [0, 0, 1, -1, 1, -1, 1, -1];
const DL = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

/** Minimum length of a boundary segment that counts as a mountain range or rift. */
const RANGE_MIN_KM = 100;
/** Motion candidates tried per world to steer the 🎯 range and rift targets (CONFIG.md §4). */
const CANDIDATES = 16;
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
    'continentSizeSkew', 'tectonicActivity', 'mountainRangeCount', 'riftCount', 'mapEdge',
  ],
  async run(ctx) {
    const n = ctx.mode === 'preview' ? 128 : 256;
    const worldKm = ctx.num('worldSize');
    const cellKm = worldKm / n;

    const { plate, count, major } = growPlates(ctx, n, worldKm);
    await ctx.checkpoint();
    const continent = growContinents(ctx, n, worldKm);
    await ctx.checkpoint();

    // Plate centroids and radii (km) for rigid motion.
    const cx = new Float64Array(count);
    const cy = new Float64Array(count);
    const area = new Float64Array(count);
    for (let c = 0; c < n * n; c++) {
      const p = plate[c];
      cx[p] += ((c % n) + 0.5) * cellKm;
      cy[p] += (Math.floor(c / n) + 0.5) * cellKm;
      area[p]++;
    }
    for (let p = 0; p < count; p++) {
      cx[p] /= Math.max(1, area[p]);
      cy[p] /= Math.max(1, area[p]);
    }

    const frame = boundaryFrame(plate, continent, n);
    const targetRanges = ctx.drawn('mountainRangeCount');
    const targetRifts = ctx.drawn('riftCount');
    const activity = ctx.num('tectonicActivity');
    let best: Classified | null = null;
    const rangeR = ctx.range('mountainRangeCount');
    const riftR = ctx.range('riftCount');
    // Outside the resolved range costs the distance to it; inside, a small pull toward the drawn value.
    const miss = (v: number, r: readonly [number, number], drawn: number): number =>
      Math.max(0, r[0] - v, v - r[1]) + 0.1 * Math.abs(v - drawn);
    for (let k = 0; k < CANDIDATES; k++) {
      const motion = randomMotion(ctx.rng('motion', k), count, major, area, cellKm, activity);
      const cand = classify(frame, plate, continent, n, cellKm, cx, cy, motion, ctx.rng('override', k));
      const score = miss(cand.ranges, rangeR, targetRanges) + miss(cand.rifts, riftR, targetRifts);
      if (!best || score < best.score) best = { ...cand, score, motion };
      if (score === 0) break;
    }
    const chosen = best!;
    await ctx.checkpoint();

    const isBoundary = new Uint8Array(n * n);
    for (let c = 0; c < n * n; c++) isBoundary[c] = chosen.bClass[c] !== B.NONE ? 1 : 0;
    const { dist, nearest } = distanceField(isBoundary, ctx.grid(n));
    const dBKm = new Float32Array(n * n);
    for (let c = 0; c < n * n; c++) dBKm[c] = dist[c] * cellKm;

    const crustLayer = new Int32Array(n * n);
    for (let c = 0; c < n * n; c++) crustLayer[c] = continent[c] + 1;
    const layers: Layer[] = [
      { id: 'plates', label: 'Plates', stage: 'plates', kind: 'categorical', w: n, h: n, worldKm, unit: '', min: 0, max: count - 1, data: plate },
      { id: 'continents', label: 'Continents (0 = ocean)', stage: 'plates', kind: 'categorical', w: n, h: n, worldKm, unit: '', min: 0, max: ctx.drawn('continentCount'), data: crustLayer },
      { id: 'boundaries', label: 'Plate boundaries', stage: 'plates', kind: 'categorical', w: n, h: n, worldKm, unit: '', min: 0, max: 6, data: chosen.bClass },
    ];
    const extra: PlatesExtra = {
      n, cellKm, plate, plateCount: count, continent, continentCount: ctx.drawn('continentCount'),
      bClass: chosen.bClass, bSeg: chosen.bSeg, segments: chosen.segments, nearest, dBKm,
      vx: chosen.motion.tx, vy: chosen.motion.ty,
    };
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

function growPlates(ctx: StageCtx, n: number, worldKm: number): { plate: Int32Array; count: number; major: number } {
  const major = ctx.drawn('plateCount');
  const micro = ctx.drawn('microplateCount');
  const count = major + micro;
  const rng = ctx.rng('seeds');
  const { xs, ys } = spacedPoints(rng, count, 0.03);
  const skew = ctx.num('plateSizeSkew');
  const weight = new Float64Array(count);
  for (let i = 0; i < count; i++) weight[i] = i < major ? Math.exp(skew * 0.9 * gaussian(rng)) : 0.3;

  const noise = new Noise2(ctx.rng('noise').nextU32());
  const warp = ctx.num('boundaryWarp');
  const cellKm = worldKm / n;
  const cost = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) cost[y * n + x] = 1 + warp * 4 * (0.5 + 0.5 * noise.fbm((x * cellKm) / 180, (y * cellKm) / 180, 4));
  }
  const plate = new Int32Array(n * n).fill(-1);
  const dist = new Float64Array(n * n).fill(Infinity);
  const heap = new MinHeap(n * 4);
  for (let i = 0; i < count; i++) {
    const c = Math.floor(ys[i] * n) * n + Math.floor(xs[i] * n);
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
    const x = c % n;
    const y = (c - x) / n;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const nc = ny * n + nx;
      const nd = d + (DL[k] * 0.5 * (cost[c] + cost[nc])) / weight[p];
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
function growContinents(ctx: StageCtx, n: number, worldKm: number): Int32Array {
  const count = ctx.drawn('continentCount');
  const rng = ctx.rng('continents');
  const margin = ctx.str('mapEdge') === 'ocean' ? 0.2 : 0.08;
  const { xs, ys } = spacedPoints(rng, count, margin);
  const skew = ctx.num('continentSizeSkew');
  const w = Array.from({ length: count }, (_, i) => (i === 0 ? 1 + 4 * skew : 1 - 0.5 * skew) * rng.range(0.8, 1.2));
  const wSum = w.reduce((a, b) => a + b, 0);
  const total = ctx.num('continentalShare') * n * n;
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
  const noise = new Noise2(ctx.rng('continent-noise').nextU32());
  const cellKm = worldKm / n;
  const cost = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const e = Math.min(x, y, n - 1 - x, n - 1 - y) / n;
      // Growing toward an ocean map edge gets expensive, so continents stay off the border.
      const edge = margin > 0.1 ? 1 + 8 * Math.max(0, 0.12 - e) / 0.12 : 1;
      cost[y * n + x] = (1 + 2.5 * (0.5 + 0.5 * noise.fbm((x * cellKm) / 260, (y * cellKm) / 260, 5))) * edge;
    }
  }

  const label = new Int32Array(n * n).fill(-1);
  // Coarse ownership blocks keep continents ~CONTINENT_GAP_KM apart, so coast noise can't merge them.
  const bs = Math.max(2, Math.round(CONTINENT_GAP_KM / 3 / cellKm));
  const nbk = Math.ceil(n / bs);
  const blockOwner = new Int32Array(nbk * nbk).fill(-1);
  const area = new Float64Array(count);
  const heap = new MinHeap(n * 4);
  for (let i = 0; i < count; i++) heap.push(0, (Math.floor(ys[i] * n) * n + Math.floor(xs[i] * n)) * 16 + i);
  while (heap.size > 0) {
    const d = heap.peekKey();
    const v = heap.pop();
    const c = v >> 4;
    const L = v & 15;
    if (label[c] !== -1 || area[L] >= target[L]) continue;
    const x = c % n;
    const y = (c - x) / n;
    if (nearOtherContinent(blockOwner, nbk, Math.floor(x / bs), Math.floor(y / bs), L)) continue;
    label[c] = L;
    const blk = Math.floor(y / bs) * nbk + Math.floor(x / bs);
    if (blockOwner[blk] === -1) blockOwner[blk] = L;
    area[L]++;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const nc = ny * n + nx;
      if (label[nc] !== -1) continue;
      const across = Math.abs(DX[k] * -ay[L] + DY[k] * ax[L]) / DL[k];
      heap.push(d + DL[k] * 0.5 * (cost[c] + cost[nc]) * (1 + stretch[L] * across), nc * 16 + L);
    }
  }
  return label;
}

function nearOtherContinent(owner: Int32Array, nb: number, bx: number, by: number, L: number): boolean {
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = bx + dx;
      const y = by + dy;
      if (x < 0 || y < 0 || x >= nb || y >= nb) continue;
      const o = owner[y * nb + x];
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
}

function boundaryFrame(plate: Int32Array, continent: Int32Array, n: number): Frame {
  const cells: number[] = [];
  const other: number[] = [];
  const nxs: number[] = [];
  const nys: number[] = [];
  const oc: number[] = [];
  for (let c = 0; c < n * n; c++) {
    const x = c % n;
    const y = (c - x) / n;
    const p = plate[c];
    let q = -1;
    for (let k = 0; k < 4 && q === -1; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx >= 0 && ny >= 0 && nx < n && ny < n && plate[ny * n + nx] !== p) q = plate[ny * n + nx];
    }
    if (q === -1) continue;
    // Normal from this plate toward q: mean offset of q's cells in a 5×5 window.
    let sx = 0;
    let sy = 0;
    let cont = 0;
    let cnt = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (plate[j] !== q) continue;
        sx += dx;
        sy += dy;
        cnt++;
        if (continent[j] !== -1) cont++;
      }
    }
    const len = Math.hypot(sx, sy) || 1;
    cells.push(c);
    other.push(q);
    nxs.push(sx / len);
    nys.push(sy / len);
    oc.push(cont * 2 > cnt ? 1 : 0);
  }
  return {
    cells: Int32Array.from(cells),
    other: Int32Array.from(other),
    nx: Float64Array.from(nxs),
    ny: Float64Array.from(nys),
    otherCont: Uint8Array.from(oc),
  };
}

interface Motion {
  tx: Float64Array;
  ty: Float64Array;
  omega: Float64Array;
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
  f: Frame, plate: Int32Array, continent: Int32Array, n: number, cellKm: number,
  cx: Float64Array, cy: Float64Array, m: Motion, rng: Rng,
): Omit<Classified, 'score' | 'motion'> {
  const nb = f.cells.length;
  const conv = new Float64Array(nb);
  const shear = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    const c = f.cells[i];
    const px = ((c % n) + 0.5) * cellKm;
    const py = (Math.floor(c / n) + 0.5) * cellKm;
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
  const index = new Int32Array(n * n).fill(-1);
  for (let i = 0; i < nb; i++) index[f.cells[i]] = i;
  // Smooth along the boundary so classes don't flicker between neighbouring cells.
  const sConv = new Float64Array(nb);
  const sShear = new Float64Array(nb);
  for (let i = 0; i < nb; i++) {
    const c = f.cells[i];
    const x = c % n;
    const y = (c - x) / n;
    const lo = Math.min(plate[c], f.other[i]);
    const hi = Math.max(plate[c], f.other[i]);
    let sc = 0;
    let ss = 0;
    let k = 0;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = index[ny * n + nx];
        if (j < 0) continue;
        const a = plate[f.cells[j]];
        const b = f.other[j];
        if (Math.min(a, b) !== lo || Math.max(a, b) !== hi) continue;
        sc += conv[j];
        ss += shear[j];
        k++;
      }
    }
    sConv[i] = sc / k;
    sShear[i] = ss / k;
  }

  const bClass = new Uint8Array(n * n);
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
  const bSeg = new Int32Array(n * n).fill(-1);
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
      const x = c % n;
      const y = (c - x) / n;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const nc = ny * n + nx;
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
