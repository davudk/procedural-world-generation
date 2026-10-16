import { chamferDistance } from '../grid/ops';
import { blockMean, cellX, cellY, DX8, DY8, insideDistance, label, labelAngle, mergeTree, nearestWhere, resolveOwners, type GridSpec } from './grid';
import { gradAt } from './shared';
import type { Candidate, RegistryInput, Shared } from './types';

/** Seas need this much water (km²) and a basin centre this far from land (km). */
const SEA_MIN_KM2 = 8000;
const SEA_MIN_DEPTH_KM = 20;
/** Straits: passages at most this wide (km) between two basins of at least STRAIT_SIDE_KM2. */
const STRAIT_MAX_KM = 60;
const STRAIT_SIDE_KM2 = 2000;

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
  const m = R.n;
  const MM = m * m;
  const rKm = R.cellM / 1000;
  const rKm2 = rKm * rKm;
  const seaR = new Uint8Array(MM);
  for (let i = 0; i < MM; i++) seaR[i] = 1 - S.land[i];

  // ── Basins and straits ──
  const t = mergeTree(S.dLand, seaR, m, false, 0.05);
  const keep = new Uint8Array(t.count);
  for (let k = 0; k < t.count; k++) {
    const big = t.area[k] * rKm2 >= SEA_MIN_KM2 && t.peakV[k] * rKm >= SEA_MIN_DEPTH_KM;
    keep[k] = big && (t.parent[k] < 0 || t.peakV[k] - t.colV[k] >= 0.5 * t.peakV[k]) ? 1 : 0;
  }
  const res = resolveOwners(t, keep);
  const basin = new Int32Array(MM).fill(-1);
  const bArea = new Float64Array(t.count);
  const edge = new Uint8Array(t.count);
  for (let i = 0; i < MM; i++) {
    if (t.owner[i] < 0) continue;
    const b = res[t.owner[i]];
    basin[i] = b;
    if (b < 0) continue;
    bArea[b]++;
    const x = i % m;
    const y = (i - x) / m;
    if (x === 0 || y === 0 || x === m - 1 || y === m - 1) edge[b] = 1;
  }
  const basins: number[] = [];
  for (let k = 0; k < t.count; k++) if (keep[k] && bArea[k] > 0) basins.push(k);
  basins.sort((a, b) => bArea[b] - bArea[a] || a - b);
  const worldKm2 = I.worldKm * I.worldKm;
  const seaCands: Candidate[] = [];
  basins.forEach((k, idx) => {
    const areaKm2 = bArea[k] * rKm2;
    const isOcean = idx === 0 && edge[k] === 1 && areaKm2 >= 0.2 * worldKm2;
    const [x, y] = snapSea(I, S, cellX(R, t.peak[k]), cellY(R, t.peak[k]));
    seaCands.push({
      kind: isOcean ? 'ocean' : 'sea', x, y, angle: NaN, extentM: Math.sqrt(areaKm2) * 1000,
      mag: Math.min(1, areaKm2 / (0.3 * worldKm2)),
      data: { areaKm2: Math.round(areaKm2), maxShoreDistKm: Math.round(t.peakV[k] * rKm) }, idX: cellX(R, t.peak[k]), idY: cellY(R, t.peak[k]),
    });
  });
  for (const c of seaCands.slice(0, 7)) out.push(c);

  const straits: Candidate[] = [];
  for (let k = 0; k < t.count; k++) {
    const p = t.parent[k];
    if (p < 0) continue;
    const widthKm = 2 * t.colV[k] * rKm;
    if (widthKm > STRAIT_MAX_KM || t.peakV[k] < 2 * t.colV[k] || t.peakV[k] * rKm < 10) continue;
    if (t.area[k] * rKm2 < STRAIT_SIDE_KM2 || t.area[p] * rKm2 < STRAIT_SIDE_KM2) continue;
    const c = t.col[k];
    const [vx, vy] = gradAt(S.dLand, m, c);
    const [x, y] = snapSea(I, S, cellX(R, c), cellY(R, c));
    straits.push({
      kind: 'strait', x, y, angle: labelAngle(-vy, vx), extentM: Math.max(3 * widthKm, 15) * 1000,
      mag: Math.min(1, Math.min(t.area[k], t.area[p]) * rKm2 / 50000),
      data: { widthKm: Math.max(1, Math.round(widthKm)) }, idX: cellX(R, c), idY: cellY(R, c),
    });
  }
  straits.sort((a, b) => b.mag - a.mag);
  const keptStraits: Candidate[] = [];
  for (const s of straits) {
    if (keptStraits.length >= 6) break;
    if (keptStraits.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < 50000)) continue;
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

  detectFjords(I, out);
  coastalFeatures(I, out);
}

