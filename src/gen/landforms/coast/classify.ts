import { smoothstep } from '../../grid/ops';
import type { LandformCtx } from '../types';
import { blockMeanList, DX8, DY8 } from './grid';

// Local copies: hot loops should not read the imported bindings.
const DX = Int8Array.from(DX8);
const DY = Int8Array.from(DY8);

/** Coast classes (research 03 §3.2 rule 4, FEATURES F10–F19). */
export const COAST = { NONE: 0, SANDY: 1, ROCKY: 2, SHELTERED: 3, ICE: 4 } as const;

/** Reference fetch (km) at which a direction counts as fully open water. */
const FETCH_REF_KM = 160;

export interface CoastInfo {
  /** 1 = base-level sea before the pass (fixed and h ≤ 0). */
  sea: Uint8Array;
  /** Coastal land cells (land with a 4-neighbour on the sea), in scan order. */
  cells: Int32Array;
  /** Per coastal cell: index into `cells`, −1 elsewhere. */
  slot: Int32Array;
  /** Per coastal cell (by slot): unit normal pointing to the sea (grid x east, y south). */
  nx: Float32Array;
  ny: Float32Array;
  /** Prevailing wind (direction blown toward) per slot. */
  wx: Float32Array;
  wy: Float32Array;
  /** Wave exposure 0–1 (fetch along the wind and the 8 compass directions), smoothed along the coast. */
  exposure: Float32Array;
  /** Wave index: exposure × the waveEnergy setting. */
  wave: Float32Array;
  /** Highest land within ~2–3 km inland (m), smoothed along the coast. */
  relief: Float32Array;
  /** Sea depth (m, negative) ~8 km offshore along the normal. */
  shelf: Float32Array;
  /** Land share within ~5 km (low = headland, high = bay head). */
  landShare: Float32Array;
  cls: Uint8Array;
  /** COAST class per cell (coastal land cells only). */
  classOf: Uint8Array;
  /** Coast length (km) per class and in total (4-edge count × π/4). */
  lengthKm: Record<'total' | 'sandy' | 'rocky' | 'sheltered' | 'ice', number>;
}

/** Prevailing-wind bands of research 03 §2.1 (trades, westerlies, polar easterlies), blowing toward. */
export function windAt(lat: number): [number, number] {
  const a = Math.abs(lat);
  const t1 = Math.min(1, Math.max(0, (a - 25) / 10));
  const t2 = Math.min(1, Math.max(0, (a - 55) / 10));
  let vx = -0.9 + t1 * (0.93 + 0.9);
  let vy = -0.43 + t1 * (0.36 + 0.43);
  vx += t2 * (-0.9 - vx);
  vy += t2 * (-0.43 - vy);
  if (lat < 0) vy = -vy;
  const len = Math.hypot(vx, vy) || 1;
  // Grid y points south; the band vectors are (east, north).
  return [vx / len, -vy / len];
}

/**
 * Coast classification: exposure from fetch over open water along the prevailing wind and the eight
 * compass directions, relief inland, shelf depth offshore and ice cover → sandy / rocky (high) /
 * sheltered / ice coasts.
 */
