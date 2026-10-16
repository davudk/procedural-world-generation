import { Rng } from './rng';

/**
 * Seeded 2D gradient noise (improved Perlin) in float64, plus fBm and domain warping helpers.
 * Output of `noise` is roughly in [-1, 1]. Coordinates are in "noise units"; callers divide world
 * kilometres by a feature wavelength.
 */
export class Noise2 {
  private readonly perm = new Uint8Array(512);
  private readonly gx = new Float64Array(256);
  private readonly gy = new Float64Array(256);

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    // 256 evenly spaced unit gradients (no axis bias from a small gradient set).
    for (let i = 0; i < 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  noise(x: number, y: number): number {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const xi = xf & 255;
    const yi = yf & 255;
    const fx = x - xf;
    const fy = y - yf;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const pm = this.perm;
    const a = pm[xi] + yi;
    const b = pm[xi + 1] + yi;
    const g00 = pm[a];
    const g01 = pm[a + 1];
    const g10 = pm[b];
    const g11 = pm[b + 1];
    const n00 = this.gx[g00] * fx + this.gy[g00] * fy;
    const n10 = this.gx[g10] * (fx - 1) + this.gy[g10] * fy;
    const n01 = this.gx[g01] * fx + this.gy[g01] * (fy - 1);
    const n11 = this.gx[g11] * (fx - 1) + this.gy[g11] * (fy - 1);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.4142135623730951;
  }

  /** Fractal Brownian motion, normalised so the result stays roughly in [-1, 1]. */
  fbm(x: number, y: number, octaves = 5, lacunarity = 2.0, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      // Per-octave offsets decorrelate octaves and avoid the shared lattice origin.
      sum += amp * this.noise(x * f + o * 17.13, y * f - o * 31.71);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }
}
