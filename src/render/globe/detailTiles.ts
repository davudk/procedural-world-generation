import type { RiverGraph } from '../../shared/protocol';
import { FACE_C, faceDir } from '../../shared/cube';
import type { Vec3 } from '../camera/ground';
import {
  DG, chartAngles, chartGrad, fbm3, globeDetailParams, tileCentre, tileKey, tileOfKey, tileStride,
  type GlobeDetailParams, type TileLattice, type TileSource,
} from '../height/globeHeightFn';
import { DN, bicubicQ, bilinearQ, detailParams, smoothstep, type DetailParams } from '../height/heightFn';
import { DRY } from '../heightField';
import { boxInFrustum, hullBelowHorizon } from '../terrain/cdlodSphere';
import { ROCK_B, ROUGH_MUL, carveSegmentCpu, riverSegments, thermalRowCpu } from '../terrain/detail/detailMap';
import { PAD, dirToFaceAngles, padFaceInto } from './cubeTex';

/**
 * Streamed close-zoom detail tiles for spheres (Sphere phase 4b; research 10 §6.7). This file holds the
 * pure parts: the per-world preparation (padded macro, water, coastal band and control on the cube),
 * the per-tile input (local rasters in the tile's own face chart, river segments), a CPU build of a
 * tile (the reference of the GPU passes and the fallback without float render targets) and the
 * streaming / LRU logic. The GPU build lives in globe/globeDetail.ts.
 *
 * A tile is a pure function of (seed, world, face, tile): its raster spans the tile core plus an apron
 * of `A` texels in the face's gnomonic chart, extended past the face edge, and every input is sampled
 * by 3D direction, so tiles on both sides of a seam see the same macro and the same 3D noise.
 */

/**
 * Rivers for carving, in any convention: the graph's attributes plus each node's unit direction.
 * Hook for the hydrology stage on spheres; tiles carve channels and valleys only when this is given.
 */
export interface SphereRivers {
  graph: Pick<RiverGraph, 'n' | 'zWater' | 'zBed' | 'width' | 'down'>;
  /** Unit direction (planet-centred, +z north) of river node i. */
  nodeDir(i: number, out: Float64Array): void;
}

/** Sphere world inputs (face-major 6·n² rasters). Optional layers come with the sphere hydrology stage. */
export interface GlobeDetailWorld {
  n: number;
  radius: number;
  seed: number;
  /** Raw elevation (m): the macro the tiles amplify. */
  elevation: ArrayLike<number>;
  /** Prepared water levels (> DRY: water surface, as heightField.prepareWater), or null: the sea at 0. */
  waterLevel?: ArrayLike<number> | null;
  /** Water class (4, 5 = river / lake water) for the water-proximity control. */
  waterClass?: ArrayLike<number> | null;
  /** log10 discharge (m³/s): large rivers damp the amplification, as on flat maps. */
  discharge?: ArrayLike<number> | null;
  biome?: ArrayLike<number> | null;
  rivers?: SphereRivers | null;
}

export interface PreparedGlobe {
  lattice: TileLattice;
  params: GlobeDetailParams;
  n: number;
  radius: number;
  /** Padded (6 × (n + 2·PAD)²) raw macro, water level, coastal band (0/1) and RGBA8 control. */
  macroPad: Float32Array;
  waterPad: Float32Array;
  coastPad: Float32Array;
  controlPad: Uint8Array;
  /** River node directions (3 per node) and attributes, or null. */
  riverDirs: Float32Array | null;
  rivers: SphereRivers | null;
}

const Q = Math.PI / 4;

/**
 * Per-world preparation, sliced (yields after face chunks): pads the macro and water, marks the coastal
 * band (sea cells and land cells whose 3×3 neighbourhood, across seams, holds both) and builds the
 * control raster (roughness, rock, water proximity) on the macro grid.
 */
