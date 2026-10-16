import type { Rng } from '../../shared/rng';
import type { Grid } from '../grid/grid';
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
  n: number;
  cellKm: number;
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
  const { n, h: hIn, fixed: fixedIn, rcv } = inp;
  const N = n * n;
  const cellM = inp.cellKm * 1000;
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
  const past = iceFlux(order, rcv, fixedIn, hIn, dzPast, inp.precip, n, cellM);
  const dzNow = heightAboveEla(inp.temp, inp.tAmp, inp.precip, opt.presentShift, new Float32Array(N));
  const now = iceFlux(order, rcv, fixedIn, hIn, dzNow, inp.precip, n, cellM);

  lap('fluxMs');
  const h = hIn.slice();
  const carver = new Stamper(n, cellM, h, fixedIn, hIn);

  // U-troughs: every glaciated channel cell is a centreline source of a parabolic cross-section
  // around its lowered floor, applied once per cell by distance to the centreline (corridor.ts).
  // Depth grows with flux (so tributaries end above the trunk floor: hanging valleys) and is limited
  // by the relief the ice drains from (plateau ice sheets scour little).
  const troughs = troughSources(past, rcv, fixedIn, hIn, n, cellM);
  lap('srcMs');
  const troughField = corridorCarve(troughs, hIn, fixedIn, n, false);
  lap('corrMs');

  const fjordMask = new Uint8Array(N);
  let fjordWalks: number[][] = [];
  let carveRaw = troughField.carve;
  let rcField = troughField.rc;
  if (opt.fjords) {
    const fj = fjordSources(inp, past, rng);
    fjordWalks = fj.walks;
    if (fj.sources.size > 0) {
      const fjField = corridorCarve(fj.sources, hIn, fixedIn, n, true);
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
  const carveSoft = softenCarve(carveRaw, rcField, n);
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
    const run = Math.abs(r - i) === 1 || Math.abs(r - i) === n ? cellM : cellM * Math.SQRT2;
    if ((hIn[i] - hIn[r]) / run < CIRQUE_SLOPE) continue;
    const R = rng.range(1000, 2500);
    const depth = rng.range(80, 220);
    carver.stamp(i, Math.max(1, hIn[i] - depth), hIn[i] + 0.5 * depth, R, 0, 3, 1.5 * depth, false);
    cirques++;
  }

  lap('cirqueMs');

  // Sea: carved cells at or below 0 m join the sea when 4-connected to it; enclosed ones stay land.
  const fixed = fixedIn.slice();
  floodSea(h, fixed, n);
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
  for (let i = 0; i < N; i++) {
    if (!fjord[i]) continue;
    const x = i % n;
    if (x > 0 && !fixed[i - 1]) fjordEdges++;
    if (x < n - 1 && !fixed[i + 1]) fjordEdges++;
    if (i >= n && !fixed[i - n]) fjordEdges++;
    if (i < N - n && !fixed[i + n]) fjordEdges++;
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
    fjordCoastKm: Math.round(fjordEdges * inp.cellKm),
    cirques,
    maxCarveM: Math.round(maxCarve),
    maxFjordDepthM: Math.round(maxFjordDepth),
    troughKm: Math.round(troughCells * inp.cellKm),
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
function troughSources(past: IceFlux, rcv: Int32Array, fixed: Uint8Array, h: Float32Array, n: number, cellM: number): CorridorSources {
  const N = n * n;
  const src = new CorridorSources();
  const idx = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    const q = past.q[i];
    if (fixed[i] || q < Q_TROUGH) continue;
    const D = Math.min(troughDepth(q), 50 + 0.6 * Math.max(0, past.top[i] - h[i]));
    idx[i] = src.add(i % n, Math.floor(i / n), Math.max(1, h[i] - D), h[i] + 0.6 * D, Math.max(MIN_HALF_CELLS, glacierWidth(q) / 2 / cellM), 1.5 * D);
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
  for (let it = 0; it < 2; it++) {
    const x = src.x.slice();
    const y = src.y.slice();
    for (let s = 0; s < src.size; s++) {
      const d = src.next[s];
      const down = d >= 0 && main[d] === s ? d : s;
      const up = main[s] >= 0 ? main[s] : s;
      if (down === s && up === s) continue;
      x[s] = 0.25 * src.x[down] + 0.5 * src.x[s] + 0.25 * src.x[up];
      y[s] = 0.25 * src.y[down] + 0.5 * src.y[s] + 0.25 * src.y[up];
    }
    for (let s = 0; s < src.size; s++) {
      src.x[s] = x[s];
      src.y[s] = y[s];
    }
  }
  return src;
}

/** Writes h = min(h, target) stamps with a power-law cross-section around a centre cell. */
class Stamper {
  constructor(
    readonly n: number,
    readonly cellM: number,
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
    const { n, h, fixed, ref } = this;
    const rc = Math.max(R / this.cellM, minCells);
    const r = Math.floor(rc);
    const cx = c % n;
    const cy = (c - cx) / n;
    const inv = rc > 0 ? 1 / rc : 0;
    const span = edge - floor;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= n) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= n) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > rc * rc) continue;
        const i = y * n + x;
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
  const { n, h: hIn, fixed, rcv } = inp;
  const N = n * n;
  const cellM = inp.cellKm * 1000;
  const mouths: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = rcv[i];
    // A real coast: the receiver is sea (h ≤ 0), not an open continental map edge.
    if (!fixed[i] && r !== i && fixed[r] && hIn[r] <= 0 && past.q[i] >= Q_FJORD && past.top[i] >= FJORD_RELIEF) mouths.push(i);
  }
  let budget = FJORD_BUDGET_KM * 1000 * ((n * cellM) / 1_024_000);
  mouths.sort((a, b) => past.q[b] - past.q[a] || a - b);
  const { start, list } = donorsCsr(rcv);
  const taken: number[] = [];
  const walks: number[][] = [];
  const sources = new CorridorSources();
  for (const m of mouths) {
    if (budget <= 0) break;
    const mx = m % n;
    const my = (m - mx) / n;
    let near = false;
    for (const t of taken) {
      const tx = t % n;
      const ty = (t - tx) / n;
      if (Math.hypot(tx - mx, ty - my) * cellM < FJORD_SPACING) {
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
      const ddx = (best % n) - (c % n);
      const ddy = Math.floor(best / n) - Math.floor(c / n);
      s += Math.hypot(ddx, ddy) * cellM;
      path.push(best);
      dist.push(s);
      c = best;
    }
    if (path.length < 3) continue;
    budget -= s;
    const L = Math.max(s, 2 * cellM);
    // Centreline vertices: the sea cell beyond the mouth, then the trunk, positions smoothed 1-2-1.
    const line = [rcv[m], ...path];
    const px = smoothLine(line.map((c) => c % n));
    const py = smoothLine(line.map((c) => Math.floor(c / n)));
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
      const v = sources.add(px[k], py[k], floor, edge, rc, cut);
      if (prev >= 0) sources.next[v] = prev;
      // On narrow (≤ 2-cell) fjords a diagonal step also gets the shared side cell as a point source,
      // so the fjord stays 4-connected.
      if (k > 0 && rc < 2) {
        const a = line[k - 1];
        if (Math.abs(p - a) !== 1 && Math.abs(p - a) !== n) {
          const s1 = Math.floor(a / n) * n + (p % n);
          const s2 = Math.floor(p / n) * n + (a % n);
          const side = hIn[s1] <= hIn[s2] ? s1 : s2;
          sources.add(side % n, Math.floor(side / n), floor, edge, Math.min(rc, prevRc), cut);
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
function floodSea(h: Float32Array, fixed: Uint8Array, n: number): void {
  const N = n * n;
  const stack: number[] = [];
  const join = (j: number): void => {
    fixed[j] = 1;
    stack.push(j);
  };
  // Seeds: carved land cells at or below 0 m touching the sea; then spread through such cells.
  for (let i = 0; i < N; i++) {
    if (fixed[i] || h[i] > 0) continue;
    const x = i % n;
    const sea = (j: number): boolean => fixed[j] === 1 && h[j] <= 0;
    if ((x > 0 && sea(i - 1)) || (x < n - 1 && sea(i + 1)) || (i >= n && sea(i - n)) || (i < N - n && sea(i + n))) join(i);
  }
  while (stack.length > 0) {
    const c = stack.pop()!;
    const x = c % n;
    if (x > 0 && !fixed[c - 1] && h[c - 1] <= 0) join(c - 1);
    if (x < n - 1 && !fixed[c + 1] && h[c + 1] <= 0) join(c + 1);
    if (c >= n && !fixed[c - n] && h[c - n] <= 0) join(c - n);
    if (c < N - n && !fixed[c + n] && h[c + n] <= 0) join(c + n);
  }
}

/**
 * Present-day ice cover 0–1: accumulation zones fade in over 0–150 m above the ELA, tongues fill
 * their glacier width; a 3×3 blur softens the edges outward. Zero on the sea.
 */
function iceCover(now: IceFlux, dz: Float32Array, fixed: Uint8Array, g: Grid): Float32Array {
  const { n, cellM } = g;
  const N = n * n;
  const raw = new Float32Array(N);
  // Tongues: the min-stamp on negated cover, −1 inside the glacier width fading to 0 at its edge.
  const tongue = new Float32Array(N);
  const st = new Stamper(n, cellM, tongue, fixed);
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
