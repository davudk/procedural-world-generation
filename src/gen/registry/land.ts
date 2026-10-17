import { cellX as colOf, cellY as rowOf } from '../grid/grid';
import { chamferDistance } from '../grid/ops';
import { candidate } from './candidate';
import { cellAtM, cellX, cellY, compKm2, label, labelAngle, mergeTree, nearestWhere, nearestWhereM, type GridSpec } from './grid';
import { gradAt } from './shared';
import type { Candidate, RegistryInput, Shared } from './types';

/**
 * Land landmarks: continents, islands (with size classes), archipelagos (single-linkage clusters of
 * islands), peninsulas (morphological opening of the land mask at three radii: land that the opening
 * removes but that hangs off a core through a base narrower than its length), capes (peninsula
 * tips) and isthmuses (key cols of the distance-from-sea merge tree between two land cores).
 */
export function detectLand(I: RegistryInput, S: Shared, out: Candidate[]): void {
  const { cellM } = I.fine;
  const cellKm = cellM / 1000;
  const cellKm2 = cellKm * cellKm;
  const M = S.masses;
  const R = S.reg;
  const rKm = R.cellM / 1000;

  // Pole of inaccessibility of every landmass on the regional grid (deepest inland cell).
  const poleCell = new Int32Array(M.count).fill(-1);
  const poleD = new Float32Array(M.count);
  for (let i = 0; i < R.cells; i++) {
    if (!S.land[i]) continue;
    const fc = cellAtM(I.fine, cellX(R, i), cellY(R, i));
    const k = M.label[fc];
    if (k < 0) continue;
    if (S.dSea[i] > poleD[k]) {
      poleD[k] = S.dSea[i];
      poleCell[k] = i;
    }
  }
  const anchorOf = (k: number): [number, number] => {
    if (poleCell[k] >= 0 && M.size[k] >= 6 * S.f * S.f) {
      const fc = nearestWhereM(I.fine, cellX(R, poleCell[k]), cellY(R, poleCell[k]), 3 * S.f, (c) => M.label[c] === k);
      if (fc >= 0) return [cellX(I.fine, fc), cellY(I.fine, fc)];
    }
    if (M.dir) {
      const [x, y] = S.geo.fromDir(M.dir[3 * k], M.dir[3 * k + 1], M.dir[3 * k + 2]);
      const fc = nearestWhereM(I.fine, x, y, Math.max(4, Math.sqrt(M.size[k])), (c) => M.label[c] === k);
      return fc >= 0 ? [cellX(I.fine, fc), cellY(I.fine, fc)] : [x, y];
    }
    const cx = M.sx[k] / M.size[k] + 0.5;
    const cy = M.sy[k] / M.size[k] + 0.5;
    const fc = nearestWhere(I.fine, cx, cy, Math.max(4, Math.sqrt(M.size[k])), (c) => M.label[c] === k);
    return fc >= 0 ? [cellX(I.fine, fc), cellY(I.fine, fc)] : [cx * cellM, cy * cellM];
  };

  // Continents.
  for (const k of S.continents) {
    const [x, y] = anchorOf(k);
    const areaKm2 = compKm2(M, k, cellKm2);
    out.push(candidate({
      kind: 'continent', x, y, angle: NaN, extentM: Math.sqrt(areaKm2) * 1000, mag: Math.min(1, areaKm2 / (0.25 * I.worldKm * I.worldKm)),
      data: { areaKm2: Math.round(areaKm2) }, idX: x, idY: y, landmass: k,
    }));
  }

  // Islands: every other landmass from a minimum size, largest first, capped by land area.
  const minIsland = Math.max(2 * cellKm2, 10);
  const islands: number[] = [];
  for (let k = 0; k < M.count; k++) if (!S.continents.has(k) && compKm2(M, k, cellKm2) >= minIsland) islands.push(k);
  islands.sort((a, b) => M.size[b] - M.size[a] || a - b);
  const capIslands = Math.round(8 + S.landKm2 / 8000);
  for (const k of islands.slice(0, capIslands)) {
    const [x, y] = anchorOf(k);
    const areaKm2 = compKm2(M, k, cellKm2);
    const sizeClass = areaKm2 >= 1000 ? 3 : areaKm2 >= 100 ? 2 : areaKm2 >= 10 ? 1 : 0;
    out.push(candidate({
      kind: 'island', x, y, angle: NaN, extentM: Math.sqrt(areaKm2) * 1000, mag: Math.min(1, Math.log10(areaKm2) / 4.5),
      data: { areaKm2: Math.round(areaKm2 * 10) / 10, sizeClass }, idX: x, idY: y, landmass: k, variant: sizeClass === 3 ? 'large' : 'small',
    }));
  }

  detectArchipelagos(I, S, out);
  detectPeninsulas(I, S, R, rKm, out);
  detectIsthmuses(I, S, R, rKm, out);
}

