import { Noise2 } from '../../shared/noise';
import { RIVER, type LakeInfo, type Layer } from '../../shared/protocol';
import { cellIndex, cellX, cellY, forWindow, type Grid } from '../grid/grid';
import { chamferDistance, smoothstep } from '../grid/ops';
import { breachShallow } from '../hydro/breach';
import { SECONDS_PER_YEAR, waterBudget } from '../hydro/budget';
import { addDeltas } from '../hydro/deltas';
import { buildHierarchy, waterBalance, type LakeBody } from '../hydro/depressions';
import { buildRivers, channelCells, enforceMonotone, meanderRoom, WIDTH_COEF } from '../hydro/geometry';
import { GraphBuilder } from '../hydro/graph';
import { bifurcationRatio, channelLengthKm, countCrossings, hackExponent, longestRiversToSea } from '../hydro/metrics';
import { extractNetwork } from '../hydro/network';
import { placeLakeBasins } from '../hydro/placeLakes';
import { accumulate, jitter, route } from '../hydro/routing';
import { reliefSlope, selectWetlands, wetnessIndex } from '../hydro/wetness';
import type { StageDef } from '../pipeline';
import type { ClimateExtra } from './climate';
import type { GlacialExtra } from './glacial';

/** Values of the `waterClass` layer. */
export const WATER = { LAND: 0, OCEAN: 1, LAKE: 2, RIVER: 3, WETLAND: 4, PLAYA: 5, SALT_LAKE: 6 } as const;
/** `waterLevel` on dry land (the renderer treats anything below −9000 as dry). */
export const DRY_LEVEL = -10000;

/** Hydrology output for later stages (biomes, M4 climate coupling). All rasters n×n, row-major. */
export interface HydroExtra {
  n: number;
  cellKm: number;
  /** Final terrain (m): input elevation with breaches, river beds and lake beds carved in (min only). */
  elevation: Float32Array;
  /** WATER classes. */
  waterClass: Uint8Array;
  /** Water surface (m): lake level, wide-river surface, 0 on the sea, DRY_LEVEL elsewhere. */
  waterLevel: Float32Array;
  /** Mean annual discharge (m³/s). */
  discharge: Float32Array;
  /** Drainage area (km²). */
  area: Float32Array;
  /** Topographic wetness index ln(a / tan β). */
  twi: Float32Array;
  /** Index into the stage's `lakes` vector per cell, −1 elsewhere (playas included). */
  lakeId: Int32Array;
  /** Flow receiver per cell (self at the sea, terminal lakes and dry sinks). */
  rcv: Int32Array;
}

/** Breach depressions shallower than this (m) and smaller than BREACH_AREA (km²), ÷ min(lakeDensity, 1) (research 02 §1.2). */
const BREACH_DEPTH = 15;
const BREACH_AREA = 4;
/**
 * Lake districts (research 05 §4 row 18: lakes ×5–20 inside districts, clustered, §3.3). Glacially
 * carved terrain is pitted everywhere; only a share of it (DISTRICT_SHARE × lakeDensity, picked by
 * low-frequency noise of DISTRICT_KM wavelength) keeps every pit. Elsewhere on carved ground the breach
 * limits grow by DISTRICT_BREACH_DEPTH and DISTRICT_BREACH_AREA, so only deep troughs keep their lakes.
 */
const DISTRICT_SHARE = 0.3;
const DISTRICT_KM = 250;
const DISTRICT_BREACH_DEPTH = 5;
const DISTRICT_BREACH_AREA = 100;
/** Acceptance of placed (sub-grid) lake basins on carved ground outside districts, relative to inside. */
const DISTRICT_PLACE_OUTSIDE = 0.3;
/** Carve depth (m) at which a pit counts as glacial (smoothstep from the first value to the second). */
const DISTRICT_CARVE: [number, number] = [2, 20];
/**
 * Channel-head drainage area of the river graph at riverDensity 1 (km²). The research's 1 km² is
 * below one cell on every grid we run; this keeps the graph at ~150–250k nodes on the 1024² build,
 * with sub-threshold creeks left to the detail level (research 02 §8).
 */
