/**
 * Biome classes (research 03 §3.3). Ids are stable: they are stored in the `biome` raster (Uint8)
 * and used by the renderer's override masks. 0 = water (ocean / lake).
 */
export const BIOME = {
  WATER: 0,
  ICE: 1,
  POLAR_DESERT: 2,
  TUNDRA: 3,
  BOREAL: 4,
  TEMP_CONIFER: 5,
  TEMP_BROADLEAF: 6,
  TEMP_RAINFOREST: 7,
  STEPPE: 8,
  MEDITERRANEAN: 9,
  HOT_DESERT: 10,
  COLD_DESERT: 11,
  XERIC_SHRUB: 12,
  SAVANNA: 13,
  TROP_DRY_FOREST: 14,
  TROP_RAINFOREST: 15,
  CLOUD_FOREST: 16,
  ALPINE_MEADOW: 17,
  NIVAL: 18,
  MANGROVE: 19,
  SALT_MARSH: 20,
  MARSH: 21,
  BOG: 22,
  BEACH: 23,
  SALT_FLAT: 24,
  ROCK: 25,
} as const;

export type BiomeId = (typeof BIOME)[keyof typeof BIOME];

export interface BiomeInfo {
  id: BiomeId;
  name: string;
  /** Typical canopy cover, 0–1. */
  canopy: number;
  /** Satellite-like and stylised base colours, sRGB 0–255. */
  satellite: readonly [number, number, number];
  stylised: readonly [number, number, number];
}

const b = (id: BiomeId, name: string, canopy: number, satellite: [number, number, number], stylised: [number, number, number]): BiomeInfo => ({
  id, name, canopy, satellite, stylised,
});

/** Indexed by id. */
export const BIOMES: readonly BiomeInfo[] = [
  b(BIOME.WATER, 'Water', 0, [40, 80, 110], [60, 120, 170]),
  b(BIOME.ICE, 'Ice sheet / glacier', 0, [236, 240, 245], [250, 252, 255]),
  b(BIOME.POLAR_DESERT, 'Polar desert', 0, [170, 160, 150], [205, 200, 190]),
  b(BIOME.TUNDRA, 'Tundra', 0.05, [124, 124, 92], [170, 180, 130]),
  b(BIOME.BOREAL, 'Boreal forest (taiga)', 0.6, [44, 62, 38], [70, 110, 70]),
  b(BIOME.TEMP_CONIFER, 'Temperate coniferous forest', 0.7, [40, 66, 40], [60, 120, 80]),
  b(BIOME.TEMP_BROADLEAF, 'Temperate broadleaf forest', 0.75, [62, 94, 46], [110, 160, 80]),
  b(BIOME.TEMP_RAINFOREST, 'Temperate rainforest', 0.95, [30, 64, 36], [40, 120, 70]),
  b(BIOME.STEPPE, 'Grassland / steppe', 0.05, [150, 148, 96], [200, 200, 120]),
  b(BIOME.MEDITERRANEAN, 'Mediterranean shrubland', 0.35, [118, 118, 78], [165, 160, 95]),
  b(BIOME.HOT_DESERT, 'Hot desert', 0, [214, 186, 140], [235, 210, 160]),
  b(BIOME.COLD_DESERT, 'Cold desert', 0, [176, 162, 136], [205, 190, 160]),
  b(BIOME.XERIC_SHRUB, 'Xeric shrubland', 0.15, [170, 150, 108], [200, 180, 120]),
  b(BIOME.SAVANNA, 'Savanna', 0.2, [156, 146, 84], [200, 190, 100]),
  b(BIOME.TROP_DRY_FOREST, 'Tropical dry forest', 0.6, [98, 110, 58], [140, 160, 70]),
  b(BIOME.TROP_RAINFOREST, 'Tropical rainforest', 0.98, [26, 66, 26], [40, 130, 50]),
  b(BIOME.CLOUD_FOREST, 'Montane / cloud forest', 0.9, [34, 72, 44], [60, 130, 90]),
  b(BIOME.ALPINE_MEADOW, 'Alpine meadow', 0.02, [120, 130, 88], [160, 190, 120]),
  b(BIOME.NIVAL, 'Alpine rock / nival', 0, [128, 122, 116], [165, 160, 155]),
  b(BIOME.MANGROVE, 'Mangrove', 0.9, [36, 70, 46], [60, 110, 80]),
  b(BIOME.SALT_MARSH, 'Salt marsh', 0.1, [100, 110, 80], [140, 160, 110]),
  b(BIOME.MARSH, 'Freshwater marsh / swamp', 0.3, [60, 80, 56], [90, 130, 100]),
  b(BIOME.BOG, 'Bog / fen', 0.1, [110, 100, 70], [150, 140, 100]),
  b(BIOME.BEACH, 'Beach / dunes', 0, [226, 212, 178], [240, 225, 180]),
  b(BIOME.SALT_FLAT, 'Salt flat', 0, [232, 230, 222], [245, 245, 240]),
  b(BIOME.ROCK, 'Bare rock / scree', 0, [120, 114, 108], [160, 150, 140]),
];
