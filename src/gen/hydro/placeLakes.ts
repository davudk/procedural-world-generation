import type { Rng } from '../../shared/rng';
import type { Grid } from '../grid/grid';
import { MinHeap } from '../grid/heap';
import { smoothstep } from '../grid/ops';

/** Lakes of at least 1 km² per km² of land in an average climate (HydroLAKES / Downing 2006, research 02 §6). */
const LAKES_PER_KM2 = 1e-3;
/** Mean acceptance of the climate/terrain weight over an average world (normalises the attempt count). */
const MEAN_WEIGHT = 0.07;
const MAX_AREA_KM2 = 3000;

export interface PlaceInput {
  grid: Grid;
  h: Float32Array;
  fixed: Uint8Array;
  /** Drainage area (m²) and receivers of the input terrain. */
  area: Float32Array;
  rcv: Int32Array;
  temp: Float32Array;
  precip: Float32Array;
  pet: Float32Array;
  lakeDensity: number;
  rng: Rng;
  /** Optional per-cell acceptance multiplier (lake districts). */
  weight?: Float32Array;
}

/**
 * Lake basins the eroded terrain lacks (research 02 §6): glacial overdeepenings, kettles and
 * tectonic sags are all closed basins on a flow path, so each placed lake is carved as a basin
 * behind a sill cell on an existing drainage line. Sizes follow a Pareto law N(A > a) ∝ a^−1 from
 * one cell up; placement favours humid, cold and gentle terrain. Only lowers `h`; whether a basin
 * then holds a through-flow lake, a salt lake or a playa is left to the water balance.
 * Returns the number of basins carved.
 */
export function placeLakeBasins(p: PlaceInput): number {
  const { grid: g, h, fixed, area, rcv, temp, precip, pet, rng } = p;
  const { cells: N, cellKm, off8: off, border } = g;
  const cellKm2 = cellKm * cellKm;
  let landCells = 0;
  for (let i = 0; i < N; i++) if (!fixed[i]) landCells++;
  const aMin = Math.max(1, cellKm2);
  const expected = (LAKES_PER_KM2 * landCells * cellKm2 * p.lakeDensity) / aMin;
  const attempts = Math.round(expected / MEAN_WEIGHT);
  const taken = new Uint8Array(N);
  const inHeap = new Int32Array(N).fill(-1);
  const heap = new MinHeap(256);
  const region: number[] = [];
  const steep = (i: number): number => {
    let s = 0;
    for (let k = 0; k < 8; k++) {
      const j = border[i] === 0 ? i + off[k] : g.nbr(i, k);
      if (j < 0) continue;
      s = Math.max(s, Math.abs(h[i] - h[j]));
    }
    return s / (cellKm * 1000);
  };
  let placed = 0;
  for (let k = 0; k < attempts; k++) {
    const start = rng.int(N);
    const u = rng.float();
    const a = Math.min(MAX_AREA_KM2, aMin / Math.max(1e-6, rng.float()));
    const target = Math.max(1, Math.round(a / cellKm2));
    // Lakes sit on drainage lines: move the sill downstream until its catchment can feed the lake.
    let sill = start;
    while (!fixed[sill] && area[sill] < 3 * target * cellKm2 * 1e6 && rcv[sill] !== sill) sill = rcv[sill];
    if (fixed[sill] || taken[sill]) continue;
    const wet = precip[sill] / Math.max(1, pet[sill]);
    const cold = 1 + 2 * smoothstep(6, -4, temp[sill]);
    // Humid and cold land holds lakes; arid land keeps closed basins that end up as playas and salt lakes.
    const climate = Math.max((0.1 + 0.9 * smoothstep(0.4, 1.2, wet)) * cold, 0.6 * smoothstep(0.6, 0.25, wet));
    const weight = ((climate * 0.5) / (1 + steep(sill) / 0.08)) * (p.weight ? p.weight[sill] : 1);
    if (u > weight) continue;
    const level = h[sill];

    // Grow the basin upstream of the sill, lowest cells first, never next to lower ground outside it.
    region.length = 0;
    heap.size = 0;
    for (let d = 0; d < 8; d++) {
      const j = border[sill] === 0 ? sill + off[d] : g.nbr(sill, d);
      if (j < 0) continue;
      if (!fixed[j] && !taken[j] && h[j] >= level && inHeap[j] !== k) {
        inHeap[j] = k;
        heap.push(h[j], j);
      }
    }
    const rise = 20 + 2 * Math.sqrt(target) * cellKm;
    while (heap.size > 0 && region.length < target) {
      const c = heap.pop();
      if (h[c] > level + rise) break;
      const b = border[c];
      let leak = false;
      for (let d = 0; d < 8 && !leak; d++) {
        const j = b === 0 ? c + off[d] : g.nbr(c, d);
        if (j < 0) {
          leak = true;
          continue;
        }
        if (j === sill || taken[j] === 2) continue;
        if (fixed[j] || taken[j] || h[j] < level) leak = true;
      }
      if (leak) continue;
      region.push(c);
      taken[c] = 2;
      for (let d = 0; d < 8; d++) {
        const j = b === 0 ? c + off[d] : g.nbr(c, d);
        if (j < 0) continue;
        if (!fixed[j] && !taken[j] && j !== sill && inHeap[j] !== k) {
          inHeap[j] = k;
          heap.push(h[j], j);
        }
      }
    }
    if (region.length === 0) continue;
    // Bowl: deepest away from the shore, depth growing with lake size.
    const depth = Math.min(80, 3 + 4 * Math.pow(region.length * cellKm2, 0.35));
    const ring = shoreDistance(region, taken, g);
    let far = 1;
    for (const d of ring) far = Math.max(far, d);
    for (let r = 0; r < region.length; r++) {
      const c = region[r];
      const z = level - 0.5 - depth * Math.pow(ring[r] / far, 0.7);
      if (z < h[c]) h[c] = Math.fround(z);
      taken[c] = 1;
    }
    taken[sill] = 1;
    placed++;
  }
  return placed;
}

/** Distance (cells, ≥ 1) from each region cell to the nearest cell outside the region. */
function shoreDistance(region: number[], taken: Uint8Array, g: Grid): Int32Array {
  const { off8: off, border } = g;
  const index = new Map<number, number>();
  region.forEach((c, r) => index.set(c, r));
  const dist = new Int32Array(region.length);
  const queue: number[] = [];
  for (let r = 0; r < region.length; r++) {
    const c = region[r];
    for (let d = 0; d < 8; d++) {
      const j = border[c] === 0 ? c + off[d] : g.nbr(c, d);
      if (j < 0 || taken[j] !== 2) {
        dist[r] = 1;
        queue.push(r);
        break;
      }
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const r = queue[q];
    const c = region[r];
    for (let d = 0; d < 8; d++) {
      const j = border[c] === 0 ? c + off[d] : g.nbr(c, d);
      if (j < 0) continue;
      const s = index.get(j);
      if (s !== undefined && dist[s] === 0) {
        dist[s] = dist[r] + 1;
        queue.push(s);
      }
    }
  }
  return dist;
}
