import { BIOME } from '../../shared/biomes';
import { candidate } from './candidate';
import { cellAtM, cellX, cellY, insideDistance, label, nearestWhere, pca } from './grid';
import { G, groupOf } from './shared';
import type { Candidate, RegistryInput, Shared } from './types';

/**
 * Biome regions on the regional grid: deserts, great forests (taiga / temperate / tropical) and
 * wetlands as large components of cells where the group holds the majority (wetlands ≥ 35 %), anchored
 * at the pole of inaccessibility; ergs from the landform features; ice caps and glaciers as
 * components of the glacier ice cover on the macro grid.
 */
export function detectRegions(I: RegistryInput, S: Shared, out: Candidate[]): void {
  const fine = I.fine;
  const R = S.reg;
  const MM = R.cells;
  const f = S.f;
  const share = S.groupShare;
  const rKm2 = (R.cellM / 1000) ** 2;
  const regions = (gr: number[], thr: number, minKm2: number): { cells: number[]; areaKm2: number; pole: number }[] => {
    const mask = new Uint8Array(MM);
    for (let i = 0; i < MM; i++) {
      let s = 0;
      for (const g of gr) s += share[g][i];
      mask[i] = s >= thr ? 1 : 0;
    }
    const comps = label(mask, R, true);
    const inside = insideDistance(mask, R);
    const res: { cells: number[]; areaKm2: number; pole: number }[] = [];
    const cellsOf: number[][] = Array.from({ length: comps.count }, () => []);
    for (let i = 0; i < MM; i++) if (comps.label[i] >= 0) cellsOf[comps.label[i]].push(i);
    for (let k = 0; k < comps.count; k++) {
      const areaKm2 = comps.size[k] * rKm2;
      if (areaKm2 < minKm2) continue;
      let pole = cellsOf[k][0];
      for (const c of cellsOf[k]) if (inside[c] > inside[pole]) pole = c;
      res.push({ cells: cellsOf[k], areaKm2, pole });
    }
    res.sort((a, b) => b.areaKm2 - a.areaKm2);
    return res;
  };
  const anchor = (pole: number): [number, number] => {
    const px = cellX(R, pole);
    const py = cellY(R, pole);
    const fc = nearestWhere(fine, px / I.fine.cellM, py / I.fine.cellM, 3 * f, (c) => !I.sea[c]);
    return fc >= 0 ? [cellX(I.fine, fc), cellY(I.fine, fc)] : [px, py];
  };
  const tempAt = (c: number): number => I.climate.temp[cellAtM(I.fine, cellX(R, c), cellY(R, c))];

  // Deserts.
  for (const r of regions([G.DESERT], 0.5, 6000).slice(0, 4)) {
    const [x, y] = anchor(r.pole);
    let t = 0;
    for (const c of r.cells) t += tempAt(c);
    t /= r.cells.length;
    const ax = pca(r.cells, R);
    out.push(candidate({
      kind: 'desert', x, y, angle: NaN, extentM: Math.max(Math.sqrt(r.areaKm2), ax.length * R.cellM / 1000 * 0.7) * 1000,
      mag: Math.min(1, r.areaKm2 / 150000), data: { areaKm2: Math.round(r.areaKm2), meanTempC: Math.round(t * 10) / 10 },
      idX: cellX(R, r.pole), idY: cellY(R, r.pole), variant: t < -5 ? 'polar' : t < 12 ? 'cold' : 'hot',
      landmass: S.masses.label[cellAtM(I.fine, x, y)],
    }));
  }

  // Great forests: one region per forest group.
  const forests: Candidate[] = [];
  for (const [gr, variant] of [[G.BOREAL, 'taiga'], [G.TEMPERATE, 'forest'], [G.TROPICAL, 'jungle']] as const) {
    for (const r of regions([gr], 0.55, 6000).slice(0, 3)) {
      const [x, y] = anchor(r.pole);
      forests.push(candidate({
        kind: 'forest', x, y, angle: NaN, extentM: Math.sqrt(r.areaKm2) * 1000, mag: Math.min(1, r.areaKm2 / 200000),
        data: { areaKm2: Math.round(r.areaKm2) }, idX: cellX(R, r.pole), idY: cellY(R, r.pole), variant,
        landmass: S.masses.label[cellAtM(I.fine, x, y)],
      }));
    }
  }
  forests.sort((a, b) => b.extentM - a.extentM);
  out.push(...forests.slice(0, Math.max(4, Math.round(S.landKm2 / 60000))));

  // Open country: steppe, savanna, scrub and tundra regions, named by their dominant biome. They fill
  // the interiors that are neither forest nor desert (M8: the emptiest world-band views were savanna
  // and shrubland with no name at all).
  const open: Candidate[] = [];
  for (const [gr, minKm2] of [[G.OPEN, 6000], [G.TUNDRA, 6000]] as const) {
    for (const r of regions([gr], 0.5, minKm2)) {
      const counts = new Map<number, number>();
      for (const c of r.cells) {
        const b = I.biome.biome[cellAtM(I.fine, cellX(R, c), cellY(R, c))];
        if (groupOf(b, 0) === gr) counts.set(b, (counts.get(b) ?? 0) + 1);
      }
      let dom = -1;
      let dc = -1;
      for (const [b, k] of counts) if (k > dc || (k === dc && b < dom)) (dc = k), (dom = b);
      const variant = dom === BIOME.SAVANNA ? 'savanna' : dom === BIOME.STEPPE ? 'steppe' : dom === BIOME.TUNDRA ? 'tundra' : 'scrub';
      const [x, y] = anchor(r.pole);
      open.push(candidate({
        kind: 'grassland', x, y, angle: NaN, extentM: Math.sqrt(r.areaKm2) * 1000, mag: Math.min(1, r.areaKm2 / 200000),
        data: { areaKm2: Math.round(r.areaKm2) }, idX: cellX(R, r.pole), idY: cellY(R, r.pole), variant,
        landmass: S.masses.label[cellAtM(I.fine, x, y)],
      }));
    }
  }
  open.sort((a, b) => b.extentM - a.extentM);
  out.push(...open.slice(0, Math.max(3, Math.round(S.landKm2 / 60000))));

  // Wetlands, named by their dominant wetland biome.
  for (const r of regions([G.WET], 0.35, 800).slice(0, Math.max(5, Math.round(S.landKm2 / 50000)))) {
    const counts = new Map<number, number>();
    for (const c of r.cells) {
      const b = I.biome.biome[cellAtM(I.fine, cellX(R, c), cellY(R, c))];
      if (groupOf(b, 0) === G.WET) counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    let dom: number = BIOME.MARSH;
    let dc = -1;
    for (const [b, k] of counts) if (k > dc || (k === dc && b < dom)) (dc = k), (dom = b);
    const variant = dom === BIOME.SWAMP ? 'swamp' : dom === BIOME.FEN ? 'fen' : dom === BIOME.BOG ? 'bog' : dom === BIOME.MANGROVE ? 'mangrove'
      : dom === BIOME.SALT_MARSH ? 'saltmarsh' : 'marsh';
    const [x, y] = anchor(r.pole);
    out.push(candidate({
      kind: 'wetland', x, y, angle: NaN, extentM: Math.sqrt(r.areaKm2) * 1000, mag: Math.min(1, r.areaKm2 / 30000),
      data: { areaKm2: Math.round(r.areaKm2) }, idX: cellX(R, r.pole), idY: cellY(R, r.pole), variant,
      landmass: S.masses.label[cellAtM(I.fine, x, y)],
    }));
  }

  // Ergs (sand seas).
  const ergs = I.landforms.features.filter((e) => e.type === 'erg' && (e.data?.areaKm2 ?? 0) >= 1500)
    .sort((a, b) => (b.data?.areaKm2 ?? 0) - (a.data?.areaKm2 ?? 0)).slice(0, 3);
  for (const e of ergs) {
    const a = e.data?.areaKm2 ?? 0;
    out.push(candidate({
      kind: 'erg', x: e.x, y: e.y, angle: NaN, extentM: e.size, mag: Math.min(1, a / 40000), data: { areaKm2: Math.round(a) },
      idX: e.x, idY: e.y, hero: { cat: 'sand-sea', score: a / 20000 }, tier: a >= 20000 ? 'rare' : 'uncommon',
      landmass: S.masses.label[cellAtM(I.fine, e.x, e.y)],
    }));
  }

  // Ice caps and glaciers (macro grid).
  const N = fine.cells;
  const ice = new Uint8Array(N);
  for (let c = 0; c < N; c++) ice[c] = !I.sea[c] && (I.landforms.ice[c] >= 0.5 || I.biome.biome[c] === BIOME.ICE) ? 1 : 0;
  const comps = label(ice, fine, true);
  const cellKm2 = (I.fine.cellM / 1000) ** 2;
  const caps: Candidate[] = [];
  const glaciers: Candidate[] = [];
  const ids: number[] = [];
  for (let k = 0; k < comps.count; k++) if (comps.size[k] >= 2 && comps.size[k] * cellKm2 >= 15) ids.push(k);
  ids.sort((a, b) => comps.size[b] - comps.size[a] || a - b);
  for (const k of ids) {
    const areaKm2 = comps.size[k] * cellKm2;
    const cap = areaKm2 >= 3000;
    if ((cap ? caps : glaciers).length >= (cap ? 3 : 10)) continue;
    const cx = comps.sx[k] / comps.size[k] + 0.5;
    const cy = comps.sy[k] / comps.size[k] + 0.5;
    const fc = nearestWhere(fine, cx, cy, Math.max(4, Math.sqrt(comps.size[k])), (c) => comps.label[c] === k);
    const x = fc >= 0 ? cellX(I.fine, fc) : cx * I.fine.cellM;
    const y = fc >= 0 ? cellY(I.fine, fc) : cy * I.fine.cellM;
    (cap ? caps : glaciers).push(candidate({
      kind: cap ? 'icecap' : 'glacier', x, y, angle: NaN, extentM: Math.sqrt(areaKm2) * 1000 * (cap ? 1 : 1.5),
      mag: Math.min(1, Math.log10(areaKm2) / 5), data: { areaKm2: Math.round(areaKm2) }, idX: x, idY: y,
      variant: areaKm2 >= 50000 ? 'sheet' : cap ? 'cap' : 'glacier', landmass: fc >= 0 ? S.masses.label[fc] : -1,
    }));
  }
  out.push(...caps, ...glaciers);
}
