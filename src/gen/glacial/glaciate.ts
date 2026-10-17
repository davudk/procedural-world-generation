import type { Rng } from '../../shared/rng';
import { cellFace, cellIndex, cellX, cellY, chartXY, isDiagonalStep, stepLength, tryCellIndex, type Grid } from '../grid/grid';
import { boxBlur, components, smoothstep } from '../grid/ops';
import { LAND_MIN } from '../lem/streamPower';
import { CorridorSources, corridorCarve, softenCarve } from './corridor';
import { donorsCsr, flowOrder, glacierWidth, heightAboveEla, iceFlux, Q0, Q_TROUGH, troughDepth, type IceFlux } from './flux';

/**
 * Cheap glacial carving after the LEM (research 01 §5): ice flux along the drainage from cells above
 * the equilibrium line, parabolic U-troughs evaluated per cell from the distance to a smoothed
 * glacier centreline (corridor.ts; the carve field is then softened ~1 cell where troughs are wide),
 * cirque bowls at glacier heads, and over-deepened fjords with a mouth sill where a large glacier
 * reached a cold coast. Only ever lowers terrain.
 */

export interface GlaciateInput {
  grid: Grid;
  h: Float32Array;
  fixed: Uint8Array;
  rcv: Int32Array;
  temp: Float32Array;
  tAmp: Float32Array;
  precip: Float32Array;
}

export interface GlaciateOptions {
  /** ELA temperature shift of the present climate (°C, + = more ice): 2·(glaciation − 1). */
  presentShift: number;
  /** Extra shift of the glacial maximum that carved the troughs (°C). */
  pastShift: number;
  fjords: boolean;
}

export interface GlaciateResult {
  /** False when no cell reaches the past ELA: the outputs are plain copies. */
  carved: boolean;
  h: Float32Array;
  fixed: Uint8Array;
  ice: Float32Array;
  /** Metres removed by carving (≥ 0). */
  carve: Float32Array;
  /** 1 = sea cell of a carved fjord. */
  fjord: Uint8Array;
  stats: Record<string, number>;
}

/** Ice flux at which a glacier reaching the coast carves a fjord (2·Q0). */
const Q_FJORD = 6e10;
/** Fjords need this much glaciated relief upstream of the mouth (m): mountainous coasts only. */
const FJORD_RELIEF = 1000;
/** Total fjord trunk length per 1024 km of world width (km); both shores ≈ 2× that of coastline. */
const FJORD_BUDGET_KM = 550;
/** Fjords stop where the pre-glacial valley floor rises above this (m). */
const FJORD_HEAD_MAX = 600;
/** Minimum spacing of fjord mouths (m). */
const FJORD_SPACING = 20_000;
/** Fjord half-width cap (m): fjords are 2–6 km wide (Sognefjord ~4.5 km). */
const FJORD_HALF_WIDTH = 3000;
/** Cirques sit at glacier heads at most this far above the glacial-maximum ELA (m). */
const CIRQUE_BAND = 1200;
/** Present-day ice tongues are drawn from this flux on (smaller ones are snowfields). */
const Q_ICE = 5e8;
/**
 * Smallest trough half-width in cells: a glacier narrower than a cell still lowers its own channel
 * cell even where the smoothed centreline passes off the cell centre.
 */
const MIN_HALF_CELLS = 0.8;
/** Minimum downhill gradient at a glacier head for a cirque. */
const CIRQUE_SLOPE = 0.08;

