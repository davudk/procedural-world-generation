import { BIOME } from '../../shared/biomes';
import { WATER } from '../stages/hydro';
import { cellIndex, coarser, cellX as colOf, cellY as rowOf } from '../grid/grid';
import { boxBlur, chamferDistance } from '../grid/ops';
import { coarseFactor, label, type GridSpec } from './grid';
import type { RegistryInput, Shared } from './types';

/** Regional grid cell size (m). */
export const REGIONAL_M = 4000;
/** A landmass is a continent from this share of the world area (and of all land). */
const CONTINENT_WORLD_SHARE = 0.035;
const CONTINENT_LAND_SHARE = 0.08;

/** Biome groups counted per regional cell (deserts, forests, wetlands, open grass and scrub lands, tundra). */
export const G = { DESERT: 0, BOREAL: 1, TEMPERATE: 2, TROPICAL: 3, WET: 4, OPEN: 5, TUNDRA: 6 } as const;
export const GROUPS = 7;

export function groupOf(b: number, water: number): number {
  if (water === WATER.WETLAND) return G.WET;
  switch (b) {
    case BIOME.HOT_DESERT: case BIOME.COLD_DESERT: case BIOME.POLAR_DESERT: case BIOME.SALT_FLAT:
      return G.DESERT;
    case BIOME.BOREAL:
      return G.BOREAL;
    case BIOME.TEMP_CONIFER: case BIOME.TEMP_BROADLEAF: case BIOME.TEMP_RAINFOREST:
      return G.TEMPERATE;
    case BIOME.TROP_RAINFOREST: case BIOME.TROP_DRY_FOREST: case BIOME.CLOUD_FOREST:
      return G.TROPICAL;
    case BIOME.MARSH: case BIOME.BOG: case BIOME.SWAMP: case BIOME.FEN: case BIOME.SALT_MARSH: case BIOME.MANGROVE:
      return G.WET;
    case BIOME.STEPPE: case BIOME.SAVANNA: case BIOME.XERIC_SHRUB: case BIOME.MEDITERRANEAN:
      return G.OPEN;
    case BIOME.TUNDRA:
      return G.TUNDRA;
    default:
      return -1;
  }
}

/** Unit direction of the gradient of a distance field at a cell (cells; y down). */
export function gradAt(d: Float32Array, g: GridSpec, c: number): [number, number] {
  const x = colOf(g, c);
  const y = rowOf(g, c);
  const at = (i: number, j: number): number => d[cellIndex(g, Math.min(g.n - 1, Math.max(0, i)), Math.min(g.n - 1, Math.max(0, j)))];
  const gx = at(x + 1, y) - at(x - 1, y);
  const gy = at(x, y + 1) - at(x, y - 1);
  const l = Math.hypot(gx, gy);
  return l > 1e-9 ? [gx / l, gy / l] : [1, 0];
}

export function computeShared(I: RegistryInput): Shared {
  const fine = I.fine;
  const { n, cellM } = fine;
  const f = coarseFactor(fine, REGIONAL_M);
  const reg = coarser(fine, f);
  const M = reg.cells;
  // One pass over the macro grid: land share, mean and max land height, biome groups, totals.
  const landShare = new Float32Array(M);
  const hMean = new Float32Array(M);
  const hMax = new Float32Array(M);
  const groupShare = Array.from({ length: GROUPS }, () => new Float32Array(M));
  const groupCells = new Float64Array(GROUPS);
  const inv = 1 / (f * f);
  const landFine = new Uint8Array(fine.cells);
  let landCells = 0;
  let tempSum = 0;
  let iceCells = 0;
  for (let face = 0; face < fine.faces; face++) {
    for (let y = 0; y < n; y++) {
      const row = cellIndex(reg, 0, Math.floor(y / f), face);
      const c0 = cellIndex(fine, 0, y, face);
      for (let x = 0; x < n; x++) {
        const c = c0 + x;
        if (I.sea[c]) continue;
        const k = row + Math.floor(x / f);
        const h = Math.max(0, I.h[c]);
        landFine[c] = 1;
        landCells++;
        landShare[k] += inv;
        hMean[k] += h * inv;
        if (h > hMax[k]) hMax[k] = h;
        tempSum += I.climate.temp[c];
        const b = I.biome.biome[c];
        if (b === BIOME.ICE || I.landforms.ice[c] >= 0.5) iceCells++;
        const g = groupOf(b, I.hydro.waterClass[c]);
        if (g >= 0) {
          groupShare[g][k] += inv;
          groupCells[g]++;
        }
      }
    }
  }

  const land = new Uint8Array(M);
  const seaR = new Uint8Array(M);
  for (let i = 0; i < M; i++) {
    land[i] = landShare[i] >= 0.5 ? 1 : 0;
    seaR[i] = 1 - land[i];
  }
  // ~20 km windows whatever the grid: radius in regional cells.
  const r = Math.max(1, Math.round(8000 / reg.cellM));
  const hSmooth = hMean.slice();
  boxBlur(hSmooth, reg, r);
  const sq = new Float32Array(M);
  for (let i = 0; i < M; i++) sq[i] = hMean[i] * hMean[i];
  boxBlur(sq, reg, r);
  const relief = new Float32Array(M);
  for (let i = 0; i < M; i++) relief[i] = Math.sqrt(Math.max(0, sq[i] - hSmooth[i] * hSmooth[i]));
  const dLand = chamferDistance(land, reg);
  const dSea = chamferDistance(seaR, reg);
  const comps = label(landFine, fine, true);
  const cellKm2 = (cellM / 1000) ** 2;
  const landKm2 = landCells * cellKm2;
  const continents = new Set<number>();
  const minCont = Math.max(CONTINENT_WORLD_SHARE * I.worldKm * I.worldKm, CONTINENT_LAND_SHARE * landKm2);
  for (let k = 0; k < comps.count; k++) if (comps.size[k] * cellKm2 >= minCont) continents.add(k);
  return {
    reg, f, landShare, hMean, hMax, relief, hSmooth, land, dLand, dSea, groupShare,
    totals: { landCells, tempMean: tempSum / Math.max(1, landCells), iceCells, groupCells },
    masses: comps, continents, landKm2,
  };
}
