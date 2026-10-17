import { cellIndex, cellX as colOf, cellY as rowOf } from '../grid/grid';
import { axesDir, axesXY, compKm2 } from './grid';
import { B } from '../stages/plates';
import { candidate, own } from './candidate';
import { cellAtM, cellX, cellY, insideDistance, label, labelAngle, mergeTree, nearestWhereM, pca, resolveOwners, type MergeTree } from './grid';
import { G } from './shared';
import type { Candidate, RegistryInput, Shared } from './types';

/** Peaks need this much topographic prominence (m). */
const PEAK_MIN_PROM = 300;
/** Minimum spacing of labelled peaks (km, research 05 §3.3). */
const PEAK_SPACING_KM = 6;
/**
 * A single summit's footprint (m) is at most this: bigger massifs read as ranges at the world band, so
 * a summit never competes with them there (M8 baseline rec. 4).
 */
const PEAK_MAX_EXTENT_M = 12000;
/**
 * Region-band crowding (research 05 §3.2: 10–25 features per 250 km view): at most PEAK_R_MAX peaks
 * that read at the region band (footprint ≥ 250 km / 80) within PEAK_R_RADIUS_KM of each other; the
 * most prominent win. Orogen views otherwise hold 15–20 summits next to their lakes and rivers.
 */
const PEAK_R_LO_M = 250000 / 80;
const PEAK_R_RADIUS_KM = 80;
const PEAK_R_MAX = 6;

export interface ReliefResult {
  /** Range id per regional cell (−1 outside ranges), for canyons. */
  rangeOf: Int32Array;
  /** Highest peak of the world (map metres, m). */
  king: { x: number; y: number; h: number } | null;
  /** Elevation merge tree over land (macro grid), prominence per component, components already used (volcano or peak). */
  tree: MergeTree;
  prom: Float32Array;
  used: Uint8Array;
}

/**
 * Relief landmarks. Peaks from the merge tree of elevation over land (prominence = summit − key col,
 * or the summit height for the highest point of a landmass); volcanoes, calderas and craters from the
 * landform features, matched to their summit; ranges as significant components of the high, rough
 * part of the smoothed relief (split at deep cols), oriented by PCA with a crest path; plateaus (high
 * and flat), plains (low and flat), rifts from continental rift segments, mesa fields and karst from
 * the landform features.
 */
