import { cellIndex, cellFace, coarser, cellX as colOf, cellY as rowOf, onFace, tryCellIndex } from '../grid/grid';
import { chamferDistance } from '../grid/ops';
import { candidate, own } from './candidate';
import { blockMean, cellAtM, cellCountKm2, cellX, cellY, compKm2, insideDistance, label, labelAngle, mergeTree, nearestWhereM, resolveOwners, type GridSpec, type MergeTree } from './grid';
import { gradAt } from './shared';
import type { Candidate, RegistryInput, Shared } from './types';

/** Seas need this much water (km²) and a basin centre this far from land (km). */
const SEA_MIN_KM2 = 8000;
const SEA_MIN_DEPTH_KM = 20;
/** Straits: passages at most this wide (km) between two basins of at least STRAIT_SIDE_KM2. */
const STRAIT_MAX_KM = 60;
const STRAIT_SIDE_KM2 = 2000;
/**
 * Oceans on a closed surface (research 10 §5.11): the world ocean (the largest sea body, at least
 * OCEAN_MIN_SHARE of the planet) is split at its narrowest passages. A basin of the distance-from-land
 * merge tree is an ocean nucleus when it holds ≥ OCEAN_NUCLEUS_SHARE of the world ocean, its centre is
 * ≥ OCEAN_DEPTH_FRAC × the equal-area size from land, and the passage joining it to a deeper basin is
 * at most OCEAN_COL × its centre's distance from land; every cell of the world ocean then belongs to
 * the nucleus it drains to in the merge tree (the root is always one), so the oceans partition it.
 */
const OCEAN_MIN_SHARE = 0.1;
const OCEAN_NUCLEUS_SHARE = 0.035;
const OCEAN_DEPTH_FRAC = 0.05;
const OCEAN_COL = 0.7;
const OCEAN_MAX = 5;

/** Partition of the world ocean into named oceans (spheres), on the regional grid. */
export interface OceanSplit {
  /** Per regional cell: index of its ocean in `peaks`, −1 outside the world ocean. */
  of: Int32Array;
  /** Per ocean, largest first: merge-tree peak cell (the point farthest from land) and area (km²). */
  peaks: number[];
  areaKm2: number[];
  /** Area of the world ocean (km²). */
  worldKm2: number;
}

/**
 * Sea landmarks on the regional grid. Basins come from the merge tree of the distance from land over
 * the sea: a basin whose centre lies much farther from land than the passage that joins it to a
 * deeper basin (centre ≥ 2× the passage half-width) is its own sea, and the passage is a strait. The
 * largest basin is the ocean. Gulfs and bays are sea cells enclosed by land along most of 16 rays at
 * two scales (30 km and 120 km). Fjords come from the glacial fjord mask; lagoons, reefs and atolls
 * from the coastal landform features.
 */