/** Nearest sea cell of the macro grid to a map position, as map metres. */
function snapSea(I: RegistryInput, S: Shared, x: number, y: number): [number, number] {
  const fc = nearestWhere(I.fine.n, x / I.fine.cellM, y / I.fine.cellM, 4 * S.f, (c) => I.sea[c] === 1);
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
  const m = R.n / fac;
  const g: GridSpec = { n: m, cellM: R.cellM * fac };
  const gKm = g.cellM / 1000;
  const share = fac === 1 ? S.landShare : blockMean(S.landShare, R.n, fac);
  const land = new Uint8Array(m * m);
  for (let i = 0; i < m * m; i++) land[i] = share[i] >= 0.5 ? 1 : 0;
  const dl = fac === 1 ? S.dLand : chamferDistance(land, m);
  const rad = radKm / gKm;
  const DIRS = 16;
  const cosT = new Float64Array(DIRS);
  const sinT = new Float64Array(DIRS);
  for (let d = 0; d < DIRS; d++) {
    cosT[d] = Math.cos((2 * Math.PI * d) / DIRS);
    sinT[d] = Math.sin((2 * Math.PI * d) / DIRS);
  }
  const emb = new Uint8Array(m * m);
  for (let i = 0; i < m * m; i++) {
    if (land[i] || dl[i] > rad) continue;
    const x0 = (i % m) + 0.5;
    const y0 = Math.floor(i / m) + 0.5;
    let hits = 0;
    for (let d = 0; d < DIRS; d++) {
      for (let s = 1; s <= rad; s += 0.75) {
        const x = Math.floor(x0 + cosT[d] * s);
        const y = Math.floor(y0 + sinT[d] * s);
        if (x < 0 || y < 0 || x >= m || y >= m) break;
        if (land[y * m + x]) {
          hits++;
          break;
        }
      }
      if (hits + (DIRS - 1 - d) < 11) break;
    }
    if (hits >= 11) emb[i] = 1;
  }
  const comps = label(emb, m, false);
  const inside = insideDistance(emb, m);
  const pole = new Int32Array(comps.count).fill(-1);
  const opens = new Uint8Array(comps.count);
  for (let i = 0; i < m * m; i++) {
    const k = comps.label[i];
    if (k < 0) continue;
    if (pole[k] < 0 || inside[i] > inside[pole[k]]) pole[k] = i;
    const x = i % m;
    const y = (i - x) / m;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX8[d];
      const ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= m || ny >= m) continue;
      const nc = ny * m + nx;
      if (!land[nc] && !emb[nc]) opens[k] = 1;
    }
  }
  const list: Candidate[] = [];
  const gKm2 = gKm * gKm;
  for (let k = 0; k < comps.count; k++) {
    const areaKm2 = comps.size[k] * gKm2;
    if (areaKm2 < minKm2 || !opens[k]) continue;
    const px = cellX(g, pole[k]);
    const py = cellY(g, pole[k]);
    // A gulf that is most of a named sea basin is that sea; a bay that is most of a gulf is that gulf.
    const rc = Math.min(R.n - 1, Math.floor(py / R.cellM)) * R.n + Math.min(R.n - 1, Math.floor(px / R.cellM));
    const b = basin[rc];
    if (b >= 0 && basinArea[b] * (R.cellM / 1000) ** 2 < 2.5 * areaKm2) continue;
    if (parent) {
      const pc = Math.min(parent.g.n - 1, Math.floor(py / parent.g.cellM)) * parent.g.n + Math.min(parent.g.n - 1, Math.floor(px / parent.g.cellM));
      const pk = parent.lab[pc];
      if (pk >= 0 && parent.area[pk] * (parent.g.cellM / 1000) ** 2 < 2.5 * areaKm2) continue;
    }
    const [x, y] = snapSea(I, S, px, py);
    const isGulf = fac > 1 && areaKm2 >= 6000;
    list.push({
      kind: isGulf ? 'gulf' : 'bay', x, y, angle: NaN, extentM: Math.sqrt(areaKm2) * 1000 * 1.2,
      mag: Math.min(1, Math.log10(areaKm2) / 5), data: { areaKm2: Math.round(areaKm2) }, idX: px, idY: py,
    });
  }
  return { list, lab: comps.label, g, area: comps.size };
}