export function detectRelief(I: RegistryInput, S: Shared, out: Candidate[]): ReliefResult {
  const fine = I.fine;
  const { n, cellM } = fine;
  const N = fine.cells;
  const land = new Uint8Array(N);
  for (let c = 0; c < N; c++) land[c] = I.sea[c] ? 0 : 1;
  const t = mergeTree(I.h, land, fine, true, 1);
  const prom = new Float32Array(t.count);
  let kingK = -1;
  for (let k = 0; k < t.count; k++) {
    prom[k] = t.parent[k] < 0 ? t.peakV[k] : t.peakV[k] - t.colV[k];
    if (kingK < 0 || t.peakV[k] > t.peakV[kingK]) kingK = k;
  }
  const kingH = kingK >= 0 ? t.peakV[kingK] : 0;
  const used = new Uint8Array(t.count);

  // Volcanic features first: they claim the summit they sit on.
  const fs = I.landforms.features;
  const geo = S.geo;
  const volcanoes: Candidate[] = [];
  for (const f of fs) {
    if (f.type !== 'stratovolcano' && f.type !== 'shield-volcano' && f.type !== 'caldera' && f.type !== 'crater') continue;
    const fx = f.x / cellM;
    const fy = f.y / cellM;
    const FX = geo.enc(f.face, f.x);
    const rad = Math.max(f.size / 2 / cellM, 1.5);
    if (f.type === 'crater') {
      const D = f.data?.diameter ?? f.size;
      const c: Candidate = candidate({
        kind: 'crater', x: FX, y: f.y, angle: NaN, extentM: D, mag: Math.min(1, D / 40000),
        data: { diameterKm: Math.round(D / 100) / 10, depthM: Math.round(f.data?.depth ?? 0) }, idX: FX, idY: f.y,
        hero: { cat: 'crater', score: D / 20000 }, tier: D >= 50000 ? 'legendary' : 'rare',
      });
      volcanoes.push(c);
      continue;
    }
    // Highest prominent summit inside the edifice.
    let best = -1;
    if (S.sphere) {
      fine.chart({ face: f.face ?? 0, u: f.x, v: f.y }, rad * cellM, (c) => {
        if (land[c] && (best < 0 || I.h[c] > I.h[best])) best = c;
      });
    } else {
      const r = Math.ceil(rad);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const xb = Math.min(n - 1, x0 + r);
      const yb = Math.min(n - 1, y0 + r);
      for (let y = Math.max(0, y0 - r); y <= yb; y++) {
        for (let x = Math.max(0, x0 - r); x <= xb; x++) {
          const dx = x - x0;
          const dy = y - y0;
          if (dx * dx + dy * dy > rad * rad) continue;
          const c = cellIndex(fine, x, y);
          if (!land[c]) continue;
          if (best < 0 || I.h[c] > I.h[best]) best = c;
        }
      }
    }
    if (f.type === 'caldera') {
      volcanoes.push(candidate({
        kind: 'caldera', x: FX, y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, f.size / 30000),
        data: { diameterKm: Math.round(f.size / 100) / 10, depthM: Math.round(f.data?.depth ?? 0), rimM: Math.round(f.data?.rim ?? 0) },
        idX: FX, idY: f.y, tier: 'rare',
      }));
      continue;
    }
    if (best < 0) continue;
    // The summit's own prominence component, if its peak lies on the edifice.
    let k = t.owner[best];
    if (k >= 0) {
      const pc = t.peak[k];
      if (S.sphere) {
        if (geo.dist(cellX(fine, pc), cellY(fine, pc), FX, f.y) > (rad + 1) * cellM) k = -1;
      } else if ((colOf(fine, pc) + 0.5 - fx) ** 2 + (rowOf(fine, pc) + 0.5 - fy) ** 2 > (rad + 1) ** 2) k = -1;
    }
    if (k >= 0) used[k] = 1;
    const hgt = I.h[best];
    const x = cellX(I.fine, best);
    const y = cellY(I.fine, best);
    volcanoes.push(candidate({
      kind: 'volcano', x, y, angle: NaN, extentM: f.size, mag: 0.7 * Math.min(1, hgt / Math.max(kingH, 1)) + 0.3 * Math.min(1, f.size / 40000),
      data: { heightM: Math.round(hgt), ...(k >= 0 ? { prominenceM: Math.round(prom[k]) } : {}), diameterKm: Math.round(f.size / 100) / 10, shield: f.type === 'shield-volcano' ? 1 : 0 },
      idX: FX, idY: f.y, variant: f.type === 'shield-volcano' ? 'shield' : 'strato', visM: Math.max(f.size, 3000),
      ...(k >= 0 ? { summit: k } : {}),
    }));
  }
  const nVol = volcanoes.filter((v) => v.kind === 'volcano').length;
  let tallest: Candidate | null = null;
  for (const v of volcanoes) if (v.kind === 'volcano' && (!tallest || v.data.heightM > tallest.data.heightM)) tallest = v;
  // Every tall cone is a hero candidate (research 05 §3.4: stratovolcano > 4 km); the tallest also
  // stands for the whole chain (> 6 cones), so volcanic island worlds have more than one candidate.
  for (const v of volcanoes) if (v.kind === 'volcano') v.hero = own({ cat: 'volcano', score: v.data.heightM / 4000 });
  if (tallest) tallest.hero = own({ cat: 'volcano', score: Math.max(tallest.data.heightM / 4000, nVol / 6) });
  out.push(...volcanoes);

  // Peaks: prominent summits, most prominent first, spaced, capped by land area; the king always.
  const cand: number[] = [];
  for (let k = 0; k < t.count; k++) if (!used[k] && prom[k] >= PEAK_MIN_PROM && t.peakV[k] >= PEAK_MIN_PROM) cand.push(k);
  cand.sort((a, b) => prom[b] + 0.25 * t.peakV[b] - (prom[a] + 0.25 * t.peakV[a]) || a - b);
  if (kingK >= 0 && !used[kingK]) {
    const i = cand.indexOf(kingK);
    if (i > 0) cand.splice(i, 1);
    if (i !== 0) cand.unshift(kingK);
  }
  // Caps scale with land area only (research 05 §3.1: size changes quantity, not density; M8 rec. 9).
  const cap = Math.round(Math.max(8, S.landKm2 / 7000));
  const sp = (PEAK_SPACING_KM * 1000) / cellM;
  /** Cell columns and rows of the peaks taken so far. */
  const taken: number[] = [];
  const peaks: Candidate[] = [];
  const peakComps: number[] = [];
  const rVis: number[] = [];
  const rr2 = (PEAK_R_RADIUS_KM * 1000) ** 2;
  for (const k of cand) {
    if (peaks.length >= cap) break;
    const c = t.peak[k];
    // Spheres: positions and great-circle distances (taken holds metres there).
    const x = S.sphere ? cellX(fine, c) : colOf(fine, c);
    const y = S.sphere ? cellY(fine, c) : rowOf(fine, c);
    let near = false;
    if (S.sphere) for (let i = 0; i < taken.length && !near; i += 2) near = geo.d2(taken[i], taken[i + 1], x, y) < (sp * cellM) ** 2;
    else for (let i = 0; i < taken.length && !near; i += 2) near = (taken[i] - x) ** 2 + (taken[i + 1] - y) ** 2 < sp * sp;
    if (near) continue;
    const ext = Math.max(cellM, Math.min(prom[k] * 6, PEAK_MAX_EXTENT_M));
    if (ext >= PEAK_R_LO_M && k !== kingK) {
      const px = cellX(I.fine, c);
      const py = cellY(I.fine, c);
      let near = 0;
      for (let i = 0; i < rVis.length; i += 2) if (geo.d2(rVis[i], rVis[i + 1], px, py) < rr2) near++;
      if (near >= PEAK_R_MAX) continue;
    }
    if (ext >= PEAK_R_LO_M) rVis.push(cellX(I.fine, c), cellY(I.fine, c));
    taken.push(x, y);
    used[k] = 1;
    peakComps.push(k);
    const p = prom[k];
    const hgt = t.peakV[k];
    const isKing = k === kingK;
    const px = cellX(I.fine, c);
    const py = cellY(I.fine, c);
    peaks.push(candidate({
      kind: 'peak', x: px, y: py, angle: NaN, extentM: ext,
      visM: isKing ? 16000 : 1000 * (p / PEAK_MIN_PROM) ** 0.9, mag: 0.6 * Math.min(1, hgt / Math.max(kingH, 1)) + 0.4 * Math.min(1, p / 3000),
      data: { heightM: Math.round(hgt), prominenceM: Math.round(p), ...(isKing ? { worldKing: 1 } : {}) }, idX: px, idY: py,
      tier: hgt >= 7500 ? 'legendary' : hgt >= 5000 ? 'rare' : isKing ? 'uncommon' : 'common',
      landmass: S.masses.label[c],
    }));
  }
  out.push(...peaks);
  detectPasses(I, S, out, t, prom, peakComps, peaks);

  const rangeOf = detectRanges(I, S, out, peaks);
  detectFlats(I, S, out, rangeOf);
  detectRifts(I, S, out);
  landformAreas(I, S, out);
  const king = kingK >= 0 ? { x: cellX(I.fine, t.peak[kingK]), y: cellY(I.fine, t.peak[kingK]), h: kingH } : null;
  return { rangeOf, king, tree: t, prom, used };
}

