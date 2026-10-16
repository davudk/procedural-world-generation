/** Per-cell water budget from the climate fields (research 02 §1.4, §2.3, §5.4). */

export const SECONDS_PER_YEAR = 3.156e7;
/** Fu (1981) Budyko-curve shape parameter. */
const FU_W = 2.6;
/** Open-water evaporation relative to potential evapotranspiration. */
const OPEN_WATER = 1.1;

export interface WaterBudget {
  /** Runoff P − ET on land (m/yr, ≥ 0); 0 on ocean. */
  runoff: Float32Array;
  /**
   * Extra loss when the cell is under a lake (m/yr, ≥ 0): open-water evaporation minus the land ET
   * already subtracted from its runoff. A lake cell therefore yields runoff − lakeLoss = P − E_lake.
   */
  lakeLoss: Float32Array;
  /** PET / P. */
  aridity: Float32Array;
}

/** Actual evapotranspiration (mm/yr) from Fu's form of the Budyko curve. */
export function budykoEt(p: number, pet: number): number {
  if (p <= 0) return 0;
  const phi = pet / p;
  return p * (1 + phi - Math.pow(1 + Math.pow(phi, FU_W), 1 / FU_W));
}

export function waterBudget(precip: Float32Array, pet: Float32Array, fixed: Uint8Array): WaterBudget {
  const N = precip.length;
  const runoff = new Float32Array(N);
  const lakeLoss = new Float32Array(N);
  const aridity = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const p = Math.max(0, precip[i]);
    const e = Math.max(0, pet[i]);
    const et = Math.min(p, budykoEt(p, e));
    aridity[i] = e / Math.max(1, p);
    if (fixed[i]) continue;
    runoff[i] = (p - et) / 1000;
    lakeLoss[i] = Math.max(0, OPEN_WATER * e - et) / 1000;
  }
  return { runoff, lakeLoss, aridity };
}
