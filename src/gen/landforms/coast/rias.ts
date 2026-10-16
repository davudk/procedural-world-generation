import type { LandformCtx } from '../types';
import { COAST, type CoastInfo } from './classify';
import { DiskSet, DX8, DY8, poisson, shuffle } from './grid';

// Local copies: hot loops should not read the imported bindings.
const DX = Int8Array.from(DX8);
const DY = Int8Array.from(DY8);

/** Rias per 1000 km of eligible (hilly, ice-free) coast at coastRoughness 1.25 and density 1. */
const RIA_RATE = 1.2;
const RIA_CAP = 12;
const RIA_SPACING_KM = 40;

/**
 * Rias (F17): on ice-free hilly coasts, valleys that reach the sea are drowned into narrow inlets.
 * From a valley mouth (a low coastal cell with higher ground on both sides) walk up the valley floor
 * (always to the lowest unvisited land neighbour) while the floor stays below the drowning level,
 * then lower the floor (and low side cells) by that level. Only lowers cells. Fjord coasts (glacier
 * ice nearby, or a deep trough offshore) are skipped: the glacial stage owns those.
 */
export function placeRias(c: LandformCtx, info: CoastInfo, edited: Uint8Array): number {
  const { n, cellKm, h, ice } = c;
  const { sea, cells, cls, relief } = info;
  const rng = c.rng('coastal', 'rias');
  const ring = Math.max(1, Math.round(3 / cellKm));
  const cand: { i: number; score: number }[] = [];
  let eligibleKm = 0;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (cls[k] !== COAST.ROCKY && !(cls[k] === COAST.SHELTERED && relief[k] > 40)) continue;
    if (Math.abs(c.climate.lat[i]) > 58) continue;
    eligibleKm += cellKm;
    if (h[i] > 30) continue;
    const x = i % n;
    const y = (i - x) / n;
    // Valley mouth: the surrounding land within ~3 km stands well above the cell; no ice, no trough.
    let sum = 0;
    let cnt = 0;
    let iceMax = 0;
    let deep = 0;
    for (let dy = -ring - 1; dy <= ring + 1; dy++) {
      for (let dx = -ring - 1; dx <= ring + 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const j = yy * n + xx;
        iceMax = Math.max(iceMax, ice[j]);
        if (sea[j]) deep = Math.min(deep, h[j]);
        else if (Math.max(Math.abs(dx), Math.abs(dy)) >= ring) {
          sum += h[j];
          cnt++;
        }
      }
    }
    if (iceMax > 0.02 || deep < -250 || cnt === 0) continue;
    const conc = sum / cnt - h[i];
    if (conc < 25) continue;
    cand.push({ i, score: conc });
  }
  const roughMul = Math.max(0.3, 1 + 6 * (c.num('coastRoughness') - 1.25));
  const want = Math.min(RIA_CAP, poisson(rng, (RIA_RATE * roughMul * c.num('density_coast') * eligibleKm) / 1000));
  if (want === 0 || cand.length === 0) return 0;
  shuffle(rng, cand);
  cand.sort((a, b) => b.score - a.score);
  // Take from the better half at random, so the deepest valleys are favoured but not exclusively.
  const pool = cand.slice(0, Math.max(want * 4, Math.ceil(cand.length / 2)));
  shuffle(rng, pool);
  const disk = new DiskSet(RIA_SPACING_KM);
  const visited = new Uint8Array(n * n);
  let made = 0;
  const maxSteps = Math.max(3, Math.round(35 / cellKm));
  for (const { i } of pool) {
    if (made >= want) break;
    const px = ((i % n) + 0.5) * cellKm;
    const py = (Math.floor(i / n) + 0.5) * cellKm;
    if (!disk.free(px, py)) continue;
    const level = rng.range(25, 70);
    const path = [i];
    visited[i] = 1;
    let cur = i;
    while (path.length < maxSteps) {
      const x = cur % n;
      const y = (cur - x) / n;
      let best = -1;
      for (let d = 0; d < 8; d++) {
        const xx = x + DX[d];
        const yy = y + DY[d];
        if (xx < 1 || yy < 1 || xx >= n - 1 || yy >= n - 1) continue;
        const j = yy * n + xx;
        if (sea[j] || visited[j] || c.fixed[j]) continue;
        if (best < 0 || h[j] < h[best]) best = j;
      }
      if (best < 0 || h[best] >= level || h[best] < h[cur] - 2 || ice[best] > 0.02) break;
      visited[best] = 1;
      path.push(best);
      cur = best;
    }
    const minLen = Math.max(2, Math.round(6 / cellKm));
    if (path.length < minLen) {
      for (const j of path) visited[j] = 0;
      continue;
    }
    for (const j of path) {
      h[j] = Math.min(h[j] - level, -1);
      edited[j] = 1;
    }
    // Widen: low side cells drown too where the same level puts them under water.
    for (const j of path) {
      const x = j % n;
      const y = (j - x) / n;
      for (let d = 0; d < 8; d++) {
        const xx = x + DX[d];
        const yy = y + DY[d];
        if (xx < 1 || yy < 1 || xx >= n - 1 || yy >= n - 1) continue;
        const q = yy * n + xx;
        if (sea[q] || c.fixed[q] || h[q] <= 0) continue;
        if (h[q] - level <= -1) {
          h[q] = h[q] - level;
          edited[q] = 1;
        }
      }
    }
    disk.add(px, py);
    made++;
    c.features.push({ type: 'ria', x: px * 1000, y: py * 1000, size: path.length * cellKm * 1000, data: { depth: level } });
  }
  return made;
}