export function* prepareGlobe(world: GlobeDetailWorld, lattice: TileLattice): Generator<number, PreparedGlobe> {
  const n = world.n;
  const m = n + 2 * PAD;
  const N6 = 6 * n * n;
  const padded = function* (src: ArrayLike<number>, ch: number): Generator<number, Float32Array> {
    const out = new Float32Array(6 * m * m * ch);
    for (let f = 0; f < 6; f++) {
      padFaceInto(src, n, f, PAD, ch, out);
      yield 0;
    }
    return out;
  };
  const macroPad = yield* padded(world.elevation, 1);
  const water = world.waterLevel ?? null;
  const waterPad = water ? yield* padded(water, 1) : new Float32Array(6 * m * m);
  const cellM = (world.radius * Math.PI) / 2 / n;
  const coast = new Float32Array(N6);
  const ctl = new Float32Array(N6 * 4);
  const cls = world.waterClass ?? null;
  const q = world.discharge ?? null;
  const bio = world.biome ?? null;
  const wet = (i: number): boolean => {
    const wl = waterPad[i];
    return wl > DRY && macroPad[i] < wl;
  };
  const sea = (i: number): boolean => wet(i) && Math.abs(waterPad[i]) < 0.5;
  for (let f = 0; f < 6; f++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const c = f * m * m + (y + PAD) * m + x + PAD;
        const i = (f * n + y) * n + x;
        let lo = Infinity, hi = -Infinity, anySea = false, anyDry = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = c + dy * m + dx;
            const v = macroPad[j];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
            if (sea(j)) anySea = true;
            else if (!wet(j)) anyDry = true;
          }
        }
        coast[i] = anySea && anyDry ? 1 : 0;
        const gx = (macroPad[c + 1] - macroPad[c - 1]) / (2 * cellM);
        const gy = (macroPad[c + m] - macroPad[c - m]) / (2 * cellM);
        const s = Math.hypot(gx, gy);
        const rl = (hi - lo) * (cellM >= 1000 ? 1000 / cellM : 1);
        const b = bio ? bio[i] & 31 : 6;
        let B = wet(c) ? 1 : 0;
        if (cls && (cls[i] === 4 || cls[i] === 5)) B = 1;
        if (q) B = Math.max(B, 0.5 * smoothstep(1.0, 2.5, q[i]));
        ctl[i * 4] = Math.min(1, Math.max(0.03, (0.65 * smoothstep(0.02, 0.35, s) + 0.45 * smoothstep(30, 900, rl)) * ROUGH_MUL[b]));
        ctl[i * 4 + 1] = Math.max(ROCK_B[b], smoothstep(0.25, 0.6, s)) * (1 - B);
        ctl[i * 4 + 2] = B;
      }
      if ((y & 15) === 15) yield 0;
    }
  }
  const coastPad = yield* padded(coast, 1);
  const cp = yield* padded(ctl, 4);
  const controlPad = new Uint8Array(cp.length);
  for (let i = 0; i < cp.length; i++) {
    controlPad[i] = Math.round(255 * Math.min(1, Math.max(0, cp[i])));
    if ((i & 0xfffff) === 0xfffff) yield 0;
  }
  let riverDirs: Float32Array | null = null;
  const rv = world.rivers ?? null;
  if (rv && rv.graph.n > 0) {
    riverDirs = new Float32Array(rv.graph.n * 3);
    const d = new Float64Array(3);
    for (let i = 0; i < rv.graph.n; i++) {
      rv.nodeDir(i, d);
      riverDirs[i * 3] = d[0];
      riverDirs[i * 3 + 1] = d[1];
      riverDirs[i * 3 + 2] = d[2];
    }
  }
  return { lattice, params: globeDetailParams(lattice, world.seed), n, radius: world.radius, macroPad, waterPad, coastPad, controlPad, riverDirs, rivers: rv };
}

