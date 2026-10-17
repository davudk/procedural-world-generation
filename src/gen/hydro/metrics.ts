import { surfaceDir } from '../../shared/cube';
import { RIVER, type RiverGraph } from '../../shared/protocol';

/**
 * Node positions for the measures: map metres (x, y, 0) on flat maps; on the sphere (RiverGraph.face
 * set) 3D points in metres from the planet centre, from (face, u, v) on a sphere of `radiusM`.
 */
export function riverPoints(g: RiverGraph, radiusM: number): Float64Array {
  const p = new Float64Array(3 * g.n);
  if (!g.face) {
    for (let i = 0; i < g.n; i++) {
      p[3 * i] = g.x[i];
      p[3 * i + 1] = g.y[i];
    }
    return p;
  }
  for (let i = 0; i < g.n; i++) {
    surfaceDir(g.face[i], g.x[i], g.y[i], radiusM, p, 3 * i);
    p[3 * i] *= radiusM;
    p[3 * i + 1] *= radiusM;
    p[3 * i + 2] *= radiusM;
  }
  return p;
}

/** Distance between nodes i and j: map metres on flat maps, the 3D chord of `pts` on the sphere. */
function nodeDist(g: RiverGraph, pts: Float64Array | null, i: number, j: number): number {
  if (!pts) return Math.hypot(g.x[j] - g.x[i], g.y[j] - g.y[i]);
  return Math.hypot(pts[3 * j] - pts[3 * i], pts[3 * j + 1] - pts[3 * i + 1], pts[3 * j + 2] - pts[3 * i + 2]);
}

/** Total channel length (km), distributaries excluded. `pts` (sphere): riverPoints. */
export function channelLengthKm(g: RiverGraph, pts: Float64Array | null = null): number {
  let m = 0;
  for (let i = 0; i < g.n; i++) {
    const d = g.down[i];
    if (d < 0 || g.flags[i] & RIVER.DISTRIBUTARY) continue;
    m += nodeDist(g, pts, i, d);
  }
  return m / 1000;
}

/** Least-squares slope of y on x. */
function slopeOf(xs: number[], ys: number[]): number {
  const k = xs.length;
  if (k < 2) return NaN;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < k; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / k;
  const my = sy / k;
  let num = 0;
  let den = 0;
  for (let i = 0; i < k; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : NaN;
}

/**
 * Horton bifurcation ratio R_b: number of Strahler streams per order, regressed as log N vs ω
 * (research 02 §3.3). A stream of order ω starts where that order first appears going downstream.
 * Orders with fewer than 3 streams are left out of the fit.
 */
export function bifurcationRatio(g: RiverGraph): { rb: number; counts: number[] } {
  const maxIn = new Uint8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const d = g.down[i];
    if (d >= 0 && !(g.flags[i] & RIVER.DISTRIBUTARY)) maxIn[d] = Math.max(maxIn[d], g.strahler[i]);
  }
  const counts: number[] = [];
  for (let i = 0; i < g.n; i++) {
    if (g.flags[i] & RIVER.DISTRIBUTARY) continue;
    const s = g.strahler[i];
    if (maxIn[i] < s) counts[s] = (counts[s] ?? 0) + 1;
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let w = 1; w < counts.length; w++) {
    if ((counts[w] ?? 0) >= 3) {
      xs.push(w);
      ys.push(Math.log(counts[w]));
    }
  }
  return { rb: Math.exp(-slopeOf(xs, ys)), counts: Array.from(counts, (c) => c ?? 0) };
}

/**
 * Hack's exponent h in L = c·A^h: main-stem length (longest path up the graph, km) against drainage
 * area at every sea mouth with A ≥ `minArea` km² (research 02 §3.3).
 */
export function hackExponent(g: RiverGraph, minArea = 100, pts: Float64Array | null = null): { h: number; basins: number } {
  const up = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const d = g.down[i];
    if (d < 0) continue;
    up[d] = Math.max(up[d], up[i] + nodeDist(g, pts, i, d) / 1000);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < g.n; i++) {
    if (!(g.flags[i] & RIVER.MOUTH_SEA) || g.flags[i] & RIVER.DISTRIBUTARY || g.area[i] < minArea || up[i] <= 0) continue;
    xs.push(Math.log(g.area[i]));
    ys.push(Math.log(up[i]));
  }
  return { h: slopeOf(xs, ys), basins: xs.length };
}

