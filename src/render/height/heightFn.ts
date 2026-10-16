import type { GroundQuery, Vec3 } from '../camera/ground';
import type { HeightField } from '../heightField';

/**
 * The shared height function, TypeScript side (research 04 §2.1, §9.4 #1). Mirrors `DETAIL_GLSL`
 * (src/render/glsl/detail.ts) operation by operation: same integer hash, same octave table, same
 * footprint fade, same clamps. The GLSL is generated from the constants below, so both stay in sync.
 *
 * Conventions: world metres, x east, y north, [0, size]². Rasters are row-major with row 0 = north;
 * "texel coordinates" q = (x, size − y) / size · n − 0.5, so integer q are texel centres.
 * Gradients are dh/dx, dh/dy in world axes (m/m).
 */

/** Noise and shaping constants, shared with the GLSL (keep integer constants < 2^32). */
export const DN = {
  /** lowbias32-style integer hash: lattice multipliers and finaliser. */
  M1: 0x8da6b343,
  M2: 0xd8163841,
  M3: 0xcb1ab31f,
  F1: 0x7feb352d,
  F2: 0x846ca68b,
  /** Seed step between octaves (golden ratio). */
  OCT: 0x9e3779b9,
  SEED_BAKE: 0x5bd1e995,
  SEED_DUNE: 0x68e31da4,
  /** Precision split: noise is evaluated on (tile, local) with tiles of 65 536 m (research 04 §1.6). */
  TILE: 65536,
  /** Tile index bias so lattice indices stay non-negative for any w > −4.19e6 m. */
  TILE_BIAS: 64,
  /** Ridged octave: 0.7 − 2|n| (mean ≈ 0), so |octave| ≤ RIDGE_MAX. */
  RIDGE_HI: 0.7,
  RIDGE_MAX: 1.3,
  /** Derivative damping (IQ): octave / (1 + DAMP·|Σ∇h|²), with Σ∇h in m/m including the base slope. */
  DAMP: 2.0,
  /** Footprint fade: an octave of wavelength λ is full while pxFoot/λ ≤ 0.25 (λ ≥ 4 px), gone at 0.5. */
  FADE_LO: 0.25,
  FADE_HI: 0.5,
  MAX_OCT: 8,
  /** Finest shader octave wavelength (m). */
  MIN_LAMBDA: 16,
  /** Shader amplification amplitude (m, all octaves): (BASE + ROUGH·roughness)·(λ0/LAM_REF)^LAM_EXP. */
  AMP_BASE: 2,
  AMP_ROUGH: 60,
  LAM_REF: 512,
  LAM_EXP: 0.7,
  /** Dunes: anisotropic ridged noise, crests N–S; height = amp·((1−|n|)² − MEAN), |·| ≤ MAX. */
  DUNE_LX: 256,
  DUNE_LY: 1024,
  DUNE_AMP: 10,
  DUNE_MEAN: 0.45,
  DUNE_MAX: 0.55,
  /** Amplification never brings terrain closer than this (m) to the water level. */
  SHORE_MARGIN: 1,
  /** Baked (detail map) noise: amplitude (BASE + ROUGH·roughness)·(λb0/BAKE_LAM_REF)^LAM_EXP. */
  BAKE_BASE: 8,
  BAKE_ROUGH: 150,
  BAKE_LAM_REF: 2048,
  /** Water levels below this are dry (heightField DRY). */
  DRY: -9000,
} as const;

/** Per-build parameters derived from the world and detail map sizes. */
export interface DetailParams {
  seed: number;
  /** World size (m). */
  size: number;
  detailN: number;
  macroN: number;
  /** Detail texel and macro cell (m). */
  texel: number;
  macroCell: number;
  /** First (longest) shader octave wavelength (power of two, m) and octave count. */
  lam0: number;
  octaves: number;
  ampScale: number;
  /** Baked noise octaves (detail map build). */
  bakeLam0: number;
  bakeOct: number;
  bakeAmpScale: number;
}

const pow2Floor = (x: number): number => 2 ** Math.floor(Math.log2(Math.max(1, x)));

