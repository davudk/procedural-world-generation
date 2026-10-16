import { B } from '../stages/plates';
import { cellAtM, cellX, cellY, insideDistance, label, labelAngle, mergeTree, nearestWhere, pca, resolveOwners, type GridSpec } from './grid';
import { G } from './shared';
import type { Candidate, RegistryInput, Shared } from './types';

/** Peaks need this much topographic prominence (m). */
const PEAK_MIN_PROM = 300;
/** Minimum spacing of labelled peaks (km, research 05 §3.3). */
const PEAK_SPACING_KM = 6;

export interface ReliefResult {
  /** Range id per regional cell (−1 outside ranges), for canyons. */
  rangeOf: Int32Array;
  /** Highest peak of the world (map metres, m). */
  king: { x: number; y: number; h: number } | null;
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
  const { n, cellM } = I.fine;
  const N = n * n;
  const land = new Uint8Array(N);
  for (let c = 0; c < N; c++) land[c] = I.sea[c] ? 0 : 1;
  const t = mergeTree(I.h, land, n, true, 1);
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
  const volcanoes: Candidate[] = [];
  for (const f of fs) {
    if (f.type !== 'stratovolcano' && f.type !== 'shield-volcano' && f.type !== 'caldera' && f.type !== 'crater') continue;
    const fx = f.x / cellM;
    const fy = f.y / cellM;
    const rad = Math.max(f.size / 2 / cellM, 1.5);
    if (f.type === 'crater') {
      const D = f.data?.diameter ?? f.size;
      const c: Candidate = {
        kind: 'crater', x: f.x, y: f.y, angle: NaN, extentM: D, mag: Math.min(1, D / 40000),
        data: { diameterKm: Math.round(D / 100) / 10, depthM: Math.round(f.data?.depth ?? 0) }, idX: f.x, idY: f.y,
        hero: { cat: 'crater', score: D / 20000 }, tier: D >= 50000 ? 'legendary' : 'rare',
      };
      volcanoes.push(c);
      continue;
    }
    // Highest prominent summit inside the edifice.
    let best = -1;
    const r = Math.ceil(rad);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= n || y >= n || dx * dx + dy * dy > rad * rad) continue;
        const c = y * n + x;
        if (!land[c]) continue;
        if (best < 0 || I.h[c] > I.h[best]) best = c;
      }
    }
    if (f.type === 'caldera') {
      volcanoes.push({
        kind: 'caldera', x: f.x, y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, f.size / 30000),
        data: { diameterKm: Math.round(f.size / 100) / 10, depthM: Math.round(f.data?.depth ?? 0), rimM: Math.round(f.data?.rim ?? 0) },
        idX: f.x, idY: f.y, tier: 'rare',
      });
      continue;
    }
    if (best < 0) continue;
    // The summit's own prominence component, if its peak lies on the edifice.
    let k = t.owner[best];
    if (k >= 0) {
      const pc = t.peak[k];
      if (((pc % n) + 0.5 - fx) ** 2 + (Math.floor(pc / n) + 0.5 - fy) ** 2 > (rad + 1) ** 2) k = -1;
    }
    if (k >= 0) used[k] = 1;
    const hgt = I.h[best];
    const x = cellX(I.fine, best);
    const y = cellY(I.fine, best);
    volcanoes.push({
      kind: 'volcano', x, y, angle: NaN, extentM: f.size, mag: 0.7 * Math.min(1, hgt / Math.max(kingH, 1)) + 0.3 * Math.min(1, f.size / 40000),
      data: { heightM: Math.round(hgt), ...(k >= 0 ? { prominenceM: Math.round(prom[k]) } : {}), diameterKm: Math.round(f.size / 100) / 10, shield: f.type === 'shield-volcano' ? 1 : 0 },
      idX: f.x, idY: f.y, variant: f.type === 'shield-volcano' ? 'shield' : 'strato', visM: Math.max(f.size, 3000),
    });
  }
  const nVol = volcanoes.filter((v) => v.kind === 'volcano').length;
  let tallest: Candidate | null = null;
  for (const v of volcanoes) if (v.kind === 'volcano' && (!tallest || v.data.heightM > tallest.data.heightM)) tallest = v;
  if (tallest) tallest.hero = { cat: 'volcano', score: Math.max(tallest.data.heightM / 4000, nVol / 6) };
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
  const cap = Math.round(Math.min(60, Math.max(8, S.landKm2 / 7000)));
  const sp = (PEAK_SPACING_KM * 1000) / cellM;
  const taken: number[] = [];
  const peaks: Candidate[] = [];
  for (const k of cand) {
    if (peaks.length >= cap) break;
    const c = t.peak[k];
    const x = c % n;
    const y = (c - x) / n;
    if (taken.some((o) => ((o % n) - x) ** 2 + (Math.floor(o / n) - y) ** 2 < sp * sp)) continue;
    taken.push(c);
    const p = prom[k];
    const hgt = t.peakV[k];
    const isKing = k === kingK;
    const px = cellX(I.fine, c);
    const py = cellY(I.fine, c);
    peaks.push({
      kind: 'peak', x: px, y: py, angle: NaN, extentM: Math.max(cellM, Math.min(p * 6, 30000)),
      visM: isKing ? 16000 : 1000 * (p / PEAK_MIN_PROM) ** 0.9, mag: 0.6 * Math.min(1, hgt / Math.max(kingH, 1)) + 0.4 * Math.min(1, p / 3000),
      data: { heightM: Math.round(hgt), prominenceM: Math.round(p), ...(isKing ? { worldKing: 1 } : {}) }, idX: px, idY: py,
      tier: hgt >= 7500 ? 'legendary' : hgt >= 5000 ? 'rare' : isKing ? 'uncommon' : 'common',
      landmass: S.masses.label[c],
    });
  }
  out.push(...peaks);

  const rangeOf = detectRanges(I, S, out, peaks);
  detectFlats(I, S, out, rangeOf);
  detectRifts(I, S, out);
  landformAreas(I, out);
  const king = kingK >= 0 ? { x: cellX(I.fine, t.peak[kingK]), y: cellY(I.fine, t.peak[kingK]), h: kingH } : null;
  return { rangeOf, king };
}

