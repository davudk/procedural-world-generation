import { fmix32, hashMix, rngFor } from '../../../shared/hash';
import { RIVER, type RiverGraph } from '../../../shared/protocol';

/**
 * Close-zoom creeks (research 02 §8, option b): per-macro-cell deterministic growth.
 *
 * Every land macro cell owns one **trunk**: a smooth curve along its D8 path from its centre to its
 * receiver's centre (or onto the macro river, or into a lake / the sea). Trunks are a pure function of the
 * macro rasters, so they are global. Creek **heads** are Poisson-disk samples inside the cell; each walks
 * downhill on the rendered terrain (`heightAt`) until it meets a trunk, a creek of the same cell, the macro
 * river, a lake or the sea. A cell's output therefore depends only on (seed, cell, macro data): cells can be
 * generated in any order or batch and come out byte-identical.
 *
 * Coordinates are MAP metres (x from the west edge, y from the north edge), like `RiverGraph`.
 */
export interface CreekInput {
  /** Macro grid side (cells). */
  n: number;
  /** Macro cell size (m). */
  cellM: number;
  /** Carved macro elevation (m), row 0 = north (hydro `elevation` layer). */
  elevation: Float32Array;
  /** Raw hydro `waterClass` (0 land, 1 ocean, 2 lake, 3 wide river, 4 wetland, 5 playa, 6 salt lake). Not the dilated render copy. */
  waterClass: Uint8Array | Float32Array;
  /** Hydro `discharge` layer: log10 of mean annual discharge (m³/s), −3 on the sea. */
  dischargeLog: Float32Array;
  /** Macro river graph (map metres). */
  rivers: RiverGraph;
  seed: number;
  /** Rendered-terrain raw elevation (m) at map coordinates (may include the shader's detail octaves). */
  heightAt: (xMapM: number, yMapM: number) => number;
  /** Optional local runoff per cell (mm/yr). Default: specific discharge Q/A of the cell, smoothed 3×3. */
  runoff?: Float32Array;
}

export interface CreekOptions {
  /** Only the cell's trunk (cheap tier for 20–60 m/px). The trunk is identical to the one in a full cell. */
  trunksOnly?: boolean;
}

/** Creek source area A_c0 (km²) in humid climates (research 02 §3.1, §10.2 `creekSourceArea`). */
export const CREEK_SOURCE_AREA = 0.2;
const SECONDS_PER_YEAR = 31_557_600;
const W_OCEAN = 1;
const W_LAKE = 2;
const W_RIVER = 3;
const W_SALT = 6;
/** Cell kinds. */
const K_TRUNK = 0;
const K_RIVER = 1;
const K_WET = 2;
const K_SINK = 3;
/** Raw trunk end kinds. */
const E_TRUNK = 0;
const E_RIVER = 1;
const E_WET = 2;
const E_SINK = 3;
/** Segment kinds in the per-cell grid. */
const S_RIVER = 0;
const S_TRUNK = 1;
const S_CREEK = 2;
/** Trunk memo is dropped when it grows past this many trunks (it is a pure cache). */
const TRUNK_MEMO_CAP = 40_000;

const D8X = [1, 0, -1, 0, 1, -1, -1, 1];
const D8Y = [0, 1, 0, -1, 1, 1, -1, -1];
const D8D = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

interface RawTrunk {
  xs: Float64Array;
  ys: Float64Array;
  /** Segments = points − 1. */
  segs: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  endKind: number;
}

/** A trunk after cutting at rivers, water and larger trunks; with its water surface. */
export interface Trunk {
  cell: number;
  xs: Float64Array;
  ys: Float64Array;
  zs: Float64Array;
  /** Points (≥ 2). */
  count: number;
  /** Cut position as raw segment index + fraction (for crossing tests against the raw curve). */
  cutParam: number;
  endFlag: number;
  areaKm2: number;
  q: number;
  width: number;
  depth: number;
  strahler: number;
  ephemeral: boolean;
}

/** Hydraulic geometry for small channels (research 02 §3.5), clamped to creek sizes. */
function geometry(areaKm2: number, runoffMm: number): { q: number; width: number; depth: number } {
  const q = (areaKm2 * 1e6 * runoffMm) / 1000 / SECONDS_PER_YEAR;
  const arid = runoffMm < 100 ? 1.5 : 1;
  return {
    q,
    width: Math.min(8, Math.max(1, 4 * arid * Math.sqrt(q))),
    depth: Math.min(1.5, Math.max(0.1, 0.35 * Math.pow(q, 0.4))),
  };
}

/** Smooth value noise in [−1, 1] on a unit lattice (deterministic, position-only). */
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const h = (i: number, j: number): number => fmix32(hashMix(hashMix(seed, i), j)) / 2147483648 - 1;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * sx;
  const b = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * sx;
  return a + (b - a) * sy;
}

/** Segment p→q against a→b: parameter t on p→q in [0, 1] and u on a→b, or −1. */
let hitU = 0;
function segHit(px: number, py: number, qx: number, qy: number, ax: number, ay: number, bx: number, by: number): number {
  const rx = qx - px;
  const ry = qy - py;
  const sx = bx - ax;
  const sy = by - ay;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return -1;
  const wx = ax - px;
  const wy = ay - py;
  const t = (wx * sy - wy * sx) / den;
  if (t < 0 || t > 1) return -1;
  const u = (wx * ry - wy * rx) / den;
  if (u < 0 || u > 1) return -1;
  hitU = u;
  return t;
}

/**
 * Per-cell segment grid over the 5×5-cell window around the cell being grown: macro river segments, trunks,
 * and this cell's creeks as they are emitted. Reused across calls (module scratch, reset per cell).
 */
class SegGrid {
  ox = 0;
  oy = 0;
  bin = 1;
  nb = 1;
  head: Int32Array = new Int32Array(1);
  count = 0;
  next: Int32Array = new Int32Array(1024);
  ax: Float64Array = new Float64Array(1024);
  ay: Float64Array = new Float64Array(1024);
  bx: Float64Array = new Float64Array(1024);
  by: Float64Array = new Float64Array(1024);
  za: Float64Array = new Float64Array(1024);
  zb: Float64Array = new Float64Array(1024);
  kind: Uint8Array = new Uint8Array(1024);
  ref: Int32Array = new Int32Array(1024);
  sub: Int32Array = new Int32Array(1024);
  /** Bin entries: linked list nodes (segment id, next). */
  eSeg: Int32Array = new Int32Array(4096);
  eNext: Int32Array = new Int32Array(4096);
  eCount = 0;

  reset(ox: number, oy: number, size: number, nb: number): void {
    this.ox = ox;
    this.oy = oy;
    this.nb = nb;
    this.bin = size / nb;
    if (this.head.length < nb * nb) this.head = new Int32Array(nb * nb);
    this.head.fill(-1, 0, nb * nb);
    this.count = 0;
    this.eCount = 0;
    this.boxOn = false;
  }

  private growSegs(): void {
    const cap = this.ax.length * 2;
    const f = (a: Float64Array): Float64Array => {
      const b = new Float64Array(cap);
      b.set(a);
      return b;
    };
    const i32 = (a: Int32Array): Int32Array => {
      const b = new Int32Array(cap);
      b.set(a);
      return b;
    };
    this.ax = f(this.ax);
    this.ay = f(this.ay);
    this.bx = f(this.bx);
    this.by = f(this.by);
    this.za = f(this.za);
    this.zb = f(this.zb);
    const k = new Uint8Array(cap);
    k.set(this.kind);
    this.kind = k;
    this.ref = i32(this.ref);
    this.sub = i32(this.sub);
    this.next = i32(this.next);
  }

