import { COAST, classifyCoast } from './coast/classify';
import { placeBarriers } from './coast/barriers';
import { placeCliffs } from './coast/cliffs';
import { reconcileFixed } from './coast/fixed';
import { chamferNearest, components8 } from './coast/grid';
import { placeReefs } from './coast/reefs';
import { placeRias } from './coast/rias';
import type { LandformCtx } from './types';

/**
 * M6 coastal landforms (FEATURES F10–F21): classify the coast (exposure from fetch along the wind
 * and the compass directions, relief, shelf depth, ice) into sandy / rocky / sheltered / ice, then
 *   rias on ice-free hilly coasts (lower drowned valley floors),
 *   sea cliffs and sea stacks on high exposed coasts,
 *   barrier islands, lagoons, spits and tombolos on low sandy coasts,
 *   fringing and barrier coral reefs and atolls in warm water,
 * and finally re-derive `fixed` (sea connected to the old sea; cut-off lagoons become depressions).
 * Masks: `cliff`, `reef`, `beach`, `marsh` (salt marsh / mangrove hint). Deltas are left to hydrology.
 */
export function applyCoastal(c: LandformCtx): void {
  const { n, h } = c;
  const N = n * n;
  const t0 = performance.now();
  let tLap = t0;
  const lap = (key: string): void => {
    const now = performance.now();
    c.stats[`coastal_ms_${key}`] = Math.round((now - tLap) * 10) / 10;
    tLap = now;
  };
  const hBefore = h.slice();
  const fixedBefore = c.fixed.slice();
  let landBefore = 0;
  for (let i = 0; i < N; i++) if (h[i] > 0) landBefore++;

  const info = classifyCoast(c);
  lap('classify');
  const edited = new Uint8Array(N);
  const cliff = new Uint8Array(N);
  const reef = new Uint8Array(N);
  const beach = new Uint8Array(N);
  const marsh = new Uint8Array(N);

  const rias = placeRias(c, info, edited);
  lap('rias');
  const cl = placeCliffs(c, info, edited, cliff);
  lap('cliffs');

  const land = new Uint8Array(N);
  for (let i = 0; i < N; i++) land[i] = info.sea[i] ? 0 : 1;
  const { dist, nearest } = chamferNearest(land, n);
  lap('distance');
  const bar = placeBarriers(c, info, dist, nearest, edited, beach, marsh, landBefore);
  lap('barriers');
  const rf = placeReefs(c, info, dist, nearest, edited, reef);
  lap('reefs');

  // Beach and marsh hints on the remaining natural shore (biome rule 4: exposed → beach, sheltered → marsh).
  const lowH = Math.max(5, 10 * c.cellKm);
  for (let k = 0; k < info.cells.length; k++) {
    const i = info.cells[k];
    if (h[i] <= 0 || cliff[i] >= 40) continue;
    const kc = info.cls[k];
    if (kc === COAST.SANDY && h[i] < 2 * lowH) beach[i] = Math.max(beach[i], Math.round(255 * Math.min(1, 0.4 + info.wave[k])));
    else if (kc === COAST.SHELTERED && h[i] < lowH && !beach[i]) marsh[i] = 255;
  }

  const fixed = reconcileFixed(h, fixedBefore, hBefore, n);
  c.fixed.set(fixed);
  lap('fixed');

  // Lagoons behind barrier islands: open (tidal inlets) or enclosed (a coastal lake for hydrology).
  const lc = components8(bar.lagoon, n);
  const enclosed = new Uint8Array(lc.sizes.length).fill(1);
  const sx = new Float64Array(lc.sizes.length);
  const sy = new Float64Array(lc.sizes.length);
  for (let i = 0; i < N; i++) {
    const l = lc.label[i];
    if (l < 0) continue;
    if (c.fixed[i]) enclosed[l] = 0;
    sx[l] += i % n;
    sy[l] += Math.floor(i / n);
  }
  let lagoons = 0;
  let lagoonsEnclosed = 0;
  for (let l = 0; l < lc.sizes.length; l++) {
    if (lc.sizes[l] < 2) continue;
    lagoons++;
    lagoonsEnclosed += enclosed[l];
    c.features.push({
      type: 'lagoon', x: (sx[l] / lc.sizes[l] + 0.5) * c.cellKm * 1000, y: (sy[l] / lc.sizes[l] + 0.5) * c.cellKm * 1000,
      size: Math.sqrt(lc.sizes[l]) * c.cellKm * 1000, data: { areaKm2: lc.sizes[l] * c.cellKm * c.cellKm, enclosed: enclosed[l] },
    });
  }

  // Masks stay consistent with the terrain: shore hints on land only, reefs on water (and motu).
  let landAfter = 0;
  for (let i = 0; i < N; i++) {
    if (h[i] > 0) landAfter++;
    else {
      beach[i] = 0;
      marsh[i] = 0;
      cliff[i] = 0;
    }
    if (beach[i] && marsh[i]) marsh[i] = 0;
  }
  c.masks.set('cliff', cliff);
  c.masks.set('reef', reef);
  c.masks.set('beach', beach);
  c.masks.set('marsh', marsh);

  const L = info.lengthKm;
  Object.assign(c.stats, {
    coastKm: Math.round(L.total),
    coastKm_sandy: Math.round(L.sandy),
    coastKm_rocky: Math.round(L.rocky),
    coastKm_sheltered: Math.round(L.sheltered),
    coastKm_ice: Math.round(L.ice),
    coastKm_cliff: Math.round(cl.km),
    barrierIslands: bar.islands,
    lagoons,
    lagoonsEnclosed,
    spits: bar.spits,
    tombolos: bar.tombolos,
    rias,
    seaStacks: cl.stacks,
    reefTracts: rf.reefs,
    reefCells: rf.fringingCells + rf.barrierCells,
    barrierReefCells: rf.barrierCells,
    atolls: rf.atolls,
    warmOceanKm2: Math.round(rf.warmOceanKm2),
    coastalLandDelta: landBefore > 0 ? Math.round(((landAfter - landBefore) / landBefore) * 1e5) / 1e5 : 0,
    coastal_ms: Math.round((performance.now() - t0) * 10) / 10,
  });
}
