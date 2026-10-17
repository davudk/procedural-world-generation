import { dirToCell } from '../../shared/cube';
import { RIVER } from '../../shared/protocol';
import type { Rng } from '../../shared/rng';
import { localFrame } from '../grid/cube';
import { cellIndex, forWindow, type Grid } from '../grid/grid';
import { DEPTH_COEF, WIDTH_COEF } from './geometry';
import type { GraphBuilder } from './graph';

/** Rivers below this discharge (m³/s) get a plain mouth (research 02 §5.2). */
export const DELTA_MIN_Q = 150;
/** The largest sea mouth gets a delta when no other has one, if it carries at least this (m³/s). */
const GUARANTEE_MIN_Q = 50;
/** Inland deltas into terminal lakes / dry sinks (research 02 §5.3–5.4). */
const INLAND_LAKE_MIN_Q = 100;
const INLAND_DRY_MIN_Q = 30;
/** Shelf shallower than this (m) within SHELF_KM of the mouth allows a delta lobe. */
const SHELF_DEPTH = 50;
const SHELF_KM = 20;

export interface DeltaInput {
  grid: Grid;
  h: Float32Array;
  fixed: Uint8Array;
  lakeId: Int32Array;
  lakeLevel: Float64Array;
  waveEnergy: number;
  tideRange: number;
  spacing: number;
  rng: Rng;
  /** At most this many sea deltas (largest discharge first); the rest get plain mouths. */
  maxSea: number;
}

export interface DeltaStats {
  birdsFoot: number;
  arcuate: number;
  cuspate: number;
  estuaries: number;
  inland: number;
  distributaries: number;
}

type Style = 'river' | 'wave' | 'tide';

/**
 * Deltas, estuaries and inland deltas as a distributary extension of the graph (research 02 §5):
 * Galloway style from discharge vs wave and tide energy. Distributaries leave a DELTA apex upstream
 * of the mouth, cross the delta plain (never climbing above the apex water level) and end where they
 * reach the sea or the lake; arid dry-sink fans end on land. Their cells are marked in `plain`.
 * On the sphere (3D builder positions) the fan is laid out in the tangent plane at the apex.
 */