  add(ax: number, ay: number, bx: number, by: number, kind: number, ref: number, sub: number, za: number, zb: number): void {
    const { ox, oy, bin, nb } = this;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - ox) / bin));
    const i1 = Math.min(nb - 1, Math.floor((Math.max(ax, bx) - ox) / bin));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - oy) / bin));
    const j1 = Math.min(nb - 1, Math.floor((Math.max(ay, by) - oy) / bin));
    if (i0 > i1 || j0 > j1) return;
    if (this.count >= this.ax.length) this.growSegs();
    const s = this.count++;
    this.ax[s] = ax;
    this.ay[s] = ay;
    this.bx[s] = bx;
    this.by[s] = by;
    this.za[s] = za;
    this.zb[s] = zb;
    this.kind[s] = kind;
    this.ref[s] = ref;
    this.sub[s] = sub;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (this.eCount >= this.eSeg.length) {
          const a = new Int32Array(this.eSeg.length * 2);
          a.set(this.eSeg);
          this.eSeg = a;
          const b = new Int32Array(this.eNext.length * 2);
          b.set(this.eNext);
          this.eNext = b;
        }
        const e = this.eCount++;
        const b = j * nb + i;
        this.eSeg[e] = s;
        this.eNext[e] = this.head[b];
        this.head[b] = e;
      }
    }
  }

  /** Earliest crossing of p→q with any stored segment: returns t (or −1); sets hitSeg / hitSegU. */
  hitSeg = -1;
  hitSegU = 0;
  firstHit(px: number, py: number, qx: number, qy: number): number {
    const { ox, oy, bin, nb } = this;
    const i0 = Math.max(0, Math.floor((Math.min(px, qx) - ox) / bin));
    const i1 = Math.min(nb - 1, Math.floor((Math.max(px, qx) - ox) / bin));
    const j0 = Math.max(0, Math.floor((Math.min(py, qy) - oy) / bin));
    const j1 = Math.min(nb - 1, Math.floor((Math.max(py, qy) - oy) / bin));
    let best = 2;
    this.hitSeg = -1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (let e = this.head[j * nb + i]; e >= 0; e = this.eNext[e]) {
          const s = this.eSeg[e];
          const t = segHit(px, py, qx, qy, this.ax[s], this.ay[s], this.bx[s], this.by[s]);
          if (t >= 0 && (t < best || (t === best && s < this.hitSeg))) {
            best = t;
            this.hitSeg = s;
            this.hitSegU = hitU;
          }
        }
      }
    }
    return this.hitSeg >= 0 ? best : -1;
  }

  /** Nearest point on any segment within maxR of p: returns the distance (Infinity if none); sets nearX/Y. */
  nearX = 0;
  nearY = 0;
  nearSeg = -1;
  nearU = 0;
  /** Optional clip box for `nearest` (only points inside it count). */
  boxOn = false;
  bx0 = 0;
  by0 = 0;
  bx1 = 0;
  by1 = 0;

  nearest(px: number, py: number, maxR: number): number {
    const { ox, oy, bin, nb } = this;
    const ci = Math.floor((px - ox) / bin);
    const cj = Math.floor((py - oy) / bin);
    let best = maxR * maxR;
    let found = false;
    const rings = Math.min(nb, Math.ceil(maxR / bin) + 1);
    for (let r = 0; r <= rings; r++) {
      if (found && (r - 1) * bin > Math.sqrt(best)) break;
      for (let j = cj - r; j <= cj + r; j++) {
        if (j < 0 || j >= nb) continue;
        const edge = j === cj - r || j === cj + r;
        for (let i = ci - r; i <= ci + r; i += edge ? 1 : 2 * r) {
          if (i >= 0 && i < nb) {
            for (let e = this.head[j * nb + i]; e >= 0; e = this.eNext[e]) {
              const s = this.eSeg[e];
              const ax = this.ax[s];
              const ay = this.ay[s];
              const dx = this.bx[s] - ax;
              const dy = this.by[s] - ay;
              const l2 = dx * dx + dy * dy;
              let t0 = 0;
              let t1 = 1;
              if (this.boxOn) {
                // Liang–Barsky: the part of the segment inside the box.
                const p = [-dx, dx, -dy, dy];
                const q = [ax - this.bx0, this.bx1 - ax, ay - this.by0, this.by1 - ay];
                for (let k = 0; k < 4 && t0 <= t1; k++) {
                  if (p[k] === 0) {
                    if (q[k] < 0) t1 = -1;
                  } else {
                    const r = q[k] / p[k];
                    if (p[k] < 0) t0 = Math.max(t0, r);
                    else t1 = Math.min(t1, r);
                  }
                }
                if (t0 > t1) continue;
              }
              const t = l2 > 0 ? Math.min(t1, Math.max(t0, ((px - ax) * dx + (py - ay) * dy) / l2)) : t0;
              const x = ax + dx * t;
              const y = ay + dy * t;
              const d2 = (x - px) * (x - px) + (y - py) * (y - py);
              if (d2 < best) {
                best = d2;
                this.nearX = x;
                this.nearY = y;
                this.nearSeg = s;
                this.nearU = t;
                found = true;
              }
            }
          }
          if (r === 0) break;
        }
      }
    }
    return found ? Math.sqrt(best) : Infinity;
  }
}

const grid = new SegGrid();

/** One creek during growth. */
interface Creek {
  xs: number[];
  ys: number[];
  hs: number[];
  /** Join: kind (−1 none / mouth / sink), and for creek joins the target creek, segment and fraction. */
  endFlag: number;
  joinCreek: number;
  joinSub: number;
  joinU: number;
  /** End water level to clamp to (−Infinity = none). */
  endZ: number;
  /** Tributaries joining this creek: creek ids (positions in the tribs' join fields). */
  tribs: number[];
  share: number;
}

/**
 * Macro-derived, deterministic precomputation shared by every cell (cached per input object):
 * D8 receivers with crossing-diagonal fixes, accumulated area, Strahler order, trunk start water levels,
 * river anchors and a per-cell bucket of river segments.
 */
export class CreekContext {
  readonly n: number;
  readonly cellM: number;
  readonly cellKm2: number;
  readonly seed: number;
  readonly rcv: Int32Array;
  /** Accumulated D8 area in cells. */
  readonly areaCells: Float32Array;
  readonly mainDonor: Int32Array;
  readonly order: Uint8Array;
  /** Water surface at each trunk's start (cell centre), monotone along rcv. */
  readonly startZ: Float32Array;
  readonly kind: Uint8Array;
  readonly anchor: Int32Array;
  readonly runoffMm: Float32Array;
  /** Channel-head area of the macro river graph (km²): creeks and trunks stay below it. */
  readonly thresholdKm2: number;
  readonly stats = { creeks: 0, sinks: 0, trunkCuts: 0, forcedJoins: 0, forcedEdge: 0, forcedStuck: 0, danglingEnds: 0, prepareMs: 0 };
  readonly step: number;
  private readonly cls: Uint8Array;
  private readonly rStart: Uint32Array;
  private readonly rList: Int32Array;
  private readonly rStamp: Int32Array;
  private stampId = 0;
  private readonly rawMemo = new Map<number, RawTrunk | null>();
  private readonly cutMemo = new Map<number, Trunk | null>();

