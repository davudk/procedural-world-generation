import type { Layer, RiverGraph } from '../../../shared/protocol';
import { BIOME } from '../../../shared/biomes';
import { compileProgram } from '../../gl/util';
import { NOISE_GLSL, type DetailSource } from '../../glsl/detail';
import { prepareWater } from '../../heightField';
import {
  DN, bicubicQ, bilinearQ, carveProfile, detailParams, fbm, smoothstep, waterBounds,
  type DetailParams, type HeightSources,
} from '../../height/heightFn';

/**
 * Close-zoom detail elevation map (M5; research 01 §4, 02 §4.4, 04 §2, §8.4).
 *
 * GPU path (needs EXT_color_buffer_float), all fragment passes in the render context:
 *   1. CPU: prepared water levels, macro slope/relief, control texture, river segments.
 *   2. cap   = min(water upper bound, river channel + valley profiles)   (depth-test MIN, no float blending)
 *   3. base  = bicubic(macro) + slope/biome-conditioned damped fBm, then Dirichlet clamp
 *   4. thermal (talus) erosion, pipe-model hydraulic erosion in 1024² tiles, thermal again
 *   5. low-frequency re-anchoring to the macro (±anchorMetres), Dirichlet clamp
 *   6. optional async readback (PBO + fence) for CPU picking (HeightFn)
 * "Dirichlet clamp" = h ← min(max(h, lo), cap): macro water stays ≤ level − 0.5 m, macro land
 * stays ≥ level + 0.5 m near water, river channels/valleys stay carved (min() of profiles whose bed
 * is non-increasing downstream, so water never climbs).
 * Without the extension the map is built on the CPU at 2048² (bicubic + noise + carve + thermal).
 *
 * Drive it: `map.build(input)` once per generation, then `map.step(4)` every frame until it returns
 * true (or `map.finishSync()` in tests/tools). `ready` flips when the texture can be used;
 * `cpuReady` when `cpuHeights` (for HeightFn) has arrived. See docs/research/06-m5-detail-integration.md.
 */

export interface DetailInput {
  elevation: Layer;
  waterLevel: Layer | null;
  waterClass: Layer | null;
  discharge: Layer | null;
  biome: Layer | null;
  rivers: RiverGraph | null;
  seed: number;
  size: 2048 | 4096;
}

export interface HydroParams {
  dt: number;
  /** Pipe constant A·g/l (grid units). */
  K: number;
  rain: number;
  Kc: number;
  Ks: number;
  Kd: number;
  Ke: number;
  amin: number;
  /** Depth limiter: capacity scales with min(1, d/dmax). */
  dmax: number;
  /** Max terrain change per step (texel units: metres / texel size). */
  maxStep: number;
}

export interface DetailOptions {
  /** Thermal iterations (split before/after hydraulic). */
  thermalSteps: number;
  /** Pipe-model iterations per tile (0 = off). Default: 40 at 2048², 24 at 4096². */
  hydraulicSteps: number | null;
  /** Low-frequency deviation allowed from the macro (m). */
  anchorMetres: number;
  /** Talus slope (tan of the repose angle) for thermal erosion. */
  talus: number;
  thermalRate: number;
  /** Read the result back for CPU picking. */
  readback: boolean;
  hydro: HydroParams;
  /** Estimated GPU throughput used by step() to slice work (Mtexel-passes per ms, ~1 for a simple pass). */
  gpuMtexPerMs: number;
}

export const DEFAULT_DETAIL_OPTIONS: DetailOptions = {
  thermalSteps: 24,
  hydraulicSteps: null,
  anchorMetres: 60,
  talus: 0.75,
  thermalRate: 0.5,
  readback: true,
  hydro: { dt: 0.05, K: 20, rain: 0.02, Kc: 0.2, Ks: 0.3, Kd: 0.1, Ke: 0.02, amin: 0.05, dmax: 0.004, maxStep: 0.002 },
  gpuMtexPerMs: 8,
};

/** Floats per river segment: ax, ay, bx, by (map m, y from north), zbA, zbB, zwA, zwB, width, floor half-width, wall slope, extent. */
export const SEG_FLOATS = 12;

/** Depth mapping for the MIN composite of carve heights. */
export const Z_LO = -12000;
export const Z_HI = 12000;

// ---- CPU preparation (pure; exported for tests) -------------------------------------------------

export interface PreparedDetail {
  size: number;
  n: number;
  macro: Float32Array;
  /** Prepared water levels (heightField.prepareWater) or null. */
  water: Float32Array | null;
  params: DetailParams;
  /** Macro slope (m/m) and 3×3 relief (m). */
  slope: Float32Array;
  relief: Float32Array;
  control: Uint8Array;
  controlN: number;
  segs: Float32Array;
  segCount: number;
}

/** Per-biome roughness multiplier and rock / dune weights of the control texture (shared with the globe tiles). */
export const ROUGH_MUL = new Float32Array(32).fill(1);
export const ROCK_B = new Float32Array(32);
const DUNE_B = new Float32Array(32);
ROUGH_MUL[BIOME.WATER] = 0.3;
ROUGH_MUL[BIOME.ICE] = 0.35;
ROUGH_MUL[BIOME.POLAR_DESERT] = 0.7;
ROUGH_MUL[BIOME.TUNDRA] = 0.8;
ROUGH_MUL[BIOME.HOT_DESERT] = 0.5;
ROUGH_MUL[BIOME.COLD_DESERT] = 0.7;
ROUGH_MUL[BIOME.BEACH] = 0.2;
ROUGH_MUL[BIOME.SALT_FLAT] = 0.05;
for (const b of [BIOME.MARSH, BIOME.BOG, BIOME.SALT_MARSH, BIOME.MANGROVE]) ROUGH_MUL[b] = 0.15;
ROUGH_MUL[BIOME.ROCK] = 1.25;
ROUGH_MUL[BIOME.NIVAL] = 1.25;
ROCK_B[BIOME.ROCK] = 1;
ROCK_B[BIOME.NIVAL] = 1;
DUNE_B[BIOME.HOT_DESERT] = 1;
DUNE_B[BIOME.COLD_DESERT] = 0.5;
DUNE_B[BIOME.BEACH] = 0.4;
DUNE_B[BIOME.XERIC_SHRUB] = 0.2;

const toF32 = (l: Layer): Float32Array => (l.data instanceof Float32Array ? l.data : Float32Array.from(l.data));

/** Macro slope (m/m, central differences) and 3×3 relief (m). */
export function macroSlope(h: Float32Array, n: number, cell: number): { slope: Float32Array; relief: Float32Array } {
  const slope = new Float32Array(n * n);
  const relief = new Float32Array(n * n);
  macroSlopeRows(h, n, cell, slope, relief, 0, n);
  return { slope, relief };
}