/**
 * Ranges: regional cells whose ~20 km mean elevation is high for this world and whose relief is
 * rough; significant components of their merge tree (a sub-range must rise ≥ 400 m above the col
 * joining it to a higher one) become ranges, the highest labelled peak inside each is its king.
 */
function detectRanges(I: RegistryInput, S: Shared, out: Candidate[], peaks: Candidate[]): Int32Array {
  const R = S.reg;
  const MM = R.cells;
  const rKm = R.cellM / 1000;
  let top = 0;
  for (let i = 0; i < MM; i++) if (S.land[i] && S.hSmooth[i] > top) top = S.hSmooth[i];
  const T = Math.max(700, 0.3 * top);
  const mask = new Uint8Array(MM);
  for (let i = 0; i < MM; i++) mask[i] = S.land[i] && S.hSmooth[i] >= T && S.relief[i] >= 120 ? 1 : 0;
  const t = mergeTree(S.hSmooth, mask, R, true, 5);
  const minKm2 = 1500;
  const keep = new Uint8Array(t.count);
  for (let k = 0; k < t.count; k++) {
    if (t.area[k] * rKm * rKm < minKm2) continue;
    keep[k] = t.parent[k] < 0 || t.peakV[k] - t.colV[k] >= Math.max(400, 0.25 * (t.peakV[k] - T)) ? 1 : 0;
  }
  const res = resolveOwners(t, keep);
  const rangeOf = new Int32Array(MM).fill(-1);
  const cellsOf = new Map<number, number[]>();
  for (let i = 0; i < MM; i++) {
    if (t.owner[i] < 0) continue;
    const r = res[t.owner[i]];
    if (r < 0) continue;
    let a = cellsOf.get(r);
    if (!a) cellsOf.set(r, (a = []));
    a.push(i);
  }
  const ranges: { c: Candidate; id: number }[] = [];
  for (const [id, cells] of cellsOf) {
    const ax = pca(cells, R, (c) => S.hSmooth[c] - T + 50);
    const lenKm = ax.length * rKm;
    if (lenKm < 50) continue;
    const widthKm = ax.width * rKm;
    // Crest: highest cell per bin along the major axis.
    const bins = Math.max(3, Math.min(24, Math.round(lenKm / 25)));
    const half = ax.length / 2;
    const bestC = new Int32Array(bins).fill(-1);
    let maxH = 0;
    let sumRel = 0;
    const q = new Float64Array(3);
    for (const c of cells) {
      axesXY(ax, R, c, q);
      const dx = q[0] - ax.cx;
      const dy = q[1] - ax.cy;
      const s = dx * ax.ux + dy * ax.uy;
      const b = Math.min(bins - 1, Math.max(0, Math.floor(((s + half) / ax.length) * bins)));
      if (bestC[b] < 0 || S.hSmooth[c] > S.hSmooth[bestC[b]]) bestC[b] = c;
      maxH = Math.max(maxH, S.hMax[c]);
      sumRel += S.relief[c];
    }
    const pts: number[] = [];
    for (let b = 0; b < bins; b++) if (bestC[b] >= 0) pts.push(bestC[b]);
    const path = S.sphere ? new Float64Array(pts.length * 2) : new Float32Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      // 3-point smoothing of the crest (spheres: of the unit vectors).
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let w = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(pts.length - 1, i + 1); j++) {
        const wj = j === i ? 2 : 1;
        if (S.sphere) {
          R.position(pts[j], q);
          sx += wj * q[0];
          sy += wj * q[1];
          sz += wj * q[2];
        } else {
          sx += wj * cellX(R, pts[j]);
          sy += wj * cellY(R, pts[j]);
        }
        w += wj;
      }
      if (S.sphere) [path[2 * i], path[2 * i + 1]] = S.geo.fromDir(sx, sy, sz);
      else {
        path[2 * i] = sx / w;
        path[2 * i + 1] = sy / w;
      }
    }
    const mid = pts[Math.floor(pts.length / 2)];
    const fa = nearestWhereM(I.fine, cellX(R, mid), cellY(R, mid), 3 * S.f, (c) => !I.sea[c]);
    const x = fa >= 0 ? cellX(I.fine, fa) : cellX(R, mid);
    const y = fa >= 0 ? cellY(I.fine, fa) : cellY(R, mid);
    const meanRel = sumRel / cells.length;
    const variant = maxH < 1500 ? 'hills' : meanRel < 250 || widthKm > 0.7 * lenKm ? 'highlands' : 'range';
    const areaKm2 = cells.length * rKm * rKm;
    ranges.push({
      id,
      c: candidate({
        kind: 'range', x, y, angle: ax.plane ? S.geo.angleOf(x, y, ...axesDir(ax, ax.ux, ax.uy)) : labelAngle(ax.ux, ax.uy), extentM: lenKm * 1000, mag: 0.5 * Math.min(1, lenKm / 600) + 0.5 * Math.min(1, maxH / 6000),
        data: { lengthKm: Math.round(lenKm), widthKm: Math.round(widthKm), maxHeightM: Math.round(maxH), areaKm2: Math.round(areaKm2) },
        idX: cellX(R, t.peak[id]), idY: cellY(R, t.peak[id]), path, variant, hero: { cat: 'massif', score: maxH / 5000 },
        landmass: fa >= 0 ? S.masses.label[fa] : -1,
      }),
    });
  }
  ranges.sort((a, b) => b.c.mag - a.c.mag);
  const kept = ranges.slice(0, 8);
  const keptIds = new Set(kept.map((r) => r.id));
  for (const [id, cells] of cellsOf) {
    if (!keptIds.has(id)) continue;
    for (const c of cells) rangeOf[c] = id;
  }
  // Kings: the highest labelled peak inside each range.
  for (const { c: rc, id } of kept) {
    let king: Candidate | null = null;
    for (const p of peaks) {
      if (rangeOf[cellAtM(R, p.x, p.y)] !== id) continue;
      if (!king || p.data.heightM > king.data.heightM) king = p;
    }
    if (king) {
      king.data.rangeKing = 1;
      if (king.tier === 'common') king.tier = 'uncommon';
      king.visM = Math.max(king.visM ?? 0, 6000);
      rc.data.kingHeightM = king.data.heightM;
    }
    out.push(rc);
  }
  return rangeOf;
}