  constructor(readonly input: CreekInput) {
    const t0 = performance.now();
    const { n, cellM, elevation: z, rivers: g } = input;
    const N = n * n;
    this.n = n;
    this.cellM = cellM;
    this.cellKm2 = (cellM / 1000) ** 2;
    this.seed = input.seed >>> 0;
    this.step = Math.min(40, Math.max(20, cellM / 32));
    const cls = new Uint8Array(N);
    for (let i = 0; i < N; i++) cls[i] = Math.round(input.waterClass[i]);
    this.cls = cls;

    // River cells and anchors (node nearest the cell centre).
    const anchor = new Int32Array(N).fill(-1);
    const best = new Float64Array(N).fill(Infinity);
    const cellOf = (x: number, y: number): number =>
      Math.min(n - 1, Math.max(0, Math.floor(y / cellM))) * n + Math.min(n - 1, Math.max(0, Math.floor(x / cellM)));
    for (let i = 0; i < g.n; i++) {
      const c = cellOf(g.x[i], g.y[i]);
      const cx = ((c % n) + 0.5) * cellM;
      const cy = (Math.floor(c / n) + 0.5) * cellM;
      const d = (g.x[i] - cx) ** 2 + (g.y[i] - cy) ** 2;
      if (d < best[c] || (d === best[c] && i < anchor[c])) {
        best[c] = d;
        anchor[c] = i;
      }
    }
    this.anchor = anchor;
    const kind = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const w = cls[i];
      if (w === W_OCEAN || w === W_LAKE || w === W_RIVER || w === W_SALT) kind[i] = K_WET;
      else if (anchor[i] >= 0) kind[i] = K_RIVER;
      else kind[i] = K_TRUNK;
    }