export function detectWater(I: RegistryInput, S: Shared, out: Candidate[]): void {
  const R = S.reg;
  const MM = R.cells;
  const rKm = R.cellM / 1000;
  const rKm2 = rKm * rKm;
  // Merge-tree areas are cell counts: the mean cell area on spheres.
  const tKm2 = cellCountKm2(R, rKm2);
  const seaR = new Uint8Array(MM);
  for (let i = 0; i < MM; i++) seaR[i] = 1 - S.land[i];

  // ── Basins and straits ──
  const t = mergeTree(S.dLand, seaR, R, false, 0.05);
  const keep = new Uint8Array(t.count);
  for (let k = 0; k < t.count; k++) {
    const big = t.area[k] * tKm2 >= SEA_MIN_KM2 && t.peakV[k] * rKm >= SEA_MIN_DEPTH_KM;
    keep[k] = big && (t.parent[k] < 0 || t.peakV[k] - t.colV[k] >= 0.5 * t.peakV[k]) ? 1 : 0;
  }
  const ocean = S.sphere ? splitOceans(I, S, t, seaR) : null;
  // Ocean nuclei are named as oceans; the seas are the other basins.
  if (ocean) for (const p of ocean.peaks) keep[t.owner[p]] = 0;
  const res = resolveOwners(t, keep);
  const basin = new Int32Array(MM).fill(-1);
  const bArea = new Float64Array(t.count);
  const edge = new Uint8Array(t.count);
  for (let i = 0; i < MM; i++) {
    if (t.owner[i] < 0) continue;
    const b = res[t.owner[i]];
    basin[i] = b;
    if (b < 0) continue;
    // Spheres: exact cell areas (in units of the nominal rKm2).
    if (R.uniform) bArea[b]++;
    else bArea[b] += R.area(i) / (rKm2 * 1e6);
    // Touches the map edge (flat; on a closed surface the oceans come from splitOceans).
    if (R.border[i] && !S.sphere) edge[b] = 1;
  }
  const basins: number[] = [];
  for (let k = 0; k < t.count; k++) if (keep[k] && bArea[k] > 0) basins.push(k);
  basins.sort((a, b) => bArea[b] - bArea[a] || a - b);
  const worldKm2 = I.worldKm * I.worldKm;
  if (ocean) {
    ocean.peaks.forEach((pk, o) => {
      const [x, y] = snapSea(I, S, cellX(R, pk), cellY(R, pk));
      const areaKm2 = ocean.areaKm2[o];
      out.push(candidate({
        kind: 'ocean', x, y, angle: NaN, extentM: Math.sqrt(areaKm2) * 1000, mag: Math.min(1, areaKm2 / (0.3 * worldKm2)),
        data: { areaKm2: Math.round(areaKm2), maxShoreDistKm: Math.round(S.dLand[pk] * rKm) }, idX: cellX(R, pk), idY: cellY(R, pk),
      }));
    });
    S.oceans = ocean;
  }
  const seaCands: Candidate[] = [];
  basins.forEach((k, idx) => {
    const areaKm2 = bArea[k] * rKm2;
    const isOcean = !ocean && idx === 0 && edge[k] === 1 && areaKm2 >= 0.2 * worldKm2;
    const [x, y] = snapSea(I, S, cellX(R, t.peak[k]), cellY(R, t.peak[k]));
    seaCands.push(candidate({
      kind: isOcean ? 'ocean' : 'sea', x, y, angle: NaN, extentM: Math.sqrt(areaKm2) * 1000,
      mag: Math.min(1, areaKm2 / (0.3 * worldKm2)),
      data: { areaKm2: Math.round(areaKm2), maxShoreDistKm: Math.round(t.peakV[k] * rKm) }, idX: cellX(R, t.peak[k]), idY: cellY(R, t.peak[k]),
    }));
  });
  for (const c of seaCands.slice(0, 7)) out.push(c);

  const straits: Candidate[] = [];
  for (let k = 0; k < t.count; k++) {
    const p = t.parent[k];
    if (p < 0) continue;
    const widthKm = 2 * t.colV[k] * rKm;
    if (widthKm > STRAIT_MAX_KM || t.peakV[k] < 2 * t.colV[k] || t.peakV[k] * rKm < 10) continue;
    if (t.area[k] * tKm2 < STRAIT_SIDE_KM2 || t.area[p] * tKm2 < STRAIT_SIDE_KM2) continue;
    const c = t.col[k];
    const [vx, vy] = gradAt(S.dLand, R, c);
    const [x, y] = snapSea(I, S, cellX(R, c), cellY(R, c));
    straits.push(candidate({
      kind: 'strait', x, y, angle: S.sphere ? S.geo.angleFromCell(R, c, -vy, vx, x, y) : labelAngle(-vy, vx), extentM: Math.max(3 * widthKm, 15) * 1000,
      mag: Math.min(1, Math.min(t.area[k], t.area[p]) * tKm2 / 50000),
      data: { widthKm: Math.max(1, Math.round(widthKm)) }, idX: cellX(R, c), idY: cellY(R, c),
    }));
  }
  straits.sort((a, b) => b.mag - a.mag);
  const keptStraits: Candidate[] = [];
  for (const s of straits) {
    if (keptStraits.length >= 6) break;
    if (keptStraits.some((o) => S.geo.dist(o.x, o.y, s.x, s.y) < 50000)) continue;
    keptStraits.push(s);
  }
  out.push(...keptStraits);

  // ── Gulfs and bays ──
  const gulfs = embayments(I, S, R, 2, 120, 6000, basin, bArea, null);
  gulfs.list.sort((a, b) => b.extentM - a.extentM);
  for (const g of gulfs.list.slice(0, 5)) out.push(g);
  const bays = embayments(I, S, R, 1, 30, 120, basin, bArea, gulfs);
  bays.list.sort((a, b) => b.extentM - a.extentM);
  for (const b of bays.list.slice(0, Math.round(Math.min(20, Math.max(4, S.landKm2 / 15000))))) out.push(b);

  detectFjords(I, S, out);
  coastalFeatures(I, S, out);
}