export function glaciate(inp: GlaciateInput, opt: GlaciateOptions, rng: Rng): GlaciateResult {
  const { grid: g, h: hIn, fixed: fixedIn, rcv } = inp;
  const { cells: N, cellM } = g;
  const dzPast = heightAboveEla(inp.temp, inp.tAmp, inp.precip, opt.presentShift + opt.pastShift, new Float32Array(N));
  let any = false;
  for (let i = 0; i < N && !any; i++) any = !fixedIn[i] && dzPast[i] > 0;
  const stats: Record<string, number> = {
    glaciers: 0, iceShare: 0, pastIceShare: 0, fjords: 0, fjordCoastKm: 0, cirques: 0, maxCarveM: 0, maxFjordDepthM: 0, troughKm: 0,
  };
  if (!any) {
    return {
      carved: false, h: hIn.slice(), fixed: fixedIn.slice(), ice: new Float32Array(N), carve: new Float32Array(N), fjord: new Uint8Array(N), stats,
    };
  }

  let tLap = performance.now();
  const lap = (key: string): void => {
    const now = performance.now();
    stats[key] = (stats[key] ?? 0) + now - tLap;
    tLap = now;
  };
  const order = flowOrder(rcv);
  const past = iceFlux(order, rcv, fixedIn, hIn, dzPast, inp.precip, g);
  const dzNow = heightAboveEla(inp.temp, inp.tAmp, inp.precip, opt.presentShift, new Float32Array(N));
  const now = iceFlux(order, rcv, fixedIn, hIn, dzNow, inp.precip, g);

  lap('fluxMs');
  const h = hIn.slice();
  const carver = new Stamper(g, h, fixedIn, hIn);

  // U-troughs: every glaciated channel cell is a centreline source of a parabolic cross-section
  // around its lowered floor, applied once per cell by distance to the centreline (corridor.ts).
  // Depth grows with flux (so tributaries end above the trunk floor: hanging valleys) and is limited
  // by the relief the ice drains from (plateau ice sheets scour little).
  const troughs = troughSources(past, rcv, fixedIn, hIn, g);
  lap('srcMs');
  const troughField = corridorCarve(troughs, hIn, fixedIn, g, false);
  lap('corrMs');

  const fjordMask = new Uint8Array(N);
  let fjordWalks: number[][] = [];
  let carveRaw = troughField.carve;
  let rcField = troughField.rc;
  if (opt.fjords) {
    const fj = fjordSources(inp, past, rng);
    fjordWalks = fj.walks;
    if (fj.sources.size > 0) {
      const fjField = corridorCarve(fj.sources, hIn, fixedIn, g, true);
      for (let i = 0; i < N; i++) {
        if (fjField.carve[i] <= 0) continue;
        fjordMask[i] = 1;
        if (fjField.carve[i] > carveRaw[i]) carveRaw[i] = fjField.carve[i];
        if (fjField.rc[i] > rcField[i]) rcField[i] = fjField.rc[i];
      }
    }
  }
  lap('fjCorrMs');
  // Soften (σ ≈ 1 cell where corridors are wide) and apply; only fjords may lower sea cells.
  const carveSoft = softenCarve(carveRaw, rcField, g);
  lap('softMs');
  for (let i = 0; i < N; i++) {
    if (fixedIn[i] && !fjordMask[i]) continue;
    const v = hIn[i] - carveSoft[i];
    if (v < h[i]) h[i] = v;
  }
  lap('troughMs');

  // Cirques: bowls with a flat floor and steep headwall (cubic profile) at glacier heads near the ELA.
  // (Isolated radial stamps: a bowl is round, so no scallops.)
  let cirques = 0;
  for (let i = 0; i < N; i++) {
    if (fixedIn[i] || past.q[i] < Q_TROUGH || past.troughDonor[i]) continue;
    if (dzPast[i] < 0 || dzPast[i] > CIRQUE_BAND) continue;
    // Only on steep ground: plateau ice caps have no cirques.
    const r = rcv[i];
    const run = g.uniform ? (isDiagonalStep(g, i, r) ? cellM * Math.SQRT2 : cellM) : stepLength(g, i, r);
    if ((hIn[i] - hIn[r]) / run < CIRQUE_SLOPE) continue;
    const R = rng.range(1000, 2500);
    const depth = rng.range(80, 220);
    carver.stamp(i, Math.max(1, hIn[i] - depth), hIn[i] + 0.5 * depth, R, 0, 3, 1.5 * depth, false);
    cirques++;
  }

  lap('cirqueMs');

  // Sea: carved cells at or below 0 m join the sea when 4-connected to it; enclosed ones stay land.
  const fixed = fixedIn.slice();
  floodSea(h, fixed, g);
  for (let i = 0; i < N; i++) if (!fixed[i] && h[i] < LAND_MIN) h[i] = LAND_MIN;

  const fjord = new Uint8Array(N);
  let fjordCount = 0;
  let maxFjordDepth = 0;
  for (const cells of fjordWalks) {
    let fresh = 0;
    for (const c of cells) if (fixed[c] && !fixedIn[c]) fresh++;
    if (fresh >= 2) fjordCount++;
  }
  let troughCells = 0;
  for (let i = 0; i < N; i++) {
    if (fixedIn[i] === 0 && past.q[i] >= Q_TROUGH) troughCells++;
    if (fjordMask[i] && fixed[i] && h[i] < 0) {
      fjord[i] = 1;
      maxFjordDepth = Math.max(maxFjordDepth, -h[i]);
    }
  }
  let fjordEdges = 0;
  const { off4, axialToRaster, border } = g;
  for (let i = 0; i < N; i++) {
    if (!fjord[i]) continue;
    for (let k = 0; k < 4; k++) {
      const j = border[i] === 0 ? i + off4[k] : g.nbr(i, axialToRaster[k]);
      if (j >= 0 && !fixed[j]) fjordEdges++;
    }
  }

  const carve = new Float32Array(N);
  let maxCarve = 0;
  for (let i = 0; i < N; i++) {
    carve[i] = Math.max(0, hIn[i] - h[i]);
    if (carve[i] > maxCarve) maxCarve = carve[i];
  }

  lap('seaMs');
  const ice = iceCover(now, dzNow, fixed, inp.grid);
  lap('iceMs');
  let land = 0;
  let iceSum = 0;
  let pastIce = 0;
  for (let i = 0; i < N; i++) {
    if (fixed[i]) continue;
    land++;
    iceSum += ice[i];
    if (past.q[i] > 0) pastIce++;
  }
  const glacierMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) glacierMask[i] = ice[i] >= 0.5 ? 1 : 0;
  const minCells = Math.max(1, Math.ceil(2e6 / (cellM * cellM)));
  const glaciers = components(glacierMask, inp.grid).sizes.filter((s) => s >= minCells).length;

  Object.assign(stats, {
    glaciers,
    iceShare: land ? iceSum / land : 0,
    pastIceShare: land ? pastIce / land : 0,
    fjords: fjordCount,
    fjordCoastKm: Math.round(fjordEdges * g.cellKm),
    cirques,
    maxCarveM: Math.round(maxCarve),
    maxFjordDepthM: Math.round(maxFjordDepth),
    troughKm: Math.round(troughCells * g.cellKm),
  });
  return { carved: true, h, fixed, ice, carve, fjord, stats };
}

