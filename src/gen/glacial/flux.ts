import { elaTemperature, LAPSE } from '../climate/tables';

/**
 * Glacier mass balance and ice flux along the fluvial drainage (research 01 §5, research 03 §1.5).
 * Ice follows the receivers of the eroded surface: every cell above the equilibrium line adds its
 * accumulation, every cell below it removes ablation over the tongue's width, and the flux stops
 * where ablation wins (the glacier snout).
 */

/** Reference ice flux Q0 (m above ELA × m²): a ~100 km² basin ~300 m above the ELA. */
export const Q0 = 3e10;
/** Smallest flux that carves a trough (≈ 10 km² × 200 m). */
export const Q_TROUGH = 2e9;
/** Height above the ELA beyond which accumulation stops growing (m). */
const DZ_CAP = 1500;
/** Ablation gradient relative to the accumulation gradient (ablation zones are steeper). */
const ABLATION = 2;

/** Glacier width (m) for an ice flux: 2.5 km at Q0, 0.3 power, clamped 300 m–10 km. */
export function glacierWidth(q: number): number {
  return Math.min(10_000, Math.max(300, 2500 * (q / Q0) ** 0.3));
}

/** Trough depth gain (m) for an ice flux: 250 m at Q0, 0.3 power, at most 900 m. */
export function troughDepth(q: number): number {
  return Math.min(900, 250 * (q / Q0) ** 0.3);
}

/**
 * Height above the local equilibrium line (m; > 0 = accumulation) from the Ohmura relation:
 * a cell is glaciated when its summer temperature (Tw − 1 °C) is below T_ELA(P) + shift.
 */
export function heightAboveEla(temp: Float32Array, tAmp: Float32Array, precip: Float32Array, shift: number, out: Float32Array): Float32Array {
  for (let i = 0; i < out.length; i++) {
    const summer = temp[i] + tAmp[i] - 1;
    out[i] = (elaTemperature(Math.max(0, precip[i])) + shift - summer) / LAPSE;
  }
  return out;
}

/** Cells ordered donors-before-receivers (Kahn's algorithm on the receiver tree). */
export function flowOrder(rcv: Int32Array): Int32Array {
  const N = rcv.length;
  const indeg = new Int32Array(N);
  for (let i = 0; i < N; i++) if (rcv[i] !== i) indeg[rcv[i]]++;
  const order = new Int32Array(N);
  let tail = 0;
  for (let i = 0; i < N; i++) if (indeg[i] === 0) order[tail++] = i;
  for (let head = 0; head < tail; head++) {
    const i = order[head];
    const r = rcv[i];
    if (r !== i && --indeg[r] === 0) order[tail++] = r;
  }
  return order;
}

export interface IceFlux {
  /** Ice flux leaving each cell (m × m²); 0 = no ice. */
  q: Float64Array;
  /** Highest glaciated cell upstream (m), for the relief limit on carving. */
  top: Float32Array;
  /** 1 = a cell with flux ≥ Q_TROUGH drains into this cell. */
  troughDonor: Uint8Array;
}

/**
 * Accumulates ice along the receivers. Accumulation: min(dz, 1500)·cell area·P factor; ablation below
 * the ELA: 2·dz·W(Q)·ds over the tongue (grid independent). Fixed (sea) cells take no ice.
 */
export function iceFlux(
  order: Int32Array,
  rcv: Int32Array,
  fixed: Uint8Array,
  h: Float32Array,
  dz: Float32Array,
  precip: Float32Array,
  n: number,
  cellM: number,
): IceFlux {
  const N = n * n;
  const q = new Float64Array(N);
  const top = new Float32Array(N).fill(-Infinity);
  const troughDonor = new Uint8Array(N);
  const cellA = cellM * cellM;
  for (let k = 0; k < N; k++) {
    const i = order[k];
    if (fixed[i]) {
      q[i] = 0;
      continue;
    }
    const qin = q[i];
    const d = dz[i];
    let qo: number;
    if (d > 0) {
      const pf = Math.min(2, Math.max(0.2, precip[i] / 1000));
      qo = qin + Math.min(d, DZ_CAP) * cellA * pf;
    } else if (qin > 0) {
      const r = rcv[i];
      const diag = r !== i && Math.abs(r - i) !== 1 && Math.abs(r - i) !== n;
      const ds = diag ? cellM * Math.SQRT2 : cellM;
      qo = Math.max(0, qin + ABLATION * d * glacierWidth(qin) * ds);
    } else {
      qo = 0;
    }
    q[i] = qo;
    if (qo <= 0) continue;
    if (h[i] > top[i]) top[i] = h[i];
    const r = rcv[i];
    if (r === i || fixed[r]) continue;
    q[r] += qo;
    if (top[i] > top[r]) top[r] = top[i];
    if (qo >= Q_TROUGH) troughDonor[r] = 1;
  }
  return { q, top, troughDonor };
}

/** Donor lists of the receiver tree in CSR form. */
export function donorsCsr(rcv: Int32Array): { start: Int32Array; list: Int32Array } {
  const N = rcv.length;
  const start = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) if (rcv[i] !== i) start[rcv[i] + 1]++;
  for (let i = 0; i < N; i++) start[i + 1] += start[i];
  const pos = start.slice(0, N);
  const list = new Int32Array(start[N]);
  for (let i = 0; i < N; i++) if (rcv[i] !== i) list[pos[rcv[i]]++] = i;
  return { start, list };
}