/** Clusters of ≥ 5 islands whose gaps are ≤ 25 km (single linkage on centroid distance minus radii). */
function detectArchipelagos(I: RegistryInput, S: Shared, out: Candidate[]): void {
  const { cellM } = I.fine;
  const cellKm = cellM / 1000;
  const M = S.masses;
  const ids: number[] = [];
  for (let k = 0; k < M.count; k++) if (!S.continents.has(k)) ids.push(k);
  ids.sort((a, b) => M.size[b] - M.size[a] || a - b);
  const list = ids.slice(0, 3000);
  const L = list.length;
  const cx = new Float64Array(L);
  const cy = new Float64Array(L);
  const rr = new Float64Array(L);
  // Spheres: centroids as unit vectors, distances along great circles in nominal cells.
  const geo = S.geo;
  const D = M.dir ? new Float64Array(L * 3) : null;
  for (let i = 0; i < L; i++) {
    const k = list[i];
    cx[i] = M.sx[k] / M.size[k] + 0.5;
    cy[i] = M.sy[k] / M.size[k] + 0.5;
    rr[i] = Math.sqrt(M.size[k] / Math.PI);
    if (D && M.dir) {
      const l = Math.hypot(M.dir[3 * k], M.dir[3 * k + 1], M.dir[3 * k + 2]);
      for (let a = 0; a < 3; a++) D[3 * i + a] = M.dir[3 * k + a] / l;
    }
  }
  const gap = 25 / cellKm;
  const uf = Int32Array.from({ length: L }, (_, i) => i);
  const find = (a: number): number => {
    while (uf[a] !== a) a = uf[a] = uf[uf[a]];
    return a;
  };
  // The pair loop is the hot part: a small function per shape keeps the flat one as fast as before.
  if (D) linkSphere(D, rr, gap, geo.R / cellM, uf);
  else linkFlat(cx, cy, rr, gap, uf);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < L; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  const found: Candidate[] = [];
  for (const g of groups.values()) {
    if (g.length < 5) continue;
    let A = 0;
    let sx = 0;
    let sy = 0;
    let big = 0;
    for (const i of g) {
      const a = M.size[list[i]];
      A += a;
      sx += a * cx[i];
      sy += a * cy[i];
      big = Math.max(big, a);
    }
    sx /= A;
    sy /= A;
    let ext = 0;
    let x = sx * cellM;
    let y = sy * cellM;
    if (D) {
      let px = 0, py = 0, pz = 0;
      for (const i of g) {
        const a = M.size[list[i]];
        px += a * D[3 * i];
        py += a * D[3 * i + 1];
        pz += a * D[3 * i + 2];
      }
      [x, y] = geo.fromDir(px, py, pz);
      const c = new Float64Array(3);
      geo.dir(x, y, c);
      for (const i of g) {
        const dot = c[0] * D[3 * i] + c[1] * D[3 * i + 1] + c[2] * D[3 * i + 2];
        ext = Math.max(ext, (Math.acos(Math.max(-1, Math.min(1, dot))) * geo.R) / cellM + rr[i]);
      }
    } else for (const i of g) ext = Math.max(ext, Math.hypot(cx[i] - sx, cy[i] - sy) + rr[i]);
    const extentM = 2 * ext * cellM;
    if (extentM < 15000) continue;
    // A single big island with a few rocks is an island, not an archipelago.
    if (big > 0.8 * A && g.length < 12) continue;
    const areaKm2 = A * cellKm * cellKm;
    const heroScore = g.length / 50;
    found.push(candidate({
      kind: 'archipelago', x, y, angle: NaN, extentM, mag: Math.min(1, Math.log10(g.length) / 2),
      data: { islands: g.length, areaKm2: Math.round(areaKm2) }, idX: x, idY: y,
      variant: g.length >= 15 ? 'archipelago' : 'islands',
      hero: { cat: 'archipelago', score: heroScore },
    }));
  }
  found.sort((a, b) => b.data.islands - a.data.islands || b.extentM - a.extentM);
  for (const c of found.slice(0, 8)) out.push(c);
}