/** Bilinear sample of a padded cube raster (ch interleaved channels, channel c) toward a direction. */
export function sampleCube(pad: ArrayLike<number>, n: number, x: number, y: number, z: number, ch = 1, c = 0): number {
  const fa = sTmp;
  dirToFaceAngles(x, y, z, fa);
  const m = n + 2 * PAD;
  const delta = Math.PI / 2 / n;
  const px = Math.min(m - 1.001, Math.max(0, (fa[1] + Q) / delta - 0.5 + PAD));
  const py = Math.min(m - 1.001, Math.max(0, (fa[2] + Q) / delta - 0.5 + PAD));
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const tx = px - x0, ty = py - y0;
  const o = fa[0] * m * m + y0 * m + x0;
  const at = (k: number): number => pad[k * ch + c];
  const top = at(o) + (at(o + 1) - at(o)) * tx;
  const bot = at(o + m) + (at(o + m + 1) - at(o + m)) * tx;
  return top + (bot - top) * ty;
}

const sTmp = new Float64Array(3);

/** Everything one tile build reads: local rasters in the tile's face chart (row = b), and river segments. */
export interface TilePrep {
  key: number;
  face: number;
  /** Raster texels per side (core + 2 aprons), local macro cells per side, texels per cell. */
  D: number;
  nl: number;
  k: number;
  /** Face texel coordinates of the raster's first texel. */
  ox: number;
  oy: number;
  /** Chart angles of the raster's corner (texel x has its centre at a0 + (x + ½)δ). */
  a0: number;
  b0: number;
  delta: number;
  texelM: number;
  radius: number;
  seed: number;
  globe: GlobeDetailParams;
  /** Tile-local DetailParams (size = D texels) for the shared carve and river helpers. */
  params: DetailParams;
  macro: Float32Array;
  water: Float32Array;
  coast: Float32Array;
  /** RGBA8 control on the local macro grid. */
  control: Uint8Array;
  slope: Float32Array;
  segs: Float32Array;
  segCount: number;
}

/** Local rasters of a tile: in-face cells are copied exactly, apron cells across a seam are sampled by direction. */
export function prepareTile(pg: PreparedGlobe, key: number): TilePrep {
  const l = pg.lattice;
  const [face, ix, iy] = tileOfKey(key, l.T);
  const { N, A, k, n } = l;
  const D = N + 2 * A;
  const nl = D / k;
  const ox = ix * N - A;
  const oy = iy * N - A;
  const cx0 = ox / k;
  const cy0 = oy / k;
  const m = n + 2 * PAD;
  const macro = new Float32Array(nl * nl);
  const water = new Float32Array(nl * nl);
  const coast = new Float32Array(nl * nl);
  const control = new Uint8Array(nl * nl * 4);
  const d = new Float64Array(3);
  const cellAng = k * l.delta;
  for (let j = 0; j < nl; j++) {
    for (let i = 0; i < nl; i++) {
      const cx = cx0 + i;
      const cy = cy0 + j;
      const o = j * nl + i;
      if (cx >= 0 && cy >= 0 && cx < n && cy < n) {
        const p = face * m * m + (cy + PAD) * m + cx + PAD;
        macro[o] = pg.macroPad[p];
        water[o] = pg.waterPad[p];
        coast[o] = pg.coastPad[p];
        for (let c = 0; c < 4; c++) control[o * 4 + c] = pg.controlPad[p * 4 + c];
        continue;
      }
      faceDir(face, -Q + (cx + 0.5) * cellAng, -Q + (cy + 0.5) * cellAng, d);
      macro[o] = sampleCube(pg.macroPad, n, d[0], d[1], d[2]);
      water[o] = sampleCube(pg.waterPad, n, d[0], d[1], d[2]);
      coast[o] = sampleCube(pg.coastPad, n, d[0], d[1], d[2]);
      for (let c = 0; c < 4; c++) control[o * 4 + c] = Math.round(sampleCube(pg.controlPad, n, d[0], d[1], d[2], 4, c));
    }
  }
  const texelM = l.texelM;
  const cellM = k * texelM;
  const slope = new Float32Array(nl * nl);
  for (let j = 0; j < nl; j++) {
    for (let i = 0; i < nl; i++) {
      const xl = Math.max(0, i - 1), xr = Math.min(nl - 1, i + 1);
      const yu = Math.max(0, j - 1), yd = Math.min(nl - 1, j + 1);
      const gx = (macro[j * nl + xr] - macro[j * nl + xl]) / (Math.max(1, xr - xl) * cellM);
      const gy = (macro[yd * nl + i] - macro[yu * nl + i]) / (Math.max(1, yd - yu) * cellM);
      slope[j * nl + i] = Math.hypot(gx, gy);
    }
  }
  const params = detailParams(D * texelM, D, nl, pg.params.seed);
  const { segs, count } = tileRiverSegments(pg, face, ox, oy, D, slope, nl, params);
  return {
    key, face, D, nl, k, ox, oy, a0: -Q + ox * l.delta, b0: -Q + oy * l.delta, delta: l.delta, texelM, radius: l.radius,
    seed: pg.params.seed, globe: pg.params, params, macro, water, coast, control, slope, segs, segCount: count,
  };
}