/**
 * Ranges: regional cells whose ~20 km mean elevation is high for this world and whose relief is
 * rough; significant components of their merge tree (a sub-range must rise ≥ 400 m above the col
 * joining it to a higher one) become ranges, the highest labelled peak inside each is its king.
 */
function detectRanges(I: RegistryInput, S: Shared, out: Candidate[], peaks: Candidate[]): Int32Array {
  const R = S.reg;
  const m = R.n;
  const MM = m * m;
  const rKm = R.cellM / 1000;
  let top = 0;
  for (let i = 0; i < MM; i++) if (S.land[i] && S.hSmooth[i] > top) top = S.hSmooth[i];
  const T = Math.max(700, 0.3 * top);
  const mask = new Uint8Array(MM);
  for (let i = 0; i < MM; i++) mask[i] = S.land[i] && S.hSmooth[i] >= T && S.relief[i] >= 120 ? 1 : 0;
  const t = mergeTree(S.hSmooth, mask, m, true, 5);
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
    const ax = pca(cells, m, (c) => S.hSmooth[c] - T + 50);
    const lenKm = ax.length * rKm;
    if (lenKm < 50) continue;
    const widthKm = ax.width * rKm;
    // Crest: highest cell per bin along the major axis.
    const bins = Math.max(3, Math.min(24, Math.round(lenKm / 25)));
    const half = ax.length / 2;
    const bestC = new Int32Array(bins).fill(-1);
    let maxH = 0;
    let sumRel = 0;
    for (const c of cells) {
      const dx = (c % m) - ax.cx;
      const dy = Math.floor(c / m) - ax.cy;
      const s = dx * ax.ux + dy * ax.uy;
      const b = Math.min(bins - 1, Math.max(0, Math.floor(((s + half) / ax.length) * bins)));
      if (bestC[b] < 0 || S.hSmooth[c] > S.hSmooth[bestC[b]]) bestC[b] = c;
      maxH = Math.max(maxH, S.hMax[c]);
      sumRel += S.relief[c];
    }
    const pts: number[] = [];
    for (let b = 0; b < bins; b++) if (bestC[b] >= 0) pts.push(bestC[b]);
    const path = new Float32Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      // 3-point smoothing of the crest.
      let sx = 0;
      let sy = 0;
      let w = 0;
      for (let j = Math.max(0, i - 1); j <= Math.min(pts.length - 1, i + 1); j++) {
        const wj = j === i ? 2 : 1;
        sx += wj * cellX(R, pts[j]);
        sy += wj * cellY(R, pts[j]);
        w += wj;
      }
      path[2 * i] = sx / w;
      path[2 * i + 1] = sy / w;
    }
    const mid = pts[Math.floor(pts.length / 2)];
    const fa = nearestWhere(I.fine.n, cellX(R, mid) / I.fine.cellM, cellY(R, mid) / I.fine.cellM, 3 * S.f, (c) => !I.sea[c]);
    const x = fa >= 0 ? cellX(I.fine, fa) : cellX(R, mid);
    const y = fa >= 0 ? cellY(I.fine, fa) : cellY(R, mid);
    const meanRel = sumRel / cells.length;
    const variant = maxH < 1500 ? 'hills' : meanRel < 250 || widthKm > 0.7 * lenKm ? 'highlands' : 'range';
    const areaKm2 = cells.length * rKm * rKm;
    ranges.push({
      id,
      c: {
        kind: 'range', x, y, angle: labelAngle(ax.ux, ax.uy), extentM: lenKm * 1000, mag: 0.5 * Math.min(1, lenKm / 600) + 0.5 * Math.min(1, maxH / 6000),
        data: { lengthKm: Math.round(lenKm), widthKm: Math.round(widthKm), maxHeightM: Math.round(maxH), areaKm2: Math.round(areaKm2) },
        idX: cellX(R, t.peak[id]), idY: cellY(R, t.peak[id]), path, variant, hero: { cat: 'massif', score: maxH / 5000 },
        landmass: fa >= 0 ? S.masses.label[fa] : -1,
      },
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

/** Plateaus (high and flat) and plains (low and flat): large regional components. */
function detectFlats(I: RegistryInput, S: Shared, out: Candidate[], rangeOf: Int32Array): void {
  const R = S.reg;
  const m = R.n;
  const MM = m * m;
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
    const comps = label(mask, m, true);
    const inside = insideDistance(mask, m);
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
      const areaKm2 = comps.size[k] * rKm2;
      if (areaKm2 < minKm2) continue;
      const px = cellX(R, pole[k]);
      const py = cellY(R, pole[k]);
      const fa = nearestWhere(I.fine.n, px / I.fine.cellM, py / I.fine.cellM, 3 * S.f, (c) => !I.sea[c]);
      const x = fa >= 0 ? cellX(I.fine, fa) : px;
      const y = fa >= 0 ? cellY(I.fine, fa) : py;
      list.push({
        kind, x, y, angle: NaN, extentM: Math.sqrt(areaKm2) * 1000, mag: Math.min(1, areaKm2 / 100000),
        data: { areaKm2: Math.round(areaKm2), elevationM: Math.round(sumH[k] / comps.size[k]) }, idX: px, idY: py,
        landmass: fa >= 0 ? S.masses.label[fa] : -1, variant: kind === 'plain' && areaKm2 > 40000 ? 'lowlands' : kind,
      });
    }
    list.sort((a, b) => b.extentM - a.extentM);
    out.push(...list.slice(0, cap));
  };
  emit(plateau, 'plateau', 2500, 4);
  emit(plain, 'plain', 15000, 3);
}