export function addDeltas(gb: GraphBuilder, inp: DeltaInput, plain: Uint8Array): DeltaStats {
  const { grid, h, fixed, lakeId, rng } = inp;
  const { n, cellM } = grid;
  /** Map size in metres (distributaries stop at the map edge). */
  const mapM = n * cellM;
  const stats: DeltaStats = { birdsFoot: 0, arcuate: 0, cuspate: 0, estuaries: 0, inland: 0, distributaries: 0 };
  const sphere = gb.sphere;
  const cellOf = (x: number, y: number): number => {
    const cx = Math.min(n - 1, Math.max(0, Math.floor(x / cellM)));
    const cy = Math.min(n - 1, Math.max(0, Math.floor(y / cellM)));
    return cellIndex(grid, cx, cy);
  };
  const cellOfNode = (i: number): number => (sphere ? dirToCell(gb.x[i], gb.y[i], gb.w[i], n) : cellOf(gb.x[i], gb.y[i]));
  // Sphere: tangent plane at the apex (origin A, axes E and Nn); flat: the map plane itself.
  const A = new Float64Array(3);
  const E = new Float64Array(3);
  const Nn = new Float64Array(3);
  const U = new Float64Array(3);
  const P = new Float64Array(3);
  const toWorld = (x: number, y: number): void => {
    for (let k = 0; k < 3; k++) P[k] = A[k] + x * E[k] + y * Nn[k];
  };
  const cellOfLocal = (x: number, y: number): number => {
    if (!sphere) return cellOf(x, y);
    toWorld(x, y);
    return dirToCell(P[0], P[1], P[2], n);
  };
  const reaches = gb.reaches;
  // Sea mouths largest first, so the cap keeps the big deltas; then everything else in reach order.
  const order: number[] = [];
  let bestSea = -1;
  for (let r = 0; r < reaches; r++) {
    const m = gb.last(r);
    if (!(gb.flags[m] & RIVER.MOUTH_SEA) || gb.flags[m] & RIVER.DISTRIBUTARY) continue;
    if (gb.q[m] >= DELTA_MIN_Q) order.push(r);
    if (gb.q[m] >= GUARANTEE_MIN_Q && (bestSea < 0 || gb.q[m] > gb.q[gb.last(bestSea)])) bestSea = r;
  }
  order.sort((a, b) => gb.q[gb.last(b)] - gb.q[gb.last(a)] || a - b);
  const seaCount = order.length;
  for (let r = 0; r < reaches; r++) if (!(gb.flags[gb.last(r)] & RIVER.MOUTH_SEA)) order.push(r);
  // Research 05 §4 row 33: guarantee one delta at the largest mouth, even on a steep shelf (cuspate).
  if (bestSea >= 0) order.push(bestSea);
  let seaDeltas = 0;
  let estuaryAt = -1;
  for (let o = 0; o < order.length; o++) {
    const r = order[o];
    const forced = o === order.length - 1 && bestSea >= 0;
    if (forced && seaDeltas > 0) break;
    if (o < seaCount && seaDeltas >= inp.maxSea) continue;
    const m = gb.last(r);
    const f = gb.flags[m];
    const Q = gb.q[m];
    let mode: 'sea' | 'lake' | 'dry' | null = null;
    if (f & RIVER.MOUTH_SEA && (Q >= DELTA_MIN_Q || forced)) mode = 'sea';
    else if (f & RIVER.MOUTH_LAKE && f & RIVER.LAKE_TERMINAL && Q >= INLAND_LAKE_MIN_Q) mode = 'lake';
    else if (f & RIVER.SINK_DRY && !(f & RIVER.LAKE_TERMINAL)) {
      let peak = 0;
      for (let i = gb.reachStart[r]; i <= m; i++) peak = Math.max(peak, gb.q[i]);
      if (peak >= INLAND_DRY_MIN_Q) mode = 'dry';
    }
    if (!mode) continue;
    const mc = cellOfNode(m);

    let style: Style = 'wave';
    let extra = 0;
    if (mode === 'sea') {
      const R = Math.max(2, Math.ceil((SHELF_KM * 1000) / cellM));
      let ocean = 0;
      let shallow = 0;
      let total = 0;
      forWindow(grid, mc, R, (c) => {
        total++;
        if (!fixed[c] || h[c] > 0) return;
        ocean++;
        if (h[c] > -SHELF_DEPTH) shallow++;
      });
      const exposure = ocean / Math.max(1, total);
      const shelf = shallow / Math.max(1, ocean);
      const sR = 0.6 + 0.6 * Math.log10(Q / DELTA_MIN_Q);
      const sW = 3 * inp.waveEnergy * exposure;
      const sT = 2.5 * inp.tideRange * shelf;
      if (forced && shelf < 0.5) {
        style = 'wave';
      } else {
        if (shelf < 0.5) {
          if (sT > 0.6 * sR) {
            stats.estuaries++;
            if (r === bestSea) estuaryAt = r;
          }
          continue;
        }
        const e = [Math.exp(sR / 0.35), Math.exp(sW / 0.35), Math.exp(forced ? -Infinity : sT / 0.35)];
        const u = rng.float() * (e[0] + e[1] + e[2]);
        style = u < e[0] ? 'river' : u < e[0] + e[1] ? 'wave' : 'tide';
      }
      if (style === 'tide') {
        stats.estuaries++;
        if (r === bestSea) estuaryAt = r;
        continue;
      }
      if (forced && estuaryAt === r) stats.estuaries--;
      seaDeltas++;
      if (style === 'river') {
        extra = 2 + rng.int(4);
        stats.birdsFoot++;
      } else if (Q > 1000) {
        extra = 1 + rng.int(2);
        stats.arcuate++;
      } else {
        stats.cuspate++;
      }
    } else {
      extra = mode === 'lake' ? 2 : 3;
    }

    // Apex: R_d upstream of the mouth along the reach.
    const Rd = Math.min(40_000, 500 * Math.pow(Q, 0.4));
    let apex = m;
    let dist = 0;
    while (apex > gb.reachStart[r] && dist < Rd) {
      dist += sphere ? gb.dist(apex, apex - 1) : Math.hypot(gb.x[apex] - gb.x[apex - 1], gb.y[apex] - gb.y[apex - 1]);
      apex--;
    }
    if (apex === m) continue;
    gb.flags[apex] |= RIVER.DELTA;
    let ax = gb.x[apex];
    let ay = gb.y[apex];
    const az = gb.zWater[apex];
    let mxL = gb.x[m];
    let myL = gb.y[m];
    if (sphere) {
      A[0] = gb.x[apex];
      A[1] = gb.y[apex];
      A[2] = gb.w[apex];
      const r0 = Math.hypot(A[0], A[1], A[2]);
      for (let k = 0; k < 3; k++) U[k] = A[k] / r0;
      localFrame(U, E, Nn);
      const dx = gb.x[m] - A[0];
      const dy = gb.y[m] - A[1];
      const dw = gb.w[m] - A[2];
      ax = 0;
      ay = 0;
      mxL = dx * E[0] + dy * E[1] + dw * E[2];
      myL = dx * Nn[0] + dy * Nn[1] + dw * Nn[2];
    }
    for (let i = apex; i <= m; i++) plain[cellOfNode(i)] = 1;
    if (extra === 0) continue;

    let targetLake = -1;
    forWindow(grid, mc, 1, (c) => {
      targetLake = lakeId[c];
      return targetLake < 0;
    });
    const zEnd = mode === 'sea' ? 0 : gb.zWater[m];
    const dirX = mxL - ax;
    const dirY = myL - ay;
    const reachLen = Math.hypot(dirX, dirY) || 1;
    const base = Math.atan2(dirY, dirX);
    const spread = ((style === 'river' ? 55 : 35) * Math.PI) / 180;
    const paths: { xs: number[]; ys: number[]; zs: number[]; end: number }[] = [];
    for (let j = 0; j < extra; j++) {
      const side = j % 2 === 0 ? 1 : -1;
      const frac = (Math.floor(j / 2) + 1) / (Math.ceil(extra / 2) + 0.5);
      const ang = base + side * (0.3 + 0.7 * frac) * spread + rng.range(-0.1, 0.1);
      const len = reachLen * rng.range(0.9, 1.3);
      const bend = rng.range(-0.12, 0.12) * len;
      const ux = Math.cos(ang);
      const uy = Math.sin(ang);
      const xs: number[] = [];
      const ys: number[] = [];
      const zs: number[] = [];
      let end = 0;
      const steps = Math.ceil((1.6 * len) / inp.spacing);
      let z = az;
      for (let k = 1; k <= steps; k++) {
        const s = k * inp.spacing;
        const b = Math.sin(Math.min(1, s / len) * Math.PI) * bend;
        const x = ax + ux * s - uy * b;
        const y = ay + uy * s + ux * b;
        if (!sphere && (x < 0 || y < 0 || x >= mapM || y >= mapM)) break;
        const c = cellOfLocal(x, y);
        const target = mode === 'sea' ? fixed[c] === 1 && h[c] <= 0 : mode === 'lake' ? lakeId[c] === targetLake : s >= len;
        if (!target && (fixed[c] || lakeId[c] >= 0 || h[c] > az + 1)) break;
        z = Math.min(z, mode === 'dry' ? h[c] : az - (az - zEnd) * Math.min(1, s / len));
        xs.push(x);
        ys.push(y);
        zs.push(target ? Math.min(z, zEnd) : z);
        if (target) {
          end = mode === 'sea' ? RIVER.MOUTH_SEA : mode === 'lake' ? RIVER.MOUTH_LAKE | RIVER.LAKE_IN | RIVER.LAKE_TERMINAL : RIVER.SINK_DRY;
          break;
        }
      }
      if (end && xs.length >= 2) paths.push({ xs, ys, zs, end });
    }
    if (paths.length === 0) continue;
    if (mode !== 'sea') stats.inland++;
    const share = 1 / (paths.length + 1);
    const q = Q * share;
    const w = Math.max(1, WIDTH_COEF * Math.sqrt(q));
    const d = Math.max(0.1, DEPTH_COEF * Math.pow(q, 0.4));
    const st = gb.strahler[apex];
    const area = gb.area[apex];
    for (const p of paths) {
      gb.beginReach();
      if (sphere) gb.node(A[0], A[1], az, az - d, q, area, w, d, st, RIVER.DISTRIBUTARY | RIVER.DELTA, A[2]);
      else gb.node(ax, ay, az, az - d, q, area, w, d, st, RIVER.DISTRIBUTARY | RIVER.DELTA);
      for (let k = 0; k < p.xs.length; k++) {
        const last = k === p.xs.length - 1;
        const flags = RIVER.DISTRIBUTARY | (last ? p.end : 0);
        if (sphere) {
          toWorld(p.xs[k], p.ys[k]);
          gb.node(P[0], P[1], p.zs[k], p.zs[k] - d, q, area, w, d, st, flags, P[2]);
        } else gb.node(p.xs[k], p.ys[k], p.zs[k], p.zs[k] - d, q, area, w, d, st, flags);
        const c = cellOfLocal(p.xs[k], p.ys[k]);
        if (!fixed[c] && lakeId[c] < 0) plain[c] = 1;
      }
      stats.distributaries++;
    }
  }
  return stats;
}