export function detailParams(size: number, detailN: number, macroN: number, seed: number): DetailParams {
  const texel = size / detailN;
  const macroCell = size / macroN;
  // The shader band starts where the texture can no longer hold a wavelength well (≤ ~3 texels).
  const lam0 = Math.min(pow2Floor(3 * texel), DN.TILE / 2);
  const octaves = Math.max(1, Math.min(DN.MAX_OCT, Math.round(Math.log2(lam0 / DN.MIN_LAMBDA)) + 1));
  // Baked band: from ~2 macro cells down to 2 detail texels (the footprint fade trims the last one).
  const bakeLam0 = Math.min(2 * pow2Floor(2 * macroCell - 1), DN.TILE / 2);
  const bakeOct = Math.max(0, Math.min(5, Math.floor(Math.log2(bakeLam0 / (2 * texel))) + 1));
  return {
    seed: seed >>> 0,
    size,
    detailN,
    macroN,
    texel,
    macroCell,
    lam0,
    octaves,
    ampScale: (lam0 / DN.LAM_REF) ** DN.LAM_EXP,
    bakeLam0,
    bakeOct,
    bakeAmpScale: (bakeLam0 / DN.BAKE_LAM_REF) ** DN.LAM_EXP,
  };
}

// ---- Scalar helpers with GLSL semantics ---------------------------------------------------------

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** Weight of an octave of wavelength `lam` at footprint `pxFoot` (m/px): 1 → 0 as λ drops from 4 px to 2 px. */
export function footWeight(pxFoot: number, lam: number): number {
  return 1 - smoothstep(DN.FADE_LO, DN.FADE_HI, pxFoot / lam);
}

/** Seed of octave k. */
export function octSeed(seed: number, k: number): number {
  return (seed + Math.imul(k, DN.OCT)) >>> 0;
}

// ---- Integer hash and value noise with analytic derivatives -------------------------------------

/** 32-bit hash of a lattice point (bit-identical to the GLSL `dnHash`). */
export function hashU(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, DN.M1) ^ Math.imul(iy, DN.M2) ^ Math.imul(seed, DN.M3)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, DN.F1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, DN.F2) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Lattice value in [−1, 1) (24 bits, exact in float32). */
export function hashV(ix: number, iy: number, seed: number): number {
  return (hashU(ix, iy, seed) >>> 8) * (2 / 16777216) - 1;
}

/**
 * Quintic value noise at world point (wx, wy) on a lattice of spacing (lx, ly) metres (powers of two
 * ≤ TILE). Writes [n, dn/dx, dn/dy] (gradient per metre) into `out`. The point is split into a 65 536 m
 * tile index and a local offset, so lattice fractions keep full precision anywhere in a 4096 km world.
 */
export function noised(wx: number, wy: number, lx: number, ly: number, seed: number, out: Float64Array): Float64Array {
  const tx = Math.floor(wx * (1 / DN.TILE));
  const ty = Math.floor(wy * (1 / DN.TILE));
  const qx = (wx - tx * DN.TILE) / lx;
  const qy = (wy - ty * DN.TILE) / ly;
  const fqx = Math.floor(qx);
  const fqy = Math.floor(qy);
  const fx = qx - fqx;
  const fy = qy - fqy;
  const ix = (tx + DN.TILE_BIAS) * (DN.TILE / lx) + fqx;
  const iy = (ty + DN.TILE_BIAS) * (DN.TILE / ly) + fqy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
  const duy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const a = hashV(ix, iy, seed);
  const b = hashV(ix + 1, iy, seed);
  const c = hashV(ix, iy + 1, seed);
  const d = hashV(ix + 1, iy + 1, seed);
  const k1 = b - a;
  const k2 = c - a;
  const k4 = a - b - c + d;
  out[0] = a + k1 * ux + k2 * uy + k4 * ux * uy;
  out[1] = (dux * (k1 + k4 * uy)) / lx;
  out[2] = (duy * (k2 + k4 * ux)) / ly;
  return out;
}

const nTmp = new Float64Array(3);