    // River segment buckets (CSR over the cells each segment's bbox touches).
    const cnt = new Uint32Array(N + 1);
    const visit = (i: number, f: (c: number) => void): void => {
      const d = g.down[i];
      const x0 = Math.min(g.x[i], g.x[d]);
      const x1 = Math.max(g.x[i], g.x[d]);
      const y0 = Math.min(g.y[i], g.y[d]);
      const y1 = Math.max(g.y[i], g.y[d]);
      const i0 = Math.max(0, Math.floor(x0 / cellM));
      const i1 = Math.min(n - 1, Math.floor(x1 / cellM));
      const j0 = Math.max(0, Math.floor(y0 / cellM));
      const j1 = Math.min(n - 1, Math.floor(y1 / cellM));
      for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) f(j * n + k);
    };
    for (let i = 0; i < g.n; i++) if (g.down[i] >= 0) visit(i, (c) => cnt[c + 1]++);
    for (let c = 0; c < N; c++) cnt[c + 1] += cnt[c];
    const rList = new Int32Array(cnt[N]);
    const fill = cnt.slice(0, N);
    for (let i = 0; i < g.n; i++) if (g.down[i] >= 0) visit(i, (c) => (rList[fill[c]++] = i));
    this.rStart = cnt;
    this.rList = rList;
    this.rStamp = new Int32Array(g.n);

    // D8 steepest descent on land (river cells included, for accumulation); ties keep the first direction.
    const rcv = new Int32Array(N).fill(-1);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (kind[i] === K_WET) continue;
        let bs = 0;
        for (let k = 0; k < 8; k++) {
          const nx = x + D8X[k];
          const ny = y + D8Y[k];
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const j = ny * n + nx;
          const s = (z[i] - z[j]) / D8D[k];
          if (s > bs) {
            bs = s;
            rcv[i] = j;
          }
        }
      }
    }
    // (Pure steepest descent never produces crossing diagonals in a 2×2 block, so no fix-up pass is needed;
    // crossings introduced by the curve smoothing are resolved when trunks are cut.)
    for (let i = 0; i < N; i++) {
      if (kind[i] === K_TRUNK && rcv[i] < 0) {
        kind[i] = K_SINK;
        this.stats.sinks++;
      }
    }
    this.kind = kind;
    this.rcv = rcv;

    // Topological order (sources first), area, main donor, Strahler.
    const indeg = new Int32Array(N);
    for (let i = 0; i < N; i++) if (rcv[i] >= 0) indeg[rcv[i]]++;
    const topo = new Int32Array(N);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < N; i++) if (indeg[i] === 0) topo[tail++] = i;
    const area = new Float32Array(N);
    const mx = new Uint8Array(N);
    const mc = new Uint8Array(N);
    const order = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (kind[i] !== K_WET) area[i] = 1;
    while (head < tail) {
      const i = topo[head++];
      order[i] = mx[i] === 0 ? 1 : mc[i] >= 2 ? mx[i] + 1 : mx[i];
      const r = rcv[i];
      if (r < 0) continue;
      area[r] += area[i];
      if (order[i] > mx[r]) {
        mx[r] = order[i];
        mc[r] = 1;
      } else if (order[i] === mx[r]) mc[r]++;
      if (--indeg[r] === 0) topo[tail++] = r;
    }
    const mainDonor = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      const r = rcv[i];
      if (r < 0) continue;
      const m = mainDonor[r];
      if (m < 0 || area[i] > area[m]) mainDonor[r] = i;
    }
    this.areaCells = area;
    this.mainDonor = mainDonor;
    this.order = order;

    // Threshold: smallest area at a macro river source.
    let th = Infinity;
    for (let i = 0; i < g.n; i++) if (g.flags[i] & RIVER.SOURCE && !(g.flags[i] & RIVER.DISTRIBUTARY)) th = Math.min(th, g.area[i]);
    this.thresholdKm2 = Number.isFinite(th) && th > 0 ? th : 8;

    // Runoff (mm/yr): given, or specific discharge Q/A, smoothed 3×3 over land.
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (input.runoff) raw[i] = input.runoff[i];
      else if (kind[i] !== K_WET) {
        const q = Math.pow(10, input.dischargeLog[i]);
        raw[i] = Math.min(3000, (q * SECONDS_PER_YEAR * 1000) / (area[i] * this.cellKm2 * 1e6));
      }
    }
    const runoff = new Float32Array(N);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let s = 0;
        let w = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= n || ny >= n || kind[ny * n + nx] === K_WET) continue;
            s += raw[ny * n + nx];
            w++;
          }
        }
        runoff[y * n + x] = w > 0 ? s / w : raw[y * n + x];
      }
    }
    this.runoffMm = runoff;

    // Trunk start levels: running minimum downstream of (z − depth), then lifted to each trunk's end level.
    const startZ = new Float32Array(N);
    const up = new Float64Array(N).fill(Infinity);
    for (let k = 0; k < tail; k++) {
      const i = topo[k];
      if (kind[i] === K_WET) continue;
      const v = Math.min(z[i] - this.trunkGeom(i).depth, up[i]);
      startZ[i] = v;
      const r = rcv[i];
      if (r >= 0) up[r] = Math.min(up[r], v);
    }
    for (let k = tail - 1; k >= 0; k--) {
      const i = topo[k];
      if (kind[i] !== K_TRUNK) continue;
      const r = rcv[i];
      const e = kind[r] === K_TRUNK || kind[r] === K_SINK ? startZ[r] : kind[r] === K_RIVER ? g.zWater[anchor[r]] : -Infinity;
      if (e > startZ[i]) startZ[i] = e;
    }
    this.startZ = startZ;
    this.stats.prepareMs = performance.now() - t0;
  }

  /** Visible drainage area of a cell's trunk (km²), 0 when the cell has no trunk. */
  trunkAreaKm2(c: number): number {
    return this.kind[c] === K_TRUNK ? Math.min(this.areaCells[c] * this.cellKm2, 0.98 * this.thresholdKm2) : 0;
  }

  /** True when the cell grows creeks (land, including cells crossed by the macro river). */
  hasCreeks(c: number): boolean {
    return this.kind[c] !== K_WET;
  }

  private trunkGeom(c: number): { q: number; width: number; depth: number } {
    return geometry(Math.min(this.areaCells[c] * this.cellKm2, 0.98 * this.thresholdKm2), this.runoffMm ? this.runoffMm[c] : 500);
  }

  private centre(c: number): [number, number] {
    return [((c % this.n) + 0.5) * this.cellM, (Math.floor(c / this.n) + 0.5) * this.cellM];
  }

  /** Where a trunk ending at cell r lands. */
  private target(r: number): [number, number] {
    if (this.kind[r] === K_RIVER) {
      const a = this.anchor[r];
      return [this.input.rivers.x[a], this.input.rivers.y[a]];
    }
    return this.centre(r);
  }

  private cellClass(x: number, y: number): number {
    const { n, cellM } = this;
    const i = Math.floor(x / cellM);
    const j = Math.floor(y / cellM);
    if (i < 0 || j < 0 || i >= n || j >= n) return W_OCEAN;
    return this.cls[j * n + i];
  }

  /** The raw (uncut) trunk curve of a cell: Catmull-Rom through D8 centres plus a seeded bow. */
  raw(c: number): RawTrunk | null {
    const memo = this.rawMemo.get(c);
    if (memo !== undefined) return memo;
    if (this.rawMemo.size > TRUNK_MEMO_CAP) this.rawMemo.clear();
    let out: RawTrunk | null = null;
    if (this.kind[c] === K_TRUNK) {
      const r = this.rcv[c];
      const [p1x, p1y] = this.centre(c);
      const [p2x, p2y] = this.target(r);
      const md = this.mainDonor[c];
      const [p0x, p0y] = md >= 0 && this.kind[md] === K_TRUNK ? this.centre(md) : [2 * p1x - p2x, 2 * p1y - p2y];
      const rr = this.kind[r] === K_TRUNK ? this.rcv[r] : -1;
      const [p3x, p3y] = rr >= 0 && this.kind[rr] !== K_WET ? this.target(rr) : [2 * p2x - p1x, 2 * p2y - p1y];
      const chord = Math.hypot(p2x - p1x, p2y - p1y);
      const m = Math.max(2, Math.ceil(chord / (1.6 * this.step)));
      const bow = (fmix32(hashMix(hashMix(this.seed, 0x7c1), c)) / 4294967296 - 0.5) * 0.16 * chord;
      const nx = chord > 0 ? -(p2y - p1y) / chord : 0;
      const ny = chord > 0 ? (p2x - p1x) / chord : 0;
      const xs = new Float64Array(m + 1);
      const ys = new Float64Array(m + 1);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = 0; k <= m; k++) {
        const t = k / m;
        const t2 = t * t;
        const t3 = t2 * t;
        const b0 = -0.5 * t3 + t2 - 0.5 * t;
        const b1 = 1.5 * t3 - 2.5 * t2 + 1;
        const b2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
        const b3 = 0.5 * t3 - 0.5 * t2;
        const off = bow * Math.sin(Math.PI * t);
        const x = k === 0 ? p1x : k === m ? p2x : b0 * p0x + b1 * p1x + b2 * p2x + b3 * p3x + off * nx;
        const y = k === 0 ? p1y : k === m ? p2y : b0 * p0y + b1 * p1y + b2 * p2y + b3 * p3y + off * ny;
        xs[k] = x;
        ys[k] = y;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      const k = this.kind[r];
      const endKind = k === K_RIVER ? E_RIVER : k === K_WET ? E_WET : k === K_SINK ? E_SINK : E_TRUNK;
      out = { xs, ys, segs: m, x0, y0, x1, y1, endKind };
    }
    this.rawMemo.set(c, out);
    return out;
  }

  /** Larger trunk wins a crossing: key order (area, then index). */
  private bigger(b: number, c: number): boolean {
    const ab = this.areaCells[b];
    const ac = this.areaCells[c];
    return ab > ac || (ab === ac && b > c);
  }

  /** River segments crossing p→q: earliest t, setting riverHitNode / riverHitU. */
  private riverHitNode = -1;
  private riverHitU = 0;
  private riverHit(px: number, py: number, qx: number, qy: number): number {
    const { n, cellM } = this;
    const g = this.input.rivers;
    const i0 = Math.max(0, Math.floor(Math.min(px, qx) / cellM));
    const i1 = Math.min(n - 1, Math.floor(Math.max(px, qx) / cellM));
    const j0 = Math.max(0, Math.floor(Math.min(py, qy) / cellM));
    const j1 = Math.min(n - 1, Math.floor(Math.max(py, qy) / cellM));
    let best = 2;
    this.riverHitNode = -1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * n + i;
        for (let k = this.rStart[c]; k < this.rStart[c + 1]; k++) {
          const s = this.rList[k];
          const d = g.down[s];
          const t = segHit(px, py, qx, qy, g.x[s], g.y[s], g.x[d], g.y[d]);
          if (t >= 0 && (t < best || (t === best && s < this.riverHitNode))) {
            best = t;
            this.riverHitNode = s;
            this.riverHitU = hitU;
          }
        }
      }
    }
    return this.riverHitNode >= 0 ? best : -1;
  }

  /** A cell's trunk cut at the macro river, water and larger crossing trunks, with its water surface. */
  trunk(c: number): Trunk | null {
    const memo = this.cutMemo.get(c);
    if (memo !== undefined) return memo;
    if (this.cutMemo.size > TRUNK_MEMO_CAP) this.cutMemo.clear();
    const raw = this.raw(c);
    let out: Trunk | null = null;
    if (raw) out = this.cutTrunk(c, raw);
    this.cutMemo.set(c, out);
    return out;
  }

  private cutTrunk(c: number, raw: RawTrunk): Trunk {
    const { n } = this;
    const g = this.input.rivers;
    const { xs, ys, segs } = raw;
    const r = this.rcv[c];
    let cut = segs; // param (segment + fraction)
    let flag: number = raw.endKind === E_SINK ? RIVER.SINK_DRY : RIVER.CONFLUENCE;
    let endZ = raw.endKind === E_TRUNK || raw.endKind === E_SINK ? this.startZ[r] : raw.endKind === E_RIVER ? g.zWater[this.anchor[r]] : -Infinity;
    // Water and macro rivers, walking down the curve.
    for (let k = 0; k < segs; k++) {
      const t = this.riverHit(xs[k], ys[k], xs[k + 1], ys[k + 1]);
      if (t >= 0 && !(raw.endKind === E_RIVER && k === segs - 1 && t > 0.999)) {
        cut = k + t;
        flag = RIVER.CONFLUENCE;
        const s = this.riverHitNode;
        endZ = g.zWater[s] + (g.zWater[g.down[s]] - g.zWater[s]) * this.riverHitU;
        break;
      }
      const w = this.cellClass(xs[k + 1], ys[k + 1]);
      if (w === W_OCEAN || w === W_LAKE || w === W_RIVER || w === W_SALT) {
        cut = k + 1;
        flag = w === W_OCEAN ? RIVER.MOUTH_SEA : w === W_RIVER ? RIVER.CONFLUENCE : RIVER.MOUTH_LAKE;
        endZ = -Infinity;
        break;
      }
    }
    // Larger trunks crossing the remaining curve (recursing only on actual raw crossings).
    const cx = c % n;
    const cy = Math.floor(c / n);
    let joined = -1;
    let joinParam = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const bx = cx + dx;
        const by = cy + dy;
        if (bx < 0 || by < 0 || bx >= n || by >= n || (dx === 0 && dy === 0)) continue;
        const b = by * n + bx;
        // Trunks sharing an end point with this one (receiver, donors, siblings) still count, away from that point.
        if (this.kind[b] !== K_TRUNK || b === r || !this.bigger(b, c)) continue;
        const rb = this.raw(b)!;
        if (rb.x0 > raw.x1 || rb.x1 < raw.x0 || rb.y0 > raw.y1 || rb.y1 < raw.y0) continue;
        let tb: Trunk | null = null;
        for (let k = 0; k < Math.ceil(cut) && k < segs; k++) {
          const ax = xs[k];
          const ay = ys[k];
          const qx = xs[k + 1];
          const qy = ys[k + 1];
          if (Math.max(ax, qx) < rb.x0 || Math.min(ax, qx) > rb.x1 || Math.max(ay, qy) < rb.y0 || Math.min(ay, qy) > rb.y1) continue;
          for (let m = 0; m < rb.segs; m++) {
            const t = segHit(ax, ay, qx, qy, rb.xs[m], rb.ys[m], rb.xs[m + 1], rb.ys[m + 1]);
            if (t < 0 || k + t >= cut || k + t <= 1e-9) continue;
            const hx = ax + (qx - ax) * t;
            const hy = ay + (qy - ay) * t;
            if ((hx - xs[0]) ** 2 + (hy - ys[0]) ** 2 < 0.25 || (hx - xs[segs]) ** 2 + (hy - ys[segs]) ** 2 < 0.25) continue;
            const pb = m + hitU;
            tb ??= this.trunk(b);
            if (!tb || pb > tb.cutParam) continue;
            cut = k + t;
            joined = b;
            joinParam = pb;
          }
        }
      }
    }
    if (joined >= 0) {
      const tb = this.trunk(joined)!;
      flag = RIVER.CONFLUENCE;
      endZ = this.zAtParam(tb, joinParam);
      this.stats.trunkCuts++;
    }
    // Emit the prefix up to the cut.
    const kEnd = Math.max(1, Math.min(segs, Math.ceil(cut - 1e-9)));
    const frac = cut - (kEnd - 1);
    const count = kEnd + 1;
    const ox = new Float64Array(count);
    const oy = new Float64Array(count);
    for (let k = 0; k < kEnd; k++) {
      ox[k] = xs[k];
      oy[k] = ys[k];
    }
    ox[kEnd] = xs[kEnd - 1] + (xs[kEnd] - xs[kEnd - 1]) * frac;
    oy[kEnd] = ys[kEnd - 1] + (ys[kEnd] - ys[kEnd - 1]) * frac;
    const geo = this.trunkGeom(c);
    const zs = new Float64Array(count);
    const z0 = this.startZ[c];
    let run = z0;
    const h = this.input.heightAt;
    for (let k = 0; k < count; k++) {
      if (k > 0) run = Math.min(run, h(ox[k], oy[k]) - geo.depth);
      zs[k] = run;
    }
    if (endZ > -Infinity) {
      const e = Math.min(endZ, z0);
      for (let k = 0; k < count; k++) zs[k] = Math.max(zs[k], e);
      zs[count - 1] = e;
    }
    return {
      cell: c, xs: ox, ys: oy, zs, count, cutParam: cut, endFlag: flag,
      areaKm2: this.trunkAreaKm2(c), q: geo.q, width: geo.width, depth: geo.depth,
      strahler: Math.min(255, this.order[c] + 1), ephemeral: this.runoffMm[c] < 100,
    };
  }

  /** Water level on a cut trunk at a raw-curve parameter. */
  private zAtParam(t: Trunk, p: number): number {
    const k = Math.min(t.count - 2, Math.floor(p));
    const f = Math.min(1, Math.max(0, p - k));
    // The last emitted segment is a partial raw segment: rescale its fraction.
    if (k === t.count - 2) {
      const last = t.cutParam - k;
      const ff = last > 0 ? Math.min(1, f / last) : 1;
      return t.zs[k] + (t.zs[k + 1] - t.zs[k]) * ff;
    }
    return t.zs[k] + (t.zs[k + 1] - t.zs[k]) * f;
  }

  // ---- Per-cell growth ------------------------------------------------------------------------

  /** Creeks (and the trunk) of one macro cell as a reach-ordered RiverGraph. */
  cell(c: number, opts: CreekOptions = {}): RiverGraph {
    const out = new CellBuilder();
    const t = this.trunk(c);
    if (t) out.addTrunk(t, this.mainDonor[c] < 0 || this.kind[this.mainDonor[c]] === K_WET);
    if (!opts.trunksOnly && this.kind[c] !== K_WET) this.growCreeks(c, out);
    return out.finish();
  }

  private growCreeks(c: number, out: CellBuilder): void {
    const { n, cellM, step } = this;
    const g = this.input.rivers;
    const h = this.input.heightAt;
    const cx = c % n;
    const cy = Math.floor(c / n);
    const hx = (cx + 0.5) * cellM;
    const hy = (cy + 0.5) * cellM;
    grid.reset((cx - 2) * cellM, (cy - 2) * cellM, 5 * cellM, 40);
    const stamp = ++this.stampId;
    const sinks: number[] = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const bx = cx + dx;
        const by = cy + dy;
        if (bx < 0 || by < 0 || bx >= n || by >= n) continue;
        const b = by * n + bx;
        for (let k = this.rStart[b]; k < this.rStart[b + 1]; k++) {
          const s = this.rList[k];
          if (this.rStamp[s] === stamp) continue;
          this.rStamp[s] = stamp;
          const d = g.down[s];
          grid.add(g.x[s], g.y[s], g.x[d], g.y[d], S_RIVER, s, 0, g.zWater[s], g.zWater[d]);
        }
        if (this.kind[b] === K_SINK) sinks.push(b);
        const t = this.trunk(b);
        if (!t) continue;
        for (let k = 0; k + 1 < t.count; k++) grid.add(t.xs[k], t.ys[k], t.xs[k + 1], t.ys[k + 1], S_TRUNK, b, k, t.zs[k], t.zs[k + 1]);
      }
    }
    const rng = rngFor(this.seed, 'creeks', c);
    const runoff = this.runoffMm[c];
    const fClimate = runoff >= 100 ? 1 : runoff >= 20 ? 0.8 : 0.8 + ((20 - Math.max(0, runoff)) / 20) * 1.7;
    const ac = CREEK_SOURCE_AREA * fClimate;
    const nHeads = Math.min(64, Math.max(1, Math.round((this.cellKm2 / ac) * (0.8 + 0.4 * rng.float()))));
    const rDisk = 0.5 * Math.sqrt(ac) * 1000;
    const excl = 0.3 * Math.sqrt(ac) * 1000;
    const hxs: number[] = [];
    const hys: number[] = [];
    const hhs: number[] = [];
    for (let a = 0; a < nHeads * 10 && hxs.length < nHeads; a++) {
      const x = (cx + rng.float()) * cellM;
      const y = (cy + rng.float()) * cellM;
      let ok = true;
      for (let k = 0; k < hxs.length && ok; k++) if ((hxs[k] - x) ** 2 + (hys[k] - y) ** 2 < rDisk * rDisk) ok = false;
      if (!ok || grid.nearest(x, y, excl) < excl) continue;
      hxs.push(x);
      hys.push(y);
      hhs.push(h(x, y));
    }
    const idx = hxs.map((_, i) => i).sort((a, b) => hhs[b] - hhs[a] || a - b);
    const creeks: Creek[] = [];
    const share = this.cellKm2 / Math.max(1, idx.length);
    const e = 0.5 * step;
    // Creeks stay inside their own cell (so creeks of different cells can never cross); channels they
    // aim for are searched inside the cell too. Every cell holds one: its trunk start, the macro river or a sink.
    const lim = 0.5 * cellM - 0.5;
    grid.boxOn = true;
    grid.bx0 = hx - lim;
    grid.by0 = hy - lim;
    grid.bx1 = hx + lim;
    grid.by1 = hy + lim;
    const maxSteps = Math.ceil((2.5 * cellM) / step);
    const nseed = hashMix(this.seed, 0x5eed);
    for (const hi of idx) {
      let px = hxs[hi];
      let py = hys[hi];
      let ph = hhs[hi];
      const cr: Creek = { xs: [px], ys: [py], hs: [ph], endFlag: -1, joinCreek: -1, joinSub: 0, joinU: 0, endZ: -Infinity, tribs: [], share };
      let pdx = 0;
      let pdy = 0;
      let tx = 0;
      let ty = 0;
      let tAge = 99;
      let travelled = 0;
      let done = false;
      // Gradient scale: fine first; a walk caught in a pit of the detail surface retries on coarser scales
      // (a cheap stand-in for fill-and-spill) before it connects straight to a channel.
      let coarse = 0;
      for (let s = 0; s < maxSteps && !done; s++) {
        let gx: number;
        let gy: number;
        if (coarse === 0) {
          gx = (h(px + e, py) - ph) / e;
          gy = (h(px, py + e) - ph) / e;
        } else {
          const ge = coarse === 1 ? 2 * step : 6 * step;
          gx = (h(px + ge, py) - h(px - ge, py)) / (2 * ge);
          gy = (h(px, py + ge) - h(px, py - ge)) / (2 * ge);
        }
        const gl = Math.hypot(gx, gy);
        let dx = 0;
        let dy = 0;
        let ux = 0;
        let uy = 0;
        if (gl > 1e-5) {
          ux = -gx / gl;
          uy = -gy / gl;
          // Gentle meander: rotate by smooth position noise.
          const th = 0.45 * valueNoise(px / 170, py / 170, nseed);
          const co = Math.cos(th);
          const si = Math.sin(th);
          dx = ux * co - uy * si;
          dy = ux * si + uy * co;
        }
        // Momentum; in a valley floor the downhill vector flips side every step, so lean on the previous
        // heading (the cross-valley parts cancel and the walk follows the valley axis).
        const mom = dx * pdx + dy * pdy < 0.2 ? 1.2 : 0.45;
        dx += mom * pdx;
        dy += mom * pdy;
        // Attraction to the nearest channel: always a little (dendritic convergence), more on flats and late.
        // Attraction to the nearest channel: a little everywhere (dendritic convergence), strong on flats,
        // late in the walk and near the cell edge, so creeks bend into a channel instead of leaving the cell.
        const edge = Math.max(Math.abs(px - hx), Math.abs(py - hy)) / cellM;
        const ew = Math.min(1, Math.max(0, (edge - 0.28) / 0.17));
        const edgeW = ew * ew * (3 - 2 * ew);
        let wa = 0.3 + (gl < 0.004 ? 1.5 : 0) + 2.5 * edgeW + Math.max(0, travelled / cellM - 0.8) * 3 + 1.2 * coarse;
        if (tAge >= (wa > 1 ? 2 : 4)) {
          const d = grid.nearest(px, py, 1.5 * cellM);
          if (d < Infinity) {
            tx = grid.nearX;
            ty = grid.nearY;
          } else wa = 0;
          tAge = 0;
        }
        tAge++;
        const tl = Math.hypot(tx - px, ty - py);
        if (wa > 0 && tl > 1e-6) {
          const ax = (tx - px) / tl;
          const ay = (ty - py) / tl;
          // On real slopes keep the step clearly downhill.
          if (gl >= 0.01 && ax * ux + ay * uy < 0 && wa < 1) wa *= 0.2;
          dx += wa * ax;
          dy += wa * ay;
        }
        let dl = Math.hypot(dx, dy);
        if (dl < 1e-9) {
          dx = tl > 1e-6 ? (tx - px) / tl : 1;
          dy = tl > 1e-6 ? (ty - py) / tl : 0;
          dl = 1;
        }
        dx /= dl;
        dy /= dl;
        if (gl >= 0.01 && dx * ux + dy * uy < 0.3 && wa < 1) {
          // Still too much across-slope: fall back to the downhill direction blended with momentum.
          dx = ux + 0.3 * pdx;
          dy = uy + 0.3 * pdy;
          dl = Math.hypot(dx, dy);
          dx /= dl;
          dy /= dl;
        }
        const qx = px + dx * step;
        const qy = py + dy * step;
        if (Math.abs(qx - hx) > lim || Math.abs(qy - hy) > lim) {
          this.stats.forcedEdge++;
          break;
        }
        if (this.tryEnd(cr, px, py, qx, qy, sinks)) {
          done = true;
          break;
        }
        // Never cross the own path; circling in a pit: coarser gradient, then connect straight.
        let loop = false;
        for (let k = 0; k + 2 < cr.xs.length && !loop; k++) loop = segHit(px, py, qx, qy, cr.xs[k], cr.ys[k], cr.xs[k + 1], cr.ys[k + 1]) >= 0;
        const back = cr.xs.length - 8;
        const circling = back >= 0 && (cr.xs[back] - qx) ** 2 + (cr.ys[back] - qy) ** 2 < 4 * step * step;
        if (loop || circling) {
          if (coarse >= 2) {
            this.stats.forcedStuck++;
            break;
          }
          coarse++;
          pdx = 0;
          pdy = 0;
          if (loop) continue;
        }
        px = qx;
        py = qy;
        ph = h(px, py);
        cr.xs.push(px);
        cr.ys.push(py);
        cr.hs.push(ph);
        pdx = dx;
        pdy = dy;
        travelled += step;
      }
      if (!done) this.forceJoin(cr, px, py, sinks);
      // Register the finished creek so later (lower) heads can join it.
      const id = creeks.length;
      creeks.push(cr);
      this.stats.creeks++;
      if (cr.joinCreek >= 0) creeks[cr.joinCreek].tribs.push(id);
      for (let k = 0; k + 1 < cr.xs.length; k++) grid.add(cr.xs[k], cr.ys[k], cr.xs[k + 1], cr.ys[k + 1], S_CREEK, id, k, 0, 0);
    }
    grid.boxOn = false;
    this.emitCreeks(creeks, out, runoff);
  }

  /** Ends the creek if p→q meets a channel, water or a sink; appends the end point. */
  private tryEnd(cr: Creek, px: number, py: number, qx: number, qy: number, sinks: number[]): boolean {
    const t = grid.firstHit(px, py, qx, qy);
    if (t >= 0) {
      this.joinAt(cr, px + (qx - px) * t, py + (qy - py) * t, grid.hitSeg, grid.hitSegU);
      return true;
    }
    // Close enough to a channel (also catches near-parallel approaches): snap onto it.
    const joinR = 0.3 * this.step;
    if (grid.nearest(qx, qy, joinR) < joinR) {
      const nx = grid.nearX;
      const ny = grid.nearY;
      const ns = grid.nearSeg;
      const nu = grid.nearU;
      // The path onto the snap point may clip a neighbouring segment first (near a vertex): take that.
      const l = Math.hypot(nx - px, ny - py) || 1;
      const t2 = grid.firstHit(px, py, nx + ((nx - px) / l) * 0.01, ny + ((ny - py) / l) * 0.01);
      if (t2 >= 0 && grid.hitSeg !== ns) {
        const ex = nx + ((nx - px) / l) * 0.01;
        const ey = ny + ((ny - py) / l) * 0.01;
        this.joinAt(cr, px + (ex - px) * t2, py + (ey - py) * t2, grid.hitSeg, grid.hitSegU);
      } else this.joinAt(cr, nx, ny, ns, nu);
      return true;
    }
    const w = this.cellClass(qx, qy);
    if (w === W_OCEAN || w === W_LAKE || w === W_RIVER || w === W_SALT) {
      cr.xs.push(qx);
      cr.ys.push(qy);
      cr.hs.push(this.input.heightAt(qx, qy));
      cr.endFlag = w === W_OCEAN ? RIVER.MOUTH_SEA : w === W_RIVER ? RIVER.CONFLUENCE : RIVER.MOUTH_LAKE;
      return true;
    }
    for (const s of sinks) {
      const [sx, sy] = this.centre(s);
      if ((sx - qx) ** 2 + (sy - qy) ** 2 < this.step * this.step) {
        cr.xs.push(sx);
        cr.ys.push(sy);
        cr.hs.push(this.input.heightAt(sx, sy));
        cr.endFlag = RIVER.SINK_DRY;
        return true;
      }
    }
    return false;
  }

  private joinAt(cr: Creek, x: number, y: number, s: number, u: number): void {
    const n = cr.xs.length;
    this.eraseLoop(cr, cr.xs[n - 1], cr.ys[n - 1], x, y);
    cr.xs.push(x);
    cr.ys.push(y);
    cr.hs.push(this.input.heightAt(x, y));
    cr.endFlag = RIVER.CONFLUENCE;
    if (grid.kind[s] === S_CREEK) {
      cr.joinCreek = grid.ref[s];
      cr.joinSub = grid.sub[s];
      cr.joinU = u;
    } else {
      cr.endZ = grid.za[s] + (grid.zb[s] - grid.za[s]) * u;
    }
  }

  /**
   * Loop erasure: if the straight line p→t crosses the creek's own path, cut the path back to the crossing
   * (the last one along the line) and return it as the new start.
   */
  private eraseLoop(cr: Creek, px: number, py: number, tx: number, ty: number): [number, number] {
    let best = -1;
    let bk = -1;
    let bu = 0;
    for (let k = 0; k + 2 < cr.xs.length; k++) {
      const t = segHit(px, py, tx, ty, cr.xs[k], cr.ys[k], cr.xs[k + 1], cr.ys[k + 1]);
      if (t > best) {
        best = t;
        bk = k;
        bu = hitU;
      }
    }
    if (bk < 0) return [px, py];
    const x = cr.xs[bk] + (cr.xs[bk + 1] - cr.xs[bk]) * bu;
    const y = cr.ys[bk] + (cr.ys[bk + 1] - cr.ys[bk]) * bu;
    const hh = cr.hs[bk] + (cr.hs[bk + 1] - cr.hs[bk]) * bu;
    cr.xs.length = cr.ys.length = cr.hs.length = bk + 1;
    cr.xs.push(x);
    cr.ys.push(y);
    cr.hs.push(hh);
    return [x, y];
  }

  /** Straight connection to the nearest channel (cut at anything met on the way), or a dry end. */
  private forceJoin(cr: Creek, px: number, py: number, sinks: number[]): void {
    this.stats.forcedJoins++;
    const d = grid.nearest(px, py, 3 * this.cellM);
    let tx = grid.nearX;
    let ty = grid.nearY;
    if (d === Infinity) {
      if (!sinks.length) {
        cr.endFlag = RIVER.SINK_DRY;
        this.stats.danglingEnds++;
        return;
      }
      [tx, ty] = this.centre(sinks[0]);
    }
    [px, py] = this.eraseLoop(cr, px, py, tx, ty);
    // Aim a hair past the target so the crossing test catches it.
    const len = Math.hypot(tx - px, ty - py);
    const ex = len > 0 ? tx + ((tx - px) / len) * 0.01 : tx;
    const ey = len > 0 ? ty + ((ty - py) / len) * 0.01 : ty;
    if (this.tryEnd(cr, px, py, ex, ey, sinks)) return;
    cr.xs.push(tx);
    cr.ys.push(ty);
    cr.hs.push(this.input.heightAt(tx, ty));
    // Parallel approach (no proper crossing): the end still lies on the channel or at the sink centre.
    cr.endFlag = d === Infinity ? RIVER.SINK_DRY : RIVER.CONFLUENCE;
  }

  /** Areas, orders and levels for the cell's creeks, then reach-ordered nodes. */
  private emitCreeks(creeks: Creek[], out: CellBuilder, runoff: number): void {
    const K = creeks.length;
    if (K === 0) return;
    const head0 = 0.35;
    // Cumulative own length per creek, end areas and orders (tributaries are created after their target).
    const cum: number[][] = [];
    for (const cr of creeks) {
      const a: number[] = [0];
      for (let k = 1; k < cr.xs.length; k++) a.push(a[k - 1] + Math.hypot(cr.xs[k] - cr.xs[k - 1], cr.ys[k] - cr.ys[k - 1]));
      cum.push(a);
    }
    const endArea = new Float64Array(K);
    const endOrder = new Uint8Array(K);
    /** Junctions per creek: [param (sub + u), tributary id], sorted. */
    const junc: [number, number][][] = creeks.map(() => []);
    for (let k = 0; k < K; k++) {
      // A join exactly at the target's last point becomes a junction just before it.
      const pMax = creeks[k].xs.length - 1 - 1e-6;
      for (const t of creeks[k].tribs) {
        const p = Math.min(pMax, creeks[t].joinSub + creeks[t].joinU);
        creeks[t].joinSub = Math.floor(p);
        creeks[t].joinU = p - Math.floor(p);
        junc[k].push([p, t]);
      }
    }
    for (const j of junc) j.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (let k = K - 1; k >= 0; k--) {
      let a = creeks[k].share;
      let o = 1;
      for (const [, t] of junc[k]) {
        a += endArea[t];
        o = endOrder[t] > o ? endOrder[t] : endOrder[t] === o ? o + 1 : o;
      }
      endArea[k] = a;
      endOrder[k] = o;
    }
    // Node lists with junction nodes inserted; levels forward (targets before tributaries).
    const nodeBase = new Int32Array(K);
    const juncNode: number[][] = creeks.map(() => []);
    interface P {
      x: number;
      y: number;
      hgt: number;
      s: number;
      param: number;
      j: number;
    }
    const lists: P[][] = [];
    let total = out.size;
    for (let k = 0; k < K; k++) {
      const cr = creeks[k];
      const L: P[] = [];
      let ji = 0;
      const J = junc[k];
      for (let i = 0; i < cr.xs.length; i++) {
        while (ji < J.length && J[ji][0] < i) {
          const p = J[ji][0];
          const sub = Math.floor(p);
          const u = p - sub;
          const x = cr.xs[sub] + (cr.xs[sub + 1] - cr.xs[sub]) * u;
          const y = cr.ys[sub] + (cr.ys[sub + 1] - cr.ys[sub]) * u;
          const hgt = cr.hs[sub] + (cr.hs[sub + 1] - cr.hs[sub]) * u;
          const s = cum[k][sub] + (cum[k][sub + 1] - cum[k][sub]) * u;
          L.push({ x, y, hgt, s, param: p, j: J[ji][1] });
          ji++;
        }
        L.push({ x: cr.xs[i], y: cr.ys[i], hgt: cr.hs[i], s: cum[k][i], param: i, j: -1 });
      }
      lists.push(L);
      nodeBase[k] = total;
      for (let i = 0; i < L.length; i++) if (L[i].j >= 0) juncNode[k].push(total + i);
      total += L.length;
    }
    const zOf: Float64Array[] = [];
    const paramOf: Float64Array[] = [];
    for (let k = 0; k < K; k++) {
      const cr = creeks[k];
      const L = lists[k];
      const Ltot = cum[k][cum[k].length - 1] || 1;
      const area = new Float64Array(L.length);
      let inflow = 0;
      for (let i = 0; i < L.length; i++) {
        if (L[i].j >= 0) inflow += endArea[L[i].j];
        area[i] = cr.share * (head0 + (1 - head0) * Math.min(1, L[i].s / Ltot)) + inflow;
      }
      let endZ = cr.endZ;
      if (cr.joinCreek >= 0) endZ = zAt(zOf[cr.joinCreek], paramOf[cr.joinCreek], cr.joinSub + cr.joinU);
      const z = new Float64Array(L.length);
      let run = Infinity;
      const geos = Array.from(area, (a) => geometry(a, runoff));
      for (let i = 0; i < L.length; i++) {
        run = Math.min(run, L[i].hgt - geos[i].depth);
        z[i] = run;
      }
      if (endZ > -Infinity) {
        // Join at the receiving channel's level (water may sit slightly above a head that walked uphill).
        for (let i = 0; i < L.length; i++) z[i] = Math.max(z[i], endZ);
        z[L.length - 1] = endZ;
      }
      zOf.push(z);
      paramOf.push(Float64Array.from(L, (p) => p.param));
      // Emit: pieces split at junction nodes (each junction node starts a new reach).
      let order = 1;
      const ephemeral = runoff < 100 ? RIVER.EPHEMERAL : 0;
      for (let i = 0; i < L.length; i++) {
        if (i === 0 || L[i].j >= 0) out.beginReach();
        if (L[i].j >= 0) {
          const o = endOrder[L[i].j];
          order = o > order ? o : o === order ? order + 1 : order;
        }
        let f = ephemeral;
        if (i === 0) f |= RIVER.SOURCE;
        if (L[i].j >= 0) f |= RIVER.CONFLUENCE;
        if (i === L.length - 1 && cr.endFlag > 0) f |= cr.endFlag;
        const gi = geos[i];
        const at = out.size;
        out.node(L[i].x, L[i].y, z[i], z[i] - gi.depth, gi.q, area[i], gi.width, gi.depth, order, f);
        if (i > 0 && L[i].j >= 0) out.link(at - 1, at);
      }
    }
    // Downstream links of creek mouths that join another creek of this cell.
    for (let k = 0; k < K; k++) {
      const cr = creeks[k];
      if (cr.joinCreek < 0) continue;
      const target = cr.joinCreek;
      const pos = juncIndex(lists[target], k);
      out.link(nodeBase[k] + lists[k].length - 1, nodeBase[target] + pos);
    }
  }
}

