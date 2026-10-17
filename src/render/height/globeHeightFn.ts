import type { Vec3 } from '../camera/ground';
import { FACE_C, FACE_E, FACE_S, faceDir } from '../../shared/cube';
import { dirToFaceAngles, PAD } from '../globe/cubeTex';
import { raySphere, type GlobeGround, type GlobeHeightField } from '../globe/globeGround';
import { DN, detailParams, footWeight, octSeed, smoothstep } from './heightFn';

/**
 * The globe's close-zoom height function, TypeScript side (Sphere phase 4b; research 10 §6.3, §6.7).
 * It mirrors `GLOBE_DETAIL_GLSL` (render/glsl/globeDetail.ts) operation by operation, and the GLSL is
 * generated from the constants here, as on flat maps (heightFn.ts ↔ glsl/detail.ts).
 *
 * The height at a direction is
 *   - far out: the bilinear macro over the padded cube faces (exactly the phase-3 globe);
 *   - closer (pixel footprint below two detail texels): the streamed detail tiles, blended across tile
 *     and face boundaries with a partition of unity, the clamped Catmull-Rom macro where a tile is not
 *     resident;
 *   - closer still: footprint-faded 3D noise octaves (`noise3` at the sea-level point dir·R, so there
 *     are no face seams), damped by the slope and capped so they never cross the sea level.
 *
 * Tiles live in face texel space: face f is n·k texels per side (k detail texels per macro cell),
 * split into T × T tiles of N texels, each stored with an M-texel margin of its neighbours so blends
 * near tile and face edges read real data. A point's texel coordinates on face g are
 * p = (angles in g's gnomonic chart + π/4) / δ; the chart extends past the face edge, so a tile's
 * margin across a seam is simply further along the same chart.
 */

/** Globe detail constants (shared with the GLSL). */
export const DG = {
  /** Hash multiplier for the third lattice axis (odd). */
  M4: 0x297a2d39,
  SEED_COAST: 0x3c6ef372,
  /** Detail texel target (m): k = texels per macro cell is the power of two closest to cell / this. */
  TEXEL_TARGET: 250,
  K_MIN: 2,
  K_MAX: 16,
  /** Stored margin, build apron and cross-fade half-width (texels). */
  MARGIN: 12,
  APRON: 48,
  BLEND: 8,
  /** Coastal band: noise amplitude = clamp(macro slope · COAST_DISP, COAST_MIN, COAST_MAX) m. */
  COAST_DISP: 700,
  COAST_MIN: 2,
  COAST_MAX: 60,
  /** How far (m) the water bounds relax inside the coastal band (×band weight). */
  COAST_RELAX: 1000,
  /**
   * Effective water level: the prepared level where real water (a cell with its own level, not a river)
   * is within reach of the bilinear mask, sinking by WET_DROP m as the mask falls from WET_FADE to 0. The
   * spread rings keep shores smooth but don't flood dry valley floors or carved channels next to a lake.
   */
  WET_FADE: 0.05,
  WET_DROP: 1000,
} as const;

/** The effective water level for a prepared level `wl` (< DRY: dry) and the real-water mask `wet` (0..1). */
export function wetLevel(wl: number, wet: number): number {
  return wl - DG.WET_DROP * (1 - Math.min(1, Math.max(0, wet / DG.WET_FADE)));
}

// ---- Tile lattice -----------------------------------------------------------------------------------

export interface TileLattice {
  /** Macro cells per face side and planet radius (m). */
  n: number;
  radius: number;
  /** Detail texels per macro cell, per face side (n·k), per tile core (N) and tiles per side (T). */
  k: number;
  F: number;
  N: number;
  T: number;
  M: number;
  A: number;
  B: number;
  /** Texel angle (rad) and nominal texel size (m) = R·δ. */
  delta: number;
  texelM: number;
}

const pow2Round = (x: number): number => 2 ** Math.round(Math.log2(Math.max(1e-9, x)));

/** The tile lattice for a face grid of n cells at radius R, with tiles of at most `tileN` texels. */
export function tileLattice(n: number, radius: number, tileN: number): TileLattice {
  const cell = (radius * Math.PI) / 2 / n;
  const k = Math.min(DG.K_MAX, Math.max(DG.K_MIN, pow2Round(cell / DG.TEXEL_TARGET)));
  const F = n * k;
  let T = Math.max(1, Math.ceil(F / tileN));
  while (F % T !== 0 || (F / T) % k !== 0 || (F / T + 2 * DG.MARGIN) % 4 !== 0) T++;
  const N = F / T;
  const delta = Math.PI / 2 / F;
  return { n, radius, k, F, N, T, M: DG.MARGIN, A: DG.APRON, B: DG.BLEND, delta, texelM: radius * delta };
}