export function classifyCoast(c: LandformCtx): CoastInfo {
  const { n, cellKm, h, fixed, ice } = c;
  const N = n * n;
  const sea = new Uint8Array(N);
  for (let i = 0; i < N; i++) sea[i] = fixed[i] && h[i] <= 0 ? 1 : 0;
  const slot = new Int32Array(N).fill(-1);
  const list: number[] = [];
  let edges = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (sea[i] || fixed[i]) continue;
      let e = 0;
      if (x > 0 && sea[i - 1]) e++;
      if (x < n - 1 && sea[i + 1]) e++;
      if (y > 0 && sea[i - n]) e++;
      if (y < n - 1 && sea[i + n]) e++;
      if (e > 0) {
        slot[i] = list.length;
        list.push(i);
        edges += e;
      }
    }
  }
  const cells = Int32Array.from(list);
  const M = cells.length;
  const nx = new Float32Array(M);
  const ny = new Float32Array(M);
  const wx = new Float32Array(M);
  const wy = new Float32Array(M);
  const exposure = new Float32Array(M);
  const relief = new Float32Array(M);
  const shelf = new Float32Array(M);
  const landShare = new Float32Array(M);

  // Normals from the land moments in a ~3 km disc; land share in a ~5 km disc.
  const rN = Math.max(2, Math.round(3 / cellKm));
  const rL = Math.max(2, Math.round(5 / cellKm));
  // Summed-area table of land for the (square) land-share window.
  const W = n + 1;
  const sat = new Int32Array(W * W);
  for (let y = 0; y < n; y++) {
    let row = 0;
    for (let x = 0; x < n; x++) {
      row += sea[y * n + x] ? 0 : 1;
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  const fetchMax = Math.max(4, Math.round(FETCH_REF_KM / cellKm));
  const stride = Math.max(1, Math.round(3 / cellKm));
  const DIRS: [number, number][] = [];
  for (let k = 0; k < 8; k++) DIRS.push([Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);
  const fetch = (x0: number, y0: number, dx: number, dy: number): number => {
    for (let s = stride; s <= fetchMax; s += stride) {
      const x = Math.round(x0 + dx * s);
      const y = Math.round(y0 + dy * s);
      // Off the map counts as open sea: on 'continent' edges the map border is land anyway.
      if (x < 0 || y < 0 || x >= n || y >= n) return 1;
      if (!sea[y * n + x]) return s / fetchMax;
    }
    return 1;
  };

  const fb = Math.max(1, Math.round(3 / cellKm));
  const fm = Math.ceil(n / fb);
  const origin = new Uint8Array(fm * fm);
  const isOrigin = new Uint8Array(M);
  for (let k = 0; k < M; k++) {
    const i = cells[k];
    const x = i % n;
    const y = (i - x) / n;
    let mx = 0;
    let my = 0;
    for (let dy = -rN; dy <= rN; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= n) continue;
      for (let dx = -rN; dx <= rN; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= n || dx * dx + dy * dy > rN * rN || sea[yy * n + xx]) continue;
        mx += dx;
        my += dy;
      }
    }
    {
      const x0 = Math.max(0, x - rL);
      const x1 = Math.min(n, x + rL + 1);
      const y0 = Math.max(0, y - rL);
      const y1 = Math.min(n, y + rL + 1);
      const land = sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0];
      landShare[k] = land / ((x1 - x0) * (y1 - y0));
    }
    let len = Math.hypot(mx, my);
    if (len < 1e-6) {
      // Symmetric neighbourhood (a point or a strip): fall back to the 4-neighbour sea direction.
      mx = (x > 0 && sea[i - 1] ? 1 : 0) - (x < n - 1 && sea[i + 1] ? 1 : 0);
      my = (y > 0 && sea[i - n] ? 1 : 0) - (y < n - 1 && sea[i + n] ? 1 : 0);
      len = Math.hypot(mx, my) || 1;
    }
    nx[k] = -mx / len;
    ny[k] = -my / len;
    const [ux, uy] = windAt(c.climate.lat[i]);
    wx[k] = ux;
    wy[k] = uy;

    // Fetch: upwind (waves travel with the wind) plus swell from all eight directions.
    // Fetch rays from one coastal cell per ~3 km block (exposure is smoothed along the coast anyway).
    const ob = Math.floor(y / fb) * fm + Math.floor(x / fb);
    if (origin[ob] === 0) {
      origin[ob] = 1;
      isOrigin[k] = 1;
      const fw = fetch(x, y, -ux, -uy);
      let fs = 0;
      for (const [ddx, ddy] of DIRS) fs += fetch(x, y, ddx, ddy);
      exposure[k] = 0.55 * fw + 0.45 * (fs / 8);
    }

    // Relief: highest land within ~2.5 km inland along −normal (at least one cell).
    const steps = Math.max(1, Math.round(2.5 / cellKm));
    let rel = h[i];
    for (let s = 1; s <= steps; s++) {
      const xx = Math.round(x - nx[k] * s);
      const yy = Math.round(y - ny[k] * s);
      if (xx < 0 || yy < 0 || xx >= n || yy >= n) break;
      const j = yy * n + xx;
      if (!sea[j]) rel = Math.max(rel, h[j]);
    }
    relief[k] = rel;
    const off = Math.max(1, Math.round(8 / cellKm));
    const sxx = Math.min(n - 1, Math.max(0, Math.round(x + nx[k] * off)));
    const syy = Math.min(n - 1, Math.max(0, Math.round(y + ny[k] * off)));
    shelf[k] = Math.min(0, h[syy * n + sxx]);
  }

  // Smooth exposure and relief along the coast over ~10 km blocks so classes come in stretches.
  const block = Math.max(1, Math.round(4 / cellKm));
  const me = blockMeanList(cells, exposure, isOrigin, n, block, 1);
  const mr = blockMeanList(cells, relief, null, n, block, 1);
  const waveMul = 0.5 + c.num('waveEnergy');
  const wave = new Float32Array(M);
  const cls = new Uint8Array(M);
  const classOf = new Uint8Array(N);
  const lengthKm = { total: 0, sandy: 0, rocky: 0, sheltered: 0, ice: 0 };
  const edgeKm = cellKm * (Math.PI / 4);
  for (let k = 0; k < M; k++) {
    const i = cells[k];
    exposure[k] = isOrigin[k] ? 0.5 * exposure[k] + 0.5 * me[k] : me[k];
    relief[k] = 0.5 * relief[k] + 0.5 * mr[k];
    wave[k] = exposure[k] * waveMul;
    // High coasts: relief, helped by a steep shore face (deep water close in).
    const high = smoothstep(25, 110, relief[k]) + 0.35 * smoothstep(-40, -200, shelf[k]);
    let k2: number = COAST.SANDY;
    if (ice[i] > 0.3) k2 = COAST.ICE;
    else if (high > 0.55) k2 = COAST.ROCKY;
    else if (wave[k] < 0.17 || landShare[k] > 0.72) k2 = COAST.SHELTERED;
    cls[k] = k2;
    classOf[i] = k2;
    const x = i % n;
    const y = (i - x) / n;
    let e = 0;
    for (let d = 0; d < 4; d++) {
      const xx = x + DX[d];
      const yy = y + DY[d];
      if (xx >= 0 && yy >= 0 && xx < n && yy < n && sea[yy * n + xx]) e++;
    }
    const km = e * edgeKm;
    if (k2 === COAST.SANDY) lengthKm.sandy += km;
    else if (k2 === COAST.ROCKY) lengthKm.rocky += km;
    else if (k2 === COAST.SHELTERED) lengthKm.sheltered += km;
    else lengthKm.ice += km;
  }
  lengthKm.total = edges * edgeKm;
  return { sea, cells, slot, nx, ny, wx, wy, exposure, wave, relief, shelf, landShare, cls, classOf, lengthKm };
}