function zAt(z: Float64Array, param: Float64Array, p: number): number {
  for (let i = 0; i + 1 < z.length; i++) {
    if (param[i + 1] >= p) {
      const span = param[i + 1] - param[i];
      const f = span > 0 ? Math.min(1, Math.max(0, (p - param[i]) / span)) : 0;
      return z[i] + (z[i + 1] - z[i]) * f;
    }
  }
  return z[z.length - 1];
}

function juncIndex(list: { j: number }[], trib: number): number {
  for (let i = 0; i < list.length; i++) if (list[i].j === trib) return i;
  throw new Error('creeks: junction node missing');
}

/** Growable per-cell graph (reach-ordered), finished into the protocol's typed arrays. */
class CellBuilder {
  private readonly f: number[][] = [[], [], [], [], [], [], [], [], [], []];
  private readonly down: number[] = [];
  private readonly flags: number[] = [];
  private readonly rs: number[] = [];
  private readonly rl: number[] = [];

  get size(): number {
    return this.down.length;
  }

  beginReach(): void {
    this.rs.push(this.down.length);
    this.rl.push(0);
  }

  node(x: number, y: number, zw: number, zb: number, q: number, area: number, width: number, depth: number, strahler: number, flags: number): void {
    const r = this.rl.length - 1;
    const i = this.down.length;
    if (this.rl[r] > 0) this.down[i - 1] = i;
    const v = [x, y, zw, zb, q, area, width, depth, strahler];
    for (let k = 0; k < 9; k++) this.f[k].push(v[k]);
    this.down.push(-1);
    this.flags.push(flags);
    this.rl[r]++;
  }