export const tileKey = (face: number, ix: number, iy: number, T: number): number => (face * T + iy) * T + ix;

export function tileOfKey(key: number, T: number): [number, number, number] {
  const ix = key % T;
  const r = (key - ix) / T;
  const iy = r % T;
  return [(r - iy) / T, ix, iy];
}

/** Stored texels per tile side (core + both margins). */
export const tileStride = (l: TileLattice): number => l.N + 2 * l.M;

/** Direction of the centre of a tile and the angle from it to its farthest corner. */
export function tileCentre(l: TileLattice, key: number, out: Float64Array): number {
  const [f, ix, iy] = tileOfKey(key, l.T);
  const span = l.N * l.delta;
  const a0 = -Math.PI / 4 + ix * span;
  const b0 = -Math.PI / 4 + iy * span;
  faceDir(f, a0 + span / 2, b0 + span / 2, out);
  const c0 = out[0], c1 = out[1], c2 = out[2];
  let rho = 0;
  const t = new Float64Array(3);
  for (const [a, b] of [[a0, b0], [a0 + span, b0], [a0, b0 + span], [a0 + span, b0 + span]]) {
    faceDir(f, a, b, t);
    rho = Math.max(rho, Math.acos(Math.min(1, c0 * t[0] + c1 * t[1] + c2 * t[2])));
  }
  return rho;
}

/** One axis of a tile's blend weight at core coordinate u (texels): 1 inside, ramping to 0 at u = −B and N + B. */
export function tileWeight1(u: number, N: number, B: number): number {
  return smoothstep(0, 1, (u + B) / (2 * B)) * smoothstep(0, 1, (N + B - u) / (2 * B));
}

/** Face whose centre is the unit axis v (one of ±x, ±y, ±z). */
export function faceOfAxis(x: number, y: number, z: number): number {
  return x > 0.5 ? 0 : y > 0.5 ? 1 : x < -0.5 ? 2 : y < -0.5 ? 3 : z > 0.5 ? 4 : 5;
}

/** Angles (a, b) of a direction in face g's gnomonic chart (valid on g's half of the sphere). */
export function chartAngles(g: number, x: number, y: number, z: number, out: Float64Array): Float64Array {
  const k = g * 3;
  const c = x * FACE_C[k] + y * FACE_C[k + 1] + z * FACE_C[k + 2];
  out[0] = Math.atan2(x * FACE_E[k] + y * FACE_E[k + 1] + z * FACE_E[k + 2], c);
  out[1] = Math.atan2(x * FACE_S[k] + y * FACE_S[k + 1] + z * FACE_S[k + 2], c);
  return out;
}

/**
 * 3D tangent gradient of a field on face g from its derivatives per radian of the chart angles
 * (ga = ∂h/∂a, gb = ∂h/∂b): solves g·ta = ga, g·tb = gb with ta, tb the chart's tangent vectors (m/rad).
 */
export function chartGrad(g: number, a: number, b: number, ga: number, gb: number, R: number, out: Float64Array, o = 1): void {
  const X = Math.tan(a);
  const Y = Math.tan(b);
  const L2 = 1 + X * X + Y * Y;
  const L = Math.sqrt(L2);
  // Face-local axes (e, s, c): d = (X, Y, 1)/L; ∂d/∂a = sec²a (e − d X/L)/L, ∂d/∂b = sec²b (s − d Y/L)/L.
  const sa = (1 + X * X) / L;
  const sb = (1 + Y * Y) / L;
  const tax = R * sa * (1 - (X * X) / L2), tay = R * sa * (-(X * Y) / L2), taz = R * sa * (-X / L2);
  const tbx = R * sb * (-(X * Y) / L2), tby = R * sb * (1 - (Y * Y) / L2), tbz = R * sb * (-Y / L2);
  const aa = tax * tax + tay * tay + taz * taz;
  const bb = tbx * tbx + tby * tby + tbz * tbz;
  const ab = tax * tbx + tay * tby + taz * tbz;
  const det = aa * bb - ab * ab;
  const al = (ga * bb - gb * ab) / det;
  const be = (gb * aa - ga * ab) / det;
  const lx = al * tax + be * tbx, ly = al * tay + be * tby, lz = al * taz + be * tbz;
  const k = g * 3;
  out[o] = lx * FACE_E[k] + ly * FACE_S[k] + lz * FACE_C[k];
  out[o + 1] = lx * FACE_E[k + 1] + ly * FACE_S[k + 1] + lz * FACE_C[k + 1];
  out[o + 2] = lx * FACE_E[k + 2] + ly * FACE_S[k + 2] + lz * FACE_C[k + 2];
}

