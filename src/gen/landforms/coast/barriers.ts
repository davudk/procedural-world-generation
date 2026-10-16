import { Noise2 } from '../../../shared/noise';
import type { LandformCtx } from '../types';
import { COAST, type CoastInfo } from './classify';
import { DiskSet, DX8, DY8, labelList, line4, poisson, shuffle } from './grid';

// Local copies: hot loops should not read the imported bindings.
const DX = Int8Array.from(DX8);
const DY = Int8Array.from(DY8);

/** Share of eligible low sandy coast fronted by barrier islands at density 1 (Earth: ~10–15 % of all coasts). */
const BARRIER_SHARE = 0.32;
/** Barrier islands may add at most this share of the land area. */
const MAX_LAND_GAIN = 0.006;
/** Spits per 1000 km of sandy coast at density 1 (F15: uncommon). */
const SPIT_RATE = 1.6;
const SPIT_CAP = 25;
const SPIT_SPACING_KM = 25;
/** Tombolos per 1000 km of sandy and sheltered coast at density 1 (F16: rare). */
const TOMBOLO_RATE = 0.4;
const TOMBOLO_CAP = 3;

export interface BarrierResult {
  islands: number;
  spits: number;
  tombolos: number;
  /** Lagoon cell ids (behind barrier islands), for the lagoon features after `fixed` is reconciled. */
  lagoon: Uint8Array;
}

/**
 * Barrier islands and lagoons (F13–F14) on low sandy coasts with moderate waves and small tides:
 * a thin sand ridge a few km offshore (band of the coast distance field), cut by tidal inlets, with
 * a shallow lagoon behind. Spits (F15) grow from headlands along the longshore drift and hook
 * landward; tombolos (F16) join near-shore islets to the mainland with a sand bar.
 */