  link(from: number, to: number): void {
    this.down[from] = to;
  }

  addTrunk(t: Trunk, source: boolean): void {
    this.beginReach();
    for (let k = 0; k < t.count; k++) {
      let f = t.ephemeral ? RIVER.EPHEMERAL : 0;
      if (k === 0 && source) f |= RIVER.SOURCE;
      if (k === t.count - 1) f |= t.endFlag;
      this.node(t.xs[k], t.ys[k], t.zs[k], t.zs[k] - t.depth, t.q, t.areaKm2, t.width, t.depth, t.strahler, f);
    }
  }

  finish(): RiverGraph {
    const n = this.down.length;
    const nr = this.rs.length;
    const area = Float32Array.from(this.f[5]);
    const down = Int32Array.from(this.down);
    const reachStart = Uint32Array.from(this.rs);
    const reachLen = Uint32Array.from(this.rl);
    const reachDown = new Int32Array(nr).fill(-1);
    const reachMinArea = new Float32Array(nr);
    // Reach of each node start, to resolve reachDown.
    const startOf = new Map<number, number>();
    for (let r = 0; r < nr; r++) startOf.set(reachStart[r], r);
    for (let r = 0; r < nr; r++) {
      const last = reachStart[r] + reachLen[r] - 1;
      const d = down[last];
      reachDown[r] = d >= 0 ? (startOf.get(d) ?? -1) : -1;
      let m = Infinity;
      for (let i = reachStart[r]; i <= last; i++) m = Math.min(m, area[i]);
      reachMinArea[r] = Number.isFinite(m) ? m : 0;
    }
    return {
      n,
      x: Float32Array.from(this.f[0]),
      y: Float32Array.from(this.f[1]),
      zWater: Float32Array.from(this.f[2]),
      zBed: Float32Array.from(this.f[3]),
      q: Float32Array.from(this.f[4]),
      area,
      width: Float32Array.from(this.f[6]),
      depth: Float32Array.from(this.f[7]),
      strahler: Uint8Array.from(this.f[8]),
      down,
      flags: Uint16Array.from(this.flags),
      reachStart,
      reachLen,
      reachDown,
      reachMinArea,
    };
  }
}

