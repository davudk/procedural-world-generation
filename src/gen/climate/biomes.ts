import { BIOME, BIOMES, type BiomeId } from '../../shared/biomes';
import type { Noise2 } from '../../shared/noise';
import type { Grid } from '../grid/grid';
import { smoothstep } from '../grid/ops';
import { gaussBlur } from '../grid/smooth';
import { coarseFbm } from './fields';
import { elaTemperature, LAPSE } from './tables';

/** waterClass codes of the hydrology stage (mirrors WATER in stages/hydro.ts). */
const W_OCEAN = 1;
/** Minimum PET (mm/yr) used for the aridity index. */
const PET_FLOOR_MM = 150;
const W_LAKE = 2;
const W_RIVER = 3;
const W_WETLAND = 4;
const W_PLAYA = 5;
const W_SALT_LAKE = 6;

/**
 * Slope thresholds of research 03 §3.2 (rock above 38°, blending from 30°) refer to a ~30 m DEM.
 * Slopes over longer baselines are gentler; tan(slope) scales as (cell / 30 m)^−0.19 between the
 * 1 km and 4 km macro grids (99.9th percentile 28° → 23°), so the thresholds are rescaled likewise.
 */
const SLOPE_REF_M = 30;
const SLOPE_ROUGHNESS = 0.19;
/** River mouths with at least this discharge (m³/s) shelter the coast within MOUTH_KM. */
const MOUTH_Q = 50;
const MOUTH_KM = 15;

export interface BiomeInput {
  grid: Grid;
  /** Macro DEM (m). */
  h: Float32Array;
  temp: Float32Array;
  tAmp: Float32Array;
  precip: Float32Array;
  pSummer: Float32Array;
  pet: Float32Array;
  fog: Uint8Array;
  /** Distance to the sea (km). */
  coastKm: Float32Array;
  waterClass: Uint8Array;
  discharge: Float32Array;
  /** Shift of the glacier equilibrium-line temperature (°C; + = more ice). */
  elaShift: number;
  noise: Noise2;
}

export interface BiomeFields {
  biome: Uint8Array;
  canopy: Float32Array;
  aridity: Float32Array;
  snow: Float32Array;
}

/** Zonal classes the majority filter may change; the overrides (rock, coast, wetland, salt) stay. */
const FILTERABLE = new Uint8Array(BIOMES.length);
for (const b of [
  BIOME.ICE, BIOME.POLAR_DESERT, BIOME.TUNDRA, BIOME.BOREAL, BIOME.TEMP_CONIFER, BIOME.TEMP_BROADLEAF, BIOME.TEMP_RAINFOREST,
  BIOME.STEPPE, BIOME.MEDITERRANEAN, BIOME.HOT_DESERT, BIOME.COLD_DESERT, BIOME.XERIC_SHRUB, BIOME.SAVANNA,
  BIOME.TROP_DRY_FOREST, BIOME.TROP_RAINFOREST, BIOME.CLOUD_FOREST, BIOME.ALPINE_MEADOW, BIOME.NIVAL,
]) FILTERABLE[b] = 1;

/**
 * Biome classification of research 03 §3.2–3.4: Köppen-style variables from jittered climate inputs,
 * then the ordered rules (water, ice, rock, coast, salt flat, wetland, cold, dry, tropical mountains,
 * tropical, temperate, continental), a 3×3 majority filter over the zonal classes, and the canopy,
 * aridity and perennial-snow rasters.
 */