/**
 * River graph → carve segments in tile-local metres (the flat map's `riverSegments` on a local graph):
 * nodes are projected into the tile's face chart; edges far from the tile are skipped.
 */
export function tileRiverSegments(
  pg: PreparedGlobe, face: number, ox: number, oy: number, D: number, slope: Float32Array, nl: number, params: DetailParams,
): { segs: Float32Array; count: number } {
  const rv = pg.rivers;
  const dirs = pg.riverDirs;
  if (!rv || !dirs) return { segs: new Float32Array(0), count: 0 };
  const g = rv.graph;
  const l = pg.lattice;
  const size = D * l.texelM;
  const reach = 0.25 * size + 20 * l.k * l.texelM;
  const x = new Float32Array(g.n).fill(Number.NaN);
  const y = new Float32Array(g.n).fill(Number.NaN);
  const k = face * 3;
  const ang = new Float64Array(2);
  for (let i = 0; i < g.n; i++) {
    const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
    if (dx * FACE_C[k] + dy * FACE_C[k + 1] + dz * FACE_C[k + 2] < 0.3) continue;
    chartAngles(face, dx, dy, dz, ang);
    const px = ((ang[0] + Q) / l.delta - ox) * l.texelM;
    const py = ((ang[1] + Q) / l.delta - oy) * l.texelM;
    if (px < -reach || py < -reach || px > size + reach || py > size + reach) continue;
    x[i] = px;
    y[i] = py;
  }
  const local = { n: g.n, x, y, zWater: g.zWater, zBed: g.zBed, width: g.width, down: g.down } as unknown as RiverGraph;
  return riverSegments(local, slope, nl, params);
}

// ---- CPU build (reference of the GPU passes; fallback without float render targets) -----------------

/** Water bounds of a tile texel (mirrors the tile head's bBounds): flat's rule, relaxed in the coastal band. */
export function tileBounds(hb: number, wl: number, coast: number): [number, number] {
  const c = coast * DG.COAST_RELAX;
  if (wl > DN.DRY) return hb < wl ? [-1e30, wl - 0.5 + c] : [wl + 0.5 - c, 1e30];
  return [hb >= 0.5 ? 0.5 - c : -1e30, 1e30];
}

