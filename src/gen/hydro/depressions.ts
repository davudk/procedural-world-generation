import type { Grid } from '../grid/grid';
import { INV_DIST } from './grid8';

/**
 * Depression hierarchy (Barnes, Callaghan & Wickert 2020) and its leaves-first water balance
 * (Fill–Spill–Merge, 2021) on the macro grid (research 02 §1.3–1.4).
 *
 * Leaves are the pits (local minima, flat minima merged), each with its D8 watershed. Two
 * watersheds meet at saddles; Kruskal over the saddles (lowest first) merges siblings into
 * meta-depressions until each tree reaches the ocean (node 0).
 */

export interface DepNode {
  /** Children (−1 for leaves). */
  a: number;
  b: number;
  /** Parent meta-depression, −1 for the top of a tree (which spills to another tree or the sea). */
  parent: number;
  /** Lowest level of the node's own band: the pit for a leaf, the merge saddle for a meta node. */
  base: number;
  /** Level at which it overflows (Infinity if it never can). */
  spill: number;
  /** Saddle cell on this side, and the cell across it. */
  spillCell: number;
  spillOut: number;
  /** Leaf that receives the overflow (0 = the sea). */
  spillTo: number;
  /** A bottom cell (leaves). */
  pit: number;
  /** Order in which a tree reached the sea (top nodes only); overflow always goes to an earlier tree. */
  attach: number;
}

export interface Hierarchy {
  nodes: DepNode[];
  /** Leaf id per cell (0 on fixed cells). */
  label: Int32Array;
  leafCount: number;
  /** Top nodes in attach order. */
  tops: number[];
  /** Post-order of all nodes; subtree of d = post[lo[d] .. pos[d]]. */
  post: Int32Array;
  lo: Int32Array;
  pos: Int32Array;
  /** Cells of each node's own band (h in [base, spill)), sorted by h: bandCells[bandStart[d] .. bandStart[d+1]). */
  bandStart: Int32Array;
  bandCells: Int32Array;
}

/** A playa covers at least the basin floor where evaporation reaches this share of the full-basin value. */
const PLAYA_FLOOR = 0.25;

/** Raster k of the forward neighbours E, SW, S, SE: each cell pair is visited once, from its earlier cell. */
const FORWARD = [4, 5, 6, 7] as const;

