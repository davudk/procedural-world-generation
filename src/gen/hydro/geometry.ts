import { hashMix } from '../../shared/hash';
import { RIVER } from '../../shared/protocol';
import { cellIfOnMap, cellIndex, cellX, cellY, type Grid } from '../grid/grid';
import { smoothstep } from '../grid/ops';
import type { GraphBuilder } from './graph';
import { kinoshita, sinuosity, targetSinuosity, thetaForAmplitude, thetaForSinuosity, THETA_MAX } from './meander';
import { END, HEAD, type CellNetwork } from './network';

/** Hydraulic geometry (Leopold & Maddock 1953, research 02 §3.5): w = a·Q^0.5, d = c·Q^0.4. */
export const WIDTH_COEF = 4;
export const DEPTH_COEF = 0.35;
/** Knickpoint test (research 02 §4.5, adapted to the macro grid): drop per cell and slope contrast. */
const FALL_MIN_DROP = 25;
const FALL_MIN_SLOPE = 0.04;
const FALL_CONTRAST = 3;
const RAPIDS_SLOPE = 0.01;
/** Lateral search for the meander belt, in cells. */
const ROOM_MAX = 6;

export interface GeometryInput {
  grid: Grid;
  seed: number;
  /** Water surface used for routing (terrain, lakes at level). */
  S: Float32Array;
  h: Float32Array;
  fixed: Uint8Array;
  lakeId: Int32Array;
  lakeLevel: Float64Array;
  /** Per lake: 0 through-flow, 1 terminal, 2 playa. */
  lakeKind: Uint8Array;
  rcv: Int32Array;
  donStart: Int32Array;
  donList: Int32Array;
  q: Float64Array;
  area: Float64Array;
  aridity: Float32Array;
  temp: Float32Array;
  jx: Float32Array;
  jy: Float32Array;
  net: CellNetwork;
  /** σ_max of the meander model (1 = no meanders). */
  sigmaMax: number;
  /** Target node spacing along the channel (m). */
  spacing: number;
}

export interface CellChannel {
  width: Float32Array;
  depth: Float32Array;
  slope: Float32Array;
  fall: Uint8Array;
  /** Per-cell node flags (EPHEMERAL, BRAIDED, RAPIDS). */
  flags: Uint16Array;
}

/** Per channel cell: width, depth, smoothed slope, waterfall/rapids and climate flags. */
export function channelCells(g: GeometryInput): CellChannel {
  const { grid, S, rcv, q, aridity, temp, jx, jy, net, donStart, donList, area } = g;
  const { cells: N, cellM } = grid;
  const { chan, strahler } = net;
  const raw = new Float32Array(N);
  const dist = (a: number, b: number): number => {
    const dx = cellX(grid, b) - cellX(grid, a) + jx[b] - jx[a];
    const dy = cellY(grid, b) - cellY(grid, a) + jy[b] - jy[a];
    return Math.hypot(dx, dy) * cellM;
  };
  for (let i = 0; i < N; i++) {
    if (!chan[i] || rcv[i] === i) continue;
    raw[i] = Math.max(0, S[i] - S[rcv[i]]) / dist(i, rcv[i]);
  }
  const mainDonor = (i: number): number => {
    let best = -1;
    for (let d = donStart[i]; d < donStart[i + 1]; d++) {
      const j = donList[d];
      if (chan[j] && (best < 0 || area[j] > area[best])) best = j;
    }
    return best;
  };
  const width = new Float32Array(N);
  const depth = new Float32Array(N);
  const slope = new Float32Array(N);
  const fall = new Uint8Array(N);
  const flags = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    if (!chan[i]) continue;
    let sum = raw[i];
    let cnt = 1;
    let down = 0;
    let downN = 0;
    for (let c = rcv[i], k = 0; k < 3 && chan[c] && c !== rcv[c]; k++, c = rcv[c]) {
      sum += raw[c];
      cnt++;
      down += raw[c];
      downN++;
    }
    let up = 0;
    let upN = 0;
    for (let c = mainDonor(i), k = 0; k < 3 && c >= 0; k++, c = mainDonor(c)) {
      up += raw[c];
      upN++;
    }
    slope[i] = sum / cnt;
    const Q = Math.max(0, q[i]);
    const arid = aridity[i] > 2;
    let w = WIDTH_COEF * Math.sqrt(Q) * (arid ? 1.5 : 1);
    if (slope[i] > 0.02) w *= 0.4;
    width[i] = Math.max(1, w);
    depth[i] = Math.max(0.1, DEPTH_COEF * Math.pow(Q, 0.4));
    const context = (down + up) / Math.max(1, downN + upN);
    const drop = rcv[i] === i ? 0 : S[i] - S[rcv[i]];
    if (drop >= FALL_MIN_DROP && raw[i] >= FALL_MIN_SLOPE && raw[i] >= FALL_CONTRAST * context) fall[i] = 1;
    else if (raw[i] > RAPIDS_SLOPE && strahler[i] >= 2) flags[i] |= RIVER.RAPIDS;
    if (Q < 0.5 && arid) flags[i] |= RIVER.EPHEMERAL;
    const st = 0.01 * Math.pow(Math.max(Q, 1e-3), -0.44);
    if (Q > 5 && slope[i] > st && slope[i] < 0.03 && (aridity[i] > 1.5 || temp[i] < 0)) flags[i] |= RIVER.BRAIDED;
  }
  return { width, depth, slope, fall, flags };
}