/**
 * Number of pairs of graph segments that cross (research 02 §10.3 #6), ignoring segments that share a
 * node. Segments are binned on a grid of `bin` metres. On the sphere (`pts` from riverPoints) each
 * segment is binned by both end points into 3D boxes of `bin` (and their neighbours) and tested in
 * the tangent plane at one end, so crossings over seams count too.
 */
export function countCrossings(g: RiverGraph, bin: number, pts: Float64Array | null = null): number {
  if (pts) return countCrossings3(g, bin, pts);
  const segs: number[] = [];
  for (let i = 0; i < g.n; i++) if (g.down[i] >= 0) segs.push(i);
  const bins = new Map<number, number[]>();
  const key = (bx: number, by: number): number => bx * 65536 + by;
  for (const i of segs) {
    const d = g.down[i];
    const x0 = Math.floor(Math.min(g.x[i], g.x[d]) / bin);
    const x1 = Math.floor(Math.max(g.x[i], g.x[d]) / bin);
    const y0 = Math.floor(Math.min(g.y[i], g.y[d]) / bin);
    const y1 = Math.floor(Math.max(g.y[i], g.y[d]) / bin);
    for (let bx = x0; bx <= x1; bx++) {
      for (let by = y0; by <= y1; by++) {
        const k = key(bx, by);
        const list = bins.get(k);
        if (list) list.push(i);
        else bins.set(k, [i]);
      }
    }
  }
  const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean => {
    const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number => (qx - px) * (ry - py) - (qy - py) * (rx - px);
    const d1 = o(cx, cy, dx, dy, ax, ay);
    const d2 = o(cx, cy, dx, dy, bx, by);
    const d3 = o(ax, ay, bx, by, cx, cy);
    const d4 = o(ax, ay, bx, by, dx, dy);
    return d1 * d2 < 0 && d3 * d4 < 0;
  };
  const seen = new Set<number>();
  const nodes = g.n;
  let count = 0;
  for (const list of bins.values()) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const i = list[p];
        const j = list[q];
        const di = g.down[i];
        const dj = g.down[j];
        if (i === dj || j === di || di === dj) continue;
        const pk = Math.min(i, j) * nodes + Math.max(i, j);
        if (seen.has(pk)) continue;
        if (cross(g.x[i], g.y[i], g.x[di], g.y[di], g.x[j], g.y[j], g.x[dj], g.y[dj])) {
          seen.add(pk);
          count++;
        }
      }
    }
  }
  return count;
}