// ---- 3D integer-hash value noise ----------------------------------------------------------------------

/** 32-bit hash of a 3D lattice point (bit-identical to GLSL `gHash`). */
export function hash3U(ix: number, iy: number, iz: number, seed: number): number {
  let h = (Math.imul(ix, DN.M1) ^ Math.imul(iy, DN.M2) ^ Math.imul(iz, DG.M4) ^ Math.imul(seed, DN.M3)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, DN.F1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, DN.F2) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const v3 = (ix: number, iy: number, iz: number, s: number): number => (hash3U(ix, iy, iz, s) >>> 8) * (2 / 16777216) - 1;

/**
 * Quintic 3D value noise at the point (x, y, z) (m, planet-centred) on a lattice of spacing lam (a power
 * of two ≤ DN.TILE): out = [n, ∂n/∂x, ∂n/∂y, ∂n/∂z] (per metre). The GLSL evaluates the same lattice
 * from a 65 536 m tile index plus a local offset relative to the camera (the arguments stay small).
 */
export function noise3(x: number, y: number, z: number, lam: number, seed: number, out: Float64Array): Float64Array {
  const qx = x / lam, qy = y / lam, qz = z / lam;
  const ix = Math.floor(qx), iy = Math.floor(qy), iz = Math.floor(qz);
  const fx = qx - ix, fy = qy - iy, fz = qz - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const dx = 30 * fx * fx * (fx * (fx - 2) + 1);
  const dy = 30 * fy * fy * (fy * (fy - 2) + 1);
  const dz = 30 * fz * fz * (fz * (fz - 2) + 1);
  const a = v3(ix, iy, iz, seed), b = v3(ix + 1, iy, iz, seed);
  const c = v3(ix, iy + 1, iz, seed), d = v3(ix + 1, iy + 1, iz, seed);
  const e = v3(ix, iy, iz + 1, seed), f = v3(ix + 1, iy, iz + 1, seed);
  const g = v3(ix, iy + 1, iz + 1, seed), h = v3(ix + 1, iy + 1, iz + 1, seed);
  const k1 = b - a, k2 = c - a, k3 = e - a;
  const k4 = a - b - c + d, k5 = a - c - e + g, k6 = a - b - e + f;
  const k7 = -a + b + c - d + e - f - g + h;
  out[0] = a + k1 * ux + k2 * uy + k3 * uz + k4 * ux * uy + k5 * uy * uz + k6 * uz * ux + k7 * ux * uy * uz;
  out[1] = (dx * (k1 + k4 * uy + k6 * uz + k7 * uy * uz)) / lam;
  out[2] = (dy * (k2 + k5 * uz + k4 * ux + k7 * uz * ux)) / lam;
  out[3] = (dz * (k3 + k6 * ux + k5 * uy + k7 * ux * uy)) / lam;
  return out;
}

const n4 = new Float64Array(4);

/**
 * Derivative-damped, optionally ridged 3D fBm on the sphere (heightFn.fbm in 3D): noise gradients are
 * projected onto the tangent plane at `up`, the damping reads the tangent slope including the base
 * gradient g0, and every octave is faded by footprint. Adds [h, gx, gy, gz] into `out`; |h| ≤ amp.
 */
export function fbm3(
  x: number, y: number, z: number, up: Float64Array, pxFoot: number, lam0: number, oct: number, amp: number, ridge: number,
  g0: Float64Array, seed: number, out: Float64Array,
): Float64Array {
  if (amp <= 0) return out;
  let a = amp / (2 * (1 - 0.5 ** oct) * DN.RIDGE_MAX);
  let lam = lam0;
  let sx = g0[1], sy = g0[2], sz = g0[3];
  for (let k = 0; k < DN.MAX_OCT; k++) {
    if (k >= oct) break;
    const fw = footWeight(pxFoot, lam);
    if (fw <= 0) break;
    noise3(x, y, z, lam, octSeed(seed, k), n4);
    const r = n4[1] * up[0] + n4[2] * up[1] + n4[3] * up[2];
    const u1 = n4[1] - r * up[0], u2 = n4[2] - r * up[1], u3 = n4[3] - r * up[2];
    const s = n4[0] > 0 ? 1 : n4[0] < 0 ? -1 : 0;
    const n0 = n4[0] + (DN.RIDGE_HI - 2 * Math.abs(n4[0]) - n4[0]) * ridge;
    const g1 = u1 + (-2 * s * u1 - u1) * ridge;
    const g2 = u2 + (-2 * s * u2 - u2) * ridge;
    const g3 = u3 + (-2 * s * u3 - u3) * ridge;
    const c = (fw * a) / (1 + DN.DAMP * (sx * sx + sy * sy + sz * sz));
    out[0] += c * n0;
    out[1] += c * g1;
    out[2] += c * g2;
    out[3] += c * g3;
    // Damping accumulates the unridged slope (scaled like the ridge's): the ridged gradient flips sign at
    // the crease, which would make every finer octave's damping, and so the height, jump there.
    const ka = a * (1 + ridge);
    sx += ka * u1;
    sy += ka * u2;
    sz += ka * u3;
    a *= 0.5;
    lam *= 0.5;
  }
  return out;
}

// ---- Parameters ----------------------------------------------------------------------------------------

export interface GlobeDetailParams {
  seed: number;
  /** Nominal detail texel and macro cell (m). */
  texelM: number;
  macroCell: number;
  /** Shader octaves: longest wavelength (m), count and amplitude scale (as heightFn.detailParams). */
  lam0: number;
  octaves: number;
  ampScale: number;
  /** Baked octaves of the tile build. */
  bakeLam0: number;
  bakeOct: number;
  bakeAmpScale: number;
}

export function globeDetailParams(l: TileLattice, seed: number): GlobeDetailParams {
  const p = detailParams(l.F * l.texelM, l.F, l.n, seed);
  return {
    seed: p.seed, texelM: p.texel, macroCell: p.macroCell, lam0: p.lam0, octaves: p.octaves, ampScale: p.ampScale,
    bakeLam0: p.bakeLam0, bakeOct: p.bakeOct, bakeAmpScale: p.bakeAmpScale,
  };
}

/** Max |detail − macro| (m, unexaggerated) the globe can show: pads CDLOD bounds and the ray-march shell. */
export function globeBoundsPad(p: GlobeDetailParams, anchorMetres: number): number {
  const bake = (DN.BAKE_BASE + DN.BAKE_ROUGH) * p.bakeAmpScale;
  const shader = (DN.AMP_BASE + DN.AMP_ROUGH) * p.ampScale;
  return Math.ceil(anchorMetres + bake + DG.COAST_MAX + shader + 50);
}

// ---- The height function ---------------------------------------------------------------------------

/** Resident tiles as the height function sees them. */
export interface TileSource {
  readonly lattice: TileLattice;
  /** CPU heights of a resident tile (stride² metres, row = v) and its fade-in weight, or null. */
  tile(key: number): { data: Float32Array | null; fade: number } | null;
}

export interface GlobeHeightSources {
  n: number;
  radius: number;
  /** Raw elevation padded like the GPU array: 6 × (n + 2·PAD)² (m). */
  macroPad: Float32Array;
  /** Rendered macro surface (the water lid), padded: GlobeHeightField.padded = the GPU's u_surf. Null: max(h, 0) of macroPad. */
  surfacePad?: Float32Array | null;
  /** Prepared water levels, padded (< DRY: dry), as the GPU's u_wlevelD; null: the sea at 0 everywhere. */
  waterPad?: Float32Array | null;
  /** Real-water mask, padded (the GPU's u_wetD); null: 1 everywhere. */
  wetPad?: Float32Array | null;
  /** Control (RGBA8, padded like the macro): roughness, rock, water proximity, unused. */
  control: Uint8Array | null;
  params: GlobeDetailParams | null;
  tiles: TileSource | null;
}

const Q = Math.PI / 4;
const tA = new Float64Array(4);
const tB = new Float64Array(5);
const tC = new Float64Array(4);
const tD = new Float64Array(4);
const ang = new Float64Array(3);
const dir3 = new Float64Array(3);

const cr = (t: number, k: number): number =>
  k === 0 ? ((-0.5 * t + 1) * t - 0.5) * t : k === 1 ? (1.5 * t - 2.5) * t * t + 1 : k === 2 ? ((-1.5 * t + 2) * t + 0.5) * t : (0.5 * t - 0.5) * t * t;
const crd = (t: number, k: number): number =>
  k === 0 ? (-1.5 * t + 2) * t - 0.5 : k === 1 ? (4.5 * t - 5) * t : k === 2 ? (-4.5 * t + 4) * t + 0.5 : (1.5 * t - 1) * t;

/** Catmull-Rom on a row-major raster (offset `base`, width w) at (qx, qy): [v, gx, gy, min, max of the 4 nearest]. Caller keeps 1 ≤ ix ≤ w − 3. */
const blk = new Float64Array(16);
const cmx = new Float64Array(9);
const cmn = new Float64Array(9);

/**
 * Catmull-Rom on a row-major raster (offset `base`, width w) at (qx, qy): [v, gx, gy, min, max]. Caller
 * keeps 1 ≤ ix ≤ w − 3. The value is clamped to a continuous envelope of the cell (2×2 texel) extremes:
 * the 3×3 cells around the point interpolated on the dual grid of cell centres, so at a cell centre it
 * is the flat maps' four-texel clamp, and it never jumps at texel edges (min, max = that envelope).
 */
function bicubicAt(d: ArrayLike<number>, base: number, w: number, qx: number, qy: number, out: Float64Array): Float64Array {
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const fx = qx - ix;
  const fy = qy - iy;
  let v = 0, gx = 0, gy = 0;
  for (let y = 0; y < 4; y++) {
    const row = base + (iy + y - 1) * w + ix - 1;
    let rv = 0, rd = 0;
    for (let x = 0; x < 4; x++) {
      const h = d[row + x];
      blk[y * 4 + x] = h;
      rv += cr(fx, x) * h;
      rd += crd(fx, x) * h;
    }
    v += cr(fy, y) * rv;
    gx += cr(fy, y) * rd;
    gy += crd(fy, y) * rv;
  }
  envelope(fx, fy, out);
  out[0] = Math.min(out[4], Math.max(out[3], v));
  out[1] = gx;
  out[2] = gy;
  return out;
}

/** Continuous min/max envelope of the 2×2-texel cell extremes over `blk` (see bicubicAt) into out[3], out[4]. */
function envelope(fx: number, fy: number, out: Float64Array): void {
  for (let cy = 0; cy < 3; cy++) {
    for (let cx = 0; cx < 3; cx++) {
      const a = blk[cy * 4 + cx], b = blk[cy * 4 + cx + 1], c = blk[cy * 4 + cx + 4], e = blk[cy * 4 + cx + 5];
      cmx[cy * 3 + cx] = Math.max(a, b, c, e);
      cmn[cy * 3 + cx] = Math.min(a, b, c, e);
    }
  }
  const sx = fx < 0.5 ? 0 : 1, sy = fy < 0.5 ? 0 : 1;
  const tx = fx < 0.5 ? fx + 0.5 : fx - 0.5, ty = fy < 0.5 ? fy + 0.5 : fy - 0.5;
  const k = sy * 3 + sx;
  const lerp2 = (m: Float64Array): number => {
    const top = m[k] + (m[k + 1] - m[k]) * tx;
    const bot = m[k + 3] + (m[k + 4] - m[k + 3]) * tx;
    return top + (bot - top) * ty;
  };
  out[3] = lerp2(cmn);
  out[4] = lerp2(cmx);
}

/** Bilinear value and texel gradient on a row-major raster at (qx, qy), indices clamped to [0, w − 1]. */
function bilinearAt(d: ArrayLike<number>, base: number, w: number, qx: number, qy: number, out: Float64Array): Float64Array {
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const fx = qx - ix;
  const fy = qy - iy;
  const x0 = Math.min(w - 1, Math.max(0, ix)), x1 = Math.min(w - 1, Math.max(0, ix + 1));
  const y0 = Math.min(w - 1, Math.max(0, iy)), y1 = Math.min(w - 1, Math.max(0, iy + 1));
  const a = d[base + y0 * w + x0], b = d[base + y0 * w + x1], c = d[base + y1 * w + x0], e = d[base + y1 * w + x1];
  const ab = a + (b - a) * fx;
  const ce = c + (e - c) * fx;
  out[0] = ab + (ce - ab) * fy;
  out[1] = b - a + (e - c - (b - a)) * fy;
  out[2] = c - a + (e - b - (c - a)) * fx;
  return out;
}

/**
 * TS port of the globe shader's height function. `sample` returns [h, gx, gy, gz]: raw elevation (m)
 * and its 3D tangent gradient (m/m), for a pixel footprint (m/px). With the same footprint it agrees
 * with the GLSL to float32 rounding (and the GPU's 8-bit linear filter of the control texture).
 */
export class GlobeHeightFn {
  amp = 1;
  readonly n: number;
  readonly radius: number;
  readonly delta: number;
  readonly m: number;

  constructor(readonly src: GlobeHeightSources) {
    this.n = src.n;
    this.radius = src.radius;
    this.delta = Math.PI / 2 / src.n;
    this.m = src.n + 2 * PAD;
  }

  /** Bilinear raw macro (= GLSL heightAt(f, ang).x) with its tangent gradient. */
  macroBilinear(face: number, a: number, b: number, out: Float64Array): Float64Array {
    const m = this.m;
    const px = Math.min(m - 1.001, Math.max(0, (a + Q) / this.delta - 0.5 + PAD));
    const py = Math.min(m - 1.001, Math.max(0, (b + Q) / this.delta - 0.5 + PAD));
    bilinearAt(this.src.macroPad, face * m * m, m, px, py, tA);
    out[0] = tA[0];
    chartGrad(face, a, b, tA[1] / this.delta, tA[2] / this.delta, this.radius, out);
    return out;
  }

  /** Rendered macro surface (= GLSL heightAt(f, ang).y): bilinear of the water lid. */
  surfaceMacro(face: number, a: number, b: number): number {
    const m = this.m;
    const px = Math.min(m - 1.001, Math.max(0, (a + Q) / this.delta - 0.5 + PAD));
    const py = Math.min(m - 1.001, Math.max(0, (b + Q) / this.delta - 0.5 + PAD));
    const x0 = Math.floor(px), y0 = Math.floor(py);
    const fx = px - x0, fy = py - y0;
    const lid = this.src.surfacePad ?? null;
    const d = lid ?? this.src.macroPad;
    const o = face * m * m + y0 * m + x0;
    const s = lid ? (v: number): number => v : (v: number): number => (v > 0 ? v : 0);
    const top = s(d[o]) + (s(d[o + 1]) - s(d[o])) * fx;
    const bot = s(d[o + m]) + (s(d[o + m + 1]) - s(d[o + m])) * fx;
    return top + (bot - top) * fy;
  }

  /** Catmull-Rom of the macro (the base where no tile is resident, envelope-clamped) with its tangent gradient. */
  macroCubic(face: number, a: number, b: number, out: Float64Array): Float64Array {
    const m = this.m;
    const px = Math.min(m - 2.001, Math.max(1, (a + Q) / this.delta - 0.5 + PAD));
    const py = Math.min(m - 2.001, Math.max(1, (b + Q) / this.delta - 0.5 + PAD));
    bicubicAt(this.src.macroPad, face * m * m, m, px, py, tB);
    out[0] = tB[0];
    chartGrad(face, a, b, tB[1] / this.delta, tB[2] / this.delta, this.radius, out);
    return out;
  }

  /** Water surface (= GLSL gWaterLevel): the effective level (wetLevel) of the bilinear prepared level (< DRY dry), or the sea at 0. */
  waterLevel(face: number, a: number, b: number): number {
    const w = this.src.waterPad;
    if (!w) return 0;
    const m = this.m;
    const px = Math.min(m - 1.001, Math.max(0, (a + Q) / this.delta - 0.5 + PAD));
    const py = Math.min(m - 1.001, Math.max(0, (b + Q) / this.delta - 0.5 + PAD));
    bilinearAt(w, face * m * m, m, px, py, tA);
    const wl = tA[0];
    const wet = this.src.wetPad;
    if (!wet || wl <= DN.DRY) return wl;
    bilinearAt(wet, face * m * m, m, px, py, tA);
    return wetLevel(wl, tA[0]);
  }

  /** Share of the detail (tiles + octaves) at a footprint: 1 below one texel per pixel, 0 above two. */
  detailWeight(pxFoot: number): number {
    const p = this.src.params;
    if (!p) return 0;
    return 1 - smoothstep(p.texelM, 2 * p.texelM, pxFoot);
  }

  /** Control (GL LINEAR over the padded faces), channels 0–1. */
  control(face: number, a: number, b: number, out: Float64Array): Float64Array {
    const c = this.src.control;
    if (!c) {
      out.fill(0);
      return out;
    }
    const m = this.m;
    const px = (a + Q) / this.delta + PAD - 0.5;
    const py = (b + Q) / this.delta + PAD - 0.5;
    const ix = Math.floor(px), iy = Math.floor(py);
    const fx = px - ix, fy = py - iy;
    const x0 = Math.min(m - 1, Math.max(0, ix)), x1 = Math.min(m - 1, Math.max(0, ix + 1));
    const y0 = Math.min(m - 1, Math.max(0, iy)), y1 = Math.min(m - 1, Math.max(0, iy + 1));
    const base = face * m * m;
    for (let k = 0; k < 4; k++) {
      const p = c[(base + y0 * m + x0) * 4 + k], q = c[(base + y0 * m + x1) * 4 + k];
      const r = c[(base + y1 * m + x0) * 4 + k], s = c[(base + y1 * m + x1) * 4 + k];
      const pq = p + (q - p) * fx;
      out[k] = (pq + (r + (s - r) * fx - pq) * fy) / 255;
    }
    return out;
  }

  /**
   * Detail base at a direction: resident tiles blended by their partition-of-unity weights (in each
   * tile's own face chart), the Catmull-Rom macro for the share of missing or fading tiles.
   */
  tileBase(face: number, a: number, b: number, dx: number, dy: number, dz: number, pxFoot: number, out: Float64Array): Float64Array {
    const ts = this.src.tiles;
    this.macroCubic(face, a, b, out);
    if (!ts) return out;
    const l = ts.lattice;
    const { N, T, M, B, F } = l;
    const W = N + 2 * M;
    const p = this.src.params!;
    const tb = 1 - smoothstep(0.25 * p.texelM, 0.5 * p.texelM, pxFoot);
    let wsum = 0, wres = 0, h = 0, gx = 0, gy = 0, gz = 0;
    const pfx = (a + Q) / l.delta, pfy = (b + Q) / l.delta;
    const k = face * 3;
    for (let side = -1; side < 4; side++) {
      // side −1: the own face; 0..3: the faces across W, E, N, S when within B texels of that edge.
      let g = face;
      let ga = a, gb = b;
      if (side >= 0) {
        const near = side === 0 ? pfx < B : side === 1 ? pfx > F - B : side === 2 ? pfy < B : pfy > F - B;
        if (!near) continue;
        const sg = side === 0 || side === 2 ? -1 : 1;
        const ax = side < 2 ? FACE_E : FACE_S;
        g = faceOfAxis(sg * ax[k], sg * ax[k + 1], sg * ax[k + 2]);
        chartAngles(g, dx, dy, dz, ang);
        ga = ang[0];
        gb = ang[1];
      }
      const px = (ga + Q) / l.delta, py = (gb + Q) / l.delta;
      const ix0 = Math.max(0, Math.floor((px - B) / N)), ix1 = Math.min(T - 1, Math.floor((px + B) / N));
      const iy0 = Math.max(0, Math.floor((py - B) / N)), iy1 = Math.min(T - 1, Math.floor((py + B) / N));
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const u = px - ix * N, v = py - iy * N;
          const w = tileWeight1(u, N, B) * tileWeight1(v, N, B);
          if (w <= 0) continue;
          wsum += w;
          const t = ts.tile(tileKey(g, ix, iy, T));
          if (!t || !t.data || t.fade <= 0) continue;
          const qx = u + M - 0.5, qy = v + M - 0.5;
          bilinearAt(t.data, 0, W, qx, qy, tC);
          if (tb > 0) {
            bicubicAt(t.data, 0, W, qx, qy, tB);
            for (let i = 0; i < 3; i++) tC[i] += (tB[i] - tC[i]) * tb;
          }
          chartGrad(g, ga, gb, tC[1] / l.delta, tC[2] / l.delta, l.radius, tD);
          const wf = w * t.fade;
          wres += wf;
          h += wf * tC[0];
          gx += wf * tD[1];
          gy += wf * tD[2];
          gz += wf * tD[3];
        }
      }
    }
    if (wres <= 0 || wsum <= 0) return out;
    const rest = wsum - wres;
    out[0] = (h + rest * out[0]) / wsum;
    out[1] = (gx + rest * out[1]) / wsum;
    out[2] = (gy + rest * out[2]) / wsum;
    out[3] = (gz + rest * out[3]) / wsum;
    return out;
  }

  /** [h, gx, gy, gz] of the rendered terrain (before the sea lid) at face angles (a, b) and footprint pxFoot. */
  sample(face: number, a: number, b: number, pxFoot: number, out = new Float64Array(4)): Float64Array {
    const p = this.src.params;
    this.macroBilinear(face, a, b, out);
    if (!p) return out;
    const t = this.detailWeight(pxFoot);
    if (t <= 0) return out;
    faceDir(face, a, b, dir3);
    const m0 = out[0], m1 = out[1], m2 = out[2], m3 = out[3];
    this.tileBase(face, a, b, dir3[0], dir3[1], dir3[2], pxFoot, out);
    if (t < 1) {
      out[0] = m0 + (out[0] - m0) * t;
      out[1] = m1 + (out[1] - m1) * t;
      out[2] = m2 + (out[2] - m2) * t;
      out[3] = m3 + (out[3] - m3) * t;
    }
    if (pxFoot >= 0.5 * p.lam0) return out;
    const ctl = this.control(face, a, b, tD);
    const amp = this.amp * (DN.AMP_BASE + DN.AMP_ROUGH * ctl[0]) * p.ampScale * (1 - ctl[2]);
    const rock = ctl[1];
    const wl = this.waterLevel(face, a, b);
    const room = wl > DN.DRY ? Math.abs(out[0] - wl) - DN.SHORE_MARGIN : 1e9;
    const s = amp > 0 ? Math.min(1, Math.max(0, room / amp)) : 0;
    const R = this.radius;
    fbm3(dir3[0] * R, dir3[1] * R, dir3[2] * R, dir3, pxFoot, p.lam0, p.octaves, amp * s, rock, out, p.seed, out);
    return out;
  }

  /** Rendered surface before exaggeration: the water lid max(h, level) (= GLSL globeSurface). */
  surface(face: number, a: number, b: number, pxFoot: number): number {
    const t = this.detailWeight(pxFoot);
    const s0 = t < 1 ? this.surfaceMacro(face, a, b) : 0;
    if (t <= 0) return s0;
    const h = this.sample(face, a, b, pxFoot, sOut)[0];
    const wl = this.waterLevel(face, a, b);
    return s0 + ((wl > DN.DRY ? Math.max(h, wl) : Math.max(h, 0)) - s0) * t;
  }
}

