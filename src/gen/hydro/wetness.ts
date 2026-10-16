import { DIST, INV_DIST, offsets, outside } from './grid8';

/** Quinn et al. (1991) contour length weights (cells): ½ orthogonal, ≈0.354 diagonal. */
const CONTOUR = Float64Array.from(DIST, (d) => (d > 1 ? 0.354 : 0.5));

/**
 * Topographic wetness index TWI = ln(a / tan β) (Beven & Kirkby 1979, research 02 §7) with the
 * specific catchment area from multiple-flow-direction routing on the water surface `S` (Quinn et al.
 * 1991, flow ∝ slope × contour length; the research's p = 1.1 costs a pow per edge for no visible gain). Cells
 * without a lower neighbour (flats, lakes) pass everything to their single receiver; the order is
 * a topological sort of that flow graph (Kahn), so no sorting by height is needed.
 */
export function wetnessIndex(S: Float32Array, n: number, cellM: number, rcv: Int32Array, fixed: Uint8Array): { twi: Float32Array; slope: Float32Array } {
  const N = n * n;
  const off = offsets(n);
  const indeg = new Uint8Array(N);
  const slope = new Float32Array(N);
  const lowerMask = new Uint8Array(N);
  const inv = INV_DIST.map((d) => d / cellM);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (fixed[i]) continue;
      const edge = x === 0 || y === 0 || x === n - 1 || y === n - 1;
      let mask = 0;
      let best = 0;
      for (let k = 0; k < 8; k++) {
        if (edge && outside(x, y, k, n)) continue;
        const j = i + off[k];
        const s = (S[i] - S[j]) * inv[k];
        if (s <= 0) continue;
        mask |= 1 << k;
        if (s > best) best = s;
        indeg[j]++;
      }
      lowerMask[i] = mask;
      slope[i] = best;
      if (mask === 0 && rcv[i] !== i) indeg[rcv[i]]++;
    }
  }
  const a = new Float64Array(N);
  const queue = new Int32Array(N);
  let qt = 0;
  for (let i = 0; i < N; i++) if (indeg[i] === 0) queue[qt++] = i;
  const w = new Float64Array(8);
  const area = cellM * cellM;
  for (let qh = 0; qh < qt; qh++) {
    const i = queue[qh];
    a[i] += area;
    if (fixed[i]) continue;
    const mask = lowerMask[i];
    if (mask === 0) {
      const r = rcv[i];
      if (r !== i) {
        a[r] += a[i];
        if (--indeg[r] === 0) queue[qt++] = r;
      }
      continue;
    }
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      if (!(mask & (1 << k))) {
        w[k] = 0;
        continue;
      }
      w[k] = (S[i] - S[i + off[k]]) * inv[k] * CONTOUR[k];
      sum += w[k];
    }
    for (let k = 0; k < 8; k++) {
      if (w[k] === 0) continue;
      const j = i + off[k];
      a[j] += (a[i] * w[k]) / sum;
      if (--indeg[j] === 0) queue[qt++] = j;
    }
  }
  const twi = new Float32Array(N);
  for (let i = 0; i < N; i++) twi[i] = fixed[i] ? 0 : Math.log(a[i] / cellM / Math.max(1e-4, slope[i]));
  return { twi, slope };
}

/** Local relief gradient: (max − min of `S` over the 3×3 neighbourhood) / (2 cells), a smoothed slope. */
export function reliefSlope(S: Float32Array, n: number, cellM: number): Float32Array {
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(n - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(n - 1, x + 1); xx++) {
          const v = S[yy * n + xx];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      out[y * n + x] = (hi - lo) / (2 * cellM);
    }
  }
  return out;
}

/** PET/P above which no wetland forms without exotic water. */
const OASIS_MAX_ARIDITY = 5;

/** Wetland candidate tiers, filled in order until the target count is met. */
export interface WetlandTiers {
  /** Flat limit (local relief) for the first tier (research 02 §7). */
  maxSlope: number;
  /** Relaxed flat limit for humid land (P/PET ≥ 1) when flat land runs short: blanket bog and fen on gentle slopes. */
  humidSlope: number;
  /** Arid cells (P/PET < 0.5) that may hold wetlands anyway: lake and playa shores, river floodplains (saline marsh, riparian). */
  aridOk?: Uint8Array;
}

/**
 * Picks `count` wetland cells among eligible land, wettest first, in tiers:
 * 1. flat (local relief below `maxSlope`) and not too dry (P/PET ≥ 0.5);
 * 2. flat arid cells next to exotic water (`aridOk`);
 * 3. humid (P/PET ≥ 1) cells up to `humidSlope`;
 * 4. other flat semi-arid cells (P/PET ≥ 1/OASIS_MAX_ARIDITY): spring-fed oases in valley floors.
 * Within a tier the score favours broad flats over narrow valley floors (half the TWI plus the log of
 * the inverse local relief) and humid climate. Returns the number marked.
 */
export function selectWetlands(
  twi: Float32Array,
  slope: Float32Array,
  aridity: Float32Array,
  eligible: Uint8Array,
  out: Uint8Array,
  count: number,
  tiers: WetlandTiers,
): number {
  if (count <= 0) return 0;
  const tierOf = (i: number): number => {
    const a = aridity[i];
    const s = slope[i];
    if (a <= 2) {
      if (s <= tiers.maxSlope) return 1;
      return a <= 1 && s <= tiers.humidSlope ? 3 : 0;
    }
    if (s > tiers.maxSlope) return 0;
    return tiers.aridOk?.[i] ? 2 : a <= OASIS_MAX_ARIDITY ? 4 : 0;
  };
  const score = (i: number): number => 0.5 * twi[i] - Math.log(Math.max(1e-4, slope[i])) - 0.5 * Math.log(Math.max(0.05, aridity[i]));
  const byTier: number[][] = [[], [], [], [], []];
  for (let i = 0; i < twi.length; i++) {
    if (!eligible[i] || out[i]) continue;
    const t = tierOf(i);
    if (t > 0) byTier[t].push(i);
  }
  let marked = 0;
  for (let t = 1; t <= 4 && marked < count; t++) {
    const cand = byTier[t];
    const k = Math.min(count - marked, cand.length);
    if (k === 0) continue;
    const scores = Float64Array.from(cand, score);
    const thr = scores.slice().sort()[cand.length - k];
    let got = 0;
    for (let j = 0; j < cand.length; j++) {
      if (scores[j] > thr) {
        out[cand[j]] = 1;
        got++;
      }
    }
    for (let j = 0; j < cand.length && got < k; j++) {
      if (scores[j] === thr) {
        out[cand[j]] = 1;
        got++;
      }
    }
    marked += k;
  }
  return marked;
}