/**
 * Lateral room for meanders per channel cell (m): distance across the flow to the valley wall
 * (terrain more than 2·depth above the water), to standing water or the sea, or half-way to another
 * reach (research 02 §4.2 "constrain to the floodplain").
 */
export function meanderRoom(g: GeometryInput, cc: CellChannel): Float32Array {
  const { grid, S, h, rcv, fixed, lakeId, net, jx, jy } = g;
  const { cells: N, cellM } = grid;
  const { chan, reachOfCell } = net;
  const room = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!chan[i]) continue;
    const r = rcv[i];
    const x = cellX(grid, i);
    const y = cellY(grid, i);
    let dx = 1;
    let dy = 0;
    if (r !== i) {
      dx = cellX(grid, r) - x + jx[r] - jx[i];
      dy = cellY(grid, r) - y + jy[r] - jy[i];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
    }
    const wall = S[i] + Math.max(2 * cc.depth[i], 3);
    let best = ROOM_MAX;
    for (const side of [-1, 1]) {
      for (let k = 1; k < best; k++) {
        const j = cellIfOnMap(grid, Math.round(x - side * k * dy), Math.round(y + side * k * dx));
        if (j < 0) {
          best = Math.min(best, k - 0.5);
          break;
        }
        if (j === i) continue;
        if (fixed[j] || lakeId[j] >= 0) {
          best = Math.min(best, k - 1);
          break;
        }
        if (h[j] > wall) {
          best = Math.min(best, k - 0.6);
          break;
        }
        if (chan[j] && reachOfCell[j] !== reachOfCell[i]) {
          best = Math.min(best, k / 2 - 0.1);
          break;
        }
      }
    }
    room[i] = Math.max(0, best) * cellM;
  }
  return room;
}

interface Axis {
  x: number[];
  y: number[];
  t: number[];
  cum: number[];
}

/** Chaikin corner cutting (2 passes, endpoints fixed); `t` is carried as the control parameter. */
function chaikin(px: number[], py: number[], passes: number): Axis {
  let x = px;
  let y = py;
  let t = px.map((_, i) => i);
  for (let p = 0; p < passes && x.length > 2; p++) {
    const nx = [x[0]];
    const ny = [y[0]];
    const nt = [t[0]];
    for (let i = 0; i < x.length - 1; i++) {
      nx.push(0.75 * x[i] + 0.25 * x[i + 1], 0.25 * x[i] + 0.75 * x[i + 1]);
      ny.push(0.75 * y[i] + 0.25 * y[i + 1], 0.25 * y[i] + 0.75 * y[i + 1]);
      nt.push(0.75 * t[i] + 0.25 * t[i + 1], 0.25 * t[i] + 0.75 * t[i + 1]);
    }
    nx.push(x[x.length - 1]);
    ny.push(y[y.length - 1]);
    nt.push(t[t.length - 1]);
    x = nx;
    y = ny;
    t = nt;
  }
  const cum = [0];
  for (let i = 1; i < x.length; i++) cum.push(cum[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]));
  return { x, y, t, cum };
}

/** Position, unit tangent and control parameter at arclength u along the axis. */
function evalAxis(a: Axis, u: number, out: Float64Array): void {
  const { x, y, t, cum } = a;
  const m = x.length;
  if (m === 1) {
    out[0] = x[0];
    out[1] = y[0];
    out[2] = 1;
    out[3] = 0;
    out[4] = t[0];
    return;
  }
  const L = cum[m - 1];
  const v = Math.min(L, Math.max(0, u));
  let lo = 0;
  let hi = m - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= v) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const f = (v - cum[lo]) / seg;
  const dx = x[hi] - x[lo];
  const dy = y[hi] - y[lo];
  const l = Math.hypot(dx, dy) || 1;
  out[0] = x[lo] + dx * f;
  out[1] = y[lo] + dy * f;
  out[2] = dx / l;
  out[3] = dy / l;
  out[4] = t[lo] + (t[hi] - t[lo]) * f;
}