/** Empty graph. */
export function emptyGraph(): RiverGraph {
  return mergeGraphs([]);
}

/** Concatenates graphs (node and reach indices offset). */
export function mergeGraphs(parts: readonly RiverGraph[]): RiverGraph {
  let n = 0;
  let nr = 0;
  for (const p of parts) {
    n += p.n;
    nr += p.reachStart.length;
  }
  const g: RiverGraph = {
    n,
    x: new Float32Array(n), y: new Float32Array(n), zWater: new Float32Array(n), zBed: new Float32Array(n),
    q: new Float32Array(n), area: new Float32Array(n), width: new Float32Array(n), depth: new Float32Array(n),
    strahler: new Uint8Array(n), down: new Int32Array(n), flags: new Uint16Array(n),
    reachStart: new Uint32Array(nr), reachLen: new Uint32Array(nr), reachDown: new Int32Array(nr), reachMinArea: new Float32Array(nr),
  };
  let o = 0;
  let ro = 0;
  for (const p of parts) {
    g.x.set(p.x, o);
    g.y.set(p.y, o);
    g.zWater.set(p.zWater, o);
    g.zBed.set(p.zBed, o);
    g.q.set(p.q, o);
    g.area.set(p.area, o);
    g.width.set(p.width, o);
    g.depth.set(p.depth, o);
    g.strahler.set(p.strahler, o);
    g.flags.set(p.flags, o);
    for (let i = 0; i < p.n; i++) g.down[o + i] = p.down[i] >= 0 ? p.down[i] + o : -1;
    for (let r = 0; r < p.reachStart.length; r++) {
      g.reachStart[ro + r] = p.reachStart[r] + o;
      g.reachLen[ro + r] = p.reachLen[r];
      g.reachDown[ro + r] = p.reachDown[r] >= 0 ? p.reachDown[r] + ro : -1;
      g.reachMinArea[ro + r] = p.reachMinArea[r];
    }
    o += p.n;
    ro += p.reachStart.length;
  }
  return g;
}

const contexts = new WeakMap<CreekInput, CreekContext>();

/** The shared precomputation for an input (built once per input object, O(n²)). */
export function prepareCreeks(input: CreekInput): CreekContext {
  let ctx = contexts.get(input);
  if (!ctx) {
    ctx = new CreekContext(input);
    contexts.set(input, ctx);
  }
  return ctx;
}

/** Creeks of the given macro cells (row-major cell ids), concatenated in iteration order. */
export function generateCreeks(input: CreekInput, cells: Iterable<number>, opts: CreekOptions = {}): RiverGraph {
  const ctx = prepareCreeks(input);
  const parts: RiverGraph[] = [];
  for (const c of cells) parts.push(ctx.cell(c, opts));
  return mergeGraphs(parts);
}
