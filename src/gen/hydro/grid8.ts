/** 8-neighbourhood helpers shared by the hydrology modules (the grid's raster D8 order). */
import { RASTER_DX, RASTER_DY } from '../grid/grid';

export const DX = RASTER_DX;
export const DY = RASTER_DY;
/** Neighbour distance in cells. */
export const DIST = Float64Array.from(DX, (dx, k) => (dx !== 0 && DY[k] !== 0 ? Math.SQRT2 : 1));

/** 1 / DIST. */
export const INV_DIST = Float64Array.from(DIST, (d) => 1 / d);

/** Next float32 strictly below z, with a floor of 1 mm (so carved paths have a visible gradient). */
export function stepDown(z: number): number {
  return Math.fround(z - Math.max(1e-3, Math.abs(z) * 9.5367431640625e-7));
}
