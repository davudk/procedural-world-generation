/**
 * Named landmarks (PLAN.md §6 landmark registry; research 05 §3.4 heroes). Produced by the registry
 * stage, consumed by labels, the Atlas panel, the inspector and density metrics.
 */
export type LandmarkKind =
  | 'continent' | 'island' | 'archipelago' | 'peninsula' | 'cape' | 'isthmus'
  | 'ocean' | 'sea' | 'gulf' | 'bay' | 'strait' | 'lagoon'
  | 'range' | 'peak' | 'volcano' | 'caldera' | 'crater' | 'plateau' | 'rift' | 'mesa-field' | 'canyon'
  | 'river' | 'lake' | 'waterfall' | 'delta' | 'fjord'
  | 'glacier' | 'icecap' | 'desert' | 'erg' | 'forest' | 'wetland' | 'karst' | 'reef' | 'atoll' | 'plain'
  | 'hill' | 'grassland' | 'pass' | 'gorge';

export type Tier = 'common' | 'uncommon' | 'rare' | 'legendary';

export interface Landmark {
  id: number;
  kind: LandmarkKind;
  name: string;
  /** Label anchor, map metres (x from the west edge, y from the north edge). */
  x: number;
  y: number;
  /** Text direction for linear features (radians, 0 = east, counter-clockwise, map axes), or NaN for horizontal. */
  angle: number;
  /** Characteristic extent (m): diameter, length or √area. */
  extentM: number;
  /** 0–1 rank used for label priority and Atlas ordering (global, comparable across kinds). */
  importance: number;
  /** Labels show only when the view's metres per pixel is at most this (zoom band, research 05 §3.2). */
  maxMpp: number;
  /** Optional centreline for labels along rivers / ranges (map metres, x,y pairs). */
  path?: Float32Array;
  /** Facts for the inspector / Atlas (e.g. heightM, prominenceM, lengthKm, areaKm2, depthM). */
  data: Record<string, number>;
  tier: Tier;
  hero: boolean;
}

/** Short, human summary of what makes a world special (research 05 §3.4 "World traits"). */
export interface WorldTraits {
  /** One sentence, e.g. "A cold realm of fjords, with a 5.6 km massif and a great river." */
  headline: string;
  /** 3–8 bullet facts. */
  traits: string[];
  /** Landmark ids of the hero landmarks. */
  heroes: number[];
}