function macroSlopeRows(h: Float32Array, n: number, cell: number, slope: Float32Array, relief: Float32Array, ya: number, yb: number): void {
  for (let y = ya; y < yb; y++) {
    const yu = Math.max(0, y - 1);
    const yd = Math.min(n - 1, y + 1);
    for (let x = 0; x < n; x++) {
      const xl = Math.max(0, x - 1);
      const xr = Math.min(n - 1, x + 1);
      const gx = (h[y * n + xr] - h[y * n + xl]) / (Math.max(1, xr - xl) * cell);
      const gy = (h[yd * n + x] - h[yu * n + x]) / (Math.max(1, yd - yu) * cell);
      slope[y * n + x] = Math.hypot(gx, gy);
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = yu; j <= yd; j++) {
        for (let i = xl; i <= xr; i++) {
          const v = h[j * n + i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      relief[y * n + x] = hi - lo;
    }
  }
}

/** River graph → valley/channel segments (map metres), with floor width and wall slope from the macro slope. */
export function riverSegments(g: RiverGraph | null, slope: Float32Array, n: number, p: DetailParams): { segs: Float32Array; count: number } {
  if (!g || g.n === 0) return { segs: new Float32Array(0), count: 0 };
  const segs = new Float32Array(g.n * SEG_FLOATS);
  const tmp = new Float64Array(3);
  let k = 0;
  for (let i = 0; i < g.n; i++) {
    const j = g.down[i];
    if (j < 0 || j >= g.n) continue;
    const ax = g.x[i];
    const ay = g.y[i];
    const bx = g.x[j];
    const by = g.y[j];
    if (!Number.isFinite(ax + ay + bx + by)) continue;
    const w = Math.max(1, g.width[i]);
    const zwA = g.zWater[i];
    const zwB = Math.min(g.zWater[j], zwA);
    const zbA = Math.min(g.zBed[i], zwA);
    const zbB = Math.min(g.zBed[j], zbA, zwB);
    const mx = 0.5 * (ax + bx);
    const my = 0.5 * (ay + by);
    const s = bilinearQ(slope, n, (mx / p.size) * n - 0.5, (my / p.size) * n - 0.5, tmp)[0];
    // Floor ≥ 1.05 texels: the 2×2 texels around any centreline point then lie on the floor, so the
    // interpolated terrain under the ribbon stays at the water surface.
    const fp = Math.max(1.05 * p.texel, w * (6 + (1.5 - 6) * smoothstep(0.005, 0.08, s)));
    const sv = Math.min(0.8, Math.max(0.01, 1.2 * s));
    const ext = 0.5 * w + fp + 2 * p.macroCell;
    const o = k * SEG_FLOATS;
    segs[o] = ax;
    segs[o + 1] = ay;
    segs[o + 2] = bx;
    segs[o + 3] = by;
    segs[o + 4] = zbA;
    segs[o + 5] = zbB;
    segs[o + 6] = zwA;
    segs[o + 7] = zwB;
    segs[o + 8] = w;
    segs[o + 9] = fp;
    segs[o + 10] = sv;
    segs[o + 11] = ext;
    k++;
  }
  return { segs: segs.subarray(0, k * SEG_FLOATS), count: k };
}

/**
 * Control texture (RGBA8, row 0 = north): r roughness, g rock (ridged octaves), b water/channel
 * proximity (1 = no amplification), a dunes. Generator: yields after row chunks.
 */
export function* buildControl(
  inp: DetailInput, prep: Omit<PreparedDetail, 'control' | 'controlN'>, cn: number, cls: Float32Array | null, out: Uint8Array,
): Generator<number, void> {
  const { n, size, macro, water, slope, relief, params } = prep;
  const ct = size / cn;
  const N = cn * cn;
  const t = new Float64Array(3);
  // Water mask → chamfer distance (texels).
  const dist = new Float32Array(N);
  const bio = inp.biome ? inp.biome.data : null;
  const bn = inp.biome ? inp.biome.w : 1;
  const q = inp.discharge ? inp.discharge.data : null;
  const qn = inp.discharge ? inp.discharge.w : 1;
  for (let y = 0; y < cn; y++) {
    const my = (y + 0.5) * ct;
    for (let x = 0; x < cn; x++) {
      const mx = (x + 0.5) * ct;
      const qx = (mx / size) * n - 0.5;
      const qy = (my / size) * n - 0.5;
      const hb = bilinearQ(macro, n, qx, qy, t)[0];
      const wl = water ? bilinearQ(water, n, qx, qy, t)[0] : 0;
      let wet = wl > DN.DRY && hb < wl;
      if (!wet && cls) {
        const c = cls[Math.min(n - 1, Math.floor((my / size) * n)) * n + Math.min(n - 1, Math.floor((mx / size) * n))];
        wet = c === 4 || c === 5;
      }
      dist[y * cn + x] = wet ? 0 : 1e9;
    }
    if ((y & 31) === 31) yield 0;
  }
  yield* chamfer(dist, cn);
  const near = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    near[i] = 1 - smoothstep(150, 900, dist[i] * ct);
    if ((i & 0x7ffff) === 0x7ffff) yield 0;
  }
  // River channels and valley floors.
  for (let s = 0; s < prep.segCount; s++) {
    const o = s * SEG_FLOATS;
    const ax = prep.segs[o];
    const ay = prep.segs[o + 1];
    const bx = prep.segs[o + 2];
    const by = prep.segs[o + 3];
    const r0 = 0.5 * prep.segs[o + 8] + prep.segs[o + 9];
    const r1 = r0 + 2 * ct;
    const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - r1) / ct));
    const x1 = Math.min(cn - 1, Math.ceil((Math.max(ax, bx) + r1) / ct));
    const y0 = Math.max(0, Math.floor((Math.min(ay, by) - r1) / ct));
    const y1 = Math.min(cn - 1, Math.ceil((Math.max(ay, by) + r1) / ct));
    const dx = bx - ax;
    const dy = by - ay;
    const L2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) {
      const py = (y + 0.5) * ct;
      for (let x = x0; x <= x1; x++) {
        const px = (x + 0.5) * ct;
        const u = L2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
        const r = Math.hypot(px - ax - u * dx, py - ay - u * dy);
        if (r >= r1) continue;
        const v = 1 - smoothstep(r0, r1, r);
        if (v > near[y * cn + x]) near[y * cn + x] = v;
      }
    }
    if ((s & 2047) === 2047) yield 0;
  }
  for (let y = 0; y < cn; y++) {
    const my = (y + 0.5) * ct;
    for (let x = 0; x < cn; x++) {
      const mx = (x + 0.5) * ct;
      const qx = (mx / size) * n - 0.5;
      const qy = (my / size) * n - 0.5;
      const s = Math.max(0, bilinearQ(slope, n, qx, qy, t)[0]);
      const rl = Math.max(0, bilinearQ(relief, n, qx, qy, t)[0] * (params.macroCell >= 1000 ? 1000 / params.macroCell : 1));
      const b = bio ? bio[Math.min(bn - 1, Math.floor((my / size) * bn)) * bn + Math.min(bn - 1, Math.floor((mx / size) * bn))] & 31 : 6;
      let B = near[y * cn + x];
      if (q) {
        const lq = q[Math.min(qn - 1, Math.floor((my / size) * qn)) * qn + Math.min(qn - 1, Math.floor((mx / size) * qn))];
        B = Math.max(B, 0.5 * smoothstep(1.0, 2.5, lq));
      }
      const R = Math.min(1, Math.max(0.03, (0.65 * smoothstep(0.02, 0.35, s) + 0.45 * smoothstep(30, 900, rl)) * ROUGH_MUL[b]));
      const G = Math.max(ROCK_B[b], smoothstep(0.25, 0.6, s)) * (1 - B);
      const A = DUNE_B[b] * (1 - smoothstep(0.02, 0.08, s)) * (1 - 0.7 * B);
      const o = (y * cn + x) * 4;
      out[o] = Math.round(255 * R);
      out[o + 1] = Math.round(255 * G);
      out[o + 2] = Math.round(255 * Math.min(1, B));
      out[o + 3] = Math.round(255 * A);
    }
    if ((y & 31) === 31) yield 0;
  }
}

/** Two-pass chamfer distance transform in place (units: texels). Generator: yields after row chunks. */
function* chamfer(d: Float32Array, n: number): Generator<number, void> {
  const D1 = 1;
  const D2 = Math.SQRT2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + D1);
      if (y > 0) {
        v = Math.min(v, d[i - n] + D1);
        if (x > 0) v = Math.min(v, d[i - n - 1] + D2);
        if (x < n - 1) v = Math.min(v, d[i - n + 1] + D2);
      }
      d[i] = v;
    }
    if ((y & 255) === 255) yield 0;
  }
  for (let y = n - 1; y >= 0; y--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = y * n + x;
      let v = d[i];
      if (x < n - 1) v = Math.min(v, d[i + 1] + D1);
      if (y < n - 1) {
        v = Math.min(v, d[i + n] + D1);
        if (x < n - 1) v = Math.min(v, d[i + n + 1] + D2);
        if (x > 0) v = Math.min(v, d[i + n - 1] + D2);
      }
      d[i] = v;
    }
    if ((y & 255) === 0) yield 0;
  }
}