export function classifyBiomes(inp: BiomeInput): BiomeFields {
  const { grid, h, temp, tAmp, precip, pSummer, pet, fog, coastKm, waterClass, discharge, elaShift, noise } = inp;
  const { cells: N, cellKm, cellM, off8, off4, border } = grid;
  // Raster D8 slots of the four axial neighbours.
  const oW = off8[3];
  const oE = off8[4];
  const oN = off8[1];
  const oS = off8[6];
  const scale = Math.pow(cellM / SLOPE_REF_M, SLOPE_ROUGHNESS);
  const rockTan = Math.tan((38 * Math.PI) / 180) / scale;
  const mixTan = Math.tan((30 * Math.PI) / 180) / scale;
  const flatTan = Math.tan((2 * Math.PI) / 180) / scale;
  const coastH = Math.max(5, 10 * cellKm);
  const coastMaxKm = Math.max(2, 1.5 * cellKm);

  // Coast geometry: a fetch proxy (sea share within ~10 km) and the reach of big river mouths.
  const sea = new Uint8Array(N);
  for (let i = 0; i < N; i++) sea[i] = waterClass[i] === W_OCEAN ? 1 : 0;
  const seaShare = Float32Array.from(sea);
  gaussBlur(seaShare, grid, 8 / cellKm);
  const mouth = new Float32Array(N);
  // Interior cells only: the map edge has no full neighbourhood.
  for (let i = 0; i < N; i++) {
    if (border[i] || sea[i] || discharge[i] < MOUTH_Q) continue;
    if (sea[i + off4[0]] || sea[i + off4[1]] || sea[i + off4[2]] || sea[i + off4[3]]) mouth[i] = 1;
  }
  // Three box passes of radius ≈ σ reach ±3σ: the blurred mask is non-zero within ~MOUTH_KM.
  gaussBlur(mouth, grid, MOUTH_KM / 3 / cellKm);

  // Jittered inputs (±1.5 °C, ±20 % P at 20–40 km) break isotherms into lobes; 4–8 km canopy mosaic.
  const n1 = coarseFbm(noise, grid, 30, 3, 3.1);
  const n2 = coarseFbm(noise, grid, 30, 3, 57.3);
  const mosaic = coarseFbm(noise, grid, 8, 1, 91.9, 4);

  const raw = new Uint8Array(N);
  const canopy = new Float32Array(N);
  const aridity = new Float32Array(N);
  const snow = new Float32Array(N);
  const rockMix = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const wc = waterClass[i];
    // PET floor: Holdridge PET is 0 when every month freezes, which would make aridity jump to its
    // clamp along that line (a visible seam in the colour LUT). Cold biome rules don't use aridity.
    aridity[i] = Math.min(10, precip[i] / Math.max(PET_FLOOR_MM, pet[i]));
    if (wc === W_OCEAN || wc === W_LAKE || wc === W_RIVER || wc === W_SALT_LAKE) {
      raw[i] = BIOME.WATER;
      continue;
    }
    const hp = Math.max(0, h[i]);
    const T = temp[i] + 3 * n1[i];
    const P = precip[i] * Math.exp(0.4 * n2[i]);
    const A = tAmp[i];
    const Tw = T + A;
    const Tc = T - A;
    const ps = pSummer[i];
    const ai = P / Math.max(1, pet[i]);

    const iceT = (Tw - 1) - (elaTemperature(P) + elaShift);
    snow[i] = smoothstep(1, -1, iceT);

    // Central differences, one-sided where a neighbour is missing.
    let xl = i + oW;
    let xr = i + oE;
    let yu = i + oN;
    let yd = i + oS;
    if (border[i]) {
      const nb = (k: number): number => {
        const j = grid.nbr(i, k);
        return j < 0 ? i : j;
      };
      xl = nb(3);
      xr = nb(4);
      yu = nb(1);
      yd = nb(6);
    }
    const gx = (h[xr] - h[xl]) / (((xr !== i ? 1 : 0) + (xl !== i ? 1 : 0)) * cellM);
    const gy = (h[yd] - h[yu]) / (((yd !== i ? 1 : 0) + (yu !== i ? 1 : 0)) * cellM);
    const slope = Math.sqrt(gx * gx + gy * gy);
    if (slope > mixTan) rockMix[i] = Math.min(1, (Math.atan(slope) - Math.atan(mixTan)) / (Math.atan(rockTan) - Math.atan(mixTan)));

    let b: BiomeId;
    if (iceT < 0) b = BIOME.ICE;
    else if (slope > rockTan) b = BIOME.ROCK;
    else if (coastKm[i] <= coastMaxKm && h[i] < coastH && slope < flatTan) {
      const sheltered = seaShare[i] < 0.3 || mouth[i] > 1e-3;
      // Cold-season SST proxy: sea-level temperature minus about half the land half-range.
      const sstCold = T + LAPSE * hp - 0.5 * A;
      if (sheltered && Tc >= 16 && sstCold >= 20) b = BIOME.MANGROVE;
      else b = sheltered ? BIOME.SALT_MARSH : BIOME.BEACH;
    } else if (wc === W_PLAYA) b = BIOME.SALT_FLAT;
    else if (wc === W_WETLAND) b = wetlandType(T, ai, waterClass, grid, i);
    else b = zonal(T, Tw, Tc, A, P, ps, ai, hp, fog[i] === 1);
    raw[i] = b;
  }

  const biome = majority(raw, grid);

  for (let i = 0; i < N; i++) {
    const b = biome[i];
    if (b === BIOME.WATER) continue;
    const T = temp[i];
    let c = BIOMES[b].canopy;
    if (c > 0) {
      const Tw = T + tAmp[i];
      c *= (0.7 + 0.3 * smoothstep(0.4, 1.4, aridity[i])) * (0.6 + 0.4 * smoothstep(10, 15, Tw));
      c += 2 * 0.25 * mosaic[i] * 4 * c * (1 - c);
    }
    canopy[i] = Math.min(1, Math.max(0, c * (1 - rockMix[i]) * (1 - snow[i])));
  }
  return { biome, canopy, aridity, snow };
}

