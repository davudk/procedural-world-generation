/**
 * Prevailing wind bands (research 03 §2.1), as unit vectors the wind blows TOWARD in grid
 * orientation (gx east, gy south).
 */

const TRADE_X = -0.9;
const TRADE_Y = -0.43;
const WEST_X = 0.93;
const WEST_Y = 0.36;

export interface WindOptions {
  /** Added to |φ| before evaluating the bands (−5 summer, +4 winter, × seasonality). */
  shiftDeg: number;
  /** Per-cell direction noise (radians). */
  noise: Float32Array;
  /** Override direction (degrees, 0 = north, clockwise) and blend strength 0–1. */
  overrideDeg: number;
  overrideStrength: number;
}

export interface Wind {
  gx: Float32Array;
  gy: Float32Array;
}

export function windField(lat: Float32Array, o: WindOptions): Wind {
  const N = lat.length;
  const gx = new Float32Array(N);
  const gy = new Float32Array(N);
  const ox = Math.sin((o.overrideDeg * Math.PI) / 180);
  const oy = Math.cos((o.overrideDeg * Math.PI) / 180);
  const s = Math.min(1, Math.max(0, o.overrideStrength));
  for (let i = 0; i < N; i++) {
    const phi = lat[i];
    const a = Math.abs(Math.abs(phi) + o.shiftDeg);
    // Trades → westerlies across 25–35°, westerlies → polar easterlies across 55–65°.
    const t1 = Math.min(1, Math.max(0, (a - 25) / 10));
    const t2 = Math.min(1, Math.max(0, (a - 55) / 10));
    let vx = TRADE_X + t1 * (WEST_X - TRADE_X);
    let vy = TRADE_Y + t1 * (WEST_Y - TRADE_Y);
    vx += t2 * (TRADE_X - vx);
    vy += t2 * (TRADE_Y - vy);
    if (phi < 0) vy = -vy;
    // The band blend passes through ~0 at the horse latitudes and the subpolar low; only the
    // direction is used, rotated by the noise.
    const ang = Math.atan2(vy, vx) + o.noise[i];
    let ex = Math.cos(ang);
    let ny = Math.sin(ang);
    if (s > 0) {
      ex += s * (ox - ex);
      ny += s * (oy - ny);
      const len = Math.hypot(ex, ny);
      if (len > 1e-6) {
        ex /= len;
        ny /= len;
      } else {
        ex = ox;
        ny = oy;
      }
    }
    gx[i] = ex;
    gy[i] = -ny;
  }
  return { gx, gy };
}