const RIVER_AREA = 8;
/** Never start channels on fewer cells than this. */
const MIN_CHANNEL_CELLS = 2.5;
/** Water that still counts as a flowing channel (m³/s). */
const MIN_Q = 1e-4;
/** Transmission-loss coefficient for arid channels (×(PET − P) per m² of bed; research 02 §5.4 uses 1, ×10 adds bed infiltration). */
const ARID_LOSS = 10;
/**
 * Drainage density (km/km²) of the channel network per unit of 1/√A_c, measured on default worlds at
 * both grid sizes. The ratio realised / expected drainage density (stat riverDensityRatio, 1.0 = on
 * target) uses expected = DD_COEF / √A_c for the channel-head area actually used (the grid floor of
 * MIN_CHANNEL_CELLS can raise it above RIVER_AREA / riverDensity², reported as channelAreaRequestedKm2)
 * and measures over channelled land only (cells whose flow path meets a channel before the sea or a
 * lake). The riverDensity outcome is that ratio × riverDensity, in slider units.
 */
const DD_COEF = 0.55;
/**
 * A great river reaches the sea over at least this length (km) on the default 1024 km world, scaled
 * with world width (research 05 §4 row 12 as restated in research 09 §4.15; mirrored in metrics/targets.ts).
 */
export const GREAT_RIVER_KM = 400;
/** Sea deltas per km² of land at most (research 05 §4 row 33: 1–5 on the default world's ~4.2 × 10⁵ km²). */
const DELTAS_PER_KM2 = 5 / 4.2e5;
/** River node spacing in cells (350 m on the 1 km build grid). */
const NODE_SPACING = 0.35;
/** Wetlands only on cells flatter than this. */
const WETLAND_MAX_SLOPE = 0.02;
/** Humid land (P/PET ≥ 1) may hold wetlands up to this local relief when flat land runs short (blanket bog, fen). */
const WETLAND_HUMID_SLOPE = 0.035;
/** Arid wetlands (saline marsh, riparian) lie within this distance (km) of lakes, playas and channels above ARID_WETLAND_Q (m³/s). */
const ARID_WETLAND_KM = 5;
const ARID_WETLAND_Q = 2;

/**
 * S8 Hydrology (research 02 §10): breach noise pits, depression hierarchy + water balance for lakes,
 * jittered D8 routing with discharge, the river graph (smoothed, meandered, monotone), deltas, TWI
 * wetlands, and the macro carve.
 */
