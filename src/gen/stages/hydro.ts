import { RIVER, type LakeInfo, type Layer } from '../../shared/protocol';
import { breachShallow } from '../hydro/breach';
import { SECONDS_PER_YEAR, waterBudget } from '../hydro/budget';
import { addDeltas } from '../hydro/deltas';
import { buildHierarchy, waterBalance, type LakeBody } from '../hydro/depressions';
import { buildRivers, channelCells, enforceMonotone, meanderRoom, WIDTH_COEF } from '../hydro/geometry';
import { GraphBuilder } from '../hydro/graph';
import { bifurcationRatio, channelLengthKm, countCrossings, hackExponent } from '../hydro/metrics';
import { extractNetwork } from '../hydro/network';
import { placeLakeBasins } from '../hydro/placeLakes';
import { accumulate, jitter, route } from '../hydro/routing';
import { reliefSlope, selectWetlands, wetnessIndex } from '../hydro/wetness';
import type { StageDef } from '../pipeline';
import type { ClimateExtra } from './climate';
import type { ErodedExtra } from './lem';

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

/** Breach depressions shallower than this (m) and smaller than BREACH_AREA (km²), ÷ lakeDensity (research 02 §1.2). */
const BREACH_DEPTH = 15;
const BREACH_AREA = 4;
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
 * both grid sizes. The riverDensity outcome is realised / expected drainage density with expected =
 * DD_COEF / √A_c for the channel-head area actually used (the grid floor of MIN_CHANNEL_CELLS can
 * raise it above RIVER_AREA / riverDensity², reported as channelAreaRequestedKm2); 1.0 = on target,
 * lower where arid or lake-filled land carries fewer channels than its area implies.
 */
const DD_COEF = 0.56;
/** River node spacing in cells (350 m on the 1 km build grid). */
const NODE_SPACING = 0.35;
/** Wetlands only on cells flatter than this. */
const WETLAND_MAX_SLOPE = 0.02;

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
    const t = ctx.input('landforms').extra as ErodedExtra;
    const cl = ctx.input('climate').extra as ClimateExtra;
    const { n, cellKm, fixed } = t;
    if (cl.n !== n) throw new Error(`hydro: climate grid ${cl.n} ≠ terrain grid ${n}`);
    const N = n * n;
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
    const lf = Math.max(0.1, lakeDensity);
    const br = breachShallow(h, n, fixed, BREACH_DEPTH / lf, Math.max(BREACH_AREA / lf / cellKm2, 1.5));
    Object.assign(stats, { pits: br.pits, breached: br.breached, breachCarvedCells: br.carved });
    lap('breach');
    stats.lakeBasinsPlaced = placeLakeBasins({
      n, cellKm, h, fixed, area: t.area, rcv: t.rcv, temp: cl.temp, precip: cl.precip, pet: cl.pet, lakeDensity, rng: ctx.rng('lakes'),
    });
    lap('placeLakes');
    await ctx.checkpoint();
    tLap = performance.now();

    // 2. Depression hierarchy and water balance → lakes.
    const H = buildHierarchy(h, n, fixed);
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
    const { jx, jy } = jitter(n, ctx.rng('jitter').nextU32());
    const R = route(S, n, fixed, roots, jx, jy, t.area);
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
      n, cellM, seed: ctx.rng('meander').nextU32(), S, h, fixed, lakeId, lakeLevel, lakeKind, rcv: R.rcv, donStart: R.donStart, donList: R.donList,
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
    const deltas = addDeltas(gb, {
      n, cellM, h, fixed, lakeId, lakeLevel, waveEnergy: ctx.num('waveEnergy'), tideRange: ctx.num('tideRange'), spacing, rng: ctx.rng('deltas'),
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
      const info = lakeInfo(l, b, n, cellM, cellKm2, budget.aridity, built.outletNode[l]);
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
      const c = Math.min(n - 1, Math.floor(rivers.y[i] / cellM)) * n + Math.min(n - 1, Math.floor(rivers.x[i] / cellM));
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
    const { twi } = wetnessIndex(S, n, cellM, rcv, fixed);
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
    wet += selectWetlands(twi, reliefSlope(S, n, cellM), budget.aridity, eligible, wetMask, Math.round(ctx.num('wetlandShare') * land) - wet, WETLAND_MAX_SLOPE);
    for (let i = 0; i < N; i++) if (wetMask[i]) waterClass[i] = WATER.WETLAND;
    lap('wetness');

    // Stats and outcomes.
    const landKm2 = land * cellKm2;
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
      hortonRb: bifurcationRatio(rivers).rb,
      hackExponent: hackExponent(rivers).h,
      maxMouthQ: maxMouthQ(rivers),
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
        riverDensity: lengthKm / Math.max(1, landKm2) / ddExpected,
        wetlandShare: wet / Math.max(1, land),
      },
      extra,
      vectors: { rivers, lakes },
    };
  },
};

function maxMouthQ(g: { n: number; q: Float32Array; flags: Uint16Array }): number {
  let m = 0;
  for (let i = 0; i < g.n; i++) if (g.flags[i] & RIVER.MOUTH_SEA) m = Math.max(m, g.q[i]);
  return m;
}

function lakeInfo(id: number, b: LakeBody, n: number, cellM: number, cellKm2: number, aridity: Float32Array, outletNode: number): LakeInfo {
  let sx = 0;
  let sy = 0;
  let arid = 0;
  for (const c of b.cells) {
    sx += (c % n) + 0.5;
    sy += Math.floor(c / n) + 0.5;
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