/** The world ocean of a sphere split into oceans (see OCEAN_*), or null when there is no world ocean. */
function splitOceans(I: RegistryInput, S: Shared, t: MergeTree, seaR: Uint8Array): OceanSplit | null {
  const R = S.reg;
  const MM = R.cells;
  const rKm = R.cellM / 1000;
  const comps = label(seaR, R, false);
  let w = -1;
  for (let k = 0; k < comps.count; k++) if (w < 0 || comps.areaM2![k] > comps.areaM2![w]) w = k;
  if (w < 0) return null;
  const worldKm2 = comps.areaM2![w] / 1e6;
  if (worldKm2 < (OCEAN_MIN_SHARE * R.totalArea) / 1e6) return null;
  const wCells = comps.size[w];
  // Candidate nuclei: basins of the world ocean, biggest first; the root (deepest basin) always.
  const cand: number[] = [];
  let root = -1;
  for (let k = 0; k < t.count; k++) {
    if (comps.label[t.peak[k]] !== w) continue;
    if (t.parent[k] < 0) {
      root = k;
      continue;
    }
    if (t.area[k] < OCEAN_NUCLEUS_SHARE * wCells || t.peakV[k] * rKm < OCEAN_DEPTH_FRAC * I.worldKm) continue;
    if (t.colV[k] > OCEAN_COL * t.peakV[k]) continue;
    cand.push(k);
  }
  if (root < 0) return null;
  cand.sort((a, b) => t.area[b] - t.area[a] || a - b);
  const nuclei = [root, ...cand.slice(0, OCEAN_MAX - 1)];
  const keep = new Uint8Array(t.count);
  for (const k of nuclei) keep[k] = 1;
  const res = resolveOwners(t, keep);
  const idx = new Int32Array(t.count).fill(-1);
  nuclei.forEach((k, o) => (idx[k] = o));
  const of = new Int32Array(MM).fill(-1);
  const areaKm2 = nuclei.map(() => 0);
  for (let i = 0; i < MM; i++) {
    if (comps.label[i] !== w) continue;
    const o = idx[res[t.owner[i]]];
    of[i] = o;
    areaKm2[o] += R.area(i) / 1e6;
  }
  // Largest first (ties by the nucleus index).
  const order = nuclei.map((_, o) => o).sort((a, b) => areaKm2[b] - areaKm2[a] || a - b);
  const rank = new Int32Array(nuclei.length);
  order.forEach((o, r) => (rank[o] = r));
  for (let i = 0; i < MM; i++) if (of[i] >= 0) of[i] = rank[of[i]];
  return { of, peaks: order.map((o) => t.peak[nuclei[o]]), areaKm2: order.map((o) => areaKm2[o]), worldKm2 };
}

/** Nearest sea cell of the macro grid to a map position, as map metres. */
function snapSea(I: RegistryInput, S: Shared, x: number, y: number): [number, number] {
  const fc = nearestWhereM(I.fine, x, y, 4 * S.f, (c) => I.sea[c] === 1);
  return fc >= 0 ? [cellX(I.fine, fc), cellY(I.fine, fc)] : [x, y];
}

interface Embayments {
  list: Candidate[];
  /** Component label per cell of the embayment grid, and that grid. */
  lab: Int32Array;
  g: GridSpec;
  area: Int32Array;
}

/**
 * Sea cells enclosed by land along ≥ 11 of 16 rays of length `radKm`, on the regional grid
 * coarsened by `fac`; components of at least `minKm2` that open onto less enclosed sea.
 */
