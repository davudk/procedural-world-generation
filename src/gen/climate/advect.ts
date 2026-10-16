import type { Wind } from './wind';

/**
 * First-order upwind stencil of a wind field (research 03 §2.3). Each cell blends its x- and
 * y-upwind neighbours by |gx| : |gy|; `order` lists every cell once, grouped by wind quadrant, each
 * group in the Gauss–Seidel sweep order in which its upwind neighbours come first (Zhao's fast
 * sweeping, restricted to the cells each sweep can update).
 */
export interface Stencil {
  n: number;
  /**
   * Upwind neighbour in x / y: −1 = no upwind cell (outside the map, or a neighbour that blows back
   * into this cell along a divergence line), the cell itself when that weight is 0.
   */
  iu: Int32Array;
  ju: Int32Array;
  /** Weight of `iu`; `ju` gets 1 − wa. */
  wa: Float32Array;
  /** Path length across the cell along the wind (km, Δ…√2Δ). */
  ds: Float32Array;
  order: Int32Array;
  /** Cells with a −1 neighbour: they take the caller's boundary value for that side. */
  sources: Int32Array;
}

export function buildStencil(w: Wind, n: number, cellKm: number): Stencil {
  const N = n * n;
  const iu = new Int32Array(N);
  const ju = new Int32Array(N);
  const wa = new Float32Array(N);
  const ds = new Float32Array(N);
  const quad = new Uint8Array(N);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const gx = w.gx[i];
      const gy = w.gy[i];
      const a = Math.abs(gx);
      const b = Math.abs(gy);
      const s = a + b;
      const ux = gx > 0 ? x - 1 : gx < 0 ? x + 1 : x;
      const uy = gy > 0 ? y - 1 : gy < 0 ? y + 1 : y;
      iu[i] = ux < 0 || ux >= n ? -1 : y * n + ux;
      ju[i] = uy < 0 || uy >= n ? -1 : uy * n + x;
      wa[i] = a / s;
      ds[i] = (cellKm * s) / Math.sqrt(gx * gx + gy * gy);
      quad[i] = (gx >= 0 ? 0 : 1) | (gy >= 0 ? 0 : 2);
    }
  }
  // Divergence lines (two cells upwind of each other) would form cycles that the sweeps resolve only
  // geometrically slowly; such air comes from aloft, so the pair takes the boundary value instead.
  let nSrc = 0;
  const isSrc = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const u = iu[i];
    const j = ju[i];
    if (u >= 0 && u !== i && iu[u] === i) isSrc[i] |= 1;
    if (j >= 0 && j !== i && ju[j] === i) isSrc[i] |= 2;
  }
  for (let i = 0; i < N; i++) {
    if (isSrc[i] & 1) iu[i] = -1;
    if (isSrc[i] & 2) ju[i] = -1;
    if (iu[i] < 0 || ju[i] < 0) {
      isSrc[i] = 1;
      nSrc++;
    } else {
      isSrc[i] = 0;
    }
  }
  const sources = new Int32Array(nSrc);
  for (let i = 0, s = 0; i < N; i++) if (isSrc[i]) sources[s++] = i;
  const order = new Int32Array(N);
  let k = 0;
  for (let q = 0; q < 4; q++) {
    const rx = (q & 1) !== 0;
    const ry = (q & 2) !== 0;
    for (let yy = 0; yy < n; yy++) {
      const r = (ry ? n - 1 - yy : yy) * n;
      for (let xx = 0; xx < n; xx++) {
        const i = r + (rx ? n - 1 - xx : xx);
        if (quad[i] === q) order[k++] = i;
      }
    }
  }
  return { n, iu, ju, wa, ds, order, sources };
}

/** Upwind blend of `v`; a side without an upwind cell takes the boundary value `b[i]`. */
function inflow(st: Stencil, v: Float32Array, b: Float32Array, i: number): number {
  const u = st.iu[i];
  const j = st.ju[i];
  const w = st.wa[i];
  return w * (u < 0 ? b[i] : v[u]) + (1 - w) * (j < 0 ? b[i] : v[j]);
}

/**
 * Sweep rounds (4 orders each). With divergence-line cycles cut, round 4 leaves residuals ≲ 1e-3
 * where round 3 still moved some cells by ~0.1 (paths that change wind quadrant several times).
 */