/**
 * Passes: the key col of a labelled peak (the lowest point on the highest route to higher ground) is
 * a saddle on the crest, the classic mountain pass. Kept when the col stands ≥ PASS_MIN_RELIEF_M
 * below the peak and ≥ PASS_MIN_H_M above the sea, spaced ≥ PASS_SPACING_KM, at most one per
 * PASS_PER_KM2 of land (research 05 §3.2 lists passes among the area-band features).
 */
const PASS_MIN_RELIEF_M = 300;
const PASS_MIN_H_M = 500;
const PASS_SPACING_KM = 10;
const PASS_PER_KM2 = 5000;
/** A pass reads as a notch about this wide (m). */
const PASS_EXTENT_M = 2000;

function detectPasses(I: RegistryInput, S: Shared, out: Candidate[], t: MergeTree, prom: Float32Array, comps: number[], peaks: Candidate[]): void {
  const fine = I.fine;
  const list: { c: number; k: number; i: number }[] = [];
  comps.forEach((k, i) => {
    const c = t.col[k];
    if (c < 0 || I.sea[c] || t.colV[k] < PASS_MIN_H_M || prom[k] < PASS_MIN_RELIEF_M) return;
    list.push({ c, k, i });
  });
  // Highest crossings of the most prominent peaks first.
  list.sort((a, b) => prom[b.k] - prom[a.k] || a.c - b.c);
  const cap = Math.max(2, Math.round(S.landKm2 / PASS_PER_KM2));
  const sp2 = (PASS_SPACING_KM * 1000) ** 2;
  const kept: { x: number; y: number }[] = [];
  for (const { c, k, i } of list) {
    if (kept.length >= cap) break;
    const x = cellX(fine, c);
    const y = cellY(fine, c);
    if (kept.some((o) => S.geo.d2(o.x, o.y, x, y) < sp2)) continue;
    kept.push({ x, y });
    out.push(candidate({
      kind: 'pass', x, y, angle: NaN, extentM: PASS_EXTENT_M, visM: PASS_EXTENT_M, mag: Math.min(1, t.colV[k] / 4000),
      data: { heightM: Math.round(t.colV[k]), belowPeakM: Math.round(prom[k]) }, idX: x, idY: y, nameFrom: peaks[i],
      tier: 'common', landmass: S.masses.label[c],
    }));
  }
}