function embayments(
  I: RegistryInput, S: Shared, R: GridSpec, fac: number, radKm: number, minKm2: number, basin: Int32Array, basinArea: Float64Array,
  parent: Embayments | null,
): Embayments {
  const g = coarser(R, fac);
  const MM = g.cells;
  const gKm = g.cellM / 1000;
  const share = fac === 1 ? S.landShare : blockMean(S.landShare, R, fac);
  const land = new Uint8Array(MM);
  for (let i = 0; i < MM; i++) land[i] = share[i] >= 0.5 ? 1 : 0;
  const dl = fac === 1 ? S.dLand : chamferDistance(land, g);
  const rad = radKm / gKm;
  const DIRS = 16;
  const cosT = new Float64Array(DIRS);
  const sinT = new Float64Array(DIRS);
  for (let d = 0; d < DIRS; d++) {
    cosT[d] = Math.cos((2 * Math.PI * d) / DIRS);
    sinT[d] = Math.sin((2 * Math.PI * d) / DIRS);
  }
  const emb = new Uint8Array(MM);
  const sphere = g.faces !== 1;
  // Rays march straight lines in cells: planar on flat maps; on spheres straight in the extended
  // equal-angle chart of the cell's face, which crosses seams and stays close to a great circle.
  for (let i = 0; i < MM; i++) {
    if (land[i] || dl[i] > rad) continue;
    const x0 = colOf(g, i) + 0.5;
    const y0 = rowOf(g, i) + 0.5;
    const face = sphere ? cellFace(g, i) : 0;
    let hits = 0;
    for (let d = 0; d < DIRS; d++) {
      for (let s = 1; s <= rad; s += 0.75) {
        const x = Math.floor(x0 + cosT[d] * s);
        const y = Math.floor(y0 + sinT[d] * s);
        if (sphere) {
          const j = tryCellIndex(g, x, y, face);
          if (j < 0) break;
          if (land[j]) {
            hits++;
            break;
          }
          continue;
        }
        if (!onFace(g, x, y)) break;
        if (land[cellIndex(g, x, y)]) {
          hits++;
          break;
        }
      }
      if (hits + (DIRS - 1 - d) < 11) break;
    }
    if (hits >= 11) emb[i] = 1;
  }
  const comps = label(emb, g, false);
  const inside = insideDistance(emb, g);
  const pole = new Int32Array(comps.count).fill(-1);
  const opens = new Uint8Array(comps.count);
  const { off4, border, axialToRaster } = g;
  for (let i = 0; i < MM; i++) {
    const k = comps.label[i];
    if (k < 0) continue;
    if (pole[k] < 0 || inside[i] > inside[pole[k]]) pole[k] = i;
    const b = border[i];
    for (let d = 0; d < 4; d++) {
      const nc = b === 0 ? i + off4[d] : g.nbr(i, axialToRaster[d]);
      if (nc >= 0 && !land[nc] && !emb[nc]) opens[k] = 1;
    }
  }
  const list: Candidate[] = [];
  const gKm2 = gKm * gKm;
  for (let k = 0; k < comps.count; k++) {
    const areaKm2 = compKm2(comps, k, gKm2);
    if (areaKm2 < minKm2 || !opens[k]) continue;
    const px = cellX(g, pole[k]);
    const py = cellY(g, pole[k]);
    // A gulf that is most of a named sea basin is that sea; a bay that is most of a gulf is that gulf.
    const b = basin[cellAtM(R, px, py)];
    if (b >= 0 && basinArea[b] * (R.cellM / 1000) ** 2 < 2.5 * areaKm2) continue;
    if (parent) {
      const pk = parent.lab[cellAtM(parent.g, px, py)];
      if (pk >= 0 && parent.area[pk] * cellCountKm2(parent.g, (parent.g.cellM / 1000) ** 2) < 2.5 * areaKm2) continue;
    }
    const [x, y] = snapSea(I, S, px, py);
    const isGulf = fac > 1 && areaKm2 >= 6000;
    list.push(candidate({
      kind: isGulf ? 'gulf' : 'bay', x, y, angle: NaN, extentM: Math.sqrt(areaKm2) * 1000,
      mag: Math.min(1, Math.log10(areaKm2) / 5), data: { areaKm2: Math.round(areaKm2) }, idX: px, idY: py,
    }));
  }
  return { list, lab: comps.label, g, area: comps.size };
}