export function placeBarriers(
  c: LandformCtx, info: CoastInfo, dist: Float32Array, nearest: Int32Array, edited: Uint8Array,
  beach: Uint8Array, marsh: Uint8Array, landCells: number,
): BarrierResult {
  const { n, cellKm, h } = c;
  const N = n * n;
  const { sea, cells, slot, cls, wave, shelf, landShare } = info;
  const rng = c.rng('coastal', 'barriers');
  const noise = new Noise2(rng.nextU32());
  const tide = c.num('tideRange');
  const dens = c.num('density_coast');
  const isl = c.num('islandAbundance');
  const lagoon = new Uint8Array(N);

  // ── Barrier islands ────────────────────────────────────────────────────────────────────────
  const M = cells.length;
  const seg = new Float32Array(M);
  const eligible = new Uint8Array(M);
  const eligVals: number[] = [];
  for (let k = 0; k < M; k++) {
    const i = cells[k];
    if (cls[k] !== COAST.SANDY || wave[k] < 0.18 || wave[k] > 1.1) continue;
    // Mainland shores only (not islets), and not deep inside bays.
    if (shelf[k] < -Math.max(45, 10 * cellKm) || landShare[k] > 0.7 || landShare[k] < 0.3) continue;
    const xk = (i % n) * cellKm;
    const yk = Math.floor(i / n) * cellKm;
    seg[k] = noise.fbm(xk / 110, yk / 110, 2);
    eligible[k] = 1;
    eligVals.push(seg[k]);
  }
  const tideMul = 1 - Math.min(1, Math.max(0, (tide - 0.4) / 0.4));
  // On coarse grids a barrier is a whole cell wide: keep the new land within a small share of the
  // land (each fronted coast cell adds about one barrier cell).
  const budget = (MAX_LAND_GAIN * landCells) / Math.max(1, eligVals.length);
  const share = Math.min(0.85, budget, BARRIER_SHARE * dens * tideMul * (0.7 + 0.3 * isl));
  eligVals.sort((a, b) => a - b);
  const thr = share > 0 && eligVals.length ? eligVals[Math.max(0, Math.floor((1 - share) * eligVals.length) - 1)] : Infinity;
  const offset = new Float32Array(M);
  for (let k = 0; k < M; k++) {
    if (!eligible[k] || seg[k] <= thr) continue;
    const i = cells[k];
    const xk = (i % n) * cellKm;
    const yk = Math.floor(i / n) * cellKm;
    const dKm = 3.5 + 5.5 * (0.5 + 0.5 * noise.noise(xk / 60 + 17.3, yk / 60 - 4.1));
    offset[k] = Math.max(2, Math.round(dKm / cellKm));
  }
  const maxDepth = -Math.max(25, 8 * cellKm);
  const inletKm = 26 / (1 + 2 * tide);
  const bar = new Uint8Array(N);
  let barList: number[] = [];
  const lagList: number[] = [];
  for (let j = 0; j < N; j++) {
    if (!sea[j] || dist[j] > 10) continue;
    const L = nearest[j];
    if (L < 0 || slot[L] < 0) continue;
    const off = offset[slot[L]];
    if (off === 0) continue;
    const d = dist[j];
    if (Math.abs(d - off) <= 0.65) {
      if (h[j] < maxDepth) continue;
      const xk = (j % n) * cellKm;
      const yk = Math.floor(j / n) * cellKm;
      // Tidal inlets: gaps where a short-wavelength noise peaks.
      if (noise.noise(xk / inletKm + 91.7, yk / inletKm + 13.9) > 0.5) continue;
      bar[j] = 1;
      barList.push(j);
    } else if (d < off - 0.65) {
      lagoon[j] = 1;
      lagList.push(j);
    }
  }
  // Close diagonal steps so lagoon water cannot leak to the sea between two barrier cells; prefer
  // the seaward corner, so the lagoon keeps its width.
  const nBar = barList.length;
  for (let t = 0; t < nBar; t++) {
    const a = barList[t];
    const x = a % n;
    const y = (a - x) / n;
    if (y >= n - 1) continue;
    for (const sx of [-1, 1]) {
      if (x + sx < 0 || x + sx >= n) continue;
      const side = a + sx;
      const below = a + n;
      if (!bar[below + sx] || bar[side] || bar[below]) continue;
      const pick = sea[side] && !lagoon[side] ? side : below;
      if (sea[pick] && !bar[pick]) {
        bar[pick] = 1;
        barList.push(pick);
      }
    }
  }
  const label = new Int32Array(N).fill(-1);
  // Drop specks: a barrier island is at least ~4 km long.
  const minBar = Math.max(2, Math.round(4 / cellKm));
  const barSizes0 = labelList(barList, bar, n, label);
  for (const j of barList) if (barSizes0[label[j]] < minBar) bar[j] = 0;
  barList = barList.filter((j) => bar[j] === 1);
  label.fill(-1);
  const lagSizes = labelList(lagList, lagoon, n, label);
  const fronted = new Uint8Array(lagSizes.length);
  for (const j of barList) {
    lagoon[j] = 0;
    const x = j % n;
    const y = (j - x) / n;
    for (let d = 0; d < 8; d++) {
      const xx = x + DX[d];
      const yy = y + DY[d];
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const l = label[yy * n + xx];
      if (l >= 0 && lagoon[yy * n + xx]) fronted[l] = 1;
    }
  }
  // Keep only lagoon water actually fronted by a barrier – drop strays.
  for (const j of lagList) {
    if (!lagoon[j]) continue;
    if (!fronted[label[j]]) {
      lagoon[j] = 0;
      continue;
    }
    h[j] = Math.min(-0.5, Math.max(h[j], -4));
    edited[j] = 1;
    // Salt marsh / tidal flats on the landward shore of lagoons (F18).
    const x = j % n;
    const y = (j - x) / n;
    for (let d = 0; d < 8; d++) {
      const xx = x + DX[d];
      const yy = y + DY[d];
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
      const q = yy * n + xx;
      if (!sea[q] && !bar[q] && h[q] > 0 && h[q] < 12) marsh[q] = 255;
    }
  }
  for (const j of barList) {
    const xk = (j % n) * cellKm;
    const yk = Math.floor(j / n) * cellKm;
    h[j] = 1.5 + 4 * (0.5 + 0.5 * noise.noise(xk / 3 + 5.5, yk / 3 - 7.7));
    edited[j] = 1;
    beach[j] = 255;
    marsh[j] = 0;
  }
  label.fill(-1);
  const barSizes = labelList(barList, bar, n, label);
  let islands = 0;
  {
    const K = barSizes.length;
    const bx0 = new Int32Array(K).fill(n);
    const bx1 = new Int32Array(K).fill(-1);
    const by0 = new Int32Array(K).fill(n);
    const by1 = new Int32Array(K).fill(-1);
    for (const j of barList) {
      const l = label[j];
      const x = j % n;
      const y = (j - x) / n;
      bx0[l] = Math.min(bx0[l], x);
      bx1[l] = Math.max(bx1[l], x);
      by0[l] = Math.min(by0[l], y);
      by1[l] = Math.max(by1[l], y);
    }
    for (let l = 0; l < K; l++) {
      if (barSizes[l] < 2) continue;
      islands++;
      const len = Math.hypot(bx1[l] - bx0[l] + 1, by1[l] - by0[l] + 1) * cellKm * 1000;
      c.features.push({
        type: 'barrier-island', x: ((bx0[l] + bx1[l]) / 2 + 0.5) * cellKm * 1000, y: ((by0[l] + by1[l]) / 2 + 0.5) * cellKm * 1000,
        size: len, data: { cells: barSizes[l] },
      });
    }
  }

  // ── Spits ───────────────────────────────────────────────────────────────────────────────────
  let sandyKm = 0;
  let softKm = 0;
  for (let k = 0; k < M; k++) {
    if (cls[k] === COAST.SANDY) sandyKm += cellKm;
    if (cls[k] === COAST.SANDY || cls[k] === COAST.SHELTERED) softKm += cellKm;
  }
  const spitCand: number[] = [];
  for (let k = 0; k < M; k++) {
    if (cls[k] !== COAST.SANDY && cls[k] !== COAST.SHELTERED) continue;
    if (landShare[k] > 0.42 || wave[k] < 0.2 || edited[cells[k]]) continue;
    spitCand.push(k);
  }
  shuffle(rng, spitCand);
  const wantSpits = Math.min(SPIT_CAP, poisson(rng, (SPIT_RATE * dens * sandyKm) / 1000));
  const spitDisk = new DiskSet(SPIT_SPACING_KM);
  const spitDepth = -Math.max(20, 6 * cellKm);
  let spits = 0;
  for (const k of spitCand) {
    if (spits >= wantSpits) break;
    const i = cells[k];
    const tx = -info.ny[k];
    const ty = info.nx[k];
    const wt = info.wx[k] * tx + info.wy[k] * ty;
    if (Math.abs(wt) < 0.25) continue;
    let dx = Math.sign(wt) * tx;
    let dy = Math.sign(wt) * ty;
    const x0 = i % n;
    const y0 = (i - x0) / n;
    const pxk = (x0 + 0.5) * cellKm;
    const pyk = (y0 + 0.5) * cellKm;
    if (!spitDisk.free(pxk, pyk)) continue;
    const lenCells = Math.max(2, Math.round(rng.range(6, 24) / cellKm));
    const hookSign = -Math.sign(dx * info.ny[k] - dy * info.nx[k]) || 1;
    let fx = x0 + 0.5 + info.nx[k];
    let fy = y0 + 0.5 + info.ny[k];
    const path: number[] = [];
    let prev = i;
    let ok = true;
    for (let s = 0; s < lenCells; s++) {
      // Hook: the last third turns landward (toward −normal) by up to ~60°.
      if (s > lenCells * 0.65) {
        const a = hookSign / Math.max(1, lenCells * 0.35);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        [dx, dy] = [dx * ca - dy * sa, dx * sa + dy * ca];
      }
      const cx = Math.floor(fx);
      const cy = Math.floor(fy);
      if (cx < 1 || cy < 1 || cx >= n - 1 || cy >= n - 1) break;
      const j = cy * n + cx;
      if (j !== prev) {
        const seg4 = line4(n, prev, j).slice(1);
        for (const q of seg4) {
          if (path.length === 0 && !sea[q]) continue;
          if (!sea[q] || edited[q] || h[q] < spitDepth || (path.length >= 2 && dist[q] < 1.9)) {
            ok = false;
            break;
          }
          path.push(q);
        }
        if (!ok) break;
        prev = j;
      }
      fx += dx;
      fy += dy;
    }
    const minLen = Math.max(2, Math.round(4 / cellKm));
    if (path.length < minLen) continue;
    for (const q of path) {
      h[q] = 1 + 2 * rng.float();
      edited[q] = 1;
      beach[q] = 255;
    }
    spitDisk.add(pxk, pyk);
    spits++;
    c.features.push({ type: 'spit', x: pxk * 1000, y: pyk * 1000, size: path.length * cellKm * 1000, data: { dirX: dx, dirY: dy } });
  }

  // ── Tombolos ────────────────────────────────────────────────────────────────────────────────
  // Island sizes by a capped flood from coastal cells: anything over the cap counts as mainland.
  const maxIsland = Math.max(1, Math.round(150 / (cellKm * cellKm)));
  const isLand = (q: number): boolean => !sea[q] && h[q] > 0;
  const comp = new Int32Array(N).fill(-1); // −2 = mainland, ≥ 0 = island id
  const islandSize: number[] = [];
  const explore = (s0: number): number => {
    if (comp[s0] !== -1) return comp[s0];
    const seen: number[] = [s0];
    comp[s0] = -3;
    let big = false;
    for (let t = 0; t < seen.length && !big; t++) {
      const q = seen[t];
      const x = q % n;
      const y = (q - x) / n;
      for (let d = 0; d < 8; d++) {
        const xx = x + DX[d];
        const yy = y + DY[d];
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const j = yy * n + xx;
        if (!isLand(j) || comp[j] === -3) continue;
        if (comp[j] === -2 || seen.length >= maxIsland) {
          big = true;
          break;
        }
        comp[j] = -3;
        seen.push(j);
      }
    }
    const id = big ? -2 : islandSize.length;
    if (!big) islandSize.push(seen.length);
    for (const q of seen) comp[q] = id;
    return id;
  };
  const reach = Math.max(2, Math.round(8 / cellKm));
  const barDepth = -Math.max(15, 5 * cellKm);
  const best = new Map<number, { a: number; b: number; len: number }>();
  for (let k = 0; k < M; k++) {
    const j = cells[k];
    if (!isLand(j) || edited[j]) continue;
    const l = explore(j);
    if (l < 0) continue;
    const x = j % n;
    const y = (j - x) / n;
    for (let d = 0; d < 8; d++) {
      for (let s = 1; s <= reach; s++) {
        const xx = x + DX[d] * s;
        const yy = y + DY[d] * s;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) break;
        const q = yy * n + xx;
        if (isLand(q)) {
          const k2 = info.classOf[q];
          if (s >= 2 && (k2 === COAST.SANDY || k2 === COAST.SHELTERED) && explore(q) === -2) {
            const cur = best.get(l);
            if (!cur || s < cur.len) best.set(l, { a: j, b: q, len: s });
          }
          break;
        }
        if (!sea[q] || h[q] < barDepth || edited[q]) break;
      }
    }
  }
  const tCand = [...best.values()].sort((p, q) => p.a - q.a);
  shuffle(rng, tCand);
  const wantT = Math.min(TOMBOLO_CAP, poisson(rng, (TOMBOLO_RATE * dens * (0.5 + 0.5 * isl) * softKm) / 1000));
  let tombolos = 0;
  for (const t of tCand) {
    if (tombolos >= wantT) break;
    const path = line4(n, t.a, t.b).filter((q) => sea[q]);
    if (path.some((q) => edited[q])) continue;
    for (const q of path) {
      h[q] = 1 + rng.float();
      edited[q] = 1;
      beach[q] = 255;
    }
    tombolos++;
    const ax = (t.a % n) + 0.5;
    const ay = Math.floor(t.a / n) + 0.5;
    const bx = (t.b % n) + 0.5;
    const by = Math.floor(t.b / n) + 0.5;
    c.features.push({
      type: 'tombolo', x: ((ax + bx) / 2) * cellKm * 1000, y: ((ay + by) / 2) * cellKm * 1000,
      size: Math.hypot(bx - ax, by - ay) * cellKm * 1000,
    });
  }
  return { islands, spits, tombolos, lagoon };
}