export function buildHierarchy(h: Float32Array, g: Grid, fixed: Uint8Array): Hierarchy {
  const { cells: N, off8: off, border } = g;
  const label = new Int32Array(N).fill(-1);
  const down = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    if (fixed[i]) {
      label[i] = 0;
      continue;
    }
    const b = border[i];
    let best = -1;
    let bestS = 0;
    for (let k = 0; k < 8; k++) {
      let j: number;
      if (b === 0) j = i + off[k];
      else if ((j = g.nbr(i, k)) < 0) continue;
      const s = (h[i] - h[j]) * INV_DIST[k];
      if (s > bestS) {
        bestS = s;
        best = j;
      }
    }
    down[i] = best;
  }

  const nodes: DepNode[] = [leafNode(-1, -Infinity)];
  const queue = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    if (label[i] >= 0 || down[i] >= 0) continue;
    const id = nodes.length;
    nodes.push(leafNode(i, h[i]));
    let qh = 0;
    let qt = 0;
    queue[qt++] = i;
    label[i] = id;
    while (qh < qt) {
      const c = queue[qh++];
      const b = border[c];
      for (let k = 0; k < 8; k++) {
        let j: number;
        if (b === 0) j = c + off[k];
        else if ((j = g.nbr(c, k)) < 0) continue;
        if (label[j] < 0 && down[j] < 0 && h[j] === h[i]) {
          label[j] = id;
          queue[qt++] = j;
        }
      }
    }
  }
  const leafCount = nodes.length - 1;
  for (let i = 0; i < N; i++) {
    if (label[i] >= 0) continue;
    let len = 0;
    let c = i;
    while (label[c] < 0) {
      queue[len++] = c;
      c = down[c];
    }
    const l = label[c];
    for (let k = 0; k < len; k++) label[queue[k]] = l;
  }

  // Saddles: lowest max(h) over the cell pairs joining two watersheds.
  const keyMul = nodes.length;
  const edgeOf = new Map<number, number>();
  const ea: number[] = [];
  const eb: number[] = [];
  const es: number[] = [];
  const eca: number[] = [];
  const ecb: number[] = [];
  const pair = (i: number, j: number): void => {
    const li = label[i];
    const lj = label[j];
    if (li === lj) return;
    const s = h[i] > h[j] ? h[i] : h[j];
    const swap = li > lj;
    const la = swap ? lj : li;
    const key = la * keyMul + (swap ? li : lj);
    const e = edgeOf.get(key);
    if (e === undefined) {
      edgeOf.set(key, ea.length);
      ea.push(la);
      eb.push(swap ? li : lj);
      es.push(s);
      eca.push(swap ? j : i);
      ecb.push(swap ? i : j);
    } else if (s < es[e]) {
      es[e] = s;
      eca[e] = swap ? j : i;
      ecb[e] = swap ? i : j;
    }
  };
  for (let i = 0; i < N; i++) {
    if (border[i] === 0) {
      for (const k of FORWARD) pair(i, i + off[k]);
    } else {
      for (const k of FORWARD) {
        const j = g.nbr(i, k);
        if (j >= 0) pair(i, j);
      }
    }
  }
  const order = Array.from(ea, (_, e) => e).sort((p, q) => es[p] - es[q] || ea[p] - ea[q] || eb[p] - eb[q]);

  const uf: number[] = nodes.map((_, i) => i);
  const find = (x: number): number => {
    while (uf[x] !== x) {
      uf[x] = uf[uf[x]];
      x = uf[x];
    }
    return x;
  };
  const tops: number[] = [];
  for (const e of order) {
    const a = ea[e];
    const b = eb[e];
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    const s = es[e];
    if (ra === 0 || rb === 0) {
      const r = ra === 0 ? rb : ra;
      const nd = nodes[r];
      nd.spill = s;
      nd.spillCell = ra === 0 ? ecb[e] : eca[e];
      nd.spillOut = ra === 0 ? eca[e] : ecb[e];
      nd.spillTo = ra === 0 ? a : b;
      nd.attach = tops.length;
      tops.push(r);
      uf[r] = 0;
    } else {
      const m = nodes.length;
      nodes.push({ a: ra, b: rb, parent: -1, base: s, spill: Infinity, spillCell: -1, spillOut: -1, spillTo: 0, pit: -1, attach: -1 });
      uf.push(m);
      Object.assign(nodes[ra], { spill: s, spillCell: eca[e], spillOut: ecb[e], spillTo: b, parent: m });
      Object.assign(nodes[rb], { spill: s, spillCell: ecb[e], spillOut: eca[e], spillTo: a, parent: m });
      uf[ra] = m;
      uf[rb] = m;
    }
  }
  // Trees that never reach the sea (a landlocked world) never overflow.
  for (let d = 1; d < nodes.length; d++) {
    if (nodes[d].parent < 0 && nodes[d].attach < 0) {
      nodes[d].attach = tops.length;
      tops.push(d);
    }
  }

  const M = nodes.length;
  const post = new Int32Array(M);
  const lo = new Int32Array(M);
  const pos = new Int32Array(M);
  let pc = 0;
  const stack: number[] = [];
  for (const t of tops) {
    stack.push(t, 0);
    while (stack.length > 0) {
      const state = stack.pop()!;
      const d = stack.pop()!;
      const nd = nodes[d];
      if (state === 0) {
        lo[d] = pc;
        stack.push(d, 1);
        if (nd.a >= 0) stack.push(nd.b, 0, nd.a, 0);
      } else {
        pos[d] = pc;
        post[pc++] = d;
      }
    }
  }

  // Each depression cell belongs to the band of the lowest node whose spill is above it.
  const owner = new Int32Array(N).fill(-1);
  const bandStart = new Int32Array(M + 1);
  for (let c = 0; c < N; c++) {
    let d = label[c];
    if (d < 1) continue;
    const hc = h[c];
    while (d >= 0 && !(hc < nodes[d].spill)) d = nodes[d].parent;
    if (d < 0) continue;
    owner[c] = d;
    bandStart[d + 1]++;
  }
  for (let d = 0; d < M; d++) bandStart[d + 1] += bandStart[d];
  const fillPos = bandStart.slice(0, M);
  const bandCells = new Int32Array(bandStart[M]);
  for (let c = 0; c < N; c++) if (owner[c] >= 0) bandCells[fillPos[owner[c]]++] = c;
  for (let d = 1; d < M; d++) {
    if (bandStart[d + 1] - bandStart[d] > 1) bandCells.subarray(bandStart[d], bandStart[d + 1]).sort((p, q) => h[p] - h[q] || p - q);
  }

  return { nodes, label, leafCount, tops, post, lo, pos, bandStart, bandCells };
}