export interface RiverBuild {
  /** First node of each cell-level reach (graph reach r = cell reach r). */
  firstNode: Int32Array;
  /** Node where each lake's outflow starts (−1 if none), by lake index. */
  outletNode: Int32Array;
}

/**
 * Builds the river graph from the cell network (research 02 §4.1–4.5): Chaikin-smoothed axis through
 * the jittered nodes, Kinoshita meanders on low slopes clamped to the meander room, resampling at
 * `spacing`, water surface interpolated along the axis with steps at waterfalls, then a running
 * minimum so zWater and zBed never increase downstream.
 */
export function buildRivers(g: GeometryInput, cc: CellChannel, room: Float32Array, lakeCount: number, gb: GraphBuilder): RiverBuild {
  const { grid, S, h, fixed, lakeId, lakeLevel, rcv, q, area, jx, jy, net, spacing, sigmaMax, seed } = g;
  const { n, cellM } = grid;
  const { strahler } = net;
  const nr = net.start.length;
  const posX = (c: number): number => (cellX(grid, c) + 0.5 + jx[c]) * cellM;
  const posY = (c: number): number => (cellY(grid, c) + 0.5 + jy[c]) * cellM;
  const firstNode = new Int32Array(nr).fill(-1);
  const outletNode = new Int32Array(lakeCount).fill(-1);
  const outletQ = new Float64Array(lakeCount).fill(-1);
  const ev = new Float64Array(5);
  const wetCell = (x: number, y: number): boolean => {
    const cx = Math.min(n - 1, Math.max(0, Math.floor(x / cellM)));
    const cy = Math.min(n - 1, Math.max(0, Math.floor(y / cellM)));
    const c = cellIndex(grid, cx, cy);
    return fixed[c] === 1 || lakeId[c] >= 0;
  };

  for (let r = 0; r < nr; r++) {
    const cells = net.cells.subarray(net.start[r], net.start[r] + net.len[r]);
    const last = cells[cells.length - 1];
    const px: number[] = [];
    const py: number[] = [];
    const pz: number[] = [];
    const pc: number[] = [];
    const fromLake = net.fromLakeCell[r];
    if (net.head[r] === HEAD.LAKE_OUT && fromLake >= 0) {
      px.push(0.5 * (posX(fromLake) + posX(cells[0])));
      py.push(0.5 * (posY(fromLake) + posY(cells[0])));
      pz.push(Math.max(S[cells[0]], lakeLevel[lakeId[fromLake]]));
      pc.push(cells[0]);
    }
    for (const c of cells) {
      px.push(posX(c));
      py.push(posY(c));
      pz.push(S[c]);
      pc.push(c);
    }
    const end = net.end[r];
    const tgt = rcv[last];
    let emitEnd = true;
    if (end === END.CONFLUENCE) {
      px.push(posX(tgt));
      py.push(posY(tgt));
      pz.push(S[tgt]);
      pc.push(last);
      emitEnd = false;
    } else if (end !== END.DRY) {
      px.push(0.5 * (posX(last) + posX(tgt)));
      py.push(0.5 * (posY(last) + posY(tgt)));
      const level = end === END.SEA ? (h[tgt] <= 0 ? 0 : h[tgt]) : end === END.PLAYA ? S[tgt] : lakeLevel[lakeId[tgt]];
      pz.push(Math.min(S[last], level));
      pc.push(last);
    }
    for (let k = 1; k < pz.length; k++) pz[k] = Math.min(pz[k], pz[k - 1]);

    const axis = chaikin(px, py, 2);
    const L = axis.cum[axis.cum.length - 1];
    const nctrl = pz.length;
    const cellOf = (t: number): number => pc[Math.min(nctrl - 1, Math.max(0, Math.floor(t)))];
    const zAt = (t: number): number => {
      if (nctrl === 1) return pz[0];
      const k = Math.min(nctrl - 2, Math.max(0, Math.floor(t)));
      const f = Math.min(1, Math.max(0, t - k));
      if (cc.fall[pc[k]] && pc[k] !== pc[k + 1]) return f < 0.5 ? pz[k] : pz[k + 1];
      return pz[k] + (pz[k + 1] - pz[k]) * f;
    };

    // Node positions as axis arclength plus a lateral (meander) offset.
    const nodeU: number[] = [];
    const nodeLat: number[] = [];
    let meandering = false;
    if (sigmaMax > 1 && L > 4 * spacing) {
      for (const c of cells) if (targetSinuosity(cc.slope[c], q[c], sigmaMax) > 1.05) meandering = true;
    }
    if (!meandering) {
      const cnt = Math.max(1, Math.round(L / spacing));
      const top = emitEnd ? cnt : cnt - 1;
      for (let k = 0; k <= top; k++) {
        nodeU.push((k * L) / cnt);
        nodeLat.push(0);
      }
      if (L === 0) {
        nodeU.length = 1;
        nodeLat.length = 1;
      }
    } else {
      const ds = spacing / 4;
      const X: number[] = [0];
      const Y: number[] = [0];
      const lam: number[] = [];
      const lamV: number[] = [];
      const amp: number[] = [];
      let x = 0;
      let y = 0;
      let phi = ((hashMix(seed, cells[0]) & 0xffff) / 65536) * 2 * Math.PI;
      const limit = Math.ceil((L / ds) * 8) + 16;
      while (x < L && X.length < limit) {
        evalAxis(axis, x, ev);
        const c = cellOf(ev[4]);
        const lv = Math.max(11 * cc.width[c], 7 * spacing);
        const win = smoothstep(0, lv, x) * smoothstep(0, lv, L - x);
        const a = room[c];
        const th0 = Math.min(THETA_MAX, thetaForSinuosity(targetSinuosity(cc.slope[c], q[c], sigmaMax)), thetaForAmplitude(a * Math.max(win, 0.05), lv));
        const lamS = sinuosity(th0) * lv;
        const th = kinoshita(th0, phi);
        x += Math.cos(th) * ds;
        y += Math.sin(th) * ds;
        phi += (2 * Math.PI * ds) / lamS;
        X.push(x);
        Y.push(y);
        lam.push(lamS);
        lamV.push(lv);
        amp.push(a);
      }
      lam.push(lam[lam.length - 1] ?? spacing);
      lamV.push(lamV[lamV.length - 1] ?? spacing);
      amp.push(amp[amp.length - 1] ?? 0);
      // Centre the curve on the axis (remove drift over one wavelength), taper to zero at the ends.
      const m = X.length;
      const pre = new Float64Array(m + 1);
      for (let j = 0; j < m; j++) pre[j + 1] = pre[j] + Y[j];
      for (let j = 0; j < m; j += 4) {
        const u = Math.min(L, Math.max(0, X[j]));
        if (u >= L - 0.5 * spacing) break;
        const half = Math.max(1, Math.round(lam[j] / (2 * ds)));
        const a = Math.max(0, j - half);
        const b = Math.min(m - 1, j + half);
        const mean = (pre[b + 1] - pre[a]) / (b - a + 1);
        const win = smoothstep(0, lamV[j], u) * smoothstep(0, lamV[j], L - u);
        const lat = Math.max(-amp[j], Math.min(amp[j], (Y[j] - mean) * win));
        nodeU.push(u);
        nodeLat.push(lat);
      }
      if (emitEnd) {
        nodeU.push(L);
        nodeLat.push(0);
      }
    }

    gb.beginReach();
    firstNode[r] = gb.size;
    let uz = 0;
    let prevZ = Infinity;
    let prevT = -1;
    let prevNode = -1;
    for (let k = 0; k < nodeU.length; k++) {
      evalAxis(axis, nodeU[k], ev);
      let x = ev[0] - ev[3] * nodeLat[k];
      let y = ev[1] + ev[2] * nodeLat[k];
      const t = ev[4];
      const c = cellOf(t);
      uz = Math.max(uz, nodeU[k]);
      evalAxis(axis, uz, ev);
      const tz = ev[4];
      const zw = Math.min(prevZ, zAt(tz));
      prevZ = zw;
      const isFirst = k === 0;
      const isLast = k === nodeU.length - 1;
      let flags = cc.flags[c];
      if (isFirst) flags |= net.head[r] === HEAD.LAKE_OUT ? RIVER.LAKE_OUT : net.head[r] === HEAD.CONFLUENCE ? RIVER.CONFLUENCE : RIVER.SOURCE;
      if (isLast && emitEnd) {
        if (end === END.SEA) flags |= RIVER.MOUTH_SEA;
        else if (end === END.LAKE) flags |= RIVER.MOUTH_LAKE | RIVER.LAKE_IN;
        else if (end === END.LAKE_TERMINAL) flags |= RIVER.MOUTH_LAKE | RIVER.LAKE_IN | RIVER.LAKE_TERMINAL;
        else if (end === END.PLAYA) flags |= RIVER.SINK_DRY | RIVER.LAKE_TERMINAL;
        else flags |= RIVER.SINK_DRY;
      }
      const exempt = (isLast && emitEnd && end !== END.DRY) || (isFirst && net.head[r] === HEAD.LAKE_OUT);
      if (!exempt && wetCell(x, y)) {
        // Back onto the valley axis, and if that is still wet, toward the channel cell itself.
        evalAxis(axis, nodeU[k], ev);
        x = ev[0];
        y = ev[1];
        const cx = posX(c);
        const cy = posY(c);
        for (const f of [0, 0.25, 0.5, 0.75, 1]) {
          const tx = x + (cx - x) * f;
          const ty = y + (cy - y) * f;
          if (!wetCell(tx, ty) || f === 1) {
            x = tx;
            y = ty;
            break;
          }
        }
      }
      // Waterfall lip: this node is the last before the middle of a falling segment.
      if (prevNode >= 0 && prevT >= 0) {
        const k0 = Math.floor(prevT);
        if (k0 < nctrl - 1 && cc.fall[pc[k0]] && pc[k0] !== pc[k0 + 1] && prevT - k0 < 0.5 && tz >= k0 + 0.5) gb.flags[prevNode] |= RIVER.WATERFALL;
      }
      const Q = Math.max(0, q[c]);
      const node = gb.node(x, y, zw, zw - cc.depth[c], Q, area[c], cc.width[c], cc.depth[c], strahler[c], flags);
      prevNode = node;
      prevT = tz;
    }
    if (!emitEnd && prevNode >= 0) {
      const k0 = Math.floor(prevT);
      if (k0 < nctrl - 1 && cc.fall[pc[k0]] && prevT - k0 < 0.5) gb.flags[prevNode] |= RIVER.WATERFALL;
    }
  }
  // Link each reach's last node to the first node of its downstream reach.
  for (let r = 0; r < nr; r++) {
    const d = net.down[r];
    if (d < 0) continue;
    gb.reachDown[r] = d;
    gb.down[gb.last(r)] = firstNode[d];
  }

  for (const { from, to } of net.exits) {
    const l = lakeId[from];
    if (!net.chan[to] || q[to] <= outletQ[l]) continue;
    outletQ[l] = q[to];
    outletNode[l] = firstNode[net.reachOfCell[to]];
  }

  // Lake-to-lake / lake-to-sea straits.
  for (const { from, to } of net.connectors) {
    const l = lakeId[from];
    const level = lakeLevel[l];
    const toLevel = fixed[to] ? Math.min(level, h[to] <= 0 ? 0 : h[to]) : Math.min(level, lakeLevel[lakeId[to]]);
    const Q = Math.max(0, q[from]);
    const w = Math.max(1, WIDTH_COEF * Math.sqrt(Q));
    const d = Math.max(0.1, DEPTH_COEF * Math.pow(Q, 0.4));
    gb.beginReach();
    const first = gb.node(posX(from), posY(from), level, level - d, Q, area[from], w, d, 1, RIVER.LAKE_OUT);
    const endFlags = fixed[to] ? RIVER.MOUTH_SEA : RIVER.MOUTH_LAKE | RIVER.LAKE_IN | (g.lakeKind[lakeId[to]] === 0 ? 0 : RIVER.LAKE_TERMINAL);
    gb.node(posX(to), posY(to), toLevel, toLevel - d, Q, area[from], w, d, 1, endFlags);
    if (Q > outletQ[l]) {
      outletQ[l] = Q;
      outletNode[l] = first;
    }
  }
  return { firstNode, outletNode };
}

/** Running minimum of zWater and zBed along `down` (nodes are stored upstream-first). */
export function enforceMonotone(gb: GraphBuilder): void {
  const { down, zWater, zBed } = gb;
  for (let i = 0; i < down.length; i++) {
    const d = down[i];
    if (d < 0) continue;
    if (d <= i) throw new Error(`river graph: node ${i} drains to earlier node ${d}`);
    if (zWater[d] > zWater[i]) zWater[d] = zWater[i];
    if (zBed[d] > zBed[i]) zBed[d] = zBed[i];
  }
}