export const hydroStage: StageDef = {
  id: 'hydro',
  label: 'Rivers & lakes',
  inputs: ['landforms', 'climate'],
  reads: ['worldSize', 'riverDensity', 'lakeDensity', 'meanderStrength', 'wetlandShare', 'waveEnergy', 'tideRange'],
  async run(ctx) {
    const t = ctx.input('landforms').extra as GlacialExtra;
    const cl = ctx.input('climate').extra as ClimateExtra;
    const { n, cellKm, fixed } = t;
    if (cl.n !== n) throw new Error(`hydro: climate grid ${cl.n} ≠ terrain grid ${n}`);
    const g = ctx.grid(n);
    const N = g.cells;
    const cellM = cellKm * 1000;
    const cellKm2 = cellKm * cellKm;
    const cellM2 = cellM * cellM;
    const worldKm = ctx.num('worldSize');
    const lakeDensity = ctx.num('lakeDensity');
    const riverDensity = ctx.num('riverDensity');
    const stats: Record<string, number> = { n, cellKm };
    let tLap = performance.now();
    const lap = (key: string): void => {
      const now = performance.now();
      stats[`ms_${key}`] = Math.round((now - tLap) * 10) / 10;
      tLap = now;
    };

    // 1. Breach noise pits; carve the lake basins the eroded terrain lacks.
    const budget = waterBudget(cl.precip, cl.pet, fixed);
    const h = t.h.slice();
    // A high lakeDensity no longer protects pits beyond the research defaults (it adds lake districts instead).
    const lf = Math.max(0.1, Math.min(1, lakeDensity));
    const districts = lakeDistricts(g, cellKm, t.carve, fixed, lakeDensity, ctx.rng('lakeDistricts').nextU32());
    const br = breachShallow(h, g, fixed, BREACH_DEPTH / lf, BREACH_AREA / lf / cellKm2, districts.depth, districts.area);
    // Pits breached into a neighbouring pit leave a compound depression: a second pass sees it whole.
    const br2 = breachShallow(h, g, fixed, BREACH_DEPTH / lf, BREACH_AREA / lf / cellKm2, districts.depth, districts.area);
    br.breached += br2.breached;
    br.carved += br2.carved;
    stats.lakeDistrictShare = districts.share;
    Object.assign(stats, { pits: br.pits, breached: br.breached, breachCarvedCells: br.carved });
    lap('breach');
    stats.lakeBasinsPlaced = placeLakeBasins({
      grid: g, h, fixed, area: t.area, rcv: t.rcv, temp: cl.temp, precip: cl.precip, pet: cl.pet, lakeDensity, rng: ctx.rng('lakes'),
      weight: districts.place,
    });
    lap('placeLakes');
    await ctx.checkpoint();
    tLap = performance.now();

    // 2. Depression hierarchy and water balance → lakes.
    const H = buildHierarchy(h, g, fixed);
    lap('hierarchy');
    const runoffY = new Float64Array(N);
    const lossY = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      runoffY[i] = budget.runoff[i] * cellM2;
      lossY[i] = budget.lakeLoss[i] * cellM2;
    }
    const bal = waterBalance(H, h, runoffY, lossY);
    const bodies = bal.lakes.sort((a, b) => b.cells.length - a.cells.length || a.node - b.node);
    const L = bodies.length;
    const lakeId = new Int32Array(N).fill(-1);
    const lakeLevel = new Float64Array(L);
    const lakeKind = new Uint8Array(L);
    const S = h.slice();
    const roots = new Uint8Array(N);
    const inLake = new Uint8Array(N);
    for (let l = 0; l < L; l++) {
      const b = bodies[l];
      lakeLevel[l] = b.level;
      lakeKind[l] = b.kind === 'through' ? 0 : b.kind === 'terminal' ? 1 : 2;
      let low = b.cells[0];
      for (const c of b.cells) {
        lakeId[c] = l;
        if (h[c] < h[low]) low = c;
        if (b.kind !== 'playa') {
          S[c] = b.level;
          inLake[c] = 1;
        }
      }
      if (b.kind !== 'through') roots[low] = 1;
    }
    stats.depressionLeaves = H.leafCount;
    lap('lakes');
    await ctx.checkpoint();
    tLap = performance.now();

    // 3. Routing and discharge.
    const { jx, jy } = jitter(g, ctx.rng('jitter').nextU32());
    const R = route(S, g, fixed, roots, jx, jy, t.area);
    lap('route');
    const yieldM3s = new Float64Array(N);
    const aridRate = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (fixed[i]) continue;
      yieldM3s[i] = ((budget.runoff[i] - (inLake[i] ? budget.lakeLoss[i] : 0)) * cellM2) / SECONDS_PER_YEAR;
      if (budget.aridity[i] > 2) aridRate[i] = (ARID_LOSS * Math.max(0, cl.pet[i] - cl.precip[i])) / 1000;
    }
    const aReq = RIVER_AREA / (riverDensity * riverDensity);
    const ath = Math.max(aReq, MIN_CHANNEL_CELLS * cellKm2);
    const acc = accumulate(R, cellKm2, cellM, yieldM3s, inLake, ath, aridRate, WIDTH_COEF);
    lap('routing');
    await ctx.checkpoint();
    tLap = performance.now();

    // 4. River network and geometry.
    const net = extractNetwork(R, acc.area, acc.q, fixed, { lakeId, kind: lakeKind }, ath, MIN_Q);
    const spacing = Math.max(250, NODE_SPACING * cellM);
    const gIn = {
      grid: g, seed: ctx.rng('meander').nextU32(), S, h, fixed, lakeId, lakeLevel, lakeKind, rcv: R.rcv, donStart: R.donStart, donList: R.donList,
      q: acc.q, area: acc.area, aridity: budget.aridity, temp: cl.temp, jx, jy, net,
      sigmaMax: 1 + 1.5 * ctx.num('meanderStrength'), spacing,
    };
    const cc = channelCells(gIn);
    const room = meanderRoom(gIn, cc);
    lap('network');
    const gb = new GraphBuilder();
    const built = buildRivers(gIn, cc, room, L, gb);
    lap('geometry');
    await ctx.checkpoint();
    tLap = performance.now();
    const plain = new Uint8Array(N);
    let landCells = 0;
    for (let i = 0; i < N; i++) if (!fixed[i]) landCells++;
    const deltas = addDeltas(gb, {
      grid: g, h, fixed, lakeId, lakeLevel, waveEnergy: ctx.num('waveEnergy'), tideRange: ctx.num('tideRange'), spacing, rng: ctx.rng('deltas'),
      maxSea: Math.max(1, Math.round(DELTAS_PER_KM2 * landCells * cellKm2)),
    }, plain);
    enforceMonotone(gb);
    const rivers = gb.finish();
    lap('deltas');
    await ctx.checkpoint();
    tLap = performance.now();

    // 5. Rasters: carve, water classes and levels.
    const elevation = h.slice();
    const waterClass = new Uint8Array(N);
    const waterLevel = new Float32Array(N).fill(DRY_LEVEL);
    const lakes: LakeInfo[] = [];
    for (let l = 0; l < L; l++) {
      const b = bodies[l];
      const info = lakeInfo(l, b, g, cellM, cellKm2, budget.aridity, built.outletNode[l]);
      lakes.push(info);
      const cls = b.kind === 'playa' ? WATER.PLAYA : info.type === 'salt' ? WATER.SALT_LAKE : WATER.LAKE;
      for (const c of b.cells) {
        waterClass[c] = cls;
        if (b.kind !== 'playa') {
          waterLevel[c] = b.level;
          elevation[c] = Math.min(elevation[c], b.level - 0.5);
        }
      }
    }
    for (let i = 0; i < N; i++) {
      if (fixed[i] && h[i] <= 0) {
        waterClass[i] = WATER.OCEAN;
        waterLevel[i] = 0;
      }
    }
    const { chan } = net;
    const { rcv, stack } = R;
    for (let i = 0; i < rivers.n; i++) {
      if (!(rivers.flags[i] & RIVER.DISTRIBUTARY)) continue;
      const c = cellIndex(g, Math.min(n - 1, Math.floor(rivers.x[i] / cellM)), Math.min(n - 1, Math.floor(rivers.y[i] / cellM)));
      if (!fixed[c] && lakeId[c] < 0) elevation[c] = Math.min(elevation[c], rivers.zBed[i]);
    }
    const zb = new Float64Array(N);
    for (let i = 0; i < N; i++) zb[i] = chan[i] ? S[i] - cc.depth[i] : Infinity;
    for (let k = N - 1; k >= 0; k--) {
      const i = stack[k];
      if (!chan[i]) continue;
      elevation[i] = Math.min(elevation[i], zb[i]);
      const r = rcv[i];
      if (chan[r]) {
        zb[r] = Math.min(zb[r], zb[i]);
        elevation[r] = Math.min(elevation[r], elevation[i]);
      }
      if (cc.width[i] >= 0.5 * cellM) {
        waterClass[i] = WATER.RIVER;
        waterLevel[i] = S[i];
      }
    }
    lap('carve');
    await ctx.checkpoint();
    tLap = performance.now();

    // 6. Wetness and wetlands (🎯 wetlandShare).
    const { twi } = wetnessIndex(S, g, rcv, fixed);
    lap('twi');
    let land = 0;
    let wet = 0;
    for (let i = 0; i < N; i++) {
      const c = waterClass[i];
      if (c === WATER.OCEAN || c === WATER.LAKE || c === WATER.SALT_LAKE) continue;
      land++;
      if (c === WATER.LAND && plain[i]) {
        waterClass[i] = WATER.WETLAND;
        wet++;
      }
    }
    const wetMask = new Uint8Array(N);
    const eligible = new Uint8Array(N);
    for (let i = 0; i < N; i++) eligible[i] = waterClass[i] === WATER.LAND && !fixed[i] ? 1 : 0;
    // Arid land holds wetlands only beside exotic water: lake and playa shores, big-river floodplains.
    const exotic = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const c = waterClass[i];
      if (c === WATER.LAKE || c === WATER.SALT_LAKE || c === WATER.PLAYA || (chan[i] && acc.q[i] >= ARID_WETLAND_Q)) exotic[i] = 1;
    }
    const exoticDist = chamferDistance(exotic, g);
    const aridReach = Math.max(1, ARID_WETLAND_KM / cellKm);
    const aridOk = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (exoticDist[i] <= aridReach) aridOk[i] = 1;
    wet += selectWetlands(twi, reliefSlope(S, g), budget.aridity, eligible, wetMask, Math.round(ctx.num('wetlandShare') * land) - wet, {
      maxSlope: WETLAND_MAX_SLOPE, humidSlope: WETLAND_HUMID_SLOPE, aridOk,
    });
    for (let i = 0; i < N; i++) if (wetMask[i]) waterClass[i] = WATER.WETLAND;
    lap('wetness');

    // Stats and outcomes. Drainage density counts only channelled land: cells whose flow path
    // meets a channel. Hillslopes draining straight to the sea or a lake (small islands, coastal and
    // lake-shore strips) carry no channel at any density, so they would bias the outcome on broken coasts.
    const landKm2 = land * cellKm2;
    const drains = new Uint8Array(N);
    let chLand = 0;
    for (let k = 0; k < N; k++) {
      const i = stack[k];
      if (fixed[i]) continue;
      drains[i] = chan[i] ? 1 : rcv[i] !== i && !inLake[i] ? drains[rcv[i]] : 0;
      const c = waterClass[i];
      if (drains[i] && c !== WATER.LAKE && c !== WATER.SALT_LAKE) chLand++;
    }
    const chLandKm2 = chLand * cellKm2;
    const lengthKm = channelLengthKm(rivers);
    const ddExpected = DD_COEF / Math.sqrt(ath);
    let toSea = 0;
    let waterfalls = 0;
    let rapids = 0;
    let ephemeral = 0;
    for (let i = 0; i < rivers.n; i++) {
      const f = rivers.flags[i];
      if (f & RIVER.MOUTH_SEA && !(f & RIVER.DISTRIBUTARY)) toSea++;
      if (f & RIVER.WATERFALL) waterfalls++;
      if (f & RIVER.RAPIDS) rapids++;
      if (f & RIVER.EPHEMERAL) ephemeral++;
    }
    const lakeOfMouth = (i: number): number => {
      const cx = Math.min(n - 1, Math.max(0, Math.floor(rivers.x[i] / cellM)));
      const cy = Math.min(n - 1, Math.max(0, Math.floor(rivers.y[i] / cellM)));
      let l = -1;
      forWindow(g, cellIndex(g, cx, cy), 1, (c) => {
        l = lakeId[c];
        return l < 0;
      });
      return l;
    };
    const ddRatio = lengthKm / Math.max(1, chLandKm2) / ddExpected;
    const great = longestRiversToSea(rivers, lakeOfMouth, built.outletNode, (GREAT_RIVER_KM * worldKm) / 1024);
    const sizeClass = (min: number): number => lakes.filter((l) => l.type !== 'playa' && l.areaKm2 >= min).length;
    let lakeCells = 0;
    for (const b of bodies) if (b.kind !== 'playa') lakeCells += b.cells.length;
    Object.assign(stats, {
      graphNodes: rivers.n,
      reaches: rivers.reachStart.length,
      channelAreaKm2: ath,
      channelAreaRequestedKm2: aReq,
      riversToSea: toSea,
      waterfalls,
      rapids,
      ephemeralNodes: ephemeral,
      lakes: lakes.filter((l) => l.type !== 'playa').length,
      lakesOver1Km2: sizeClass(1),
      lakesOver10Km2: sizeClass(10),
      lakesOver100Km2: sizeClass(100),
      lakesOver1000Km2: sizeClass(1000),
      throughLakes: lakeKind.filter((k) => k === 0).length,
      terminalLakes: lakeKind.filter((k) => k === 1).length,
      saltLakes: lakes.filter((l) => l.type === 'salt').length,
      playas: lakes.filter((l) => l.type === 'playa').length,
      lakeCover: lakeCells / Math.max(1, land + lakeCells),
      deltasBirdsFoot: deltas.birdsFoot,
      deltasArcuate: deltas.arcuate,
      deltasCuspate: deltas.cuspate,
      estuaries: deltas.estuaries,
      inlandDeltas: deltas.inland,
      distributaries: deltas.distributaries,
      drainageDensity: lengthKm / Math.max(1, landKm2),
      channelledLandShare: chLand / Math.max(1, land),
      riverDensityRatio: ddRatio,
      hortonRb: bifurcationRatio(rivers).rb,
      hackExponent: hackExponent(rivers).h,
      maxMouthQ: maxMouthQ(rivers),
      longestRiverKm: great.longestKm,
      greatRivers: great.count,
      crossings: countCrossings(rivers, cellM),
      lakeSpillToSeaM3s: bal.toSea / SECONDS_PER_YEAR,
      aridLossM3s: acc.aridLoss,
    });

    const discharge = Float32Array.from(acc.q);
    const area = Float32Array.from(acc.area);
    const extra: HydroExtra = { n, cellKm, elevation, waterClass, waterLevel, discharge, area, twi, lakeId, rcv };
    return {
      layers: layers(extra, net.strahler, chan, worldKm),
      stats,
      outcomes: {
        // In slider units: the realised / expected drainage density ratio times the requested value, so
        // the panel's ±10 % check against riverDensity holds (ratio 1 = on target).
        riverDensity: ddRatio * riverDensity,
        wetlandShare: wet / Math.max(1, land),
      },
      extra,
      vectors: { rivers, lakes },
    };
  },
};

