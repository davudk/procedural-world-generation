import { FACE_C, FACE_E, FACE_S } from '../../shared/cube';
import type { QualityTier } from '../quality';
import { GLOBE_NOISE_GLSL, type GlobeDetailSource } from '../glsl/globeDetail';
import { NOISE_GLSL } from '../glsl/detail';
import {
  GlobeHeightFn, globeBoundsPad, tileLattice, tileStride, type GlobeDetailParams, type TileLattice,
} from '../height/globeHeightFn';
import {
  DEFAULT_DETAIL_OPTIONS, QUAD_VS, SEG_FLOATS, Z_HI, Z_LO, detailBuildSources, type HydroParams,
} from '../terrain/detail/detailMap';
import { PAD, uploadArray } from './cubeTex';
import {
  TileCache, buildTileCpu, extractTile, prepareGlobe, prepareTile, type GlobeDetailWorld, type PreparedGlobe, type StreamView, type TilePrep,
} from './detailTiles';

/**
 * Streamed close-zoom detail for the globe (Sphere phase 4b; research 10 §6.7), GPU side.
 *
 * `setWorld()` prepares the cube rasters (sliced on the CPU) and the control texture. `update()` runs
 * once per frame: it plans the wanted tiles around the camera (detail/TileCache), starts at most one
 * tile build at a time and advances it within a time budget, never waiting on the GPU (fences), and
 * fades resident tiles in. A tile build is the flat detail map's pipeline on a tile raster in the
 * face chart (globe/detailTiles.ts): cap + river carve (depth-MIN), base = Catmull-Rom macro + baked 3D
 * noise + coastal noise, thermal, pipe-model hydraulic, thermal, re-anchoring; then the core and
 * margin are copied into a slot of a TEXTURE_2D_ARRAY and read back asynchronously for picking.
 * Without float render targets tiles are built on the CPU (no hydraulic erosion), sliced the same way.
 */

export interface GlobeDetailOptions {
  /** Tile core texels (per side) and resident tile slots. */
  tileN: 512 | 1024;
  slots: number;
  thermalSteps: number;
  hydraulicSteps: number;
  anchorMetres: number;
  talus: number;
  thermalRate: number;
  hydro: HydroParams;
  gpuMtexPerMs: number;
  readback: boolean;
  /** Free the build scratch after this long without a build (ms). */
  idleFreeMs: number;
}

export const DEFAULT_GLOBE_DETAIL: GlobeDetailOptions = {
  tileN: 1024,
  slots: 12,
  thermalSteps: DEFAULT_DETAIL_OPTIONS.thermalSteps,
  hydraulicSteps: 24,
  anchorMetres: DEFAULT_DETAIL_OPTIONS.anchorMetres,
  talus: DEFAULT_DETAIL_OPTIONS.talus,
  thermalRate: DEFAULT_DETAIL_OPTIONS.thermalRate,
  hydro: DEFAULT_DETAIL_OPTIONS.hydro,
  // Starting point; with timer queries the estimates are calibrated against measured GPU time (gpuScale).
  gpuMtexPerMs: 5,
  readback: true,
  idleFreeMs: 5000,
};

/** Tile size and LRU budget per quality tier (memory: research 10 §6.7, PLAN Sphere phase 4b). */
export function globeDetailOptions(tier: QualityTier): Partial<GlobeDetailOptions> {
  switch (tier) {
    case 'low':
      return { tileN: 512, slots: 8, hydraulicSteps: 16, thermalSteps: 16 };
    case 'medium':
      return { tileN: 1024, slots: 8 };
    case 'high':
      return { tileN: 1024, slots: 12 };
  }
}

// ---- Build shaders ---------------------------------------------------------------------------------