/** Single-linkage of islands whose gap (centroid distance minus radii, cells) is ≤ gap, into a union-find. */
function linkFlat(cx: Float64Array, cy: Float64Array, rr: Float64Array, gap: number, uf: Int32Array): void {
  const L = cx.length;
  const find = (a: number): number => {
    while (uf[a] !== a) a = uf[a] = uf[uf[a]];
    return a;
  };
  for (let i = 0; i < L; i++) {
    for (let j = i + 1; j < L; j++) {
      const d = Math.hypot(cx[i] - cx[j], cy[i] - cy[j]) - rr[i] - rr[j];
      if (d <= gap) {
        const a = find(i);
        const b = find(j);
        if (a !== b) uf[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
}

/** linkFlat on a sphere: centroid unit vectors D, great-circle distances in cells (k = R / cellM). */
function linkSphere(D: Float64Array, rr: Float64Array, gap: number, k: number, uf: Int32Array): void {
  const L = rr.length;
  const find = (a: number): number => {
    while (uf[a] !== a) a = uf[a] = uf[uf[a]];
    return a;
  };
  for (let i = 0; i < L; i++) {
    for (let j = i + 1; j < L; j++) {
      const c = D[3 * i] * D[3 * j] + D[3 * i + 1] * D[3 * j + 1] + D[3 * i + 2] * D[3 * j + 2];
      const d = Math.acos(Math.max(-1, Math.min(1, c))) * k - rr[i] - rr[j];
      if (d <= gap) {
        const a = find(i);
        const b = find(j);
        if (a !== b) uf[Math.max(a, b)] = Math.min(a, b);
      }
    }
  }
}

/** Peninsulas at three opening radii, largest first; capes at the tips of the long ones. */
function detectPeninsulas(I: RegistryInput, S: Shared, R: GridSpec, rKm: number, out: Candidate[]): void {
  const MM = R.cells;
  const { off8Axial: off, border, axialToRaster } = R;
  const accepted: { tx: number; ty: number }[] = [];
  const geo = S.geo;
  const pt = new Float64Array(3);
  const found: Candidate[] = [];
  const capes: Candidate[] = [];
  for (const radKm of [60, 30, 12]) {
    const rad = radKm / rKm;
    if (rad < 1.5) continue;
    const eroded = new Uint8Array(MM);
    for (let i = 0; i < MM; i++) eroded[i] = S.land[i] && S.dSea[i] > rad ? 1 : 0;
    const dO = chamferDistance(eroded, R);
    const resid = new Uint8Array(MM);
    const opened = new Uint8Array(MM);
    for (let i = 0; i < MM; i++) {
      if (!S.land[i]) continue;
      if (dO[i] <= rad) opened[i] = 1;
      else resid[i] = 1;
    }
    const comps = label(resid, R, true);
    const cellsOf: number[][] = Array.from({ length: comps.count }, () => []);
    for (let i = 0; i < MM; i++) if (comps.label[i] >= 0) cellsOf[comps.label[i]].push(i);
    const depth = new Float32Array(MM).fill(Infinity);
    for (let k = 0; k < comps.count; k++) {
      const cells = cellsOf[k];
      if (cells.length < 3) continue;
      // Base: cells touching the opened core. Dijkstra-free BFS on 8 neighbours (good enough for a length).
      const queue: number[] = [];
      let bx = 0;
      let by = 0;
      const bd = new Float64Array(3);
      for (const c of cells) {
        const b = border[c];
        let touches = false;
        for (let d = 0; d < 4; d++) {
          const nc = b === 0 ? c + off[d] : R.nbr(c, axialToRaster[d]);
          if (nc >= 0 && opened[nc]) touches = true;
        }
        if (touches) {
          depth[c] = 0;
          queue.push(c);
          bx += colOf(R, c);
          by += rowOf(R, c);
          if (S.sphere) {
            R.position(c, pt);
            for (let a = 0; a < 3; a++) bd[a] += pt[a];
          }
        }
      }
      if (queue.length === 0) continue;
      const base = queue.length;
      bx /= base;
      by /= base;
      for (let qi = 0; qi < queue.length; qi++) {
        const c = queue[qi];
        const b = border[c];
        for (let d = 0; d < 8; d++) {
          const nc = b === 0 ? c + off[d] : R.nbr(c, axialToRaster[d]);
          if (nc < 0 || comps.label[nc] !== k) continue;
          const nd = depth[c] + (d < 4 ? 1 : Math.SQRT2);
          if (nd < depth[nc]) {
            depth[nc] = nd;
            queue.push(nc);
          }
        }
      }
      let tip = -1;
      let P = 0;
      for (const c of cells) if (depth[c] < Infinity && depth[c] > P) (P = depth[c]), (tip = c);
      const PKm = (P + rad * 0.5) * rKm;
      if (tip < 0 || PKm < Math.max(25, 1.5 * radKm) || P < 1.2 * base) continue;
      const tx = S.sphere ? cellX(R, tip) : colOf(R, tip);
      const ty = S.sphere ? cellY(R, tip) : rowOf(R, tip);
      const minKm = Math.max(20, 2 * radKm);
      if (S.sphere ? accepted.some((a) => geo.dist(a.tx, a.ty, tx, ty) < minKm * 1000) : accepted.some((a) => Math.hypot(a.tx - tx, a.ty - ty) * rKm < minKm)) continue;
      // Anchor: the most inland cell of the middle third.
      let anchor = tip;
      let ad = -1;
      for (const c of cells) {
        if (depth[c] < 0.3 * P || depth[c] > 0.7 * P) continue;
        if (S.dSea[c] > ad) (ad = S.dSea[c]), (anchor = c);
      }
      const ax = cellX(R, anchor);
      const ay = cellY(R, anchor);
      const fa = nearestWhereM(I.fine, ax, ay, 3 * S.f, (c) => !I.sea[c]);
      const x = fa >= 0 ? cellX(I.fine, fa) : ax;
      const y = fa >= 0 ? cellY(I.fine, fa) : ay;
      const areaKm2 = S.sphere ? areaOf(R, cells) : cells.length * rKm * rKm;
      // Most of a landmass is not a peninsula of it.
      const mass = fa >= 0 ? S.masses.label[fa] : -1;
      if (mass >= 0 && areaKm2 > 0.4 * compKm2(S.masses, mass, (I.fine.cellM / 1000) ** 2)) continue;
      accepted.push({ tx, ty });
      let angle: number;
      if (S.sphere) {
        R.position(tip, pt);
        const l = Math.hypot(bd[0], bd[1], bd[2]) || 1;
        angle = geo.angleAlong(x, y, [bd[0] / l, bd[1] / l, bd[2] / l], pt);
      } else angle = labelAngle(tx - bx, ty - by);
      found.push(candidate({
        kind: 'peninsula', x, y, angle, extentM: PKm * 1000, mag: Math.min(1, PKm / 300),
        data: { lengthKm: Math.round(PKm), areaKm2: Math.round(areaKm2), neckKm: Math.round(base * rKm) }, idX: cellX(R, tip), idY: cellY(R, tip),
        landmass: mass,
      }));
      if (PKm >= 30) {
        // Cape: the fine land cell nearest the tip that touches the sea.
        const fine = I.fine;
        const fc = nearestWhereM(fine, cellX(R, tip), cellY(R, tip), 4 * S.f, (c) => {
          if (I.sea[c]) return false;
          const b = fine.border[c];
          for (let d = 0; d < 4; d++) {
            const j = b === 0 ? c + fine.off4[d] : fine.nbr(c, fine.axialToRaster[d]);
            if (j >= 0 && I.sea[j] === 1) return true;
          }
          return false;
        });
        if (fc >= 0) {
          const cx = cellX(I.fine, fc);
          const cy = cellY(I.fine, fc);
          capes.push(candidate({
            kind: 'cape', x: cx, y: cy, angle: NaN, extentM: Math.min(PKm, 40) * 1000 * 0.25, visM: Math.min(PKm, 60) * 1000 * 0.2,
            mag: Math.min(1, PKm / 300), data: { peninsulaKm: Math.round(PKm) }, idX: cx, idY: cy, landmass: S.masses.label[fc],
          }));
        }
      }
    }
  }
  found.sort((a, b) => b.extentM - a.extentM);
  for (const c of found.slice(0, Math.round(Math.min(25, Math.max(6, S.landKm2 / 15000))))) out.push(c);
  capes.sort((a, b) => b.mag - a.mag);
  for (const c of capes.slice(0, 12)) out.push(c);
}

/** Exact area (km²) of a list of sphere cells. */
function areaOf(g: GridSpec, cells: number[]): number {
  let a = 0;
  for (const c of cells) a += g.area(c);
  return a / 1e6;
}

/** Isthmuses: narrow land necks (≤ 40 km) between two land cores of ≥ 3000 km². */
function detectIsthmuses(I: RegistryInput, S: Shared, R: GridSpec, rKm: number, out: Candidate[]): void {
  const t = mergeTree(S.dSea, S.land, R, true, 0.05);
  const found: Candidate[] = [];
  const core = 12 / rKm;
  for (let k = 0; k < t.count; k++) {
    const p = t.parent[k];
    if (p < 0) continue;
    const widthKm = 2 * t.colV[k] * rKm;
    if (widthKm > 40 || t.peakV[k] < core || t.peakV[p] < core) continue;
    if (t.peakV[k] < 2 * t.colV[k]) continue;
    if (t.area[k] * rKm * rKm < 3000 || t.area[p] * rKm * rKm < 3000) continue;
    const c = t.col[k];
    const [vx, vy] = gradAt(S.dSea, R, c);
    const ax = cellX(R, c);
    const ay = cellY(R, c);
    const fa = nearestWhereM(I.fine, ax, ay, 3 * S.f, (q) => !I.sea[q]);
    const x = fa >= 0 ? cellX(I.fine, fa) : ax;
    const y = fa >= 0 ? cellY(I.fine, fa) : ay;
    found.push(candidate({
      kind: 'isthmus', x, y, angle: S.sphere ? S.geo.angleFromCell(R, c, -vy, vx, x, y) : labelAngle(-vy, vx), extentM: Math.max(widthKm * 2, 10) * 1000, mag: Math.min(1, t.peakV[k] / (4 * Math.max(t.colV[k], 0.5))),
      data: { widthKm: Math.round(widthKm) }, idX: ax, idY: ay, landmass: fa >= 0 ? S.masses.label[fa] : -1,
    }));
  }
  found.sort((a, b) => b.mag - a.mag);
  for (const c of found.slice(0, 4)) out.push(c);
}