/** CPU preparation shared by both paths. Generator: yields after chunks; returns the result. */
export function* prepareDetail(inp: DetailInput, detailN: number): Generator<number, PreparedDetail> {
  const e = inp.elevation;
  const n = e.w;
  const size = e.worldKm * 1000;
  const macro = toF32(e);
  let water: Float32Array | null = null;
  let cls: Float32Array | null = null;
  if (inp.waterLevel && inp.waterLevel.w === n) {
    const p = prepareWater(e, inp.waterLevel, inp.waterClass && inp.waterClass.w === n ? inp.waterClass : null);
    water = p.level;
    cls = p.cls;
  }
  yield 0;
  const params = detailParams(size, detailN, n, inp.seed);
  const slope = new Float32Array(n * n);
  const relief = new Float32Array(n * n);
  for (let y0 = 0; y0 < n; y0 += 128) {
    macroSlopeRows(macro, n, size / n, slope, relief, y0, Math.min(n, y0 + 128));
    yield 0;
  }
  const { segs, count } = riverSegments(inp.rivers, slope, n, params);
  yield 0;
  const controlN = Math.min(2048, detailN, Math.max(256, 2 * n));
  const control = new Uint8Array(controlN * controlN * 4);
  const base = { size, n, macro, water, params, slope, relief, segs, segCount: count };
  yield* buildControl(inp, base, controlN, cls, control);
  return { ...base, control, controlN };
}

/** Bake amplitude (m) from control values. */
function bakeAmp(rough: number, near: number, p: DetailParams): number {
  return (DN.BAKE_BASE + DN.BAKE_ROUGH * rough) * p.bakeAmpScale * (1 - near);
}

/**
 * CPU detail build (fallback; also the reference for the GPU passes): bicubic macro + baked noise,
 * Dirichlet water bounds, river carve, a few thermal iterations. Generator: yields after chunks.
 */
export function* buildDetailCpu(prep: PreparedDetail, thermalSteps: number, opts: Pick<DetailOptions, 'talus' | 'thermalRate'>): Generator<number, Float32Array> {
  const p = prep.params;
  const D = p.detailN;
  const { n, size, macro, water } = prep;
  const tx = p.texel;
  const h = new Float32Array(D * D);
  const lo = new Float32Array(D * D);
  const cap = new Float32Array(D * D);
  const b5 = new Float64Array(5);
  const t3 = new Float64Array(3);
  const acc = new Float64Array(3);
  const ctl = new Float64Array(4);
  const cn = prep.controlN;
  const kq = n / size;
  for (let y = 0; y < D; y++) {
    const my = (y + 0.5) * tx;
    const wy = size - my;
    for (let x = 0; x < D; x++) {
      const mx = (x + 0.5) * tx;
      const qx = mx * kq - 0.5;
      const qy = my * kq - 0.5;
      bicubicQ(macro, n, qx, qy, b5);
      const hb = bilinearQ(macro, n, qx, qy, t3)[0];
      const wl = water ? bilinearQ(water, n, qx, qy, t3)[0] : 0;
      const [l, hi] = waterBounds(hb, wl);
      controlAt(prep.control, cn, mx / size, my / size, ctl);
      acc[0] = acc[1] = acc[2] = 0;
      if (p.bakeOct > 0) fbm(mx, wy, tx, p.bakeLam0, p.bakeOct, bakeAmp(ctl[0], ctl[2], p), ctl[1], b5[1] * kq, -b5[2] * kq, (p.seed ^ DN.SEED_BAKE) >>> 0, acc);
      const i = y * D + x;
      h[i] = b5[0] + acc[0];
      lo[i] = l;
      cap[i] = hi;
    }
    if ((y & 15) === 15) yield 0;
  }
  // River carve (min of profiles) into cap.
  for (let s = 0; s < prep.segCount; s++) {
    carveSegmentCpu(prep, s, lo, cap);
    if ((s & 1023) === 1023) yield 0;
  }
  for (let i = 0; i < D * D; i++) h[i] = Math.min(Math.max(h[i], lo[i]), cap[i]);
  yield 0;
  let src = h;
  let dst = new Float32Array(D * D);
  for (let it = 0; it < thermalSteps; it++) {
    for (let y = 0; y < D; y++) {
      thermalRowCpu(src, dst, lo, cap, D, y, opts.talus * tx, opts.thermalRate);
      if ((y & 255) === 255) yield 0;
    }
    [src, dst] = [dst, src];
  }
  return src;
}

/** One thermal row: symmetric (mass-conserving) talus exchange with 8 neighbours, then Dirichlet. */
export function thermalRowCpu(src: Float32Array, dst: Float32Array, lo: Float32Array, cap: Float32Array, D: number, y: number, talus: number, rate: number): void {
  for (let x = 0; x < D; x++) {
    const i = y * D + x;
    const h = src[i];
    let acc = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = Math.min(D - 1, Math.max(0, y + dy));
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = Math.min(D - 1, Math.max(0, x + dx));
        const d = src[ny * D + nx] - h;
        const T = talus * (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
        const ex = Math.abs(d) - T;
        if (ex > 0) acc += d > 0 ? ex : -ex;
      }
    }
    dst[i] = Math.min(Math.max(h + rate * 0.125 * acc, lo[i]), cap[i]);
  }
}

/** Rasterises segment s's carve profile into `cap` (min), as the GPU carve pass. */
export function carveSegmentCpu(prep: Pick<PreparedDetail, 'params' | 'segs'>, s: number, lo: Float32Array, cap: Float32Array): void {
  const p = prep.params;
  const D = p.detailN;
  const tx = p.texel;
  const g = prep.segs;
  const o = s * SEG_FLOATS;
  const ax = g[o];
  const ay = g[o + 1];
  const bx = g[o + 2];
  const by = g[o + 3];
  const ext = g[o + 11];
  const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - ext) / tx));
  const x1 = Math.min(D - 1, Math.ceil((Math.max(ax, bx) + ext) / tx));
  const y0 = Math.max(0, Math.floor((Math.min(ay, by) - ext) / tx));
  const y1 = Math.min(D - 1, Math.ceil((Math.max(ay, by) + ext) / tx));
  const dx = bx - ax;
  const dy = by - ay;
  const L2 = dx * dx + dy * dy;
  for (let y = y0; y <= y1; y++) {
    const py = (y + 0.5) * tx;
    for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) * tx;
      const t = L2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const r = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (r >= ext) continue;
      const zb = g[o + 4] + (g[o + 5] - g[o + 4]) * t;
      const zw = g[o + 6] + (g[o + 7] - g[o + 6]) * t;
      const i = y * D + x;
      const z = carveProfile(r, zb, zw, g[o + 8], g[o + 9], g[o + 10], ext, lo[i], p.macroCell);
      if (z < cap[i]) cap[i] = z;
    }
  }
}

/** GL LINEAR lookup of an RGBA8 raster at uv (row 0 = v 0), channels 0–1. */
function controlAt(c: Uint8Array, n: number, u: number, v: number, out: Float64Array): void {
  const qx = u * n - 0.5;
  const qy = v * n - 0.5;
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const fx = qx - ix;
  const fy = qy - iy;
  const x0 = Math.min(n - 1, Math.max(0, ix));
  const x1 = Math.min(n - 1, Math.max(0, ix + 1));
  const y0 = Math.min(n - 1, Math.max(0, iy));
  const y1 = Math.min(n - 1, Math.max(0, iy + 1));
  for (let k = 0; k < 4; k++) {
    const a = c[(y0 * n + x0) * 4 + k];
    const b = c[(y0 * n + x1) * 4 + k];
    const d = c[(y1 * n + x0) * 4 + k];
    const e = c[(y1 * n + x1) * 4 + k];
    const ab = a + (b - a) * fx;
    out[k] = (ab + (d + (e - d) * fx - ab) * fy) / 255;
  }
}

// ---- GLSL for the build passes ------------------------------------------------------------------

const HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${NOISE_GLSL}
uniform sampler2D u_macro;   // R32F macro elevation (n²), row 0 = north
uniform sampler2D u_wl;      // R32F prepared water level, < -9000 dry
uniform int u_hasWater;
uniform int u_n;
uniform float u_size;
uniform int u_D;
float bTexel() { return u_size / float(u_D); }
float bCell() { return u_size / float(u_n); }
vec2 bMacroQ(vec2 pm) { return pm / u_size * float(u_n) - 0.5; }
// Water bounds (lo, hi) at map point pm (m, y from north); mirrors heightFn.waterBounds.
vec2 bBounds(vec2 pm) {
  vec2 q = bMacroQ(pm);
  float hb = dnBilinear(u_macro, u_n, q).x;
  float wl = u_hasWater == 1 ? dnBilinear(u_wl, u_n, q).x : 0.0;
  if (wl > DN_DRY) return hb < wl ? vec2(-1e30, wl - 0.5) : vec2(wl + 0.5, 1e30);
  return vec2(hb >= 0.5 ? 0.5 : -1e30, 1e30);
}
float bDepth(float z) { return clamp((z - (${Z_LO}.0)) / (${Z_HI - Z_LO}.0), 0.0, 1.0); }
`;

export const QUAD_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.5, 1.0);
}`;

const CAP_FS = (head: string): string => `${head}
out float o;
void main() {
  vec2 b = bBounds(gl_FragCoord.xy * bTexel());
  if (b.y > 1e29) discard;
  o = b.y;
  gl_FragDepth = bDepth(b.y);
}`;

