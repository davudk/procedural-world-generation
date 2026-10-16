import { Noise2 } from '../../../shared/noise';
import { blockGrid, cellIndex, cellX, cellY, tryCellIndex } from '../../grid/grid';
import type { LandformCtx } from '../types';
import { COAST, type CoastInfo } from './classify';
import { components8, DiskSet, poisson, shuffle } from './grid';

/** Coral needs the cold-season sea surface at or above this (°C; research 03 §4). */
const REEF_SST = 20;
/** Atolls per 10⁵ km² of warm ocean at density 1 (research 05 §4 row 38: 0.3–1). */
const ATOLL_RATE = 0.6;
const ATOLL_CAP = 6;
const ATOLL_SPACING_KM = 20;
/** Share of warm reef-able coast with an offshore barrier reef. */
const BARRIER_REEF_SHARE = 0.14;

export interface ReefResult {
  fringingCells: number;
  barrierCells: number;
  reefs: number;
  atolls: number;
  warmOceanKm2: number;
}

/**
 * Coral reefs (F20) and atolls (F21). Reefs need warm (cold-season SST ≥ 20 °C), shallow, clear water:
 * fringing reefs hug exposed tropical shores (mask only: they are narrower than a macro cell);
 * barrier reefs are a crest raised to just below sea level ~10–25 km offshore on tropical shelves,
 * with passes. Atolls form on prominent seamounts or small subsided islands in deep warm ocean,
 * favouring the old end of hotspot chains (a taller, younger volcano along the plate motion): a thin
 * ring reef at sea level with a few islets (motu) and a lagoon inside. Writes the `reef` mask.
 */
export function placeReefs(
  c: LandformCtx, info: CoastInfo, dist: Float32Array, nearest: Int32Array, edited: Uint8Array, mask: Uint8Array,
): ReefResult {
  const { grid: g, n, cellKm, h } = c;
  const N = g.cells;
  const { temp, tAmp } = c.climate;
  const { sea, slot, cls, exposure } = info;
  const rng = c.rng('coastal', 'reefs');
  const noise = new Noise2(rng.nextU32());
  const dens = c.num('density_coast');
  const isl = c.num('islandAbundance');
  const res: ReefResult = { fringingCells: 0, barrierCells: 0, reefs: 0, atolls: 0, warmOceanKm2: 0 };

  const sst = (j: number): number => {
    const xk = cellX(g, j) * cellKm;
    const yk = cellY(g, j) * cellKm;
    return temp[j] + 0.0065 * Math.max(0, h[j]) - 0.5 * tAmp[j] + noise.noise(xk / 80, yk / 80);
  };
  // Warm sea cells (coarse estimate on a strided sample is enough for the area).
  const stride = Math.max(1, Math.round(4 / cellKm));
  let warm = 0;
  for (let y = 0; y < n; y += stride) {
    for (let x = 0; x < n; x += stride) {
      const j = cellIndex(g, x, y);
      if (sea[j] && temp[j] - 0.5 * tAmp[j] >= REEF_SST) warm++;
    }
  }
  res.warmOceanKm2 = warm * (stride * cellKm) ** 2;

  // ── Fringing and barrier reefs ────────────────────────────────────────────────────────────
  const fringeCells = Math.max(1, Math.round(2 / cellKm));
  const fringeDepth = -Math.max(40, 12 * cellKm);
  const reefCell = new Uint8Array(N);
  if (warm > 0) {
    // Per coastal cell: barrier-reef offset (10–25 km) and whether the stretch carries one.
    const M = info.cells.length;
    const offR = new Float32Array(M);
    for (let k = 0; k < M; k++) {
      const i = info.cells[k];
      const xk = cellX(g, i) * cellKm;
      const yk = cellY(g, i) * cellKm;
      if (cls[k] === COAST.ICE || noise.fbm(xk / 160 - 21, yk / 160 + 37, 2) < 0.62 - 1.6 * BARRIER_REEF_SHARE) continue;
      offR[k] = Math.max(3, Math.round((10 + 15 * (0.5 + 0.5 * noise.noise(xk / 120 + 41, yk / 120 - 9))) / cellKm));
    }
    const reach = 9 + 25 / cellKm;
    for (let j = 0; j < N; j++) {
      if (!sea[j] || dist[j] > reach || h[j] > 0) continue;
      const L = nearest[j];
      const k = L >= 0 ? slot[L] : -1;
      if (k < 0 || cls[k] === COAST.ICE) continue;
      const d = dist[j];
      const fringe = d <= fringeCells && h[j] >= fringeDepth && !edited[j];
      const band = !fringe && offR[k] > 0 && Math.abs(d - offR[k]) <= 0.6 && h[j] >= -70 && h[j] <= -2 && !edited[j];
      if (!fringe && !band) continue;
      if (temp[j] - 0.5 * tAmp[j] < REEF_SST - 2 || sst(j) < REEF_SST) continue;
      const xk = cellX(g, j) * cellKm;
      const yk = cellY(g, j) * cellKm;
      if (fringe) {
        // Muddy, sheltered shores (mangrove and marsh coasts) rarely carry reefs.
        const clear = cls[k] === COAST.SHELTERED ? -0.35 : exposure[k] < 0.12 ? -0.1 : 0.2;
        if (noise.fbm(xk / 25 + 3.3, yk / 25 - 8.1, 2) + clear > -0.1) {
          reefCell[j] = 1;
          mask[j] = Math.max(mask[j], 190);
          res.fringingCells++;
        }
        continue;
      }
      // Barrier reef crest just below sea level, with passes.
      if (noise.noise(xk / 7 + 1.7, yk / 7 + 2.9) > 0.55) continue;
      h[j] = -1 - 1.5 * rng.float();
      edited[j] = 1;
      reefCell[j] = 1;
      mask[j] = 255;
      res.barrierCells++;
    }
  }

  // ── Atolls ────────────────────────────────────────────────────────────────────────────────
  const atolls = placeAtolls(c, edited, mask, reefCell, sst, res.warmOceanKm2, dens, isl);
  res.atolls = atolls;

  // Reef features: contiguous reef tracts of ≥ ~25 km² (atolls are features of their own).
  const minCells = Math.max(3, Math.round(25 / cellKm));
  const rc = components8(reefCell, g);
  const sx = new Float64Array(rc.sizes.length);
  const sy = new Float64Array(rc.sizes.length);
  const crest = new Uint8Array(rc.sizes.length);
  for (let j = 0; j < N; j++) {
    const l = rc.label[j];
    if (l < 0) continue;
    sx[l] += cellX(g, j);
    sy[l] += cellY(g, j);
    if (mask[j] === 255) crest[l] = 1;
  }
  for (let l = 0; l < rc.sizes.length; l++) {
    if (rc.sizes[l] < minCells) continue;
    res.reefs++;
    c.features.push({
      type: 'reef', x: (sx[l] / rc.sizes[l] + 0.5) * cellKm * 1000, y: (sy[l] / rc.sizes[l] + 0.5) * cellKm * 1000,
      size: rc.sizes[l] * cellKm * 1000, data: { barrier: crest[l] },
    });
  }
  return res;
}