function countCrossings3(g: RiverGraph, bin: number, p: Float64Array): number {
  const bins = new Map<string, number[]>();
  const keyOf = (x: number, y: number, z: number): string => `${Math.floor(x / bin)},${Math.floor(y / bin)},${Math.floor(z / bin)}`;
  // Each segment goes into the boxes its end points fall in; a crossing pair then shares a box as long
  // as segments are shorter than a box (checked by also scanning the 26 neighbours below).
  for (let i = 0; i < g.n; i++) {
    const d = g.down[i];
    if (d < 0) continue;
    const k = keyOf(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
    const list = bins.get(k);
    if (list) list.push(i);
    else bins.set(k, [i]);
  }
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number): number => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const seen = new Set<number>();
  const nodes = g.n;
  let count = 0;
  const up = new Float64Array(3);
  const e = new Float64Array(3);
  const nn = new Float64Array(3);
  for (let i = 0; i < g.n; i++) {
    const di = g.down[i];
    if (di < 0) continue;
    const bx = Math.floor(p[3 * i] / bin);
    const by = Math.floor(p[3 * i + 1] / bin);
    const bz = Math.floor(p[3 * i + 2] / bin);
    const r = Math.hypot(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
    for (let k = 0; k < 3; k++) up[k] = p[3 * i + k] / r;
    // Tangent plane at node i: east / north coordinates relative to it.
    e[0] = -up[1];
    e[1] = up[0];
    e[2] = 0;
    let el = Math.hypot(e[0], e[1]);
    if (el < 1e-9) {
      e[0] = 0;
      e[1] = 1;
      el = 1;
    }
    e[0] /= el;
    e[1] /= el;
    nn[0] = up[1] * e[2] - up[2] * e[1];
    nn[1] = up[2] * e[0] - up[0] * e[2];
    nn[2] = up[0] * e[1] - up[1] * e[0];
    const loc = (j: number, out: number[]): void => {
      const dx = p[3 * j] - p[3 * i];
      const dy = p[3 * j + 1] - p[3 * i + 1];
      const dz = p[3 * j + 2] - p[3 * i + 2];
      out[0] = dx * e[0] + dy * e[1] + dz * e[2];
      out[1] = dx * nn[0] + dy * nn[1] + dz * nn[2];
    };
    const A = [0, 0];
    const B = [0, 0];
    const C = [0, 0];
    const D = [0, 0];
    loc(di, B);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -1; oz <= 1; oz++) {
          const list = bins.get(`${bx + ox},${by + oy},${bz + oz}`);
          if (!list) continue;
          for (const j of list) {
            if (j <= i) continue;
            const dj = g.down[j];
            if (i === dj || j === di || di === dj) continue;
            const pk = i * nodes + j;
            if (seen.has(pk)) continue;
            loc(j, C);
            loc(dj, D);
            const d1 = o(C[0], C[1], D[0], D[1], A[0], A[1]);
            const d2 = o(C[0], C[1], D[0], D[1], B[0], B[1]);
            const d3 = o(A[0], A[1], B[0], B[1], C[0], C[1]);
            const d4 = o(A[0], A[1], B[0], B[1], D[0], D[1]);
            if (d1 * d2 < 0 && d3 * d4 < 0) {
              seen.add(pk);
              count++;
            }
          }
        }
      }
    }
  }
  return count;
}

/**
 * Longest river to the sea (research 05 §4 row 12, restated for M8): for every sea mouth, the length
 * (km) of the longest path up the graph to a source, crossing through-flow lakes from inlet to outlet
 * (as rivers like the St. Lawrence or the Nile are measured). `lakeOfMouth` gives the lake a
 * MOUTH_LAKE node ends in (−1 if none) and `outletNode` the outlet node per lake (−1 for terminal
 * lakes). Returns the longest length and how many sea mouths reach `minKm`.
 */
export function longestRiversToSea(
  g: RiverGraph,
  lakeOfMouth: (node: number) => number,
  outletNode: Int32Array,
  minKm: number,
  pts: Float64Array | null = null,
): { longestKm: number; count: number } {
  const N = g.n;
  const tgt = new Int32Array(N).fill(-1);
  const indeg = new Int32Array(N);
  const skip = (i: number): boolean => (g.flags[i] & RIVER.DISTRIBUTARY) !== 0;
  for (let i = 0; i < N; i++) {
    if (skip(i)) continue;
    let t = g.down[i];
    if (t < 0 && g.flags[i] & RIVER.MOUTH_LAKE && !(g.flags[i] & RIVER.LAKE_TERMINAL)) {
      const l = lakeOfMouth(i);
      if (l >= 0 && l < outletNode.length) t = outletNode[l];
    }
    if (t < 0 || t === i || skip(t)) continue;
    tgt[i] = t;
    indeg[t]++;
  }
  const len = new Float64Array(N);
  const queue = new Int32Array(N);
  let qt = 0;
  for (let i = 0; i < N; i++) if (indeg[i] === 0 && !skip(i)) queue[qt++] = i;
  let longest = 0;
  let count = 0;
  for (let qh = 0; qh < qt; qh++) {
    const i = queue[qh];
    const t = tgt[i];
    if (t >= 0) {
      len[t] = Math.max(len[t], len[i] + nodeDist(g, pts, i, t));
      if (--indeg[t] === 0) queue[qt++] = t;
    } else if (g.flags[i] & RIVER.MOUTH_SEA) {
      const km = len[i] / 1000;
      longest = Math.max(longest, km);
      if (km >= minKm) count++;
    }
  }
  return { longestKm: longest, count };
}
