import { RIVER, type RiverGraph } from '../../shared/protocol';

/** Total channel length (km), distributaries excluded. */
export function channelLengthKm(g: RiverGraph): number {
  let m = 0;
  for (let i = 0; i < g.n; i++) {
    const d = g.down[i];
    if (d < 0 || g.flags[i] & RIVER.DISTRIBUTARY) continue;
    m += Math.hypot(g.x[d] - g.x[i], g.y[d] - g.y[i]);
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
export function hackExponent(g: RiverGraph, minArea = 100): { h: number; basins: number } {
  const up = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const d = g.down[i];
    if (d < 0) continue;
    up[d] = Math.max(up[d], up[i] + Math.hypot(g.x[d] - g.x[i], g.y[d] - g.y[i]) / 1000);
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
 * node. Segments are binned on a grid of `bin` metres.
 */
export function countCrossings(g: RiverGraph, bin: number): number {
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
  let count = 0;
  for (const list of bins.values()) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const i = list[p];
        const j = list[q];
        const di = g.down[i];
        const dj = g.down[j];
        if (i === dj || j === di || di === dj) continue;
        const pk = Math.min(i, j) * g.n + Math.max(i, j);
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
