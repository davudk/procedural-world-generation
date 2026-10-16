import { MinHeap } from '../grid/heap';
import { DIST, DX, DY, offsets, stepDown } from './grid8';

export interface BreachResult {
  /** Closed depressions found (flat minima merged). */
  pits: number;
  breached: number;
  /** Cells lowered. */
  carved: number;
}

/**
 * Breaches shallow, small depressions (noise pits) instead of keeping them as lakes (research 02
 * §1.2, Lindsay 2016). Each closed minimum is flooded locally, lowest cells first, until the flood
 * finds lower ground beyond the spill; if that happens within `maxDepth` and `maxCells`, the path from
 * the pit to the lower ground is carved strictly downhill and then continued down the steepest
 * descent until it meets terrain below the carve. Deeper or larger depressions are left for the
 * lake model. `depthScale` and `areaScale` (per pit cell) multiply the two limits; the area limit
 * never drops below `minCells`. Only ever lowers `h`; fixed cells are never touched.
 */
export function breachShallow(
  h: Float32Array,
  n: number,
  fixed: Uint8Array,
  maxDepth: number,
  maxCells: number,
  depthScale?: Float32Array,
  areaScale?: Float32Array,
  minCells = 1.5,
): BreachResult {
  const N = n * n;
  const off = offsets(n);
  const stamp = new Int32Array(N).fill(-1);
  const parent = new Int32Array(N);
  const mark = new Int32Array(N).fill(-1);
  const heap = new MinHeap(64);
  const inside = (c: number, k: number): boolean => {
    const x = (c % n) + DX[k];
    const y = Math.floor(c / n) + DY[k];
    return x >= 0 && y >= 0 && x < n && y < n;
  };
  const isMin = (i: number): boolean => {
    const x = i % n;
    const y = (i - x) / n;
    if (x > 0 && y > 0 && x < n - 1 && y < n - 1) {
      for (let k = 0; k < 8; k++) if (h[i + off[k]] < h[i]) return false;
      return true;
    }
    for (let k = 0; k < 8; k++) if (inside(i, k) && h[i + off[k]] < h[i]) return false;
    return true;
  };
  let pits = 0;
  let breached = 0;
  let carved = 0;
  for (let p = 0; p < N; p++) {
    if (fixed[p] || !isMin(p)) continue;
    pits++;
    const dMax = maxDepth * (depthScale ? depthScale[p] : 1);
    const cMax = Math.max(maxCells * (areaScale ? areaScale[p] : 1), minCells);
    // Local priority flood from the pit until a cell below the running water level appears.
    const base = h[p];
    let level = base;
    let outlet = -1;
    let flooded = 0;
    heap.size = 0;
    heap.push(h[p], p);
    stamp[p] = p;
    parent[p] = -1;
    while (heap.size > 0) {
      const c = heap.pop();
      if (h[c] < level || fixed[c]) {
        outlet = c;
        break;
      }
      level = h[c];
      if (level - base >= dMax || ++flooded > cMax) break;
      for (let k = 0; k < 8; k++) {
        if (!inside(c, k)) continue;
        const j = c + off[k];
        if (stamp[j] === p) continue;
        stamp[j] = p;
        parent[j] = c;
        heap.push(h[j], j);
      }
    }
    if (outlet < 0) continue;
    breached++;
    const path: number[] = [];
    for (let c = outlet; c >= 0; c = parent[c]) path.push(c);
    let z = base;
    let c = -1;
    // Surface of `c` before carving: the descent below follows the natural terrain, not the trench.
    let natural = h[p];
    mark[p] = p;
    for (let k = path.length - 2; k >= 0; k--) {
      c = path[k];
      natural = h[c];
      if (fixed[c]) break;
      z = stepDown(z);
      if (h[c] <= z) break;
      h[c] = z;
      mark[c] = p;
      carved++;
    }
    // The outlet can lie below the spill but above the pit floor: continue down the natural steepest
    // descent (never back along the trench) until the terrain is below the carved level.
    while (c >= 0 && !fixed[c]) {
      let best = -1;
      let bestS = 0;
      for (let k = 0; k < 8; k++) {
        if (!inside(c, k)) continue;
        const j = c + off[k];
        if (mark[j] === p) continue;
        const s = (natural - h[j]) / DIST[k];
        if (s > bestS) {
          bestS = s;
          best = j;
        }
      }
      if (best < 0 || fixed[best]) break;
      z = stepDown(Math.min(z, h[c]));
      if (h[best] <= z) break;
      natural = h[best];
      h[best] = z;
      mark[best] = p;
      carved++;
      c = best;
    }
  }
  return { pits, breached, carved };
}