/**
 * Derivative-damped, optionally ridged fBm (research 04 §2.1–2.2), faded per octave by footprint.
 * |result| ≤ amp. Gradient ignores the (slowly varying) damping factor. Adds into `out` ([h, gx, gy]).
 */
export function fbm(
  wx: number, wy: number, pxFoot: number, lam0: number, oct: number, amp: number, ridge: number,
  g0x: number, g0y: number, seed: number, out: Float64Array,
): Float64Array {
  if (amp <= 0) return out;
  const norm = 2 * (1 - 0.5 ** oct) * DN.RIDGE_MAX;
  let a = amp / norm;
  let lam = lam0;
  let dsx = g0x;
  let dsy = g0y;
  for (let k = 0; k < DN.MAX_OCT; k++) {
    if (k >= oct) break;
    const fw = footWeight(pxFoot, lam);
    if (fw <= 0) break;
    noised(wx, wy, lam, lam, octSeed(seed, k), nTmp);
    const s = sign(nTmp[0]);
    const n0 = nTmp[0] + (DN.RIDGE_HI - 2 * Math.abs(nTmp[0]) - nTmp[0]) * ridge;
    const n1 = nTmp[1] + (-2 * s * nTmp[1] - nTmp[1]) * ridge;
    const n2 = nTmp[2] + (-2 * s * nTmp[2] - nTmp[2]) * ridge;
    const damp = 1 / (1 + DN.DAMP * (dsx * dsx + dsy * dsy));
    const c = fw * a * damp;
    out[0] += c * n0;
    out[1] += c * n1;
    out[2] += c * n2;
    // Damping uses the ungated derivatives, so an octave's contribution depends on pxFoot only
    // through its own fade weight (fading fine octaves never changes coarser ones).
    dsx += a * n1;
    dsy += a * n2;
    a *= 0.5;
    lam *= 0.5;
  }
  return out;
}

/** Dune field (crests run north–south), faded by footprint. |result| ≤ DUNE_MAX·amp. Adds into `out`. */
export function dunes(wx: number, wy: number, pxFoot: number, amp: number, seed: number, out: Float64Array): Float64Array {
  if (amp <= 0) return out;
  const fw = footWeight(pxFoot, DN.DUNE_LX);
  if (fw <= 0) return out;
  noised(wx, wy, DN.DUNE_LX, DN.DUNE_LY, (seed ^ DN.SEED_DUNE) >>> 0, nTmp);
  const v = 1 - Math.abs(nTmp[0]);
  const s = sign(nTmp[0]);
  const c = fw * amp;
  out[0] += c * (v * v - DN.DUNE_MEAN);
  out[1] += c * -2 * v * s * nTmp[1];
  out[2] += c * -2 * v * s * nTmp[2];
  return out;
}

// ---- Raster sampling (identical addressing to the GLSL) -----------------------------------------

/** Bilinear value and texel-space gradient of an n×n raster at texel coordinates (qx, qy). */
export function bilinearQ(d: ArrayLike<number>, n: number, qx: number, qy: number, out: Float64Array): Float64Array {
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const fx = qx - ix;
  const fy = qy - iy;
  const x0 = clamp(ix, 0, n - 1);
  const x1 = clamp(ix + 1, 0, n - 1);
  const y0 = clamp(iy, 0, n - 1);
  const y1 = clamp(iy + 1, 0, n - 1);
  const a = d[y0 * n + x0];
  const b = d[y0 * n + x1];
  const c = d[y1 * n + x0];
  const e = d[y1 * n + x1];
  const ab = a + (b - a) * fx;
  const ce = c + (e - c) * fx;
  out[0] = ab + (ce - ab) * fy;
  out[1] = b - a + (e - c - (b - a)) * fy;
  out[2] = c - a + (e - b - (c - a)) * fx;
  return out;
}

const cr = (t: number, k: number): number =>
  k === 0 ? ((-0.5 * t + 1) * t - 0.5) * t : k === 1 ? (1.5 * t - 2.5) * t * t + 1 : k === 2 ? ((-1.5 * t + 2) * t + 0.5) * t : (0.5 * t - 0.5) * t * t;
