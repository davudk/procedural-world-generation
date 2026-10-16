import { boxBlur } from '../grid/ops';
import {
  areaFactor, aridityAt, bigRegions, centreOf, coarseNoise, coarsen, concavity, DiskSet, drains, DX8, DY8, forDisk, poisson, refineCoarse,
  settleFixed, snapshot, sstep, stampRadial, strataField,
} from './profiles';
import type { LandformCtx } from './types';

/** Width of the riser within one terrace step (share of the step height). */
const RISER = 0.35;

/**
 * The arid set (FEATURES A10, A11, A16, H3–H7; research 01 §6.3, research 05 rows 29, 37):
 * - Caprock terracing: in arid (P/PET < ~0.5), uplifted (> 150 m) cells on layered rock
 *   (base.strata > 0) heights are pulled down onto treads of a world-constant step T (140–220 m,
 *   the caprock thickness scale). The terrace map only lowers and is monotone in height, so channels
 *   keep their course; cells that would become new pits are lifted back (never above their original
 *   height). Dissected tablelands turn into stepped mesas and buttes with escarpments at the risers.
 * - Ergs: low-relief arid basins (below the 40 km regional mean, hyper-arid to arid) shaped by
 *   province-scale noise, scaled by density_arid. Mask `erg` (0–255) drives dunes in the detail
 *   shader; mask `dunes` holds the prevailing sand-moving wind as 1 + 254·(azimuth/2π) (0 = none),
 *   from the latitude wind belts (trades / westerlies / polar easterlies).
 * - Inselbergs: bornhardt domes on old (geologicAge) low-relief plains, Poisson count per plain area
 *   scaled by density_relief, rejected where they would dam drainage.
 * Masks: `erg`, `dunes`, `mesa` (terrace weight 0–255).
 */