/** Plateaus (high and flat) and plains (low and flat): large regional components. */
function detectFlats(I: RegistryInput, S: Shared, out: Candidate[], rangeOf: Int32Array): void {
  const R = S.reg;
  const MM = R.cells;
  const rKm2 = (R.cellM / 1000) ** 2;
  const plateau = new Uint8Array(MM);
  const plain = new Uint8Array(MM);
  for (let i = 0; i < MM; i++) {
    if (!S.land[i] || rangeOf[i] >= 0) continue;
    if (S.hSmooth[i] >= 800 && S.relief[i] < 150) plateau[i] = 1;
    // Plains: low, flat and not already a desert region.
    if (S.hSmooth[i] < 200 && S.relief[i] < 50 && S.dSea[i] * R.cellM >= 8000 && S.groupShare[G.DESERT][i] < 0.5) plain[i] = 1;
  }
  const emit = (mask: Uint8Array, kind: 'plateau' | 'plain', minKm2: number, cap: number): void => {
    const comps = label(mask, R, true);
    const inside = insideDistance(mask, R);
    const pole = new Int32Array(comps.count).fill(-1);
    const sumH = new Float64Array(comps.count);
    for (let i = 0; i < MM; i++) {
      const k = comps.label[i];
      if (k < 0) continue;
      sumH[k] += S.hSmooth[i];
      if (pole[k] < 0 || inside[i] > inside[pole[k]]) pole[k] = i;
    }
    const list: Candidate[] = [];
    for (let k = 0; k < comps.count; k++) {
      const areaKm2 = compKm2(comps, k, rKm2);
      if (areaKm2 < minKm2) continue;
      const px = cellX(R, pole[k]);
      const py = cellY(R, pole[k]);
      const fa = nearestWhereM(I.fine, px, py, 3 * S.f, (c) => !I.sea[c]);
      const x = fa >= 0 ? cellX(I.fine, fa) : px;
      const y = fa >= 0 ? cellY(I.fine, fa) : py;
      list.push(candidate({
        kind, x, y, angle: NaN, extentM: Math.sqrt(areaKm2) * 1000, mag: Math.min(1, areaKm2 / 100000),
        data: { areaKm2: Math.round(areaKm2), elevationM: Math.round(sumH[k] / comps.size[k]) }, idX: px, idY: py,
        landmass: fa >= 0 ? S.masses.label[fa] : -1, variant: kind === 'plain' && areaKm2 > 40000 ? 'lowlands' : kind,
      }));
    }
    list.sort((a, b) => b.extentM - a.extentM);
    out.push(...list.slice(0, cap));
  };
  // Caps scale with land area (M8 baseline rec. 9); the world-band budget picks among them.
  emit(plateau, 'plateau', 2500, Math.max(4, Math.round(S.landKm2 / 60000)));
  emit(plain, 'plain', 6000, Math.max(3, Math.round(S.landKm2 / 50000)));
}