const crd = (t: number, k: number): number =>
  k === 0 ? (-1.5 * t + 2) * t - 0.5 : k === 1 ? (4.5 * t - 5) * t : k === 2 ? (-4.5 * t + 4) * t + 0.5 : (1.5 * t - 1) * t;

/**
 * Catmull-Rom bicubic value and texel-space gradient at (qx, qy); out[3], out[4] = min, max of the
 * four nearest texels (the shader clamps to them so the curve cannot overshoot across a shoreline).
 * Reproduces the raster exactly at texel centres.
 */
export function bicubicQ(d: ArrayLike<number>, n: number, qx: number, qy: number, out: Float64Array): Float64Array {
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const fx = qx - ix;
  const fy = qy - iy;
  let v = 0;
  let gx = 0;
  let gy = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < 4; y++) {
    const row = clamp(iy + y - 1, 0, n - 1) * n;
    let rv = 0;
    let rd = 0;
    for (let x = 0; x < 4; x++) {
      const h = d[row + clamp(ix + x - 1, 0, n - 1)];
      rv += cr(fx, x) * h;
      rd += crd(fx, x) * h;
      if (x >= 1 && x <= 2 && y >= 1 && y <= 2) {
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    v += cr(fy, y) * rv;
    gx += cr(fy, y) * rd;
    gy += crd(fy, y) * rv;
  }
  out[0] = v;
  out[1] = gx;
  out[2] = gy;
  out[3] = lo;
  out[4] = hi;
  return out;
}

/**
 * Water bounds for detail terrain at a point (map metres, y from the north), from the macro
 * bilinear elevation `hb` and water level `wl` (0 when the world has no water layer): where the
 * macro is water the detail must stay ≤ wl − 0.5; where it is dry, ≥ wl + 0.5. Far from water
 * (wl dry) land above 0.5 m may not sink below 0.5 m. Returns [lo, hi].
 */
export function waterBounds(hb: number, wl: number): [number, number] {
  if (wl > DN.DRY) return hb < wl ? [-1e30, wl - 0.5] : [wl + 0.5, 1e30];
  return [hb >= 0.5 ? 0.5 : -1e30, 1e30];
}

/**
 * River valley cross-section (research 02 §4.4): parabolic channel from the bed `zb` up to the
 * water surface `zw` at the bank, a near-flat floor of half-width `fp` beyond it, then a valley wall
 * of slope `sv`, and a steep ramp in the last part of the ribbon so the min() fades into the terrain.
 * Outside the channel the profile never cuts below `lo` (dry land stays dry).
 */
export function carveProfile(r: number, zb: number, zw: number, w: number, fp: number, sv: number, ext: number, lo: number, macroCell: number): number {
  const half = 0.5 * w;
  let z: number;
  if (r < half) {
    const u = r / half;
    z = zb + (zw - zb) * u * u;
  } else {
    const x = r - half;
    z = Math.max(zw + 0.002 * Math.min(x, fp) + sv * Math.max(0, x - fp), lo);
  }
  const rampW = Math.min(macroCell, 0.4 * ext);
  const e0 = ext - rampW;
  if (r > e0) {
    const t = (r - e0) / rampW;
    z += 2000 * t * t;
  }
  return z;
}

// ---- The height function -----------------------------------------------------------------------

/** Everything the height function reads; mirrors the textures/uniforms bound for the shader. */
export interface HeightSources {
  /** World size (m). */
  size: number;
  /** Macro elevation (the `elevation` layer), macroN², row 0 = north. */
  macro: Float32Array;
  macroN: number;
  /** Prepared water level (render/heightField.ts `prepareWater`), same grid, or null (sea at 0). */
  water: Float32Array | null;
  /** Detail parameters, or null when the shader runs with u_hasDetail = 0 (macro only). */
  params: DetailParams | null;
  /** CPU copy of the detail texture (detailN², metres), or null while it is GPU-only (macro bicubic then stands in). */
  detail: Float32Array | null;
  /** Control texture (RGBA8, controlN²): roughness, rock, water/channel proximity, dunes. */
  control: Uint8Array | null;
  controlN: number;
}

const tA = new Float64Array(5);
const tB = new Float64Array(5);
const tC = new Float64Array(5);

/**
 * TS port of the VS/FS height function. `sample` returns [h, dh/dx, dh/dy] (raw elevation, metres,
 * world axes) for a pixel footprint `pxFoot` (m/px); same pxFoot ⇒ same value as the GLSL up to
 * float32 rounding.
 */
export class HeightFn {
  /** Global amplitude multiplier (u_detailAmp). */
  amp = 1;
  readonly size: number;

  constructor(readonly src: HeightSources) {
    this.size = src.size;
  }

  private q(n: number, x: number, y: number): [number, number] {
    return [(x / this.size) * n - 0.5, ((this.size - y) / this.size) * n - 0.5];
  }

  /** Bilinear macro elevation with gradient (= GLSL rawHeight). */
  macroBilinear(x: number, y: number, out = new Float64Array(3)): Float64Array {
    const n = this.src.macroN;
    const [qx, qy] = this.q(n, x, y);
    bilinearQ(this.src.macro, n, qx, qy, out);
    const k = n / this.size;
    out[1] *= k;
    out[2] *= -k;
    return out;
  }

  /** Catmull-Rom macro elevation (stands in for the detail texture before its CPU copy arrives). */
  macroBicubic(x: number, y: number, out = new Float64Array(5)): Float64Array {
    const n = this.src.macroN;
    const [qx, qy] = this.q(n, x, y);
    bicubicQ(this.src.macro, n, qx, qy, out);
    const k = n / this.size;
    out[1] *= k;
    out[2] *= -k;
    return out;
  }

  /** Bilinear prepared water level (= GLSL waterLevelAt with u_hasWater = 1). */
  waterLevelAt(x: number, y: number): number {
    const w = this.src.water;
    if (!w) return 0;
    const n = this.src.macroN;
    const [qx, qy] = this.q(n, x, y);
    return bilinearQ(w, n, qx, qy, tC)[0];
  }

  /** = GLSL surfaceHeight: per-texel water lid, then bilinear. */
  surfaceHeightMacro(x: number, y: number): number {
    const n = this.src.macroN;
    const [qx, qy] = this.q(n, x, y);
    const ix = Math.floor(qx);
    const iy = Math.floor(qy);
    const fx = qx - ix;
    const fy = qy - iy;
    const s = (tx: number, ty: number): number => {
      const i = clamp(ty, 0, n - 1) * n + clamp(tx, 0, n - 1);
      const h = this.src.macro[i];
      const wl = this.src.water ? this.src.water[i] : h < 0 ? 0 : -10000;
      return wl > DN.DRY ? Math.max(h, wl) : Math.max(h, 0);
    };
    const a = s(ix, iy);
    const b = s(ix + 1, iy);
    const c = s(ix, iy + 1);
    const d = s(ix + 1, iy + 1);
    const ab = a + (b - a) * fx;
    const cd = c + (d - c) * fx;
    return ab + (cd - ab) * fy;
  }

  /** Detail-map weight at a footprint: 1 below one detail texel per pixel, 0 above two (= GLSL detailWeight). */
  detailWeight(pxFoot: number): number {
    const p = this.src.params;
    if (!p) return 0;
    return 1 - smoothstep(p.texel, 2 * p.texel, pxFoot);
  }

  /** Control texel (GL LINEAR, clamp to edge), channels 0–1. */
  control(x: number, y: number, out: Float64Array): Float64Array {
    const c = this.src.control;
    const n = this.src.controlN;
    if (!c) {
      out.fill(0, 0, 4);
      return out;
    }
    const qx = (x / this.size) * n - 0.5;
    const qy = ((this.size - y) / this.size) * n - 0.5;
    const ix = Math.floor(qx);
    const iy = Math.floor(qy);
    const fx = qx - ix;
    const fy = qy - iy;
    const x0 = clamp(ix, 0, n - 1);
    const x1 = clamp(ix + 1, 0, n - 1);
    const y0 = clamp(iy, 0, n - 1);
    const y1 = clamp(iy + 1, 0, n - 1);
    for (let k = 0; k < 4; k++) {
      const a = c[(y0 * n + x0) * 4 + k];
      const b = c[(y0 * n + x1) * 4 + k];
      const d = c[(y1 * n + x0) * 4 + k];
      const e = c[(y1 * n + x1) * 4 + k];
      const ab = a + (b - a) * fx;
      const de = d + (e - d) * fx;
      out[k] = (ab + (de - ab) * fy) / 255;
    }
    return out;
  }

  /** Base elevation from the detail map (bilinear, bicubic when texels span ≥ 2–4 px). */
  private detailBase(x: number, y: number, pxFoot: number, out: Float64Array): Float64Array {
    const p = this.src.params!;
    const det = this.src.detail;
    if (!det) {
      this.macroBicubic(x, y, tB);
      out[0] = tB[0];
      out[1] = tB[1];
      out[2] = tB[2];
      return out;
    }
    const n = p.detailN;
    const [qx, qy] = this.q(n, x, y);
    bilinearQ(det, n, qx, qy, out);
    const tb = 1 - smoothstep(0.25 * p.texel, 0.5 * p.texel, pxFoot);
    if (tb > 0) {
      bicubicQ(det, n, qx, qy, tB);
      if (tB[0] < tB[3] || tB[0] > tB[4]) {
        tB[0] = clamp(tB[0], tB[3], tB[4]);
        tB[1] = out[1];
        tB[2] = out[2];
      }
      for (let i = 0; i < 3; i++) out[i] += (tB[i] - out[i]) * tb;
    }
    const k = n / this.size;
    out[1] *= k;
    out[2] *= -k;
    return out;
  }

  /** [h, dh/dx, dh/dy] of the rendered terrain (before the water lid) at footprint pxFoot. */
  sample(x: number, y: number, pxFoot: number, out = new Float64Array(3)): Float64Array {
    const p = this.src.params;
    if (!p) return this.macroBilinear(x, y, out);
    const t = this.detailWeight(pxFoot);
    if (t <= 0) return this.macroBilinear(x, y, out);
    this.detailBase(x, y, pxFoot, out);
    if (t < 1) {
      this.macroBilinear(x, y, tA);
      for (let i = 0; i < 3; i++) out[i] = tA[i] + (out[i] - tA[i]) * t;
    }
    if (pxFoot >= 0.5 * p.lam0) return out;
    const ctl = this.control(x, y, tC);
    const rough = ctl[0];
    const rock = ctl[1];
    const near = ctl[2];
    const dune = ctl[3];
    let amp = this.amp * (DN.AMP_BASE + DN.AMP_ROUGH * rough) * p.ampScale * (1 - near);
    let dAmp = this.amp * DN.DUNE_AMP * dune * (1 - near);
    const wl = this.src.water ? this.waterLevelAt(x, y) : 0;
    const room = wl > DN.DRY ? Math.abs(out[0] - wl) - DN.SHORE_MARGIN : 1e9;
    const tot = amp + DN.DUNE_MAX * dAmp;
    const s = tot > 0 ? clamp(room / tot, 0, 1) : 0;
    amp *= s;
    dAmp *= s;
    fbm(x, y, pxFoot, p.lam0, p.octaves, amp, rock, out[1], out[2], p.seed, out);
    dunes(x, y, pxFoot, dAmp, p.seed, out);
    return out;
  }

  terrainHeight(x: number, y: number, pxFoot: number): number {
    return this.sample(x, y, pxFoot, sOut)[0];
  }

  terrainGradient(x: number, y: number, pxFoot: number): [number, number] {
    const s = this.sample(x, y, pxFoot, sOut);
    return [s[1], s[2]];
  }

  /** Rendered surface before exaggeration: the water lid max(h, wl) (= GLSL terrainSurface). */
  terrainSurface(x: number, y: number, pxFoot: number): number {
    const p = this.src.params;
    if (!p) return this.surfaceHeightMacro(x, y);
    const t = this.detailWeight(pxFoot);
    const s0 = t < 1 ? this.surfaceHeightMacro(x, y) : 0;
    if (t <= 0) return s0;
    const h = this.sample(x, y, pxFoot, sOut)[0];
    const wl = this.src.water ? this.waterLevelAt(x, y) : 0;
    const s = wl > DN.DRY ? Math.max(h, wl) : Math.max(h, 0);
    return s0 + (s - s0) * t;
  }
}

const sOut = new Float64Array(3);

/**
 * GroundQuery over the detailed surface (camera clamps, picking, label/creek placement).
 * `pxFoot` is the footprint the geometry is drawn at near the point of interest; the renderer
 * should set it each frame (e.g. camera.metresPerPixel(), floored at the leaf vertex spacing).
 */
export class DetailGround implements GroundQuery {
  /** Footprint (m/px) used by heightAt/raycast when none is given. */
  pxFoot = 100;
  /** Max |slope| of the unexaggerated surface, for safe ray stepping. */
  maxSlope = 3;

  constructor(
    readonly fn: HeightFn,
    private readonly hf: HeightField,
    /** Max height the detail can add above the macro surface (m, unexaggerated). */
    readonly pad = 300,
  ) {}

  get size(): number {
    return this.hf.size;
  }

  /** Rendered height (water lid, exaggeration applied). */
  heightAt(x: number, y: number, pxFoot = this.pxFoot): number {
    const s = this.hf.size;
    return this.fn.terrainSurface(clamp(x, 0, s), clamp(y, 0, s), pxFoot) * this.hf.exaggeration;
  }

  /** Raw detailed elevation (m, no lid, no exaggeration). */
  detailHeightAt(x: number, y: number, pxFoot = this.pxFoot): number {
    const s = this.hf.size;
    return this.fn.terrainHeight(clamp(x, 0, s), clamp(y, 0, s), pxFoot);
  }

  /**
   * First hit of o + t·d with the rendered surface: Lipschitz-bounded marching (never steps over a
   * surface whose slope ≤ maxSlope), then bisection.
   */
  raycast(o: Vec3, d: Vec3, pxFoot = this.pxFoot): Vec3 | null {
    const s = this.hf.size;
    const ex = this.hf.exaggeration;
    const top = this.hf.maxHeight + this.pad * ex + 1;
    let t0 = 0;
    let t1 = Infinity;
    const clip = (p: number, dp: number, lo: number, hi: number): boolean => {
      if (Math.abs(dp) < 1e-12) return p >= lo && p <= hi;
      let a = (lo - p) / dp;
      let b = (hi - p) / dp;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, b);
      return t0 <= t1;
    };
    if (!clip(o.x, d.x, 0, s) || !clip(o.y, d.y, 0, s) || !clip(o.z, d.z, -12000 * ex, top)) return null;
    const hlen = Math.hypot(d.x, d.y);
    const rate = this.maxSlope * ex * hlen + Math.abs(d.z); // max change of (ray z − surface) per unit t
    const minDt = Math.max(0.25 * pxFoot, 1) / Math.max(1e-9, Math.hypot(hlen, d.z));
    const above = (t: number): number => o.z + d.z * t - this.heightAt(o.x + d.x * t, o.y + d.y * t, pxFoot);
    let t = t0;
    let a = above(t);
    if (a <= 0) return at(o, d, t);
    for (let i = 0; i < 100000 && t < t1; i++) {
      const dt = Math.max(minDt, a / Math.max(1e-9, rate));
      const tn = Math.min(t1, t + dt);
      const an = above(tn);
      if (an <= 0) {
        let lo = t;
        let hi = tn;
        for (let k = 0; k < 30; k++) {
          const mid = 0.5 * (lo + hi);
          if (above(mid) > 0) lo = mid;
          else hi = mid;
        }
        return at(o, d, hi);
      }
      if (tn >= t1) break;
      t = tn;
      a = an;
    }
    return null;
  }
}

function at(o: Vec3, d: Vec3, t: number): Vec3 {
  return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
}