export function applyArid(c: LandformCtx): void {
  const snap = snapshot(c);
  const { n, h, fixed } = c;
  const N = n * n;
  const ck = c.cellKm;
  const rng = c.rng('arid');
  const T = rng.range(140, 220);
  const af = areaFactor(c);

  // ── Caprock terracing ──────────────────────────────────────────────────────────────────────
  const w = new Float32Array(N);
  const level = new Int16Array(N).fill(-1);
  const changed: number[] = [];
  const strata = strataField(c);
  for (let i = 0; i < N; i++) {
    if (strata[i] <= 20 || fixed[i] || h[i] <= 150) continue;
    const aF = 1 - sstep(0.15, 0.5, aridityAt(c, i));
    if (aF <= 0) continue;
    const sF = sstep(20, 80, strata[i]);
    const wi = aF * sF * sstep(150, 500, h[i]) * (1 - c.ice[i]);
    if (wi < 0.01) continue;
    w[i] = wi;
    const z = h[i];
    const k = Math.floor(z / T);
    const f = z / T - k;
    const g = f < 1 - RISER ? 0 : ((f - (1 - RISER)) / RISER) ** 2;
    h[i] = z - 0.95 * wi * (z - T * (k + g));
    level[i] = k;
    changed.push(i);
  }
  // New pits from spatially varying weights: lift back just above the lowest neighbour.
  const wasPit = (i: number): boolean => {
    const x = i % n;
    const y = (i - x) / n;
    if (x === 0 || y === 0 || x === n - 1 || y === n - 1) return false;
    for (let k = 0; k < 8; k++) if (snap.h[i + DY8[k] * n + DX8[k]] < snap.h[i]) return false;
    return true;
  };
  let repaired = 0;
  for (let pass = 0; pass < 4; pass++) {
    let fixes = 0;
    for (const i of changed) {
      if (drains(c, i) || wasPit(i)) continue;
      let lo = Infinity;
      for (let k = 0; k < 8; k++) lo = Math.min(lo, h[i + DY8[k] * n + DX8[k]]);
      h[i] = Math.min(snap.h[i], lo + 0.1);
      fixes++;
    }
    repaired += fixes;
    if (fixes === 0) break;
  }

  // Mesa tops: connected cells of one tread level with only lower levels around them.
  const zone = (i: number): boolean => w[i] > 0.4;
  const seen = new Uint8Array(N);
  const stack: number[] = [];
  const topMask = new Uint8Array(N);
  let mesas = 0;
  let buttes = 0;
  for (const s of changed) {
    if (!zone(s) || seen[s]) continue;
    const k = level[s];
    const cells: number[] = [];
    let isTop = true;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % n;
      const y = (i - x) / n;
      for (let d = 0; d < 8; d++) {
        const xx = x + DX8[d];
        const yy = y + DY8[d];
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const j = yy * n + xx;
        if (snap.h[j] >= (k + 1) * T) isTop = false;
        if (d < 4 && !seen[j] && zone(j) && level[j] === k) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (!isTop || k < 1) continue;
    const km2 = cells.length * ck * ck;
    if (km2 > 150) continue;
    if (km2 < 2) buttes++;
    else mesas++;
    for (const i of cells) topMask[i] = 1;
  }

  // Escarpments: risers of at least half a step between neighbouring cells.
  const esc = new Uint8Array(N);
  for (const i of changed) {
    if (w[i] < 0.3) continue;
    const x = i % n;
    const y = (i - x) / n;
    if (x === 0 || y === 0 || x === n - 1 || y === n - 1) continue;
    let lo = Infinity;
    for (let k = 0; k < 8; k++) lo = Math.min(lo, h[i + DY8[k] * n + DX8[k]]);
    if (h[i] - lo >= 0.5 * T) esc[i] = 1;
  }
  const escs = changed.length ? bigRegions(c, esc, 40 * ck, Math.ceil(10 * af)).list : [];
  for (const e of escs) c.features.push({ type: 'escarpment', x: e.x * 1000, y: e.y * 1000, size: (e.km2 / ck) * 1000, data: { step: T } });

  const zoneMask = new Uint8Array(N);
  const mesaMask = new Uint8Array(N);
  for (const i of changed) {
    mesaMask[i] = Math.round(255 * w[i]);
    if (zone(i)) zoneMask[i] = 1;
  }
  const { list: fields, label } = changed.length ? bigRegions(c, zoneMask, 400, Math.ceil(10 * af)) : { list: [], label: new Int32Array(0) };
  if (fields.length) {
    const tops = new Map<number, number>();
    for (let i = 0; i < N; i++) if (topMask[i] && label[i] >= 0) tops.set(label[i], (tops.get(label[i]) ?? 0) + 1);
    for (const f of fields) {
      c.features.push({ type: 'mesa-field', x: f.x * 1000, y: f.y * 1000, size: Math.sqrt(f.km2) * 1000, data: { areaKm2: f.km2, tops: tops.get(f.label) ?? 0, step: T } });
    }
  }
  c.masks.set('mesa', mesaMask);

  // ── Ergs (sand seas) ───────────────────────────────────────────────────────────────────────
  // Regional fields on a ~4 km lattice: 8 km mean slope and the 40 km regional mean height.
  const co = coarsen(c, h);
  const cm = co.m;
  const ckC = ck * co.f;
  const sC = new Float32Array(cm * cm);
  for (let y = 1; y < cm - 1; y++) {
    for (let x = 1; x < cm - 1; x++) {
      const i = y * cm + x;
      sC[i] = Math.hypot(co.g[i + 1] - co.g[i - 1], co.g[i + cm] - co.g[i - cm]) / (2 * ckC * 1000);
    }
  }
  boxBlur(sC, cm, Math.max(1, Math.round(8 / ckC)));
  const slope = refineCoarse(c, sC, cm, co.f);
  boxBlur(co.g, cm, Math.max(1, Math.round(40 / ckC)), 2);
  const reg = refineCoarse(c, co.g, cm, co.f);
  const shape = coarseNoise(c, rng.nextU32(), [{ km: 300, octaves: 3, weight: 1 }]);
  const dens = c.num('density_arid');
  const erg = new Uint8Array(N);
  const dunes = new Uint8Array(N);
  let ergCells = 0;
  for (let i = 0; i < N; i++) {
    if (fixed[i] || h[i] <= 0 || c.ice[i] > 0.1) continue;
    const ai = aridityAt(c, i);
    if (ai > 0.16) continue;
    const s = (1 - sstep(0.04, 0.16, ai)) * (1 - sstep(0.006, 0.025, slope[i])) * (1 - sstep(-40, 150, h[i] - reg[i]))
      * (0.6 + 0.8 * (0.5 + 0.5 * shape[i])) * (1 - w[i]);
    const v = Math.round(255 * sstep(0.3, 0.55, s * dens));
    if (v <= 0) continue;
    erg[i] = v;
    ergCells++;
    dunes[i] = windCode(c.climate.lat[i]);
  }
  const ergBig = new Uint8Array(N);
  for (let i = 0; i < N; i++) ergBig[i] = erg[i] >= 128 ? 1 : 0;
  const ergs = bigRegions(c, ergBig, 2000, Math.ceil(6 * af)).list;
  for (const e of ergs) c.features.push({ type: 'erg', x: e.x * 1000, y: e.y * 1000, size: Math.sqrt(e.km2) * 1000, data: { areaKm2: e.km2 } });
  c.masks.set('erg', erg);
  c.masks.set('dunes', dunes);

  // ── Inselbergs on old low plains ───────────────────────────────────────────────────────────
  const plain = (i: number): boolean => !fixed[i] && h[i] > 20 && h[i] < 900 && slope[i] < 0.012 && w[i] < 0.1 && erg[i] < 64 && c.ice[i] < 0.05;
  let plainCells = 0;
  for (let i = 0; i < N; i++) if (plain(i)) plainCells++;
  const age = c.num('geologicAge');
  const irng = c.rng('inselbergs');
  const lambda = ((plainCells * ck * ck) / 1e5) * 6 * sstep(0.3, 0.9, age) * c.num('density_relief');
  const want = Math.min(Math.ceil(40 * af), poisson(irng, lambda));
  const idisk = new DiskSet(25);
  let inselbergs = 0;
  for (let t = 0; t < want * 40 && inselbergs < want && plainCells > 0; t++) {
    const i = irng.int(N);
    if (!plain(i) || concavity(c, i) < -1) continue;
    const p = centreOf(c, i);
    if (!idisk.free(p.x, p.y, 25)) continue;
    const r = irng.range(1.2, 3.5);
    const hi = irng.range(120, 450) * (0.6 + 0.4 * age);
    const b = h[i];
    const saved: [number, number][] = [];
    forDisk(c, p.x, p.y, r + 2 * ck, (cell) => saved.push([cell, h[cell]]));
    stampRadial(c, p.x, p.y, r, 'max', (rr) => b + hi * Math.sqrt(Math.max(0, 1 - (rr / r) ** 2.5)));
    if (!saved.every(([cell]) => drains(c, cell) || wasPit(cell))) {
      for (const [cell, v] of saved) h[cell] = v;
      continue;
    }
    idisk.add(p.x, p.y);
    c.features.push({ type: 'inselberg', x: p.x * 1000, y: p.y * 1000, size: 2 * r * 1000, data: { height: hi } });
    inselbergs++;
  }

  c.stats['terraceStepM'] = T;
  c.stats['terracedKm2'] = changed.length * ck * ck;
  c.stats['terracePitsRepaired'] = repaired;
  c.stats['mesas'] = mesas;
  c.stats['buttes'] = buttes;
  c.stats['mesaFields'] = fields.length;
  c.stats['escarpments'] = escs.length;
  c.stats['ergKm2'] = ergCells * ck * ck;
  c.stats['ergs'] = ergs.length;
  c.stats['inselbergs'] = inselbergs;
  c.stats['aridDrowned'] = settleFixed(c, snap);
}

/**
 * Prevailing sand-moving wind (the direction it blows towards) from the latitude belts, encoded as
 * 1 + 254·(azimuth / 2π) with azimuth measured from +x (east) towards +y (south on the map).
 */
function windCode(lat: number): number {
  const a = Math.abs(lat);
  const north = lat >= 0;
  let vx: number;
  let vy: number;
  if (a < 30) {
    vx = -1; // trades: NE (north) / SE (south) winds blowing towards the equator and west
    vy = north ? 0.6 : -0.6;
  } else if (a < 60) {
    vx = 1; // westerlies: blowing towards the pole and east
    vy = north ? -0.5 : 0.5;
  } else {
    vx = -1;
    vy = north ? 0.4 : -0.4;
  }
  let az = Math.atan2(vy, vx);
  if (az < 0) az += Math.PI * 2;
  return 1 + Math.round((254 * az) / (Math.PI * 2));
}