function leafNode(pit: number, base: number): DepNode {
  return { a: -1, b: -1, parent: -1, base, spill: Infinity, spillCell: -1, spillOut: -1, spillTo: 0, pit, attach: -1 };
}

export type LakeKind = 'through' | 'terminal' | 'playa';

export interface LakeBody {
  node: number;
  kind: LakeKind;
  /** Water surface (m, float32-exact): the spill level for through-flow lakes. */
  level: number;
  /** Cells under water (for a playa: the dry pan). */
  cells: Int32Array;
  /** Cells the lake would cover at its spill level. */
  cellsAtSpill: number;
  bottom: number;
  /** Mean annual inflow and outflow (m³/yr). */
  inflow: number;
  outflow: number;
}

export interface Balance {
  lakes: LakeBody[];
  /** Overflow of each top node (m³/yr) that leaves the hierarchy into the sea. */
  toSea: number;
}

/**
 * Leaves-first water balance on the hierarchy (research 02 §1.4). A node whose inflow exceeds its
 * evaporation at the spill level is full (through-flow lake at the spill, excess passed on); a meta
 * node whose children are both full is one merged lake; otherwise the lake stands at the level where
 * evaporation balances inflow. Whether a node is full depends only on its total inflow, so the
 * hierarchy can be solved top-down, passing a full child's overflow to its sibling's spill leaf.
 *
 * `runoff` and `loss` are per cell in m³/yr; a cell under water yields runoff − loss.
 */
