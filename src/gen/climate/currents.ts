import { asCube } from '../grid/cube';
import { cellIndex, type Grid } from '../grid/grid';
import { smoothstep } from '../grid/ops';
import { gaussBlur } from '../grid/smooth';
import { distanceAlong, eastWest } from './sphere';
import { LatTable } from './tables';

/** e-folding distance of a coastal current anomaly offshore (km). */
const CURRENT_KM = 300;

const band = (a: number, lo: number, hi: number): number => smoothstep(lo - 4, lo + 4, a) * (1 - smoothstep(hi - 4, hi + 4, a));

/** ΔSST for an ocean cell with land to its east (the continent's west coast), research 03 §1.4. */
const westCoast = new LatTable((a) => -4 * band(a, 12, 35) + 4 * band(a, 45, 68));
/** ΔSST for an ocean cell with land to its west (the continent's east coast). */
const eastCoast = new LatTable((a) => 2 * band(a, 15, 40) - 4 * band(a, 42, 60));

/**
 * Sea-surface temperature anomaly (°C) from the coastline-orientation heuristic of research 03 §1.4:
 * two row sweeps give the distance to land east and west of every sea cell. The SH is mirrored via
 * |φ|. With `edgeIsLand` the map edge counts as a coast. Blurred over the sea (σ 20 km) so the row
 * sweeps leave no horizontal streaks. Zero on land. On the sphere the rows are chains of east / west
 * neighbours along the local parallel, and every ocean has both kinds of coast.
 */
export function sstAnomaly(sea: Uint8Array, lat: Float32Array, g: Grid, edgeIsLand: boolean): Float32Array {
  const { n, cellKm, cells: N } = g;
  const out = new Float32Array(N);
  if (g.shape === 'sphere') {
    const c = asCube(g);
    const { east, west } = eastWest(c);
    const farKm = 2 * n * cellKm;
    const dE = distanceAlong(c, sea, east, farKm);
    const dW = distanceAlong(c, sea, west, farKm);
    const fall = (d: number): number => (d >= farKm ? 0 : Math.exp(-d / CURRENT_KM));
    for (let i = 0; i < N; i++) if (sea[i]) out[i] = westCoast.at(lat[i]) * fall(dE[i]) + eastCoast.at(lat[i]) * fall(dW[i]);
    return normalisedBlur(out, sea, g);
  }
  const far = 2 * n;
  const fall = Float32Array.from({ length: 2 * n + 1 }, (_, d) => (d >= 2 * n ? 0 : Math.exp((-d * cellKm) / CURRENT_KM)));
  const dE = new Int32Array(n);
  for (let y = 0; y < n; y++) {
    let d = edgeIsLand ? 0 : far;
    for (let x = n - 1; x >= 0; x--) {
      d = sea[cellIndex(g, x, y)] ? Math.min(far, d + 1) : 0;
      dE[x] = d;
    }
    d = edgeIsLand ? 0 : far;
    for (let x = 0; x < n; x++) {
      const i = cellIndex(g, x, y);
      d = sea[i] ? Math.min(far, d + 1) : 0;
      if (!sea[i]) continue;
      out[i] = westCoast.at(lat[i]) * fall[dE[x]] + eastCoast.at(lat[i]) * fall[d];
    }
  }
  return normalisedBlur(out, sea, g);
}

function normalisedBlur(out: Float32Array, sea: Uint8Array, g: Grid): Float32Array {
  const { cellKm, cells: N } = g;
  // Normalised convolution: land cells carry no anomaly and must not dilute the coastal values.
  const w = Float32Array.from(sea);
  gaussBlur(out, g, 20 / cellKm);
  gaussBlur(w, g, 20 / cellKm);
  for (let i = 0; i < N; i++) out[i] = sea[i] && w[i] > 1e-4 ? out[i] / w[i] : 0;
  return out;
}