/** 1-2-1 smoothing of a polyline coordinate, end points fixed. */
function smoothLine(v: number[]): number[] {
  let a = v;
  for (let it = 0; it < 2; it++) {
    const b = a.slice();
    for (let k = 1; k < a.length - 1; k++) b[k] = 0.25 * a[k - 1] + 0.5 * a[k] + 0.25 * a[k + 1];
    a = b;
  }
  return a;
}

/**
 * Trough centreline: every channel cell with flux ≥ Q_TROUGH is a vertex linked to its receiver.
 * Depth grows with flux (so tributaries end above the trunk floor: hanging valleys) and is limited by
 * the relief the ice drains from (plateau ice sheets scour little). Vertex positions are smoothed
 * twice along each trunk (receiver and largest-flux donor, 1-2-1) to take the D8 zigzag out of the
 * centreline; a tributary keeps its junction point, so it still meets the trunk.
 */
function troughSources(past: IceFlux, rcv: Int32Array, fixed: Uint8Array, h: Float32Array, g: Grid): CorridorSources {
  const { cells: N, cellM } = g;
  const src = new CorridorSources();
  const idx = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    const q = past.q[i];
    if (fixed[i] || q < Q_TROUGH) continue;
    const D = Math.min(troughDepth(q), 50 + 0.6 * Math.max(0, past.top[i] - h[i]));
    idx[i] = src.addCell(g, i, Math.max(1, h[i] - D), h[i] + 0.6 * D, Math.max(MIN_HALF_CELLS, glacierWidth(q) / 2 / cellM), 1.5 * D);
  }
  const main = new Int32Array(src.size).fill(-1);
  const cells = new Int32Array(src.size);
  for (let i = 0; i < N; i++) {
    const s = idx[i];
    if (s < 0) continue;
    cells[s] = i;
    const r = idx[rcv[i]];
    if (r >= 0 && rcv[i] !== i) {
      src.next[s] = r;
      if (main[r] < 0 || past.q[i] > past.q[cells[main[r]]]) main[r] = s;
    }
  }
  const sphere = g.shape !== 'flat';
  for (let it = 0; it < 2; it++) {
    const x = src.x.slice();
    const y = src.y.slice();
    const z = src.z.slice();
    for (let s = 0; s < src.size; s++) {
      const d = src.next[s];
      const down = d >= 0 && main[d] === s ? d : s;
      const up = main[s] >= 0 ? main[s] : s;
      if (down === s && up === s) continue;
      x[s] = 0.25 * src.x[down] + 0.5 * src.x[s] + 0.25 * src.x[up];
      y[s] = 0.25 * src.y[down] + 0.5 * src.y[s] + 0.25 * src.y[up];
      if (sphere) {
        // Unit vectors: smooth in 3D and project back onto the sphere.
        z[s] = 0.25 * src.z[down] + 0.5 * src.z[s] + 0.25 * src.z[up];
        const l = Math.hypot(x[s], y[s], z[s]);
        x[s] /= l;
        y[s] /= l;
        z[s] /= l;
      }
    }
    for (let s = 0; s < src.size; s++) {
      src.x[s] = x[s];
      src.y[s] = y[s];
      if (sphere) src.z[s] = z[s];
    }
  }
  return src;
}

