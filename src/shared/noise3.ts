import type { Noise2 } from './noise';

/**
 * Seeded 3D gradient noise (improved Perlin) on a hashed integer lattice, for spherical worlds
 * (research 10 §5). Noise2's 256-entry permutation repeats every 256 lattice units, which a planet
 * evaluated at unit·R/λ would hit several times round its circumference; hashing the lattice
 * coordinates has no period inside the int32 range. Same conventions as Noise2: output roughly in
 * [−1, 1], coordinates in noise units (km / wavelength), fBm and ridged helpers with per-octave offsets.
 */
export class Noise3 implements SurfaceNoise {
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed | 0;
  }

  noise(x: number, y: number, z: number): number {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const zf = Math.floor(z);
    const fx = x - xf;
    const fy = y - yf;
    const fz = z - zf;
    const u = fade(fx);
    const v = fade(fy);
    const w = fade(fz);
    const s = this.seed;
    const n000 = grad(hash(s, xf, yf, zf), fx, fy, fz);
    const n100 = grad(hash(s, xf + 1, yf, zf), fx - 1, fy, fz);
    const n010 = grad(hash(s, xf, yf + 1, zf), fx, fy - 1, fz);
    const n110 = grad(hash(s, xf + 1, yf + 1, zf), fx - 1, fy - 1, fz);
    const n001 = grad(hash(s, xf, yf, zf + 1), fx, fy, fz - 1);
    const n101 = grad(hash(s, xf + 1, yf, zf + 1), fx - 1, fy, fz - 1);
    const n011 = grad(hash(s, xf, yf + 1, zf + 1), fx, fy - 1, fz - 1);
    const n111 = grad(hash(s, xf + 1, yf + 1, zf + 1), fx - 1, fy - 1, fz - 1);
    const x00 = n000 + u * (n100 - n000);
    const x10 = n010 + u * (n110 - n010);
    const x01 = n001 + u * (n101 - n001);
    const x11 = n011 + u * (n111 - n011);
    const y0 = x00 + v * (x10 - x00);
    const y1 = x01 + v * (x11 - x01);
    return (y0 + w * (y1 - y0)) * SCALE;
  }

  /** Fractal Brownian motion, normalised so the result stays roughly in [−1, 1]. */
  fbm3(x: number, y: number, z: number, octaves = 5, lacunarity = 2.0, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * f + o * 17.13, y * f - o * 31.71, z * f + o * 23.37);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal-style noise in [0, 1]. */
  ridged3(x: number, y: number, z: number, octaves = 4, lacunarity = 2.0, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      const r = 1 - Math.abs(this.noise(x * f + o * 7.31, y * f + o * 13.7, z * f - o * 11.3));
      sum += amp * r * r;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }
}

/**
 * Noise evaluated at a surface position in km: planar worlds pass (x, y, ignored z) to Noise2, the
 * sphere passes the 3D position to Noise3, so a stage can write each noise call once.
 */
export interface SurfaceNoise {
  fbm3(x: number, y: number, z: number, octaves?: number, lacunarity?: number, gain?: number): number;
  ridged3(x: number, y: number, z: number, octaves?: number, lacunarity?: number, gain?: number): number;
}

/** Noise2 behind the SurfaceNoise interface (z is ignored, so the values are Noise2's bit for bit). */
export function planarNoise(n: Noise2): SurfaceNoise {
  return {
    fbm3: (x, y, _z, octaves, lacunarity, gain) => n.fbm(x, y, octaves, lacunarity, gain),
    ridged3: (x, y, _z, octaves, lacunarity, gain) => n.ridged(x, y, octaves, lacunarity, gain),
  };
}

/** Scales the RMS value to Noise2's (≈ 0.30 for single octaves). */
const SCALE = 1.12;

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function hash(seed: number, x: number, y: number, z: number): number {
  let h = seed ^ Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** Dot product with one of the 12 cube-edge gradients (Perlin 2002). */
function grad(h: number, x: number, y: number, z: number): number {
  switch (h % 12) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x + z;
    case 5: return -x + z;
    case 6: return x - z;
    case 7: return -x - z;
    case 8: return y + z;
    case 9: return -y + z;
    case 10: return y - z;
    default: return -y - z;
  }
}