/** Continental rift segments (plates) of ≥ 100 km, mostly on land. */
function detectRifts(I: RegistryInput, S: Shared, out: Candidate[]): void {
  const P = I.plates;
  const pg = I.platesGrid;
  const cells = new Map<number, number[]>();
  for (let c = 0; c < pg.cells; c++) {
    const s = P.bSeg[c];
    if (s < 0 || P.segments[s].cls !== B.RIFT) continue;
    let a = cells.get(s);
    if (!a) cells.set(s, (a = []));
    a.push(c);
  }
  const list: Candidate[] = [];
  for (const [s, cs] of cells) {
    const seg = P.segments[s];
    if (seg.lengthKm < 100) continue;
    let onLand = 0;
    for (const c of cs) if (!I.sea[cellAtM(I.fine, cellX(pg, c), cellY(pg, c))]) onLand++;
    if (onLand < 0.6 * cs.length) continue;
    const ax = pca(cs, pg);
    const bins = Math.max(3, Math.min(16, Math.round(seg.lengthKm / 40)));
    const sx = new Float64Array(bins);
    const sy = new Float64Array(bins);
    const sz = new Float64Array(bins);
    const cnt = new Int32Array(bins);
    let mid = cs[0];
    let md = Infinity;
    const q = new Float64Array(3);
    for (const c of cs) {
      axesXY(ax, pg, c, q);
      const dx = q[0] - ax.cx;
      const dy = q[1] - ax.cy;
      const t = dx * ax.ux + dy * ax.uy;
      const b = Math.min(bins - 1, Math.max(0, Math.floor(((t + ax.length / 2) / ax.length) * bins)));
      if (S.sphere) {
        pg.position(c, q);
        sx[b] += q[0];
        sy[b] += q[1];
        sz[b] += q[2];
      } else {
        sx[b] += cellX(pg, c);
        sy[b] += cellY(pg, c);
      }
      cnt[b]++;
      const d = dx * dx + dy * dy;
      if (d < md && !I.sea[cellAtM(I.fine, cellX(pg, c), cellY(pg, c))]) (md = d), (mid = c);
    }
    const pts: number[] = [];
    for (let b = 0; b < bins; b++) {
      if (!cnt[b]) continue;
      if (S.sphere) pts.push(...S.geo.fromDir(sx[b], sy[b], sz[b]));
      else pts.push(sx[b] / cnt[b], sy[b] / cnt[b]);
    }
    const x = cellX(pg, mid);
    const y = cellY(pg, mid);
    list.push(candidate({
      kind: 'rift', x, y, angle: ax.plane ? S.geo.angleOf(x, y, ...axesDir(ax, ax.ux, ax.uy)) : labelAngle(ax.ux, ax.uy),
      extentM: seg.lengthKm * 1000, mag: Math.min(1, seg.lengthKm / 800),
      data: { lengthKm: Math.round(seg.lengthKm) }, idX: x, idY: y, path: S.sphere ? Float64Array.from(pts) : Float32Array.from(pts), tier: 'uncommon',
      landmass: S.masses.label[cellAtM(I.fine, x, y)],
    }));
  }
  list.sort((a, b) => b.extentM - a.extentM);
  out.push(...list.slice(0, 4));
}

