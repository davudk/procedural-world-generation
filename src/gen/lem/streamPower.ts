import type { Rng } from '../../shared/rng';
import { createPriorityFloodScratch, priorityFloodEpsilon, type PriorityFloodScratch } from '../grid/priorityFlood';

/**
 * Landscape evolution: uplift + stream-power incision (Braun & Willett 2013 implicit O(n) solver,
 * n = 1) + hillslope diffusion + talus clamp on a square grid (research 01 §3).
 */

export interface LemParams {
  /** Area exponent; the slope exponent is 1 (implicit linear solve). */
  m: number;
  /** Years per iteration. */
  dt: number;
  iterations: number;
  /** Effective hillslope diffusivity, m²/yr (explicit, sub-stepped for stability). */
  kd: number;
  /** Max stable slope tan(θ) for the talus clamp. */
  talus: number;
  /** The first k iterations pick receivers among downslope neighbours with p ∝ slope⁴ (breaks D8 bias). */
  stochasticIterations: number;
  /** No diffusion in the final k iterations (keeps crests sharp). */
  diffusionOffLast: number;
}

export const DEFAULT_LEM_PARAMS: Readonly<LemParams> = {
  m: 0.4,
  dt: 2.5e5,
  iterations: 80,
  kd: 1,
  talus: 0.5,
  stochasticIterations: 40,
  diffusionOffLast: 10,
};

export interface LemStrata {
  /** Layer thickness per cell (m); 0 = no strata there. */
  thickness: Float32Array;
  /** Fraction of each layer that is hard caprock (K × 1). */
  capFraction: number;
  /** K multiplier of the soft part of each layer (> 1). */
  softRatio: number;
}

export interface LemInput {
  n: number;
  cellM: number;
  /** Elevation (m, sea level 0); modified in place. */
  h: Float32Array;
  /** Uplift, m/yr. */
  U: Float32Array;
  /** Erodibility, m^(1−2m)/yr. */
  K: Float32Array;
  /** 1 = base level (ocean / open edge): never uplifted or eroded. */
  fixed: Uint8Array;
  /** Runoff weight per cell for drainage area (default 1). */
  rain?: Float32Array;
  strata?: LemStrata;
}

export interface LemProfile {
  uplift: number;
  flood: number;
  receivers: number;
  stack: number;
  area: number;
  incision: number;
  diffusion: number;
  talus: number;
}

export interface LemResult {
  h: Float32Array;
  /** Rain-weighted drainage area, m² (routed on the final surface). */
  area: Float32Array;
  /** Receiver per cell on the depression-filled final surface (self for fixed cells). */
  rcv: Int32Array;
  iterations: number;
  ms: number;
  /** Total ms per phase across all iterations. */
  profile: LemProfile;
}

/** Non-fixed cells never go below this (m), so the land fraction cannot shrink. */
export const LAND_MIN = 0.1;
/** Hack-like area–distance coefficient, A ≈ HACK_COEF·s² (research 01 §3.1). */
export const HACK_COEF = 0.3;
/**
 * Measured relief / upliftForPeak prediction on a uniform strip at the default parameters
 * (tests/lem.test.ts reports it). upliftForPeak divides it out.
 */
export const RELIEF_CALIBRATION = 1.2;

const CHECKPOINT_EVERY = 2;
const FLOOD_EPS = 1e-3;
const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];
const DIAG = [true, false, true, false, false, true, false, true];

const offsets = (n: number): Int32Array => Int32Array.from(DX, (dx, k) => DY[k] * n + dx);

function outside(x: number, y: number, k: number, n: number): boolean {
  const nx = x + DX[k];
  const ny = y + DY[k];
  return nx < 0 || ny < 0 || nx >= n || ny >= n;
}

/**
 * Uplift rate (m/yr) giving roughly `targetPeakM` of steady-state relief for a range of half-width
 * `halfWidthM`: integrates S = U/(K·A^m) with A = HACK_COEF·s² from the first resolved cell to the
 * range half-width (research 01 §3.1, any m).
 */
export function upliftForPeak(targetPeakM: number, K: number, m: number, halfWidthM: number, cellM: number): number {
  const s0 = cellM;
  const W = Math.max(halfWidthM, 2 * cellM);
  const e = 1 - 2 * m;
  const integral = Math.abs(e) < 1e-9 ? Math.log(W / s0) : (W ** e - s0 ** e) / e;
  return (targetPeakM * K * HACK_COEF ** m) / (integral * RELIEF_CALIBRATION);
}

/**
 * D8 flow routing on a depression-filled copy of a surface: receivers, Braun–Willett stack and
 * rain-weighted drainage area. All buffers are allocated once and reused per call.
 */