const sOut = new Float64Array(4);

/**
 * GlobeGround over the detailed globe surface (camera clamps and picking). `pxFoot` is the footprint the
 * geometry is drawn at near the point of interest; the renderer sets it every frame
 * (max(metres per pixel, leaf vertex spacing)). Beyond two texels per pixel it is exactly the macro
 * height field, so the fast macro ray march is used there.
 */
export class GlobeDetailGround implements GlobeGround {
  pxFoot = 1000;
  /** Max |slope| of the unexaggerated detailed surface, for safe ray stepping. */
  maxSlope = 3;
  private readonly fa = new Float64Array(3);

  constructor(
    readonly fn: GlobeHeightFn,
    private readonly hf: GlobeHeightField,
    /** Max height the detail adds above the macro surface (m, unexaggerated). */
    readonly pad: number,
  ) {}

  get radius(): number {
    return this.hf.radius;
  }

  get maxHeight(): number {
    return this.hf.maxHeight + this.pad * this.hf.exaggeration;
  }

  private foot(p: number): number {
    if (!(p > 0)) p = this.pxFoot > 0 ? this.pxFoot : 1000;
    return Math.min(p, 1e9);
  }

  /** True when the footprint shows macro only (the detail weight is 0). */
  private macroOnly(pxFoot: number): boolean {
    return this.fn.detailWeight(pxFoot) <= 0;
  }

