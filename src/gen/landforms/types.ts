import type { Range } from '../../shared/config/types';
import type { Rng } from '../../shared/rng';
import type { BaseExtra } from '../stages/base';
import type { ClimateExtra } from '../stages/climate';
import type { PlatesExtra } from '../stages/plates';

/** A placed landmark, for stats now and the registry/atlas in M7. Positions in map metres (y from the north edge). */
export interface Feature {
  /** FEATURES.md row id or a short type key, e.g. 'stratovolcano', 'caldera', 'crater', 'fjord', 'mesa', 'barrier-island'. */
  type: string;
  x: number;
  y: number;
  /** Characteristic size (m): diameter, length, … */
  size: number;
  /** Optional extra numbers (height, depth, age …). */
  data?: Record<string, number>;
}

/**
 * Shared context for the M6 landform passes (glacial runs as its own stage before these). Every pass
 * edits `h` in place on the macro grid and must keep `fixed` consistent: fixed = 1 exactly where
 * the cell is base level (ocean, or an open map edge). New sea cells (h ≤ 0 connected to the ocean)
 * become fixed; cells raised above 0 stop being fixed. Masks are optional extra rasters (Uint8, 0–255)
 * that the stage exports as layers for rendering/biomes.
 */
export interface LandformCtx {
  n: number;
  cellKm: number;
  worldKm: number;
  h: Float32Array;
  fixed: Uint8Array;
  /** Glacier ice cover 0–1 from the glacial stage (read-only here). */
  ice: Float32Array;
  climate: ClimateExtra;
  plates: PlatesExtra;
  base: BaseExtra;
  num(id: string): number;
  range(id: string): Range;
  str(id: string): string;
  drawn(id: string): number;
  rng(...keys: (string | number)[]): Rng;
  features: Feature[];
  masks: Map<string, Uint8Array>;
  stats: Record<string, number>;
}