/** One fjord per connected trough of the glacial fjord mask; path from the head to the mouth. */
function detectFjords(I: RegistryInput, S: Shared, out: Candidate[]): void {
  const fine = I.fine;
  const { cells: N, cellM, off8Axial: off, border, axialToRaster } = fine;
  const fj = I.landforms.fjord;
  const comps = label(fj, fine, true);
  if (comps.count === 0) return;
  const cellsOf: number[][] = Array.from({ length: comps.count }, () => []);
  for (let i = 0; i < N; i++) if (comps.label[i] >= 0) cellsOf[comps.label[i]].push(i);
  const dist = new Float32Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const found: Candidate[] = [];
  let totalKm = 0;
  for (let k = 0; k < comps.count; k++) {
    const cells = cellsOf[k];
    if (cells.length < 3) continue;
    const queue: number[] = [];
    for (const c of cells) {
      const b = border[c];
      for (let d = 0; d < 4; d++) {
        const nc = b === 0 ? c + off[d] : fine.nbr(c, axialToRaster[d]);
        if (nc < 0) continue;
        if (I.sea[nc] && !fj[nc]) {
          dist[c] = 0;
          queue.push(c);
          break;
        }
      }
    }
    if (queue.length === 0) continue;
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi];
      const b = border[c];
      for (let d = 0; d < 8; d++) {
        const nc = b === 0 ? c + off[d] : fine.nbr(c, axialToRaster[d]);
        if (nc < 0 || comps.label[nc] !== k) continue;
        const nd = dist[c] + (d < 4 ? 1 : Math.SQRT2);
        if (nd < dist[nc] - 1e-6) {
          dist[nc] = nd;
          prev[nc] = c;
          queue.push(nc);
        }
      }
    }
    let head = -1;
    for (const c of cells) if (dist[c] < Infinity && (head < 0 || dist[c] > dist[head])) head = c;
    const lenKm = (dist[head] + 1) * (cellM / 1000);
    totalKm += lenKm;
    if (lenKm < Math.max(8, 2.5 * cellM / 1000)) continue;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let c = head; c >= 0; c = prev[c]) {
      xs.push(cellX(I.fine, c));
      ys.push(cellY(I.fine, c));
    }
    const mid = Math.floor(xs.length / 2);
    const path = S.sphere ? new Float64Array(xs.length * 2) : new Float32Array(xs.length * 2);
    for (let i = 0; i < xs.length; i++) {
      path[2 * i] = xs[i];
      path[2 * i + 1] = ys[i];
    }
    const last = xs.length - 1;
    let angle: number;
    if (S.sphere) {
      const a = new Float64Array(3);
      const b = new Float64Array(3);
      S.geo.dir(xs[0], ys[0], a);
      S.geo.dir(xs[last], ys[last], b);
      angle = S.geo.angleAlong(xs[mid], ys[mid], a, b);
    } else angle = labelAngle(xs[last] - xs[0], ys[last] - ys[0]);
    found.push(candidate({
      kind: 'fjord', x: xs[mid], y: ys[mid], angle, extentM: lenKm * 1000,
      mag: Math.min(1, lenKm / 150), data: { lengthKm: Math.round(lenKm) }, idX: xs[last], idY: ys[last], path,
    }));
  }
  found.sort((a, b) => b.extentM - a.extentM);
  const kept = found.slice(0, 25);
  if (kept.length > 0) {
    kept[0].hero = own({ cat: 'fjord-coast', score: totalKm / 150 });
    kept[0].data.fjordCount = found.length;
    kept[0].data.fjordTotalKm = Math.round(totalKm);
  }
  out.push(...kept);
}

/** Lagoons, reefs and atolls from the coastal landform features. */
function coastalFeatures(I: RegistryInput, S: Shared, out: Candidate[]): void {
  const fs = I.landforms.features;
  const X = (f: (typeof fs)[number]): number => S.geo.enc(f.face, f.x);
  const lagoons = fs.filter((f) => f.type === 'lagoon' && !f.data?.atoll && f.size >= 4000).sort((a, b) => b.size - a.size).slice(0, 8);
  for (const f of lagoons) {
    out.push(candidate({
      kind: 'lagoon', x: X(f), y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, f.size / 40000),
      data: { areaKm2: Math.round(f.data?.areaKm2 ?? (f.size / 1000) ** 2) }, idX: X(f), idY: f.y,
    }));
  }
  const reefs = fs.filter((f) => f.type === 'reef' && f.size >= 10000).sort((a, b) => b.size - a.size).slice(0, 6);
  for (const f of reefs) {
    out.push(candidate({
      kind: 'reef', x: X(f), y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, f.size / 150000),
      data: { lengthKm: Math.round(f.size / 1000), barrier: f.data?.barrier ? 1 : 0 }, idX: X(f), idY: f.y,
      // A great barrier reef (≥ ~150 km) is a hero option of reef and island worlds (M8 baseline rec. 12).
      hero: { cat: 'reef', score: f.size / 150000 },
    }));
  }
  const atolls = fs.filter((f) => f.type === 'atoll').sort((a, b) => b.size - a.size).slice(0, 10);
  for (const f of atolls) {
    out.push(candidate({
      kind: 'atoll', x: X(f), y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, f.size / 30000),
      data: { diameterKm: Math.round(f.size / 100) / 10, islets: f.data?.motu ?? 0 }, idX: X(f), idY: f.y, tier: 'rare',
    }));
  }
}
