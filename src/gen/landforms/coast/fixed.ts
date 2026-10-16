import type { Grid } from '../../grid/grid';
import { components8 } from './grid';

/**
 * Re-derives the base-level mask after coastal edits: `fixed` = 1 exactly on water (h ≤ 0) that is
 * 8-connected to the sea that existed before the pass, plus the open-map-edge land cells that were
 * already fixed. Each old sea body is anchored at its deepest remaining cell (and its map-border
 * cells), so water cut off behind a closed barrier or a raised bar becomes a depression for hydrology
 * (fixed 0), and newly drowned cells joined to the sea (rias) become sea (fixed 1). 8-connectivity
 * matches the D8 routing of the hydrology stage.
 */
export function reconcileFixed(h: Float32Array, fixedBefore: Uint8Array, hBefore: Float32Array, g: Grid): Uint8Array {
  const { cells: N, border } = g;
  const oldSea = new Uint8Array(N);
  for (let i = 0; i < N; i++) oldSea[i] = fixedBefore[i] && hBefore[i] <= 0 ? 1 : 0;
  const { label, sizes } = components8(oldSea, g);
  const deepest = new Int32Array(sizes.length).fill(-1);
  const out = new Uint8Array(N);
  const queue = new Int32Array(N);
  let qt = 0;
  for (let i = 0; i < N; i++) {
    const l = label[i];
    if (l < 0 || h[i] > 0) continue;
    const d = deepest[l];
    if (d < 0 || h[i] < h[d]) deepest[l] = i;
    if (border[i]) {
      out[i] = 1;
      queue[qt++] = i;
    }
  }
  for (const d of deepest) {
    if (d >= 0 && !out[d]) {
      out[d] = 1;
      queue[qt++] = d;
    }
  }
  flood(h, out, queue, qt, g);
  // Open map edges (mapEdge = continent) stay base level on land.
  for (let i = 0; i < N; i++) {
    if (!fixedBefore[i] || hBefore[i] <= 0) continue;
    if (border[i]) out[i] = 1;
  }
  return out;
}

/** Flood over water cells (h ≤ 0, 8-connected) from the `top` seeds on `stack`, marking `out`. */
function flood(h: Float32Array, out: Uint8Array, stack: Int32Array, seeds: number, g: Grid): void {
  const { cells: N, border, off8Axial, axialToRaster } = g;
  const water = new Uint8Array(N);
  for (let i = 0; i < N; i++) water[i] = h[i] <= 0 && !out[i] ? 1 : 0;
  let top = seeds;
  while (top > 0) {
    const c = stack[--top];
    const b = border[c];
    for (let k = 0; k < 8; k++) {
      const j = b === 0 ? c + off8Axial[k] : g.nbr(c, axialToRaster[k]);
      if (j >= 0 && water[j]) {
        water[j] = 0;
        out[j] = 1;
        stack[top++] = j;
      }
    }
  }
}
