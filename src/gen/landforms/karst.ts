import {
  areaFactor, aridityAt, bigRegions, centreOf, coarseNoise, concavity, DiskSet, drains, poisson, settleFixed, snapshot, sstep,
} from './profiles';
import type { LandformCtx } from './types';

/** Macro-grid dolines per km² of karst at density 1 (one pit per ~40 km²; the real ones are sub-cell). */
const DOLINES_PER_KM2 = 1 / 40;

/**
 * Karst (FEATURES I1–I4; research 05 row 36):
 * - Limestone provinces: warped province-scale noise thresholded so that `karstShare` of the land is
 *   carbonate, then karstified where the climate is humid (P/PET ≳ 0.5) and ice-free. Mask `karst`
 *   (0–255) = limestone × humidity; it drives polygonal karst in the detail shader.
 * - Dolines: single-cell pits on non-channel karst cells, mostly shallow (5–14 m: hydrology breaches
 *   them, as in real karst that drains underground), ~12 % deep enough to hold ponds.
 * - Tower karst: in tropical karst (T > 20 °C, P > 1200 mm) isolated cells rise as steep towers
 *   (80–220 m, damped on coarse grids), rejected where they would dam drainage.
 * - Cenotes: deep (20–60 m) pits in flat, low, near-coast warm karst; the hydro stage floods them.
 * Counts are in physical units (per km² of karst) × density_karst and capped.
 */