/** Writes h = min(h, target) stamps with a power-law cross-section around a centre cell. */
class Stamper {
  constructor(
    readonly g: Grid,
    readonly h: Float32Array,
    readonly fixed: Uint8Array,
    /** Heights before carving, for the per-stamp cut limit. */
    readonly ref: Float32Array | null = null,
  ) {}

  /**
   * target(d) = floor + (edge − floor)·(d/R)^pow within radius R (m, at least `minCells` cells).
   * No cell is cut more than `maxCut` below its pre-carving height (truncated spurs, not razed
   * ridges). Sea cells are only touched when `sea` is set.
   */
  stamp(
    c: number, floor: number, edge: number, R: number, minCells: number, pow: number, maxCut: number, sea: boolean,
  ): void {
    const { g, h, fixed, ref } = this;
    const rc = Math.max(R / g.cellM, minCells);
    const r = Math.floor(rc);
    const inv = rc > 0 ? 1 / rc : 0;
    const span = edge - floor;
    // Plain loops rather than forWindow: tongues stamp once per glacier cell.
    // On the sphere the window continues across seams in c's face chart (cells there may be hit
    // twice, which the min-stamp absorbs).
    const cx = cellX(g, c);
    const cy = cellY(g, c);
    const cf = cellFace(g, c);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const i = tryCellIndex(g, cx + dx, cy + dy, cf);
        if (i < 0) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > rc * rc) continue;
        if (fixed[i] && !sea) continue;
        const t = Math.sqrt(d2) * inv;
        let target = floor + span * (pow === 2 ? t * t : t ** pow);
        if (ref && target < ref[i] - maxCut) target = ref[i] - maxCut;
        if (target < h[i]) h[i] = target;
      }
    }
  }
}

/**
 * Fjords: every coast-reaching glacier with flux ≥ Q_FJORD (largest first, mouths ≥ 12 km apart)
 * deepens its trunk trough inland: depth 300–1200 m by flux, a 50–150 m sill at the mouth, the deep
 * basin from ~15 % of the length, shoaling to the fjord head (length 15–200 km by flux, ending where
 * the valley floor rises above 600 m). Returns the corridor sources (trunk cells, plus one side cell at
 * each diagonal step so the fjord stays 4-connected) and the trunk cells of each fjord.
 */