export class FlowRouter {
  readonly cells: number;
  /** Receiver per cell; self for fixed cells. */
  readonly rcv: Int32Array;
  /** Distance to the receiver (m); 0 for fixed cells. */
  readonly rdist: Float32Array;
  /** Cells ordered so every receiver precedes its donors; the first `stackLen` entries are valid. */
  readonly stack: Int32Array;
  stackLen = 0;
  /** Rain-weighted drainage area (m²) including the cell itself; fixed cells only collect inflow. */
  readonly area: Float64Array;
  readonly filled: Float32Array;
  private readonly donStart: Int32Array;
  private readonly donPos: Int32Array;
  private readonly donList: Int32Array;
  private readonly flood: PriorityFloodScratch;
  private readonly w = new Float64Array(8);
  private readonly ks = new Int32Array(8);
  private readonly dist: Float64Array;
  private readonly invDist: Float64Array;

  constructor(
    readonly n: number,
    readonly cellM: number,
    readonly fixed: Uint8Array,
  ) {
    const N = n * n;
    this.cells = N;
    this.rcv = new Int32Array(N);
    this.rdist = new Float32Array(N);
    this.stack = new Int32Array(N);
    this.area = new Float64Array(N);
    this.filled = new Float32Array(N);
    this.donStart = new Int32Array(N + 1);
    this.donPos = new Int32Array(N);
    this.donList = new Int32Array(N);
    this.flood = createPriorityFloodScratch(N);
    this.dist = Float64Array.from(DIAG, (d) => (d ? Math.SQRT2 : 1) * cellM);
    this.invDist = this.dist.map((d) => 1 / d);
  }

  /** Priority-Flood+ε of `h` into `filled`, seeded from the fixed cells. */
  fill(h: Float32Array): void {
    priorityFloodEpsilon(h, this.n, this.fixed, this.filled, FLOOD_EPS, this.flood);
  }

  /**
   * Steepest-descent receivers on `filled`. With an rng, picks among all lower neighbours with
   * probability ∝ slope⁴ instead (cells visited in index order, so the draw sequence is fixed).
   */
  receivers(rng: Rng | null): void {
    const { n, fixed, filled, rcv, rdist, dist, invDist, w, ks } = this;
    const off = offsets(n);
    for (let y = 0; y < n; y++) {
      const edgeRow = y === 0 || y === n - 1;
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (fixed[i]) {
          rcv[i] = i;
          rdist[i] = 0;
          continue;
        }
        const edge = edgeRow || x === 0 || x === n - 1;
        const zi = filled[i];
        let best = -1;
        if (rng) {
          let cnt = 0;
          let sum = 0;
          for (let k = 0; k < 8; k++) {
            if (edge && outside(x, y, k, n)) continue;
            const s = (zi - filled[i + off[k]]) * invDist[k];
            if (s <= 0) continue;
            const s2 = s * s;
            w[cnt] = s2 * s2;
            sum += w[cnt];
            ks[cnt++] = k;
          }
          if (cnt > 0) {
            let r = rng.float() * sum;
            let c = 0;
            while (c < cnt - 1 && r >= w[c]) r -= w[c++];
            best = ks[c];
          }
        } else {
          let bestS = 0;
          for (let k = 0; k < 8; k++) {
            if (edge && outside(x, y, k, n)) continue;
            const s = (zi - filled[i + off[k]]) * invDist[k];
            if (s > bestS) {
              bestS = s;
              best = k;
            }
          }
        }
        if (best < 0) throw new Error(`FlowRouter: cell ${i} has no lower neighbour after filling`);
        rcv[i] = i + off[best];
        rdist[i] = dist[best];
      }
    }
  }

  /** Donor CSR and the receiver-before-donor stack (breadth-first from each base-level root). */
  buildStack(): void {
    const { cells: N, rcv, donStart, donPos, donList, stack } = this;
    donStart.fill(0);
    for (let i = 0; i < N; i++) if (rcv[i] !== i) donStart[rcv[i] + 1]++;
    for (let i = 0; i < N; i++) donStart[i + 1] += donStart[i];
    donPos.set(donStart.subarray(0, N));
    for (let i = 0; i < N; i++) {
      const r = rcv[i];
      if (r !== i) donList[donPos[r]++] = i;
    }
    let top = 0;
    for (let root = 0; root < N; root++) {
      if (rcv[root] !== root || donStart[root] === donStart[root + 1]) continue;
      stack[top++] = root;
      for (let k = top - 1; k < top; k++) {
        const c = stack[k];
        for (let d = donStart[c], end = donStart[c + 1]; d < end; d++) stack[top++] = donList[d];
      }
    }
    this.stackLen = top;
  }

  /** Drainage area: cellM²·rain on non-fixed cells, summed downstream along the stack. */
  accumulate(rain?: Float32Array): void {
    const { cells: N, fixed, area, rcv, stack } = this;
    const a = this.cellM * this.cellM;
    for (let i = 0; i < N; i++) area[i] = fixed[i] ? 0 : rain ? a * rain[i] : a;
    for (let k = this.stackLen - 1; k >= 0; k--) {
      const i = stack[k];
      const r = rcv[i];
      if (r !== i) area[r] += area[i];
    }
  }

  /** fill + receivers + stack + area in one call. */
  route(h: Float32Array, rng: Rng | null, rain?: Float32Array): void {
    this.fill(h);
    this.receivers(rng);
    this.buildStack();
    this.accumulate(rain);
  }
}

