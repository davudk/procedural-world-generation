import { MinHeap } from './heap';

/** Reusable buffers so repeated floods (one per LEM iteration) allocate nothing. */
export interface PriorityFloodScratch {
  closed: Uint8Array;
  pit: Int32Array;
  heap: MinHeap;
}

export function createPriorityFloodScratch(cells: number): PriorityFloodScratch {
  return { closed: new Uint8Array(cells), pit: new Int32Array(cells), heap: new MinHeap(4096) };
}

const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * Smallest float32 value we treat as "strictly above" z: z + max(eps, |z|·2^-20). The relative term
 * is ≥ 8 float32 ulps, so the step survives rounding at any elevation.
 */
export function floodStep(z: number, eps: number): number {
  return Math.fround(z + Math.max(eps, Math.abs(z) * 9.5367431640625e-7));
}

/**
 * Priority-Flood+ε (Barnes, Lehman & Mulla 2014) with the pit-queue optimisation. Floods inwards from
 * the seed cells (ocean / open edge, left unchanged) over the 8-neighbourhood and writes to `out` a
 * copy of `h` in which every non-seed cell has a strictly lower neighbour, so steepest descent on
 * `out` reaches a seed from everywhere. Depressions become gently inclined flats. Ties pop by cell
 * index (MinHeap), so the result is deterministic. With no seeds at all, `out` is a plain copy.
 */
export function priorityFloodEpsilon(
  h: Float32Array,
  n: number,
  isSeed: Uint8Array,
  out: Float32Array,
  eps = 1e-3,
  scratch: PriorityFloodScratch = createPriorityFloodScratch(n * n),
): void {
  const N = n * n;
  out.set(h);
  const { closed, pit, heap } = scratch;
  closed.fill(0);
  heap.size = 0;

  for (let i = 0; i < N; i++) if (isSeed[i]) closed[i] = 1;
  // Only seeds that touch a non-seed cell can ever spill into land; interior ocean stays out of the heap.
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (!isSeed[i]) continue;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        if (!closed[ny * n + nx]) {
          heap.push(out[i], i);
          break;
        }
      }
    }
  }

  const off = Int32Array.from(DX, (dx, k) => DY[k] * n + dx);
  let pitHead = 0;
  let pitTail = 0;
  while (pitHead < pitTail || heap.size > 0) {
    const c = pitHead < pitTail ? pit[pitHead++] : heap.pop();
    const zNext = floodStep(out[c], eps);
    const cx = c % n;
    const cy = (c - cx) / n;
    const edge = cx === 0 || cy === 0 || cx === n - 1 || cy === n - 1;
    for (let k = 0; k < 8; k++) {
      if (edge) {
        const nx = cx + DX[k];
        const ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      }
      const j = c + off[k];
      if (closed[j]) continue;
      closed[j] = 1;
      if (out[j] <= zNext) {
        out[j] = zNext;
        pit[pitTail++] = j;
      } else {
        heap.push(out[j], j);
      }
    }
  }
}