/** The flat build passes' head, for a tile raster: local macro grid, water and the coastal band. */
const TILE_HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${NOISE_GLSL}
${GLOBE_NOISE_GLSL}
uniform sampler2D u_macro;   // R32F local macro (nl x nl), row = chart b
uniform sampler2D u_wl;      // R32F local water level, < -9000 dry
uniform sampler2D u_coast;   // R32F local coastal band (0..1)
uniform int u_hasWater;
uniform int u_n;
uniform float u_size;
uniform int u_D;
float bTexel() { return u_size / float(u_D); }
float bCell() { return u_size / float(u_n); }
vec2 bMacroQ(vec2 pm) { return pm / u_size * float(u_n) - 0.5; }
// Water bounds (lo, hi), mirrors detailTiles.tileBounds: the flat rule, relaxed inside the coastal band.
vec2 bBounds(vec2 pm) {
  vec2 q = bMacroQ(pm);
  float hb = dnBilinear(u_macro, u_n, q).x;
  float wl = u_hasWater == 1 ? dnBilinear(u_wl, u_n, q).x : 0.0;
  float c = dnBilinear(u_coast, u_n, q).x * G_COAST_RELAX;
  if (wl > DN_DRY) return hb < wl ? vec2(-1e30, wl - 0.5 + c) : vec2(wl + 0.5 - c, 1e30);
  return vec2(hb >= 0.5 ? 0.5 - c : -1e30, 1e30);
}
float bDepth(float z) { return clamp((z - (${Z_LO}.0)) / (${Z_HI - Z_LO}.0), 0.0, 1.0); }
`;

// Mirrors detailTiles.buildTileCpu's base.
const TBASE_FS = `${TILE_HEAD}
uniform sampler2D u_cap;
uniform sampler2D u_ctl;
uniform uint u_seed;
uniform float u_bakeLam0;
uniform int u_bakeOct;
uniform float u_bakeAmpScale;
uniform vec3 u_tC;
uniform vec3 u_tE;
uniform vec3 u_tS;
uniform vec2 u_org;
uniform float u_delta;
uniform float u_R;
out float o;
void main() {
  vec2 pm = gl_FragCoord.xy * bTexel();
  vec2 t = tan(u_org + gl_FragCoord.xy * u_delta);
  vec3 up = normalize(u_tC + t.x * u_tE + t.y * u_tS);
  vec3 P = up * u_R;
  vec2 mm;
  vec3 m = dnBicubic(u_macro, u_n, bMacroQ(pm), mm);
  vec3 et = normalize(u_tE - dot(u_tE, up) * up);
  vec3 st = normalize(u_tS - dot(u_tS, up) * up);
  vec3 g0 = (m.y * et + m.z * st) / bCell();
  vec4 c = textureLod(u_ctl, pm / u_size, 0.0);
  float amp = (G_BAKE_BASE + G_BAKE_ROUGH * c.r) * u_bakeAmpScale * (1.0 - c.b);
  float nz = u_bakeOct > 0 ? gFbmAt(P, up, bTexel(), u_bakeLam0, u_bakeOct, amp, c.g, g0, u_seed ^ G_SEED_BAKE).x : 0.0;
  float coast = dnBilinear(u_coast, u_n, bMacroQ(pm)).x;
  float ac = clamp(length(m.yz) / bCell() * G_COAST_DISP, G_COAST_MIN, G_COAST_MAX) * coast;
  float cz = ac > 0.0 && u_bakeOct > 0 ? gFbmAt(P, up, bTexel(), 0.5 * u_bakeLam0, u_bakeOct, ac, 0.0, vec3(0.0), u_seed ^ G_SEED_COAST).x : 0.0;
  vec2 b = bBounds(pm);
  o = min(max(m.x + nz + cz, b.x), texelFetch(u_cap, ivec2(gl_FragCoord.xy), 0).r);
}`;

const TEXTRACT_FS = `${TILE_HEAD}
uniform sampler2D u_h;
uniform int u_off;
out float o;
void main() { o = texelFetch(u_h, ivec2(gl_FragCoord.xy) + u_off, 0).r; }`;

const TPACK_FS = `${TILE_HEAD}
uniform sampler2D u_h;
uniform int u_off;
out vec4 o;
void main() {
  ivec2 b = ivec2(int(gl_FragCoord.x) * 4, int(gl_FragCoord.y)) + u_off;
  o = vec4(texelFetch(u_h, b, 0).r, texelFetch(u_h, b + ivec2(1, 0), 0).r, texelFetch(u_h, b + ivec2(2, 0), 0).r, texelFetch(u_h, b + ivec2(3, 0), 0).r);
}`;

type TileProg = 'cap' | 'carve' | 'thermal' | 'copy' | 'hinit' | 'hflux' | 'hwater' | 'hadvect' | 'hwrite' | 'adown' | 'ablur' | 'afinal' | 'tbase' | 'textract' | 'tpack';

const FLAT = detailBuildSources(TILE_HEAD);

/** Exposed for tests: the tile build programs (flat passes over the tile head, plus the tile's own). */
export const GLOBE_TILE_SOURCES: Readonly<Record<TileProg, readonly [string, string]>> = {
  cap: FLAT.cap, carve: FLAT.carve, thermal: FLAT.thermal, copy: FLAT.copy, hinit: FLAT.hinit, hflux: FLAT.hflux,
  hwater: FLAT.hwater, hadvect: FLAT.hadvect, hwrite: FLAT.hwrite, adown: FLAT.adown, ablur: FLAT.ablur, afinal: FLAT.afinal,
  tbase: [QUAD_VS, TBASE_FS], textract: [QUAD_VS, TEXTRACT_FS], tpack: [QUAD_VS, TPACK_FS],
};

const WAIT = -1;

export interface GlobeDetailStats {
  path: 'gpu' | 'cpu' | 'none';
  /** World preparation (CPU, sliced) and shader compile wall time (ms). */
  prepMs: number;
  compileMs: number;
  /** Tiles built, and per tile: wall time from start to resident, CPU time in slices, readback (ms). */
  built: number;
  lastTileMs: number;
  lastTileCpuMs: number;
  lastReadbackMs: number;
  /** Longest single update() slice (ms of CPU on the main thread). */
  maxSliceMs: number;
  /** Mean wall time per tile. */
  meanTileMs: number;
  /** Measured / estimated GPU time of build slices (1 without timer queries). */
  gpuScale: number;
  /** GPU time (ms) of the last build slices, when timer queries exist. */
  sliceGpuMs: number[];
}

interface Scratch {
  D: number;
  nl: number;
  macro: WebGLTexture;
  wl: WebGLTexture;
  coast: WebGLTexture;
  ctl: WebGLTexture;
  cap: WebGLTexture;
  depth: WebGLRenderbuffer;
  hA: WebGLTexture;
  hB: WebGLTexture;
  A0: WebGLTexture;
  A1: WebGLTexture;
  F0: WebGLTexture;
  F1: WebGLTexture;
  V: WebGLTexture;
  low: WebGLTexture;
  low2: WebGLTexture;
  pack: WebGLTexture;
  pbo: WebGLBuffer;
  segBuf: WebGLBuffer;
  segVao: WebGLVertexArrayObject;
}

/** Streamed detail tiles for one sphere world (see the file comment). */
export class GlobeDetail implements GlobeDetailSource {
  params: GlobeDetailParams | null = null;
  lattice: TileLattice | null = null;
  controlTex: WebGLTexture | null = null;
  tileTex: WebGLTexture | null = null;
  idxTex: WebGLTexture | null = null;
  cache: TileCache | null = null;
  /** TS height function over the same inputs (camera ground), once the world is prepared. */
  fn: GlobeHeightFn | null = null;
  /** Max |detail − macro| (m, unexaggerated). */
  boundsPad = 0;
  readonly gpu: boolean;
  readonly opts: GlobeDetailOptions;
  stats: GlobeDetailStats = { path: 'none', prepMs: 0, compileMs: 0, built: 0, lastTileMs: 0, lastTileCpuMs: 0, lastReadbackMs: 0, maxSliceMs: 0, meanTileMs: 0, gpuScale: 2.5, sliceGpuMs: [] };
  /** Increments when the world preparation finishes (swap the camera ground then). */
  version = 0;

  private prepared: PreparedGlobe | null = null;
  private job: Generator<number, void> | null = null;
  private jobKey = -1;
  private fence: WebGLSync | null = null;
  private progs: Partial<Record<TileProg, WebGLProgram>> = {};
  private compiled = false;
  private locs = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private readonly fbo: WebGLFramebuffer;
  private readonly vao: WebGLVertexArrayObject;
  private scratch: Scratch | null = null;
  private idxData: Float32Array | null = null;
  private idxDirty = false;
  private lastBuild = 0;
  private unitsUsed = 0;
  private tileTotalMs = 0;
  /**
   * Measured / estimated GPU time of build slices (EMA), from timer queries when available. Starts
   * conservative (≈ what the browser pane measured on Apple silicon) so the first slices don't hitch.
   */
  gpuScale = 2.5;
  private readonly timer: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private queries: { q: WebGLQuery; est: number }[] = [];
  private get timerBusy(): boolean {
    return this.queries.length > 4;
  }

  constructor(private readonly gl: WebGL2RenderingContext, opts: Partial<GlobeDetailOptions> = {}) {
    this.opts = { ...DEFAULT_GLOBE_DETAIL, ...opts, hydro: { ...DEFAULT_GLOBE_DETAIL.hydro, ...(opts.hydro ?? {}) } };
    this.gpu = gl.getExtension('EXT_color_buffer_float') !== null && probeFloatTargets(gl);
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    this.fbo = gl.createFramebuffer();
    this.vao = gl.createVertexArray();
  }

  /** Number of resident tiles the shader may sample. */
  get residentCount(): number {
    return this.cache ? this.cache.residentCount : 0;
  }

  /** True while the world is being prepared, a tile builds, or a tile still fades in. */
  get busy(): boolean {
    if (this.job) return true;
    const c = this.cache;
    if (!c) return false;
    for (let s = 0; s < c.slots; s++) if (c.ready[s] && c.fade[s] < 1) return true;
    return c.next() >= 0;
  }

  /** Starts over for a new sphere world (null: none). */
  setWorld(world: GlobeDetailWorld | null): void {
    this.cancel();
    this.releaseWorld();
    if (!world) return;
    const lat = tileLattice(world.n, world.radius, this.opts.tileN);
    this.lattice = lat;
    this.stats = { ...this.stats, path: this.gpu ? 'gpu' : 'cpu', prepMs: 0, built: 0, lastTileMs: 0, lastTileCpuMs: 0, lastReadbackMs: 0, maxSliceMs: 0, meanTileMs: 0, sliceGpuMs: [] };
    this.tileTotalMs = 0;
    this.job = this.prepJob(world, lat);
    this.jobKey = -1;
  }

  /**
   * Once per frame before drawing: streaming, fade-in and up to `budgetMs` of build work (CPU time plus
   * estimated GPU time). Returns true when what the shader shows changed (a tile arrived or faded).
   */
  update(view: StreamView, dt: number, budgetMs: number): boolean {
    const t0 = performance.now();
    let changed = false;
    const c = this.cache;
    if (c && this.prepared) {
      c.plan(view);
      if (!this.job) {
        const key = c.next();
        if (key >= 0 && c.acquire(key) >= 0) {
          this.job = this.tileJob(key);
          this.jobKey = key;
          this.idxDirty = true;
        }
      }
    }
    this.pollTimers();
    if (this.job) changed = this.step(budgetMs) || changed;
    if (c && c.tick(dt)) this.idxDirty = true;
    if (this.idxDirty) {
      this.uploadIndex();
      changed = true;
    }
    if (!this.job && this.scratch && performance.now() - this.lastBuild > this.opts.idleFreeMs) this.freeScratch();
    this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, performance.now() - t0);
    return changed;
  }

  dispose(): void {
    this.cancel();
    this.releaseWorld();
    const gl = this.gl;
    for (const p of Object.values(this.progs)) if (p) gl.deleteProgram(p);
    this.progs = {};
    this.compiled = false;
    for (const { q } of this.queries) gl.deleteQuery(q);
    this.queries = [];
    gl.deleteFramebuffer(this.fbo);
    gl.deleteVertexArray(this.vao);
  }

  /** GPU memory held now (bytes): tiles, index, control and build scratch. */
  memoryBytes(): { tiles: number; control: number; scratch: number; cpu: number } {
    const l = this.lattice;
    const W = l ? tileStride(l) : 0;
    const tiles = this.tileTex && l ? W * W * 4 * this.opts.slots : 0;
    const m = this.prepared ? this.prepared.n + 2 * PAD : 0;
    const control = this.controlTex ? 6 * m * m * 4 : 0;
    const s = this.scratch;
    const D2 = s ? s.D * s.D : 0;
    const scratch = s ? D2 * (4 * 3 + 4 + 16 * 4 + 8) + s.nl * s.nl * (4 * 5 + 4) + W * W * 4 * 2 : 0;
    let cpu = 0;
    if (this.cache) for (const d of this.cache.data) if (d) cpu += d.byteLength;
    if (this.prepared) cpu += this.prepared.macroPad.byteLength * 3 + this.prepared.controlPad.byteLength;
    return { tiles, control, scratch, cpu };
  }

  // ---- internals ----------------------------------------------------------------------------------

  private step(budgetMs: number): boolean {
    const job = this.job;
    if (!job) return false;
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
    let estSum = 0;
    const residentBefore = this.residentCount;
    // GPU time of this slice, when timer queries exist: calibrates the per-pass estimates (gpuScale).
    const timer = this.timer;
    const q = timer && !this.timerBusy ? gl.createQuery() : null;
    if (q) gl.beginQuery(timer!.TIME_ELAPSED_EXT, q);
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
          estSum += r.value;
          spent += r.value * this.gpuScale;
        }
      }
    });
    if (q) {
      gl.endQuery(timer!.TIME_ELAPSED_EXT);
      this.queries.push({ q, est: estSum });
    }
    if (gpuWork && !done) this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (done) {
      this.job = null;
      this.jobKey = -1;
      this.lastBuild = performance.now();
    }
    return this.residentCount !== residentBefore;
  }

  /** Folds finished timer queries into gpuScale (slices with little estimated work are skipped). */
  private pollTimers(): void {
    const gl = this.gl;
    const t = this.timer;
    if (!t || this.queries.length === 0) return;
    const disjoint = gl.getParameter(t.GPU_DISJOINT_EXT) as boolean;
    while (this.queries.length > 0) {
      const { q, est } = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      gl.deleteQuery(q);
      this.queries.shift();
      if (disjoint) continue;
      this.stats.sliceGpuMs.push(ms);
      if (this.stats.sliceGpuMs.length > 256) this.stats.sliceGpuMs.shift();
      if (est < 0.3) continue;
      this.gpuScale = Math.min(20, Math.max(0.25, 0.7 * this.gpuScale + 0.3 * (ms / est)));
    }
    this.stats.gpuScale = this.gpuScale;
  }

  private cancel(): void {
    if (this.job) this.job.return(undefined);
    this.job = null;
    if (this.jobKey >= 0 && this.cache) this.cache.release(this.jobKey);
    this.jobKey = -1;
    if (this.fence) this.gl.deleteSync(this.fence);
    this.fence = null;
  }

  private releaseWorld(): void {
    const gl = this.gl;
    for (const t of [this.controlTex, this.tileTex, this.idxTex]) if (t) gl.deleteTexture(t);
    this.controlTex = this.tileTex = this.idxTex = null;
    this.freeScratch();
    this.cache = null;
    this.prepared = null;
    this.params = null;
    this.lattice = null;
    this.fn = null;
    this.idxData = null;
    this.version++;
  }

  private *prepJob(world: GlobeDetailWorld, lat: TileLattice): Generator<number, void> {
    const t = performance.now();
    const pg = yield* prepareGlobe(world, lat);
    const gl = this.gl;
    this.controlTex = gl.createTexture();
    uploadArray(gl, this.controlTex, pg.controlPad, pg.n + 2 * PAD, 'rgba8', true);
    yield 0;
    const W = tileStride(lat);
    this.tileTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, W, W, this.opts.slots);
    setArrayParams(gl);
    this.idxTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.idxTex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RG32F, lat.T, lat.T, 6);
    setArrayParams(gl);
    this.idxData = new Float32Array(6 * lat.T * lat.T * 2);
    this.cache = new TileCache(lat, this.opts.slots);
    this.uploadIndex();
    this.prepared = pg;
    this.params = pg.params;
    this.boundsPad = globeBoundsPad(pg.params, this.opts.anchorMetres);
    this.fn = new GlobeHeightFn({ n: pg.n, radius: pg.radius, macroPad: pg.macroPad, control: pg.controlPad, params: pg.params, tiles: this.cache });
    this.stats.prepMs = performance.now() - t;
    this.version++;
  }

  private uploadIndex(): void {
    const gl = this.gl;
    const c = this.cache;
    const l = this.lattice;
    if (!c || !l || !this.idxTex || !this.idxData) return;
    c.writeIndex(this.idxData);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.idxTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, l.T, l.T, 6, gl.RG, gl.FLOAT, this.idxData);
    this.idxDirty = false;
  }

  private *tileJob(key: number): Generator<number, void> {
    const t0 = performance.now();
    let cpu = 0;
    const pg = this.prepared!;
    const lat = pg.lattice;
    const tc = performance.now();
    const tp = prepareTile(pg, key);
    cpu += performance.now() - tc;
    yield 0;
    if (!this.gpu) {
      const tb = performance.now();
      const raster = yield* buildTileCpu(tp, Math.min(4, this.opts.thermalSteps), this.opts);
      cpu += performance.now() - tb;
      const data = extractTile(raster, lat);
      const W = tileStride(lat);
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tileTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, this.cache!.slotOf.get(key)!, W, W, 1, gl.RED, gl.FLOAT, data);
      this.cache!.commit(key, data);
      this.finishTile(t0, cpu, 0);
      return;
    }
    if (!this.compiled) yield* this.compileAll();
    const readback = yield* this.gpuTile(tp, key);
    this.finishTile(t0, cpu, readback);
  }

  private finishTile(t0: number, cpu: number, readback: number): void {
    const ms = performance.now() - t0;
    this.stats.built++;
    this.stats.lastTileMs = ms;
    this.stats.lastTileCpuMs = cpu;
    this.stats.lastReadbackMs = readback;
    this.tileTotalMs += ms;
    this.stats.meanTileMs = this.tileTotalMs / this.stats.built;
    this.idxDirty = true;
  }

  /** Compiles every build program; with KHR_parallel_shader_compile without blocking the frame. */
  private *compileAll(): Generator<number, void> {
    const gl = this.gl;
    const t = performance.now();
    const par = gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null;
    const pending: [TileProg, WebGLProgram, WebGLShader, WebGLShader][] = [];
    for (const name of Object.keys(GLOBE_TILE_SOURCES) as TileProg[]) {
      if (this.progs[name]) continue;
      const [vsSrc, fsSrc] = GLOBE_TILE_SOURCES[name];
      const vs = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vs, vsSrc);
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(fs, fsSrc);
      gl.compileShader(fs);
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      pending.push([name, p, vs, fs]);
      if (!par) yield 0;
    }
    if (par) {
      while (pending.some(([, p]) => !gl.getProgramParameter(p, par.COMPLETION_STATUS_KHR))) yield WAIT;
    }
    for (const [name, p, vs, fs] of pending) {
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = `${gl.getShaderInfoLog(vs) ?? ''}${gl.getShaderInfoLog(fs) ?? ''}${gl.getProgramInfoLog(p) ?? ''}`;
        throw new Error(`[globe-tile-${name}] ${log}`);
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      this.progs[name] = p;
    }
    this.compiled = true;
    this.stats.compileMs = performance.now() - t;
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

  private tex2d(internal: number, w: number, linear = false): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, w);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private ensureScratch(D: number, nl: number): Scratch {
    const s0 = this.scratch;
    if (s0 && s0.D === D && s0.nl === nl) return s0;
    this.freeScratch();
    const gl = this.gl;
    const W = tileStride(this.lattice!);
    const r32 = (w: number): WebGLTexture => this.tex2d(gl.R32F, w);
    const rgba32 = (): WebGLTexture => this.tex2d(gl.RGBA32F, D);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, D, D);
    const pack = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, pack);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, W / 4, W);
    const pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, W * W * 4, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    const s: Scratch = {
      D, nl,
      macro: r32(nl), wl: r32(nl), coast: r32(nl), ctl: this.tex2d(gl.RGBA8, nl, true),
      cap: r32(D), depth, hA: r32(D), hB: r32(D),
      A0: rgba32(), A1: rgba32(), F0: rgba32(), F1: rgba32(), V: this.tex2d(gl.RG32F, D),
      low: r32(nl), low2: r32(nl), pack, pbo, segBuf: gl.createBuffer(), segVao: gl.createVertexArray(),
    };
    this.scratch = s;
    return s;
  }

  private freeScratch(): void {
    const s = this.scratch;
    if (!s) return;
    const gl = this.gl;
    for (const t of [s.macro, s.wl, s.coast, s.ctl, s.cap, s.hA, s.hB, s.A0, s.A1, s.F0, s.F1, s.V, s.low, s.low2, s.pack]) gl.deleteTexture(t);
    gl.deleteRenderbuffer(s.depth);
    gl.deleteBuffer(s.pbo);
    gl.deleteBuffer(s.segBuf);
    gl.deleteVertexArray(s.segVao);
    this.scratch = null;
  }

  /** Binds a program, the shared uniforms of the tile head and the given textures. */
  private use(name: TileProg, tp: TilePrep, s: Scratch, textures: Record<string, WebGLTexture>): WebGLProgram {
    const gl = this.gl;
    const p = this.progs[name]!;
    gl.useProgram(p);
    gl.uniform1i(this.loc(p, 'u_hasWater'), 1);
    gl.uniform1i(this.loc(p, 'u_n'), tp.nl);
    gl.uniform1f(this.loc(p, 'u_size'), tp.D * tp.texelM);
    gl.uniform1i(this.loc(p, 'u_D'), tp.D);
    const all: Record<string, WebGLTexture> = { u_macro: s.macro, u_wl: s.wl, u_coast: s.coast, ...textures };
    let unit = 0;
    for (const [k, t] of Object.entries(all)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(this.loc(p, k), unit);
      unit++;
    }
    for (let u = unit; u < this.unitsUsed; u++) {
      gl.activeTexture(gl.TEXTURE0 + u);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    this.unitsUsed = unit;
    return p;
  }

  private target(color: WebGLTexture[], w: number, h: number, depth: WebGLRenderbuffer | null = null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    for (let i = 0; i < 2; i++) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, color[i] ?? null, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.drawBuffers(color.length === 2 ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, w, h);
  }

  private quad(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private est(texels: number, weight: number): number {
    return Math.max(0.01, ((texels / 1e6) * weight) / this.opts.gpuMtexPerMs);
  }

  /** The GPU build of one tile into its slot; returns the readback time (ms). */
  private *gpuTile(tp: TilePrep, key: number): Generator<number, number> {
    const gl = this.gl;
    const o = this.opts;
    const lat = this.lattice!;
    const D = tp.D;
    const nl = tp.nl;
    const s = this.ensureScratch(D, nl);
    const upload = (t: WebGLTexture, data: ArrayBufferView, fmt: number, type: number): void => {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, nl, nl, fmt, type, data);
    };
    upload(s.macro, tp.macro, gl.RED, gl.FLOAT);
    upload(s.wl, tp.water, gl.RED, gl.FLOAT);
    upload(s.coast, tp.coast, gl.RED, gl.FLOAT);
    upload(s.ctl, tp.control, gl.RGBA, gl.UNSIGNED_BYTE);

    // 1. cap = min(water upper bound, carve profiles), depth-test MIN.
    const minDepth = (): void => {
      this.target([s.cap], D, D, s.depth);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
    };
    minDepth();
    gl.clearBufferfv(gl.COLOR, 0, [1e6, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    this.use('cap', tp, s, {});
    this.quad();
    yield this.est(D * D, 1);
    if (tp.segCount > 0) {
      gl.bindVertexArray(s.segVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, s.segBuf);
      gl.bufferData(gl.ARRAY_BUFFER, tp.segs, gl.STREAM_DRAW);
      gl.bindVertexArray(null);
      const CHUNK = 16384;
      for (let first = 0; first < tp.segCount; first += CHUNK) {
        const count = Math.min(CHUNK, tp.segCount - first);
        minDepth();
        this.use('carve', tp, s, {});
        gl.bindVertexArray(s.segVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, s.segBuf);
        for (let a = 0; a < 3; a++) {
          gl.enableVertexAttribArray(a);
          gl.vertexAttribPointer(a, 4, gl.FLOAT, false, SEG_FLOATS * 4, first * SEG_FLOATS * 4 + a * 16);
          gl.vertexAttribDivisor(a, 1);
        }
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.bindVertexArray(null);
        yield this.est(count * 4096, 2);
      }
    }
    gl.disable(gl.DEPTH_TEST);

    // 2. Base: Catmull-Rom macro + baked 3D noise + coastal noise, clamped.
    let hA = s.hA;
    let hB = s.hB;
    {
      const p = this.use('tbase', tp, s, { u_cap: s.cap, u_ctl: s.ctl });
      const g = tp.globe;
      const k3 = tp.face * 3;
      gl.uniform1ui(this.loc(p, 'u_seed'), g.seed >>> 0);
      gl.uniform1f(this.loc(p, 'u_bakeLam0'), g.bakeLam0);
      gl.uniform1i(this.loc(p, 'u_bakeOct'), g.bakeOct);
      gl.uniform1f(this.loc(p, 'u_bakeAmpScale'), g.bakeAmpScale);
      gl.uniform3f(this.loc(p, 'u_tC'), FACE_C[k3], FACE_C[k3 + 1], FACE_C[k3 + 2]);
      gl.uniform3f(this.loc(p, 'u_tE'), FACE_E[k3], FACE_E[k3 + 1], FACE_E[k3 + 2]);
      gl.uniform3f(this.loc(p, 'u_tS'), FACE_S[k3], FACE_S[k3 + 1], FACE_S[k3 + 2]);
      gl.uniform2f(this.loc(p, 'u_org'), tp.a0, tp.b0);
      gl.uniform1f(this.loc(p, 'u_delta'), tp.delta);
      gl.uniform1f(this.loc(p, 'u_R'), tp.radius);
      this.target([hA], D, D);
      this.quad();
      yield this.est(D * D, 6);
    }

    // 3. Thermal / hydraulic / thermal.
    const thermalA = Math.floor(o.thermalSteps / 2);
    const thermal = function* (this: GlobeDetail, steps: number): Generator<number, void> {
      for (let i = 0; i < steps; i++) {
        const p = this.use('thermal', tp, s, { u_h: hA, u_cap: s.cap });
        gl.uniform1f(this.loc(p, 'u_talus'), o.talus * tp.texelM);
        gl.uniform1f(this.loc(p, 'u_rate'), o.thermalRate);
        this.target([hB], D, D);
        this.quad();
        [hA, hB] = [hB, hA];
        yield this.est(D * D, 1.5);
      }
    };
    yield* thermal.call(this, thermalA);
    if (o.hydraulicSteps > 0) {
      this.use('copy', tp, s, { u_h: hA });
      this.target([hB], D, D);
      this.quad();
      const h = o.hydro;
      const setTile = (p: WebGLProgram): void => {
        gl.uniform1i(this.loc(p, 'u_T'), D);
        gl.uniform2i(this.loc(p, 'u_org'), 0, 0);
        gl.uniform1f(this.loc(p, 'u_dt'), h.dt);
        gl.uniform1f(this.loc(p, 'u_K'), h.K);
        gl.uniform1f(this.loc(p, 'u_rain'), h.rain);
      };
      let f = s.F0;
      let f2 = s.F1;
      let p = this.use('hinit', tp, s, { u_h: hA });
      gl.uniform2i(this.loc(p, 'u_org'), 0, 0);
      this.target([s.A0], D, D);
      this.quad();
      this.target([f], D, D);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      yield this.est(D * D, 0.8);
      for (let it = 0; it < o.hydraulicSteps; it++) {
        p = this.use('hflux', tp, s, { u_A: s.A0, u_F: f });
        setTile(p);
        this.target([f2], D, D);
        this.quad();
        [f, f2] = [f2, f];
        p = this.use('hwater', tp, s, { u_A: s.A0, u_F: f });
        setTile(p);
        gl.uniform1f(this.loc(p, 'u_Kc'), h.Kc);
        gl.uniform1f(this.loc(p, 'u_Ks'), h.Ks);
        gl.uniform1f(this.loc(p, 'u_Kd'), h.Kd);
        gl.uniform1f(this.loc(p, 'u_amin'), h.amin);
        gl.uniform1f(this.loc(p, 'u_dmax'), h.dmax);
        gl.uniform1f(this.loc(p, 'u_maxStep'), h.maxStep);
        this.target([s.A1, s.V], D, D);
        this.quad();
        p = this.use('hadvect', tp, s, { u_A: s.A1, u_F: f, u_V: s.V, u_h: hA, u_cap: s.cap });
        setTile(p);
        gl.uniform1f(this.loc(p, 'u_Ke'), h.Ke);
        this.target([s.A0], D, D);
        this.quad();
        yield this.est(D * D, 3);
      }
      p = this.use('hwrite', tp, s, { u_A: s.A0 });
      gl.uniform2i(this.loc(p, 'u_org'), 0, 0);
      this.target([hB], D, D);
      this.quad();
      [hA, hB] = [hB, hA];
      yield this.est(D * D, 0.3);
    }
    yield* thermal.call(this, o.thermalSteps - thermalA);

    // 4. Re-anchor low frequencies to the macro.
    {
      this.use('adown', tp, s, { u_h: hA });
      this.target([s.low], nl, nl);
      this.quad();
      let p = this.use('ablur', tp, s, { u_src: s.low });
      gl.uniform2i(this.loc(p, 'u_dir'), 1, 0);
      this.target([s.low2], nl, nl);
      this.quad();
      p = this.use('ablur', tp, s, { u_src: s.low2 });
      gl.uniform2i(this.loc(p, 'u_dir'), 0, 1);
      this.target([s.low], nl, nl);
      this.quad();
      p = this.use('afinal', tp, s, { u_h: hA, u_low: s.low, u_cap: s.cap });
      gl.uniform1f(this.loc(p, 'u_a'), o.anchorMetres);
      this.target([hB], D, D);
      this.quad();
      [hA, hB] = [hB, hA];
      yield this.est(D * D, 2);
    }

    // 5. Core + margin into the tile's slot; the shader may use it from the next frame on.
    const W = tileStride(lat);
    const off = lat.A - lat.M;
    const slot = this.cache!.slotOf.get(key);
    if (slot === undefined) return 0;
    {
      const p = this.use('textract', tp, s, { u_h: hA });
      gl.uniform1i(this.loc(p, 'u_off'), off);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.tileTex, 0, slot);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, null);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, W, W);
      this.quad();
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    }
    this.cache!.commit(key);
    this.idxDirty = true;
    if (!o.readback) return 0;

    // 6. Readback for CPU picking: 4 heights per RGBA32F texel into a PBO, then a fence.
    const tr = performance.now();
    {
      const p = this.use('tpack', tp, s, { u_h: hA });
      gl.uniform1i(this.loc(p, 'u_off'), off);
      this.target([s.pack], W / 4, W);
      this.quad();
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
      gl.readPixels(0, 0, W / 4, W, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    }
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (fence) {
      try {
        while (gl.clientWaitSync(fence, 0, 0) === gl.TIMEOUT_EXPIRED) yield WAIT;
      } finally {
        gl.deleteSync(fence);
      }
    }
    const out = new Float32Array(W * W);
    const chunk = 256 * 1024;
    for (let at = 0; at < W * W; at += chunk) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, at * 4, out, at, Math.min(chunk, W * W - at));
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      yield 0;
    }
    // The tile may have been evicted while the readback ran.
    if (this.cache!.slotOf.get(key) === slot) this.cache!.setData(key, out);
    return performance.now() - tr;
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
}

function setArrayParams(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

/** Can we render to R32F / RG32F / RGBA32F (the build's targets)? */
function probeFloatTargets(gl: WebGL2RenderingContext): boolean {
  const fb = gl.createFramebuffer();
  const prev = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  let ok = true;
  const texs: WebGLTexture[] = [];
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  for (const fmt of [gl.R32F, gl.RG32F, gl.RGBA32F]) {
    const t = gl.createTexture();
    texs.push(t);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, 4, 4);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) ok = false;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, prev);
  gl.deleteFramebuffer(fb);
  for (const t of texs) gl.deleteTexture(t);
  return ok;
}
