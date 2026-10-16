import { hashMix } from '../../shared/hash';
import type { Grid } from '../grid/grid';
import { DX, DY } from './grid8';

/** Jitter amplitude of routing nodes, in cells (research 02 §2.2). */
export const ROUTING_JITTER = 0.7;

/** Fixed sub-cell offset of each routing node (cells, in [−J/2, J/2]). */
export function jitter(g: Grid, seed: number): { jx: Float32Array; jy: Float32Array } {
  const N = g.cells;
  const jx = new Float32Array(N);
  const jy = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = hashMix(seed, i);
    jx[i] = ROUTING_JITTER * ((r & 0xffff) / 65536 - 0.5);
    jy[i] = ROUTING_JITTER * ((r >>> 16) / 65536 - 0.5);
  }
  return { jx, jy };
}

export interface Routing {
  /** Receiver per cell; self for roots (fixed cells, terminal lakes, dry sinks). */
  rcv: Int32Array;
  /** Receivers before donors; the first `stackLen` entries cover every cell. */
  stack: Int32Array;
  donStart: Int32Array;
  donList: Int32Array;
}

/**
 * Single-receiver routing on the water surface `S` (terrain, lakes flat at their level): steepest
 * descent between jittered nodes where a strictly lower neighbour exists, otherwise a breadth-first
 * walk across the flat toward its exits (lakes drain to their outlet this way). `roots` marks cells
 * that keep themselves as receiver (terminal-lake bottoms); unresolvable minima also become roots.
 */
export function route(S: Float32Array, g: Grid, fixed: Uint8Array, roots: Uint8Array, jx: Float32Array, jy: Float32Array, crossKey: Float32Array): Routing {
  const { cells: N, off8: off, border } = g;
  const rcv = new Int32Array(N).fill(-1);
  const dxs = Float64Array.from(DX);
  const dys = Float64Array.from(DY);
  for (let i = 0; i < N; i++) {
    if (fixed[i] || roots[i]) {
      rcv[i] = i;
      continue;
    }
    const b = border[i];
    const zi = S[i];
    const jxi = jx[i];
    const jyi = jy[i];
    let best = -1;
    let bestS = 0;
    for (let k = 0; k < 8; k++) {
      let j: number;
      if (b === 0) j = i + off[k];
      else if ((j = g.nbr(i, k)) < 0) continue;
      const dz = zi - S[j];
      if (dz <= 0) continue;
      const ddx = dxs[k] + jx[j] - jxi;
      const ddy = dys[k] + jy[j] - jyi;
      const s2 = (dz * dz) / (ddx * ddx + ddy * ddy);
      if (s2 > bestS) {
        bestS = s2;
        best = j;
      }
    }
    rcv[i] = best;
  }
  uncross(S, g, rcv, crossKey);

  // Flats: breadth-first from resolved cells into unresolved cells of equal height.
  const queue = new Int32Array(N);
  let qt = 0;
  const seen = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (rcv[i] >= 0) continue;
    const b = border[i];
    for (let k = 0; k < 8; k++) {
      let j: number;
      if (b === 0) j = i + off[k];
      else if ((j = g.nbr(i, k)) < 0) continue;
      if (rcv[j] >= 0 && !seen[j] && S[j] === S[i]) {
        seen[j] = 1;
        queue[qt++] = j;
      }
    }
  }
  for (let qh = 0; qh < qt; qh++) {
    const c = queue[qh];
    const b = border[c];
    for (let k = 0; k < 8; k++) {
      let j: number;
      if (b === 0) j = c + off[k];
      else if ((j = g.nbr(c, k)) < 0) continue;
      if (rcv[j] < 0 && S[j] === S[c]) {
        rcv[j] = c;
        queue[qt++] = j;
      }
    }
  }
  for (let i = 0; i < N; i++) if (rcv[i] < 0) rcv[i] = i;

  // Donor CSR and the receiver-before-donor stack.
  const donStart = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) if (rcv[i] !== i) donStart[rcv[i] + 1]++;
  for (let i = 0; i < N; i++) donStart[i + 1] += donStart[i];
  const fill = donStart.slice(0, N);
  const donList = new Int32Array(Math.max(1, donStart[N]));
  for (let i = 0; i < N; i++) if (rcv[i] !== i) donList[fill[rcv[i]]++] = i;
  const stack = new Int32Array(N);
  let top = 0;
  for (let r = 0; r < N; r++) {
    if (rcv[r] !== r) continue;
    stack[top++] = r;
    for (let k = top - 1; k < top; k++) {
      const c = stack[k];
      for (let d = donStart[c], end = donStart[c + 1]; d < end; d++) stack[top++] = donList[d];
    }
  }
  if (top !== N) throw new Error(`hydro routing: stack covers ${top} of ${N} cells (cycle)`);
  return { rcv, stack, donStart, donList };
}