  heightAtDir(x: number, y: number, z: number, pxFoot = this.pxFoot): number {
    const f = this.foot(pxFoot);
    if (this.macroOnly(f)) return this.hf.heightAtDir(x, y, z);
    dirToFaceAngles(x, y, z, this.fa);
    return this.fn.surface(this.fa[0], this.fa[1], this.fa[2], f) * this.hf.exaggeration;
  }

  /** Raw detailed elevation (m, no lid, no exaggeration) toward a direction. */
  elevationAtDir(x: number, y: number, z: number, pxFoot = this.pxFoot): number {
    dirToFaceAngles(x, y, z, this.fa);
    return this.fn.sample(this.fa[0], this.fa[1], this.fa[2], this.foot(pxFoot), sOut)[0];
  }

  /**
   * First hit of o + t·d (d unit) with the detailed surface: Lipschitz-bounded marching through the
   * shell between R and R + maxHeight (never steps over a surface of slope ≤ maxSlope), then bisection.
   */
  raycast(o: Vec3, d: Vec3, pxFoot = this.pxFoot): Vec3 | null {
    const foot = this.foot(pxFoot);
    if (this.macroOnly(foot)) return this.hf.raycast(o, d);
    const R = this.hf.radius;
    const outer = raySphere(o, d, R + this.maxHeight + 1);
    if (!outer || outer[1] < 0) return null;
    const t0 = Math.max(0, outer[0]);
    let t1 = outer[1];
    const inner = raySphere(o, d, R);
    if (inner && inner[0] >= 0) t1 = Math.min(t1, inner[0]);
    const ex = this.hf.exaggeration;
    const rate = 1 + this.maxSlope * ex;
    const minDt = Math.max(0.25 * foot, 0.5);
    const above = (t: number): number => {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      return Math.sqrt(x * x + y * y + z * z) - R - this.heightAtDir(x, y, z, foot);
    };
    let t = t0;
    let a = above(t);
    if (a <= 0) return at(o, d, t);
    for (let i = 0; i < 20000 && t < t1; i++) {
      const tn = Math.min(t1, t + Math.max(minDt, a / rate));
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
    return t1 < outer[1] ? at(o, d, t1) : null;
  }
}

function at(o: Vec3, d: Vec3, t: number): Vec3 {
  return { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
}
