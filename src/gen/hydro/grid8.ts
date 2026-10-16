/** 8-neighbourhood helpers shared by the hydrology modules (square row-major grids). */

export const DX = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
export const DY = [-1, -1, -1, 0, 0, 1, 1, 1] as const;
/** Neighbour distance in cells. */
export const DIST = Float64Array.from(DX, (dx, k) => (dx !== 0 && DY[k] !== 0 ? Math.SQRT2 : 1));

/** 1 / DIST. */
export const INV_DIST = Float64Array.from(DIST, (d) => 1 / d);

export const offsets = (n: number): Int32Array => Int32Array.from(DX, (dx, k) => DY[k] * n + dx);

/** Whether neighbour k of (x, y) lies outside the n×n grid. */
export function outside(x: number, y: number, k: number, n: number): boolean {
  const nx = x + DX[k];
  const ny = y + DY[k];
  return nx < 0 || ny < 0 || nx >= n || ny >= n;
}

/** Next float32 strictly below z, with a floor of 1 mm (so carved paths have a visible gradient). */
export function stepDown(z: number): number {
  return Math.fround(z - Math.max(1e-3, Math.abs(z) * 9.5367431640625e-7));
}