/**
 * Per-cell breach limit scales for lake districts: 1 off carved ground and inside districts, up to
 * DISTRICT_BREACH_* on carved ground outside them; `place` scales sub-grid lake placement. `share` = district share of the carved land.
 */
function lakeDistricts(
  g: Grid,
  cellKm: number,
  carve: Float32Array,
  fixed: Uint8Array,
  lakeDensity: number,
  seed: number,
): { depth: Float32Array; area: Float32Array; place: Float32Array; share: number } {
  const N = g.cells;
  const depth = new Float32Array(N).fill(1);
  const area = new Float32Array(N).fill(1);
  const place = new Float32Array(N).fill(1);
  const share = Math.min(0.9, Math.max(0.05, DISTRICT_SHARE * lakeDensity));
  const vals: number[] = [];
  const noise = new Noise2(seed);
  const field = new Float32Array(N);
  const f = cellKm / DISTRICT_KM;
  for (let i = 0; i < N; i++) {
    if (fixed[i] || carve[i] < DISTRICT_CARVE[0]) continue;
    field[i] = noise.fbm(cellX(g, i) * f, cellY(g, i) * f, 3);
    vals.push(field[i]);
  }
  if (vals.length === 0) return { depth, area, place, share };
  vals.sort((a, b) => a - b);
  const thr = vals[Math.min(vals.length - 1, Math.floor((1 - share) * vals.length))];
  const soft = 0.08;
  for (let i = 0; i < N; i++) {
    if (fixed[i] || carve[i] < DISTRICT_CARVE[0]) continue;
    const outside = 1 - smoothstep(thr - soft, thr + soft, field[i]);
    const glacial = smoothstep(DISTRICT_CARVE[0], DISTRICT_CARVE[1], carve[i]);
    const w = outside * glacial;
    depth[i] = 1 + (DISTRICT_BREACH_DEPTH - 1) * w;
    area[i] = 1 + (DISTRICT_BREACH_AREA - 1) * w;
    place[i] = 1 - (1 - DISTRICT_PLACE_OUTSIDE) * w;
  }
  return { depth, area, place, share };
}