const zeroProfile = (): LemProfile => ({ uplift: 0, flood: 0, receivers: 0, stack: 0, area: 0, incision: 0, diffusion: 0, talus: 0 });

/**
 * Runs the LEM in place on `input.h`. Deterministic for a given rng state. `checkpoint` is awaited
 * every few iterations and may throw to cancel; `onIteration` sees the surface after each iteration.
 */
export async function runLem(
  input: LemInput,
  p: LemParams,
  rng: Rng,
  checkpoint?: () => Promise<void>,
  onIteration?: (i: number, h: Float32Array) => void,
): Promise<LemResult> {
  const t0 = performance.now();
  const { n, cellM, h, U, K, fixed, rain, strata } = input;
  const N = n * n;
  for (const [name, a] of [['h', h], ['U', U], ['K', K], ['fixed', fixed], ['rain', rain], ['strata.thickness', strata?.thickness]] as const) {
    if (a && a.length !== N) throw new Error(`runLem: ${name} has ${a.length} cells, expected ${N}`);
  }
  let land = 0;
  for (let i = 0; i < N; i++) if (!fixed[i]) land++;
  if (land === N) throw new Error('runLem: needs at least one fixed (base-level) cell');

  const router = new FlowRouter(n, cellM, fixed);
  const { rcv, rdist, stack, area } = router;
  const am = new Float64Array(N);
  const tmp = new Float32Array(N);
  const rim = rimMask(fixed, n);
  const prof = zeroProfile();
  const { m, dt } = p;
  let t = performance.now();
  const lap = (key: keyof LemProfile): void => {
    const now = performance.now();
    prof[key] += now - t;
    t = now;
  };

  for (let i = 0; i < N; i++) if (!fixed[i] && !(h[i] >= LAND_MIN)) h[i] = LAND_MIN;

  for (let it = 0; it < p.iterations; it++) {
    t = performance.now();
    for (let i = 0; i < N; i++) if (!fixed[i]) h[i] += U[i] * dt;
    lap('uplift');

    router.fill(h);
    lap('flood');
    router.receivers(it < p.stochasticIterations ? rng : null);
    lap('receivers');
    router.buildStack();
    lap('stack');
    router.accumulate(rain);
    for (let i = 0; i < N; i++) am[i] = fixed[i] ? 0 : Math.exp(m * Math.log(area[i]));
    lap('area');

    incise(h, fixed, K, am, rcv, rdist, stack, router.stackLen, dt, strata);
    lap('incision');

    if (p.kd > 0 && it < p.iterations - p.diffusionOffLast) diffuse(h, tmp, fixed, n, cellM, p.kd, dt);
    lap('diffusion');

    if (p.talus > 0) talusClamp(h, fixed, rim, n, cellM, p.talus);
    lap('talus');

    onIteration?.(it, h);
    if (checkpoint && (it + 1) % CHECKPOINT_EVERY === 0) await checkpoint();
  }

  router.route(h, null, rain);
  const areaOut = new Float32Array(N);
  for (let i = 0; i < N; i++) areaOut[i] = area[i];
  return { h, area: areaOut, rcv, iterations: p.iterations, ms: performance.now() - t0, profile: prof };
}

/**
 * Implicit n = 1 stream-power step in stack order (receivers already updated):
 * h = (h + F·h_r)/(1 + F), F = K·dt·A^m/L. Cells at or below their receiver (inside a filled
 * depression) are not incised. Fixed receivers count as no lower than sea level.
 */
