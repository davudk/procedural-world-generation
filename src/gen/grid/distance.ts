import { AXIAL_DX as DX, AXIAL_DY as DY, type Grid } from './grid';
import { MinHeap } from './heap';

/**
 * Approximate Euclidean distance transform with nearest-source propagation: a multi-source Dijkstra
 * where each cell inherits its neighbour's nearest source and is keyed by the true Euclidean distance
 * to that source (vector propagation; errors are rare and sub-cell). O(n log n).
 * Returns distances in cells and the index of the nearest source cell (−1 if none).
 */
export function distanceField(source: Uint8Array, g: Grid): { dist: Float32Array; nearest: Int32Array } {
  const n = g.n;
  // Float64 on purpose: comparing float64 candidates against float32-rounded stored distances can
  // re-queue the same cells forever.
  const dist = new Float64Array(n * n).fill(Infinity);
  const nearest = new Int32Array(n * n).fill(-1);
  const heap = new MinHeap(n * 4);
  for (let i = 0; i < n * n; i++) {
    if (!source[i]) continue;
    dist[i] = 0;
    nearest[i] = i;
    heap.push(0, i);
  }
  while (heap.size > 0) {
    const d = heap.peekKey();
    const c = heap.pop();
    if (d > dist[c]) continue;
    const s = nearest[c];
    const sx = s % n;
    const sy = (s - sx) / n;
    const x = c % n;
    const y = (c - x) / n;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k];
      const ny = y + DY[k];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const nc = ny * n + nx;
      const nd = Math.hypot(nx - sx, ny - sy);
      if (nd < dist[nc]) {
        dist[nc] = nd;
        nearest[nc] = s;
        heap.push(nd, nc);
      }
    }
  }
  return { dist: Float32Array.from(dist), nearest };
}

/**
 * Signed distance (in cells) to the boundary of `mask`: positive inside, negative outside. Each side
 * is measured to the nearest cell of the other side, minus half a cell, so the zero crossing sits on
 * the cell edge.
 */
export function signedDistance(mask: Uint8Array, g: Grid): Float32Array {
  const n = g.n;
  const inv = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) inv[i] = mask[i] ? 0 : 1;
  const toOutside = distanceField(inv, g).dist;
  const toInside = distanceField(mask, g).dist;
  const out = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    out[i] = mask[i] ? Math.min(toOutside[i], n) - 0.5 : -(Math.min(toInside[i], n) - 0.5);
  }
  return out;
}
