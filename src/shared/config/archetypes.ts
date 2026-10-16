import type { Pins } from './types';

/**
 * World archetypes (CONFIG.md §5). `bias` feeds AUTO formulas ("AUTO ← archetype"); `pins` become
 * PRESET values. Every bias key must exist in EARTH_LIKE, which supplies the defaults.
 */
export interface Archetype {
  id: string;
  label: string;
  blurb: string;
  bias: Readonly<Record<string, number>>;
  pins: Pins;
}

const EARTH_LIKE: Readonly<Record<string, number>> = {
  worldSize: 1024,
  landFraction: 0.4,
  tectonicActivity: 0.5,
  geologicAge: 0.5,
  latNorth: 65,
  latSouth: 20,
  temperatureOffset: 0,
  humidity: 1,
  plateMul: 1,
  plateSizeSkew: 0.4,
  continentMul: 1,
  continentSizeSkew: 0.5,
  islandAbundance: 1,
  coastRoughness: 1.25,
  seaLevelRise: 0,
  mapEdgeContinent: 0,
  impactHistory: 1,
  strataShare: 0.15,
  karstShare: 0.06,
  poleEquatorGradient: 1,
};

function arch(id: string, label: string, blurb: string, bias: Record<string, number>, pins: Pins = {}): Archetype {
  for (const k of Object.keys(bias)) {
    if (!(k in EARTH_LIKE)) throw new Error(`archetype ${id}: unknown bias ${k}`);
  }
  return { id, label, blurb, bias: { ...EARTH_LIKE, ...bias }, pins };
}

export const ARCHETYPES: readonly Archetype[] = [
  arch('earth', 'Earth-like', 'Temperate-to-subtropical realm with a few continents, ranges and great rivers.', {}),
  arch('archipelago', 'Archipelago', 'Mostly sea: island arcs, shelf islands and drowned ranges.', {
    landFraction: 0.18, islandAbundance: 2, continentMul: 0.6, coastRoughness: 1.32, seaLevelRise: 60,
  }),
  arch('pangaea', 'Pangaea', 'One great landmass with a dry interior.', {
    landFraction: 0.55, continentSizeSkew: 0.9, islandAbundance: 0.5,
  }, { continentCount: [1, 1] }),
  arch('rift', 'Rift & great lakes', 'A continent pulling apart: rift valleys, long deep lakes, volcanoes.', {
    tectonicActivity: 0.7, landFraction: 0.5, humidity: 1.2, latNorth: 15, latSouth: -15,
  }, { riftCount: [2, 3] }),
  arch('fjordland', 'Fjordland', 'Cold, high-latitude coast with glaciated mountains and drowned valleys.', {
    latNorth: 72, latSouth: 55, temperatureOffset: -1, humidity: 1.3, seaLevelRise: 120, coastRoughness: 1.4,
    tectonicActivity: 0.55,
  }, { fjords: true }),
  arch('desert', 'Desert world', 'Hot and dry: ergs, mesas, salt flats and wadis.', {
    latNorth: 40, latSouth: 10, temperatureOffset: 3, humidity: 0.35, landFraction: 0.55, strataShare: 0.45,
    mapEdgeContinent: 1,
  }),
  arch('volcanic', 'Volcanic island chain', 'Hotspots and island arcs in warm seas, reefs and atolls.', {
    landFraction: 0.15, tectonicActivity: 0.85, islandAbundance: 1.8, latNorth: 30, latSouth: 5, humidity: 1.2,
  }, { hotspotCount: [2, 3] }),
  arch('iceage', 'Ice age', 'Glaciers reach low elevations; steppe and tundra expand.', {
    temperatureOffset: -6, humidity: 0.75, latNorth: 70, latSouth: 25, poleEquatorGradient: 1.15,
  }),
  arch('hothouse', 'Hothouse tropics', 'No ice, rainforests far from the equator.', {
    temperatureOffset: 8, humidity: 1.3, latNorth: 75, latSouth: 15, poleEquatorGradient: 0.6,
  }),
  arch('craton', 'Old craton', 'Ancient, worn-down land: low relief, inselbergs, surviving impact craters.', {
    tectonicActivity: 0.15, geologicAge: 0.9, impactHistory: 2.5, karstShare: 0.12,
  }),
];

export const DEFAULT_ARCHETYPE = 'earth';

export function archetypeById(id: string): Archetype {
  return ARCHETYPES.find((a) => a.id === id) ?? ARCHETYPES[0];
}