/** Rules 7–12 of research 03 §3.2 (`h` ≥ 0 m; T, P already jittered). */
function zonal(T: number, Tw: number, Tc: number, A: number, P: number, ps: number, ai: number, h: number, fog: boolean): BiomeId {
  const T0w = Tw + LAPSE * h;
  const alpine = h > 600 && T0w >= 10;
  if (Tw < 10) {
    if (Tw < 3) return alpine ? BIOME.NIVAL : BIOME.POLAR_DESERT;
    if (alpine) return P >= 300 ? BIOME.ALPINE_MEADOW : BIOME.NIVAL;
    return P >= 150 ? BIOME.TUNDRA : BIOME.POLAR_DESERT;
  }
  // Köppen B threshold (Peel et al. 2007), mm.
  const pth = 2 * T + (ps >= 0.7 ? 28 : ps <= 0.3 ? 0 : 14);
  if (P < 10 * pth) {
    if (P < 5 * pth) return T >= 18 ? BIOME.HOT_DESERT : BIOME.COLD_DESERT;
    if (T >= 18) return ps > 0.6 ? BIOME.SAVANNA : BIOME.XERIC_SHRUB;
    return ps < 0.35 ? BIOME.XERIC_SHRUB : BIOME.STEPPE;
  }
  const T0c = Tc + LAPSE * h;
  if (T0c >= 12 && h >= 1000 && 10 <= T && T <= 20 && P >= (fog ? 1000 : 1500)) return BIOME.CLOUD_FOREST;
  if (Tc >= 18) {
    if (P >= 2000 && Math.min(ps, 1 - ps) >= 0.3) return BIOME.TROP_RAINFOREST;
    return P >= 1000 ? BIOME.TROP_DRY_FOREST : BIOME.SAVANNA;
  }
  if (Tc > -3) {
    if (ps < 0.35 && Tw >= 17) return BIOME.MEDITERRANEAN;
    if (P >= 2000 && A <= 8 && T >= 4 && T <= 16) return BIOME.TEMP_RAINFOREST;
    if (ai < 0.75) return BIOME.STEPPE;
    return h > 800 && Tw < 16 ? BIOME.TEMP_CONIFER : BIOME.TEMP_BROADLEAF;
  }
  if (ai < 0.6) return BIOME.STEPPE;
  if (monthsAbove10(T, A) <= 3) return BIOME.BOREAL;
  return T < 5 || h > 800 ? BIOME.TEMP_CONIFER : BIOME.TEMP_BROADLEAF;
}

/** Months with T_month > 10 °C in the cosine annual cycle. */
function monthsAbove10(T: number, A: number): number {
  let k = 0;
  for (let m = 0; m < 12; m++) if (T + A * Math.cos((2 * Math.PI * (m + 0.5)) / 12) > 10) k++;
  return k;
}

/**
 * 3×3 majority filter over the zonal classes (research 03 §3.4): a cell switches to the most common
 * filterable class around it when that class outnumbers its own; ties keep the cell.
 */
function majority(raw: Uint8Array, g: Grid): Uint8Array {
  const { cells: N, off8, border } = g;
  const out = raw.slice();
  const count = new Uint8Array(BIOMES.length);
  // Interior cells only: the map edge has no full 3×3 window.
  for (let i = 0; i < N; i++) {
    if (border[i]) continue;
    const self = raw[i];
    if (!FILTERABLE[self]) continue;
    let best = self;
    count[self]++;
    for (let k = 0; k < 8; k++) {
      const b = raw[i + off8[k]];
      if (FILTERABLE[b]) count[b]++;
    }
    // The cell itself never beats its own count, so only the neighbours can win (raster order).
    let bestN = count[self];
    for (let k = 0; k < 8; k++) {
      const b = raw[i + off8[k]];
      if (count[b] > bestN) {
        best = b;
        bestN = count[b];
      }
    }
    count[self] = 0;
    for (let k = 0; k < 8; k++) count[raw[i + off8[k]]] = 0;
    out[i] = best;
  }
  return out;
}

/**
 * Wetland typing (research 02 §7): warm humid → swamp (forested); cold → fen where fed by groundwater
 * or open water (next to a lake or river), otherwise rain-fed bog; everything else → marsh.
 */
function wetlandType(T: number, ai: number, wc: ArrayLike<number>, g: Grid, i: number): BiomeId {
  if (T >= 18 && ai >= 1) return BIOME.SWAMP;
  if (T < 6) {
    for (let k = 0; k < 8; k++) {
      const j = g.border[i] === 0 ? i + g.off8[k] : g.nbr(i, k);
      if (j < 0) continue;
      const c = wc[j];
      if (c === W_LAKE || c === W_RIVER) return BIOME.FEN;
    }
    return BIOME.BOG;
  }
  return BIOME.MARSH;
}