function placeAtolls(
  c: LandformCtx, edited: Uint8Array, mask: Uint8Array, reefCell: Uint8Array,
  sst: (j: number) => number, warmKm2: number, dens: number, isl: number,
): number {
  const { grid: g, n, cellKm, h } = c;
  const P = c.plates;
  const pg = c.platesGrid;
  const rng = c.rng('coastal', 'atolls');
  if (warmKm2 <= 0) return 0;
  // Coarse 6 km blocks: max height and where it is.
  const B = Math.max(1, Math.round(6 / cellKm));
  const bg = blockGrid(g, B);
  const m = bg.n;
  const mx = new Float32Array(m * m).fill(-Infinity);
  const arg = new Int32Array(m * m).fill(-1);
  for (let y = 0; y < n; y++) {
    const br = cellIndex(bg, 0, Math.floor(y / B));
    const row = cellIndex(g, 0, y);
    for (let x = 0; x < n; x++) {
      const i = row + x;
      const b = br + Math.floor(x / B);
      if (h[i] > mx[b]) {
        mx[b] = h[i];
        arg[b] = i;
      }
    }
  }
  const bKm = B * cellKm;
  const peakR = Math.max(2, Math.round(18 / bKm));
  const ring0 = Math.max(peakR + 1, Math.round(30 / bKm));
  const ring1 = ring0 + 1;
  const cand: { i: number; score: number }[] = [];
  for (let by = ring1; by < m - ring1; by++) {
    for (let bx = ring1; bx < m - ring1; bx++) {
      const b = cellIndex(bg, bx, by);
      const pk = mx[b];
      if (pk < -1800 || pk > 300) continue;
      let isMax = true;
      for (let dy = -peakR; dy <= peakR && isMax; dy++) {
        for (let dx = -peakR; dx <= peakR; dx++) {
          if (!dx && !dy) continue;
          const o = cellIndex(bg, bx + dx, by + dy);
          const v = mx[o];
          if (v > pk || (v === pk && o < b)) {
            isMax = false;
            break;
          }
        }
      }
      if (!isMax) continue;
      let sum = 0;
      let cnt = 0;
      for (let dy = -ring1; dy <= ring1; dy++) {
        for (let dx = -ring1; dx <= ring1; dx++) {
          const r = Math.max(Math.abs(dx), Math.abs(dy));
          if (r < ring0) continue;
          sum += mx[cellIndex(bg, bx + dx, by + dy)];
          cnt++;
        }
      }
      const floor = sum / cnt;
      if (floor > -1500 || pk - floor < 900) continue;
      const i = arg[b];
      if (sst(i) < REEF_SST + 0.5) continue;
      // Old end of a hotspot chain: a taller (younger) edifice along the plate motion within 300 km.
      const pu = Math.min(P.n - 1, Math.floor((cellX(g, i) / n) * P.n));
      const pv = Math.min(P.n - 1, Math.floor((cellY(g, i) / n) * P.n));
      const pl = P.plate[cellIndex(pg, pu, pv)];
      const sp = Math.hypot(P.vx[pl], P.vy[pl]) || 1;
      const ux = P.vx[pl] / sp;
      const uy = P.vy[pl] / sp;
      let chain = 0;
      for (let s = 40; s <= 300; s += bKm) {
        const q = tryCellIndex(bg, Math.round(bx + (ux * s) / bKm), Math.round(by + (uy * s) / bKm));
        if (q < 0) break;
        if (mx[q] > pk + 500) {
          chain = 1;
          break;
        }
      }
      cand.push({ i, score: chain + (pk > -400 ? 0.5 : 0) + rng.float() * 0.4 });
    }
  }
  if (cand.length === 0) return 0;
  cand.sort((a, b) => b.score - a.score || a.i - b.i);
  let want = Math.min(ATOLL_CAP, poisson(rng, (ATOLL_RATE * dens * (0.5 + 0.5 * isl) * warmKm2) / 1e5));
  // Rare tier: one is guaranteed where a warm hotspot chain offers a subsided edifice.
  if (want === 0 && dens > 0 && cand[0].score >= 1 && warmKm2 >= 1e5) want = 1;
  const disk = new DiskSet(ATOLL_SPACING_KM + 30);
  let made = 0;
  for (const { i } of cand) {
    if (made >= want) break;
    const cx = cellX(g, i) + 0.5;
    const cy = cellY(g, i) + 0.5;
    if (!disk.free(cx * cellKm, cy * cellKm)) continue;
    const R = Math.max(1.6, rng.range(3, 9) / cellKm);
    const half = 0.55;
    const lagoonDepth = rng.range(15, 55);
    const reach = Math.ceil(R + 3);
    const ring: number[] = [];
    for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(n - 1, Math.ceil(cy + reach)); y++) {
      for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(n - 1, Math.ceil(cx + reach)); x++) {
        const j = cellIndex(g, x, y);
        if (edited[j] || (!c.fixed[j] && h[j] > 250)) continue;
        const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (r < R - half) {
          h[j] = -lagoonDepth * (0.7 + 0.3 * (1 - r / R));
          edited[j] = 1;
        } else if (r <= R + half) {
          ring.push(j);
        } else if (r < R + 3) {
          const flank = -350 * (r - R - half);
          if (h[j] < flank) {
            h[j] = flank;
            edited[j] = 1;
          }
        }
      }
    }
    shuffle(rng, ring);
    let motu = 0;
    for (let k = 0; k < ring.length; k++) {
      const j = ring[k];
      // A third of the ring carries islets; at least two passes stay open.
      const islet = k >= 2 && rng.float() < 0.33;
      h[j] = islet ? 1 + 2.5 * rng.float() : -0.5 - 1.5 * rng.float();
      edited[j] = 1;
      mask[j] = islet ? 220 : 255;
      reefCell[j] = 0;
      if (islet) motu++;
    }
    disk.add(cx * cellKm, cy * cellKm);
    made++;
    c.features.push({
      type: 'atoll', x: cx * cellKm * 1000, y: cy * cellKm * 1000, size: 2 * R * cellKm * 1000,
      data: { lagoonDepth, motu, ringCells: ring.length },
    });
    c.features.push({ type: 'lagoon', x: cx * cellKm * 1000, y: cy * cellKm * 1000, size: 2 * (R - half) * cellKm * 1000, data: { atoll: 1 } });
  }
  return made;
}