function maxMouthQ(g: { n: number; q: Float32Array; flags: Uint16Array }): number {
  let m = 0;
  for (let i = 0; i < g.n; i++) if (g.flags[i] & RIVER.MOUTH_SEA) m = Math.max(m, g.q[i]);
  return m;
}

function lakeInfo(id: number, b: LakeBody, g: Grid, cellM: number, cellKm2: number, aridity: Float32Array, outletNode: number): LakeInfo {
  let sx = 0;
  let sy = 0;
  let arid = 0;
  for (const c of b.cells) {
    sx += cellX(g, c) + 0.5;
    sy += cellY(g, c) + 0.5;
    arid += aridity[c];
  }
  const k = Math.max(1, b.cells.length);
  arid /= k;
  const ratio = b.cells.length / Math.max(1, b.cellsAtSpill);
  let type: LakeInfo['type'] = 'basin';
  let salinity: LakeInfo['salinity'] = 0;
  if (b.kind === 'playa') {
    type = 'playa';
    salinity = 2;
  } else if (b.kind === 'terminal') {
    if (ratio < 0.4 || arid > 2) {
      type = 'salt';
      salinity = 2;
    } else {
      salinity = 1;
    }
  }
  return {
    id,
    type,
    level: b.level,
    areaKm2: b.cells.length * cellKm2,
    maxDepth: Math.max(0, b.level - b.bottom),
    cx: (sx / k) * cellM,
    cy: (sy / k) * cellM,
    outletNode: b.kind === 'through' ? outletNode : -1,
    salinity,
  };
}