/** One fjord per connected trough of the glacial fjord mask; path from the head to the mouth. */
function detectFjords(I: RegistryInput, out: Candidate[]): void {
  const { n, cellM } = I.fine;
  const fj = I.landforms.fjord;
  const comps = label(fj, n, true);
  if (comps.count === 0) return;
  const cellsOf: number[][] = Array.from({ length: comps.count }, () => []);
  for (let i = 0; i < n * n; i++) if (comps.label[i] >= 0) cellsOf[comps.label[i]].push(i);
  const dist = new Float32Array(n * n).fill(Infinity);
  const prev = new Int32Array(n * n).fill(-1);
  const found: Candidate[] = [];
  let totalKm = 0;
  for (let k = 0; k < comps.count; k++) {
    const cells = cellsOf[k];
    if (cells.length < 3) continue;
    const queue: number[] = [];
    for (const c of cells) {
      const x = c % n;
      const y = (c - x) / n;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX8[d];
        const ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const nc = ny * n + nx;
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
      const x = c % n;
      const y = (c - x) / n;
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d];
        const ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const nc = ny * n + nx;
        if (comps.label[nc] !== k) continue;
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
    const path = new Float32Array(xs.length * 2);
    for (let i = 0; i < xs.length; i++) {
      path[2 * i] = xs[i];
      path[2 * i + 1] = ys[i];
    }
    const last = xs.length - 1;
    found.push({
      kind: 'fjord', x: xs[mid], y: ys[mid], angle: labelAngle(xs[last] - xs[0], ys[last] - ys[0]), extentM: lenKm * 1000,
      mag: Math.min(1, lenKm / 150), data: { lengthKm: Math.round(lenKm) }, idX: xs[last], idY: ys[last], path,
    });
  }
  found.sort((a, b) => b.extentM - a.extentM);
  const kept = found.slice(0, 25);
  if (kept.length > 0) {
    kept[0].hero = { cat: 'fjord-coast', score: totalKm / 150 };
    kept[0].data.fjordCount = found.length;
    kept[0].data.fjordTotalKm = Math.round(totalKm);
  }
  out.push(...kept);
}

/** Lagoons, reefs and atolls from the coastal landform features. */
function coastalFeatures(I: RegistryInput, out: Candidate[]): void {
  const fs = I.landforms.features;
  const lagoons = fs.filter((f) => f.type === 'lagoon' && !f.data?.atoll && f.size >= 4000).sort((a, b) => b.size - a.size).slice(0, 8);
  for (const f of lagoons) {
    out.push({
      kind: 'lagoon', x: f.x, y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, f.size / 40000),
      data: { areaKm2: Math.round(f.data?.areaKm2 ?? (f.size / 1000) ** 2) }, idX: f.x, idY: f.y,
    });
  }
  const reefs = fs.filter((f) => f.type === 'reef' && f.size >= 10000).sort((a, b) => b.size - a.size).slice(0, 6);
  for (const f of reefs) {
    out.push({
      kind: 'reef', x: f.x, y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, f.size / 150000),
      data: { lengthKm: Math.round(f.size / 1000), barrier: f.data?.barrier ? 1 : 0 }, idX: f.x, idY: f.y,
    });
  }
  const atolls = fs.filter((f) => f.type === 'atoll').sort((a, b) => b.size - a.size).slice(0, 10);
  for (const f of atolls) {
    out.push({
      kind: 'atoll', x: f.x, y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, f.size / 30000),
      data: { diameterKm: Math.round(f.size / 100) / 10, islets: f.data?.motu ?? 0 }, idX: f.x, idY: f.y, tier: 'rare',
    });
  }
}