/** Continental rift segments (plates) of ≥ 100 km, mostly on land. */
function detectRifts(I: RegistryInput, S: Shared, out: Candidate[]): void {
  const P = I.plates;
  const pg: GridSpec = { n: P.n, cellM: P.cellKm * 1000 };
  const cells = new Map<number, number[]>();
  for (let c = 0; c < P.n * P.n; c++) {
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
    const ax = pca(cs, P.n);
    const bins = Math.max(3, Math.min(16, Math.round(seg.lengthKm / 40)));
    const sx = new Float64Array(bins);
    const sy = new Float64Array(bins);
    const cnt = new Int32Array(bins);
    let mid = cs[0];
    let md = Infinity;
    for (const c of cs) {
      const dx = (c % P.n) - ax.cx;
      const dy = Math.floor(c / P.n) - ax.cy;
      const t = dx * ax.ux + dy * ax.uy;
      const b = Math.min(bins - 1, Math.max(0, Math.floor(((t + ax.length / 2) / ax.length) * bins)));
      sx[b] += cellX(pg, c);
      sy[b] += cellY(pg, c);
      cnt[b]++;
      const d = dx * dx + dy * dy;
      if (d < md && !I.sea[cellAtM(I.fine, cellX(pg, c), cellY(pg, c))]) (md = d), (mid = c);
    }
    const pts: number[] = [];
    for (let b = 0; b < bins; b++) if (cnt[b]) pts.push(sx[b] / cnt[b], sy[b] / cnt[b]);
    const x = cellX(pg, mid);
    const y = cellY(pg, mid);
    list.push({
      kind: 'rift', x, y, angle: labelAngle(ax.ux, ax.uy), extentM: seg.lengthKm * 1000, mag: Math.min(1, seg.lengthKm / 800),
      data: { lengthKm: Math.round(seg.lengthKm) }, idX: x, idY: y, path: Float32Array.from(pts), tier: 'uncommon',
      landmass: S.masses.label[cellAtM(I.fine, x, y)],
    });
  }
  list.sort((a, b) => b.extentM - a.extentM);
  out.push(...list.slice(0, 4));
}