export function waterBalance(H: Hierarchy, h: Float32Array, runoff: Float64Array, loss: Float64Array): Balance {
  const { nodes, label, post, lo, pos, bandStart, bandCells, tops } = H;
  const M = nodes.length;
  const own = new Float64Array(M);
  for (let c = 0; c < label.length; c++) if (label[c] > 0) own[label[c]] += runoff[c];
  const bandLoss = new Float64Array(bandCells.length);
  const fullLoss = new Float64Array(M);
  const childFull = new Float64Array(M);
  const spillCells = new Int32Array(M);
  for (let p = 0; p < M; p++) {
    const d = post[p];
    if (d === 0) continue;
    const nd = nodes[d];
    let acc = 0;
    for (let k = bandStart[d]; k < bandStart[d + 1]; k++) {
      acc += loss[bandCells[k]];
      bandLoss[k] = acc;
    }
    if (nd.a >= 0) {
      own[d] = own[nd.a] + own[nd.b];
      childFull[d] = fullLoss[nd.a] + fullLoss[nd.b];
      spillCells[d] = spillCells[nd.a] + spillCells[nd.b];
    }
    fullLoss[d] = childFull[d] + acc;
    spillCells[d] += bandStart[d + 1] - bandStart[d];
  }
  const inSubtree = (leaf: number, d: number): boolean => pos[leaf] >= lo[d] && pos[leaf] <= pos[d];
  const bandHeight = (d: number, m: number): number => h[bandCells[bandStart[d] + m]];

  /** Level where evaporation over the node's water equals `total` (node not full). */
  const levelFor = (d: number, total: number): number => {
    const s0 = bandStart[d];
    const len = bandStart[d + 1] - s0;
    const rem = total - childFull[d];
    const cum = (m: number): number => (m === 0 ? 0 : bandLoss[s0 + m - 1]);
    let a = 0;
    let b = len;
    while (a < b) {
      const mid = (a + b + 1) >> 1;
      if (cum(mid) <= rem) a = mid;
      else b = mid - 1;
    }
    const nd = nodes[d];
    if (a === 0) return nd.base;
    const hPrev = bandHeight(d, a - 1);
    const hNext = a < len ? bandHeight(d, a) : nd.spill;
    const lm = a < len ? bandLoss[s0 + a] - cum(a) : 0;
    const frac = lm > 0 ? Math.min(0.95, Math.max(0.05, (rem - cum(a)) / lm)) : 0.5;
    let L = Math.fround(hPrev + frac * (hNext - hPrev));
    if (!(L > hPrev)) L = Math.fround(hPrev + Math.max(1e-3, Math.abs(hPrev) * 2.4e-7));
    return Math.min(L, nd.spill);
  };

  /** Cells of the subtree below `level` (all of each descendant band, and d's own band up to level). */
  const cellsBelow = (d: number, level: number): Int32Array => {
    const out: number[] = [];
    for (let p = lo[d]; p < pos[d]; p++) {
      const e = post[p];
      for (let k = bandStart[e]; k < bandStart[e + 1]; k++) out.push(bandCells[k]);
    }
    for (let k = bandStart[d]; k < bandStart[d + 1]; k++) {
      const c = bandCells[k];
      if (h[c] < level) out.push(c);
      else break;
    }
    return Int32Array.from(out);
  };

  const lakes: LakeBody[] = [];
  let toSea = 0;
  const work: { d: number; tr: { leaf: number; q: number }[] }[] = [];
  for (let t = tops.length - 1; t >= 0; t--) {
    work.push({ d: tops[t], tr: [] });
    while (work.length > 0) {
      const { d, tr } = work.pop()!;
      const nd = nodes[d];
      let total = own[d];
      for (const x of tr) total += x.q;
      if (total >= fullLoss[d] && Number.isFinite(nd.spill)) {
        const cells = cellsBelow(d, nd.spill);
        const outflow = total - fullLoss[d];
        if (cells.length > 0) {
          lakes.push({ node: d, kind: 'through', level: nd.spill, cells, cellsAtSpill: spillCells[d], bottom: bottomOf(h, cells), inflow: total, outflow });
        }
        if (nd.parent < 0) {
          if (nd.spillTo > 0) {
            for (let e = nd.spillTo; e >= 0; e = nodes[e].parent) own[e] += outflow;
          } else {
            toSea += outflow;
          }
        }
        continue;
      }
      if (nd.a < 0 || total >= childFull[d]) {
        const level = levelFor(d, total);
        const cells = cellsBelow(d, level);
        const ratio = cells.length / Math.max(1, spillCells[d]);
        if (ratio < 0.05) {
          // Too little water for a standing lake: a playa, the floor that rare floods cover.
          const pan = levelFor(d, Math.min(fullLoss[d], Math.max(childFull[d], 5 * total, PLAYA_FLOOR * fullLoss[d])));
          const panCells = cellsBelow(d, pan);
          if (panCells.length > 0) {
            lakes.push({ node: d, kind: 'playa', level: pan, cells: panCells, cellsAtSpill: spillCells[d], bottom: bottomOf(h, panCells), inflow: total, outflow: 0 });
          }
          continue;
        }
        lakes.push({ node: d, kind: 'terminal', level, cells, cellsAtSpill: spillCells[d], bottom: bottomOf(h, cells), inflow: total, outflow: 0 });
        continue;
      }
      // Not merged: each child gets its own inflow plus the transfers that enter its subtree.
      const trA: { leaf: number; q: number }[] = [];
      const trB: { leaf: number; q: number }[] = [];
      let ta = own[nd.a];
      let tb = own[nd.b];
      for (const x of tr) {
        if (inSubtree(x.leaf, nd.a)) {
          trA.push(x);
          ta += x.q;
        } else {
          trB.push(x);
          tb += x.q;
        }
      }
      if (ta >= fullLoss[nd.a]) trB.push({ leaf: nodes[nd.a].spillTo, q: ta - fullLoss[nd.a] });
      else if (tb >= fullLoss[nd.b]) trA.push({ leaf: nodes[nd.b].spillTo, q: tb - fullLoss[nd.b] });
      work.push({ d: nd.a, tr: trA }, { d: nd.b, tr: trB });
    }
  }
  return { lakes, toSea };
}

function bottomOf(h: Float32Array, cells: Int32Array): number {
  let lo = Infinity;
  for (const c of cells) lo = Math.min(lo, h[c]);
  return lo;
}