/** Mesa fields, karst and tower karst from the landform features. */
function landformAreas(I: RegistryInput, S: Shared, out: Candidate[]): void {
  const fs = I.landforms.features;
  const X = (f: (typeof fs)[number]): number => S.geo.enc(f.face, f.x);
  const pick = (type: string, minKm2: number, cap: number): typeof fs => fs
    .filter((f) => f.type === type && (f.data?.areaKm2 ?? 0) >= minKm2)
    .sort((a, b) => (b.data?.areaKm2 ?? 0) - (a.data?.areaKm2 ?? 0))
    .slice(0, cap);
  for (const f of pick('mesa-field', 150, 4)) {
    const a = f.data?.areaKm2 ?? 0;
    out.push(candidate({
      kind: 'mesa-field', x: X(f), y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, a / 5000),
      data: { areaKm2: Math.round(a), mesas: f.data?.tops ?? 0 }, idX: X(f), idY: f.y, tier: 'uncommon',
    }));
  }
  for (const f of pick('karst', 300, 3)) {
    const a = f.data?.areaKm2 ?? 0;
    out.push(candidate({ kind: 'karst', x: X(f), y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, a / 10000), data: { areaKm2: Math.round(a) }, idX: X(f), idY: f.y, tier: 'uncommon' }));
  }
  for (const f of pick('tower-karst', 200, 2)) {
    const a = f.data?.areaKm2 ?? 0;
    out.push(candidate({
      kind: 'karst', x: X(f), y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, a / 5000), data: { areaKm2: Math.round(a), towers: 1 },
      idX: X(f), idY: f.y, variant: 'towers', tier: 'rare', hero: { cat: 'karst-towers', score: a / 1500 },
    }));
  }
}