/** Raster k of the east, south-east and south neighbours: the 2×2 block whose north-west cell is i. */
const K_E = 4;
const K_SE = 7;
const K_S = 6;

/**
 * Removes crossing diagonal receivers in every 2×2 block (research 02 §2.2 step 4): the cell with
 * the smaller `key` (a drainage-area proxy) moves to its best strictly lower orthogonal neighbour
 * (E W S N, first wins). Blocks are visited by their north-west cell in index order.
 */
function uncross(S: Float32Array, g: Grid, rcv: Int32Array, key: Float32Array): void {
  const { cells: N, off8: off, off4, axialToRaster, border } = g;
  const reroute = (i: number): void => {
    let best = -1;
    let bestDz = 0;
    for (let k = 0; k < 4; k++) {
      let j: number;
      if (border[i] === 0) j = i + off4[k];
      else if ((j = g.nbr(i, axialToRaster[k])) < 0) continue;
      const dz = S[i] - S[j];
      if (dz > bestDz) {
        bestDz = dz;
        best = j;
      }
    }
    if (best >= 0) rcv[i] = best;
  };
  const oE = off[K_E];
  const oS = off[K_S];
  const oSE = off[K_SE];
  for (let a = 0; a < N; a++) {
    let b: number;
    let c: number;
    let d: number;
    if (border[a] === 0) {
      b = a + oE;
      c = a + oS;
      d = a + oSE;
    } else if ((b = g.nbr(a, K_E)) < 0 || (c = g.nbr(a, K_S)) < 0 || (d = g.nbr(a, K_SE)) < 0) {
      continue;
    }
    const diagA = rcv[a] === d || rcv[d] === a;
    const diagB = rcv[b] === c || rcv[c] === b;
    if (!diagA || !diagB) continue;
    const pa = rcv[a] === d ? a : d;
    const pb = rcv[b] === c ? b : c;
    reroute(key[pa] < key[pb] ? pa : pb);
  }
}

export interface Accumulation {
  /** Drainage area (km²). */
  area: Float64Array;
  /** Mean annual discharge (m³/s). */
  q: Float64Array;
  /** Total water lost in arid channels (m³/s). */
  aridLoss: number;
}

/**
 * Drainage area and discharge in one reverse-stack sweep (Braun & Willett 2013). `yieldM3s` is each
 * cell's own contribution (runoff, or runoff − lake evaporation under water: may be negative inside
 * lakes, which only clamp to ≥ 0 where the water leaves them). Channel cells in arid climate lose
 * `aridLossRate` (m/yr) times their width and length (research 02 §5.4).
 */
export function accumulate(
  R: Routing,
  cellKm2: number,
  cellM: number,
  yieldM3s: Float64Array,
  inLake: Uint8Array,
  channelAreaKm2: number,
  aridLossRate: Float32Array,
  widthCoef: number,
): Accumulation {
  const { rcv, stack } = R;
  const N = rcv.length;
  const area = new Float64Array(N);
  const q = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    q[i] = yieldM3s[i];
    area[i] = cellKm2;
  }
  let aridLoss = 0;
  const perSecond = cellM / 3.156e7;
  for (let k = N - 1; k >= 0; k--) {
    const i = stack[k];
    const r = rcv[i];
    if (!inLake[i]) {
      if (q[i] < 0) q[i] = 0;
      if (area[i] >= channelAreaKm2 && aridLossRate[i] > 0 && q[i] > 0) {
        const l = Math.min(q[i], aridLossRate[i] * widthCoef * Math.sqrt(q[i]) * perSecond);
        q[i] -= l;
        aridLoss += l;
      }
    }
    if (r !== i) {
      area[r] += area[i];
      q[r] += q[i];
    }
  }
  return { area, q, aridLoss };
}