/** GL LINEAR lookup of an RGBA8 raster at uv, channels 0–1 (as detailMap's controlAt). */
function controlAt(c: Uint8Array, n: number, u: number, v: number, out: Float64Array): void {
  const qx = u * n - 0.5;
  const qy = v * n - 0.5;
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const fx = qx - ix;
  const fy = qy - iy;
  const x0 = Math.min(n - 1, Math.max(0, ix)), x1 = Math.min(n - 1, Math.max(0, ix + 1));
  const y0 = Math.min(n - 1, Math.max(0, iy)), y1 = Math.min(n - 1, Math.max(0, iy + 1));
  for (let k = 0; k < 4; k++) {
    const a = c[(y0 * n + x0) * 4 + k], b = c[(y0 * n + x1) * 4 + k];
    const d = c[(y1 * n + x0) * 4 + k], e = c[(y1 * n + x1) * 4 + k];
    const ab = a + (b - a) * fx;
    out[k] = (ab + (d + (e - d) * fx - ab) * fy) / 255;
  }
}

/**
 * CPU build of one tile raster (D², metres, row = b): Catmull-Rom macro + baked 3D noise + coastal
 * noise, water bounds, river carve, then a few thermal iterations (no hydraulic erosion or
 * re-anchoring, as the flat CPU fallback). Generator: yields after row chunks.
 */
export function* buildTileCpu(tp: TilePrep, thermalSteps: number, opts: { talus: number; thermalRate: number }): Generator<number, Float32Array> {
  const { D, nl, k, texelM, radius: R } = tp;
  const g = tp.globe;
  const h = new Float32Array(D * D);
  const lo = new Float32Array(D * D);
  const cap = new Float32Array(D * D);
  const b5 = new Float64Array(5);
  const t3 = new Float64Array(3);
  const ctl = new Float64Array(4);
  const up = new Float64Array(3);
  const g0 = new Float64Array(4);
  const acc = new Float64Array(4);
  const zero = new Float64Array(4);
  const cellM = k * texelM;
  const cellAng = k * tp.delta;
  for (let y = 0; y < D; y++) {
    const b = tp.b0 + (y + 0.5) * tp.delta;
    const qy = (y + 0.5) / k - 0.5;
    for (let x = 0; x < D; x++) {
      const a = tp.a0 + (x + 0.5) * tp.delta;
      const qx = (x + 0.5) / k - 0.5;
      faceDir(tp.face, a, b, up);
      bicubicQ(tp.macro, nl, qx, qy, b5);
      const hb = bilinearQ(tp.macro, nl, qx, qy, t3)[0];
      const wl = bilinearQ(tp.water, nl, qx, qy, t3)[0];
      const co = bilinearQ(tp.coast, nl, qx, qy, t3)[0];
      const [l, hi] = tileBounds(hb, wl, co);
      controlAt(tp.control, nl, (x + 0.5) / D, (y + 0.5) / D, ctl);
      chartGrad(tp.face, a, b, b5[1] / cellAng, b5[2] / cellAng, R, g0);
      acc.fill(0);
      const amp = (DN.BAKE_BASE + DN.BAKE_ROUGH * ctl[0]) * g.bakeAmpScale * (1 - ctl[2]);
      const px = up[0] * R, py = up[1] * R, pz = up[2] * R;
      if (g.bakeOct > 0) fbm3(px, py, pz, up, texelM, g.bakeLam0, g.bakeOct, amp, ctl[1], g0, (g.seed ^ DN.SEED_BAKE) >>> 0, acc);
      const ac = Math.min(DG.COAST_MAX, Math.max(DG.COAST_MIN, (Math.hypot(b5[1], b5[2]) / cellM) * DG.COAST_DISP)) * co;
      let coastN = 0;
      if (ac > 0 && g.bakeOct > 0) {
        zero.fill(0);
        coastN = fbm3(px, py, pz, up, texelM, 0.5 * g.bakeLam0, g.bakeOct, ac, 0, zero, (g.seed ^ DG.SEED_COAST) >>> 0, new Float64Array(4))[0];
      }
      const i = y * D + x;
      h[i] = b5[0] + acc[0] + coastN;
      lo[i] = l;
      cap[i] = hi;
    }
    if ((y & 3) === 3) yield 0;
  }
  for (let s = 0; s < tp.segCount; s++) carveSegmentCpu(tp, s, lo, cap);
  for (let i = 0; i < D * D; i++) h[i] = Math.min(Math.max(h[i], lo[i]), cap[i]);
  yield 0;
  let src = h;
  let dst = new Float32Array(D * D);
  for (let it = 0; it < thermalSteps; it++) {
    for (let y = 0; y < D; y++) {
      thermalRowCpu(src, dst, lo, cap, D, y, opts.talus * texelM, opts.thermalRate);
      if ((y & 255) === 255) yield 0;
    }
    [src, dst] = [dst, src];
  }
  return src;
}

