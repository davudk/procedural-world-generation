import { BIOME, BIOMES, type BiomeId } from '../../shared/biomes';

/** LUT axes (research 03 §3.4): u = (T + 20) / 50 over −20…30 °C, v = log10(AI·10)/2 over AI 0.1…10. */
export const LUT_SIZE = 64;
export const LUT_T_MIN = -20;
export const LUT_T_SPAN = 50;

export type Palette = 'satellite' | 'stylised';

/** Zonal biome for a (temperature, aridity) pair; `drySummer` selects the Mediterranean variant. */
export function zonalBiome(t: number, ai: number, drySummer: boolean): BiomeId {
  if (t < -6) return ai < 0.3 ? BIOME.POLAR_DESERT : BIOME.TUNDRA;
  if (t < 2) return ai < 0.3 ? BIOME.COLD_DESERT : ai < 0.6 ? BIOME.STEPPE : BIOME.BOREAL;
  if (drySummer && t >= 8 && t < 20 && ai >= 0.3 && ai < 1.3) return BIOME.MEDITERRANEAN;
  if (t < 10) return ai < 0.2 ? BIOME.COLD_DESERT : ai < 0.65 ? BIOME.STEPPE : t < 6 ? BIOME.TEMP_CONIFER : BIOME.TEMP_BROADLEAF;
  if (t < 18) {
    if (ai < 0.2) return t < 14 ? BIOME.COLD_DESERT : BIOME.HOT_DESERT;
    if (ai < 0.5) return BIOME.XERIC_SHRUB;
    if (ai < 0.75) return BIOME.STEPPE;
    return ai > 2.5 && t < 16 ? BIOME.TEMP_RAINFOREST : BIOME.TEMP_BROADLEAF;
  }
  if (ai < 0.2) return BIOME.HOT_DESERT;
  if (ai < 0.5) return BIOME.XERIC_SHRUB;
  if (ai < 0.9) return BIOME.SAVANNA;
  if (ai < 1.4) return BIOME.TROP_DRY_FOREST;
  return BIOME.TROP_RAINFOREST;
}

/**
 * Builds the colour LUT (RGBA8, LUT_SIZE²; row = aridity, column = temperature): each texel is its
 * zonal biome's colour, then Gaussian-blurred (σ = 2 texels) so hardware bilinear filtering gives
 * continuous ecotones at any zoom instead of hard biome edges.
 */
export function buildBiomeLut(palette: Palette, drySummer: boolean): Uint8Array {
  const S = LUT_SIZE;
  const rgb = new Float32Array(S * S * 3);
  for (let y = 0; y < S; y++) {
    const ai = 10 ** ((2 * (y + 0.5)) / S - 1);
    for (let x = 0; x < S; x++) {
      const t = LUT_T_MIN + (LUT_T_SPAN * (x + 0.5)) / S;
      const info = BIOMES[zonalBiome(t, ai, drySummer)];
      const c = palette === 'satellite' ? info.satellite : info.stylised;
      const o = (y * S + x) * 3;
      rgb[o] = c[0];
      rgb[o + 1] = c[1];
      rgb[o + 2] = c[2];
    }
  }
  const blurred = gaussian(rgb, S, 2);
  const out = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    out[i * 4] = blurred[i * 3];
    out[i * 4 + 1] = blurred[i * 3 + 1];
    out[i * 4 + 2] = blurred[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Biome palette as a 32×1 RGBA8 strip (for the biome map mode and override colours). */
export function buildBiomePalette(palette: Palette): Uint8Array {
  const out = new Uint8Array(32 * 4);
  for (const b of BIOMES) {
    const c = palette === 'satellite' ? b.satellite : b.stylised;
    out.set([c[0], c[1], c[2], 255], b.id * 4);
  }
  return out;
}

function gaussian(src: Float32Array, S: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const w: number[] = [];
  let sum = 0;
  for (let k = -r; k <= r; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    w.push(v);
    sum += v;
  }
  const pass = (a: Float32Array, dx: number, dy: number): Float32Array => {
    const out = new Float32Array(a.length);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        for (let c = 0; c < 3; c++) {
          let acc = 0;
          for (let k = -r; k <= r; k++) {
            const sx = Math.min(S - 1, Math.max(0, x + k * dx));
            const sy = Math.min(S - 1, Math.max(0, y + k * dy));
            acc += a[(sy * S + sx) * 3 + c] * w[k + r];
          }
          out[(y * S + x) * 3 + c] = acc / sum;
        }
      }
    }
    return out;
  };
  return pass(pass(src, 1, 0), 0, 1);
}