function layers(e: HydroExtra, strahler: Uint8Array, chan: Uint8Array, worldKm: number): Layer[] {
  const { n } = e;
  const N = n * n;
  const range = (a: Float32Array, skip?: (v: number) => boolean): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of a) {
      if (skip?.(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return Number.isFinite(lo) ? [lo, hi] : [0, 0];
  };
  const order = new Uint8Array(N);
  let maxOrder = 0;
  for (let i = 0; i < N; i++) {
    if (!chan[i]) continue;
    order[i] = strahler[i];
    maxOrder = Math.max(maxOrder, strahler[i]);
  }
  const q = new Float32Array(N);
  for (let i = 0; i < N; i++) q[i] = e.waterClass[i] === WATER.OCEAN ? -3 : Math.log10(Math.max(1e-3, e.discharge[i]));
  const [eLo, eHi] = range(e.elevation);
  const [wLo, wHi] = range(e.waterLevel, (v) => v <= DRY_LEVEL);
  const [qLo, qHi] = range(q);
  const [tLo, tHi] = range(e.twi);
  const base = { stage: 'hydro' as const, w: n, h: n, worldKm };
  return [
    { ...base, id: 'elevation', label: 'Elevation (carved)', kind: 'elevation', unit: 'm', min: eLo, max: eHi, data: e.elevation },
    { ...base, id: 'waterLevel', label: 'Water level', kind: 'scalar', unit: 'm', min: wLo, max: wHi, data: e.waterLevel },
    { ...base, id: 'waterClass', label: 'Water class', kind: 'categorical', unit: '', min: 0, max: 6, data: e.waterClass },
    { ...base, id: 'riverOrder', label: 'Strahler order', kind: 'categorical', unit: '', min: 0, max: maxOrder, data: order },
    { ...base, id: 'discharge', label: 'Discharge (log10 m³/s)', kind: 'scalar', unit: 'log10 m³/s', min: qLo, max: qHi, data: q },
    { ...base, id: 'wetness', label: 'Wetness index (TWI)', kind: 'scalar', unit: '', min: tLo, max: tHi, data: e.twi },
  ];
}