function incise(
  h: Float32Array,
  fixed: Uint8Array,
  K: Float32Array,
  am: Float64Array,
  rcv: Int32Array,
  rdist: Float32Array,
  stack: Int32Array,
  stackLen: number,
  dt: number,
  strata: LemStrata | undefined,
): void {
  for (let k = 0; k < stackLen; k++) {
    const i = stack[k];
    if (fixed[i]) continue;
    const r = rcv[i];
    const hr = fixed[r] && h[r] < 0 ? 0 : h[r];
    const hi = h[i];
    if (hi <= hr) continue;
    let ke = K[i];
    if (strata) {
      const T = strata.thickness[i];
      if (T > 0) {
        const z = hi / T;
        if (z - Math.floor(z) >= strata.capFraction) ke *= strata.softRatio;
      }
    }
    const F = (ke * dt * am[i]) / rdist[i];
    const v = (hi + F * hr) / (1 + F);
    h[i] = v < LAND_MIN ? LAND_MIN : v;
  }
}

/** Height a neighbour presents to land cells: fixed (ocean) cells count as no lower than sea level. */
function boundaryH(h: Float32Array, fixed: Uint8Array, j: number): number {
  return fixed[j] && h[j] < 0 ? 0 : h[j];
}

/** Explicit 5-point diffusion on land cells, sub-stepped to Δt ≤ cell²/(4·kd); map edges are zero-flux. */
function diffuse(h: Float32Array, tmp: Float32Array, fixed: Uint8Array, n: number, cellM: number, kd: number, dt: number): void {
  const N = n * n;
  const steps = Math.max(1, Math.ceil((dt * 4 * kd) / (cellM * cellM)));
  const c = (kd * (dt / steps)) / (cellM * cellM);
  for (let s = 0; s < steps; s++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        if (fixed[i]) continue;
        const hi = h[i];
        const l = x > 0 ? boundaryH(h, fixed, i - 1) : hi;
        const r = x < n - 1 ? boundaryH(h, fixed, i + 1) : hi;
        const u = y > 0 ? boundaryH(h, fixed, i - n) : hi;
        const d = y < n - 1 ? boundaryH(h, fixed, i + n) : hi;
        const v = hi + c * (l + r + u + d - 4 * hi);
        tmp[i] = v < LAND_MIN ? LAND_MIN : v;
      }
    }
    for (let i = 0; i < N; i++) if (!fixed[i]) h[i] = tmp[i];
  }
}

/**
 * One sequential pass: where a land cell's steepest drop exceeds `tanMax`, half the excess moves to
 * that neighbour (all of it when the neighbour is fixed, where the material is lost to the sea).
 * `rim` flags cells touching the map edge or a fixed cell (the only ones needing those checks).
 */
function talusClamp(h: Float32Array, fixed: Uint8Array, rim: Uint8Array, n: number, cellM: number, tanMax: number): void {
  const inv = Float64Array.from(DIAG, (d) => 1 / ((d ? Math.SQRT2 : 1) * cellM));
  const lim = Float64Array.from(DIAG, (d) => tanMax * (d ? Math.SQRT2 : 1) * cellM);
  const limOrtho = tanMax * cellM;
  const off = offsets(n);
  const N = n * n;
  for (let i = 0; i < N; i++) {
    if (fixed[i]) continue;
    const hi = h[i];
    let best = -1;
    let bestS = 0;
    let bestK = 0;
    let hb = 0;
    if (rim[i]) {
      const x = i % n;
      const y = (i - x) / n;
      for (let k = 0; k < 8; k++) {
        if (outside(x, y, k, n)) continue;
        const j = i + off[k];
        const hj = boundaryH(h, fixed, j);
        const s = (hi - hj) * inv[k];
        if (s > bestS) {
          bestS = s;
          best = j;
          bestK = k;
          hb = hj;
        }
      }
    } else {
      // Cheap reject: no drop can exceed the orthogonal limit if the lowest neighbour is close enough.
      let lo = hi;
      for (let k = 0; k < 8; k++) {
        const hj = h[i + off[k]];
        if (hj < lo) lo = hj;
      }
      if (hi - lo <= limOrtho) continue;
      for (let k = 0; k < 8; k++) {
        const hj = h[i + off[k]];
        const s = (hi - hj) * inv[k];
        if (s > bestS) {
          bestS = s;
          best = i + off[k];
          bestK = k;
          hb = hj;
        }
      }
    }
    if (best < 0) continue;
    const excess = hi - hb - lim[bestK];
    if (excess <= 0) continue;
    if (fixed[best]) {
      h[i] = Math.max(LAND_MIN, hi - excess);
    } else {
      h[i] = Math.max(LAND_MIN, hi - excess * 0.5);
      h[best] += excess * 0.5;
    }
  }
}

/** Cells on the map edge or next to a fixed cell. */
function rimMask(fixed: Uint8Array, n: number): Uint8Array {
  const rim = new Uint8Array(n * n);
  const off = offsets(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      for (let k = 0; k < 8; k++) {
        if (outside(x, y, k, n) || fixed[i + off[k]]) {
          rim[i] = 1;
          break;
        }
      }
    }
  }
  return rim;
}