function fjordSources(inp: GlaciateInput, past: IceFlux, rng: Rng): { sources: CorridorSources; walks: number[][] } {
  const { grid: g, h: hIn, fixed, rcv } = inp;
  const { n, cells: N, cellM } = g;
  const mouths: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = rcv[i];
    // A real coast: the receiver is sea (h ≤ 0), not an open continental map edge.
    if (!fixed[i] && r !== i && fixed[r] && hIn[r] <= 0 && past.q[i] >= Q_FJORD && past.top[i] >= FJORD_RELIEF) mouths.push(i);
  }
  // Per 1024 km of world width; a sphere uses its equal-area size √A.
  let budget = FJORD_BUDGET_KM * 1000 * ((g.shape === 'flat' ? n * cellM : Math.sqrt(g.totalArea)) / 1_024_000);
  mouths.sort((a, b) => past.q[b] - past.q[a] || a - b);
  const { start, list } = donorsCsr(rcv);
  const taken: number[] = [];
  const walks: number[][] = [];
  const sources = new CorridorSources();
  for (const m of mouths) {
    if (budget <= 0) break;
    const mx = cellX(g, m);
    const my = cellY(g, m);
    let near = false;
    for (const t of taken) {
      const d = g.shape === 'flat' ? Math.hypot(cellX(g, t) - mx, cellY(g, t) - my) * cellM : g.distance(t, m);
      if (d < FJORD_SPACING) {
        near = true;
        break;
      }
    }
    if (near) continue;
    taken.push(m);

    const qm = past.q[m];
    const depthMax = Math.min(1200, Math.max(300, 350 * (qm / Q0) ** 0.3 * rng.range(0.85, 1.15)));
    const sill = Math.min(0.4 * depthMax, rng.range(50, 150));
    const lMax = Math.min(200_000, Math.max(15_000, 25_000 * (qm / Q0) ** 0.35));
    // Trunk walk upstream along the largest-flux donor.
    const path = [m];
    const dist = [0];
    let c = m;
    let s = 0;
    while (s < lMax) {
      let best = -1;
      for (let k = start[c]; k < start[c + 1]; k++) {
        const d = list[k];
        if (!fixed[d] && (best < 0 || past.q[d] > past.q[best])) best = d;
      }
      if (best < 0 || past.q[best] < 0.3 * Q_FJORD || hIn[best] > FJORD_HEAD_MAX) break;
      if (g.shape === 'flat') {
        const ddx = cellX(g, best) - cellX(g, c);
        const ddy = cellY(g, best) - cellY(g, c);
        s += Math.hypot(ddx, ddy) * cellM;
      } else s += stepLength(g, best, c);
      path.push(best);
      dist.push(s);
      c = best;
    }
    if (path.length < 3) continue;
    budget -= s;
    const L = Math.max(s, 2 * cellM);
    // Centreline vertices: the sea cell beyond the mouth, then the trunk, positions smoothed 1-2-1.
    const line = [rcv[m], ...path];
    // Flat: cell coordinates; sphere: unit vectors, smoothed in 3D and renormalised.
    const sphere = g.shape !== 'flat';
    const pos = sphere ? line.map((c) => { const v = new Float64Array(3); g.position(c, v); return v; }) : null;
    const px = smoothLine(pos ? pos.map((v) => v[0]) : line.map((c) => cellX(g, c)));
    const py = smoothLine(pos ? pos.map((v) => v[1]) : line.map((c) => cellY(g, c)));
    const pz = pos ? smoothLine(pos.map((v) => v[2])) : null;
    if (pz) {
      for (let k = 0; k < px.length; k++) {
        const l = Math.hypot(px[k], py[k], pz[k]);
        px[k] /= l;
        py[k] /= l;
        pz[k] /= l;
      }
    }
    let prev = -1;
    let prevRc = 1;
    for (let k = 0; k < line.length; k++) {
      const p = line[k];
      const t = k === 0 ? 0 : dist[k - 1];
      const rise = smoothstep(0, Math.max(0.15 * L, 1.5 * cellM), t);
      const fall = 1 - smoothstep(0.6 * L, 1.1 * L, t);
      const depth = (sill + (depthMax - sill) * rise) * fall;
      const q = k === 0 ? past.q[m] : past.q[p];
      const half = Math.min(FJORD_HALF_WIDTH, glacierWidth(q) / 2);
      // The vertex beyond the mouth sits on the sea: shape it from the mouth's height.
      const hp = Math.max(k === 0 ? hIn[m] : hIn[p], 0);
      const floor = Math.min(-depth, hp - troughDepth(q));
      const cut = hp - floor + 300;
      const edge = hp + 0.5 * depthMax;
      const rc = Math.max(1, half / cellM);
      const v = pz ? sources.addDir(px[k], py[k], pz[k], floor, edge, rc, cut) : sources.add(px[k], py[k], floor, edge, rc, cut);
      if (prev >= 0) sources.next[v] = prev;
      // On narrow (≤ 2-cell) fjords a diagonal step also gets the shared side cell as a point source,
      // so the fjord stays 4-connected.
      if (k > 0 && rc < 2) {
        const a = line[k - 1];
        if (isDiagonalStep(g, a, p)) {
          let s1: number;
          let s2: number;
          if (!sphere) {
            s1 = cellIndex(g, cellX(g, p), cellY(g, a));
            s2 = cellIndex(g, cellX(g, a), cellY(g, p));
          } else {
            // The two cells sharing edges with both, in p's face chart (a may be across a seam).
            const fp = cellFace(g, p);
            const q = new Float64Array(2);
            chartXY(g, fp, a, q);
            s1 = tryCellIndex(g, cellX(g, p), Math.round(q[1]), fp);
            s2 = tryCellIndex(g, Math.round(q[0]), cellY(g, p), fp);
            if (s1 < 0) s1 = s2;
            if (s2 < 0) s2 = s1;
          }
          if (s1 >= 0) {
            const side = hIn[s1] <= hIn[s2] ? s1 : s2;
            if (sphere) sources.addCell(g, side, floor, edge, Math.min(rc, prevRc), cut);
            else sources.add(cellX(g, side), cellY(g, side), floor, edge, Math.min(rc, prevRc), cut);
          }
        }
      }
      prev = v;
      prevRc = rc;
    }
    walks.push(path);
  }
  return { sources, walks };
}

