import type { Grid } from './grid';
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
  g: Grid,
  isSeed: Uint8Array,
  out: Float32Array,
  eps = 1e-3,
  scratch: PriorityFloodScratch = createPriorityFloodScratch(g.cells),
): void {
  const { cells: N, off8: off, border } = g;
  out.set(h);
  const { closed, pit, heap } = scratch;
  closed.fill(0);
  heap.size = 0;

  for (let i = 0; i < N; i++) if (isSeed[i]) closed[i] = 1;
  // Only seeds that touch a non-seed cell can ever spill into land; interior ocean stays out of the heap.
  for (let i = 0; i < N; i++) {
    if (!isSeed[i]) continue;
    const b = border[i];
    for (let k = 0; k < 8; k++) {
      const j = b === 0 ? i + off[k] : g.nbr(i, k);
      if (j < 0) continue;
      if (!closed[j]) {
        heap.push(out[i], i);
        break;
      }
    }
  }

  let pitHead = 0;
  let pitTail = 0;
  while (pitHead < pitTail || heap.size > 0) {
    const c = pitHead < pitTail ? pit[pitHead++] : heap.pop();
    const zNext = floodStep(out[c], eps);
    const b = border[c];
    for (let k = 0; k < 8; k++) {
      let j: number;
      if (b === 0) j = c + off[k];
      else if ((j = g.nbr(c, k)) < 0) continue;
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