const MAX_ROUNDS = 4;
const TOL = 1e-3;

export interface MarineInput {
  sea: Uint8Array;
  /** SST anomaly on sea cells (°C). */
  anom: Float32Array;
  /** Per-cell land decay factor exp(−ds / L_m). */
  decay: Float32Array;
  /** Inflow of marine influence for the cells in `Stencil.sources`. */
  boundaryM: Float32Array;
}

/**
 * Marine influence m (1 over water, decaying inland along the wind) and the advected SST anomaly
 * (research 03 §1.3–1.4). Returns the number of rounds used.
 */
export function advectMarine(st: Stencil, inp: MarineInput, m: Float32Array, a: Float32Array): number {
  const { order } = st;
  const { sea, anom, decay, boundaryM } = inp;
  let rounds = 0;
  while (rounds < MAX_ROUNDS) {
    rounds++;
    let res = 0;
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      let mv: number;
      let av: number;
      if (sea[i]) {
        mv = 1;
        av = anom[i];
      } else {
        const d = decay[i];
        mv = inflow(st, m, boundaryM, i) * d;
        const u = st.iu[i];
        const j = st.ju[i];
        const w = st.wa[i];
        av = (w * (u < 0 ? 0 : a[u]) + (1 - w) * (j < 0 ? 0 : a[j])) * d;
      }
      const dm = Math.abs(mv - m[i]);
      if (dm > res) res = dm;
      m[i] = mv;
      a[i] = av;
    }
    if (res < TOL) break;
  }
  return rounds;
}

export interface MoistureInput {
  sea: Uint8Array;
  /** Sea: equilibrium humidity RH_SEA·C(SST); recharge factor exp(−ds / L_EVAP). */
  target: Float32Array;
  recharge: Float32Array;
  /** Depletion factor exp(−eff·ds / L_RAIN) (sea cells: circulation term only). */
  deplete: Float32Array;
  /** Land: saturation cap C(T at the blurred surface)·RH_MAX and its snow-out retention per cell. */
  cap: Float32Array;
  retain: Float32Array;
  /** Recycling fraction × warmth (0 = frozen ground). */
  recycle: Float32Array;
  /** Inflow humidity for the cells in `Stencil.sources`. */
  boundaryQ: Float32Array;
}

/**
 * Steady upwind humidity transport with rain-out, snow-out of supersaturated air and land
 * recycling, then a final non-mutating pass that turns what each column lost into precipitation:
 * P = P0·(q_in − q_out)·L_RAIN / ds (mm/yr). Returns the rounds used.
 */
export function advectMoisture(st: Stencil, inp: MoistureInput, p0: number, lRain: number, q: Float32Array, precip: Float32Array): number {
  const { order, ds } = st;
  const { sea, target, recharge, deplete, cap, retain, recycle, boundaryQ } = inp;
  let rounds = 0;
  while (rounds < MAX_ROUNDS) {
    rounds++;
    let res = 0;
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const qin = inflow(st, q, boundaryQ, i);
      let qv: number;
      if (sea[i]) {
        const t = target[i];
        qv = t + (qin - t) * recharge[i];
      } else {
        let qq = qin * deplete[i];
        const c = cap[i];
        if (qq > c) qq = c + (qq - c) * retain[i];
        // Vegetation proxy for evapotranspiration: dry air means desert (0.1), moist air forest (1).
        const s = Math.min(1, Math.max(0, (qin - 0.1) / 0.5));
        const veg = 0.1 + 0.9 * s * s * (3 - 2 * s);
        qv = qq + recycle[i] * veg * (qin - qq);
      }
      const d = Math.abs(qv - q[i]);
      if (d > res) res = d;
      q[i] = qv;
    }
    if (res < TOL) break;
  }
  for (let i = 0; i < q.length; i++) {
    const qin = inflow(st, q, boundaryQ, i);
    let qq = qin * deplete[i];
    if (!sea[i]) {
      const c = cap[i];
      if (qq > c) qq = c + (qq - c) * retain[i];
    }
    precip[i] = (p0 * (qin - qq) * lRain) / ds[i];
  }
  return rounds;
}