/** Mesa fields, karst and tower karst from the landform features. */
function landformAreas(I: RegistryInput, out: Candidate[]): void {
  const fs = I.landforms.features;
  const pick = (type: string, minKm2: number, cap: number): typeof fs => fs
    .filter((f) => f.type === type && (f.data?.areaKm2 ?? 0) >= minKm2)
    .sort((a, b) => (b.data?.areaKm2 ?? 0) - (a.data?.areaKm2 ?? 0))
    .slice(0, cap);
  for (const f of pick('mesa-field', 150, 4)) {
    const a = f.data?.areaKm2 ?? 0;
    out.push({
      kind: 'mesa-field', x: f.x, y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, a / 5000),
      data: { areaKm2: Math.round(a), mesas: f.data?.tops ?? 0 }, idX: f.x, idY: f.y, tier: 'uncommon',
    });
  }
  for (const f of pick('karst', 300, 3)) {
    const a = f.data?.areaKm2 ?? 0;
    out.push({ kind: 'karst', x: f.x, y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, a / 10000), data: { areaKm2: Math.round(a) }, idX: f.x, idY: f.y, tier: 'uncommon' });
  }
  for (const f of pick('tower-karst', 200, 2)) {
    const a = f.data?.areaKm2 ?? 0;
    out.push({
      kind: 'karst', x: f.x, y: f.y, angle: NaN, extentM: f.size, mag: Math.min(1, a / 5000), data: { areaKm2: Math.round(a), towers: 1 },
      idX: f.x, idY: f.y, variant: 'towers', tier: 'rare', hero: { cat: 'karst-towers', score: a / 1500 },
    });
  }
}
