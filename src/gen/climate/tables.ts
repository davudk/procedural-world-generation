/** Climatology tables and small formulas of research 03 §1–2. Latitudes are |φ| in degrees. */

const LAT10 = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
/** Zonal-mean annual sea-level air temperature (°C), §1.1. */
const T0 = [26, 26, 24.5, 20, 13.5, 6, -1, -9, -17, -22];
/** Half annual range over the open ocean and over a very continental interior (°C), §1.1. */
const A_OCEAN = [1, 1.5, 2.5, 4, 5, 5.5, 6, 8, 10, 12];
const A_LAND = [1.5, 4, 8, 11, 14, 17, 20, 22, 22, 22];

const S_LAT = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90];
/** Large-scale circulation factor (§2.2): wet ITCZ, dry subtropical highs, wet storm track. */
const S_TAB = [2.0, 2.2, 1.4, 0.7, 0.35, 0.2, 0.25, 0.5, 0.9, 1.15, 1.3, 1.3, 1.1, 0.6, 0.35, 0.25];

function lerpTable(xs: readonly number[], ys: readonly number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  const last = xs.length - 1;
  if (x >= xs[last]) return ys[last];
  let k = 1;
  while (xs[k] < x) k++;
  const t = (x - xs[k - 1]) / (xs[k] - xs[k - 1]);
  return ys[k - 1] + t * (ys[k] - ys[k - 1]);
}

/** Look-up table sampled every 0.1° so the per-cell work is one index. */
export class LatTable {
  private readonly v = new Float32Array(901);
  constructor(f: (lat: number) => number) {
    for (let i = 0; i <= 900; i++) this.v[i] = f(i / 10);
  }
  at(lat: number): number {
    const a = Math.min(900, Math.abs(lat) * 10);
    const i = Math.floor(a);
    const t = a - i;
    return i >= 900 ? this.v[900] : this.v[i] + t * (this.v[i + 1] - this.v[i]);
  }
}

export const zonalT = new LatTable((a) => lerpTable(LAT10, T0, a));
export const ampOcean = new LatTable((a) => lerpTable(LAT10, A_OCEAN, a));
export const ampLand = new LatTable((a) => lerpTable(LAT10, A_LAND, a));
export const circulation = new LatTable((a) => lerpTable(S_LAT, S_TAB, a));

/** Saturation capacity relative to 15 °C air (Clausius–Clapeyron ≈ 7 %/°C). */
export function capacity(t: number): number {
  return Math.exp(0.0698 * (t - 15));
}

/**
 * Summer (JJA) temperature at the glacier equilibrium line for annual precipitation P (mm), the
 * inverse of Ohmura, Kasser & Funk (1992) P = 645 + 296·T + 9·T² (§1.5).
 */
export function elaTemperature(p: number): number {
  return (-296 + Math.sqrt(296 * 296 - 36 * (645 - p))) / 18;
}

/** Share of a half-year's mean anomaly in the cosine annual cycle: mean of cos over ±90° = 2/π. */
export const HALF_YEAR = 2 / Math.PI;

/** Environmental lapse rate (°C per m). */
export const LAPSE = 0.0065;