const CARVE_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 a_seg;
layout(location = 1) in vec4 a_z;
layout(location = 2) in vec4 a_w;
uniform float u_size;
flat out vec4 v_seg;
flat out vec4 v_z;
flat out vec4 v_w;
void main() {
  vec2 a = a_seg.xy, b = a_seg.zw, d = b - a;
  float L = length(d);
  vec2 t = L > 1e-3 ? d / L : vec2(1.0, 0.0);
  vec2 nr = vec2(-t.y, t.x);
  float E = a_w.w;
  int id = gl_VertexID;
  vec2 p = ((id & 1) == 0 ? a - t * E : b + t * E) + nr * ((id & 2) == 0 ? -E : E);
  v_seg = a_seg;
  v_z = a_z;
  v_w = a_w;
  gl_Position = vec4(p / u_size * 2.0 - 1.0, 0.5, 1.0);
}`;

// Mirrors heightFn.carveProfile.
const CARVE_FS = (head: string): string => `${head}
flat in vec4 v_seg;
flat in vec4 v_z;
flat in vec4 v_w;
out float o;
float dnCarve(float r, float zb, float zw, float w, float fp, float sv, float ext, float lo, float cell) {
  float half_ = 0.5 * w;
  float z;
  if (r < half_) { float u = r / half_; z = zb + (zw - zb) * u * u; }
  else { float x = r - half_; z = max(zw + 0.002 * min(x, fp) + sv * max(0.0, x - fp), lo); }
  float rampW = min(cell, 0.4 * ext);
  float e0 = ext - rampW;
  if (r > e0) { float t = (r - e0) / rampW; z += 2000.0 * t * t; }
  return z;
}
void main() {
  vec2 p = gl_FragCoord.xy * bTexel();
  vec2 a = v_seg.xy, ab = v_seg.zw - v_seg.xy;
  float L2 = dot(ab, ab);
  float t = L2 > 0.0 ? clamp(dot(p - a, ab) / L2, 0.0, 1.0) : 0.0;
  float r = length(p - a - t * ab);
  float ext = v_w.w;
  if (r >= ext) discard;
  float zb = mix(v_z.x, v_z.y, t), zw = mix(v_z.z, v_z.w, t);
  float z = dnCarve(r, zb, zw, v_w.x, v_w.y, v_w.z, ext, bBounds(p).x, bCell());
  o = z;
  gl_FragDepth = bDepth(z);
}`;

const BASE_FS = (head: string): string => `${head}
uniform sampler2D u_cap;
uniform sampler2D u_ctl;
uniform uint u_seed;
uniform float u_bakeLam0;
uniform int u_bakeOct;
uniform float u_bakeAmpScale;
out float o;
void main() {
  vec2 pm = gl_FragCoord.xy * bTexel();
  vec2 mm;
  vec3 m = dnBicubic(u_macro, u_n, bMacroQ(pm), mm);
  float k = float(u_n) / u_size;
  vec4 c = textureLod(u_ctl, pm / u_size, 0.0);
  float amp = (DN_BAKE_BASE + DN_BAKE_ROUGH * c.r) * u_bakeAmpScale * (1.0 - c.b);
  vec3 nz = u_bakeOct > 0 ? dnFbm(vec2(pm.x, u_size - pm.y), bTexel(), u_bakeLam0, u_bakeOct, amp, c.g, vec2(m.y * k, -m.z * k), u_seed ^ DN_SEED_BAKE) : vec3(0.0);
  vec2 b = bBounds(pm);
  o = min(max(m.x + nz.x, b.x), texelFetch(u_cap, ivec2(gl_FragCoord.xy), 0).r);
}`;

const THERMAL_FS = (head: string): string => `${head}
uniform sampler2D u_h;
uniform sampler2D u_cap;
uniform float u_talus;
uniform float u_rate;
out float o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float h = dnFetch(u_h, u_D, c);
  float acc = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      float d = dnFetch(u_h, u_D, c + ivec2(dx, dy)) - h;
      float T = u_talus * ((dx != 0 && dy != 0) ? 1.41421356 : 1.0);
      acc += sign(d) * max(0.0, abs(d) - T);
    }
  }
  vec2 b = bBounds(gl_FragCoord.xy * bTexel());
  o = min(max(h + u_rate * 0.125 * acc, b.x), texelFetch(u_cap, c, 0).r);
}`;

const COPY_FS = (head: string): string => `${head}
uniform sampler2D u_h;
out float o;
void main() { o = texelFetch(u_h, ivec2(gl_FragCoord.xy), 0).r; }`;

const TILE_HEAD = (head: string): string => `${head}
uniform sampler2D u_A;   // RGBA32F: terrain b (texel units), water d, sediment s
uniform sampler2D u_F;   // RGBA32F: outflow L, R, T (row-1, north), B (row+1)
uniform int u_T;
uniform ivec2 u_org;
uniform float u_dt;
uniform float u_K;
uniform float u_rain;
vec4 tA(ivec2 c) { return texelFetch(u_A, clamp(c, ivec2(0), ivec2(u_T - 1)), 0); }
vec4 tF(ivec2 c) { return texelFetch(u_F, clamp(c, ivec2(0), ivec2(u_T - 1)), 0); }
`;

const HINIT_FS = (head: string): string => `${head}
uniform sampler2D u_h;
uniform ivec2 u_org;
out vec4 o;
void main() { o = vec4(dnFetch(u_h, u_D, ivec2(gl_FragCoord.xy) + u_org) / bTexel(), 0.0, 0.0, 0.0); }`;

const HFLUX_FS = (head: string): string => `${TILE_HEAD(head)}
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = tA(c);
  float r = u_dt * u_rain;
  float dr = s.y + r;
  float H = s.x + dr;
  vec4 sl = tA(c - ivec2(1, 0)), sr = tA(c + ivec2(1, 0)), st = tA(c - ivec2(0, 1)), sb = tA(c + ivec2(0, 1));
  vec4 hn = vec4(
    c.x > 0 ? sl.x + sl.y + r : H,
    c.x < u_T - 1 ? sr.x + sr.y + r : H,
    c.y > 0 ? st.x + st.y + r : H,
    c.y < u_T - 1 ? sb.x + sb.y + r : H);
  vec4 nf = max(vec4(0.0), tF(c) + u_dt * u_K * (H - hn));
  float sum = nf.x + nf.y + nf.z + nf.w;
  o = sum > 0.0 ? nf * min(1.0, dr / (sum * u_dt)) : vec4(0.0);
}`;

const HWATER_FS = (head: string): string => `${TILE_HEAD(head)}
uniform float u_Kc;
uniform float u_Ks;
uniform float u_Kd;
uniform float u_amin;
uniform float u_dmax;
uniform float u_maxStep;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oV;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = tA(c);
  float dr = s.y + u_dt * u_rain;
  vec4 f = tF(c);
  float inL = c.x > 0 ? tF(c - ivec2(1, 0)).y : 0.0;
  float inR = c.x < u_T - 1 ? tF(c + ivec2(1, 0)).x : 0.0;
  float inT = c.y > 0 ? tF(c - ivec2(0, 1)).w : 0.0;
  float inB = c.y < u_T - 1 ? tF(c + ivec2(0, 1)).z : 0.0;
  float d2 = max(0.0, dr + u_dt * (inL + inR + inT + inB - (f.x + f.y + f.z + f.w)));
  float db = max(0.5 * (dr + d2), 1e-6);
  vec2 v = 0.5 * vec2(inL - f.x + f.y - inR, inT - f.z + f.w - inB) / db;
  float g = 0.5 * length(vec2(tA(c + ivec2(1, 0)).x - tA(c - ivec2(1, 0)).x, tA(c + ivec2(0, 1)).x - tA(c - ivec2(0, 1)).x));
  float sinA = g / sqrt(1.0 + g * g);
  float C = u_Kc * max(sinA, u_amin) * length(v) * clamp(d2 / u_dmax, 0.0, 1.0);
  float b = s.x, sed = s.z;
  if (C > sed) { float e = min(u_Ks * (C - sed) * u_dt, u_maxStep); b -= e; sed += e; }
  else { float e = min(u_Kd * (sed - C) * u_dt, u_maxStep); b += e; sed -= e; }
  oA = vec4(b, d2, sed, 0.0);
  oV = vec4(v, 0.0, 0.0);
}`;

const HADVECT_FS = (head: string): string => `${TILE_HEAD(head)}
uniform sampler2D u_V;
uniform sampler2D u_h;
uniform sampler2D u_cap;
uniform float u_Ke;
out vec4 o;
float sedAt(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = p - vec2(i);
  return mix(mix(tA(i).z, tA(i + ivec2(1, 0)).z, f.x), mix(tA(i + ivec2(0, 1)).z, tA(i + ivec2(1, 1)).z, f.x), f.y);
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = tA(c);
  vec2 v = texelFetch(u_V, c, 0).xy;
  float vl = length(v) * u_dt;
  if (vl > 0.9) v *= 0.9 / vl;
  float sed = sedAt(vec2(c) - v * u_dt);
  float d = s.y * (1.0 - u_Ke * u_dt);
  ivec2 g = c + u_org;
  float cell = bTexel();
  float b = s.x * cell;
  if (isnan(b) || isinf(b) || abs(b) > 1e5 || isnan(sed) || isnan(d) || isinf(d)) { b = dnFetch(u_h, u_D, g); sed = 0.0; d = 0.0; }
  vec2 bd = bBounds((vec2(g) + 0.5) * cell);
  b = min(max(b, bd.x), dnFetch(u_cap, u_D, g));
  if (bd.y < 1e29) { d = 0.0; sed = 0.0; }
  o = vec4(b / cell, d, max(sed, 0.0), 0.0);
}`;

const HWRITE_FS = (head: string): string => `${head}
uniform sampler2D u_A;
uniform ivec2 u_org;
out float o;
void main() { o = texelFetch(u_A, ivec2(gl_FragCoord.xy) - u_org, 0).x * bTexel(); }`;

const ADOWN_FS = (head: string): string => `${head}
uniform sampler2D u_h;
out float o;
void main() {
  ivec2 cell = ivec2(gl_FragCoord.xy);
  int k = max(1, u_D / u_n);
  int st = max(1, k / 4);
  float sum = 0.0, cnt = 0.0;
  for (int j = 0; j < 4; j++) {
    if (j * st >= k) break;
    for (int i = 0; i < 4; i++) {
      if (i * st >= k) break;
      ivec2 t = cell * k + ivec2(i, j) * st + st / 2;
      vec2 mm;
      float up = dnBicubic(u_macro, u_n, bMacroQ((vec2(t) + 0.5) * bTexel()), mm).x;
      sum += dnFetch(u_h, u_D, t) - up;
      cnt += 1.0;
    }
  }
  o = sum / cnt;
}`;

const ABLUR_FS = (head: string): string => `${head}
uniform sampler2D u_src;
uniform ivec2 u_dir;
out float o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float s = 0.0, w = 0.0;
  for (int i = -6; i <= 6; i++) {
    float k = exp(-float(i * i) / 8.0);
    s += k * dnFetch(u_src, u_n, c + u_dir * i);
    w += k;
  }
  o = s / w;
}`;

const AFINAL_FS = (head: string): string => `${head}
uniform sampler2D u_h;
uniform sampler2D u_low;
uniform sampler2D u_cap;
uniform float u_a;
out float o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 pm = gl_FragCoord.xy * bTexel();
  float low = dnBilinear(u_low, u_n, bMacroQ(pm)).x;
  float h = dnFetch(u_h, u_D, c) - low + clamp(low, -u_a, u_a);
  vec2 b = bBounds(pm);
  o = min(max(h, b.x), texelFetch(u_cap, c, 0).r);
}`;

const PACK_FS = (head: string): string => `${head}
uniform sampler2D u_h;
out vec4 o;
void main() {
  ivec2 b = ivec2(int(gl_FragCoord.x) * 4, int(gl_FragCoord.y));
  o = vec4(texelFetch(u_h, b, 0).r, texelFetch(u_h, b + ivec2(1, 0), 0).r, texelFetch(u_h, b + ivec2(2, 0), 0).r, texelFetch(u_h, b + ivec2(3, 0), 0).r);
}`;

export type ProgName = 'cap' | 'carve' | 'base' | 'thermal' | 'copy' | 'hinit' | 'hflux' | 'hwater' | 'hadvect' | 'hwrite' | 'adown' | 'ablur' | 'afinal' | 'pack';

/**
 * The build programs over a given HEAD (which defines bTexel, bCell, bMacroQ, bBounds, bDepth and the
 * shared macro uniforms). The flat map uses HEAD; the globe's detail tiles (globe/detailTiles.ts)
 * reuse every pass with their own head (tile-local raster, coastal band).
 */
export function detailBuildSources(head: string): Record<ProgName, [string, string]> {
  return {
    cap: [QUAD_VS, CAP_FS(head)],
    carve: [CARVE_VS, CARVE_FS(head)],
    base: [QUAD_VS, BASE_FS(head)],
    thermal: [QUAD_VS, THERMAL_FS(head)],
    copy: [QUAD_VS, COPY_FS(head)],
    hinit: [QUAD_VS, HINIT_FS(head)],
    hflux: [QUAD_VS, HFLUX_FS(head)],
    hwater: [QUAD_VS, HWATER_FS(head)],
    hadvect: [QUAD_VS, HADVECT_FS(head)],
    hwrite: [QUAD_VS, HWRITE_FS(head)],
    adown: [QUAD_VS, ADOWN_FS(head)],
    ablur: [QUAD_VS, ABLUR_FS(head)],
    afinal: [QUAD_VS, AFINAL_FS(head)],
    pack: [QUAD_VS, PACK_FS(head)],
  };
}

const SOURCES: Record<ProgName, [string, string]> = detailBuildSources(HEAD);

/** Exposed for tests/tools: the build shaders' sources. */
export const DETAIL_BUILD_SOURCES: Readonly<Record<string, readonly [string, string]>> = SOURCES;

/** Yielded by a pipeline to end the current step (waiting on the GPU). */
const WAIT = -1;

const TILE = 1024;
const OVERLAP = 48;

/** Timings (ms) of the last build's CPU stages, and the GPU work estimate. */
export interface DetailStats {
  path: 'gpu' | 'cpu' | 'none';
  prepMs: number;
  cpuBuildMs: number;
  passes: number;
  gpuEstMs: number;
  readbackMs: number;
  totalMs: number;
  segments: number;
}

/**
 * Detail elevation map: R32F texture (metres, raw elevation like the macro, row 0 = north) plus an
 * RGBA8 control texture. See the file comment for the build and how to drive it.
 */
export class DetailMap implements DetailSource {
  texture: WebGLTexture | null = null;
  readonly control: WebGLTexture;
  size = 0;
  ready = false;
  /** CPU copy of `texture` (size², row 0 = north) once read back; null before. */
  cpuHeights: Float32Array | null = null;
  params: DetailParams | null = null;
  controlData: Uint8Array | null = null;
  controlSize = 0;
  /** 0–1 while building. */
  progress = 0;
  readonly gpu: boolean;
  readonly opts: DetailOptions;
  stats: DetailStats = { path: 'none', prepMs: 0, cpuBuildMs: 0, passes: 0, gpuEstMs: 0, readbackMs: 0, totalMs: 0, segments: 0 };
  /** Increments when `texture`, `ready` or `cpuHeights` change (rebuild HeightFn / DetailGround then). */
  version = 0;

  private job: Generator<number, void> | null = null;
  private fence: WebGLSync | null = null;
  private progs: Partial<Record<ProgName, WebGLProgram>> = {};
  private locs = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private readonly fbo: WebGLFramebuffer;
  private readonly vao: WebGLVertexArrayObject;
  private temps = new Set<WebGLTexture | WebGLRenderbuffer | WebGLBuffer | WebGLVertexArrayObject>();
  private macroWater: { macro: Float32Array; water: Float32Array | null; n: number; worldSize: number } | null = null;
  private passesTotal = 1;
  private passesDone = 0;
  private t0 = 0;
  private syncMode = false;
  private unitsUsed = 0;

  constructor(private readonly gl: WebGL2RenderingContext, opts: Partial<DetailOptions> = {}) {
    this.opts = { ...DEFAULT_DETAIL_OPTIONS, ...opts, hydro: { ...DEFAULT_DETAIL_OPTIONS.hydro, ...(opts.hydro ?? {}) } };
    this.gpu = gl.getExtension('EXT_color_buffer_float') !== null && this.probe();
    this.fbo = gl.createFramebuffer();
    this.vao = gl.createVertexArray();
    this.control = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.control);
    setParams(gl, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }

  /** Max |detail − macro| the shader can show (m, unexaggerated): pad CDLOD bounds by this × exaggeration. */
  get boundsPad(): number {
    const p = this.params;
    if (!p) return 0;
    const bake = (DN.BAKE_BASE + DN.BAKE_ROUGH) * p.bakeAmpScale;
    const shader = (DN.AMP_BASE + DN.AMP_ROUGH) * p.ampScale + DN.DUNE_AMP * DN.DUNE_MAX;
    return Math.ceil(this.opts.anchorMetres + bake + shader + 50);
  }

  /** True once `cpuHeights` is available. */
  get cpuReady(): boolean {
    return this.cpuHeights !== null;
  }

  /** True while a build is in progress. */
  get building(): boolean {
    return this.job !== null;
  }

  /**
   * Inputs for HeightFn (CPU picking). Before the readback arrives `detail` is null and HeightFn
   * stands in with the macro bicubic. Null until the first build has prepared its inputs.
   */
  heightSources(): HeightSources | null {
    const m = this.macroWater;
    if (!m) return null;
    return {
      size: m.worldSize,
      macro: m.macro,
      macroN: m.n,
      water: m.water,
      params: this.ready ? this.params : null,
      detail: this.ready ? this.cpuHeights : null,
      control: this.controlData,
      controlN: this.controlSize,
    };
  }

  /** Starts (or restarts) a build. The previous texture stays unusable (ready = false) until done. */
  build(input: DetailInput): void {
    this.cancel();
    this.releaseResult();
    const gl = this.gl;
    const maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number);
    const D = this.gpu ? (input.size === 4096 && maxTex >= 4096 ? 4096 : 2048) : 2048;
    this.t0 = performance.now();
    this.stats = { path: this.gpu ? 'gpu' : 'cpu', prepMs: 0, cpuBuildMs: 0, passes: 0, gpuEstMs: 0, readbackMs: 0, totalMs: 0, segments: 0 };
    this.progress = 0;
    this.job = this.gpu ? this.gpuPipeline(input, D) : this.cpuPipeline(input, D);
  }

  /**
   * Advances the build by about `budgetMs` of CPU time plus estimated GPU work; returns true when the
   * build (including the CPU readback) is complete. Call once per frame, before drawing. Never stalls
   * on the GPU: if the previous slice's GPU work is unfinished it returns immediately.
   */
  step(budgetMs = 4): boolean {
    const job = this.job;
    if (!job) return true;
    const gl = this.gl;
    if (this.fence) {
      const st = gl.clientWaitSync(this.fence, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED) return false;
      gl.deleteSync(this.fence);
      this.fence = null;
    }
    let spent = 0;
    let gpuWork = false;
    let done = false;
    this.withState(() => {
      while (spent < budgetMs) {
        const t = performance.now();
        const r = job.next();
        spent += performance.now() - t;
        if (r.done) {
          done = true;
          break;
        }
        if (r.value === WAIT) break;
        if (r.value > 0) {
          gpuWork = true;
          spent += r.value;
        }
      }
    });
    if (gpuWork && !done) this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (done) this.finishJob();
    return done;
  }

  /** Runs the whole build now (blocking; sync readPixels for the readback). For tests and tools. */
  finishSync(): void {
    const job = this.job;
    if (!job) return;
    this.syncMode = true;
    try {
      this.withState(() => {
        for (;;) if (job.next().done) break;
      });
    } finally {
      this.syncMode = false;
    }
    if (this.fence) {
      this.gl.deleteSync(this.fence);
      this.fence = null;
    }
    this.finishJob();
  }

  dispose(): void {
    this.cancel();
    this.releaseResult();
    const gl = this.gl;
    for (const p of Object.values(this.progs)) if (p) gl.deleteProgram(p);
    this.progs = {};
    gl.deleteFramebuffer(this.fbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.control);
  }

  // ---- internals --------------------------------------------------------------------------------

  private finishJob(): void {
    this.job = null;
    this.progress = 1;
    this.stats.totalMs = performance.now() - this.t0;
    this.version++;
  }

  private cancel(): void {
    if (this.job) this.job.return(undefined);
    this.job = null;
    if (this.fence) this.gl.deleteSync(this.fence);
    this.fence = null;
    this.freeTemps();
  }

  private releaseResult(): void {
    if (this.texture) this.gl.deleteTexture(this.texture);
    this.texture = null;
    this.ready = false;
    this.cpuHeights = null;
    this.version++;
  }

  private freeTemps(): void {
    const gl = this.gl;
    for (const o of this.temps) {
      if (o instanceof WebGLTexture) gl.deleteTexture(o);
      else if (o instanceof WebGLRenderbuffer) gl.deleteRenderbuffer(o);
      else if (o instanceof WebGLBuffer) gl.deleteBuffer(o);
      else gl.deleteVertexArray(o);
    }
    this.temps.clear();
  }

  private free(o: WebGLTexture | WebGLRenderbuffer | WebGLBuffer | null): void {
    if (!o) return;
    const gl = this.gl;
    this.temps.delete(o);
    if (o instanceof WebGLTexture) gl.deleteTexture(o);
    else if (o instanceof WebGLRenderbuffer) gl.deleteRenderbuffer(o);
    else gl.deleteBuffer(o);
  }

  /** Can we render to R32F / RG32F / RGBA32F with a 32F depth buffer? */
  private probe(): boolean {
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    let ok = true;
    const texs: WebGLTexture[] = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    for (const [fmt, base] of [[gl.R32F, gl.RED], [gl.RG32F, gl.RG], [gl.RGBA32F, gl.RGBA]] as const) {
      const t = gl.createTexture();
      texs.push(t);
      gl.bindTexture(gl.TEXTURE_2D, t);
      setParams(gl, gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt, 4, 4, 0, base, gl.FLOAT, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) ok = false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
    gl.deleteFramebuffer(fb);
    for (const t of texs) gl.deleteTexture(t);
    return ok;
  }

  private withState(fn: () => void): void {
    const gl = this.gl;
    const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const vp = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const prog = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const abuf = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const caps = [gl.DEPTH_TEST, gl.BLEND, gl.SCISSOR_TEST, gl.CULL_FACE].map((c) => [c, gl.isEnabled(c)] as const);
    const depthMask = gl.getParameter(gl.DEPTH_WRITEMASK) as boolean;
    const depthFunc = gl.getParameter(gl.DEPTH_FUNC) as number;
    for (const [c] of caps) gl.disable(c);
    try {
      fn();
    } finally {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
      gl.useProgram(prog);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, abuf);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      for (const [c, on] of caps) if (on) gl.enable(c);
      else gl.disable(c);
      gl.depthMask(depthMask);
      gl.depthFunc(depthFunc);
      gl.activeTexture(gl.TEXTURE0);
    }
  }

  private prog(name: ProgName): WebGLProgram {
    let p = this.progs[name];
    if (!p) {
      const [vs, fs] = SOURCES[name];
      p = compileProgram(this.gl, `detail-${name}`, vs, fs);
      this.progs[name] = p;
    }
    return p;
  }

  private loc(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.locs.get(p);
    if (!m) {
      m = new Map();
      this.locs.set(p, m);
    }
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name) ?? null;
  }

  private tex(internal: number, format: number, w: number, h: number, data: ArrayBufferView | null = null, type?: number): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    setParams(gl, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type ?? gl.FLOAT, data);
    this.temps.add(t);
    return t;
  }

  /** Binds the program, the shared macro uniforms and the given textures (unit order). */
  private use(name: ProgName, ctx: GpuCtx, textures: Record<string, WebGLTexture>): WebGLProgram {
    const gl = this.gl;
    const p = this.prog(name);
    gl.useProgram(p);
    gl.uniform1i(this.loc(p, 'u_hasWater'), ctx.water ? 1 : 0);
    gl.uniform1i(this.loc(p, 'u_n'), ctx.n);
    gl.uniform1f(this.loc(p, 'u_size'), ctx.size);
    gl.uniform1i(this.loc(p, 'u_D'), ctx.D);
    const all: Record<string, WebGLTexture> = { u_macro: ctx.macroTex, u_wl: ctx.wlTex, ...textures };
    let unit = 0;
    for (const [k, t] of Object.entries(all)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(this.loc(p, k), unit);
      unit++;
    }
    // Unbind stale units so no render target stays bound for sampling (feedback-loop safety).
    for (let u = unit; u < this.unitsUsed; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    this.unitsUsed = unit;
    return p;
  }

  /** Points the FBO at the given colour targets (and optional depth), sets the viewport. */
  private target(color: WebGLTexture[], w: number, h: number, depth: WebGLRenderbuffer | null = null, vp?: [number, number, number, number]): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    for (let i = 0; i < 2; i++) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, color[i] ?? null, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.drawBuffers(color.length === 2 ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0]);
    if (vp) gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    else gl.viewport(0, 0, w, h);
  }

  private quad(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.passesDone++;
    this.stats.passes++;
    this.progress = Math.min(0.99, this.passesDone / this.passesTotal);
  }

  /** Estimated GPU ms for a pass over `texels` with relative cost `weight`. */
  private est(texels: number, weight: number): number {
    const ms = (texels / 1e6) * weight / this.opts.gpuMtexPerMs;
    this.stats.gpuEstMs += ms;
    return Math.max(0.01, ms);
  }

  private *prep(input: DetailInput, D: number): Generator<number, PreparedDetail> {
    const t = performance.now();
    const prep = yield* prepareDetail(input, D);
    this.stats.prepMs = performance.now() - t;
    this.stats.segments = prep.segCount;
    this.params = prep.params;
    this.size = D;
    this.controlData = prep.control;
    this.controlSize = prep.controlN;
    this.macroWater = { macro: prep.macro, water: prep.water, n: prep.n, worldSize: prep.size };
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.control);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, prep.controlN, prep.controlN, 0, gl.RGBA, gl.UNSIGNED_BYTE, prep.control);
    return prep;
  }

  private *cpuPipeline(input: DetailInput, D: number): Generator<number, void> {
    const prep = yield* this.prep(input, D);
    const t = performance.now();
    const gen = buildDetailCpu(prep, Math.min(4, this.opts.thermalSteps), this.opts);
    let r = gen.next();
    let chunks = 0;
    const totalChunks = D / 16 + prep.segCount / 1024 + 1 + (Math.min(4, this.opts.thermalSteps) * D) / 256;
    while (!r.done) {
      chunks++;
      this.progress = Math.min(0.99, chunks / totalChunks);
      yield 0;
      r = gen.next();
    }
    const h = r.value;
    this.stats.cpuBuildMs = performance.now() - t;
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    setParams(gl, gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, D, D, 0, gl.RED, gl.FLOAT, h);
    this.texture = tex;
    this.cpuHeights = h;
    this.ready = true;
    this.version++;
  }

  private *gpuPipeline(input: DetailInput, D: number): Generator<number, void> {
    const prep = yield* this.prep(input, D);
    const gl = this.gl;
    const o = this.opts;
    const n = prep.n;
    const hydroSteps = o.hydraulicSteps ?? (D >= 4096 ? 24 : 40);
    const T = Math.min(D, TILE);
    const tilesPerSide = Math.ceil(D / T);
    const thermalA = Math.floor(o.thermalSteps / 2);
    const thermalB = o.thermalSteps - thermalA;
    this.passesTotal = 3 + o.thermalSteps + (hydroSteps > 0 ? 1 + tilesPerSide * tilesPerSide * (2 + 3 * hydroSteps) : 0) + 4 + (o.readback ? 1 : 0);
    this.passesDone = 0;

    // Inputs.
    const macroTex = this.tex(gl.R32F, gl.RED, n, n, prep.macro);
    const wlTex = this.tex(gl.R32F, gl.RED, n, n, prep.water ?? new Float32Array(n * n).fill(-10000));
    const ctx: GpuCtx = { n, D, size: prep.size, water: prep.water !== null, macroTex, wlTex };
    for (const name of Object.keys(SOURCES) as ProgName[]) {
      if (hydroSteps === 0 && name.startsWith('h')) continue;
      this.prog(name);
      yield 0;
    }

    // 1. cap = min(water upper bound, carve profiles), via depth-test MIN.
    const cap = this.tex(gl.R32F, gl.RED, D, D);
    const depth = gl.createRenderbuffer();
    this.temps.add(depth);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, D, D);
    const minDepth = (): void => {
      // Set right before each draw: the renderer runs between steps and changes this state.
      this.target([cap], D, D, depth);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
    };
    minDepth();
    gl.clearBufferfv(gl.COLOR, 0, [1e6, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    this.use('cap', ctx, {});
    this.quad();
    yield this.est(D * D, 1);
    if (prep.segCount > 0) {
      const vao = gl.createVertexArray();
      const buf = gl.createBuffer();
      this.temps.add(vao);
      this.temps.add(buf);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, prep.segs, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      // Instanced capsules in chunks (no baseInstance in WebGL2: re-point the attributes per chunk).
      const CHUNK = 16384;
      for (let first = 0; first < prep.segCount; first += CHUNK) {
        const count = Math.min(CHUNK, prep.segCount - first);
        minDepth();
        this.use('carve', ctx, {});
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        for (let a = 0; a < 3; a++) {
          gl.enableVertexAttribArray(a);
          gl.vertexAttribPointer(a, 4, gl.FLOAT, false, SEG_FLOATS * 4, first * SEG_FLOATS * 4 + a * 16);
          gl.vertexAttribDivisor(a, 1);
        }
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.bindVertexArray(null);
        let area = 0;
        for (let s = first; s < first + count; s++) {
          const k = s * SEG_FLOATS;
          const e = prep.segs[k + 11];
          area += (Math.hypot(prep.segs[k + 2] - prep.segs[k], prep.segs[k + 3] - prep.segs[k + 1]) + 2 * e) * 2 * e;
        }
        this.stats.passes++;
        yield this.est(area / (prep.params.texel * prep.params.texel), 2);
      }
      this.passesDone++;
      this.temps.delete(vao);
      gl.deleteVertexArray(vao);
      this.free(buf);
    }
    gl.disable(gl.DEPTH_TEST);
    this.target([cap], D, D, null);
    this.free(depth);

    // 2. Base: bicubic macro + baked noise, clamped.
    let hA = this.tex(gl.R32F, gl.RED, D, D);
    let hB = this.tex(gl.R32F, gl.RED, D, D);
    {
      const p = this.use('base', ctx, { u_cap: cap, u_ctl: this.control });
      const pp = prep.params;
      gl.uniform1ui(this.loc(p, 'u_seed'), pp.seed >>> 0);
      gl.uniform1f(this.loc(p, 'u_bakeLam0'), pp.bakeLam0);
      gl.uniform1i(this.loc(p, 'u_bakeOct'), pp.bakeOct);
      gl.uniform1f(this.loc(p, 'u_bakeAmpScale'), pp.bakeAmpScale);
      this.target([hA], D, D);
      this.quad();
      yield this.est(D * D, 4);
    }

    // 3. Thermal / hydraulic / thermal.
    const thermal = function* (this: DetailMap, steps: number): Generator<number, void> {
      for (let i = 0; i < steps; i++) {
        const p = this.use('thermal', ctx, { u_h: hA, u_cap: cap });
        gl.uniform1f(this.loc(p, 'u_talus'), o.talus * prep.params.texel);
        gl.uniform1f(this.loc(p, 'u_rate'), o.thermalRate);
        this.target([hB], D, D);
        this.quad();
        [hA, hB] = [hB, hA];
        yield this.est(D * D, 1.5);
      }
    };
    yield* thermal.call(this, thermalA);

    if (hydroSteps > 0) {
      this.use('copy', ctx, { u_h: hA });
      this.target([hB], D, D);
      this.quad();
      yield this.est(D * D, 0.3);
      const ov = tilesPerSide > 1 ? OVERLAP : 0;
      const TT = T + 2 * ov;
      const A0 = this.tex(gl.RGBA32F, gl.RGBA, TT, TT);
      const A1 = this.tex(gl.RGBA32F, gl.RGBA, TT, TT);
      const F0 = this.tex(gl.RGBA32F, gl.RGBA, TT, TT);
      const F1 = this.tex(gl.RGBA32F, gl.RGBA, TT, TT);
      const V = this.tex(gl.RG32F, gl.RG, TT, TT);
      const h = o.hydro;
      const setTile = (p: WebGLProgram, org: [number, number]): void => {
        gl.uniform1i(this.loc(p, 'u_T'), TT);
        gl.uniform2i(this.loc(p, 'u_org'), org[0], org[1]);
        gl.uniform1f(this.loc(p, 'u_dt'), h.dt);
        gl.uniform1f(this.loc(p, 'u_K'), h.K);
        gl.uniform1f(this.loc(p, 'u_rain'), h.rain);
      };
      for (let ty = 0; ty < tilesPerSide; ty++) {
        for (let tx = 0; tx < tilesPerSide; tx++) {
          const org: [number, number] = [tx * T - ov, ty * T - ov];
          const a = A0;
          const a2 = A1;
          let f = F0;
          let f2 = F1;
          let p = this.use('hinit', ctx, { u_h: hA });
          gl.uniform2i(this.loc(p, 'u_org'), org[0], org[1]);
          this.target([a], TT, TT);
          this.quad();
          this.target([f], TT, TT);
          gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
          yield this.est(TT * TT, 0.5);
          for (let it = 0; it < hydroSteps; it++) {
            p = this.use('hflux', ctx, { u_A: a, u_F: f });
            setTile(p, org);
            this.target([f2], TT, TT);
            this.quad();
            [f, f2] = [f2, f];
            p = this.use('hwater', ctx, { u_A: a, u_F: f });
            setTile(p, org);
            gl.uniform1f(this.loc(p, 'u_Kc'), h.Kc);
            gl.uniform1f(this.loc(p, 'u_Ks'), h.Ks);
            gl.uniform1f(this.loc(p, 'u_Kd'), h.Kd);
            gl.uniform1f(this.loc(p, 'u_amin'), h.amin);
            gl.uniform1f(this.loc(p, 'u_dmax'), h.dmax);
            gl.uniform1f(this.loc(p, 'u_maxStep'), h.maxStep);
            this.target([a2, V], TT, TT);
            this.quad();
            p = this.use('hadvect', ctx, { u_A: a2, u_F: f, u_V: V, u_h: hA, u_cap: cap });
            setTile(p, org);
            gl.uniform1f(this.loc(p, 'u_Ke'), h.Ke);
            this.target([a], TT, TT);
            this.quad();
            yield this.est(TT * TT, 3);
          }
          // Write the tile interior back.
          p = this.use('hwrite', ctx, { u_A: a });
          gl.uniform2i(this.loc(p, 'u_org'), org[0], org[1]);
          const x0 = tx * T;
          const y0 = ty * T;
          this.target([hB], D, D, null, [x0, y0, Math.min(T, D - x0), Math.min(T, D - y0)]);
          this.quad();
          yield this.est(T * T, 0.3);
        }
      }
      for (const t of [A0, A1, F0, F1, V]) this.free(t);
      [hA, hB] = [hB, hA];
    }
    yield* thermal.call(this, thermalB);

    // 4. Re-anchor low frequencies to the macro.
    {
      const low = this.tex(gl.R32F, gl.RED, n, n);
      const low2 = this.tex(gl.R32F, gl.RED, n, n);
      this.use('adown', ctx, { u_h: hA });
      this.target([low], n, n);
      this.quad();
      yield this.est(n * n * 16, 2);
      let p = this.use('ablur', ctx, { u_src: low });
      gl.uniform2i(this.loc(p, 'u_dir'), 1, 0);
      this.target([low2], n, n);
      this.quad();
      p = this.use('ablur', ctx, { u_src: low2 });
      gl.uniform2i(this.loc(p, 'u_dir'), 0, 1);
      this.target([low], n, n);
      this.quad();
      yield this.est(n * n, 2);
      p = this.use('afinal', ctx, { u_h: hA, u_low: low, u_cap: cap });
      gl.uniform1f(this.loc(p, 'u_a'), o.anchorMetres);
      this.target([hB], D, D);
      this.quad();
      [hA, hB] = [hB, hA];
      yield this.est(D * D, 1.5);
      this.free(low);
      this.free(low2);
    }
    this.free(cap);
    this.free(hB);
    this.free(macroTex);
    this.free(wlTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
    this.temps.delete(hA);
    this.texture = hA;
    this.ready = true;
    this.version++;

    // 5. Readback for CPU picking: pack 4 heights per RGBA32F texel, read into a PBO, poll a fence.
    if (!o.readback) return;
    const tr = performance.now();
    const pack = this.tex(gl.RGBA32F, gl.RGBA, D / 4, D);
    this.use('pack', ctx, { u_h: hA });
    this.target([pack], D / 4, D);
    this.quad();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const out = new Float32Array(D * D);
    if (this.syncMode) {
      gl.readPixels(0, 0, D / 4, D, gl.RGBA, gl.FLOAT, out);
    } else {
      const pbo = gl.createBuffer();
      this.temps.add(pbo);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, D * D * 4, gl.STREAM_READ);
      gl.readPixels(0, 0, D / 4, D, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      if (fence) {
        try {
          while (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) yield WAIT;
        } finally {
          gl.deleteSync(fence);
        }
      }
      // Copy in 8 MB chunks so no single frame pays for the whole buffer.
      const chunk = 2 * 1024 * 1024;
      for (let off = 0; off < D * D; off += chunk) {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, off * 4, out, off, Math.min(chunk, D * D - off));
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        yield 0;
      }
      this.free(pbo);
    }
    this.free(pack);
    this.cpuHeights = out;
    this.stats.readbackMs = performance.now() - tr;
    this.version++;
  }
}

interface GpuCtx {
  n: number;
  D: number;
  size: number;
  water: boolean;
  macroTex: WebGLTexture;
  wlTex: WebGLTexture;
}

function setParams(gl: WebGL2RenderingContext, filter: number): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}
