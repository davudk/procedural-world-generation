import type { LandmarkKind, Tier } from '../../shared/landmarks';
import type { LakeInfo, RiverGraph } from '../../shared/protocol';
import type { BiomeExtra } from '../stages/biome';
import type { ClimateExtra } from '../stages/climate';
import type { HydroExtra } from '../stages/hydro';
import type { LandformsExtra } from '../stages/landforms';
import type { PlatesExtra } from '../stages/plates';
import type { Components, GridSpec } from './grid';

/** Hero menu categories (research 05 §3.4). */
export type HeroCat =
  | 'massif' | 'great-river' | 'great-lake' | 'fjord-coast' | 'volcano' | 'crater' | 'sand-sea' | 'canyon' | 'archipelago'
  | 'karst-towers' | 'salt-basin' | 'reef';

/**
 * A detected landmark before ranking and naming. Detectors fill geometry and facts; the registry
 * adds importance, zoom band, tier, name and hero status.
 */
export interface Candidate {
  kind: LandmarkKind;
  x: number;
  y: number;
  angle: number;
  extentM: number;
  /** Kind-specific magnitude 0–1 (height, discharge, area… relative to a reference), for importance. */
  mag: number;
  data: Record<string, number>;
  path?: Float32Array;
  /**
   * Identity for names: a position that is stable for this feature when unrelated parameters change
   * (summit, mouth, basin centre), map metres.
   */
  idX: number;
  idY: number;
  /** Visible footprint (m) for point features whose extent understates how early they read (peaks, falls). */
  visM?: number;
  /** Naming variant for kinds with several generics (e.g. 'playa', 'boreal', 'marsh'). */
  variant?: string;
  /** Share this candidate's base name (delta of a river, king of a range…). */
  nameFrom?: Candidate;
  /** Hero menu category and its score (≥ 1 meets the research 05 threshold). */
  hero?: { cat: HeroCat; score: number };
  tier?: Tier;
  /** Elevation merge-tree component of the summit this candidate claimed (volcanoes), so a pass can free it. */
  summit?: number;
  /** Island / continent label for language choice (land features). */
  landmass?: number;
}

/** Everything the detectors read. Map positions are metres; `fine` is the macro grid. */
export interface RegistryInput {
  seed: number;
  worldKm: number;
  fine: GridSpec;
  /** The plates stage's grid. */
  platesGrid: GridSpec;
  /** Final carved terrain (m). */
  h: Float32Array;
  /** 1 = sea (WATER.OCEAN). */
  sea: Uint8Array;
  hydro: HydroExtra;
  rivers: RiverGraph;
  lakes: LakeInfo[];
  landforms: LandformsExtra;
  plates: PlatesExtra;
  biome: BiomeExtra;
  climate: ClimateExtra;
}

/** Shared derived rasters (computed once). */
export interface Shared {
  /** Regional grid (~4 km cells) and its factor relative to the macro grid. */
  reg: GridSpec;
  f: number;
  /** Regional land share, mean elevation (sea counted as 0 m), relief (local σ of elevation, m). */
  landShare: Float32Array;
  hMean: Float32Array;
  hMax: Float32Array;
  relief: Float32Array;
  /** Smoothed elevation (m, ~20 km window). */
  hSmooth: Float32Array;
  /** Regional land mask (majority). */
  land: Uint8Array;
  /** Distance from land over the sea, and from the sea over land (regional cells). */
  dLand: Float32Array;
  dSea: Float32Array;
  /** Share of each biome group (shared.ts G) per regional cell. */
  groupShare: Float32Array[];
  /** Macro-grid land totals: cells, mean temperature (°C), ice cells, cells per biome group. */
  totals: { landCells: number; tempMean: number; iceCells: number; groupCells: Float64Array };
  /** Macro-grid landmasses (8-connected land incl. lakes). */
  masses: Components;
  /** Landmass ids that count as continents. */
  continents: Set<number>;
  landKm2: number;
}