/**
 * Joins cells at or below 0 m to the sea where 4-connected to it (in place on `fixed`). Open map
 * edges (fixed cells above 0 m on a continental edge) are base level but not sea, so never seed.
 */
function floodSea(h: Float32Array, fixed: Uint8Array, g: Grid): void {
  const { cells: N, off4, axialToRaster, border } = g;
  const stack: number[] = [];
  const join = (j: number): void => {
    fixed[j] = 1;
    stack.push(j);
  };
  const nb = (c: number, k: number): number => (border[c] === 0 ? c + off4[k] : g.nbr(c, axialToRaster[k]));
  // Seeds: carved land cells at or below 0 m touching the sea; then spread through such cells.
  for (let i = 0; i < N; i++) {
    if (fixed[i] || h[i] > 0) continue;
    for (let k = 0; k < 4; k++) {
      const j = nb(i, k);
      if (j >= 0 && fixed[j] === 1 && h[j] <= 0) {
        join(i);
        break;
      }
    }
  }
  while (stack.length > 0) {
    const c = stack.pop()!;
    for (let k = 0; k < 4; k++) {
      const j = nb(c, k);
      if (j >= 0 && !fixed[j] && h[j] <= 0) join(j);
    }
  }
}

/**
 * Present-day ice cover 0–1: accumulation zones fade in over 0–150 m above the ELA, tongues fill
 * their glacier width; a 3×3 blur softens the edges outward. Zero on the sea.
 */
function iceCover(now: IceFlux, dz: Float32Array, fixed: Uint8Array, g: Grid): Float32Array {
  const N = g.cells;
  const raw = new Float32Array(N);
  // Tongues: the min-stamp on negated cover, −1 inside the glacier width fading to 0 at its edge.
  const tongue = new Float32Array(N);
  const st = new Stamper(g, tongue, fixed);
  for (let i = 0; i < N; i++) {
    if (fixed[i]) continue;
    if (dz[i] > 0) raw[i] = smoothstep(0, 150, dz[i]);
    const q = now.q[i];
    if (q >= Q_ICE) st.stamp(i, -1, 0, glacierWidth(q) / 2, 0, 4, Infinity, false);
    else if (q > 0) raw[i] = Math.max(raw[i], q / Q_ICE);
  }
  for (let i = 0; i < N; i++) raw[i] = Math.max(raw[i], -tongue[i]);
  const soft = raw.slice();
  boxBlur(soft, g, 1);
  for (let i = 0; i < N; i++) raw[i] = fixed[i] ? 0 : Math.min(1, Math.max(raw[i], soft[i]));
  return raw;
}
