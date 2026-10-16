import { asCube, unitPositions, type CubeGrid } from './cube';
import { AXIAL_DX as DX, AXIAL_DY as DY, type Grid } from './grid';
import { MinHeap } from './heap';

/**
 * Approximate Euclidean distance transform with nearest-source propagation: a multi-source Dijkstra
 * where each cell inherits its neighbour's nearest source and is keyed by the true Euclidean distance
 * to that source (vector propagation; errors are rare and sub-cell). O(n log n).
 * Returns distances in cells and the index of the nearest source cell (−1 if none). On the sphere the
 * key is the great-circle distance to the source in nominal cells (cellM), so distance × cellKm is km.
 */
export function distanceField(source: Uint8Array, g: Grid): { dist: Float32Array; nearest: Int32Array } {
  if (g.faces !== 1) return distanceFieldCube(source, asCube(g));
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

function distanceFieldCube(source: Uint8Array, g: CubeGrid): { dist: Float32Array; nearest: Int32Array } {
  const N = g.cells;
  const p = unitPositions(g);
  const inv = 1 / g.delta;
  const dist = new Float64Array(N).fill(Infinity);
  const nearest = new Int32Array(N).fill(-1);
  const heap = new MinHeap(g.n * 24);
  for (let i = 0; i < N; i++) {
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
    const sx = p[s * 3];
    const sy = p[s * 3 + 1];
    const sz = p[s * 3 + 2];
    for (let k = 0; k < 8; k++) {
      const nc = g.nbr(c, k);
      if (nc < 0) continue;
      const qx = p[nc * 3];
      const qy = p[nc * 3 + 1];
      const qz = p[nc * 3 + 2];
      const cx = sy * qz - sz * qy;
      const cy = sz * qx - sx * qz;
      const cz = sx * qy - sy * qx;
      const nd = Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), sx * qx + sy * qy + sz * qz) * inv;
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
  const N = g.cells;
  const inv = new Uint8Array(N);
  for (let i = 0; i < N; i++) inv[i] = mask[i] ? 0 : 1;
  const toOutside = distanceField(inv, g).dist;
  const toInside = distanceField(mask, g).dist;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = mask[i] ? Math.min(toOutside[i], n) - 0.5 : -(Math.min(toInside[i], n) - 0.5);
  }
  return out;
}