/** The stored part of a tile raster: core plus margin, stride² texels. */
export function extractTile(full: Float32Array, l: TileLattice): Float32Array {
  const D = l.N + 2 * l.A;
  const W = tileStride(l);
  const off = l.A - l.M;
  const out = new Float32Array(W * W);
  for (let y = 0; y < W; y++) out.set(full.subarray((y + off) * D + off, (y + off) * D + off + W), y * W);
  return out;
}

/** Runs a generator to completion (tests and tools). */
export function runSync<T>(g: Generator<number, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

// ---- Streaming and LRU -----------------------------------------------------------------------------

export interface StreamView {
  /** Eye, planet-centred (m). */
  eye: Vec3;
  /** Metres per pixel per metre of distance (2·tan(fovY/2) / viewH). */
  pxScale: number;
  /** Frustum planes relative to the eye (cdlod convention), or null. */
  planes: Float64Array | null;
  /** Highest rendered height above R, detail pad included (m). */
  maxHeight: number;
}

/** Seconds a newly resident tile takes to fade in. */
export const TILE_FADE_S = 0.4;
/** A tile is wanted while its nearest point is drawn finer than this many texels per pixel. */
export const WANT_TEXELS = 2.5;

/**
 * The tile set around the camera: which tiles are wanted (detail weight > 0 somewhere in them, not
 * behind the horizon; in-frustum tiles first, then by distance), which slot each resident tile holds,
 * and LRU eviction of tiles no longer wanted. Also the CPU copies and fade-in weights the height
 * function reads (TileSource).
 */
export class TileCache implements TileSource {
  readonly lattice: TileLattice;
  readonly slots: number;
  /** Resident (or building) tile → slot. */
  readonly slotOf = new Map<number, number>();
  /** Slot → tile key, −1 when free. */
  readonly keyOf: Int32Array;
  /** Slot holds finished GPU content. */
  readonly ready: Uint8Array;
  /** Slot fade-in weight 0..1. */
  readonly fade: Float32Array;
  /** CPU copies of slots (null until the readback arrives). */
  readonly data: (Float32Array | null)[];
  private readonly lastWanted: Float64Array;
  private frame = 0;
  /** Wanted tiles of the last plan, best first. */
  wanted: number[] = [];
  private wantedSet = new Set<number>();
  private readonly centres: Float32Array;
  private readonly radii: Float32Array;

  constructor(lattice: TileLattice, slots: number) {
    this.lattice = lattice;
    this.slots = slots;
    this.keyOf = new Int32Array(slots).fill(-1);
    this.ready = new Uint8Array(slots);
    this.fade = new Float32Array(slots);
    this.data = new Array<Float32Array | null>(slots).fill(null);
    this.lastWanted = new Float64Array(slots).fill(-1);
    const count = 6 * lattice.T * lattice.T;
    this.centres = new Float32Array(count * 3);
    this.radii = new Float32Array(count);
    const c = new Float64Array(3);
    for (let key = 0; key < count; key++) {
      this.radii[key] = tileCentre(lattice, key, c) + (lattice.B * lattice.delta);
      this.centres.set(c, key * 3);
    }
  }

  get tileCount(): number {
    return this.radii.length;
  }

  /** Number of slots with finished content. */
  get residentCount(): number {
    let k = 0;
    for (let s = 0; s < this.slots; s++) if (this.ready[s]) k++;
    return k;
  }

  tile(key: number): { data: Float32Array | null; fade: number } | null {
    const s = this.slotOf.get(key);
    if (s === undefined || !this.ready[s]) return null;
    return { data: this.data[s], fade: this.fade[s] };
  }

  /**
   * Nearest distance (m) from the eye to a tile's patch, whether it can be above the horizon, and
   * whether its hull touches the frustum.
   */
  tileView(key: number, v: StreamView): { dist: number; visible: boolean; inFrustum: boolean } {
    const l = this.lattice;
    const R = l.radius;
    const e = v.eye;
    const re = Math.hypot(e.x, e.y, e.z);
    const cx = this.centres[key * 3], cy = this.centres[key * 3 + 1], cz = this.centres[key * 3 + 2];
    const th = Math.acos(Math.max(-1, Math.min(1, (e.x * cx + e.y * cy + e.z * cz) / re)));
    const phi = Math.max(0, th - this.radii[key]);
    const dist = Math.max(0, Math.sqrt(Math.max(0, re * re + R * R - 2 * re * R * Math.cos(phi))) - v.maxHeight);
    // Horizon: the nearest point is hidden behind the sea-level sphere (heights only help by the
    // horizon of R + maxHeight).
    let visible = true;
    if (re > R + v.maxHeight) {
      const hz = Math.acos(R / re) + Math.acos(R / (R + v.maxHeight));
      visible = phi < hz;
    }
    let inFrustum = true;
    if (v.planes && visible && dist > 0) {
      const [f, ix, iy] = tileOfKey(key, l.T);
      const span = l.N * l.delta;
      const d = new Float64Array(3);
      const pts = new Float64Array(18 * 3);
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      let p = 0;
      const lo = R, hi = (R + v.maxHeight) / Math.cos(Math.min(1.5, span + 2 * l.B * l.delta) / 2);
      for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
          faceDir(f, -Q + ix * span + (i * span) / 2, -Q + iy * span + (j * span) / 2, d);
          for (const r of [lo, hi]) {
            const px = d[0] * r, py = d[1] * r, pz = d[2] * r;
            pts[p++] = px;
            pts[p++] = py;
            pts[p++] = pz;
            x0 = Math.min(x0, px); x1 = Math.max(x1, px);
            y0 = Math.min(y0, py); y1 = Math.max(y1, py);
            z0 = Math.min(z0, pz); z1 = Math.max(z1, pz);
          }
        }
      }
      const pad = l.B * l.texelM * 2;
      inFrustum = boxInFrustum(v.planes, x0 - pad - e.x, y0 - pad - e.y, z0 - pad - e.z, x1 + pad - e.x, y1 + pad - e.y, z1 + pad - e.z);
      if (hullBelowHorizon(pts, 18, e, R * (1 - 1e-7))) visible = false;
    }
    return { dist, visible, inFrustum };
  }

  /**
   * Plans the wanted set for a view: tiles whose nearest point is drawn at under WANT_TEXELS texels per
   * pixel and that may be visible, in-frustum ones first, each group by distance, capped at `slots`.
   * Marks wanted resident tiles as recently used.
   */
  plan(v: StreamView): number[] {
    this.frame++;
    const l = this.lattice;
    const range = (WANT_TEXELS * l.texelM) / Math.max(1e-12, v.pxScale);
    const cand: { key: number; score: number }[] = [];
    for (let key = 0; key < this.tileCount; key++) {
      const t = this.tileView(key, v);
      if (!t.visible || t.dist > range) continue;
      cand.push({ key, score: t.dist + (t.inFrustum ? 0 : 4 * range) });
    }
    cand.sort((a, b) => a.score - b.score || a.key - b.key);
    this.wanted = cand.slice(0, this.slots).map((c) => c.key);
    this.wantedSet = new Set(this.wanted);
    for (const key of this.wanted) {
      const s = this.slotOf.get(key);
      if (s !== undefined) this.lastWanted[s] = this.frame;
    }
    return this.wanted;
  }

  /** The best wanted tile that is not resident or building, or −1. */
  next(): number {
    for (const key of this.wanted) if (!this.slotOf.has(key)) return key;
    return -1;
  }

  /**
   * A slot for `key`: a free one, else the least recently wanted resident tile outside the wanted set
   * (evicted; its slot is returned). −1 when every slot holds a wanted tile.
   */
  acquire(key: number): number {
    const have = this.slotOf.get(key);
    if (have !== undefined) return have;
    let best = -1;
    for (let s = 0; s < this.slots; s++) {
      if (this.keyOf[s] < 0) {
        best = s;
        break;
      }
      if (this.wantedSet.has(this.keyOf[s]) || !this.ready[s]) continue;
      if (best < 0 || this.lastWanted[s] < this.lastWanted[best]) best = s;
    }
    if (best < 0) return -1;
    this.evictSlot(best);
    this.keyOf[best] = key;
    this.slotOf.set(key, best);
    this.lastWanted[best] = this.frame;
    return best;
  }

  /** The slot's GPU content is final (CPU copy optional, may follow later). */
  commit(key: number, data: Float32Array | null = null): void {
    const s = this.slotOf.get(key);
    if (s === undefined) return;
    this.ready[s] = 1;
    this.fade[s] = 0;
    if (data) this.data[s] = data;
  }

  /** Attaches the CPU copy of a resident tile. */
  setData(key: number, data: Float32Array): void {
    const s = this.slotOf.get(key);
    if (s !== undefined) this.data[s] = data;
  }

  /** Drops a tile (e.g. a cancelled build). */
  release(key: number): void {
    const s = this.slotOf.get(key);
    if (s !== undefined) this.evictSlot(s);
  }

  /** Advances fade-ins by dt seconds; true when any weight changed. */
  tick(dt: number): boolean {
    let changed = false;
    for (let s = 0; s < this.slots; s++) {
      if (!this.ready[s] || this.fade[s] >= 1) continue;
      this.fade[s] = Math.min(1, this.fade[s] + Math.max(0, dt) / TILE_FADE_S);
      changed = true;
    }
    return changed;
  }

  /** Indirection texels (RG per tile, layer = face): slot (−1 when not ready) and fade. */
  writeIndex(out: Float32Array): void {
    out.fill(0);
    for (let i = 0; i < out.length; i += 2) out[i] = -1;
    for (let s = 0; s < this.slots; s++) {
      const key = this.keyOf[s];
      if (key < 0 || !this.ready[s]) continue;
      out[key * 2] = s;
      out[key * 2 + 1] = this.fade[s];
    }
  }

  clear(): void {
    for (let s = 0; s < this.slots; s++) this.evictSlot(s);
    this.wanted = [];
    this.wantedSet.clear();
  }

  private evictSlot(s: number): void {
    const key = this.keyOf[s];
    if (key >= 0) this.slotOf.delete(key);
    this.keyOf[s] = -1;
    this.ready[s] = 0;
    this.fade[s] = 0;
    this.data[s] = null;
    this.lastWanted[s] = -1;
  }
}

/** Tile key of the tile containing a direction (tests and tools). */
export function tileAtDir(l: TileLattice, x: number, y: number, z: number): number {
  const fa = new Float64Array(3);
  dirToFaceAngles(x, y, z, fa);
  const ix = Math.min(l.T - 1, Math.max(0, Math.floor((fa[1] + Q) / (l.N * l.delta))));
  const iy = Math.min(l.T - 1, Math.max(0, Math.floor((fa[2] + Q) / (l.N * l.delta))));
  return tileKey(fa[0], ix, iy, l.T);
}