export function applyKarst(c: LandformCtx): void {
  const snap = snapshot(c);
  const { h, fixed } = c;
  const { cells: N, border, off8Axial } = c.grid;
  const ck = c.cellKm;
  const ckm2 = ck * ck;
  const af = areaFactor(c);
  const rng = c.rng('karst');
  const share = c.num('karstShare');
  const dens = c.num('density_karst');
  const mask = new Uint8Array(N);
  c.masks.set('karst', mask);
  if (share <= 0) {
    c.stats['karstKm2'] = 0;
    return;
  }

  // Limestone: the top `share` of land by a province-scale noise (warped by a finer one).
  const lime = coarseNoise(c, rng.nextU32(), [{ km: 260, octaves: 3, weight: 1 }, { km: 60, octaves: 2, weight: 0.25 }]);
  const buf = new Float32Array(Math.ceil(N / 7));
  let ns = 0;
  for (let i = 0; i < N; i += 7) if (!fixed[i] && h[i] > 0) buf[ns++] = lime[i];
  if (ns === 0) {
    c.stats['karstKm2'] = 0;
    return;
  }
  const sample = buf.subarray(0, ns).sort();
  const cut = sample[Math.min(sample.length - 1, Math.floor((1 - Math.min(1, share)) * sample.length))];

  let karstCells = 0;
  const tropic = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (fixed[i] || h[i] <= 0) continue;
    const l = sstep(cut, cut + 0.03, lime[i]);
    if (l <= 0) continue;
    const v = Math.round(255 * l * sstep(0.45, 0.8, aridityAt(c, i)) * (1 - Math.min(1, c.ice[i] * 3)));
    if (v <= 0) continue;
    mask[i] = v;
    if (v >= 128) {
      karstCells++;
      if (c.climate.temp[i] > 20 && c.climate.precip[i] > 1200 && h[i] < 800) tropic[i] = 1;
    }
  }

  const karstAreas = karstCells === 0 ? [] : bigRegions(c, toBinary(mask, 128), 500, Math.ceil(8 * af)).list;
  for (const k of karstAreas) c.features.push({ type: 'karst', x: k.x * 1000, y: k.y * 1000, size: Math.sqrt(k.km2) * 1000, data: { areaKm2: k.km2 } });
  const towerAreas = karstCells === 0 ? [] : bigRegions(c, tropic, 300, Math.ceil(6 * af)).list;
  for (const k of towerAreas) c.features.push({ type: 'tower-karst', x: k.x * 1000, y: k.y * 1000, size: Math.sqrt(k.km2) * 1000, data: { areaKm2: k.km2 } });

  const isolated = (i: number, marks: Uint8Array): boolean => {
    if (border[i]) return false;
    for (let k = 0; k < 8; k++) if (marks[i + off8Axial[k]]) return false;
    return true;
  };

  // ── Dolines ────────────────────────────────────────────────────────────────────────────────
  const drng = c.rng('dolines');
  const pDoline = Math.min(0.25, DOLINES_PER_KM2 * ckm2 * dens);
  const dCap = Math.ceil(4000 * af);
  const pits = new Uint8Array(N);
  let dolines = 0;
  let deep = 0;
  for (let i = 0; i < N && dolines < dCap; i++) {
    if (mask[i] < 128 || drng.float() > pDoline) continue;
    if (h[i] < 10 || !isolated(i, pits) || concavity(c, i) < -2) continue;
    const isDeep = drng.float() < 0.12;
    const d = Math.min(h[i] - 1, isDeep ? drng.range(18, 40) : drng.range(5, 14));
    if (d <= 0) continue;
    h[i] -= d;
    pits[i] = 1;
    dolines++;
    if (isDeep) deep++;
  }

  // ── Tower karst ────────────────────────────────────────────────────────────────────────────
  const trng = c.rng('towers');
  const pTower = Math.min(0.3, (ckm2 / 6) * dens);
  const tCap = Math.ceil(3000 * af);
  const towersMark = new Uint8Array(N);
  let towers = 0;
  for (let i = 0; i < N && towers < tCap; i++) {
    if (!tropic[i] || pits[i] || trng.float() > pTower) continue;
    if (!isolated(i, towersMark) || concavity(c, i) < 0) continue;
    const before = h[i];
    h[i] += trng.range(80, 220) * Math.min(1, Math.sqrt(1.5 / ck));
    // Isolated cells are interior, so all eight neighbours exist.
    let ok = true;
    for (let k = 0; k < 8 && ok; k++) ok = drains(c, i + off8Axial[k]);
    if (!ok) {
      h[i] = before;
      continue;
    }
    towersMark[i] = 1;
    towers++;
  }

  // ── Cenotes: flat, low, near-coast warm karst ──────────────────────────────────────────────
  const crng = c.rng('cenotes');
  const flatWarm: number[] = [];
  for (let i = 0; i < N; i++) {
    if (mask[i] < 128 || pits[i] || towersMark[i] || h[i] > 150 || h[i] < 5) continue;
    if (c.climate.temp[i] < 18 || c.climate.coastKm[i] > 120 || Math.abs(concavity(c, i)) > 8) continue;
    flatWarm.push(i);
  }
  const want = Math.min(Math.ceil(20 * af), poisson(crng, ((flatWarm.length * ckm2) / 1e4) * 2 * dens));
  const cdisk = new DiskSet(15);
  let cenotes = 0;
  for (let t = 0; t < want * 30 && cenotes < want && flatWarm.length; t++) {
    const i = flatWarm[crng.int(flatWarm.length)];
    const p = centreOf(c, i);
    if (!isolated(i, pits) || !cdisk.free(p.x, p.y, 15)) continue;
    const d = Math.min(h[i] - 1, crng.range(20, 60));
    h[i] -= d;
    pits[i] = 1;
    cdisk.add(p.x, p.y);
    c.features.push({ type: 'cenote', x: p.x * 1000, y: p.y * 1000, size: Math.min(ck, 0.3) * 1000, data: { depth: d } });
    cenotes++;
  }

  c.stats['karstKm2'] = karstCells * ckm2;
  c.stats['karstShareLand'] = karstCells / Math.max(1, sample.length * 7);
  c.stats['dolines'] = dolines;
  c.stats['dolinesDeep'] = deep;
  c.stats['karstTowers'] = towers;
  c.stats['cenotes'] = cenotes;
  c.stats['karstDrowned'] = settleFixed(c, snap);
}

function toBinary(m: Uint8Array, t: number): Uint8Array {
  const out = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) out[i] = m[i] >= t ? 1 : 0;
  return out;
}
